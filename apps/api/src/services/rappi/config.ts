import { prisma } from '@sta/db/client';
import { config } from '../../config.js';
import { getCached, invalidate } from '../../lib/cache.js';

/**
 * Configuración de la integración con RAPPI.
 *
 * Está partida en dos a propósito:
 *
 *  - **Secretos y ambiente** viven en el entorno (Railway): `RAPPI_CLIENT_ID`,
 *    `RAPPI_CLIENT_SECRET`, `RAPPI_WEBHOOK_SECRET`, `RAPPI_AMBIENTE`. No se
 *    editan desde la pantalla ni se guardan en la base — la base se replica a
 *    la nube y se espeja en la máquina del dueño; un secreto ahí es un secreto
 *    en tres lugares.
 *
 *  - **Lo operativo** vive en `configuracion_sistema` (clave `rappi_config`),
 *    para que el dueño lo pueda tocar desde el celular: qué tienda, si se
 *    toman las órdenes solas, el tiempo de cocina que se declara.
 */

/** Dominios de RAPPI por ambiente. Ver docs/RAPPI-API-REFERENCE.md → Dominios. */
const DOMINIOS = {
  dev: {
    // Endpoints `/api/v2/restaurants-integrations-public-api/...`
    legacy: 'https://microservices.dev.rappi.com',
    // Endpoints `/restaurants/{orders|menu|auth}/v1/...`
    nuevo: 'https://api.dev.rappi.com',
  },
  prod: {
    legacy: 'https://services.rappi.com.ar',
    nuevo: 'https://api.rappi.com.ar',
  },
} as const;

export type AmbienteRappi = keyof typeof DOMINIOS;

export function ambienteRappi(): AmbienteRappi {
  return config.RAPPI_AMBIENTE;
}

/** Dónde pegarle. Los overrides son para tests (un RAPPI falso) o un proxy. */
export function dominiosRappi(): { legacy: string; nuevo: string } {
  const base = DOMINIOS[ambienteRappi()];
  return {
    legacy: (config.RAPPI_BASE_LEGACY_URL ?? base.legacy).replace(/\/+$/, ''),
    nuevo: (config.RAPPI_BASE_NUEVO_URL ?? base.nuevo).replace(/\/+$/, ''),
  };
}

/** ¿Hay credenciales para llamar a RAPPI? Sin esto, lo saliente está apagado. */
export function credencialesRappi(): { clientId: string; clientSecret: string } | null {
  if (!config.RAPPI_CLIENT_ID || !config.RAPPI_CLIENT_SECRET) return null;
  return { clientId: config.RAPPI_CLIENT_ID, clientSecret: config.RAPPI_CLIENT_SECRET };
}

export function secretoWebhookRappi(): string | null {
  return config.RAPPI_WEBHOOK_SECRET ?? null;
}

// ─── Lo operativo, en la base ────────────────────────────────────────────

export interface RappiConfig {
  /** El `rappiId` de la tienda con la que se opera. Se elige de la lista de tiendas. */
  storeId: string | null;
  /** El nombre, sólo para mostrarlo sin volver a consultar. */
  storeNombre: string | null;
  /**
   * El `integrationId` que RAPPI le asigna a esa tienda dentro de nuestra
   * integración. Lo piden los endpoints de disponibilidad de productos
   * (`store_integration_id`), que no aceptan el `rappiId`.
   */
  storeIntegrationId: string | null;
  /** El `clientId` de la integración, para suscribir webhooks a nivel integración. */
  clientIntegrationId: string | null;
  /**
   * Tomar la orden en RAPPI apenas entra el webhook. RAPPI cancela sola lo que
   * no se toma en 6 minutos; con esto prendido nunca se vence, pero la cocina
   * queda comprometida sin que nadie la mire. Es una decisión del dueño, por
   * eso arranca APAGADO.
   */
  tomarAutomatico: boolean;
  /** Minutos de cocina que se declaran al tomar. Null = el default de RAPPI. */
  tiempoCocinaMin: number | null;
  /** Lo último que pasó con el menú, para mostrarlo en la pantalla. */
  menu: {
    enviadoAt: string | null;
    items: number | null;
    /** Lo que dijo RAPPI después: llega por webhook o se consulta. */
    estado: 'PENDIENTE' | 'APROBADO' | 'RECHAZADO' | null;
    estadoAt: string | null;
  };
}

const CLAVE = 'rappi_config';
const CACHE_KEY = 'rappi:config';

const DEFAULT: RappiConfig = {
  storeId: null,
  storeNombre: null,
  storeIntegrationId: null,
  clientIntegrationId: null,
  tomarAutomatico: false,
  tiempoCocinaMin: null,
  menu: { enviadoAt: null, items: null, estado: null, estadoAt: null },
};

export async function getRappiConfig(): Promise<RappiConfig> {
  return getCached(CACHE_KEY, 30_000, async () => {
    const row = await prisma.configuracionSistema
      .findUnique({ where: { clave: CLAVE } })
      .catch(() => null);
    if (!row?.valor) return { ...DEFAULT };
    try {
      const parsed = JSON.parse(row.valor) as Partial<RappiConfig>;
      return {
        ...DEFAULT,
        ...parsed,
        menu: { ...DEFAULT.menu, ...(parsed.menu ?? {}) },
      };
    } catch {
      return { ...DEFAULT };
    }
  });
}

export async function setRappiConfig(
  patch: Partial<Omit<RappiConfig, 'menu'>> & { menu?: Partial<RappiConfig['menu']> },
  actualizadoPor?: string,
): Promise<RappiConfig> {
  const actual = await getRappiConfig();
  const nuevo: RappiConfig = {
    ...actual,
    ...patch,
    menu: { ...actual.menu, ...(patch.menu ?? {}) },
  };
  await prisma.configuracionSistema.upsert({
    where: { clave: CLAVE },
    create: {
      clave: CLAVE,
      valor: JSON.stringify(nuevo),
      tipo: 'json',
      categoria: 'integraciones',
      descripcion: 'Integración con RAPPI: tienda, tomar automático, estado del menú',
      actualizadoPor: actualizadoPor ?? null,
    },
    update: { valor: JSON.stringify(nuevo), actualizadoPor: actualizadoPor ?? null },
  });
  invalidate(CACHE_KEY);
  return nuevo;
}
