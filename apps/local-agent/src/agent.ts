/**
 * Local agent — daemon que corre en una PC del local.
 *
 * Responsabilidades:
 *   - Cada N seg: trae la config de impresoras desde la API (cambios del panel
 *     admin se aplican en el siguiente poll).
 *   - Cada N seg: pide trabajos pendientes a la API.
 *   - Renderiza el payload con node-thermal-printer y manda a la EPSON
 *     correspondiente.
 *   - Reporta estado (impreso / error) a la API.
 *
 * Auth: el agent corre dentro del .exe de Nancy, en el mismo proceso/red
 * que la API local. Usa AGENT_API_TOKEN si está seteado, sino auth cookie
 * (heredada de la sesión actual del Electron).
 */

import 'dotenv/config';
import { Socket } from 'node:net';
import pino from 'pino';
import {
  imprimirComanda,
  imprimirTicketCliente,
  imprimirTicketDelivery,
  testPrinter,
  setPrinterConfig,
  getPrinterConfig,
  type DestinoImpresora,
  type PrinterConfig,
} from './printers.js';

const logger = pino({
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

const API_URL = process.env.API_PUBLIC_URL ?? 'http://127.0.0.1:3001';
const POLL_INTERVAL_MS = Number(process.env.AGENT_POLL_INTERVAL_MS ?? 3000);
const CONFIG_REFRESH_EVERY_N_POLLS = 5; // refresh config cada ~15s
const HEARTBEAT_EVERY_N_POLLS = 10; // heartbeat cada ~30s
const HEARTBEAT_TCP_TIMEOUT_MS = 3000;
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
  destino: DestinoImpresora;
  payload: Record<string, unknown>;
  intentos: number;
}

const baseHeaders = AGENT_TOKEN
  ? { Authorization: `Bearer ${AGENT_TOKEN}` }
  : ({} as Record<string, string>);

async function fetchPendientes(): Promise<TrabajoImpresion[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/impresion/pendientes?limit=10`, {
      headers: baseHeaders,
    });
    if (!res.ok) {
      if (res.status !== 401 && res.status !== 404) {
        logger.warn({ status: res.status }, 'Error consultando trabajos');
      }
      return [];
    }
    return (await res.json()) as TrabajoImpresion[];
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : e }, 'No se pudo conectar a la API');
    return [];
  }
}

/**
 * Hace un TCP probe a host:port. Devuelve { online, latencyMs?, error? }.
 * No envía nada — solo abre el socket. Si conecta exitoso → online.
 * Útil para confirmar que la impresora está enchufada antes de mandarle
 * trabajos, sin gastar papel en un test físico.
 */
async function tcpProbe(host: string, port: number): Promise<{
  online: boolean;
  latencyMs?: number;
  error?: string;
}> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const start = Date.now();
    let settled = false;
    const finish = (result: { online: boolean; latencyMs?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    socket.setTimeout(HEARTBEAT_TCP_TIMEOUT_MS);
    socket.once('connect', () => finish({ online: true, latencyMs: Date.now() - start }));
    socket.once('timeout', () => finish({ online: false, error: 'Timeout' }));
    socket.once('error', (e: NodeJS.ErrnoException) => finish({
      online: false,
      error: e.code ?? e.message ?? 'Unknown error',
    }));
    socket.connect(port, host);
  });
}

async function reportarHeartbeat(): Promise<void> {
  for (const destino of ['MOSTRADOR', 'DELIVERY', 'COCINA'] as const) {
    const cfg = getPrinterConfig(destino);
    if (!cfg.activa) continue; // skip impresoras desactivadas
    const probe = await tcpProbe(cfg.host, cfg.port);
    try {
      await fetch(`${API_URL}/api/v1/admin/impresion/heartbeat`, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destino,
          online: probe.online,
          error: probe.error,
          latencyMs: probe.latencyMs,
        }),
      });
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : e, destino }, 'No se pudo reportar heartbeat');
    }
  }
}

async function fetchConfig(): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/api/v1/admin/impresion/config`, {
      headers: baseHeaders,
    });
    if (!res.ok) return;
    const cfg = (await res.json()) as Record<DestinoImpresora, Omit<PrinterConfig, 'destino'>>;
    const wrapped: Partial<Record<DestinoImpresora, PrinterConfig>> = {};
    for (const k of ['MOSTRADOR', 'DELIVERY', 'COCINA'] as const) {
      if (cfg[k]) wrapped[k] = { destino: k, ...cfg[k] };
    }
    setPrinterConfig(wrapped);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : e }, 'No se pudo refrescar config');
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
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado, error }),
    });
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : e, id, estado }, 'No se pudo reportar estado');
  }
}

async function procesar(t: TrabajoImpresion): Promise<void> {
  const cfg = getPrinterConfig(t.destino);
  if (!cfg.activa) {
    // La impresora destino está marcada como NO activa en el panel admin.
    // Reportar como ERROR con mensaje claro para que la encargada vea por qué
    // los pedidos no se imprimen.
    await reportarEstado(
      t.id,
      'ERROR',
      `Impresora ${t.destino} desactivada en config. Activala desde Admin → Configuración → Impresoras.`,
    );
    return;
  }

  logger.info(
    { id: t.id, tipo: t.tipo, destino: t.destino, host: cfg.host },
    'Procesando trabajo',
  );
  try {
    switch (t.tipo) {
      case 'COMANDA_COCINA':
      case 'COMANDA_REIMPRESION':
      case 'COMANDA_CANCELADA':
        await imprimirComanda(
          {
            ...(t.payload as unknown as Parameters<typeof imprimirComanda>[0]),
            esCancelada: t.tipo === 'COMANDA_CANCELADA',
            esReimpresion: t.tipo === 'COMANDA_REIMPRESION',
          },
          t.destino,
        );
        break;
      case 'TICKET_CLIENTE':
      case 'TICKET_REIMPRESION':
        await imprimirTicketCliente(
          t.payload as unknown as Parameters<typeof imprimirTicketCliente>[0],
        );
        break;
      case 'TICKET_DELIVERY':
        await imprimirTicketDelivery(
          t.payload as unknown as Parameters<typeof imprimirTicketDelivery>[0],
        );
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
  logger.info({ apiUrl: API_URL, pollMs: POLL_INTERVAL_MS }, '🍝 Local agent arrancado');

  // Carga inicial de config + heartbeat inicial (para que el panel admin
  // tenga datos en cuanto la encargada lo abre, sin esperar 30s)
  await fetchConfig();
  await reportarHeartbeat();

  let pollCount = 0;
  while (true) {
    pollCount += 1;
    if (pollCount % CONFIG_REFRESH_EVERY_N_POLLS === 0) {
      await fetchConfig();
    }
    if (pollCount % HEARTBEAT_EVERY_N_POLLS === 0) {
      // No await en el loop principal — corre en paralelo para no bloquear
      // la atención de trabajos pendientes mientras se prueban TCP probes
      // a las 3 impresoras.
      void reportarHeartbeat();
    }
    const trabajos = await fetchPendientes();
    if (trabajos.length > 0) {
      logger.info({ count: trabajos.length }, 'Trabajos pendientes');
      for (const t of trabajos) {
        await procesar(t);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

loop().catch((e) => {
  logger.fatal({ err: e instanceof Error ? e.message : e }, 'Agent crash');
  process.exit(1);
});
