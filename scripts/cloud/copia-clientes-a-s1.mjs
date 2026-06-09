// Copia los ~781 contactos de delivery (clientes origen='innovo') de Supabase
// a la base LOCAL de S1. Correr desde C:\sta-temp (con `pg`):  node copia-clientes-a-s1.mjs
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
  await local.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS origen varchar(20)`);
  const { rows } = await cloud.query(`SELECT row_to_json(t) j FROM clientes t WHERE origen='innovo'`);
  if (rows.length) {
    await local.query(
      `INSERT INTO clientes SELECT * FROM json_populate_recordset(null::clientes, $1::json) ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows.map((r) => r.j))],
    );
  }
  const n = (await local.query(`SELECT count(*)::int n FROM clientes WHERE origen='innovo'`)).rows[0].n;
  console.log(`✓ Contactos delivery (origen=innovo) en S1: ${n}`);
} catch (e) {
  console.error('ERROR:', e.message); process.exitCode = 1;
} finally {
  await local.end(); await cloud.end();
}
