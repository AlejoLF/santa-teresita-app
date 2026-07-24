'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { subtotalItem as sharedSubtotalItem } from '@sta/shared';

export interface ModificadorAplicado {
  grupoId: string;
  grupoNombre: string;
  opcionId: string;
  opcionNombre: string;
  deltaPrecio: string;
}

export interface CartItem {
  uid: string; // identidad local
  productoId: string;
  productoNombre: string;
  /** Nombre de la categoría del producto (ej. "Pastas frescas", "Bebidas").
   *  Lo usa la UI del carrito para mostrar tags como "(pasta fresca)". */
  categoriaNombre?: string;
  formaVenta: 'UNIDAD' | 'GRAMO' | 'PLANCHA' | 'PORCION';
  unidadPrecio:
    | 'POR_UNIDAD'
    | 'POR_GRAMO'
    | 'POR_KILO'
    | 'POR_PORCION'
    | 'POR_PLANCHA'
    | 'POR_DOCENA';
  cantidad: number;
  precioUnitario: number;
  modificadores: ModificadorAplicado[];
  observacion?: string;
  cocinaInterviene: boolean;
  parteDeComboId?: string;
  parteDeComboInstancia?: string;
}

/**
 * Una PROMO/COMBO en el carrito. El cajero elige el combo + cantidad + una
 * aclaración; el SERVIDOR la desarma en productos y reparte el precio (ver
 * venta.ts). Acá guardamos lo mínimo para mostrarla y cobrarla: el precio del
 * combo (para el subtotal en pantalla) y los componentes (solo display).
 */
export interface CartPromo {
  uid: string;
  comboId: string;
  nombre: string;
  cantidad: number;
  observacion?: string;
  /** Precio del combo por unidad (lo autoritativo lo recalcula el server). */
  precioCombo: number;
  /** Componentes para mostrar en el carrito ("2× Empanada, 1× Gaseosa"). */
  componentes: Array<{ nombre: string; cantidad: string }>;
}

export interface BorradorPedido {
  id: string;
  items: CartItem[];
  promos?: CartPromo[];
  canal: CartState['canal'];
  modalidad: CartState['modalidad'];
  clienteNombre?: string;
  clienteTelefono?: string;
  direccionEntrega?: string;
  indicacionesEntrega?: string;
  creadoAt: string; // ISO
}

interface CartState {
  items: CartItem[];
  promos: CartPromo[];
  canal: 'MOSTRADOR' | 'TELEFONO' | 'WHATSAPP' | 'WEB' | 'PEDIDOS_YA' | 'RAPPI' | 'MERCADO_LIBRE' | 'DELIVERATE';
  modalidad: 'TAKE_AWAY' | 'DELIVERY_PROPIO' | 'DELIVERY_PLATAFORMA' | 'DELIVERY_DELIVERATE';
  // Datos del cliente cuando es delivery — viajan al backend y a la comanda.
  clienteNombre: string;
  clienteTelefono: string;
  direccionEntrega: string;
  indicacionesEntrega: string;
  // ID de la orden en la plataforma externa (ej. "RAP-12345", "PYA-9876").
  // Se persiste en Venta.idExternoCanal para reconciliación con la app de la
  // plataforma. Solo aplica cuando canal es RAPPI / PEDIDOS_YA / MERCADO_LIBRE
  // / DELIVERATE.
  idExternoCanal: string;
  numeroOrden?: number; // del backend
  ventaId?: string; // del backend cuando ya se creó
  borradores: BorradorPedido[];
  agregar: (item: Omit<CartItem, 'uid'>) => void;
  remover: (uid: string) => void;
  editar: (uid: string, patch: Partial<CartItem>) => void;
  agregarPromo: (promo: Omit<CartPromo, 'uid'>) => void;
  removerPromo: (uid: string) => void;
  editarPromo: (uid: string, patch: Partial<CartPromo>) => void;
  vaciar: () => void;
  setCanal: (c: CartState['canal']) => void;
  setModalidad: (m: CartState['modalidad']) => void;
  setClienteNombre: (s: string) => void;
  setClienteTelefono: (s: string) => void;
  setDireccionEntrega: (s: string) => void;
  setIndicacionesEntrega: (s: string) => void;
  setIdExternoCanal: (s: string) => void;
  setVenta: (id: string, numero: number) => void;
  // Borradores
  guardarComoBorrador: () => string | null;
  restaurarBorrador: (id: string) => void;
  eliminarBorrador: (id: string) => void;
}

// Subtotal de un item del carrito. Delega al canónico de @sta/shared para que
// la convención de cantidad (gramos / docenas / unidades) sea idéntica entre
// frontend y backend. Devolvemos number porque la UI suma con +.
// Tope de borradores en memoria/localStorage. Por encima descartamos el más
// viejo (FIFO eviction). zustand/persist serializa todo el array en cada
// mutación; sin tope, una jornada larga puede agotar la quota ~5MB.
const MAX_BORRADORES = 10;

// Versión del schema persistido. Subir cuando cambien tipos de CartItem o
// CartState para que `migrate` pueda transformar payloads viejos.
const CART_PERSIST_VERSION = 2;

const calcSubtotal = (i: CartItem): number => {
  return Number(
    sharedSubtotalItem({
      cantidad: i.cantidad,
      precioUnitario: i.precioUnitario,
      unidadPrecio: i.unidadPrecio,
    }),
  );
};

export const subtotalItem = calcSubtotal;

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      promos: [],
      canal: 'MOSTRADOR',
      modalidad: 'TAKE_AWAY',
      clienteNombre: '',
      clienteTelefono: '',
      direccionEntrega: '',
      indicacionesEntrega: '',
      idExternoCanal: '',
      borradores: [],
      agregar: (item) =>
        set((s) => ({
          items: [...s.items, { ...item, uid: crypto.randomUUID() }],
        })),
      remover: (uid) =>
        set((s) => ({ items: s.items.filter((i) => i.uid !== uid) })),
      editar: (uid, patch) =>
        set((s) => ({
          items: s.items.map((i) => (i.uid === uid ? { ...i, ...patch } : i)),
        })),
      agregarPromo: (promo) =>
        set((s) => ({
          promos: [...s.promos, { ...promo, uid: crypto.randomUUID() }],
        })),
      removerPromo: (uid) =>
        set((s) => ({ promos: s.promos.filter((p) => p.uid !== uid) })),
      editarPromo: (uid, patch) =>
        set((s) => ({
          promos: s.promos.map((p) => (p.uid === uid ? { ...p, ...patch } : p)),
        })),
      vaciar: () =>
        set({
          items: [],
          promos: [],
          ventaId: undefined,
          numeroOrden: undefined,
          clienteNombre: '',
          clienteTelefono: '',
          direccionEntrega: '',
          indicacionesEntrega: '',
          idExternoCanal: '',
        }),
      setCanal: (c) => set({ canal: c }),
      setModalidad: (m) => set({ modalidad: m }),
      setClienteNombre: (s) => set({ clienteNombre: s }),
      setClienteTelefono: (s) => set({ clienteTelefono: s }),
      setDireccionEntrega: (s) => set({ direccionEntrega: s }),
      setIndicacionesEntrega: (s) => set({ indicacionesEntrega: s }),
      setIdExternoCanal: (s) => set({ idExternoCanal: s }),
      setVenta: (id, numero) => set({ ventaId: id, numeroOrden: numero }),
      // ── Borradores ──────────────────────────────────────────────────
      // Guarda el carrito actual como borrador y vacía el carrito.
      // Devuelve el id del borrador o null si el carrito estaba vacío.
      guardarComoBorrador: () => {
        const s = get();
        if (s.items.length === 0 && s.promos.length === 0) return null;
        const borrador: BorradorPedido = {
          id: crypto.randomUUID(),
          items: s.items,
          promos: s.promos,
          canal: s.canal,
          modalidad: s.modalidad,
          clienteNombre: s.clienteNombre || undefined,
          clienteTelefono: s.clienteTelefono || undefined,
          direccionEntrega: s.direccionEntrega || undefined,
          indicacionesEntrega: s.indicacionesEntrega || undefined,
          creadoAt: new Date().toISOString(),
        };
        // Cap de borradores en MAX_BORRADORES con FIFO eviction. localStorage
        // tiene quota ~5MB y un día con 20+ borradores acumulados puede
        // romper la persistencia silenciosamente.
        set({
          borradores: [borrador, ...s.borradores].slice(0, MAX_BORRADORES),
          items: [],
          promos: [],
          ventaId: undefined,
          numeroOrden: undefined,
          clienteNombre: '',
          clienteTelefono: '',
          direccionEntrega: '',
          indicacionesEntrega: '',
        });
        return borrador.id;
      },
      // Restaura un borrador al carrito (lo elimina de la lista de borradores).
      restaurarBorrador: (id) => {
        const s = get();
        const b = s.borradores.find((x) => x.id === id);
        if (!b) return;
        set({
          items: b.items,
          promos: b.promos ?? [],
          canal: b.canal,
          modalidad: b.modalidad,
          clienteNombre: b.clienteNombre ?? '',
          clienteTelefono: b.clienteTelefono ?? '',
          direccionEntrega: b.direccionEntrega ?? '',
          indicacionesEntrega: b.indicacionesEntrega ?? '',
          borradores: s.borradores.filter((x) => x.id !== id),
        });
      },
      eliminarBorrador: (id) =>
        set((s) => ({ borradores: s.borradores.filter((x) => x.id !== id) })),
    }),
    {
      name: 'sta-cart-vendedor',
      version: CART_PERSIST_VERSION,
      // Migración entre versiones del schema persistido. Si el state guardado
      // viene de una versión anterior, transformarlo aquí en vez de dejar que
      // se rehidrate con shape viejo y rompa silenciosamente.
      migrate: (persistedState: unknown, version: number) => {
        // v0 → v1: agregamos clienteNombre/Telefono/direccionEntrega/
        //         indicacionesEntrega y borradores con esos campos opcionales.
        // Asignamos defaults vacíos en payloads anteriores.
        if (version < 1 && persistedState && typeof persistedState === 'object') {
          const s = persistedState as Record<string, unknown>;
          return {
            ...s,
            clienteNombre: typeof s.clienteNombre === 'string' ? s.clienteNombre : '',
            clienteTelefono: typeof s.clienteTelefono === 'string' ? s.clienteTelefono : '',
            direccionEntrega: typeof s.direccionEntrega === 'string' ? s.direccionEntrega : '',
            indicacionesEntrega:
              typeof s.indicacionesEntrega === 'string' ? s.indicacionesEntrega : '',
          };
        }
        // v1 → v2: agregamos `promos` al carrito. Defaults vacíos.
        if (version < 2 && persistedState && typeof persistedState === 'object') {
          const s = persistedState as Record<string, unknown>;
          return { ...s, promos: Array.isArray(s.promos) ? s.promos : [] };
        }
        return persistedState;
      },
    },
  ),
);

export function selectSubtotal(s: CartState): number {
  const itemsTotal = s.items.reduce((acc, i) => acc + calcSubtotal(i), 0);
  const promosTotal = s.promos.reduce((acc, p) => acc + p.precioCombo * p.cantidad, 0);
  return itemsTotal + promosTotal;
}

/** Total de unidades en el carrito (items + promos), para badges/contadores. */
export function selectCantidadTotal(s: CartState): number {
  return s.items.length + s.promos.length;
}
