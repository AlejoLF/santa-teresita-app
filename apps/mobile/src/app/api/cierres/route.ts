import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/cierres
 *
 * Historial de cierres de caja (sesiones CERRADA / APROBADA), más recientes
 * primero. Todos los montos (inicial / esperado / contado / diferencia) ya
 * fueron computados y guardados por el escritorio al cerrar — los leemos tal
 * cual. Read-only.
 */
export async function GET() {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const cierres = await query<{
    id: string;
    fecha: string;
    turno: string;
    estado: string;
    inicial: string | null;
    final: string | null;
    esperada: string | null;
    diferencia: string | null;
    apertura: string | null;
    cierre: string | null;
    abrio: string | null;
    cerro: string | null;
  }>(`
    SELECT
      s.id::text,
      s.fecha::text AS fecha,
      s.turno::text AS turno,
      s.estado::text AS estado,
      s.existencia_inicial::text AS inicial,
      s.existencia_final::text AS final,
      s.recaudacion_esperada::text AS esperada,
      s.diferencia::text AS diferencia,
      s.horario_apertura::text AS apertura,
      s.horario_cierre::text AS cierre,
      ua.nombre AS abrio,
      uc.nombre AS cerro
    FROM sesiones_caja s
    LEFT JOIN usuarios ua ON ua.id = s.usuario_apertura_id
    LEFT JOIN usuarios uc ON uc.id = s.usuario_cierre_id
    WHERE s.estado IN ('CERRADA', 'APROBADA')
    ORDER BY s.fecha DESC, CASE s.turno WHEN 'TARDE' THEN 0 ELSE 1 END
    LIMIT 30
  `);

  return NextResponse.json({ cierres });
}
