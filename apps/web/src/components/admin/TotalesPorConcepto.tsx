'use client';

import { MoneyAmount } from '@/components/ui/MoneyAmount';

/**
 * Lo pagado en el período, DISCRIMINADO por concepto.
 *
 * El pedido de la encargada, textual: que los números estén "siempre arriba de
 * todo, grandes y claros", y que digan cuánto se fue en cada cosa —jornada,
 * horas extra, plus, adelanto— y no un único total que no explica nada.
 *
 * El mismo componente va en la pantalla general de Empleados y en la ficha de
 * cada uno, a propósito: son la misma pregunta a distinta escala, y que se vean
 * igual evita tener que volver a entenderlos.
 *
 * Los montos responden al filtro temporal elegido arriba. Cuando no se pagó
 * nada en el período, se dice con todas las letras en vez de mostrar una fila
 * de ceros — un cero no distingue "no hubo pagos" de "todavía no cargó".
 */

export interface ConceptoTotal {
  concepto: string;
  monto: string;
  cantidad: number;
}

export function TotalesPorConcepto({
  porConcepto,
  total,
  titulo = 'Pagado en el período',
  cargando = false,
}: {
  porConcepto: ConceptoTotal[];
  /** El total. Si no viene, se suma de los conceptos. */
  total?: string;
  titulo?: string;
  cargando?: boolean;
}) {
  const suma =
    total ?? porConcepto.reduce((acc, c) => acc + Number(c.monto), 0).toFixed(2);
  const hayAlgo = porConcepto.length > 0 && Number(suma) !== 0;

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-2xs uppercase tracking-wider text-ink-500">{titulo}</span>
        {cargando && <span className="text-2xs text-ink-500">actualizando…</span>}
      </div>

      <MoneyAmount
        value={suma}
        hero
        fit
        className="text-teresita-700 mt-1"
      />

      {!hayAlgo ? (
        <p className="text-sm text-ink-500 mt-2">
          No se registran pagos en el período elegido.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-3">
          {porConcepto.map((c) => (
            <div key={c.concepto} className="min-w-0">
              <div className="text-2xs uppercase tracking-wider text-ink-500 truncate">
                {c.concepto}
              </div>
              <MoneyAmount value={c.monto} fit className="text-md text-ink-900" />
              <div className="text-2xs text-ink-500">
                {c.cantidad} pago{c.cantidad !== 1 && 's'}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
