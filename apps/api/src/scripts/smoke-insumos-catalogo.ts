import { prisma } from '@sta/db/client';

const insumos = await prisma.insumo.findMany({
  include: {
    proveedorPrincipal: true,
    proveedoresVinculo: { include: { proveedor: true } },
  },
  take: 10,
});

console.log(`▸ ${insumos.length} insumos en catálogo`);
for (const i of insumos.slice(0, 5)) {
  console.log(
    `  ${i.nombre} (${i.categoria}) — ${i.proveedoresVinculo.length} proveedores · principal: ${i.proveedorPrincipal?.nombre ?? '—'}`,
  );
}
process.exit(0);
