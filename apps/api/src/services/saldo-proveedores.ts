import { prisma } from '@sta/db/client';
import { Prisma } from '@sta/db';
import { calcSaldoFactura } from './facturas.js';

/**
 * EL saldo de un proveedor, calculado en UN solo lugar.
 *
 * ─── Por qué existe (incidente 14/11, Cooperativa Alimentos Roca) ────────
 *
 * La lista de proveedores y la ficha de cada uno sacaban el saldo con dos
 * cuentas distintas: la lista sumaba sólo las facturas pendientes; la ficha
 * además les restaba los "pagos a cuenta". El mismo proveedor daba
 * $1.192.495 en la lista y $504.278 en la ficha.
 *
 * Y los "pagos a cuenta" estaban mal contados por tres lados:
 *  1. Antes de que existiera la carga de facturas, a los proveedores se les
 *     pagaba sin factura. Esos pagos quedaron "libres" y aparecían como plata a
 *     favor (proveedores con $9 millones a favor). No son crédito: pagaban
 *     deudas que nunca se cargaron como factura.
 *  2. Un egreso desde "Aportes y egresos" que SÍ imputó facturas no deja
 *     `PagoFactura` (deja `MovimientoFactura`), así que si además tenía una
 *     fila de `pagos` se contaba como pago a cuenta: la factura bajaba por un
 *     lado y el saldo otra vez por el otro.
 *  3. No se miraba si el movimiento estaba anulado.
 *
 * ─── La regla ────────────────────────────────────────────────────────────
 *
 *   saldo = Σ saldo de facturas pendientes (las notas de crédito restan)
 *         − Σ pagos a cuenta VIGENTES
 *
 * Un pago a cuenta vigente es un EGRESO confirmado al proveedor que no está
 * atado a ninguna factura (ni por `MovimientoFactura` ni por `PagoFactura`),
 * cargado DESDE el corte, y que nadie marcó como histórico. Lo cargado antes
 * del corte sin factura es HISTÓRICO: se muestra, pero ya está saldado y no
 * cuenta para nada. No se borra ni se toca.
 */

/** Desde acá, un pago sin factura es crédito a favor. Antes, histórico. */
export const CORTE_PAGOS_A_CUENTA = new Date('2026-11-15T03:00:00Z'); // 15/11/2026 00:00 AR

export interface PagoSinFactura {
  movimientoId: string;
  proveedorId: string;
  fecha: Date;
  fechaAlta: Date;
  monto: number;
  metodo: string;
  cuentaNombre: string | null;
  numeroReferencia: string | null;
  observacion: string | null;
  historico: boolean;
}

const esHistorico = (m: { fechaAlta: Date; adicionales: Prisma.JsonValue | null }) =>
  m.fechaAlta < CORTE_PAGOS_A_CUENTA ||
  !!(m.adicionales && typeof m.adicionales === 'object' && (m.adicionales as Record<string, unknown>).pagoHistoricoSinFactura);

/** Los egresos confirmados a estos proveedores que no están atados a ninguna factura. */
export async function pagosSinFactura(proveedorIds: string[] | 'todos'): Promise<PagoSinFactura[]> {
  const proveedores = proveedorIds === 'todos'
    ? (await prisma.proveedor.findMany({ select: { id: true } })).map((p) => p.id)
    : proveedorIds;
  if (proveedores.length === 0) return [];
  const movs = await prisma.movimiento.findMany({
    where: {
      tipo: 'EGRESO',
      estado: 'CONFIRMADO',
      entidadId: { in: proveedores },
      facturasAsociadas: { none: {} },
      pagosFactura: { none: {} },
      pagos: { none: { pagosFactura: { some: {} } } },
    },
    select: {
      id: true, entidadId: true, fechaComputo: true, fechaAlta: true, monto: true, observacion: true, adicionales: true,
      cuentaOrigen: { select: { nombre: true } },
      pagos: { select: { metodo: true, numeroReferencia: true, cuenta: { select: { nombre: true } } }, take: 1 },
    },
    orderBy: { fechaComputo: 'desc' },
  });
  return movs.map((m) => ({
    movimientoId: m.id,
    proveedorId: m.entidadId!,
    fecha: m.fechaComputo,
    fechaAlta: m.fechaAlta,
    monto: Number(m.monto),
    metodo: m.pagos[0]?.metodo ?? 'EFECTIVO',
    cuentaNombre: m.pagos[0]?.cuenta.nombre ?? m.cuentaOrigen?.nombre ?? null,
    numeroReferencia: m.pagos[0]?.numeroReferencia ?? null,
    observacion: m.observacion,
    historico: esHistorico(m),
  }));
}

export interface SaldoProveedor {
  saldoFacturas: number;
  pagosACuenta: number;
  saldo: number;
  facturasPendientes: number;
  proximoVencimiento: Date | null;
}

/** Saldo de cada proveedor pedido (o de todos), con la regla de arriba. */
export async function saldosProveedores(proveedorIds: string[] | 'todos'): Promise<Map<string, SaldoProveedor>> {
  const [facturas, pagos] = await Promise.all([
    prisma.facturaRecibida.findMany({
      where: {
        estado: { in: ['PENDIENTE_PAGO', 'PAGADA_PARCIAL'] },
        ...(proveedorIds !== 'todos' && { proveedorId: { in: proveedorIds } }),
      },
      select: { proveedorId: true, total: true, totalPagado: true, tipoComprobante: true, fechaVencimiento: true },
    }),
    pagosSinFactura(proveedorIds),
  ]);
  const map = new Map<string, SaldoProveedor>();
  const get = (id: string) => {
    let s = map.get(id);
    if (!s) { s = { saldoFacturas: 0, pagosACuenta: 0, saldo: 0, facturasPendientes: 0, proximoVencimiento: null }; map.set(id, s); }
    return s;
  };
  for (const f of facturas) {
    const s = get(f.proveedorId);
    const saldo = calcSaldoFactura(f);
    s.saldoFacturas += saldo;
    // Una factura con saldo 0 no está pendiente aunque su estado lo diga (se
    // pagó por otro camino): ni se cuenta ni "vence".
    if (f.tipoComprobante !== 'NOTA_CREDITO' && saldo > 0.01) {
      s.facturasPendientes += 1;
      if (f.fechaVencimiento && (!s.proximoVencimiento || f.fechaVencimiento < s.proximoVencimiento)) s.proximoVencimiento = f.fechaVencimiento;
    }
  }
  for (const p of pagos) {
    if (p.historico) continue;
    get(p.proveedorId).pagosACuenta += p.monto;
  }
  for (const s of map.values()) {
    s.saldoFacturas = Number(s.saldoFacturas.toFixed(2));
    s.pagosACuenta = Number(s.pagosACuenta.toFixed(2));
    s.saldo = Number((s.saldoFacturas - s.pagosACuenta).toFixed(2));
  }
  return map;
}
