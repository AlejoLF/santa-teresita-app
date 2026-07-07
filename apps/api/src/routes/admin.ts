import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import {
  EstadoVenta,
  EstadoLiquidacion,
  EstadoMovimiento,
  EstadoSesionCaja,
  TipoCategoriaMovimiento,
  RolUsuario,
} from '@sta/db';
import { queryBool } from '@sta/shared/schemas';
import { recordAudit } from '../services/audit.js';
import { clasificarCanalBucket, esVentaDeliverate } from '../services/clasificar-pago.js';
import {
  detectarCambiosListaPrecios,
  detectarCambiosProveedores,
  aplicarAprobacion,
  rechazarAprobacion,
  posponerAprobacion,
} from '../services/excel-sync.js';
import { cargarCierre, generarExcelCierre, generarHtmlCierre } from '../services/cierre-export.js';
import { sendMail, sendTestEmail } from '../services/mailer.js';
import { actualizarCashflow } from '../services/excel-writeback.js';
import {
  getSesionActualReadOnly,
  getSesionAnteriorReadOnly,
  getOrCreateSesionActual,
  FueraDeHorarioError,
} from '../services/sesion-caja.js';

/**
 * Auto-envío del email del cierre al cerrar la sesión. Helper standalone
 * (fuera de fastify) para que el handler del cierre dispare fire-and-forget
 * sin bloquear el response.
 *
 *   - Si la sesión no existe o no está cerrada → no hace nada.
 *   - Si la flag `email_auto_envio_cierre` está en false → no hace nada.
 *   - Si SMTP cae a Ethereal (no configurado) → log warning, no manda.
 *   - Si hay error → log, no rethrow (el caller debe hacer .catch()).
 */
async function enviarEmailDeCierreSiCorresponde(sesionId: string): Promise<void> {
  const flag = await prisma.configuracionSistema
    .findUnique({ where: { clave: 'email_auto_envio_cierre' } })
    .catch(() => null);
  if (flag && flag.valor !== 'true') {
    console.log(`[email-cierre] auto-envío deshabilitado (sesion=${sesionId})`);
    return;
  }
  const data = await cargarCierre(sesionId);
  const xlsx = await generarExcelCierre(data);
  const { subject, html, text } = generarHtmlCierre(data);
  const fechaSlug = data.sesion.fecha.toISOString().slice(0, 10);
  const turnoSlug = data.sesion.turno.toLowerCase();
  const result = await sendMail({
    subject,
    html,
    text,
    attachments: [
      {
        filename: `cierre-${fechaSlug}-${turnoSlug}.xlsx`,
        content: xlsx,
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  });
  if (result.isEthereal) {
    console.warn(
      `[email-cierre] sesion=${sesionId} usó Ethereal (SMTP no configurado). Preview: ${result.previewUrl}`,
    );
    return;
  }
  await prisma.sesionCaja.update({
    where: { id: sesionId },
    data: {
      emailEnviadoA: result.recipients.join(', '),
      emailEnviadoAt: new Date(),
    },
  });
  console.log(`[email-cierre] sesion=${sesionId} → ${result.recipients.join(', ')}`);
}

/**
 * Sincroniza la membresía de un producto en las listas CUSTOM (mayoristas).
 * Las listas pública y de canal incluyen a todos los productos implícitamente,
 * así que sólo se gestiona la pertenencia a las listas custom (PrecioPorLista).
 * Agrega las nuevas (al precio base × ajuste de la lista) y quita las
 * desmarcadas. `listaIds` es el set final de listas custom marcadas.
 */
async function syncListasCustomDeProducto(
  productoId: string,
  precioBase: string,
  listaIds: string[],
): Promise<void> {
  const custom = await prisma.listaPrecios.findMany({
    where: { canalDefault: 'MAYORISTA', activa: true },
    select: { id: true, ajustePctDefault: true },
  });
  const customIds = new Set(custom.map((c) => c.id));
  const ajuste = new Map(custom.map((c) => [c.id, Number(c.ajustePctDefault)]));
  const target = listaIds.filter((id) => customIds.has(id));
  const existentes = await prisma.precioPorLista.findMany({
    where: { productoId, listaId: { in: [...customIds] } },
    select: { listaId: true },
  });
  const existSet = new Set(existentes.map((e) => e.listaId));
  const base = Number(precioBase);
  for (const lid of target) {
    if (!existSet.has(lid)) {
      await prisma.precioPorLista.create({
        data: {
          productoId,
          listaId: lid,
          precioEfectivo: (base * (1 + (ajuste.get(lid) ?? 0) / 100)).toFixed(2),
          vigenciaDesde: new Date(),
        },
      });
    }
  }
  const remove = [...existSet].filter((id) => !target.includes(id));
  if (remove.length > 0) {
    await prisma.precioPorLista.deleteMany({ where: { productoId, listaId: { in: remove } } });
  }
}

/**
 * Endpoints exclusivos del rol Admin. Devuelven KPIs agregados para los dashboards.
 * Todas las queries usan agregaciones de Postgres (no fetch + sum en app) para que escale.
 */
export default async function adminRoutes(fastify: FastifyInstance) {
  // GET /admin/pendientes — endpoint liviano para el badge de notificaciones
  // del layout admin. El polling del layout llamaba /admin/dashboard (5-10KB,
  // 15 queries) solo para leer 3 contadores; ahora ese poll usa este endpoint
  // dedicado (~100 bytes, 3 counts en paralelo).
  fastify.get(
    '/admin/pendientes',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const [facturasSinValidar, cambiosExcelPendientes, sesionesSinAprobar] =
        await Promise.all([
          prisma.facturaRecibida.count({ where: { estado: 'PENDIENTE_VALIDACION' } }),
          prisma.aprobacionExcel.count({ where: { estado: 'PENDIENTE' } }),
          prisma.sesionCaja.count({ where: { estado: 'CERRADA' } }),
        ]);
      return {
        pendientes: {
          facturasSinValidar,
          cambiosExcelPendientes,
          sesionesSinAprobar,
        },
      };
    },
  );

  // GET /admin/dashboard — KPIs principales (Wireframe 06).
  fastify.get(
    '/admin/dashboard',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          periodo: z
            .enum(['sesion_actual', 'sesion_anterior', 'dia', 'semana', 'custom'])
            .default('dia'),
          desde: z.string().optional(), // ISO datetime, solo para custom
          hasta: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query as {
        periodo: 'sesion_actual' | 'sesion_anterior' | 'dia' | 'semana' | 'custom';
        desde?: string;
        hasta?: string;
      };
      const ahora = new Date();
      const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
      const inicioAyer = new Date(inicioHoy);
      inicioAyer.setDate(inicioAyer.getDate() - 1);
      const finAyer = new Date(inicioHoy);
      const en20Dias = new Date(inicioHoy);
      en20Dias.setDate(en20Dias.getDate() + 20);

      // Rango del período para los KPIs de ventas/pagos/movimientos. Las vistas
      // forward-looking (próximos depósitos, vencimientos) NO dependen de esto.
      let rangoDesde: Date = inicioHoy;
      let rangoHasta: Date = ahora;
      let rangoLabel = 'Hoy';
      if (q.periodo === 'sesion_actual') {
        const { sesion } = await getSesionActualReadOnly();
        if (sesion) {
          rangoDesde = sesion.horarioApertura;
          rangoHasta = ahora;
          rangoLabel = 'Sesión actual';
        } else {
          rangoLabel = 'Hoy (sin sesión abierta)';
        }
      } else if (q.periodo === 'sesion_anterior') {
        // Ventana [apertura, cierre] de la sesión inmediatamente previa a la
        // actual — mismo criterio de ventana-por-fechas que sesion_actual.
        const { sesion } = await getSesionAnteriorReadOnly();
        if (sesion) {
          rangoDesde = sesion.horarioApertura;
          rangoHasta = sesion.horarioCierre ?? ahora;
          rangoLabel = 'Sesión anterior';
        } else {
          rangoLabel = 'Hoy (sin sesión anterior)';
        }
      } else if (q.periodo === 'semana') {
        rangoDesde = new Date(inicioHoy);
        rangoDesde.setDate(rangoDesde.getDate() - 6);
        rangoHasta = ahora;
        rangoLabel = 'Últimos 7 días';
      } else if (q.periodo === 'custom' && q.desde && q.hasta) {
        rangoDesde = new Date(q.desde);
        rangoHasta = new Date(q.hasta);
        rangoLabel = 'Personalizado';
      }

      // BATCH 1 — todas las queries independientes corren en paralelo.
      // Pasamos de ~15 round-trips secuenciales a Supabase a 2 batches paralelos.
      // Con ~200ms RTT cada uno, esto reduce el endpoint de ~3000ms a ~600ms.
      const [
        ventasHoy,
        ventasAyer,
        pedidosAbiertos,
        pagosHoy,
        aportesPorCategoria,
        egresosPorCategoria,
        ventasPorCanal,
        proximosDepositos,
        cuentasACobrar,
        facturasSinValidar,
        facturasVencenPronto,
        cambiosExcelPendientes,
        sesionesSinAprobar,
        saldosCuentas,
      ] = await Promise.all([
        prisma.venta.aggregate({
          _sum: { total: true },
          _count: { _all: true },
          where: {
            estado: EstadoVenta.FINALIZADA,
            fechaFinalizacion: { gte: rangoDesde, lte: rangoHasta },
          },
        }),
        prisma.venta.aggregate({
          _sum: { total: true },
          _count: { _all: true },
          where: {
            estado: EstadoVenta.FINALIZADA,
            fechaFinalizacion: { gte: inicioAyer, lt: finAyer },
          },
        }),
        // `esEncargo: false`: los encargos A_PAGAR (pedidos futuros que se cobran
        // otro día) no son "pedidos abiertos" del turno — tienen su propia pestaña.
        prisma.venta.count({ where: { estado: EstadoVenta.PROCESADA, esEncargo: false } }),
        prisma.pago.findMany({
          where: {
            estado: 'CONFIRMADO',
            venta: {
              estado: EstadoVenta.FINALIZADA,
              fechaFinalizacion: { gte: rangoDesde, lte: rangoHasta },
            },
          },
          select: {
            metodo: true,
            monto: true,
            venta: { select: { canal: true, modalidad: true } },
          },
        }),
        prisma.movimiento.groupBy({
          by: ['categoriaId'],
          _sum: { monto: true },
          _count: { _all: true },
          where: {
            tipo: 'INGRESO',
            estado: EstadoMovimiento.CONFIRMADO,
            fechaComputo: { gte: rangoDesde, lte: rangoHasta },
          },
        }),
        prisma.movimiento.groupBy({
          by: ['categoriaId'],
          _sum: { monto: true },
          _count: { _all: true },
          where: {
            tipo: 'EGRESO',
            estado: EstadoMovimiento.CONFIRMADO,
            fechaComputo: { gte: rangoDesde, lte: rangoHasta },
          },
        }),
        prisma.venta.groupBy({
          by: ['canal'],
          _sum: { total: true },
          _count: { _all: true },
          where: {
            estado: EstadoVenta.FINALIZADA,
            fechaFinalizacion: { gte: rangoDesde, lte: rangoHasta },
          },
        }),
        prisma.liquidacionPendiente.groupBy({
          by: ['cuentaACobrarId', 'fechaAcreditacionEsperada'],
          _sum: { montoNetoEsperado: true },
          _count: { _all: true },
          where: {
            estado: EstadoLiquidacion.PENDIENTE,
            fechaAcreditacionEsperada: { gte: inicioHoy, lte: en20Dias },
          },
          orderBy: { fechaAcreditacionEsperada: 'asc' },
        }),
        prisma.cuentaACobrar.findMany({
          select: { id: true, nombre: true, cuentaDestino: { select: { nombre: true } } },
        }),
        prisma.facturaRecibida.count({ where: { estado: 'PENDIENTE_VALIDACION' } }),
        prisma.facturaRecibida.count({
          where: {
            estado: { in: ['PENDIENTE_PAGO', 'PAGADA_PARCIAL'] },
            fechaVencimiento: { gte: inicioHoy, lte: en20Dias },
          },
        }),
        prisma.aprobacionExcel.count({ where: { estado: 'PENDIENTE' } }),
        prisma.sesionCaja.count({ where: { estado: 'CERRADA' } }),
        prisma.cuenta.findMany({
          where: { activa: true },
          select: { id: true, nombre: true, tipo: true, saldoActual: true },
        }),
      ]);

      // Cobrado en efectivo del día = mostrador + Damián (excluye DELIVERATE).
      // Cobrado con tarjeta = todo lo no efectivo, también excluye DELIVERATE.
      type DesgloseEfectivo = {
        mostrador: { monto: number; cantidad: number };
        damian: { monto: number; cantidad: number };
        plataformas: { monto: number; cantidad: number }; // PYA, RAPPI, MELI con efectivo (suma a caja)
        deliverate: { monto: number; cantidad: number }; // informativo, no suma
      };
      type DesgloseTarjeta = {
        debito: { monto: number; cantidad: number };
        credito: { monto: number; cantidad: number };
        mpQr: { monto: number; cantidad: number };
        transferencia: { monto: number; cantidad: number };
        otro: { monto: number; cantidad: number };
      };
      const efDesglose: DesgloseEfectivo = {
        mostrador: { monto: 0, cantidad: 0 },
        damian: { monto: 0, cantidad: 0 },
        plataformas: { monto: 0, cantidad: 0 },
        deliverate: { monto: 0, cantidad: 0 },
      };
      const tjDesglose: DesgloseTarjeta = {
        debito: { monto: 0, cantidad: 0 },
        credito: { monto: 0, cantidad: 0 },
        mpQr: { monto: 0, cantidad: 0 },
        transferencia: { monto: 0, cantidad: 0 },
        otro: { monto: 0, cantidad: 0 },
      };
      for (const p of pagosHoy) {
        const monto = Number(p.monto);
        const bucket = clasificarCanalBucket(p.venta?.canal, p.venta?.modalidad);
        const esDeliverate = bucket === 'deliverate';

        if (p.metodo === 'EFECTIVO') {
          if (bucket === 'deliverate') {
            efDesglose.deliverate.monto += monto;
            efDesglose.deliverate.cantidad += 1;
          } else if (bucket === 'plataforma') {
            // Cliente pagó al motoquero de la app (típico de PYA) — SÍ suma a caja
            efDesglose.plataformas.monto += monto;
            efDesglose.plataformas.cantidad += 1;
          } else if (bucket === 'delivery_propio') {
            efDesglose.damian.monto += monto;
            efDesglose.damian.cantidad += 1;
          } else {
            efDesglose.mostrador.monto += monto;
            efDesglose.mostrador.cantidad += 1;
          }
        } else if (esDeliverate) {
          // No suma a tarjeta tampoco — DELIVERATE rinde semanal aparte
        } else {
          if (p.metodo === 'DEBITO') {
            tjDesglose.debito.monto += monto;
            tjDesglose.debito.cantidad += 1;
          } else if (
            p.metodo === 'CREDITO_1_PAGO' ||
            p.metodo === 'CREDITO_CUOTAS' ||
            p.metodo === 'TARJETA_NARANJA'
          ) {
            tjDesglose.credito.monto += monto;
            tjDesglose.credito.cantidad += 1;
          } else if (p.metodo === 'MERCADOPAGO_QR') {
            tjDesglose.mpQr.monto += monto;
            tjDesglose.mpQr.cantidad += 1;
          } else if (p.metodo === 'TRANSFERENCIA' || p.metodo === 'DEPOSITO') {
            tjDesglose.transferencia.monto += monto;
            tjDesglose.transferencia.cantidad += 1;
          } else {
            tjDesglose.otro.monto += monto;
            tjDesglose.otro.cantidad += 1;
          }
        }
      }

      const totalEfectivo =
        efDesglose.mostrador.monto +
        efDesglose.damian.monto +
        efDesglose.plataformas.monto;
      const totalTarjeta =
        tjDesglose.debito.monto +
        tjDesglose.credito.monto +
        tjDesglose.mpQr.monto +
        tjDesglose.transferencia.monto +
        tjDesglose.otro.monto;

      // BATCH 2 — resolver nombres de categorías (depende de batch 1).
      const categoriasIds = Array.from(
        new Set([
          ...aportesPorCategoria.map((a) => a.categoriaId),
          ...egresosPorCategoria.map((e) => e.categoriaId),
        ]),
      );
      const categoriasMov = categoriasIds.length
        ? await prisma.categoriaMovimiento.findMany({
            where: { id: { in: categoriasIds } },
            select: { id: true, nombre: true },
          })
        : [];
      const catNombre = new Map(categoriasMov.map((c) => [c.id, c.nombre]));

      const aportesDetalle = aportesPorCategoria.map((a) => ({
        categoria: catNombre.get(a.categoriaId) ?? '—',
        monto: Number(a._sum.monto ?? 0),
        cantidad: a._count._all,
      }));
      const egresosDetalle = egresosPorCategoria.map((e) => ({
        categoria: catNombre.get(e.categoriaId) ?? '—',
        monto: Number(e._sum.monto ?? 0),
        cantidad: e._count._all,
      }));

      const totalAportes = aportesDetalle.reduce((acc, a) => acc + a.monto, 0);
      const totalEgresos = egresosDetalle.reduce((acc, e) => acc + e.monto, 0);
      const cantAportes = aportesDetalle.reduce((acc, a) => acc + a.cantidad, 0);
      const cantEgresos = egresosDetalle.reduce((acc, e) => acc + e.cantidad, 0);

      const cuentaPorId = new Map(cuentasACobrar.map((c) => [c.id, c]));

      const totalVentasHoy = Number(ventasHoy._sum.total ?? 0);
      const totalVentasAyer = Number(ventasAyer._sum.total ?? 0);
      const variacionPct =
        totalVentasAyer > 0
          ? ((totalVentasHoy - totalVentasAyer) / totalVentasAyer) * 100
          : null;

      // Sesiones de turnos anteriores que quedaron ABIERTAS sin cerrar (todas
      // las ABIERTA menos la del slot vigente). Alimenta la alerta roja del
      // dashboard: "cerrá/aprobá la caja anterior antes de empezar la siguiente".
      const sesionesAbiertasTodas = await prisma.sesionCaja.findMany({
        where: { estado: EstadoSesionCaja.ABIERTA },
        select: { id: true },
      });
      const { sesion: sesionSlotActual } = await getSesionActualReadOnly();
      const sesionesAbiertasViejas = sesionesAbiertasTodas.filter(
        (s) => s.id !== sesionSlotActual?.id,
      ).length;

      return {
        periodo: {
          tipo: q.periodo,
          label: rangoLabel,
          desde: rangoDesde.toISOString(),
          hasta: rangoHasta.toISOString(),
        },
        kpis: {
          ventasHoy: {
            monto: totalVentasHoy.toFixed(2),
            cantidad: ventasHoy._count._all,
            variacionPct: variacionPct !== null ? Number(variacionPct.toFixed(1)) : null,
            porCanal: ventasPorCanal.map((v) => ({
              canal: v.canal,
              monto: Number(v._sum.total ?? 0).toFixed(2),
              cantidad: v._count._all,
            })),
          },
          cobradoEfectivo: {
            monto: totalEfectivo.toFixed(2),
            cantidad:
              efDesglose.mostrador.cantidad +
              efDesglose.damian.cantidad +
              efDesglose.plataformas.cantidad,
            desglose: {
              mostrador: {
                monto: efDesglose.mostrador.monto.toFixed(2),
                cantidad: efDesglose.mostrador.cantidad,
              },
              damian: {
                monto: efDesglose.damian.monto.toFixed(2),
                cantidad: efDesglose.damian.cantidad,
              },
              plataformas: {
                monto: efDesglose.plataformas.monto.toFixed(2),
                cantidad: efDesglose.plataformas.cantidad,
              },
              deliverateInformativo: {
                monto: efDesglose.deliverate.monto.toFixed(2),
                cantidad: efDesglose.deliverate.cantidad,
              },
            },
          },
          cobradoTarjeta: {
            monto: totalTarjeta.toFixed(2),
            cantidad:
              tjDesglose.debito.cantidad +
              tjDesglose.credito.cantidad +
              tjDesglose.mpQr.cantidad +
              tjDesglose.transferencia.cantidad +
              tjDesglose.otro.cantidad,
            desglose: {
              debito: {
                monto: tjDesglose.debito.monto.toFixed(2),
                cantidad: tjDesglose.debito.cantidad,
              },
              credito: {
                monto: tjDesglose.credito.monto.toFixed(2),
                cantidad: tjDesglose.credito.cantidad,
              },
              mpQr: {
                monto: tjDesglose.mpQr.monto.toFixed(2),
                cantidad: tjDesglose.mpQr.cantidad,
              },
              transferencia: {
                monto: tjDesglose.transferencia.monto.toFixed(2),
                cantidad: tjDesglose.transferencia.cantidad,
              },
              otro: {
                monto: tjDesglose.otro.monto.toFixed(2),
                cantidad: tjDesglose.otro.cantidad,
              },
            },
          },
          aportesHoy: {
            monto: totalAportes.toFixed(2),
            cantidad: cantAportes,
            porCategoria: aportesDetalle.map((a) => ({
              categoria: a.categoria,
              monto: a.monto.toFixed(2),
              cantidad: a.cantidad,
            })),
          },
          egresosHoy: {
            monto: totalEgresos.toFixed(2),
            cantidad: cantEgresos,
            porCategoria: egresosDetalle.map((e) => ({
              categoria: e.categoria,
              monto: e.monto.toFixed(2),
              cantidad: e.cantidad,
            })),
          },
          pedidosAbiertos,
        },
        proximosDepositos: proximosDepositos.map((p) => {
          const cuenta = cuentaPorId.get(p.cuentaACobrarId);
          return {
            fuente: cuenta?.nombre ?? 'Desconocida',
            cuentaDestino: cuenta?.cuentaDestino?.nombre ?? null,
            fecha: p.fechaAcreditacionEsperada,
            monto: Number(p._sum.montoNetoEsperado ?? 0).toFixed(2),
            operaciones: p._count._all,
          };
        }),
        pendientes: {
          facturasSinValidar,
          facturasVencenPronto,
          cambiosExcelPendientes,
          sesionesSinAprobar,
          sesionesAbiertasViejas,
        },
        saldosCuentas: saldosCuentas.map((c) => ({
          id: c.id,
          nombre: c.nombre,
          tipo: c.tipo,
          saldoActual: c.saldoActual.toFixed(2),
        })),
      };
    },
  );

  // GET /admin/ventas-por-hora — para el gráfico de hoy, con comparación contra
  // el MISMO DÍA de la semana anterior (sábado 12hs vs sábado pasado 12hs) —
  // pedido del dueño: comparar con "ayer" no sirve porque cada día de la semana
  // tiene un patrón distinto.
  fastify.get(
    '/admin/ventas-por-hora',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      // TODO en hora ARGENTINA explícita, sin depender de la TZ del proceso ni
      // de la TZ de sesión de Postgres. Las columnas son `timestamp` naive que
      // guardan UTC → la conversión correcta es UTC-primero:
      //   (col AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')
      // (Incidente: EXTRACT(HOUR) directo devolvía la hora UTC → el gráfico
      // mostraba "hora europea", 3 h adelantada.)
      const hoyAR = new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
      });
      // Mismo día de la semana pasada (aritmética segura a mediodía UTC).
      const dAnterior = new Date(`${hoyAR}T12:00:00Z`);
      dAnterior.setUTCDate(dAnterior.getUTCDate() - 7);
      const semanaPasadaAR = dAnterior.toISOString().slice(0, 10);

      // Postgres: extraer hora AR y agrupar (hoy + mismo día semana pasada)
      const [rows, rowsAnterior] = await Promise.all([
        prisma.$queryRaw<Array<{ hora: number; cantidad: bigint; total: number }>>`
          SELECT
            EXTRACT(HOUR FROM (fecha_finalizacion AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int AS hora,
            COUNT(*)::bigint AS cantidad,
            SUM(total)::float AS total
          FROM ventas
          WHERE estado = 'FINALIZADA'
            AND (fecha_finalizacion AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = ${hoyAR}::date
          GROUP BY hora
          ORDER BY hora ASC
        `,
        prisma.$queryRaw<Array<{ hora: number; cantidad: bigint; total: number }>>`
          SELECT
            EXTRACT(HOUR FROM (fecha_finalizacion AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int AS hora,
            COUNT(*)::bigint AS cantidad,
            SUM(total)::float AS total
          FROM ventas
          WHERE estado = 'FINALIZADA'
            AND (fecha_finalizacion AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = ${semanaPasadaAR}::date
          GROUP BY hora
          ORDER BY hora ASC
        `,
      ]);

      // Llenamos huecos (horas sin ventas → 0)
      const map = new Map<number, { cantidad: number; total: number }>();
      for (const r of rows) {
        map.set(r.hora, { cantidad: Number(r.cantidad), total: Number(r.total ?? 0) });
      }
      const mapAnterior = new Map<number, { cantidad: number; total: number }>();
      for (const r of rowsAnterior) {
        mapAnterior.set(r.hora, { cantidad: Number(r.cantidad), total: Number(r.total ?? 0) });
      }
      const horas: Array<{ hora: number; cantidad: number; total: number }> = [];
      const horasSemanaAnterior: Array<{ hora: number; cantidad: number; total: number }> = [];
      for (let h = 9; h <= 23; h++) {
        const r = map.get(h);
        horas.push({ hora: h, cantidad: r?.cantidad ?? 0, total: r?.total ?? 0 });
        const ra = mapAnterior.get(h);
        horasSemanaAnterior.push({ hora: h, cantidad: ra?.cantidad ?? 0, total: ra?.total ?? 0 });
      }
      // Etiqueta del día comparado, ej. "sábado 24/06". Mediodía UTC + timeZone
      // UTC para que el día no se corra sin importar la TZ del proceso.
      const diaAnteriorLabel = new Date(`${semanaPasadaAR}T12:00:00Z`).toLocaleDateString(
        'es-AR',
        { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: '2-digit' },
      );
      return { horas, horasSemanaAnterior, diaAnteriorLabel };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   PRODUCTOS (CRUD admin)
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/productos — listado con filtros, paginación.
  fastify.get(
    '/admin/productos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          q: z.string().optional(),
          categoriaId: z.string().uuid().optional(),
          tipoProductoId: z.string().uuid().optional(),
          incluirInactivos: queryBool(false),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query as {
        q?: string;
        categoriaId?: string;
        tipoProductoId?: string;
        incluirInactivos: boolean;
        page: number;
        pageSize: number;
      };
      const where = {
        ...(q.q && { nombre: { contains: q.q, mode: 'insensitive' as const } }),
        ...(q.tipoProductoId && { tipoProductoId: q.tipoProductoId }),
        ...(q.categoriaId && { tipoProducto: { categoriaId: q.categoriaId } }),
        ...(q.incluirInactivos ? {} : { activo: true }),
      };
      const [productos, total] = await Promise.all([
        prisma.producto.findMany({
          where,
          include: {
            tipoProducto: { include: { categoria: true } },
          },
          orderBy: [
            { tipoProducto: { categoria: { orden: 'asc' } } },
            { tipoProducto: { orden: 'asc' } },
            { nombre: 'asc' },
          ],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.producto.count({ where }),
      ]);
      return { productos, total, page: q.page, pageSize: q.pageSize };
    },
  );

  // PATCH /admin/productos/:id — actualizar precio / activo / nombre / categoría.
  fastify.patch(
    '/admin/productos/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            nombre: z.string().min(1).max(160).optional(),
            marca: z.string().max(80).nullable().optional(),
            presentacion: z.string().max(80).nullable().optional(),
            precioBase: z
              .string()
              .regex(/^\d+(\.\d{1,2})?$/, 'Precio inválido')
              .optional(),
            activo: z.boolean().optional(),
            codigo: z.string().max(40).nullable().optional(),
            descripcion: z.string().nullable().optional(),
            motivoCambioPrecio: z.string().max(200).optional(),
            tipoProductoId: z.string().uuid().optional(),
            formaVentaLabel: z.string().max(40).nullable().optional(),
            unidadPrecioLabel: z.string().max(40).nullable().optional(),
            // Fix 3a: casillero "Enviar a cocina" por-producto. null = hereda del tipo.
            cocinaIntervieneOverride: z.boolean().nullable().optional(),
            listasCustom: z.array(z.string().uuid()).optional(),
          })
          .refine(
            (d) =>
              d.nombre !== undefined ||
              d.marca !== undefined ||
              d.presentacion !== undefined ||
              d.precioBase !== undefined ||
              d.activo !== undefined ||
              d.codigo !== undefined ||
              d.descripcion !== undefined ||
              d.tipoProductoId !== undefined ||
              d.formaVentaLabel !== undefined ||
              d.unidadPrecioLabel !== undefined ||
              d.cocinaIntervieneOverride !== undefined ||
              d.listasCustom !== undefined,
            { message: 'Hay que enviar al menos un campo a cambiar' },
          ),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as {
        nombre?: string;
        marca?: string | null;
        presentacion?: string | null;
        precioBase?: string;
        activo?: boolean;
        codigo?: string | null;
        descripcion?: string | null;
        motivoCambioPrecio?: string;
        tipoProductoId?: string;
        formaVentaLabel?: string | null;
        unidadPrecioLabel?: string | null;
        cocinaIntervieneOverride?: boolean | null;
        listasCustom?: string[];
      };

      const before = await prisma.producto.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Producto no encontrado' });

      // Si cambia precio, registrar en historial.
      const cambiaPrecio =
        body.precioBase !== undefined && body.precioBase !== before.precioBase.toString();

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.producto.update({
          where: { id: params.id },
          data: {
            ...(body.nombre !== undefined && { nombre: body.nombre }),
            ...(body.marca !== undefined && { marca: body.marca }),
            ...(body.presentacion !== undefined && { presentacion: body.presentacion }),
            ...(body.precioBase !== undefined && { precioBase: body.precioBase }),
            ...(body.activo !== undefined && { activo: body.activo }),
            ...(body.codigo !== undefined && { codigo: body.codigo }),
            ...(body.descripcion !== undefined && { descripcion: body.descripcion }),
            ...(body.tipoProductoId !== undefined && { tipoProductoId: body.tipoProductoId }),
            ...(body.formaVentaLabel !== undefined && { formaVentaLabel: body.formaVentaLabel }),
            ...(body.unidadPrecioLabel !== undefined && { unidadPrecioLabel: body.unidadPrecioLabel }),
            ...(body.cocinaIntervieneOverride !== undefined && {
              cocinaIntervieneOverride: body.cocinaIntervieneOverride,
            }),
          },
        });
        if (cambiaPrecio) {
          await tx.historialPrecio.create({
            data: {
              productoId: u.id,
              precioAnterior: before.precioBase,
              precioNuevo: u.precioBase,
              usuarioId: req.usuario!.id,
              motivo: body.motivoCambioPrecio ?? null,
            },
          });
        }
        return u;
      });

      if (body.listasCustom !== undefined) {
        await syncListasCustomDeProducto(
          updated.id,
          updated.precioBase.toString(),
          body.listasCustom,
        );
      }

      await recordAudit({
        tabla: 'productos',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: {
          nombre: before.nombre,
          precioBase: before.precioBase.toString(),
          activo: before.activo,
        },
        valorNuevo: {
          nombre: updated.nombre,
          precioBase: updated.precioBase.toString(),
          activo: updated.activo,
        },
        contexto: body.motivoCambioPrecio ? { motivo: body.motivoCambioPrecio } : undefined,
      });

      return updated;
    },
  );

  // DELETE /admin/productos/:id — eliminar producto.
  //
  // Intenta hard-delete. Si el producto está referenciado por ventas
  // históricas (items_venta), precios por lista, modificadores aplicables,
  // etc., la FK lo impide → caemos a soft-delete (activo=false) para no
  // romper el histórico. Mismo patrón que /admin/sabores/:opcionId.
  fastify.delete(
    '/admin/productos/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.producto.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Producto no encontrado' });

      try {
        // Limpiar dependencias "seguras" (precios, historial) en una tx y
        // luego borrar el producto. Si hay items_venta que lo referencian,
        // el delete del producto falla por FK y caemos al catch.
        await prisma.$transaction(async (tx) => {
          await tx.precioPorLista.deleteMany({ where: { productoId: params.id } });
          await tx.historialPrecio.deleteMany({ where: { productoId: params.id } });
          await tx.producto.delete({ where: { id: params.id } });
        });
        await recordAudit({
          tabla: 'productos',
          registroId: params.id,
          accion: 'DELETE',
          usuarioId: req.usuario!.id,
          valorAnterior: { nombre: before.nombre, activo: before.activo },
        });
        return { ok: true, deleted: true };
      } catch {
        // FK con items_venta (ventas históricas) → soft-delete.
        const updated = await prisma.producto.update({
          where: { id: params.id },
          data: { activo: false },
        });
        await recordAudit({
          tabla: 'productos',
          registroId: params.id,
          accion: 'UPDATE',
          usuarioId: req.usuario!.id,
          valorAnterior: { activo: before.activo },
          valorNuevo: { activo: false },
          contexto: { motivo: 'soft-delete (referenciado por ventas)' },
        });
        return reply.send({
          ok: true,
          deleted: false,
          deactivated: true,
          mensaje:
            'El producto tiene ventas históricas asociadas, así que se desactivó ' +
            'en vez de borrarse (para no romper reportes). Ya no aparece en el catálogo del cajero.',
        });
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   MOVIMIENTOS (ingresos / egresos / transferencias)
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/movimientos
  fastify.get(
    '/admin/movimientos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          tipo: z.enum(['INGRESO', 'EGRESO', 'TRANSFERENCIA_INTERNA', 'AJUSTE']).optional(),
          categoriaId: z.string().uuid().optional(),
          cuentaId: z.string().uuid().optional(),
          // `sesion=actual|anterior` filtra por sesión de caja. Tiene prioridad
          // sobre desde/hasta (es un filtro por sesión, no por fecha).
          sesion: z.enum(['actual', 'anterior']).optional(),
          desde: z.string().datetime().optional(),
          hasta: z.string().datetime().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query as {
        tipo?: 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA_INTERNA' | 'AJUSTE';
        categoriaId?: string;
        cuentaId?: string;
        sesion?: 'actual' | 'anterior';
        desde?: string;
        hasta?: string;
        page: number;
        pageSize: number;
      };

      // "Sesión actual": resolvemos la sesión de caja abierta y filtramos por su
      // id (no por fecha — un movimiento cuenta para el turno por su
      // `sesionCajaId`, ver invariante en CLAUDE.md). Si no hay sesión abierta,
      // forzamos un id imposible para que el listado salga vacío.
      let sesionCajaId: string | undefined;
      if (q.sesion === 'actual') {
        const abierta = await prisma.sesionCaja.findFirst({
          where: { estado: EstadoSesionCaja.ABIERTA },
          orderBy: { horarioApertura: 'desc' },
          select: { id: true },
        });
        sesionCajaId = abierta?.id ?? '00000000-0000-0000-0000-000000000000';
      } else if (q.sesion === 'anterior') {
        const { sesion } = await getSesionAnteriorReadOnly();
        sesionCajaId = sesion?.id ?? '00000000-0000-0000-0000-000000000000';
      }

      const where = {
        ...(q.tipo && { tipo: q.tipo }),
        ...(q.categoriaId && { categoriaId: q.categoriaId }),
        ...(sesionCajaId && { sesionCajaId }),
        ...(q.cuentaId && {
          OR: [{ cuentaOrigenId: q.cuentaId }, { cuentaDestinoId: q.cuentaId }],
        }),
        // El filtro por fecha solo aplica cuando NO se filtró por sesión actual.
        ...(!sesionCajaId &&
          (q.desde || q.hasta) && {
            fechaComputo: {
              ...(q.desde && { gte: new Date(q.desde) }),
              ...(q.hasta && { lte: new Date(q.hasta) }),
            },
          }),
      };
      const [movimientos, total, sumas] = await Promise.all([
        prisma.movimiento.findMany({
          where,
          include: {
            cuentaOrigen: { select: { id: true, nombre: true } },
            cuentaDestino: { select: { id: true, nombre: true } },
            categoria: { select: { id: true, nombre: true, tipo: true } },
            usuario: { select: { id: true, nombre: true } },
          },
          orderBy: { fechaComputo: 'desc' },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.movimiento.count({ where }),
        prisma.movimiento.groupBy({
          by: ['tipo'],
          _sum: { monto: true },
          where: { ...where, estado: EstadoMovimiento.CONFIRMADO },
        }),
      ]);

      const totalIngresos = Number(
        sumas.find((s) => s.tipo === 'INGRESO')?._sum.monto ?? 0,
      );
      const totalEgresos = Number(
        sumas.find((s) => s.tipo === 'EGRESO')?._sum.monto ?? 0,
      );

      // Marcar cuáles fueron modificados o anulados — consultamos el audit
      // log de los movimientos del page actual en una sola query y mapeamos
      // por id. Sin esto la UI no sabría qué fila tiene tag "modificado".
      const ids = movimientos.map((m) => m.id);
      const auditEntries = ids.length
        ? await prisma.auditLog.findMany({
            where: {
              tabla: 'movimientos',
              registroId: { in: ids },
              accion: { in: ['UPDATE', 'TRANSITION'] },
            },
            select: { registroId: true, accion: true, timestamp: true },
          })
        : [];
      const modificadoMap = new Map<string, string>();
      for (const a of auditEntries) {
        if (a.accion === 'UPDATE') {
          modificadoMap.set(a.registroId, a.timestamp.toISOString());
        }
      }

      // Resolver "sub-objeto" para mostrar en la columna Categoría:
      // "Sueldos (Edgardo Pérez)", "Insumos (Ave Fenix)". El movimiento
      // tiene entidadId (UUID) pero polimórfico — puede ser empleado o
      // proveedor según la categoría. Hacemos batch lookups de ambos en
      // una sola query por tabla.
      const entidadIds = movimientos
        .map((m) => m.entidadId)
        .filter((x): x is string => typeof x === 'string');
      const empleados = entidadIds.length
        ? await prisma.empleado.findMany({
            where: { id: { in: entidadIds } },
            select: { id: true, nombre: true, apellido: true, puesto: true },
          })
        : [];
      const proveedores = entidadIds.length
        ? await prisma.proveedor.findMany({
            where: { id: { in: entidadIds } },
            select: { id: true, nombre: true },
          })
        : [];
      const empleadoMap = new Map(
        empleados.map((e) => [
          e.id,
          `${e.puesto.toLowerCase()} ${e.nombre}${e.apellido ? ' ' + e.apellido : ''}`.trim(),
        ]),
      );
      const proveedorMap = new Map(proveedores.map((p) => [p.id, p.nombre]));

      return {
        movimientos: movimientos.map((m) => ({
          ...m,
          modificado: modificadoMap.has(m.id),
          modificadoAt: modificadoMap.get(m.id) ?? null,
          entidadNombre:
            (m.entidadId &&
              (empleadoMap.get(m.entidadId) ?? proveedorMap.get(m.entidadId))) ??
            null,
        })),
        total,
        page: q.page,
        pageSize: q.pageSize,
        sumas: {
          ingresos: totalIngresos.toFixed(2),
          egresos: totalEgresos.toFixed(2),
          neto: (totalIngresos - totalEgresos).toFixed(2),
        },
      };
    },
  );

  // POST /admin/movimientos — crear ingreso / egreso / transferencia
  fastify.post(
    '/admin/movimientos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z
          .object({
            tipo: z.enum(['INGRESO', 'EGRESO', 'TRANSFERENCIA_INTERNA']),
            monto: z
              .string()
              .regex(/^\d+(\.\d{1,2})?$/, 'Monto inválido')
              .refine((v) => Number(v) > 0, 'El monto debe ser mayor a 0'),
            categoriaId: z.string().uuid(),
            cuentaOrigenId: z.string().uuid().optional(),
            cuentaDestinoId: z.string().uuid().optional(),
            fechaComputo: z.string().datetime().optional(),
            entidadId: z.string().uuid().optional(),
            observacion: z.string().max(500).optional(),
            // Para egresos a empleados (Sueldos / Adelanto): desglose por concepto.
            // Si se envía, el monto total debe coincidir con la suma de los conceptos.
            conceptos: z
              .array(
                z.object({
                  tipo: z.enum([
                    'JORNADA',
                    'HORAS_EXTRA',
                    'AGUINALDO',
                    'VACACIONES',
                    'ADELANTO',
                    'OTRO',
                  ]),
                  monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
                  detalle: z.string().max(120).optional(),
                }),
              )
              .optional(),
          })
          .refine(
            (d) => {
              if (d.tipo === 'INGRESO') return !!d.cuentaDestinoId;
              if (d.tipo === 'EGRESO') return !!d.cuentaOrigenId;
              if (d.tipo === 'TRANSFERENCIA_INTERNA')
                return !!d.cuentaOrigenId && !!d.cuentaDestinoId;
              return true;
            },
            { message: 'Cuentas inválidas para el tipo de movimiento' },
          ),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        tipo: 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA_INTERNA';
        monto: string;
        categoriaId: string;
        cuentaOrigenId?: string;
        cuentaDestinoId?: string;
        fechaComputo?: string;
        entidadId?: string;
        observacion?: string;
        conceptos?: Array<{ tipo: string; monto: string; detalle?: string }>;
      };

      // Verificar que la categoría exista y aplique al tipo
      const cat = await prisma.categoriaMovimiento.findUnique({ where: { id: body.categoriaId } });
      if (!cat) return reply.code(400).send({ error: 'Categoría no encontrada' });

      const fecha = body.fechaComputo ? new Date(body.fechaComputo) : new Date();
      const monto = Number(body.monto);

      // Resolver la sesión actual y asociar el movimiento. Antes, los aportes
      // y egresos cargados desde el panel admin se guardaban con
      // sesion_caja_id = NULL y quedaban huérfanos: el cierre de caja no los
      // sumaba al "Egresos del turno" pero seguían apareciendo en la lista
      // del panel /admin/movimientos (que filtra por fecha, no por sesión).
      // Eso producía la sensación de que los movs "se mezclaban con sesiones
      // pasadas". Ahora los atamos al turno vigente del momento de carga
      // (mismo helper que usan las ventas). Si estamos fuera de horario,
      // devolvemos 423 con la próxima apertura para que el usuario sepa
      // cuándo cargarlo.
      let sesion;
      try {
        sesion = await getOrCreateSesionActual(req.usuario!.id);
      } catch (e) {
        if (e instanceof FueraDeHorarioError) {
          return reply.code(423).send({
            error: 'Fuera del horario de atención — no se puede cargar este movimiento ahora',
            codigo: 'FUERA_DE_HORARIO',
            resolucion: e.resolucion,
          });
        }
        throw e;
      }

      // Si vienen conceptos, validar que sumen el monto total (tolerancia 0.5)
      if (body.conceptos && body.conceptos.length > 0) {
        const sumaConceptos = body.conceptos.reduce((acc, c) => acc + Number(c.monto), 0);
        if (Math.abs(sumaConceptos - monto) > 0.5) {
          return reply.code(400).send({
            error: `La suma de conceptos (${sumaConceptos.toFixed(2)}) no coincide con el monto total (${monto.toFixed(2)})`,
          });
        }
      }

      const adicionales =
        body.conceptos && body.conceptos.length > 0
          ? { conceptos: body.conceptos }
          : undefined;

      const created = await prisma.$transaction(async (tx) => {
        const mov = await tx.movimiento.create({
          data: {
            tipo: body.tipo,
            monto: body.monto,
            categoriaId: body.categoriaId,
            cuentaOrigenId: body.cuentaOrigenId ?? null,
            cuentaDestinoId: body.cuentaDestinoId ?? null,
            entidadId: body.entidadId ?? null,
            sesionCajaId: sesion.id,
            fechaComputo: fecha,
            observacion: body.observacion ?? null,
            usuarioId: req.usuario!.id,
            estado: EstadoMovimiento.CONFIRMADO,
            ...(adicionales && { adicionales: adicionales as never }),
          },
          include: {
            cuentaOrigen: { select: { nombre: true } },
            cuentaDestino: { select: { nombre: true } },
            categoria: { select: { nombre: true } },
          },
        });

        // Actualizar saldos de cuentas afectadas
        if (body.cuentaOrigenId) {
          await tx.cuenta.update({
            where: { id: body.cuentaOrigenId },
            data: { saldoActual: { decrement: monto } },
          });
        }
        if (body.cuentaDestinoId) {
          await tx.cuenta.update({
            where: { id: body.cuentaDestinoId },
            data: { saldoActual: { increment: monto } },
          });
        }
        return mov;
      });

      await recordAudit({
        tabla: 'movimientos',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: {
          tipo: created.tipo,
          monto: created.monto.toString(),
          categoria: created.categoria.nombre,
          cuentaOrigen: created.cuentaOrigen?.nombre,
          cuentaDestino: created.cuentaDestino?.nombre,
        },
      });

      return reply.code(201).send(created);
    },
  );

  // GET /admin/movimientos/:id — detalle + audit log para el modal de detalle.
  fastify.get(
    '/admin/movimientos/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const mov = await prisma.movimiento.findUnique({
        where: { id: params.id },
        include: {
          cuentaOrigen: { select: { nombre: true } },
          cuentaDestino: { select: { nombre: true } },
          categoria: { select: { nombre: true } },
          usuario: { select: { nombre: true } },
        },
      });
      if (!mov) return reply.code(404).send({ error: 'Movimiento no encontrado' });

      // Audit log: todas las modificaciones del movimiento
      const audits = await prisma.auditLog.findMany({
        where: { tabla: 'movimientos', registroId: mov.id },
        orderBy: { timestamp: 'asc' },
        include: { usuario: { select: { nombre: true } } },
      });

      return {
        ...mov,
        audits: audits.map((a) => ({
          id: a.id,
          accion: a.accion,
          fecha: a.timestamp.toISOString(),
          usuarioNombre: a.usuario?.nombre ?? null,
          valorAnterior: a.valorAnterior,
          valorNuevo: a.valorNuevo,
        })),
        modificado: audits.some((a) => a.accion === 'UPDATE'),
        anulado: mov.estado === EstadoMovimiento.ANULADO,
      };
    },
  );

  // PATCH /admin/movimientos/:id — editar monto / observación / cuenta del
  // movimiento. Recalcula saldos de las cuentas afectadas si cambia el monto
  // o la cuenta. Cualquier edición se registra en el audit log para que el
  // historial quede visible en la UI.
  fastify.patch(
    '/admin/movimientos/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            monto: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Monto inválido').optional(),
            observacion: z.string().max(500).nullable().optional(),
            cuentaOrigenId: z.string().uuid().nullable().optional(),
            cuentaDestinoId: z.string().uuid().nullable().optional(),
            categoriaId: z.string().uuid().optional(),
            fechaComputo: z.string().datetime().optional(),
          })
          .refine(
            (d) =>
              d.monto !== undefined ||
              d.observacion !== undefined ||
              d.cuentaOrigenId !== undefined ||
              d.cuentaDestinoId !== undefined ||
              d.categoriaId !== undefined ||
              d.fechaComputo !== undefined,
            { message: 'Hay que enviar al menos un campo' },
          ),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as {
        monto?: string;
        observacion?: string | null;
        cuentaOrigenId?: string | null;
        cuentaDestinoId?: string | null;
        categoriaId?: string;
        fechaComputo?: string;
      };

      const mov = await prisma.movimiento.findUnique({
        where: { id: params.id },
        include: { categoria: true },
      });
      if (!mov) return reply.code(404).send({ error: 'Movimiento no encontrado' });
      if (mov.estado === EstadoMovimiento.ANULADO) {
        return reply.code(400).send({ error: 'No se puede editar un movimiento anulado' });
      }

      // Si cambia la categoría, validamos que sea compatible. Bloquear los
      // saltos entre categorías que tienen datos extra requeridos (Sueldos
      // necesita empleado + conceptos; Insumos necesita proveedor) porque
      // eso dejaría el movimiento inconsistente. Para reclasificar entre
      // esas categorías, hay que anular + recrear.
      if (body.categoriaId && body.categoriaId !== mov.categoriaId) {
        const nuevaCat = await prisma.categoriaMovimiento.findUnique({
          where: { id: body.categoriaId },
        });
        if (!nuevaCat) {
          return reply.code(400).send({ error: 'Categoría nueva no encontrada' });
        }
        const requiereDataExtra = (nombre: string) =>
          /sueldo|adelanto a empleado|insumos.*proveedor/i.test(nombre);
        const viejaTieneExtra = requiereDataExtra(mov.categoria.nombre);
        const nuevaTieneExtra = requiereDataExtra(nuevaCat.nombre);
        if (viejaTieneExtra || nuevaTieneExtra) {
          // Aceptamos el cambio solo si vieja y nueva pertenecen al mismo grupo
          // funcional (Sueldos ↔ Adelanto a empleado, ambas con empleadoId).
          const mismoGrupoSueldo =
            /sueldo|adelanto a empleado/i.test(mov.categoria.nombre) &&
            /sueldo|adelanto a empleado/i.test(nuevaCat.nombre);
          if (!mismoGrupoSueldo) {
            return reply.code(400).send({
              error:
                'No se puede cambiar entre categorías con datos especiales (Sueldos/Insumos). Anulá el movimiento y creá uno nuevo con la categoría correcta.',
            });
          }
        }
        // Validar que el tipo de la nueva categoría coincida con el tipo del
        // movimiento (no se puede mover un EGRESO a una categoría de INGRESO).
        if (nuevaCat.tipo !== 'AMBOS' && nuevaCat.tipo !== mov.tipo) {
          return reply.code(400).send({
            error: `La categoría "${nuevaCat.nombre}" es para tipo ${nuevaCat.tipo}, no aplica a ${mov.tipo}`,
          });
        }
      }

      const montoAnterior = Number(mov.monto);
      const montoNuevo = body.monto !== undefined ? Number(body.monto) : montoAnterior;
      const cuentaOrigenAnterior = mov.cuentaOrigenId;
      const cuentaOrigenNueva =
        body.cuentaOrigenId !== undefined ? body.cuentaOrigenId : cuentaOrigenAnterior;
      const cuentaDestinoAnterior = mov.cuentaDestinoId;
      const cuentaDestinoNueva =
        body.cuentaDestinoId !== undefined ? body.cuentaDestinoId : cuentaDestinoAnterior;

      const updated = await prisma.$transaction(async (tx) => {
        // 1. Revertir el efecto del movimiento original
        if (cuentaOrigenAnterior) {
          await tx.cuenta.update({
            where: { id: cuentaOrigenAnterior },
            data: { saldoActual: { increment: montoAnterior } },
          });
        }
        if (cuentaDestinoAnterior) {
          await tx.cuenta.update({
            where: { id: cuentaDestinoAnterior },
            data: { saldoActual: { decrement: montoAnterior } },
          });
        }
        // 2. Update del movimiento con valores nuevos
        const nuevo = await tx.movimiento.update({
          where: { id: mov.id },
          data: {
            ...(body.monto !== undefined && { monto: body.monto }),
            ...(body.observacion !== undefined && { observacion: body.observacion }),
            ...(body.cuentaOrigenId !== undefined && {
              cuentaOrigenId: body.cuentaOrigenId,
            }),
            ...(body.cuentaDestinoId !== undefined && {
              cuentaDestinoId: body.cuentaDestinoId,
            }),
            ...(body.categoriaId && { categoriaId: body.categoriaId }),
            ...(body.fechaComputo && { fechaComputo: new Date(body.fechaComputo) }),
          },
        });
        // 3. Aplicar el efecto nuevo (con cuenta nueva y monto nuevo)
        if (cuentaOrigenNueva) {
          await tx.cuenta.update({
            where: { id: cuentaOrigenNueva },
            data: { saldoActual: { decrement: montoNuevo } },
          });
        }
        if (cuentaDestinoNueva) {
          await tx.cuenta.update({
            where: { id: cuentaDestinoNueva },
            data: { saldoActual: { increment: montoNuevo } },
          });
        }
        return nuevo;
      });

      await recordAudit({
        tabla: 'movimientos',
        registroId: mov.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: {
          monto: mov.monto.toString(),
          observacion: mov.observacion,
          cuentaOrigenId: mov.cuentaOrigenId,
          cuentaDestinoId: mov.cuentaDestinoId,
          categoriaId: mov.categoriaId,
          fechaComputo: mov.fechaComputo.toISOString(),
        },
        valorNuevo: {
          monto: updated.monto.toString(),
          observacion: updated.observacion,
          cuentaOrigenId: updated.cuentaOrigenId,
          cuentaDestinoId: updated.cuentaDestinoId,
          categoriaId: updated.categoriaId,
          fechaComputo: updated.fechaComputo.toISOString(),
        },
      });

      return reply.send(updated);
    },
  );

  // POST /admin/movimientos/:id/anular
  fastify.post(
    '/admin/movimientos/:id/anular',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ motivo: z.string().min(3).max(500) }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { motivo: string };
      const mov = await prisma.movimiento.findUnique({ where: { id: params.id } });
      if (!mov) return reply.code(404).send({ error: 'Movimiento no encontrado' });
      if (mov.estado === EstadoMovimiento.ANULADO) {
        return reply.code(400).send({ error: 'Ya está anulado' });
      }
      const monto = Number(mov.monto);

      await prisma.$transaction(async (tx) => {
        await tx.movimiento.update({
          where: { id: mov.id },
          data: {
            estado: EstadoMovimiento.ANULADO,
            observacion: `${mov.observacion ?? ''}\n[Anulado] ${body.motivo}`.trim(),
          },
        });
        // Revertir saldos
        if (mov.cuentaOrigenId) {
          await tx.cuenta.update({
            where: { id: mov.cuentaOrigenId },
            data: { saldoActual: { increment: monto } },
          });
        }
        if (mov.cuentaDestinoId) {
          await tx.cuenta.update({
            where: { id: mov.cuentaDestinoId },
            data: { saldoActual: { decrement: monto } },
          });
        }
      });

      await recordAudit({
        tabla: 'movimientos',
        registroId: mov.id,
        accion: 'TRANSITION',
        usuarioId: req.usuario!.id,
        valorAnterior: { estado: mov.estado },
        valorNuevo: { estado: 'ANULADO', motivo: body.motivo },
      });

      return reply.send({ ok: true });
    },
  );

  // GET /admin/categorias-movimiento — para los selects de la UI
  fastify.get(
    '/admin/categorias-movimiento',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const categorias = await prisma.categoriaMovimiento.findMany({
        where: { activa: true },
        orderBy: { orden: 'asc' },
      });
      return { categorias };
    },
  );

  // POST /admin/categorias-movimiento — crear una categoría nueva al vuelo
  // desde el modal de "Nuevo movimiento". La encargada agrega conceptos que
  // no estaban en la lista (recurrentes que quiere tener guardados).
  fastify.post(
    '/admin/categorias-movimiento',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(80),
          tipo: z.enum(['INGRESO', 'EGRESO', 'TRANSFERENCIA', 'AMBOS']),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        tipo: 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA' | 'AMBOS';
      };
      const nombre = body.nombre.trim();
      if (!nombre) return reply.code(400).send({ error: 'El nombre no puede estar vacío' });

      // Si ya existe una con ese nombre (case-insensitive), la reusamos en
      // lugar de fallar — así la encargada no se traba con "ya existe".
      const existente = await prisma.categoriaMovimiento.findFirst({
        where: { nombre: { equals: nombre, mode: 'insensitive' } },
      });
      if (existente) {
        // Si estaba desactivada, la reactivamos. Devolvemos la existente.
        if (!existente.activa) {
          const reactivada = await prisma.categoriaMovimiento.update({
            where: { id: existente.id },
            data: { activa: true },
          });
          return reply.code(200).send(reactivada);
        }
        return reply.code(200).send(existente);
      }

      // Orden al final de la lista (después de las de sistema).
      const max = await prisma.categoriaMovimiento.aggregate({ _max: { orden: true } });
      const created = await prisma.categoriaMovimiento.create({
        data: {
          nombre,
          tipo: body.tipo as never,
          esSistema: false,
          esOperativa: true,
          orden: (max._max.orden ?? 0) + 1,
          activa: true,
        },
      });
      await recordAudit({
        tabla: 'categorias_movimiento',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: created.nombre, tipo: created.tipo },
      });
      return reply.code(201).send(created);
    },
  );

  // DELETE /admin/categorias-movimiento/:id — eliminar una categoría de
  // movimiento. Las de sistema (esSistema=true) no se borran. Si tiene
  // movimientos vinculados, soft-delete (activa=false) para no romper el
  // histórico; si está vacía, hard delete.
  fastify.delete(
    '/admin/categorias-movimiento/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const cat = await prisma.categoriaMovimiento.findUnique({
        where: { id: params.id },
        include: { _count: { select: { movimientos: true } } },
      });
      if (!cat) return reply.code(404).send({ error: 'Categoría no encontrada' });
      if (cat.esSistema) {
        return reply.code(400).send({ error: 'No se pueden eliminar las categorías del sistema' });
      }
      let modo: 'hard' | 'soft';
      if (cat._count.movimientos === 0) {
        await prisma.categoriaMovimiento.delete({ where: { id: params.id } });
        modo = 'hard';
      } else {
        await prisma.categoriaMovimiento.update({ where: { id: params.id }, data: { activa: false } });
        modo = 'soft';
      }
      await recordAudit({
        tabla: 'categorias_movimiento',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: cat.nombre },
        contexto: { modo },
      });
      return { ok: true, modo };
    },
  );

  // GET /admin/cuentas — listado con saldoActual + métricas de los últimos 30 días.
  // Sirve tanto para los selects como para la pantalla "Cuentas y saldos".
  fastify.get(
    '/admin/cuentas',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const cuentas = await prisma.cuenta.findMany({
        where: { activa: true },
        orderBy: { nombre: 'asc' },
      });

      const inicioMes = new Date();
      inicioMes.setDate(1);
      inicioMes.setHours(0, 0, 0, 0);

      // Movimientos del mes en curso, agrupados por cuenta + tipo (origen=egreso, destino=ingreso)
      const [egresosMes, ingresosMes, ultimoMov] = await Promise.all([
        prisma.movimiento.groupBy({
          by: ['cuentaOrigenId'],
          _sum: { monto: true },
          _count: { _all: true },
          where: {
            estado: EstadoMovimiento.CONFIRMADO,
            fechaComputo: { gte: inicioMes },
            cuentaOrigenId: { not: null },
          },
        }),
        prisma.movimiento.groupBy({
          by: ['cuentaDestinoId'],
          _sum: { monto: true },
          _count: { _all: true },
          where: {
            estado: EstadoMovimiento.CONFIRMADO,
            fechaComputo: { gte: inicioMes },
            cuentaDestinoId: { not: null },
          },
        }),
        prisma.movimiento.findMany({
          where: { estado: EstadoMovimiento.CONFIRMADO },
          orderBy: { fechaComputo: 'desc' },
          select: { cuentaOrigenId: true, cuentaDestinoId: true, fechaComputo: true },
          take: 200,
        }),
      ]);

      const egresosMap = new Map(
        egresosMes.map((e) => [
          e.cuentaOrigenId as string,
          { total: Number(e._sum.monto ?? 0), count: e._count._all },
        ]),
      );
      const ingresosMap = new Map(
        ingresosMes.map((e) => [
          e.cuentaDestinoId as string,
          { total: Number(e._sum.monto ?? 0), count: e._count._all },
        ]),
      );

      // Última fecha de movimiento por cuenta (para "frescura del saldo")
      const ultimaFechaPorCuenta = new Map<string, Date>();
      for (const m of ultimoMov) {
        for (const id of [m.cuentaOrigenId, m.cuentaDestinoId]) {
          if (!id) continue;
          const prev = ultimaFechaPorCuenta.get(id);
          if (!prev || m.fechaComputo > prev) ultimaFechaPorCuenta.set(id, m.fechaComputo);
        }
      }

      const totalSaldos = cuentas.reduce((acc, c) => acc + Number(c.saldoActual), 0);

      return {
        cuentas: cuentas.map((c) => {
          const ing = ingresosMap.get(c.id) ?? { total: 0, count: 0 };
          const egr = egresosMap.get(c.id) ?? { total: 0, count: 0 };
          const ultima = ultimaFechaPorCuenta.get(c.id) ?? null;
          return {
            id: c.id,
            nombre: c.nombre,
            tipo: c.tipo,
            activa: c.activa,
            saldoActual: Number(c.saldoActual).toFixed(2),
            ingresosMes: ing.total.toFixed(2),
            egresosMes: egr.total.toFixed(2),
            netoMes: (ing.total - egr.total).toFixed(2),
            movimientosMes: ing.count + egr.count,
            ultimoMovimiento: ultima ? ultima.toISOString() : null,
          };
        }),
        totalSaldos: totalSaldos.toFixed(2),
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   CAJA — sesión actual + cierre + aprobación
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/caja/sesion-actual — datos de la sesión activa con resumen.
  fastify.get(
    '/admin/caja/sesion-actual',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      // Resolver el slot vigente según la config de horarios (ver
      // services/horarios.ts). Si estamos fuera de horario, devuelve la
      // última sesión ABIERTA (cualquier slot) para que la encargada la
      // pueda cerrar incluso si el grace ya pasó.
      const { sesion: sesionResolved, resolucion } = await getSesionActualReadOnly();

      if (!sesionResolved) {
        return { sesion: null, resolucion };
      }

      const sesion = await prisma.sesionCaja.findUnique({
        where: { id: sesionResolved.id },
        include: {
          usuarioApertura: { select: { nombre: true } },
          usuarioCierre: { select: { nombre: true } },
        },
      });
      if (!sesion) return { sesion: null, resolucion };

      // Sumar pagos de ventas finalizadas en esta sesión, por método
      // (incluye también la cuenta destino para distinguir lo que entró a
      // caja física vs lo que quedó en banco/wallet/cuentas a cobrar).
      const pagosRaw = await prisma.pago.findMany({
        where: {
          estado: 'CONFIRMADO',
          venta: { sesionCajaId: sesion.id, estado: EstadoVenta.FINALIZADA },
        },
        select: {
          metodo: true,
          monto: true,
          cuenta: { select: { tipo: true, excluidaDeCierreCaja: true } },
          venta: { select: { canal: true, modalidad: true } },
        },
      });

      // Movimientos del turno + cuentas para saber el efecto en caja física.
      // Resta egreso/transferencia desde EFECTIVO; suma ingreso/transferencia hacia EFECTIVO.
      // El resto (egreso desde banco, ingreso a banco, etc.) NO afecta caja —
      // siguen viéndose en el listado pero no en la fórmula de efectivo.
      // Cuentas con `excluidaDeCierreCaja=true` (ej: "Efectivo acumulado")
      // se tratan como NO-efectivo para el cálculo aunque su tipo sea EFECTIVO.
      const movimientos = await prisma.movimiento.findMany({
        where: { sesionCajaId: sesion.id, estado: EstadoMovimiento.CONFIRMADO },
        select: {
          id: true,
          tipo: true,
          monto: true,
          categoria: { select: { nombre: true } },
          cuentaOrigen: { select: { tipo: true, nombre: true, excluidaDeCierreCaja: true } },
          cuentaDestino: { select: { tipo: true, nombre: true, excluidaDeCierreCaja: true } },
        },
      });

      const ventasCount = await prisma.venta.count({
        where: { sesionCajaId: sesion.id, estado: EstadoVenta.FINALIZADA },
      });
      // `esEncargo: false`: los encargos A_PAGAR (pedidos futuros que se cobran EL
      // DÍA de entrega, días después) nacen PROCESADA en la sesión donde se cargan,
      // pero NO son "pedidos sin cobrar" del turno — NO deben bloquear el cierre.
      // Al cobrarse se reasigna sesionCajaId a la sesión del cobro (entran a la
      // caja de ese momento). Se cuentan aparte en `encargosAPagar` (informativo).
      const ventasAbiertas = await prisma.venta.count({
        where: { sesionCajaId: sesion.id, estado: EstadoVenta.PROCESADA, esEncargo: false },
      });
      const encargosAPagar = await prisma.venta.count({
        where: { sesionCajaId: sesion.id, estado: EstadoVenta.PROCESADA, esEncargo: true },
      });

      // Cobros por método — informativo, no afecta el cálculo de caja.
      const cobrosByMetodo = new Map<string, { monto: number; cantidad: number }>();
      for (const p of pagosRaw) {
        const cur = cobrosByMetodo.get(p.metodo) ?? { monto: 0, cantidad: 0 };
        cur.monto += Number(p.monto);
        cur.cantidad += 1;
        cobrosByMetodo.set(p.metodo, cur);
      }
      const cobrosPorMetodo = [...cobrosByMetodo.entries()].map(([metodo, v]) => ({
        metodo,
        monto: v.monto.toFixed(2),
        cantidad: v.cantidad,
      }));

      // Plata que ENTRÓ a caja física por ventas. `excluidaDeCierreCaja`
      // descarta cuentas como "Efectivo acumulado" (efectivo del dueño que
      // no entra al turno actual).
      const esEfectivoCierre = (
        c: { tipo: string; excluidaDeCierreCaja?: boolean } | null | undefined,
      ): boolean => !!c && c.tipo === 'EFECTIVO' && c.excluidaDeCierreCaja !== true;

      const totalEfectivo = pagosRaw
        .filter(
          (p) =>
            esEfectivoCierre(p.cuenta) &&
            // El efectivo DELIVERATE lo cobra su repartidor y se rinde
            // semanal — nunca entra al cajón, no cuenta para el esperado.
            !esVentaDeliverate(p.venta?.canal, p.venta?.modalidad),
        )
        .reduce((acc, p) => acc + Number(p.monto), 0);

      // Plata que SALIÓ de caja física por movimientos (egresos + transferencias internas saliendo).
      const totalEgresosCaja = movimientos
        .filter(
          (m) =>
            (m.tipo === 'EGRESO' || m.tipo === 'TRANSFERENCIA_INTERNA') &&
            esEfectivoCierre(m.cuentaOrigen),
        )
        .reduce((acc, m) => acc + Number(m.monto), 0);

      // Plata que ENTRÓ a caja física por movimientos (ingresos + transferencias internas entrando).
      const totalIngresosCaja = movimientos
        .filter(
          (m) =>
            (m.tipo === 'INGRESO' || m.tipo === 'TRANSFERENCIA_INTERNA') &&
            esEfectivoCierre(m.cuentaDestino),
        )
        .reduce((acc, m) => acc + Number(m.monto), 0);

      const recaudacionEsperadaEfectivo =
        Number(sesion.existenciaInicial) +
        totalEfectivo +
        totalIngresosCaja -
        totalEgresosCaja;

      return {
        sesion: {
          id: sesion.id,
          fecha: sesion.fecha,
          turno: sesion.turno,
          estado: sesion.estado,
          horarioApertura: sesion.horarioApertura,
          horarioCierre: sesion.horarioCierre,
          existenciaInicial: sesion.existenciaInicial.toFixed(2),
          existenciaFinal: sesion.existenciaFinal?.toFixed(2) ?? null,
          diferencia: sesion.diferencia?.toFixed(2) ?? null,
          aprobadaPorAdmin: sesion.aprobadaPorAdmin,
          usuarioApertura: sesion.usuarioApertura.nombre,
          usuarioCierre: sesion.usuarioCierre?.nombre ?? null,
        },
        cobrosPorMetodo,
        // Listado completo de movimientos del turno (sin filtrar por cuenta —
        // la encargada quiere verlos todos; el filtro es sólo en el cálculo).
        // Cada item incluye `afectaCaja` para que la UI pueda destacarlos.
        movimientos: movimientos.map((m) => {
          const sale = esEfectivoCierre(m.cuentaOrigen);
          const entra = esEfectivoCierre(m.cuentaDestino);
          return {
            id: m.id,
            tipo: m.tipo,
            monto: m.monto.toString(),
            categoria: m.categoria.nombre,
            cuentaOrigen: m.cuentaOrigen?.nombre ?? null,
            cuentaDestino: m.cuentaDestino?.nombre ?? null,
            afectaCaja: sale || entra,
          };
        }),
        ventasCount,
        ventasAbiertas,
        encargosAPagar,
        totalEfectivo: totalEfectivo.toFixed(2),
        totalIngresosCaja: totalIngresosCaja.toFixed(2),
        totalEgresosCaja: totalEgresosCaja.toFixed(2),
        // Alias deprecado conservado por compatibilidad de UI vieja. Igual al egresos-de-caja
        // — antes incluía egresos desde cualquier cuenta, ahora sólo desde caja.
        totalEgresos: totalEgresosCaja.toFixed(2),
        recaudacionEsperadaEfectivo: recaudacionEsperadaEfectivo.toFixed(2),
        resolucion,
      };
    },
  );

  // GET /admin/caja/sesiones-abiertas — TODAS las sesiones ABIERTA. Sirve para
  // que el cierre muestre las viejas colgadas (de días/turnos anteriores que
  // el auto-lock dejó abiertas) y la encargada las pueda cerrar puntualmente,
  // en vez de que el server resuelva una sola y agarre la equivocada.
  fastify.get(
    '/admin/caja/sesiones-abiertas',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const sesiones = await prisma.sesionCaja.findMany({
        where: { estado: 'ABIERTA' },
        orderBy: [{ fecha: 'asc' }, { horarioApertura: 'asc' }],
        include: { usuarioApertura: { select: { nombre: true } } },
      });
      // Para distinguir cuál es la del slot vigente (la "normal" de hoy) vs las
      // colgadas, devolvemos la resolución actual.
      const { sesion: actual } = await getSesionActualReadOnly();
      return {
        sesiones: sesiones.map((s) => ({
          id: s.id,
          fecha: s.fecha,
          turno: s.turno,
          horarioApertura: s.horarioApertura,
          abiertaPor: s.usuarioApertura?.nombre ?? null,
          esActual: actual?.id === s.id,
        })),
      };
    },
  );

  // GET /admin/caja/sesiones-del-dia?fecha=YYYY-MM-DD — sesiones de un día
  // puntual. Sirve para que el dashboard de ventas deje elegir CUÁL sesión de
  // ese día mostrar (cuando hubo mañana + tarde, o varias por cierres).
  fastify.get(
    '/admin/caja/sesiones-del-dia',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { querystring: z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) },
    },
    async (req) => {
      const { fecha } = req.query as { fecha: string };
      // `fecha` de SesionCaja es @db.Date (sin hora) → matchea por igualdad con
      // la medianoche UTC de ese día.
      const dia = new Date(`${fecha}T00:00:00.000Z`);
      const sesiones = await prisma.sesionCaja.findMany({
        where: { fecha: dia },
        orderBy: { horarioApertura: 'asc' },
        include: { usuarioApertura: { select: { nombre: true } } },
      });
      return {
        sesiones: sesiones.map((s) => ({
          id: s.id,
          fecha: s.fecha,
          turno: s.turno,
          horarioApertura: s.horarioApertura,
          horarioCierre: s.horarioCierre,
          estado: s.estado,
          abiertaPor: s.usuarioApertura?.nombre ?? null,
        })),
      };
    },
  );

  // POST /admin/caja/sesion-actual/cerrar — cierra la sesión con conteo físico.
  //
  // El flag `anticipado` (opcional) lo marca como CIERRE ANTICIPADO: el
  // resolverSlotActivo no reabre el slot por el resto del día. Útil cuando
  // el local termina la jornada antes del horario configurado (ej: pautada
  // hasta 14:30 pero cierran a las 13:00).
  fastify.post(
    '/admin/caja/sesion-actual/cerrar',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          existenciaFinal: z.string().regex(/^\d+(\.\d{1,2})?$/),
          observaciones: z.string().max(500).optional(),
          anticipado: z.boolean().optional().default(false),
          // Id explícito de la sesión a cerrar. La UI manda SIEMPRE el id de la
          // sesión que está mostrando → se cierra exactamente esa, sin que el
          // server re-resuelva y agarre otra (incidente: "toma una sesión
          // anterior al cerrarla", por sesiones viejas colgadas). Si no viene,
          // cae al resolver legacy.
          sesionId: z.string().uuid().optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        existenciaFinal: string;
        observaciones?: string;
        anticipado?: boolean;
        sesionId?: string;
      };
      const ahora = new Date();

      // Si la UI mandó el id explícito, cerramos ESA sesión. Sino, resolvemos
      // como antes (slot vigente / última abierta).
      let sesion;
      if (body.sesionId) {
        sesion = await prisma.sesionCaja.findUnique({ where: { id: body.sesionId } });
      } else {
        const { sesion: sesionResolved } = await getSesionActualReadOnly();
        sesion = sesionResolved
          ? await prisma.sesionCaja.findUnique({ where: { id: sesionResolved.id } })
          : null;
      }
      if (!sesion) return reply.code(404).send({ error: 'Sesión no encontrada' });
      if (sesion.estado !== 'ABIERTA') {
        return reply.code(400).send({ error: `La sesión está ${sesion.estado}` });
      }

      // Calcular esperada — sólo lo que entra y sale de la caja física (tipo=EFECTIVO).
      // Antes (pre-fix) se sumaba TODO pago con metodo='EFECTIVO' y se restaban TODOS
      // los egresos de la sesión sin importar cuenta origen — eso mezclaba pagos a
      // proveedores hechos desde banco con la caja, dando diferencias fantasma de
      // millones (incidente: cierre del 17/05 MAÑANA con dif=$4.86M por un egreso de
      // Santander que se restaba como si fuera efectivo).
      // `excluidaDeCierreCaja=false` filtra cuentas como "Efectivo acumulado"
      // (efectivo de cajas anteriores que el dueño guarda aparte). Movimientos
      // contra esas cuentas NO afectan al esperado del turno.
      const pagosEfectivo = await prisma.pago.aggregate({
        _sum: { monto: true },
        where: {
          estado: 'CONFIRMADO',
          cuenta: { tipo: 'EFECTIVO', excluidaDeCierreCaja: false },
          venta: {
            sesionCajaId: sesion.id,
            estado: EstadoVenta.FINALIZADA,
            // Ventas DELIVERATE: su efectivo lo cobra el repartidor de
            // DELIVERATE (rinde semanal, neto de comisión) — nunca entra al
            // cajón. Sin esta exclusión el esperado se infla y el cierre da
            // "falta efectivo" fantasma por el monto exacto de esas ventas.
            NOT: [{ modalidad: 'DELIVERY_DELIVERATE' }, { canal: 'DELIVERATE' }],
          },
        },
      });
      const egresosCaja = await prisma.movimiento.aggregate({
        _sum: { monto: true },
        where: {
          sesionCajaId: sesion.id,
          estado: EstadoMovimiento.CONFIRMADO,
          tipo: { in: ['EGRESO', 'TRANSFERENCIA_INTERNA'] },
          cuentaOrigen: { tipo: 'EFECTIVO', excluidaDeCierreCaja: false },
        },
      });
      const ingresosCaja = await prisma.movimiento.aggregate({
        _sum: { monto: true },
        where: {
          sesionCajaId: sesion.id,
          estado: EstadoMovimiento.CONFIRMADO,
          tipo: { in: ['INGRESO', 'TRANSFERENCIA_INTERNA'] },
          cuentaDestino: { tipo: 'EFECTIVO', excluidaDeCierreCaja: false },
        },
      });
      const esperada =
        Number(sesion.existenciaInicial) +
        Number(pagosEfectivo._sum.monto ?? 0) +
        Number(ingresosCaja._sum.monto ?? 0) -
        Number(egresosCaja._sum.monto ?? 0);
      const final = Number(body.existenciaFinal);
      const diferencia = final - esperada;

      const observacionFinal = body.anticipado
        ? `[CIERRE ANTICIPADO] ${body.observaciones ?? ''}`.trim()
        : body.observaciones ?? null;

      const updated = await prisma.sesionCaja.update({
        where: { id: sesion.id },
        data: {
          estado: 'CERRADA',
          existenciaFinal: body.existenciaFinal,
          recaudacionEsperada: esperada.toFixed(2),
          diferencia: diferencia.toFixed(2),
          horarioCierre: ahora,
          usuarioCierreId: req.usuario!.id,
          observaciones: observacionFinal,
          cerradaAnticipadamente: !!body.anticipado,
        },
      });

      await recordAudit({
        tabla: 'sesiones_caja',
        registroId: sesion.id,
        accion: body.anticipado ? 'CIERRE_ANTICIPADO' : 'TRANSITION',
        usuarioId: req.usuario!.id,
        valorAnterior: { estado: 'ABIERTA' },
        valorNuevo: {
          estado: 'CERRADA',
          existenciaFinal: body.existenciaFinal,
          esperada: esperada.toFixed(2),
          diferencia: diferencia.toFixed(2),
        },
      });

      // Auto-envío del email del cierre (fire-and-forget). Si SMTP no está
      // configurado o falla, NO bloquea el cierre — sólo loguea. La
      // encargada puede re-enviar manualmente desde /admin/cierres si hace
      // falta. Controlado por flag email_auto_envio_cierre.
      void enviarEmailDeCierreSiCorresponde(sesion.id).catch((e) => {
        req.log.error({ err: e, sesionId: sesion.id }, 'Auto-envío de email del cierre falló');
      });

      return updated;
    },
  );

  // POST /admin/caja/sesion/:id/aprobar
  fastify.post(
    '/admin/caja/sesion/:id/aprobar',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const sesion = await prisma.sesionCaja.findUnique({ where: { id: params.id } });
      if (!sesion) return reply.code(404).send({ error: 'Sesión no encontrada' });
      if (sesion.estado !== 'CERRADA') {
        return reply.code(400).send({ error: `Solo se aprueban sesiones CERRADAS` });
      }

      // Al aprobar, barremos la plata física del cierre (existenciaFinal) a la
      // cuenta "Efectivo acumulado" (EFECTIVO, excluida del cierre). Como el
      // próximo turno arranca en $0, ese efectivo acumula ahí. La cuenta destino
      // está excluida del cierre, así que NO afecta los cierres siguientes, y
      // como el aprobar solo corre una vez (CERRADA → APROBADA) no se duplica.
      const efectivo = Number(sesion.existenciaFinal ?? 0);
      let cuentaDestino: { id: string; nombre: string } | null = null;
      if (efectivo > 0) {
        cuentaDestino =
          (await prisma.cuenta.findFirst({
            where: {
              tipo: 'EFECTIVO',
              excluidaDeCierreCaja: true,
              activa: true,
              nombre: { contains: 'acumulado', mode: 'insensitive' },
            },
            select: { id: true, nombre: true },
          })) ??
          (await prisma.cuenta.findFirst({
            where: { tipo: 'EFECTIVO', excluidaDeCierreCaja: true, activa: true },
            orderBy: { nombre: 'asc' },
            select: { id: true, nombre: true },
          }));
      }

      const result = await prisma.$transaction(async (tx) => {
        const s = await tx.sesionCaja.update({
          where: { id: sesion.id },
          data: {
            estado: 'APROBADA',
            aprobadaPorAdmin: true,
            aprobadaAdminId: req.usuario!.id,
            fechaAprobacion: new Date(),
          },
        });

        let barridoId: string | null = null;
        if (efectivo > 0 && cuentaDestino) {
          // Categoría dedicada (idempotente). esOperativa=false: es un
          // movimiento de tesorería, no un ingreso operativo nuevo (las ventas
          // ya se cuentan aparte), así no infla los reportes de ingresos.
          const categoria = await tx.categoriaMovimiento.upsert({
            where: { nombre: 'Recaudación de caja' },
            create: {
              nombre: 'Recaudación de caja',
              tipo: TipoCategoriaMovimiento.INGRESO,
              esSistema: true,
              esOperativa: false,
            },
            update: {},
          });
          const mov = await tx.movimiento.create({
            data: {
              tipo: 'INGRESO',
              monto: sesion.existenciaFinal!,
              categoriaId: categoria.id,
              cuentaDestinoId: cuentaDestino.id,
              sesionCajaId: sesion.id,
              fechaComputo: new Date(),
              observacion: `Barrido de efectivo al aprobar cierre ${new Date(
                sesion.fecha,
              ).toLocaleDateString('es-AR')} ${sesion.turno}`,
              estado: EstadoMovimiento.CONFIRMADO,
              usuarioId: req.usuario!.id,
            },
          });
          await tx.cuenta.update({
            where: { id: cuentaDestino.id },
            data: { saldoActual: { increment: efectivo } },
          });
          barridoId = mov.id;
        }
        return { s, barridoId };
      });

      await recordAudit({
        tabla: 'sesiones_caja',
        registroId: sesion.id,
        accion: 'TRANSITION',
        usuarioId: req.usuario!.id,
        valorAnterior: { estado: 'CERRADA' },
        valorNuevo: {
          estado: 'APROBADA',
          barridoEfectivo: result.barridoId ? efectivo.toFixed(2) : null,
          cuentaAcumulada: result.barridoId ? cuentaDestino?.nombre : null,
        },
      });

      if (result.barridoId) {
        await recordAudit({
          tabla: 'movimientos',
          registroId: result.barridoId,
          accion: 'INSERT',
          usuarioId: req.usuario!.id,
          valorNuevo: {
            tipo: 'INGRESO',
            monto: efectivo.toFixed(2),
            categoria: 'Recaudación de caja',
            cuentaDestino: cuentaDestino?.nombre,
            origen: `Barrido de efectivo al aprobar cierre (sesión ${sesion.id})`,
          },
        });
      }

      return {
        ...result.s,
        barrido: result.barridoId
          ? { monto: efectivo.toFixed(2), cuenta: cuentaDestino!.nombre }
          : null,
      };
    },
  );

  // POST /admin/caja/sesion/:id/enviar-email — manda el cierre por email con
  // adjunto Excel. Si no se pasa `to`, usa ADMIN_EMAIL_RECIPIENTS del .env.
  fastify.post(
    '/admin/caja/sesion/:id/enviar-email',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          to: z.array(z.string().email()).optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { to?: string[] };
      try {
        const data = await cargarCierre(params.id);
        if (data.sesion.estado === 'ABIERTA') {
          return reply
            .code(400)
            .send({ error: 'No se puede enviar el cierre de una sesión abierta' });
        }
        const xlsx = await generarExcelCierre(data);
        const { subject, html, text } = generarHtmlCierre(data);
        const fechaSlug = data.sesion.fecha.toISOString().slice(0, 10);
        const turnoSlug = data.sesion.turno.toLowerCase();
        const result = await sendMail({
          to: body.to,
          subject,
          html,
          text,
          attachments: [
            {
              filename: `cierre-${fechaSlug}-${turnoSlug}.xlsx`,
              content: xlsx,
              contentType:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
          ],
        });

        await prisma.sesionCaja.update({
          where: { id: params.id },
          data: {
            emailEnviadoA: result.recipients.join(', '),
            emailEnviadoAt: new Date(),
          },
        });

        return {
          ok: true,
          recipients: result.recipients,
          previewUrl: result.previewUrl, // null si SMTP real, URL si Ethereal
          isEthereal: result.isEthereal,
          messageId: result.messageId,
        };
      } catch (e) {
        return reply
          .code(500)
          .send({ error: e instanceof Error ? e.message : 'Error al enviar' });
      }
    },
  );

  // POST /admin/caja/sesion/:id/sincronizar-cashflow — actualiza CASHFLOW 2026.xlsx
  // con los datos del día completo (mañana + tarde) que contiene la sesión.
  fastify.post(
    '/admin/caja/sesion/:id/sincronizar-cashflow',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const sesion = await prisma.sesionCaja.findUnique({ where: { id: params.id } });
      if (!sesion) return reply.code(404).send({ error: 'Sesión no encontrada' });
      try {
        const r = await actualizarCashflow({ fecha: sesion.fecha });
        return {
          ok: true,
          archivoPath: r.archivoPath,
          hoja: r.hoja,
          columna: r.columna,
          dia: r.diaLabel,
          celdasActualizadas: r.cambios.length,
          cambios: r.cambios.map((c) => ({
            celda: c.celda,
            etiqueta: c.etiqueta,
            valor: c.valorNuevo,
          })),
          warnings: r.warnings,
        };
      } catch (e) {
        return reply
          .code(500)
          .send({ error: e instanceof Error ? e.message : 'Error sincronizando' });
      }
    },
  );

  // POST /admin/email/test — sirve para validar que el SMTP está bien antes
  // de hacer un cierre real. Devuelve detalles de error de nodemailer
  // (`code`, `command`, `response`) para que el admin sepa qué arreglar:
  // EAUTH = pass mal, ECONNECTION = host/port/firewall, ETIMEDOUT = red, etc.
  fastify.post(
    '/admin/email/test',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { body: z.object({ to: z.string().email().optional() }) },
    },
    async (req, reply) => {
      const body = req.body as { to?: string };
      try {
        const r = await sendTestEmail(body.to);
        return r;
      } catch (e) {
        const err = e as Record<string, unknown>;
        return reply.code(500).send({
          error: e instanceof Error ? e.message : 'Error al enviar test',
          code: err?.code ?? null,
          command: err?.command ?? null,
          response: err?.response ?? null,
          responseCode: err?.responseCode ?? null,
        });
      }
    },
  );

  // GET /admin/caja/cierres — historial de sesiones cerradas/aprobadas
  fastify.get(
    '/admin/caja/cierres',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(30),
        }),
      },
    },
    async (req) => {
      const q = req.query as { page: number; pageSize: number };
      const [sesiones, total] = await Promise.all([
        prisma.sesionCaja.findMany({
          where: { estado: { in: ['CERRADA', 'APROBADA'] } },
          include: {
            usuarioApertura: { select: { nombre: true } },
            usuarioCierre: { select: { nombre: true } },
            aprobadaAdmin: { select: { nombre: true } },
          },
          orderBy: [{ fecha: 'desc' }, { turno: 'desc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.sesionCaja.count({ where: { estado: { in: ['CERRADA', 'APROBADA'] } } }),
      ]);
      return { sesiones, total, page: q.page, pageSize: q.pageSize };
    },
  );

  // GET /admin/caja/cierres/:id — detalle completo del cierre con desglose
  // paso a paso de cómo se llega al "esperado" + movimientos y ventas.
  fastify.get(
    '/admin/caja/cierres/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const sesion = await prisma.sesionCaja.findUnique({
        where: { id: params.id },
        include: {
          usuarioApertura: { select: { nombre: true } },
          usuarioCierre: { select: { nombre: true } },
          aprobadaAdmin: { select: { nombre: true } },
        },
      });
      if (!sesion) return reply.code(404).send({ error: 'Sesión no encontrada' });

      // 1. Pagos de la sesión — todos con cuenta para identificar EFECTIVO.
      const pagos = await prisma.pago.findMany({
        where: {
          estado: 'CONFIRMADO',
          venta: { sesionCajaId: sesion.id, estado: EstadoVenta.FINALIZADA },
        },
        select: {
          id: true,
          metodo: true,
          monto: true,
          cuenta: { select: { id: true, nombre: true, tipo: true, excluidaDeCierreCaja: true } },
          venta: { select: { numero: true, numeroOrdenTurno: true, canal: true, modalidad: true } },
        },
      });

      // 2. Movimientos con detalle de cuentas para identificar afecta-caja.
      const movs = await prisma.movimiento.findMany({
        where: { sesionCajaId: sesion.id, estado: EstadoMovimiento.CONFIRMADO },
        select: {
          id: true,
          tipo: true,
          monto: true,
          observacion: true,
          fechaComputo: true,
          categoria: { select: { nombre: true } },
          cuentaOrigen: { select: { nombre: true, tipo: true, excluidaDeCierreCaja: true } },
          cuentaDestino: { select: { nombre: true, tipo: true, excluidaDeCierreCaja: true } },
          usuario: { select: { nombre: true } },
        },
        orderBy: { fechaComputo: 'asc' },
      });

      // 3. Ventas (con totales por estado).
      const ventas = await prisma.venta.findMany({
        where: { sesionCajaId: sesion.id },
        select: {
          id: true,
          numero: true,
          numeroOrdenTurno: true,
          canal: true,
          modalidad: true,
          estado: true,
          total: true,
          fechaApertura: true,
          fechaFinalizacion: true,
        },
        orderBy: { numeroOrdenTurno: 'asc' },
      });

      // Desglose paso a paso del esperado. Cuentas con excluidaDeCierreCaja
      // se consideran NO-efectivo aunque su tipo lo sea — caso "Efectivo
      // acumulado" del dueño (cajas pasadas).
      const afectaCierre = (
        c: { tipo: string; excluidaDeCierreCaja?: boolean } | null | undefined,
      ): boolean => !!c && c.tipo === 'EFECTIVO' && c.excluidaDeCierreCaja !== true;

      // DELIVERATE no cuenta como efectivo del cajón (rinde semanal) — sus
      // pagos van al bloque informativo aunque la cuenta sea EFECTIVO.
      const cobrosEfectivo = pagos.filter(
        (p) => afectaCierre(p.cuenta) && !esVentaDeliverate(p.venta?.canal, p.venta?.modalidad),
      );
      const totalCobrosEfectivo = cobrosEfectivo.reduce((acc, p) => acc + Number(p.monto), 0);
      const ingresosCaja = movs.filter(
        (m) =>
          (m.tipo === 'INGRESO' || m.tipo === 'TRANSFERENCIA_INTERNA') &&
          afectaCierre(m.cuentaDestino),
      );
      const totalIngresosCaja = ingresosCaja.reduce((acc, m) => acc + Number(m.monto), 0);
      const egresosCaja = movs.filter(
        (m) =>
          (m.tipo === 'EGRESO' || m.tipo === 'TRANSFERENCIA_INTERNA') &&
          afectaCierre(m.cuentaOrigen),
      );
      const totalEgresosCaja = egresosCaja.reduce((acc, m) => acc + Number(m.monto), 0);

      const existenciaInicial = Number(sesion.existenciaInicial);
      const esperadaCalculada =
        existenciaInicial + totalCobrosEfectivo + totalIngresosCaja - totalEgresosCaja;

      // Pagos no-efectivo (info — no afectan caja física). Incluye los pagos
      // DELIVERATE aunque su cuenta sea EFECTIVO (van como informativos).
      const pagosNoEfectivo = pagos.filter(
        (p) => !afectaCierre(p.cuenta) || esVentaDeliverate(p.venta?.canal, p.venta?.modalidad),
      );
      // Movimientos que NO afectan caja (egresos/ingresos contra banco o cuenta excluida).
      const movsNoAfectanCaja = movs.filter(
        (m) => !afectaCierre(m.cuentaOrigen) && !afectaCierre(m.cuentaDestino),
      );

      // Agrupar pagos efectivo por método (info breakdown).
      const cobrosEfectivoPorMetodo = new Map<string, { monto: number; cantidad: number }>();
      for (const p of cobrosEfectivo) {
        const cur = cobrosEfectivoPorMetodo.get(p.metodo) ?? { monto: 0, cantidad: 0 };
        cur.monto += Number(p.monto);
        cur.cantidad += 1;
        cobrosEfectivoPorMetodo.set(p.metodo, cur);
      }
      const cobrosNoEfectivoPorMetodo = new Map<string, { monto: number; cantidad: number; cuenta: string }>();
      for (const p of pagosNoEfectivo) {
        const key = `${p.metodo}|${p.cuenta?.nombre ?? '—'}`;
        const cur = cobrosNoEfectivoPorMetodo.get(key) ?? {
          monto: 0,
          cantidad: 0,
          cuenta: p.cuenta?.nombre ?? '—',
        };
        cur.monto += Number(p.monto);
        cur.cantidad += 1;
        cobrosNoEfectivoPorMetodo.set(key, cur);
      }

      return {
        sesion: {
          id: sesion.id,
          fecha: sesion.fecha,
          turno: sesion.turno,
          estado: sesion.estado,
          horarioApertura: sesion.horarioApertura,
          horarioCierre: sesion.horarioCierre,
          existenciaInicial: existenciaInicial.toFixed(2),
          existenciaFinal: sesion.existenciaFinal?.toFixed(2) ?? null,
          recaudacionEsperada: sesion.recaudacionEsperada?.toFixed(2) ?? null,
          diferencia: sesion.diferencia?.toFixed(2) ?? null,
          observaciones: sesion.observaciones,
          cerradaAnticipadamente: sesion.cerradaAnticipadamente,
          fechaAprobacion: sesion.fechaAprobacion,
          usuarioApertura: sesion.usuarioApertura?.nombre ?? null,
          usuarioCierre: sesion.usuarioCierre?.nombre ?? null,
          aprobadaAdmin: sesion.aprobadaAdmin?.nombre ?? null,
          emailEnviadoA: sesion.emailEnviadoA,
          emailEnviadoAt: sesion.emailEnviadoAt,
        },
        // Desglose paso a paso del esperado (las 4 líneas que dan el número).
        desgloseEsperado: {
          existenciaInicial: existenciaInicial.toFixed(2),
          cobrosEfectivo: totalCobrosEfectivo.toFixed(2),
          cobrosEfectivoCantidad: cobrosEfectivo.length,
          ingresosCaja: totalIngresosCaja.toFixed(2),
          ingresosCajaCantidad: ingresosCaja.length,
          egresosCaja: totalEgresosCaja.toFixed(2),
          egresosCajaCantidad: egresosCaja.length,
          esperadaCalculada: esperadaCalculada.toFixed(2),
          // Si lo recalculado no coincide con lo guardado en la sesión, lo
          // marcamos para que la UI lo destaque (debug). Diferencia menor a
          // 1 centavo se considera igualdad.
          coincideConGuardado:
            sesion.recaudacionEsperada == null ||
            Math.abs(esperadaCalculada - Number(sesion.recaudacionEsperada)) < 0.01,
        },
        // Breakdown por método dentro de cada bucket.
        breakdownCobrosEfectivo: [...cobrosEfectivoPorMetodo.entries()].map(([metodo, v]) => ({
          metodo,
          monto: v.monto.toFixed(2),
          cantidad: v.cantidad,
        })),
        breakdownCobrosNoEfectivo: [...cobrosNoEfectivoPorMetodo.entries()].map(([key, v]) => ({
          metodo: key.split('|')[0],
          cuenta: v.cuenta,
          monto: v.monto.toFixed(2),
          cantidad: v.cantidad,
        })),
        // Listas detalladas que la UI muestra agrupadas/colapsables.
        ingresosCaja: ingresosCaja.map((m) => ({
          id: m.id,
          tipo: m.tipo,
          monto: m.monto.toString(),
          categoria: m.categoria.nombre,
          cuentaOrigen: m.cuentaOrigen?.nombre ?? null,
          cuentaDestino: m.cuentaDestino?.nombre ?? null,
          observacion: m.observacion,
          fecha: m.fechaComputo,
          usuario: m.usuario.nombre,
        })),
        egresosCaja: egresosCaja.map((m) => ({
          id: m.id,
          tipo: m.tipo,
          monto: m.monto.toString(),
          categoria: m.categoria.nombre,
          cuentaOrigen: m.cuentaOrigen?.nombre ?? null,
          cuentaDestino: m.cuentaDestino?.nombre ?? null,
          observacion: m.observacion,
          fecha: m.fechaComputo,
          usuario: m.usuario.nombre,
        })),
        movsNoAfectanCaja: movsNoAfectanCaja.map((m) => ({
          id: m.id,
          tipo: m.tipo,
          monto: m.monto.toString(),
          categoria: m.categoria.nombre,
          cuentaOrigen: m.cuentaOrigen?.nombre ?? null,
          cuentaDestino: m.cuentaDestino?.nombre ?? null,
          observacion: m.observacion,
          fecha: m.fechaComputo,
          usuario: m.usuario.nombre,
        })),
        ventas: {
          finalizadas: ventas.filter((v) => v.estado === 'FINALIZADA').map((v) => ({
            id: v.id,
            numero: v.numero,
            numeroOrdenTurno: v.numeroOrdenTurno,
            canal: v.canal,
            modalidad: v.modalidad,
            total: v.total.toString(),
            fechaFinalizacion: v.fechaFinalizacion,
          })),
          anuladas: ventas.filter((v) => v.estado === 'ANULADA').map((v) => ({
            id: v.id,
            numero: v.numero,
            numeroOrdenTurno: v.numeroOrdenTurno,
            canal: v.canal,
            total: v.total.toString(),
          })),
          procesadas: ventas.filter((v) => v.estado === 'PROCESADA').length,
        },
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   VENTAS — análisis dedicado (lo que rinde el día/semana/mes/custom)
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/ventas-analisis — KPIs + desglose por método + canal + listado.
  fastify.get(
    '/admin/ventas-analisis',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          periodo: z
            .enum([
              'hoy',
              'ayer',
              'semana',
              'mes',
              'trimestre',
              'anio',
              'custom',
              'sesion_actual',
              'sesion_anterior',
            ])
            .default('hoy'),
          desde: z.string().optional(),
          hasta: z.string().optional(),
          metodo: z.string().optional(),
          canal: z.string().optional(),
          // Filtro explícito por una sesión de caja puntual (selector del día custom).
          sesionId: z.string().uuid().optional(),
        }),
      },
    },
    async (req, reply) => {
      const q = req.query as {
        periodo:
          | 'hoy'
          | 'ayer'
          | 'semana'
          | 'mes'
          | 'trimestre'
          | 'anio'
          | 'custom'
          | 'sesion_actual'
          | 'sesion_anterior';
        desde?: string;
        hasta?: string;
        metodo?: string;
        canal?: string;
        sesionId?: string;
      };

      // Resolver rango de fechas
      const ahora = new Date();
      const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
      let desde: Date = inicioHoy;
      let hasta: Date = ahora;

      // ── Filtro por SESIÓN de caja ───────────────────────────────────────
      // Cuando se pide una sesión puntual ('sesion_actual'/'sesion_anterior'
      // o un sesionId del selector del día custom), el dashboard muestra
      // EXACTAMENTE esa sesión: filtramos ventas/anuladas/movimientos por
      // `sesionCajaId` (fuente de verdad del turno) y ajustamos desde/hasta a
      // la ventana [apertura, cierre] para los gráficos por hora.
      const usaSesion =
        !!q.sesionId || q.periodo === 'sesion_actual' || q.periodo === 'sesion_anterior';
      let sesionFiltroId: string | null = null;
      let sesionFiltroMeta: {
        id: string;
        fecha: Date;
        turno: string;
        horarioApertura: Date;
        horarioCierre: Date | null;
        estado: string;
      } | null = null;

      if (usaSesion) {
        let sesion: Awaited<ReturnType<typeof prisma.sesionCaja.findUnique>> = null;
        if (q.sesionId) {
          sesion = await prisma.sesionCaja.findUnique({ where: { id: q.sesionId } });
        } else if (q.periodo === 'sesion_actual') {
          const r = await getSesionActualReadOnly();
          sesion =
            r.sesion ??
            (await prisma.sesionCaja.findFirst({ orderBy: { horarioApertura: 'desc' } }));
        } else {
          // sesion_anterior: la sesión inmediatamente previa a la "actual".
          const r = await getSesionActualReadOnly();
          const ref =
            r.sesion ??
            (await prisma.sesionCaja.findFirst({ orderBy: { horarioApertura: 'desc' } }));
          if (ref) {
            sesion = await prisma.sesionCaja.findFirst({
              where: { horarioApertura: { lt: ref.horarioApertura } },
              orderBy: { horarioApertura: 'desc' },
            });
          }
        }
        if (!sesion) {
          return reply
            .code(404)
            .send({ error: 'No se encontró la sesión solicitada', codigo: 'SESION_NO_ENCONTRADA' });
        }
        sesionFiltroId = sesion.id;
        sesionFiltroMeta = {
          id: sesion.id,
          fecha: sesion.fecha,
          turno: sesion.turno,
          horarioApertura: sesion.horarioApertura,
          horarioCierre: sesion.horarioCierre,
          estado: sesion.estado,
        };
        desde = sesion.horarioApertura;
        hasta = sesion.horarioCierre ?? new Date();
      } else if (q.periodo === 'custom') {
        if (!q.desde || !q.hasta) {
          return reply.code(400).send({ error: 'desde y hasta requeridos para custom' });
        }
        const [yd, md, dd] = q.desde.split('-').map(Number);
        const [yh, mh, dh] = q.hasta.split('-').map(Number);
        desde = new Date(yd!, (md ?? 1) - 1, dd ?? 1, 0, 0, 0, 0);
        hasta = new Date(yh!, (mh ?? 1) - 1, dh ?? 1, 23, 59, 59, 999);
      } else {
        hasta = new Date();
        switch (q.periodo) {
          case 'hoy':
            desde = inicioHoy;
            break;
          case 'ayer':
            desde = new Date(inicioHoy);
            desde.setDate(desde.getDate() - 1);
            hasta = new Date(inicioHoy);
            hasta.setMilliseconds(-1);
            break;
          case 'semana':
            desde = new Date(inicioHoy);
            desde.setDate(desde.getDate() - 7);
            break;
          case 'mes':
            desde = new Date(inicioHoy);
            desde.setDate(desde.getDate() - 30);
            break;
          case 'trimestre':
            desde = new Date(inicioHoy);
            desde.setDate(desde.getDate() - 90);
            break;
          case 'anio':
            desde = new Date(inicioHoy);
            desde.setFullYear(desde.getFullYear() - 1);
            break;
        }
      }

      // Cargar TODAS las ventas del período para que las agregaciones (KPIs,
      // cierre de cajas) sean exactas. El `take: 500` previo truncaba
      // silenciosamente días con > 500 ventas (a 2.500 ventas/día se podía
      // perder hasta el 80% de la data sin warning).
      //
      // Para limitar memoria, sólo traemos las columnas que usamos para
      // agregar — NO cargamos items, cliente, etc. (eso queda para el listado
      // de abajo, que sí está paginado a 200).
      const ventas = await prisma.venta.findMany({
        where: {
          estado: EstadoVenta.FINALIZADA,
          ...(sesionFiltroId
            ? { sesionCajaId: sesionFiltroId }
            : { fechaFinalizacion: { gte: desde, lte: hasta } }),
          ...(q.canal && { canal: q.canal as never }),
        },
        select: {
          id: true,
          canal: true,
          modalidad: true,
          total: true,
          descuentoTotal: true,
          fechaFinalizacion: true,
          pagos: {
            where: { estado: 'CONFIRMADO' },
            select: { metodo: true, monto: true },
          },
        },
        orderBy: { fechaFinalizacion: 'desc' },
      });

      // Anuladas (para el contador del mismo período)
      const anuladasCount = await prisma.venta.count({
        where: {
          estado: 'ANULADA',
          ...(sesionFiltroId
            ? { sesionCajaId: sesionFiltroId }
            : { fechaAnulacion: { gte: desde, lte: hasta } }),
          ...(q.canal && { canal: q.canal as never }),
        },
      });

      // Filtrar por método si vino en el query (a nivel pago)
      const ventasFiltradas = q.metodo
        ? ventas.filter((v) => v.pagos.some((p) => p.metodo === q.metodo))
        : ventas;

      // Agregados
      const totalCobrado = ventasFiltradas.reduce(
        (acc, v) => acc + Number(v.total),
        0,
      );
      const cantidadVentas = ventasFiltradas.length;
      const ticketPromedio = cantidadVentas > 0 ? totalCobrado / cantidadVentas : 0;
      const totalDescuentos = ventasFiltradas.reduce(
        (acc, v) => acc + Number(v.descuentoTotal),
        0,
      );

      // Por método
      type Bucket = { monto: number; cantidad: number };
      const porMetodo = new Map<string, Bucket>();
      for (const v of ventasFiltradas) {
        for (const p of v.pagos) {
          if (q.metodo && p.metodo !== q.metodo) continue;
          const cur = porMetodo.get(p.metodo) ?? { monto: 0, cantidad: 0 };
          cur.monto += Number(p.monto);
          cur.cantidad += 1;
          porMetodo.set(p.metodo, cur);
        }
      }

      // Por canal
      const porCanal = new Map<string, Bucket>();
      for (const v of ventasFiltradas) {
        const cur = porCanal.get(v.canal) ?? { monto: 0, cantidad: 0 };
        cur.monto += Number(v.total);
        cur.cantidad += 1;
        porCanal.set(v.canal, cur);
      }

      // ──────────────────────────────────────────────────────────────────
      //   Categorización jerárquica: MOSTRADOR / DELIVERY / PLATAFORMAS
      //   (lo que el dueño y la encargada quieren ver al cerrar caja)
      // ──────────────────────────────────────────────────────────────────
      const ESES_NO_EFECTIVO_DEBITO = (m: string) =>
        m !== 'EFECTIVO' && m !== 'DEBITO';

      let mostradorEfectivo = 0,
        mostradorDebito = 0,
        mostradorCreditoOtros = 0;
      let deliveryEfectivoDamian = 0,
        deliveryEfectivoDeliverate = 0,
        deliveryOnline = 0;
      let plataformasApp = 0,
        plataformasEfectivo = 0;
      let countMostradorEf = 0,
        countMostradorDeb = 0,
        countMostradorCred = 0;
      let countDamianEf = 0,
        countDeliverateEf = 0,
        countDeliveryOnline = 0;
      let countPlataApp = 0,
        countPlataEf = 0;

      for (const v of ventasFiltradas) {
        const bucket = clasificarCanalBucket(v.canal, v.modalidad);
        // delivery_propio acá lo tratamos según canal — para los buckets "delivery"
        // del cierre de cajas, TELEFONO/WHATSAPP/WEB caen en delivery local
        // independiente de modalidad (la encargada quiere ver el origen del pedido).
        const esDeliveryLocal =
          v.canal === 'TELEFONO' || v.canal === 'WHATSAPP' || v.canal === 'WEB';
        const esDeliverate = bucket === 'deliverate';
        const esPlataforma = bucket === 'plataforma';

        for (const p of v.pagos) {
          if (q.metodo && p.metodo !== q.metodo) continue;
          const monto = Number(p.monto);
          // DELIVERATE va PRIMERO: la venta entra por su canal real (mostrador/
          // teléfono/wsp) + modalidad DELIVERY_DELIVERATE. Si se chequea el
          // canal antes, su efectivo cae en "Efectivo Damián" o "Mostrador" e
          // infla el efectivo en caja (bug real reportado por el dueño).
          // TODO el cobro DELIVERATE (cualquier método) va a su discriminación:
          // rinde semanal, neto de la comisión del servicio. NO suma a caja.
          if (esDeliverate) {
            deliveryEfectivoDeliverate += monto;
            countDeliverateEf += 1;
          } else if (bucket === 'mostrador' && !esDeliveryLocal) {
            if (p.metodo === 'EFECTIVO') {
              mostradorEfectivo += monto;
              countMostradorEf += 1;
            } else if (p.metodo === 'DEBITO') {
              mostradorDebito += monto;
              countMostradorDeb += 1;
            } else {
              mostradorCreditoOtros += monto;
              countMostradorCred += 1;
            }
          } else if (esDeliveryLocal) {
            if (p.metodo === 'EFECTIVO') {
              deliveryEfectivoDamian += monto;
              countDamianEf += 1;
            } else {
              deliveryOnline += monto;
              countDeliveryOnline += 1;
            }
          } else if (esPlataforma) {
            if (p.metodo === 'EFECTIVO') {
              plataformasEfectivo += monto;
              countPlataEf += 1;
            } else {
              plataformasApp += monto;
              countPlataApp += 1;
            }
          } else {
            // Fallback (no debería caer acá con canales actuales)
            if (p.metodo === 'EFECTIVO') {
              mostradorEfectivo += monto;
              countMostradorEf += 1;
            } else if (p.metodo === 'DEBITO') {
              mostradorDebito += monto;
              countMostradorDeb += 1;
            } else if (ESES_NO_EFECTIVO_DEBITO(p.metodo)) {
              mostradorCreditoOtros += monto;
              countMostradorCred += 1;
            }
          }
        }
      }

      // Movimientos del período sobre Caja física (para calcular efectivo en caja)
      const cajaFisica = await prisma.cuenta.findFirst({
        where: { tipo: 'EFECTIVO', activa: true },
        orderBy: { nombre: 'asc' },
      });
      let aportesEfectivo = 0;
      let egresosEfectivo = 0;
      let countAportes = 0;
      let countEgresos = 0;
      if (cajaFisica) {
        const movs = await prisma.movimiento.findMany({
          where: {
            estado: 'CONFIRMADO',
            ...(sesionFiltroId
              ? { sesionCajaId: sesionFiltroId }
              : { fechaComputo: { gte: desde, lte: hasta } }),
            OR: [
              { cuentaOrigenId: cajaFisica.id },
              { cuentaDestinoId: cajaFisica.id },
            ],
          },
          select: { tipo: true, monto: true, cuentaOrigenId: true, cuentaDestinoId: true },
        });
        for (const m of movs) {
          const monto = Number(m.monto);
          if (m.cuentaDestinoId === cajaFisica.id) {
            // Entra plata a caja física: ingreso o transferencia entrante
            aportesEfectivo += monto;
            countAportes += 1;
          }
          if (m.cuentaOrigenId === cajaFisica.id) {
            // Sale plata de caja física: egreso o transferencia saliente
            egresosEfectivo += monto;
            countEgresos += 1;
          }
        }
      }

      // Efectivo en caja al cierre
      // = efectivo mostrador + efectivo Damián + efectivo plataformas (PYA)
      // + aportes en efectivo del período − egresos en efectivo del período
      const efectivoFromVentas =
        mostradorEfectivo + deliveryEfectivoDamian + plataformasEfectivo;
      const efectivoEnCaja = efectivoFromVentas + aportesEfectivo - egresosEfectivo;

      const totalMostrador =
        mostradorEfectivo + mostradorDebito + mostradorCreditoOtros;
      const totalDelivery =
        deliveryEfectivoDamian + deliveryEfectivoDeliverate + deliveryOnline;
      const totalPlataformas = plataformasApp + plataformasEfectivo;

      const cierreCajas = {
        mostrador: {
          total: totalMostrador.toFixed(2),
          efectivo: { monto: mostradorEfectivo.toFixed(2), cantidad: countMostradorEf },
          debito: { monto: mostradorDebito.toFixed(2), cantidad: countMostradorDeb },
          creditoOtros: {
            monto: mostradorCreditoOtros.toFixed(2),
            cantidad: countMostradorCred,
          },
        },
        delivery: {
          total: totalDelivery.toFixed(2),
          // Suma a caja (lo que efectivamente entra hoy):
          efectivoDamian: {
            monto: deliveryEfectivoDamian.toFixed(2),
            cantidad: countDamianEf,
          },
          // Informativo (rinde semanal, NO suma):
          efectivoDeliverate: {
            monto: deliveryEfectivoDeliverate.toFixed(2),
            cantidad: countDeliverateEf,
          },
          online: { monto: deliveryOnline.toFixed(2), cantidad: countDeliveryOnline },
        },
        plataformas: {
          total: totalPlataformas.toFixed(2),
          app: { monto: plataformasApp.toFixed(2), cantidad: countPlataApp },
          efectivo: { monto: plataformasEfectivo.toFixed(2), cantidad: countPlataEf },
        },
        // Bloque permanente: cuánto efectivo debería tener en caja en este momento
        efectivoEnCaja: {
          total: efectivoEnCaja.toFixed(2),
          desgloseVentas: {
            mostrador: mostradorEfectivo.toFixed(2),
            damian: deliveryEfectivoDamian.toFixed(2),
            plataformasEfectivo: plataformasEfectivo.toFixed(2),
            subtotal: efectivoFromVentas.toFixed(2),
          },
          aportes: { monto: aportesEfectivo.toFixed(2), cantidad: countAportes },
          egresos: { monto: egresosEfectivo.toFixed(2), cantidad: countEgresos },
        },
      };

      // Por hora del día (solo si rango ≤ 2 días)
      const rangoMs = hasta.getTime() - desde.getTime();
      const porHora: Array<{ hora: number; monto: number; cantidad: number }> = [];
      if (rangoMs <= 2 * 24 * 60 * 60 * 1000) {
        const map = new Map<number, Bucket>();
        for (const v of ventasFiltradas) {
          if (!v.fechaFinalizacion) continue;
          const h = v.fechaFinalizacion.getHours();
          const cur = map.get(h) ?? { monto: 0, cantidad: 0 };
          cur.monto += Number(v.total);
          cur.cantidad += 1;
          map.set(h, cur);
        }
        for (let h = 9; h <= 23; h++) {
          const r = map.get(h) ?? { monto: 0, cantidad: 0 };
          porHora.push({ hora: h, monto: r.monto, cantidad: r.cantidad });
        }
      }

      // Por día (cuando rango > 2 días)
      const porDia: Array<{ fecha: string; monto: number; cantidad: number }> = [];
      if (rangoMs > 2 * 24 * 60 * 60 * 1000) {
        const map = new Map<string, Bucket>();
        for (const v of ventasFiltradas) {
          if (!v.fechaFinalizacion) continue;
          const f = v.fechaFinalizacion;
          const key = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
          const cur = map.get(key) ?? { monto: 0, cantidad: 0 };
          cur.monto += Number(v.total);
          cur.cantidad += 1;
          map.set(key, cur);
        }
        for (const [k, v] of map.entries()) {
          porDia.push({ fecha: k, monto: v.monto, cantidad: v.cantidad });
        }
        porDia.sort((a, b) => a.fecha.localeCompare(b.fecha));
      }

      return {
        rango: { desde, hasta },
        sesion: sesionFiltroMeta,
        kpis: {
          totalCobrado: totalCobrado.toFixed(2),
          cantidadVentas,
          ticketPromedio: ticketPromedio.toFixed(2),
          totalDescuentos: totalDescuentos.toFixed(2),
          anuladasCantidad: anuladasCount,
        },
        cierreCajas,
        porMetodo: Array.from(porMetodo.entries())
          .map(([metodo, b]) => ({
            metodo,
            monto: b.monto.toFixed(2),
            cantidad: b.cantidad,
            pct: totalCobrado > 0 ? Number(((b.monto / totalCobrado) * 100).toFixed(1)) : 0,
          }))
          .sort((a, b) => Number(b.monto) - Number(a.monto)),
        porCanal: Array.from(porCanal.entries())
          .map(([canal, b]) => ({
            canal,
            monto: b.monto.toFixed(2),
            cantidad: b.cantidad,
            pct: totalCobrado > 0 ? Number(((b.monto / totalCobrado) * 100).toFixed(1)) : 0,
          }))
          .sort((a, b) => Number(b.monto) - Number(a.monto)),
        porHora,
        porDia,
        ventas: await (async () => {
          // Listado paginado a 200 con campos extras (numero, numeroOrden) que
          // NO se piden en la query agregada para no cargar todo a memoria.
          const ventasListado = await prisma.venta.findMany({
            where: {
              estado: EstadoVenta.FINALIZADA,
              // Mismo criterio que los agregados: si se filtra por sesión de caja
              // usamos `sesionCajaId`; si no, el rango por fecha.
              ...(sesionFiltroId
                ? { sesionCajaId: sesionFiltroId }
                : { fechaFinalizacion: { gte: desde, lte: hasta } }),
              ...(q.canal && { canal: q.canal as never }),
              ...(q.metodo && {
                pagos: { some: { metodo: q.metodo as never, estado: 'CONFIRMADO' } },
              }),
            },
            select: {
              id: true,
              numero: true,
              numeroOrdenTurno: true,
              canal: true,
              modalidad: true,
              fechaFinalizacion: true,
              total: true,
              descuentoTotal: true,
              // Cliente del pedido: el cliente asociado, o el nombre cargado en el
              // snapshot de delivery (lo tipea la cajera en pedidos telefónicos/WhatsApp).
              cliente: { select: { nombre: true, apellido: true } },
              deliveryInfo: { select: { direccionSnapshot: true } },
              pagos: {
                where: { estado: 'CONFIRMADO' },
                select: { metodo: true },
              },
            },
            orderBy: { fechaFinalizacion: 'desc' },
            take: 200,
          });
          return ventasListado.map((v) => {
            const snap =
              (v.deliveryInfo?.direccionSnapshot as Record<string, unknown> | null) ?? {};
            const nombreSnap =
              typeof snap.clienteNombre === 'string' ? snap.clienteNombre.trim() : '';
            const nombreCliente = v.cliente
              ? `${v.cliente.nombre}${v.cliente.apellido ? ' ' + v.cliente.apellido : ''}`.trim()
              : '';
            return {
              id: v.id,
              numero: v.numero,
              numeroOrdenTurno: v.numeroOrdenTurno,
              canal: v.canal,
              modalidad: v.modalidad,
              fecha: v.fechaFinalizacion,
              cliente: nombreSnap || nombreCliente || null,
              total: v.total.toString(),
              descuento: v.descuentoTotal.toString(),
              metodos: v.pagos.map((p) => p.metodo),
            };
          });
        })(),
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   ESTADISTICAS consolidadas
  // ──────────────────────────────────────────────────────────────────────

  fastify.get(
    '/admin/estadisticas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          periodo: z
            .enum(['hoy', 'semana', 'mes', 'trimestre', 'anio', 'custom'])
            .default('mes'),
          desde: z.string().optional(),
          hasta: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const q = req.query as {
        periodo: 'hoy' | 'semana' | 'mes' | 'trimestre' | 'anio' | 'custom';
        desde?: string;
        hasta?: string;
      };
      let ahora = new Date();
      const desde = new Date(ahora);
      if (q.periodo === 'custom') {
        if (!q.desde || !q.hasta) {
          return reply
            .code(400)
            .send({ error: 'Para periodo=custom, desde y hasta son requeridos (YYYY-MM-DD)' });
        }
        const [yd, md, dd] = q.desde.split('-').map(Number);
        const [yh, mh, dh] = q.hasta.split('-').map(Number);
        desde.setFullYear(yd!, (md ?? 1) - 1, dd ?? 1);
        desde.setHours(0, 0, 0, 0);
        ahora = new Date();
        ahora.setFullYear(yh!, (mh ?? 1) - 1, dh ?? 1);
        ahora.setHours(23, 59, 59, 999);
        if (desde.getTime() > ahora.getTime()) {
          return reply.code(400).send({ error: '"desde" no puede ser mayor a "hasta"' });
        }
      } else {
        switch (q.periodo) {
          case 'hoy':
            desde.setHours(0, 0, 0, 0);
            break;
          case 'semana':
            desde.setDate(desde.getDate() - 7);
            break;
          case 'mes':
            desde.setMonth(desde.getMonth() - 1);
            break;
          case 'trimestre':
            desde.setMonth(desde.getMonth() - 3);
            break;
          case 'anio':
            desde.setFullYear(desde.getFullYear() - 1);
            break;
        }
      }

      // Período anterior para comparativos
      const desdeAnterior = new Date(desde);
      const duracionMs = ahora.getTime() - desde.getTime();
      desdeAnterior.setTime(desdeAnterior.getTime() - duracionMs);

      // Ventas finalizadas del período
      const ventasActuales = await prisma.venta.aggregate({
        _sum: { total: true },
        _count: { _all: true },
        _avg: { total: true },
        where: {
          estado: EstadoVenta.FINALIZADA,
          fechaFinalizacion: { gte: desde, lte: ahora },
        },
      });
      const ventasAnterior = await prisma.venta.aggregate({
        _sum: { total: true },
        _count: { _all: true },
        where: {
          estado: EstadoVenta.FINALIZADA,
          fechaFinalizacion: { gte: desdeAnterior, lt: desde },
        },
      });

      // Anuladas
      const anuladas = await prisma.venta.aggregate({
        _sum: { total: true },
        _count: { _all: true },
        where: {
          estado: EstadoVenta.ANULADA,
          fechaAnulacion: { gte: desde, lte: ahora },
        },
      });

      // Ventas por canal
      const porCanal = await prisma.venta.groupBy({
        by: ['canal'],
        _sum: { total: true },
        _count: { _all: true },
        where: {
          estado: EstadoVenta.FINALIZADA,
          fechaFinalizacion: { gte: desde, lte: ahora },
        },
      });

      // Egresos por categoría
      const egresosPorCat = await prisma.movimiento.groupBy({
        by: ['categoriaId'],
        _sum: { monto: true },
        _count: { _all: true },
        where: {
          tipo: 'EGRESO',
          estado: EstadoMovimiento.CONFIRMADO,
          fechaComputo: { gte: desde, lte: ahora },
        },
      });
      const cats = await prisma.categoriaMovimiento.findMany({
        where: { id: { in: egresosPorCat.map((e) => e.categoriaId) } },
      });
      const catById = new Map(cats.map((c) => [c.id, c]));

      // Top 10 productos INDIVIDUALES (excluye los items que son parte de un combo).
      // Así no contamina las estadísticas: si un Ravioles se vendió como parte
      // de "Promo 2 Planchas + Salsa", no suma en el top de Ravioles individuales.
      const topProductos = await prisma.itemVenta.groupBy({
        by: ['productoId'],
        _sum: { cantidad: true, totalLinea: true },
        _count: { _all: true },
        where: {
          venta: {
            estado: EstadoVenta.FINALIZADA,
            fechaFinalizacion: { gte: desde, lte: ahora },
          },
          parteDeComboId: null,
        },
        orderBy: { _sum: { totalLinea: 'desc' } },
        take: 10,
      });
      const productos = await prisma.producto.findMany({
        where: { id: { in: topProductos.map((t) => t.productoId) } },
        select: { id: true, nombre: true, tipoProducto: { select: { categoria: { select: { nombre: true } } } } },
      });
      const prodById = new Map(productos.map((p) => [p.id, p]));

      // Combos / Promos vendidos en el período — fila propia, separada de productos individuales.
      const combosVendidos = await prisma.itemVenta.groupBy({
        by: ['parteDeComboId'],
        _sum: { totalLinea: true },
        _count: { _all: true },
        where: {
          venta: {
            estado: EstadoVenta.FINALIZADA,
            fechaFinalizacion: { gte: desde, lte: ahora },
          },
          parteDeComboId: { not: null },
        },
        orderBy: { _sum: { totalLinea: 'desc' } },
      });
      const combosInfo =
        combosVendidos.length > 0
          ? await prisma.combo.findMany({
              where: {
                id: {
                  in: combosVendidos
                    .map((c) => c.parteDeComboId)
                    .filter((x): x is string => !!x),
                },
              },
              select: { id: true, nombre: true, precioCombo: true },
            })
          : [];
      const comboById = new Map(combosInfo.map((c) => [c.id, c]));
      // Cantidad de "instancias" de cada combo: número de combos únicos vendidos.
      // Lo aproximamos contando parteDeComboInstancia distintos por combo.
      const instanciasPorCombo = combosVendidos.length
        ? await prisma.itemVenta.groupBy({
            by: ['parteDeComboId', 'parteDeComboInstancia'],
            where: {
              venta: {
                estado: EstadoVenta.FINALIZADA,
                fechaFinalizacion: { gte: desde, lte: ahora },
              },
              parteDeComboId: { not: null },
              parteDeComboInstancia: { not: null },
            },
          })
        : [];
      const cantInstanciasPorCombo = new Map<string, number>();
      for (const r of instanciasPorCombo) {
        if (r.parteDeComboId) {
          cantInstanciasPorCombo.set(
            r.parteDeComboId,
            (cantInstanciasPorCombo.get(r.parteDeComboId) ?? 0) + 1,
          );
        }
      }

      // Ventas por día (últimos 14 días, para el gráfico)
      const ventasPorDia = await prisma.$queryRaw<
        Array<{ dia: Date; cantidad: bigint; total: number }>
      >`
        SELECT
          DATE(fecha_finalizacion) AS dia,
          COUNT(*)::bigint AS cantidad,
          SUM(total)::float AS total
        FROM ventas
        WHERE estado = 'FINALIZADA'
          AND fecha_finalizacion >= ${desde}
          AND fecha_finalizacion <= ${ahora}
        GROUP BY dia
        ORDER BY dia ASC
      `;

      // Top clientes por monto comprado en el período
      const topClientes = await prisma.venta.groupBy({
        by: ['clienteId'],
        _sum: { total: true },
        _count: { _all: true },
        where: {
          estado: EstadoVenta.FINALIZADA,
          fechaFinalizacion: { gte: desde, lte: ahora },
          clienteId: { not: null },
        },
        orderBy: { _sum: { total: 'desc' } },
        take: 5,
      });
      const clientes = await prisma.cliente.findMany({
        where: {
          id: { in: topClientes.map((t) => t.clienteId).filter(Boolean) as string[] },
        },
        select: { id: true, nombre: true, apellido: true, tipo: true },
      });
      const cliById = new Map(clientes.map((c) => [c.id, c]));

      const ventasTotal = Number(ventasActuales._sum.total ?? 0);
      const ventasAnt = Number(ventasAnterior._sum.total ?? 0);
      const variacionVentas =
        ventasAnt > 0 ? ((ventasTotal - ventasAnt) / ventasAnt) * 100 : null;

      const totalEgresos = egresosPorCat.reduce(
        (acc, e) => acc + Number(e._sum.monto ?? 0),
        0,
      );

      // Resultado neto = ventas − egresos
      const resultadoNeto = ventasTotal - totalEgresos;

      return {
        periodo: q.periodo,
        desde,
        hasta: ahora,
        kpis: {
          ventasTotal: ventasTotal.toFixed(2),
          ventasCantidad: ventasActuales._count._all,
          ticketPromedio: Number(ventasActuales._avg.total ?? 0).toFixed(2),
          variacionVentasPct: variacionVentas !== null ? Number(variacionVentas.toFixed(1)) : null,
          anuladasMonto: Number(anuladas._sum.total ?? 0).toFixed(2),
          anuladasCantidad: anuladas._count._all,
          egresosTotal: totalEgresos.toFixed(2),
          resultadoNeto: resultadoNeto.toFixed(2),
        },
        ventasPorCanal: porCanal.map((p) => ({
          canal: p.canal,
          monto: Number(p._sum.total ?? 0).toFixed(2),
          cantidad: p._count._all,
          pct:
            ventasTotal > 0
              ? Number(((Number(p._sum.total ?? 0) / ventasTotal) * 100).toFixed(1))
              : 0,
        })),
        egresosPorCategoria: egresosPorCat
          .map((e) => ({
            categoria: catById.get(e.categoriaId)?.nombre ?? 'Sin categoría',
            esOperativa: catById.get(e.categoriaId)?.esOperativa ?? true,
            monto: Number(e._sum.monto ?? 0).toFixed(2),
            cantidad: e._count._all,
          }))
          .sort((a, b) => Number(b.monto) - Number(a.monto)),
        topProductos: topProductos.map((t) => {
          const p = prodById.get(t.productoId);
          return {
            productoId: t.productoId,
            nombre: p?.nombre ?? '?',
            categoria: p?.tipoProducto.categoria.nombre ?? '?',
            cantidad: Number(t._sum.cantidad ?? 0).toFixed(2),
            monto: Number(t._sum.totalLinea ?? 0).toFixed(2),
            ocurrencias: t._count._all,
          };
        }),
        // Combos / promos vendidos como entidad propia
        combosVendidos: combosVendidos
          .filter((c): c is typeof c & { parteDeComboId: string } => !!c.parteDeComboId)
          .map((c) => {
            const info = comboById.get(c.parteDeComboId);
            const instancias = cantInstanciasPorCombo.get(c.parteDeComboId) ?? c._count._all;
            return {
              comboId: c.parteDeComboId,
              nombre: info?.nombre ?? '?',
              instancias,
              monto: Number(c._sum.totalLinea ?? 0).toFixed(2),
              precioCombo: info?.precioCombo.toString() ?? '0',
            };
          })
          .sort((a, b) => Number(b.monto) - Number(a.monto)),
        ventasPorDia: ventasPorDia.map((v) => ({
          dia: v.dia,
          cantidad: Number(v.cantidad),
          total: Number(v.total ?? 0).toFixed(2),
        })),
        topClientes: topClientes.map((t) => {
          const c = t.clienteId ? cliById.get(t.clienteId) : null;
          return {
            clienteId: t.clienteId,
            nombre: c ? `${c.nombre}${c.apellido ? ` ${c.apellido}` : ''}` : 'Sin cliente',
            tipo: c?.tipo ?? null,
            monto: Number(t._sum.total ?? 0).toFixed(2),
            cantidad: t._count._all,
          };
        }),
      };
    },
  );

  // GET /admin/productos/:id/historial-precios
  fastify.get(
    '/admin/productos/:id/historial-precios',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const params = req.params as { id: string };
      const historial = await prisma.historialPrecio.findMany({
        where: { productoId: params.id },
        orderBy: { fechaCambio: 'desc' },
        take: 50,
        include: { lista: true, producto: { select: { nombre: true } } },
      });
      return { historial };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   PRECIOS — vistas globales (lista + historial + aprobaciones excel)
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/precios/lista — productos enfocados en precio, con último cambio.
  fastify.get(
    '/admin/precios/lista',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          q: z.string().optional(),
          categoriaId: z.string().uuid().optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query as { q?: string; categoriaId?: string };
      const productos = await prisma.producto.findMany({
        where: {
          activo: true,
          ...(q.q && { nombre: { contains: q.q, mode: 'insensitive' as const } }),
          ...(q.categoriaId && { tipoProducto: { categoriaId: q.categoriaId } }),
        },
        include: {
          tipoProducto: { include: { categoria: true } },
          historialPrecios: {
            orderBy: { fechaCambio: 'desc' },
            take: 1,
          },
        },
        orderBy: [
          { tipoProducto: { categoria: { orden: 'asc' } } },
          { tipoProducto: { orden: 'asc' } },
          { codigo: 'asc' },
        ],
      });
      return {
        productos: productos.map((p) => {
          const ult = p.historialPrecios[0];
          const deltaPct = ult
            ? ((Number(p.precioBase) - Number(ult.precioAnterior)) /
                Number(ult.precioAnterior)) *
              100
            : null;
          return {
            id: p.id,
            codigo: p.codigo,
            nombre: p.nombre,
            marca: p.marca,
            presentacion: p.presentacion,
            precioBase: p.precioBase.toString(),
            unidadPrecio: p.unidadPrecio,
            formaVenta: p.formaVenta,
            categoria: p.tipoProducto.categoria.nombre,
            tipoNombre: p.tipoProducto.nombre,
            ultimoCambio: ult
              ? {
                  fecha: ult.fechaCambio,
                  precioAnterior: ult.precioAnterior.toString(),
                  deltaPct: deltaPct !== null ? Number(deltaPct.toFixed(1)) : null,
                  motivo: ult.motivo,
                }
              : null,
          };
        }),
      };
    },
  );

  // GET /admin/precios/historial — feed global de cambios de precio recientes.
  fastify.get(
    '/admin/precios/historial',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query as { limit: number };
      const cambios = await prisma.historialPrecio.findMany({
        orderBy: { fechaCambio: 'desc' },
        take: q.limit,
        include: {
          producto: {
            select: {
              id: true,
              nombre: true,
              codigo: true,
              tipoProducto: { select: { categoria: { select: { nombre: true } } } },
            },
          },
          lista: { select: { nombre: true } },
        },
      });

      // Resolver nombres de usuario por separado (no hay relación Prisma definida).
      const usuarioIds = Array.from(
        new Set(cambios.map((c) => c.usuarioId).filter((id): id is string => !!id)),
      );
      const usuarios = usuarioIds.length
        ? await prisma.usuario.findMany({
            where: { id: { in: usuarioIds } },
            select: { id: true, nombre: true },
          })
        : [];
      const usuarioPorId = new Map(usuarios.map((u) => [u.id, u.nombre]));

      return {
        cambios: cambios.map((c) => {
          const anterior = Number(c.precioAnterior);
          const nuevo = Number(c.precioNuevo);
          const deltaPct = anterior > 0 ? ((nuevo - anterior) / anterior) * 100 : null;
          return {
            id: c.id,
            fecha: c.fechaCambio,
            productoId: c.producto.id,
            productoNombre: c.producto.nombre,
            productoCodigo: c.producto.codigo,
            categoria: c.producto.tipoProducto.categoria.nombre,
            precioAnterior: c.precioAnterior.toString(),
            precioNuevo: c.precioNuevo.toString(),
            deltaPct: deltaPct !== null ? Number(deltaPct.toFixed(1)) : null,
            motivo: c.motivo,
            usuario: c.usuarioId ? usuarioPorId.get(c.usuarioId) ?? null : null,
            lista: c.lista?.nombre ?? null,
          };
        }),
      };
    },
  );

  // GET /admin/precios/aprobaciones — aprobaciones de Excel (todas las recientes).
  fastify.get(
    '/admin/precios/aprobaciones',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const aprobaciones = await prisma.aprobacionExcel.findMany({
        orderBy: { detectadoAt: 'desc' },
        take: 25,
        include: { aprobadaPor: { select: { nombre: true } } },
      });
      return {
        aprobaciones: aprobaciones.map((a) => ({
          id: a.id,
          fuente: a.fuente,
          archivoNombre: a.archivoNombre,
          modificadoEn: a.modificadoEn,
          modificadoPor: a.modificadoPor,
          detectadoAt: a.detectadoAt,
          cambiosTotal: a.cambiosTotal,
          cambiosAplicables: a.cambiosAplicables,
          cambiosSospechosos: a.cambiosSospechosos,
          cambiosErrores: a.cambiosErrores,
          estado: a.estado,
          aprobadaAt: a.aprobadaAt,
          aprobadaPor: a.aprobadaPor?.nombre ?? null,
        })),
      };
    },
  );

  // GET /admin/precios/aprobaciones/:id — detalle con el diff completo.
  fastify.get(
    '/admin/precios/aprobaciones/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const a = await prisma.aprobacionExcel.findUnique({
        where: { id: params.id },
        include: { aprobadaPor: { select: { nombre: true } } },
      });
      if (!a) return reply.code(404).send({ error: 'Aprobación no encontrada' });
      return {
        id: a.id,
        fuente: a.fuente,
        archivoNombre: a.archivoNombre,
        modificadoEn: a.modificadoEn,
        modificadoPor: a.modificadoPor,
        detectadoAt: a.detectadoAt,
        cambiosTotal: a.cambiosTotal,
        cambiosAplicables: a.cambiosAplicables,
        cambiosSospechosos: a.cambiosSospechosos,
        cambiosErrores: a.cambiosErrores,
        estado: a.estado,
        aprobadaAt: a.aprobadaAt,
        aprobadaPor: a.aprobadaPor?.nombre ?? null,
        observaciones: a.observaciones,
        diff: a.diff,
      };
    },
  );

  // POST /admin/precios/buscar-cambios — corre la detección sobre el Excel local.
  fastify.post(
    '/admin/precios/buscar-cambios',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          fuente: z.enum(['LISTA_PRECIOS', 'PROVEEDORES', 'AMBAS']).default('AMBAS'),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as { fuente: 'LISTA_PRECIOS' | 'PROVEEDORES' | 'AMBAS' };
      const resultados: Array<{
        fuente: string;
        aprobacionId: string;
        cambiosAplicables: number;
        sospechosos: number;
        errores: number;
      }> = [];
      const errores: Array<{ fuente: string; mensaje: string }> = [];

      const corridas =
        body.fuente === 'AMBAS'
          ? (['LISTA_PRECIOS', 'PROVEEDORES'] as const)
          : ([body.fuente] as const);

      for (const f of corridas) {
        try {
          const detector =
            f === 'LISTA_PRECIOS' ? detectarCambiosListaPrecios : detectarCambiosProveedores;
          const { aprobacion, diff } = await detector({
            modificadoPor: req.usuario!.nombre,
          });
          resultados.push({
            fuente: f,
            aprobacionId: aprobacion.id,
            cambiosAplicables: diff.resumen.cambiosAplicables,
            sospechosos: diff.resumen.sospechosos,
            errores: diff.resumen.errores,
          });
        } catch (e) {
          errores.push({
            fuente: f,
            mensaje: e instanceof Error ? e.message : 'Error inesperado',
          });
        }
      }

      if (resultados.length === 0 && errores.length > 0) {
        return reply.code(500).send({ resultados, errores });
      }
      return { resultados, errores };
    },
  );

  // POST /admin/precios/aprobaciones/:id/aplicar — aplicar cambios (parcial o total).
  fastify.post(
    '/admin/precios/aprobaciones/:id/aplicar',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          // null o array vacío → aplicar todos los cambios
          cambioIds: z.array(z.string().uuid()).nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { cambioIds?: string[] | null };
      try {
        const r = await aplicarAprobacion({
          aprobacionId: params.id,
          cambioIds: body.cambioIds && body.cambioIds.length > 0 ? body.cambioIds : null,
          usuarioId: req.usuario!.id,
        });
        return r;
      } catch (e) {
        return reply
          .code(400)
          .send({ error: e instanceof Error ? e.message : 'Error al aplicar' });
      }
    },
  );

  // POST /admin/precios/aprobaciones/:id/rechazar
  fastify.post(
    '/admin/precios/aprobaciones/:id/rechazar',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ observaciones: z.string().max(500).optional() }),
      },
    },
    async (req) => {
      const params = req.params as { id: string };
      const body = req.body as { observaciones?: string };
      await rechazarAprobacion({
        aprobacionId: params.id,
        usuarioId: req.usuario!.id,
        observaciones: body.observaciones,
      });
      return { ok: true };
    },
  );

  // POST /admin/precios/aprobaciones/:id/posponer
  fastify.post(
    '/admin/precios/aprobaciones/:id/posponer',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const params = req.params as { id: string };
      await posponerAprobacion({ aprobacionId: params.id });
      return { ok: true };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   TIPOS DE PRODUCTO (para reasignar categoría desde el editor)
  // ──────────────────────────────────────────────────────────────────────
  fastify.get(
    '/admin/tipos-producto',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const tipos = await prisma.tipoProducto.findMany({
        where: { activo: true },
        include: { categoria: { select: { id: true, nombre: true, icono: true } } },
        orderBy: [{ categoria: { orden: 'asc' } }, { nombre: 'asc' }],
      });
      return { tipos };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   CREACIÓN DE CATEGORÍAS, TIPOS Y PRODUCTOS
  //   Para el flujo "Añadir" del panel admin: la encargada arma la jerarquía.
  // ──────────────────────────────────────────────────────────────────────

  // POST /admin/categorias — crear nueva categoría
  fastify.post(
    '/admin/categorias',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(80),
          icono: z.string().max(8).nullable().optional(),
          color: z.string().max(20).nullable().optional(),
          orden: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as { nombre: string; icono?: string | null; color?: string | null; orden?: number };
      const yaExiste = await prisma.categoria.findFirst({ where: { nombre: body.nombre } });
      if (yaExiste) return reply.code(409).send({ error: 'Ya existe una categoría con ese nombre' });
      // orden: si no viene, va al final
      let orden = body.orden;
      if (orden === undefined) {
        const max = await prisma.categoria.aggregate({ _max: { orden: true } });
        orden = (max._max.orden ?? 0) + 1;
      }
      const cat = await prisma.categoria.create({
        data: {
          nombre: body.nombre,
          icono: body.icono ?? null,
          color: body.color ?? null,
          orden,
        },
      });
      await recordAudit({
        tabla: 'categorias',
        registroId: cat.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: cat.nombre, icono: cat.icono, orden: cat.orden },
      });
      return { categoria: cat };
    },
  );

  // PATCH /admin/categorias/:id — editar nombre/icono/color/orden
  fastify.patch(
    '/admin/categorias/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(80).optional(),
          icono: z.string().max(8).nullable().optional(),
          color: z.string().max(20).nullable().optional(),
          orden: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.categoria.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Categoría no encontrada' });
      const cat = await prisma.categoria.update({
        where: { id: params.id },
        data: req.body as Record<string, unknown>,
      });
      await recordAudit({
        tabla: 'categorias',
        registroId: cat.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre },
        valorNuevo: { nombre: cat.nombre },
      });
      return { categoria: cat };
    },
  );

  // DELETE /admin/categorias/:id — eliminar categoría de producto.
  // Si tiene tipos/productos vinculados, hard delete viola FK → soft-delete
  // (activa=false). Si está vacía, hard delete real.
  fastify.delete(
    '/admin/categorias/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const cat = await prisma.categoria.findUnique({
        where: { id: params.id },
        include: { _count: { select: { tipos: true } } },
      });
      if (!cat) return reply.code(404).send({ error: 'Categoría no encontrada' });

      let modo: 'hard' | 'soft';
      if (cat._count.tipos === 0) {
        await prisma.categoria.delete({ where: { id: params.id } });
        modo = 'hard';
      } else {
        await prisma.categoria.update({ where: { id: params.id }, data: { activa: false } });
        modo = 'soft';
      }
      await recordAudit({
        tabla: 'categorias',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: cat.nombre },
        contexto: { modo },
      });
      return { ok: true, modo };
    },
  );

  // POST /admin/tipos-producto — crear nuevo tipo (subcategoría)
  fastify.post(
    '/admin/tipos-producto',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(120),
          categoriaId: z.string().uuid(),
          cocinaInterviene: z.boolean().default(false),
          descripcion: z.string().nullable().optional(),
          orden: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        categoriaId: string;
        cocinaInterviene: boolean;
        descripcion?: string | null;
        orden?: number;
      };
      const cat = await prisma.categoria.findUnique({ where: { id: body.categoriaId } });
      if (!cat) return reply.code(404).send({ error: 'Categoría no existe' });
      const yaExiste = await prisma.tipoProducto.findFirst({
        where: { categoriaId: body.categoriaId, nombre: body.nombre },
      });
      if (yaExiste) return reply.code(409).send({ error: 'Ya hay un tipo con ese nombre en esa categoría' });
      let orden = body.orden;
      if (orden === undefined) {
        const max = await prisma.tipoProducto.aggregate({
          where: { categoriaId: body.categoriaId },
          _max: { orden: true },
        });
        orden = (max._max.orden ?? 0) + 1;
      }
      const tipo = await prisma.tipoProducto.create({
        data: {
          nombre: body.nombre,
          categoriaId: body.categoriaId,
          cocinaInterviene: body.cocinaInterviene,
          descripcion: body.descripcion ?? null,
          orden,
          // Creado vía el panel admin → es una sub-categoría real visible en el cajero
          esSubcategoria: true,
        },
      });
      await recordAudit({
        tabla: 'tipos_producto',
        registroId: tipo.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: tipo.nombre, categoriaId: tipo.categoriaId },
      });
      return { tipo };
    },
  );

  // POST /admin/productos — crear nuevo producto
  fastify.post(
    '/admin/productos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(160),
          // Fix 3b: subcategoría OPCIONAL. Si no viene tipoProductoId, se usa/crea
          // un tipo "General" en la categoría (por eso también aceptamos categoriaId).
          tipoProductoId: z.string().uuid().optional(),
          categoriaId: z.string().uuid().optional(),
          codigo: z.string().max(40).nullable().optional(),
          marca: z.string().max(80).nullable().optional(),
          presentacion: z.string().max(80).nullable().optional(),
          precioBase: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Precio inválido'),
          formaVenta: z.enum(['UNIDAD', 'GRAMO', 'PLANCHA', 'PORCION']).default('UNIDAD'),
          formaVentaLabel: z.string().max(40).nullable().optional(),
          unidadPrecio: z
            .enum(['POR_UNIDAD', 'POR_GRAMO', 'POR_KILO', 'POR_PORCION', 'POR_PLANCHA', 'POR_DOCENA'])
            .default('POR_UNIDAD'),
          unidadPrecioLabel: z.string().max(40).nullable().optional(),
          cantidadDefault: z.string().nullable().optional(),
          descripcion: z.string().nullable().optional(),
          // Fix 3a: casillero "Enviar a cocina" por-producto. null = hereda del tipo.
          cocinaIntervieneOverride: z.boolean().nullable().optional(),
          // Listas custom (mayoristas) a las que se agrega el producto. La
          // pública y las de canal lo incluyen siempre.
          listasCustom: z.array(z.string().uuid()).optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        tipoProductoId?: string;
        categoriaId?: string;
        codigo?: string | null;
        marca?: string | null;
        presentacion?: string | null;
        precioBase: string;
        formaVenta: 'UNIDAD' | 'GRAMO' | 'PLANCHA' | 'PORCION';
        formaVentaLabel?: string | null;
        unidadPrecio:
          | 'POR_UNIDAD'
          | 'POR_GRAMO'
          | 'POR_KILO'
          | 'POR_PORCION'
          | 'POR_PLANCHA'
          | 'POR_DOCENA';
        unidadPrecioLabel?: string | null;
        cantidadDefault?: string | null;
        descripcion?: string | null;
        cocinaIntervieneOverride?: boolean | null;
        listasCustom?: string[];
      };
      // Fix 3b: subcategoría opcional. Si no viene tipoProductoId, usamos (o
      // creamos) un tipo "General" en la categoría elegida — así el producto queda
      // bien colgado sin obligar a la encargada a crear una sub-categoría antes.
      let tipoProductoId: string;
      if (body.tipoProductoId) {
        tipoProductoId = body.tipoProductoId;
      } else {
        if (!body.categoriaId) {
          return reply
            .code(400)
            .send({ error: 'Elegí una sub-categoría, o al menos una categoría' });
        }
        const cat = await prisma.categoria.findUnique({ where: { id: body.categoriaId } });
        if (!cat) return reply.code(404).send({ error: 'Categoría no existe' });
        let general = await prisma.tipoProducto.findFirst({
          where: { categoriaId: body.categoriaId, nombre: 'General' },
        });
        if (!general) {
          general = await prisma.tipoProducto.create({
            data: {
              nombre: 'General',
              categoriaId: body.categoriaId,
              cocinaInterviene: false,
              esSubcategoria: true,
              orden: 999,
            },
          });
        }
        tipoProductoId = general.id;
      }
      const tipo = await prisma.tipoProducto.findUnique({ where: { id: tipoProductoId } });
      if (!tipo) return reply.code(404).send({ error: 'Tipo de producto no existe' });
      // Si viene código, verificar único
      if (body.codigo) {
        const yaCodigo = await prisma.producto.findFirst({ where: { codigo: body.codigo } });
        if (yaCodigo) return reply.code(409).send({ error: `Código ${body.codigo} ya está usado` });
      }
      const producto = await prisma.producto.create({
        data: {
          nombre: body.nombre,
          tipoProductoId,
          codigo: body.codigo ?? null,
          marca: body.marca ?? null,
          presentacion: body.presentacion ?? null,
          precioBase: body.precioBase,
          formaVenta: body.formaVenta,
          formaVentaLabel: body.formaVentaLabel ?? null,
          unidadPrecio: body.unidadPrecio,
          unidadPrecioLabel: body.unidadPrecioLabel ?? null,
          cantidadDefault: body.cantidadDefault ?? null,
          descripcion: body.descripcion ?? null,
          cocinaIntervieneOverride: body.cocinaIntervieneOverride ?? null,
          activo: true,
        },
      });
      if (body.listasCustom && body.listasCustom.length > 0) {
        await syncListasCustomDeProducto(producto.id, body.precioBase, body.listasCustom);
      }
      await recordAudit({
        tabla: 'productos',
        registroId: producto.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: producto.nombre, codigo: producto.codigo, tipoProductoId: producto.tipoProductoId },
      });
      return { producto };
    },
  );

  // GET /admin/categorias — lista para el modal de creación (incluye orden e ícono)
  fastify.get(
    '/admin/categorias',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const categorias = await prisma.categoria.findMany({
        orderBy: { orden: 'asc' },
        include: { _count: { select: { tipos: true } } },
      });
      return { categorias };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   SABORES — opciones del primer grupo modificador del producto
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/productos/:id/sabores
  fastify.get(
    '/admin/productos/:id/sabores',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const producto = await prisma.producto.findUnique({
        where: { id: params.id },
        include: {
          tipoProducto: {
            include: {
              modificadores: {
                include: {
                  grupoModificador: {
                    include: { opciones: { orderBy: { orden: 'asc' } } },
                  },
                },
              },
            },
          },
          modificadores: {
            include: {
              grupoModificador: {
                include: { opciones: { orderBy: { orden: 'asc' } } },
              },
            },
          },
        },
      });
      if (!producto) return reply.code(404).send({ error: 'Producto no encontrado' });
      const todos = [...producto.modificadores, ...producto.tipoProducto.modificadores];
      const grupo = todos[0]?.grupoModificador;
      return {
        grupo: grupo
          ? {
              id: grupo.id,
              nombre: grupo.nombre,
              tipoSeleccion: grupo.tipoSeleccion,
              obligatorio: grupo.obligatorio,
            }
          : null,
        opciones: grupo
          ? grupo.opciones.map((o) => ({
              id: o.id,
              nombre: o.nombre,
              deltaPrecio: o.deltaPrecio.toString(),
              activa: o.activa,
              orden: o.orden,
            }))
          : [],
      };
    },
  );

  // POST /admin/productos/:id/sabores — crear opción de sabor (crea grupo si no existe)
  fastify.post(
    '/admin/productos/:id/sabores',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(120),
          deltaPrecio: z.string().regex(/^-?\d+(\.\d{1,2})?$/).default('0'),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { nombre: string; deltaPrecio: string };
      const producto = await prisma.producto.findUnique({
        where: { id: params.id },
        include: {
          tipoProducto: { include: { modificadores: { include: { grupoModificador: true } } } },
          modificadores: { include: { grupoModificador: true } },
        },
      });
      if (!producto) return reply.code(404).send({ error: 'Producto no encontrado' });

      const todos = [...producto.modificadores, ...producto.tipoProducto.modificadores];
      let grupoId = todos[0]?.grupoModificadorId;
      if (!grupoId) {
        // No existe grupo → lo creamos asociado al tipoProducto
        const grupo = await prisma.grupoModificador.create({
          data: {
            nombre: `Sabor — ${producto.nombre}`,
            tipoSeleccion: 'UNICA',
            obligatorio: true,
            minOpciones: 1,
            maxOpciones: 1,
          },
        });
        await prisma.modificadorAplicable.create({
          data: { grupoModificadorId: grupo.id, tipoProductoId: producto.tipoProductoId },
        });
        grupoId = grupo.id;
      }

      // Determinar orden
      const ultima = await prisma.opcionModificador.findFirst({
        where: { grupoId },
        orderBy: { orden: 'desc' },
      });
      const opcion = await prisma.opcionModificador.create({
        data: {
          grupoId,
          nombre: body.nombre,
          deltaPrecio: body.deltaPrecio,
          orden: (ultima?.orden ?? -1) + 1,
        },
      });
      return reply.code(201).send({ opcion });
    },
  );

  // PATCH /admin/sabores/:opcionId — renombrar / cambiar delta / activar
  fastify.patch(
    '/admin/sabores/:opcionId',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ opcionId: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(120).optional(),
          deltaPrecio: z.string().regex(/^-?\d+(\.\d{1,2})?$/).optional(),
          activa: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { opcionId: string };
      const body = req.body as {
        nombre?: string;
        deltaPrecio?: string;
        activa?: boolean;
      };
      const updated = await prisma.opcionModificador.update({
        where: { id: params.opcionId },
        data: body,
      });
      return { opcion: updated };
    },
  );

  // DELETE /admin/sabores/:opcionId — borrar (o desactivar si tiene historial)
  fastify.delete(
    '/admin/sabores/:opcionId',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ opcionId: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { opcionId: string };
      try {
        await prisma.opcionModificador.delete({ where: { id: params.opcionId } });
        return { ok: true, deleted: true };
      } catch {
        // Si falla (FK con items_venta), desactivar
        await prisma.opcionModificador.update({
          where: { id: params.opcionId },
          data: { activa: false },
        });
        return { ok: true, deleted: false, deactivated: true };
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   MODIFICADORES (grupos genéricos: salsas, agregados, etc.)
  //
  //   Fix 3d: la encargada puede CREAR grupos de modificadores con sus opciones
  //   (ej. "Salsa" → Fileto / Bolognesa / Mixta / Rosa) y APLICARLOS a cualquier
  //   producto, además de los sabores clásicos. El cajero ya renderiza todos los
  //   grupos aplicables del producto (los aplana en el modal de modificadores).
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/modificadores/grupos — todos los grupos con opciones + dónde se usan.
  fastify.get(
    '/admin/modificadores/grupos',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const grupos = await prisma.grupoModificador.findMany({
        include: {
          opciones: { orderBy: { orden: 'asc' } },
          aplicables: {
            include: {
              tipoProducto: { select: { id: true, nombre: true } },
              producto: { select: { id: true, nombre: true } },
            },
          },
        },
        orderBy: { nombre: 'asc' },
      });
      return {
        grupos: grupos.map((g) => ({
          id: g.id,
          nombre: g.nombre,
          tipoSeleccion: g.tipoSeleccion,
          obligatorio: g.obligatorio,
          opciones: g.opciones.map((o) => ({
            id: o.id,
            nombre: o.nombre,
            deltaPrecio: o.deltaPrecio.toString(),
            activa: o.activa,
          })),
          usadoEn: g.aplicables.map((a) => ({
            aplicableId: a.id,
            tipo: a.tipoProducto ? ('TIPO' as const) : ('PRODUCTO' as const),
            nombre: a.tipoProducto?.nombre ?? a.producto?.nombre ?? '—',
          })),
        })),
      };
    },
  );

  // POST /admin/modificadores/grupos — crear grupo nuevo con sus opciones.
  fastify.post(
    '/admin/modificadores/grupos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(80),
          tipoSeleccion: z.enum(['UNICA', 'MULTIPLE']).default('UNICA'),
          obligatorio: z.boolean().default(false),
          opciones: z
            .array(
              z.object({
                nombre: z.string().min(1).max(120),
                deltaPrecio: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
              }),
            )
            .min(1, 'El grupo necesita al menos una opción'),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        tipoSeleccion: 'UNICA' | 'MULTIPLE';
        obligatorio: boolean;
        opciones: Array<{ nombre: string; deltaPrecio: string }>;
      };
      const yaExiste = await prisma.grupoModificador.findFirst({
        where: { nombre: body.nombre },
      });
      if (yaExiste) {
        return reply.code(409).send({ error: `Ya existe un grupo llamado "${body.nombre}"` });
      }
      const grupo = await prisma.grupoModificador.create({
        data: {
          nombre: body.nombre,
          tipoSeleccion: body.tipoSeleccion,
          obligatorio: body.obligatorio,
          minOpciones: body.obligatorio ? 1 : 0,
          maxOpciones: body.tipoSeleccion === 'UNICA' ? 1 : body.opciones.length,
          opciones: {
            create: body.opciones.map((o, idx) => ({
              nombre: o.nombre,
              deltaPrecio: o.deltaPrecio,
              orden: idx,
            })),
          },
        },
        include: { opciones: { orderBy: { orden: 'asc' } } },
      });
      await recordAudit({
        tabla: 'grupos_modificador',
        registroId: grupo.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: grupo.nombre, opciones: body.opciones.map((o) => o.nombre) },
      });
      return reply.code(201).send({ grupo });
    },
  );

  // GET /admin/productos/:id/modificadores — grupos aplicados a este producto
  // (directos del producto + heredados de su tipo/sub-categoría).
  fastify.get(
    '/admin/productos/:id/modificadores',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const producto = await prisma.producto.findUnique({
        where: { id: params.id },
        include: {
          modificadores: {
            include: {
              grupoModificador: { include: { opciones: { orderBy: { orden: 'asc' } } } },
            },
          },
          tipoProducto: {
            include: {
              modificadores: {
                include: {
                  grupoModificador: { include: { opciones: { orderBy: { orden: 'asc' } } } },
                },
              },
            },
          },
        },
      });
      if (!producto) return reply.code(404).send({ error: 'Producto no encontrado' });
      const mapear = (
        a: (typeof producto.modificadores)[number],
        origen: 'PRODUCTO' | 'TIPO',
      ) => ({
        aplicableId: a.id,
        origen,
        grupo: {
          id: a.grupoModificador.id,
          nombre: a.grupoModificador.nombre,
          tipoSeleccion: a.grupoModificador.tipoSeleccion,
          obligatorio: a.grupoModificador.obligatorio,
          opciones: a.grupoModificador.opciones.map((o) => ({
            id: o.id,
            nombre: o.nombre,
            deltaPrecio: o.deltaPrecio.toString(),
            activa: o.activa,
          })),
        },
      });
      return {
        aplicados: [
          ...producto.modificadores.map((a) => mapear(a, 'PRODUCTO')),
          ...producto.tipoProducto.modificadores.map((a) => mapear(a, 'TIPO')),
        ],
      };
    },
  );

  // POST /admin/productos/:id/modificadores — aplicar un grupo existente al producto.
  fastify.post(
    '/admin/productos/:id/modificadores',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ grupoId: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { grupoId: string };
      const producto = await prisma.producto.findUnique({
        where: { id: params.id },
        include: { tipoProducto: { include: { modificadores: true } }, modificadores: true },
      });
      if (!producto) return reply.code(404).send({ error: 'Producto no encontrado' });
      const grupo = await prisma.grupoModificador.findUnique({ where: { id: body.grupoId } });
      if (!grupo) return reply.code(404).send({ error: 'Grupo no encontrado' });
      const yaDirecto = producto.modificadores.some((a) => a.grupoModificadorId === body.grupoId);
      const yaHeredado = producto.tipoProducto.modificadores.some(
        (a) => a.grupoModificadorId === body.grupoId,
      );
      if (yaDirecto || yaHeredado) {
        return reply.code(409).send({
          error: yaHeredado
            ? 'Ese grupo ya aplica por la sub-categoría del producto'
            : 'Ese grupo ya está aplicado a este producto',
        });
      }
      const aplicable = await prisma.modificadorAplicable.create({
        data: { grupoModificadorId: body.grupoId, productoId: params.id },
      });
      await recordAudit({
        tabla: 'modificadores_aplicables',
        registroId: aplicable.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { grupo: grupo.nombre, producto: producto.nombre },
      });
      return reply.code(201).send({ aplicable });
    },
  );

  // DELETE /admin/modificadores/aplicables/:id — quitar un grupo de un producto.
  // Solo aplicaciones DIRECTAS al producto: las heredadas del tipo se quitan
  // desde el tipo (afectan a todos sus productos — no lo hacemos silencioso).
  fastify.delete(
    '/admin/modificadores/aplicables/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const aplicable = await prisma.modificadorAplicable.findUnique({
        where: { id: params.id },
        include: {
          grupoModificador: { select: { nombre: true } },
          producto: { select: { nombre: true } },
        },
      });
      if (!aplicable) return reply.code(404).send({ error: 'Aplicación no encontrada' });
      if (!aplicable.productoId) {
        return reply.code(400).send({
          error:
            'Ese grupo aplica a la sub-categoría entera (no a este producto puntual). Quitalo desde la sub-categoría.',
        });
      }
      await prisma.modificadorAplicable.delete({ where: { id: params.id } });
      await recordAudit({
        tabla: 'modificadores_aplicables',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: {
          grupo: aplicable.grupoModificador.nombre,
          producto: aplicable.producto?.nombre ?? null,
        },
      });
      return { ok: true };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   COMBOS / PROMOS
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/combos
  fastify.get(
    '/admin/combos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          incluirInactivos: queryBool(false),
        }),
      },
    },
    async (req) => {
      const q = req.query as { incluirInactivos: boolean };
      const combos = await prisma.combo.findMany({
        where: q.incluirInactivos ? {} : { activo: true },
        include: {
          componentes: {
            include: {
              producto: { select: { id: true, nombre: true, codigo: true, precioBase: true } },
              opciones: {
                include: {
                  producto: { select: { id: true, nombre: true, codigo: true, precioBase: true } },
                },
              },
            },
            orderBy: { orden: 'asc' },
          },
        },
        orderBy: { nombre: 'asc' },
      });
      // Calcular precio "suelto" (suma de productos individuales) y descuento del combo
      const combosConDesc = combos.map((c) => {
        let precioSuelto = 0;
        for (const comp of c.componentes) {
          const cant = Number(comp.cantidad);
          if (comp.producto) {
            precioSuelto += cant * Number(comp.producto.precioBase);
          } else if (comp.opciones[0]) {
            // Si es por elección, asumimos el más barato
            const minPrecio = Math.min(
              ...comp.opciones.map((o) => Number(o.producto.precioBase)),
            );
            precioSuelto += cant * minPrecio;
          }
        }
        const descuento = precioSuelto - Number(c.precioCombo);
        return {
          ...c,
          precioSuelto: precioSuelto.toFixed(2),
          descuento: descuento.toFixed(2),
          descuentoPct: precioSuelto > 0 ? Number(((descuento / precioSuelto) * 100).toFixed(1)) : 0,
        };
      });
      return { combos: combosConDesc };
    },
  );

  // POST /admin/combos — crear nuevo combo
  fastify.post(
    '/admin/combos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(160),
          precioCombo: z.string().regex(/^\d+(\.\d{1,2})?$/),
          observaciones: z.string().max(500).optional(),
          componentes: z
            .array(
              z.object({
                productoId: z.string().uuid(),
                cantidad: z.string().regex(/^\d+(\.\d{1,3})?$/).default('1'),
                etiqueta: z.string().max(80).optional(),
              }),
            )
            .min(1),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        precioCombo: string;
        observaciones?: string;
        componentes: Array<{ productoId: string; cantidad: string; etiqueta?: string }>;
      };
      const combo = await prisma.combo.create({
        data: {
          nombre: body.nombre,
          precioCombo: body.precioCombo,
          observaciones: body.observaciones ?? null,
          componentes: {
            create: body.componentes.map((c, idx) => ({
              tipo: 'PRODUCTO_FIJO' as const,
              productoId: c.productoId,
              cantidad: c.cantidad,
              etiqueta: c.etiqueta ?? null,
              orden: idx,
            })),
          },
        },
      });
      await recordAudit({
        tabla: 'combos',
        registroId: combo.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: combo.nombre, precio: combo.precioCombo.toString() },
      });
      return reply.code(201).send({ combo });
    },
  );

  // PATCH /admin/combos/:id — editar combo (precio, nombre, activar/desactivar, componentes)
  fastify.patch(
    '/admin/combos/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(160).optional(),
          precioCombo: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          activo: z.boolean().optional(),
          observaciones: z.string().max(500).nullable().optional(),
          componentes: z
            .array(
              z.object({
                productoId: z.string().uuid(),
                cantidad: z.string().regex(/^\d+(\.\d{1,3})?$/).default('1'),
                etiqueta: z.string().max(80).optional(),
              }),
            )
            .optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as {
        nombre?: string;
        precioCombo?: string;
        activo?: boolean;
        observaciones?: string | null;
        componentes?: Array<{ productoId: string; cantidad: string; etiqueta?: string }>;
      };
      const combo = await prisma.$transaction(async (tx) => {
        const c = await tx.combo.update({
          where: { id: params.id },
          data: {
            ...(body.nombre !== undefined && { nombre: body.nombre }),
            ...(body.precioCombo !== undefined && { precioCombo: body.precioCombo }),
            ...(body.activo !== undefined && { activo: body.activo }),
            ...(body.observaciones !== undefined && { observaciones: body.observaciones }),
          },
        });
        if (body.componentes) {
          // Reemplazar componentes (borrar + crear)
          await tx.componenteCombo.deleteMany({ where: { comboId: params.id } });
          for (const [idx, comp] of body.componentes.entries()) {
            await tx.componenteCombo.create({
              data: {
                comboId: params.id,
                tipo: 'PRODUCTO_FIJO' as const,
                productoId: comp.productoId,
                cantidad: comp.cantidad,
                etiqueta: comp.etiqueta ?? null,
                orden: idx,
              },
            });
          }
        }
        return c;
      });
      return { combo };
    },
  );

  // DELETE /admin/combos/:id — desactivar (soft delete)
  fastify.delete(
    '/admin/combos/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const params = req.params as { id: string };
      try {
        await prisma.combo.delete({ where: { id: params.id } });
        return { ok: true, deleted: true };
      } catch {
        await prisma.combo.update({
          where: { id: params.id },
          data: { activo: false },
        });
        return { ok: true, deleted: false, deactivated: true };
      }
    },
  );

  // POST /admin/combos/detectar — recibe items del carrito y devuelve combos auto-detectados
  // que matchean los productos individuales. El frontend llama a este endpoint antes del cobro.
  fastify.post(
    '/admin/combos/detectar',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        body: z.object({
          items: z.array(
            z.object({
              productoId: z.string().uuid(),
              cantidad: z.coerce.number().int().min(1).default(1),
              parteDeComboInstancia: z.string().optional(),
            }),
          ),
        }),
      },
    },
    async (req) => {
      const body = req.body as {
        items: Array<{
          productoId: string;
          cantidad: number;
          parteDeComboInstancia?: string;
        }>;
      };

      // Solo consideramos items que NO ya forman parte de un combo cargado manualmente
      const itemsLibres = body.items.filter((i) => !i.parteDeComboInstancia);
      if (itemsLibres.length === 0) return { detectados: [] };

      const combos = await prisma.combo.findMany({
        where: { activo: true },
        include: {
          componentes: { orderBy: { orden: 'asc' } },
        },
      });

      // Multi-set de items disponibles
      const disponibles = new Map<string, number>();
      for (const i of itemsLibres) {
        disponibles.set(i.productoId, (disponibles.get(i.productoId) ?? 0) + i.cantidad);
      }

      // Greedy: para cada combo, intentamos consumir N veces sus componentes
      type Detectado = {
        comboId: string;
        nombre: string;
        precioCombo: string;
        instancias: number;
        descuentoTotal: string;
        productosUsados: Array<{ productoId: string; cantidad: number }>;
      };
      const detectados: Detectado[] = [];
      for (const combo of combos) {
        const componentesFijos = combo.componentes.filter(
          (c) => c.productoId !== null,
        );
        if (componentesFijos.length === 0) continue;
        let instancias = 0;
        const usados: Array<{ productoId: string; cantidad: number }> = [];
        // Cuántas veces podemos hacer el combo
        while (true) {
          const puede = componentesFijos.every((c) => {
            const tengo = disponibles.get(c.productoId!) ?? 0;
            return tengo >= Number(c.cantidad);
          });
          if (!puede) break;
          for (const c of componentesFijos) {
            const cant = Number(c.cantidad);
            disponibles.set(
              c.productoId!,
              (disponibles.get(c.productoId!) ?? 0) - cant,
            );
            usados.push({ productoId: c.productoId!, cantidad: cant });
          }
          instancias += 1;
        }
        if (instancias > 0) {
          // Calcular precio suelto
          const productosIds = componentesFijos.map((c) => c.productoId!);
          const productos = await prisma.producto.findMany({
            where: { id: { in: productosIds } },
            select: { id: true, precioBase: true },
          });
          const precioPorId = new Map(productos.map((p) => [p.id, Number(p.precioBase)]));
          const precioSueltoUnit = componentesFijos.reduce(
            (acc, c) => acc + Number(c.cantidad) * (precioPorId.get(c.productoId!) ?? 0),
            0,
          );
          const descuentoUnit = precioSueltoUnit - Number(combo.precioCombo);
          detectados.push({
            comboId: combo.id,
            nombre: combo.nombre,
            precioCombo: combo.precioCombo.toString(),
            instancias,
            descuentoTotal: (descuentoUnit * instancias).toFixed(2),
            productosUsados: usados,
          });
        }
      }
      return { detectados };
    },
  );
}
