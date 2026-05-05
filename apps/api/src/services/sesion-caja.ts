import { prisma } from '@sta/db/client';
import { TurnoCaja, EstadoSesionCaja, type SesionCaja } from '@sta/db';

/**
 * Devuelve la SesionCaja activa para el momento actual (turno mañana o tarde).
 * Si no hay ninguna abierta, crea una sesión nueva con `existencia_inicial = 0`
 * y la devuelve. Esto evita que el cajero tenga que abrir la caja manualmente
 * para empezar a vender — pero la encargada después debe ajustar la existencia
 * inicial correcta cuando llegue a apertura formal.
 *
 * Nota operativa: el corte mañana/tarde se hace a las 14:30. Productos que se
 * cargan a las 14:29 entran en la sesión MAÑANA, los de 14:30 en TARDE.
 */
export async function getOrCreateSesionActual(usuarioId: string): Promise<SesionCaja> {
  const ahora = new Date();
  const fecha = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const hora = ahora.getHours() + ahora.getMinutes() / 60;
  const turno = hora < 14.5 ? TurnoCaja.MANANA : TurnoCaja.TARDE;

  const existing = await prisma.sesionCaja.findFirst({
    where: { fecha, turno, estado: { in: [EstadoSesionCaja.ABIERTA] } },
  });
  if (existing) return existing;

  return prisma.sesionCaja.create({
    data: {
      fecha,
      turno,
      horarioApertura: ahora,
      existenciaInicial: '0',
      usuarioAperturaId: usuarioId,
      estado: EstadoSesionCaja.ABIERTA,
    },
  });
}

/**
 * Devuelve el próximo numeroOrdenTurno para la sesión, garantizando atomicidad
 * bajo carga concurrente. Postgres garantiza que `UPDATE ... RETURNING` con
 * `increment` es atómico — dos cajas creando ventas en simultáneo nunca
 * obtienen el mismo valor.
 *
 * El campo `ultimoNumeroOrden` arranca en 0 al crear la sesión, así que el
 * primer valor devuelto es 1.
 */
export async function siguienteNumeroOrdenTurno(sesionId: string): Promise<number> {
  const updated = await prisma.sesionCaja.update({
    where: { id: sesionId },
    data: { ultimoNumeroOrden: { increment: 1 } },
    select: { ultimoNumeroOrden: true },
  });
  return updated.ultimoNumeroOrden;
}
