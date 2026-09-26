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

// ─── El entorno, analizado una sola vez ──────────────────────────────────
//
// Las variables RAPPI_* llegan sin validar desde config.ts, a propósito: un
// valor mal cargado en Railway no puede tirar el API entero (ver el comentario
// ahí). Acá se analizan una vez, y cada cosa rara queda anotada CON NOMBRE Y
// MOTIVO para que el panel la muestre — "faltan las credenciales" no le sirve
// a nadie si en Railway se ven cargadas.

export interface ProblemaEntorno {
  variable: string;
  problema: string;
  /** true = impide operar (falta, vacía, ambiente inválido). false = aviso. */
  grave: boolean;
}

interface EntornoRappi {
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  ambiente: AmbienteRappi;
  legacyUrl: string | null;
  nuevoUrl: string | null;
  problemas: ProblemaEntorno[];
}

/**
 * Limpia un valor que vino del entorno y anota lo que tuvo que corregir.
 * Devuelve null si no está o quedó vacío.
 */
function leerVariable(
  nombre: string,
  crudo: string | undefined,
  problemas: ProblemaEntorno[],
  { obligatoria }: { obligatoria: boolean },
): string | null {
  if (crudo === undefined) {
    if (obligatoria) problemas.push({ variable: nombre, problema: 'no está seteada en el entorno del API.', grave: true });
    return null;
  }
  let valor = crudo.trim();
  if (valor !== crudo) {
    problemas.push({
      variable: nombre,
      problema: 'tenía espacios o un salto de línea al principio o al final (quedan afuera).',
      grave: false,
    });
  }
  if (valor.length >= 2 && ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'")))) {
    valor = valor.slice(1, -1).trim();
    problemas.push({
      variable: nombre,
      problema: 'está entre comillas. Railway las guarda como parte del valor; se cargan sin ellas.',
      grave: false,
    });
  }
  if (valor === '') {
    problemas.push({ variable: nombre, problema: 'está seteada pero VACÍA.', grave: true });
    return null;
  }
  return valor;
}

function leerUrl(nombre: string, crudo: string | undefined, problemas: ProblemaEntorno[]): string | null {
  const valor = leerVariable(nombre, crudo, problemas, { obligatoria: false });
  if (valor === null) return null;
  try {
    const u = new URL(valor);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo');
    return valor.replace(/\/+$/, '');
  } catch {
    problemas.push({
      variable: nombre,
      problema: `"${valor}" no es una URL (http/https). Se ignora y se usa el dominio del ambiente.`,
      grave: true,
    });
    return null;
  }
}

function analizarEntorno(): EntornoRappi {
  const problemas: ProblemaEntorno[] = [];
  const clientId = leerVariable('RAPPI_CLIENT_ID', config.RAPPI_CLIENT_ID, problemas, { obligatoria: true });
  const clientSecret = leerVariable('RAPPI_CLIENT_SECRET', config.RAPPI_CLIENT_SECRET, problemas, { obligatoria: true });
  const webhookSecret = leerVariable('RAPPI_WEBHOOK_SECRET', config.RAPPI_WEBHOOK_SECRET, problemas, { obligatoria: true });
  if (webhookSecret !== null && webhookSecret.length < 16) {
    problemas.push({
      variable: 'RAPPI_WEBHOOK_SECRET',
      problema: `tiene ${webhookSecret.length} caracteres. Se usa igual, pero conviene uno de 16 o más (es lo que firma cada pedido).`,
      grave: false,
    });
  }

  let ambiente: AmbienteRappi = 'dev';
  const ambienteCrudo = leerVariable('RAPPI_AMBIENTE', config.RAPPI_AMBIENTE, problemas, { obligatoria: false });
  if (ambienteCrudo !== null) {
    const normalizado = ambienteCrudo.toLowerCase();
    if (normalizado === 'dev' || normalizado === 'prod') {
      ambiente = normalizado;
      if (normalizado !== ambienteCrudo) {
        problemas.push({ variable: 'RAPPI_AMBIENTE', problema: `vale "${ambienteCrudo}"; se toma como ${normalizado}.`, grave: false });
      }
    } else {
      problemas.push({
        variable: 'RAPPI_AMBIENTE',
        problema: `vale "${ambienteCrudo}" y sólo puede ser dev o prod. Se usa dev.`,
        grave: true,
      });
    }
  }

  const legacyUrl = leerUrl('RAPPI_BASE_LEGACY_URL', config.RAPPI_BASE_LEGACY_URL, problemas);
  const nuevoUrl = leerUrl('RAPPI_BASE_NUEVO_URL', config.RAPPI_BASE_NUEVO_URL, problemas);

  return { clientId, clientSecret, webhookSecret, ambiente, legacyUrl, nuevoUrl, problemas };
}

let entornoCache: EntornoRappi | null = null;
function entorno(): EntornoRappi {
  if (!entornoCache) entornoCache = analizarEntorno();
  return entornoCache;
}

/** Sólo para tests: vuelve a leer el entorno. */
export function _reanalizarEntornoRappi(): void {
  entornoCache = null;
}

export function ambienteRappi(): AmbienteRappi {
  return entorno().ambiente;
}

/** Dónde pegarle. Los overrides son para tests (un RAPPI falso) o un proxy. */
export function dominiosRappi(): { legacy: string; nuevo: string } {
  const e = entorno();
  const base = DOMINIOS[e.ambiente];
  return {
    legacy: e.legacyUrl ?? base.legacy,
    nuevo: e.nuevoUrl ?? base.nuevo,
  };
}

/** ¿Hay credenciales para llamar a RAPPI? Sin esto, lo saliente está apagado. */
export function credencialesRappi(): { clientId: string; clientSecret: string } | null {
  const e = entorno();
  if (!e.clientId || !e.clientSecret) return null;
  return { clientId: e.clientId, clientSecret: e.clientSecret };
}

export function secretoWebhookRappi(): string | null {
  return entorno().webhookSecret;
}

/**
 * Lo que el panel muestra cuando algo del entorno no está bien: cada variable
 * con su problema, más desde cuándo corre este proceso y con qué versión —
 * porque la pregunta de fondo, cuando "cargué las variables y no da bien", es
 * si el deploy con las variables nuevas llegó a arrancar o sigue el anterior.
 */
export function diagnosticoEntornoRappi(): {
  problemas: ProblemaEntorno[];
  version: string;
  arrancoAt: string;
  rol: string;
} {
  return {
    problemas: entorno().problemas,
    version: process.env.STA_SERVER_VERSION ?? process.env.STA_DESKTOP_VERSION ?? 'dev',
    arrancoAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    rol: config.STA_ROLE,
  };
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
