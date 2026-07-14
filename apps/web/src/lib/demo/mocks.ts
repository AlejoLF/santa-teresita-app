/**
 * Mock router para modo demo.
 * Recibe (method, path, body) y devuelve la respuesta que daría la API real.
 * El estado mutable (ventas creadas, items removidos, etc.) vive en memoria
 * + sessionStorage para sobrevivir navegaciones.
 */

import {
  categorias,
  productosSeed,
  cuentasSeed,
  categoriasMov,
  empleadosSeed,
  clientesSeed,
  proveedoresSeed,
  ventasIniciales,
  movimientosSeed,
  grupoModRavioles,
  grupoModSorrentinos,
  grupoModCanelones,
  grupoModSalsa,
  type VentaSeed,
} from './data';

const SESSION_KEY = 'sta-demo-state-v2';

interface DemoState {
  ventas: VentaSeed[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encargos: any[];
  movimientos: typeof movimientosSeed;
  rolActivo: 'VENDEDOR' | 'ADMIN';
  usuarioActivo: { id: string; nombre: string; rol: 'VENDEDOR' | 'ADMIN' };
}

function defaultState(): DemoState {
  return {
    ventas: JSON.parse(JSON.stringify(ventasIniciales)),
    encargos: buildEncargosDemo(),
    movimientos: JSON.parse(JSON.stringify(movimientosSeed)),
    rolActivo: 'VENDEDOR',
    usuarioActivo: { id: 'u-vendedor', nombre: 'Lucía (demo)', rol: 'VENDEDOR' },
  };
}

/** Encargos demo (pedidos para días futuros). Fechas relativas a hoy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildEncargosDemo(): any[] {
  // Fechas relativas a HOY en hora de Argentina (igual base que la UI), formato
  // YYYY-MM-DD, para que el día calce con el calendario/tarjetas.
  const arHoy = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  const dia = (n: number) => {
    const [y, mo, d] = arHoy.split('-').map(Number);
    const dt = new Date(Date.UTC(y!, (mo ?? 1) - 1, d ?? 1));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  };
  const enc = (o: Record<string, unknown>) => ({
    canal: 'MOSTRADOR',
    modalidad: 'TAKE_AWAY',
    tieneCocina: false,
    fechaApertura: addDays(-1),
    esEncargo: true,
    pagos: [],
    // Entrega: null = pendiente de retiro (ortogonal al cobro).
    retiradoAt: null,
    ...o,
  });
  return [
    enc({
      id: 'enc-1', numero: 4101, numeroOrdenTurno: 12, estado: 'PROCESADA',
      estadoCobroEncargo: 'A_PAGAR', tipoEntregaEncargo: 'RETIRO',
      fechaEntregaPromesa: dia(0), horaEntregaExacta: null, franjaEntrega: 'TARDE',
      subtotal: '9000', total: '9000',
      items: [{ id: 'ei1', productoId: 'p-enc-1', nombreSnapshot: 'Ravioles tradicionales · Ricota y espinaca', cantidad: '6', unidad: 'UNIDAD', precioUnitario: '1500', totalLinea: '9000', cocinaInterviene: false, modificadoresAplicados: [{ opcionNombre: 'Ricota y espinaca' }] }],
      deliveryInfo: { direccionSnapshot: { clienteNombre: 'Marta López', clienteTelefono: '221-555-7788', direccion: null, _retiro: true } },
    }),
    enc({
      id: 'enc-2', numero: 4102, numeroOrdenTurno: 18, estado: 'PROCESADA',
      estadoCobroEncargo: 'A_PAGAR', tipoEntregaEncargo: 'ENVIO',
      canal: 'TELEFONO', modalidad: 'DELIVERY_PROPIO',
      fechaEntregaPromesa: dia(0), horaEntregaExacta: '20:30', franjaEntrega: null,
      subtotal: '14400', total: '14400',
      items: [{ id: 'ei2', productoId: 'p-enc-2', nombreSnapshot: 'Sorrentinos caseros · Jamón y mozzarella', cantidad: '8', unidad: 'UNIDAD', precioUnitario: '1800', totalLinea: '14400', cocinaInterviene: false, modificadoresAplicados: [{ opcionNombre: 'Jamón y mozzarella' }] }],
      deliveryInfo: { direccionSnapshot: { clienteNombre: 'Flia. Gómez', clienteTelefono: '221-555-3344', direccion: 'Calle 50 nº 1234', indicaciones: 'Timbre azul', _retiro: false } },
    }),
    enc({
      id: 'enc-3', numero: 4103, numeroOrdenTurno: 21, estado: 'FINALIZADA',
      estadoCobroEncargo: 'COBRADO', tipoEntregaEncargo: 'RETIRO',
      fechaEntregaPromesa: dia(1), horaEntregaExacta: null, franjaEntrega: 'MANANA',
      subtotal: '6000', total: '6000', fechaFinalizacion: addDays(-1),
      items: [{ id: 'ei3', productoId: 'p-enc-3', nombreSnapshot: 'Lasaña casera', cantidad: '2', unidad: 'PORCION', precioUnitario: '3000', totalLinea: '6000', cocinaInterviene: true, modificadoresAplicados: null }],
      pagos: [{ id: 'pg-enc-3', metodo: 'EFECTIVO', monto: '6000' }],
      deliveryInfo: { direccionSnapshot: { clienteNombre: 'Pedro N.', clienteTelefono: '221-555-9911', direccion: null, _retiro: true } },
    }),
    enc({
      id: 'enc-4', numero: 4104, numeroOrdenTurno: 25, estado: 'PROCESADA',
      estadoCobroEncargo: 'A_PAGAR', tipoEntregaEncargo: 'ENVIO',
      canal: 'TELEFONO', modalidad: 'DELIVERY_PROPIO',
      fechaEntregaPromesa: dia(3), horaEntregaExacta: null, franjaEntrega: 'NOCHE',
      subtotal: '21000', total: '21000',
      items: [{ id: 'ei4', productoId: 'p-enc-4', nombreSnapshot: 'Canelones de verdura', cantidad: '14', unidad: 'UNIDAD', precioUnitario: '1500', totalLinea: '21000', cocinaInterviene: true, modificadoresAplicados: null }],
      deliveryInfo: { direccionSnapshot: { clienteNombre: 'Cumple Sofía', clienteTelefono: '221-555-2200', direccion: 'Av. 7 nº 880', _retiro: false } },
    }),
    // Cobrado Y retirado — muestra que las dos dimensiones son independientes.
    enc({
      id: 'enc-5', numero: 4105, numeroOrdenTurno: 8, estado: 'FINALIZADA',
      estadoCobroEncargo: 'COBRADO', tipoEntregaEncargo: 'RETIRO',
      fechaEntregaPromesa: dia(0), horaEntregaExacta: null, franjaEntrega: 'MANANA',
      subtotal: '7500', total: '7500', fechaFinalizacion: addDays(-1),
      retiradoAt: addDays(0),
      items: [{ id: 'ei5', productoId: 'p-enc-5', nombreSnapshot: 'Empanadas', cantidad: '12', unidad: 'UNIDAD', precioUnitario: '625', totalLinea: '7500', cocinaInterviene: true, modificadoresAplicados: null }],
      pagos: [{ id: 'pg-enc-5', metodo: 'EFECTIVO', monto: '7500' }],
      deliveryInfo: { direccionSnapshot: { clienteNombre: 'Ana Ruiz', clienteTelefono: '221-555-6060', direccion: null, _retiro: true } },
    }),
  ];
}

export function buildCierrePayloadFromDemo(extras?: { contado?: string; observaciones?: string }) {
  const state = loadState();
  const finalizadas = state.ventas.filter((v) => v.estado === 'FINALIZADA');
  const totalDelDia = finalizadas.reduce((a, v) => a + Number(v.total), 0);
  const pagos = finalizadas.flatMap((v) => v.pagos);
  const sumByMetodo = (metodos: string[]) =>
    pagos.filter((p) => metodos.includes(p.metodo)).reduce((a, p) => a + Number(p.monto), 0);

  const porCanal = Object.entries(
    finalizadas.reduce<Record<string, { monto: number; cantidad: number }>>((acc, v) => {
      const cur = acc[v.canal] ?? { monto: 0, cantidad: 0 };
      cur.monto += Number(v.total);
      cur.cantidad += 1;
      acc[v.canal] = cur;
      return acc;
    }, {}),
  ).map(([canal, vv]) => ({ canal, monto: vv.monto.toString(), cantidad: vv.cantidad }));

  const aportes = state.movimientos.filter((m) => m.tipo === 'INGRESO');
  const egresos = state.movimientos.filter((m) => m.tipo === 'EGRESO');

  return {
    fecha: new Date().toISOString(),
    turno: 'TARDE',
    cantidadVentas: finalizadas.length,
    totalDelDia: totalDelDia.toString(),
    desgloseEfectivo: {
      mostrador: sumByMetodo(['EFECTIVO']).toString(),
      damian: '0',
      plataformas: '0',
    },
    desgloseTarjeta: {
      debito: sumByMetodo(['DEBITO']).toString(),
      credito: sumByMetodo(['CREDITO_1_PAGO', 'CREDITO_CUOTAS']).toString(),
      mpQr: sumByMetodo(['MERCADOPAGO_QR']).toString(),
      transferencia: sumByMetodo(['TRANSFERENCIA']).toString(),
    },
    porCanal,
    aportes: {
      total: aportes.reduce((a, m) => a + Number(m.monto), 0).toString(),
      cantidad: aportes.length,
      items: aportes.map((m) => ({ categoria: m.categoria, monto: m.monto, descripcion: m.descripcion })),
    },
    egresos: {
      total: egresos.reduce((a, m) => a + Number(m.monto), 0).toString(),
      cantidad: egresos.length,
      items: egresos.map((m) => ({ categoria: m.categoria, monto: m.monto, descripcion: m.descripcion })),
    },
    comentario: extras?.observaciones,
    enviadoPor: state.usuarioActivo.nombre,
  };
}

export function setDemoRol(rol: 'VENDEDOR' | 'ADMIN') {
  const state = loadState();
  state.rolActivo = rol;
  state.usuarioActivo =
    rol === 'ADMIN'
      ? { id: 'u-julio', nombre: 'Julio (demo)', rol: 'ADMIN' }
      : { id: 'u-vendedor', nombre: 'Lucía (demo)', rol: 'VENDEDOR' };
  saveState(state);
}

export function resetDemoState() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(SESSION_KEY);
}

function loadState(): DemoState {
  if (typeof window === 'undefined') return defaultState();
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return defaultState();
    return JSON.parse(raw);
  } catch {
    return defaultState();
  }
}

function saveState(s: DemoState) {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildSabores(p: (typeof productosSeed)[number], grupo?: typeof grupoModRavioles | null) {
  if (!grupo) return { mods: [], sabores: [] };
  const mods = [
    {
      grupoModificador: {
        id: grupo.id,
        nombre: grupo.nombre,
        obligatorio: grupo.obligatorio,
        tipoSeleccion: grupo.tipoSeleccion,
        opciones: grupo.opciones,
      },
    },
  ];
  const sabores = grupo.opciones.map((o, idx) => ({
    opcionId: o.id,
    grupoId: grupo.id,
    grupoNombre: grupo.nombre,
    nombre: o.nombre,
    deltaPrecio: o.deltaPrecio,
    codigo: p.codigo ? `${p.codigo}${String(idx + 1).padStart(2, '0')}` : null,
  }));
  return { mods, sabores };
}

function productosFull() {
  return productosSeed.map((p) => {
    const tipo = categorias.flatMap((c) => c.tipos).find((t) => t.id === p.tipoId)!;
    const cat = categorias.find((c) => c.id === tipo.categoriaId)!;
    const { mods, sabores } = buildSabores(p, p.grupoMod);
    return {
      id: p.id,
      codigo: p.codigo,
      nombre: p.nombre,
      marca: p.marca ?? null,
      presentacion: p.presentacion ?? null,
      precioBase: p.precioBase,
      formaVenta: p.formaVenta,
      unidadPrecio: p.unidadPrecio,
      cantidadDefault: p.cantidadDefault,
      activo: p.activo,
      tipoProducto: {
        id: tipo.id,
        nombre: tipo.nombre,
        cocinaInterviene: tipo.cocinaInterviene,
        categoria: { id: cat.id, nombre: cat.nombre, icono: cat.icono ?? null },
      },
      modificadores: mods,
      saboresResumen: sabores.map((s) => s.nombre).slice(0, 8),
      sabores,
      // Misma regla que la API real: detectado por el nombre del tipo.
      incluyeSalsa: tipo.nombre.toLowerCase().endsWith('porción simple')
        ? ('SIMPLE' as const)
        : tipo.nombre.toLowerCase().endsWith('porción especial')
          ? ('ESPECIAL' as const)
          : null,
    };
  });
}

function findProducto(id: string) {
  return productosFull().find((p) => p.id === id);
}

function calcVentaTotales(v: VentaSeed) {
  const sub = v.items.reduce((acc, i) => acc + Number(i.totalLinea), 0);
  v.subtotal = sub.toString();
  v.total = sub.toString();
  v.tieneCocina = v.items.some((i) => i.cocinaInterviene);
}

function addDays(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

function fechaHoyTime(h: number, m: number) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

// ─── Cuentas con saldos derivados ─────────────────────────────────────

function cuentasConSaldos(state: DemoState) {
  // Mapear tipo a la enum del front (EFECTIVO/BANCO/WALLET)
  const tipoMap: Record<string, 'EFECTIVO' | 'BANCO' | 'WALLET'> = {
    EFECTIVO: 'EFECTIVO',
    BANCO: 'BANCO',
    DIGITAL: 'WALLET',
  };

  const movs = state.movimientos;

  return cuentasSeed.map((c) => {
    const ingresos = movs
      .filter((m) => m.cuentaId === c.id && m.tipo === 'INGRESO')
      .reduce((a, m) => a + Number(m.monto), 0);
    const egresos = movs
      .filter((m) => m.cuentaId === c.id && m.tipo === 'EGRESO')
      .reduce((a, m) => a + Number(m.monto), 0);
    const movsCuenta = movs.filter((m) => m.cuentaId === c.id);
    const ultimo = movsCuenta.length > 0 ? movsCuenta[0]!.fecha : null;

    return {
      id: c.id,
      nombre: c.nombre,
      tipo: tipoMap[c.tipo] ?? 'BANCO',
      activa: c.activa,
      saldoActual: c.saldoActual,
      ingresosMes: ingresos.toString(),
      egresosMes: egresos.toString(),
      netoMes: (ingresos - egresos).toString(),
      movimientosMes: movsCuenta.length,
      ultimoMovimiento: ultimo,
    };
  });
}

// ─── Dashboard ────────────────────────────────────────────────────────

function buildDashboard(state: DemoState) {
  const finalizadas = state.ventas.filter((v) => v.estado === 'FINALIZADA');
  const ventasHoyMonto = finalizadas.reduce((a, v) => a + Number(v.total), 0);
  const cantidadVentas = finalizadas.length;
  const porCanal = Object.entries(
    finalizadas.reduce<Record<string, { monto: number; cantidad: number }>>((acc, v) => {
      const cur = acc[v.canal] ?? { monto: 0, cantidad: 0 };
      cur.monto += Number(v.total);
      cur.cantidad += 1;
      acc[v.canal] = cur;
      return acc;
    }, {}),
  ).map(([canal, v]) => ({ canal, monto: v.monto.toString(), cantidad: v.cantidad }));

  const pagos = finalizadas.flatMap((v) => v.pagos);
  const sumByMetodo = (metodos: string[]) =>
    pagos.filter((p) => metodos.includes(p.metodo)).reduce(
      (a, p) => ({ monto: a.monto + Number(p.monto), cantidad: a.cantidad + 1 }),
      { monto: 0, cantidad: 0 },
    );

  const efectivoMostrador = sumByMetodo(['EFECTIVO']).monto;
  const aportes = state.movimientos.filter((m) => m.tipo === 'INGRESO');
  const egresos = state.movimientos.filter((m) => m.tipo === 'EGRESO');
  const aportesMonto = aportes.reduce((a, m) => a + Number(m.monto), 0);
  const egresosMonto = egresos.reduce((a, m) => a + Number(m.monto), 0);

  const porCategoria = (lista: typeof aportes) =>
    Object.entries(
      lista.reduce<Record<string, { monto: number; cantidad: number }>>((acc, m) => {
        const cur = acc[m.categoria] ?? { monto: 0, cantidad: 0 };
        cur.monto += Number(m.monto);
        cur.cantidad += 1;
        acc[m.categoria] = cur;
        return acc;
      }, {}),
    ).map(([categoria, v]) => ({ categoria, monto: v.monto.toString(), cantidad: v.cantidad }));

  return {
    kpis: {
      ventasHoy: {
        monto: ventasHoyMonto.toString(),
        cantidad: cantidadVentas,
        variacionPct: 12.4,
        porCanal,
      },
      cobradoEfectivo: {
        monto: efectivoMostrador.toString(),
        cantidad: pagos.filter((p) => p.metodo === 'EFECTIVO').length,
        desglose: {
          mostrador: { monto: efectivoMostrador.toString(), cantidad: pagos.filter((p) => p.metodo === 'EFECTIVO').length },
          damian: { monto: '0', cantidad: 0 },
          plataformas: { monto: '0', cantidad: 0 },
          deliverateInformativo: { monto: '0', cantidad: 0 },
        },
      },
      cobradoTarjeta: {
        monto: (
          sumByMetodo(['DEBITO']).monto +
          sumByMetodo(['CREDITO_1_PAGO', 'CREDITO_CUOTAS']).monto +
          sumByMetodo(['MERCADOPAGO_QR']).monto +
          sumByMetodo(['TRANSFERENCIA']).monto
        ).toString(),
        cantidad: pagos.filter((p) => p.metodo !== 'EFECTIVO').length,
        desglose: {
          debito: { monto: sumByMetodo(['DEBITO']).monto.toString(), cantidad: sumByMetodo(['DEBITO']).cantidad },
          credito: { monto: sumByMetodo(['CREDITO_1_PAGO', 'CREDITO_CUOTAS']).monto.toString(), cantidad: sumByMetodo(['CREDITO_1_PAGO', 'CREDITO_CUOTAS']).cantidad },
          mpQr: { monto: sumByMetodo(['MERCADOPAGO_QR']).monto.toString(), cantidad: sumByMetodo(['MERCADOPAGO_QR']).cantidad },
          transferencia: { monto: sumByMetodo(['TRANSFERENCIA']).monto.toString(), cantidad: sumByMetodo(['TRANSFERENCIA']).cantidad },
          otro: { monto: '0', cantidad: 0 },
        },
      },
      aportesHoy: { monto: aportesMonto.toString(), cantidad: aportes.length, porCategoria: porCategoria(aportes) },
      egresosHoy: { monto: egresosMonto.toString(), cantidad: egresos.length, porCategoria: porCategoria(egresos) },
      pedidosAbiertos: state.ventas.filter((v) => v.estado === 'PROCESADA').length,
    },
    proximosDepositos: [
      { fuente: 'RAPPI', cuentaDestino: 'Santander', fecha: addDays(2), monto: '184500', operaciones: 14 },
      { fuente: 'Pedidos YA', cuentaDestino: 'MercadoPago', fecha: addDays(5), monto: '92300', operaciones: 8 },
      { fuente: 'Mercado Libre', cuentaDestino: 'Santander', fecha: addDays(10), monto: '54200', operaciones: 4 },
    ],
    pendientes: {
      facturasSinValidar: 2,
      facturasVencenPronto: 1,
      cambiosExcelPendientes: 3,
      sesionesSinAprobar: 1,
    },
    saldosCuentas: cuentasSeed.map((c) => ({ id: c.id, nombre: c.nombre, tipo: c.tipo, saldoActual: c.saldoActual })),
  };
}

function ventasPorHora() {
  const horas = [];
  const horasSemanaAnterior = [];
  for (let h = 9; h <= 22; h++) {
    const cantidad = Math.max(0, Math.round(Math.sin((h - 9) / 4) * 8 + 6 + (h === 13 || h === 21 ? 5 : 0)));
    const total = cantidad * (3500 + Math.round(Math.random() * 2500));
    horas.push({ hora: h, cantidad, total });
    // Mismo día de la semana pasada: curva parecida con variación.
    const cantAnt = Math.max(0, Math.round(Math.sin((h - 8.5) / 4) * 7 + 5 + (h === 21 ? 4 : 0)));
    horasSemanaAnterior.push({ hora: h, cantidad: cantAnt, total: cantAnt * (3300 + Math.round(Math.random() * 2200)) });
  }
  const diaAnteriorLabel = new Date(Date.now() - 7 * 86400000).toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
  });
  return { horas, horasSemanaAnterior, diaAnteriorLabel };
}

// ─── Análisis de ventas (página /admin/ventas) ────────────────────────

function buildVentasAnalisis(state: DemoState, search: URLSearchParams) {
  const finalizadas = state.ventas.filter((v) => v.estado === 'FINALIZADA');
  const anuladas = state.ventas.filter((v) => v.estado === 'ANULADA');
  const total = finalizadas.reduce((a, v) => a + Number(v.total), 0);
  const pagos = finalizadas.flatMap((v) => v.pagos);

  const sumByMetodo = (metodos: string[]) =>
    pagos.filter((p) => metodos.includes(p.metodo)).reduce(
      (a, p) => ({ monto: a.monto + Number(p.monto), cantidad: a.cantidad + 1 }),
      { monto: 0, cantidad: 0 },
    );

  const desde = search.get('desde') ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const hasta = search.get('hasta') ?? new Date().toISOString().slice(0, 10);

  // Cierre: agrupado por canal
  const ventasMostrador = finalizadas.filter((v) => v.canal === 'MOSTRADOR');
  const ventasDelivery = finalizadas.filter((v) => v.modalidad === 'DELIVERY_PROPIO' || v.canal === 'WHATSAPP' || v.canal === 'TELEFONO');
  const ventasPlataformas = finalizadas.filter((v) => ['PEDIDOS_YA', 'RAPPI', 'MERCADO_LIBRE', 'DELIVERATE'].includes(v.canal));

  const mostradorTotal = ventasMostrador.reduce((a, v) => a + Number(v.total), 0);
  const deliveryTotal = ventasDelivery.reduce((a, v) => a + Number(v.total), 0);
  const plataformasTotal = ventasPlataformas.reduce((a, v) => a + Number(v.total), 0);

  const aportes = state.movimientos.filter((m) => m.tipo === 'INGRESO');
  const egresos = state.movimientos.filter((m) => m.tipo === 'EGRESO');

  const totalCobrado = total;

  // Por método
  const metodosUnicos = Array.from(new Set(pagos.map((p) => p.metodo)));
  const porMetodo = metodosUnicos.map((m) => {
    const r = pagos.filter((p) => p.metodo === m);
    const monto = r.reduce((a, p) => a + Number(p.monto), 0);
    return {
      metodo: m,
      monto: monto.toString(),
      cantidad: r.length,
      pct: totalCobrado > 0 ? (monto / totalCobrado) * 100 : 0,
    };
  });

  // Por canal
  const canalesUnicos = Array.from(new Set(finalizadas.map((v) => v.canal)));
  const porCanal = canalesUnicos.map((c) => {
    const r = finalizadas.filter((v) => v.canal === c);
    const monto = r.reduce((a, v) => a + Number(v.total), 0);
    return {
      canal: c,
      monto: monto.toString(),
      cantidad: r.length,
      pct: total > 0 ? (monto / total) * 100 : 0,
    };
  });

  return {
    rango: {
      desde: new Date(desde).toISOString(),
      hasta: new Date(hasta).toISOString(),
    },
    kpis: {
      totalCobrado: totalCobrado.toString(),
      cantidadVentas: finalizadas.length,
      ticketPromedio: finalizadas.length > 0 ? (total / finalizadas.length).toFixed(0) : '0',
      totalDescuentos: '0',
      anuladasCantidad: anuladas.length,
    },
    cierreCajas: {
      mostrador: {
        total: mostradorTotal.toString(),
        efectivo: { monto: sumByMetodo(['EFECTIVO']).monto.toString(), cantidad: sumByMetodo(['EFECTIVO']).cantidad },
        debito: { monto: sumByMetodo(['DEBITO']).monto.toString(), cantidad: sumByMetodo(['DEBITO']).cantidad },
        creditoOtros: { monto: sumByMetodo(['CREDITO_1_PAGO', 'CREDITO_CUOTAS', 'MERCADOPAGO_QR']).monto.toString(), cantidad: sumByMetodo(['CREDITO_1_PAGO', 'CREDITO_CUOTAS', 'MERCADOPAGO_QR']).cantidad },
      },
      delivery: {
        total: deliveryTotal.toString(),
        efectivoDamian: { monto: '0', cantidad: 0 },
        efectivoDeliverate: { monto: '0', cantidad: 0 },
        online: { monto: deliveryTotal.toString(), cantidad: ventasDelivery.length },
      },
      plataformas: {
        total: plataformasTotal.toString(),
        app: { monto: plataformasTotal.toString(), cantidad: ventasPlataformas.length },
        efectivo: { monto: '0', cantidad: 0 },
      },
      efectivoEnCaja: {
        total: sumByMetodo(['EFECTIVO']).monto.toString(),
        desgloseVentas: {
          mostrador: sumByMetodo(['EFECTIVO']).monto.toString(),
          damian: '0',
          plataformasEfectivo: '0',
          subtotal: sumByMetodo(['EFECTIVO']).monto.toString(),
        },
        aportes: { monto: aportes.reduce((a, m) => a + Number(m.monto), 0).toString(), cantidad: aportes.length },
        egresos: { monto: egresos.reduce((a, m) => a + Number(m.monto), 0).toString(), cantidad: egresos.length },
      },
    },
    porMetodo,
    porCanal,
    porHora: ventasPorHora().horas.map((h) => ({ hora: h.hora, monto: h.total, cantidad: h.cantidad })),
    porDia: Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      return {
        fecha: d.toISOString().slice(0, 10),
        monto: 180000 + Math.round(Math.random() * 80000),
        cantidad: 30 + Math.round(Math.random() * 20),
      };
    }),
    ventas: finalizadas.map((v, i) => ({
      id: v.id,
      numero: v.numero,
      numeroOrdenTurno: v.numeroOrdenTurno,
      canal: v.canal,
      modalidad: v.modalidad,
      fecha: v.fechaFinalizacion ?? v.fechaApertura,
      // Cliente del pedido (en delivery/teléfono la cajera lo carga). Mostrador
      // no suele tenerlo. Demo-only: sintetizamos uno para los canales no-mostrador.
      cliente:
        v.canal === 'MOSTRADOR'
          ? null
          : ['Carla', 'Martín', 'Flia. Gómez', 'Lucía', 'Pedro N.'][i % 5] ?? null,
      total: v.total,
      descuento: '0',
      metodos: v.pagos.map((p) => p.metodo),
    })),
  };
}

// ─── Estadísticas (página /admin/estadisticas) ────────────────────────

function buildEstadisticas(state: DemoState, search: URLSearchParams) {
  const finalizadas = state.ventas.filter((v) => v.estado === 'FINALIZADA');
  const anuladas = state.ventas.filter((v) => v.estado === 'ANULADA');
  const total = finalizadas.reduce((a, v) => a + Number(v.total), 0);
  const periodo = (search.get('periodo') ?? 'mes') as 'hoy' | 'semana' | 'mes' | 'trimestre' | 'anio' | 'custom';

  // Por canal
  const canalesUnicos = Array.from(new Set(finalizadas.map((v) => v.canal)));
  const ventasPorCanal = canalesUnicos.map((c) => {
    const r = finalizadas.filter((v) => v.canal === c);
    const monto = r.reduce((a, v) => a + Number(v.total), 0);
    return {
      canal: c,
      monto: monto.toString(),
      cantidad: r.length,
      pct: total > 0 ? (monto / total) * 100 : 0,
    };
  });

  // Egresos por categoría
  const egresos = state.movimientos.filter((m) => m.tipo === 'EGRESO');
  const egresosTotal = egresos.reduce((a, m) => a + Number(m.monto), 0);
  const catSet = Array.from(new Set(egresos.map((e) => e.categoria)));
  const egresosPorCategoria = catSet.map((cat) => {
    const r = egresos.filter((e) => e.categoria === cat);
    return {
      categoria: cat,
      esOperativa: !cat.includes('Aporte'),
      monto: r.reduce((a, e) => a + Number(e.monto), 0).toString(),
      cantidad: r.length,
    };
  });

  // Top productos
  const porProducto: Record<string, { nombre: string; categoria: string; cantidad: number; monto: number; ocurrencias: number; productoId: string }> = {};
  for (const v of finalizadas) {
    for (const it of v.items) {
      let entry = porProducto[it.productoId];
      if (!entry) {
        const p = findProducto(it.productoId);
        entry = {
          productoId: it.productoId,
          nombre: it.nombreSnapshot.split(' · ')[0] ?? 'Producto',
          categoria: p?.tipoProducto.categoria.nombre ?? '—',
          cantidad: 0,
          monto: 0,
          ocurrencias: 0,
        };
        porProducto[it.productoId] = entry;
      }
      entry.cantidad += Number(it.cantidad);
      entry.monto += Number(it.totalLinea);
      entry.ocurrencias += 1;
    }
  }
  const topProductos = Object.values(porProducto)
    .sort((a, b) => b.monto - a.monto)
    .slice(0, 10)
    .map((p) => ({
      productoId: p.productoId,
      nombre: p.nombre,
      categoria: p.categoria,
      cantidad: p.cantidad.toString(),
      monto: p.monto.toString(),
      ocurrencias: p.ocurrencias,
    }));

  // Ventas por día (últimos 30)
  const ventasPorDia: Array<{ dia: string; cantidad: number; total: string }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dia = d.toISOString().slice(0, 10);
    const c = 25 + Math.round(Math.random() * 25);
    const t = 150000 + Math.round(Math.random() * 100000);
    ventasPorDia.push({ dia, cantidad: c, total: t.toString() });
  }

  return {
    periodo,
    desde: new Date(Date.now() - 30 * 86400000).toISOString(),
    hasta: new Date().toISOString(),
    kpis: {
      ventasTotal: total.toString(),
      ventasCantidad: finalizadas.length,
      ticketPromedio: finalizadas.length > 0 ? (total / finalizadas.length).toFixed(0) : '0',
      variacionVentasPct: 8.5,
      anuladasMonto: '0',
      anuladasCantidad: anuladas.length,
      egresosTotal: egresosTotal.toString(),
      resultadoNeto: (total - egresosTotal).toString(),
    },
    ventasPorCanal,
    egresosPorCategoria,
    topProductos,
    combosVendidos: [],
    ventasPorDia,
    topClientes: clientesSeed.slice(0, 5).map((c) => ({
      clienteId: c.id,
      nombre: c.nombre,
      tipo: 'PARTICULAR',
      monto: (15000 + Math.round(Math.random() * 30000)).toString(),
      cantidad: 1 + Math.round(Math.random() * 5),
    })),
  };
}

// ─── Movimientos (página /admin/movimientos) ──────────────────────────

function buildMovimientosListado(state: DemoState, search: URLSearchParams) {
  const tipo = search.get('tipo');
  const cuentaId = search.get('cuentaId');
  const page = Number(search.get('page') ?? '1');
  const pageSize = Number(search.get('pageSize') ?? '50');

  let lista = state.movimientos.slice();
  if (tipo) lista = lista.filter((m) => m.tipo === tipo);
  if (cuentaId) lista = lista.filter((m) => m.cuentaId === cuentaId);

  const ingresos = lista.filter((m) => m.tipo === 'INGRESO').reduce((a, m) => a + Number(m.monto), 0);
  const egresos = lista.filter((m) => m.tipo === 'EGRESO').reduce((a, m) => a + Number(m.monto), 0);

  const total = lista.length;
  const slice = lista.slice((page - 1) * pageSize, page * pageSize);

  const movimientos = slice.map((m) => ({
    id: m.id,
    tipo: m.tipo,
    monto: m.monto,
    fechaComputo: m.fecha,
    estado: 'CONFIRMADO',
    observacion: m.descripcion,
    cuentaOrigen: m.tipo === 'EGRESO' ? { nombre: m.cuenta } : null,
    cuentaDestino: m.tipo === 'INGRESO' ? { nombre: m.cuenta } : null,
    categoria: { nombre: m.categoria },
    usuario: { nombre: m.usuario },
  }));

  return {
    movimientos,
    total,
    page,
    pageSize,
    sumas: {
      ingresos: ingresos.toString(),
      egresos: egresos.toString(),
      neto: (ingresos - egresos).toString(),
    },
  };
}

// ─── Sesión actual ────────────────────────────────────────────────────

function buildSesionActual(state: DemoState) {
  const finalizadas = state.ventas.filter((v) => v.estado === 'FINALIZADA');
  const abiertas = state.ventas.filter((v) => v.estado === 'PROCESADA');
  // Encargos A_PAGAR: informativo, NO bloquean el cierre (viven en state.encargos,
  // aparte de state.ventas — igual que en la API real, esEncargo no cuenta como
  // "pedido abierto" del turno).
  const encargosAPagar = (state.encargos ?? []).filter(
    (e) => e?.estado === 'PROCESADA' && e?.estadoCobroEncargo === 'A_PAGAR',
  ).length;
  const pagos = finalizadas.flatMap((v) => v.pagos);

  const cobrosPorMetodo: Array<{ metodo: string; monto: string; cantidad: number }> = [];
  const metodosUnicos = Array.from(new Set(pagos.map((p) => p.metodo)));
  for (const m of metodosUnicos) {
    const r = pagos.filter((p) => p.metodo === m);
    cobrosPorMetodo.push({
      metodo: m,
      monto: r.reduce((a, p) => a + Number(p.monto), 0).toString(),
      cantidad: r.length,
    });
  }

  const totalEfectivo = pagos.filter((p) => p.metodo === 'EFECTIVO').reduce((a, p) => a + Number(p.monto), 0);
  const totalEgresos = state.movimientos.filter((m) => m.tipo === 'EGRESO').reduce((a, m) => a + Number(m.monto), 0);
  const totalAportes = state.movimientos.filter((m) => m.tipo === 'INGRESO').reduce((a, m) => a + Number(m.monto), 0);

  return {
    sesion: {
      id: 'sesion-actual-1',
      fecha: new Date().toISOString().slice(0, 10),
      turno: 'TARDE' as const,
      estado: 'ABIERTA' as const,
      horarioApertura: fechaHoyTime(13, 0),
      horarioCierre: null,
      existenciaInicial: '50000',
      existenciaFinal: null,
      diferencia: null,
      aprobadaPorAdmin: false,
      usuarioApertura: 'María (Encargada)',
      usuarioCierre: null,
    },
    cobrosPorMetodo,
    movimientos: state.movimientos.map((m) => ({
      id: m.id,
      tipo: m.tipo,
      monto: m.monto,
      categoria: m.categoria,
    })),
    ventasCount: finalizadas.length,
    ventasAbiertas: abiertas.length,
    encargosAPagar,
    totalEfectivo: totalEfectivo.toString(),
    totalEgresos: totalEgresos.toString(),
    recaudacionEsperadaEfectivo: (50000 + totalEfectivo + totalAportes - totalEgresos).toString(),
  };
}

// ─── Cierres históricos ───────────────────────────────────────────────

function buildCierres() {
  return Array.from({ length: 8 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i - 1);
    const turno = i % 2 === 0 ? ('MANANA' as const) : ('TARDE' as const);
    const aprobada = i > 1;
    const existInicial = 50000;
    const existFinal = existInicial + 30000 + Math.round(Math.random() * 50000);
    const recaudacion = existFinal - existInicial;
    return {
      id: `ses-${i}`,
      fecha: d.toISOString().slice(0, 10),
      turno,
      estado: (aprobada ? 'APROBADA' : 'CERRADA') as 'CERRADA' | 'APROBADA',
      horarioApertura: new Date(d.setHours(turno === 'MANANA' ? 9 : 13, 0)).toISOString(),
      horarioCierre: new Date(d.setHours(turno === 'MANANA' ? 13 : 22, 0)).toISOString(),
      existenciaInicial: existInicial.toString(),
      existenciaFinal: existFinal.toString(),
      recaudacionEsperada: recaudacion.toString(),
      diferencia: '0',
      fechaAprobacion: aprobada ? new Date(d).toISOString() : null,
      usuarioApertura: { nombre: 'María (Encargada)' },
      usuarioCierre: { nombre: 'María (Encargada)' },
      aprobadaAdmin: aprobada ? { nombre: 'Julio (Dueño)' } : null,
      observaciones: i === 0 ? 'Sesión cerrada con normalidad.' : null,
      emailEnviadoA: null,
      emailEnviadoAt: null,
    };
  });
}

/**
 * Match de producto por texto libre — espeja `buscarProductoWhere` del backend:
 * nombre, marca, presentación, código, descripción y el nombre de la
 * sub-categoría / categoría. `q` ya viene en minúsculas y trim.
 */
function matchProductoBusqueda(
  p: {
    nombre: string;
    marca?: string | null;
    presentacion?: string | null;
    codigo?: string | null;
    descripcion?: string | null;
    tipoProducto?: { nombre?: string; categoria?: { nombre?: string } };
  },
  q: string,
): boolean {
  return (
    p.nombre.toLowerCase().includes(q) ||
    (p.marca ?? '').toLowerCase().includes(q) ||
    (p.presentacion ?? '').toLowerCase().includes(q) ||
    (p.codigo ?? '').toLowerCase().includes(q) ||
    (p.descripcion ?? '').toLowerCase().includes(q) ||
    (p.tipoProducto?.nombre ?? '').toLowerCase().includes(q) ||
    (p.tipoProducto?.categoria?.nombre ?? '').toLowerCase().includes(q)
  );
}

// ─── Precios — lista, historial, aprobaciones ─────────────────────────

function buildPreciosLista(search: URLSearchParams) {
  const q = search.get('q')?.toLowerCase().trim() ?? '';
  const categoriaId = search.get('categoriaId');

  let prods = productosFull();
  if (q) {
    prods = prods.filter((p) => matchProductoBusqueda(p, q));
  }
  if (categoriaId) {
    prods = prods.filter((p) => p.tipoProducto.categoria.id === categoriaId);
  }

  return {
    productos: prods.map((p, i) => ({
      id: p.id,
      codigo: p.codigo,
      nombre: p.nombre,
      marca: p.marca,
      presentacion: p.presentacion,
      precioBase: p.precioBase,
      unidadPrecio: p.unidadPrecio,
      formaVenta: p.formaVenta,
      categoria: p.tipoProducto.categoria.nombre,
      tipoNombre: p.tipoProducto.nombre,
      ultimoCambio: i % 3 === 0
        ? {
            fecha: addDays(-7 - (i * 3) % 60),
            precioAnterior: (Number(p.precioBase) * 0.9).toFixed(0),
            deltaPct: 11.1,
            motivo: 'Ajuste de precios',
          }
        : null,
    })),
  };
}

function buildPreciosHistorial() {
  const cambios: Array<any> = [];
  const sample = productosSeed.slice(0, 12);
  for (let i = 0; i < sample.length; i++) {
    const p = sample[i]!;
    const tipo = categorias.flatMap((c) => c.tipos).find((t) => t.id === p.tipoId)!;
    const cat = categorias.find((c) => c.id === tipo.categoriaId)!;
    cambios.push({
      id: `hist-${i}`,
      fecha: addDays(-1 - i * 2),
      productoId: p.id,
      productoNombre: p.nombre,
      productoCodigo: p.codigo,
      categoria: cat.nombre,
      precioAnterior: (Number(p.precioBase) * 0.9).toFixed(0),
      precioNuevo: p.precioBase,
      deltaPct: 11.1,
      motivo: 'Ajuste de precios',
      usuario: 'Julio (Dueño)',
      lista: 'Lista de precios general',
    });
  }
  return { cambios };
}

function buildPreciosAprobaciones() {
  return [
    {
      id: 'aprob-1',
      archivoNombre: 'Lista de Precios.xlsx',
      modificadoEn: addDays(-1),
      modificadoPor: 'Julio (Dueño)',
      detectadoAt: addDays(-1),
      cambiosTotal: 12,
      cambiosAplicables: 10,
      cambiosSospechosos: 1,
      cambiosErrores: 1,
      estado: 'PENDIENTE' as const,
      aprobadaAt: null,
      aprobadaPor: null,
    },
    {
      id: 'aprob-2',
      archivoNombre: 'Lista de Precios.xlsx',
      modificadoEn: addDays(-7),
      modificadoPor: 'Julio (Dueño)',
      detectadoAt: addDays(-7),
      cambiosTotal: 5,
      cambiosAplicables: 5,
      cambiosSospechosos: 0,
      cambiosErrores: 0,
      estado: 'APROBADA' as const,
      aprobadaAt: addDays(-7),
      aprobadaPor: 'Julio (Dueño)',
    },
  ];
}

function buildAprobacionDetalle(id: string) {
  const aprobacion = buildPreciosAprobaciones().find((a) => a.id === id);
  if (!aprobacion) return null;
  const cambios = productosSeed.slice(0, 10).map((p, i) => ({
    tipo: 'PRECIO_CAMBIA' as const,
    cambioId: `c-${i}`,
    productoId: p.id,
    codigo: p.codigo,
    nombreProducto: p.nombre,
    categoria: categorias.flatMap((c) => c.tipos).find((t) => t.id === p.tipoId)?.nombre ?? '—',
    precioAnterior: p.precioBase,
    precioNuevo: (Number(p.precioBase) * 1.1).toFixed(0),
    deltaPct: 10,
  }));
  return {
    ...aprobacion,
    observaciones: null,
    diff: {
      fuente: 'Drive',
      archivoNombre: aprobacion.archivoNombre,
      cambios,
      sospechosos: [
        {
          tipo: 'PRODUCTO_NO_ENCONTRADO' as const,
          cambioId: 'sosp-1',
          codigo: '0099',
          nombreSugerido: 'Salsa nueva especial',
          categoria: 'Salsas',
          precioPropuesto: '1500',
          posibleMatchNombre: null,
        },
      ],
      errores: [
        { tipo: 'FORMATO', mensaje: 'Fila 47: precio no es numérico ("ver"). Se ignoró.' },
      ],
      resumen: {
        cambiosAplicables: cambios.length,
        sospechosos: 1,
        errores: 1,
        sinCambios: 36,
      },
    },
  };
}

// ─── Productos (con paginación) ───────────────────────────────────────

function buildProductosListado(search: URLSearchParams) {
  const q = search.get('q')?.toLowerCase().trim() ?? '';
  const categoriaId = search.get('categoriaId');
  const incluirInactivos = search.get('incluirInactivos') === 'true';
  const page = Number(search.get('page') ?? '1');
  const pageSize = Number(search.get('pageSize') ?? '50');

  let prods = productosFull();
  if (!incluirInactivos) prods = prods.filter((p) => p.activo);
  if (q) {
    prods = prods.filter((p) => matchProductoBusqueda(p, q));
  }
  if (categoriaId) {
    prods = prods.filter((p) => p.tipoProducto.categoria.id === categoriaId);
  }

  return {
    productos: prods.slice((page - 1) * pageSize, page * pageSize),
    total: prods.length,
    page,
    pageSize,
  };
}

// ─── Router principal ─────────────────────────────────────────────────

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface MockResponse {
  status: number;
  body: unknown;
}

function ok(body: unknown): MockResponse {
  return { status: 200, body };
}

function notFound(message = 'No encontrado'): MockResponse {
  return { status: 404, body: { error: message } };
}

// ─── Mayoristas / cuenta corriente (datos demo) ────────────────────────
// Clientes que compran a precio especial y pagan por cuenta corriente.
const MAYORISTAS_DEMO = [
  {
    id: 'may-1',
    nombre: 'Restaurante La Nonna',
    cuit: '30-71234567-9',
    contacto: 'Marta Gómez',
    telefono: '221-555-1010',
    email: 'lanonna@example.com',
    direccion: 'Calle 50 nº 1234, La Plata',
    observaciones: 'Entrega martes y viernes',
    activo: true,
    lista: { id: 'lm-a', nombre: 'Mayorista A' },
    remitos: [
      { id: 'rem-1', numero: 101, fecha: addDays(-20), total: '85000', estado: 'PENDIENTE', itemsCount: 6, observaciones: null, items: [
        { nombre: 'Ravioles tradicionales', cantidad: '20', precioUnitario: '1500', subtotal: '30000' },
        { nombre: 'Sorrentinos caseros', cantidad: '22', precioUnitario: '1818.18', subtotal: '40000' },
        { nombre: 'Salsa casera', cantidad: '18.75', precioUnitario: '800', subtotal: '15000' },
      ] },
      { id: 'rem-2', numero: 102, fecha: addDays(-10), total: '64000', estado: 'PENDIENTE', itemsCount: 4, observaciones: 'Sin TACC', items: [
        { nombre: 'Ñoquis de papa', cantidad: '25', precioUnitario: '1600', subtotal: '40000' },
        { nombre: 'Tallarines al huevo', cantidad: '20', precioUnitario: '1200', subtotal: '24000' },
      ] },
      { id: 'rem-3', numero: 103, fecha: addDays(-3), total: '120000', estado: 'PENDIENTE', itemsCount: 9, observaciones: null, items: [
        { nombre: 'Canelones', cantidad: '30', precioUnitario: '1600', subtotal: '48000' },
        { nombre: 'Lasaña casera', cantidad: '25', precioUnitario: '1800', subtotal: '45000' },
        { nombre: 'Pesto fresco', cantidad: '22.5', precioUnitario: '1200', subtotal: '27000' },
      ] },
    ],
    cobros: [
      { id: 'cob-1', fecha: addDays(-8), monto: '100000', cuenta: 'Santander', usuario: 'Julio (Dueño)', observacion: 'Transferencia' },
    ],
  },
  {
    id: 'may-2',
    nombre: 'Rotisería El Buen Sabor',
    cuit: '27-30222111-4',
    contacto: 'Carlos',
    telefono: '221-555-2020',
    email: null,
    direccion: 'Av. 7 nº 880',
    observaciones: null,
    activo: true,
    lista: { id: 'lm-b', nombre: 'Mayorista B' },
    remitos: [
      { id: 'rem-4', numero: 104, fecha: addDays(-15), total: '48000', estado: 'PENDIENTE', itemsCount: 3, observaciones: null, items: [
        { nombre: 'Tarta pascualina', cantidad: '20', precioUnitario: '1400', subtotal: '28000' },
        { nombre: 'Tarta de verdura', cantidad: '14.28', precioUnitario: '1400', subtotal: '20000' },
      ] },
      { id: 'rem-5', numero: 105, fecha: addDays(-5), total: '52000', estado: 'PENDIENTE', itemsCount: 5, observaciones: null, items: [
        { nombre: 'Ravioles tradicionales', cantidad: '24', precioUnitario: '1500', subtotal: '36000' },
        { nombre: 'Salsa casera', cantidad: '20', precioUnitario: '800', subtotal: '16000' },
      ] },
    ],
    cobros: [
      { id: 'cob-2', fecha: addDays(-12), monto: '48000', cuenta: 'Efectivo', usuario: 'María (Encargada)', observacion: null },
      { id: 'cob-3', fecha: addDays(-2), monto: '52000', cuenta: 'Cuenta DNI', usuario: 'Julio (Dueño)', observacion: 'Saldó el mes' },
    ],
  },
  {
    id: 'may-3',
    nombre: 'Kiosco Don José',
    cuit: null,
    contacto: 'José',
    telefono: '221-555-3030',
    email: null,
    direccion: 'Calle 12 esq. 60',
    observaciones: 'Suele pagar al contado',
    activo: true,
    lista: { id: 'lm-a', nombre: 'Mayorista A' },
    remitos: [
      { id: 'rem-6', numero: 106, fecha: addDays(-1), total: '23000', estado: 'PENDIENTE', itemsCount: 2, observaciones: null },
    ],
    cobros: [],
  },
];

function mayoristaTotales(m: (typeof MAYORISTAS_DEMO)[number]) {
  const remitado = m.remitos
    .filter((r) => r.estado !== 'ANULADO')
    .reduce((a, r) => a + Number(r.total), 0);
  const cobrado = m.cobros.reduce((a, c) => a + Number(c.monto), 0);
  return { remitado, cobrado, saldo: remitado - cobrado };
}

function mayoristaCatalogo(m: (typeof MAYORISTAS_DEMO)[number] | undefined) {
  return {
    lista: m?.lista ?? { id: 'lm-a', nombre: 'Mayorista A' },
    productos: [
      { id: 'p-0011', nombre: 'Ravioles tradicionales', marca: 'Santa Teresita', unidadPrecio: 'POR_UNIDAD', unidadPrecioLabel: 'doc', precioUnitario: '1500' },
      { id: 'p-0012', nombre: 'Sorrentinos caseros', marca: 'Santa Teresita', unidadPrecio: 'POR_UNIDAD', unidadPrecioLabel: 'doc', precioUnitario: '1800' },
      { id: 'p-0031', nombre: 'Salsa bolognesa', marca: 'Santa Teresita', unidadPrecio: 'POR_UNIDAD', unidadPrecioLabel: 'u', precioUnitario: '900' },
      { id: 'p-0061', nombre: 'Tapa de empanadas x12', marca: 'La Salteña', unidadPrecio: 'POR_UNIDAD', unidadPrecioLabel: 'paq', precioUnitario: '1200' },
      { id: 'p-0070', nombre: 'Ñoquis de papa', marca: 'Santa Teresita', unidadPrecio: 'POR_KILO', unidadPrecioLabel: 'kg', precioUnitario: '2200' },
    ],
  };
}

export function handleMock(method: Method, path: string, body?: unknown): MockResponse {
  const state = loadState();
  const url = new URL(path, 'http://demo.local');
  const p = url.pathname;
  const search = url.searchParams;

  // ─── Auth ──────────────────────────────────────────────────────────
  if (p === '/auth/me' && method === 'GET') return ok({ usuario: state.usuarioActivo });
  if (p === '/auth/login' && method === 'POST') return ok({ usuario: state.usuarioActivo });
  if (p === '/auth/logout' && method === 'POST') return ok({});
  if (p === '/auth/cambiar-pin' && method === 'POST') return ok({});

  // ─── Catálogo ──────────────────────────────────────────────────────
  if (p === '/catalogo/categorias' && method === 'GET') return ok({ categorias });
  if (p === '/catalogo/productos' && method === 'GET') return ok({ productos: productosFull() });
  {
    const mSalsa = p.match(/^\/catalogo\/salsa\/(SIMPLE|ESPECIAL)$/);
    if (mSalsa && method === 'GET') {
      const tipoSalsa = mSalsa[1] as 'SIMPLE' | 'ESPECIAL';
      const grupoNombre = tipoSalsa === 'SIMPLE' ? 'Tipo — Salsa simple' : 'Tipo — Salsa especial';
      return ok({
        producto: { id: `p-salsa-${tipoSalsa.toLowerCase()}`, nombre: `Salsa ${tipoSalsa.toLowerCase()}`, precioBase: '0' },
        sabores: grupoModSalsa.opciones.map((o) => ({
          opcionId: o.id,
          grupoId: grupoModSalsa.id,
          grupoNombre,
          nombre: o.nombre,
          deltaPrecio: '0',
          codigo: null,
        })),
      });
    }
  }
  if (p.startsWith('/catalogo/buscar-por-codigo/') && method === 'GET') {
    const codigo = p.split('/').pop()!;
    let codigoNorm = codigo;
    let saborIdx: number | null = null;
    if (codigo.length === 6) {
      codigoNorm = codigo.slice(0, 4);
      saborIdx = Number(codigo.slice(4)) - 1;
    } else if (codigo.length <= 4) {
      codigoNorm = codigo.padStart(4, '0');
    }
    const prod = productosFull().find((x) => x.codigo === codigoNorm);
    if (!prod) return notFound(`Sin producto con código ${codigoNorm}`);
    let saborPreseleccionado = null;
    if (saborIdx !== null && prod.sabores) {
      const s = prod.sabores[saborIdx];
      if (s) {
        saborPreseleccionado = { opcionId: s.opcionId, grupoId: s.grupoId, nombre: s.nombre };
      }
    }
    return ok({ producto: prod, saborPreseleccionado });
  }
  if (p === '/catalogo/cuentas' && method === 'GET') {
    return ok({ cuentas: cuentasSeed.map((c) => ({ id: c.id, nombre: c.nombre, tipo: c.tipo })) });
  }
  if (p === '/catalogo/listas-precios' && method === 'GET') {
    return ok({ listas: [{ id: 'l-default', nombre: 'Lista de precios general', activa: true }] });
  }
  if (p === '/catalogo/top' && method === 'GET') return ok({ top: [] });

  // ─── Ventas ────────────────────────────────────────────────────────
  if (p === '/ventas' && method === 'POST') {
    const b = body as { canal: string; modalidad: string; items: any[] };
    const num = Math.max(...state.ventas.map((v) => v.numero), 1000) + 1;
    const items = b.items.map((it: any, idx: number) => {
      const prod = findProducto(it.productoId);
      if (!prod) throw new Error(`Producto ${it.productoId} no existe`);
      const delta = (it.modificadores || []).reduce((a: number, mm: any) => a + Number(mm.deltaPrecio || 0), 0);
      const precio = Number(prod.precioBase) + delta;
      const cantidad = Number(it.cantidad);
      const totalLinea =
        prod.unidadPrecio === 'POR_KILO' ? (cantidad / 1000) * precio :
        cantidad * precio;
      const sabor = (it.modificadores || []).map((mm: any) => mm.opcionNombre).join(', ');
      const nombre = sabor ? `${prod.nombre} · ${sabor}` : prod.nombre;
      return {
        id: `it-${Date.now()}-${idx}`,
        productoId: it.productoId,
        nombreSnapshot: nombre,
        cantidad: cantidad.toString(),
        unidad: prod.formaVenta,
        precioUnitario: precio.toString(),
        totalLinea: totalLinea.toString(),
        cocinaInterviene: prod.tipoProducto.cocinaInterviene,
        modificadoresAplicados: (it.modificadores || []).map((mm: any) => ({ opcionNombre: mm.opcionNombre })),
        observacion: it.observacion ?? null,
      };
    });
    const nueva: VentaSeed = {
      id: `v-${Date.now()}`,
      numero: num,
      numeroOrdenTurno: state.ventas.filter((v) => v.estado === 'PROCESADA' || v.fechaApertura.startsWith(new Date().toISOString().slice(0, 10))).length + 1,
      canal: b.canal,
      modalidad: b.modalidad,
      estado: 'PROCESADA',
      total: '0',
      subtotal: '0',
      fechaApertura: new Date().toISOString(),
      items,
      pagos: [],
      tieneCocina: false,
    };
    calcVentaTotales(nueva);
    state.ventas.unshift(nueva);
    saveState(state);
    return ok({ id: nueva.id, numero: nueva.numero, numeroOrdenTurno: nueva.numeroOrdenTurno, tieneCocina: nueva.tieneCocina });
  }

  if (p === '/ventas/abiertas' && method === 'GET') {
    return ok({ ventas: state.ventas.filter((v) => v.estado === 'PROCESADA') });
  }
  if (p === '/ventas/historial-sesion' && method === 'GET') {
    return ok({
      abiertas: state.ventas.filter((v) => v.estado === 'PROCESADA'),
      cerradas: state.ventas.filter((v) => v.estado === 'FINALIZADA'),
      anuladas: state.ventas.filter((v) => v.estado === 'ANULADA'),
    });
  }
  let m = p.match(/^\/ventas\/([^/]+)$/);
  if (m && method === 'GET') {
    const v =
      state.ventas.find((x) => x.id === m![1]) ?? state.encargos.find((x) => x.id === m![1]);
    if (!v) return notFound('Venta no encontrada');
    return ok(v);
  }
  m = p.match(/^\/ventas\/([^/]+)\/items$/);
  if (m && method === 'POST') {
    const v = state.ventas.find((x) => x.id === m![1]);
    if (!v) return notFound();
    const b = body as { items: any[] };
    for (const [idx, it] of b.items.entries()) {
      const prod = findProducto(it.productoId);
      if (!prod) continue;
      const delta = (it.modificadores || []).reduce((a: number, mm: any) => a + Number(mm.deltaPrecio || 0), 0);
      const precio = Number(prod.precioBase) + delta;
      const cantidad = Number(it.cantidad);
      const totalLinea =
        prod.unidadPrecio === 'POR_KILO' ? (cantidad / 1000) * precio :
        cantidad * precio;
      const sabor = (it.modificadores || []).map((mm: any) => mm.opcionNombre).join(', ');
      v.items.push({
        id: `it-${Date.now()}-${idx}`,
        productoId: it.productoId,
        nombreSnapshot: sabor ? `${prod.nombre} · ${sabor}` : prod.nombre,
        cantidad: cantidad.toString(),
        unidad: prod.formaVenta,
        precioUnitario: precio.toString(),
        totalLinea: totalLinea.toString(),
        cocinaInterviene: prod.tipoProducto.cocinaInterviene,
        modificadoresAplicados: (it.modificadores || []).map((mm: any) => ({ opcionNombre: mm.opcionNombre })),
        observacion: it.observacion ?? null,
      });
    }
    calcVentaTotales(v);
    saveState(state);
    return ok(v);
  }
  m = p.match(/^\/ventas\/([^/]+)\/items\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const v = state.ventas.find((x) => x.id === m![1]);
    if (!v) return notFound();
    v.items = v.items.filter((i) => i.id !== m![2]);
    calcVentaTotales(v);
    saveState(state);
    return ok(v);
  }
  m = p.match(/^\/ventas\/([^/]+)\/finalizar$/);
  if (m && method === 'POST') {
    const v = state.ventas.find((x) => x.id === m![1]) ?? state.encargos.find((x) => x.id === m![1]);
    if (!v) return notFound();
    const b = body as { pagos: any[] };
    v.estado = 'FINALIZADA';
    v.fechaFinalizacion = new Date().toISOString();
    v.pagos = b.pagos.map((pg: any, i: number) => ({ id: `pg-${Date.now()}-${i}`, metodo: pg.metodo, monto: pg.monto, cuentaId: pg.cuentaId }));
    // Encargo: marcar cobrado (en la sesión "actual" de la demo).
    if (v.esEncargo) v.estadoCobroEncargo = 'COBRADO';
    saveState(state);
    return ok(v);
  }
  m = p.match(/^\/ventas\/([^/]+)\/anular$/);
  if (m && method === 'POST') {
    const v = state.ventas.find((x) => x.id === m![1]) ?? state.encargos.find((x) => x.id === m![1]);
    if (!v) return notFound();
    v.estado = 'ANULADA';
    saveState(state);
    return ok(v);
  }
  m = p.match(/^\/ventas\/([^/]+)\/delivery$/);
  if (m && method === 'PUT') {
    const v = state.ventas.find((x) => x.id === m![1]);
    if (!v) return notFound();
    saveState(state);
    return ok(v);
  }

  // ─── Encargos (pedidos para días futuros) ──────────────────────────
  if (p === '/encargos' && method === 'GET') {
    const desde = search.get('desde') ?? '0000-00-00';
    const hasta = search.get('hasta') ?? '9999-99-99';
    const encargos = state.encargos
      .filter((e) => e.estado !== 'ANULADA')
      .filter((e) => {
        const f = (e.fechaEntregaPromesa ?? '').slice(0, 10);
        return f >= desde && f <= hasta;
      })
      .map((e) => {
        const snap = e.deliveryInfo?.direccionSnapshot ?? {};
        return {
          id: e.id,
          numero: e.numero,
          numeroOrdenTurno: e.numeroOrdenTurno,
          estado: e.estado,
          total: e.total,
          tipoEntrega: e.tipoEntregaEncargo,
          fechaEntrega: (e.fechaEntregaPromesa ?? '').slice(0, 10),
          horaEntregaExacta: e.horaEntregaExacta,
          franjaEntrega: e.franjaEntrega,
          estadoCobro: e.estadoCobroEncargo,
          retiradoAt: e.retiradoAt ?? null,
          cliente: snap.clienteNombre ?? null,
          telefono: snap.clienteTelefono ?? null,
          itemsCount: e.items?.length ?? 0,
        };
      });
    return ok({ encargos });
  }
  // Marcar / desmarcar retiro (no toca la caja ni el estado de cobro).
  m = p.match(/^\/encargos\/([^/]+)\/retirar$/);
  if (m && method === 'POST') {
    const e = state.encargos.find((x) => x.id === m![1]);
    if (!e) return { status: 404, body: { error: 'Encargo no encontrado' } };
    const retirar = (body as { retirado?: boolean })?.retirado ?? true;
    e.retiradoAt = retirar ? new Date().toISOString() : null;
    saveState(state);
    return ok(e);
  }
  if (p === '/encargos' && method === 'POST') {
    const b = body as any;
    const num = Math.max(4100, ...state.encargos.map((e) => e.numero)) + 1;
    const items = (b.items || []).map((it: any, idx: number) => {
      const prod = findProducto(it.productoId);
      const delta = (it.modificadores || []).reduce((a: number, mm: any) => a + Number(mm.deltaPrecio || 0), 0);
      const precio = (prod ? Number(prod.precioBase) : 1000) + delta;
      const cant = Number(it.cantidad);
      const totalLinea = prod && prod.unidadPrecio === 'POR_KILO' ? (cant / 1000) * precio : cant * precio;
      const sabor = (it.modificadores || []).map((mm: any) => mm.opcionNombre).join(', ');
      return {
        id: `ei-${Date.now()}-${idx}`,
        productoId: it.productoId,
        nombreSnapshot: sabor ? `${prod?.nombre ?? 'Producto'} · ${sabor}` : prod?.nombre ?? 'Producto',
        cantidad: cant.toString(),
        unidad: prod?.formaVenta ?? 'UNIDAD',
        precioUnitario: precio.toString(),
        totalLinea: totalLinea.toString(),
        cocinaInterviene: prod?.tipoProducto.cocinaInterviene ?? false,
        modificadoresAplicados: (it.modificadores || []).map((mm: any) => ({ opcionNombre: mm.opcionNombre })),
        observacion: it.observacion ?? null,
      };
    });
    const total = items.reduce((a: number, i: any) => a + Number(i.totalLinea), 0);
    const esEnvio = b.tipoEntrega === 'ENVIO';
    const nueva = {
      id: `enc-${Date.now()}`,
      numero: num,
      numeroOrdenTurno: state.encargos.length + 30,
      canal: esEnvio ? 'TELEFONO' : 'MOSTRADOR',
      modalidad: esEnvio ? 'DELIVERY_PROPIO' : 'TAKE_AWAY',
      estado: 'PROCESADA',
      tieneCocina: items.some((i: any) => i.cocinaInterviene),
      fechaApertura: new Date().toISOString(),
      esEncargo: true,
      estadoCobroEncargo: 'A_PAGAR',
      tipoEntregaEncargo: b.tipoEntrega,
      fechaEntregaPromesa: b.fechaEntrega,
      horaEntregaExacta: b.horaEntregaExacta ?? null,
      franjaEntrega: b.franjaEntrega ?? null,
      subtotal: total.toFixed(2),
      total: total.toFixed(2),
      pagos: [],
      items,
      deliveryInfo: {
        direccionSnapshot: {
          clienteNombre: b.clienteNombre,
          clienteTelefono: b.clienteTelefono,
          direccion: esEnvio ? b.direccionEntrega : null,
          indicaciones: b.indicacionesEntrega ?? null,
          _retiro: !esEnvio,
        },
      },
    };
    state.encargos.push(nueva);
    saveState(state);
    return ok(nueva);
  }
  m = p.match(/^\/encargos\/([^/]+)$/);
  if (m && method === 'PATCH') {
    const e = state.encargos.find((x) => x.id === m![1]);
    if (!e) return notFound('Encargo no encontrado');
    const b = body as any;
    if (b.fechaEntrega) e.fechaEntregaPromesa = b.fechaEntrega;
    if (b.horaEntregaExacta !== undefined) e.horaEntregaExacta = b.horaEntregaExacta;
    if (b.franjaEntrega !== undefined) e.franjaEntrega = b.franjaEntrega;
    if (b.tipoEntrega !== undefined) e.tipoEntregaEncargo = b.tipoEntrega;
    if (!e.deliveryInfo) e.deliveryInfo = { direccionSnapshot: {} };
    const snap = e.deliveryInfo.direccionSnapshot;
    if (b.clienteNombre !== undefined) snap.clienteNombre = b.clienteNombre;
    if (b.clienteTelefono !== undefined) snap.clienteTelefono = b.clienteTelefono;
    if (b.direccionEntrega !== undefined) snap.direccion = b.direccionEntrega;
    if (b.indicacionesEntrega !== undefined) snap.indicaciones = b.indicacionesEntrega;
    saveState(state);
    return ok(e);
  }

  // ─── Admin: dashboard / stats ──────────────────────────────────────
  if (p === '/admin/dashboard' && method === 'GET') return ok(buildDashboard(state));
  if (p === '/admin/ventas-por-hora' && method === 'GET') return ok(ventasPorHora());
  if (p === '/admin/estadisticas' && method === 'GET') return ok(buildEstadisticas(state, search));
  if (p === '/admin/ventas-analisis' && method === 'GET') return ok(buildVentasAnalisis(state, search));

  // ─── Admin: cuentas ─────────────────────────────────────────────────
  if (p === '/admin/cuentas' && method === 'GET') {
    const cuentas = cuentasConSaldos(state);
    const total = cuentas.reduce((a, c) => a + Number(c.saldoActual), 0);
    return ok({ cuentas, totalSaldos: total.toString() });
  }
  if (p === '/admin/configuracion/cuentas' && method === 'GET') {
    return ok({ cuentas: cuentasSeed });
  }
  if (p === '/admin/configuracion/cuentas' && method === 'POST') return ok({ id: 'cu-new' });
  if (p.startsWith('/admin/configuracion/cuentas/') && method === 'PATCH') return ok({});
  if (p === '/admin/configuracion/posnets' && method === 'GET') {
    return ok({ posnets: [{ id: 'pos-1', nombre: 'POSNET Santander', cuentaId: 'cu-santander', marca: 'GETNET', activo: true }] });
  }
  if (p === '/admin/configuracion/posnets' && method === 'POST') return ok({ id: 'pos-new' });
  if (p.startsWith('/admin/configuracion/posnets/') && method === 'PATCH') return ok({});

  // ─── Admin: movimientos ────────────────────────────────────────────
  if (p === '/admin/movimientos' && method === 'GET') {
    return ok(buildMovimientosListado(state, search));
  }
  if (p === '/admin/movimientos' && method === 'POST') {
    const b = body as any;
    const nuevo = {
      id: `mv-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      fecha: b.fecha ?? new Date().toISOString(),
      tipo: b.tipo,
      categoria: categoriasMov.find((c) => c.id === b.categoriaId)?.nombre ?? '—',
      categoriaId: b.categoriaId,
      descripcion: b.descripcion ?? b.observacion ?? '',
      monto: b.monto?.toString() ?? '0',
      cuentaId: b.cuentaId ?? b.cuentaOrigenId ?? b.cuentaDestinoId,
      cuenta: cuentasSeed.find((c) => c.id === (b.cuentaId ?? b.cuentaOrigenId ?? b.cuentaDestinoId))?.nombre ?? '—',
      usuario: state.usuarioActivo.nombre,
    };
    state.movimientos.unshift(nuevo);
    saveState(state);
    return ok(nuevo);
  }
  if (p === '/admin/categorias-movimiento' && method === 'GET') {
    return ok({
      categorias: categoriasMov.map((c) => ({
        id: c.id,
        nombre: c.nombre,
        tipo: c.tipo,
        esOperativa: c.tipo === 'EGRESO',
      })),
    });
  }

  // ─── Admin: empleados ──────────────────────────────────────────────
  if (p === '/admin/empleados' && method === 'GET') return ok({ empleados: empleadosSeed });
  if (p === '/admin/empleados' && method === 'POST') return ok({ id: `emp-${Date.now()}` });
  m = p.match(/^\/admin\/empleados\/([^/]+)$/);
  if (m && method === 'GET') {
    const e = empleadosSeed.find((x) => x.id === m![1]);
    if (!e) return notFound();
    return ok({ empleado: e, movimientos: state.movimientos.filter((mv) => mv.descripcion.includes(e.nombre)).slice(0, 20), saldoCtaCte: e.saldoCtaCte });
  }
  if (m && method === 'PATCH') return ok({});
  m = p.match(/^\/admin\/empleados\/([^/]+)\/movimientos$/);
  if (m && method === 'POST') return ok({});

  // ─── Admin: clientes ───────────────────────────────────────────────
  if (p === '/admin/clientes' && method === 'GET') {
    return ok({ clientes: clientesSeed, total: clientesSeed.length });
  }
  if (p === '/admin/clientes' && method === 'POST') return ok({ id: `cli-${Date.now()}` });
  m = p.match(/^\/admin\/clientes\/([^/]+)$/);
  if (m && method === 'GET') {
    const c = clientesSeed.find((x) => x.id === m![1]);
    if (!c) return notFound();
    return ok({ cliente: c, ventasRecientes: [] });
  }
  if (m && method === 'PATCH') return ok({});
  m = p.match(/^\/admin\/clientes\/([^/]+)\/direcciones/);
  if (m) return ok({});

  // ─── Admin: insumos / proveedores ──────────────────────────────────
  if (p === '/admin/proveedores' && method === 'GET') return ok({ proveedores: proveedoresSeed });
  m = p.match(/^\/admin\/proveedores\/([^/]+)$/);
  if (m && method === 'GET') {
    const pr = proveedoresSeed.find((x) => x.id === m![1]);
    if (!pr) return notFound();
    return ok({ proveedor: pr, facturas: [], pagos: [], insumos: pr.insumos });
  }
  if (p === '/admin/insumos' && method === 'GET') {
    const insumos = proveedoresSeed.flatMap((pr) => pr.insumos.map((i) => ({ ...i, proveedorId: pr.id, proveedor: pr.nombre })));
    return ok({ insumos });
  }
  m = p.match(/^\/admin\/insumos\/([^/]+)$/);
  if (m && method === 'GET') {
    const all = proveedoresSeed.flatMap((pr) => pr.insumos.map((i) => ({ ...i, proveedorId: pr.id, proveedor: pr.nombre })));
    const i = all.find((x) => x.id === m![1]);
    if (!i) return notFound();
    return ok({ insumo: i, comprasRecientes: [] });
  }
  m = p.match(/^\/admin\/insumos\/([^/]+)\/compras$/);
  if (m && method === 'GET') return ok({ compras: [], total: 0, evolucionPrecio: [] });
  if (p === '/admin/pagos-multicuenta' && method === 'POST') return ok({});
  if (p === '/admin/pagos-a-cuenta' && method === 'POST') return ok({});
  m = p.match(/^\/admin\/facturas\/([^/]+)$/);
  if (m && method === 'GET') {
    return ok({ factura: { id: m![1], numero: 'A-0001-00012345', proveedor: 'Frigorífico La Plata', fechaEmision: new Date().toISOString(), fechaVencimiento: addDays(15), total: '145000', items: [], saldo: '145000', estado: 'PENDIENTE' } });
  }

  // ─── Admin: productos / sabores / combos ───────────────────────────
  if (p === '/admin/productos' && method === 'GET') {
    return ok(buildProductosListado(search));
  }
  m = p.match(/^\/admin\/productos\/([^/]+)\/historial$/);
  if (m && method === 'GET') {
    return ok({ historial: [
      { id: 'h1', precioAnterior: '1400', precioNuevo: '1500', fechaCambio: addDays(-30), motivo: 'Ajuste de precios', lista: { nombre: 'Lista general' } },
      { id: 'h2', precioAnterior: '1200', precioNuevo: '1400', fechaCambio: addDays(-90), motivo: 'Aumento por inflación', lista: { nombre: 'Lista general' } },
    ] });
  }
  m = p.match(/^\/admin\/productos\/([^/]+)\/sabores$/);
  if (m && method === 'POST') return ok({ id: 'sab-new' });
  m = p.match(/^\/admin\/productos\/([^/]+)$/);
  if (m && (method === 'PATCH' || method === 'DELETE')) return ok({});
  m = p.match(/^\/admin\/sabores\/([^/]+)$/);
  if (m && (method === 'PATCH' || method === 'DELETE')) return ok({});
  if (p === '/admin/tipos-producto' && method === 'GET') {
    return ok({ tipos: categorias.flatMap((c) => c.tipos.map((t) => ({ ...t, categoria: { id: c.id, nombre: c.nombre } }))) });
  }
  m = p.match(/^\/admin\/grupos-modificadores\/([^/]+)\/opciones$/);
  if (m && method === 'GET') {
    const gm = [grupoModRavioles, grupoModSorrentinos, grupoModCanelones, grupoModSalsa].find((g) => g.id === m![1]);
    return ok({ grupo: gm ? { id: gm.id, nombre: gm.nombre } : null, opciones: gm?.opciones ?? [] });
  }
  if (p === '/admin/combos' && method === 'GET') {
    return ok({ combos: [
      {
        id: 'combo-1', nombre: 'Combo Familiar', descripcion: 'Pasta + salsa + bebida',
        descuentoPct: '15', activo: true,
        componentes: [
          { id: 'c1', tipoComponente: 'PRODUCTO_FIJO', productoId: 'p-0011', nombreProducto: 'Ravioles tradicionales', cantidad: 2 },
          { id: 'c2', tipoComponente: 'PRODUCTO_FIJO', productoId: 'p-0031', nombreProducto: 'Salsa casera', cantidad: 1 },
          { id: 'c3', tipoComponente: 'PRODUCTO_FIJO', productoId: 'p-0061', nombreProducto: 'Coca-Cola 1.5L', cantidad: 1 },
        ],
      },
    ] });
  }
  if (p === '/admin/combos' && method === 'POST') return ok({ id: 'combo-new' });
  if (p === '/admin/combos/detectar' && method === 'POST') return ok({ detectados: [] });
  m = p.match(/^\/admin\/combos\/([^/]+)$/);
  if (m && (method === 'PATCH' || method === 'DELETE')) return ok({});

  // ─── Admin: precios ───────────────────────────────────────────────
  if (p === '/admin/precios/lista' && method === 'GET') return ok(buildPreciosLista(search));
  if (p === '/admin/precios/historial' && method === 'GET') return ok(buildPreciosHistorial());
  if (p === '/admin/precios/aprobaciones' && method === 'GET') {
    return ok({ aprobaciones: buildPreciosAprobaciones() });
  }
  m = p.match(/^\/admin\/precios\/aprobaciones\/([^/]+)$/);
  if (m && method === 'GET') {
    const id = m[1];
    if (!id) return notFound();
    const det = buildAprobacionDetalle(id);
    if (!det) return notFound();
    return ok(det);
  }
  m = p.match(/^\/admin\/precios\/aprobaciones\/([^/]+)\/(aplicar|rechazar|posponer)$/);
  if (m && method === 'POST') return ok({});
  if (p === '/admin/precios/buscar-cambios' && method === 'POST') {
    return ok({
      resultados: [
        { fuente: 'DRIVE', aprobacionId: 'aprob-1', cambiosAplicables: 12, sospechosos: 1, errores: 1 },
      ],
      errores: [],
    });
  }

  // ─── Admin: caja sesion / cierres ──────────────────────────────────
  if (p === '/admin/caja/sesion-actual' && method === 'GET') return ok(buildSesionActual(state));
  if (p === '/admin/caja/sesion-actual/cerrar' && method === 'POST') return ok({});
  m = p.match(/^\/admin\/caja\/sesion\/([^/]+)\/aprobar$/);
  if (m && method === 'POST') return ok({});
  m = p.match(/^\/admin\/caja\/sesion\/([^/]+)\/enviar-email$/);
  if (m && method === 'POST') return ok({ ok: true, recipients: ['encargada@example.com', 'alejolafalce@gmail.com'], previewUrl: null, isEthereal: false });
  m = p.match(/^\/admin\/caja\/sesion\/([^/]+)\/sincronizar-excel$/);
  if (m && method === 'POST') return ok({ ok: true, sincronizado: true });
  if (p === '/admin/caja/cierres' && method === 'GET') {
    return ok({ sesiones: buildCierres() });
  }

  // ─── Admin: configuración / usuarios / parámetros ──────────────────
  if (p === '/admin/usuarios' && method === 'GET') {
    return ok({ usuarios: [
      { id: 'u-julio', nombre: 'Julio (Dueño)', rol: 'ADMIN', activo: true, ultimoIngreso: new Date(Date.now() - 60000 * 30).toISOString() },
      { id: 'u-encargada', nombre: 'María (Encargada)', rol: 'ADMIN', activo: true, ultimoIngreso: new Date(Date.now() - 60000 * 60 * 3).toISOString() },
      { id: 'u-vendedor', nombre: 'Vendedor', rol: 'VENDEDOR', activo: true, ultimoIngreso: new Date().toISOString() },
    ] });
  }
  if (p === '/admin/usuarios' && method === 'POST') return ok({ id: `u-${Date.now()}` });
  m = p.match(/^\/admin\/usuarios\/([^/]+)$/);
  if (m && method === 'PATCH') return ok({});
  m = p.match(/^\/admin\/usuarios\/([^/]+)\/reset-pin$/);
  if (m && method === 'POST') return ok({});
  if (p === '/admin/configuracion/parametros' && method === 'GET') {
    return ok({ parametros: [
      { clave: 'descuento_efectivo_pct', valor: '10', tipo: 'NUMBER', descripcion: 'Descuento al efectivo en mostrador' },
      { clave: 'mostrar_redes_en_ticket', valor: 'true', tipo: 'BOOLEAN', descripcion: 'Mostrar @santateresita en ticket' },
      { clave: 'horas_apertura_manana', valor: '09:00', tipo: 'STRING', descripcion: 'Hora apertura turno mañana' },
      { clave: 'horas_apertura_tarde', valor: '17:00', tipo: 'STRING', descripcion: 'Hora apertura turno tarde' },
    ] });
  }
  m = p.match(/^\/admin\/configuracion\/parametros\/([^/]+)$/);
  if (m && method === 'PATCH') return ok({});

  // ─── Admin: mayoristas / cuenta corriente ──────────────────────────
  if (p === '/admin/mayoristas' && method === 'GET') {
    return ok({
      clientes: MAYORISTAS_DEMO.map((m2) => {
        const { saldo } = mayoristaTotales(m2);
        return {
          id: m2.id,
          nombre: m2.nombre,
          cuit: m2.cuit,
          telefono: m2.telefono,
          activo: m2.activo,
          lista: m2.lista,
          saldo: saldo.toFixed(2),
        };
      }),
    });
  }
  if (p === '/admin/mayoristas' && method === 'POST') return ok({ id: 'may-new' });
  if (p === '/admin/mayoristas/listas' && method === 'GET') {
    return ok({
      listas: [
        { id: 'lm-a', nombre: 'Mayorista A' },
        { id: 'lm-b', nombre: 'Mayorista B' },
      ],
    });
  }
  // Anular remito: /admin/mayoristas/remitos/:remitoId/anular (va antes del :id genérico).
  m = p.match(/^\/admin\/mayoristas\/remitos\/([^/]+)\/anular$/);
  if (m && method === 'POST') return ok({});
  m = p.match(/^\/admin\/mayoristas\/([^/]+)\/catalogo$/);
  if (m && method === 'GET') {
    return ok(mayoristaCatalogo(MAYORISTAS_DEMO.find((x) => x.id === m![1])));
  }
  m = p.match(/^\/admin\/mayoristas\/([^/]+)\/remitos$/);
  if (m && method === 'POST') return ok({ id: 'rem-new' });
  m = p.match(/^\/admin\/mayoristas\/([^/]+)\/cobros$/);
  if (m && method === 'POST') return ok({});
  m = p.match(/^\/admin\/mayoristas\/([^/]+)$/);
  if (m && method === 'GET') {
    const may = MAYORISTAS_DEMO.find((x) => x.id === m![1]);
    if (!may) return notFound('Cliente no encontrado');
    const { remitado, cobrado, saldo } = mayoristaTotales(may);
    return ok({
      cliente: {
        id: may.id,
        nombre: may.nombre,
        cuit: may.cuit,
        contacto: may.contacto,
        telefono: may.telefono,
        email: may.email,
        direccion: may.direccion,
        observaciones: may.observaciones,
        activo: may.activo,
        lista: may.lista,
      },
      saldo: saldo.toFixed(2),
      totales: { remitado: remitado.toFixed(2), cobrado: cobrado.toFixed(2) },
      remitos: may.remitos,
      cobros: may.cobros,
    });
  }
  m = p.match(/^\/admin\/mayoristas\/([^/]+)$/);
  if (m && method === 'PATCH') return ok({});

  // ─── Fallback ──────────────────────────────────────────────────────
  console.warn('[demo] mock no implementado:', method, p);
  return ok({});
}
