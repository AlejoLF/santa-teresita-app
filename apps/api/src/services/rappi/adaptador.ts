import { prisma } from '@sta/db/client';
import type { ModificadorAplicado } from '@sta/shared';
import type { OrdenCanal } from '../venta-canal.js';

/**
 * El traductor del `NEW_ORDER` de RAPPI al contrato neutral del sistema.
 *
 * Es el pendiente que quedó abierto el 29/08: no se podía escribir sin ver el
 * cuerpo que RAPPI manda de verdad. El cuerpo está en
 * docs/RAPPI-API-REFERENCE.md → "El payload de NEW_ORDER", transcrito del
 * portal, y esto es su mapeo:
 *
 *   order_detail.order_id      → idExternoCanal
 *   order_detail.items[].sku   → items[].codigo   (= Producto.codigo)
 *   order_detail.items[].quantity / comments
 *   order_detail.items[].subitems (type topping) → modificadores
 *   customer                   → cliente
 *   delivery_information       → entrega (forma no documentada: se copia lo que haya)
 *
 * PRECIOS: no se usan los de RAPPI. `crearVentaCanal` valúa con la lista de
 * precios del canal RAPPI, como cualquier venta (decisión de alpha.39: precios
 * server-side, nunca del cliente). El cuerpo entero queda en `payloadExterno`,
 * así que el total de RAPPI se puede comparar después.
 */

export interface ItemRappi {
  id?: string | number;
  sku?: string | null;
  name?: string;
  type?: string;
  quantity?: number;
  comments?: string | null;
  price?: number;
  unit_price_with_discount?: number;
  toppingId?: string | number | null;
  toppingCategoryId?: string | number | null;
  categoryDescription?: string | null;
  subitems?: ItemRappi[];
}

export interface NuevaOrdenRappi {
  order_detail: {
    order_id: string | number;
    delivery_method?: string;
    payment_method?: string;
    cooking_time?: number;
    created_at?: string;
    place_at?: string | null;
    delivery_information?: Record<string, unknown> | null;
    totals?: { total_order?: number; total_to_pay?: number } & Record<string, unknown>;
    items?: ItemRappi[];
  } & Record<string, unknown>;
  customer?: {
    first_name?: string;
    last_name?: string;
    phone_number?: string;
    email?: string;
  } | null;
  store?: { internal_id?: string; external_id?: string; name?: string } | null;
  /** "scheduled" en NEW_ORDER_SCHEDULED (aviso anticipado, montos en cero). */
  action?: string;
}

/** ¿Tiene la forma de un NEW_ORDER de RAPPI? */
export function esNuevaOrdenRappi(body: unknown): body is NuevaOrdenRappi {
  if (!body || typeof body !== 'object') return false;
  const od = (body as { order_detail?: unknown }).order_detail;
  if (!od || typeof od !== 'object') return false;
  const id = (od as { order_id?: unknown }).order_id;
  return typeof id === 'string' || typeof id === 'number';
}

/** ¿Tiene la forma de un ORDER_EVENT_CANCEL de RAPPI? */
export function esCancelacionRappi(
  body: unknown,
): body is { event: string; order_id: string | number; store_id?: string | number } {
  if (!body || typeof body !== 'object') return false;
  const b = body as { event?: unknown; order_id?: unknown };
  return typeof b.event === 'string' && (typeof b.order_id === 'string' || typeof b.order_id === 'number');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Un topping de RAPPI → un modificador nuestro.
 *
 * Para que se COBRE, `opcionId` tiene que ser el id real de la
 * `OpcionModificador` (así lo busca `deltaDeModificadores`). Cuando publicamos
 * el menú, el sku de cada topping es el `codigo` de la opción si lo tiene, o su
 * id. Acá se deshace ese camino. Si no se encuentra, el modificador igual va
 * (se ve en la comanda), pero con delta 0 — es mejor que perder el sabor.
 */
async function resolverToppings(
  items: ItemRappi[],
): Promise<Map<string, { id: string; nombre: string; grupoId: string; grupoNombre: string; delta: string }>> {
  const skus = new Set<string>();
  for (const it of items) for (const s of it.subitems ?? []) if (s.sku) skus.add(String(s.sku));
  if (skus.size === 0) return new Map();

  const lista = [...skus];
  const porId = lista.filter((s) => UUID_RE.test(s));
  const porCodigo = lista.filter((s) => !UUID_RE.test(s));
  const opciones = await prisma.opcionModificador.findMany({
    where: {
      OR: [
        ...(porId.length ? [{ id: { in: porId } }] : []),
        ...(porCodigo.length ? [{ codigo: { in: porCodigo } }] : []),
      ],
    },
    select: {
      id: true,
      nombre: true,
      codigo: true,
      deltaPrecio: true,
      grupo: { select: { id: true, nombre: true } },
    },
  });
  const out = new Map<string, { id: string; nombre: string; grupoId: string; grupoNombre: string; delta: string }>();
  for (const o of opciones) {
    const v = {
      id: o.id,
      nombre: o.nombre,
      grupoId: o.grupo.id,
      grupoNombre: o.grupo.nombre,
      delta: o.deltaPrecio.toString(),
    };
    out.set(o.id, v);
    if (o.codigo) out.set(o.codigo, v);
  }
  return out;
}

function esRetiro(deliveryMethod: string | undefined): boolean {
  return /pick|take|retir|marketplace_pickup/i.test(deliveryMethod ?? '');
}

/** Lo mejor que se puede sacar de `delivery_information`, cuya forma no está documentada. */
function direccionDe(info: Record<string, unknown> | null | undefined): {
  direccion?: string;
  indicaciones?: string;
} {
  if (!info || typeof info !== 'object') return {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = info[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  const direccion = pick('address', 'full_address', 'street', 'address_line', 'direccion');
  const indicaciones = pick('address_details', 'details', 'complement', 'indications', 'notes');
  return {
    ...(direccion && { direccion: direccion.slice(0, 300) }),
    ...(indicaciones && { indicaciones: indicaciones.slice(0, 300) }),
  };
}

/**
 * RAPPI vende UNIDADES; acá hay productos que se venden por peso. El menú los
 * publica como "una unidad = `cantidadDefault`" (p. ej. 500 g), así que cuando
 * vuelven 2 unidades hay que convertirlas a 2 × 500 g — que es la cantidad que
 * `crearVenta` espera para un producto POR_KILO/POR_GRAMO. Sin esto, dos
 * unidades entrarían como DOS GRAMOS.
 */
async function factorCantidadPorSku(skus: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (skus.length === 0) return out;
  const productos = await prisma.producto.findMany({
    where: { codigo: { in: skus } },
    select: { codigo: true, unidadPrecio: true, cantidadDefault: true },
  });
  for (const p of productos) {
    if (!p.codigo) continue;
    const porPeso = p.unidadPrecio === 'POR_KILO' || p.unidadPrecio === 'POR_GRAMO';
    const cd = p.cantidadDefault ? Number(p.cantidadDefault) : 0;
    out.set(p.codigo, porPeso && cd > 0 ? cd : 1);
  }
  return out;
}

export async function nuevaOrdenANeutral(p: NuevaOrdenRappi): Promise<OrdenCanal> {
  const od = p.order_detail;
  const itemsRappi = (od.items ?? []).filter(
    (it) => !it.type || /product/i.test(it.type),
  );
  const [toppings, factores] = await Promise.all([
    resolverToppings(itemsRappi),
    factorCantidadPorSku([...new Set(itemsRappi.map((it) => String(it.sku ?? '')).filter(Boolean))]),
  ]);

  const items = itemsRappi.map((it) => {
    const modificadores: ModificadorAplicado[] = (it.subitems ?? []).map((s) => {
      const sku = s.sku ? String(s.sku) : '';
      const conocido = sku ? toppings.get(sku) : undefined;
      return conocido
        ? {
            grupoId: conocido.grupoId,
            grupoNombre: conocido.grupoNombre,
            opcionId: conocido.id,
            opcionNombre: conocido.nombre,
            deltaPrecio: conocido.delta,
          }
        : {
            // Desconocido para el catálogo: se muestra igual, no se cobra.
            grupoId: String(s.toppingCategoryId ?? 'rappi'),
            grupoNombre: s.categoryDescription?.trim() || 'Extra',
            opcionId: sku || String(s.id ?? s.name ?? 'topping'),
            opcionNombre: s.name?.trim() || sku || 'Extra',
            deltaPrecio: '0',
          };
    });
    const sku = String(it.sku ?? '');
    const unidades = Number(it.quantity ?? 1) || 1;
    return {
      codigo: sku,
      cantidad: unidades * (factores.get(sku) ?? 1),
      ...(it.comments?.trim() && { observacion: it.comments.trim().slice(0, 500) }),
      ...(modificadores.length && { modificadores }),
    };
  });

  const nombre = [p.customer?.first_name, p.customer?.last_name]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const telefono = p.customer?.phone_number?.trim();

  const totalRappi = od.totals?.total_order;
  const observaciones = [
    `RAPPI #${od.order_id}`,
    od.payment_method ? `pagó ${od.payment_method}` : null,
    typeof totalRappi === 'number' ? `total RAPPI $${totalRappi}` : null,
    p.action === 'scheduled' && od.place_at ? `AGENDADO para ${od.place_at}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    canal: 'RAPPI',
    idExternoCanal: String(od.order_id),
    modalidad: esRetiro(od.delivery_method) ? 'TAKE_AWAY' : 'DELIVERY_PLATAFORMA',
    items,
    ...((nombre || telefono) && { cliente: { ...(nombre && { nombre }), ...(telefono && { telefono }) } }),
    ...(Object.keys(direccionDe(od.delivery_information)).length && {
      entrega: direccionDe(od.delivery_information),
    }),
    observaciones: observaciones.slice(0, 500),
    payloadExterno: p,
  };
}
