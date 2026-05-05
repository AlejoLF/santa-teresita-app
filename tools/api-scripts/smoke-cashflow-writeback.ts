/**
 * Smoke test del writeback al CASHFLOW Excel.
 *
 *   pnpm --filter @sta/api exec tsx src/scripts/smoke-cashflow-writeback.ts [--fecha=YYYY-MM-DD]
 *
 * Sin --fecha usa "ayer" (donde el generar-dia-prueba.ts dejó datos).
 */

import { actualizarCashflow } from '../services/excel-writeback.js';

async function main() {
  const args = process.argv.slice(2);
  const fechaArg = args.find((a) => a.startsWith('--fecha='))?.split('=')[1];
  const fecha = fechaArg ? new Date(fechaArg) : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  })();
  fecha.setHours(0, 0, 0, 0);

  console.log(`▸ Sincronizando CASHFLOW para ${fecha.toISOString().slice(0, 10)}`);
  const r = await actualizarCashflow({ fecha });

  console.log(`  ✓ archivo: ${r.archivoPath}`);
  console.log(`  ✓ hoja: ${r.hoja}, columna ${r.columna} (${r.diaLabel})`);
  console.log(`  ✓ ${r.cambios.length} celdas actualizadas:`);
  for (const c of r.cambios) {
    console.log(`      ${c.celda} ${c.etiqueta.padEnd(30)} ${c.valorAnterior} → ${c.valorNuevo}`);
  }
  if (r.warnings.length > 0) {
    console.log('  ⚠ warnings:');
    for (const w of r.warnings) console.log('      -', w);
  }
  process.exit(0);
}

void main().catch((e) => {
  console.error('❌ Error:', e);
  process.exit(1);
});
