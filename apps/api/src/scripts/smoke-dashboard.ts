/**
 * Smoke test del dashboard endpoint — corre las mismas queries que el endpoint
 * y muestra los KPIs nuevos (efectivo, tarjeta, aportes, egresos con desgloses).
 */

import { prisma } from '@sta/db/client';

async function main() {
  const ahora = new Date();
  const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());

  // Como el día de prueba está en "ayer", lo simulo desplazando inicioHoy.
  const arg = process.argv.find((a) => a.startsWith('--fecha='));
  const fechaInicio = arg
    ? (() => {
        const [y, m, d] = arg.split('=')[1]!.split('-').map(Number);
        return new Date(y!, (m ?? 1) - 1, d ?? 1);
      })()
    : new Date(inicioHoy.getTime() - 86_400_000); // ayer
  fechaInicio.setHours(0, 0, 0, 0);
  const fechaFin = new Date(fechaInicio.getTime() + 86_400_000);

  console.log(
    `▸ Probando con fechas ${fechaInicio.toISOString().slice(0, 10)} (00:00 → 24:00)`,
  );
  console.log();

  // Pagos del día — filtramos por sesionCaja.fecha (más robusto frente a TZ
  // que filtrar por fechaFinalizacion timestamp).
  const pagos = await prisma.pago.findMany({
    where: {
      estado: 'CONFIRMADO',
      venta: {
        estado: 'FINALIZADA',
        sesionCaja: { fecha: fechaInicio },
      },
    },
    select: {
      metodo: true,
      monto: true,
      venta: { select: { canal: true, modalidad: true } },
    },
  });
  console.log(`  ${pagos.length} pagos encontrados\n`);

  let efectMostrador = 0,
    efectDamian = 0,
    efectDeliverate = 0;
  let tjDebito = 0,
    tjCredito = 0,
    tjMpQr = 0,
    tjTransfer = 0,
    tjOtro = 0;

  for (const p of pagos) {
    const m = Number(p.monto);
    const canal = p.venta?.canal ?? 'MOSTRADOR';
    const modalidad = p.venta?.modalidad ?? 'TAKE_AWAY';
    const esDamian =
      (canal === 'TELEFONO' || canal === 'WHATSAPP') &&
      modalidad === 'DELIVERY_PROPIO' &&
      p.metodo === 'EFECTIVO';
    if (p.metodo === 'EFECTIVO') {
      if (canal === 'DELIVERATE') efectDeliverate += m;
      else if (esDamian) efectDamian += m;
      else efectMostrador += m;
    } else if (canal !== 'DELIVERATE') {
      if (p.metodo === 'DEBITO') tjDebito += m;
      else if (
        p.metodo === 'CREDITO_1_PAGO' ||
        p.metodo === 'CREDITO_CUOTAS' ||
        p.metodo === 'TARJETA_NARANJA'
      )
        tjCredito += m;
      else if (p.metodo === 'MERCADOPAGO_QR') tjMpQr += m;
      else if (p.metodo === 'TRANSFERENCIA' || p.metodo === 'DEPOSITO') tjTransfer += m;
      else tjOtro += m;
    }
  }

  const ingresosMov = await prisma.movimiento.groupBy({
    by: ['categoriaId'],
    _sum: { monto: true },
    _count: { _all: true },
    where: {
      tipo: 'INGRESO',
      estado: 'CONFIRMADO',
      fechaComputo: { gte: fechaInicio, lt: fechaFin },
    },
  });
  const egresosMov = await prisma.movimiento.groupBy({
    by: ['categoriaId'],
    _sum: { monto: true },
    _count: { _all: true },
    where: {
      tipo: 'EGRESO',
      estado: 'CONFIRMADO',
      fechaComputo: { gte: fechaInicio, lt: fechaFin },
    },
  });

  const totalEfectivo = efectMostrador + efectDamian;
  const totalTarjeta = tjDebito + tjCredito + tjMpQr + tjTransfer + tjOtro;
  const totalAportes = ingresosMov.reduce((a, x) => a + Number(x._sum.monto ?? 0), 0);
  const totalEgresos = egresosMov.reduce((a, x) => a + Number(x._sum.monto ?? 0), 0);

  const fmt = (n: number) =>
    new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 2,
    }).format(n);

  console.log('━━━ COBRADO EN EFECTIVO (suma a caja) ━━━');
  console.log(`  Mostrador:           ${fmt(efectMostrador)}`);
  console.log(`  Damián (delivery):   ${fmt(efectDamian)}`);
  console.log(`  TOTAL:               ${fmt(totalEfectivo)}`);
  console.log(`  --- informativo ---`);
  console.log(`  DELIVERATE:          ${fmt(efectDeliverate)}  (no suma)`);
  console.log();

  console.log('━━━ COBRADO CON TARJETA ━━━');
  console.log(`  Débito:              ${fmt(tjDebito)}`);
  console.log(`  Crédito:             ${fmt(tjCredito)}`);
  console.log(`  MercadoPago / QR:    ${fmt(tjMpQr)}`);
  console.log(`  Transferencia:       ${fmt(tjTransfer)}`);
  console.log(`  Otro:                ${fmt(tjOtro)}`);
  console.log(`  TOTAL:               ${fmt(totalTarjeta)}`);
  console.log();

  console.log(`━━━ APORTES (${ingresosMov.length} categorías) ━━━`);
  console.log(`  TOTAL:               ${fmt(totalAportes)}`);
  console.log();

  console.log(`━━━ EGRESOS (${egresosMov.length} categorías) ━━━`);
  console.log(`  TOTAL:               ${fmt(totalEgresos)}`);

  process.exit(0);
}

void main().catch((e) => {
  console.error('❌ Error:', e);
  process.exit(1);
});
