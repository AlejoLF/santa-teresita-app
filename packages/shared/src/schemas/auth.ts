import { z } from 'zod';

export const PinSchema = z
  .string()
  .regex(/^\d{4}$/, 'El PIN debe tener exactamente 4 dígitos numéricos');

export const LoginSchema = z.object({
  pin: PinSchema,
  pcOrigen: z.string().min(1).max(40),
  ipOrigen: z.string().optional(),
  userAgent: z.string().optional(),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const ApprovalSchema = z.object({
  accion: z.string().min(1).max(120),
  pin: PinSchema,
  contexto: z.record(z.unknown()).optional(),
});
export type ApprovalInput = z.infer<typeof ApprovalSchema>;

export const ChangePinSchema = z
  .object({
    pinActual: PinSchema,
    pinNuevo: PinSchema,
    pinNuevoConfirmacion: PinSchema,
  })
  .refine((d) => d.pinNuevo === d.pinNuevoConfirmacion, {
    message: 'La confirmación no coincide',
    path: ['pinNuevoConfirmacion'],
  })
  .refine((d) => d.pinActual !== d.pinNuevo, {
    message: 'El PIN nuevo debe ser distinto al actual',
    path: ['pinNuevo'],
  });

export const PINS_DEBILES = [
  '0000',
  '1111',
  '2222',
  '3333',
  '4444',
  '5555',
  '6666',
  '7777',
  '8888',
  '9999',
  '1234',
  '4321',
  '0123',
  '1212',
  '2121',
  '1010',
  '2020',
  '1122',
  '6969',
  '4242',
  '1357',
  '2468',
] as const;

export function pinEsDebil(pin: string): boolean {
  return (PINS_DEBILES as readonly string[]).includes(pin);
}
