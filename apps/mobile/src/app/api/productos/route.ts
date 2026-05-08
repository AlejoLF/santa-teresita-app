import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/productos?q=ravioles
 *
 * Catálogo browse-only. Devuelve productos activos con precio.
 * Filtro por nombre (ILIKE).
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim();

  const conds: string[] = ['p.activo = true'];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    conds.push(`LOWER(p.nombre) LIKE $${params.length}`);
  }

  const productos = await query<{
    id: string;
    codigo: string | null;
    nombre: string;
    categoria: string;
    tipo: string;
    precio: string;
    forma_venta: string;
    sabores_count: number;
  }>(
    `
    SELECT
      p.id::text,
      p.codigo,
      p.nombre,
      cat.nombre AS categoria,
      tp.nombre AS tipo,
      p.precio_base::text AS precio,
      p.forma_venta::text AS forma_venta,
      (SELECT COUNT(*)::int
       FROM modificadores_aplicables ma
       JOIN opciones_modificador om ON om.grupo_id = ma.grupo_modificador_id
       WHERE ma.tipo_producto_id = p.tipo_producto_id AND om.activa = true
      ) AS sabores_count
    FROM productos p
    JOIN tipos_producto tp ON tp.id = p.tipo_producto_id
    JOIN categorias cat ON cat.id = tp.categoria_id
    WHERE ${conds.join(' AND ')}
    ORDER BY cat.orden, tp.orden, p.codigo NULLS LAST, p.nombre
    LIMIT 200
    `,
    params,
  );

  return NextResponse.json({ productos });
}
