'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface SesionAbierta {
  id: string;
  fecha: string;
  turno: string;
  horarioApertura: string;
  abiertaPor: string | null;
  esActual: boolean;
}

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
  /**
   * Cobros de cuenta corriente de mayoristas del turno.
   *
   * Vienen aparte de `movimientos` a propósito: no son aportes ni egresos, son
   * mercadería ya entregada que se cobra ahora. Se muestran arriba, con las
   * ventas (pedido de la encargada).
   */
  cobrosCuentaCorriente?: Array<{
    id: string;
    monto: string;
    cliente: string;
    metodos: string[];
    cuenta: string | null;
  }>;
  totalCobrosCuentaCorriente?: string;
  movimientos: Array<{
    id: string;
    tipo: string;
    monto: string;
    categoria: string;
    observacion?: string | null;
    /** Cuánto de este movimiento tocó el cajón (con un pago repartido NO es el total). */
    efectoCaja?: string;
    /** "$40.000 Caja física + $60.000 Santander" cuando salió de varias cuentas. */
    reparto?: string | null;
  }>;
  ventasCount: number;
  ventasAbiertas: number;
  // Encargos A_PAGAR de la sesión: informativo, NO bloquean el cierre (se cobran
  // el día de entrega, días después, y ahí entran a la caja del momento).
  encargosAPagar?: number;
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

/** Banner de cajas de turnos anteriores sin cerrar, con botón para cerrar cada
 *  una. Se usa tanto en la vista normal como cuando no hay sesión del turno
 *  actual (sino el cartel del dashboard quedaba sin destino). */
function BannerViejas({
  viejas,
  onCerrar,
}: {
  viejas: SesionAbierta[];
  onCerrar: (s: SesionAbierta) => void;
}) {
  if (viejas.length === 0) return null;
  return (
    <div className="card p-3 bg-saffron-100 border-l-4 border-saffron-600">
      <div className="text-sm text-saffron-700 font-medium mb-2">
        ⚠ Hay {viejas.length} sesión{viejas.length > 1 ? 'es' : ''} de turnos
        anteriores sin cerrar. Cerralas para que no se mezclen con la de hoy.
      </div>
      <div className="space-y-1">
        {viejas.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between text-xs bg-white/60 rounded px-2 py-1"
          >
            <span className="text-ink-700">
              {new Date(s.fecha).toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' })}
              {' · '}
              {s.turno === 'MANANA' ? 'Mañana' : 'Tarde'}
              {s.abiertaPor && <span className="text-ink-500"> · abrió {s.abiertaPor}</span>}
            </span>
            <button
              onClick={() => onCerrar(s)}
              className="text-2xs font-medium text-pomodoro-600 hover:underline"
            >
              Cerrar esta
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SesionActualPage() {
  const [data, setData] = useState<SesionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = modal cerrado; 'normal' = cierre regular (fin de turno);
  // 'anticipado' = cerrá antes del horario configurado y el slot no se
  // reabre por el resto del día.
  const [showCierre, setShowCierre] = useState<'normal' | 'anticipado' | null>(null);
  // Sesiones viejas colgadas (de días/turnos anteriores sin cerrar).
  const [abiertas, setAbiertas] = useState<SesionAbierta[]>([]);
  // Cierre puntual de una sesión vieja (id explícito).
  const [cerrarVieja, setCerrarVieja] = useState<SesionAbierta | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get<SesionData>('/admin/caja/sesion-actual');
      setData(res);
      const ab = await api
        .get<{ sesiones: SesionAbierta[] }>('/admin/caja/sesiones-abiertas')
        .catch(() => ({ sesiones: [] as SesionAbierta[] }));
      // `?? []`: el .catch solo cubre errores lanzados, no una respuesta 200
      // con body vacío ({}); sin esto, `abiertas` quedaba undefined y la lista
      // de sesiones viejas rompía con `.map` de undefined.
      setAbiertas(ab.sesiones ?? []);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudo cargar la sesión');
      }
    }
  }, []);

  useEffect(() => {
    void fetchData();
    // 30s — el turno solo cambia en el cierre, 15s no aportaba info nueva
    // entre ticks. Reduce a la mitad la carga del endpoint.
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  if (error) return <div className="text-pomodoro-600">{error}</div>;
  if (!data) return <div className="text-ink-500">Cargando...</div>;

  // Cajas viejas colgadas (de turnos anteriores). Se calcula ANTES del early
  // return de "sin sesión" para poder mostrarlas/cerrarlas aunque todavía no
  // haya sesión del turno actual — sino el cartel rojo del dashboard llevaba a
  // un callejón sin salida (caso: a la mañana, sin la primera venta cargada).
  const viejasSinCerrar = abiertas.filter((sa) => !sa.esActual);

  if (!data.sesion) {
    const r = data.resolucion;
    const cerrado = r?.tipo === 'CERRADO';
    return (
      <div className="max-w-md mx-auto space-y-4">
        <BannerViejas viejas={viejasSinCerrar} onCerrar={setCerrarVieja} />
        <div className="card p-8 text-center">
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
        {cerrarVieja && (
          <ModalCerrarSesion
            esperada={null}
            modo="normal"
            sesionId={cerrarVieja.id}
            tituloExtra={`${new Date(cerrarVieja.fecha).toLocaleDateString('es-AR', { timeZone: 'UTC' })} · ${cerrarVieja.turno}`}
            onClose={() => setCerrarVieja(null)}
            onCerrada={() => {
              setCerrarVieja(null);
              void fetchData();
            }}
          />
        )}
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
      <BannerViejas viejas={viejasSinCerrar} onCerrar={setCerrarVieja} />
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
            // `fecha` es @db.Date (medianoche UTC). Sin timeZone:'UTC' el
            // navegador en AR (UTC-3) la corre un día atrás (bug reportado:
            // "sesión actual" marcaba 3 de junio en vez de 4).
            timeZone: 'UTC',
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
            Apertura: {new Date(s.horarioApertura).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' })} · {s.usuarioApertura}
          </span>
          {s.horarioCierre && (
            <span className="text-ink-500">
              · Cierre:{' '}
              {new Date(s.horarioCierre).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' })} ·{' '}
              {s.usuarioCierre}
            </span>
          )}
        </div>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Ventas finalizadas</div>
          <div className="hero-number text-2xl text-ink-900">{data.ventasCount}</div>
          {data.ventasAbiertas > 0 && (
            <div className="text-xs text-saffron-600 mt-1">
              {data.ventasAbiertas} pedido{data.ventasAbiertas > 1 ? 's' : ''} abierto
              {data.ventasAbiertas > 1 ? 's' : ''}
            </div>
          )}
          {(data.encargosAPagar ?? 0) > 0 && (
            <div className="text-xs text-ink-500 mt-1">
              📦 {data.encargosAPagar} encargo{(data.encargosAPagar ?? 0) > 1 ? 's' : ''} a pagar ·
              {' '}se cobra{(data.encargosAPagar ?? 0) > 1 ? 'n' : ''} el día de entrega (no bloquea el cierre)
            </div>
          )}
        </div>
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Cobrado total</div>
          <MoneyAmount value={totalCobrado.toFixed(2)} hero fit className="text-2xl text-teresita-700" />
        </div>
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Egresos turno</div>
          <MoneyAmount value={data.totalEgresos} hero fit className="text-2xl text-pomodoro-600" />
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

      {/* Cobros de cuenta corriente — van acá arriba, con las ventas, y NO
          abajo entre los aportes y egresos: es mercadería ya entregada que se
          cobra hoy, no un ajuste de caja. */}
      {(data.cobrosCuentaCorriente?.length ?? 0) > 0 && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-1">
            Cobros de cuenta corriente
          </h2>
          <p className="text-2xs text-ink-500 mb-3">
            Mayoristas que pagaron mercadería ya entregada. Ya están incluidos en el total
            cobrado de arriba.
          </p>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-cream-200">
              {data.cobrosCuentaCorriente!.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 text-ink-700">
                    {c.cliente}
                    <div className="text-2xs text-ink-500">
                      {c.metodos.map((m) => METODO_LABEL[m] ?? m).join(' + ') || '—'}
                      {c.cuenta && ` · ${c.cuenta}`}
                    </div>
                  </td>
                  <td className="py-2 text-right align-top">
                    <MoneyAmount value={c.monto} className="text-teresita-700" />
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-2">Total</td>
                <td className="py-2 text-right">
                  <MoneyAmount
                    value={data.totalCobrosCuentaCorriente ?? '0'}
                    className="text-teresita-700"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

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
                    <td className="py-2 text-ink-700">
                      {m.categoria}
                      {/* La aclaración distingue dos egresos de la misma
                          categoría — ej. dos pagos a "Sueldos" donde uno es
                          por un servicio puntual. */}
                      {m.observacion && (
                        <div className="text-2xs text-ink-500" title={m.observacion}>
                          {m.observacion}
                        </div>
                      )}
                      {/* Un pago repartido entre cuentas se veía como si hubiera
                          salido entero de una sola. Mostrarlo evita la sorpresa
                          de que la caja no cierre por la parte en efectivo. */}
                      {m.reparto && (
                        <div className="text-2xs text-saffron-700">{m.reparto}</div>
                      )}
                    </td>
                    <td className="py-2 text-right align-top">
                      <MoneyAmount value={m.monto} className="text-pomodoro-600" />
                      {m.reparto && (
                        <div className="text-2xs text-ink-500">
                          {Number(m.efectoCaja ?? 0) === 0
                            ? 'no toca la caja'
                            : `del cajón: $${Math.abs(Number(m.efectoCaja)).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`}
                        </div>
                      )}
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
        <div className="space-y-2">
          <Button onClick={() => setShowCierre('normal')} fullWidth size="lg">
            Cerrar sesión y contar caja
          </Button>
          <Button
            onClick={() => setShowCierre('anticipado')}
            fullWidth
            size="md"
            variant="secondary"
          >
            ⏱ Cerrar anticipado (terminamos antes del horario)
          </Button>
          <p className="text-xs text-ink-500 px-1">
            "Cerrar anticipado" cierra el turno y bloquea cargar más ventas en este slot por
            el resto del día. La próxima venta/movimiento abrirá el siguiente turno cuando
            llegue su horario.
          </p>
        </div>
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
          modo={showCierre}
          sesionId={data.sesion.id}
          onClose={() => setShowCierre(null)}
          onCerrada={() => {
            setShowCierre(null);
            void fetchData();
          }}
        />
      )}

      {cerrarVieja && (
        <ModalCerrarSesion
          esperada={null}
          modo="normal"
          sesionId={cerrarVieja.id}
          tituloExtra={`${new Date(cerrarVieja.fecha).toLocaleDateString('es-AR', { timeZone: 'UTC' })} · ${cerrarVieja.turno}`}
          onClose={() => setCerrarVieja(null)}
          onCerrada={() => {
            setCerrarVieja(null);
            void fetchData();
          }}
        />
      )}
    </div>
  );
}

function ModalCerrarSesion({
  esperada,
  modo,
  sesionId,
  tituloExtra,
  onClose,
  onCerrada,
}: {
  // null = no conocemos el esperado de antemano (sesión vieja); el server lo
  // calcula al cerrar. En ese caso no mostramos preview de diferencia.
  esperada: string | null;
  modo: 'normal' | 'anticipado';
  sesionId: string;
  tituloExtra?: string;
  onClose: () => void;
  onCerrada: () => void;
}) {
  const [contado, setContado] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resumen de cierre de ESTA sesión (esperado + desglose). Para cajas viejas
  // "colgadas" el padre no lo conoce (pasa esperada=null), así que lo pedimos
  // por sesionId → el modal muestra la MISMA info que un cierre normal.
  const [resumen, setResumen] = useState<SesionData | null>(null);
  useEffect(() => {
    let vivo = true;
    api
      .get<SesionData>(`/admin/caja/sesion-actual?sesionId=${sesionId}`)
      .then((r) => {
        if (vivo) setResumen(r);
      })
      .catch(() => {
        /* si falla, el server igual calcula el esperado al cerrar */
      });
    return () => {
      vivo = false;
    };
  }, [sesionId]);

  // Esperado efectivo: el del resumen recién pedido gana; si aún no cargó, el
  // que pasó el padre (cierre normal). Puede ser null (vieja, sin cargar aún).
  const esperadaEfectiva = resumen?.recaudacionEsperadaEfectivo ?? esperada;
  const diferencia =
    contado && esperadaEfectiva != null ? Number(contado) - Number(esperadaEfectiva) : null;
  const esAnticipado = modo === 'anticipado';

  async function submit() {
    if (!contado || Number(contado) < 0) return setError('Ingresá el monto contado');
    setGuardando(true);
    try {
      await api.post('/admin/caja/sesion-actual/cerrar', {
        existenciaFinal: contado,
        observaciones: observaciones || undefined,
        anticipado: esAnticipado,
        // Cerramos EXACTAMENTE la sesión que la pantalla está mostrando — no
        // dejamos que el server re-resuelva y agarre una sesión vieja.
        sesionId,
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
      <div className="card w-full max-w-md p-5 shadow-modal max-h-[88vh] overflow-y-auto">
        <h2 className="font-display text-lg text-teresita-700 mb-3">
          {esAnticipado ? '⏱ Cierre anticipado de turno' : 'Contar caja física'}
          {tituloExtra && (
            <span className="block text-xs font-normal text-ink-500 mt-0.5">
              Sesión vieja sin cerrar · {tituloExtra}
            </span>
          )}
        </h2>
        {esAnticipado && (
          <div className="mb-3 p-3 rounded bg-saffron-100 text-saffron-600 text-xs">
            Vas a cerrar el turno <strong>antes del horario configurado</strong>. Después de
            esto no se pueden cargar más ventas ni movimientos en este turno por el resto
            del día. La próxima venta abrirá el siguiente turno cuando llegue su horario.
          </div>
        )}
        <p className="text-sm text-ink-500 mb-4">
          {esperadaEfectiva != null ? (
            <>
              El sistema espera{' '}
              <MoneyAmount value={esperadaEfectiva} className="font-medium text-ink-900" /> en
              efectivo. Contá lo que hay en la caja y cargalo abajo.
            </>
          ) : (
            <>Contá lo que hay en la caja y cargalo abajo. El sistema calcula la diferencia al cerrar.</>
          )}
        </p>

        {/* Desglose completo del cierre — la MISMA info que el cierre normal,
            también para las cajas viejas colgadas (fix: antes no se veía el
            esperado ni el desglose al cerrar una caja de un turno anterior). */}
        {resumen?.sesion && (
          <div className="mb-4 p-3 rounded bg-surface-sunken text-sm font-mono space-y-1">
            <div className="flex justify-between">
              <span className="text-ink-500">Existencia inicial</span>
              <MoneyAmount value={resumen.sesion.existenciaInicial} />
            </div>
            <div className="flex justify-between">
              <span className="text-ink-500">+ Cobros en efectivo</span>
              <MoneyAmount value={resumen.totalEfectivo} />
            </div>
            <div className="flex justify-between">
              <span className="text-ink-500">− Egresos del turno</span>
              <MoneyAmount value={resumen.totalEgresos} className="text-pomodoro-600" />
            </div>
            <div className="flex justify-between border-t border-cream-300 pt-1 font-semibold">
              <span>Total esperado</span>
              <MoneyAmount value={resumen.recaudacionEsperadaEfectivo} className="text-teresita-700" />
            </div>
            <div className="pt-1 text-xs text-ink-500 font-sans">
              {resumen.ventasCount} venta{resumen.ventasCount !== 1 ? 's' : ''} finalizada
              {resumen.ventasCount !== 1 ? 's' : ''}
              {resumen.movimientos.length > 0 &&
                ` · ${resumen.movimientos.length} movimiento${resumen.movimientos.length !== 1 ? 's' : ''}`}
            </div>
            {resumen.cobrosPorMetodo.length > 0 && (
              <div className="pt-2 border-t border-cream-300 space-y-0.5">
                {resumen.cobrosPorMetodo.map((c) => (
                  <div key={c.metodo} className="flex justify-between text-xs">
                    <span className="text-ink-500 font-sans">
                      {METODO_LABEL[c.metodo] ?? c.metodo} ({c.cantidad})
                    </span>
                    <MoneyAmount value={c.monto} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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
            {guardando
              ? 'Cerrando...'
              : esAnticipado
                ? 'Cerrar turno anticipado'
                : 'Cerrar sesión'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
