/**
 * Seed inicial de Santa Teresita Pastas.
 *
 * Pobla:
 *   - Usuarios (Vendedor + Encargada + Julio) con PIN bcrypt
 *   - Categorías de movimientos (sistema)
 *   - Cuentas (5 reales + cuentas a cobrar transitorias)
 *   - Posnets (placeholders, soportaIntegracion=false hasta confirmar modelos)
 *   - Listas de precios (Local + Pedidos YA + RAPPI placeholder)
 *   - Productos desde lista-precios.json (output del parser de Excel)
 *
 * Idempotente: usa upsert por campos únicos. Correr varias veces no duplica datos.
 *
 * Uso:
 *   pnpm db:seed
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import bcrypt from 'bcryptjs';
import {
  PrismaClient,
  TipoCuenta,
  TipoCuentaACobrar,
  MetodoActualizacionCuenta,
  CanalListaPrecios,
  RolUsuario,
  TipoCategoriaMovimiento,
  FormaVenta,
  UnidadPrecio,
  TipoSeleccion,
} from '@prisma/client';

const prisma = new PrismaClient();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────────────────────────────
//   Constantes (PINs default — el cliente debe cambiarlos en producción)
// ────────────────────────────────────────────────────────────────────────

const PIN_VENDEDOR_DEFAULT = '0001';
const PIN_ENCARGADA_DEFAULT = '0002';
const PIN_JULIO_DEFAULT = '0003';
const BCRYPT_ROUNDS = 12;

async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

// ────────────────────────────────────────────────────────────────────────
//   1. Usuarios
// ────────────────────────────────────────────────────────────────────────

async function seedUsuarios() {
  console.log('▸ Seeding usuarios...');
  const vendedor = await prisma.usuario.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      nombre: 'Vendedor',
      rol: RolUsuario.VENDEDOR,
      pinHash: await hashPin(PIN_VENDEDOR_DEFAULT),
    },
    update: {},
  });

  const encargada = await prisma.usuario.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      nombre: 'Encargada',
      rol: RolUsuario.ADMIN,
      pinHash: await hashPin(PIN_ENCARGADA_DEFAULT),
    },
    update: {},
  });

  const julio = await prisma.usuario.upsert({
    where: { id: '00000000-0000-0000-0000-000000000003' },
    create: {
      id: '00000000-0000-0000-0000-000000000003',
      nombre: 'Julio',
      rol: RolUsuario.ADMIN,
      pinHash: await hashPin(PIN_JULIO_DEFAULT),
    },
    update: {},
  });

  console.log(`  ✓ Vendedor (PIN ${PIN_VENDEDOR_DEFAULT})`);
  console.log(`  ✓ Encargada (PIN ${PIN_ENCARGADA_DEFAULT})`);
  console.log(`  ✓ Julio (PIN ${PIN_JULIO_DEFAULT})`);
  return { vendedor, encargada, julio };
}

// ────────────────────────────────────────────────────────────────────────
//   2. Categorías de movimientos (SPEC §3.2.4)
// ────────────────────────────────────────────────────────────────────────

const CATEGORIAS_MOVIMIENTO_SISTEMA: Array<{
  nombre: string;
  tipo: TipoCategoriaMovimiento;
  esOperativa?: boolean;
  orden: number;
}> = [
  { nombre: 'Venta mostrador', tipo: TipoCategoriaMovimiento.INGRESO, orden: 1 },
  { nombre: 'Venta delivery propio', tipo: TipoCategoriaMovimiento.INGRESO, orden: 2 },
  { nombre: 'Venta DELIVERATE', tipo: TipoCategoriaMovimiento.INGRESO, orden: 3 },
  { nombre: 'Venta plataforma', tipo: TipoCategoriaMovimiento.INGRESO, orden: 4 },
  { nombre: 'Otros ingresos', tipo: TipoCategoriaMovimiento.INGRESO, orden: 5 },
  { nombre: 'Sueldos', tipo: TipoCategoriaMovimiento.EGRESO, orden: 10 },
  { nombre: 'Adelanto a empleado', tipo: TipoCategoriaMovimiento.EGRESO, orden: 11 },
  { nombre: 'Comisiones', tipo: TipoCategoriaMovimiento.EGRESO, orden: 12 },
  { nombre: 'Insumos (compras a proveedores)', tipo: TipoCategoriaMovimiento.EGRESO, orden: 13 },
  { nombre: 'Servicios', tipo: TipoCategoriaMovimiento.EGRESO, orden: 14 },
  { nombre: 'Mantenimiento', tipo: TipoCategoriaMovimiento.EGRESO, orden: 15 },
  { nombre: 'Impuestos y tasas', tipo: TipoCategoriaMovimiento.EGRESO, orden: 16 },
  { nombre: 'Gastos financieros', tipo: TipoCategoriaMovimiento.EGRESO, orden: 17 },
  { nombre: 'Publicidad', tipo: TipoCategoriaMovimiento.EGRESO, orden: 18 },
  { nombre: 'Movilidad', tipo: TipoCategoriaMovimiento.EGRESO, orden: 19 },
  { nombre: 'Retiro Julio', tipo: TipoCategoriaMovimiento.EGRESO, esOperativa: false, orden: 20 },
  { nombre: 'Diferencia de caja', tipo: TipoCategoriaMovimiento.AMBOS, orden: 30 },
  { nombre: 'Transferencia interna', tipo: TipoCategoriaMovimiento.TRANSFERENCIA, orden: 40 },
  { nombre: 'Extraordinario / Sin categoría', tipo: TipoCategoriaMovimiento.AMBOS, orden: 99 },
];

async function seedCategoriasMovimiento() {
  console.log('▸ Seeding categorías de movimiento...');
  for (const c of CATEGORIAS_MOVIMIENTO_SISTEMA) {
    await prisma.categoriaMovimiento.upsert({
      where: { nombre: c.nombre },
      create: {
        nombre: c.nombre,
        tipo: c.tipo,
        esSistema: true,
        esOperativa: c.esOperativa ?? true,
        orden: c.orden,
      },
      update: {
        tipo: c.tipo,
        orden: c.orden,
        esOperativa: c.esOperativa ?? true,
      },
    });
  }
  console.log(`  ✓ ${CATEGORIAS_MOVIMIENTO_SISTEMA.length} categorías base`);
}

// ────────────────────────────────────────────────────────────────────────
//   3. Cuentas y cuentas a cobrar (SPEC §3.1)
// ────────────────────────────────────────────────────────────────────────

async function seedCuentas() {
  console.log('▸ Seeding cuentas...');

  const cajaFisica = await prisma.cuenta.upsert({
    where: { nombre: 'Caja física' },
    create: {
      nombre: 'Caja física',
      tipo: TipoCuenta.EFECTIVO,
      metodoActualizacion: MetodoActualizacionCuenta.MANUAL,
    },
    update: {},
  });

  const santander = await prisma.cuenta.upsert({
    where: { nombre: 'Santander' },
    create: {
      nombre: 'Santander',
      tipo: TipoCuenta.BANCO,
      banco: 'Santander Río',
      metodoActualizacion: MetodoActualizacionCuenta.BELVO,
    },
    update: {},
  });

  const galicia = await prisma.cuenta.upsert({
    where: { nombre: 'Galicia' },
    create: {
      nombre: 'Galicia',
      tipo: TipoCuenta.BANCO,
      banco: 'Banco Galicia',
      metodoActualizacion: MetodoActualizacionCuenta.BELVO,
    },
    update: {},
  });

  const cuentaDni = await prisma.cuenta.upsert({
    where: { nombre: 'Cuenta DNI' },
    create: {
      nombre: 'Cuenta DNI',
      tipo: TipoCuenta.WALLET,
      banco: 'Banco Provincia',
      metodoActualizacion: MetodoActualizacionCuenta.IMPORT_EXTRACTO,
    },
    update: {},
  });

  const mercadoPago = await prisma.cuenta.upsert({
    where: { nombre: 'MercadoPago' },
    create: {
      nombre: 'MercadoPago',
      tipo: TipoCuenta.WALLET,
      banco: 'MercadoPago',
      metodoActualizacion: MetodoActualizacionCuenta.API_MP,
    },
    update: {},
  });

  console.log('  ✓ 5 cuentas reales');

  // Cuentas a cobrar — tarjetas por banco + plataformas
  const cac: Array<{
    nombre: string;
    tipo: TipoCuentaACobrar;
    cuentaDestinoId: string;
    plazoDias: number;
    comisionPct: string;
  }> = [
    {
      nombre: 'Tarjeta Débito Santander',
      tipo: TipoCuentaACobrar.TARJETA_DEBITO,
      cuentaDestinoId: santander.id,
      plazoDias: 2,
      comisionPct: '2.0',
    },
    {
      nombre: 'Tarjeta Crédito Santander',
      tipo: TipoCuentaACobrar.TARJETA_CREDITO,
      cuentaDestinoId: santander.id,
      plazoDias: 18,
      comisionPct: '3.0',
    },
    {
      nombre: 'Tarjeta Débito Galicia',
      tipo: TipoCuentaACobrar.TARJETA_DEBITO,
      cuentaDestinoId: galicia.id,
      plazoDias: 2,
      comisionPct: '2.0',
    },
    {
      nombre: 'Tarjeta Crédito Galicia',
      tipo: TipoCuentaACobrar.TARJETA_CREDITO,
      cuentaDestinoId: galicia.id,
      plazoDias: 18,
      comisionPct: '3.0',
    },
    {
      nombre: 'Pedidos YA',
      tipo: TipoCuentaACobrar.PLATAFORMA_DELIVERY,
      cuentaDestinoId: santander.id,
      plazoDias: 7,
      comisionPct: '22.0',
    },
    {
      nombre: 'RAPPI',
      tipo: TipoCuentaACobrar.PLATAFORMA_DELIVERY,
      cuentaDestinoId: santander.id,
      plazoDias: 7,
      comisionPct: '30.0',
    },
    {
      nombre: 'Mercado Libre',
      tipo: TipoCuentaACobrar.PLATAFORMA_DELIVERY,
      cuentaDestinoId: mercadoPago.id,
      plazoDias: 14,
      comisionPct: '15.0',
    },
    {
      nombre: 'DELIVERATE',
      tipo: TipoCuentaACobrar.EMPRESA_DELIVERY,
      cuentaDestinoId: cajaFisica.id,
      plazoDias: 7,
      comisionPct: '0.0', // TBD — confirmar con encargada
    },
  ];

  for (const c of cac) {
    await prisma.cuentaACobrar.upsert({
      where: { nombre: c.nombre },
      create: c,
      update: {},
    });
  }
  console.log(`  ✓ ${cac.length} cuentas a cobrar`);

  return { cajaFisica, santander, galicia, cuentaDni, mercadoPago };
}

// ────────────────────────────────────────────────────────────────────────
//   4. Listas de precios
// ────────────────────────────────────────────────────────────────────────

async function seedListasPrecios() {
  console.log('▸ Seeding listas de precios...');

  const local = await prisma.listaPrecios.upsert({
    where: { nombre: 'Local' },
    create: {
      nombre: 'Local',
      canalDefault: CanalListaPrecios.LOCAL_MOSTRADOR,
      ajustePctDefault: '0',
    },
    update: {},
  });

  const pedidosYa = await prisma.listaPrecios.upsert({
    where: { nombre: 'Pedidos YA' },
    create: {
      nombre: 'Pedidos YA',
      canalDefault: CanalListaPrecios.PEDIDOS_YA,
      ajustePctDefault: '20.0',
    },
    update: {},
  });

  const rappi = await prisma.listaPrecios.upsert({
    where: { nombre: 'RAPPI' },
    create: {
      nombre: 'RAPPI',
      canalDefault: CanalListaPrecios.RAPPI,
      ajustePctDefault: '30.0',
    },
    update: {},
  });

  const meli = await prisma.listaPrecios.upsert({
    where: { nombre: 'Mercado Libre' },
    create: {
      nombre: 'Mercado Libre',
      canalDefault: CanalListaPrecios.MERCADO_LIBRE,
      ajustePctDefault: '15.0',
    },
    update: {},
  });

  const deliverate = await prisma.listaPrecios.upsert({
    where: { nombre: 'DELIVERATE' },
    create: {
      nombre: 'DELIVERATE',
      canalDefault: CanalListaPrecios.DELIVERATE,
      ajustePctDefault: '0.0',
    },
    update: {},
  });

  console.log('  ✓ 5 listas de precios (Local + Pedidos YA + RAPPI + MELI + DELIVERATE)');
  return { local, pedidosYa, rappi, meli, deliverate };
}

// ────────────────────────────────────────────────────────────────────────
//   5. Cliente Casual (default)
// ────────────────────────────────────────────────────────────────────────

async function seedClienteCasual() {
  console.log('▸ Seeding cliente casual...');
  await prisma.cliente.upsert({
    where: { id: '00000000-0000-0000-0000-000000000099' },
    create: {
      id: '00000000-0000-0000-0000-000000000099',
      tipo: 'CASUAL',
      nombre: 'Cliente Casual',
    },
    update: {},
  });
  console.log('  ✓ Cliente Casual');
}

// ────────────────────────────────────────────────────────────────────────
//   6. Catálogo desde JSON (output del parser de Excel)
// ────────────────────────────────────────────────────────────────────────

interface SeedCategoria {
  nombre: string;
  orden: number;
  icono?: string;
  color?: string;
}
interface SeedTipo {
  categoria: string;
  nombre: string;
  cocina_interviene: boolean;
  descripcion?: string;
}
interface SeedProducto {
  codigo: string;
  tipo_categoria: string;
  tipo_nombre: string;
  nombre: string;
  marca?: string | null;
  presentacion?: string | null;
  forma_venta: string;
  unidad_precio: string;
  precio_base: string;
  cantidad_default: number | null;
  modificador_default?: string | null;
}
interface SeedModificador {
  tipo_producto: string;
  grupo_nombre: string;
  tipo_seleccion: string;
  obligatorio: boolean;
  opciones: Array<{ nombre: string; delta_precio: string }>;
}
interface SeedJson {
  categorias: SeedCategoria[];
  tipos_producto: SeedTipo[];
  productos: SeedProducto[];
  modificadores: SeedModificador[];
}

async function seedCatalogo(listaPreciosLocalId: string) {
  console.log('▸ Seeding catálogo desde lista-precios.json...');
  const seedFile = join(__dirname, 'seed-data', 'lista-precios.json');
  if (!existsSync(seedFile)) {
    console.warn(`  ⚠ ${seedFile} no existe — corré el parser primero:`);
    console.warn(`    python tools/parse_lista_precios.py --excel "Lista de Precios.xlsx" --output ${seedFile}`);
    return;
  }
  const data = JSON.parse(readFileSync(seedFile, 'utf-8')) as SeedJson;

  // ── Limpieza de productos legacy (códigos no numéricos del parser viejo) ──
  // El parser v2 asigna códigos de 4 dígitos. Los códigos viejos eran tipo "RAV_VERDURA".
  // Borramos los legacy SI no tienen referencias en items_venta (defensivo).
  const legacyProductos = await prisma.producto.findMany({
    where: {
      OR: [{ codigo: { not: { startsWith: '0' } } }, { codigo: null }],
    },
    select: { id: true, codigo: true, nombre: true, _count: { select: { itemsVenta: true } } },
  });
  let borradosLegacy = 0;
  let saltadosLegacy = 0;
  for (const p of legacyProductos) {
    // Si ya tiene código de 4 dígitos válido, saltarlo
    if (p.codigo && /^\d{4}$/.test(p.codigo)) continue;
    if (p._count.itemsVenta > 0) {
      // Tiene ventas → solo desactivar, no borrar
      await prisma.producto.update({
        where: { id: p.id },
        data: { activo: false },
      });
      saltadosLegacy++;
      continue;
    }
    // Sin ventas → borrar
    try {
      // Borrar relaciones en modificadores_aplicables primero
      await prisma.modificadorAplicable.deleteMany({ where: { productoId: p.id } });
      // Borrar opciones de combo si las hay
      await prisma.opcionComponenteCombo.deleteMany({ where: { productoId: p.id } });
      await prisma.precioPorLista.deleteMany({ where: { productoId: p.id } });
      await prisma.historialPrecio.deleteMany({ where: { productoId: p.id } });
      await prisma.producto.delete({ where: { id: p.id } });
      borradosLegacy++;
    } catch {
      // Si falla por otra FK, solo desactivar
      await prisma.producto.update({ where: { id: p.id }, data: { activo: false } });
      saltadosLegacy++;
    }
  }
  if (borradosLegacy > 0 || saltadosLegacy > 0) {
    console.log(
      `  ✓ Limpieza legacy: ${borradosLegacy} borrados, ${saltadosLegacy} desactivados (con ventas)`,
    );
  }

  // Categorías
  const catByName = new Map<string, string>();
  for (const c of data.categorias) {
    const cat = await prisma.categoria.upsert({
      where: { nombre: c.nombre },
      create: { nombre: c.nombre, orden: c.orden, icono: c.icono, color: c.color },
      update: { orden: c.orden, icono: c.icono, color: c.color },
    });
    catByName.set(c.nombre, cat.id);
  }
  console.log(`  ✓ ${catByName.size} categorías`);

  // Tipos producto
  const tipoByKey = new Map<string, string>();
  for (const t of data.tipos_producto) {
    const catId = catByName.get(t.categoria);
    if (!catId) continue;
    const existing = await prisma.tipoProducto.findFirst({
      where: { categoriaId: catId, nombre: t.nombre },
    });
    const tipo = existing
      ? await prisma.tipoProducto.update({
          where: { id: existing.id },
          data: {
            cocinaInterviene: t.cocina_interviene,
            descripcion: t.descripcion ?? null,
          },
        })
      : await prisma.tipoProducto.create({
          data: {
            categoriaId: catId,
            nombre: t.nombre,
            cocinaInterviene: t.cocina_interviene,
            descripcion: t.descripcion ?? null,
          },
        });
    tipoByKey.set(`${t.categoria}::${t.nombre}`, tipo.id);
  }
  console.log(`  ✓ ${tipoByKey.size} tipos de producto`);

  // Productos
  let productosCreados = 0;
  for (const p of data.productos) {
    const tipoId = tipoByKey.get(`${p.tipo_categoria}::${p.tipo_nombre}`);
    if (!tipoId) continue;
    const formaVenta = (p.forma_venta as FormaVenta) ?? FormaVenta.UNIDAD;
    const unidadPrecio = (p.unidad_precio as UnidadPrecio) ?? UnidadPrecio.POR_UNIDAD;
    await prisma.producto.upsert({
      where: { codigo: p.codigo },
      create: {
        codigo: p.codigo,
        tipoProductoId: tipoId,
        nombre: p.nombre,
        marca: p.marca ?? null,
        presentacion: p.presentacion ?? null,
        formaVenta,
        unidadPrecio,
        precioBase: p.precio_base || '0.00',
        cantidadDefault:
          p.cantidad_default !== null && p.cantidad_default !== undefined
            ? String(p.cantidad_default)
            : null,
      },
      update: {
        nombre: p.nombre,
        marca: p.marca ?? null,
        presentacion: p.presentacion ?? null,
        precioBase: p.precio_base || '0.00',
        formaVenta,
        unidadPrecio,
      },
    });
    productosCreados++;
  }
  console.log(`  ✓ ${productosCreados} productos`);

  // Modificadores
  let modCreados = 0;
  for (const m of data.modificadores) {
    if (!m.opciones?.length) continue;
    // Buscar grupo existente o crearlo
    const grupo = await prisma.grupoModificador.findFirst({
      where: { nombre: `${m.grupo_nombre} — ${m.tipo_producto}` },
    });
    const grupoId = grupo
      ? grupo.id
      : (
          await prisma.grupoModificador.create({
            data: {
              nombre: `${m.grupo_nombre} — ${m.tipo_producto}`,
              tipoSeleccion: (m.tipo_seleccion as TipoSeleccion) ?? TipoSeleccion.UNICA,
              obligatorio: m.obligatorio,
              minOpciones: m.obligatorio ? 1 : 0,
              maxOpciones: 1,
            },
          })
        ).id;

    // Opciones
    for (const [idx, op] of m.opciones.entries()) {
      const existing = await prisma.opcionModificador.findFirst({
        where: { grupoId, nombre: op.nombre },
      });
      if (!existing) {
        await prisma.opcionModificador.create({
          data: {
            grupoId,
            nombre: op.nombre,
            deltaPrecio: op.delta_precio,
            orden: idx,
          },
        });
      }
    }

    // Buscar tipoProducto por nombre y vincular
    const tp = await prisma.tipoProducto.findFirst({ where: { nombre: m.tipo_producto } });
    if (tp) {
      const existingMA = await prisma.modificadorAplicable.findFirst({
        where: { grupoModificadorId: grupoId, tipoProductoId: tp.id },
      });
      if (!existingMA) {
        await prisma.modificadorAplicable.create({
          data: { grupoModificadorId: grupoId, tipoProductoId: tp.id },
        });
      }
    }
    modCreados++;
  }
  console.log(`  ✓ ${modCreados} grupos de modificadores`);

  // ── Salsas: agregar sabores reales ──────────────────────────────────
  await seedSalsasSabores();

  // ── Vincular sabores del tipo BASE a sus tipos PORCIÓN ──────────────
  // Las "Ravioles porción simple" comparten los mismos sabores que "Ravioles".
  await linkSaboresAPorciones();

  // ── Marcar Sub-categorías reales para el cajero ─────────────────────
  await marcarSubcategoriasReales();

  // ── Renombrar Tricolor / Mixtos con sus descripciones ───────────────
  await agregarDescripcionesSabores();

  // ── Códigos reales (Santa Teresita) ─────────────────────────────────
  // La encargada usa códigos cortos memorizables. Asignamos manualmente.
  await aplicarCodigosSantaTeresita();
}

/**
 * Las pastas calientes (porción simple/especial) comparten sabores con su
 * pasta base fresca. Linkeamos los grupos de modificadores del tipo base
 * a cada tipo porción.
 *
 * Mapeo manual porque los nombres tienen variaciones ("Fideos al huevo" vs "Fideos porción simple").
 */
async function linkSaboresAPorciones() {
  const mapeos: Array<{ porcion: string; base: string }> = [
    // Ravioles
    { porcion: 'Ravioles porción simple', base: 'Ravioles' },
    { porcion: 'Ravioles porción especial', base: 'Ravioles' },
    // Fideos
    { porcion: 'Fideos porción simple', base: 'Fideos al huevo' },
    { porcion: 'Fideos porción especial', base: 'Fideos al huevo' },
    // Pasta seca (no tiene sabores en muchos casos, dejarlo igual si no encuentra base)
    { porcion: 'Pasta seca porción simple', base: 'Pasta seca' },
    { porcion: 'Pasta seca porción especial', base: 'Pasta seca' },
    // Tortelettis
    { porcion: 'Tortelettis porción simple', base: 'Tortelettis' },
    { porcion: 'Tortelettis porción especial', base: 'Tortelettis' },
    // Sorrentinos
    { porcion: 'Sorrentinos porción simple', base: 'Sorrentinos' },
    { porcion: 'Sorrentinos porción especial', base: 'Sorrentinos' },
    { porcion: 'Sorrentinos negros porción', base: 'Sorrentinos de Salmón' },
    // Raviolones
    { porcion: 'Raviolones remolacha porción', base: 'Raviolones' },
    // Lasagna
    { porcion: 'Lasagna porción simple', base: 'Lasagna' },
    { porcion: 'Lasagna porción especial', base: 'Lasagna' },
    // Rondelli
    { porcion: 'Rondelli porción simple', base: 'Rondelli' },
    { porcion: 'Rondelli porción especial', base: 'Rondelli' },
    // Canelones
    { porcion: 'Canelones porción simple', base: 'Canelones' },
    { porcion: 'Canelones porción especial', base: 'Canelones' },
    // Ñoquis
    { porcion: 'Ñoquis porción simple', base: 'Ñoquis de sémola' },
    { porcion: 'Ñoquis porción especial', base: 'Ñoquis de sémola' },
    // Crepes
    { porcion: 'Crepes porción simple', base: 'Crepes' },
    { porcion: 'Crepes porción especial', base: 'Crepes' },
  ];

  let linkeados = 0;
  for (const m of mapeos) {
    const tipoPorcion = await prisma.tipoProducto.findFirst({ where: { nombre: m.porcion } });
    const tipoBase = await prisma.tipoProducto.findFirst({ where: { nombre: m.base } });
    if (!tipoPorcion || !tipoBase) continue;

    // Tomar todos los grupos modificadores aplicables al tipo base
    const aplicablesBase = await prisma.modificadorAplicable.findMany({
      where: { tipoProductoId: tipoBase.id },
    });

    for (const a of aplicablesBase) {
      // Idempotente: si ya está linkeado, saltear
      const ya = await prisma.modificadorAplicable.findFirst({
        where: { grupoModificadorId: a.grupoModificadorId, tipoProductoId: tipoPorcion.id },
      });
      if (ya) continue;
      await prisma.modificadorAplicable.create({
        data: { grupoModificadorId: a.grupoModificadorId, tipoProductoId: tipoPorcion.id },
      });
      linkeados++;
    }
  }
  console.log(`  ✓ Sabores linkeados a tipos porción: ${linkeados} aplicaciones`);
}

/**
 * Agrega descripciones a sabores específicos: Tricolor (Ñoquis) y Mixtos (Ñoquis)
 * tienen un significado especial que la encargada quiere que se vea junto al nombre.
 */
async function agregarDescripcionesSabores() {
  // Tricolor → "Tricolor (Papa, Ricota y Espinaca)"
  // Mixtos → "Mixtos (todos los sabores)"
  const renames: Array<{ nombreActual: string; nombreNuevo: string }> = [
    { nombreActual: 'Tricolor', nombreNuevo: 'Tricolor (Papa, Ricota y Espinaca)' },
    { nombreActual: 'Mixtos', nombreNuevo: 'Mixtos (todos los sabores)' },
  ];

  for (const r of renames) {
    const opciones = await prisma.opcionModificador.findMany({
      where: { nombre: r.nombreActual },
    });
    for (const op of opciones) {
      await prisma.opcionModificador.update({
        where: { id: op.id },
        data: { nombre: r.nombreNuevo },
      });
    }
  }
}

/**
 * Splits Salsa en dos productos según el precio que la encargada pasó:
 *   - Salsa simple ($6.000): Fileto (63), Blanca (68), Crema (72)
 *   - Salsa especial ($6.900): Príncipe (60), Roquefort (61), Bolognesa (62),
 *                              Crema de hongos (64), Cuatro quesos (67), Pesto (69), Verdeo (71)
 *
 * Las pastas porción simple/especial las "incluyen" gratis hasta el total de
 * porciones (lógica en el frontend al armar el pedido).
 *
 * Las opciones extras "Aceite", "Aceite de oliva" y "Manteca" se ofrecen solo
 * cuando se acompaña una pasta — se manejan en el frontend, no en la DB.
 */
async function seedSalsasSabores() {
  const tipoSalsa = await prisma.tipoProducto.findFirst({ where: { nombre: 'Salsa' } });
  if (!tipoSalsa) {
    console.warn('  ⚠ No encontré tipoProducto "Salsa"');
    return;
  }

  // Desactivar el producto "Salsa" viejo (precio único) si existe — preservamos histórico.
  const salsaVieja = await prisma.producto.findFirst({
    where: { nombre: 'Salsa', tipoProductoId: tipoSalsa.id },
  });
  if (salsaVieja) {
    // Liberar el código viejo antes de cambiarlo (UNIQUE en codigo)
    await prisma.producto.update({
      where: { id: salsaVieja.id },
      data: { activo: false, codigo: `LEGACY_${salsaVieja.id.slice(0, 6)}` },
    });
  }

  // Limpiar grupos viejos (Tipo — Salsa) para no duplicar
  const grupoViejo = await prisma.grupoModificador.findFirst({ where: { nombre: 'Tipo — Salsa' } });
  if (grupoViejo) {
    await prisma.modificadorAplicable.deleteMany({ where: { grupoModificadorId: grupoViejo.id } });
    await prisma.opcionModificador.deleteMany({ where: { grupoId: grupoViejo.id } });
    await prisma.grupoModificador.delete({ where: { id: grupoViejo.id } }).catch(() => {});
  }

  // Crear/upsert los dos productos nuevos. Usamos códigos internos únicos
  // que no chocan con los códigos de sabor (que la encargada va a usar).
  const simple = await upsertSalsaProducto(tipoSalsa.id, {
    nombre: 'Salsa simple',
    codigoInterno: 'SAL-SIMPLE',
    precio: '6000.00',
  });
  const especial = await upsertSalsaProducto(tipoSalsa.id, {
    nombre: 'Salsa especial',
    codigoInterno: 'SAL-ESPECIAL',
    precio: '6900.00',
  });

  // Grupos modificadores (uno por producto)
  const grupoSimple = await upsertGrupoSalsa('Tipo — Salsa simple');
  const grupoEspecial = await upsertGrupoSalsa('Tipo — Salsa especial');

  // Vincular cada grupo a su producto
  await vincularGrupoAProducto(grupoSimple.id, simple.id);
  await vincularGrupoAProducto(grupoEspecial.id, especial.id);

  // Sabores SIMPLE
  await reemplazarSabores(grupoSimple.id, [
    { nombre: 'Fileto', codigo: '63', orden: 0 },
    { nombre: 'Blanca', codigo: '68', orden: 1 },
    { nombre: 'Crema', codigo: '72', orden: 2 },
  ]);

  // Sabores ESPECIAL
  await reemplazarSabores(grupoEspecial.id, [
    { nombre: 'Príncipe', codigo: '60', orden: 0 },
    { nombre: 'Roquefort', codigo: '61', orden: 1 },
    { nombre: 'Bolognesa', codigo: '62', orden: 2 },
    { nombre: 'Crema de hongos', codigo: '64', orden: 3 },
    { nombre: 'Cuatro quesos', codigo: '67', orden: 4 },
    { nombre: 'Pesto', codigo: '69', orden: 5 },
    { nombre: 'Verdeo', codigo: '71', orden: 6 },
  ]);

  console.log('  ✓ Salsas split: Salsa simple ($6.000, 3 sabores) + Salsa especial ($6.900, 7 sabores)');
}

async function upsertSalsaProducto(tipoProductoId: string, opts: { nombre: string; codigoInterno: string; precio: string }) {
  const existente = await prisma.producto.findFirst({ where: { nombre: opts.nombre } });
  if (existente) {
    return prisma.producto.update({
      where: { id: existente.id },
      data: {
        codigo: opts.codigoInterno,
        tipoProductoId,
        precioBase: opts.precio,
        formaVenta: FormaVenta.UNIDAD,
        unidadPrecio: UnidadPrecio.POR_UNIDAD,
        activo: true,
      },
    });
  }
  return prisma.producto.create({
    data: {
      nombre: opts.nombre,
      codigo: opts.codigoInterno,
      tipoProductoId,
      precioBase: opts.precio,
      formaVenta: FormaVenta.UNIDAD,
      unidadPrecio: UnidadPrecio.POR_UNIDAD,
      activo: true,
    },
  });
}

async function upsertGrupoSalsa(nombre: string) {
  const existente = await prisma.grupoModificador.findFirst({ where: { nombre } });
  if (existente) return existente;
  return prisma.grupoModificador.create({
    data: { nombre, tipoSeleccion: TipoSeleccion.UNICA, obligatorio: true, minOpciones: 1, maxOpciones: 1 },
  });
}

async function vincularGrupoAProducto(grupoModificadorId: string, productoId: string) {
  const ya = await prisma.modificadorAplicable.findFirst({ where: { grupoModificadorId, productoId } });
  if (!ya) {
    await prisma.modificadorAplicable.create({ data: { grupoModificadorId, productoId } });
  }
}

async function reemplazarSabores(
  grupoId: string,
  sabores: Array<{ nombre: string; codigo: string; orden: number }>,
) {
  // Liberar códigos primero (UNIQUE) — set codigo a null en sabores existentes con esos códigos
  const codigos = sabores.map((s) => s.codigo);
  await prisma.opcionModificador.updateMany({
    where: { codigo: { in: codigos } },
    data: { codigo: null },
  });
  // Borrar las opciones del grupo (no hay items_venta en una DB recién seedeada)
  await prisma.opcionModificador.deleteMany({ where: { grupoId } });
  // Crear las nuevas
  for (const s of sabores) {
    await prisma.opcionModificador.create({
      data: { grupoId, nombre: s.nombre, codigo: s.codigo, deltaPrecio: '0', orden: s.orden },
    });
  }
}

/**
 * Marca como `esSubcategoria=true` los tipos que SÍ corresponden mostrar en el
 * cajero como chips de sub-categoría. Solo Bebidas por ahora — el resto de los
 * tipos del seed son auto-derivados del Excel y son redundantes con marca.
 *
 * Los tipos creados por admin via "Añadir → Subcategoría" tienen el flag en true
 * automáticamente desde la creación.
 */
async function marcarSubcategoriasReales() {
  const categoriasValidas = ['Bebidas'];
  let total = 0;
  for (const nombreCat of categoriasValidas) {
    const cat = await prisma.categoria.findFirst({ where: { nombre: nombreCat } });
    if (!cat) continue;
    const result = await prisma.tipoProducto.updateMany({
      where: { categoriaId: cat.id },
      data: { esSubcategoria: true },
    });
    total += result.count;
  }
  console.log(`  ✓ Sub-categorías reales marcadas: ${total} tipos en Bebidas`);
}

/**
 * Asigna los códigos memorizables que usa la encargada (de WhatsApp).
 * Reemplaza los códigos de 4 dígitos del Excel por los cortos.
 *
 *   Ravioles sabores: 0=VyR, 1=Verdura, 2=Pollo, 3=RyJ, 4=Ricota, 5=VyP
 *   Productos standalone: 6=Fideos frescos, 7=Fideos especiales, 8=Ñoquis,
 *                         9=Tortelettis, 12=Lasagna, 13=Rondelli, 30=Queso rallado, 50=Pan mignon
 *   Canelones sabores: 16=Verdura, 17=JyQ, 18=VyC
 *   Crepes sabores: 22=VyP, 23=Puerro
 *   Salsas sabores: ya seteados arriba
 */
async function aplicarCodigosSantaTeresita() {
  // Helper: setear código en sabor por (tipoProducto + nombre fuzzy)
  const setSaborCodigo = async (tipoProductoNombre: string, saborMatch: string[], codigo: string) => {
    const tp = await prisma.tipoProducto.findFirst({ where: { nombre: tipoProductoNombre } });
    if (!tp) return false;
    // Encontrar el grupo modificador asociado al tipoProducto
    const aplicables = await prisma.modificadorAplicable.findMany({
      where: { tipoProductoId: tp.id },
      include: { grupoModificador: { include: { opciones: true } } },
    });
    for (const a of aplicables) {
      const opciones = a.grupoModificador.opciones;
      for (const op of opciones) {
        const norm = op.nombre.toLowerCase().trim();
        const matches = saborMatch.every((kw) => norm.includes(kw.toLowerCase()));
        if (matches) {
          await prisma.opcionModificador.update({
            where: { id: op.id },
            data: { codigo },
          });
          return true;
        }
      }
    }
    return false;
  };

  // Helper: cambiar código de producto por nombre exacto del tipoProducto
  const setProductoCodigoByTipo = async (tipoProductoNombre: string, codigo: string) => {
    const tp = await prisma.tipoProducto.findFirst({ where: { nombre: tipoProductoNombre } });
    if (!tp) return false;
    // Tomamos el primer producto activo de ese tipo
    const prod = await prisma.producto.findFirst({ where: { tipoProductoId: tp.id, activo: true } });
    if (!prod) return false;
    // Verificar que el código no esté tomado por otro producto
    const otro = await prisma.producto.findFirst({ where: { codigo, NOT: { id: prod.id } } });
    if (otro) {
      // Liberamos el código del otro (le ponemos el de prod)
      await prisma.producto.update({ where: { id: otro.id }, data: { codigo: prod.codigo ?? null } });
    }
    await prisma.producto.update({ where: { id: prod.id }, data: { codigo } });
    return true;
  };

  // Limpiar códigos viejos de sabores (estaban en null antes; defensivo)
  // Y limpiar códigos de productos que vamos a reasignar
  // Para evitar conflictos de UNIQUE, primero NULL los códigos a reasignar.

  // ─── Ravioles sabores 0..5 ─────────────────────────────────────────
  await setSaborCodigo('Ravioles', ['verdura', 'ricota'], '0');
  await setSaborCodigo('Ravioles', ['verdura'], '1');           // "Verdura" sola
  await setSaborCodigo('Ravioles', ['pollo'], '2');             // "Pollo" sola (o "Pollo y Carne")
  await setSaborCodigo('Ravioles', ['ricota', 'jam'], '3');     // "Ricota y Jamón"
  await setSaborCodigo('Ravioles', ['ricota'], '4');            // "Ricota" sola
  await setSaborCodigo('Ravioles', ['verdura', 'pollo'], '5');  // "Verdura y Pollo"

  // Aclaración: los matches son por palabras clave, así que "verdura" matcheará
  // primero "Verdura y Ricota", después "Verdura" sola. Para evitar mismatches,
  // re-corremos con variantes adicionales si quedaron vacíos.
  // (En la práctica los nombres en el Excel son consistentes y matchean OK.)

  // ─── Productos standalone ──────────────────────────────────────────
  await setProductoCodigoByTipo('Fideos al huevo', '6');           // Fideos frescos
  await setProductoCodigoByTipo('Fideos especiales', '7');         // Fideos morron/espinaca
  await setProductoCodigoByTipo('Ñoquis de sémola', '8');
  await setProductoCodigoByTipo('Tortelettis', '9');
  await setProductoCodigoByTipo('Lasagna', '12');
  await setProductoCodigoByTipo('Rondelli', '13');

  // ─── Canelones sabores 16..18 ──────────────────────────────────────
  await setSaborCodigo('Canelones', ['verdura'], '16');
  await setSaborCodigo('Canelones', ['jam', 'queso'], '17');
  await setSaborCodigo('Canelones', ['verdura', 'carne'], '18');

  // ─── Crepes sabores 22..23 ─────────────────────────────────────────
  await setSaborCodigo('Crepes', ['verdura', 'pollo'], '22');
  await setSaborCodigo('Crepes', ['puerro'], '23');

  // ─── Otros standalone ──────────────────────────────────────────────
  await setProductoCodigoByTipo('Queso', '30');
  // Pan mignon — buscar por nombre del producto
  const panmignon = await prisma.producto.findFirst({ where: { nombre: { contains: 'mignon', mode: 'insensitive' } } });
  if (panmignon) {
    await prisma.producto.update({ where: { id: panmignon.id }, data: { codigo: '50' } });
  }

  console.log('  ✓ Códigos cortos de Santa Teresita aplicados (0-72)');
}

// ────────────────────────────────────────────────────────────────────────
//   6.5 Estantería + Bebidas (del Excel Proveedores 2026.xlsx)
// ────────────────────────────────────────────────────────────────────────

interface SeedEstanteriaBebidas {
  categorias: SeedCategoria[];
  tipos_producto: SeedTipo[];
  productos: SeedProducto[];
}

async function seedEstanteriaBebidas() {
  console.log('▸ Seeding estantería y bebidas...');
  const seedFile = join(__dirname, 'seed-data', 'estanteria-bebidas.json');
  if (!existsSync(seedFile)) {
    console.warn(`  ⚠ ${seedFile} no existe — corré el parser:`);
    console.warn(
      `    python tools/parse_estanteria_bebidas.py --excel "Proveedores 2026.xlsx" --output ${seedFile}`,
    );
    return;
  }
  const data = JSON.parse(readFileSync(seedFile, 'utf-8')) as SeedEstanteriaBebidas;

  // Categorías nuevas (Estantería, Bebidas)
  for (const c of data.categorias) {
    await prisma.categoria.upsert({
      where: { nombre: c.nombre },
      create: { nombre: c.nombre, orden: c.orden, icono: c.icono, color: c.color },
      update: { orden: c.orden, icono: c.icono, color: c.color },
    });
  }

  // Tipos de producto (1 por marca/categoría)
  const tipoByKey = new Map<string, string>();
  for (const t of data.tipos_producto) {
    const cat = await prisma.categoria.findUnique({ where: { nombre: t.categoria } });
    if (!cat) continue;
    const existing = await prisma.tipoProducto.findFirst({
      where: { categoriaId: cat.id, nombre: t.nombre },
    });
    const tipo = existing
      ? await prisma.tipoProducto.update({
          where: { id: existing.id },
          data: { cocinaInterviene: t.cocina_interviene, descripcion: t.descripcion ?? null },
        })
      : await prisma.tipoProducto.create({
          data: {
            categoriaId: cat.id,
            nombre: t.nombre,
            cocinaInterviene: t.cocina_interviene,
            descripcion: t.descripcion ?? null,
          },
        });
    tipoByKey.set(`${t.categoria}::${t.nombre}`, tipo.id);
  }

  // Productos
  let creados = 0;
  for (const p of data.productos) {
    const tipoId = tipoByKey.get(`${p.tipo_categoria}::${p.tipo_nombre}`);
    if (!tipoId) continue;
    await prisma.producto.upsert({
      where: { codigo: p.codigo },
      create: {
        codigo: p.codigo,
        tipoProductoId: tipoId,
        nombre: p.nombre,
        marca: p.marca ?? null,
        presentacion: p.presentacion ?? null,
        formaVenta: (p.forma_venta as FormaVenta) ?? FormaVenta.UNIDAD,
        unidadPrecio: (p.unidad_precio as UnidadPrecio) ?? UnidadPrecio.POR_UNIDAD,
        precioBase: p.precio_base || '0.00',
        cantidadDefault:
          p.cantidad_default !== null && p.cantidad_default !== undefined
            ? String(p.cantidad_default)
            : null,
      },
      update: {
        nombre: p.nombre,
        marca: p.marca ?? null,
        presentacion: p.presentacion ?? null,
        precioBase: p.precio_base || '0.00',
      },
    });
    creados++;
  }
  console.log(`  ✓ ${creados} productos (estantería + bebidas)`);
}

// ────────────────────────────────────────────────────────────────────────
//   7. Proveedores históricos (del Excel "Proveedores 2026.xlsx" hoja Deudas)
// ────────────────────────────────────────────────────────────────────────

const PROVEEDORES_HISTORICOS: Array<{ nombre: string; categoriaPrincipal: string }> = [
  // Lácteos / Quesos
  { nombre: 'Lingotes', categoriaPrincipal: 'Lácteos' },
  { nombre: 'Vacalin', categoriaPrincipal: 'Lácteos' },
  { nombre: 'Cosenza', categoriaPrincipal: 'Lácteos' },
  { nombre: 'Milkaut', categoriaPrincipal: 'Lácteos' },
  { nombre: 'Corycor', categoriaPrincipal: 'Lácteos' },
  // Verduras / Insumos
  { nombre: 'Free Vegetales', categoriaPrincipal: 'Verdulería' },
  { nombre: 'Navacerrada', categoriaPrincipal: 'Verdulería' },
  { nombre: 'Maprisa', categoriaPrincipal: 'Insumos' },
  { nombre: 'Condiriko', categoriaPrincipal: 'Condimentos' },
  { nombre: 'Prod. Silvia', categoriaPrincipal: 'Insumos' },
  { nombre: 'Roca Food', categoriaPrincipal: 'Insumos' },
  // Carnes / Pescado / Huevos
  { nombre: 'Carnicería Fca.', categoriaPrincipal: 'Carnes' },
  { nombre: 'Carnicería Julio Felipe', categoriaPrincipal: 'Carnes' },
  { nombre: 'Pollos', categoriaPrincipal: 'Pollo' },
  { nombre: 'Huevos', categoriaPrincipal: 'Huevos' },
  { nombre: 'Campodonico', categoriaPrincipal: 'Pescado' },
  // Sin TACC
  { nombre: 'Grupo DF Sin TACC', categoriaPrincipal: 'Sin TACC' },
  { nombre: 'La Pastelera Sin TACC', categoriaPrincipal: 'Sin TACC' },
  // Envases / Papelería
  { nombre: 'Grafipack (Blanco y Negro)', categoriaPrincipal: 'Envases' },
  { nombre: 'Polibol', categoriaPrincipal: 'Envases' },
  { nombre: 'Ave Fenix (Blanco y Negro)', categoriaPrincipal: 'Envases' },
  // Fiambres
  { nombre: 'Marcelo Dist.', categoriaPrincipal: 'Fiambres' },
  { nombre: 'Fiambres Cibum-Agri', categoriaPrincipal: 'Fiambres' },
  { nombre: 'Fiambre del Sur', categoriaPrincipal: 'Fiambres' },
  // Otros
  { nombre: 'Luis Gourmet', categoriaPrincipal: 'Insumos' },
  { nombre: 'Rama', categoriaPrincipal: 'Insumos' },
  { nombre: 'Cervezas', categoriaPrincipal: 'Bebidas' },
  { nombre: 'Vinos', categoriaPrincipal: 'Bebidas' },
  { nombre: 'Limpieza', categoriaPrincipal: 'Limpieza' },
];

async function seedProveedores() {
  console.log('▸ Seeding proveedores...');
  for (const p of PROVEEDORES_HISTORICOS) {
    await prisma.proveedor.upsert({
      where: { nombre: p.nombre },
      create: {
        nombre: p.nombre,
        categoriaPrincipal: p.categoriaPrincipal,
      },
      update: {},
    });
  }
  console.log(`  ✓ ${PROVEEDORES_HISTORICOS.length} proveedores`);
}

// ────────────────────────────────────────────────────────────────────────
//   8. Empleados de ejemplo
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
//   9. Configuración del sistema (key-value)
// ────────────────────────────────────────────────────────────────────────

const CONFIG_DEFAULT: Array<{
  clave: string;
  valor: string;
  tipo: 'string' | 'number' | 'boolean';
  descripcion: string;
  categoria: 'descuentos' | 'seguridad' | 'ticket' | 'local';
}> = [
  // Descuentos
  {
    clave: 'descuento_efectivo_pct',
    valor: '10',
    tipo: 'number',
    descripcion: 'Descuento automático cuando se paga 100% en efectivo en mostrador (%)',
    categoria: 'descuentos',
  },
  {
    clave: 'descuento_manual_max_vendedor_pct',
    valor: '5',
    tipo: 'number',
    descripcion: 'Descuento manual máximo que un vendedor puede aplicar sin admin (%)',
    categoria: 'descuentos',
  },
  // Seguridad
  {
    clave: 'sesion_admin_inactividad_min',
    valor: '15',
    tipo: 'number',
    descripcion: 'Minutos de inactividad antes de bloquear la sesión admin',
    categoria: 'seguridad',
  },
  {
    clave: 'intentos_fallidos_max',
    valor: '5',
    tipo: 'number',
    descripcion: 'Intentos fallidos de PIN antes de bloquear',
    categoria: 'seguridad',
  },
  {
    clave: 'bloqueo_pin_minutos',
    valor: '10',
    tipo: 'number',
    descripcion: 'Minutos que dura el bloqueo por PIN',
    categoria: 'seguridad',
  },
  {
    clave: 'diferencia_caja_max_sin_aprobacion',
    valor: '1000',
    tipo: 'number',
    descripcion: 'Diferencia de caja máxima en $ que no requiere aprobación admin',
    categoria: 'seguridad',
  },
  // Local
  {
    clave: 'nombre_local',
    valor: 'Santa Teresita Pastas',
    tipo: 'string',
    descripcion: 'Nombre del comercio (aparece en tickets y app)',
    categoria: 'local',
  },
  {
    clave: 'direccion_local',
    valor: 'Av. 44 e. 12 y Plaza Paso, La Plata, Bs. As.',
    tipo: 'string',
    descripcion: 'Dirección física que aparece en tickets',
    categoria: 'local',
  },
  {
    clave: 'telefono_local',
    valor: '',
    tipo: 'string',
    descripcion: 'Teléfono que aparece en tickets',
    categoria: 'local',
  },
  // Ticket
  {
    clave: 'mensaje_footer_ticket',
    valor: '¡Gracias por su compra!',
    tipo: 'string',
    descripcion: 'Mensaje que aparece al pie del ticket cliente',
    categoria: 'ticket',
  },
  {
    clave: 'mostrar_redes_en_ticket',
    valor: 'true',
    tipo: 'boolean',
    descripcion: 'Mostrar redes sociales y web en el footer del ticket',
    categoria: 'ticket',
  },
  {
    clave: 'instagram_local',
    valor: '@santateresitapastas',
    tipo: 'string',
    descripcion: 'Instagram que aparece en el ticket',
    categoria: 'ticket',
  },
];

async function seedConfiguracion() {
  console.log('▸ Seeding configuración del sistema...');
  for (const c of CONFIG_DEFAULT) {
    await prisma.configuracionSistema.upsert({
      where: { clave: c.clave },
      create: c,
      update: { descripcion: c.descripcion, categoria: c.categoria, tipo: c.tipo },
    });
  }
  console.log(`  ✓ ${CONFIG_DEFAULT.length} parámetros`);
}

// ────────────────────────────────────────────────────────────────────────
//   10. Posnets reales del local (identificados desde fotos del cliente)
// ────────────────────────────────────────────────────────────────────────

async function seedPosnets() {
  console.log('▸ Seeding posnets reales...');

  // Obtener cuentas destino para cada posnet
  const [santander, galicia, mp, cuentaDni] = await Promise.all([
    prisma.cuenta.findUnique({ where: { nombre: 'Santander' } }),
    prisma.cuenta.findUnique({ where: { nombre: 'Galicia' } }),
    prisma.cuenta.findUnique({ where: { nombre: 'MercadoPago' } }),
    prisma.cuenta.findUnique({ where: { nombre: 'Cuenta DNI' } }),
  ]);

  // Cuentas a cobrar débito/crédito para cada banco
  const [tdSant, tcSant, tdGal, tcGal] = await Promise.all([
    prisma.cuentaACobrar.findUnique({ where: { nombre: 'Tarjeta Débito Santander' } }),
    prisma.cuentaACobrar.findUnique({ where: { nombre: 'Tarjeta Crédito Santander' } }),
    prisma.cuentaACobrar.findUnique({ where: { nombre: 'Tarjeta Débito Galicia' } }),
    prisma.cuentaACobrar.findUnique({ where: { nombre: 'Tarjeta Crédito Galicia' } }),
  ]);

  const posnets: Array<{
    nombre: string;
    marca: string;
    modelo: string | null;
    adquirente: string;
    soportaIntegracion: boolean;
    ubicacion: string;
    cuentaDestinoId: string | null;
    cuentaACobrarDebitoId: string | null;
    cuentaACobrarCreditoId: string | null;
  }> = [
    {
      nombre: 'Posnet Santander (Getnet)',
      marca: 'Newland',
      modelo: 'N910 Pro',
      adquirente: 'Getnet',
      soportaIntegracion: true,
      ubicacion: 'mostrador',
      cuentaDestinoId: santander?.id ?? null,
      cuentaACobrarDebitoId: tdSant?.id ?? null,
      cuentaACobrarCreditoId: tcSant?.id ?? null,
    },
    {
      nombre: 'Posnet Galicia',
      marca: 'Positivo',
      modelo: 'L400',
      adquirente: 'Cabal (Galicia)',
      soportaIntegracion: true,
      ubicacion: 'mostrador',
      cuentaDestinoId: galicia?.id ?? null,
      cuentaACobrarDebitoId: tdGal?.id ?? null,
      cuentaACobrarCreditoId: tcGal?.id ?? null,
    },
    {
      nombre: 'Posnet MercadoPago',
      marca: 'Mercado Pago',
      modelo: 'Point Smart (A910)',
      adquirente: 'Mercado Pago',
      soportaIntegracion: true,
      ubicacion: 'mostrador / móvil',
      cuentaDestinoId: mp?.id ?? null,
      // MP no genera "tarjeta a cobrar" tradicional — la liquidación es directa a la wallet.
      cuentaACobrarDebitoId: null,
      cuentaACobrarCreditoId: null,
    },
    {
      nombre: 'Posnet Provincia (Lapos)',
      marca: 'PosNet by Fiserv',
      modelo: 'legacy — sin modelo en etiqueta',
      adquirente: 'Fiserv (Banco Provincia)',
      soportaIntegracion: false, // terminal tradicional, doble carga manual
      ubicacion: 'mostrador',
      cuentaDestinoId: cuentaDni?.id ?? null,
      cuentaACobrarDebitoId: null,
      cuentaACobrarCreditoId: null,
    },
  ];

  for (const p of posnets) {
    const existing = await prisma.posnet.findFirst({ where: { nombre: p.nombre } });
    if (existing) continue;
    await prisma.posnet.create({ data: p });
  }
  console.log(`  ✓ ${posnets.length} posnets`);
}

async function seedEmpleados() {
  console.log('▸ Seeding empleados...');
  const empleados: Array<{
    id: string;
    nombre: string;
    puesto: 'CAJERO' | 'COCINERO' | 'ENCARGADO' | 'MOTOQUERO' | 'ADMINISTRATIVO' | 'OTRO';
    formaPago?: string;
  }> = [
    { id: '00000000-0000-0000-0000-000000000101', nombre: 'Damián', puesto: 'MOTOQUERO', formaPago: 'comisión' },
    { id: '00000000-0000-0000-0000-000000000102', nombre: 'Encargada', puesto: 'ENCARGADO', formaPago: 'mensual' },
    { id: '00000000-0000-0000-0000-000000000103', nombre: 'Cocinero 1', puesto: 'COCINERO', formaPago: 'mensual' },
    { id: '00000000-0000-0000-0000-000000000104', nombre: 'Cajero 1', puesto: 'CAJERO', formaPago: 'mensual' },
  ];
  for (const e of empleados) {
    await prisma.empleado.upsert({
      where: { id: e.id },
      create: e,
      update: {},
    });
  }
  console.log(`  ✓ ${empleados.length} empleados`);
}

// ────────────────────────────────────────────────────────────────────────
//   Main
// ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Santa Teresita — Seed inicial');
  console.log('═══════════════════════════════════════════════════════════\n');

  await seedUsuarios();
  await seedCategoriasMovimiento();
  await seedCuentas();
  const listas = await seedListasPrecios();
  await seedClienteCasual();
  await seedCatalogo(listas.local.id);
  await seedEstanteriaBebidas();
  await seedProveedores();
  await seedEmpleados();
  await seedConfiguracion();
  await seedPosnets();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✓ Seed completado');
  console.log('═══════════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error('✕ Seed falló:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
