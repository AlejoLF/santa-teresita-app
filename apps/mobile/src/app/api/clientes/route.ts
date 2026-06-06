import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/clientes?q=texto
 *
 * Clientes con stats agregadas (cantidad de compras finalizadas, total gastado,
 * última compra). Ordenados por total gastado desc (mejores clientes primero).
 * Búsqueda por nombre/apellido/teléfono. Read-only.
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const q = new URL(req.url).searchParams.get('q')?.trim().toLowerCase();
  const params: unknown[] = [];
  let filtro = 'c.activo = true';
  if (q) {
    params.push(`%${q}%`);
    filtro += ` AND (LOWER(COALESCE(c.nombre,'') || ' ' || COALESCE(c.apellido,'')) LIKE $${params.length} OR COALESCE(c.telefono,'') LIKE $${params.length})`;
  }

  const clientes = await query<{
    id: string;
    nombre: string;
    apellido: string | null;
    telefono: string | null;
    tipo: string;
    compras: number;
    total: string;
    ultima: string | null;
  }>(
    `
    SELECT
      c.id::text,
      c.nombre,
      c.apellido,
      c.telefono,
      c.tipo::text AS tipo,
      COUNT(v.id) FILTER (WHERE v.estado = 'FINALIZADA')::int AS compras,
      COALESCE(SUM(v.total) FILTER (WHERE v.estado = 'FINALIZADA'), 0)::text AS total,
      MAX(v.fecha_finalizacion) FILTER (WHERE v.estado = 'FINALIZADA')::text AS ultima
    FROM clientes c
    LEFT JOIN ventas v ON v.cliente_id = c.id
    WHERE ${filtro}
    GROUP BY c.id
    ORDER BY COALESCE(SUM(v.total) FILTER (WHERE v.estado = 'FINALIZADA'), 0) DESC, c.nombre
    LIMIT 100
    `,
    params,
  );

  return NextResponse.json({ clientes });
}
