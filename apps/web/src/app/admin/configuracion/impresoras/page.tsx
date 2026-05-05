'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

type Destino = 'KITCHEN' | 'COUNTER' | 'DELIVERY';

interface ConfigImpresora {
  host: string;
  port: number;
  width: number;
  activa: boolean;
}

type ConfigPrinters = Record<Destino, ConfigImpresora>;

interface JobsListado {
  jobs: Array<{
    id: string;
    tipo: string;
    destino: string;
    estado: string;
    intentos: number;
    ultimoError: string | null;
    encoladoAt: string;
    procesadoAt: string | null;
    impresoAt: string | null;
  }>;
  counts: Record<string, number>;
}

const DESTINOS_INFO: Record<Destino, { titulo: string; descripcion: string; icon: string }> = {
  KITCHEN: {
    titulo: 'Cocina',
    descripcion: 'Comanda térmica con items para que la cocinera prepare. Incluye datos de delivery.',
    icon: '🍝',
  },
  COUNTER: {
    titulo: 'Mostrador',
    descripcion: 'Ticket no fiscal para el cliente. Sale al cobrar la venta.',
    icon: '🏪',
  },
  DELIVERY: {
    titulo: 'Delivery',
    descripcion: 'Ticket separado para el motoquero (opcional). Si no se activa, todo va por Cocina.',
    icon: '🛵',
  },
};

export default function ImpresorasConfigPage() {
  const [config, setConfig] = useState<ConfigPrinters | null>(null);
  const [edit, setEdit] = useState<ConfigPrinters | null>(null);
  const [jobs, setJobs] = useState<JobsListado | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function fetchConfig() {
    try {
      const c = await api.get<ConfigPrinters>('/admin/impresion/config');
      setConfig(c);
      setEdit(c);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudo cargar la configuración');
      }
    }
  }
  async function fetchJobs() {
    try {
      const j = await api.get<JobsListado>('/admin/impresion/jobs?limit=20');
      setJobs(j);
    } catch {
      /* silencioso */
    }
  }

  useEffect(() => {
    void fetchConfig();
    void fetchJobs();
    const id = setInterval(() => void fetchJobs(), 5000);
    return () => clearInterval(id);
  }, []);

  function setField(d: Destino, patch: Partial<ConfigImpresora>) {
    if (!edit) return;
    setEdit({ ...edit, [d]: { ...edit[d], ...patch } });
  }

  async function guardar() {
    if (!edit) return;
    setGuardando(true);
    setError(null);
    setInfo(null);
    try {
      await api.put('/admin/impresion/config', edit);
      setConfig(edit);
      setInfo('✓ Configuración guardada');
      setTimeout(() => setInfo(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setGuardando(false);
    }
  }

  async function imprimirTest(destino: Destino) {
    setError(null);
    setInfo(null);
    try {
      await api.post('/admin/impresion/test', { destino });
      setInfo(`✓ Test encolado para ${DESTINOS_INFO[destino].titulo}. Esperá 2-5 seg.`);
      setTimeout(() => setInfo(null), 5000);
      void fetchJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo encolar el test');
    }
  }

  async function reintentar(jobId: string) {
    try {
      await api.post(`/admin/impresion/${jobId}/reintentar`, {});
      void fetchJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo reintentar');
    }
  }

  const dirty =
    config && edit && (['KITCHEN', 'COUNTER', 'DELIVERY'] as Destino[]).some(
      (d) => JSON.stringify(config[d]) !== JSON.stringify(edit[d]),
    );

  if (!config || !edit) {
    return <div className="text-ink-500 py-8 text-center">Cargando...</div>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="font-display text-md text-ink-900">Impresoras térmicas</h2>
        <p className="text-sm text-ink-500">
          Configurá las impresoras del local (cocina, mostrador, delivery). Cada una se conecta
          por red Ethernet (TCP). Si todavía no las tenés instaladas, dejá los valores default
          y configurá cuando estén físicamente conectadas.
        </p>
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}
      {info && (
        <div className="bg-basil-100 text-basil-600 px-3 py-2 rounded text-sm">{info}</div>
      )}

      {/* Cards de cada destino */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {(['KITCHEN', 'COUNTER', 'DELIVERY'] as Destino[]).map((d) => {
          const meta = DESTINOS_INFO[d];
          const cfg = edit[d];
          return (
            <section
              key={d}
              className={cn(
                'card p-4 space-y-3 border-t-4',
                cfg.activa ? 'border-teresita-700' : 'border-cream-300 opacity-70',
              )}
            >
              <header>
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-md text-ink-900">
                    <span className="mr-1">{meta.icon}</span>
                    {meta.titulo}
                  </h3>
                  <label className="flex items-center gap-1 cursor-pointer text-2xs">
                    <input
                      type="checkbox"
                      checked={cfg.activa}
                      onChange={(e) => setField(d, { activa: e.target.checked })}
                      className="w-3.5 h-3.5"
                    />
                    Activa
                  </label>
                </div>
                <p className="text-2xs text-ink-500 mt-0.5">{meta.descripcion}</p>
              </header>

              <div className="space-y-2">
                <div>
                  <label className="block text-2xs font-medium text-ink-700 mb-0.5">
                    IP / hostname
                  </label>
                  <input
                    type="text"
                    value={cfg.host}
                    onChange={(e) => setField(d, { host: e.target.value })}
                    placeholder="192.168.1.50"
                    className="input text-sm py-1.5 font-mono w-full"
                    disabled={!cfg.activa}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-2xs font-medium text-ink-700 mb-0.5">
                      Puerto
                    </label>
                    <input
                      type="number"
                      value={cfg.port}
                      onChange={(e) => setField(d, { port: Number(e.target.value) || 9100 })}
                      placeholder="9100"
                      className="input text-sm py-1.5 font-mono w-full"
                      disabled={!cfg.activa}
                    />
                  </div>
                  <div>
                    <label className="block text-2xs font-medium text-ink-700 mb-0.5">
                      Ancho (chars)
                    </label>
                    <input
                      type="number"
                      value={cfg.width}
                      onChange={(e) => setField(d, { width: Number(e.target.value) || 42 })}
                      className="input text-sm py-1.5 font-mono w-full"
                      disabled={!cfg.activa}
                    />
                    <p className="text-2xs text-ink-400 mt-0.5">
                      80mm = 42 · 58mm = 32
                    </p>
                  </div>
                </div>
              </div>

              <Button
                size="sm"
                variant="secondary"
                fullWidth
                disabled={!cfg.activa}
                onClick={() => void imprimirTest(d)}
              >
                🖨️ Imprimir test
              </Button>
            </section>
          );
        })}
      </div>

      {/* Footer con guardar */}
      <footer className="flex justify-end gap-2 sticky bottom-0 bg-cream-50 border-t border-cream-300 py-3">
        <Button
          variant="secondary"
          onClick={() => setEdit(config)}
          disabled={!dirty || guardando}
        >
          Descartar cambios
        </Button>
        <Button onClick={() => void guardar()} disabled={!dirty || guardando}>
          {guardando ? 'Guardando...' : 'Guardar configuración'}
        </Button>
      </footer>

      {/* Listado de jobs recientes (debug / monitoreo) */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken flex items-center justify-between">
          <h3 className="font-display text-md text-ink-900">Cola de impresión (24h)</h3>
          <div className="flex gap-3 text-2xs">
            {jobs?.counts &&
              Object.entries(jobs.counts).map(([estado, count]) => (
                <span
                  key={estado}
                  className={cn(
                    'px-2 py-0.5 rounded font-medium',
                    estado === 'IMPRESO' && 'bg-basil-100 text-basil-600',
                    estado === 'PENDIENTE' && 'bg-saffron-100 text-saffron-600',
                    estado === 'EN_PROCESO' && 'bg-ocean-100 text-ocean-600',
                    estado === 'ERROR' && 'bg-pomodoro-100 text-pomodoro-600',
                  )}
                >
                  {estado}: {count}
                </span>
              ))}
          </div>
        </header>
        {jobs?.jobs.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-ink-500">
            Sin trabajos en las últimas 24 horas. Cuando se cargue una venta con items de cocina
            (o se imprima un test), aparece acá.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-4 py-2">Hora</th>
                <th className="text-left px-4 py-2">Tipo</th>
                <th className="text-left px-4 py-2">Destino</th>
                <th className="text-center px-4 py-2">Estado</th>
                <th className="text-center px-4 py-2">Intentos</th>
                <th className="text-left px-4 py-2">Error</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {jobs?.jobs.map((j) => {
                const fecha = new Date(j.encoladoAt);
                return (
                  <tr key={j.id} className="hover:bg-cream-100">
                    <td className="px-4 py-2 font-mono text-ink-500">
                      {fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td className="px-4 py-2 text-ink-700">{j.tipo.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="px-4 py-2 text-ink-700">{j.destino}</td>
                    <td className="px-4 py-2 text-center">
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded font-medium uppercase tracking-wider text-2xs',
                          j.estado === 'IMPRESO' && 'bg-basil-100 text-basil-600',
                          j.estado === 'PENDIENTE' && 'bg-saffron-100 text-saffron-600',
                          j.estado === 'EN_PROCESO' && 'bg-ocean-100 text-ocean-600',
                          j.estado === 'ERROR' && 'bg-pomodoro-100 text-pomodoro-600',
                          j.estado === 'CANCELADO' && 'bg-cream-200 text-ink-500',
                        )}
                      >
                        {j.estado}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-center font-mono text-ink-500">{j.intentos}</td>
                    <td className="px-4 py-2 text-ink-700 truncate max-w-[200px]" title={j.ultimoError ?? ''}>
                      {j.ultimoError ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {j.estado === 'ERROR' && (
                        <button
                          onClick={() => void reintentar(j.id)}
                          className="text-2xs text-teresita-700 hover:underline"
                        >
                          reintentar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
