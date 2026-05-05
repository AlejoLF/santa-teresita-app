/**
 * Local agent — daemon que corre en una PC del local.
 *
 * Responsabilidades (fase 1):
 *   - Polling cada 2s a la API por trabajos de impresión pendientes (TrabajoImpresion)
 *   - Renderiza el payload con node-thermal-printer y manda a la EPSON
 *   - Reporta estado (impreso / error) a la API
 *
 * Responsabilidades futuras (fuera de scope ahora):
 *   - Replicar Postgres local ↔ VPS (logical replication la maneja Postgres, no el agente)
 *   - Watchdog de impresoras (heartbeat cada N segundos)
 *   - Procesar webhook proxy si VPS y local pierden conexión
 */

import 'dotenv/config';
import pino from 'pino';
import { imprimirComanda, imprimirTicketCliente, testPrinter } from './printers.js';

const logger = pino({
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

const API_URL = process.env.API_PUBLIC_URL ?? 'http://localhost:3001';
const POLL_INTERVAL_MS = 2000;
const AGENT_TOKEN = process.env.AGENT_API_TOKEN ?? '';

interface TrabajoImpresion {
  id: string;
  tipo:
    | 'COMANDA_COCINA'
    | 'COMANDA_CANCELADA'
    | 'COMANDA_REIMPRESION'
    | 'TICKET_CLIENTE'
    | 'TICKET_DELIVERY'
    | 'TICKET_REIMPRESION'
    | 'TEST';
  destino: 'KITCHEN' | 'COUNTER' | 'DELIVERY';
  payload: Record<string, unknown>;
}

async function fetchPendientes(): Promise<TrabajoImpresion[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/impresion/pendientes`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    if (!res.ok) {
      if (res.status !== 404) logger.warn({ status: res.status }, 'Error consultando trabajos');
      return [];
    }
    return (await res.json()) as TrabajoImpresion[];
  } catch (e) {
    logger.error({ err: e }, 'No se pudo conectar a la API');
    return [];
  }
}

async function reportarEstado(
  id: string,
  estado: 'IMPRESO' | 'ERROR',
  error?: string,
): Promise<void> {
  try {
    await fetch(`${API_URL}/api/v1/impresion/${id}/estado`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ estado, error }),
    });
  } catch (e) {
    logger.error({ err: e, id, estado }, 'No se pudo reportar estado');
  }
}

async function procesar(t: TrabajoImpresion): Promise<void> {
  logger.info({ id: t.id, tipo: t.tipo, destino: t.destino }, 'Procesando trabajo');
  try {
    switch (t.tipo) {
      case 'COMANDA_COCINA':
      case 'COMANDA_REIMPRESION':
      case 'COMANDA_CANCELADA':
        await imprimirComanda({
          ...(t.payload as Parameters<typeof imprimirComanda>[0]),
          esCancelada: t.tipo === 'COMANDA_CANCELADA',
          esReimpresion: t.tipo === 'COMANDA_REIMPRESION',
        });
        break;
      case 'TICKET_CLIENTE':
      case 'TICKET_REIMPRESION':
        await imprimirTicketCliente(t.payload as Parameters<typeof imprimirTicketCliente>[0]);
        break;
      case 'TICKET_DELIVERY':
        // TODO: implementar render de ticket delivery (Wireframe 10 — Ticket 3)
        logger.warn({ id: t.id }, 'TICKET_DELIVERY todavía no implementado');
        break;
      case 'TEST':
        await testPrinter(t.destino);
        break;
    }
    await reportarEstado(t.id, 'IMPRESO');
    logger.info({ id: t.id }, '✓ Impreso');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ id: t.id, err: msg }, '✕ Falló impresión');
    await reportarEstado(t.id, 'ERROR', msg);
  }
}

async function loop(): Promise<void> {
  logger.info({ apiUrl: API_URL }, '🍝 Local agent arrancado — polling impresión');
  while (true) {
    const trabajos = await fetchPendientes();
    if (trabajos.length > 0) logger.info({ count: trabajos.length }, 'Trabajos pendientes');
    for (const t of trabajos) {
      await procesar(t);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

loop().catch((e) => {
  logger.fatal({ err: e }, 'Agent crash');
  process.exit(1);
});
