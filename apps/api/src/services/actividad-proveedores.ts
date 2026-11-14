import { prisma } from '@sta/db/client';
import { Prisma } from '@sta/db';
import { importeConSigno } from './facturas.js';
import { CORTE_PAGOS_A_CUENTA } from './saldo-proveedores.js';
import {
  esBusquedaNumerica,
  whereRangoDiaUtc,
  whereRangoFecha,
  type FiltroTemporal,
} from './filtro-temporal.js';

/**
 * Buscador de Insumos y proveedores: facturas, notas de crédito y pagos en UNA
 * sola lista, con los mismos filtros que "Aportes y egresos" (texto, tipo,
 * fecha, sesión). Sirve para todos los proveedores o para uno solo (la ficha).
 *
 * Los pagos salen de `movimientos` (EGRESO con `entidadId` = proveedor): es la
 * misma fila que se ve en Aportes y egresos, así que lo que aparece acá
 * aparece allá y al revés.
 *
 * Paginación sobre dos tablas: se traen de cada una las primeras
 * `page * pageSize` filas ordenadas por fecha, se mezclan y se corta la página.
 * Con páginas de 12 eso son pocas filas; el `total` es la suma de los dos
 * conteos.
 */

export type ClaseActividad = 'FACTURA' | 'NOTA_CREDITO' | 'PAGO';
export type EstadoActividad = 'PENDIENTE' | 'PAGADA' | 'ANULADA';

export interface FilaActividad {
  clase: ClaseActividad;
  id: string; // facturaId o movimientoId
  fecha: string;
  proveedorId: string;
  proveedorNombre: string;
  descripcion: string;
  detalle: string | null;
  monto: string; // con signo para la NC (resta)
  saldo: string | null; // sólo facturas
  estado: string;
  /** Pago sin factura cargado antes del corte: ya saldado, no es saldo a favor. */
  historico?: boolean;
}

const ci = (v: string) => ({ contains: v, mode: 'insensitive' as const });

const TIPO_LABEL: Record<string, string> = {
  FACTURA_A: 'Factura A',
  FACTURA_B: 'Factura B',
  FACTURA_C: 'Factura C',
  FACTURA_X: 'Factura X',
  NOTA_CREDITO: 'Nota de crédito',
};
const METODO_LABEL: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  TRANSFERENCIA: 'Transferencia',
  DEPOSITO: 'Depósito',
  CHEQUE: 'Cheque',
  MERCADOPAGO_QR: 'MercadoPago',
  OTRO: 'Otro',
};

export async function buscarActividad(args: {
  proveedorId?: string;
  texto?: string;
  clase?: ClaseActividad;
  estado?: EstadoActividad;
  ft: FiltroTemporal;
  page: number;
  pageSize: number;
  /** Export: sin paginar, hasta este tope. */
  tope?: number;
}) {
  const { texto, ft } = args;

  // Proveedores en juego. Sin proveedor puntual, todos (incluidos los dados de
  // baja: sus pagos viejos también tienen que poder encontrarse).
  const proveedores = await prisma.proveedor.findMany({
    where: args.proveedorId ? { id: args.proveedorId } : {},
    select: { id: true, nombre: true },
  });
  const nombrePorId = new Map(proveedores.map((p) => [p.id, p.nombre]));
  const ids = proveedores.map((p) => p.id);
  const idsPorNombre = texto
    ? proveedores
        .filter((p) => p.nombre.toLowerCase().includes(texto.toLowerCase()))
        .map((p) => p.id)
    : [];

  // ── Facturas / NC ────────────────────────────────────────────────────────
  // Sin sesión de caja propia: con un filtro por sesión se toman las cargadas
  // durante esa sesión (por `creadoAt`).
  let rangoSesion: { gte: Date; lte?: Date } | null = null;
  if (ft.sesionCajaId) {
    const s = await prisma.sesionCaja.findUnique({
      where: { id: ft.sesionCajaId },
      select: { horarioApertura: true, horarioCierre: true },
    });
    rangoSesion = s
      ? { gte: s.horarioApertura, ...(s.horarioCierre && { lte: s.horarioCierre }) }
      : { gte: new Date(8.64e15) }; // sesión inexistente → nada
  }
  const quiereFacturas = args.clase !== 'PAGO';
  const quierePagos = !args.clase || args.clase === 'PAGO';

  const whereFactura: Prisma.FacturaRecibidaWhereInput = {
    proveedorId: args.proveedorId ?? { in: ids },
    ...(args.clase === 'NOTA_CREDITO'
      ? { tipoComprobante: 'NOTA_CREDITO' }
      : args.clase === 'FACTURA'
        ? { tipoComprobante: { not: 'NOTA_CREDITO' } }
        : {}),
    ...(args.estado === 'PENDIENTE' && {
      estado: { in: ['PENDIENTE_VALIDACION', 'PENDIENTE_PAGO', 'PAGADA_PARCIAL'] },
    }),
    ...(args.estado === 'PAGADA' && { estado: 'PAGADA' }),
    ...(args.estado === 'ANULADA' && { estado: 'ANULADA' }),
    ...(rangoSesion ? { creadoAt: rangoSesion } : whereRangoDiaUtc('fechaEmision', ft)),
    ...(texto && {
      OR: [
        { numero: ci(texto) },
        { puntoVenta: ci(texto) },
        { observaciones: ci(texto) },
        { razonSocialEmisor: ci(texto) },
        ...(idsPorNombre.length ? [{ proveedorId: { in: idsPorNombre } }] : []),
        ...(esBusquedaNumerica(texto) ? [{ total: texto }] : []),
      ],
    }),
  };

  // ── Pagos ────────────────────────────────────────────────────────────────
  const whereMov: Prisma.MovimientoWhereInput = {
    tipo: 'EGRESO',
    entidadId: args.proveedorId ?? { in: ids },
    ...(args.estado === 'ANULADA'
      ? { estado: 'ANULADO' }
      : args.estado === 'PENDIENTE' || args.estado === 'PAGADA'
        ? { id: { in: [] } } // "pendiente"/"pagada" es estado de una factura, no de un pago
        : {}),
    ...(ft.sesionCajaId && { sesionCajaId: ft.sesionCajaId }),
    ...whereRangoFecha('fechaComputo', ft),
    ...(texto && {
      OR: [
        { observacion: ci(texto) },
        { cuentaOrigen: { nombre: ci(texto) } },
        { pagos: { some: { numeroReferencia: ci(texto) } } },
        { pagos: { some: { cuenta: { nombre: ci(texto) } } } },
        { facturasAsociadas: { some: { factura: { numero: ci(texto) } } } },
        { pagosFactura: { some: { factura: { numero: ci(texto) } } } },
        ...(idsPorNombre.length ? [{ entidadId: { in: idsPorNombre } }] : []),
        ...(esBusquedaNumerica(texto) ? [{ monto: texto }] : []),
      ],
    }),
  };

  const take = args.tope ?? args.page * args.pageSize;
  const [facturas, nFacturas, movs, nMovs, sumF, sumP] = await Promise.all([
    quiereFacturas
      ? prisma.facturaRecibida.findMany({
          where: whereFactura,
          select: {
            id: true,
            proveedorId: true,
            tipoComprobante: true,
            puntoVenta: true,
            numero: true,
            fechaEmision: true,
            total: true,
            totalPagado: true,
            estado: true,
            observaciones: true,
          },
          orderBy: [{ fechaEmision: 'desc' }, { creadoAt: 'desc' }],
          take,
        })
      : [],
    quiereFacturas ? prisma.facturaRecibida.count({ where: whereFactura }) : 0,
    quierePagos
      ? prisma.movimiento.findMany({
          where: whereMov,
          select: {
            id: true,
            entidadId: true,
            fechaComputo: true,
            fechaAlta: true,
            monto: true,
            estado: true,
            observacion: true,
            adicionales: true,
            cuentaOrigen: { select: { nombre: true } },
            pagos: { select: { metodo: true, monto: true, numeroReferencia: true, cuenta: { select: { nombre: true } } } },
            facturasAsociadas: { select: { factura: { select: { numero: true, puntoVenta: true } } } },
            pagosFactura: { select: { factura: { select: { numero: true, puntoVenta: true } } } },
            categoria: { select: { nombre: true } },
          },
          orderBy: { fechaComputo: 'desc' },
          take,
        })
      : [],
    quierePagos ? prisma.movimiento.count({ where: whereMov }) : 0,
    quiereFacturas
      ? prisma.facturaRecibida.groupBy({
          by: ['tipoComprobante'],
          where: { ...whereFactura, estado: { not: 'ANULADA' } },
          _sum: { total: true },
        })
      : [],
    quierePagos
      ? prisma.movimiento.aggregate({
          where: { ...whereMov, estado: 'CONFIRMADO' },
          _sum: { monto: true },
        })
      : null,
  ]);

  const numeroDe = (f: { numero: string; puntoVenta: string | null }) =>
    f.puntoVenta ? `${f.puntoVenta}-${f.numero}` : f.numero;

  const filas: FilaActividad[] = [
    ...facturas.map((f): FilaActividad => {
      const esNC = f.tipoComprobante === 'NOTA_CREDITO';
      const saldo = Number(f.total) - Number(f.totalPagado);
      return {
        clase: esNC ? 'NOTA_CREDITO' : 'FACTURA',
        id: f.id,
        fecha: f.fechaEmision.toISOString(),
        proveedorId: f.proveedorId,
        proveedorNombre: nombrePorId.get(f.proveedorId) ?? '—',
        descripcion: `${TIPO_LABEL[f.tipoComprobante] ?? f.tipoComprobante} ${numeroDe(f)}`,
        detalle: f.observaciones,
        monto: importeConSigno(f).toFixed(2),
        saldo: esNC ? null : saldo.toFixed(2),
        estado: f.estado,
      };
    }),
    ...movs.map((m): FilaActividad => {
      const facturasPagadas = [
        ...m.facturasAsociadas.map((x) => numeroDe(x.factura)),
        ...m.pagosFactura.map((x) => numeroDe(x.factura)),
      ];
      const unicas = [...new Set(facturasPagadas)];
      const formas = m.pagos.length
        ? m.pagos
            .map((p) => `${METODO_LABEL[p.metodo] ?? p.metodo} · ${p.cuenta.nombre}${p.numeroReferencia ? ` (${p.numeroReferencia})` : ''}`)
            .join(' + ')
        : (m.cuentaOrigen?.nombre ?? m.categoria?.nombre ?? '');
      const sinFactura = unicas.length === 0;
      const ad = m.adicionales as Record<string, unknown> | null;
      return {
        clase: 'PAGO',
        id: m.id,
        fecha: m.fechaComputo.toISOString(),
        proveedorId: m.entidadId!,
        proveedorNombre: nombrePorId.get(m.entidadId!) ?? '—',
        descripcion: sinFactura
          ? 'Pago sin factura'
          : `Pago de ${unicas.length === 1 ? 'factura' : 'facturas'} ${unicas.join(', ')}`,
        detalle: [formas, m.observacion].filter(Boolean).join(' — ') || null,
        monto: Number(m.monto).toFixed(2),
        saldo: null,
        estado: m.estado,
        ...(sinFactura &&
          m.estado === 'CONFIRMADO' &&
          (m.fechaAlta < CORTE_PAGOS_A_CUENTA || !!ad?.pagoHistoricoSinFactura) && { historico: true }),
      };
    }),
  ].sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));

  const desde = args.tope ? 0 : (args.page - 1) * args.pageSize;
  const pagina = args.tope ? filas.slice(0, args.tope) : filas.slice(desde, desde + args.pageSize);

  let facturado = 0;
  for (const g of sumF) {
    const t = Number(g._sum.total ?? 0);
    facturado += g.tipoComprobante === 'NOTA_CREDITO' ? -Math.abs(t) : t;
  }
  return {
    filas: pagina,
    total: nFacturas + nMovs,
    sumas: {
      facturado: facturado.toFixed(2),
      pagado: Number(sumP?._sum.monto ?? 0).toFixed(2),
    },
  };
}
