import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/empleados
 *
 * Roster de empleados (activos primero). Read-only. No incluye adelantos/
 * liquidaciones (eso requiere agregaciones de movimientos por entidad — fase
 * siguiente si se necesita).
 */
export async function GET() {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const empleados = await query<{
    id: string;
    nombre: string;
    apellido: string | null;
    puesto: string;
    sueldo: string | null;
    forma: string | null;
    telefono: string | null;
    ingreso: string | null;
    activo: boolean;
  }>(`
    SELECT
      id::text,
      nombre,
      apellido,
      puesto::text AS puesto,
      sueldo_base::text AS sueldo,
      forma_pago AS forma,
      telefono,
      fecha_ingreso::text AS ingreso,
      activo
    FROM empleados
    ORDER BY activo DESC, nombre
    LIMIT 200
  `);

  return NextResponse.json({ empleados });
}
