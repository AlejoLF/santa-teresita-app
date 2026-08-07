'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

type Destino = 'MOSTRADOR' | 'DELIVERY' | 'COCINA';

interface ConfigImpresora {
  host: string;
  port: number;
  width: number;
  activa: boolean;
  /** Canales cuyos pedidos imprimen su comanda en esta comandera. */
  canales: string[];
  /** ¿Esta comandera imprime los tickets de ENCARGO? (panel dedicado). */
  encargos?: boolean;
  /** ¿Y los REMITOS de mayorista? Por defecto sólo Mostrador. */
  remitos?: boolean;
  /** Nombre visible editable. Vacío = se usa el título por defecto. */
  nombre?: string;
}

type ConfigPrinters = Record<Destino, ConfigImpresora>;

// Canales enrutables con etiqueta legible (mismo orden que el enum del backend).
const CANALES: Array<{ valor: string; label: string; icono: string }> = [
  { valor: 'MOSTRADOR', label: 'Mostrador', icono: '🏪' },
  { valor: 'TELEFONO', label: 'Teléfono', icono: '📞' },
  { valor: 'WHATSAPP', label: 'WhatsApp', icono: '💬' },
  { valor: 'WEB', label: 'Web', icono: '🌐' },
  { valor: 'RAPPI', label: 'Rappi', icono: '🛵' },
  { valor: 'PEDIDOS_YA', label: 'Pedidos Ya', icono: '🛵' },
  { valor: 'MERCADO_LIBRE', label: 'Mercado Libre', icono: '📦' },
  { valor: 'DELIVERATE', label: 'Deliverate', icono: '🛵' },
];

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

const DESTINOS_INFO: Record<Destino, { titulo: string; descripcion: string; icon: string; numero: number }> = {
  MOSTRADOR: {
    numero: 1,
    titulo: 'Comandera 1 · Mostrador',
    descripcion: 'Recibe TODOS los pedidos cobrados en mostrador (frescos y calientes).',
    icon: '🏪',
  },
  DELIVERY: {
    numero: 2,
    titulo: 'Comandera 2 · Delivery',
    descripcion: 'Recibe los pedidos de delivery propio (Teléfono, WhatsApp).',
    icon: '🛵',
  },
  COCINA: {
    numero: 3,
    titulo: 'Comandera 3 · Cocina',
    descripcion: 'Recibe pedidos con items que requieren cocción + TODOS los de apps (RAPPI, Pedidos YA, MELI, DELIVERATE).',
    icon: '🍝',
  },
};

interface PrinterStatus {
  online: boolean;
  error: string | null;
  latencyMs: number | null;
  checkedAt: string;
}

export default function ImpresorasConfigPage() {
  const [config, setConfig] = useState<ConfigPrinters | null>(null);
  const [edit, setEdit] = useState<ConfigPrinters | null>(null);
  const [jobs, setJobs] = useState<JobsListado | null>(null);
  const [statuses, setStatuses] = useState<Partial<Record<Destino, PrinterStatus>>>({});
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
  async function fetchStatuses() {
    try {
      const s = await api.get<Partial<Record<Destino, PrinterStatus>>>(
        '/admin/impresion/status',
      );
      setStatuses(s);
    } catch {
      /* silencioso */
    }
  }

  useEffect(() => {
    let cancelled = false;
    void fetchConfig();
    const refresh = () => {
      if (cancelled) return;
      void fetchJobs();
      void fetchStatuses();
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function setField(d: Destino, patch: Partial<ConfigImpresora>) {
    if (!edit) return;
    setEdit({ ...edit, [d]: { ...edit[d], ...patch } });
  }

  function toggleCanal(d: Destino, canal: string) {
    if (!edit) return;
    const actuales = edit[d].canales ?? [];
    const canales = actuales.includes(canal)
      ? actuales.filter((c) => c !== canal)
      : [...actuales, canal];
    setField(d, { canales });
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
    config && edit && (['MOSTRADOR', 'DELIVERY', 'COCINA'] as Destino[]).some(
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
          Configurá las 3 comanderas del local. Cada una se conecta por red Ethernet (TCP).
        </p>
      </header>

      <details className="card p-4 bg-cream-50 border border-cream-300 cursor-pointer">
        <summary className="font-medium text-sm text-ink-900">
          📋 ¿Qué pedido va a qué comandera?
        </summary>
        <div className="mt-3 text-xs text-ink-700 space-y-1.5">
          <p>
            Cada comandera imprime la comanda de los <strong>tipos de pedido que marques</strong>{' '}
            abajo en su recuadro (Mostrador, Teléfono, WhatsApp, Rappi, Pedidos Ya, Deliverate…).
            Un mismo pedido puede salir en varias comanderas a la vez.
          </p>
          <ul className="ml-4 space-y-1 list-none">
            <li>
              <strong>Comandera 3 (Cocina):</strong> además del canal, solo recibe pedidos{' '}
              <strong>con cocción</strong> (al menos un producto cuya subcategoría tiene marcado
              "Cocina interviene", ej. Porciones calientes).
            </li>
            <li>
              <strong>Comandera 1 (Mostrador):</strong> el ticket del cliente (con precios y total)
              se imprime siempre acá al cobrar en el mostrador — eso es aparte de esta matriz.
            </li>
          </ul>
          <p className="text-2xs text-ink-500 italic mt-2">
            Los tickets de ENCARGO se configuran aparte: cada comandera tiene abajo
            un check 📦. Si la comandera elegida al cargar un encargo no imprime
            encargos, se redirige a una habilitada (por defecto, Mostrador).
          </p>
        </div>
      </details>

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
        {(['MOSTRADOR', 'DELIVERY', 'COCINA'] as Destino[]).map((d) => {
          const meta = DESTINOS_INFO[d];
          const cfg = edit[d];
          const status = statuses[d];
          // Edge ribbon de estado: verde=online, rojo=offline, gris=desactivada
          const ribbonClass = !cfg.activa
            ? 'border-cream-300 opacity-70'
            : status?.online
              ? 'border-basil-600'
              : status
                ? 'border-pomodoro-600'
                : 'border-saffron-600';
          return (
            <section
              key={d}
              className={cn('card p-4 space-y-3 border-t-4', ribbonClass)}
            >
              <header>
                <div className="flex items-center justify-between gap-2">
                  {/* Nombre editable: la encargada las llama por dónde están
                      ("la de adelante"), no por el número. Vacío = default. */}
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <span>{meta.icon}</span>
                    <input
                      type="text"
                      value={cfg.nombre ?? ''}
                      onChange={(e) => setField(d, { nombre: e.target.value })}
                      placeholder={meta.titulo}
                      maxLength={40}
                      title="Nombre de la comandera (editable)"
                      className="font-display text-md text-ink-900 bg-transparent border-b border-dashed border-cream-300 focus:border-teresita-700 focus:outline-none flex-1 min-w-0 py-0.5"
                    />
                  </div>
                  <label className="flex items-center gap-1 cursor-pointer text-2xs shrink-0">
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

                {/* Indicador de estado runtime (heartbeat del agent) */}
                {cfg.activa && (
                  <div className="mt-2 flex items-center gap-2 text-2xs">
                    {status === undefined ? (
                      <span className="flex items-center gap-1 text-saffron-600">
                        <span className="inline-block w-2 h-2 rounded-full bg-saffron-600 animate-pulse" />
                        Esperando primer chequeo...
                      </span>
                    ) : status.online ? (
                      <span className="flex items-center gap-1 text-basil-600 font-medium">
                        <span className="inline-block w-2 h-2 rounded-full bg-basil-600" />
                        Online
                        {status.latencyMs !== null && (
                          <span className="text-ink-500 font-normal">
                            ({status.latencyMs}ms)
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-pomodoro-600 font-medium">
                        <span className="inline-block w-2 h-2 rounded-full bg-pomodoro-600" />
                        Offline
                        {status.error && (
                          <span className="text-ink-500 font-normal truncate max-w-[150px]" title={status.error}>
                            · {status.error}
                          </span>
                        )}
                      </span>
                    )}
                    {status && (
                      <span className="text-ink-400 ml-auto">
                        {(() => {
                          const ago = Math.round(
                            (Date.now() - new Date(status.checkedAt).getTime()) / 1000,
                          );
                          if (ago < 60) return `hace ${ago}s`;
                          return `hace ${Math.floor(ago / 60)}m`;
                        })()}
                      </span>
                    )}
                  </div>
                )}
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

              {/* Ruteo por tipo de pedido: qué canales imprimen su comanda acá.
                  La encargada elige DÓNDE y CUÁLES tickets salen. */}
              <div className="pt-2 border-t border-cream-200">
                <div className="text-2xs font-medium text-ink-700 mb-1.5">
                  Imprime la comanda de:
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {CANALES.map((canal) => {
                    const marcado = (cfg.canales ?? []).includes(canal.valor);
                    return (
                      <label
                        key={canal.valor}
                        className={cn(
                          'flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-2xs transition-colors',
                          !cfg.activa && 'opacity-50 cursor-not-allowed',
                          marcado
                            ? 'bg-teresita-50 text-teresita-700'
                            : 'text-ink-500 hover:bg-cream-100',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={marcado}
                          disabled={!cfg.activa}
                          onChange={() => toggleCanal(d, canal.valor)}
                          className="w-3.5 h-3.5 shrink-0"
                        />
                        <span aria-hidden>{canal.icono}</span>
                        <span className="truncate">{canal.label}</span>
                      </label>
                    );
                  })}
                </div>
                {d === 'COCINA' && (
                  <p className="text-2xs text-ink-400 mt-1.5 italic">
                    La cocina solo recibe pedidos con cocción, sin importar el canal.
                  </p>
                )}
              </div>

              {/* Tickets de ENCARGO — panel dedicado: la encargada decide qué
                  comanderas imprimen encargos (evita que salgan en cocina al
                  cobrar / re-imprimir, que era lo que confundía). */}
              <div className="pt-2 border-t border-cream-200">
                <label
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs transition-colors',
                    !cfg.activa && 'opacity-50 cursor-not-allowed',
                    cfg.encargos ? 'bg-wood-100 text-wood-900' : 'text-ink-500 hover:bg-cream-100',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={cfg.encargos ?? false}
                    disabled={!cfg.activa}
                    onChange={(e) => setField(d, { encargos: e.target.checked })}
                    className="w-4 h-4 shrink-0"
                  />
                  <span aria-hidden>📦</span>
                  <span className="font-medium">Imprime tickets de ENCARGO</span>
                </label>
                {d === 'COCINA' && (
                  <p className="text-2xs text-ink-400 mt-1 italic px-2">
                    Recomendado apagado: así el encargo no sale en cocina al cobrarlo.
                  </p>
                )}

                {/* Remitos de mayorista: se entregan junto con la mercadería,
                    igual que el ticket de una venta, así que por defecto salen
                    en Mostrador. Configurable por si el punto de entrega de los
                    mayoristas no es el mostrador. */}
                <label
                  className={cn(
                    'mt-2 flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs transition-colors',
                    !cfg.activa && 'opacity-50 cursor-not-allowed',
                    cfg.remitos ? 'bg-wood-100 text-wood-900' : 'text-ink-500 hover:bg-cream-100',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={cfg.remitos ?? false}
                    disabled={!cfg.activa}
                    onChange={(e) => setField(d, { remitos: e.target.checked })}
                    className="w-4 h-4 shrink-0"
                  />
                  <span aria-hidden>🧾</span>
                  <span className="font-medium">Imprime REMITOS de mayorista</span>
                </label>
                <p className="text-2xs text-ink-400 mt-1 italic px-2">
                  Si hay más de una marcada, el remito sale en la primera de la
                  lista (Mostrador → Delivery → Cocina).
                </p>
              </div>
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
          <>
            <table className="w-full text-xs hidden md:table">
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
                        {fecha.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
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

            {/* Tarjetas (mobile) */}
            <div className="md:hidden divide-y divide-cream-200">
              {jobs?.jobs.map((j) => {
                const fecha = new Date(j.encoladoAt);
                return (
                  <div key={j.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-ink-900 truncate">
                          {j.tipo.replace(/_/g, ' ').toLowerCase()}
                        </div>
                        <div className="text-2xs font-mono text-ink-500 truncate">
                          {j.destino} ·{' '}
                          {fecha.toLocaleTimeString('es-AR', {
                            timeZone: 'America/Argentina/Buenos_Aires',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}{' '}
                          · {j.intentos} int.
                        </div>
                        {j.ultimoError && (
                          <div
                            className="text-2xs text-pomodoro-600 truncate mt-0.5"
                            title={j.ultimoError}
                          >
                            {j.ultimoError}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
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
                        {j.estado === 'ERROR' && (
                          <button
                            onClick={() => void reintentar(j.id)}
                            className="block ml-auto mt-1 text-2xs text-teresita-700 hover:underline"
                          >
                            reintentar
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
