import { z } from 'zod';

export const FormaVentaEnum = z.enum(['UNIDAD', 'GRAMO', 'PLANCHA', 'PORCION']);
export type FormaVenta = z.infer<typeof FormaVentaEnum>;

export const CanalVentaEnum = z.enum([
  'MOSTRADOR',
  'TELEFONO',
  'WHATSAPP',
  'WEB',
  'RAPPI',
  'PEDIDOS_YA',
  'MERCADO_LIBRE',
  'DELIVERATE',
]);
export type CanalVenta = z.infer<typeof CanalVentaEnum>;

export const ModalidadVentaEnum = z.enum([
  'TAKE_AWAY',
  'DELIVERY_PROPIO',
  'DELIVERY_PLATAFORMA',
  'DELIVERY_DELIVERATE',
]);

export const MetodoPagoEnum = z.enum([
  'EFECTIVO',
  'DEBITO',
  'CREDITO_1_PAGO',
  'CREDITO_CUOTAS',
  'TRANSFERENCIA',
  'DEPOSITO',
  'MERCADOPAGO_QR',
  'CHEQUE',
  'TARJETA_NARANJA',
  'OTRO',
]);

export const ModificadorAplicadoSchema = z.object({
  grupoId: z.string().uuid(),
  grupoNombre: z.string(),
  opcionId: z.string().uuid(),
  opcionNombre: z.string(),
  deltaPrecio: z.string(),
});
export type ModificadorAplicado = z.infer<typeof ModificadorAplicadoSchema>;

export const ItemNuevoSchema = z.object({
  productoId: z.string().uuid(),
  cantidad: z.number().positive(),
  modificadores: z.array(ModificadorAplicadoSchema).default([]),
  observacion: z.string().max(500).optional(),
  parteDeComboId: z.string().uuid().optional(),
  parteDeComboInstancia: z.string().uuid().optional(),
});
export type ItemNuevo = z.infer<typeof ItemNuevoSchema>;

export const VentaNuevaSchema = z.object({
  canal: CanalVentaEnum,
  modalidad: ModalidadVentaEnum,
  pcOrigen: z.string().min(1).max(40),
  clienteId: z.string().uuid().optional(),
  observaciones: z.string().max(500).optional(),
  items: z.array(ItemNuevoSchema).default([]),
  // Datos de cliente para delivery (se guardan en deliveryInfo.direccionSnapshot
  // y se imprimen en la comanda de cocina cuando la venta es delivery).
  clienteNombre: z.string().max(120).optional(),
  clienteTelefono: z.string().max(40).optional(),
  direccionEntrega: z.string().max(300).optional(),
  indicacionesEntrega: z.string().max(300).optional(),
});
export type VentaNueva = z.infer<typeof VentaNuevaSchema>;

export const PagoNuevoSchema = z.object({
  metodo: MetodoPagoEnum,
  cuentaId: z.string().uuid(),
  cuentaACobrarId: z.string().uuid().optional(),
  monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
  cambioDado: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  numeroReferencia: z.string().max(80).optional(),
  posnetId: z.string().uuid().optional(),
  tarjetaUltimos4: z.string().regex(/^\d{4}$/).optional(),
});

export const FinalizarVentaSchema = z.object({
  pagos: z.array(PagoNuevoSchema).min(1),
  aplicarDescuentoEfectivo: z.boolean().default(false),
  /**
   * Porcentaje de descuento aplicado sobre la parte EFECTIVO en mostrador.
   * Default = 10. Se ignora si `aplicarDescuentoEfectivo=false` o canal≠MOSTRADOR.
   * Tope blando = 30 (configurable a futuro vía parametros sistema).
   */
  descuentoPctEfectivo: z.number().min(0).max(50).default(10),
});
