import { prisma } from '@sta/db/client';
import type { ModificadorAplicado } from '@sta/shared';
import type { ItemCanal, OrdenCanal } from '../venta-canal.js';
import {
  claveTraduccion,
  marcaItemExterno,
  normalizarNombre,
  productoComodin,
  registrarVistos,
  type VistoExterno,
} from '../traduccion-canal.js';

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
 * PRODUCTOS Y PRECIOS (decisión del 30/09): el menú vive en RAPPI. Cada ítem se
 * traduce por su id de RAPPI a un producto nuestro (services/traduccion-canal.ts)
 * y el precio es el de RAPPI. Lo que no tiene traducción entra con el comodín
 * y queda pendiente — el pedido nunca se rechaza por un producto desconocido.
 * El cuerpo entero queda en `payloadExterno`.
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

/** La clave estable de un ítem de RAPPI: su id; si no viene, el sku; si no, el nombre. */
function idExternoDe(it: ItemRappi): string {
  const id = it.id !== undefined && it.id !== null && String(it.id).trim() ? String(it.id).trim() : '';
  if (id) return id;
  const sku = it.sku ? String(it.sku).trim() : '';
  if (sku) return `sku:${sku}`;
  return `nombre:${normalizarNombre(it.name ?? '')}`;
}

/** El precio unitario que RAPPI le cobró al cliente por este ítem (con descuento, si lo hubo). */
function precioUnitarioDe(it: ItemRappi): number {
  const c = [it.unit_price_with_discount, it.price].find((v) => typeof v === 'number' && Number.isFinite(v));
  return typeof c === 'number' ? c : 0;
}

/**
 * El pedido de RAPPI, traducido al catálogo:
 *
 *   - cada producto de RAPPI (por su id) va al Producto que la encargada le
 *     asignó; si no tiene traducción, entra con el comodín "RAPPI — sin
 *     traducir" con el nombre de RAPPI, y queda PENDIENTE en la pantalla de
 *     traducciones. El pedido NUNCA se rechaza por eso;
 *   - el precio es el de RAPPI (unidad + sus extras), no el de nuestra lista;
 *   - los toppings traducidos van como el modificador real; los demás, como
 *     etiqueta con el nombre de RAPPI (se ven en la comanda igual);
 *   - un producto marcado IGNORAR (p. ej. "envío") no entra en la venta;
 *   - por peso: una unidad de RAPPI = `cantidadPorUnidad` de la traducción o
 *     el `cantidadDefault` del producto (así 2 unidades no son 2 gramos).
 */
export async function nuevaOrdenANeutral(p: NuevaOrdenRappi): Promise<OrdenCanal> {
  const od = p.order_detail;
  const itemsRappi = (od.items ?? []).filter((it) => !it.type || /product/i.test(it.type));

  const vistos: VistoExterno[] = [];
  for (const it of itemsRappi) {
    vistos.push({
      tipo: 'PRODUCTO',
      idExterno: idExternoDe(it),
      nombre: it.name?.trim() || String(it.sku ?? ''),
      sku: it.sku ? String(it.sku) : null,
      precio: precioUnitarioDe(it),
    });
    for (const s of it.subitems ?? []) {
      vistos.push({
        tipo: 'TOPPING',
        idExterno: idExternoDe(s),
        nombre: s.name?.trim() || String(s.sku ?? ''),
        sku: s.sku ? String(s.sku) : null,
        categoria: s.categoryDescription ?? null,
        precio: precioUnitarioDe(s),
      });
    }
  }
  const [trad, comodinId] = await Promise.all([
    registrarVistos('RAPPI', vistos, 'PEDIDO'),
    productoComodin('RAPPI'),
  ]);

  const productoIds = [...trad.values()].filter((t) => t.tipo === 'PRODUCTO' && t.productoId).map((t) => t.productoId as string);
  // Opciones: las de los toppings traducidos Y el sabor/tipo de los productos traducidos.
  const opcionIds = [...trad.values()].filter((t) => t.opcionId).map((t) => t.opcionId as string);
  const [productos, opciones] = await Promise.all([
    productoIds.length
      ? prisma.producto.findMany({ where: { id: { in: productoIds } }, select: { id: true, unidadPrecio: true, cantidadDefault: true, activo: true } })
      : [],
    opcionIds.length
      ? prisma.opcionModificador.findMany({ where: { id: { in: opcionIds } }, select: { id: true, nombre: true, grupo: { select: { id: true, nombre: true } } } })
      : [],
  ]);
  const productoPorId = new Map(productos.map((x) => [x.id, x]));
  const opcionPorId = new Map(opciones.map((x) => [x.id, x]));

  const items: ItemCanal[] = [];
  for (const it of itemsRappi) {
    const idExterno = idExternoDe(it);
    const t = trad.get(claveTraduccion('PRODUCTO', idExterno));
    if (t?.estado === 'IGNORAR') continue;
    const productoReal = t?.estado === 'TRADUCIDO' && t.productoId ? productoPorId.get(t.productoId) : undefined;
    const traducido = Boolean(productoReal && productoReal.activo);
    const unidades = Number(it.quantity ?? 1) || 1;
    let factor = 1;
    if (traducido && productoReal) {
      const porPeso = productoReal.unidadPrecio === 'POR_KILO' || productoReal.unidadPrecio === 'POR_GRAMO';
      const cpu = t?.cantidadPorUnidad ? Number(t.cantidadPorUnidad) : 0;
      const cd = productoReal.cantidadDefault ? Number(productoReal.cantidadDefault) : 0;
      factor = cpu > 0 ? cpu : porPeso && cd > 0 ? cd : 1;
    }

    let extras = 0;
    const modificadores: ModificadorAplicado[] = [];
    // El sabor/tipo que la traducción le asigna al producto ("Ravioles de
    // ricota" de RAPPI = Ravioles + Ricota). No suma precio: ya está en el de RAPPI.
    const sabor = traducido && t?.opcionId ? opcionPorId.get(t.opcionId) : undefined;
    if (sabor) {
      modificadores.push({
        grupoId: sabor.grupo.id,
        grupoNombre: sabor.grupo.nombre,
        opcionId: sabor.id,
        opcionNombre: sabor.nombre,
        deltaPrecio: '0',
      });
    }
    for (const s of it.subitems ?? []) {
      const ts = trad.get(claveTraduccion('TOPPING', idExternoDe(s)));
      if (ts?.estado === 'IGNORAR') continue;
      const precioTopping = precioUnitarioDe(s) * (Number(s.quantity ?? 1) || 1);
      extras += precioTopping;
      const opcion = ts?.estado === 'TRADUCIDO' && ts.opcionId ? opcionPorId.get(ts.opcionId) : undefined;
      modificadores.push(
        opcion
          ? {
              grupoId: opcion.grupo.id,
              grupoNombre: opcion.grupo.nombre,
              opcionId: opcion.id,
              opcionNombre: opcion.nombre,
              deltaPrecio: precioTopping.toFixed(2),
            }
          : {
              grupoId: String(s.toppingCategoryId ?? 'rappi'),
              grupoNombre: s.categoryDescription?.trim() || 'Extra',
              opcionId: `rappi:${idExternoDe(s)}`,
              opcionNombre: s.name?.trim() || String(s.sku ?? 'Extra'),
              deltaPrecio: precioTopping.toFixed(2),
            },
      );
    }
    // El precio de la línea, con los extras adentro: lo que RAPPI le cobró al
    // cliente por cada unidad de este ítem. Si el producto nuestro se vende por
    // peso, `cantidad` va en gramos y el precio unitario es por kilo (o por
    // gramo), así que se convierte para que el subtotal dé unidades × precio
    // de RAPPI: 2 × $4000 por "250 g" = 500 g a $16.000/kg = $8000.
    const precioPorUnidadRappi = precioUnitarioDe(it) + extras;
    const porKilo = productoReal?.unidadPrecio === 'POR_KILO';
    const precioUnitario =
      Math.round(((factor !== 1 ? precioPorUnidadRappi / factor : precioPorUnidadRappi) * (porKilo && factor !== 1 ? 1000 : 1)) * 100) / 100;
    const comentario = it.comments?.trim() ?? '';
    const observacion = traducido
      ? comentario
      : `${marcaItemExterno('RAPPI', idExterno)}${comentario ? ` ${comentario}` : ''}`;

    items.push({
      codigo: (it.sku ? String(it.sku) : idExterno).slice(0, 40),
      productoId: traducido && productoReal ? productoReal.id : comodinId,
      cantidad: unidades * factor,
      nombreCanal: (it.name?.trim() || String(it.sku ?? 'Producto RAPPI')).slice(0, 160),
      precioUnitarioCanal: precioUnitario,
      pendiente: !traducido,
      ...(observacion && { observacion: observacion.slice(0, 500) }),
      ...(modificadores.length && { modificadores }),
    });
  }

  const nombre = [p.customer?.first_name, p.customer?.last_name]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const telefono = p.customer?.phone_number?.trim();

  const totalRappi = od.totals?.total_order;
  const sinTraducir = items.filter((i) => i.pendiente).length;
  const observaciones = [
    `RAPPI #${od.order_id}`,
    od.payment_method ? `pagó ${od.payment_method}` : null,
    typeof totalRappi === 'number' ? `total RAPPI $${totalRappi}` : null,
    sinTraducir ? `${sinTraducir} ítem(s) sin traducir` : null,
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
