// Copia el histórico de Innovo de Supabase -> base LOCAL de S1.
// OJO: el server NO tiene `pg` suelto (esbuild lo bundlea dentro de server.mjs).
// Correr desde una carpeta temporal con `pg` instalado:
//     mkdir C:\sta-temp -Force; cd C:\sta-temp
//     npm init -y; npm install pg
//     irm <raw url> -OutFile C:\sta-temp\copia-historico-a-s1.mjs
//     node copia-historico-a-s1.mjs
// Lee DATABASE_URL (local) y REPLICATE_TO_URL (Supabase) de C:\sta-server\.env.
// Idempotente (ON CONFLICT DO NOTHING). Usa json_populate_recordset (mapea
// columnas + enums solo, sin enumerar). También copia categorias/tipos/listas
// porque el migrate-cloud-to-local del cutover los dejó vacíos en S1.
import pkg from 'pg';
import fs from 'node:fs';
const { Pool } = pkg;

const env = Object.fromEntries(
  fs.readFileSync('C:/sta-server/.env', 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
if (!env.DATABASE_URL || !env.REPLICATE_TO_URL) { console.error('Falta DATABASE_URL o REPLICATE_TO_URL en .env'); process.exit(1); }
const local = new Pool({ connectionString: env.DATABASE_URL, max: 4 });
const cloud = new Pool({ connectionString: env.REPLICATE_TO_URL, ssl: { rejectUnauthorized: false }, max: 4 });

// Tabla chica: copia completa (o filtrada) en una.
async function copyFull(table, where = 'true') {
  const { rows } = await cloud.query(`SELECT row_to_json(t) j FROM ${table} t WHERE ${where}`);
  if (rows.length === 0) { console.log(`  ${table}: 0 (nada en cloud)`); return; }
  await local.query(
    `INSERT INTO ${table} SELECT * FROM json_populate_recordset(null::${table}, $1::json) ON CONFLICT DO NOTHING`,
    [JSON.stringify(rows.map((r) => r.j))],
  );
  console.log(`✓ ${table}: ${rows.length}`);
}

// Tabla grande: keyset por id, en lotes.
async function copyBig(table, where, batch) {
  let last = '00000000-0000-0000-0000-000000000000', done = 0;
  for (;;) {
    const { rows } = await cloud.query(
      `SELECT row_to_json(t) j, t.id::text id FROM ${table} t WHERE (${where}) AND t.id > $1 ORDER BY t.id LIMIT ${batch}`,
      [last],
    );
    if (rows.length === 0) break;
    await local.query(
      `INSERT INTO ${table} SELECT * FROM json_populate_recordset(null::${table}, $1::json) ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows.map((r) => r.j))],
    );
    last = rows[rows.length - 1].id; done += rows.length;
    if (done % (batch * 10) === 0) console.log(`  ${table}: ${done}`);
  }
  console.log(`✓ ${table}: ${done}`);
}

try {
  console.log('1) Esquema (origen + sesion nullable + check, idempotente)...');
  await local.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS origen varchar(20)`);
  await local.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS origen varchar(20)`);
  await local.query(`ALTER TABLE ventas ALTER COLUMN sesion_caja_id DROP NOT NULL`);
  await local.query(`ALTER TABLE ventas DROP CONSTRAINT IF EXISTS ventas_sesion_o_origen_chk`);
  await local.query(`ALTER TABLE ventas ADD CONSTRAINT ventas_sesion_o_origen_chk CHECK (sesion_caja_id IS NOT NULL OR origen = 'innovo')`);

  console.log('2) Catálogo de soporte (estaba vacío en S1)...');
  await copyFull('categorias');
  await copyFull('tipos_producto');
  await copyFull('listas_precios');

  console.log('3) 10 productos nuevos (postres + otros)...');
  await copyFull('productos', `(codigo LIKE 'POS-%' OR codigo='OTROS-HIST')`);

  console.log('4) Sesión centinela...');
  await copyFull('sesiones_caja', `id='00000000-0000-0000-0000-000000000099'`);

  console.log('5) Ventas históricas (217K)...');
  await copyBig('ventas', `t.origen='innovo'`, 1000);

  console.log('6) Items históricos (453K)...');
  await copyBig('items_venta', `EXISTS (SELECT 1 FROM ventas v WHERE v.id=t.venta_id AND v.origen='innovo')`, 2500);

  const v = (await local.query(`SELECT count(*)::int n FROM ventas WHERE origen='innovo'`)).rows[0].n;
  const i = (await local.query(`SELECT count(*)::int n FROM items_venta i JOIN ventas v ON v.id=i.venta_id WHERE v.origen='innovo'`)).rows[0].n;
  console.log(`\n✓ EN S1-LOCAL: ${v} ventas históricas, ${i} items.`);
} catch (e) {
  console.error('ERROR:', e.message); process.exitCode = 1;
} finally {
  await local.end(); await cloud.end();
}
