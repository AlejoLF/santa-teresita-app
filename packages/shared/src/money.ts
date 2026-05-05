/**
 * Utilidades de dinero — todos los montos se manejan en CENTAVOS (int) internamente
 * para evitar errores de punto flotante. La capa Prisma usa Decimal y convierte a string;
 * acá hay funciones para ir y volver entre las representaciones.
 *
 * Convenciones:
 *   - "centavos" = monto * 100 como entero (ej. $1.234,56 → 123456 centavos)
 *   - "ars"      = monto en pesos como string ("1234.56") o número (1234.56)
 *   - Formateo de display: usa Intl.NumberFormat con locale es-AR.
 */

const CURRENCY = 'ARS';
const LOCALE = 'es-AR';

export type MoneyInput = number | string | bigint;

export function toCentavos(value: MoneyInput): number {
  if (typeof value === 'bigint') return Number(value);
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) {
    throw new Error(`No se puede convertir a centavos: ${String(value)}`);
  }
  return Math.round(n * 100);
}

export function fromCentavos(centavos: number): number {
  return centavos / 100;
}

const arsFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const arsFormatterDecimal = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formatea sin decimales: $ 1.234 (ideal para precios redondos en UI cajero). */
export function formatARS(value: MoneyInput): string {
  const n = typeof value === 'string' ? Number(value) : Number(value);
  return arsFormatter.format(n);
}

/** Formatea con 2 decimales: $ 1.234,56 (ideal para tickets y reportes contables). */
export function formatARSDecimal(value: MoneyInput): string {
  const n = typeof value === 'string' ? Number(value) : Number(value);
  return arsFormatterDecimal.format(n);
}

/** Suma una lista de montos como decimales en pesos, devuelve string con 2 decimales. */
export function sumARS(values: MoneyInput[]): string {
  const totalCent = values.reduce<number>((acc, v) => acc + toCentavos(v), 0);
  return (totalCent / 100).toFixed(2);
}

/** Aplica un porcentaje (ej. 10) sobre un monto, devuelve string con 2 decimales. */
export function applyPct(value: MoneyInput, pct: number): string {
  const cent = toCentavos(value);
  const result = Math.round(cent * (pct / 100));
  return (result / 100).toFixed(2);
}

export function calcularDescuentoEfectivo(subtotal: MoneyInput, pct = 10): {
  descuento: string;
  total: string;
} {
  const sub = toCentavos(subtotal);
  const descuento = Math.round(sub * (pct / 100));
  const total = sub - descuento;
  return {
    descuento: (descuento / 100).toFixed(2),
    total: (total / 100).toFixed(2),
  };
}

/**
 * Calcula el subtotal de un item según unidad y precio.
 *
 * Convenciones de `cantidad` por `unidadPrecio`:
 *   POR_KILO    → cantidad en GRAMOS  (ej. 500 = medio kilo) → divide por 1000
 *   POR_DOCENA  → cantidad en DOCENAS (ej. 1   = 1 docena)   → multiplica directo
 *   POR_UNIDAD / POR_GRAMO / POR_PORCION / POR_PLANCHA → cantidad en la misma
 *                  unidad que el precio, multiplica directo.
 *
 * Ejemplos:
 *   200g de fideos a $13.000/kg     → 200/1000 × 13.000 = 2.600
 *   1 docena empanadas a $1.200/doc → 1 × 1.200          = 1.200
 *   2 unidades a $500 c/u           → 2 × 500            = 1.000
 */
export function subtotalItem(args: {
  cantidad: number;
  precioUnitario: MoneyInput;
  unidadPrecio:
    | 'POR_UNIDAD'
    | 'POR_GRAMO'
    | 'POR_KILO'
    | 'POR_PORCION'
    | 'POR_PLANCHA'
    | 'POR_DOCENA';
}): string {
  const precioCent = toCentavos(args.precioUnitario);
  const cantidad = args.cantidad;
  let totalCent: number;
  switch (args.unidadPrecio) {
    case 'POR_KILO':
      // cantidad en gramos
      totalCent = Math.round((cantidad / 1000) * precioCent);
      break;
    case 'POR_UNIDAD':
    case 'POR_GRAMO':
    case 'POR_PORCION':
    case 'POR_PLANCHA':
    case 'POR_DOCENA':
      // cantidad ya está en la misma unidad que el precio (docenas, unidades, etc.)
      totalCent = Math.round(cantidad * precioCent);
      break;
    default: {
      const _exhaustive: never = args.unidadPrecio;
      throw new Error(`Unidad de precio no soportada: ${String(_exhaustive)}`);
    }
  }
  return (totalCent / 100).toFixed(2);
}
