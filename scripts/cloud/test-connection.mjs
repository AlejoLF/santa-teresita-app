/**
 * Verifica conectividad con la cloud DB de Supabase.
 *
 *   pnpm cloud:test
 *
 * Prueba primero el direct (5432, IPv6) — si falla por IPv6 not reachable y
 * sí por la pooled (6543, IPv4), eso ya nos dice que la red local es IPv4-only
 * y vamos a tener que usar siempre el pooler.
 *
 * Loggea sin exponer credenciales.
 */

import { Client } from 'pg';
import { directUrl, pooledUrl, supabaseRef, maskUrl } from './_url.mjs';

async function probar(label, url) {
  console.log(`\n━━ ${label}`);
  console.log(`   URL:  ${maskUrl(url)}`);
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const t0 = Date.now();
  try {
    await c.connect();
    const r = await c.query(
      `SELECT version() as v, current_database() as db, current_user as u, inet_server_addr() as ip`,
    );
    console.log(`   OK   (${Date.now() - t0}ms)`);
    console.log(`   db:  ${r.rows[0].db}  user: ${r.rows[0].u}  ip: ${r.rows[0].ip ?? 'n/a'}`);
    console.log(`   ver: ${r.rows[0].v.slice(0, 70)}...`);
    await c.end();
    return true;
  } catch (e) {
    console.log(`   FAIL (${Date.now() - t0}ms): ${e.message}  [code: ${e.code ?? '-'}]`);
    try { await c.end(); } catch {}
    return false;
  }
}

(async () => {
  console.log(`▸ Project ref: ${supabaseRef()}`);
  const directOk = await probar('Direct (puerto 5432, IPv6)', directUrl());
  const pooledOk = await probar('Pooled (puerto 6543, IPv4)', pooledUrl());

  console.log('\n━━ Resumen');
  console.log(`   direct: ${directOk ? 'OK' : 'FAIL'}`);
  console.log(`   pooled: ${pooledOk ? 'OK' : 'FAIL'}`);
  if (!directOk && !pooledOk) {
    console.log('\n   ⚠ Las dos fallaron. Revisar SUPABASE_DB_PASSWORD en .env.');
    process.exit(1);
  }
  if (!directOk) {
    console.log('   ⚠ Direct falla pero pooled anda — la red es IPv4-only. Usaremos pooler.');
  }
  console.log('\n   ✓ Conectividad lista');
})();
