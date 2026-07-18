import { prisma } from '@sta/db/client';
import {
  CanalVenta,
  EstadoVenta,
  MetodoPago,
  EstadoPago,
  Prisma,
  type Venta,
} from '@sta/db';
import type { ModificadorAplicado } from '@sta/shared';
import { crearVenta } from './venta.js';
import { recordAudit } from './audit.js';

/**
 * Ingesta de ÓRDENES de canal (RAPPI / Pedidos YA / Mercado Libre) → crea la
 * venta en el POS. Es el "puente" que conecta los integradores de plataforma
 * con Santa Teresita (CLAUDE.md pendiente #5).
 *
 * Flujo:
 *   1. Idempotencia por (canal, idExternoCanal) — el webhook se puede reenviar.
 *   2. Mapea cada item por SKU = `Producto.codigo` → productoId. Si algún SKU
 *      no existe/activo, corta con MapeoIncompletoError (el integrador rechaza
 *      la orden en Rappi con OUT_OF_STOCK).
 *   3. Crea la venta con `crearVenta` (PROCESADA, precios server-side de la
 *      lista del canal, comanda de cocina sale al crear).
 *   4. Auto-finaliza: la orden ya viene PAGADA por la plataforma. Registra el
 *      cobro como cuenta a cobrar del canal → bucket 'plataforma'
 *      (clasificarCanalBucket) → NO infla la caja física, pero cuenta en
 *      "Total vendido". Fuera de horario → FueraDeHorarioError (423).
 *
 * INVARIANTE (ver CLAUDE.md): dentro del `$transaction` de finalización TODO
 * usa `tx`, nunca el prisma global. Las cajas corren con connection_limit=1 en
 * el pooler → una query global adentro de la tx deadlockea (incidente alpha.52).
 */

/** UUID fijo del usuario de sistema "Canales" (seed). No es un login humano. */
export const USUARIO_CANALES_ID = '00000000-0000-0000-0000-000000000009';

/** Canales de plataforma que este endpoint acepta (prepago, bucket plataforma). */
export const CANALES_PLATAFORMA = ['RAPPI', 'PEDIDOS_YA', 'MERCADO_LIBRE'] as const;
export type CanalPlataforma = (typeof CANALES_PLATAFORMA)[number];

/** Nombre de la cuenta a cobrar (receivable) por canal — matchea el seed. */
const CUENTA_A_COBRAR_POR_CANAL: Record<CanalPlataforma, string> = {
  RAPPI: 'RAPPI',
  PEDIDOS_YA: 'Pedidos YA',
  MERCADO_LIBRE: 'Mercado Libre',
};

/** Item normalizado de una orden de canal (SKU = `Producto.codigo`). */
export interface ItemCanal {
  codigo: string;
  cantidad: number;
  observacion?: string;
  modificadores?: ModificadorAplicado[];
}

/** Orden de canal normalizada (platform-neutral: sirve para RAPPI/PYA/MELI). */
export interface OrdenCanal {
  canal: CanalPlataforma;
  idExternoCanal: string;
  modalidad?: 'DELIVERY_PLATAFORMA' | 'TAKE_AWAY';
  items: ItemCanal[];
  cliente?: { nombre?: string; telefono?: string };
  entrega?: { direccion?: string; indicaciones?: string };
  observaciones?: string;
  /** Payload crudo de la plataforma — se guarda en Venta.payloadExterno. */
  payloadExterno?: unknown;
}

/** Uno o más SKU (`Producto.codigo`) de la orden no existen/activos. */
export class MapeoIncompletoError extends Error {
  skusFaltantes: string[];
  constructor(skus: string[]) {
    super(`SKUs sin mapear en el catálogo: ${skus.join(', ')}`);
    this.name = 'MapeoIncompletoError';
    this.skusFaltantes = skus;
  }
}

export interface ResultadoOrdenCanal {
  venta: Venta;
  duplicate: boolean;
}

export async function crearVentaCanal(orden: OrdenCanal): Promise<ResultadoOrdenCanal> {
  const canal = orden.canal as CanalVenta;

  // 1. Idempotencia: ¿ya existe una venta para (canal, idExternoCanal)?
  const existente = await prisma.venta.findFirst({
    where: { canal, idExternoCanal: orden.idExternoCanal },
  });
  // Ya finalizada/anulada → idempotente puro, devolvemos la misma sin tocar nada.
  if (existente && existente.estado !== EstadoVenta.PROCESADA) {
    return { venta: existente, duplicate: true };
  }

  // 2. Cuenta a cobrar del canal (receivable) — necesaria para auto-finalizar.
  const nombreCac = CUENTA_A_COBRAR_POR_CANAL[orden.canal];
  const receivable = await prisma.cuentaACobrar.findFirst({
    where: { nombre: nombreCac },
    select: { id: true, cuentaDestinoId: true },
  });
  if (!receivable) {
    throw new Error(
      `Falta la cuenta a cobrar "${nombreCac}" (seed). No se puede finalizar la orden de ${orden.canal}.`,
    );
  }

  // 3. Venta base. Si ya había una PROCESADA a medias (una finalización previa
  //    falló), la reusamos (self-heal). Si no, la creamos.
  let venta: Venta | null = existente;
  if (!venta) {
    // Map SKU (Producto.codigo) → productoId. Rechazamos si falta alguno.
    const codigos = [...new Set(orden.items.map((i) => i.codigo))];
    const productos = await prisma.producto.findMany({
      where: { codigo: { in: codigos }, activo: true },
      select: { id: true, codigo: true },
    });
    const porCodigo = new Map(productos.map((p) => [p.codigo as string, p.id]));
    const faltantes = codigos.filter((c) => !porCodigo.has(c));
    if (faltantes.length) throw new MapeoIncompletoError(faltantes);

    const modalidad = orden.modalidad ?? 'DELIVERY_PLATAFORMA';
    try {
      venta = await crearVenta({
        usuarioId: USUARIO_CANALES_ID,
        data: {
          canal: orden.canal,
          modalidad,
          pcOrigen: `CANAL:${orden.canal}`,
          idExternoCanal: orden.idExternoCanal,
          observaciones: orden.observaciones,
          enviarACocina: true, // la cocina arranca apenas entra la orden
          clienteNombre: orden.cliente?.nombre,
          clienteTelefono: orden.cliente?.telefono,
          direccionEntrega: orden.entrega?.direccion,
          indicacionesEntrega: orden.entrega?.indicaciones,
          items: orden.items.map((it) => ({
            productoId: porCodigo.get(it.codigo) as string,
            cantidad: it.cantidad,
            modificadores: it.modificadores ?? [],
            observacion: it.observacion,
          })),
        },
      });
    } catch (e) {
      // Carrera: dos webhooks duplicados en paralelo — el @@unique(canal,
      // idExternoCanal) rechaza el segundo. Reintentamos leyendo el existente.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const yaCreada = await prisma.venta.findFirst({
          where: { canal, idExternoCanal: orden.idExternoCanal },
        });
        if (!yaCreada) throw e;
        if (yaCreada.estado !== EstadoVenta.PROCESADA) {
          return { venta: yaCreada, duplicate: true };
        }
        venta = yaCreada; // quedó PROCESADA → seguimos a finalizar (self-heal)
      } else {
        throw e;
      }
    }
  }

  // 4. Auto-finalizar (tx-safe: SOLO `tx` adentro, nunca el prisma global).
  const ventaBase = venta as Venta;
  const total = Number(ventaBase.total);
  const finalizada = await prisma.$transaction(async (tx) => {
    // Idempotencia dura del pago: si una tx previa ya lo creó, no duplicamos.
    const pagosExistentes = await tx.pago.count({ where: { ventaId: ventaBase.id } });
    if (pagosExistentes === 0) {
      await tx.pago.create({
        data: {
          ventaId: ventaBase.id,
          metodo: MetodoPago.OTRO,
          cuentaId: receivable.cuentaDestinoId,
          cuentaACobrarId: receivable.id,
          monto: total.toFixed(2),
          estado: EstadoPago.CONFIRMADO,
        },
      });
    }
    const upd = await tx.venta.update({
      where: { id: ventaBase.id },
      data: {
        estado: EstadoVenta.FINALIZADA,
        fechaFinalizacion: new Date(),
        totalPagado: total.toFixed(2),
        usuarioCierreId: USUARIO_CANALES_ID,
        ...(orden.payloadExterno !== undefined && {
          payloadExterno: orden.payloadExterno as Prisma.InputJsonValue,
        }),
      },
    });
    await recordAudit({
      tabla: 'ventas',
      registroId: ventaBase.id,
      accion: 'TRANSITION',
      usuarioId: USUARIO_CANALES_ID,
      pcOrigen: `CANAL:${orden.canal}`,
      valorAnterior: { estado: 'PROCESADA' },
      valorNuevo: {
        estado: 'FINALIZADA',
        total,
        canal: ventaBase.canal,
        idExternoCanal: orden.idExternoCanal,
      },
      tx,
    });
    return upd;
  });

  return { venta: finalizada, duplicate: Boolean(existente) };
}
