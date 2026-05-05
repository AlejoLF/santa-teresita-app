/**
 * Smoke test del servicio de Excel sync.
 * Corre detección sobre Lista de Precios + Proveedores y reporta el resultado.
 *
 * Uso (desde apps/api):
 *   tsx src/scripts/smoke-excel-sync.ts
 */

import {
  detectarCambiosListaPrecios,
  detectarCambiosProveedores,
} from '../services/excel-sync.js';

async function main() {
  console.log('━━━ Lista de Precios ━━━');
  try {
    const r = await detectarCambiosListaPrecios({ modificadoPor: 'smoke-test' });
    console.log('  aprobacionId:', r.aprobacion.id);
    console.log('  cambios aplicables :', r.diff.resumen.cambiosAplicables);
    console.log('  sospechosos        :', r.diff.resumen.sospechosos);
    console.log('  errores            :', r.diff.resumen.errores);
    console.log('  sin cambios        :', r.diff.resumen.sinCambios);
    if (r.diff.cambios.length > 0) {
      console.log('  primeros 3 cambios :');
      for (const c of r.diff.cambios.slice(0, 3)) {
        console.log(
          `    ${c.codigo ?? '----'} ${c.nombreProducto.padEnd(35)} ${c.precioAnterior} → ${c.precioNuevo} (${c.deltaPct > 0 ? '+' : ''}${c.deltaPct}%)`,
        );
      }
    }
  } catch (e) {
    console.error('  ERROR:', e instanceof Error ? e.message : e);
  }

  console.log('\n━━━ Proveedores 2026 ━━━');
  try {
    const r = await detectarCambiosProveedores({ modificadoPor: 'smoke-test' });
    console.log('  aprobacionId:', r.aprobacion.id);
    console.log('  cambios aplicables :', r.diff.resumen.cambiosAplicables);
    console.log('  sospechosos        :', r.diff.resumen.sospechosos);
    console.log('  errores            :', r.diff.resumen.errores);
    console.log('  sin cambios        :', r.diff.resumen.sinCambios);
  } catch (e) {
    console.error('  ERROR:', e instanceof Error ? e.message : e);
  }

  process.exit(0);
}

void main();
