/**
 * ¿Hay columnas en `schema.prisma` que NINGUNA migración crea?
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 * En este repo conviven dos formas de armar una base:
 *   - desde el SCHEMA (`prisma db push`) → Supabase y las locales de desarrollo;
 *   - aplicando las MIGRACIONES en orden → el mini PC S1 (`update-server.ps1`,
 *     `setup-mini-pc.ps1`) y `scripts/cloud/migrate.mjs`.
 *
 * Cuando alguien agrega un campo al schema y lo empuja con `db push` sin
 * escribir la migración, las dos formas dejan de coincidir. Y no se nota: la
 * base de desarrollo anda, la nube anda, y la que se rompe es la que nadie
 * mira todos los días.
 *
 * Incidente real (2026-08-15): tres columnas quedaron así. Una de ellas,
 * `tipos_producto.es_subcategoria`, la USA `20260702120000_porciones_reorg`,
 * que en S1 fallaba por columna inexistente. Como el updater corta ante el
 * primer error, S1 quedó SEIS SEMANAS sin poder aplicar una sola migración,
 * fallando y rolleando sola cada noche a las 4 AM en silencio.
 *
 * ── Uso ───────────────────────────────────────────────────────────────────
 *   node tools/check-migration-drift.mjs
 *
 * Sale 0 si no hay drift, 1 si lo hay. Requiere `pnpm db:generate` antes (lee
 * el DMMF del cliente generado, no parsea el schema a mano).
 *
 * ── Alcance ───────────────────────────────────────────────────────────────
 * Compara COLUMNAS y TABLAS. No mira tipos, defaults, índices ni constraints:
 * el objetivo es cazar el "esto no existe en la base armada por migraciones",
 * que es lo que rompe. Un cambio de tipo sin migración no lo detecta.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const MIG = path.join(REPO, 'packages', 'db', 'prisma', 'migrations');

const require = createRequire(import.meta.url);
let Prisma;
try {
  ({ Prisma } = require(path.join(REPO, 'packages', 'db', 'node_modules', '@prisma', 'client', 'index.js')));
} catch {
  try {
    ({ Prisma } = require('@prisma/client'));
  } catch {
    console.error('No pude cargar @prisma/client. Corré `pnpm db:generate` primero.');
    process.exit(2);
  }
}

// El paquete puede resolver pero venir SIN generar (un `install` limpio deja el
// stub). Ahí `Prisma` existe y `Prisma.dmmf` no, así que sin este chequeo el
// script muere con un TypeError críptico en vez del mensaje de arriba — que es
// exactamente lo que pasó en la primera corrida del workflow de release.
if (!Prisma?.dmmf?.datamodel) {
  console.error('@prisma/client está sin generar (no trae dmmf). Corré `pnpm db:generate` primero.');
  process.exit(2);
}

// Identificador SQL con o sin comillas: las migraciones usan las dos formas
// (las generadas por Prisma citan todo, las escritas a mano no siempre).
const ID = '"?([a-z0-9_]+)"?';
const IDX = '"?[a-z0-9_]+"?';
const NO_SON_COLUMNAS = /^(primary|foreign|unique|constraint|check|exclude)$/i;

/** tabla → Set(columnas) según el SQL de TODAS las migraciones. */
function columnasSegunMigraciones() {
  const porTabla = new Map();
  const add = (t, c) => {
    if (!porTabla.has(t)) porTabla.set(t, new Set());
    porTabla.get(t).add(c);
  };

  for (const dir of fs.readdirSync(MIG).sort()) {
    const f = path.join(MIG, dir, 'migration.sql');
    if (!fs.existsSync(f)) continue;
    const sql = fs.readFileSync(f, 'utf8');

    // CREATE TABLE x ( ... );  — el cuerpo termina en un ");" a principio de línea.
    const reCreate = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${ID}\\s*\\(([\\s\\S]*?)^\\s*\\)\\s*;`, 'gim');
    for (const m of sql.matchAll(reCreate)) {
      // Una columna es `nombre TIPO`, donde TIPO puede ir entre comillas
      // (los enum que genera Prisma, p.ej. "RolUsuario").
      for (const c of m[2].matchAll(/^\s*"?([a-z0-9_]+)"?\s+(?:"[A-Za-z0-9_]+"|[A-Za-z])/gm)) {
        if (NO_SON_COLUMNAS.test(c[1])) continue;
        add(m[1], c[1]);
      }
    }

    const reAlter = new RegExp(`ALTER TABLE\\s+(?:IF EXISTS\\s+)?${ID}([\\s\\S]*?);`, 'gi');
    for (const m of sql.matchAll(reAlter)) {
      for (const c of m[2].matchAll(new RegExp(`ADD COLUMN\\s+(?:IF NOT EXISTS\\s+)?${ID}`, 'gi'))) add(m[1], c[1]);
      for (const c of m[2].matchAll(new RegExp(`RENAME COLUMN\\s+${IDX}\\s+TO\\s+${ID}`, 'gi'))) add(m[1], c[1]);
    }
  }
  return porTabla;
}

const enMigraciones = columnasSegunMigraciones();
const problemas = [];

for (const modelo of Prisma.dmmf.datamodel.models) {
  const tabla = modelo.dbName ?? modelo.name;
  const cols = enMigraciones.get(tabla);
  if (!cols) {
    problemas.push({ tabla, detalle: 'la tabla no la crea ninguna migración' });
    continue;
  }
  const faltan = modelo.fields
    .filter((f) => f.kind !== 'object') // las relaciones no son columnas
    .map((f) => f.dbName ?? f.name)
    .filter((c) => !cols.has(c));
  if (faltan.length) problemas.push({ tabla, detalle: faltan.join(', ') });
}

if (problemas.length === 0) {
  console.log('OK — toda tabla y columna del schema la crea alguna migración.');
  process.exit(0);
}

console.error('DRIFT: hay cosas en schema.prisma que ninguna migración crea.\n');
for (const p of problemas) console.error(`  ${p.tabla}: ${p.detalle}`);
console.error(
  '\nUna base armada aplicando migraciones (el mini PC S1) NO va a tener esto,' +
    '\naunque Supabase y tu local sí porque se armaron con `db push`.' +
    '\nEscribí una migración aditiva e idempotente (ADD COLUMN IF NOT EXISTS).' +
    '\nSi alguna migración YA EXISTENTE usa la columna, el nombre de la nueva' +
    '\ntiene que ordenar ANTES que aquella: se aplican por orden alfabético.',
);
process.exit(1);
