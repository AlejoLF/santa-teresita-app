import { prisma } from '@sta/db/client';

const p = await prisma.producto.findFirst({ where: { codigo: '0001' } });
console.log('antes:', p?.codigo, p?.nombre, 'precio:', p?.precioBase.toString());
if (p) {
  await prisma.producto.update({
    where: { id: p.id },
    data: { precioBase: '7000.00' },
  });
  const p2 = await prisma.producto.findFirst({ where: { codigo: '0001' } });
  console.log('después:', p2?.precioBase.toString());
}
process.exit(0);
