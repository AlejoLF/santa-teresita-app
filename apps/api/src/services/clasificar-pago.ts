/**
 * Helper común para clasificar pagos según canal/modalidad de la venta.
 *
 * Tanto el dashboard (`/admin/dashboard`) como el análisis de ventas
 * (`/admin/ventas-analisis`) duplicaban estas reglas. Centralizarlas acá
 * evita que diverjan: cualquier ajuste de bucket (ej. agregar UBER EATS)
 * se hace en un solo lugar.
 *
 * Buckets:
 *   - 'mostrador'      → Venta en local (canal MOSTRADOR o fallback)
 *   - 'delivery_propio'→ Damián / motoquero del local (TELEFONO/WHATSAPP/WEB
 *                        con DELIVERY_PROPIO)
 *   - 'deliverate'     → DELIVERATE (rinde semanal, NO suma a caja del día)
 *   - 'plataforma'     → RAPPI / Pedidos YA / Mercado Libre (cobran ellos)
 */
export type CanalBucket = 'mostrador' | 'delivery_propio' | 'deliverate' | 'plataforma';

export function clasificarCanalBucket(
  canal: string | null | undefined,
  modalidad?: string | null,
): CanalBucket {
  if (!canal || canal === 'MOSTRADOR') return 'mostrador';
  if (canal === 'DELIVERATE') return 'deliverate';
  if (canal === 'RAPPI' || canal === 'PEDIDOS_YA' || canal === 'MERCADO_LIBRE') {
    return 'plataforma';
  }
  // TELEFONO / WHATSAPP / WEB → delivery_propio cuando hay modalidad delivery,
  // mostrador en otros casos (ej. take-away avisado por teléfono).
  if (canal === 'TELEFONO' || canal === 'WHATSAPP' || canal === 'WEB') {
    if (modalidad === 'DELIVERY_PROPIO') return 'delivery_propio';
    return 'mostrador';
  }
  return 'mostrador';
}

/**
 * Sub-clasificación de método de pago para los desgloses tarjeta/efectivo.
 *
 * Usar después de `clasificarCanalBucket` para tener bucket × método.
 */
export type MetodoBucket = 'efectivo' | 'debito' | 'credito' | 'mpQr' | 'transferencia' | 'otro';

export function clasificarMetodoBucket(metodo: string): MetodoBucket {
  if (metodo === 'EFECTIVO') return 'efectivo';
  if (metodo === 'DEBITO') return 'debito';
  if (metodo === 'CREDITO_1_PAGO' || metodo === 'CREDITO_CUOTAS' || metodo === 'TARJETA_NARANJA') {
    return 'credito';
  }
  if (metodo === 'MERCADOPAGO_QR') return 'mpQr';
  if (metodo === 'TRANSFERENCIA' || metodo === 'DEPOSITO') return 'transferencia';
  return 'otro';
}
