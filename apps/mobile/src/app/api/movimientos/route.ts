import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

/**
 * GET /api/movimientos?periodo=hoy|semana|mes
 *
 * Cashflow: aportes (INGRESO), egresos (EGRESO), transferencias internas,
 * liquidaciones y ajustes. Read-only contra la cloud DB. Devuelve la lista
 * (hasta 100) + un resumen de ingresos/egresos del período (neto excluye las
 * transferencias internas, que no mueven plata fuera del sistema).
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const periodo = new URL(req.url).searchParams.get('periodo') ?? 'hoy';
  const rango =
    periodo === 'semana'
      ? "m.fecha_computo >= (CURRENT_DATE - INTERVAL '7 days')"
      : periodo === 'mes'
        ? "m.fecha_computo >= (CURRENT_DATE - INTERVAL '30 days')"
        : 'm.fecha_computo >= CURRENT_DATE';

  const [movimientos, resumen] = await Promise.all([
    query<{
      id: string;
      tipo: string;
      monto: string;
      fecha: string;
      observacion: string | null;
      categoria: string;
      cuenta_origen: string | null;
      cuenta_destino: string | null;
      usuario: string | null;
    }>(`
      SELECT
        m.id::text,
        m.tipo::text AS tipo,
        m.monto::text AS monto,
        m.fecha_computo::text AS fecha,
        m.observacion,
        cat.nombre AS categoria,
        co.nombre AS cuenta_origen,
        cd.nombre AS cuenta_destino,
        u.nombre AS usuario
      FROM movimientos m
      JOIN categorias_movimiento cat ON cat.id = m.categoria_id
      LEFT JOIN cuentas co ON co.id = m.cuenta_origen_id
      LEFT JOIN cuentas cd ON cd.id = m.cuenta_destino_id
      LEFT JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.estado = 'CONFIRMADO' AND ${rango}
      ORDER BY m.fecha_computo DESC
      LIMIT 100
    `),
    queryOne<{ ingresos: string; egresos: string; cantidad: string }>(`
      SELECT
        COALESCE(SUM(CASE WHEN tipo = 'INGRESO' THEN monto ELSE 0 END), 0)::text AS ingresos,
        COALESCE(SUM(CASE WHEN tipo = 'EGRESO' THEN monto ELSE 0 END), 0)::text AS egresos,
        COUNT(*)::text AS cantidad
      FROM movimientos m
      WHERE m.estado = 'CONFIRMADO' AND ${rango}
    `),
  ]);

  return NextResponse.json({ movimientos, resumen });
}
