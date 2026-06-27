# syntax=docker/dockerfile:1
# ───────────────────────────────────────────────────────────────────────
# API Fastify de Santa Teresita para la NUBE (Railway / cualquier contenedor).
# Reusa el bundler probado de apps/server (esbuild → dist/api/server.mjs,
# self-contained, con el engine de Prisma compilado para Linux en el build).
# STA_ROLE=cloud → NO arranca replicator/outbox/geocoder (eso es del mini-PC).
# La data viene por DATABASE_URL (Supabase pooler hoy; mañana S1 vía Tailscale).
# ───────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# openssl: requerido por el engine de Prisma. python3/make/g++: fallback por si
# better-sqlite3 no tuviera prebuild para esta ABI (normalmente sí lo tiene).
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY . .

# Instala SOLO lo necesario para construir la API (incluye @sta/db, @sta/shared
# y las devDeps de build de @sta/server). Excluye desktop/web/mobile → sin electron.
RUN pnpm install --frozen-lockfile --filter "@sta/server..." --filter "@sta/api..."

# Bundle self-contained: prisma generate (engine Linux) + esbuild + externals.
RUN node apps/server/scripts/build.mjs

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    TZ=America/Argentina/Buenos_Aires \
    STA_ROLE=cloud \
    API_TRUST_PROXY=1

# Railway inyecta PORT en runtime; el server lee API_PORT.
EXPOSE 3001
CMD ["sh","-c","API_PORT=${PORT:-3001} node apps/server/dist/api/server.mjs"]
