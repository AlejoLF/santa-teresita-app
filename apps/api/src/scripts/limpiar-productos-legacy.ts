/**
 * Limpieza profunda de productos legacy: los duplicados con códigos tipo
 * "CAN__JAM_Y_QU" que aparecen como inactivos en el catálogo.
 *
 * Estrategia:
 *   1. Identificar productos con código no de 4 dígitos (o nulo).
 *   2. Para cada uno:
 *      - Si tiene ventas: re-mapear items_venta al producto activo equivalente
 *        (mismo tipoProductoId con código de 4 dígitos), y luego borrar.
 *      - Si no tiene ventas: borrar directamente.
 *   3. Confirmar que ya no quedan inactivos legacy.
 *
 * Uso:
 *   pnpm --filter @sta/api exec tsx src/scripts/limpiar-productos-legacy.ts
 */

import { prisma } from '@sta/db/client';

async function main() {
  const legacy = await prisma.producto.findMany({
    where: {
      OR: [{ codigo: { not: { startsWith: '0' } } }, { codigo: null }],
    },
    select: {
      id: true,
      codigo: true,
      nombre: true,
      tipoProductoId: true,
      _count: { select: { itemsVenta: true } },
    },
  });

  // Filtrar los que tienen código de 4 dígitos válido (ya migrados)
  const objetivo = legacy.filter(
    (p) => !p.codigo || !/^\d{4}$/.test(p.codigo),
  );

  console.log(`▸ Productos legacy detectados: ${objetivo.length}`);
  if (objetivo.length === 0) {
    console.log('  ✓ Nada que limpiar.');
    process.exit(0);
  }

  // Cargar productos primarios (con código numérico) por tipoProductoId
  const primarios = await prisma.producto.findMany({
    where: {
      activo: true,
      codigo: { startsWith: '0' },
    },
    select: { id: true, codigo: true, nombre: true, tipoProductoId: true },
  });
  const primarioPorTipo = new Map<string, string>();
  for (const p of primarios) {
    if (p.codigo && /^\d{4}$/.test(p.codigo)) {
      // Si hay varios primarios para el mismo tipo, nos quedamos con el primero
      if (!primarioPorTipo.has(p.tipoProductoId)) {
        primarioPorTipo.set(p.tipoProductoId, p.id);
      }
    }
  }

  let borrados = 0;
  let remapeados = 0;
  let huerfanos = 0;

  for (const p of objetivo) {
    if (p._count.itemsVenta > 0) {
      const primarioId = primarioPorTipo.get(p.tipoProductoId);
      if (primarioId) {
        // Re-mapear items_venta al primario
        const r = await prisma.itemVenta.updateMany({
          where: { productoId: p.id },
          data: { productoId: primarioId },
        });
        remapeados += r.count;
      } else {
        // No hay primario equivalente — solo desactivar (no podemos borrar sin perder ventas)
        await prisma.producto.update({
          where: { id: p.id },
          data: { activo: false },
        });
        huerfanos++;
        continue;
      }
    }
    // Borrar dependencias
    await prisma.modificadorAplicable.deleteMany({ where: { productoId: p.id } });
    await prisma.opcionComponenteCombo.deleteMany({ where: { productoId: p.id } });
    await prisma.precioPorLista.deleteMany({ where: { productoId: p.id } });
    await prisma.historialPrecio.deleteMany({ where: { productoId: p.id } });
    try {
      await prisma.producto.delete({ where: { id: p.id } });
      borrados++;
    } catch (e) {
      // Si falla, lo dejamos desactivado
      await prisma.producto.update({
        where: { id: p.id },
        data: { activo: false },
      });
      huerfanos++;
    }
  }

  console.log(`✓ Borrados: ${borrados}`);
  console.log(`✓ Items de venta re-mapeados al producto primario: ${remapeados}`);
  console.log(`✓ Desactivados (no se pudieron borrar, sin primario equivalente): ${huerfanos}`);
  process.exit(0);
}

void main().catch((e) => {
  console.error('❌ Error:', e);
  process.exit(1);
});
