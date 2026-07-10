import { z } from 'zod';
import { ItemNuevoSchema } from './venta.js';

export const FranjaEntregaEnum = z.enum(['MANANA', 'TARDE', 'NOCHE']);
export type FranjaEntrega = z.infer<typeof FranjaEntregaEnum>;

export const TipoEntregaEncargoEnum = z.enum(['RETIRO', 'ENVIO']);
export type TipoEntregaEncargo = z.infer<typeof TipoEntregaEncargoEnum>;

/** Comanderas disponibles para imprimir la comanda de un encargo. */
export const DestinoImpresionEnum = z.enum(['MOSTRADOR', 'DELIVERY', 'COCINA']);
export type DestinoImpresionEncargo = z.infer<typeof DestinoImpresionEnum>;

/**
 * Alta de un encargo (pedido para un día futuro).
 *
 * Los campos de entrega son OBLIGATORIOS (a diferencia de una venta normal):
 * día, hora (exacta XOR franja), nombre, teléfono, retiro/envío y dirección si
 * es envío. La validación cruzada (XOR hora/franja, dirección si envío) se hace
 * en el handler para no depender de ZodEffects en el schema de Fastify.
 *
 * `accion`:
 *   - 'cargar' → nace A_PAGAR (no toca caja); imprime comanda ENCARGO "A PAGAR".
 *   - 'cobrar' → el front lo crea y redirige al cobro (mismo flujo que una venta);
 *     la comanda "COBRADO" sale al finalizar el cobro.
 */
export const EncargoNuevoSchema = z.object({
  pcOrigen: z.string().min(1).max(40),
  items: z.array(ItemNuevoSchema).min(1),
  /** Día de entrega/retiro, formato YYYY-MM-DD. */
  fechaEntrega: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Hora exacta "HH:MM" (exactamente una de horaEntregaExacta/franjaEntrega). */
  horaEntregaExacta: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  franjaEntrega: FranjaEntregaEnum.optional(),
  clienteNombre: z.string().min(1).max(120),
  clienteTelefono: z.string().min(1).max(40),
  tipoEntrega: TipoEntregaEncargoEnum,
  direccionEntrega: z.string().max(300).optional(),
  indicacionesEntrega: z.string().max(300).optional(),
  observaciones: z.string().max(500).optional(),
  accion: z.enum(['cargar', 'cobrar']).default('cargar'),
  /**
   * Comandera por la que sale la comanda del encargo. Los encargos se toman
   * también desde PCs que no son la del mostrador, así que la caja elige el
   * destino al cargar (no solo al re-imprimir).
   */
  destinoImpresion: DestinoImpresionEnum.default('MOSTRADOR'),
});
export type EncargoNuevo = z.infer<typeof EncargoNuevoSchema>;

/** Edición de los datos de un encargo A_PAGAR (no cobrado todavía). */
export const EncargoEditarSchema = z.object({
  fechaEntrega: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  horaEntregaExacta: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  franjaEntrega: FranjaEntregaEnum.nullable().optional(),
  clienteNombre: z.string().min(1).max(120).optional(),
  clienteTelefono: z.string().min(1).max(40).optional(),
  tipoEntrega: TipoEntregaEncargoEnum.optional(),
  direccionEntrega: z.string().max(300).nullable().optional(),
  indicacionesEntrega: z.string().max(300).nullable().optional(),
  observaciones: z.string().max(500).nullable().optional(),
});
export type EncargoEditar = z.infer<typeof EncargoEditarSchema>;
