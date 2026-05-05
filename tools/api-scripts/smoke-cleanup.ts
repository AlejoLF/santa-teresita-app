import { prisma } from '@sta/db/client';

// Restaurar el precio del producto 0001
await prisma.producto.updateMany({
  where: { codigo: '0001' },
  data: { precioBase: '7650.00' },
});
console.log('✓ Precio de Ravioles (0001) restaurado a 7650.00');

// Borrar las aprobaciones generadas por el smoke test
const del = await prisma.aprobacionExcel.deleteMany({
  where: { modificadoPor: 'smoke-test' },
});
console.log(`✓ ${del.count} aprobaciones de smoke-test eliminadas`);

// Borrar también el historial generado por el smoke test (si quedó alguno)
const histDel = await prisma.historialPrecio.deleteMany({
  where: { motivo: { contains: 'Sync Lista de Precios.xlsx' } },
});
console.log(`✓ ${histDel.count} entradas de historial limpiadas`);

process.exit(0);
