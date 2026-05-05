import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { TipoTrabajoImpresion } from '@sta/db';

/**
 * Servicio de la cola de impresión.
 *
 * Encolar trabajos es idempotente vía `tx` opcional para que la creación de
 * la venta y la encolada del trabajo sean un único commit atómico.
 *
 * REGLAS DE ROUTING (qué venta va a qué comandera):
 *
 *   Comandera 1 = MOSTRADOR — todos los pedidos cobrados en mostrador
 *   Comandera 2 = DELIVERY  — todos los pedidos de delivery propio
 *                              (TELEFONO/WHATSAPP/WEB con DELIVERY_PROPIO)
 *   Comandera 3 = COCINA    — pedidos con items que requieren preparación
 *                              caliente + todos los de apps externas (RAPPI,
 *                              Pedidos YA, MELI, DELIVERATE)
 *
 * | Caso                                    | MOSTRADOR | DELIVERY | COCINA |
 * |-----------------------------------------|-----------|----------|--------|
 * | Mostrador + sin cocina                  | ✓         | ·        | ·      |
 * | Mostrador + con cocina                  | ✓         | ·        | ✓      |
 * | Delivery propio + sin cocina            | ·         | ✓        | ·      |
 * | Delivery propio + con cocina            | ·         | ✓        | ✓      |
 * | Apps externas (RAPPI/PYA/MELI/DELIVERATE)| ·        | ·        | ✓      |
 */

type DbClient = Prisma.TransactionClient | typeof prisma;

export type DestinoImpresion = 'MOSTRADOR' | 'DELIVERY' | 'COCINA';

/**
 * Devuelve la lista de destinos físicos donde tiene que imprimirse la
 * comanda de una venta, según las reglas operativas del local.
 *
 * @param canal       Canal de la venta (MOSTRADOR / TELEFONO / WHATSAPP /
 *                    RAPPI / PEDIDOS_YA / MERCADO_LIBRE / DELIVERATE / WEB)
 * @param tieneCocina true si al menos un item requiere preparación caliente
 */
export function determinarDestinos(
  canal: string,
  tieneCocina: boolean,
): DestinoImpresion[] {
  // Apps externas: solo cocina (la cocinera prepara y deja listo para que
  // el motoquero de la app retire). DELIVERATE va acá también — empresa de
  // delivery contratada que retira el pedido del local.
  if (canal === 'RAPPI' || canal === 'PEDIDOS_YA' || canal === 'MERCADO_LIBRE' || canal === 'DELIVERATE') {
    return ['COCINA'];
  }

  // Delivery propio (motoquero del local — Damián): Comandera 2.
  // + Cocina si tiene items que cocinan.
  if (canal === 'TELEFONO' || canal === 'WHATSAPP' || canal === 'WEB') {
    return tieneCocina ? ['DELIVERY', 'COCINA'] : ['DELIVERY'];
  }

  // Mostrador (default para canales no clasificados): Comandera 1.
  // + Cocina si tiene items que cocinan.
  return tieneCocina ? ['MOSTRADOR', 'COCINA'] : ['MOSTRADOR'];
}

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
 * Encolar comandas para una venta — aplica las reglas de `determinarDestinos`
 * y crea N trabajos (uno por destino físico). Por ejemplo:
 *   - Venta mostrador con pasta caliente → 2 trabajos (MOSTRADOR + COCINA)
 *   - Venta WhatsApp con bebida → 1 trabajo (DELIVERY)
 *   - Venta RAPPI con cualquier cosa → 1 trabajo (COCINA)
 *
 * Se llama al crear venta y al agregar items (la cocinera ve la versión
 * actualizada). Idempotente para retries: cada llamada genera trabajos
 * nuevos; los viejos quedan en la cola con su propia historia.
 */
export async function encolarComandasParaVenta(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<DestinoImpresion[]> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    select: { canal: true, tieneCocina: true },
  });
  if (!venta) return [];

  const destinos = determinarDestinos(venta.canal, venta.tieneCocina);
  if (destinos.length === 0) return [];

  const payload = await buildComandaPayload(ventaId, tx);
  for (const destino of destinos) {
    await encolarTrabajo({
      tipo: TipoTrabajoImpresion.COMANDA_COCINA,
      destino,
      payload,
      ventaId,
      tx,
    });
  }
  return destinos;
}

/**
 * Encolar comandas CANCELADAS para una venta — sale con marca
 * "*** CANCELADA ***" en todas las comanderas donde se imprimió el original
 * (mostrador / delivery / cocina), para que el operador en cada estación
 * tache el pedido.
 */
export async function encolarComandasCanceladas(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<DestinoImpresion[]> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    select: { canal: true, tieneCocina: true },
  });
  if (!venta) return [];

  const destinos = determinarDestinos(venta.canal, venta.tieneCocina);
  if (destinos.length === 0) return [];

  const payload = await buildComandaPayload(ventaId, tx);
  for (const destino of destinos) {
    await encolarTrabajo({
      tipo: TipoTrabajoImpresion.COMANDA_CANCELADA,
      destino,
      payload,
      ventaId,
      tx,
    });
  }
  return destinos;
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
  MOSTRADOR: { host: '192.168.1.50', port: 9100, width: 42, activa: true },
  DELIVERY: { host: '192.168.1.51', port: 9100, width: 42, activa: true },
  COCINA: { host: '192.168.1.52', port: 9100, width: 42, activa: true },
};

export async function getConfigImpresion(): Promise<
  Record<DestinoImpresion, PrinterDestinoConfig>
> {
  const rows = await prisma.configuracionSistema.findMany({
    where: { categoria: 'impresoras' },
  });
  const byClave = new Map(rows.map((r) => [r.clave, r.valor]));
  const result: Record<DestinoImpresion, PrinterDestinoConfig> = { ...DEFAULT_CONFIG };
  for (const destino of ['MOSTRADOR', 'DELIVERY', 'COCINA'] as const) {
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
