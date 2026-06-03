/**
 * Migración de datos: renombrar la lista del canal LOCAL_MOSTRADOR (hoy "Local")
 * a "Venta al público".
 *
 * No se materializan precios: en el modelo nuevo el precio al público ES
 * `producto.precioBase` (la lista pública es una vista editable sobre eso), las
 * listas de canal (RAPPI/PYA/ML/...) son DERIVADAS = base × (1+ajuste) y las
 * mayoristas/custom guardan sus overrides en PrecioPorLista. Así que solo hace
 * falta el rename — el pricing no cambia.
 *
 * IMPORTANTE: correr SOLO cuando las cajas ya están en el build con el resolver
 * por canal (no por nombre). El alpha viejo busca la lista por nombre "Local" y
 * se rompería. Por eso esto va junto al deploy.
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

  const ren = await client.query(
    `UPDATE listas_precios
        SET nombre = 'Venta al público'
      WHERE canal_default = 'LOCAL_MOSTRADOR'
        AND nombre <> 'Venta al público'
      RETURNING id, nombre`,
  );
  console.log(
    ren.rowCount > 0
      ? `✓ Lista LOCAL_MOSTRADOR renombrada → "Venta al público" (${ren.rows[0].id})`
      : `• La lista pública ya se llama "Venta al público" (o no hay LOCAL_MOSTRADOR)`,
  );

  await client.end();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
