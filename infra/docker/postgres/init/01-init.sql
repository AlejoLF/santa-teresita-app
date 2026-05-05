-- ════════════════════════════════════════════════════════════════════
--   Inicialización Postgres dev — Santa Teresita
--   Se corre automáticamente al levantar el container la primera vez.
-- ════════════════════════════════════════════════════════════════════

-- Extensiones que vamos a usar
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- DB shadow para Prisma migrate
SELECT 'CREATE DATABASE teresita_shadow OWNER teresita'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'teresita_shadow')\gexec
