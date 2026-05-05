/**
 * Saldo pendiente de una factura recibida = total facturado - total pagado.
 *
 * Acepta `Decimal` de Prisma (que tiene `valueOf()` que devuelve número),
 * `string` (cuando viene serializado de un `select`), o `number`.
 *
 * Devuelve un `number`. Para responses JSON, formatear con `.toFixed(2)`
 * fuera. Para comparaciones, usar `<= 0.01` para considerar "saldada".
 */
export function calcSaldoFactura(f: {
  total: { toString(): string } | string | number;
  totalPagado: { toString(): string } | string | number;
}): number {
  return Number(f.total) - Number(f.totalPagado);
}
