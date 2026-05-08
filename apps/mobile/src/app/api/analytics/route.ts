import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/analytics
 *
 * Subset de analytics para mobile (los últimos 30 días):
 *   - top productos
 *   - ventas por canal
 *   - top clientes
 *   - tendencia diaria (últimos 14 días)
 *
 * NO devuelve cohort/RFM/heatmap/etc — eso es overkill para una pantalla
 * de teléfono y mejor consultado desde desktop.
 */
export async function GET() {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const [topProductos, porCanal, topClientes, tendencia] = await Promise.all([
    query<{ nombre: string; cantidad: string; monto: string }>(`
      SELECT
        i.nombre_snapshot AS nombre,
        SUM(i.cantidad)::text AS cantidad,
        SUM(i.total_linea)::text AS monto
      FROM items_venta i
      JOIN ventas v ON v.id = i.venta_id
      WHERE v.estado = 'FINALIZADA'
        AND v.fecha_finalizacion >= (CURRENT_DATE - INTERVAL '30 days')
      GROUP BY i.nombre_snapshot
      ORDER BY SUM(i.total_linea) DESC
      LIMIT 10
    `),
    query<{ canal: string; cantidad: number; monto: string }>(`
      SELECT
        canal::text AS canal,
        COUNT(*)::int AS cantidad,
        SUM(total)::text AS monto
      FROM ventas
      WHERE estado = 'FINALIZADA'
        AND fecha_finalizacion >= (CURRENT_DATE - INTERVAL '30 days')
      GROUP BY canal
      ORDER BY SUM(total) DESC
    `),
    query<{ nombre: string; cantidad: number; monto: string }>(`
      SELECT
        COALESCE(c.nombre || COALESCE(' ' || c.apellido, ''), 'Anónimos') AS nombre,
        COUNT(*)::int AS cantidad,
        SUM(v.total)::text AS monto
      FROM ventas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.estado = 'FINALIZADA'
        AND v.fecha_finalizacion >= (CURRENT_DATE - INTERVAL '30 days')
      GROUP BY 1
      ORDER BY SUM(v.total) DESC
      LIMIT 10
    `),
    query<{ fecha: string; total: string; cantidad: number }>(`
      WITH dias AS (
        SELECT generate_series(
          CURRENT_DATE - INTERVAL '13 days',
          CURRENT_DATE,
          '1 day'::interval
        )::date AS fecha
      )
      SELECT
        d.fecha::text,
        COALESCE(SUM(v.total), 0)::text AS total,
        COUNT(v.id)::int AS cantidad
      FROM dias d
      LEFT JOIN ventas v ON v.estado = 'FINALIZADA' AND v.fecha_finalizacion::date = d.fecha
      GROUP BY d.fecha
      ORDER BY d.fecha
    `),
  ]);

  return NextResponse.json({
    topProductos,
    porCanal,
    topClientes,
    tendencia,
  });
}
