import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@sta/db';
import { prisma } from '@sta/db/client';
import { EstadoVenta, RolUsuario } from '@sta/db';

/**
 * Endpoints de Analytics — el panel pro para Julio (contador) y la encargada.
 * Todas las queries van a Postgres con SQL crudo cuando Prisma no alcanza
 * para agregaciones complejas (heatmaps, cohort, basket analysis).
 *
 * Mantenemos un endpoint por tab del frontend para que cada tab cargue solo
 * lo que necesita y no haya un mega-endpoint que devuelva 1MB.
 */
export default async function analyticsRoutes(fastify: FastifyInstance) {
  const QuerySchema = z.object({
    periodo: z.enum(['hoy', 'semana', 'mes', 'trimestre', 'anio', 'custom']).default('mes'),
    desde: z.string().optional(),
    hasta: z.string().optional(),
  });

  /** Resuelve el rango (desde, hasta, desdeAnterior) según el período. */
  function resolverRango(q: z.infer<typeof QuerySchema>): {
    desde: Date;
    hasta: Date;
    desdeAnterior: Date;
    hastaAnterior: Date;
  } {
    let hasta = new Date();
    const desde = new Date(hasta);
    if (q.periodo === 'custom') {
      if (!q.desde || !q.hasta) {
        throw new Error('Para periodo=custom, desde y hasta son requeridos (YYYY-MM-DD)');
      }
      const [yd, md, dd] = q.desde.split('-').map(Number);
      const [yh, mh, dh] = q.hasta.split('-').map(Number);
      desde.setFullYear(yd!, (md ?? 1) - 1, dd ?? 1);
      desde.setHours(0, 0, 0, 0);
      hasta = new Date();
      hasta.setFullYear(yh!, (mh ?? 1) - 1, dh ?? 1);
      hasta.setHours(23, 59, 59, 999);
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
    const duracionMs = hasta.getTime() - desde.getTime();
    const desdeAnterior = new Date(desde.getTime() - duracionMs);
    const hastaAnterior = new Date(desde);
    return { desde, hasta, desdeAnterior, hastaAnterior };
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1. RESUMEN — KPIs principales + sparklines + proyección
  // ──────────────────────────────────────────────────────────────────────
  fastify.get(
    '/admin/analytics/resumen',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { querystring: QuerySchema },
    },
    async (req) => {
      const q = req.query as z.infer<typeof QuerySchema>;
      const { desde, hasta, desdeAnterior, hastaAnterior } = resolverRango(q);

      // KPIs período actual
      const ventas = await prisma.venta.aggregate({
        _sum: { total: true, descuentoTotal: true },
        _count: { _all: true },
        _avg: { total: true },
        where: {
          estado: EstadoVenta.FINALIZADA,
          fechaFinalizacion: { gte: desde, lte: hasta },
        },
      });
      const ventasAnterior = await prisma.venta.aggregate({
        _sum: { total: true },
        _count: { _all: true },
        where: {
          estado: EstadoVenta.FINALIZADA,
          fechaFinalizacion: { gte: desdeAnterior, lt: hastaAnterior },
        },
      });
      const anuladas = await prisma.venta.aggregate({
        _sum: { total: true },
        _count: { _all: true },
        where: {
          estado: EstadoVenta.ANULADA,
          fechaAnulacion: { gte: desde, lte: hasta },
        },
      });
      const egresos = await prisma.movimiento.aggregate({
        _sum: { monto: true },
        where: { tipo: 'EGRESO', fechaComputo: { gte: desde, lte: hasta } },
      });

      const ventasNum = Number(ventas._sum.total ?? 0);
      const ventasAnteriorNum = Number(ventasAnterior._sum.total ?? 0);
      const variacion =
        ventasAnteriorNum > 0
          ? ((ventasNum - ventasAnteriorNum) / ventasAnteriorNum) * 100
          : null;
      const egresosNum = Number(egresos._sum?.monto ?? 0);
      const resultadoNeto = ventasNum - egresosNum;

      // Sparklines: serie diaria de ventas + egresos
      const sparklineSql = await prisma.$queryRaw<
        Array<{ fecha: string; ventas: string; egresos: string }>
      >(Prisma.sql`
        WITH dias AS (
          SELECT generate_series(
            ${desde}::timestamptz::date,
            ${hasta}::timestamptz::date,
            '1 day'::interval
          )::date AS fecha
        ),
        v AS (
          SELECT
            fecha_finalizacion::date AS fecha,
            SUM(total)::text AS total
          FROM ventas
          WHERE estado = 'FINALIZADA'
            AND fecha_finalizacion >= ${desde}
            AND fecha_finalizacion <= ${hasta}
          GROUP BY 1
        ),
        e AS (
          SELECT
            fecha_computo::date AS fecha,
            SUM(monto)::text AS total
          FROM movimientos
          WHERE tipo = 'EGRESO'
            AND fecha_computo >= ${desde}
            AND fecha_computo <= ${hasta}
          GROUP BY 1
        )
        SELECT
          d.fecha::text,
          COALESCE(v.total, '0') AS ventas,
          COALESCE(e.total, '0') AS egresos
        FROM dias d
        LEFT JOIN v ON v.fecha = d.fecha
        LEFT JOIN e ON e.fecha = d.fecha
        ORDER BY d.fecha
      `);

      // Proyección de cierre de mes (solo si periodo='mes' o custom-mes-actual)
      let proyeccion = null;
      const ahora = new Date();
      if (q.periodo === 'mes' || q.periodo === 'hoy' || q.periodo === 'semana') {
        const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
        const finMes = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0);
        const ventasMes = await prisma.venta.aggregate({
          _sum: { total: true },
          where: {
            estado: EstadoVenta.FINALIZADA,
            fechaFinalizacion: { gte: inicioMes, lte: ahora },
          },
        });
        const ventasMesNum = Number(ventasMes._sum.total ?? 0);
        const diasTranscurridos = Math.max(
          1,
          Math.floor((ahora.getTime() - inicioMes.getTime()) / 86400000) + 1,
        );
        const diasTotales =
          Math.floor((finMes.getTime() - inicioMes.getTime()) / 86400000) + 1;
        const promedioPorDia = ventasMesNum / diasTranscurridos;
        const proyeccionTotal = promedioPorDia * diasTotales;
        proyeccion = {
          diasTranscurridos,
          diasTotales,
          ventasHasta: ventasMesNum.toFixed(2),
          proyeccionTotal: proyeccionTotal.toFixed(2),
          promedioPorDia: promedioPorDia.toFixed(2),
        };
      }

      return {
        periodo: q.periodo,
        desde: desde.toISOString(),
        hasta: hasta.toISOString(),
        kpis: {
          ventasTotal: ventasNum.toFixed(2),
          ventasCantidad: ventas._count._all,
          ticketPromedio: (Number(ventas._avg.total ?? 0)).toFixed(2),
          descuentoTotal: Number(ventas._sum.descuentoTotal ?? 0).toFixed(2),
          variacionVentasPct: variacion,
          anuladasMonto: Number(anuladas._sum.total ?? 0).toFixed(2),
          anuladasCantidad: anuladas._count._all,
          egresosTotal: egresosNum.toFixed(2),
          resultadoNeto: resultadoNeto.toFixed(2),
        },
        sparklines: sparklineSql,
        proyeccion,
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // 2. TENDENCIAS — heatmap día×hora + YoY + rolling avg
  // ──────────────────────────────────────────────────────────────────────
  fastify.get(
    '/admin/analytics/tendencias',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { querystring: QuerySchema },
    },
    async (req) => {
      const q = req.query as z.infer<typeof QuerySchema>;
      const { desde, hasta } = resolverRango(q);

      // Heatmap día (0-6) × hora (0-23)
      const heatmap = await prisma.$queryRaw<
        Array<{ dia: number; hora: number; cantidad: number; total: string }>
      >(Prisma.sql`
        SELECT
          EXTRACT(DOW FROM fecha_apertura)::int AS dia,
          EXTRACT(HOUR FROM fecha_apertura)::int AS hora,
          COUNT(*)::int AS cantidad,
          COALESCE(SUM(total), 0)::text AS total
        FROM ventas
        WHERE estado = 'FINALIZADA'
          AND fecha_finalizacion >= ${desde}
          AND fecha_finalizacion <= ${hasta}
        GROUP BY 1, 2
      `);

      // YoY: últimos 12 meses cerrados, comparados con los mismos del año anterior
      const yoy = await prisma.$queryRaw<
        Array<{ mes: string; total: string }>
      >(Prisma.sql`
        SELECT
          to_char(fecha_finalizacion, 'YYYY-MM') AS mes,
          SUM(total)::text AS total
        FROM ventas
        WHERE estado = 'FINALIZADA'
          AND fecha_finalizacion >= (CURRENT_DATE - INTERVAL '24 months')
        GROUP BY 1
        ORDER BY 1
      `);

      // Rolling avg 7d / 28d sobre la serie diaria
      const rolling = await prisma.$queryRaw<
        Array<{ fecha: string; total: string; ma7: string; ma28: string }>
      >(Prisma.sql`
        WITH diarios AS (
          SELECT
            fecha_finalizacion::date AS fecha,
            SUM(total)::numeric AS total
          FROM ventas
          WHERE estado = 'FINALIZADA'
            AND fecha_finalizacion >= (${desde}::timestamptz - INTERVAL '28 days')
            AND fecha_finalizacion <= ${hasta}
          GROUP BY 1
        )
        SELECT
          fecha::text,
          total::text,
          AVG(total) OVER (ORDER BY fecha ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)::text AS ma7,
          AVG(total) OVER (ORDER BY fecha ROWS BETWEEN 27 PRECEDING AND CURRENT ROW)::text AS ma28
        FROM diarios
        WHERE fecha >= ${desde}
        ORDER BY fecha
      `);

      return { heatmap, yoy, rolling };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // 3. CLIENTES — RFM + cohort + nuevos vs recurrentes + top
  // ──────────────────────────────────────────────────────────────────────
  fastify.get(
    '/admin/analytics/clientes',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { querystring: QuerySchema },
    },
    async (req) => {
      const q = req.query as z.infer<typeof QuerySchema>;
      const { desde, hasta } = resolverRango(q);

      // RFM: Recency (días desde última compra), Frequency (cant. compras),
      // Monetary (total gastado). Calculados sobre TODA la historia, no solo
      // el período — RFM tiene sentido global.
      // Segmentación simple basada en quintiles aproximados: VIP/Fieles/En riesgo/Perdidos.
      const rfm = await prisma.$queryRaw<
        Array<{
          cliente_id: string;
          nombre: string;
          telefono: string | null;
          recency_dias: number;
          frequency: number;
          monetary: string;
          ultima_compra: string;
          segmento: string;
        }>
      >(Prisma.sql`
        WITH base AS (
          SELECT
            v.cliente_id,
            COUNT(*) AS frequency,
            SUM(v.total) AS monetary,
            MAX(v.fecha_finalizacion) AS ultima_compra
          FROM ventas v
          WHERE v.estado = 'FINALIZADA'
            AND v.cliente_id IS NOT NULL
          GROUP BY v.cliente_id
        ),
        clasificado AS (
          SELECT
            b.*,
            EXTRACT(DAY FROM (CURRENT_TIMESTAMP - b.ultima_compra))::int AS recency_dias,
            CASE
              WHEN b.frequency >= 5 AND EXTRACT(DAY FROM (CURRENT_TIMESTAMP - b.ultima_compra)) <= 30 THEN 'VIP'
              WHEN b.frequency >= 3 AND EXTRACT(DAY FROM (CURRENT_TIMESTAMP - b.ultima_compra)) <= 60 THEN 'Fiel'
              WHEN EXTRACT(DAY FROM (CURRENT_TIMESTAMP - b.ultima_compra)) <= 90 THEN 'Activo'
              WHEN EXTRACT(DAY FROM (CURRENT_TIMESTAMP - b.ultima_compra)) <= 180 THEN 'En riesgo'
              ELSE 'Perdido'
            END AS segmento
          FROM base b
        )
        SELECT
          c.cliente_id::text,
          cl.nombre || COALESCE(' ' || cl.apellido, '') AS nombre,
          cl.telefono,
          c.recency_dias,
          c.frequency::int AS frequency,
          c.monetary::text AS monetary,
          c.ultima_compra::text AS ultima_compra,
          c.segmento
        FROM clasificado c
        LEFT JOIN clientes cl ON cl.id = c.cliente_id
        ORDER BY c.monetary DESC
        LIMIT 100
      `);

      // Distribución por segmento (para chart). Postgres NO permite usar el
      // alias `segmento` dentro de un `CASE segmento WHEN ...` en ORDER BY,
      // así que envolvemos en una sub-CTE para poder ordenarlo limpio.
      const segmentos = await prisma.$queryRaw<
        Array<{ segmento: string; cantidad: number; monto: string }>
      >(Prisma.sql`
        WITH base AS (
          SELECT
            v.cliente_id,
            COUNT(*) AS frequency,
            SUM(v.total) AS monetary,
            MAX(v.fecha_finalizacion) AS ultima_compra
          FROM ventas v
          WHERE v.estado = 'FINALIZADA' AND v.cliente_id IS NOT NULL
          GROUP BY v.cliente_id
        ),
        clasificado AS (
          SELECT
            CASE
              WHEN frequency >= 5 AND EXTRACT(DAY FROM (CURRENT_TIMESTAMP - ultima_compra)) <= 30 THEN 'VIP'
              WHEN frequency >= 3 AND EXTRACT(DAY FROM (CURRENT_TIMESTAMP - ultima_compra)) <= 60 THEN 'Fiel'
              WHEN EXTRACT(DAY FROM (CURRENT_TIMESTAMP - ultima_compra)) <= 90 THEN 'Activo'
              WHEN EXTRACT(DAY FROM (CURRENT_TIMESTAMP - ultima_compra)) <= 180 THEN 'En riesgo'
              ELSE 'Perdido'
            END AS segmento,
            monetary
          FROM base
        )
        SELECT
          segmento,
          COUNT(*)::int AS cantidad,
          SUM(monetary)::text AS monto
        FROM clasificado
        GROUP BY segmento
        ORDER BY
          CASE segmento
            WHEN 'VIP' THEN 1
            WHEN 'Fiel' THEN 2
            WHEN 'Activo' THEN 3
            WHEN 'En riesgo' THEN 4
            ELSE 5
          END
      `);

      // Cohort retention últimos 6 meses
      const cohort = await prisma.$queryRaw<
        Array<{ cohorte_mes: string; mes_compra: string; clientes: number }>
      >(Prisma.sql`
        WITH primera_compra AS (
          SELECT
            cliente_id,
            DATE_TRUNC('month', MIN(fecha_finalizacion))::date AS cohorte_mes
          FROM ventas
          WHERE estado = 'FINALIZADA' AND cliente_id IS NOT NULL
            AND fecha_finalizacion >= (CURRENT_DATE - INTERVAL '6 months')
          GROUP BY cliente_id
        ),
        compras_mes AS (
          SELECT
            v.cliente_id,
            DATE_TRUNC('month', v.fecha_finalizacion)::date AS mes_compra
          FROM ventas v
          WHERE v.estado = 'FINALIZADA' AND v.cliente_id IS NOT NULL
            AND v.fecha_finalizacion >= (CURRENT_DATE - INTERVAL '6 months')
          GROUP BY v.cliente_id, DATE_TRUNC('month', v.fecha_finalizacion)
        )
        SELECT
          to_char(p.cohorte_mes, 'YYYY-MM') AS cohorte_mes,
          to_char(c.mes_compra, 'YYYY-MM') AS mes_compra,
          COUNT(DISTINCT c.cliente_id)::int AS clientes
        FROM primera_compra p
        JOIN compras_mes c ON c.cliente_id = p.cliente_id AND c.mes_compra >= p.cohorte_mes
        GROUP BY 1, 2
        ORDER BY 1, 2
      `);

      // Nuevos vs recurrentes por mes (últimos 12)
      const nuevosVsRecurrentes = await prisma.$queryRaw<
        Array<{ mes: string; nuevos: number; recurrentes: number }>
      >(Prisma.sql`
        WITH primera_compra AS (
          SELECT cliente_id, DATE_TRUNC('month', MIN(fecha_finalizacion))::date AS primer_mes
          FROM ventas WHERE estado = 'FINALIZADA' AND cliente_id IS NOT NULL
          GROUP BY cliente_id
        ),
        ventas_mes AS (
          SELECT
            DATE_TRUNC('month', v.fecha_finalizacion)::date AS mes,
            v.cliente_id,
            (DATE_TRUNC('month', v.fecha_finalizacion)::date = p.primer_mes) AS es_nuevo
          FROM ventas v
          JOIN primera_compra p ON p.cliente_id = v.cliente_id
          WHERE v.estado = 'FINALIZADA' AND v.cliente_id IS NOT NULL
            AND v.fecha_finalizacion >= (CURRENT_DATE - INTERVAL '12 months')
          GROUP BY 1, 2, 3
        )
        SELECT
          to_char(mes, 'YYYY-MM') AS mes,
          COUNT(DISTINCT CASE WHEN es_nuevo THEN cliente_id END)::int AS nuevos,
          COUNT(DISTINCT CASE WHEN NOT es_nuevo THEN cliente_id END)::int AS recurrentes
        FROM ventas_mes
        GROUP BY 1
        ORDER BY 1
      `);

      // Top clientes del período seleccionado
      const top = await prisma.$queryRaw<
        Array<{ cliente_id: string | null; nombre: string; cantidad: number; monto: string }>
      >(Prisma.sql`
        SELECT
          v.cliente_id::text,
          COALESCE(c.nombre || COALESCE(' ' || c.apellido, ''), 'Anónimo') AS nombre,
          COUNT(*)::int AS cantidad,
          SUM(v.total)::text AS monto
        FROM ventas v
        LEFT JOIN clientes c ON c.id = v.cliente_id
        WHERE v.estado = 'FINALIZADA'
          AND v.fecha_finalizacion >= ${desde}
          AND v.fecha_finalizacion <= ${hasta}
        GROUP BY 1, 2
        ORDER BY SUM(v.total) DESC
        LIMIT 20
      `);

      return { rfm, segmentos, cohort, nuevosVsRecurrentes, top };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // 4. PRODUCTOS — top + basket + ABC + declinantes
  // ──────────────────────────────────────────────────────────────────────
  fastify.get(
    '/admin/analytics/productos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { querystring: QuerySchema },
    },
    async (req) => {
      const q = req.query as z.infer<typeof QuerySchema>;
      const { desde, hasta, desdeAnterior, hastaAnterior } = resolverRango(q);

      // Top productos del período
      const top = await prisma.$queryRaw<
        Array<{
          producto_id: string;
          nombre: string;
          cantidad: string;
          monto: string;
          ocurrencias: number;
        }>
      >(Prisma.sql`
        SELECT
          i.producto_id::text,
          i.nombre_snapshot AS nombre,
          SUM(i.cantidad)::text AS cantidad,
          SUM(i.total_linea)::text AS monto,
          COUNT(DISTINCT i.venta_id)::int AS ocurrencias
        FROM items_venta i
        JOIN ventas v ON v.id = i.venta_id
        WHERE v.estado = 'FINALIZADA'
          AND v.fecha_finalizacion >= ${desde}
          AND v.fecha_finalizacion <= ${hasta}
        GROUP BY 1, 2
        ORDER BY SUM(i.total_linea) DESC
        LIMIT 30
      `);

      // ABC analysis (Pareto): % acumulado del monto total
      const abc = await prisma.$queryRaw<
        Array<{
          producto_id: string;
          nombre: string;
          monto: string;
          monto_acum: string;
          pct_acum: number;
          clase: string;
        }>
      >(Prisma.sql`
        WITH base AS (
          SELECT
            i.producto_id,
            i.nombre_snapshot AS nombre,
            SUM(i.total_linea) AS monto
          FROM items_venta i
          JOIN ventas v ON v.id = i.venta_id
          WHERE v.estado = 'FINALIZADA'
            AND v.fecha_finalizacion >= ${desde}
            AND v.fecha_finalizacion <= ${hasta}
          GROUP BY 1, 2
        ),
        ordenado AS (
          SELECT
            producto_id,
            nombre,
            monto,
            SUM(monto) OVER (ORDER BY monto DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS monto_acum,
            SUM(monto) OVER () AS total_global
          FROM base
        )
        SELECT
          producto_id::text,
          nombre,
          monto::text,
          monto_acum::text,
          ROUND((monto_acum / NULLIF(total_global, 0) * 100)::numeric, 2)::float AS pct_acum,
          CASE
            WHEN (monto_acum / NULLIF(total_global, 0) * 100) <= 80 THEN 'A'
            WHEN (monto_acum / NULLIF(total_global, 0) * 100) <= 95 THEN 'B'
            ELSE 'C'
          END AS clase
        FROM ordenado
      `);

      // Basket analysis: pares de productos co-ocurrentes en la misma venta
      const basket = await prisma.$queryRaw<
        Array<{
          producto_a: string;
          producto_b: string;
          coocurrencias: number;
          support_pct: number;
        }>
      >(Prisma.sql`
        WITH ventas_filtradas AS (
          SELECT id FROM ventas
          WHERE estado = 'FINALIZADA'
            AND fecha_finalizacion >= ${desde}
            AND fecha_finalizacion <= ${hasta}
        ),
        total_ventas AS (
          SELECT COUNT(*)::numeric AS n FROM ventas_filtradas
        ),
        pares AS (
          SELECT DISTINCT
            i1.venta_id,
            LEAST(i1.nombre_snapshot, i2.nombre_snapshot) AS producto_a,
            GREATEST(i1.nombre_snapshot, i2.nombre_snapshot) AS producto_b
          FROM items_venta i1
          JOIN items_venta i2 ON i2.venta_id = i1.venta_id
            AND i2.producto_id <> i1.producto_id
          JOIN ventas_filtradas vf ON vf.id = i1.venta_id
          WHERE i1.nombre_snapshot < i2.nombre_snapshot
        )
        SELECT
          producto_a,
          producto_b,
          COUNT(*)::int AS coocurrencias,
          ROUND((COUNT(*)::numeric / NULLIF((SELECT n FROM total_ventas), 0) * 100), 2)::float AS support_pct
        FROM pares
        GROUP BY 1, 2
        HAVING COUNT(*) >= 2
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `);

      // Declinantes: productos que vendían el período anterior y caen >30%
      const declinantes = await prisma.$queryRaw<
        Array<{
          producto_id: string;
          nombre: string;
          monto_actual: string;
          monto_anterior: string;
          variacion_pct: number;
        }>
      >(Prisma.sql`
        WITH actual AS (
          SELECT i.producto_id, i.nombre_snapshot, SUM(i.total_linea) AS monto
          FROM items_venta i
          JOIN ventas v ON v.id = i.venta_id
          WHERE v.estado = 'FINALIZADA'
            AND v.fecha_finalizacion >= ${desde}
            AND v.fecha_finalizacion <= ${hasta}
          GROUP BY 1, 2
        ),
        anterior AS (
          SELECT i.producto_id, SUM(i.total_linea) AS monto
          FROM items_venta i
          JOIN ventas v ON v.id = i.venta_id
          WHERE v.estado = 'FINALIZADA'
            AND v.fecha_finalizacion >= ${desdeAnterior}
            AND v.fecha_finalizacion < ${hastaAnterior}
          GROUP BY 1
        )
        SELECT
          a.producto_id::text,
          a.nombre_snapshot AS nombre,
          a.monto::text AS monto_actual,
          COALESCE(b.monto, 0)::text AS monto_anterior,
          CASE
            WHEN COALESCE(b.monto, 0) = 0 THEN NULL
            ELSE ROUND(((a.monto - b.monto) / b.monto * 100)::numeric, 2)::float
          END AS variacion_pct
        FROM actual a
        JOIN anterior b ON b.producto_id = a.producto_id
        WHERE COALESCE(b.monto, 0) > 0
          AND ((a.monto - b.monto) / b.monto * 100) <= -30
        ORDER BY variacion_pct ASC
        LIMIT 20
      `);

      return { top, abc, basket, declinantes };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // 5. CANALES — comisiones, DSO, anulación rate
  // ──────────────────────────────────────────────────────────────────────
  fastify.get(
    '/admin/analytics/canales',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { querystring: QuerySchema },
    },
    async (req) => {
      const q = req.query as z.infer<typeof QuerySchema>;
      const { desde, hasta } = resolverRango(q);

      // Comisiones por canal (ajustables via configuracion_sistema en el futuro)
      const COMISIONES_DEFAULT: Record<string, number> = {
        MOSTRADOR: 0,
        TELEFONO: 0,
        WHATSAPP: 0,
        WEB: 0,
        RAPPI: 25,
        PEDIDOS_YA: 22,
        MERCADO_LIBRE: 13,
        DELIVERATE: 5,
      };

      // Postgres no acepta `ORDER BY <alias>::numeric` cuando el alias se
      // generó con `::text` en la SELECT — repetimos la expresión SUM en el
      // ORDER BY directamente.
      const porCanal = await prisma.$queryRaw<
        Array<{
          canal: string;
          cantidad: number;
          monto: string;
          ticket_promedio: string;
          anuladas_cantidad: number;
        }>
      >(Prisma.sql`
        SELECT
          v.canal::text AS canal,
          COUNT(*) FILTER (WHERE v.estado = 'FINALIZADA')::int AS cantidad,
          COALESCE(SUM(CASE WHEN v.estado = 'FINALIZADA' THEN v.total ELSE 0 END), 0)::text AS monto,
          COALESCE(AVG(CASE WHEN v.estado = 'FINALIZADA' THEN v.total ELSE NULL END), 0)::text AS ticket_promedio,
          COUNT(*) FILTER (WHERE v.estado = 'ANULADA')::int AS anuladas_cantidad
        FROM ventas v
        WHERE COALESCE(v.fecha_finalizacion, v.fecha_anulacion, v.fecha_apertura) >= ${desde}
          AND COALESCE(v.fecha_finalizacion, v.fecha_anulacion, v.fecha_apertura) <= ${hasta}
        GROUP BY 1
        ORDER BY COALESCE(SUM(CASE WHEN v.estado = 'FINALIZADA' THEN v.total ELSE 0 END), 0) DESC
      `);

      const canales = porCanal.map((c) => {
        const monto = Number(c.monto);
        const comisionPct = COMISIONES_DEFAULT[c.canal] ?? 0;
        const comisionMonto = (monto * comisionPct) / 100;
        const total = c.cantidad + c.anuladas_cantidad;
        const anuladasPct = total > 0 ? (c.anuladas_cantidad / total) * 100 : 0;
        return {
          ...c,
          comisionPct,
          comisionMonto: comisionMonto.toFixed(2),
          montoNeto: (monto - comisionMonto).toFixed(2),
          anuladasPct: Number(anuladasPct.toFixed(2)),
        };
      });

      // DSO por canal: días promedio entre venta y cobro real (pago confirmado)
      // Para mostrador/efectivo es 0 (instant). Para plataformas, el pago real
      // se registra cuando llega la liquidación.
      const dso = await prisma.$queryRaw<
        Array<{ canal: string; dso_dias: number | null }>
      >(Prisma.sql`
        SELECT
          v.canal::text AS canal,
          ROUND(AVG(EXTRACT(EPOCH FROM (p.fecha - v.fecha_finalizacion)) / 86400)::numeric, 1)::float AS dso_dias
        FROM ventas v
        JOIN pagos p ON p.venta_id = v.id
        WHERE v.estado = 'FINALIZADA' AND p.estado = 'CONFIRMADO'
          AND v.fecha_finalizacion >= ${desde}
          AND v.fecha_finalizacion <= ${hasta}
        GROUP BY 1
      `);

      // Aging cuentas a cobrar (pendientes de liquidar). El "envejecimiento"
      // se mide desde `creado_at` (cuando se generó la liquidación pendiente,
      // típicamente al cerrar la venta con pago RAPPI/PYA/etc.) hasta hoy.
      // Usamos `monto_bruto` (lo facturado, antes de comisión) — otra opción
      // sería `monto_neto_esperado` (lo que vamos a cobrar realmente).
      const aging = await prisma.$queryRaw<
        Array<{
          cuenta: string;
          monto_total: string;
          dias_0_7: string;
          dias_8_15: string;
          dias_16_30: string;
          dias_31plus: string;
        }>
      >(Prisma.sql`
        SELECT
          ca.nombre AS cuenta,
          COALESCE(SUM(lp.monto_bruto), 0)::text AS monto_total,
          COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM (CURRENT_TIMESTAMP - lp.creado_at)) <= 7 THEN lp.monto_bruto ELSE 0 END), 0)::text AS dias_0_7,
          COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM (CURRENT_TIMESTAMP - lp.creado_at)) BETWEEN 8 AND 15 THEN lp.monto_bruto ELSE 0 END), 0)::text AS dias_8_15,
          COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM (CURRENT_TIMESTAMP - lp.creado_at)) BETWEEN 16 AND 30 THEN lp.monto_bruto ELSE 0 END), 0)::text AS dias_16_30,
          COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM (CURRENT_TIMESTAMP - lp.creado_at)) > 30 THEN lp.monto_bruto ELSE 0 END), 0)::text AS dias_31plus
        FROM liquidaciones_pendientes lp
        JOIN cuentas_a_cobrar ca ON ca.id = lp.cuenta_a_cobrar_id
        WHERE lp.estado = 'PENDIENTE'
        GROUP BY ca.nombre
        HAVING SUM(lp.monto_bruto) > 0
        ORDER BY SUM(lp.monto_bruto) DESC
      `);

      return { canales, dso, aging };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // 6. EQUIPO — performance vendedor + cocina + descuento
  // ──────────────────────────────────────────────────────────────────────
  fastify.get(
    '/admin/analytics/equipo',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { querystring: QuerySchema },
    },
    async (req) => {
      const q = req.query as z.infer<typeof QuerySchema>;
      const { desde, hasta } = resolverRango(q);

      // Performance por vendedor: agregamos en CTEs separadas para evitar
      // subqueries correlacionadas. Una para totales por venta, otra para
      // items-por-venta promedio.
      const vendedores = await prisma.$queryRaw<
        Array<{
          usuario_id: string;
          nombre: string;
          cantidad: number;
          monto: string;
          ticket_promedio: string;
          anuladas_cantidad: number;
          anuladas_pct: number;
          items_por_venta: number;
        }>
      >(Prisma.sql`
        WITH ventas_periodo AS (
          SELECT
            v.usuario_apertura_id AS usuario_id,
            v.id AS venta_id,
            v.estado::text AS estado,
            v.total
          FROM ventas v
          WHERE COALESCE(v.fecha_finalizacion, v.fecha_anulacion, v.fecha_apertura) >= ${desde}
            AND COALESCE(v.fecha_finalizacion, v.fecha_anulacion, v.fecha_apertura) <= ${hasta}
        ),
        agregado AS (
          SELECT
            usuario_id,
            COUNT(*) FILTER (WHERE estado = 'FINALIZADA')::int AS cantidad,
            COALESCE(SUM(CASE WHEN estado = 'FINALIZADA' THEN total ELSE 0 END), 0) AS monto_num,
            COALESCE(AVG(CASE WHEN estado = 'FINALIZADA' THEN total ELSE NULL END), 0) AS ticket_num,
            COUNT(*) FILTER (WHERE estado = 'ANULADA')::int AS anuladas_cantidad,
            COUNT(*)::int AS total_eventos
          FROM ventas_periodo
          GROUP BY usuario_id
        ),
        items_por_venta_prom AS (
          SELECT
            vp.usuario_id,
            ROUND(AVG(item_count)::numeric, 1)::float AS items_por_venta
          FROM ventas_periodo vp
          JOIN (
            SELECT venta_id, COUNT(*) AS item_count
            FROM items_venta
            GROUP BY venta_id
          ) ic ON ic.venta_id = vp.venta_id
          WHERE vp.estado = 'FINALIZADA'
          GROUP BY vp.usuario_id
        )
        SELECT
          u.id::text AS usuario_id,
          u.nombre,
          a.cantidad,
          a.monto_num::text AS monto,
          a.ticket_num::text AS ticket_promedio,
          a.anuladas_cantidad,
          ROUND(a.anuladas_cantidad::numeric / NULLIF(a.total_eventos, 0) * 100, 2)::float AS anuladas_pct,
          COALESCE(ipv.items_por_venta, 0) AS items_por_venta
        FROM agregado a
        JOIN usuarios u ON u.id = a.usuario_id
        LEFT JOIN items_por_venta_prom ipv ON ipv.usuario_id = a.usuario_id
        ORDER BY a.monto_num DESC
      `);

      // Cocina: tiempo desde "venta finalizada" a "comanda lista" (proxy)
      // Si no hay tracking explícito, usamos comanda_impresa como proxy de
      // "ya empezó cocina"
      const cocina = await prisma.$queryRaw<
        Array<{ pedidos_con_cocina: number; pedidos_sin_cocina: number }>
      >(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE tiene_cocina)::int AS pedidos_con_cocina,
          COUNT(*) FILTER (WHERE NOT tiene_cocina)::int AS pedidos_sin_cocina
        FROM ventas
        WHERE estado = 'FINALIZADA'
          AND fecha_finalizacion >= ${desde}
          AND fecha_finalizacion <= ${hasta}
      `);

      // Costo del descuento 10% efectivo
      const descuentoEfectivo = await prisma.$queryRaw<
        Array<{
          monto_total: string;
          cantidad_ventas: number;
          ventas_total: number;
          pct_ventas_con_descuento: number;
        }>
      >(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE WHEN descuento_efectivo_aplicado THEN descuento_total ELSE 0 END), 0)::text AS monto_total,
          COUNT(*) FILTER (WHERE descuento_efectivo_aplicado)::int AS cantidad_ventas,
          COUNT(*)::int AS ventas_total,
          ROUND(
            COUNT(*) FILTER (WHERE descuento_efectivo_aplicado)::numeric
            / NULLIF(COUNT(*), 0) * 100, 2
          )::float AS pct_ventas_con_descuento
        FROM ventas
        WHERE estado = 'FINALIZADA'
          AND fecha_finalizacion >= ${desde}
          AND fecha_finalizacion <= ${hasta}
      `);

      return {
        vendedores,
        cocina: cocina[0],
        descuentoEfectivo: descuentoEfectivo[0],
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // 7. MAPA — pines del día + heatmap del período
  // ──────────────────────────────────────────────────────────────────────
  fastify.get(
    '/admin/analytics/mapa',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { querystring: QuerySchema },
    },
    async (req) => {
      const q = req.query as z.infer<typeof QuerySchema>;
      const { desde, hasta } = resolverRango(q);

      // Pines del DÍA actual (operativo)
      const inicioHoy = new Date();
      inicioHoy.setHours(0, 0, 0, 0);
      const finHoy = new Date();
      finHoy.setHours(23, 59, 59, 999);

      const pinesHoy = await prisma.$queryRaw<
        Array<{
          venta_id: string;
          numero: number;
          total: string;
          estado: string;
          estado_delivery: string | null;
          cliente: string;
          telefono: string | null;
          direccion: string;
          lat: number | null;
          lng: number | null;
          demora_min: number | null;
        }>
      >(Prisma.sql`
        SELECT
          v.id::text AS venta_id,
          v.numero_orden_turno AS numero,
          v.total::text AS total,
          v.estado::text AS estado,
          d.estado::text AS estado_delivery,
          COALESCE(c.nombre || COALESCE(' ' || c.apellido, ''), 'NN') AS cliente,
          c.telefono,
          COALESCE(d.direccion_snapshot->>'direccion', d.direccion_snapshot::text, '') AS direccion,
          (d.direccion_snapshot->>'lat')::float AS lat,
          (d.direccion_snapshot->>'lng')::float AS lng,
          CASE
            WHEN d.hora_entrega IS NOT NULL
            THEN EXTRACT(EPOCH FROM (d.hora_entrega - v.fecha_apertura))::int / 60
            ELSE NULL
          END AS demora_min
        FROM ventas v
        JOIN delivery_info d ON d.venta_id = v.id
        LEFT JOIN clientes c ON c.id = v.cliente_id
        WHERE v.fecha_apertura >= ${inicioHoy}
          AND v.fecha_apertura <= ${finHoy}
          AND v.estado IN ('PROCESADA', 'FINALIZADA')
        ORDER BY v.fecha_apertura DESC
      `);

      // Heatmap del período: agregación por punto geográfico (rounded a 0.001
      // = ~111m de precisión) — agrupa puntos cercanos
      const heatmap = await prisma.$queryRaw<
        Array<{ lat: number; lng: number; cantidad: number; monto: string }>
      >(Prisma.sql`
        SELECT
          ROUND(((d.direccion_snapshot->>'lat')::float * 1000))/1000 AS lat,
          ROUND(((d.direccion_snapshot->>'lng')::float * 1000))/1000 AS lng,
          COUNT(*)::int AS cantidad,
          SUM(v.total)::text AS monto
        FROM ventas v
        JOIN delivery_info d ON d.venta_id = v.id
        WHERE v.estado = 'FINALIZADA'
          AND v.fecha_finalizacion >= ${desde}
          AND v.fecha_finalizacion <= ${hasta}
          AND d.direccion_snapshot ? 'lat'
          AND d.direccion_snapshot ? 'lng'
        GROUP BY 1, 2
        ORDER BY cantidad DESC
        LIMIT 500
      `);

      // Cuántas direcciones falta geocodificar
      const pendientesRows = await prisma.$queryRaw<
        Array<{ pendientes: number }>
      >(Prisma.sql`
        SELECT COUNT(*)::int AS pendientes
        FROM delivery_info d
        JOIN ventas v ON v.id = d.venta_id
        WHERE NOT (d.direccion_snapshot ? 'lat')
          AND v.fecha_apertura >= (CURRENT_DATE - INTERVAL '90 days')
      `);

      return {
        pinesHoy,
        heatmap,
        geocodingPendiente: pendientesRows[0]?.pendientes ?? 0,
      };
    },
  );
}
