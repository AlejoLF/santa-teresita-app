// Diagnóstico: ¿el catálogo de S1-local tiene los MISMOS UUIDs que Supabase?
// Correr desde C:\sta-temp (con `pg` instalado):  node diag-catalogo-s1.mjs
import pkg from 'pg';
import fs from 'node:fs';
const { Pool } = pkg;
const env = Object.fromEntries(
  fs.readFileSync('C:/sta-server/.env', 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const local = new Pool({ connectionString: env.DATABASE_URL });
const cloud = new Pool({ connectionString: env.REPLICATE_TO_URL, ssl: { rejectUnauthorized: false } });
try {
  const lp = (await local.query('SELECT count(*)::int n FROM productos')).rows[0].n;
  const cp = (await cloud.query('SELECT count(*)::int n FROM productos')).rows[0].n;
  const lt = (await local.query('SELECT count(*)::int n FROM tipos_producto')).rows[0].n;
  // ¿cuántos UUIDs de producto de la nube existen en S1-local?
  const cloudIds = (await cloud.query('SELECT id FROM productos')).rows.map((r) => r.id);
  const match = (await local.query('SELECT count(*)::int n FROM productos WHERE id = ANY($1::uuid[])', [cloudIds])).rows[0].n;
  // tipo Postres en S1
  const tipo2d = (await local.query("SELECT count(*)::int n FROM tipos_producto WHERE id='2dbe05ec-8446-4e7d-a04e-5085e70050a7'")).rows[0].n;
  const postres = (await local.query("SELECT id::text, nombre FROM tipos_producto WHERE nombre ILIKE '%postre%' OR nombre ILIKE '%otro%'")).rows;
  // ¿coinciden por CÓDIGO? (cuántos códigos de la nube existen en S1)
  const cloudCods = (await cloud.query('SELECT codigo FROM productos WHERE codigo IS NOT NULL')).rows.map((r) => r.codigo);
  const codMatch2 = (await local.query('SELECT count(*)::int n FROM productos WHERE codigo = ANY($1::text[])', [cloudCods])).rows[0].n;
  console.log('=== CATÁLOGO S1 vs Supabase ===');
  console.log(`productos: S1=${lp}  cloud=${cp}`);
  console.log(`UUIDs de cloud que existen en S1: ${match} de ${cloudIds.length}  ${match === cloudIds.length ? '(COINCIDEN por UUID ✓)' : '(NO coinciden por UUID ✗)'}`);
  console.log(`CÓDIGOS de cloud que existen en S1: ${codMatch2} de ${cloudCods.length}`);
  console.log(`tipos_producto en S1: ${lt}  |  tipo Postres 2dbe05ec presente: ${tipo2d ? 'SÍ' : 'NO'}`);
  console.log('tipos S1 (postre/otros):', postres);
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await local.end(); await cloud.end();
}
