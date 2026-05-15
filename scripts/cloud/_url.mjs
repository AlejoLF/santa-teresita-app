/**
 * Construye los DATABASE_URL de Supabase. Acepta dos modos:
 *
 * Modo A — URLs explícitos (más simple si ya los tenés en el dashboard):
 *   SUPABASE_DB_URL_DIRECT=postgresql://postgres:PASS@db.REF.supabase.co:5432/postgres
 *   SUPABASE_DB_URL_POOLED=postgresql://postgres.REF:PASS@aws-0-REGION.pooler.supabase.com:6543/postgres
 *
 * Modo B — variables atómicas (más robusto si la password tiene caracteres
 * que necesitan URL-encoding):
 *   SUPABASE_PROJECT_REF
 *   SUPABASE_DB_PASSWORD
 *   SUPABASE_DB_REGION (default: sa-east-1)
 *
 * Si están las dos cosas en el .env, prefiere el Modo A (los URLs explícitos).
 */

function tryGet(name) {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : null;
}

function required(name) {
  const v = tryGet(name);
  if (!v) throw new Error(`Falta la variable de entorno ${name} en el .env`);
  return v;
}

export function supabaseRef() {
  return required('SUPABASE_PROJECT_REF');
}

export function dbRegion() {
  return tryGet('SUPABASE_DB_REGION') || 'sa-east-1';
}

export function directUrl() {
  const explicit = tryGet('SUPABASE_DB_URL_DIRECT');
  if (explicit) return explicit;
  const ref = supabaseRef();
  const pass = encodeURIComponent(required('SUPABASE_DB_PASSWORD'));
  return `postgresql://postgres:${pass}@db.${ref}.supabase.co:5432/postgres`;
}

export function pooledUrl() {
  const explicit = tryGet('SUPABASE_DB_URL_POOLED');
  if (explicit) return explicit;
  const ref = supabaseRef();
  const pass = encodeURIComponent(required('SUPABASE_DB_PASSWORD'));
  const region = dbRegion();
  // aws-1 = nueva infra ELB-fronted de Supavisor. La aws-0 quedó como
  // legacy: proyectos nuevos y migrados viven en aws-1. Si Supabase saca
  // un aws-2 en el futuro, actualizar acá (y permitir override via
  // SUPABASE_DB_POOLER_HOST si hace falta).
  return `postgresql://postgres.${ref}:${pass}@aws-1-${region}.pooler.supabase.com:6543/postgres`;
}

/** Para mostrar en logs sin exponer credenciales. */
export function maskUrl(url) {
  return url.replace(/:[^:@/]+@/, ':***@');
}
