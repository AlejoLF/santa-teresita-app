import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/mayoristas
 *
 * Clientes mayoristas con su cuenta corriente (suma de remitos PENDIENTES, o
 * sea entregado y todavía no cobrado). Read-only. Vacío si todavía no hay
 * mayoristas cargados.
 */
export async function GET() {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const mayoristas = await query<{
    id: string;
    nombre: string;
    contacto: string | null;
    telefono: string | null;
    cuenta_corriente: string;
    remitos_pendientes: number;
    ultimo_remito: string | null;
  }>(`
    SELECT
      cm.id::text,
      cm.nombre,
      cm.contacto,
      cm.telefono,
      COALESCE(SUM(r.total) FILTER (WHERE r.estado = 'PENDIENTE'), 0)::text AS cuenta_corriente,
      COUNT(r.id) FILTER (WHERE r.estado = 'PENDIENTE')::int AS remitos_pendientes,
      MAX(r.fecha)::text AS ultimo_remito
    FROM clientes_mayoristas cm
    LEFT JOIN remitos r ON r.cliente_mayorista_id = cm.id
    WHERE cm.activo = true
    GROUP BY cm.id
    ORDER BY COALESCE(SUM(r.total) FILTER (WHERE r.estado = 'PENDIENTE'), 0) DESC, cm.nombre
    LIMIT 100
  `);

  return NextResponse.json({ mayoristas });
}
