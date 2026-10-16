/**
 * Comprobantes que RESTAN de lo que se le debe al proveedor en vez de sumar.
 *
 * Una nota de crédito se carga con el importe como figura en el papel (en
 * positivo, sin signo) y el signo lo pone el TIPO. Así la encargada no tiene
 * que acordarse de poner "-", la lectura por foto (que la detecta y la guarda
 * en positivo) queda bien sola, y las que ya estaban cargadas se corrigen sin
 * tocar un dato: antes el saldo sumaba `total` sin mirar el tipo y una NC de
 * $50.000 AUMENTABA la deuda (incidente 16/10, la encargada).
 *
 * El Excel de proveedores ya restaba las NC (excel-proveedores.ts). Con esto
 * el sistema y el Excel vuelven a coincidir.
 */
export const TIPOS_QUE_RESTAN: ReadonlySet<string> = new Set(['NOTA_CREDITO']);

export function esNotaCredito(tipoComprobante: string | null | undefined): boolean {
  return !!tipoComprobante && TIPOS_QUE_RESTAN.has(tipoComprobante);
}

/**
 * El importe del comprobante con el signo que le corresponde: positivo lo que
 * suma deuda, negativo lo que la baja. Se usa `abs` porque alguna NC vieja
 * pudo haber entrado ya en negativo (el OCR acepta "-"); con el signo puesto
 * por el tipo, ponerlo dos veces la volvería a sumar.
 */
export function importeConSigno(f: {
  total: { toString(): string } | string | number;
  tipoComprobante?: string | null;
}): number {
  const total = Number(f.total);
  return esNotaCredito(f.tipoComprobante) ? -Math.abs(total) : total;
}

/**
 * Saldo pendiente de un comprobante = lo facturado - lo pagado.
 *
 * Para una nota de crédito da NEGATIVO: es plata a favor que descuenta del
 * total adeudado al proveedor. Una NC no se paga (no entra a las imputaciones),
 * así que su `totalPagado` es 0 y su saldo es `-total`.
 *
 * Acepta `Decimal` de Prisma, `string` o `number`. Devuelve `number`; para
 * JSON, `.toFixed(2)` afuera. Para "saldada", comparar contra 0.01.
 *
 * `tipoComprobante` es opcional para no romper a quien no lo selecciona, pero
 * SIN él una NC se calcula como factura: quien sume saldos tiene que traerlo.
 */
export function calcSaldoFactura(f: {
  total: { toString(): string } | string | number;
  totalPagado: { toString(): string } | string | number;
  tipoComprobante?: string | null;
}): number {
  if (esNotaCredito(f.tipoComprobante)) return -(Math.abs(Number(f.total)) - Number(f.totalPagado));
  return Number(f.total) - Number(f.totalPagado);
}
