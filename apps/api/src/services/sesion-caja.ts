import { prisma } from '@sta/db/client';
import { EstadoSesionCaja, type SesionCaja } from '@sta/db';
import {
  getConfigHorarios,
  resolverSlotActivo,
  type ResolucionHorario,
} from './horarios.js';

/**
 * Error tipado que el caller puede inspeccionar para devolver un 400/409
 * con un mensaje claro al cajero ("estamos fuera de horario").
 */
export class FueraDeHorarioError extends Error {
  resolucion: ResolucionHorario;
  constructor(resolucion: ResolucionHorario) {
    super('Fuera del horario de atención configurado');
    this.name = 'FueraDeHorarioError';
    this.resolucion = resolucion;
  }
}

/**
 * Resuelve la sesión activa al momento `ahora`, consultando la config de
 * horarios. Si estamos en horario (ACTIVO o GRACE) y no existe sesión,
 * la crea con `existencia_inicial = 0` para que el cajero pueda vender
 * sin abrir caja manualmente.
 *
 * Auto-lock lazy: si llega una venta y la última sesión abierta corresponde
 * a un turno cuyo grace ya pasó, NO la cerramos (eso requiere conteo físico),
 * pero tampoco la reusamos: creamos la del nuevo slot. La vieja queda ABIERTA
 * y aparece en /admin/sesion-actual para que la encargada la cierre.
 *
 * Si estamos fuera de horario, lanza FueraDeHorarioError.
 */
export async function getOrCreateSesionActual(usuarioId: string): Promise<SesionCaja> {
  const ahora = new Date();
  const config = await getConfigHorarios();
  const resolucion = resolverSlotActivo(config, ahora);

  if (resolucion.tipo === 'CERRADO') {
    throw new FueraDeHorarioError(resolucion);
  }

  const { fechaSesion, turno } = resolucion.slot;

  const existing = await prisma.sesionCaja.findFirst({
    where: { fecha: fechaSesion, turno, estado: EstadoSesionCaja.ABIERTA },
  });
  if (existing) return existing;

  // Si hoy ya hubo una sesión de este turno cerrada ANTICIPADAMENTE, no
  // reabrir un slot nuevo el mismo día — el usuario eligió cerrar el turno
  // antes de tiempo, las ventas/movs nuevos deben esperar al siguiente turno.
  // Buscamos cualquier sesión del slot vigente con cerrada_anticipadamente=true.
  // Si hoy ya hubo una sesión de este turno cerrada anticipadamente, el
  // resolver no reabre el slot por el resto del día.
  const cerradaAntic = await prisma.sesionCaja.findFirst({
    where: {
      fecha: fechaSesion,
      turno,
      cerradaAnticipadamente: true,
    },
    select: { id: true },
  });
  if (cerradaAntic) {
    throw new FueraDeHorarioError(resolucion);
  }

  return prisma.sesionCaja.create({
    data: {
      fecha: fechaSesion,
      turno,
      horarioApertura: ahora,
      existenciaInicial: '0',
      usuarioAperturaId: usuarioId,
      estado: EstadoSesionCaja.ABIERTA,
    },
  });
}

/**
 * Devuelve el próximo numeroOrdenTurno para la sesión, garantizando atomicidad
 * bajo carga concurrente. Postgres garantiza que `UPDATE ... RETURNING` con
 * `increment` es atómico — dos cajas creando ventas en simultáneo nunca
 * obtienen el mismo valor.
 *
 * El campo `ultimoNumeroOrden` arranca en 0 al crear la sesión, así que el
 * primer valor devuelto es 1.
 */
export async function siguienteNumeroOrdenTurno(sesionId: string): Promise<number> {
  const updated = await prisma.sesionCaja.update({
    where: { id: sesionId },
    data: { ultimoNumeroOrden: { increment: 1 } },
    select: { ultimoNumeroOrden: true },
  });
  return updated.ultimoNumeroOrden;
}

/**
 * Versión "read-only" usada por endpoints admin que quieren saber qué sesión
 * está activa AHORA sin crear ninguna. Si no hay sesión ABIERTA en el slot
 * vigente, devuelve la más reciente del slot actual (puede no existir aún).
 */
export async function getSesionActualReadOnly(): Promise<{
  sesion: SesionCaja | null;
  resolucion: ResolucionHorario;
}> {
  const ahora = new Date();
  const config = await getConfigHorarios();
  const resolucion = resolverSlotActivo(config, ahora);

  if (resolucion.tipo === 'CERRADO') {
    // Devolver la última sesión abierta (de cualquier slot) para que el admin
    // pueda cerrarla aunque el grace haya pasado.
    const sesion = await prisma.sesionCaja.findFirst({
      where: { estado: EstadoSesionCaja.ABIERTA },
      orderBy: { horarioApertura: 'desc' },
    });
    return { sesion, resolucion };
  }

  const { fechaSesion, turno } = resolucion.slot;
  const sesion = await prisma.sesionCaja.findFirst({
    where: { fecha: fechaSesion, turno },
  });
  return { sesion, resolucion };
}
