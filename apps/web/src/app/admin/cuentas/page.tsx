'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { KpiCard } from '@/components/admin/KpiCard';
import { cn } from '@/lib/cn';

interface CuentaConSaldo {
  id: string;
  nombre: string;
  tipo: 'EFECTIVO' | 'BANCO' | 'WALLET';
  activa: boolean;
  saldoActual: string;
  ingresosMes: string;
  egresosMes: string;
  netoMes: string;
  movimientosMes: number;
  ultimoMovimiento: string | null;
}

const TIPO_LABEL: Record<CuentaConSaldo['tipo'], { label: string; icon: string }> = {
  EFECTIVO: { label: 'Efectivo', icon: '💵' },
  BANCO: { label: 'Banco', icon: '🏦' },
  WALLET: { label: 'Billetera digital', icon: '📱' },
};

function ultimoMovimientoLabel(iso: string | null): { label: string; tone: 'fresh' | 'stale' | 'old' } {
  if (!iso) return { label: 'Sin movimientos', tone: 'old' };
  const hace = Date.now() - new Date(iso).getTime();
  const horas = hace / (1000 * 60 * 60);
  if (horas < 24) return { label: 'Hoy', tone: 'fresh' };
  if (horas < 48) return { label: 'Ayer', tone: 'fresh' };
  if (horas < 24 * 7) {
    const d = Math.round(horas / 24);
    return { label: `Hace ${d} días`, tone: 'stale' };
  }
  return { label: 'Más de 1 semana', tone: 'old' };
}

export default function AdminCuentasPage() {
  const [data, setData] = useState<{ cuentas: CuentaConSaldo[]; totalSaldos: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ cuentas: CuentaConSaldo[]; totalSaldos: string }>(
          '/admin/cuentas',
        );
        setData(res);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) {
          setError('No se pudieron cargar las cuentas');
        }
      }
    })();
  }, []);

  if (error) return <div className="text-pomodoro-600">{error}</div>;
  if (!data) return <div className="text-ink-500">Cargando cuentas...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-xl text-ink-900">Cuentas y saldos</h1>
          <p className="text-sm text-ink-500">
            {data.cuentas.length} cuentas activas · saldos calculados sobre los movimientos
            registrados
          </p>
          <p className="text-2xs text-ink-300 mt-1">
            La sincronización con bancos y MercadoPago se habilita en la próxima versión.
          </p>
        </div>
      </header>

      {/* Total disponible (las otras cards las sacamos: el desglose por tipo
          ya se ve en la tabla de abajo) */}
      <section className="max-w-sm">
        <KpiCard
          label="Total disponible"
          value={data.totalSaldos}
          accent="success"
          hint={`${data.cuentas.length} cuenta${data.cuentas.length !== 1 ? 's' : ''} activa${data.cuentas.length !== 1 ? 's' : ''}`}
        />
      </section>

      {/* Tabla detallada */}
      <section className="card overflow-hidden">
        <header className="px-5 py-3 border-b border-cream-300 bg-surface-sunken flex items-center justify-between">
          <h2 className="font-display text-md text-ink-900">Detalle por cuenta</h2>
          <span className="text-2xs text-ink-500 uppercase tracking-wide">
            mes en curso
          </span>
        </header>
        <table className="w-full text-sm">
          <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
            <tr>
              <th className="text-left px-5 py-2">Cuenta</th>
              <th className="text-right px-3 py-2">Saldo actual</th>
              <th className="text-right px-3 py-2">Ingresos mes</th>
              <th className="text-right px-3 py-2">Egresos mes</th>
              <th className="text-right px-3 py-2">Neto</th>
              <th className="text-left px-3 py-2">Último mov.</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {data.cuentas.map((c) => {
              const meta = TIPO_LABEL[c.tipo];
              const neto = Number(c.netoMes);
              const fresc = ultimoMovimientoLabel(c.ultimoMovimiento);
              return (
                <tr key={c.id} className="hover:bg-cream-100 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-baseline gap-2">
                      <span>{meta.icon}</span>
                      <div>
                        <div className="font-medium text-ink-900">{c.nombre}</div>
                        <div className="text-2xs text-ink-500 uppercase tracking-wide">
                          {meta.label}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <MoneyAmount
                      value={c.saldoActual}
                      className="text-md font-semibold text-teresita-900"
                    />
                  </td>
                  <td className="px-3 py-3 text-right text-basil-600 font-mono">
                    {Number(c.ingresosMes) > 0 ? (
                      <MoneyAmount value={c.ingresosMes} />
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right text-pomodoro-600 font-mono">
                    {Number(c.egresosMes) > 0 ? (
                      <MoneyAmount value={c.egresosMes} />
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-3 text-right font-mono',
                      neto > 0 && 'text-basil-600',
                      neto < 0 && 'text-pomodoro-600',
                      neto === 0 && 'text-ink-500',
                    )}
                  >
                    <MoneyAmount value={c.netoMes} />
                  </td>
                  <td className="px-3 py-3 text-xs">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded',
                        fresc.tone === 'fresh' && 'bg-basil-100 text-basil-600',
                        fresc.tone === 'stale' && 'bg-saffron-100 text-saffron-600',
                        fresc.tone === 'old' && 'bg-cream-200 text-ink-500',
                      )}
                    >
                      {fresc.label}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Link
                      href={`/admin/movimientos?cuentaId=${c.id}`}
                      className="text-xs text-teresita-700 hover:underline"
                    >
                      Ver movimientos →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-cream-300 bg-surface-sunken">
            <tr>
              <td className="px-5 py-3 font-medium text-ink-700">TOTAL DISPONIBLE</td>
              <td className="px-3 py-3 text-right">
                <MoneyAmount
                  value={data.totalSaldos}
                  className="text-md text-teresita-900 font-bold"
                />
              </td>
              <td colSpan={5}></td>
            </tr>
          </tfoot>
        </table>
      </section>

      <footer className="text-xs text-ink-500">
        Para crear o desactivar cuentas:{' '}
        <Link href="/admin/configuracion/cuentas" className="text-teresita-700 hover:underline">
          Configuración → Cuentas
        </Link>
        .
      </footer>
    </div>
  );
}
