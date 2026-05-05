import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { TipoTrabajoImpresion } from '@sta/db';

/**
 * Servicio de la cola de impresión.
 *
 * Encolar trabajos es idempotente vía `tx` opcional para que la creación de
 * la venta y la encolada del trabajo sean un único commit atómico.
 */

type DbClient = Prisma.TransactionClient | typeof prisma;

export type DestinoImpresion = 'KITCHEN' | 'COUNTER' | 'DELIVERY';

interface EncolarArgs {
  tipo: TipoTrabajoImpresion;
  destino: DestinoImpresion;
  payload: Record<string, unknown>;
  ventaId?: string | null;
  tx?: Prisma.TransactionClient;
}

export async function encolarTrabajo(args: EncolarArgs) {
  const client: DbClient = args.tx ?? prisma;
  return client.trabajoImpresion.create({
    data: {
      tipo: args.tipo,
      destino: args.destino,
      payload: args.payload as Prisma.InputJsonValue,
      ventaId: args.ventaId ?? null,
    },
  });
}

/**
 * Construye el ComandaPayload completo a partir de la venta y sus items.
 *
 * Incluye los datos de delivery (cliente, dirección, teléfono, indicaciones)
 * cuando la venta es DELIVERY_*. La cocinera ve TODO en una sola hoja:
 * items de cocina + a quién/dónde se entrega.
 */
export async function buildComandaPayload(
  ventaId: string,
  client: DbClient = prisma,
): Promise<Record<string, unknown>> {
  const venta = await client.venta.findUnique({
    where: { id: ventaId },
    include: {
      items: {
        orderBy: { orden: 'asc' },
        include: { combo: true },
      },
      deliveryInfo: true,
    },
  });
  if (!venta) throw new Error(`Venta ${ventaId} no encontrada`);

  // Datos de delivery: solo si modalidad es delivery y hay deliveryInfo
  let delivery: Record<string, unknown> | undefined;
  if (venta.modalidad !== 'TAKE_AWAY' && venta.deliveryInfo?.direccionSnapshot) {
    const snap = venta.deliveryInfo.direccionSnapshot as Record<string, unknown>;
    delivery = {
      clienteNombre: snap.clienteNombre ?? null,
      clienteTelefono: snap.clienteTelefono ?? null,
      direccion: snap.direccion ?? null,
      indicaciones: snap.indicaciones ?? null,
      horaPrometida: venta.deliveryInfo.horaPrometida
        ? venta.deliveryInfo.horaPrometida.toISOString()
        : null,
    };
  }

  return {
    numeroOrden: venta.numeroOrdenTurno,
    hora: venta.fechaApertura.toISOString().slice(11, 16),
    canal: venta.canal,
    items: venta.items.map((it) => {
      const mods = (it.modificadoresAplicados as Array<{ opcionNombre?: string }> | null) ?? [];
      return {
        cantidad: String(it.cantidad),
        nombre: it.nombreSnapshot,
        modificadores: mods
          .map((m) => m?.opcionNombre)
          .filter((x): x is string => typeof x === 'string'),
        observacion: it.observacion ?? undefined,
        parteDeCombo: it.combo?.nombre,
      };
    }),
    pcOrigen: venta.pcOrigen,
    delivery,
  };
}

/**
 * Encolar la comanda de cocina al crear/agregar items a una venta.
 * Solo encola si la venta tiene al menos un item con cocinaInterviene=true.
 */
export async function encolarComandaCocina(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    select: { tieneCocina: true },
  });
  if (!venta?.tieneCocina) return; // nada para cocina, no encolar

  const payload = await buildComandaPayload(ventaId, tx);
  await encolarTrabajo({
    tipo: TipoTrabajoImpresion.COMANDA_COCINA,
    destino: 'KITCHEN',
    payload,
    ventaId,
    tx,
  });
}

/**
 * Encolar comanda CANCELADA — la cocinera la recibe con marca "*** CANCELADA ***"
 * para tachar el pedido y descartar la prep si ya empezó.
 */
export async function encolarComandaCancelada(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const payload = await buildComandaPayload(ventaId, tx);
  await encolarTrabajo({
    tipo: TipoTrabajoImpresion.COMANDA_CANCELADA,
    destino: 'KITCHEN',
    payload,
    ventaId,
    tx,
  });
}

/**
 * Trabajo TEST — útil para que el admin verifique que la impresora está OK
 * desde el panel de configuración (un click → sale un ticket "=== TEST OK ===").
 */
export async function encolarTrabajoTest(destino: DestinoImpresion) {
  return encolarTrabajo({
    tipo: TipoTrabajoImpresion.TEST,
    destino,
    payload: { destino },
  });
}

/**
 * Configuración runtime de impresoras (por destino). Se persiste en
 * `configuracion_sistema` con clave `impresora_kitchen|counter|delivery`.
 *
 * Defaults: 192.168.1.50/51/52:9100 con 42 chars de ancho (papel 80mm).
 * El admin puede cambiarlas desde el panel.
 */
export interface PrinterDestinoConfig {
  host: string;
  port: number;
  width: number;
  activa: boolean;
}

const DEFAULT_CONFIG: Record<DestinoImpresion, PrinterDestinoConfig> = {
  KITCHEN: { host: '192.168.1.50', port: 9100, width: 42, activa: true },
  COUNTER: { host: '192.168.1.51', port: 9100, width: 42, activa: true },
  DELIVERY: { host: '192.168.1.52', port: 9100, width: 42, activa: false },
};

export async function getConfigImpresion(): Promise<
  Record<DestinoImpresion, PrinterDestinoConfig>
> {
  const rows = await prisma.configuracionSistema.findMany({
    where: { categoria: 'impresoras' },
  });
  const byClave = new Map(rows.map((r) => [r.clave, r.valor]));
  const result: Record<DestinoImpresion, PrinterDestinoConfig> = { ...DEFAULT_CONFIG };
  for (const destino of ['KITCHEN', 'COUNTER', 'DELIVERY'] as const) {
    const raw = byClave.get(`impresora_${destino.toLowerCase()}`);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<PrinterDestinoConfig>;
      result[destino] = { ...DEFAULT_CONFIG[destino], ...parsed };
    } catch {
      /* fallback al default */
    }
  }
  return result;
}
