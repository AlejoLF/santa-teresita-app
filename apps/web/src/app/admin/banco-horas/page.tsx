'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

/**
 * Banco de horas — el listado. Responde las tres preguntas de la encargada:
 * cuánto le debo a cada uno, cuánto debo en total, y cuánto me deben.
 *
 * Las horas se muestran como HORAS y aparte su valor en pesos, no sólo el
 * peso: la deuda está expresada en horas y se revalúa sola cuando cambia el
 * valor de la categoría (SPEC §14).
 */

interface Fila {
  id: string;
  nombre: string;
  apellido: string | null;
  puesto: string;
  activo: boolean;
  categoria: string | null;
  tieneValorPropio: boolean;
  valorHora: string;
  horasPendientes: string;
  montoHoras: string;
  adelantosPendientes: string;
  saldo: string;
  sinValorHora: boolean;
}

interface Totales {
  montoHoras: string;
  adelantos: string;
  saldo: string;
}

export default function BancoHorasPage() {
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [totales, setTotales] = useState<Totales | null>(null);
  const [q, setQ] = useState('');
  const [soloConSaldo, setSoloConSaldo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set('q', q.trim());
      if (soloConSaldo) p.set('soloConSaldo', 'true');
      const r = await api.get<{ empleados: Fila[]; totales: Totales }>(
        `/admin/banco-horas?${p}`,
      );
      setFilas(r.empleados);
      setTotales(r.totales);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el banco de horas');
    }
  }, [q, soloConSaldo]);

  useEffect(() => {
    const t = setTimeout(() => void cargar(), 250);
    return () => clearTimeout(t);
  }, [cargar]);

  const sinTarifa = (filas ?? []).filter((f) => f.sinValorHora);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-xl text-ink-900">Banco de horas</h1>
          <p className="text-sm text-ink-500">
            Horas trabajadas pendientes de pago y adelantos entregados.
          </p>
        </div>
        <Link href="/admin/banco-horas/configuracion">
          <Button variant="secondary" size="sm">
            ⚙️ Categorías y tipos de hora
          </Button>
        </Link>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔎 Buscar empleado…"
          className="input flex-1 min-w-[200px]"
        />
        <label className="flex items-center gap-2 text-sm text-ink-700 cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={soloConSaldo}
            onChange={(e) => setSoloConSaldo(e.target.checked)}
            className="w-4 h-4"
          />
          Sólo con saldo
        </label>
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}

      {/* Un empleado sin valor hora acumula horas que valen $0. Sin este aviso,
          el total de abajo sale más bajo de lo que corresponde y nada lo indica. */}
      {sinTarifa.length > 0 && (
        <div className="bg-saffron-100 text-saffron-700 px-3 py-2 rounded text-sm">
          <strong>
            {sinTarifa.length === 1
              ? `${sinTarifa[0]!.nombre} tiene horas cargadas pero no tiene valor hora.`
              : `${sinTarifa.length} empleados tienen horas cargadas pero no tienen valor hora.`}
          </strong>{' '}
          Esas horas se están contando como $0. Asignales una categoría desde su ficha.
        </div>
      )}

      <section className="card overflow-hidden">
        <table className="w-full text-sm hidden md:table">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Empleado</th>
              <th className="text-left px-4 py-2">Categoría</th>
              <th className="text-right px-4 py-2">Hs. pend.</th>
              <th className="text-right px-4 py-2">$/h</th>
              <th className="text-right px-4 py-2">En pesos</th>
              <th className="text-right px-4 py-2">Adelantos</th>
              <th className="text-right px-4 py-2">Saldo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {!filas && (
              <tr>
                <td colSpan={7} className="text-center text-ink-500 py-8">
                  Cargando…
                </td>
              </tr>
            )}
            {filas?.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-ink-500 py-8 italic">
                  {soloConSaldo ? 'Nadie tiene saldo pendiente ✨' : 'Sin empleados'}
                </td>
              </tr>
            )}
            {filas?.map((f) => (
              <tr key={f.id} className={cn('hover:bg-cream-100', !f.activo && 'opacity-50')}>
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/banco-horas/${f.id}`}
                    className="font-medium text-ink-900 hover:text-teresita-700"
                  >
                    {f.nombre}
                    {f.apellido && ` ${f.apellido}`}
                  </Link>
                </td>
                <td className="px-4 py-3 text-xs text-ink-500">
                  {/* Tener valor propio en vez de categoría es válido, no un
                      problema: sólo se avisa cuando no tiene NINGUNO de los dos. */}
                  {f.categoria ??
                    (f.tieneValorPropio ? (
                      <span className="italic">valor propio</span>
                    ) : (
                      <span className="text-saffron-700">sin categoría</span>
                    ))}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {Number(f.horasPendientes) !== 0 ? f.horasPendientes : <span className="text-ink-300">—</span>}
                </td>
                <td className="px-4 py-3 text-right text-xs text-ink-500">
                  {Number(f.valorHora) > 0 ? <MoneyAmount value={f.valorHora} /> : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  {Number(f.montoHoras) !== 0 ? (
                    <MoneyAmount value={f.montoHoras} className="text-basil-600" />
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {Number(f.adelantosPendientes) !== 0 ? (
                    <MoneyAmount value={f.adelantosPendientes} className="text-saffron-600" />
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <MoneyAmount
                    value={f.saldo}
                    className={cn(
                      'font-medium',
                      Number(f.saldo) < 0 ? 'text-pomodoro-600' : 'text-ink-900',
                    )}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          {totales && (
            <tfoot className="bg-surface-sunken border-t border-cream-300">
              <tr className="font-medium">
                <td colSpan={4} className="px-4 py-3 text-2xs uppercase tracking-wider text-ink-500">
                  Total adeudado
                </td>
                <td className="px-4 py-3 text-right">
                  <MoneyAmount value={totales.montoHoras} />
                </td>
                <td className="px-4 py-3 text-right">
                  <MoneyAmount value={totales.adelantos} className="text-saffron-600" />
                </td>
                <td className="px-4 py-3 text-right">
                  <MoneyAmount value={totales.saldo} className="text-ink-900" />
                </td>
              </tr>
            </tfoot>
          )}
        </table>

        {/* Tarjetas en celular, como el resto del admin */}
        <div className="md:hidden divide-y divide-cream-200">
          {filas?.map((f) => (
            <Link
              key={f.id}
              href={`/admin/banco-horas/${f.id}`}
              className={cn('block p-3', !f.activo && 'opacity-50')}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium text-ink-900">
                    {f.nombre} {f.apellido ?? ''}
                  </div>
                  <div className="text-2xs text-ink-500">
                    {f.categoria ?? (f.tieneValorPropio ? 'valor propio' : 'sin categoría')} ·{' '}
                    {f.horasPendientes} hs
                  </div>
                </div>
                <MoneyAmount
                  value={f.saldo}
                  className={cn(
                    'text-base font-medium',
                    Number(f.saldo) < 0 ? 'text-pomodoro-600' : 'text-ink-900',
                  )}
                />
              </div>
            </Link>
          ))}
          {totales && (
            <div className="p-3 bg-surface-sunken flex items-center justify-between">
              <span className="text-2xs uppercase tracking-wider text-ink-500">Total</span>
              <MoneyAmount value={totales.saldo} className="text-base font-medium" />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
