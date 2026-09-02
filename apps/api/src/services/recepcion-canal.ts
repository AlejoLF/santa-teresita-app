import { prisma } from '@sta/db/client';
import type { FastifyRequest } from 'fastify';

/**
 * El buzón de la ingesta de plataformas: deja constancia de TODO lo que golpea
 * `/channel/*`, se haya aceptado o no.
 *
 * ─── Por qué ────────────────────────────────────────────────────────────
 *
 * La ingesta tenía cinco maneras distintas de rechazar un pedido y las cinco
 * eran mudas del lado del local: la plataforma se llevaba su código de error y
 * acá no quedaba nada. Cuando un pedido de RAPPI "no aparece", las dos causas
 * posibles son opuestas —llegó y lo rechazamos, o nunca salió de RAPPI— y sin
 * registro no hay forma de distinguirlas.
 *
 * Con esto, un buzón vacío después de una prueba también es información: dice
 * que el problema está del lado de la plataforma (URL mal cargada, el pedido no
 * disparó el webhook), no acá.
 */

/** Más que esto no se guarda. Un pedido normal pesa un par de KB. */
const MAX_BYTES = 64 * 1024;

/** Cuántas recepciones se conservan. Es un buzón de diagnóstico, no un archivo. */
const MAX_FILAS = 300;

export type ResultadoRecepcion =
  | 'OK'
  | 'SIN_TOKEN_CONFIGURADO'
  | 'TOKEN_INVALIDO'
  | 'BODY_INVALIDO'
  | 'SKU_FALTANTE'
  | 'FUERA_DE_HORARIO'
  | 'SIN_ADAPTADOR'
  | 'DUPLICADO'
  | 'ERROR';

/**
 * Headers, con los secretos tapados.
 *
 * De `authorization` (y compañía) se guarda LA FORMA, no el valor: el largo y
 * las cuatro puntas. Alcanza para responder la pregunta que importa al conectar
 * un integrador nuevo —"¿mandó token? ¿es de otro largo que el nuestro?"— sin
 * dejar un secreto guardado en una tabla de diagnóstico que además se replica a
 * la nube.
 */
const HEADERS_SECRETOS = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
  'cookie',
]);

export function redactarHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const clave = k.toLowerCase();
    const valor = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    if (!HEADERS_SECRETOS.has(clave)) {
      out[clave] = valor.slice(0, 300);
      continue;
    }
    if (!valor) {
      out[clave] = '(vacío)';
      continue;
    }
    // "Bearer abcd…wxyz (48 chars)" — la forma, nunca el secreto.
    const limpio = valor.replace(/^Bearer\s+/i, '');
    const esquema = valor.length !== limpio.length ? 'Bearer ' : '';
    out[clave] =
      limpio.length <= 8
        ? `${esquema}(${limpio.length} chars, muy corto)`
        : `${esquema}${limpio.slice(0, 4)}…${limpio.slice(-4)} (${limpio.length} chars)`;
  }
  return out;
}

/** La IP real detrás del proxy de Railway. */
function ipDe(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const primera = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (primera ?? req.ip ?? '').trim().slice(0, 60);
}

export interface DatosRecepcion {
  resultado: ResultadoRecepcion;
  status: number;
  detalle?: string | null;
  canal?: string | null;
  idExternoCanal?: string | null;
  ventaId?: string | null;
}

/**
 * Guarda la recepción. NUNCA tira: es diagnóstico, y un problema para registrar
 * lo que pasó no puede ser el motivo de que un pedido real se pierda.
 */
export async function registrarRecepcion(
  req: FastifyRequest,
  datos: DatosRecepcion,
): Promise<void> {
  try {
    const crudo = req.body;
    let body: unknown = null;
    let bodyTexto: string | null = null;
    let bytes = 0;

    if (typeof crudo === 'string') {
      bytes = Buffer.byteLength(crudo);
      bodyTexto = crudo.slice(0, MAX_BYTES);
    } else if (crudo !== undefined && crudo !== null) {
      const json = JSON.stringify(crudo);
      bytes = Buffer.byteLength(json);
      if (bytes <= MAX_BYTES) body = crudo;
      // Un body gigante se guarda recortado como texto: sirve para ver la forma
      // aunque no entre entero, y no infla la tabla.
      else bodyTexto = json.slice(0, MAX_BYTES);
    }

    await prisma.recepcionCanal.create({
      data: {
        ruta: (req.routeOptions?.url ?? req.url ?? '').slice(0, 160),
        metodo: (req.method ?? '').slice(0, 10),
        ip: ipDe(req) || null,
        headers: redactarHeaders(req.headers as Record<string, unknown>),
        body: body === null ? undefined : (body as never),
        bodyTexto,
        bytes,
        status: datos.status,
        resultado: datos.resultado,
        detalle: datos.detalle ?? null,
        canal: datos.canal ?? null,
        idExternoCanal: datos.idExternoCanal ?? null,
        ventaId: datos.ventaId ?? null,
      },
    });

    await podar();
  } catch (e) {
    // A la consola y nada más. Que el buzón falle no puede tumbar la ingesta.
    console.error('[recepcion-canal] no se pudo registrar la recepción:', e);
  }
}

/**
 * Deja sólo las últimas `MAX_FILAS`.
 *
 * Se poda cada 25 inserciones y no en cada una: el DELETE con subconsulta es
 * más caro que el INSERT, y correrlo siempre haría que el costo de registrar
 * dependiera del tamaño de la tabla justo cuando entra una ráfaga de pedidos.
 */
async function podar(): Promise<void> {
  if (Math.random() > 1 / 25) return;
  await prisma.$executeRaw`
    DELETE FROM "recepciones_canal"
     WHERE "id" IN (
       SELECT "id" FROM "recepciones_canal"
        ORDER BY "recibido_at" DESC
        OFFSET ${MAX_FILAS}
     )
  `;
}
