/**
 * Migración de datos: "Venta al público" + materialización de precios.
 *
 *   1) Renombra la lista del canal LOCAL_MOSTRADOR (hoy "Local") → "Venta al
 *      público".
 *   2) Materializa PrecioPorLista para cada lista activa × cada producto activo
 *      que todavía no tenga precio en esa lista: precio = base × (1 + ajuste%).
 *      Idempotente (guard NOT EXISTS) — se puede correr varias veces.
 *
 * IMPORTANTE: el paso 1 (rename) debe correrse SOLO cuando las cajas ya están
 * en el build con el resolver por canal (no por nombre). El alpha viejo busca
 * la lista por nombre "Local" y se rompería. Por eso esto va junto al deploy.
 *
 *   node --env-file=.env scripts/cloud/seed-venta-al-publico.mjs
 */
import { Client } from 'pg';
import { pooledUrl, maskUrl } from './_url.mjs';

async function main() {
  const url = pooledUrl();
  console.log('▸ Pooler:', maskUrl(url));
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 1) Renombrar la lista pública.
  const ren = await client.query(
    `UPDATE listas_precios
        SET nombre = 'Venta al público'
      WHERE canal_default = 'LOCAL_MOSTRADOR'
        AND nombre <> 'Venta al público'
      RETURNING id`,
  );
  console.log(
    ren.rowCount > 0
      ? `✓ Lista LOCAL_MOSTRADOR renombrada → "Venta al público"`
      : `• La lista pública ya se llama "Venta al público" (o no hay LOCAL_MOSTRADOR)`,
  );

  // 2) Materializar precios por lista (idempotente).
  const listas = await client.query(
    `SELECT id, nombre, ajuste_pct_default FROM listas_precios WHERE activa = true ORDER BY nombre`,
  );
  let total = 0;
  for (const l of listas.rows) {
    const factor = 1 + Number(l.ajuste_pct_default) / 100;
    const ins = await client.query(
      `INSERT INTO precios_por_lista (id, producto_id, lista_id, precio_efectivo, vigencia_desde)
       SELECT gen_random_uuid(), p.id, $1, round(p.precio_base * CAST($2 AS numeric), 2), now()
         FROM productos p
        WHERE p.activo = true
          AND NOT EXISTS (
            SELECT 1 FROM precios_por_lista ppl
             WHERE ppl.lista_id = $1 AND ppl.producto_id = p.id
          )`,
      [l.id, factor],
    );
    console.log(`  ✓ ${l.nombre}: +${ins.rowCount} precios`);
    total += ins.rowCount ?? 0;
  }
  console.log(`✓ Total precios materializados: ${total}`);

  await client.end();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
