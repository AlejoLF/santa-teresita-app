'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface SesionData {
  sesion: {
    id: string;
    fecha: string;
    turno: 'MANANA' | 'TARDE';
    estado: 'ABIERTA' | 'CERRADA' | 'APROBADA';
    horarioApertura: string;
    horarioCierre: string | null;
    existenciaInicial: string;
    existenciaFinal: string | null;
    diferencia: string | null;
    aprobadaPorAdmin: boolean;
    usuarioApertura: string;
    usuarioCierre: string | null;
  } | null;
  cobrosPorMetodo: Array<{ metodo: string; monto: string; cantidad: number }>;
  movimientos: Array<{ id: string; tipo: string; monto: string; categoria: string }>;
  ventasCount: number;
  ventasAbiertas: number;
  totalEfectivo: string;
  totalEgresos: string;
  recaudacionEsperadaEfectivo: string;
  resolucion?: ResolucionHorario;
}

type SlotInfo = {
  slot: { id: string; turno: string; horaInicio: string; horaFin: string; ventanaCierreMin: number };
  estado: 'ACTIVO' | 'GRACE';
  minutosRestantes: number;
};

type ResolucionHorario =
  | { tipo: 'EN_HORARIO'; slot: SlotInfo }
  | {
      tipo: 'CERRADO';
      razon: 'FERIADO' | 'FUERA_DE_HORARIO';
      proximaApertura?: { horaInicio: string; turno: string; minutosEspera: number; fechaSesion: string };
    };

function formatearEspera(min: number): string {
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return `en ${h}h ${m > 0 ? m + 'min' : ''}`.trim();
  const d = Math.floor(h / 24);
  return `en ${d} día${d > 1 ? 's' : ''}`;
}

const METODO_LABEL: Record<string, string> = {
  EFECTIVO: '💵 Efectivo',
  DEBITO: '💳 Débito',
  CREDITO_1_PAGO: '💳 Crédito',
  CREDITO_CUOTAS: '💳 Crédito cuotas',
  TRANSFERENCIA: '🏦 Transferencia',
  MERCADOPAGO_QR: '📱 MP / QR',
  CHEQUE: '📄 Cheque',
  TARJETA_NARANJA: '💳 Naranja',
  OTRO: '❓ Otro',
};

export default function SesionActualPage() {
  const [data, setData] = useState<SesionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCierre, setShowCierre] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get<SesionData>('/admin/caja/sesion-actual');
      setData(res);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudo cargar la sesión');
      }
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const id = setInterval(fetchData, 15_000);
    return () => clearInterval(id);
  }, [fetchData]);

  if (error) return <div className="text-pomodoro-600">{error}</div>;
  if (!data) return <div className="text-ink-500">Cargando...</div>;

  if (!data.sesion) {
    const r = data.resolucion;
    const cerrado = r?.tipo === 'CERRADO';
    return (
      <div className="card p-8 text-center max-w-md mx-auto">
        <div className="text-3xl mb-3">{cerrado ? '🔒' : '🌅'}</div>
        <h2 className="font-display text-md text-ink-900 mb-2">
          {cerrado
            ? r?.razon === 'FERIADO'
              ? 'Hoy es feriado'
              : 'Fuera del horario de atención'
            : 'Sin sesión abierta'}
        </h2>
        <p className="text-sm text-ink-500">
          {cerrado
            ? r?.proximaApertura
              ? `Próxima apertura ${formatearEspera(r.proximaApertura.minutosEspera)} (${r.proximaApertura.horaInicio})`
              : 'Revisá la configuración de horarios.'
            : 'La sesión se abre automáticamente cuando se carga la primera venta del turno.'}
        </p>
      </div>
    );
  }

  const s = data.sesion;
  const totalCobrado = data.cobrosPorMetodo.reduce((acc, c) => acc + Number(c.monto), 0);
  const aprobada = s.estado === 'APROBADA';
  const cerrada = s.estado === 'CERRADA';
  const abierta = s.estado === 'ABIERTA';

  async function aprobar() {
    try {
      await api.post(`/admin/caja/sesion/${s.id}/aprobar`, {});
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al aprobar');
    }
  }

  const r = data.resolucion;
  const enGrace = r?.tipo === 'EN_HORARIO' && r.slot.estado === 'GRACE';
  const fueraDeHorario = r?.tipo === 'CERRADO';

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {enGrace && r.tipo === 'EN_HORARIO' && (
        <div className="card p-3 bg-saffron-100 text-saffron-600 text-sm flex items-center gap-2">
          ⏳ Ventana de cierre — quedan {r.slot.minutosRestantes} min para cargar ventas tardías
          de este turno.
        </div>
      )}
      {fueraDeHorario && abierta && (
        <div className="card p-3 bg-pomodoro-100 text-pomodoro-600 text-sm flex items-center gap-2">
          🔒 Esta sesión está fuera del horario configurado. No se pueden cargar más ventas;
          contá la caja y cerrala.
        </div>
      )}
      <header>
        <h1 className="font-display text-xl text-ink-900">
          Sesión {s.turno === 'MANANA' ? 'Mañana' : 'Tarde'} ·{' '}
          {new Date(s.fecha).toLocaleDateString('es-AR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </h1>
        <div className="flex items-center gap-3 mt-1 text-sm">
          <span
            className={cn(
              'text-2xs font-medium px-2 py-0.5 rounded uppercase tracking-wider',
              abierta && 'bg-saffron-100 text-saffron-600',
              cerrada && 'bg-ocean-100 text-ocean-600',
              aprobada && 'bg-basil-100 text-basil-600',
            )}
          >
            {s.estado.toLowerCase()}
          </span>
          <span className="text-ink-500">
            Apertura: {new Date(s.horarioApertura).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })} · {s.usuarioApertura}
          </span>
          {s.horarioCierre && (
            <span className="text-ink-500">
              · Cierre:{' '}
              {new Date(s.horarioCierre).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })} ·{' '}
              {s.usuarioCierre}
            </span>
          )}
        </div>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Ventas finalizadas</div>
          <div className="hero-number text-2xl text-ink-900">{data.ventasCount}</div>
          {data.ventasAbiertas > 0 && (
            <div className="text-xs text-saffron-600 mt-1">
              {data.ventasAbiertas} pedido{data.ventasAbiertas > 1 ? 's' : ''} abierto
              {data.ventasAbiertas > 1 ? 's' : ''}
            </div>
          )}
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Cobrado total</div>
          <MoneyAmount value={totalCobrado.toFixed(2)} hero className="text-2xl text-teresita-700" />
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Egresos turno</div>
          <MoneyAmount value={data.totalEgresos} hero className="text-2xl text-pomodoro-600" />
        </div>
      </section>

      {/* Desglose por método de pago */}
      <section className="card p-5">
        <h2 className="font-display text-md text-ink-900 mb-3">Cobros por método</h2>
        {data.cobrosPorMetodo.length === 0 ? (
          <p className="text-sm text-ink-500">Sin cobros confirmados aún en este turno.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-cream-200">
              {data.cobrosPorMetodo.map((c) => (
                <tr key={c.metodo}>
                  <td className="py-2 text-ink-700">{METODO_LABEL[c.metodo] ?? c.metodo}</td>
                  <td className="py-2 text-right text-ink-500 text-xs">{c.cantidad} pagos</td>
                  <td className="py-2 text-right">
                    <MoneyAmount value={c.monto} />
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-2">Total</td>
                <td className="py-2"></td>
                <td className="py-2 text-right">
                  <MoneyAmount value={totalCobrado.toFixed(2)} className="text-teresita-700" />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {/* Egresos del turno */}
      {data.movimientos.length > 0 && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Egresos del turno</h2>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-cream-200">
              {data.movimientos
                .filter((m) => m.tipo === 'EGRESO')
                .map((m) => (
                  <tr key={m.id}>
                    <td className="py-2 text-ink-700">{m.categoria}</td>
                    <td className="py-2 text-right">
                      <MoneyAmount value={m.monto} className="text-pomodoro-600" />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Caja física esperada */}
      <section className="card p-5 bg-surface-sunken">
        <h2 className="font-display text-md text-ink-900 mb-3">Caja física esperada</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm font-mono">
          <span>Existencia inicial:</span>
          <span className="text-right">
            <MoneyAmount value={s.existenciaInicial} />
          </span>
          <span>+ Cobros en efectivo:</span>
          <span className="text-right">
            <MoneyAmount value={data.totalEfectivo} />
          </span>
          <span>− Egresos del turno:</span>
          <span className="text-right">
            <MoneyAmount value={data.totalEgresos} className="text-pomodoro-600" />
          </span>
          <span className="border-t border-cream-300 pt-2 font-semibold">Total esperado:</span>
          <span className="border-t border-cream-300 pt-2 text-right font-semibold">
            <MoneyAmount value={data.recaudacionEsperadaEfectivo} className="text-teresita-700 text-md" />
          </span>
        </div>

        {cerrada && (
          <div className="mt-4 pt-4 border-t border-cream-300 grid grid-cols-2 gap-2 text-sm font-mono">
            <span>Contado físicamente:</span>
            <span className="text-right">
              <MoneyAmount value={s.existenciaFinal ?? '0'} />
            </span>
            <span className="font-semibold">Diferencia:</span>
            <span
              className={cn(
                'text-right font-semibold',
                Number(s.diferencia ?? 0) === 0 && 'text-basil-600',
                Number(s.diferencia ?? 0) < 0 && 'text-pomodoro-600',
                Number(s.diferencia ?? 0) > 0 && 'text-saffron-600',
              )}
            >
              <MoneyAmount value={s.diferencia ?? '0'} />
            </span>
          </div>
        )}
      </section>

      {/* Acciones */}
      {abierta && data.ventasAbiertas === 0 && (
        <Button onClick={() => setShowCierre(true)} fullWidth size="lg">
          Cerrar sesión y contar caja
        </Button>
      )}
      {abierta && data.ventasAbiertas > 0 && (
        <div className="card p-4 bg-saffron-100 text-saffron-600 text-sm">
          ⚠ Hay {data.ventasAbiertas} pedido{data.ventasAbiertas > 1 ? 's' : ''} abierto
          {data.ventasAbiertas > 1 ? 's' : ''}. Cerralos antes de cerrar la sesión.
        </div>
      )}
      {cerrada && (
        <Button onClick={aprobar} fullWidth size="lg">
          ✓ Aprobar cierre
        </Button>
      )}
      {aprobada && (
        <div className="card p-4 bg-basil-100 text-basil-600 text-sm flex items-center gap-2">
          ✓ Sesión aprobada. Los movimientos quedaron registrados definitivamente.
        </div>
      )}

      {showCierre && data.sesion && (
        <ModalCerrarSesion
          esperada={data.recaudacionEsperadaEfectivo}
          onClose={() => setShowCierre(false)}
          onCerrada={() => {
            setShowCierre(false);
            void fetchData();
          }}
        />
      )}
    </div>
  );
}

function ModalCerrarSesion({
  esperada,
  onClose,
  onCerrada,
}: {
  esperada: string;
  onClose: () => void;
  onCerrada: () => void;
}) {
  const [contado, setContado] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diferencia = contado ? Number(contado) - Number(esperada) : null;

  async function submit() {
    if (!contado || Number(contado) < 0) return setError('Ingresá el monto contado');
    setGuardando(true);
    try {
      await api.post('/admin/caja/sesion-actual/cerrar', {
        existenciaFinal: contado,
        observaciones: observaciones || undefined,
      });
      onCerrada();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cerrar');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Contar caja física</h2>
        <p className="text-sm text-ink-500 mb-4">
          El sistema espera <MoneyAmount value={esperada} className="font-medium text-ink-900" /> en
          efectivo. Contá lo que hay en la caja y cargalo abajo.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Total contado en efectivo
            </label>
            <input
              type="number"
              step="0.01"
              value={contado}
              onChange={(e) => setContado(e.target.value)}
              className="input font-mono text-lg"
              placeholder="0.00"
              autoFocus
            />
          </div>

          {diferencia !== null && (
            <div
              className={cn(
                'p-3 rounded text-sm',
                Math.abs(diferencia) < 0.01 && 'bg-basil-100 text-basil-600',
                diferencia < 0 && 'bg-pomodoro-100 text-pomodoro-600',
                diferencia > 0 && 'bg-saffron-100 text-saffron-600',
              )}
            >
              {Math.abs(diferencia) < 0.01 ? (
                <>✓ Cuadra perfecto.</>
              ) : diferencia < 0 ? (
                <>
                  Faltan <MoneyAmount value={String(-diferencia)} className="font-medium" />
                </>
              ) : (
                <>
                  Sobran <MoneyAmount value={String(diferencia)} className="font-medium" />
                </>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Observaciones (opcional)
            </label>
            <textarea
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              className="input min-h-[60px]"
              placeholder="ej. Falta plata por un cobro mal registrado..."
            />
          </div>

          {error && (
            <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={guardando}>
            {guardando ? 'Cerrando...' : 'Cerrar sesión'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
