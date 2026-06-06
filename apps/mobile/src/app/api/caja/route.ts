import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/caja
 *
 * Saldos por cuenta + saldos "a cobrar" (en tránsito: tarjetas/plataformas que
 * todavía no liquidaron). Todo PRE-CALCULADO por el escritorio: leemos
 * `cuentas.saldo_actual` y `cuentas_a_cobrar.saldo_pendiente` tal cual — los
 * mismos números que ve el admin. NO escribe nada.
 */
export async function GET() {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const [cuentas, porCobrar] = await Promise.all([
    query<{ id: string; nombre: string; tipo: string; banco: string | null; saldo: string }>(`
      SELECT id::text, nombre, tipo::text AS tipo, banco, saldo_actual::text AS saldo
      FROM cuentas
      WHERE activa = true
      ORDER BY CASE tipo WHEN 'EFECTIVO' THEN 0 WHEN 'BANCO' THEN 1 ELSE 2 END, nombre
    `),
    query<{ nombre: string; saldo: string }>(`
      SELECT nombre, saldo_pendiente::text AS saldo
      FROM cuentas_a_cobrar
      WHERE activa = true AND saldo_pendiente <> 0
      ORDER BY saldo_pendiente DESC
    `),
  ]);

  const totalEfectivo = cuentas
    .filter((c) => c.tipo === 'EFECTIVO')
    .reduce((s, c) => s + Number(c.saldo), 0);
  const totalBancario = cuentas
    .filter((c) => c.tipo === 'BANCO' || c.tipo === 'WALLET')
    .reduce((s, c) => s + Number(c.saldo), 0);
  const totalPorCobrar = porCobrar.reduce((s, c) => s + Number(c.saldo), 0);

  return NextResponse.json({
    cuentas,
    porCobrar,
    totales: {
      efectivo: totalEfectivo,
      bancario: totalBancario,
      disponible: totalEfectivo + totalBancario,
      porCobrar: totalPorCobrar,
    },
  });
}
