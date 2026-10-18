import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { recordAuditBatch } from './audit.js';
import { ReglaNegocioError } from './errores.js';

/**
 * Unificar dos fichas de la MISMA persona en una.
 *
 * Pasa cuando alguien "elimina" a una empleada (que en realidad sólo la
 * desactiva: el historial queda) y después, creyendo que se perdió, la vuelve
 * a crear. Quedan dos fichas: la VIEJA, inactiva, con todo el historial, y la
 * NUEVA, activa, con lo último que se le cargó. Incidente 17/10, Yessica.
 *
 * Qué hace:
 *  - Mueve a la ficha que QUEDA todo lo de la que SE ABSORBE: los movimientos
 *    de caja (sueldos, adelantos, pagos: `movimientos.entidad_id`), el banco
 *    de horas y las liquidaciones. Son las tres tablas que apuntan a un
 *    empleado; no hay otras.
 *  - Los datos de la ficha (teléfono, categoría, valor hora…) se toman de la
 *    que fue modificada MÁS RECIENTEMENTE cuando la tiene cargada: eso es "la
 *    última modificación" que la encargada quiere conservar. Lo que esa no
 *    tiene, se completa con la otra. La fecha de ingreso es la más vieja.
 *  - La que queda, queda activa. La absorbida queda inactiva y marcada como
 *    unificada (no se borra: es la red si algo saliera mal, y vacía no molesta).
 *
 * Todo en una transacción y auditado fila por fila (para que replique).
 */

const CAMPOS = [
  'nombre', 'apellido', 'dni', 'cuil', 'puesto', 'sueldoBase', 'formaPago', 'telefono', 'email',
  'categoriaLaboralId', 'valorHoraPropio',
] as const;
type Campo = (typeof CAMPOS)[number];

const ETIQUETA: Record<Campo, string> = {
  nombre: 'Nombre', apellido: 'Apellido', dni: 'DNI', cuil: 'CUIL', puesto: 'Puesto', sueldoBase: 'Sueldo base',
  formaPago: 'Forma de pago', telefono: 'Teléfono', email: 'Email', categoriaLaboralId: 'Categoría laboral',
  valorHoraPropio: 'Valor hora propio',
};

async function ultimaModificacion(id: string, creadoAt: Date): Promise<Date> {
  const a = await prisma.auditLog.findFirst({
    where: { tabla: 'empleados', registroId: id, accion: 'UPDATE' },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
  return a?.timestamp && a.timestamp > creadoAt ? a.timestamp : creadoAt;
}

const vacio = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const texto = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export async function planUnificacion(quedaId: string, absorbidaId: string) {
  if (quedaId === absorbidaId) throw new ReglaNegocioError('Elegiste la misma ficha dos veces.');
  const [queda, absorbida] = await Promise.all([
    prisma.empleado.findUnique({ where: { id: quedaId }, include: { categoriaLaboral: { select: { nombre: true } } } }),
    prisma.empleado.findUnique({ where: { id: absorbidaId }, include: { categoriaLaboral: { select: { nombre: true } } } }),
  ]);
  if (!queda || !absorbida) throw new ReglaNegocioError('No encontré una de las dos fichas.');
  if ((absorbida.observaciones ?? '').startsWith('UNIFICADA EN ')) {
    throw new ReglaNegocioError('Esa ficha ya fue unificada en otra.');
  }

  const [modQueda, modAbsorbida] = await Promise.all([
    ultimaModificacion(queda.id, queda.creadoAt),
    ultimaModificacion(absorbida.id, absorbida.creadoAt),
  ]);
  // La más recientemente tocada manda en los datos de la ficha.
  const reciente = modAbsorbida > modQueda ? absorbida : queda;
  const otra = reciente === queda ? absorbida : queda;

  const datos: Partial<Record<Campo, unknown>> = {};
  const cambios: Array<{ campo: string; antes: string; despues: string }> = [];
  const categoriaNombre = (e: typeof queda) => e.categoriaLaboral?.nombre ?? '';
  for (const c of CAMPOS) {
    const valor = !vacio(reciente[c]) ? reciente[c] : otra[c];
    if (texto(valor) !== texto(queda[c])) {
      datos[c] = valor;
      cambios.push({
        campo: ETIQUETA[c],
        antes: c === 'categoriaLaboralId' ? categoriaNombre(queda) : texto(queda[c]),
        despues: c === 'categoriaLaboralId' ? categoriaNombre(valor === absorbida.categoriaLaboralId ? absorbida : queda) : texto(valor),
      });
    }
  }
  const ingresos = [queda.fechaIngreso, absorbida.fechaIngreso].filter((d): d is Date => !!d);
  const fechaIngreso = ingresos.length ? new Date(Math.min(...ingresos.map((d) => d.getTime()))) : null;
  if (texto(fechaIngreso?.toISOString()) !== texto(queda.fechaIngreso?.toISOString())) {
    cambios.push({ campo: 'Fecha de ingreso', antes: queda.fechaIngreso?.toISOString().slice(0, 10) ?? '', despues: fechaIngreso?.toISOString().slice(0, 10) ?? '' });
  }
  if (!queda.activo) cambios.push({ campo: 'Activo', antes: 'no', despues: 'sí' });

  const [movimientos, bancoHoras, liquidaciones] = await Promise.all([
    prisma.movimiento.findMany({ where: { entidadId: absorbida.id }, select: { id: true } }),
    prisma.movimientoBancoHoras.findMany({ where: { empleadoId: absorbida.id }, select: { id: true } }),
    prisma.liquidacionEmpleado.findMany({ where: { empleadoId: absorbida.id }, select: { id: true } }),
  ]);
  const [enQuedaMov, enQuedaBh, enQuedaLiq] = await Promise.all([
    prisma.movimiento.count({ where: { entidadId: queda.id } }),
    prisma.movimientoBancoHoras.count({ where: { empleadoId: queda.id } }),
    prisma.liquidacionEmpleado.count({ where: { empleadoId: queda.id } }),
  ]);

  const nombreDe = (e: typeof queda) => [e.nombre, e.apellido].filter(Boolean).join(' ');
  return {
    queda: { id: queda.id, nombre: nombreDe(queda), activo: queda.activo, creadoAt: queda.creadoAt, movimientos: enQuedaMov, bancoHoras: enQuedaBh, liquidaciones: enQuedaLiq },
    absorbida: { id: absorbida.id, nombre: nombreDe(absorbida), activo: absorbida.activo, creadoAt: absorbida.creadoAt, movimientos: movimientos.length, bancoHoras: bancoHoras.length, liquidaciones: liquidaciones.length },
    datosDe: reciente === queda ? 'queda' : 'absorbida',
    cambios,
    // interno, para aplicar
    _datos: { ...datos, fechaIngreso, activo: true } as Prisma.EmpleadoUncheckedUpdateInput,
    _ids: { movimientos: movimientos.map((m) => m.id), bancoHoras: bancoHoras.map((b) => b.id), liquidaciones: liquidaciones.map((l) => l.id) },
  };
}

export async function aplicarUnificacion(quedaId: string, absorbidaId: string, usuarioId: string) {
  const plan = await planUnificacion(quedaId, absorbidaId);
  const { _datos, _ids } = plan;
  await prisma.$transaction(
    async (tx) => {
      // Primero se libera la absorbida y se completa la que queda (orden del
      // audit = orden en que la otra base va a aplicar los cambios).
      await tx.empleado.update({ where: { id: quedaId }, data: _datos });
      if (_ids.movimientos.length) await tx.movimiento.updateMany({ where: { id: { in: _ids.movimientos } }, data: { entidadId: quedaId } });
      if (_ids.liquidaciones.length) await tx.liquidacionEmpleado.updateMany({ where: { id: { in: _ids.liquidaciones } }, data: { empleadoId: quedaId } });
      if (_ids.bancoHoras.length) await tx.movimientoBancoHoras.updateMany({ where: { id: { in: _ids.bancoHoras } }, data: { empleadoId: quedaId } });
      const absorbida = await tx.empleado.findUniqueOrThrow({ where: { id: absorbidaId }, select: { observaciones: true } });
      await tx.empleado.update({
        where: { id: absorbidaId },
        data: {
          activo: false,
          observaciones: `UNIFICADA EN ${plan.queda.nombre} (${quedaId}) el ${new Date().toISOString().slice(0, 10)}.${absorbida.observaciones ? ` ${absorbida.observaciones}` : ''}`.slice(0, 2000),
        },
      });
      const contexto = { unificacion: { queda: quedaId, absorbida: absorbidaId } };
      await recordAuditBatch(tx, [
        { tabla: 'empleados', registroId: quedaId, accion: 'UPDATE', usuarioId, valorNuevo: { cambios: plan.cambios }, contexto },
        ..._ids.movimientos.map((id) => ({ tabla: 'movimientos', registroId: id, accion: 'UPDATE' as const, usuarioId, valorAnterior: { entidadId: absorbidaId }, valorNuevo: { entidadId: quedaId }, contexto })),
        ..._ids.liquidaciones.map((id) => ({ tabla: 'liquidaciones_empleado', registroId: id, accion: 'UPDATE' as const, usuarioId, valorAnterior: { empleadoId: absorbidaId }, valorNuevo: { empleadoId: quedaId }, contexto })),
        ..._ids.bancoHoras.map((id) => ({ tabla: 'movimientos_banco_horas', registroId: id, accion: 'UPDATE' as const, usuarioId, valorAnterior: { empleadoId: absorbidaId }, valorNuevo: { empleadoId: quedaId }, contexto })),
        { tabla: 'empleados', registroId: absorbidaId, accion: 'UPDATE', usuarioId, valorNuevo: { activo: false, unificadaEn: quedaId }, contexto },
      ]);
    },
    { timeout: 60_000 },
  );
  return {
    ok: true,
    movidos: { movimientos: _ids.movimientos.length, bancoHoras: _ids.bancoHoras.length, liquidaciones: _ids.liquidaciones.length },
    cambios: plan.cambios,
  };
}
