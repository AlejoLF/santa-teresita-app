import { prisma } from '@sta/db/client';

const cnt = await prisma.venta.count({ where: { estado: 'FINALIZADA' } });
console.log('Total finalizadas:', cnt);
const vs = await prisma.venta.findMany({
  where: { estado: 'FINALIZADA' },
  orderBy: { fechaFinalizacion: 'desc' },
  take: 3,
  select: {
    fechaFinalizacion: true,
    sesionCaja: { select: { fecha: true, turno: true } },
  },
});
for (const v of vs) {
  console.log({
    fechaFinalizacion: v.fechaFinalizacion?.toISOString(),
    sesionFecha: v.sesionCaja?.fecha?.toISOString(),
    turno: v.sesionCaja?.turno,
  });
}
process.exit(0);
