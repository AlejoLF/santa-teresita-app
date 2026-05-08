'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { PedidosAbiertosList } from '@/components/PedidosAbiertosList';
import { ClienteDeliveryFields } from '@/components/vendedor/ClienteDeliveryFields';
import {
  useCart,
  selectSubtotal,
  subtotalItem,
  type CartItem,
  type ModificadorAplicado,
  type BorradorPedido,
} from '@/stores/cart';
import { cn } from '@/lib/cn';

interface Categoria {
  id: string;
  nombre: string;
  icono?: string | null;
  tipos: TipoProducto[];
}
interface TipoProducto {
  id: string;
  nombre: string;
  cocinaInterviene: boolean;
}
interface OpcionMod {
  id: string;
  nombre: string;
  deltaPrecio: string;
}
interface GrupoMod {
  id: string;
  nombre: string;
  obligatorio: boolean;
  tipoSeleccion: 'UNICA' | 'MULTIPLE';
  opciones: OpcionMod[];
}
interface ProductoMod {
  grupoModificador: GrupoMod;
}
interface SaborConCodigo {
  opcionId: string;
  grupoId: string;
  grupoNombre: string;
  nombre: string;
  deltaPrecio: string;
  codigo: string | null; // ej: "0040A", "0040B"
}
interface Producto {
  id: string;
  codigo: string | null;
  nombre: string;
  marca?: string | null;
  presentacion?: string | null;
  precioBase: string;
  formaVenta: 'UNIDAD' | 'GRAMO' | 'PLANCHA' | 'PORCION';
  unidadPrecio: CartItem['unidadPrecio'];
  cantidadDefault: string | null;
  tipoProducto: {
    id: string;
    nombre?: string;
    cocinaInterviene: boolean;
    /** Si true, el tipo se muestra como chip de sub-categoría en el cajero. */
    esSubcategoria?: boolean;
    categoria: { id: string; nombre: string };
  };
  modificadores: ProductoMod[];
  saboresResumen?: string[];
  sabores?: SaborConCodigo[];
  /**
   * Si está seteado, la pasta incluye salsa gratis hasta su cantidad de porciones.
   * El cajero debe seleccionar la salsa después de cargar la pasta.
   */
  incluyeSalsa?: 'SIMPLE' | 'ESPECIAL' | null;
}

// Helpers de unidad y display
function unidadCorta(unidadPrecio: string): string {
  switch (unidadPrecio) {
    case 'POR_KILO':
      return 'kg';
    case 'POR_GRAMO':
      return 'g';
    case 'POR_DOCENA':
      return 'doc';
    case 'POR_PORCION':
      return 'porc.';
    case 'POR_PLANCHA':
      return 'pl.';
    default:
      return 'Unid.';
  }
}

function unidadCantidad(unidadPrecio: string, formaVenta: string): string {
  // Cómo se cuenta la cantidad: gramos para POR_KILO, unidades para los demás.
  if (unidadPrecio === 'POR_KILO') return 'g';
  if (unidadPrecio === 'POR_DOCENA') return 'doc';
  if (formaVenta === 'PLANCHA') return 'plancha';
  if (formaVenta === 'PORCION') return 'porc.';
  return 'u';
}

function pasoIncremento(unidadPrecio: string): number {
  // POR_KILO se incrementa de 100 en 100 gramos. Resto es 1 unidad.
  return unidadPrecio === 'POR_KILO' ? 100 : 1;
}

// Reutilizamos el cálculo canónico del cart store (que delega al shared).
// Mantenemos el nombre local para no tocar todas las llamadas.
const calcSubtotal = subtotalItem;

export default function CargarPedidoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ventaAbiertaId = searchParams.get('ventaAbierta');
  const cart = useCart();
  const subtotal = useCart(selectSubtotal);

  const [categorias, setCategorias] = useState<Categoria[]>([]);
  // Cuando la categoría activa tiene productos con marca (ej: Estantería),
  // permitimos filtrar por una marca específica. null = ver todas las marcas.
  const [marcaActiva, setMarcaActiva] = useState<string | null>(null);
  // Sub-categoría (TipoProducto) activa dentro de la categoría seleccionada.
  // null = mostrar todas las sub-categorías.
  const [tipoActivo, setTipoActivo] = useState<string | null>(null);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [categoriaActiva, setCategoriaActiva] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [productoSeleccionado, setProductoSeleccionado] = useState<{
    producto: Producto;
    focoOpcionId: string | null;
  } | null>(null);
  // Modal de salsa que aparece después de cargar una pasta porción simple/especial.
  // Tracking: cantidad total de porciones cargadas y tipo de salsa que incluye.
  const [salsaModal, setSalsaModal] = useState<{
    tipo: 'SIMPLE' | 'ESPECIAL';
    porcionesIncluidas: number;
    nombrePasta: string;
  } | null>(null);
  const [usuario, setUsuario] = useState<{ nombre: string; rol: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ abiertos: 0, cerrados: 0 });
  const [enviando, setEnviando] = useState(false);
  const [showPedidosDrawer, setShowPedidosDrawer] = useState(false);
  // Total previo de la venta abierta cuando estás agregando items
  const [totalPrevioVenta, setTotalPrevioVenta] = useState<string | null>(null);
  // Si el cajero clickeó "Pedido nuevo +", forzamos mostrar el carrito vacío
  // (en vez de la lista de pedidos abiertos) para indicarle visualmente que arranca uno nuevo.
  const [forzarCarritoVacio, setForzarCarritoVacio] = useState(false);
  // Modal de confirmación cuando se quiere empezar un pedido nuevo con items en el carrito
  const [confirmarNuevo, setConfirmarNuevo] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const categoryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const subcatRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const marcaRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const productCardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Reset refs cuando cambian los productos visibles
  productCardRefs.current = [];

  // Foco automático en la barra de búsqueda al abrir + después de cualquier acción.
  useEffect(() => {
    const timer = setTimeout(() => {
      // Solo enfocar si no hay un modal abierto que ya tomó el foco.
      if (!productoSeleccionado && !salsaModal) {
        searchInputRef.current?.focus();
      }
    }, 100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productoSeleccionado, salsaModal, showPedidosDrawer]);

  // Helper: encuentra el botón cuya posición horizontal sea la más cercana
  // al centro X del botón actual.
  function findClosestX(refs: HTMLButtonElement[], targetX: number): HTMLButtonElement | null {
    if (refs.length === 0) return null;
    let best: HTMLButtonElement = refs[0]!;
    let bestDx = Infinity;
    for (const r of refs) {
      const rect = r.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const dx = Math.abs(cx - targetX);
      if (dx < bestDx) {
        bestDx = dx;
        best = r;
      }
    }
    return best;
  }

  // Helper: encuentra el botón en la PRIMERA fila (Y mínima) cuya X esté más
  // cerca de targetX. Para saltar de categoría a marcas o productos: queremos
  // siempre caer en la fila superior, no en la columna más cercana de cualquier fila.
  function findFirstRowClosestX(targets: HTMLButtonElement[], targetX: number): HTMLButtonElement | null {
    if (targets.length === 0) return null;
    let minY = Infinity;
    for (const t of targets) {
      const r = t.getBoundingClientRect();
      if (r.top < minY) minY = r.top;
    }
    const ROW_TOL = 8;
    const firstRow = targets.filter((t) => Math.abs(t.getBoundingClientRect().top - minY) <= ROW_TOL);
    return findClosestX(firstRow, targetX);
  }

  // Geometría: encuentra el siguiente botón en una dirección dentro de una colección.
  // Se usa para navegar el grid de productos donde sí queremos ↑↓ por filas.
  function focusGeometricInRefs(
    current: HTMLElement,
    direction: 'up' | 'down' | 'left' | 'right',
    refs: HTMLButtonElement[],
  ): boolean {
    if (refs.length === 0) return false;
    const cur = current.getBoundingClientRect();
    const cx = cur.left + cur.width / 2;
    const cy = cur.top + cur.height / 2;
    const ROW_TOL = Math.max(8, cur.height * 0.4);

    let best: { el: HTMLElement; score: number } | null = null;
    for (const el of refs) {
      if (el === current) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;
      let primary: number;
      let secondary: number;
      switch (direction) {
        case 'down':
          if (dy <= ROW_TOL) continue;
          primary = dy;
          secondary = Math.abs(dx);
          break;
        case 'up':
          if (dy >= -ROW_TOL) continue;
          primary = -dy;
          secondary = Math.abs(dx);
          break;
        case 'right':
          if (Math.abs(dy) > ROW_TOL || dx <= 0) continue;
          primary = dx;
          secondary = Math.abs(dy);
          break;
        case 'left':
          if (Math.abs(dy) > ROW_TOL || dx >= 0) continue;
          primary = -dx;
          secondary = Math.abs(dy);
          break;
      }
      const score = secondary * 4 + primary;
      if (!best || score < best.score) best = { el, score };
    }
    if (best) {
      best.el.focus();
      return true;
    }
    return false;
  }

  // Helpers DOM-based: traen los botones navegables actuales sin depender de refs.
  // Más confiable que ref arrays porque siempre refleja el DOM "ahora mismo".
  function getNavButtons(section: 'category' | 'subcat' | 'marca' | 'product'): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-nav="${section}"]`));
  }

  // Navegación:
  //   - ←→ : siguiente/anterior dentro de la misma sección (lineal)
  //   - ↑↓ : PRIMERO intenta encontrar otra fila de la misma sección
  //          (porque las categorías/marcas pueden envolver en múltiples filas);
  //          si no hay → salta a la sección siguiente/anterior
  //   - Productos: geométrico dentro del grid en todas direcciones;
  //                ↑ desde la primera fila sale del grid hacia marcas/categorías
  function onKeyDownCategoria(_idx: number, e: React.KeyboardEvent<HTMLButtonElement>) {
    const cur = e.currentTarget;
    const cx = cur.getBoundingClientRect().left + cur.getBoundingClientRect().width / 2;
    const cats = getNavButtons('category');
    const idx = cats.indexOf(cur);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // 1. ¿Hay otra fila de categorías abajo? (categorías envueltas) — NO commit todavía
      if (focusGeometricInRefs(cur, 'down', cats)) return;
      // Estamos por SALIR de categorías → commit la actual
      cur.click();
      // 2. Sub-categoría → marcas → productos
      setTimeout(() => {
        const subs = getNavButtons('subcat');
        if (subs.length > 0) { findFirstRowClosestX(subs, cx)?.focus(); return; }
        const ms = getNavButtons('marca');
        if (ms.length > 0) { findFirstRowClosestX(ms, cx)?.focus(); return; }
        const ps = getNavButtons('product');
        findFirstRowClosestX(ps, cx)?.focus();
      }, 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focusGeometricInRefs(cur, 'up', cats)) return;
      searchInputRef.current?.focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (idx >= 0 && cats[idx + 1]) cats[idx + 1]!.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (idx > 0) cats[idx - 1]!.focus();
    } else if (e.key === 'Enter') {
      // Enter: commit actual + advance al siguiente nivel
      e.preventDefault();
      cur.click();
      setTimeout(() => {
        const subs = getNavButtons('subcat');
        if (subs.length > 0) { findFirstRowClosestX(subs, cx)?.focus(); return; }
        const ms = getNavButtons('marca');
        if (ms.length > 0) { findFirstRowClosestX(ms, cx)?.focus(); return; }
        const ps = getNavButtons('product');
        findFirstRowClosestX(ps, cx)?.focus();
      }, 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
  }

  function onKeyDownMarca(_idx: number, e: React.KeyboardEvent<HTMLButtonElement>) {
    const cur = e.currentTarget;
    const cx = cur.getBoundingClientRect().left + cur.getBoundingClientRect().width / 2;
    const ms = getNavButtons('marca');
    const idx = ms.indexOf(cur);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // 1. ¿Hay otra fila de marcas abajo? — NO commit todavía
      if (focusGeometricInRefs(cur, 'down', ms)) return;
      // Estamos por SALIR de marcas → commit la actual
      cur.click();
      setTimeout(() => {
        const ps = getNavButtons('product');
        findFirstRowClosestX(ps, cx)?.focus();
      }, 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focusGeometricInRefs(cur, 'up', ms)) return;
      // Subir a sub-cat (si hay) o categoría
      const subs = getNavButtons('subcat');
      if (subs.length > 0) { findFirstRowClosestX(subs, cx)?.focus(); return; }
      const cats = getNavButtons('category');
      findFirstRowClosestX(cats, cx)?.focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (idx >= 0 && ms[idx + 1]) ms[idx + 1]!.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (idx > 0) ms[idx - 1]!.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      cur.click();
      setTimeout(() => {
        const ps = getNavButtons('product');
        findFirstRowClosestX(ps, cx)?.focus();
      }, 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
  }

  // Handler para chips de SUB-CATEGORÍA (TipoProducto)
  // Solo aparecen cuando la categoría activa tiene 2+ tipos con productos.
  function onKeyDownSubCat(_idx: number, e: React.KeyboardEvent<HTMLButtonElement>) {
    const cur = e.currentTarget;
    const cx = cur.getBoundingClientRect().left + cur.getBoundingClientRect().width / 2;
    const subs = getNavButtons('subcat');
    const idx = subs.indexOf(cur);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (focusGeometricInRefs(cur, 'down', subs)) return;
      cur.click();
      setTimeout(() => {
        const ms = getNavButtons('marca');
        if (ms.length > 0) { findFirstRowClosestX(ms, cx)?.focus(); return; }
        const ps = getNavButtons('product');
        findFirstRowClosestX(ps, cx)?.focus();
      }, 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focusGeometricInRefs(cur, 'up', subs)) return;
      const cats = getNavButtons('category');
      findFirstRowClosestX(cats, cx)?.focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (idx >= 0 && subs[idx + 1]) subs[idx + 1]!.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (idx > 0) subs[idx - 1]!.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      cur.click();
      setTimeout(() => {
        const ms = getNavButtons('marca');
        if (ms.length > 0) { findFirstRowClosestX(ms, cx)?.focus(); return; }
        const ps = getNavButtons('product');
        findFirstRowClosestX(ps, cx)?.focus();
      }, 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
  }

  function onKeyDownProducto(_idx: number, e: React.KeyboardEvent<HTMLButtonElement>) {
    const cur = e.currentTarget;
    const cx = cur.getBoundingClientRect().left + cur.getBoundingClientRect().width / 2;
    const ps = getNavButtons('product');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusGeometricInRefs(cur, 'down', ps);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // Si estoy en la primera fila del grid, salir hacia marcas → sub-cat → categoría
      if (!focusGeometricInRefs(cur, 'up', ps)) {
        const ms = getNavButtons('marca');
        if (ms.length > 0) { findClosestX(ms, cx)?.focus(); return; }
        const subs = getNavButtons('subcat');
        if (subs.length > 0) { findClosestX(subs, cx)?.focus(); return; }
        findClosestX(getNavButtons('category'), cx)?.focus();
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusGeometricInRefs(cur, 'right', ps);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusGeometricInRefs(cur, 'left', ps);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
  }

  // Desde la barra de búsqueda: ↓ baja a categorías
  function onSearchKeyExtras(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && !search.trim()) {
      e.preventDefault();
      categoryRefs.current[0]?.focus();
    }
  }

  // Si estamos agregando a una venta abierta, fetch el total previo
  useEffect(() => {
    if (!ventaAbiertaId) {
      setTotalPrevioVenta(null);
      return;
    }
    (async () => {
      try {
        const v = await api.get<{ total: string }>(`/ventas/${ventaAbiertaId}`);
        setTotalPrevioVenta(v.total);
      } catch {
        /* silencioso */
      }
    })();
  }, [ventaAbiertaId]);

  // Cuando se agrega el primer item, desactivamos el flag de "carrito vacío forzado"
  // para que el comportamiento normal vuelva.
  useEffect(() => {
    if (cart.items.length > 0 && forzarCarritoVacio) {
      setForzarCarritoVacio(false);
    }
  }, [cart.items.length, forzarCarritoVacio]);

  // Cargar contexto inicial
  useEffect(() => {
    (async () => {
      try {
        const me = await api.get<{ usuario: { nombre: string; rol: string } }>('/auth/me');
        setUsuario(me.usuario);
        const cats = await api.get<{ categorias: Categoria[] }>('/catalogo/categorias');
        // Categorías ordenadas alfabéticamente (la encargada lo pidió así)
        const ordenadas = [...cats.categorias].sort((a, b) =>
          a.nombre.localeCompare(b.nombre, 'es'),
        );
        setCategorias(ordenadas);
        if (ordenadas[0]) {
          setCategoriaActiva(ordenadas[0].id);
        }
        const prods = await api.get<{ productos: Producto[] }>('/catalogo/productos?limit=2000');
        setProductos(prods.productos);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          router.replace('/login');
          return;
        }
        setError('No se pudo cargar el catálogo');
      }
    })();
  }, [router]);

  // Stats footer — flag de cancelación para evitar setState sobre componente
  // desmontado y solapamiento de ticks (last-write-wins).
  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const res = await api.get<{ abiertas: unknown[]; cerradas: unknown[] }>(
          '/ventas/historial-sesion',
        );
        if (cancelled) return;
        setStats({ abiertos: res.abiertas.length, cerrados: res.cerradas.length });
      } catch {
        /* silencioso */
      }
    };
    void fetchStats();
    const id = setInterval(fetchStats, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Watcher de la cola de impresión: si hay trabajos en ERROR, mostramos un
  // banner para que la cajera/encargada lo vea y vaya al panel admin.
  // El admin lo verifica solo si tiene rol ADMIN, sino el banner queda oculto.
  const [printerErrors, setPrinterErrors] = useState<number>(0);
  useEffect(() => {
    if (usuario?.rol !== 'ADMIN' && usuario?.rol !== 'VENDEDOR') return;
    let cancelled = false;
    const checkPrinter = async () => {
      try {
        const res = await api.get<{ counts: Record<string, number> }>(
          '/admin/impresion/jobs?estado=ERROR&limit=1',
        );
        if (cancelled) return;
        setPrinterErrors(res.counts?.ERROR ?? 0);
      } catch {
        /* el endpoint solo es para ADMIN — si vendedor falla con 403, ignorar */
      }
    };
    void checkPrinter();
    const id = setInterval(checkPrinter, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [usuario?.rol]);

  // Productos de la categoría activa (sin filtrar por búsqueda) — base para el panel de marcas
  const productosCategoria = useMemo(() => {
    if (!categoriaActiva) return [];
    return productos.filter((p) => p.tipoProducto.categoria.id === categoriaActiva);
  }, [productos, categoriaActiva]);

  // Sub-categorías visibles en el cajero. SOLO los tipos marcados como esSubcategoria=true
  // (Bebidas seedeadas + creadas explícitamente por admin via "Añadir → Subcategoría").
  // Los tipos auto-derivados del Excel (Conservas, Aceites, brand-as-tipo, etc.)
  // NO aparecen acá porque son ruido para el cajero.
  const tiposDeCategoria = useMemo(() => {
    const map = new Map<string, { id: string; nombre: string; cuenta: number }>();
    for (const p of productosCategoria) {
      const t = p.tipoProducto;
      if (!t.esSubcategoria) continue;
      const nombre = t.nombre ?? '—';
      if (!map.has(t.id)) map.set(t.id, { id: t.id, nombre, cuenta: 0 });
      map.get(t.id)!.cuenta += 1;
    }
    return Array.from(map.values()).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }, [productosCategoria]);

  const mostrarPanelSubcategorias = tiposDeCategoria.length >= 2 && !search.trim();

  // Marcas — pero filtradas por sub-categoría activa si hay
  const marcasDeCategoria = useMemo(() => {
    const marcas = new Set<string>();
    const base = tipoActivo
      ? productosCategoria.filter((p) => p.tipoProducto.id === tipoActivo)
      : productosCategoria;
    for (const p of base) {
      if (p.marca && p.marca.trim()) marcas.add(p.marca.trim());
    }
    return Array.from(marcas).sort((a, b) => a.localeCompare(b, 'es'));
  }, [productosCategoria, tipoActivo]);

  const mostrarPanelMarcas = marcasDeCategoria.length >= 3 && !search.trim();

  // Reset al cambiar de categoría / subcategoría
  useEffect(() => {
    setMarcaActiva(null);
    setTipoActivo(null);
  }, [categoriaActiva]);
  useEffect(() => {
    setMarcaActiva(null);
  }, [tipoActivo]);

  const productosVisibles = useMemo(() => {
    let lista = productos;
    const trimmed = search.trim();
    if (trimmed) {
      const q = trimmed.toLowerCase();
      const esCodigo = /^\d{1,4}$/.test(trimmed);
      lista = lista.filter((p) => {
        if (esCodigo) {
          const codigoBuscado = trimmed.padStart(4, '0');
          return p.codigo === codigoBuscado || (p.codigo?.startsWith(trimmed) ?? false);
        }
        return (
          p.nombre.toLowerCase().includes(q) ||
          (p.marca ?? '').toLowerCase().includes(q) ||
          (p.presentacion ?? '').toLowerCase().includes(q) ||
          (p.codigo ?? '').toLowerCase().includes(q) ||
          (p.saboresResumen ?? []).some((s) => s.toLowerCase().includes(q))
        );
      });
    } else if (categoriaActiva) {
      lista = lista.filter((p) => p.tipoProducto.categoria.id === categoriaActiva);
      if (tipoActivo) {
        lista = lista.filter((p) => p.tipoProducto.id === tipoActivo);
      }
      if (mostrarPanelMarcas && marcaActiva) {
        lista = lista.filter((p) => (p.marca ?? '').trim() === marcaActiva);
      }
    }
    return lista;
  }, [productos, categoriaActiva, tipoActivo, search, mostrarPanelMarcas, marcaActiva]);

  function abrirAgregar(p: Producto, focoOpcionId: string | null = null) {
    if (!p.modificadores.length && !p.incluyeSalsa) {
      cart.agregar({
        productoId: p.id,
        productoNombre: p.nombre,
        categoriaNombre: p.tipoProducto.categoria.nombre,
        formaVenta: p.formaVenta,
        unidadPrecio: p.unidadPrecio,
        cantidad: p.cantidadDefault ? Number(p.cantidadDefault) : 1,
        precioUnitario: Number(p.precioBase),
        modificadores: [],
        cocinaInterviene: p.tipoProducto.cocinaInterviene,
      });
      return;
    }
    setProductoSeleccionado({ producto: p, focoOpcionId });
  }

  // Handler del Enter en la barra de búsqueda.
  // Sistema Santa Teresita: códigos cortos (1-4 dígitos).
  //   - Cada SABOR tiene su propio código ("0" = Ravioles VYR, "60" = Salsa Príncipe).
  //   - Cada PRODUCTO standalone tiene su código ("8" = Ñoquis, "12" = Lasagna).
  // Si el código matchea un sabor → abre modal con ese sabor preseleccionado y foco
  // en su input de cantidad (la encargada tipea cantidad y Enter para agregar).
  async function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const trimmed = search.trim();
    if (!trimmed) return;
    e.preventDefault();
    if (/^\d+$/.test(trimmed)) {
      try {
        const res = await api.get<{
          producto: Producto;
          saborPreseleccionado: { opcionId: string; grupoId: string; nombre: string } | null;
        }>(`/catalogo/buscar-por-codigo/${trimmed}`);
        if (!res.producto.modificadores.length && !res.producto.incluyeSalsa) {
          // Standalone sin salsa → agregar directo
          cart.agregar({
            productoId: res.producto.id,
            productoNombre: res.producto.nombre,
            categoriaNombre: res.producto.tipoProducto.categoria.nombre,
            formaVenta: res.producto.formaVenta,
            unidadPrecio: res.producto.unidadPrecio,
            cantidad: res.producto.cantidadDefault ? Number(res.producto.cantidadDefault) : 1,
            precioUnitario: Number(res.producto.precioBase),
            modificadores: [],
            cocinaInterviene: res.producto.tipoProducto.cocinaInterviene,
          });
        } else {
          // Tiene sabores O incluye salsa → abrir modal
          setProductoSeleccionado({
            producto: res.producto,
            focoOpcionId: res.saborPreseleccionado?.opcionId ?? null,
          });
        }
        setSearch('');
        return;
      } catch {
        // Caer al search local si la API no encuentra
      }
    }
    // Fallback: si solo hay 1 producto visible (filtrado por nombre), abrirlo
    if (productosVisibles.length === 1) {
      abrirAgregar(productosVisibles[0]!);
      setSearch('');
    }
  }

  // Agrega el producto con un sabor pre-seleccionado (búsqueda por código tipo "0040B")
  function agregarConSabor(p: Producto, sabor: SaborConCodigo) {
    cart.agregar({
      productoId: p.id,
      productoNombre: p.nombre,
      categoriaNombre: p.tipoProducto.categoria.nombre,
      formaVenta: p.formaVenta,
      unidadPrecio: p.unidadPrecio,
      cantidad: p.cantidadDefault ? Number(p.cantidadDefault) : 1,
      precioUnitario: Number(p.precioBase) + Number(sabor.deltaPrecio || 0),
      modificadores: [
        {
          grupoId: sabor.grupoId,
          grupoNombre: sabor.grupoNombre,
          opcionId: sabor.opcionId,
          opcionNombre: sabor.nombre,
          deltaPrecio: sabor.deltaPrecio,
        },
      ],
      cocinaInterviene: p.tipoProducto.cocinaInterviene,
    });
  }

  // Modo de envío: 'enviar' (queda en lista) | 'cobrar' (va directo a método de pago) | 'nuevo' (envía y limpia para cargar otro)
  async function procesarPedido(modo: 'enviar' | 'cobrar' | 'nuevo') {
    if (cart.items.length === 0 || enviando) return;
    setEnviando(true);
    setError(null);
    const itemsPayload = cart.items.map((i) => ({
      productoId: i.productoId,
      cantidad: i.cantidad,
      modificadores: i.modificadores,
      observacion: i.observacion,
      parteDeComboId: i.parteDeComboId,
      parteDeComboInstancia: i.parteDeComboInstancia,
    }));
    try {
      if (ventaAbiertaId) {
        await api.post(`/ventas/${ventaAbiertaId}/items`, { items: itemsPayload });
        cart.vaciar();
        if (modo === 'cobrar') {
          router.push(`/venta/${ventaAbiertaId}?cobrar=1`);
        } else {
          router.push(`/venta/${ventaAbiertaId}`);
        }
        return;
      }
      const esDelivery = cart.modalidad !== 'TAKE_AWAY';
      const res = await api.post<{
        id: string;
        numero: number;
        numeroOrdenTurno: number;
        tieneCocina: boolean;
      }>('/ventas', {
        canal: cart.canal,
        modalidad: cart.modalidad,
        pcOrigen: localStorage.getItem('sta_pc_origen') ?? 'PC1',
        items: itemsPayload,
        // Datos de cliente cuando es delivery — viajan a deliveryInfo y a la comanda.
        ...(esDelivery && cart.clienteNombre.trim() && { clienteNombre: cart.clienteNombre.trim() }),
        ...(esDelivery && cart.clienteTelefono.trim() && { clienteTelefono: cart.clienteTelefono.trim() }),
        ...(esDelivery && cart.direccionEntrega.trim() && { direccionEntrega: cart.direccionEntrega.trim() }),
        ...(esDelivery && cart.indicacionesEntrega.trim() && { indicacionesEntrega: cart.indicacionesEntrega.trim() }),
        // Nº de orden en la plataforma externa (RAPPI, PYA, MELI, DELIVERATE).
        ...(cart.idExternoCanal.trim() && { idExternoCanal: cart.idExternoCanal.trim() }),
      });
      cart.vaciar();
      if (modo === 'cobrar') {
        // Va directo a método de pago
        router.push(`/venta/${res.id}?cobrar=1`);
      } else {
        // Vuelve al cajero limpio (queda en la lista de pedidos abiertos)
        router.push('/cargar-pedido');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al procesar el pedido');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="grid grid-rows-[56px_1fr_48px] h-screen">
      {/* Header */}
      <header className="bg-teresita-700 text-cream-50 px-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {usuario?.rol === 'ADMIN' && (
            <button
              onClick={() => router.push('/admin')}
              className="bg-teresita-900 hover:bg-ink-900/30 text-cream-50 px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5"
              title="Volver al panel admin"
            >
              <span>←</span>
              <span>Panel admin</span>
            </button>
          )}
          <span className="text-2xl">🍝</span>
          <span className="font-display text-md tracking-tight">SANTA TERESITA</span>
          <span className="text-xs text-cream-100 ml-4">
            {usuario?.rol === 'ADMIN' ? (
              <>Modo Admin · <span className="text-cream-50 font-medium">{usuario?.nombre}</span></>
            ) : (
              <>Sesión: TARDE · Vendedor: {usuario?.nombre ?? '—'}</>
            )}
          </span>
          {ventaAbiertaId && (
            <span className="bg-saffron-100 text-saffron-600 px-2 py-0.5 rounded text-2xs font-medium uppercase tracking-wide">
              Agregando a pedido abierto
            </span>
          )}
          {printerErrors > 0 && (
            <a
              href="/admin/configuracion/impresoras"
              className="bg-pomodoro-600 text-cream-50 px-2 py-0.5 rounded text-2xs font-medium uppercase tracking-wide hover:bg-pomodoro-700 transition-colors"
              title="Hay trabajos de impresión que fallaron — click para ver"
            >
              ⚠ {printerErrors} impresión{printerErrors !== 1 ? 'es' : ''} fallida{printerErrors !== 1 ? 's' : ''}
            </a>
          )}
        </div>
        <div className="flex items-center gap-3">
          <select
            value={cart.canal}
            onChange={(e) => {
              const c = e.target.value as 'MOSTRADOR' | 'TELEFONO' | 'WHATSAPP' | 'PEDIDOS_YA' | 'RAPPI' | 'MERCADO_LIBRE' | 'DELIVERATE';
              cart.setCanal(c);
              // Mapear canal → modalidad por defecto. La encargada lo puede sobreescribir.
              if (c === 'MOSTRADOR') {
                cart.setModalidad('TAKE_AWAY');
                // Limpiar datos del cliente delivery al pasar a Mostrador para
                // evitar que persistan datos del pedido anterior (PII cruzada).
                cart.setClienteNombre('');
                cart.setClienteTelefono('');
                cart.setDireccionEntrega('');
                cart.setIndicacionesEntrega('');
                cart.setIdExternoCanal('');
              } else if (c === 'TELEFONO' || c === 'WHATSAPP') {
                cart.setModalidad('DELIVERY_PROPIO');
                cart.setIdExternoCanal(''); // delivery propio no tiene id externo
              } else if (c === 'DELIVERATE') cart.setModalidad('DELIVERY_DELIVERATE');
              else cart.setModalidad('DELIVERY_PLATAFORMA');
            }}
            className={cn(
              'px-3 py-1 rounded text-sm font-medium border-2',
              cart.canal === 'MOSTRADOR' && 'bg-teresita-900 text-cream-50 border-transparent',
              (cart.canal === 'TELEFONO' || cart.canal === 'WHATSAPP') && 'bg-saffron-600 text-white border-saffron-700',
              cart.canal === 'PEDIDOS_YA' && 'bg-pomodoro-600 text-white border-pomodoro-700',
              cart.canal === 'RAPPI' && 'bg-pomodoro-700 text-white border-pomodoro-700',
              cart.canal === 'MERCADO_LIBRE' && 'bg-saffron-600 text-white border-saffron-600',
              cart.canal === 'DELIVERATE' && 'bg-ocean-600 text-white border-ocean-600',
            )}
          >
            <option value="MOSTRADOR">🏪 Mostrador</option>
            <option value="TELEFONO">📞 Teléfono (delivery)</option>
            <option value="WHATSAPP">💬 WhatsApp (delivery)</option>
            <option value="PEDIDOS_YA">🛵 Pedidos YA</option>
            <option value="RAPPI">🛵 RAPPI</option>
            <option value="MERCADO_LIBRE">🛵 MELI</option>
            <option value="DELIVERATE">🛵 DELIVERATE</option>
          </select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (cart.items.length > 0) {
                // Hay items → preguntar qué hacer (guardar borrador / descartar / cancelar)
                setConfirmarNuevo(true);
              } else {
                setForzarCarritoVacio(true);
                searchInputRef.current?.focus();
              }
            }}
            className="text-cream-50"
          >
            Pedido nuevo +
          </Button>
        </div>
      </header>

      {/* Body */}
      <main className="grid grid-cols-[1fr_420px] gap-6 px-6 py-4 overflow-hidden">
        {/* Catálogo */}
        <section className="overflow-y-auto pr-2">
          <input
            ref={searchInputRef}
            type="search"
            placeholder="🔍 Buscar producto o código (ej. 1, 11, 60)... Enter agrega · ↓ navega categorías"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              onSearchKeyExtras(e);
              if (!e.defaultPrevented) void onSearchKeyDown(e);
            }}
            autoFocus
            className="input mb-4 font-mono"
          />
          {!search && (
            <>
              <nav className="flex gap-2 flex-wrap mb-3">
                {categorias.map((c, idx) => (
                  <button
                    key={c.id}
                    ref={(el) => { categoryRefs.current[idx] = el; }}
                    data-nav="category"
                    onClick={() => setCategoriaActiva(c.id)}
                    onKeyDown={(e) => onKeyDownCategoria(idx, e)}
                    className={cn(
                      'px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-fast focus:ring-2 focus:ring-teresita-700/40 focus:outline-none',
                      categoriaActiva === c.id
                        ? 'bg-teresita-700 text-cream-50'
                        : 'bg-cream-200 text-ink-700 hover:bg-cream-300',
                    )}
                  >
                    {c.icono} {c.nombre}
                  </button>
                ))}
              </nav>

              {/* Sub-categorías (TipoProducto) — solo si la categoría tiene 2+ tipos.
                  Aparece entre la fila de categorías y la fila de marcas. */}
              {mostrarPanelSubcategorias && (
                <nav className="flex gap-1.5 flex-wrap mb-3">
                  <span className="text-2xs uppercase tracking-wider text-ink-500 mr-1 self-center">
                    Sub-categoría:
                  </span>
                  <button
                    ref={(el) => { subcatRefs.current[0] = el; }}
                    data-nav="subcat"
                    onClick={() => setTipoActivo(null)}
                    onKeyDown={(e) => onKeyDownSubCat(0, e)}
                    className={cn(
                      'px-2.5 py-1 rounded text-xs font-medium transition-colors focus:ring-2 focus:ring-teresita-700/40 focus:outline-none',
                      tipoActivo === null
                        ? 'bg-saffron-100 text-saffron-600 border border-saffron-600'
                        : 'bg-white text-ink-700 border border-cream-300 hover:bg-cream-100',
                    )}
                  >
                    Todas ({productosCategoria.length})
                  </button>
                  {tiposDeCategoria.map((t, idx) => (
                    <button
                      key={t.id}
                      ref={(el) => { subcatRefs.current[idx + 1] = el; }}
                      data-nav="subcat"
                      onClick={() => setTipoActivo(t.id)}
                      onKeyDown={(e) => onKeyDownSubCat(idx + 1, e)}
                      className={cn(
                        'px-2.5 py-1 rounded text-xs font-medium transition-colors focus:ring-2 focus:ring-teresita-700/40 focus:outline-none',
                        tipoActivo === t.id
                          ? 'bg-saffron-100 text-saffron-600 border border-saffron-600'
                          : 'bg-white text-ink-700 border border-cream-300 hover:bg-cream-100',
                      )}
                    >
                      {t.nombre} ({t.cuenta})
                    </button>
                  ))}
                </nav>
              )}

              {/* Marcas (típicamente para Estantería).
                  Se muestran cuando la categoría activa tiene 3+ marcas distintas. */}
              {mostrarPanelMarcas && (
                <nav className="flex gap-1.5 flex-wrap mb-4 pb-3 border-b border-cream-300">
                  <span className="text-2xs uppercase tracking-wider text-ink-500 mr-1 self-center">
                    Marca:
                  </span>
                  <button
                    ref={(el) => { marcaRefs.current[0] = el; }}
                    data-nav="marca"
                    onClick={() => setMarcaActiva(null)}
                    onKeyDown={(e) => onKeyDownMarca(0, e)}
                    className={cn(
                      'px-2.5 py-1 rounded text-xs font-medium transition-colors focus:ring-2 focus:ring-teresita-700/40 focus:outline-none',
                      marcaActiva === null
                        ? 'bg-teresita-50 text-teresita-700 border border-teresita-700'
                        : 'bg-white text-ink-700 border border-cream-300 hover:bg-cream-100',
                    )}
                  >
                    Todas ({productosCategoria.length})
                  </button>
                  {marcasDeCategoria.map((m, idx) => {
                    const cuenta = productosCategoria.filter(
                      (p) => (p.marca ?? '').trim() === m,
                    ).length;
                    return (
                      <button
                        key={m}
                        ref={(el) => { marcaRefs.current[idx + 1] = el; }}
                        data-nav="marca"
                        onClick={() => setMarcaActiva(m)}
                        onKeyDown={(e) => onKeyDownMarca(idx + 1, e)}
                        className={cn(
                          'px-2.5 py-1 rounded text-xs font-medium transition-colors focus:ring-2 focus:ring-teresita-700/40 focus:outline-none',
                          marcaActiva === m
                            ? 'bg-teresita-50 text-teresita-700 border border-teresita-700'
                            : 'bg-white text-ink-700 border border-cream-300 hover:bg-cream-100',
                        )}
                      >
                        {m} ({cuenta})
                      </button>
                    );
                  })}
                </nav>
              )}
            </>
          )}

          {/* Productos */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
            {productosVisibles.map((p, idx) => (
              <button
                key={p.id}
                ref={(el) => { productCardRefs.current[idx] = el; }}
                data-nav="product"
                onClick={() => abrirAgregar(p)}
                onKeyDown={(e) => onKeyDownProducto(idx, e)}
                className="card p-3 min-h-28 flex flex-col items-start text-left hover:shadow-md transition-shadow duration-fast active:scale-[0.98] focus:ring-2 focus:ring-teresita-700/40 focus:outline-none focus:border-teresita-700"
              >
                <div className="flex items-baseline justify-between w-full mb-1">
                  <span className="text-2xs font-mono text-ink-300">{p.codigo ?? '----'}</span>
                  {p.tipoProducto.cocinaInterviene && (
                    <span className="text-2xs text-saffron-600">🍳</span>
                  )}
                </div>
                <span className="text-sm font-medium text-ink-900 line-clamp-2 leading-tight">
                  {p.nombre}
                </span>
                {p.marca && (
                  <span className="text-2xs text-ink-500 mt-0.5">
                    {p.marca}
                    {p.presentacion && ` · ${p.presentacion}`}
                  </span>
                )}
                {p.sabores && p.sabores.length > 0 && (
                  <span className="text-2xs text-ink-500 line-clamp-3 mt-0.5 leading-snug">
                    {p.sabores
                      .map((s) =>
                        s.codigo ? `${s.nombre} (${s.codigo})` : s.nombre,
                      )
                      .join(' · ')}
                  </span>
                )}
                <div className="mt-auto flex items-baseline gap-1">
                  <MoneyAmount value={p.precioBase} className="text-md text-teresita-700" />
                  <span className="text-2xs text-ink-500">/{unidadCorta(p.unidadPrecio)}</span>
                </div>
              </button>
            ))}
            {productosVisibles.length === 0 && (
              <div className="col-span-full text-center text-ink-500 py-12">
                {search ? `Sin coincidencias para "${search}"` : 'Sin productos en esta categoría'}
              </div>
            )}
          </div>
        </section>

        {/* Columna derecha:
            - Carrito vacío + sin venta abierta + NO se clickeó "Pedido nuevo" → muestra pedidos abiertos + borradores
            - Carrito vacío + se clickeó "Pedido nuevo" → muestra carrito vacío con prompt
            - Hay items en carrito → muestra carrito normal
            - Modo agregar a venta abierta → muestra carrito de "agregando" */}
        {cart.items.length === 0 && !ventaAbiertaId && !forzarCarritoVacio ? (
          <aside className="card flex flex-col overflow-hidden">
            {cart.borradores.length > 0 && (
              <BorradoresPanel
                borradores={cart.borradores}
                onRestaurar={(id) => {
                  // Carrito vacío en este punto, así que solo restauramos.
                  // (Si hubiera items, se hubiera mostrado el carrito en lugar de este panel.)
                  cart.restaurarBorrador(id);
                  searchInputRef.current?.focus();
                }}
                onEliminar={(id) => cart.eliminarBorrador(id)}
              />
            )}
            <div className="flex-1 overflow-hidden">
              <PedidosAbiertosList />
            </div>
          </aside>
        ) : (
          <aside className="card flex flex-col overflow-hidden">
            <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken flex items-center justify-between">
              <div>
                <h2 className="font-display text-md text-teresita-700">
                  {ventaAbiertaId
                    ? 'AGREGANDO AL PEDIDO'
                    : `PEDIDO ${cart.numeroOrden ? `#${String(cart.numeroOrden).padStart(3, '0')}` : 'NUEVO'}`}
                </h2>
                <div className="text-xs text-ink-500 flex justify-between gap-3">
                  <span>
                    {new Date().toLocaleTimeString('es-AR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span>{cart.canal.replace('_', ' ')}</span>
                </div>
              </div>
              <button
                onClick={() => setShowPedidosDrawer(true)}
                className="text-xs text-teresita-700 hover:underline whitespace-nowrap"
                title="Ver pedidos abiertos sin perder este"
              >
                Ver lista pedidos →
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-3 py-2">
              {cart.items.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-4 py-12">
                  <div className="text-4xl mb-3">🍝</div>
                  <p className="text-sm font-medium text-ink-700 mb-1">Listo para empezar</p>
                  <p className="text-xs text-ink-500">
                    Buscá productos por nombre o código, o tocá una card del catálogo para
                    agregar.
                  </p>
                </div>
              ) : (
                renderCartGrouped(cart.items)
              )}
            </div>

            {/* Panel contextual según el canal */}
            {cart.canal !== 'MOSTRADOR' && (() => {
              const esPlataforma =
                cart.canal === 'RAPPI' ||
                cart.canal === 'PEDIDOS_YA' ||
                cart.canal === 'MERCADO_LIBRE' ||
                cart.canal === 'DELIVERATE';
              const listaPrecios =
                cart.canal === 'RAPPI'
                  ? 'RAPPI (+30%)'
                  : cart.canal === 'PEDIDOS_YA'
                    ? 'Pedidos YA (+20%)'
                    : cart.canal === 'MERCADO_LIBRE'
                      ? 'Mercado Libre'
                      : cart.canal === 'DELIVERATE'
                        ? 'DELIVERATE'
                        : 'Local';

              return (
                <div
                  className={cn(
                    'border-t border-cream-300 px-3 py-2 space-y-1.5',
                    esPlataforma ? 'bg-pomodoro-100/40' : 'bg-saffron-100/40',
                  )}
                >
                  <div className="flex items-baseline justify-between">
                    <span
                      className={cn(
                        'text-2xs uppercase tracking-wider font-medium',
                        esPlataforma ? 'text-pomodoro-600' : 'text-saffron-600',
                      )}
                    >
                      {esPlataforma
                        ? `📱 Pedido de ${cart.canal.replace('_', ' ')}`
                        : '🛵 Datos del cliente (sale en la comanda)'}
                    </span>
                    <span className="text-2xs text-ink-500 font-medium">
                      Lista: {listaPrecios}
                    </span>
                  </div>

                  {/* PLATAFORMA: solo Nº de orden + datos opcionales (la plataforma maneja la dirección) */}
                  {esPlataforma ? (
                    <>
                      <input
                        type="text"
                        value={cart.idExternoCanal}
                        onChange={(e) => cart.setIdExternoCanal(e.target.value)}
                        placeholder={
                          cart.canal === 'RAPPI'
                            ? 'Nº de orden RAPPI (ej. RAP-12345)'
                            : cart.canal === 'PEDIDOS_YA'
                              ? 'Nº de orden Pedidos YA'
                              : cart.canal === 'MERCADO_LIBRE'
                                ? 'Nº de orden MELI'
                                : 'Nº de orden DELIVERATE'
                        }
                        maxLength={120}
                        className="input text-sm py-1 px-2 w-full font-mono"
                      />
                      <p className="text-2xs text-ink-500 italic">
                        Cargá los items tal como vienen en la app de la plataforma. El
                        sistema aplica precios de la lista <strong>{listaPrecios}</strong>.
                      </p>
                    </>
                  ) : (
                    /* DELIVERY PROPIO (TELEFONO / WHATSAPP): nombre + tel + dirección
                       con autocomplete por teléfono y búsqueda por nombre. */
                    <ClienteDeliveryFields
                      nombre={cart.clienteNombre}
                      telefono={cart.clienteTelefono}
                      direccion={cart.direccionEntrega}
                      indicaciones={cart.indicacionesEntrega}
                      onNombre={cart.setClienteNombre}
                      onTelefono={cart.setClienteTelefono}
                      onDireccion={cart.setDireccionEntrega}
                      onIndicaciones={cart.setIndicacionesEntrega}
                    />
                  )}
                </div>
              );
            })()}

            <footer className="border-t border-cream-300 p-4 space-y-2 bg-surface-sunken">
              {ventaAbiertaId && totalPrevioVenta ? (
                // Modo agregando a pedido abierto: mostrar total previo + (+) + total final
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between text-ink-500">
                    <span>Total actual del pedido:</span>
                    <MoneyAmount value={totalPrevioVenta} />
                  </div>
                  <div className="flex justify-between text-ink-700">
                    <span>+ Agregando ahora:</span>
                    <MoneyAmount
                      value={subtotal}
                      className="text-saffron-600 font-medium"
                    />
                  </div>
                  <hr className="border-cream-300 my-1" />
                  <div className="flex justify-between items-baseline">
                    <span className="text-base text-ink-900 font-medium">NUEVO TOTAL:</span>
                    <MoneyAmount
                      value={(Number(totalPrevioVenta) + Number(subtotal)).toFixed(2)}
                      hero
                      className="text-2xl text-teresita-900"
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-ink-500">Subtotal:</span>
                    <MoneyAmount value={subtotal} />
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-base text-ink-700">TOTAL:</span>
                    <MoneyAmount value={subtotal} hero className="text-2xl text-teresita-900" />
                  </div>
                </>
              )}

              {ventaAbiertaId ? (
                // En modo agregar items, solo 1 botón
                <>
                  <Button
                    fullWidth
                    size="lg"
                    disabled={cart.items.length === 0 || enviando}
                    onClick={() => procesarPedido('enviar')}
                    className="text-lg py-4 mt-3"
                  >
                    {enviando ? 'Agregando...' : 'AGREGAR AL PEDIDO →'}
                  </Button>
                  <button
                    onClick={() => {
                      cart.vaciar();
                      router.push(`/venta/${ventaAbiertaId}`);
                    }}
                    className="w-full text-xs text-ink-500 hover:underline mt-1"
                  >
                    ← Volver al pedido sin agregar
                  </button>
                </>
              ) : (
                // Pedido nuevo: 3 botones con colores distintos para identificación rápida
                <div className="space-y-2 mt-3">
                  {/* COBRAR — verde Teresita (acción principal: cobra ya) */}
                  <button
                    type="button"
                    disabled={cart.items.length === 0 || enviando}
                    onClick={() => procesarPedido('cobrar')}
                    className="w-full bg-teresita-700 hover:bg-teresita-900 text-cream-50 font-semibold text-lg py-4 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {enviando ? 'Procesando...' : '💚 COBRAR'}
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    {/* ENVIAR PEDIDO — amarillo (manda a cocina, queda pendiente) */}
                    <button
                      type="button"
                      disabled={cart.items.length === 0 || enviando}
                      onClick={() => procesarPedido('enviar')}
                      className="bg-saffron-100 hover:bg-saffron-600 hover:text-white text-saffron-600 font-medium text-sm py-2.5 rounded-md transition-colors border border-saffron-600/40 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      🍳 Enviar a cocina
                    </button>
                    {/* CARGAR OTRO — celeste (siguiente cliente) */}
                    <button
                      type="button"
                      disabled={cart.items.length === 0 || enviando}
                      onClick={() => procesarPedido('nuevo')}
                      className="bg-ocean-100 hover:bg-ocean-600 hover:text-white text-ocean-600 font-medium text-sm py-2.5 rounded-md transition-colors border border-ocean-600/40 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      ➕ Cargar otro
                    </button>
                  </div>
                  <p className="text-2xs text-ink-500 text-center">
                    El pedido va a cocina y queda en la lista hasta que cobres.
                  </p>
                </div>
              )}
            </footer>
          </aside>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-surface-sunken border-t border-cream-300 px-6 flex items-center justify-between text-xs text-ink-500">
        <div className="flex gap-6">
          <span className={stats.abiertos > 0 ? 'text-saffron-600 font-medium' : ''}>
            📋 Pedidos abiertos: {stats.abiertos}
          </span>
          <span>✓ Cerrados en este turno: {stats.cerrados}</span>
        </div>
        <div className="flex gap-4">
          <button onClick={() => router.push('/historial')} className="hover:text-ink-700">
            Historial (F10)
          </button>
          <button
            onClick={async () => {
              await api.post('/auth/logout', {});
              router.push('/login');
            }}
            className="hover:text-pomodoro-600"
          >
            Cerrar sesión
          </button>
        </div>
      </footer>

      {/* Modal modificadores */}
      {productoSeleccionado && (
        <ModalModificadores
          producto={productoSeleccionado.producto}
          focoOpcionId={productoSeleccionado.focoOpcionId}
          onClose={() => setProductoSeleccionado(null)}
          onConfirmMulti={(items) => {
            for (const it of items) cart.agregar(it);
            // En porción mode la salsa ya viene en items (todo en un solo modal).
            // No abrimos SalsaModal aparte.
            setProductoSeleccionado(null);
          }}
        />
      )}

      {/* Modal de salsa post-pasta */}
      {salsaModal && (
        <SalsaModal
          tipo={salsaModal.tipo}
          porcionesIncluidas={salsaModal.porcionesIncluidas}
          nombrePasta={salsaModal.nombrePasta}
          onClose={() => setSalsaModal(null)}
          onConfirm={(items) => {
            for (const it of items) cart.agregar(it);
            setSalsaModal(null);
            // Volver el foco a la barra de búsqueda
            setTimeout(() => searchInputRef.current?.focus(), 50);
          }}
        />
      )}

      {/* Drawer pedidos abiertos (sin perder carrito) */}
      {showPedidosDrawer && <PedidosAbiertosDrawer onClose={() => setShowPedidosDrawer(false)} />}

      {/* Modal: ¿qué hacer con el carrito en curso al iniciar un pedido nuevo? */}
      {confirmarNuevo && (
        <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
          <div className="card w-full max-w-md p-6 shadow-modal">
            <div className="text-3xl mb-2 text-center">📋</div>
            <h2 className="font-display text-lg text-teresita-700 mb-2 text-center">
              Tenés un pedido en curso
            </h2>
            <p className="text-sm text-ink-500 mb-5 text-center">
              Hay {cart.items.length} producto{cart.items.length !== 1 && 's'} cargado
              {cart.items.length !== 1 && 's'}. ¿Qué querés hacer?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  cart.guardarComoBorrador();
                  setConfirmarNuevo(false);
                  setForzarCarritoVacio(true);
                  searchInputRef.current?.focus();
                }}
                className="bg-teresita-700 hover:bg-teresita-900 text-cream-50 font-semibold text-md py-3 rounded-md transition-colors"
              >
                💾 Guardar como borrador y empezar nuevo
              </button>
              <button
                onClick={() => {
                  cart.vaciar();
                  setConfirmarNuevo(false);
                  setForzarCarritoVacio(true);
                  searchInputRef.current?.focus();
                }}
                className="bg-pomodoro-100 hover:bg-pomodoro-600 hover:text-white text-pomodoro-600 font-medium text-sm py-2.5 rounded-md transition-colors border border-pomodoro-600/40"
              >
                🗑️ Descartar y empezar nuevo
              </button>
              <button
                onClick={() => setConfirmarNuevo(false)}
                className="text-ink-500 text-sm hover:underline mt-1"
              >
                Cancelar (seguir con este pedido)
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="fixed top-4 right-4 bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded shadow-lg z-50"
        >
          {error}
          <button className="ml-3 underline" onClick={() => setError(null)}>
            cerrar
          </button>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Línea del carrito con dropdown de sabor + +/- de cantidad
// ────────────────────────────────────────────────────────────────────────

/**
 * Agrupa los items del carrito por `parteDeComboInstancia`. Los items de un
 * paquete (porción + sus salsas + acompañamientos) salen juntos visualmente
 * con un borde común y un punto decorativo a la izquierda. Los items sueltos
 * (sin instancia) salen como antes.
 */
function renderCartGrouped(items: CartItem[]): React.ReactNode {
  // Mantener el ORDEN del carrito pero agrupar items contiguos con el mismo instanciaId.
  const groups: Array<{ instanciaId: string | null; items: CartItem[] }> = [];
  for (const it of items) {
    const id = it.parteDeComboInstancia ?? null;
    const last = groups[groups.length - 1];
    if (id && last && last.instanciaId === id) {
      last.items.push(it);
    } else {
      groups.push({ instanciaId: id, items: [it] });
    }
  }
  return groups.map((g, gi) => {
    if (!g.instanciaId || g.items.length === 1) {
      // Item suelto
      return g.items.map((item) => <CartItemRow key={item.uid} item={item} />);
    }
    // Paquete: porción + salsas + obs como un bloque
    return (
      <div
        key={`grp-${gi}`}
        className="border-l-4 border-teresita-700 bg-teresita-50/40 my-2 rounded-r-md"
      >
        {g.items.map((item, idx) => (
          <CartItemRow
            key={item.uid}
            item={item}
            esParteDePaquete
            esPrimeroDelPaquete={idx === 0}
          />
        ))}
      </div>
    );
  });
}

function CartItemRow({ item, esParteDePaquete, esPrimeroDelPaquete }: {
  item: CartItem;
  esParteDePaquete?: boolean;
  esPrimeroDelPaquete?: boolean;
}) {
  const cart = useCart();
  const paso = pasoIncremento(item.unidadPrecio);
  const unidadCant = unidadCantidad(item.unidadPrecio, item.formaVenta);

  // Para el dropdown de sabor: necesitamos las opciones del modificador del producto.
  // Lo guardamos el grupo del primer modificador que el item tiene aplicado (para sabores).
  const modSabor = item.modificadores[0]; // 1er grupo (típicamente "Sabor / Relleno")
  const [opcionesSabor, setOpcionesSabor] = useState<OpcionMod[]>([]);
  useEffect(() => {
    if (!modSabor) return;
    (async () => {
      try {
        const res = await api.get<{ productos: Producto[] }>(
          `/catalogo/productos?q=${encodeURIComponent(item.productoNombre)}&limit=1`,
        );
        const p = res.productos.find((x) => x.id === item.productoId);
        const grupo = p?.modificadores.find(
          (m) => m.grupoModificador.id === modSabor.grupoId,
        );
        if (grupo) setOpcionesSabor(grupo.grupoModificador.opciones);
      } catch {
        /* silencioso */
      }
    })();
  }, [item.productoId, item.productoNombre, modSabor]);

  function cambiarSabor(opcionId: string) {
    if (!modSabor) return;
    const op = opcionesSabor.find((o) => o.id === opcionId);
    if (!op) return;
    // Recalcular delta total
    const otrosMods = item.modificadores.slice(1);
    const nuevosMods: ModificadorAplicado[] = [
      {
        grupoId: modSabor.grupoId,
        grupoNombre: modSabor.grupoNombre,
        opcionId: op.id,
        opcionNombre: op.nombre,
        deltaPrecio: op.deltaPrecio,
      },
      ...otrosMods,
    ];
    const deltaTotal = nuevosMods.reduce((acc, m) => acc + Number(m.deltaPrecio || 0), 0);
    const deltaAnterior = item.modificadores.reduce(
      (acc, m) => acc + Number(m.deltaPrecio || 0),
      0,
    );
    const precioBase = item.precioUnitario - deltaAnterior;
    cart.editar(item.uid, {
      modificadores: nuevosMods,
      precioUnitario: precioBase + deltaTotal,
    });
  }

  function inc(delta: number) {
    const next = Math.max(paso, item.cantidad + delta);
    cart.editar(item.uid, { cantidad: next });
  }

  return (
    <div
      className={cn(
        'py-3',
        esParteDePaquete
          ? 'px-3 border-b border-teresita-700/15 last:border-0'
          : 'border-b border-cream-200 last:border-0',
      )}
    >
      <div className="flex justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            {esParteDePaquete && !esPrimeroDelPaquete && (
              <span className="text-teresita-700 font-bold flex-shrink-0">↳</span>
            )}
            <span className={cn(
              'truncate',
              esPrimeroDelPaquete ? 'font-semibold text-ink-900' : 'font-medium text-ink-900',
            )}>
              {item.productoNombre}
              {/* Salsa que viene incluida con la porción: la mostramos inline
                  entre paréntesis, NO como item suelto ni como observación. */}
              {item.modificadores
                .filter((m) => m.grupoNombre?.startsWith('Tipo — Salsa'))
                .map((m, i) => (
                  <span key={i} className="text-ink-500 font-normal">
                    {' '}({m.opcionNombre})
                  </span>
                ))}
            </span>
            {item.categoriaNombre?.toLowerCase().includes('pasta fresca') && (
              <span className="text-2xs uppercase tracking-wider text-teresita-700 bg-teresita-50 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                pasta fresca
              </span>
            )}
          </div>
          {item.observacion && (
            esParteDePaquete && esPrimeroDelPaquete ? (
              <div className="mt-1 px-2.5 py-1.5 bg-saffron-100 border-l-4 border-saffron-600 rounded-r">
                <div className="text-2xs font-bold uppercase tracking-widest text-saffron-600">
                  ⚠ Observación
                </div>
                <div className="text-sm font-bold text-ink-900 leading-tight">
                  {item.observacion}
                </div>
              </div>
            ) : (
              <div className="text-xs italic text-saffron-600 mt-0.5">{item.observacion}</div>
            )
          )}
        </div>
        <div className="text-right flex flex-col items-end gap-3">
          <MoneyAmount
            value={calcSubtotal(item)}
            className="text-lg font-semibold text-teresita-700"
          />
          {!esParteDePaquete && (
            <button
              onClick={() => cart.remover(item.uid)}
              className="text-pomodoro-600 text-sm hover:underline px-2 py-0.5"
            >
              quitar
            </button>
          )}
          {esParteDePaquete && esPrimeroDelPaquete && (
            <button
              onClick={() => {
                // Quitar todo el paquete (porción + salsa + extras)
                if (!confirm('¿Quitar esta porción y todo lo que va con ella?')) return;
                const inst = item.parteDeComboInstancia;
                if (!inst) return cart.remover(item.uid);
                const toRemove = useCart.getState().items.filter((x) => x.parteDeComboInstancia === inst);
                for (const t of toRemove) cart.remover(t.uid);
              }}
              className="text-pomodoro-600 text-sm hover:underline px-2 py-0.5"
            >
              quitar paquete
            </button>
          )}
        </div>
      </div>

      {/* Dropdown de sabor: solo en items sueltos, no en paquetes (la salsa ya viene fija con la porción) */}
      {!esParteDePaquete && modSabor && opcionesSabor.length > 0 && (
        <div className="mt-1.5">
          <select
            value={modSabor.opcionId}
            onChange={(e) => cambiarSabor(e.target.value)}
            className="w-full text-xs px-2 py-1 rounded border border-cream-300 bg-white text-ink-700 font-medium"
          >
            {opcionesSabor.map((op) => (
              <option key={op.id} value={op.id}>
                {op.nombre}
                {Number(op.deltaPrecio) > 0 && ` (+$${op.deltaPrecio})`}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Cantidad +/- : solo en items sueltos. En paquetes, la cantidad de porción
          es 1 fija (cada porción se carga individualmente). */}
      {!esParteDePaquete && (
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => inc(-paso)}
          className="w-9 h-9 rounded bg-cream-200 text-ink-700 font-bold text-md hover:bg-cream-300 disabled:opacity-30"
          disabled={item.cantidad <= paso}
          aria-label={`Restar ${paso} ${unidadCant}`}
        >
          −
        </button>
        <input
          type="number"
          step={paso}
          min={paso}
          value={item.cantidad}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) cart.editar(item.uid, { cantidad: v });
          }}
          className="w-24 text-center text-md font-mono py-1.5 rounded border border-cream-300 bg-white"
        />
        <span className="text-sm text-ink-500 font-mono w-12">{unidadCant}</span>
        <button
          type="button"
          onClick={() => inc(paso)}
          className="w-9 h-9 rounded bg-cream-200 text-ink-700 font-bold text-md hover:bg-cream-300"
          aria-label={`Sumar ${paso} ${unidadCant}`}
        >
          +
        </button>
        <span className="ml-auto text-xs text-ink-500 font-mono whitespace-nowrap">
          @ <MoneyAmount value={item.precioUnitario} />/{unidadCorta(item.unidadPrecio)}
        </span>
      </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Panel de borradores (carritos guardados sin enviar)
// ────────────────────────────────────────────────────────────────────────

function BorradoresPanel({
  borradores,
  onRestaurar,
  onEliminar,
}: {
  borradores: BorradorPedido[];
  onRestaurar: (id: string) => void;
  onEliminar: (id: string) => void;
}) {
  return (
    <div className="border-b-2 border-saffron-600/30 bg-saffron-100/40">
      <header className="px-4 py-2 border-b border-saffron-600/20 flex items-center justify-between">
        <h3 className="font-display text-sm text-saffron-600 font-semibold">
          📋 BORRADORES ({borradores.length})
        </h3>
        <span className="text-2xs text-ink-500">sin enviar</span>
      </header>
      <ul>
        {borradores.map((b) => {
          const totalEstimado = b.items.reduce((acc, i) => {
            // POR_KILO: cantidad en gramos → divide por 1000
            // Resto (incluido POR_DOCENA con cantidad en docenas): multiplica directo
            if (i.unidadPrecio === 'POR_KILO') {
              return acc + (i.cantidad / 1000) * i.precioUnitario;
            }
            return acc + i.cantidad * i.precioUnitario;
          }, 0);
          const fecha = new Date(b.creadoAt);
          const hh = String(fecha.getHours()).padStart(2, '0');
          const mm = String(fecha.getMinutes()).padStart(2, '0');
          const summary = b.items
            .slice(0, 2)
            .map((i) => i.productoNombre)
            .join(', ') + (b.items.length > 2 ? `, +${b.items.length - 2}` : '');
          return (
            <li
              key={b.id}
              className="px-4 py-2 border-b border-saffron-600/10 last:border-b-0 hover:bg-saffron-100/60"
            >
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-xs text-ink-500">{hh}:{mm}</span>
                <MoneyAmount value={totalEstimado.toFixed(2)} className="text-md text-ink-900" />
              </div>
              <div className="text-xs text-ink-700 line-clamp-1 mt-0.5">{summary}</div>
              <div className="flex gap-2 mt-1.5">
                <button
                  onClick={() => onRestaurar(b.id)}
                  className="flex-1 text-center text-xs py-1.5 rounded bg-teresita-700 hover:bg-teresita-900 text-cream-50 font-medium"
                >
                  Continuar editando
                </button>
                <button
                  onClick={() => {
                    if (confirm('¿Borrar este borrador?')) onEliminar(b.id);
                  }}
                  className="text-xs py-1.5 px-2 rounded text-pomodoro-600 hover:bg-pomodoro-100"
                  title="Eliminar borrador"
                >
                  🗑️
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Drawer: ver pedidos abiertos sin perder carrito
// ────────────────────────────────────────────────────────────────────────

function PedidosAbiertosDrawer({ onClose }: { onClose: () => void }) {
  const cart = useCart();

  function restaurarPreservandoActual(id: string) {
    // Si hay items en el carrito actual, primero los guardamos como borrador
    // para no perder el trabajo del cajero.
    if (cart.items.length > 0) {
      cart.guardarComoBorrador();
    }
    cart.restaurarBorrador(id);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-ink-900/40" onClick={onClose} />
      <aside className="w-[420px] bg-white shadow-modal h-full flex flex-col overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken flex items-center justify-between">
          <h2 className="font-display text-md text-teresita-700">PEDIDOS</h2>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900 text-xl">
            ✕
          </button>
        </header>
        <p className="px-4 py-2 text-xs text-ink-500 bg-cream-100">
          {cart.items.length > 0
            ? 'Tu pedido en curso se guarda como borrador automáticamente si abrís otro.'
            : 'Click en uno para ir a cobrar/editar o restaurar un borrador.'}
        </p>
        <div className="flex-1 overflow-y-auto">
          {cart.borradores.length > 0 && (
            <BorradoresPanel
              borradores={cart.borradores}
              onRestaurar={restaurarPreservandoActual}
              onEliminar={(id) => cart.eliminarBorrador(id)}
            />
          )}
          <PedidosAbiertosList />
        </div>
      </aside>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal modificadores (Wireframe 03)
// ────────────────────────────────────────────────────────────────────────

interface ModalModificadoresProps {
  producto: Producto;
  focoOpcionId: string | null;
  onClose: () => void;
  onConfirmMulti: (items: Array<Omit<CartItem, 'uid'>>) => void;
}

/**
 * Modal con navegación por teclado.
 *
 * Casos:
 *   A. Producto con sabores (ej. Ravioles) → lista de sabores con input cantidad
 *   B. Producto sin sabores pero con incluyeSalsa (ej. Ñoquis porción simple) →
 *      muestra una sola fila "Cantidad" para el producto
 *   C. Producto pasta fresca (categoría "Pastas frescas") → además de A, ofrece
 *      "Agregar salsa al pedido" expandible con todas las salsas en frasco.
 *
 * Foco inicial: primer input disponible. ↑↓ navega · Enter agrega · Esc cancela.
 */
function ModalModificadores({ producto, focoOpcionId, onClose, onConfirmMulti }: ModalModificadoresProps) {
  // Modo "porción individual": producto con incluyeSalsa → UNA porción por modal,
  // selección única de sabor (radio), cantidad=1. Cada porción puede tener su
  // propia observación. Después confirmar abre el modal de salsa.
  const isPorcionMode = !!producto.incluyeSalsa;

  // Lista plana de sabores. Si el producto NO tiene sabores pero incluye salsa,
  // creamos UNA fila "fantasma" con el producto mismo.
  const sabores = useMemo(() => {
    const out: Array<{
      id: string;
      nombre: string;
      codigo: string | null;
      deltaPrecio: string;
      grupoId: string | null;
      grupoNombre: string | null;
    }> = [];
    for (const m of producto.modificadores) {
      for (const op of m.grupoModificador.opciones) {
        out.push({
          id: op.id,
          nombre: op.nombre,
          codigo: (op as { codigo?: string | null }).codigo ?? null,
          deltaPrecio: op.deltaPrecio,
          grupoId: m.grupoModificador.id,
          grupoNombre: m.grupoModificador.nombre,
        });
      }
    }
    // Producto sin sabores pero requiere modal (incluye salsa) → una fila fantasma
    if (out.length === 0) {
      out.push({
        id: '__producto__',
        nombre: producto.nombre,
        codigo: producto.codigo,
        deltaPrecio: '0',
        grupoId: null,
        grupoNombre: null,
      });
    }
    return out;
  }, [producto]);

  const esPastaFresca = useMemo(() => {
    const cat = producto.tipoProducto.categoria.nombre.toLowerCase();
    return cat.includes('pasta fresca') || cat === 'pastas frescas';
  }, [producto]);

  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  // Modo porción individual: solo se selecciona UN sabor (radio).
  const [saborRadioId, setSaborRadioId] = useState<string | null>(
    isPorcionMode ? (focoOpcionId ?? sabores[0]?.id ?? null) : null,
  );
  // Modo porción: salsa elegida (radio único). Cantidad fija = 1 porción → 1 salsa incluida.
  const [salsaPorcionId, setSalsaPorcionId] = useState<string | null>(null);
  // Cantidad de paquetes (porción × N + salsa × N + observación). Default 1.
  const [cantidadPaquete, setCantidadPaquete] = useState<string>('1');
  const cantidadPaqueteNum = (() => {
    const n = parseInt(cantidadPaquete || '1', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();
  const cantidadInputRef = useRef<HTMLInputElement | null>(null);
  const [observacion, setObservacion] = useState('');
  const [showSalsaAdder, setShowSalsaAdder] = useState(false);
  const [salsaCantidades, setSalsaCantidades] = useState<Record<string, string>>({});
  const [salsasData, setSalsasData] = useState<{
    simple: { producto: { id: string; nombre: string; precioBase: string }; sabores: Array<{ opcionId: string; grupoId: string; grupoNombre: string; nombre: string; codigo: string | null; deltaPrecio: string }> } | null;
    especial: { producto: { id: string; nombre: string; precioBase: string }; sabores: Array<{ opcionId: string; grupoId: string; grupoNombre: string; nombre: string; codigo: string | null; deltaPrecio: string }> } | null;
  }>({ simple: null, especial: null });
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const obsRef = useRef<HTMLInputElement | null>(null);
  const salsaToggleRef = useRef<HTMLButtonElement | null>(null);

  const unidadCant = unidadCantidad(producto.unidadPrecio, producto.formaVenta);

  // Cargar datos de salsa si es pasta fresca (para "Agregar salsa")
  // O si es porción mode (para mostrar lista de salsas integrada en el modal)
  useEffect(() => {
    if (!esPastaFresca && !isPorcionMode) return;
    (async () => {
      try {
        // En porción mode solo necesitamos el tipo correspondiente.
        // En pasta fresca cargamos ambos.
        if (isPorcionMode && producto.incluyeSalsa) {
          const tipo = producto.incluyeSalsa;
          const r = await api.get<{ producto: { id: string; nombre: string; precioBase: string }; sabores: Array<{ opcionId: string; grupoId: string; grupoNombre: string; nombre: string; codigo: string | null; deltaPrecio: string }> }>(`/catalogo/salsa/${tipo}`);
          setSalsasData(tipo === 'SIMPLE' ? { simple: r, especial: null } : { simple: null, especial: r });
        } else {
          const [s, e] = await Promise.all([
            api.get<{ producto: { id: string; nombre: string; precioBase: string }; sabores: Array<{ opcionId: string; grupoId: string; grupoNombre: string; nombre: string; codigo: string | null; deltaPrecio: string }> }>('/catalogo/salsa/SIMPLE'),
            api.get<{ producto: { id: string; nombre: string; precioBase: string }; sabores: Array<{ opcionId: string; grupoId: string; grupoNombre: string; nombre: string; codigo: string | null; deltaPrecio: string }> }>('/catalogo/salsa/ESPECIAL'),
          ]);
          setSalsasData({ simple: s, especial: e });
        }
      } catch {
        /* silencioso */
      }
    })();
  }, [esPastaFresca, isPorcionMode, producto.incluyeSalsa]);

  // Foco inicial:
  //   - Modo porción: si NO hay sabor preseleccionado (el cajero clickeó la card),
  //     foco en cantidad para que escriba "5" y baje a sabor.
  //     Si tipeó un código de sabor, foco directo en ese sabor.
  //   - Modo normal: foco en el sabor preseleccionado o el primero.
  useEffect(() => {
    const t = setTimeout(() => {
      if (isPorcionMode && !focoOpcionId) {
        cantidadInputRef.current?.focus();
        cantidadInputRef.current?.select();
        return;
      }
      const targetId = focoOpcionId && inputRefs.current[focoOpcionId] ? focoOpcionId : sabores[0]?.id;
      if (!targetId) return;
      const el = inputRefs.current[targetId];
      if (el) {
        el.focus();
        if (typeof (el as HTMLInputElement).select === 'function') (el as HTMLInputElement).select();
      }
    }, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lista plana de "casillas navegables": sabores → obs → toggle salsa → salsas (si abierto)
  const allSalsaSabores = useMemo(() => {
    if (!showSalsaAdder || !salsasData.simple || !salsasData.especial) return [];
    return [
      ...salsasData.simple.sabores.map((s) => ({ ...s, tipo: 'SIMPLE' as const, precio: salsasData.simple!.producto.precioBase })),
      ...salsasData.especial.sabores.map((s) => ({ ...s, tipo: 'ESPECIAL' as const, precio: salsasData.especial!.producto.precioBase })),
    ];
  }, [showSalsaAdder, salsasData]);

  function setQty(opcionId: string, value: string) {
    setCantidades((c) => ({ ...c, [opcionId]: value }));
  }
  function setSalsaQty(opcionId: string, value: string) {
    setSalsaCantidades((c) => ({ ...c, [opcionId]: value }));
  }

  // Navegación. Las "casillas" en orden:
  //   0..N-1: sabores
  //   N: observaciones
  //   N+1: toggle salsa (si pasta fresca)
  //   N+2..: salsas (si toggle abierto)
  function focusItemAt(globalIdx: number) {
    if (globalIdx < 0) return;
    const N = sabores.length;
    if (globalIdx < N) {
      const el = inputRefs.current[sabores[globalIdx]!.id];
      if (el) { el.focus(); el.select(); }
      return;
    }
    if (globalIdx === N) {
      obsRef.current?.focus();
      return;
    }
    if (esPastaFresca && globalIdx === N + 1) {
      salsaToggleRef.current?.focus();
      return;
    }
    if (showSalsaAdder) {
      const salsaIdx = globalIdx - (N + 2);
      const sabor = allSalsaSabores[salsaIdx];
      if (sabor) {
        const el = inputRefs.current['salsa::' + sabor.opcionId];
        if (el) { el.focus(); el.select(); }
      }
    }
  }

  function confirmar() {
    const items: Array<Omit<CartItem, 'uid'>> = [];

    if (isPorcionMode) {
      const N = cantidadPaqueteNum;

      // La porción (sabor de pasta + salsa elegida) × N — un solo item.
      //
      // La salsa va dentro del array de modificadores de la porción, NO como
      // item separado. Es un acompañamiento sin cargo: el precio de la porción
      // ya la incluye. Así evitamos que la encargada vea una "Salsa simple"
      // cobrada aparte (bug visible al cobrar).
      const sabor = sabores.find((s) => s.id === saborRadioId) ?? sabores[0];
      if (!sabor) return;
      const precioFinal = Number(producto.precioBase) + Number(sabor.deltaPrecio || 0);
      const modificadores: ModificadorAplicado[] = sabor.grupoId
        ? [{ grupoId: sabor.grupoId, grupoNombre: sabor.grupoNombre!, opcionId: sabor.id, opcionNombre: sabor.nombre, deltaPrecio: sabor.deltaPrecio }]
        : [];

      // Agregamos el "modificador salsa" — distinguible por grupoNombre que
      // arranca con "Tipo — Salsa". El UI lo renderiza inline entre paréntesis
      // al lado del nombre de la porción (no como item suelto ni en el cartel
      // amarillo de observación).
      const salsasDataActiva = producto.incluyeSalsa === 'SIMPLE' ? salsasData.simple : salsasData.especial;
      const salsaTipo = producto.incluyeSalsa;
      if (salsaPorcionId && salsasDataActiva) {
        const saborSalsaReal = salsasDataActiva.sabores.find((s) => s.opcionId === salsaPorcionId);
        if (saborSalsaReal) {
          modificadores.push({
            grupoId: saborSalsaReal.grupoId,
            grupoNombre: saborSalsaReal.grupoNombre,
            opcionId: saborSalsaReal.opcionId,
            opcionNombre: saborSalsaReal.nombre,
            deltaPrecio: '0', // incluida — el cargo está en la pasta
          });
        } else {
          // Extras "manuales" (Aceite, Manteca, Mixta) — no son OpcionModificador
          // reales, son etiquetas frontend-only. El schema admite strings libres
          // en grupoId/opcionId precisamente para este caso.
          const extrasMap: Record<string, { nombre: string }> = salsaTipo === 'SIMPLE'
            ? {
                '__aceite': { nombre: 'Aceite' },
                '__aceite_oliva': { nombre: 'Aceite de oliva' },
                '__manteca': { nombre: 'Manteca' },
              }
            : {
                '__mixta': { nombre: 'Mixta / Rosa' },
              };
          const extra = extrasMap[salsaPorcionId];
          if (extra) {
            const grupoNombreSintetico = salsaTipo === 'SIMPLE' ? 'Tipo — Salsa simple' : 'Tipo — Salsa especial';
            modificadores.push({
              grupoId: salsasDataActiva.producto.id, // sentinel — no es un grupoId real, pero el schema acepta string
              grupoNombre: grupoNombreSintetico,
              opcionId: salsaPorcionId, // ej. "__aceite_oliva" — string libre
              opcionNombre: extra.nombre,
              deltaPrecio: '0',
            });
          }
        }
      }

      items.push({
        productoId: producto.id,
        productoNombre: producto.nombre,
        categoriaNombre: producto.tipoProducto.categoria.nombre,
        formaVenta: producto.formaVenta,
        unidadPrecio: producto.unidadPrecio,
        cantidad: N,
        precioUnitario: precioFinal,
        modificadores,
        observacion: observacion || undefined,
        cocinaInterviene: producto.tipoProducto.cocinaInterviene,
      });
    } else {
      // Modo normal: multi-cantidad por sabor (ej. pasta fresca para llevar)
      for (const s of sabores) {
        const raw = cantidades[s.id]?.trim() ?? '';
        const n = Number(raw);
        if (!raw || !Number.isFinite(n) || n <= 0) continue;
        const precioFinal = Number(producto.precioBase) + Number(s.deltaPrecio || 0);
        const modificadores = s.grupoId
          ? [{ grupoId: s.grupoId, grupoNombre: s.grupoNombre!, opcionId: s.id, opcionNombre: s.nombre, deltaPrecio: s.deltaPrecio }]
          : [];
        items.push({
          productoId: producto.id,
          productoNombre: producto.nombre,
          categoriaNombre: producto.tipoProducto.categoria.nombre,
          formaVenta: producto.formaVenta,
          unidadPrecio: producto.unidadPrecio,
          cantidad: n,
          precioUnitario: precioFinal,
          modificadores,
          observacion: observacion || undefined,
          cocinaInterviene: producto.tipoProducto.cocinaInterviene,
        });
      }
      // Salsas en frasco (solo aplica al modo no-porción)
      if (showSalsaAdder) {
        for (const s of allSalsaSabores) {
          const raw = salsaCantidades[s.opcionId]?.trim() ?? '';
          const n = Number(raw);
          if (!raw || !Number.isFinite(n) || n <= 0) continue;
          const productoSalsa = s.tipo === 'SIMPLE' ? salsasData.simple!.producto : salsasData.especial!.producto;
          items.push({
            productoId: productoSalsa.id,
            productoNombre: `${productoSalsa.nombre} (frasco)`,
            formaVenta: 'UNIDAD',
            unidadPrecio: 'POR_UNIDAD',
            cantidad: n,
            precioUnitario: Number(s.precio),
            modificadores: [{ grupoId: s.grupoId, grupoNombre: s.grupoNombre, opcionId: s.opcionId, opcionNombre: s.nombre, deltaPrecio: s.deltaPrecio }],
            cocinaInterviene: false,
          });
        }
      }
    }
    if (items.length === 0) return;
    onConfirmMulti(items);
  }

  function onKeyDownNav(globalIdx: number, e: React.KeyboardEvent<HTMLElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItemAt(globalIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItemAt(globalIdx - 1);
    } else if (e.key === 'Enter') {
      // Si está en el toggle de salsa, expandir/colapsar; si no, confirmar
      if (e.currentTarget === salsaToggleRef.current) {
        e.preventDefault();
        setShowSalsaAdder((v) => !v);
        return;
      }
      e.preventDefault();
      confirmar();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  // Subtotal en vivo
  const subtotalPrincipal = sabores.reduce((acc, s) => {
    const raw = cantidades[s.id]?.trim() ?? '';
    const n = Number(raw);
    if (!raw || !Number.isFinite(n) || n <= 0) return acc;
    const precioFinal = Number(producto.precioBase) + Number(s.deltaPrecio || 0);
    if (producto.unidadPrecio === 'POR_KILO') return acc + (n / 1000) * precioFinal;
    return acc + n * precioFinal;
  }, 0);
  const subtotalSalsas = showSalsaAdder
    ? allSalsaSabores.reduce((acc, s) => {
        const n = Number(salsaCantidades[s.opcionId] ?? 0);
        return Number.isFinite(n) && n > 0 ? acc + n * Number(s.precio) : acc;
      }, 0)
    : 0;
  const subtotal = subtotalPrincipal + subtotalSalsas;

  const totalUnidadesPrincipal = sabores.reduce((a, s) => {
    const n = Number(cantidades[s.id] ?? 0);
    return a + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  const totalUnidadesSalsa = showSalsaAdder
    ? allSalsaSabores.reduce((a, s) => {
        const n = Number(salsaCantidades[s.opcionId] ?? 0);
        return a + (Number.isFinite(n) && n > 0 ? n : 0);
      }, 0)
    : 0;
  const totalUnidades = totalUnidadesPrincipal + totalUnidadesSalsa;

  // Determinar etiqueta de la fila principal cuando es producto sin sabores
  const esProductoFantasma = sabores.length === 1 && sabores[0]!.id === '__producto__';

  // Lista de items de salsa para mostrar en porción mode (sabores + extras)
  const salsasParaPorcion = useMemo(() => {
    const data = producto.incluyeSalsa === 'SIMPLE' ? salsasData.simple : producto.incluyeSalsa === 'ESPECIAL' ? salsasData.especial : null;
    if (!data) return [] as Array<{ id: string; nombre: string; codigo: string | null }>;
    const items: Array<{ id: string; nombre: string; codigo: string | null }> = data.sabores.map((s) => ({
      id: s.opcionId,
      nombre: s.nombre,
      codigo: s.codigo,
    }));
    if (producto.incluyeSalsa === 'SIMPLE') {
      items.push({ id: '__aceite', nombre: 'Aceite', codigo: null });
      items.push({ id: '__aceite_oliva', nombre: 'Aceite de oliva', codigo: null });
      items.push({ id: '__manteca', nombre: 'Manteca', codigo: null });
    } else if (producto.incluyeSalsa === 'ESPECIAL') {
      items.push({ id: '__mixta', nombre: 'Mixta / Rosa', codigo: null });
    }
    return items;
  }, [producto.incluyeSalsa, salsasData]);

  // Refs para los radios de salsa (para nav)
  const salsaPorcionRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className={cn(
        'card w-full max-h-[90vh] overflow-hidden flex flex-col shadow-modal',
        isPorcionMode ? 'max-w-4xl' : 'max-w-lg',
      )}>
        <header className="px-5 py-4 flex justify-between items-start border-b border-cream-300">
          <div>
            {producto.codigo && (
              <div className="text-2xs font-mono text-ink-300">{producto.codigo}</div>
            )}
            <h2 className="font-display text-lg text-teresita-700">{producto.nombre}</h2>
            <p className="text-xs text-ink-500">
              {producto.tipoProducto.categoria.nombre} · base{' '}
              <MoneyAmount value={producto.precioBase} />/{unidadCorta(producto.unidadPrecio)}
              {producto.incluyeSalsa && (
                <span className="ml-2 text-basil-600 font-medium">· incluye salsa {producto.incluyeSalsa.toLowerCase()}</span>
              )}
            </p>
            <p className="text-2xs text-ink-300 mt-1 italic">
              {isPorcionMode
                ? '1 porción · elegí sabor · elegí salsa · agregá observación · Enter agrega TODO como un paquete'
                : '↑↓ navegá · Enter agregá · Esc cancelá'}
            </p>
          </div>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900 text-xl leading-none">
            ✕
          </button>
        </header>

        {/* PORCIÓN MODE: layout 2 columnas (porción + salsa) con observación abajo */}
        {isPorcionMode && (
          <div className="overflow-y-auto px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* COLUMNA 1: Porción + cantidad de paquetes */}
            <div>
              <div className="flex items-center justify-between mb-2 gap-2">
                <div className="text-2xs font-medium uppercase tracking-wider text-ink-500">
                  {esProductoFantasma ? 'Porción' : 'Elegí sabor de la porción'}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-2xs uppercase tracking-wider text-ink-500">Cant:</span>
                  <input
                    ref={cantidadInputRef}
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    value={cantidadPaquete}
                    onChange={(e) => setCantidadPaquete(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        const first = sabores[0];
                        if (first) inputRefs.current[first.id]?.focus();
                      } else if (e.key === 'ArrowRight') {
                        e.preventDefault();
                        const firstSalsa = salsasParaPorcion[0];
                        if (firstSalsa) salsaPorcionRefs.current[firstSalsa.id]?.focus();
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        confirmar();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        onClose();
                      }
                    }}
                    className="w-14 input text-center font-mono py-1 text-sm"
                  />
                  <span className="text-2xs text-ink-500">u</span>
                </div>
              </div>
              <div className="grid gap-1.5">
                {sabores.map((s, idx) => {
                  const seleccionado = saborRadioId === s.id;
                  return (
                    <button
                      key={s.id}
                      ref={(el) => { inputRefs.current[s.id] = el as unknown as HTMLInputElement; }}
                      type="button"
                      onClick={() => setSaborRadioId(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          const next = sabores[idx + 1];
                          if (next) inputRefs.current[next.id]?.focus();
                          else obsRef.current?.focus();
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          const prev = sabores[idx - 1];
                          if (prev) inputRefs.current[prev.id]?.focus();
                          else cantidadInputRef.current?.focus();
                        } else if (e.key === 'ArrowLeft') {
                          // ← desde sabor vuelve a la cantidad (única posición a la izquierda)
                          e.preventDefault();
                          cantidadInputRef.current?.focus();
                        } else if (e.key === 'ArrowRight') {
                          e.preventDefault();
                          // Saltar a salsa column (misma fila aproximadamente)
                          const target = salsasParaPorcion[Math.min(idx, salsasParaPorcion.length - 1)];
                          if (target) salsaPorcionRefs.current[target.id]?.focus();
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          confirmar();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          onClose();
                        }
                      }}
                      onFocus={() => setSaborRadioId(s.id)}
                      className={cn(
                        'w-full flex items-center gap-3 py-2 px-3 rounded-md border text-left transition-colors focus:outline-none',
                        seleccionado
                          ? 'bg-teresita-50 border-teresita-700 ring-2 ring-teresita-700/30'
                          : 'bg-white border-cream-300 hover:bg-cream-50 focus:ring-2 focus:ring-teresita-700/40',
                      )}
                    >
                      <span className={cn(
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                        seleccionado ? 'border-teresita-700 bg-teresita-700' : 'border-cream-300',
                      )}>
                        {seleccionado && <span className="w-2 h-2 rounded-full bg-cream-50" />}
                      </span>
                      {!esProductoFantasma && (
                        <span className="text-2xs font-mono text-ink-500 w-10 text-right">
                          {s.codigo ?? '—'}
                        </span>
                      )}
                      <span className="text-sm flex-1 text-ink-900">{s.nombre}</span>
                      {Number(s.deltaPrecio) !== 0 && (
                        <span className="text-2xs text-ink-500 font-mono">
                          {Number(s.deltaPrecio) > 0 ? '+' : ''}
                          <MoneyAmount value={s.deltaPrecio} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* COLUMNA 2: Salsa */}
            <div>
              <div className="text-2xs font-medium uppercase tracking-wider text-ink-500 mb-2">
                Elegí salsa {producto.incluyeSalsa?.toLowerCase()} (incluida)
              </div>
              {salsasParaPorcion.length === 0 ? (
                <div className="text-xs text-ink-500 italic py-4">Cargando salsas...</div>
              ) : (
                <div className="grid gap-1.5">
                  {salsasParaPorcion.map((s, sidx) => {
                    const seleccionada = salsaPorcionId === s.id;
                    return (
                      <button
                        key={s.id}
                        ref={(el) => { salsaPorcionRefs.current[s.id] = el; }}
                        type="button"
                        onClick={() => setSalsaPorcionId(s.id)}
                        onFocus={() => setSalsaPorcionId(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            const next = salsasParaPorcion[sidx + 1];
                            if (next) salsaPorcionRefs.current[next.id]?.focus();
                            else obsRef.current?.focus();
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            const prev = salsasParaPorcion[sidx - 1];
                            if (prev) salsaPorcionRefs.current[prev.id]?.focus();
                            else cantidadInputRef.current?.focus();
                          } else if (e.key === 'ArrowLeft') {
                            // ← desde cualquier salsa va DIRECTO al input de cantidad
                            // (1 click, no 2). Si querés volver al sabor seleccionado,
                            // bajá con ↓ desde la cantidad.
                            e.preventDefault();
                            cantidadInputRef.current?.focus();
                          } else if (e.key === 'Enter') {
                            e.preventDefault();
                            confirmar();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            onClose();
                          }
                        }}
                        className={cn(
                          'w-full flex items-center gap-3 py-2 px-3 rounded-md border text-left transition-colors focus:outline-none',
                          seleccionada
                            ? 'bg-teresita-50 border-teresita-700 ring-2 ring-teresita-700/30'
                            : 'bg-white border-cream-300 hover:bg-cream-50 focus:ring-2 focus:ring-teresita-700/40',
                        )}
                      >
                        <span className={cn(
                          'w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                          seleccionada ? 'border-teresita-700 bg-teresita-700' : 'border-cream-300',
                        )}>
                          {seleccionada && <span className="w-2 h-2 rounded-full bg-cream-50" />}
                        </span>
                        <span className="text-2xs font-mono text-ink-500 w-10 text-right">
                          {s.codigo ?? '—'}
                        </span>
                        <span className="text-sm flex-1 text-ink-900">{s.nombre}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Observaciones (full width abajo) */}
            <div className="md:col-span-2 mt-2 pt-4 border-t border-cream-200">
              <label className="block text-2xs font-medium uppercase tracking-wider text-ink-500 mb-1">
                Observaciones (opcional)
              </label>
              <input
                ref={obsRef}
                type="text"
                value={observacion}
                onChange={(e) => setObservacion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmar();
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (salsaPorcionId) salsaPorcionRefs.current[salsaPorcionId]?.focus();
                    else if (sabores[0]) inputRefs.current[sabores[0].id]?.focus();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onClose();
                  }
                }}
                placeholder="ej. sin sal, todo bien cocido, separar la salsa..."
                className="input"
              />
              <p className="text-2xs text-ink-300 mt-1">
                Esta observación viaja con esta porción y aparece GRANDE en la comanda.
              </p>
            </div>
          </div>
        )}

        {/* MODO NORMAL (no porción): layout existente — sabores con cantidades + adder de salsa para pasta fresca */}
        {!isPorcionMode && (
        <div className="overflow-y-auto px-5 py-4">
          {/* Sección principal: sabores o cantidad del producto */}
          <div className="grid gap-1.5">
            {isPorcionMode && !esProductoFantasma && (
              <div className="text-2xs font-medium uppercase tracking-wider text-ink-500 mb-1">
                Elegí UN sabor (1 porción) · ↑↓ navega · Enter confirma
              </div>
            )}
            {!isPorcionMode && esProductoFantasma && (
              <div className="text-2xs font-medium uppercase tracking-wider text-ink-500 mb-1">
                Cantidad
              </div>
            )}
            {sabores.map((s, idx) => {
              if (isPorcionMode) {
                // Modo radio: cada sabor es un botón seleccionable. UN solo sabor a la vez.
                const seleccionado = saborRadioId === s.id;
                return (
                  <button
                    key={s.id}
                    ref={(el) => { inputRefs.current[s.id] = el as unknown as HTMLInputElement; }}
                    type="button"
                    onClick={() => setSaborRadioId(s.id)}
                    onKeyDown={(e) => onKeyDownNav(idx, e)}
                    onFocus={() => setSaborRadioId(s.id)}
                    className={cn(
                      'w-full flex items-center gap-3 py-2 px-3 rounded-md border text-left transition-colors focus:outline-none',
                      seleccionado
                        ? 'bg-teresita-50 border-teresita-700 ring-2 ring-teresita-700/30'
                        : 'bg-white border-cream-300 hover:bg-cream-50 focus:ring-2 focus:ring-teresita-700/40',
                    )}
                  >
                    <span
                      className={cn(
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                        seleccionado ? 'border-teresita-700 bg-teresita-700' : 'border-cream-300',
                      )}
                    >
                      {seleccionado && <span className="w-2 h-2 rounded-full bg-cream-50" />}
                    </span>
                    {!esProductoFantasma && (
                      <span className="text-2xs font-mono text-ink-500 w-10 text-right">
                        {s.codigo ?? '—'}
                      </span>
                    )}
                    <span className="text-sm flex-1 text-ink-900">{s.nombre}</span>
                    {Number(s.deltaPrecio) !== 0 && (
                      <span className="text-2xs text-ink-500 font-mono">
                        {Number(s.deltaPrecio) > 0 ? '+' : ''}
                        <MoneyAmount value={s.deltaPrecio} />
                      </span>
                    )}
                  </button>
                );
              }
              // Modo normal: input de cantidad por sabor
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-3 py-1.5 px-2 rounded-md hover:bg-cream-50 focus-within:bg-teresita-50 focus-within:ring-1 focus-within:ring-teresita-700/30"
                >
                  {!esProductoFantasma && (
                    <span className="text-2xs font-mono text-ink-500 w-10 text-right">
                      {s.codigo ?? '—'}
                    </span>
                  )}
                  <span className="text-sm flex-1 text-ink-900">{s.nombre}</span>
                  {Number(s.deltaPrecio) !== 0 && (
                    <span className="text-2xs text-ink-500 font-mono">
                      {Number(s.deltaPrecio) > 0 ? '+' : ''}
                      <MoneyAmount value={s.deltaPrecio} />
                    </span>
                  )}
                  <input
                    ref={(el) => { inputRefs.current[s.id] = el; }}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    placeholder="0"
                    value={cantidades[s.id] ?? ''}
                    onChange={(e) => setQty(s.id, e.target.value)}
                    onKeyDown={(e) => onKeyDownNav(idx, e)}
                    onFocus={(e) => e.target.select()}
                    className="w-20 input text-center font-mono py-1.5 text-sm"
                  />
                  <span className="text-2xs text-ink-300 w-10 text-left">{unidadCant}</span>
                </div>
              );
            })}
          </div>

          {/* Observaciones */}
          <div className="mt-5 pt-4 border-t border-cream-200">
            <label className="block text-2xs font-medium uppercase tracking-wider text-ink-500 mb-1">
              Observaciones (opcional)
            </label>
            <input
              ref={obsRef}
              type="text"
              value={observacion}
              onChange={(e) => setObservacion(e.target.value)}
              onKeyDown={(e) => onKeyDownNav(sabores.length, e)}
              placeholder="ej. sin sal, extra queso, todo bien cocido..."
              className="input"
            />
            <p className="text-2xs text-ink-300 mt-1">
              {isPorcionMode
                ? 'La observación viaja con esta porción y aparece grande en la comanda.'
                : 'La observación se aplica a TODOS los sabores que cargues en este pedido.'}
            </p>
          </div>

          {/* Agregar salsa (solo pasta fresca, NO en porciones) */}
          {esPastaFresca && !isPorcionMode && (
            <div className="mt-5 pt-4 border-t border-cream-200">
              <button
                ref={salsaToggleRef}
                type="button"
                onClick={() => setShowSalsaAdder((v) => !v)}
                onKeyDown={(e) => onKeyDownNav(sabores.length + 1, e)}
                className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-md bg-cream-100 hover:bg-cream-200 focus:bg-teresita-50 focus:ring-2 focus:ring-teresita-700/40 focus:outline-none transition-colors"
              >
                <span className="text-saffron-600 font-mono">{showSalsaAdder ? '▼' : '▶'}</span>
                <span className="text-sm font-medium text-ink-700">¿Agregar salsa al pedido?</span>
                <span className="text-2xs text-ink-500 ml-auto italic">
                  (Enter para {showSalsaAdder ? 'cerrar' : 'abrir'})
                </span>
              </button>

              {showSalsaAdder && (
                <div className="mt-3 grid gap-1.5 bg-cream-50 p-3 rounded-md border border-cream-300">
                  {salsasData.simple && (
                    <>
                      <div className="text-2xs font-medium uppercase tracking-wider text-ink-500 mt-1 mb-1">
                        Salsa simple · <MoneyAmount value={salsasData.simple.producto.precioBase} />/u
                      </div>
                      {salsasData.simple.sabores.map((s, idx) => {
                        const globalIdx = sabores.length + 2 + idx;
                        return (
                          <div
                            key={s.opcionId}
                            className="flex items-center gap-3 py-1 px-2 rounded-md hover:bg-cream-100 focus-within:bg-teresita-50 focus-within:ring-1 focus-within:ring-teresita-700/30"
                          >
                            <span className="text-2xs font-mono text-ink-500 w-10 text-right">{s.codigo ?? '—'}</span>
                            <span className="text-sm flex-1 text-ink-900">{s.nombre}</span>
                            <input
                              ref={(el) => { inputRefs.current['salsa::' + s.opcionId] = el; }}
                              type="number"
                              inputMode="numeric"
                              min="0"
                              step="1"
                              placeholder="0"
                              value={salsaCantidades[s.opcionId] ?? ''}
                              onChange={(e) => setSalsaQty(s.opcionId, e.target.value)}
                              onKeyDown={(e) => onKeyDownNav(globalIdx, e)}
                              onFocus={(e) => e.target.select()}
                              className="w-20 input text-center font-mono py-1 text-sm"
                            />
                            <span className="text-2xs text-ink-300 w-10 text-left">u</span>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {salsasData.especial && (
                    <>
                      <div className="text-2xs font-medium uppercase tracking-wider text-ink-500 mt-3 mb-1">
                        Salsa especial · <MoneyAmount value={salsasData.especial.producto.precioBase} />/u
                      </div>
                      {salsasData.especial.sabores.map((s, idx) => {
                        const globalIdx = sabores.length + 2 + (salsasData.simple?.sabores.length ?? 0) + idx;
                        return (
                          <div
                            key={s.opcionId}
                            className="flex items-center gap-3 py-1 px-2 rounded-md hover:bg-cream-100 focus-within:bg-teresita-50 focus-within:ring-1 focus-within:ring-teresita-700/30"
                          >
                            <span className="text-2xs font-mono text-ink-500 w-10 text-right">{s.codigo ?? '—'}</span>
                            <span className="text-sm flex-1 text-ink-900">{s.nombre}</span>
                            <input
                              ref={(el) => { inputRefs.current['salsa::' + s.opcionId] = el; }}
                              type="number"
                              inputMode="numeric"
                              min="0"
                              step="1"
                              placeholder="0"
                              value={salsaCantidades[s.opcionId] ?? ''}
                              onChange={(e) => setSalsaQty(s.opcionId, e.target.value)}
                              onKeyDown={(e) => onKeyDownNav(globalIdx, e)}
                              onFocus={(e) => e.target.select()}
                              className="w-20 input text-center font-mono py-1 text-sm"
                            />
                            <span className="text-2xs text-ink-300 w-10 text-left">u</span>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        )}

        <footer className="px-5 py-3 border-t border-cream-300 bg-surface-sunken flex items-center justify-between gap-3">
          <div className="flex-1">
            {isPorcionMode ? (
              <>
                <div className="text-2xs text-ink-500">
                  {cantidadPaqueteNum} {cantidadPaqueteNum === 1 ? 'porción' : 'porciones'} · {salsaPorcionId ? 'salsa elegida ✓' : 'falta elegir salsa'}
                </div>
                <MoneyAmount value={Number(producto.precioBase) * cantidadPaqueteNum} className="text-md text-teresita-700" />
              </>
            ) : (
              <>
                <div className="text-2xs text-ink-500">
                  {totalUnidades > 0 ? `${totalUnidades} u` : 'Cargá cantidad'}
                </div>
                <MoneyAmount value={subtotal} className="text-md text-teresita-700" />
              </>
            )}
          </div>
          <Button variant="secondary" onClick={onClose}>
            Cancelar (Esc)
          </Button>
          <Button
            disabled={isPorcionMode ? !saborRadioId : totalUnidades === 0}
            onClick={confirmar}
          >
            {isPorcionMode ? 'Agregar al pedido (Enter)' : 'Agregar (Enter)'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   SalsaModal — aparece después de cargar una pasta porción simple/especial.
//   Reglas:
//     - El cajero distribuye salsas entre los sabores con inputs de cantidad.
//     - Las primeras N (= porciones de pasta) son GRATIS (incluidas).
//     - Lo que excede se cobra al precio base de la salsa.
//     - Salsa simple ofrece además: Aceite, Aceite de oliva, Manteca (sin precio).
// ────────────────────────────────────────────────────────────────────────

interface SalsaModalProps {
  tipo: 'SIMPLE' | 'ESPECIAL';
  porcionesIncluidas: number;
  nombrePasta: string;
  onClose: () => void;
  onConfirm: (items: Array<Omit<CartItem, 'uid'>>) => void;
}

function SalsaModal({ tipo, porcionesIncluidas, nombrePasta, onClose, onConfirm }: SalsaModalProps) {
  const [data, setData] = useState<{
    producto: { id: string; nombre: string; precioBase: string; formaVenta: string; unidadPrecio: string; tipoProducto: { cocinaInterviene: boolean } };
    sabores: Array<{ opcionId: string; grupoId: string; grupoNombre: string; nombre: string; deltaPrecio: string; codigo: string | null }>;
  } | null>(null);
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Opciones extra que solo aparecen en este modal (post-pasta), NO en venta directa de salsa.
  //   - SIMPLE: Aceite, Aceite de oliva, Manteca (sin cargo, son acompañamientos)
  //   - ESPECIAL: Mixta / rosa (cuenta como salsa, va al precio especial si excede porciones)
  const extras = tipo === 'SIMPLE'
    ? [
        { id: '__aceite', nombre: 'Aceite', codigo: null, esExtraSinCargo: true },
        { id: '__aceite_oliva', nombre: 'Aceite de oliva', codigo: null, esExtraSinCargo: true },
        { id: '__manteca', nombre: 'Manteca', codigo: null, esExtraSinCargo: true },
      ]
    : [
        // Salsa mixta / rosa: cuenta como salsa, paga si excede porciones incluidas.
        { id: '__mixta', nombre: 'Mixta / Rosa', codigo: null, esExtraSinCargo: false },
      ];

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<typeof data>(`/catalogo/salsa/${tipo}`);
        setData(res);
      } catch (e) {
        console.error('Error cargando salsa', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [tipo]);

  // Foco inicial en el primer input de sabor (no extras)
  useEffect(() => {
    if (loading || !data) return;
    const t = setTimeout(() => {
      const first = data.sabores[0];
      if (first) {
        const el = inputRefs.current[first.opcionId];
        el?.focus();
        el?.select();
      }
    }, 50);
    return () => clearTimeout(t);
  }, [loading, data]);

  const allItems = data ? [
    ...data.sabores.map((s) => ({ id: s.opcionId, nombre: s.nombre, codigo: s.codigo, esExtra: false })),
    ...extras.map((e) => ({ id: e.id, nombre: e.nombre, codigo: e.codigo, esExtra: true })),
  ] : [];

  function focusByIndex(idx: number) {
    if (idx < 0 || idx >= allItems.length) return;
    const el = inputRefs.current[allItems[idx]!.id];
    if (el) {
      el.focus();
      el.select();
    }
  }

  function setQty(id: string, value: string) {
    setCantidades((c) => ({ ...c, [id]: value }));
  }

  function totalUnidades(): number {
    let total = 0;
    for (const it of allItems) {
      const n = Number(cantidades[it.id] ?? 0);
      if (Number.isFinite(n) && n > 0) total += n;
    }
    return total;
  }

  function calcExtraCharge(): number {
    if (!data) return 0;
    // Sabores reales + extras "con cargo" (ej: Mixta) cuentan para el cupo.
    let saboresTotal = 0;
    for (const s of data.sabores) {
      const n = Number(cantidades[s.opcionId] ?? 0);
      if (Number.isFinite(n) && n > 0) saboresTotal += n;
    }
    for (const e of extras) {
      if (!e.esExtraSinCargo) {
        const n = Number(cantidades[e.id] ?? 0);
        if (Number.isFinite(n) && n > 0) saboresTotal += n;
      }
    }
    const exceso = Math.max(0, saboresTotal - porcionesIncluidas);
    return exceso * Number(data.producto.precioBase);
  }

  function confirmar() {
    if (!data) return;
    // Estrategia: distribuir las primeras N (=porcionesIncluidas) como gratis,
    // el resto al precio base. Para mantener trazabilidad, generamos items
    // separados: "incluida" (precio 0) y "extra" (precio base).
    const items: Array<Omit<CartItem, 'uid'>> = [];
    let restantesIncluidas = porcionesIncluidas;
    const precioBase = Number(data.producto.precioBase);

    for (const sab of data.sabores) {
      const n = Number(cantidades[sab.opcionId] ?? 0);
      if (!Number.isFinite(n) || n <= 0) continue;

      const incluidas = Math.min(n, restantesIncluidas);
      const extras = n - incluidas;
      restantesIncluidas -= incluidas;

      const baseModif = [
        {
          grupoId: sab.grupoId,
          grupoNombre: sab.grupoNombre,
          opcionId: sab.opcionId,
          opcionNombre: sab.nombre,
          deltaPrecio: sab.deltaPrecio,
        },
      ];

      if (incluidas > 0) {
        items.push({
          productoId: data.producto.id,
          productoNombre: `${data.producto.nombre} (incluida con ${nombrePasta})`,
          formaVenta: data.producto.formaVenta as 'UNIDAD',
          unidadPrecio: data.producto.unidadPrecio as 'POR_UNIDAD',
          cantidad: incluidas,
          precioUnitario: 0,
          modificadores: baseModif,
          observacion: 'Incluida con la pasta',
          cocinaInterviene: data.producto.tipoProducto.cocinaInterviene,
        });
      }
      if (extras > 0) {
        items.push({
          productoId: data.producto.id,
          productoNombre: `${data.producto.nombre} (extra)`,
          formaVenta: data.producto.formaVenta as 'UNIDAD',
          unidadPrecio: data.producto.unidadPrecio as 'POR_UNIDAD',
          cantidad: extras,
          precioUnitario: precioBase,
          modificadores: baseModif,
          cocinaInterviene: data.producto.tipoProducto.cocinaInterviene,
        });
      }
    }

    // Extras especiales (Aceite, Manteca, Mixta, etc.)
    //   - esExtraSinCargo=true → siempre gratis (acompañamientos)
    //   - esExtraSinCargo=false → cuenta como salsa, gratis hasta porciones, después al precio
    for (const e of extras) {
      const n = Number(cantidades[e.id] ?? 0);
      if (!Number.isFinite(n) || n <= 0) continue;

      if (e.esExtraSinCargo) {
        items.push({
          productoId: data.producto.id,
          productoNombre: `${e.nombre} (acompañamiento)`,
          formaVenta: data.producto.formaVenta as 'UNIDAD',
          unidadPrecio: data.producto.unidadPrecio as 'POR_UNIDAD',
          cantidad: n,
          precioUnitario: 0,
          modificadores: [],
          observacion: `Acompañamiento sin cargo (con ${nombrePasta})`,
          cocinaInterviene: data.producto.tipoProducto.cocinaInterviene,
        });
        continue;
      }

      // Salsa mixta: cuenta para el cupo de porciones incluidas
      const incluidas = Math.min(n, restantesIncluidas);
      const xtras = n - incluidas;
      restantesIncluidas -= incluidas;

      if (incluidas > 0) {
        items.push({
          productoId: data.producto.id,
          productoNombre: `${data.producto.nombre} ${e.nombre} (incluida con ${nombrePasta})`,
          formaVenta: data.producto.formaVenta as 'UNIDAD',
          unidadPrecio: data.producto.unidadPrecio as 'POR_UNIDAD',
          cantidad: incluidas,
          precioUnitario: 0,
          modificadores: [],
          observacion: `Salsa ${e.nombre.toLowerCase()} incluida con la pasta`,
          cocinaInterviene: data.producto.tipoProducto.cocinaInterviene,
        });
      }
      if (xtras > 0) {
        items.push({
          productoId: data.producto.id,
          productoNombre: `${data.producto.nombre} ${e.nombre} (extra)`,
          formaVenta: data.producto.formaVenta as 'UNIDAD',
          unidadPrecio: data.producto.unidadPrecio as 'POR_UNIDAD',
          cantidad: xtras,
          precioUnitario: precioBase,
          modificadores: [],
          observacion: `Salsa ${e.nombre.toLowerCase()}`,
          cocinaInterviene: data.producto.tipoProducto.cocinaInterviene,
        });
      }
    }

    if (items.length === 0) {
      onClose();
      return;
    }
    onConfirm(items);
  }

  function onKeyDownItem(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusByIndex(idx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusByIndex(idx - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      confirmar();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-50 p-4">
        <div className="card p-8 text-ink-500">Cargando salsas...</div>
      </div>
    );
  }
  if (!data) return null;

  const usadas = totalUnidades();
  const extra = calcExtraCharge();

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col shadow-modal">
        <header className="px-5 py-4 border-b border-cream-300">
          <div className="flex justify-between items-start">
            <div>
              <div className="text-2xs font-mono text-ink-300 uppercase tracking-wider">
                Salsa para {nombrePasta}
              </div>
              <h2 className="font-display text-lg text-teresita-700">
                Salsa {tipo === 'SIMPLE' ? 'simple' : 'especial'}
              </h2>
              <p className="text-xs text-ink-500 mt-1">
                <strong className="text-basil-600">{porcionesIncluidas}</strong> incluida{porcionesIncluidas !== 1 ? 's' : ''} con la pasta · extra{' '}
                <MoneyAmount value={data.producto.precioBase} />/u
              </p>
            </div>
            <button onClick={onClose} className="text-ink-500 hover:text-ink-900 text-xl leading-none">
              ✕
            </button>
          </div>
          <p className="text-2xs text-ink-300 mt-2 italic">
            Cargá la cantidad de cada sabor · ↑↓ navega · Enter confirma · Esc cancela
          </p>
        </header>

        <div className="overflow-y-auto px-5 py-4">
          {/* Lista unificada: sabores + extras con el mismo estilo. Sin secciones aparte. */}
          <div className="grid gap-1.5">
            {allItems.map((item, idx) => (
              <div
                key={item.id}
                className="flex items-center gap-3 py-1.5 px-2 rounded-md hover:bg-cream-50 focus-within:bg-teresita-50 focus-within:ring-1 focus-within:ring-teresita-700/30"
              >
                <span className="text-2xs font-mono text-ink-500 w-10 text-right">
                  {item.codigo ?? '—'}
                </span>
                <span className="text-sm flex-1 text-ink-900">{item.nombre}</span>
                <input
                  ref={(el) => { inputRefs.current[item.id] = el; }}
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  placeholder="0"
                  value={cantidades[item.id] ?? ''}
                  onChange={(e) => setQty(item.id, e.target.value)}
                  onKeyDown={(e) => onKeyDownItem(idx, e)}
                  onFocus={(e) => e.target.select()}
                  className="w-20 input text-center font-mono py-1.5 text-sm"
                />
                <span className="text-2xs text-ink-300 w-10 text-left">u</span>
              </div>
            ))}
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-cream-300 bg-surface-sunken flex items-center justify-between gap-3">
          <div className="flex-1">
            <div className="text-2xs text-ink-500">
              {usadas} salsa{usadas !== 1 ? 's' : ''}
              {extra > 0 && (
                <>
                  {' · '}
                  <span className="text-saffron-600 font-medium">extra a cobrar:</span>
                </>
              )}
            </div>
            <MoneyAmount value={extra} className={cn('text-md', extra > 0 ? 'text-saffron-600' : 'text-basil-600')} />
          </div>
          <Button variant="secondary" onClick={onClose}>
            Saltar (Esc)
          </Button>
          <Button onClick={confirmar} disabled={usadas === 0}>
            Agregar (Enter)
          </Button>
        </footer>
      </div>
    </div>
  );
}
