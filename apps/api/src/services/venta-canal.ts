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
import { encolarComandasCanceladas } from './impresion.js';
import { getConfigHorarios, resolverSlotActivo } from './horarios.js';

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

/** Resultado del pre-flight (`simularOrdenCanal`) — ninguna escritura ocurrió. */
export interface DiagnosticoOrdenCanal {
  /** true = la orden real se crearía sin errores AHORA MISMO. */
  ok: boolean;
  /** Motivos por los que la orden real fallaría o no crearía nada. */
  problemas: string[];
  horario: { enHorario: boolean; razon?: string };
  idempotencia: { yaExiste: boolean; ventaId?: string; numero?: number; estado?: string };
  cuentaACobrar: { nombre: string; existe: boolean };
  items: Array<{ codigo: string; cantidad: number; mapeado: boolean; nombre?: string }>;
  skusFaltantes: string[];
}

/**
 * MODO DE PRUEBA del puente: corre las MISMAS validaciones que `crearVentaCanal`
 * pero **sin escribir absolutamente nada**. Solo lecturas — no crea venta, no
 * abre sesión de caja, no registra pago, no encola impresión, no audita.
 *
 * Existe porque una orden real es destructiva de hecho: se auto-finaliza, entra
 * al cierre de caja del turno y dispara la comanda a la cocina. Probar el
 * contrato contra producción "a ver si anda" imprime papel y ensucia el cierre.
 * Con esto el integrador verifica el mapeo del menú y el shape del payload sin
 * tocar nada.
 *
 * Cubre los 3 modos de falla reales del endpoint vivo:
 *   - fuera de horario   → la orden real daría 423
 *   - SKU sin mapear     → la orden real daría 422
 *   - cuenta a cobrar faltante (seed) → la orden real explotaría al finalizar
 * …y además avisa si el (canal, idExternoCanal) ya fue ingerido (idempotencia).
 */
export async function simularOrdenCanal(orden: OrdenCanal): Promise<DiagnosticoOrdenCanal> {
  const canal = orden.canal as CanalVenta;
  const problemas: string[] = [];

  // 1. Horario — mismo resolver que usa getOrCreateSesionActual, pero puro:
  //    resolverSlotActivo no escribe, así que NO se crea la SesionCaja.
  const resolucion = resolverSlotActivo(await getConfigHorarios(), new Date());
  const enHorario = resolucion.tipo !== 'CERRADO';
  if (!enHorario) {
    problemas.push(
      `Fuera del horario de atención (${resolucion.razon}) — la orden real daría 423.`,
    );
  }

  // 2. Idempotencia — ¿este (canal, idExternoCanal) ya se ingirió?
  const existente = await prisma.venta.findFirst({
    where: { canal, idExternoCanal: orden.idExternoCanal },
    select: { id: true, numero: true, estado: true },
  });
  if (existente) {
    problemas.push(
      `Ya existe la venta #${existente.numero} para ${orden.canal}/${orden.idExternoCanal} — la orden real NO crearía otra (idempotente).`,
    );
  }

  // 3. Cuenta a cobrar del canal (viene del seed) — sin ella no se puede finalizar.
  const nombreCac = CUENTA_A_COBRAR_POR_CANAL[orden.canal];
  const receivable = await prisma.cuentaACobrar.findFirst({
    where: { nombre: nombreCac },
    select: { id: true },
  });
  if (!receivable) {
    problemas.push(
      `Falta la cuenta a cobrar "${nombreCac}" (seed) — la orden real no podría auto-finalizar.`,
    );
  }

  // 4. Mapeo de SKUs (SKU = Producto.codigo, activo).
  const codigos = [...new Set(orden.items.map((i) => i.codigo))];
  const productos = await prisma.producto.findMany({
    where: { codigo: { in: codigos }, activo: true },
    select: { codigo: true, nombre: true },
  });
  const porCodigo = new Map(productos.map((p) => [p.codigo as string, p.nombre]));
  const skusFaltantes = codigos.filter((c) => !porCodigo.has(c));
  if (skusFaltantes.length) {
    problemas.push(
      `SKUs sin mapear en el catálogo: ${skusFaltantes.join(', ')} — la orden real daría 422.`,
    );
  }

  return {
    ok: problemas.length === 0,
    problemas,
    horario: {
      enHorario,
      ...(resolucion.tipo === 'CERRADO' && { razon: resolucion.razon }),
    },
    idempotencia: {
      yaExiste: Boolean(existente),
      ...(existente && {
        ventaId: existente.id,
        numero: existente.numero,
        estado: existente.estado,
      }),
    },
    cuentaACobrar: { nombre: nombreCac, existe: Boolean(receivable) },
    items: orden.items.map((it) => ({
      codigo: it.codigo,
      cantidad: it.cantidad,
      mapeado: porCodigo.has(it.codigo),
      ...(porCodigo.has(it.codigo) && { nombre: porCodigo.get(it.codigo) }),
    })),
    skusFaltantes,
  };
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
          // Las plataformas mandan items sueltos, no promos del catálogo interno.
          promos: [],
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

/**
 * Resultado de anular una orden de canal. Siempre es información, nunca un
 * error HTTP: que la venta no exista es un caso NORMAL (la orden pudo haberse
 * rechazado, o haber entrado en dry-run), no una falla.
 */
export type ResultadoAnulacionCanal =
  | { resultado: 'ANULADA'; venta: Venta; pagosReversados: number }
  | { resultado: 'YA_ANULADA'; venta: Venta }
  | { resultado: 'NO_ENCONTRADA' };

/**
 * Anula la venta creada por una orden de plataforma que la plataforma canceló.
 *
 * POR QUÉ EXISTE: sin esto, un `ORDER_EVENT_CANCEL` de Rappi se logueaba y nada
 * más. La venta quedaba FINALIZADA, entraba al cierre de caja y al analytics
 * como facturada, y el cliente nunca pagó → **descuadre del turno**.
 *
 * Diferencias con `POST /ventas/:id/anular` (el camino humano):
 *
 * - **Sin PIN admin.** No hay humano: la plataforma es la autoridad sobre el
 *   estado de su propia orden. El control de acceso es el CHANNEL_INGEST_TOKEN.
 *   Queda igual de auditado (`recordAudit` con el usuario de sistema Canales).
 * - **Idempotente.** El webhook se reenvía; anular dos veces devuelve
 *   `YA_ANULADA` sin tocar nada.
 * - **Busca por `(canal, idExternoCanal)`**, no por el UUID interno: el
 *   integrador sólo conoce el id de la plataforma.
 *
 * INVARIANTE (ver CLAUDE.md): dentro del `$transaction` TODO usa `tx`, nunca el
 * prisma global — las cajas corren con connection_limit=1 y deadlockean.
 */
export async function anularVentaCanal(args: {
  canal: CanalPlataforma;
  idExternoCanal: string;
  motivo: string;
}): Promise<ResultadoAnulacionCanal> {
  const canal = args.canal as CanalVenta;
  const venta = await prisma.venta.findFirst({
    where: { canal, idExternoCanal: args.idExternoCanal },
  });
  if (!venta) return { resultado: 'NO_ENCONTRADA' };
  if (venta.estado === EstadoVenta.ANULADA) return { resultado: 'YA_ANULADA', venta };

  // Sólo las FINALIZADAS tienen pagos; una PROCESADA a medias no.
  const pagosAReversar =
    venta.estado === EstadoVenta.FINALIZADA
      ? await prisma.pago.findMany({
          where: { ventaId: venta.id, estado: EstadoPago.CONFIRMADO },
        })
      : [];

  const anulada = await prisma.$transaction(async (tx) => {
    // NO se toca `saldoActual`: las ventas no acreditan saldo a las cuentas
    // (se concilian a mano). Decrementar acá dejaría la cuenta en negativo —
    // el mismo bug que ya se corrigió en el anular humano.
    for (const pago of pagosAReversar) {
      await tx.pago.update({ where: { id: pago.id }, data: { estado: EstadoPago.ANULADO } });
    }

    const upd = await tx.venta.update({
      where: { id: venta.id },
      data: {
        estado: EstadoVenta.ANULADA,
        motivoAnulacion: args.motivo,
        fechaAnulacion: new Date(),
        usuarioAnulacionId: USUARIO_CANALES_ID,
      },
    });

    await recordAudit({
      tabla: 'ventas',
      registroId: venta.id,
      accion: 'TRANSITION',
      usuarioId: USUARIO_CANALES_ID,
      pcOrigen: `CANAL:${args.canal}`,
      valorAnterior: { estado: venta.estado, total: venta.total },
      valorNuevo: {
        estado: 'ANULADA',
        motivo: args.motivo,
        idExternoCanal: args.idExternoCanal,
        pagosReversados: pagosAReversar.length,
        montoReversado: pagosAReversar.reduce((s, p) => s + Number(p.monto), 0).toFixed(2),
      },
      tx,
    });

    // La cocina puede estar preparándolo: hay que mandarles la cancelación.
    await encolarComandasCanceladas(venta.id, tx);
    return upd;
  });

  return { resultado: 'ANULADA', venta: anulada, pagosReversados: pagosAReversar.length };
}
