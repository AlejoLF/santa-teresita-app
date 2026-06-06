import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

/**
 * GET /api/insumos
 *
 * Insumos (stock + último precio + proveedor) y gastos (facturas recibidas,
 * con lo pendiente de pago). Read-only. Si el negocio todavía no cargó insumos
 * ni facturas (feature de OCR/carga aún en marcha), devuelve listas vacías y
 * la UI muestra el estado correspondiente.
 */
export async function GET() {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const [insumos, facturas, resumen] = await Promise.all([
    query<{
      id: string;
      nombre: string;
      categoria: string;
      unidad: string;
      stock: string;
      minimo: string | null;
      proveedor: string | null;
      precio: string | null;
    }>(`
      SELECT
        i.id::text,
        i.nombre,
        i.categoria::text AS categoria,
        i.unidad_compra::text AS unidad,
        i.stock_actual::text AS stock,
        i.stock_minimo::text AS minimo,
        p.nombre AS proveedor,
        ip.precio_ultimo::text AS precio
      FROM insumos i
      LEFT JOIN proveedores p ON p.id = i.proveedor_principal_id
      LEFT JOIN insumo_proveedores ip ON ip.insumo_id = i.id AND ip.es_principal = true
      WHERE i.activo = true
      ORDER BY i.categoria, i.nombre
      LIMIT 200
    `),
    query<{
      id: string;
      numero: string;
      fecha: string;
      total: string;
      pagado: string;
      estado: string;
      proveedor: string;
    }>(`
      SELECT
        f.id::text,
        f.numero,
        f.fecha_emision::text AS fecha,
        f.total::text AS total,
        f.total_pagado::text AS pagado,
        f.estado::text AS estado,
        p.nombre AS proveedor
      FROM facturas_recibidas f
      JOIN proveedores p ON p.id = f.proveedor_id
      ORDER BY f.fecha_emision DESC
      LIMIT 100
    `),
    queryOne<{ por_pagar: string; facturas_pendientes: number; bajo_stock: number }>(`
      SELECT
        COALESCE((SELECT SUM(total - total_pagado) FROM facturas_recibidas WHERE total > total_pagado), 0)::text AS por_pagar,
        (SELECT COUNT(*) FROM facturas_recibidas WHERE total > total_pagado)::int AS facturas_pendientes,
        (SELECT COUNT(*) FROM insumos WHERE activo = true AND stock_minimo IS NOT NULL AND stock_actual <= stock_minimo)::int AS bajo_stock
    `),
  ]);

  return NextResponse.json({ insumos, facturas, resumen });
}
