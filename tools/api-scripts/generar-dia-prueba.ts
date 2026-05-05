/**
 * Generador de día de prueba.
 *
 * Crea 2 sesiones de caja (MAÑANA + TARDE) con:
 *   - Ventas finalizadas variadas (canales, modalidades, métodos de pago)
 *   - Algunas anuladas
 *   - Movimientos del turno (ingresos + egresos diversos)
 *   - Cierre con conteo físico (con un poco de variación)
 *
 * Uso:
 *   pnpm --filter @sta/api exec tsx src/scripts/generar-dia-prueba.ts [--fecha YYYY-MM-DD]
 *   pnpm --filter @sta/api exec tsx src/scripts/generar-dia-prueba.ts --limpiar
 *
 * Sin --fecha usa "ayer" para no chocar con la sesión actual.
 */

import { prisma } from '@sta/db/client';
import {
  CanalVenta,
  EstadoSesionCaja,
  EstadoVenta,
  EstadoMovimiento,
  EstadoPago,
  FormaVenta,
  MetodoPago,
  ModalidadVenta,
  TurnoCaja,
  TipoMovimiento,
} from '@sta/db';

// ────────────────────────────────────────────────────────────────────────
//   Helpers de aleatoriedad
// ────────────────────────────────────────────────────────────────────────

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}
function chance(pct: number): boolean {
  return Math.random() * 100 < pct;
}

// Distribución de canales (peso → frecuencia relativa) — diversificado para
// que se vea volumen en todos los buckets del nuevo dashboard.
const CANALES: Array<{ canal: CanalVenta; modalidad: ModalidadVenta; peso: number }> = [
  { canal: CanalVenta.MOSTRADOR, modalidad: ModalidadVenta.TAKE_AWAY, peso: 45 },
  { canal: CanalVenta.TELEFONO, modalidad: ModalidadVenta.DELIVERY_PROPIO, peso: 12 },
  { canal: CanalVenta.WHATSAPP, modalidad: ModalidadVenta.DELIVERY_PROPIO, peso: 12 },
  { canal: CanalVenta.WEB, modalidad: ModalidadVenta.DELIVERY_PROPIO, peso: 6 },
  { canal: CanalVenta.PEDIDOS_YA, modalidad: ModalidadVenta.DELIVERY_PLATAFORMA, peso: 8 },
  { canal: CanalVenta.RAPPI, modalidad: ModalidadVenta.DELIVERY_PLATAFORMA, peso: 6 },
  { canal: CanalVenta.MERCADO_LIBRE, modalidad: ModalidadVenta.DELIVERY_PLATAFORMA, peso: 3 },
  { canal: CanalVenta.DELIVERATE, modalidad: ModalidadVenta.DELIVERY_DELIVERATE, peso: 8 },
];

function pickCanal() {
  const total = CANALES.reduce((acc, c) => acc + c.peso, 0);
  let r = Math.random() * total;
  for (const c of CANALES) {
    if (r < c.peso) return { canal: c.canal, modalidad: c.modalidad };
    r -= c.peso;
  }
  return { canal: CanalVenta.MOSTRADOR, modalidad: ModalidadVenta.TAKE_AWAY };
}

// Distribución de métodos de pago (sólo cuando NO es plataforma)
const METODOS_MOSTRADOR: Array<{ metodo: MetodoPago; peso: number }> = [
  { metodo: MetodoPago.EFECTIVO, peso: 40 },
  { metodo: MetodoPago.DEBITO, peso: 22 },
  { metodo: MetodoPago.CREDITO_1_PAGO, peso: 18 },
  { metodo: MetodoPago.MERCADOPAGO_QR, peso: 15 },
  { metodo: MetodoPago.TRANSFERENCIA, peso: 5 },
];

function pickMetodoPago(): MetodoPago {
  const total = METODOS_MOSTRADOR.reduce((acc, c) => acc + c.peso, 0);
  let r = Math.random() * total;
  for (const m of METODOS_MOSTRADOR) {
    if (r < m.peso) return m.metodo;
    r -= m.peso;
  }
  return MetodoPago.EFECTIVO;
}

// ────────────────────────────────────────────────────────────────────────
//   Main
// ────────────────────────────────────────────────────────────────────────

interface ContextoDia {
  fecha: Date;
  vendedor: { id: string; nombre: string };
  admin: { id: string; nombre: string };
  productos: Array<{
    id: string;
    nombre: string;
    precioBase: number;
    formaVenta: FormaVenta;
    cantidadDefault: number;
    cocinaInterviene: boolean;
  }>;
  cuentas: {
    cajaFisica: { id: string; nombre: string };
    santander: { id: string; nombre: string };
    galicia: { id: string; nombre: string };
    mercadopago: { id: string; nombre: string };
  };
  categorias: Map<string, string>; // nombre → id
  listaPreciosId: string;
}

async function cargarContexto(fecha: Date): Promise<ContextoDia> {
  const vendedor = await prisma.usuario.findFirst({
    where: { rol: 'VENDEDOR', activo: true },
  });
  if (!vendedor) throw new Error('Falta seed de vendedor (PIN 0001)');
  const admin = await prisma.usuario.findFirst({
    where: { rol: 'ADMIN', activo: true },
  });
  if (!admin) throw new Error('Falta seed de admin');

  const productosRaw = await prisma.producto.findMany({
    where: { activo: true },
    include: { tipoProducto: true },
    take: 200,
  });
  const productos = productosRaw.map((p) => ({
    id: p.id,
    nombre: p.nombre,
    precioBase: Number(p.precioBase),
    formaVenta: p.formaVenta,
    cantidadDefault: p.cantidadDefault ? Number(p.cantidadDefault) : 1,
    cocinaInterviene: p.tipoProducto.cocinaInterviene,
  }));
  if (productos.length < 5) {
    throw new Error('Faltan productos. Corré pnpm db:seed antes.');
  }

  const cuentasRaw = await prisma.cuenta.findMany({ where: { activa: true } });
  const buscarCuenta = (nombre: string) => {
    const c = cuentasRaw.find((x) => x.nombre.toLowerCase().includes(nombre.toLowerCase()));
    if (!c) throw new Error(`Falta cuenta "${nombre}" en seed`);
    return { id: c.id, nombre: c.nombre };
  };

  const cuentas = {
    cajaFisica: buscarCuenta('caja'),
    santander: buscarCuenta('santander'),
    galicia: buscarCuenta('galicia'),
    mercadopago: buscarCuenta('mercadopago'),
  };

  const cats = await prisma.categoriaMovimiento.findMany();
  const categorias = new Map(cats.map((c) => [c.nombre, c.id]));

  const lista = await prisma.listaPrecios.findFirst({
    where: { activa: true },
    orderBy: { nombre: 'asc' },
  });
  if (!lista) throw new Error('Falta lista de precios. Corré pnpm db:seed.');

  return {
    fecha,
    vendedor: { id: vendedor.id, nombre: vendedor.nombre },
    admin: { id: admin.id, nombre: admin.nombre },
    productos,
    cuentas,
    categorias,
    listaPreciosId: lista.id,
  };
}

function cuentaPorMetodo(ctx: ContextoDia, metodo: MetodoPago): { id: string; nombre: string } {
  switch (metodo) {
    case MetodoPago.EFECTIVO:
      return ctx.cuentas.cajaFisica;
    case MetodoPago.MERCADOPAGO_QR:
      return ctx.cuentas.mercadopago;
    case MetodoPago.DEBITO:
    case MetodoPago.CREDITO_1_PAGO:
    case MetodoPago.CREDITO_CUOTAS:
    case MetodoPago.TARJETA_NARANJA:
      return chance(50) ? ctx.cuentas.santander : ctx.cuentas.galicia;
    case MetodoPago.TRANSFERENCIA:
      return chance(50) ? ctx.cuentas.santander : ctx.cuentas.galicia;
    default:
      return ctx.cuentas.cajaFisica;
  }
}

interface VentaInput {
  hora: Date;
  numeroOrdenTurno: number;
  canal: CanalVenta;
  modalidad: ModalidadVenta;
  items: Array<{
    productoId: string;
    nombreSnapshot: string;
    cantidad: number;
    unidad: FormaVenta;
    precioUnitario: number;
    cocinaInterviene: boolean;
  }>;
  pagos: Array<{
    metodo: MetodoPago;
    monto: number;
    cuentaId: string;
  }>;
  subtotal: number;
  descuento: number;
  total: number;
  anulada: boolean;
}

function generarVenta(
  ctx: ContextoDia,
  hora: Date,
  numeroOrden: number,
): VentaInput {
  const { canal, modalidad } = pickCanal();
  const cantItems = randInt(1, 4);
  const itemsPicked = Array.from({ length: cantItems }, () => rand(ctx.productos));
  const items = itemsPicked.map((p) => ({
    productoId: p.id,
    nombreSnapshot: p.nombre,
    cantidad: p.cantidadDefault,
    unidad: p.formaVenta,
    precioUnitario: p.precioBase,
    cocinaInterviene: p.cocinaInterviene,
  }));
  const subtotal = items.reduce((acc, i) => acc + i.cantidad * i.precioUnitario, 0);

  // Determinar pagos
  const esApp =
    canal === CanalVenta.PEDIDOS_YA ||
    canal === CanalVenta.RAPPI ||
    canal === CanalVenta.MERCADO_LIBRE;
  const esDeliverate = canal === CanalVenta.DELIVERATE;
  const esDeliveryLocal =
    canal === CanalVenta.TELEFONO ||
    canal === CanalVenta.WHATSAPP ||
    canal === CanalVenta.WEB;

  let descuento = 0;
  let total = subtotal;
  const pagos: VentaInput['pagos'] = [];

  if (esDeliverate) {
    // DELIVERATE siempre cobra al cliente en efectivo y rinde semanal.
    pagos.push({
      metodo: MetodoPago.EFECTIVO,
      monto: total,
      cuentaId: cuentaPorMetodo(ctx, MetodoPago.EFECTIVO).id,
    });
  } else if (esApp) {
    // Plataformas: ~30% efectivo (PYA principalmente), 70% cobrado por la app.
    if (canal === CanalVenta.PEDIDOS_YA && chance(40)) {
      pagos.push({
        metodo: MetodoPago.EFECTIVO,
        monto: total,
        cuentaId: cuentaPorMetodo(ctx, MetodoPago.EFECTIVO).id,
      });
    } else {
      const metodo = chance(60) ? MetodoPago.MERCADOPAGO_QR : MetodoPago.TRANSFERENCIA;
      pagos.push({
        metodo,
        monto: total,
        cuentaId: cuentaPorMetodo(ctx, metodo).id,
      });
    }
  } else if (esDeliveryLocal) {
    // Damián / pedido WSP / web: ~55% efectivo (cuando llega Damián), 45% online (transfer/MP/débito).
    if (chance(55)) {
      pagos.push({
        metodo: MetodoPago.EFECTIVO,
        monto: total,
        cuentaId: cuentaPorMetodo(ctx, MetodoPago.EFECTIVO).id,
      });
    } else {
      const metodo = chance(50)
        ? MetodoPago.TRANSFERENCIA
        : chance(50)
          ? MetodoPago.MERCADOPAGO_QR
          : MetodoPago.DEBITO;
      pagos.push({
        metodo,
        monto: total,
        cuentaId: cuentaPorMetodo(ctx, metodo).id,
      });
    }
  } else if (chance(15)) {
    // Pago dividido (cuenta partida)
    const metodo1 = MetodoPago.EFECTIVO;
    const metodo2 = chance(50) ? MetodoPago.DEBITO : MetodoPago.MERCADOPAGO_QR;
    const efectivoBruto = Math.round(subtotal * randFloat(0.3, 0.6));
    const efectivoNeto = Math.round(efectivoBruto * 0.9); // aplica 10% off al efectivo
    descuento = efectivoBruto - efectivoNeto;
    total = subtotal - descuento;
    const restante = Math.round((total - efectivoNeto) * 100) / 100;
    pagos.push({ metodo: metodo1, monto: efectivoNeto, cuentaId: cuentaPorMetodo(ctx, metodo1).id });
    pagos.push({ metodo: metodo2, monto: restante, cuentaId: cuentaPorMetodo(ctx, metodo2).id });
  } else {
    const metodo = pickMetodoPago();
    if (metodo === MetodoPago.EFECTIVO && canal === CanalVenta.MOSTRADOR) {
      // 10% off automático
      descuento = Math.round(subtotal * 0.1 * 100) / 100;
      total = subtotal - descuento;
    }
    pagos.push({
      metodo,
      monto: total,
      cuentaId: cuentaPorMetodo(ctx, metodo).id,
    });
  }

  // 3% chance de anulación
  const anulada = chance(3);

  return {
    hora,
    numeroOrdenTurno: numeroOrden,
    canal,
    modalidad,
    items,
    pagos,
    subtotal: Math.round(subtotal * 100) / 100,
    descuento: Math.round(descuento * 100) / 100,
    total: Math.round(total * 100) / 100,
    anulada,
  };
}

async function crearSesion(
  ctx: ContextoDia,
  turno: TurnoCaja,
  cantVentas: number,
  existenciaInicial: number,
): Promise<{ sesionId: string; ventasInsertadas: number }> {
  const apertura = new Date(ctx.fecha);
  if (turno === TurnoCaja.MANANA) apertura.setHours(9, 0, 0, 0);
  else apertura.setHours(14, 30, 0, 0);

  const cierre = new Date(ctx.fecha);
  if (turno === TurnoCaja.MANANA) cierre.setHours(14, 30, 0, 0);
  else cierre.setHours(22, 0, 0, 0);

  // Generar ventas distribuidas a lo largo del turno
  const ventas: VentaInput[] = [];
  const duracionMs = cierre.getTime() - apertura.getTime();
  for (let i = 0; i < cantVentas; i++) {
    const t = apertura.getTime() + (duracionMs * i) / cantVentas + randInt(-300_000, 300_000);
    ventas.push(generarVenta(ctx, new Date(t), i + 1));
  }

  // Calcular efectivo neto + egresos para determinar existencia final
  const totalEfectivo = ventas
    .filter((v) => !v.anulada)
    .flatMap((v) => v.pagos)
    .filter((p) => p.metodo === MetodoPago.EFECTIVO)
    .reduce((acc, p) => acc + p.monto, 0);

  // Movimientos del turno: 1-3 egresos + 0-1 ingresos
  type MovInput = {
    tipo: TipoMovimiento;
    monto: number;
    categoriaNombre: string;
    cuentaOrigenNombre?: string;
    cuentaDestinoNombre?: string;
    observacion: string;
    horaOffset: number; // ms desde apertura
  };
  const movimientos: MovInput[] = [];

  if (turno === TurnoCaja.MANANA) {
    movimientos.push({
      tipo: TipoMovimiento.EGRESO,
      monto: 25000,
      categoriaNombre: 'Adelanto a empleado',
      cuentaOrigenNombre: 'Caja física',
      observacion: 'Adelanto Edgardo',
      horaOffset: 1000 * 60 * 60 * 2, // 11:00
    });
    if (chance(60)) {
      movimientos.push({
        tipo: TipoMovimiento.EGRESO,
        monto: randInt(8000, 18000),
        categoriaNombre: 'Movilidad',
        cuentaOrigenNombre: 'Caja física',
        observacion: 'Combustible Damián',
        horaOffset: 1000 * 60 * 60 * 3,
      });
    }
  } else {
    movimientos.push({
      tipo: TipoMovimiento.EGRESO,
      monto: 220000,
      categoriaNombre: 'Insumos (compras a proveedores)',
      cuentaOrigenNombre: 'Caja física',
      observacion: 'Pago Vacalin (cheque levantado)',
      horaOffset: 1000 * 60 * 60 * 1,
    });
    if (chance(50)) {
      movimientos.push({
        tipo: TipoMovimiento.INGRESO,
        monto: 100000,
        categoriaNombre: 'Otros ingresos',
        cuentaDestinoNombre: 'Caja física',
        observacion: 'Aporte Julio',
        horaOffset: 1000 * 60 * 60 * 2,
      });
    }
    movimientos.push({
      tipo: TipoMovimiento.EGRESO,
      monto: randInt(35000, 60000),
      categoriaNombre: 'Sueldos',
      cuentaOrigenNombre: 'Galicia',
      observacion: 'Quincena cocineros',
      horaOffset: 1000 * 60 * 60 * 4,
    });
  }

  const totalEgresosEfectivo = movimientos
    .filter((m) => m.tipo === TipoMovimiento.EGRESO && m.cuentaOrigenNombre === 'Caja física')
    .reduce((acc, m) => acc + m.monto, 0);
  const totalIngresosEfectivo = movimientos
    .filter((m) => m.tipo === TipoMovimiento.INGRESO && m.cuentaDestinoNombre === 'Caja física')
    .reduce((acc, m) => acc + m.monto, 0);

  const recaudacionEsperada = existenciaInicial + totalEfectivo + totalIngresosEfectivo - totalEgresosEfectivo;
  // Existencia final con pequeña variación realista (±0.5% de rango)
  const variacion = randFloat(-Math.min(2000, recaudacionEsperada * 0.005), Math.min(2000, recaudacionEsperada * 0.005));
  const existenciaFinal = Math.round((recaudacionEsperada + variacion) * 100) / 100;
  const diferencia = Math.round((existenciaFinal - recaudacionEsperada) * 100) / 100;

  // Insertar todo en una transacción
  let ventasInsertadas = 0;
  const sesionId = await prisma.$transaction(
    async (tx) => {
      const sesion = await tx.sesionCaja.create({
        data: {
          fecha: ctx.fecha,
          turno,
          horarioApertura: apertura,
          horarioCierre: cierre,
          existenciaInicial: existenciaInicial.toFixed(2),
          existenciaFinal: existenciaFinal.toFixed(2),
          recaudacionEsperada: recaudacionEsperada.toFixed(2),
          diferencia: diferencia.toFixed(2),
          usuarioAperturaId: ctx.vendedor.id,
          usuarioCierreId: ctx.vendedor.id,
          estado: EstadoSesionCaja.CERRADA,
          observaciones:
            Math.abs(diferencia) > 0
              ? `Diferencia detectada en cierre: ${diferencia > 0 ? '+' : ''}${diferencia.toFixed(2)}`
              : null,
        },
      });

      // Ventas + items + pagos
      for (const v of ventas) {
        const venta = await tx.venta.create({
          data: {
            numeroOrdenTurno: v.numeroOrdenTurno,
            canal: v.canal,
            modalidad: v.modalidad,
            estado: v.anulada ? EstadoVenta.ANULADA : EstadoVenta.FINALIZADA,
            listaPreciosId: ctx.listaPreciosId,
            subtotal: v.subtotal.toFixed(2),
            descuentoTotal: v.descuento.toFixed(2),
            total: v.total.toFixed(2),
            totalPagado: v.anulada ? '0' : v.total.toFixed(2),
            pcOrigen: 'TEST',
            usuarioAperturaId: ctx.vendedor.id,
            usuarioCierreId: ctx.vendedor.id,
            usuarioAnulacionId: v.anulada ? ctx.vendedor.id : null,
            motivoAnulacion: v.anulada ? 'Cliente desistió' : null,
            sesionCajaId: sesion.id,
            fechaApertura: v.hora,
            fechaFinalizacion: v.anulada ? null : new Date(v.hora.getTime() + 60_000),
            fechaAnulacion: v.anulada ? new Date(v.hora.getTime() + 30_000) : null,
            tieneCocina: v.items.some((i) => i.cocinaInterviene),
          },
        });

        await tx.itemVenta.createMany({
          data: v.items.map((i, idx) => ({
            ventaId: venta.id,
            productoId: i.productoId,
            nombreSnapshot: i.nombreSnapshot,
            cantidad: i.cantidad.toString(),
            unidad: i.unidad,
            precioUnitario: i.precioUnitario.toFixed(2),
            subtotal: (i.cantidad * i.precioUnitario).toFixed(2),
            totalLinea: (i.cantidad * i.precioUnitario).toFixed(2),
            orden: idx,
            cocinaInterviene: i.cocinaInterviene,
          })),
        });

        if (!v.anulada) {
          await tx.pago.createMany({
            data: v.pagos.map((p) => ({
              ventaId: venta.id,
              metodo: p.metodo,
              cuentaId: p.cuentaId,
              monto: p.monto.toFixed(2),
              estado: EstadoPago.CONFIRMADO,
              fecha: new Date(v.hora.getTime() + 30_000),
            })),
          });
          ventasInsertadas += 1;
        }
      }

      // Movimientos
      for (const m of movimientos) {
        const cuentaOrigen = m.cuentaOrigenNombre
          ? Object.values(ctx.cuentas).find(
              (c) => c.nombre.toLowerCase() === m.cuentaOrigenNombre!.toLowerCase(),
            )
          : null;
        const cuentaDestino = m.cuentaDestinoNombre
          ? Object.values(ctx.cuentas).find(
              (c) => c.nombre.toLowerCase() === m.cuentaDestinoNombre!.toLowerCase(),
            )
          : null;
        const categoriaId = ctx.categorias.get(m.categoriaNombre);
        if (!categoriaId) {
          console.warn(`Categoría "${m.categoriaNombre}" no encontrada — skip`);
          continue;
        }
        await tx.movimiento.create({
          data: {
            tipo: m.tipo,
            estado: EstadoMovimiento.CONFIRMADO,
            monto: m.monto.toFixed(2),
            categoriaId,
            cuentaOrigenId: cuentaOrigen?.id ?? null,
            cuentaDestinoId: cuentaDestino?.id ?? null,
            usuarioId: ctx.vendedor.id,
            sesionCajaId: sesion.id,
            observacion: m.observacion,
            fechaComputo: new Date(apertura.getTime() + m.horaOffset),
          },
        });
      }

      return sesion.id;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );

  return { sesionId, ventasInsertadas };
}

async function limpiarDia(fecha: Date): Promise<void> {
  console.log(`▸ Limpiando día ${fecha.toISOString().slice(0, 10)}...`);
  const sesiones = await prisma.sesionCaja.findMany({ where: { fecha } });
  for (const s of sesiones) {
    // Borrar pagos de las ventas
    await prisma.pago.deleteMany({
      where: { venta: { sesionCajaId: s.id } },
    });
    // Borrar items
    await prisma.itemVenta.deleteMany({
      where: { venta: { sesionCajaId: s.id } },
    });
    // Borrar ventas
    await prisma.venta.deleteMany({ where: { sesionCajaId: s.id } });
    // Borrar movimientos
    await prisma.movimiento.deleteMany({ where: { sesionCajaId: s.id } });
    // Borrar sesion
    await prisma.sesionCaja.delete({ where: { id: s.id } });
  }
  console.log(`  ✓ ${sesiones.length} sesiones limpiadas`);
}

async function main() {
  const args = process.argv.slice(2);
  const limpiar = args.includes('--limpiar');
  const fechaArg = args.find((a) => a.startsWith('--fecha='));
  let fecha: Date;
  if (fechaArg) {
    fecha = new Date(fechaArg.split('=')[1]!);
    fecha.setHours(0, 0, 0, 0);
  } else {
    // Por defecto: ayer (para no chocar con la sesión de hoy)
    fecha = new Date();
    fecha.setDate(fecha.getDate() - 1);
    fecha.setHours(0, 0, 0, 0);
  }

  if (limpiar) {
    await limpiarDia(fecha);
    process.exit(0);
  }

  // Si ya existe alguna sesión en esa fecha → abortar
  const existente = await prisma.sesionCaja.findFirst({ where: { fecha } });
  if (existente) {
    console.error(
      `❌ Ya existe una sesión para ${fecha.toISOString().slice(0, 10)}. ` +
        `Corré con --limpiar primero o elegí otra fecha con --fecha=YYYY-MM-DD`,
    );
    process.exit(1);
  }

  console.log(`▸ Generando día de prueba para ${fecha.toISOString().slice(0, 10)}`);
  const ctx = await cargarContexto(fecha);
  console.log(`  ✓ Contexto cargado (${ctx.productos.length} productos)`);

  console.log('▸ Generando sesión MAÑANA (~80 ventas)...');
  const m = await crearSesion(ctx, TurnoCaja.MANANA, 80, 200_000);
  console.log(`  ✓ Mañana: ${m.ventasInsertadas} ventas finalizadas — ${m.sesionId}`);

  console.log('▸ Generando sesión TARDE (~120 ventas)...');
  const t = await crearSesion(ctx, TurnoCaja.TARDE, 120, 50_000);
  console.log(`  ✓ Tarde: ${t.ventasInsertadas} ventas finalizadas — ${t.sesionId}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✓ Día de prueba listo.');
  console.log('  Andá a /admin/cierres para ver y enviar por email.');
  console.log('  Para borrarlo:  pnpm --filter @sta/api exec tsx src/scripts/generar-dia-prueba.ts --limpiar' +
    (fechaArg ? ` --fecha=${fecha.toISOString().slice(0, 10)}` : ''));

  process.exit(0);
}

void main().catch((e) => {
  console.error('❌ Error:', e);
  process.exit(1);
});
