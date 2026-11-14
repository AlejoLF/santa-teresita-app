import { prisma } from '@sta/db/client';
import { EstadoFacturaRecibida } from '@sta/db';
import { calcSaldoFactura } from './facturas.js';
import { aplicarImputacion, facturasPendientesDe, planificarImputacion } from './imputacion-facturas.js';
import { pagosSinFactura } from './saldo-proveedores.js';
import { recordAuditBatch } from './audit.js';

/**
 * Ordena lo que ya está cargado en las cuentas de proveedores (14/11):
 *
 *  1. CERRAR: facturas que figuran pendientes pero ya no deben nada (se
 *     pagaron por otro camino y nadie las tildó). Pasan a PAGADA.
 *  2. IMPUTAR: pagos sin factura cuyo monto es IDÉNTICO al saldo de una
 *     factura pendiente del mismo proveedor, emitida a lo sumo 7 días después
 *     del pago (un pago de marzo no paga una factura de octubre aunque sea del
 *     mismo monto: con pedidos fijos se repiten los importes). Cada pago y
 *     cada factura se usan una sola vez, de los más viejos a los más nuevos.
 *
 * Los pagos sin factura que no coinciden con nada no se tocan: si son de
 * antes del corte ya son históricos (saldados, no cuentan como saldo a favor;
 * ver saldo-proveedores.ts).
 *
 * `vistaPrevia` no escribe nada. `aplicar` recalcula el plan y aplica sólo lo
 * que la encargada dejó tildado.
 */

const DIAS_TOLERANCIA = 7;

export async function vistaPreviaConciliacion() {
  const [pendientes, proveedores] = await Promise.all([
    prisma.facturaRecibida.findMany({
      where: { estado: { in: ['PENDIENTE_PAGO', 'PAGADA_PARCIAL'] }, tipoComprobante: { notIn: ['NOTA_CREDITO'] } },
      select: { id: true, proveedorId: true, numero: true, puntoVenta: true, tipoComprobante: true, total: true, totalPagado: true, fechaEmision: true },
      orderBy: [{ fechaEmision: 'asc' }, { numero: 'asc' }],
    }),
    prisma.proveedor.findMany({ select: { id: true, nombre: true } }),
  ]);
  const nombre = new Map(proveedores.map((p) => [p.id, p.nombre]));
  const nro = (f: { puntoVenta: string | null; numero: string }) => (f.puntoVenta ? `${f.puntoVenta}-${f.numero}` : f.numero);

  const cerrar = pendientes
    .filter((f) => calcSaldoFactura(f) <= 0.01)
    .map((f) => ({ facturaId: f.id, proveedor: nombre.get(f.proveedorId) ?? '?', numero: nro(f), total: Number(f.total).toFixed(2), pagado: Number(f.totalPagado).toFixed(2) }));

  const abiertas = pendientes.filter((f) => calcSaldoFactura(f) > 0.01);
  const pagos = (await pagosSinFactura('todos')).sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
  const usadas = new Set<string>();
  const imputar: Array<{ movimientoId: string; facturaId: string; proveedor: string; fechaPago: string; monto: string; factura: string; fechaFactura: string }> = [];
  for (const p of pagos) {
    const limite = p.fecha.getTime() + DIAS_TOLERANCIA * 86_400_000;
    const f = abiertas.find((x) =>
      x.proveedorId === p.proveedorId && !usadas.has(x.id) && x.fechaEmision.getTime() <= limite &&
      Math.abs(calcSaldoFactura(x) - p.monto) <= 0.01);
    if (!f) continue;
    usadas.add(f.id);
    imputar.push({
      movimientoId: p.movimientoId,
      facturaId: f.id,
      proveedor: nombre.get(p.proveedorId) ?? '?',
      fechaPago: p.fecha.toISOString(),
      monto: p.monto.toFixed(2),
      factura: nro(f),
      fechaFactura: f.fechaEmision.toISOString(),
    });
  }

  // Lo que queda como histórico, por proveedor: para que se vea cuánto se "obvia".
  const historicosPorProveedor = new Map<string, { proveedor: string; cantidad: number; total: number }>();
  const imputados = new Set(imputar.map((i) => i.movimientoId));
  for (const p of pagos) {
    if (!p.historico || imputados.has(p.movimientoId)) continue;
    const h = historicosPorProveedor.get(p.proveedorId) ?? { proveedor: nombre.get(p.proveedorId) ?? '?', cantidad: 0, total: 0 };
    h.cantidad += 1; h.total += p.monto;
    historicosPorProveedor.set(p.proveedorId, h);
  }

  return {
    cerrar,
    imputar,
    historicos: [...historicosPorProveedor.values()]
      .sort((a, b) => b.total - a.total)
      .map((h) => ({ ...h, total: h.total.toFixed(2) })),
  };
}

export async function aplicarConciliacion(args: { cerrar: string[]; imputar: string[]; usuarioId: string }) {
  const plan = await vistaPreviaConciliacion();
  const aCerrar = plan.cerrar.filter((c) => args.cerrar.includes(c.facturaId));
  const aImputar = plan.imputar.filter((i) => args.imputar.includes(i.movimientoId));
  let cerradas = 0;
  let imputadas = 0;

  for (const c of aCerrar) {
    await prisma.$transaction(async (tx) => {
      await tx.facturaRecibida.update({ where: { id: c.facturaId }, data: { estado: EstadoFacturaRecibida.PAGADA, pagadaAt: new Date() } });
      await recordAuditBatch(tx, [{
        tabla: 'facturas_recibidas', registroId: c.facturaId, accion: 'UPDATE', usuarioId: args.usuarioId,
        valorNuevo: { estado: 'PAGADA' }, contexto: { motivo: 'conciliación: saldo 0 sin tildar' },
      }]);
    });
    cerradas += 1;
  }

  for (const i of aImputar) {
    await prisma.$transaction(async (tx) => {
      const mov = await tx.movimiento.findUniqueOrThrow({ where: { id: i.movimientoId }, select: { id: true, entidadId: true, fechaComputo: true, monto: true, pagos: { select: { id: true } } } });
      const pendientes = await facturasPendientesDe(tx, mov.entidadId!);
      const imp = planificarImputacion(pendientes, Number(mov.monto), [{ facturaId: i.facturaId }]);
      await aplicarImputacion(tx, {
        asignaciones: imp.asignaciones,
        facturas: pendientes,
        movimientoId: mov.id,
        // Con UN pago, la imputación cuelga de él (PagoFactura): así la ficha
        // lo ve atado a la factura. Con varios o ninguno, del movimiento.
        ...(mov.pagos.length === 1 && { pagoId: mov.pagos[0]!.id }),
        fecha: mov.fechaComputo,
      });
      await recordAuditBatch(tx, [
        { tabla: 'facturas_recibidas', registroId: i.facturaId, accion: 'UPDATE', usuarioId: args.usuarioId, valorNuevo: { pagadaCon: mov.id }, contexto: { motivo: 'conciliación: pago sin factura del mismo monto' } },
        { tabla: 'movimientos', registroId: mov.id, accion: 'UPDATE', usuarioId: args.usuarioId, valorNuevo: { imputadoA: i.facturaId }, contexto: { motivo: 'conciliación: pago sin factura del mismo monto' } },
      ]);
    });
    imputadas += 1;
  }
  return { cerradas, imputadas };
}
