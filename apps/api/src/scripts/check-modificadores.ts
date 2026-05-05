import { prisma } from '@sta/db/client';

const productos = await prisma.producto.findMany({
  where: { activo: true },
  include: {
    tipoProducto: {
      include: {
        modificadores: {
          include: {
            grupoModificador: {
              include: { opciones: { where: { activa: true } } },
            },
          },
        },
      },
    },
    modificadores: {
      include: {
        grupoModificador: {
          include: { opciones: { where: { activa: true }, orderBy: { orden: 'asc' } } },
        },
      },
    },
  },
  orderBy: { codigo: 'asc' },
});

// Combinar mods propios + del tipo
const productosConMods = productos.map((p) => ({
  ...p,
  modificadores: [...p.modificadores, ...p.tipoProducto.modificadores],
}));

console.log(`Total productos activos: ${productos.length}`);
console.log();

const productosFinal = productosConMods;
const conSabores = productosFinal.filter((p) => p.modificadores.length > 0);
console.log(`Productos con modificadores: ${conSabores.length}`);
console.log();

console.log('Primeros 10 con modificadores:');
for (const p of conSabores.slice(0, 10)) {
  const grupo = p.modificadores[0]?.grupoModificador;
  const opciones = grupo?.opciones.map((o) => o.nombre).join(', ') ?? '—';
  console.log(`  ${p.codigo} ${p.nombre.padEnd(30)} | ${grupo?.nombre ?? '—'}: ${opciones}`);
}

console.log();
console.log('Pizza / Salsa específicamente:');
for (const p of productosFinal.filter((p) =>
  /pizza|salsa|ravioles|sorrent/i.test(p.nombre),
)) {
  const mods = p.modificadores.length;
  const grupo = p.modificadores[0]?.grupoModificador;
  console.log(
    `  ${p.codigo} ${p.nombre.padEnd(30)} | mods: ${mods} | grupo: ${grupo?.nombre ?? '—'} | opciones: ${grupo?.opciones.length ?? 0}`,
  );
}

process.exit(0);
