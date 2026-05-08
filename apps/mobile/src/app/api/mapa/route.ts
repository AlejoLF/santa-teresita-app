import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/mapa
 *
 * Pines de delivery del DÍA actual (mobile-friendly: solo el día, no el
 * período entero). Si direccion_snapshot tiene lat/lng, los devolvemos.
 * Si no, igual devolvemos el item con dirección textual.
 */
export async function GET() {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const pines = await query<{
    id: string;
    numero: number;
    total: string;
    estado: string;
    estado_delivery: string | null;
    cliente: string;
    telefono: string | null;
    direccion: string;
    lat: number | null;
    lng: number | null;
    demora_min: number | null;
  }>(`
    SELECT
      v.id::text,
      v.numero_orden_turno AS numero,
      v.total::text,
      v.estado::text,
      d.estado::text AS estado_delivery,
      COALESCE(c.nombre || COALESCE(' ' || c.apellido, ''), 'NN') AS cliente,
      c.telefono,
      COALESCE(d.direccion_snapshot->>'direccion', '') AS direccion,
      (d.direccion_snapshot->>'lat')::float AS lat,
      (d.direccion_snapshot->>'lng')::float AS lng,
      CASE
        WHEN d.hora_entrega IS NOT NULL
        THEN EXTRACT(EPOCH FROM (d.hora_entrega - v.fecha_apertura))::int / 60
        ELSE NULL
      END AS demora_min
    FROM ventas v
    JOIN delivery_info d ON d.venta_id = v.id
    LEFT JOIN clientes c ON c.id = v.cliente_id
    WHERE v.fecha_apertura::date = CURRENT_DATE
      AND v.estado IN ('PROCESADA', 'FINALIZADA')
    ORDER BY v.fecha_apertura DESC
  `);

  return NextResponse.json({ pines });
}
