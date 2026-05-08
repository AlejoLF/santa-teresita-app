/**
 * Reporta el estado actual de la cloud DB: cuenta filas en cada tabla
 * principal para sanity-check post-bootstrap.
 */

import { Client } from 'pg';
import { pooledUrl, maskUrl } from './_url.mjs';

const TABLAS_CLAVE = [
  'usuarios',
  'categorias_movimiento',
  'cuentas',
  'cuentas_a_cobrar',
  'listas_precios',
  'clientes',
  'categorias',
  'tipos_producto',
  'productos',
  'grupos_modificador',
  'opciones_modificador',
  'modificadores_aplicables',
  'combos',
  'componentes_combo',
  'sesiones_caja',
  'ventas',
  'items_venta',
  'movimientos',
  'pagos',
  'audit_log',
  'sync_inbox',
  '_prisma_migrations',
];

async function main() {
  const url = pooledUrl();
  console.log(`▸ Pooler: ${maskUrl(url)}\n`);
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('━━ Conteo de filas ━━');
  let totalFilas = 0;
  for (const t of TABLAS_CLAVE) {
    try {
      const r = await client.query(`SELECT count(*)::int as n FROM public."${t}"`);
      const n = r.rows[0].n;
      totalFilas += n;
      const flag = n > 0 ? '✓' : '·';
      console.log(`  ${flag} ${t.padEnd(28)} ${String(n).padStart(6)}`);
    } catch (e) {
      console.log(`  ✕ ${t.padEnd(28)} (no existe: ${e.message.slice(0, 50)})`);
    }
  }
  console.log(`\n  total filas: ${totalFilas}`);

  // Conteo total de tablas
  const totalT = await client.query(
    `SELECT count(*)::int as n FROM pg_tables WHERE schemaname = 'public'`,
  );
  console.log(`  total tablas en public: ${totalT.rows[0].n}`);

  // RLS status
  const rls = await client.query(
    `SELECT count(*)::int as enabled FROM pg_class c
     JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true`,
  );
  console.log(`  tablas con RLS habilitado: ${rls.rows[0].enabled}`);

  await client.end();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
