/**
 * PONER AL DÍA LAS FACTURAS DE PROVEEDOR CONTRA LOS PAGOS YA CARGADOS.
 *
 * Durante meses, los egresos a proveedores cargados desde "Aportes y egresos"
 * movían la plata pero no tocaban ninguna factura: el saldo del proveedor no
 * bajaba y las facturas quedaban en PENDIENTE_PAGO para siempre. El fix del
 * código arregla los pagos NUEVOS; esto arregla los que ya están cargados.
 *
 * Qué hace:
 *   1. Junta, por proveedor, toda la plata que se le pagó y que NO está
 *      imputada a ninguna factura (egresos confirmados sin `pagos_factura`).
 *   2. La reparte contra sus facturas impagas, de la más vieja a la más nueva.
 *   3. Actualiza `total_pagado` y el estado (PAGADA / PAGADA_PARCIAL), y deja
 *      la fila en `pagos_factura` para que quede el rastro de qué pago saldó qué.
 *
 * ⚠️ EL REPARTO ES UNA SUPOSICIÓN. Nadie registró contra qué factura fue cada
 * pago, así que asume "lo más viejo primero", que es como se paga en la
 * práctica. Si un pago en particular fue por otra factura, va a quedar mal
 * imputado — el TOTAL adeudado del proveedor queda bien igual, porque es la
 * misma plata repartida distinto.
 *
 * Uso:
 *   node scripts/cloud/imputar-pagos-proveedores.mjs            # informe, no toca nada
 *   node scripts/cloud/imputar-pagos-proveedores.mjs --aplicar  # escribe
 *   node scripts/cloud/imputar-pagos-proveedores.mjs --local    # contra la DB local
 *
 * Es idempotente: correrlo dos veces no imputa dos veces (la segunda vez ya no
 * quedan pagos sin imputar).
 */

import { Client } from 'pg';
import { pooledUrl, maskUrl } from './_url.mjs';

const APLICAR = process.argv.includes('--aplicar');
const LOCAL = process.argv.includes('--local');

const money = (n) =>
  '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Number(Number(n).toFixed(2));

async function main() {
  const url = LOCAL ? process.env.DATABASE_URL : pooledUrl();
  if (!url) throw new Error('Falta DATABASE_URL (con --local) o la config de Supabase');
  console.log(`\n▸ Base: ${LOCAL ? url.replace(/:[^:@]*@/, ':***@') : maskUrl(url)}`);
  console.log(`▸ Modo: ${APLICAR ? 'APLICAR (escribe)' : 'informe (no toca nada)'}\n`);

  const db = new Client({ connectionString: url });
  await db.connect();

  try {
    // ── 1. Pagos a proveedores que no están imputados a ninguna factura ──
    //
    // `entidad_id` es polimórfico (empleado o proveedor), así que el JOIN
    // contra `proveedores` es lo que decide que el egreso es a un proveedor —
    // no la categoría, que puede estar mal elegida.
    const { rows: pagosSueltos } = await db.query(`
      SELECT m.id,
             m.entidad_id       AS proveedor_id,
             p.nombre           AS proveedor,
             m.monto,
             m.fecha_computo,
             m.observacion
        FROM movimientos m
        JOIN proveedores p ON p.id = m.entidad_id
       WHERE m.tipo = 'EGRESO'
         AND m.estado = 'CONFIRMADO'
         AND NOT EXISTS (
               SELECT 1 FROM movimiento_facturas mf WHERE mf.movimiento_id = m.id
             )
       ORDER BY p.nombre, m.fecha_computo ASC
    `);

    if (pagosSueltos.length === 0) {
      console.log('✓ No hay pagos a proveedores sin imputar. Nada que hacer.\n');
      return;
    }

    // ── 2. Facturas impagas, de la más vieja a la más nueva ──
    const { rows: facturas } = await db.query(`
      SELECT f.id,
             f.proveedor_id,
             f.punto_venta,
             f.numero,
             f.fecha_emision,
             f.total,
             f.total_pagado,
             f.estado
        FROM facturas_recibidas f
       WHERE f.estado IN ('PENDIENTE_PAGO', 'PAGADA_PARCIAL')
       ORDER BY f.proveedor_id, f.fecha_emision ASC, f.numero ASC
    `);

    const porProveedor = new Map();
    for (const m of pagosSueltos) {
      const e = porProveedor.get(m.proveedor_id) ?? {
        nombre: m.proveedor,
        pagos: [],
        facturas: [],
      };
      e.pagos.push(m);
      porProveedor.set(m.proveedor_id, e);
    }
    for (const f of facturas) {
      const e = porProveedor.get(f.proveedor_id);
      if (e) e.facturas.push(f);
    }

    // ── 3. Repartir ──
    let totalPagos = 0;
    let totalImputado = 0;
    let totalSobrante = 0;
    let facturasCerradas = 0;
    let facturasParciales = 0;
    const escrituras = [];

    for (const [, e] of [...porProveedor].sort((a, b) => a[1].nombre.localeCompare(b[1].nombre))) {
      const suma = r2(e.pagos.reduce((a, m) => a + Number(m.monto), 0));
      const deuda = r2(e.facturas.reduce((a, f) => a + (Number(f.total) - Number(f.total_pagado)), 0));
      totalPagos += suma;

      console.log(`${e.nombre}`);
      console.log(
        `   ${e.pagos.length} pago${e.pagos.length > 1 ? 's' : ''} sin imputar por ${money(suma)} · ${e.facturas.length} factura${e.facturas.length === 1 ? '' : 's'} impaga${e.facturas.length === 1 ? '' : 's'} por ${money(deuda)}`,
      );

      if (e.facturas.length === 0) {
        console.log(`   → sin facturas cargadas: los ${money(suma)} quedan como pago a cuenta\n`);
        totalSobrante += suma;
        continue;
      }

      // El reparto va pago por pago para que cada `pagos_factura` cuelgue del
      // pago real que lo cubrió, y no de uno cualquiera.
      let iFactura = 0;
      let restaEnFactura =
        e.facturas.length > 0
          ? r2(Number(e.facturas[0].total) - Number(e.facturas[0].total_pagado))
          : 0;
      const aplicadoPorFactura = new Map();

      for (const pago of e.pagos) {
        let porRepartir = Number(pago.monto);
        while (porRepartir > 0.004 && iFactura < e.facturas.length) {
          if (restaEnFactura <= 0.004) {
            iFactura += 1;
            if (iFactura >= e.facturas.length) break;
            restaEnFactura = r2(
              Number(e.facturas[iFactura].total) - Number(e.facturas[iFactura].total_pagado),
            );
            continue;
          }
          const f = e.facturas[iFactura];
          const trozo = r2(Math.min(porRepartir, restaEnFactura));
          escrituras.push({ movimientoId: pago.id, facturaId: f.id, monto: trozo });
          aplicadoPorFactura.set(f.id, r2((aplicadoPorFactura.get(f.id) ?? 0) + trozo));
          porRepartir = r2(porRepartir - trozo);
          restaEnFactura = r2(restaEnFactura - trozo);
          totalImputado += trozo;
        }
        if (porRepartir > 0.004) totalSobrante += porRepartir;
      }

      for (const f of e.facturas) {
        const aplicado = aplicadoPorFactura.get(f.id);
        if (!aplicado) continue;
        const nuevoPagado = r2(Number(f.total_pagado) + aplicado);
        const queda = r2(Number(f.total) - nuevoPagado);
        const cerrada = queda <= 0.01;
        if (cerrada) facturasCerradas += 1;
        else facturasParciales += 1;
        const nro = f.punto_venta ? `${f.punto_venta}-${f.numero}` : f.numero;
        console.log(
          `   → ${nro} (${money(f.total)}): +${money(aplicado)} → ${cerrada ? 'PAGADA' : `PAGADA_PARCIAL, le quedan ${money(queda)}`}`,
        );
      }
      const sobra = r2(suma - [...aplicadoPorFactura.values()].reduce((a, v) => a + v, 0));
      if (sobra > 0.01) console.log(`   → sobran ${money(sobra)}: quedan a cuenta del proveedor`);
      console.log('');
    }

    console.log('───────────────────────────────────────────────');
    console.log(`Pagos sin imputar encontrados:  ${money(totalPagos)} (${pagosSueltos.length} movimientos)`);
    console.log(`Se imputa a facturas:           ${money(totalImputado)}`);
    console.log(`Queda a cuenta (sin factura):   ${money(totalSobrante)}`);
    console.log(`Facturas que pasan a PAGADA:    ${facturasCerradas}`);
    console.log(`Facturas que quedan PARCIAL:    ${facturasParciales}`);
    console.log('───────────────────────────────────────────────\n');

    if (!APLICAR) {
      console.log('Esto fue sólo el informe. Para escribirlo:');
      console.log(`  node scripts/cloud/imputar-pagos-proveedores.mjs --aplicar${LOCAL ? ' --local' : ''}\n`);
      return;
    }

    // ── 4. Escribir, todo o nada ──
    await db.query('BEGIN');
    try {
      for (const w of escrituras) {
        // `pagos_factura.pago_id` es NOT NULL, así que hace falta el `Pago` del
        // movimiento. Los egresos cargados desde "Aportes y egresos" no tienen
        // uno (son sólo un movimiento), así que se crea acá: sin él no hay
        // dónde colgar la imputación.
        const { rows: pagoRows } = await db.query(
          `SELECT id FROM pagos WHERE movimiento_id = $1 ORDER BY fecha ASC LIMIT 1`,
          [w.movimientoId],
        );
        let pagoId = pagoRows[0]?.id;
        if (!pagoId) {
          const { rows: movRows } = await db.query(
            `SELECT monto, cuenta_origen_id, fecha_computo FROM movimientos WHERE id = $1`,
            [w.movimientoId],
          );
          const mv = movRows[0];
          if (!mv?.cuenta_origen_id) {
            throw new Error(
              `El movimiento ${w.movimientoId} no tiene cuenta de origen: no se le puede crear el pago. Revisalo a mano.`,
            );
          }
          const { rows: nuevo } = await db.query(
            `INSERT INTO pagos (id, movimiento_id, metodo, cuenta_id, monto, estado, fecha)
             VALUES (gen_random_uuid(), $1, 'OTRO', $2, $3, 'CONFIRMADO', $4)
             RETURNING id`,
            [w.movimientoId, mv.cuenta_origen_id, mv.monto, mv.fecha_computo],
          );
          pagoId = nuevo[0].id;
        }

        await db.query(
          `INSERT INTO pagos_factura (id, pago_id, factura_id, movimiento_id, monto_aplicado, orden)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 0)`,
          [pagoId, w.facturaId, w.movimientoId, w.monto],
        );
        await db.query(
          `INSERT INTO movimiento_facturas (movimiento_id, factura_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [w.movimientoId, w.facturaId],
        );
        await db.query(
          `UPDATE facturas_recibidas
              SET total_pagado = total_pagado + $2,
                  estado = CASE WHEN total - (total_pagado + $2) <= 0.01
                                THEN 'PAGADA'::"EstadoFacturaRecibida"
                                ELSE 'PAGADA_PARCIAL'::"EstadoFacturaRecibida" END,
                  pagada_at = CASE WHEN total - (total_pagado + $2) <= 0.01
                                   THEN COALESCE(pagada_at, now())
                                   ELSE NULL END
            WHERE id = $1`,
          [w.facturaId, w.monto],
        );
      }
      await db.query('COMMIT');
      console.log(`✓ Aplicado: ${escrituras.length} imputaciones escritas.\n`);
    } catch (e) {
      await db.query('ROLLBACK');
      console.error('✗ Nada se escribió (rollback):', e.message, '\n');
      process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
