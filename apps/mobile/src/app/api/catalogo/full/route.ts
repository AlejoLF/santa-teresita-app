import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/catalogo/full
 *
 * Catálogo completo para el vendedor mobile: categorías + productos activos
 * con sabores (opciones del primer grupo modificador). Es un solo endpoint
 * porque mobile necesita el catálogo entero al abrir cargar-pedido — el
 * payload ronda los 100 KB para ~300 productos, aceptable para un PWA con
 * cache de Service Worker.
 *
 * Diferencias vs el desktop:
 *   - No expone modificadores complejos ni precios por lista.
 *   - No hereda del tipoProducto: solo modificadores directos del producto
 *     (suficiente para el flujo simple).
 *   - Si el producto no tiene grupo, sabores=[].
 */
export async function GET() {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  // Categorías
  const categorias = await query<{
    id: string;
    nombre: string;
    icono: string | null;
    orden: number;
  }>(
    `SELECT id::text, nombre, icono, orden
     FROM categorias
     WHERE activa = true
     ORDER BY orden, nombre`,
  );

  // Productos con tipo + categoría
  const productos = await query<{
    id: string;
    codigo: string | null;
    nombre: string;
    precio_base: string;
    forma_venta: string;
    unidad_precio: string;
    cantidad_default: string | null;
    incluye_salsa: 'SIMPLE' | 'ESPECIAL' | null;
    tipo_id: string;
    tipo_nombre: string;
    cocina_interviene: boolean;
    categoria_id: string;
    categoria_nombre: string;
  }>(
    `SELECT
       p.id::text,
       p.codigo,
       p.nombre,
       p.precio_base::text AS precio_base,
       p.forma_venta::text AS forma_venta,
       p.unidad_precio::text AS unidad_precio,
       p.cantidad_default::text AS cantidad_default,
       CASE
         WHEN LOWER(tp.nombre) LIKE '%porción simple' THEN 'SIMPLE'
         WHEN LOWER(tp.nombre) LIKE '%porción especial' THEN 'ESPECIAL'
         ELSE NULL
       END::text AS incluye_salsa,
       tp.id::text AS tipo_id,
       tp.nombre AS tipo_nombre,
       tp.cocina_interviene,
       cat.id::text AS categoria_id,
       cat.nombre AS categoria_nombre
     FROM productos p
     JOIN tipos_producto tp ON tp.id = p.tipo_producto_id
     JOIN categorias cat ON cat.id = tp.categoria_id
     WHERE p.activo = true AND tp.activo = true AND cat.activa = true
     ORDER BY cat.orden, tp.orden, p.codigo NULLS LAST, p.nombre`,
  );

  // Sabores: para cada producto, el primer grupo modificador (directo o
  // heredado del tipo). Si hay un override directo (productoId definido),
  // tiene prioridad sobre el heredado.
  const sabores = await query<{
    producto_id: string;
    grupo_id: string;
    grupo_nombre: string;
    opcion_id: string;
    nombre: string;
    delta_precio: string;
    codigo: string | null;
  }>(
    `WITH primer_grupo AS (
       SELECT DISTINCT ON (p.id)
         p.id AS producto_id,
         g.id AS grupo_id,
         g.nombre AS grupo_nombre
       FROM productos p
       JOIN modificadores_aplicables ma
         ON (ma.producto_id = p.id)
         OR (ma.producto_id IS NULL AND ma.tipo_producto_id = p.tipo_producto_id)
       JOIN grupos_modificador g ON g.id = ma.grupo_modificador_id
       WHERE p.activo = true
       ORDER BY p.id, ma.producto_id NULLS LAST, g.nombre
     )
     SELECT
       pg.producto_id::text,
       pg.grupo_id::text,
       pg.grupo_nombre,
       om.id::text AS opcion_id,
       om.nombre,
       om.delta_precio::text AS delta_precio,
       om.codigo
     FROM primer_grupo pg
     JOIN opciones_modificador om ON om.grupo_id = pg.grupo_id AND om.activa = true
     ORDER BY pg.producto_id, om.orden, om.nombre`,
  );

  // Agrupamos sabores por producto_id
  const saboresPorProducto = new Map<string, typeof sabores>();
  for (const s of sabores) {
    const arr = saboresPorProducto.get(s.producto_id) ?? [];
    arr.push(s);
    saboresPorProducto.set(s.producto_id, arr);
  }

  // Estructura final
  const productosConSabores = productos.map((p) => ({
    id: p.id,
    codigo: p.codigo,
    nombre: p.nombre,
    precioBase: p.precio_base,
    formaVenta: p.forma_venta,
    unidadPrecio: p.unidad_precio,
    cantidadDefault: p.cantidad_default,
    incluyeSalsa: p.incluye_salsa,
    tipo: {
      id: p.tipo_id,
      nombre: p.tipo_nombre,
      cocinaInterviene: p.cocina_interviene,
    },
    categoriaId: p.categoria_id,
    sabores: (saboresPorProducto.get(p.id) ?? []).map((s) => ({
      opcionId: s.opcion_id,
      grupoId: s.grupo_id,
      grupoNombre: s.grupo_nombre,
      nombre: s.nombre,
      deltaPrecio: s.delta_precio,
      codigo: s.codigo,
    })),
  }));

  return NextResponse.json({
    categorias: categorias.map((c) => ({
      id: c.id,
      nombre: c.nombre,
      icono: c.icono,
    })),
    productos: productosConSabores,
  });
}
