import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

/**
 * GET /api/resumen
 *
 * KPIs principales del día / semana / mes contra la cloud DB.
 * Lee solo de tablas operacionales. NO escribe nada.
 *
 * Response:
 *   {
 *     hoy: { ventas, monto, ticket_promedio },
 *     semana: { ventas, monto, ticket_promedio },
 *     mes: { ventas, monto, ticket_promedio },
 *     ultimas: [{ id, numero, total, canal, fecha, cliente }]
 *   }
 */
export async function GET() {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  // Paralelizamos las 3 ventanas de tiempo + la lista de últimas ventas.
  const [hoy, semana, mes, ultimas] = await Promise.all([
    queryOne<{ cantidad: string; monto: string; ticket: string }>(`
      SELECT
        COUNT(*)::text AS cantidad,
        COALESCE(SUM(total), 0)::text AS monto,
        COALESCE(AVG(total), 0)::text AS ticket
      FROM ventas
      WHERE estado = 'FINALIZADA'
        AND fecha_finalizacion >= CURRENT_DATE
    `),
    queryOne<{ cantidad: string; monto: string; ticket: string }>(`
      SELECT
        COUNT(*)::text AS cantidad,
        COALESCE(SUM(total), 0)::text AS monto,
        COALESCE(AVG(total), 0)::text AS ticket
      FROM ventas
      WHERE estado = 'FINALIZADA'
        AND fecha_finalizacion >= (CURRENT_DATE - INTERVAL '7 days')
    `),
    queryOne<{ cantidad: string; monto: string; ticket: string }>(`
      SELECT
        COUNT(*)::text AS cantidad,
        COALESCE(SUM(total), 0)::text AS monto,
        COALESCE(AVG(total), 0)::text AS ticket
      FROM ventas
      WHERE estado = 'FINALIZADA'
        AND fecha_finalizacion >= (CURRENT_DATE - INTERVAL '30 days')
    `),
    query<{
      id: string;
      numero: number;
      total: string;
      canal: string;
      fecha: string;
      cliente: string | null;
    }>(`
      SELECT
        v.id::text,
        v.numero,
        v.total::text,
        v.canal::text AS canal,
        v.fecha_finalizacion::text AS fecha,
        COALESCE(c.nombre || COALESCE(' ' || c.apellido, ''), 'NN') AS cliente
      FROM ventas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.estado = 'FINALIZADA'
      ORDER BY v.fecha_finalizacion DESC
      LIMIT 10
    `),
  ]);

  return NextResponse.json({
    hoy,
    semana,
    mes,
    ultimas,
  });
}
