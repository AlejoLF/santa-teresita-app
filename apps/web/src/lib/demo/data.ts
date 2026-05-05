/**
 * Datos de demostración. Realistas pero ficticios.
 * Todo número en strings (la API real devuelve Decimals como string).
 */

const id = (slug: string) => slug; // ids no-uuid pero estables para la demo

// ─── Categorías y tipos de producto ────────────────────────────────────

export const categorias = [
  {
    id: id('cat-pastas-frescas'),
    nombre: 'Pastas frescas',
    icono: '🍝',
    orden: 1,
    activa: true,
    tipos: [
      { id: id('tp-ravioles'), nombre: 'Ravioles', cocinaInterviene: false, activo: true, orden: 1, categoriaId: id('cat-pastas-frescas') },
      { id: id('tp-sorrentinos'), nombre: 'Sorrentinos', cocinaInterviene: false, activo: true, orden: 2, categoriaId: id('cat-pastas-frescas') },
      { id: id('tp-noquis'), nombre: 'Ñoquis', cocinaInterviene: false, activo: true, orden: 3, categoriaId: id('cat-pastas-frescas') },
      { id: id('tp-tallarines'), nombre: 'Tallarines', cocinaInterviene: false, activo: true, orden: 4, categoriaId: id('cat-pastas-frescas') },
      { id: id('tp-fideos'), nombre: 'Fideos secos', cocinaInterviene: false, activo: true, orden: 5, categoriaId: id('cat-pastas-frescas') },
    ],
  },
  {
    id: id('cat-rellenos'),
    nombre: 'Rellenos al horno',
    icono: '🥧',
    orden: 2,
    activa: true,
    tipos: [
      { id: id('tp-canelones'), nombre: 'Canelones', cocinaInterviene: true, activo: true, orden: 1, categoriaId: id('cat-rellenos') },
      { id: id('tp-lasagna'), nombre: 'Lasaña', cocinaInterviene: true, activo: true, orden: 2, categoriaId: id('cat-rellenos') },
      { id: id('tp-fugazzeta'), nombre: 'Fugazzeta', cocinaInterviene: true, activo: true, orden: 3, categoriaId: id('cat-rellenos') },
    ],
  },
  {
    id: id('cat-salsas'),
    nombre: 'Salsas caseras',
    icono: '🥫',
    orden: 3,
    activa: true,
    tipos: [
      { id: id('tp-salsa'), nombre: 'Salsa', cocinaInterviene: false, activo: true, orden: 1, categoriaId: id('cat-salsas') },
      { id: id('tp-pesto'), nombre: 'Pesto', cocinaInterviene: false, activo: true, orden: 2, categoriaId: id('cat-salsas') },
    ],
  },
  {
    id: id('cat-tartas'),
    nombre: 'Tartas',
    icono: '🥮',
    orden: 4,
    activa: true,
    tipos: [
      { id: id('tp-tarta'), nombre: 'Tarta', cocinaInterviene: false, activo: true, orden: 1, categoriaId: id('cat-tartas') },
    ],
  },
  {
    id: id('cat-estanteria'),
    nombre: 'Estantería',
    icono: '🏪',
    orden: 5,
    activa: true,
    tipos: [
      { id: id('tp-conservas'), nombre: 'Conservas', cocinaInterviene: false, activo: true, orden: 1, categoriaId: id('cat-estanteria') },
      { id: id('tp-aceites'), nombre: 'Aceites', cocinaInterviene: false, activo: true, orden: 2, categoriaId: id('cat-estanteria') },
      { id: id('tp-quesos'), nombre: 'Quesos y embutidos', cocinaInterviene: false, activo: true, orden: 3, categoriaId: id('cat-estanteria') },
    ],
  },
  {
    id: id('cat-bebidas'),
    nombre: 'Bebidas',
    icono: '🥤',
    orden: 6,
    activa: true,
    tipos: [
      { id: id('tp-gaseosas'), nombre: 'Gaseosas y aguas', cocinaInterviene: false, activo: true, orden: 1, categoriaId: id('cat-bebidas') },
      { id: id('tp-vinos'), nombre: 'Vinos y cervezas', cocinaInterviene: false, activo: true, orden: 2, categoriaId: id('cat-bebidas') },
    ],
  },
];

// ─── Modificadores (sabores) ──────────────────────────────────────────

export const grupoModRavioles = {
  id: id('gm-ravioles'),
  nombre: 'Sabor — Ravioles',
  obligatorio: true,
  tipoSeleccion: 'UNICA' as const,
  opciones: [
    { id: id('op-rav-ricota-esp'), nombre: 'Ricota y espinaca', deltaPrecio: '0', activa: true, orden: 1 },
    { id: id('op-rav-cuatro-q'), nombre: 'Cuatro quesos', deltaPrecio: '300', activa: true, orden: 2 },
    { id: id('op-rav-jam-q'), nombre: 'Jamón y queso', deltaPrecio: '300', activa: true, orden: 3 },
    { id: id('op-rav-verdura'), nombre: 'Verdura', deltaPrecio: '0', activa: true, orden: 4 },
    { id: id('op-rav-calabaza'), nombre: 'Calabaza y queso', deltaPrecio: '200', activa: true, orden: 5 },
  ],
};

export const grupoModSorrentinos = {
  id: id('gm-sorrentinos'),
  nombre: 'Sabor — Sorrentinos',
  obligatorio: true,
  tipoSeleccion: 'UNICA' as const,
  opciones: [
    { id: id('op-sor-jam-mozza'), nombre: 'Jamón y mozzarella', deltaPrecio: '0', activa: true, orden: 1 },
    { id: id('op-sor-pollo-verd'), nombre: 'Pollo y verdeo', deltaPrecio: '400', activa: true, orden: 2 },
    { id: id('op-sor-verdura'), nombre: 'Verdura', deltaPrecio: '0', activa: true, orden: 3 },
    { id: id('op-sor-cuatro-q'), nombre: 'Cuatro quesos', deltaPrecio: '500', activa: true, orden: 4 },
  ],
};

export const grupoModCanelones = {
  id: id('gm-canelones'),
  nombre: 'Sabor — Canelones',
  obligatorio: true,
  tipoSeleccion: 'UNICA' as const,
  opciones: [
    { id: id('op-can-verdura'), nombre: 'Verdura', deltaPrecio: '0', activa: true, orden: 1 },
    { id: id('op-can-carne'), nombre: 'Carne', deltaPrecio: '200', activa: true, orden: 2 },
    { id: id('op-can-esp-ric'), nombre: 'Espinaca y ricota', deltaPrecio: '100', activa: true, orden: 3 },
  ],
};

export const grupoModSalsa = {
  id: id('gm-salsa'),
  nombre: 'Tipo — Salsa',
  obligatorio: true,
  tipoSeleccion: 'UNICA' as const,
  opciones: [
    { id: id('op-sal-bolognesa'), nombre: 'Bolognesa', deltaPrecio: '0', activa: true, orden: 1 },
    { id: id('op-sal-filetto'), nombre: 'Filetto', deltaPrecio: '0', activa: true, orden: 2 },
    { id: id('op-sal-crema'), nombre: 'Crema', deltaPrecio: '0', activa: true, orden: 3 },
    { id: id('op-sal-pomarola'), nombre: 'Pomarola', deltaPrecio: '0', activa: true, orden: 4 },
  ],
};

// ─── Productos ────────────────────────────────────────────────────────

interface ProductoSeed {
  id: string;
  codigo: string;
  nombre: string;
  marca?: string | null;
  presentacion?: string | null;
  precioBase: string;
  formaVenta: 'UNIDAD' | 'GRAMO' | 'PLANCHA' | 'PORCION';
  unidadPrecio: 'POR_UNIDAD' | 'POR_GRAMO' | 'POR_KILO' | 'POR_PORCION' | 'POR_PLANCHA' | 'POR_DOCENA';
  cantidadDefault: string | null;
  tipoId: string;
  grupoMod?: typeof grupoModRavioles | null;
  activo: boolean;
}

export const productosSeed: ProductoSeed[] = [
  // Pastas frescas
  { id: id('p-0011'), codigo: '0011', nombre: 'Ravioles tradicionales', precioBase: '1500', formaVenta: 'UNIDAD', unidadPrecio: 'POR_DOCENA', cantidadDefault: '1', tipoId: id('tp-ravioles'), grupoMod: grupoModRavioles, activo: true },
  { id: id('p-0012'), codigo: '0012', nombre: 'Sorrentinos caseros', precioBase: '1800', formaVenta: 'UNIDAD', unidadPrecio: 'POR_DOCENA', cantidadDefault: '1', tipoId: id('tp-sorrentinos'), grupoMod: grupoModSorrentinos, activo: true },
  { id: id('p-0013'), codigo: '0013', nombre: 'Ñoquis de papa', precioBase: '1200', formaVenta: 'PORCION', unidadPrecio: 'POR_PORCION', cantidadDefault: '1', tipoId: id('tp-noquis'), activo: true },
  { id: id('p-0014'), codigo: '0014', nombre: 'Tallarines al huevo', precioBase: '1100', formaVenta: 'PORCION', unidadPrecio: 'POR_PORCION', cantidadDefault: '1', tipoId: id('tp-tallarines'), activo: true },
  { id: id('p-0015'), codigo: '0015', nombre: 'Fideos secos por kilo', precioBase: '4500', formaVenta: 'GRAMO', unidadPrecio: 'POR_KILO', cantidadDefault: '500', tipoId: id('tp-fideos'), activo: true },
  // Rellenos
  { id: id('p-0021'), codigo: '0021', nombre: 'Canelones', precioBase: '1600', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-canelones'), grupoMod: grupoModCanelones, activo: true },
  { id: id('p-0022'), codigo: '0022', nombre: 'Lasaña casera', precioBase: '1800', formaVenta: 'PORCION', unidadPrecio: 'POR_PORCION', cantidadDefault: '1', tipoId: id('tp-lasagna'), activo: true },
  { id: id('p-0023'), codigo: '0023', nombre: 'Fugazzeta', precioBase: '1500', formaVenta: 'PORCION', unidadPrecio: 'POR_PORCION', cantidadDefault: '1', tipoId: id('tp-fugazzeta'), activo: true },
  // Salsas
  { id: id('p-0031'), codigo: '0031', nombre: 'Salsa casera', precioBase: '800', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-salsa'), grupoMod: grupoModSalsa, activo: true },
  { id: id('p-0032'), codigo: '0032', nombre: 'Pesto fresco', precioBase: '1200', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-pesto'), activo: true },
  // Tartas
  { id: id('p-0041'), codigo: '0041', nombre: 'Tarta pascualina', precioBase: '1400', formaVenta: 'PORCION', unidadPrecio: 'POR_PORCION', cantidadDefault: '1', tipoId: id('tp-tarta'), activo: true },
  { id: id('p-0042'), codigo: '0042', nombre: 'Tarta de ricota', precioBase: '1400', formaVenta: 'PORCION', unidadPrecio: 'POR_PORCION', cantidadDefault: '1', tipoId: id('tp-tarta'), activo: true },
  { id: id('p-0043'), codigo: '0043', nombre: 'Tarta de verdura', precioBase: '1400', formaVenta: 'PORCION', unidadPrecio: 'POR_PORCION', cantidadDefault: '1', tipoId: id('tp-tarta'), activo: true },
  // Estantería (con marca)
  { id: id('p-0051'), codigo: '0051', nombre: 'Tomate triturado', marca: 'La Campagnola', presentacion: '520g', precioBase: '1200', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-conservas'), activo: true },
  { id: id('p-0052'), codigo: '0052', nombre: 'Tomates en cubos', marca: 'Cica', presentacion: '400g', precioBase: '1100', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-conservas'), activo: true },
  { id: id('p-0053'), codigo: '0053', nombre: 'Atún en aceite', marca: 'Gomes da Costa', presentacion: '170g', precioBase: '1800', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-conservas'), activo: true },
  { id: id('p-0054'), codigo: '0054', nombre: 'Aceitunas verdes', marca: 'Argenfrut', presentacion: '300g', precioBase: '1500', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-conservas'), activo: true },
  { id: id('p-0055'), codigo: '0055', nombre: 'Aceite girasol', marca: 'Cocinero', presentacion: '900ml', precioBase: '2400', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-aceites'), activo: true },
  { id: id('p-0056'), codigo: '0056', nombre: 'Aceite de oliva', marca: 'Krol', presentacion: '500ml', precioBase: '5800', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-aceites'), activo: true },
  { id: id('p-0057'), codigo: '0057', nombre: 'Queso rallado', marca: 'Tregar', presentacion: '120g', precioBase: '1500', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-quesos'), activo: true },
  { id: id('p-0058'), codigo: '0058', nombre: 'Mozzarella', marca: 'Punta del Agua', presentacion: 'horma 250g', precioBase: '2800', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-quesos'), activo: true },
  // Bebidas
  { id: id('p-0061'), codigo: '0061', nombre: 'Coca-Cola', marca: 'Coca-Cola', presentacion: '1.5L', precioBase: '2500', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-gaseosas'), activo: true },
  { id: id('p-0062'), codigo: '0062', nombre: 'Sprite', marca: 'Coca-Cola', presentacion: '1.5L', precioBase: '2500', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-gaseosas'), activo: true },
  { id: id('p-0063'), codigo: '0063', nombre: 'Agua sin gas', marca: 'Villa del Sur', presentacion: '1.5L', precioBase: '1100', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-gaseosas'), activo: true },
  { id: id('p-0064'), codigo: '0064', nombre: 'Vino Malbec', marca: 'Norton', presentacion: '750ml', precioBase: '4500', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-vinos'), activo: true },
  { id: id('p-0065'), codigo: '0065', nombre: 'Vino Cabernet', marca: 'San Felipe Roble', presentacion: '750ml', precioBase: '5500', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-vinos'), activo: true },
  { id: id('p-0066'), codigo: '0066', nombre: 'Cerveza', marca: 'Quilmes', presentacion: '1L', precioBase: '1800', formaVenta: 'UNIDAD', unidadPrecio: 'POR_UNIDAD', cantidadDefault: '1', tipoId: id('tp-vinos'), activo: true },
];

// ─── Cuentas ──────────────────────────────────────────────────────────

export const cuentasSeed = [
  { id: id('cu-caja'), nombre: 'Caja física', tipo: 'EFECTIVO', saldoActual: '345200', activa: true },
  { id: id('cu-santander'), nombre: 'Santander', tipo: 'BANCO', saldoActual: '1287400', activa: true },
  { id: id('cu-galicia'), nombre: 'Galicia', tipo: 'BANCO', saldoActual: '982150', activa: true },
  { id: id('cu-mp'), nombre: 'MercadoPago', tipo: 'DIGITAL', saldoActual: '423800', activa: true },
  { id: id('cu-bapro'), nombre: 'Cuenta DNI BAPRO', tipo: 'BANCO', saldoActual: '156900', activa: true },
];

// ─── Categorías de movimiento ─────────────────────────────────────────

export const categoriasMov = [
  { id: id('cm-aporte'), nombre: 'Aporte de socio', tipo: 'INGRESO' },
  { id: id('cm-cobro-rappi'), nombre: 'Cobro RAPPI', tipo: 'INGRESO' },
  { id: id('cm-cobro-pya'), nombre: 'Cobro Pedidos YA', tipo: 'INGRESO' },
  { id: id('cm-cobro-meli'), nombre: 'Cobro Mercado Libre', tipo: 'INGRESO' },
  { id: id('cm-sueldo'), nombre: 'Sueldo', tipo: 'EGRESO' },
  { id: id('cm-servicios'), nombre: 'Servicios (luz, gas, agua)', tipo: 'EGRESO' },
  { id: id('cm-insumos'), nombre: 'Insumos / mercadería', tipo: 'EGRESO' },
  { id: id('cm-alquiler'), nombre: 'Alquiler', tipo: 'EGRESO' },
  { id: id('cm-transporte'), nombre: 'Transporte / nafta', tipo: 'EGRESO' },
  { id: id('cm-imp'), nombre: 'Impuestos', tipo: 'EGRESO' },
];

// ─── Empleados ────────────────────────────────────────────────────────

export const empleadosSeed = [
  { id: id('emp-1'), nombre: 'María', apellido: 'Pérez', rol: 'ENCARGADA', activo: true, fechaIngreso: '2022-03-15', valorHora: '3500', saldoCtaCte: '0' },
  { id: id('emp-2'), nombre: 'Lucía', apellido: 'González', rol: 'CAJERA', activo: true, fechaIngreso: '2024-08-01', valorHora: '2800', saldoCtaCte: '-15000' },
  { id: id('emp-3'), nombre: 'Camila', apellido: 'Rodríguez', rol: 'CAJERA', activo: true, fechaIngreso: '2025-01-10', valorHora: '2800', saldoCtaCte: '0' },
  { id: id('emp-4'), nombre: 'Damián', apellido: 'Acosta', rol: 'MOTOQUERO', activo: true, fechaIngreso: '2023-06-20', valorHora: '2500', saldoCtaCte: '0' },
  { id: id('emp-5'), nombre: 'Hernán', apellido: 'Suárez', rol: 'COCINERO', activo: true, fechaIngreso: '2021-11-04', valorHora: '3800', saldoCtaCte: '-32000' },
];

// ─── Clientes ─────────────────────────────────────────────────────────

export const clientesSeed = [
  { id: id('cli-1'), nombre: 'Carlos Martínez', telefono: '221-555-0101', email: 'carlos.m@example.com', notas: 'Pide siempre canelones de carne', creadoAt: '2024-05-12T10:00:00Z', direcciones: [{ id: 'd1', calle: 'Calle 12', numero: '345', piso: '3°B', barrio: 'Centro', referencia: 'Edificio gris', principal: true }] },
  { id: id('cli-2'), nombre: 'Florencia López', telefono: '221-555-0234', email: null, notas: '', creadoAt: '2024-09-22T15:30:00Z', direcciones: [] },
  { id: id('cli-3'), nombre: 'Restaurante La Esquina', telefono: '221-555-0876', email: 'compras@laesquina.ar', notas: 'Cliente mayorista — pide ravioles los viernes', creadoAt: '2023-11-08T09:15:00Z', direcciones: [{ id: 'd2', calle: 'Av. 7', numero: '1450', piso: null, barrio: 'Casco Urbano', referencia: 'Esquina', principal: true }] },
  { id: id('cli-4'), nombre: 'Marta García', telefono: '221-555-0492', email: null, notas: 'Vegetariana', creadoAt: '2025-02-14T18:45:00Z', direcciones: [{ id: 'd3', calle: 'Calle 50', numero: '2380', piso: 'PB', barrio: 'La Loma', referencia: '', principal: true }] },
];

// ─── Insumos / Proveedores ────────────────────────────────────────────

export const proveedoresSeed = [
  {
    id: id('prov-1'),
    nombre: 'Harinas Argentinas SA',
    cuit: '30-12345678-9',
    contacto: 'Roberto Núñez',
    telefono: '221-555-9911',
    email: 'pedidos@harinasarg.com',
    saldoCtaCte: '-87500',
    facturasPendientes: 2,
    insumos: [
      { id: id('ins-1'), nombre: 'Harina 000', presentacion: 'Bolsa 25kg', ultimoPrecio: '12500' },
      { id: id('ins-2'), nombre: 'Harina 0000', presentacion: 'Bolsa 25kg', ultimoPrecio: '13800' },
    ],
  },
  {
    id: id('prov-2'),
    nombre: 'Frigorífico La Plata',
    cuit: '30-23456789-0',
    contacto: 'Marcos Vázquez',
    telefono: '221-555-2233',
    email: 'ventas@frigorifico.ar',
    saldoCtaCte: '-145000',
    facturasPendientes: 3,
    insumos: [
      { id: id('ins-3'), nombre: 'Carne picada especial', presentacion: 'Bolsa 5kg', ultimoPrecio: '38000' },
      { id: id('ins-4'), nombre: 'Jamón cocido', presentacion: 'Pieza 4kg', ultimoPrecio: '42000' },
    ],
  },
  {
    id: id('prov-3'),
    nombre: 'Lácteos Tregar',
    cuit: '30-34567890-1',
    contacto: 'Adriana Pérez',
    telefono: '221-555-3344',
    email: 'distribucion@tregar.com',
    saldoCtaCte: '0',
    facturasPendientes: 0,
    insumos: [
      { id: id('ins-5'), nombre: 'Mozzarella block', presentacion: 'Block 5kg', ultimoPrecio: '32000' },
      { id: id('ins-6'), nombre: 'Ricota fresca', presentacion: 'Tacho 2kg', ultimoPrecio: '8200' },
      { id: id('ins-7'), nombre: 'Queso parmesano', presentacion: 'Horma 1.5kg', ultimoPrecio: '18000' },
    ],
  },
  {
    id: id('prov-4'),
    nombre: 'Distribuidora Bebidas SA',
    cuit: '30-45678901-2',
    contacto: 'Juan Manuel Acosta',
    telefono: '221-555-4455',
    email: 'pedidos@distbebidas.ar',
    saldoCtaCte: '-23400',
    facturasPendientes: 1,
    insumos: [
      { id: id('ins-8'), nombre: 'Coca-Cola 1.5L', presentacion: 'Pack x6', ultimoPrecio: '9600' },
      { id: id('ins-9'), nombre: 'Quilmes 1L', presentacion: 'Pack x12', ultimoPrecio: '14400' },
    ],
  },
];

// ─── Helpers de venta histórica ───────────────────────────────────────

export interface VentaSeed {
  id: string;
  numero: number;
  numeroOrdenTurno: number;
  canal: string;
  modalidad: string;
  estado: 'PROCESADA' | 'FINALIZADA' | 'ANULADA';
  total: string;
  subtotal: string;
  fechaApertura: string;
  fechaFinalizacion?: string;
  items: Array<{
    id: string;
    productoId: string;
    nombreSnapshot: string;
    cantidad: string;
    unidad: string;
    precioUnitario: string;
    totalLinea: string;
    cocinaInterviene: boolean;
    modificadoresAplicados: Array<{ opcionNombre: string }> | null;
    observacion?: string | null;
  }>;
  pagos: Array<{ id: string; metodo: string; monto: string; cuentaId?: string }>;
  tieneCocina: boolean;
}

const HOY = new Date();
const fechaHoy = (h: number, m: number) => {
  const d = new Date(HOY);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

let ventaCounter = 1000;

export const ventasIniciales: VentaSeed[] = [
  {
    id: id('v-1001'),
    numero: ++ventaCounter,
    numeroOrdenTurno: 1,
    canal: 'MOSTRADOR',
    modalidad: 'TAKE_AWAY',
    estado: 'FINALIZADA',
    total: '4500',
    subtotal: '4500',
    fechaApertura: fechaHoy(10, 15),
    fechaFinalizacion: fechaHoy(10, 18),
    items: [
      { id: 'i1', productoId: id('p-0011'), nombreSnapshot: 'Ravioles tradicionales · Ricota y espinaca', cantidad: '3', unidad: 'UNIDAD', precioUnitario: '1500', totalLinea: '4500', cocinaInterviene: false, modificadoresAplicados: [{ opcionNombre: 'Ricota y espinaca' }] },
    ],
    pagos: [{ id: 'pg1', metodo: 'EFECTIVO', monto: '4500', cuentaId: id('cu-caja') }],
    tieneCocina: false,
  },
  {
    id: id('v-1002'),
    numero: ++ventaCounter,
    numeroOrdenTurno: 2,
    canal: 'MOSTRADOR',
    modalidad: 'TAKE_AWAY',
    estado: 'FINALIZADA',
    total: '7200',
    subtotal: '7200',
    fechaApertura: fechaHoy(11, 5),
    fechaFinalizacion: fechaHoy(11, 8),
    items: [
      { id: 'i2', productoId: id('p-0022'), nombreSnapshot: 'Lasaña casera', cantidad: '2', unidad: 'PORCION', precioUnitario: '1800', totalLinea: '3600', cocinaInterviene: true, modificadoresAplicados: null },
      { id: 'i3', productoId: id('p-0031'), nombreSnapshot: 'Salsa casera · Bolognesa', cantidad: '2', unidad: 'UNIDAD', precioUnitario: '800', totalLinea: '1600', cocinaInterviene: false, modificadoresAplicados: [{ opcionNombre: 'Bolognesa' }] },
      { id: 'i4', productoId: id('p-0061'), nombreSnapshot: 'Coca-Cola · 1.5L', cantidad: '1', unidad: 'UNIDAD', precioUnitario: '2500', totalLinea: '2500', cocinaInterviene: false, modificadoresAplicados: null },
    ],
    pagos: [{ id: 'pg2', metodo: 'DEBITO', monto: '7700', cuentaId: id('cu-santander') }],
    tieneCocina: true,
  },
  {
    id: id('v-1003'),
    numero: ++ventaCounter,
    numeroOrdenTurno: 3,
    canal: 'PEDIDOS_YA',
    modalidad: 'DELIVERY_PLATAFORMA',
    estado: 'FINALIZADA',
    total: '5400',
    subtotal: '5400',
    fechaApertura: fechaHoy(12, 30),
    fechaFinalizacion: fechaHoy(12, 35),
    items: [
      { id: 'i5', productoId: id('p-0012'), nombreSnapshot: 'Sorrentinos caseros · Jamón y mozzarella', cantidad: '3', unidad: 'UNIDAD', precioUnitario: '1800', totalLinea: '5400', cocinaInterviene: false, modificadoresAplicados: [{ opcionNombre: 'Jamón y mozzarella' }] },
    ],
    pagos: [{ id: 'pg3', metodo: 'MERCADOPAGO_QR', monto: '5400', cuentaId: id('cu-mp') }],
    tieneCocina: false,
  },
  {
    id: id('v-1004'),
    numero: ++ventaCounter,
    numeroOrdenTurno: 4,
    canal: 'MOSTRADOR',
    modalidad: 'TAKE_AWAY',
    estado: 'FINALIZADA',
    total: '8950',
    subtotal: '8950',
    fechaApertura: fechaHoy(13, 10),
    fechaFinalizacion: fechaHoy(13, 14),
    items: [
      { id: 'i6', productoId: id('p-0011'), nombreSnapshot: 'Ravioles tradicionales · Cuatro quesos', cantidad: '2', unidad: 'UNIDAD', precioUnitario: '1800', totalLinea: '3600', cocinaInterviene: false, modificadoresAplicados: [{ opcionNombre: 'Cuatro quesos' }] },
      { id: 'i7', productoId: id('p-0041'), nombreSnapshot: 'Tarta pascualina', cantidad: '2', unidad: 'PORCION', precioUnitario: '1400', totalLinea: '2800', cocinaInterviene: false, modificadoresAplicados: null },
      { id: 'i8', productoId: id('p-0064'), nombreSnapshot: 'Vino Malbec Norton', cantidad: '1', unidad: 'UNIDAD', precioUnitario: '4500', totalLinea: '4500', cocinaInterviene: false, modificadoresAplicados: null },
    ],
    pagos: [{ id: 'pg4', metodo: 'EFECTIVO', monto: '9810', cuentaId: id('cu-caja') }],
    tieneCocina: false,
  },
  {
    id: id('v-1005'),
    numero: ++ventaCounter,
    numeroOrdenTurno: 5,
    canal: 'WHATSAPP',
    modalidad: 'DELIVERY_PROPIO',
    estado: 'FINALIZADA',
    total: '11200',
    subtotal: '11200',
    fechaApertura: fechaHoy(13, 45),
    fechaFinalizacion: fechaHoy(14, 5),
    items: [
      { id: 'i9', productoId: id('p-0012'), nombreSnapshot: 'Sorrentinos caseros · Pollo y verdeo', cantidad: '4', unidad: 'UNIDAD', precioUnitario: '2200', totalLinea: '8800', cocinaInterviene: false, modificadoresAplicados: [{ opcionNombre: 'Pollo y verdeo' }] },
      { id: 'i10', productoId: id('p-0031'), nombreSnapshot: 'Salsa casera · Crema', cantidad: '3', unidad: 'UNIDAD', precioUnitario: '800', totalLinea: '2400', cocinaInterviene: false, modificadoresAplicados: [{ opcionNombre: 'Crema' }] },
    ],
    pagos: [{ id: 'pg5', metodo: 'TRANSFERENCIA', monto: '11200', cuentaId: id('cu-galicia') }],
    tieneCocina: false,
  },
  {
    id: id('v-1006'),
    numero: ++ventaCounter,
    numeroOrdenTurno: 6,
    canal: 'MOSTRADOR',
    modalidad: 'TAKE_AWAY',
    estado: 'PROCESADA', // abierta
    total: '6300',
    subtotal: '6300',
    fechaApertura: fechaHoy(14, 20),
    items: [
      { id: 'i11', productoId: id('p-0021'), nombreSnapshot: 'Canelones · Verdura', cantidad: '3', unidad: 'UNIDAD', precioUnitario: '1600', totalLinea: '4800', cocinaInterviene: true, modificadoresAplicados: [{ opcionNombre: 'Verdura' }] },
      { id: 'i12', productoId: id('p-0061'), nombreSnapshot: 'Coca-Cola · 1.5L', cantidad: '1', unidad: 'UNIDAD', precioUnitario: '2500', totalLinea: '2500', cocinaInterviene: false, modificadoresAplicados: null },
    ],
    pagos: [],
    tieneCocina: true,
  },
];

// ─── Movimientos del día ──────────────────────────────────────────────

export const movimientosSeed = [
  { id: 'mv1', fecha: fechaHoy(9, 0), tipo: 'INGRESO', categoria: 'Aporte de socio', categoriaId: id('cm-aporte'), descripcion: 'Aporte para cambio inicial', monto: '50000', cuentaId: id('cu-caja'), cuenta: 'Caja física', usuario: 'María (Encargada)' },
  { id: 'mv2', fecha: fechaHoy(11, 30), tipo: 'EGRESO', categoria: 'Insumos / mercadería', categoriaId: id('cm-insumos'), descripcion: 'Pago harinas (parcial)', monto: '45000', cuentaId: id('cu-santander'), cuenta: 'Santander', usuario: 'María (Encargada)' },
  { id: 'mv3', fecha: fechaHoy(12, 45), tipo: 'EGRESO', categoria: 'Servicios (luz, gas, agua)', categoriaId: id('cm-servicios'), descripcion: 'Edenor — factura febrero', monto: '38500', cuentaId: id('cu-galicia'), cuenta: 'Galicia', usuario: 'Julio (Dueño)' },
  { id: 'mv4', fecha: fechaHoy(13, 15), tipo: 'INGRESO', categoria: 'Cobro RAPPI', categoriaId: id('cm-cobro-rappi'), descripcion: 'Liquidación quincenal RAPPI', monto: '127400', cuentaId: id('cu-mp'), cuenta: 'MercadoPago', usuario: 'Sistema' },
  { id: 'mv5', fecha: fechaHoy(15, 0), tipo: 'EGRESO', categoria: 'Sueldo', categoriaId: id('cm-sueldo'), descripcion: 'Sueldo Lucía González (parte 1/2)', monto: '180000', cuentaId: id('cu-caja'), cuenta: 'Caja física', usuario: 'Julio (Dueño)' },
  { id: 'mv6', fecha: fechaHoy(16, 20), tipo: 'EGRESO', categoria: 'Transporte / nafta', categoriaId: id('cm-transporte'), descripcion: 'Carga de nafta — moto Damián', monto: '12500', cuentaId: id('cu-caja'), cuenta: 'Caja física', usuario: 'María (Encargada)' },
  { id: 'mv7', fecha: fechaHoy(17, 0), tipo: 'INGRESO', categoria: 'Cobro Pedidos YA', categoriaId: id('cm-cobro-pya'), descripcion: 'Liquidación semanal Pedidos YA', monto: '95800', cuentaId: id('cu-mp'), cuenta: 'MercadoPago', usuario: 'Sistema' },
  { id: 'mv8', fecha: fechaHoy(18, 30), tipo: 'EGRESO', categoria: 'Insumos / mercadería', categoriaId: id('cm-insumos'), descripcion: 'Compra mozzarella + ricota', monto: '67000', cuentaId: id('cu-santander'), cuenta: 'Santander', usuario: 'María (Encargada)' },
];
