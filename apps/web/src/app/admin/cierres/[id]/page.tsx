'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface DetalleCierre {
  sesion: {
    id: string;
    fecha: string;
    turno: 'MANANA' | 'TARDE';
    estado: 'CERRADA' | 'APROBADA';
    horarioApertura: string;
    horarioCierre: string;
    existenciaInicial: string;
    existenciaFinal: string | null;
    recaudacionEsperada: string | null;
    diferencia: string | null;
    observaciones: string | null;
    cerradaAnticipadamente: boolean;
    fechaAprobacion: string | null;
    usuarioApertura: string | null;
    usuarioCierre: string | null;
    aprobadaAdmin: string | null;
    emailEnviadoA: string | null;
    emailEnviadoAt: string | null;
  };
  desgloseEsperado: {
    existenciaInicial: string;
    cobrosEfectivo: string;
    cobrosEfectivoCantidad: number;
    ingresosCaja: string;
    ingresosCajaCantidad: number;
    egresosCaja: string;
    egresosCajaCantidad: number;
    esperadaCalculada: string;
    coincideConGuardado: boolean;
  };
  breakdownCobrosEfectivo: Array<{ metodo: string; monto: string; cantidad: number }>;
  breakdownCobrosNoEfectivo: Array<{ metodo: string; cuenta: string; monto: string; cantidad: number }>;
  ingresosCaja: MovItem[];
  egresosCaja: MovItem[];
  movsNoAfectanCaja: MovItem[];
  ventas: {
    finalizadas: Array<{
      id: string;
      numero: number;
      numeroOrdenTurno: number;
      canal: string;
      modalidad: string;
      total: string;
      fechaFinalizacion: string | null;
    }>;
    anuladas: Array<{ id: string; numero: number; numeroOrdenTurno: number; canal: string; total: string }>;
    procesadas: number;
  };
}

interface MovItem {
  id: string;
  tipo: string;
  monto: string;
  categoria: string;
  cuentaOrigen: string | null;
  cuentaDestino: string | null;
  observacion: string | null;
  fecha: string;
  usuario: string;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function fmtFecha(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function CierreDetallePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<DetalleCierre | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reenviando, setReenviando] = useState(false);
  const [resultadoEmail, setResultadoEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;
    api
      .get<DetalleCierre>(`/admin/caja/cierres/${params.id}`)
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          setError('Cierre no encontrado');
        } else {
          setError('Error cargando el detalle');
        }
      });
  }, [params.id]);

  async function reenviarEmail() {
    if (!data) return;
    setReenviando(true);
    setResultadoEmail(null);
    try {
      const r = await api.post<{
        recipients: string[];
        isEthereal: boolean;
        previewUrl: string | null;
      }>(`/admin/caja/sesion/${data.sesion.id}/enviar-email`, {});
      setResultadoEmail(
        r.isEthereal
          ? `✉ Preview (SMTP no configurado): ${r.previewUrl}`
          : `✓ Email enviado a ${r.recipients.join(', ')}`,
      );
    } catch (e) {
      setResultadoEmail(e instanceof Error ? '✗ ' + e.message : '✗ Error');
    } finally {
      setReenviando(false);
    }
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-4">
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded">{error}</div>
        <Link href="/admin/cierres" className="mt-4 inline-block text-teresita-700 hover:underline">
          ← Volver al listado
        </Link>
      </div>
    );
  }

  if (!data) {
    return <div className="max-w-4xl mx-auto p-4 text-ink-500">Cargando…</div>;
  }

  const { sesion, desgloseEsperado: dg } = data;
  const dif = sesion.diferencia ? Number(sesion.diferencia) : null;

  return (
    <div className="max-w-5xl mx-auto space-y-4 pb-12">
      {/* Header */}
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/cierres" className="text-xs text-teresita-700 hover:underline">
            ← Cierres
          </Link>
          <h1 className="font-display text-xl text-ink-900 mt-1">
            {fmtFecha(sesion.fecha)} · {sesion.turno === 'MANANA' ? 'Mañana' : 'Tarde'}
          </h1>
          <p className="text-sm text-ink-500">
            Abierta {fmtTime(sesion.horarioApertura)} → Cerrada {fmtTime(sesion.horarioCierre)} ·
            cerró {sesion.usuarioCierre ?? '—'}
            {sesion.cerradaAnticipadamente && (
              <span className="ml-2 text-saffron-600">⚠ cierre anticipado</span>
            )}
          </p>
        </div>
        <span
          className={cn(
            'text-2xs font-medium px-2 py-0.5 rounded uppercase tracking-wider',
            sesion.estado === 'APROBADA'
              ? 'bg-basil-100 text-basil-600'
              : 'bg-saffron-100 text-saffron-600',
          )}
        >
          {sesion.estado.toLowerCase()}
        </span>
      </header>

      {/* CARD DESTACADO — Cómo se llega al esperado */}
      <section className="card p-5 border-l-4 border-teresita-700">
        <h2 className="font-display text-md text-ink-900 mb-3">
          Cómo se llega al efectivo esperado
        </h2>
        <p className="text-xs text-ink-500 mb-4">
          Sólo se cuentan las plata que entró y salió de la <strong>Caja física</strong>.
          Movimientos que pasaron por banco/Mercado Pago/Cuenta DNI no afectan este cálculo.
        </p>

        <div className="space-y-2 font-mono text-sm">
          <DesgloseRow
            label="Existencia inicial"
            valor={dg.existenciaInicial}
            sign=""
            tone="neutral"
          />
          <DesgloseRow
            label={`+ Cobros EFECTIVO de ventas (${dg.cobrosEfectivoCantidad} pagos)`}
            valor={dg.cobrosEfectivo}
            sign="+"
            tone="ingreso"
          />
          <DesgloseRow
            label={`+ Ingresos a caja física (${dg.ingresosCajaCantidad} movs)`}
            valor={dg.ingresosCaja}
            sign="+"
            tone="ingreso"
          />
          <DesgloseRow
            label={`− Egresos desde caja física (${dg.egresosCajaCantidad} movs)`}
            valor={dg.egresosCaja}
            sign="−"
            tone="egreso"
          />
          <div className="border-t border-cream-300 mt-2 pt-2">
            <DesgloseRow
              label="= Esperado en caja"
              valor={dg.esperadaCalculada}
              sign=""
              tone="esperado"
              bold
            />
            {!dg.coincideConGuardado && sesion.recaudacionEsperada && (
              <p className="text-2xs text-saffron-600 mt-1">
                ⚠ El recálculo difiere del valor guardado en el cierre ($
                {sesion.recaudacionEsperada}). Posiblemente la sesión se cerró con la fórmula
                vieja — el botón "Sincronizar CASHFLOW" puede ayudar a recalcular.
              </p>
            )}
          </div>

          {sesion.existenciaFinal != null && (
            <>
              <div className="mt-4 pt-2 border-t-2 border-ink-300">
                <DesgloseRow
                  label="Contado (lo que la encargada contó al cerrar)"
                  valor={sesion.existenciaFinal}
                  sign=""
                  tone="contado"
                  bold
                />
              </div>
              <DesgloseRow
                label="Diferencia (contado − esperado)"
                valor={sesion.diferencia ?? '0'}
                sign={dif != null && dif > 0 ? '+' : ''}
                tone={
                  dif == null
                    ? 'neutral'
                    : Math.abs(dif) < 0.01
                      ? 'cuadrado'
                      : dif > 0
                        ? 'sobra'
                        : 'falta'
                }
                bold
              />
            </>
          )}
        </div>

        {dif != null && Math.abs(dif) >= 0.01 && (
          <p className="text-2xs text-ink-500 mt-3 italic">
            {dif > 0
              ? 'Hay más plata en el cajón que la que el sistema esperaba. Posibles causas: cobro no registrado, ingreso a caja no cargado, vuelto mal dado a favor.'
              : 'Hay menos plata en el cajón que la que el sistema esperaba. Posibles causas: egreso no cargado, vuelto excesivo dado, faltante físico.'}
          </p>
        )}
      </section>

      {/* Acciones */}
      <section className="card p-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => router.back()}>
          ← Volver al listado
        </Button>
        <Button variant="secondary" size="sm" onClick={reenviarEmail} disabled={reenviando}>
          {reenviando ? 'Enviando…' : '📧 Re-enviar email'}
        </Button>
        {sesion.emailEnviadoAt && (
          <span className="text-2xs text-basil-600">
            ✉ Enviado a {sesion.emailEnviadoA} ·{' '}
            {new Date(sesion.emailEnviadoAt).toLocaleString('es-AR')}
          </span>
        )}
        {resultadoEmail && (
          <span className="text-2xs text-ink-700">{resultadoEmail}</span>
        )}
      </section>

      {/* Ingresos a caja */}
      {data.ingresosCaja.length > 0 && (
        <section className="card p-4">
          <h3 className="font-display text-md text-ink-900 mb-2">
            + Ingresos a caja física ({data.ingresosCaja.length})
          </h3>
          <p className="text-2xs text-ink-500 mb-3">
            Plata que entró al cajón vía movimientos (no por ventas).
          </p>
          <MovList items={data.ingresosCaja} kind="ingreso" />
        </section>
      )}

      {/* Egresos de caja */}
      {data.egresosCaja.length > 0 && (
        <section className="card p-4">
          <h3 className="font-display text-md text-ink-900 mb-2">
            − Egresos desde caja física ({data.egresosCaja.length})
          </h3>
          <p className="text-2xs text-ink-500 mb-3">
            Plata que salió del cajón (pagos a proveedores, retiros, etc.).
          </p>
          <MovList items={data.egresosCaja} kind="egreso" />
        </section>
      )}

      {/* Cobros desglosados */}
      <section className="card p-4">
        <h3 className="font-display text-md text-ink-900 mb-2">Cobros de ventas finalizadas</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-2xs uppercase text-ink-500 mb-1">EFECTIVO (afecta caja)</div>
            {data.breakdownCobrosEfectivo.length === 0 ? (
              <p className="text-xs text-ink-500 italic">Sin cobros en efectivo</p>
            ) : (
              <ul className="text-xs space-y-1">
                {data.breakdownCobrosEfectivo.map((b) => (
                  <li key={b.metodo} className="flex justify-between">
                    <span>{b.metodo} ({b.cantidad})</span>
                    <MoneyAmount value={b.monto} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-2xs uppercase text-ink-500 mb-1">Otros métodos (no afectan caja)</div>
            {data.breakdownCobrosNoEfectivo.length === 0 ? (
              <p className="text-xs text-ink-500 italic">Sin otros cobros</p>
            ) : (
              <ul className="text-xs space-y-1">
                {data.breakdownCobrosNoEfectivo.map((b, i) => (
                  <li key={i} className="flex justify-between">
                    <span>
                      {b.metodo} ({b.cantidad}){' '}
                      <span className="text-ink-500">→ {b.cuenta}</span>
                    </span>
                    <MoneyAmount value={b.monto} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* Movs que NO afectan caja (info, colapsable) */}
      {data.movsNoAfectanCaja.length > 0 && (
        <section className="card p-4">
          <details>
            <summary className="cursor-pointer font-display text-md text-ink-900">
              Otros movimientos del turno (no afectan caja) ({data.movsNoAfectanCaja.length})
            </summary>
            <p className="text-2xs text-ink-500 mt-2 mb-3">
              Movimientos que pasaron por bancos/wallets — se ven acá para auditoría pero no
              suman ni restan al efectivo esperado.
            </p>
            <MovList items={data.movsNoAfectanCaja} kind="neutral" />
          </details>
        </section>
      )}

      {/* Ventas */}
      <section className="card p-4">
        <h3 className="font-display text-md text-ink-900 mb-2">
          Ventas del turno ({data.ventas.finalizadas.length} finalizadas
          {data.ventas.anuladas.length > 0 && ` · ${data.ventas.anuladas.length} anuladas`}
          {data.ventas.procesadas > 0 && ` · ${data.ventas.procesadas} sin cerrar`})
        </h3>
        {data.ventas.finalizadas.length === 0 ? (
          <p className="text-xs text-ink-500 italic">Sin ventas finalizadas</p>
        ) : (
          <>
            <table className="w-full text-xs hidden md:table">
              <thead className="text-2xs uppercase text-ink-500 border-b border-cream-300">
                <tr>
                  <th className="text-left py-1">#</th>
                  <th className="text-left py-1">Hora</th>
                  <th className="text-left py-1">Canal</th>
                  <th className="text-left py-1">Modalidad</th>
                  <th className="text-right py-1">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.ventas.finalizadas.map((v) => (
                  <tr key={v.id} className="border-b border-cream-200">
                    <td className="py-1">#{v.numeroOrdenTurno}</td>
                    <td className="py-1 text-ink-500">{fmtTime(v.fechaFinalizacion)}</td>
                    <td className="py-1">{v.canal}</td>
                    <td className="py-1 text-ink-500">{v.modalidad}</td>
                    <td className="py-1 text-right">
                      <MoneyAmount value={v.total} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Tarjetas (mobile) */}
            <div className="md:hidden divide-y divide-cream-200">
              {data.ventas.finalizadas.map((v) => (
                <div key={v.id} className="py-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-ink-900 truncate">
                      #{v.numeroOrdenTurno} · {v.canal}
                    </div>
                    <div className="text-2xs font-mono text-ink-500 truncate">
                      {fmtTime(v.fechaFinalizacion)} · {v.modalidad}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <MoneyAmount value={v.total} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {data.ventas.anuladas.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-2xs text-pomodoro-600">
              Anuladas ({data.ventas.anuladas.length})
            </summary>
            <ul className="text-xs mt-2 space-y-1">
              {data.ventas.anuladas.map((v) => (
                <li key={v.id} className="text-ink-500 line-through">
                  #{v.numeroOrdenTurno} · {v.canal} · ${Number(v.total).toFixed(0)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* Observaciones */}
      {sesion.observaciones && (
        <section className="card p-4">
          <h3 className="text-2xs uppercase text-ink-500 mb-1">Observaciones</h3>
          <p className="text-sm text-ink-700 italic">{sesion.observaciones}</p>
        </section>
      )}
    </div>
  );
}

function DesgloseRow({
  label,
  valor,
  sign,
  tone,
  bold,
}: {
  label: string;
  valor: string;
  sign: string;
  tone: 'neutral' | 'ingreso' | 'egreso' | 'esperado' | 'contado' | 'cuadrado' | 'sobra' | 'falta';
  bold?: boolean;
}) {
  const toneClass = {
    neutral: 'text-ink-700',
    ingreso: 'text-basil-600',
    egreso: 'text-pomodoro-600',
    esperado: 'text-teresita-700',
    contado: 'text-ink-900',
    cuadrado: 'text-basil-600',
    sobra: 'text-saffron-600',
    falta: 'text-pomodoro-600',
  }[tone];
  return (
    <div className={cn('flex justify-between items-baseline', bold && 'font-semibold text-base')}>
      <span className={cn(bold ? 'text-ink-900' : 'text-ink-700')}>{label}</span>
      <span className={cn('font-mono', toneClass)}>
        {sign}
        <MoneyAmount value={valor} />
      </span>
    </div>
  );
}

function MovList({ items, kind }: { items: MovItem[]; kind: 'ingreso' | 'egreso' | 'neutral' }) {
  return (
    <>
      <table className="w-full text-xs hidden md:table">
        <thead className="text-2xs uppercase text-ink-500 border-b border-cream-300">
          <tr>
            <th className="text-left py-1">Hora</th>
            <th className="text-left py-1">Categoría</th>
            <th className="text-left py-1">Cuenta</th>
            <th className="text-left py-1">Observación</th>
            <th className="text-right py-1">Monto</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id} className="border-b border-cream-200">
              <td className="py-1 text-ink-500">{fmtTime(m.fecha)}</td>
              <td className="py-1">{m.categoria}</td>
              <td className="py-1 text-ink-500">
                {m.tipo === 'TRANSFERENCIA_INTERNA'
                  ? `${m.cuentaOrigen ?? '—'} → ${m.cuentaDestino ?? '—'}`
                  : m.cuentaOrigen ?? m.cuentaDestino ?? '—'}
              </td>
              <td className="py-1 text-ink-500 max-w-xs truncate" title={m.observacion ?? ''}>
                {m.observacion ?? '—'}
              </td>
              <td
                className={cn(
                  'py-1 text-right font-mono',
                  kind === 'ingreso' && 'text-basil-600',
                  kind === 'egreso' && 'text-pomodoro-600',
                )}
              >
                {kind === 'egreso' && '−'}
                <MoneyAmount value={m.monto} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Tarjetas (mobile) */}
      <div className="md:hidden divide-y divide-cream-200">
        {items.map((m) => (
          <div key={m.id} className="py-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium text-ink-900 truncate">{m.categoria}</div>
              <div className="text-2xs font-mono text-ink-500 truncate">
                {fmtTime(m.fecha)} ·{' '}
                {m.tipo === 'TRANSFERENCIA_INTERNA'
                  ? `${m.cuentaOrigen ?? '—'} → ${m.cuentaDestino ?? '—'}`
                  : m.cuentaOrigen ?? m.cuentaDestino ?? '—'}
              </div>
              {m.observacion && (
                <div className="text-2xs text-ink-500 truncate" title={m.observacion}>
                  {m.observacion}
                </div>
              )}
            </div>
            <div
              className={cn(
                'shrink-0 text-right font-mono',
                kind === 'ingreso' && 'text-basil-600',
                kind === 'egreso' && 'text-pomodoro-600',
              )}
            >
              {kind === 'egreso' && '−'}
              <MoneyAmount value={m.monto} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
