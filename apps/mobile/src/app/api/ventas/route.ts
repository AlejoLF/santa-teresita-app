import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/ventas?periodo=hoy|semana|mes&canal=RAPPI&q=teresa
 * Devuelve hasta 100 ventas finalizadas filtradas. Diseñado para la lista
 * scrolleable del mobile.
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const periodo = url.searchParams.get('periodo') ?? 'mes';
  const canal = url.searchParams.get('canal');
  const q = url.searchParams.get('q')?.trim();

  // Mapeamos el período a un INTERVAL — más legible que parsear fechas en JS.
  const intervalSql =
    periodo === 'hoy'
      ? "fecha_finalizacion >= CURRENT_DATE"
      : periodo === 'semana'
        ? "fecha_finalizacion >= (CURRENT_DATE - INTERVAL '7 days')"
        : "fecha_finalizacion >= (CURRENT_DATE - INTERVAL '30 days')";

  const conds: string[] = ["v.estado = 'FINALIZADA'", `v.${intervalSql}`];
  const params: unknown[] = [];
  if (canal) {
    params.push(canal);
    conds.push(`v.canal = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    conds.push(
      `(LOWER(COALESCE(c.nombre, '')) LIKE $${params.length} OR LOWER(COALESCE(c.telefono, '')) LIKE $${params.length})`,
    );
  }

  const rows = await query<{
    id: string;
    numero: number;
    total: string;
    canal: string;
    modalidad: string;
    fecha: string;
    cliente: string;
    items_count: number;
  }>(
    `
    SELECT
      v.id::text,
      v.numero,
      v.total::text,
      v.canal::text AS canal,
      v.modalidad::text AS modalidad,
      v.fecha_finalizacion::text AS fecha,
      COALESCE(c.nombre || COALESCE(' ' || c.apellido, ''), 'NN') AS cliente,
      (SELECT COUNT(*)::int FROM items_venta i WHERE i.venta_id = v.id) AS items_count
    FROM ventas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    WHERE ${conds.join(' AND ')}
    ORDER BY v.fecha_finalizacion DESC
    LIMIT 100
    `,
    params,
  );

  return NextResponse.json({ ventas: rows });
}
