import { prisma } from '@sta/db/client';
import { CanalListaPrecios } from '@sta/db';
import { llamarRappi } from './cliente.js';
import { getRappiConfig, setRappiConfig } from './config.js';

/**
 * Capacidades de "Menú" del checklist: publicar el menú desde NUESTRO
 * catálogo, consultar si lo aprobaron, prender/apagar productos.
 * docs/RAPPI-API-REFERENCE.md → Menú.
 *
 * ─── Cómo se traduce el catálogo ─────────────────────────────────────────
 *
 *  producto (activo, con código) → item PRODUCT, sku = Producto.codigo
 *  categoría del tipo de producto → category (la sección del menú en RAPPI)
 *  grupos de modificadores aplicables → children TOPPING, agrupados por
 *    category = el grupo, con minQty/maxQty del grupo
 *  opción → sku = codigo de la opción, o su id si no tiene. El adaptador de
 *    NEW_ORDER deshace exactamente ese camino para que el sabor se COBRE.
 *
 * Los precios son los de la lista de precios del canal RAPPI (override del
 * producto, o precio base × ajuste de la lista), los mismos con los que
 * `crearVentaCanal` valúa el pedido cuando entra. RAPPI pide ENTEROS.
 *
 * ─── Productos por peso ──────────────────────────────────────────────────
 *
 * RAPPI vende UNIDADES. Un producto que acá se vende por kilo se publica como
 * "una unidad = `cantidadDefault`" (p. ej. 500 g), con el precio de esa
 * cantidad y la cantidad en el nombre. Si no tiene cantidad por defecto, no
 * hay forma de publicarlo y se lista aparte para que el dueño la cargue. El
 * adaptador aplica la misma regla al revés: 2 unidades → 2 × 500 g.
 *
 * Los COMBOS no se publican todavía: un pedido con un sku de combo no tendría
 * cómo entrar (`crearVentaCanal` mapea sólo `Producto.codigo`).
 */

const LEGACY = '/api/v2/restaurants-integrations-public-api';

interface CategoriaRappi {
  id: string;
  name: string;
  minQty: number;
  maxQty: number;
  sortingPosition: number;
}

interface ItemRappi {
  name: string;
  description: string;
  sku: string;
  type: 'PRODUCT' | 'TOPPING';
  price: number;
  imageUrl?: string;
  sortingPosition?: number;
  maxLimit?: number;
  combo?: boolean;
  category: CategoriaRappi;
  children: ItemRappi[];
}

export interface MenuRappi {
  storeId: string;
  items: ItemRappi[];
}

export interface ResumenMenu {
  productos: number;
  toppings: number;
  categorias: number;
  /** Nombres de productos activos que quedaron afuera, con el motivo. */
  excluidos: Array<{ nombre: string; motivo: string }>;
  combosOmitidos: number;
  lista: string;
}

/**
 * Precio unitario para RAPPI, y cómo se describe la unidad.
 * Devuelve null cuando no se puede publicar.
 */
export function precioUnidadRappi(p: {
  unidadPrecio: string;
  precioLista: number;
  cantidadDefault: number | null;
}): { precio: number; sufijoNombre: string | null } | null {
  switch (p.unidadPrecio) {
    case 'POR_KILO': {
      if (!p.cantidadDefault || p.cantidadDefault <= 0) return null;
      // cantidadDefault en gramos (mismo criterio que subtotalItem).
      return {
        precio: Math.round((p.precioLista * p.cantidadDefault) / 1000),
        sufijoNombre: `(${formatearGramos(p.cantidadDefault)})`,
      };
    }
    case 'POR_GRAMO': {
      if (!p.cantidadDefault || p.cantidadDefault <= 0) return null;
      return {
        precio: Math.round(p.precioLista * p.cantidadDefault),
        sufijoNombre: `(${formatearGramos(p.cantidadDefault)})`,
      };
    }
    default:
      return { precio: Math.round(p.precioLista), sufijoNombre: null };
  }
}

function formatearGramos(g: number): string {
  return g >= 1000 && g % 100 === 0 ? `${(g / 1000).toString().replace('.', ',')} kg` : `${Math.round(g)} g`;
}

export async function armarMenuRappi(storeId: string): Promise<{ menu: MenuRappi; resumen: ResumenMenu }> {
  const lista = await prisma.listaPrecios.findFirst({
    where: { canalDefault: CanalListaPrecios.RAPPI, activa: true },
    orderBy: { nombre: 'asc' },
  });
  if (!lista) throw new Error('No hay una lista de precios activa para el canal RAPPI.');
  const ajuste = Number(lista.ajustePctDefault);

  const [productos, aplicables, grupos, deltas, combos] = await Promise.all([
    prisma.producto.findMany({
      where: { activo: true },
      include: {
        tipoProducto: { include: { categoria: true } },
        preciosPorLista: { where: { listaId: lista.id }, take: 1 },
      },
      orderBy: [{ tipoProducto: { categoria: { orden: 'asc' } } }, { nombre: 'asc' }],
    }),
    prisma.modificadorAplicable.findMany(),
    prisma.grupoModificador.findMany({
      include: { opciones: { where: { activa: true }, orderBy: { orden: 'asc' } } },
    }),
    prisma.deltaOpcionPorLista.findMany({ where: { listaId: lista.id } }),
    prisma.combo.count({ where: { activo: true } }),
  ]);

  const deltaPorOpcion = new Map(deltas.map((d) => [d.opcionId, Number(d.deltaPrecio)]));
  const grupoPorId = new Map(grupos.map((g) => [g.id, g]));
  // Qué grupos aplican a cada producto: por producto directo y por su tipo.
  const gruposDeProducto = new Map<string, Set<string>>();
  const gruposDeTipo = new Map<string, Set<string>>();
  for (const a of aplicables) {
    if (a.productoId) {
      if (!gruposDeProducto.has(a.productoId)) gruposDeProducto.set(a.productoId, new Set());
      gruposDeProducto.get(a.productoId)!.add(a.grupoModificadorId);
    } else if (a.tipoProductoId) {
      if (!gruposDeTipo.has(a.tipoProductoId)) gruposDeTipo.set(a.tipoProductoId, new Set());
      gruposDeTipo.get(a.tipoProductoId)!.add(a.grupoModificadorId);
    }
  }

  const items: ItemRappi[] = [];
  const excluidos: ResumenMenu['excluidos'] = [];
  const categorias = new Set<string>();
  let toppings = 0;

  productos.forEach((p, idx) => {
    if (!p.codigo) {
      excluidos.push({ nombre: p.nombre, motivo: 'sin código (el código es el SKU en RAPPI)' });
      return;
    }
    const precioLista = p.preciosPorLista[0]
      ? Number(p.preciosPorLista[0].precioEfectivo)
      : Number(p.precioBase) * (1 + ajuste / 100);
    const pu = precioUnidadRappi({
      unidadPrecio: p.unidadPrecio,
      precioLista,
      cantidadDefault: p.cantidadDefault ? Number(p.cantidadDefault) : null,
    });
    if (!pu) {
      excluidos.push({
        nombre: p.nombre,
        motivo: 'se vende por peso y no tiene cantidad por defecto (RAPPI vende unidades)',
      });
      return;
    }
    if (pu.precio <= 0) {
      excluidos.push({ nombre: p.nombre, motivo: 'precio en cero' });
      return;
    }

    const cat = p.tipoProducto.categoria;
    categorias.add(cat.id);

    const idsGrupos = new Set<string>([
      ...(gruposDeProducto.get(p.id) ?? []),
      ...(gruposDeTipo.get(p.tipoProductoId) ?? []),
    ]);
    const children: ItemRappi[] = [];
    let gi = 0;
    for (const gid of idsGrupos) {
      const g = grupoPorId.get(gid);
      if (!g || g.opciones.length === 0) continue;
      const obligatorio =
        aplicables.find((a) => a.grupoModificadorId === gid && a.productoId === p.id)?.obligatorioOverride ??
        g.obligatorio;
      const catTopping: CategoriaRappi = {
        id: g.id,
        name: g.nombre,
        minQty: obligatorio ? Math.max(1, g.minOpciones) : Math.max(0, g.minOpciones),
        maxQty: g.tipoSeleccion === 'UNICA' ? 1 : Math.max(1, g.maxOpciones),
        sortingPosition: gi++,
      };
      g.opciones.forEach((o, oi) => {
        const delta = deltaPorOpcion.get(o.id) ?? Number(o.deltaPrecio);
        children.push({
          name: o.nombre,
          description: o.nombre,
          sku: o.codigo ?? o.id,
          type: 'TOPPING',
          price: Math.max(0, Math.round(delta)),
          sortingPosition: oi,
          maxLimit: 1,
          category: catTopping,
          children: [],
        });
        toppings++;
      });
    }

    items.push({
      name: pu.sufijoNombre ? `${p.nombre} ${pu.sufijoNombre}` : p.nombre,
      description: (p.descripcion?.trim() || p.nombre).slice(0, 500),
      sku: p.codigo,
      type: 'PRODUCT',
      price: pu.precio,
      ...(p.imagenUrl && /^https?:\/\//i.test(p.imagenUrl) && { imageUrl: p.imagenUrl }),
      sortingPosition: idx,
      combo: false,
      category: {
        id: cat.id,
        name: cat.nombre,
        minQty: 0,
        maxQty: 0,
        sortingPosition: cat.orden,
      },
      children,
    });
  });

  return {
    menu: { storeId, items },
    resumen: {
      productos: items.length,
      toppings,
      categorias: categorias.size,
      excluidos,
      combosOmitidos: combos,
      lista: lista.nombre,
    },
  };
}

/** `POST /menu`. RAPPI valida en el momento: 200 = queda pendiente de aprobación. */
export async function enviarMenu(storeId: string) {
  const { menu, resumen } = await armarMenuRappi(storeId);
  const r = await llamarRappi({
    arbol: 'legacy',
    metodo: 'POST',
    ruta: `${LEGACY}/menu`,
    body: menu,
    contexto: `enviar menú (${resumen.productos} productos) a la tienda ${storeId}`,
  });
  if (r.ok) {
    await setRappiConfig({
      menu: { enviadoAt: new Date().toISOString(), items: resumen.productos, estado: 'PENDIENTE', estadoAt: null },
    });
  }
  return {
    ok: r.ok,
    status: r.status,
    resumen,
    respuesta: r.body ?? r.texto,
    explicacion:
      r.status === 400
        ? 'RAPPI rechazó la estructura del menú; el detalle de la respuesta dice qué.'
        : r.status === 404
          ? 'RAPPI no encuentra esa tienda.'
          : r.status === 424
            ? 'RAPPI dice que hay ítems duplicados (dos productos o sabores con el mismo SKU).'
            : null,
  };
}

/** `GET /menu/approved/{storeId}` — sólo el código de estado está documentado. */
export async function estadoMenu(storeId: string) {
  const r = await llamarRappi({
    arbol: 'legacy',
    metodo: 'GET',
    ruta: `${LEGACY}/menu/approved/${encodeURIComponent(storeId)}`,
    contexto: `consultar estado del menú de la tienda ${storeId}`,
  });
  return { ok: r.ok, status: r.status, respuesta: r.body ?? r.texto };
}

/**
 * `PUT /availability/stores/items` — prender/apagar productos por NUESTRO sku.
 * Pide el `integrationId` de la tienda, no el `rappiId`.
 */
export async function setDisponibilidad(args: { prender: string[]; apagar: string[] }) {
  const cfg = await getRappiConfig();
  const storeIntegrationId = cfg.storeIntegrationId ?? cfg.storeId;
  if (!storeIntegrationId) throw new Error('Primero elegí la tienda de RAPPI.');
  const r = await llamarRappi({
    arbol: 'legacy',
    metodo: 'PUT',
    ruta: `${LEGACY}/availability/stores/items`,
    body: [{ store_integration_id: storeIntegrationId, items: { turn_on: args.prender, turn_off: args.apagar } }],
    contexto: `disponibilidad: prender ${args.prender.length}, apagar ${args.apagar.length}`,
  });
  return { ok: r.ok, status: r.status, respuesta: r.body ?? r.texto };
}
