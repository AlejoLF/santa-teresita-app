/**
 * Side-effect import: carga el .env antes que cualquier otro módulo lea process.env.
 * Importar PRIMERO en server.ts (`import './env-loader.js';`) — es el primer módulo
 * en evaluarse y poblá process.env para que config.ts pueda parsearlo con zod.
 *
 * Estrategia de paths:
 *   1. apps/api/.env (si existe — copia local del developer)
 *   2. raíz del monorepo /.env (autoritativo)
 */

import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const localEnv = resolve(here, '..', '.env');
const rootEnv = resolve(here, '..', '..', '..', '.env');

if (existsSync(localEnv)) {
  loadDotenv({ path: localEnv });
}
if (existsSync(rootEnv)) {
  loadDotenv({ path: rootEnv });
}
