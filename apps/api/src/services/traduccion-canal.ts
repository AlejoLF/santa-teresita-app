import { prisma } from '@sta/db/client';
import { Prisma, type TraduccionCanal } from '@sta/db';
import { recordAudit } from './audit.js';
import { ReglaNegocioError } from './errores.js';

/**
 * Traducción del menú de una plataforma al catálogo del POS.
 *
 * Decisión del 30/09: el menú de RAPPI lo maneja la encargada en la web de
 * RAPPI, y el POS NO publica el suyo. Los productos, combos y precios de allá
 * son otros. Lo que sí hace el POS es CONTAR lo que se vendió: cada producto o
 * topping de RAPPI (por su id de RAPPI, que es estable) se traduce a un
 * Producto / OpcionModificador nuestro. El precio es el de RAPPI, siempre.
 *
 * Reglas:
 *   - Lo que llega sin traducción NO se pierde: la venta entra igual con el
 *     producto comodín ("RAPPI — sin traducir"), con el nombre y el precio de
 *     RAPPI, y acá queda una fila PENDIENTE para traducirla después.
 *   - Cuando la encargada traduce algo que ya había entrado como comodín, las
 *     ventas anteriores se corrigen (el ítem pasa al producto real, mismo
 *     precio y nombre), así el conteo queda bien desde el primer pedido.
 *   - NADA se traduce solo (pedido del 30/09: la primera versión traducía por
 *     nombre exacto y eligió mal). Todo lo nuevo queda PENDIENTE; la pantalla
 *     ofrece sugerencias, pero decide la encargada.
 *   - Un producto de RAPPI puede traducirse a un producto nuestro MÁS un
 *     sabor/tipo (opcionId): "Ravioles de ricota" de RAPPI = Ravioles + Ricota.
 */

export type PlataformaCanal = 'RAPPI' | 'PEDIDOS_YA' | 'MERCADO_LIBRE';
export type TipoTraduccion = 'PRODUCTO' | 'TOPPING';
export type EstadoTraduccion = 'PENDIENTE' | 'TRADUCIDO' | 'IGNORAR';

export interface VistoExterno {
  tipo: TipoTraduccion;
  idExterno: string;
  nombre: string;
  sku?: string | null;
  categoria?: string | null;
  precio?: number | null;
}

const claveDe = (tipo: TipoTraduccion, idExterno: string) => `${tipo}:${idExterno}`;

/** Sin acentos, sin mayúsculas, sin espacios de más: para comparar nombres. */
export function normalizarNombre(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Comodín ─────────────────────────────────────────────────────────────

const CODIGO_COMODIN: Record<PlataformaCanal, string> = {
  RAPPI: 'RAPPI-SIN-TRADUCIR',
  PEDIDOS_YA: 'PYA-SIN-TRADUCIR',
  MERCADO_LIBRE: 'MELI-SIN-TRADUCIR',
};
const NOMBRE_COMODIN: Record<PlataformaCanal, string> = {
  RAPPI: 'RAPPI — sin traducir',
  PEDIDOS_YA: 'Pedidos YA — sin traducir',
  MERCADO_LIBRE: 'Mercado Libre — sin traducir',
};
const comodinCache = new Map<PlataformaCanal, string>();

/**
 * El producto con el que entra lo que no tiene traducción. Se crea solo la
 * primera vez, en una categoría "Plataformas" propia (va a cocina: la comanda
 * tiene que salir igual, con el nombre de RAPPI).
 */
export async function productoComodin(plataforma: PlataformaCanal): Promise<string> {
  const cacheado = comodinCache.get(plataforma);
  if (cacheado) return cacheado;
  const codigo = CODIGO_COMODIN[plataforma];
  const existente = await prisma.producto.findUnique({ where: { codigo }, select: { id: true, activo: true } });
  if (existente) {
    // Nunca activo: ver abajo.
    if (existente.activo) await prisma.producto.update({ where: { id: existente.id }, data: { activo: false } });
    comodinCache.set(plataforma, existente.id);
    return existente.id;
  }
  const categoria = await prisma.categoria.upsert({
    where: { nombre: 'Plataformas' },
    create: { nombre: 'Plataformas', orden: 99, icono: '🛵', activa: true },
    update: {},
  });
  const tipo =
    (await prisma.tipoProducto.findFirst({
      where: { categoriaId: categoria.id, nombre: 'Sin traducir' },
      select: { id: true },
    })) ??
    (await prisma.tipoProducto.create({
      data: {
        categoriaId: categoria.id,
        nombre: 'Sin traducir',
        descripcion: 'Ítems de plataformas que todavía no tienen traducción al catálogo.',
        cocinaInterviene: true,
      },
      select: { id: true },
    }));
  const creado = await prisma.producto.create({
    data: {
      tipoProductoId: tipo.id,
      nombre: NOMBRE_COMODIN[plataforma],
      formaVenta: 'UNIDAD',
      unidadPrecio: 'POR_UNIDAD',
      precioBase: '0',
      codigo,
      descripcion:
        'Comodín: lo que llega de la plataforma sin traducción entra con este producto, ' +
        'con el nombre y el precio de allá. Se corrige solo cuando se traduce.',
      // INACTIVO a propósito: así no aparece en el cajero (a $0) ni se publica
      // en el menú de RAPPI. Las ventas de canal lo usan igual: crearVenta no
      // filtra por activo, y el precio viene de la plataforma.
      activo: false,
    },
    select: { id: true },
  });
  comodinCache.set(plataforma, creado.id);
  return creado.id;
}

// ─── Registrar lo visto y traducir automáticamente lo obvio ─────────────

/**
 * Anota cada producto/topping tal como lo mandó la plataforma (nombre, sku,
 * precio, cuántas veces se vio). No toca lo que la encargada ya decidió. Lo
 * nuevo queda PENDIENTE: no se traduce nada solo.
 */
export async function registrarVistos(
  plataforma: PlataformaCanal,
  vistos: VistoExterno[],
  origen: 'MENU' | 'PEDIDO',
): Promise<Map<string, TraduccionCanal>> {
  const unicos = new Map<string, VistoExterno>();
  for (const v of vistos) {
    if (!v.idExterno) continue;
    const k = claveDe(v.tipo, v.idExterno);
    if (!unicos.has(k)) unicos.set(k, v);
  }
  const out = new Map<string, TraduccionCanal>();
  if (unicos.size === 0) return out;

  const existentes = await prisma.traduccionCanal.findMany({
    where: {
      plataforma,
      OR: [...unicos.values()].map((v) => ({ tipo: v.tipo, idExterno: v.idExterno })),
    },
  });
  const porClave = new Map(existentes.map((t) => [claveDe(t.tipo as TipoTraduccion, t.idExterno), t]));
  const nuevas: VistoExterno[] = [];
  const ahora = new Date();

  for (const [k, v] of unicos) {
    const ya = porClave.get(k);
    const nombre = (v.nombre || v.idExterno).slice(0, 200);
    if (ya) {
      const upd = await prisma.traduccionCanal.update({
        where: { id: ya.id },
        data: {
          nombreExterno: nombre,
          ...(v.sku !== undefined && { skuExterno: v.sku?.slice(0, 120) ?? null }),
          ...(v.categoria !== undefined && { categoriaExterna: v.categoria?.slice(0, 200) ?? null }),
          ...(typeof v.precio === 'number' && Number.isFinite(v.precio) && { precioExterno: v.precio.toFixed(2) }),
          vecesVisto: { increment: origen === 'PEDIDO' ? 1 : 0 },
          vistoAt: ahora,
        },
      });
      out.set(k, upd);
    } else {
      nuevas.push(v);
    }
  }

  if (nuevas.length) {
    for (const v of nuevas) {
      const k = claveDe(v.tipo, v.idExterno);
      const creada = await prisma.traduccionCanal.create({
        data: {
          plataforma,
          tipo: v.tipo,
          idExterno: v.idExterno.slice(0, 120),
          nombreExterno: (v.nombre || v.idExterno).slice(0, 200),
          skuExterno: v.sku?.slice(0, 120) ?? null,
          categoriaExterna: v.categoria?.slice(0, 200) ?? null,
          precioExterno:
            typeof v.precio === 'number' && Number.isFinite(v.precio) ? v.precio.toFixed(2) : null,
          origen,
          vecesVisto: origen === 'PEDIDO' ? 1 : 0,
          vistoAt: ahora,
          estado: 'PENDIENTE',
        },
      });
      out.set(k, creada);
    }
  }
  return out;
}

/** Busca traducciones ya existentes (sin registrar nada). */
export async function buscarTraducciones(
  plataforma: PlataformaCanal,
  claves: Array<{ tipo: TipoTraduccion; idExterno: string }>,
): Promise<Map<string, TraduccionCanal>> {
  if (claves.length === 0) return new Map();
  const filas = await prisma.traduccionCanal.findMany({
    where: { plataforma, OR: claves.map((c) => ({ tipo: c.tipo, idExterno: c.idExterno })) },
  });
  return new Map(filas.map((t) => [claveDe(t.tipo as TipoTraduccion, t.idExterno), t]));
}

export { claveDe as claveTraduccion };

// ─── Pantalla: listar, resumen, decidir ─────────────────────────────────

export interface FiltroTraducciones {
  tipo?: TipoTraduccion;
  estado?: EstadoTraduccion;
  q?: string;
  limite?: number;
}

export async function resumenTraducciones(plataforma: PlataformaCanal) {
  const filas = await prisma.traduccionCanal.groupBy({
    by: ['tipo', 'estado'],
    where: { plataforma },
    _count: { _all: true },
  });
  const cuenta = (tipo: TipoTraduccion, estado: EstadoTraduccion) =>
    filas.find((f) => f.tipo === tipo && f.estado === estado)?._count._all ?? 0;
  const resumen = {
    productos: {
      pendientes: cuenta('PRODUCTO', 'PENDIENTE'),
      traducidos: cuenta('PRODUCTO', 'TRADUCIDO'),
      ignorados: cuenta('PRODUCTO', 'IGNORAR'),
    },
    toppings: {
      pendientes: cuenta('TOPPING', 'PENDIENTE'),
      traducidos: cuenta('TOPPING', 'TRADUCIDO'),
      ignorados: cuenta('TOPPING', 'IGNORAR'),
    },
  };
  return { ...resumen, pendientes: resumen.productos.pendientes + resumen.toppings.pendientes };
}

/** Palabras en común entre dos nombres, para sugerir. Barato y suficiente. */
function parecido(a: string, b: string): number {
  const A = new Set(normalizarNombre(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(normalizarNombre(b).split(' ').filter((w) => w.length > 2));
  if (A.size === 0 || B.size === 0) return 0;
  let comunes = 0;
  for (const w of A) if (B.has(w)) comunes++;
  return comunes / Math.max(A.size, B.size);
}

export async function listarTraducciones(plataforma: PlataformaCanal, f: FiltroTraducciones = {}) {
  const q = f.q?.trim();
  const filas = await prisma.traduccionCanal.findMany({
    where: {
      plataforma,
      ...(f.tipo && { tipo: f.tipo }),
      ...(f.estado && { estado: f.estado }),
      ...(q && {
        OR: [
          { nombreExterno: { contains: q, mode: 'insensitive' } },
          { skuExterno: { contains: q, mode: 'insensitive' } },
          { categoriaExterna: { contains: q, mode: 'insensitive' } },
        ],
      }),
    },
    include: {
      producto: { select: { id: true, nombre: true, codigo: true, unidadPrecio: true, cantidadDefault: true } },
      opcion: { select: { id: true, nombre: true, codigo: true, grupo: { select: { id: true, nombre: true } } } },
    },
    orderBy: [{ estado: 'asc' }, { vecesVisto: 'desc' }, { nombreExterno: 'asc' }],
    take: f.limite ?? 500,
  });

  // Sugerencias sólo para lo pendiente: los 3 productos/opciones con más
  // palabras en común. La encargada confirma con un clic o busca otro.
  const pendProductos = filas.filter((t) => t.tipo === 'PRODUCTO' && t.estado === 'PENDIENTE');
  const pendToppings = filas.filter((t) => t.tipo === 'TOPPING' && t.estado === 'PENDIENTE');
  const sugerencias = new Map<string, Array<{ id: string; nombre: string; detalle?: string }>>();
  if (pendProductos.length) {
    const activos = await prisma.producto.findMany({
      where: { activo: true, codigo: { notIn: Object.values(CODIGO_COMODIN) } },
      select: { id: true, nombre: true, codigo: true },
    });
    for (const t of pendProductos) {
      const top = activos
        .map((p) => ({ p, s: parecido(t.nombreExterno, p.nombre) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 3)
        .map((x) => ({ id: x.p.id, nombre: x.p.nombre, detalle: x.p.codigo ?? undefined }));
      if (top.length) sugerencias.set(t.id, top);
    }
  }
  if (pendToppings.length) {
    const opciones = await prisma.opcionModificador.findMany({
      where: { activa: true },
      select: { id: true, nombre: true, grupo: { select: { nombre: true } } },
    });
    for (const t of pendToppings) {
      const top = opciones
        .map((o) => ({ o, s: parecido(t.nombreExterno, o.nombre) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 3)
        .map((x) => ({ id: x.o.id, nombre: x.o.nombre, detalle: x.o.grupo.nombre }));
      if (top.length) sugerencias.set(t.id, top);
    }
  }

  return filas.map((t) => ({
    id: t.id,
    tipo: t.tipo as TipoTraduccion,
    idExterno: t.idExterno,
    nombreExterno: t.nombreExterno,
    skuExterno: t.skuExterno,
    categoriaExterna: t.categoriaExterna,
    precioExterno: t.precioExterno?.toString() ?? null,
    estado: t.estado as EstadoTraduccion,
    origenTraduccion: t.origenTraduccion,
    origen: t.origen,
    vecesVisto: t.vecesVisto,
    vistoAt: t.vistoAt.toISOString(),
    cantidadPorUnidad: t.cantidadPorUnidad?.toString() ?? null,
    producto: t.producto
      ? {
          id: t.producto.id,
          nombre: t.producto.nombre,
          codigo: t.producto.codigo,
          porPeso: t.producto.unidadPrecio === 'POR_KILO' || t.producto.unidadPrecio === 'POR_GRAMO',
          cantidadDefault: t.producto.cantidadDefault?.toString() ?? null,
        }
      : null,
    opcion: t.opcion
      ? { id: t.opcion.id, nombre: t.opcion.nombre, codigo: t.opcion.codigo, grupo: t.opcion.grupo.nombre }
      : null,
    sugerencias: sugerencias.get(t.id) ?? [],
  }));
}

export interface DecisionTraduccion {
  /** Para tipo PRODUCTO. null = sacar la traducción. */
  productoId?: string | null;
  /**
   * Para tipo TOPPING: la opción nuestra (null = sacar la traducción).
   * Para tipo PRODUCTO: el sabor/tipo que se aplica al producto (opcional;
   * null = sin sabor).
   */
  opcionId?: string | null;
  /** IGNORAR para que no cuente; PENDIENTE para volver a dejarlo sin decidir. */
  estado?: EstadoTraduccion;
  cantidadPorUnidad?: number | null;
}

/**
 * La decisión de la encargada. Si traduce un producto, las ventas de los
 * últimos 90 días que entraron con el comodín para ese id de RAPPI se
 * corrigen al producto real (mismo nombre y precio: sólo cambia a qué se
 * imputa). Devuelve cuántos ítems se corrigieron.
 */
export async function decidirTraduccion(
  id: string,
  decision: DecisionTraduccion,
  usuario: { id: string; nombre?: string | null; pcOrigen?: string },
): Promise<{ traduccion: TraduccionCanal; itemsCorregidos: number }> {
  const actual = await prisma.traduccionCanal.findUnique({ where: { id } });
  if (!actual) throw new ReglaNegocioError('Esa traducción no existe.');

  const data: Prisma.TraduccionCanalUncheckedUpdateInput = {
    actualizadoPor: usuario.nombre ?? usuario.id,
  };
  if (decision.estado === 'IGNORAR') {
    Object.assign(data, { estado: 'IGNORAR', productoId: null, opcionId: null, origenTraduccion: 'MANUAL' });
  } else if (decision.estado === 'PENDIENTE') {
    Object.assign(data, { estado: 'PENDIENTE', productoId: null, opcionId: null, origenTraduccion: null });
  } else if (actual.tipo === 'PRODUCTO') {
    if (decision.productoId === null) {
      Object.assign(data, { estado: 'PENDIENTE', productoId: null, opcionId: null, origenTraduccion: null });
    } else if (decision.productoId) {
      const p = await prisma.producto.findUnique({ where: { id: decision.productoId }, select: { id: true, codigo: true } });
      if (!p) throw new ReglaNegocioError('Ese producto no existe.');
      if (p.codigo && Object.values(CODIGO_COMODIN).includes(p.codigo)) {
        throw new ReglaNegocioError('El comodín no es una traducción: elegí el producto real.');
      }
      Object.assign(data, { estado: 'TRADUCIDO', productoId: p.id, origenTraduccion: 'MANUAL' });
    }
    // El sabor/tipo que acompaña al producto. Sólo tiene sentido con un
    // producto traducido (ya sea el de esta decisión o el que ya estaba).
    if (decision.opcionId !== undefined) {
      const hayProducto = decision.productoId ?? actual.productoId;
      if (decision.opcionId === null || !hayProducto) {
        data.opcionId = null;
      } else {
        const o = await prisma.opcionModificador.findUnique({ where: { id: decision.opcionId }, select: { id: true } });
        if (!o) throw new ReglaNegocioError('Ese sabor no existe.');
        data.opcionId = o.id;
      }
    }
  } else if (actual.tipo === 'TOPPING') {
    if (decision.opcionId === null) {
      Object.assign(data, { estado: 'PENDIENTE', opcionId: null, origenTraduccion: null });
    } else if (decision.opcionId) {
      const o = await prisma.opcionModificador.findUnique({ where: { id: decision.opcionId }, select: { id: true } });
      if (!o) throw new ReglaNegocioError('Esa opción no existe.');
      Object.assign(data, { estado: 'TRADUCIDO', opcionId: o.id, origenTraduccion: 'MANUAL' });
    }
  }
  if (decision.cantidadPorUnidad !== undefined) {
    data.cantidadPorUnidad =
      decision.cantidadPorUnidad === null || !(decision.cantidadPorUnidad > 0)
        ? null
        : decision.cantidadPorUnidad.toFixed(3);
  }

  const traduccion = await prisma.traduccionCanal.update({ where: { id }, data });
  await recordAudit({
    tabla: 'traducciones_canal',
    registroId: id,
    accion: 'UPDATE',
    usuarioId: usuario.id,
    pcOrigen: usuario.pcOrigen ?? 'admin',
    valorAnterior: { estado: actual.estado, productoId: actual.productoId, opcionId: actual.opcionId },
    valorNuevo: {
      estado: traduccion.estado,
      productoId: traduccion.productoId,
      opcionId: traduccion.opcionId,
      idExterno: actual.idExterno,
      nombreExterno: actual.nombreExterno,
    },
  });

  let itemsCorregidos = 0;
  if (traduccion.tipo === 'PRODUCTO' && traduccion.estado === 'TRADUCIDO' && traduccion.productoId) {
    itemsCorregidos = await corregirItemsComodin(
      traduccion.plataforma as PlataformaCanal,
      traduccion.idExterno,
      traduccion.productoId,
      usuario,
    );
  }
  return { traduccion, itemsCorregidos };
}

/** Marca que va en la observación del ítem para saber de qué producto de RAPPI salió. */
export function marcaItemExterno(plataforma: PlataformaCanal, idExterno: string): string {
  return `[${plataforma}:${idExterno}]`;
}

const DIAS_CORRECCION = 90;

/**
 * Los ítems que entraron con el comodín para este id externo pasan al
 * producto real. No se toca precio, cantidad ni nombre — sólo a qué se
 * imputa — y queda auditado ítem por ítem.
 */
async function corregirItemsComodin(
  plataforma: PlataformaCanal,
  idExterno: string,
  productoId: string,
  usuario: { id: string; pcOrigen?: string },
): Promise<number> {
  const comodinId = await productoComodin(plataforma);
  const marca = marcaItemExterno(plataforma, idExterno);
  const desde = new Date(Date.now() - DIAS_CORRECCION * 24 * 3_600_000);
  const items = await prisma.itemVenta.findMany({
    where: {
      productoId: comodinId,
      observacion: { startsWith: marca },
      venta: { canal: plataforma, fechaApertura: { gte: desde } },
    },
    select: { id: true, ventaId: true },
  });
  if (items.length === 0) return 0;
  await prisma.$transaction(async (tx) => {
    for (const it of items) {
      await tx.itemVenta.update({ where: { id: it.id }, data: { productoId, editadoAt: new Date(), editadoPorId: usuario.id } });
      await recordAudit({
        tabla: 'items_venta',
        registroId: it.id,
        accion: 'UPDATE',
        usuarioId: usuario.id,
        pcOrigen: usuario.pcOrigen ?? 'admin',
        valorAnterior: { productoId: comodinId },
        valorNuevo: { productoId, motivo: `traducción ${plataforma} ${idExterno}` },
        tx,
      });
    }
  });
  return items.length;
}
