'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

interface EmpresaDelivery {
  id: string;
  nombre: string;
  comisionPct: string;
  esInterno: boolean;
  activo: boolean;
}

interface Envio {
  id: string;
  codigo: string | null;
  nombre: string;
  monto: string;
  activo: boolean;
  canales: string[];
}

// Canales (de delivery) donde puede ofrecerse un envío al cobrar. Mostrador /
// take-away nunca muestran envíos, por eso no están en la lista.
const CANALES_ENVIO_OPCIONES: Array<{ value: string; label: string }> = [
  { value: 'TELEFONO', label: 'Teléfono' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'WEB', label: 'Web' },
  { value: 'RAPPI', label: 'RAPPI' },
  { value: 'PEDIDOS_YA', label: 'PedidosYa' },
  { value: 'MERCADO_LIBRE', label: 'Mercado Libre' },
  { value: 'DELIVERATE', label: 'DELIVERATE' },
];
const CANALES_ENVIO_DEFAULT = ['TELEFONO', 'WHATSAPP', 'WEB'];
const labelCanal = (c: string) =>
  CANALES_ENVIO_OPCIONES.find((x) => x.value === c)?.label ?? c;

export default function AdminDeliveryPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="font-display text-xl text-ink-900">Delivery</h1>
        <p className="text-sm text-ink-500">
          Empresas de reparto con su comisión, y los tipos de envío que se cobran al cliente.
        </p>
      </header>

      <EmpresasSection />
      <EnviosSection />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//   Empresas de delivery
// ════════════════════════════════════════════════════════════════════════

function EmpresasSection() {
  const [empresas, setEmpresas] = useState<EmpresaDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [agregando, setAgregando] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const r = await api.get<{ empresas: EmpresaDelivery[] }>(
        '/admin/configuracion/delivery-empresas',
      );
      setEmpresas(r.empresas);
    } catch {
      setError('No se pudieron cargar las empresas de delivery');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  async function eliminar(id: string, nombre: string) {
    if (!confirm(`¿Quitar "${nombre}" de la lista de delivery?`)) return;
    try {
      await api.delete(`/admin/configuracion/delivery-empresas/${id}`);
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al eliminar');
    }
  }

  return (
    <section className="card p-4">
      <header className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-display text-md text-ink-900">🛵 Empresas de delivery</h2>
          <p className="text-2xs text-ink-500">
            Quién reparte y qué comisión cobra. La comisión queda guardada (informativa).
          </p>
        </div>
        {!agregando && (
          <Button size="sm" onClick={() => setAgregando(true)}>
            + Agregar
          </Button>
        )}
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm mb-2">
          {error}
        </div>
      )}

      {agregando && (
        <EmpresaForm
          onCancel={() => setAgregando(false)}
          onSaved={() => {
            setAgregando(false);
            void fetchData();
          }}
        />
      )}

      {loading ? (
        <p className="text-ink-500 text-sm">Cargando…</p>
      ) : (
        <>
          <table className="w-full text-sm mt-2 hidden md:table">
            <thead className="text-2xs uppercase text-ink-500 border-b border-cream-300">
              <tr>
                <th className="text-left py-1">Empresa</th>
                <th className="text-right py-1">Comisión</th>
                <th className="text-center py-1">Tipo</th>
                <th className="text-right py-1">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {empresas
                .filter((e) => e.activo)
                .map((e) =>
                  editId === e.id ? (
                    <tr key={e.id} className="border-b border-cream-200">
                      <td colSpan={4} className="py-2">
                        <EmpresaForm
                          empresa={e}
                          onCancel={() => setEditId(null)}
                          onSaved={() => {
                            setEditId(null);
                            void fetchData();
                          }}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={e.id} className="border-b border-cream-200">
                      <td className="py-1.5 font-medium text-ink-900">{e.nombre}</td>
                      <td className="py-1.5 text-right font-mono">
                        {Number(e.comisionPct).toFixed(2)}%
                      </td>
                      <td className="py-1.5 text-center">
                        {e.esInterno ? (
                          <span className="text-2xs bg-basil-100 text-basil-600 px-2 py-0.5 rounded">
                            propio
                          </span>
                        ) : (
                          <span className="text-2xs bg-cream-200 text-ink-700 px-2 py-0.5 rounded">
                            externo
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          onClick={() => setEditId(e.id)}
                          className="text-2xs text-teresita-700 hover:underline mr-3"
                        >
                          editar
                        </button>
                        <button
                          onClick={() => eliminar(e.id, e.nombre)}
                          className="text-2xs text-pomodoro-600 hover:underline"
                        >
                          quitar
                        </button>
                      </td>
                    </tr>
                  ),
                )}
            </tbody>
          </table>

          {/* Tarjetas (mobile) */}
          <div className="md:hidden divide-y divide-cream-200 mt-2">
            {empresas
              .filter((e) => e.activo)
              .map((e) =>
                editId === e.id ? (
                  <div key={e.id} className="py-2">
                    <EmpresaForm
                      empresa={e}
                      onCancel={() => setEditId(null)}
                      onSaved={() => {
                        setEditId(null);
                        void fetchData();
                      }}
                    />
                  </div>
                ) : (
                  <div key={e.id} className="py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-ink-900 truncate">{e.nombre}</div>
                        <div className="flex items-center gap-1.5 mt-1">
                          {e.esInterno ? (
                            <span className="text-2xs bg-basil-100 text-basil-600 px-2 py-0.5 rounded">
                              propio
                            </span>
                          ) : (
                            <span className="text-2xs bg-cream-200 text-ink-700 px-2 py-0.5 rounded">
                              externo
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right font-mono text-ink-900">
                        {Number(e.comisionPct).toFixed(2)}%
                      </div>
                    </div>
                    <div className="flex gap-3 mt-2">
                      <button
                        onClick={() => setEditId(e.id)}
                        className="text-2xs text-teresita-700 hover:underline"
                      >
                        editar
                      </button>
                      <button
                        onClick={() => eliminar(e.id, e.nombre)}
                        className="text-2xs text-pomodoro-600 hover:underline"
                      >
                        quitar
                      </button>
                    </div>
                  </div>
                ),
              )}
          </div>
        </>
      )}
    </section>
  );
}

function EmpresaForm({
  empresa,
  onCancel,
  onSaved,
}: {
  empresa?: EmpresaDelivery;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [nombre, setNombre] = useState(empresa?.nombre ?? '');
  const [comision, setComision] = useState(
    empresa ? Number(empresa.comisionPct).toString() : '0',
  );
  const [esInterno, setEsInterno] = useState(empresa?.esInterno ?? false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    if (!nombre.trim()) {
      setError('Falta el nombre');
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      const body = {
        nombre: nombre.trim(),
        comisionPct: (Number(comision) || 0).toString(),
        esInterno,
      };
      if (empresa) {
        await api.patch(`/admin/configuracion/delivery-empresas/${empresa.id}`, body);
      } else {
        await api.post('/admin/configuracion/delivery-empresas', body);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="rounded-md border border-teresita-700/40 bg-teresita-50/40 p-3 space-y-2 mb-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-2xs uppercase text-ink-500">Nombre</span>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Ej: RAPPI, Damián, …"
            className="input w-full text-sm"
            maxLength={80}
            autoFocus
          />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase text-ink-500">Comisión %</span>
          <input
            type="number"
            value={comision}
            onChange={(e) => setComision(e.target.value)}
            placeholder="0"
            step="0.01"
            min="0"
            className="input w-full text-sm"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={esInterno}
          onChange={(e) => setEsInterno(e.target.checked)}
        />
        <span>Es repartidor propio del local (ej. Damián — sin comisión)</span>
      </label>
      {error && <p className="text-2xs text-pomodoro-600">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={guardar} disabled={guardando}>
          {guardando ? 'Guardando…' : empresa ? 'Guardar cambios' : 'Agregar empresa'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//   Tipos de envío
// ════════════════════════════════════════════════════════════════════════

function EnviosSection() {
  const [envios, setEnvios] = useState<Envio[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [agregando, setAgregando] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const r = await api.get<{ envios: Envio[] }>('/admin/configuracion/envios');
      setEnvios(r.envios);
    } catch {
      setError('No se pudieron cargar los tipos de envío');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  async function eliminar(id: string, nombre: string) {
    if (!confirm(`¿Quitar "${nombre}" de los tipos de envío?`)) return;
    try {
      await api.delete(`/admin/configuracion/envios/${id}`);
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al eliminar');
    }
  }

  return (
    <section className="card p-4">
      <header className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-display text-md text-ink-900">📦 Tipos de envío</h2>
          <p className="text-2xs text-ink-500">
            Lo que se cobra al cliente. Aparecen como botones en la pantalla de cobrar.
          </p>
        </div>
        {!agregando && (
          <Button size="sm" onClick={() => setAgregando(true)}>
            + Agregar
          </Button>
        )}
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm mb-2">
          {error}
        </div>
      )}

      {agregando && (
        <EnvioForm
          onCancel={() => setAgregando(false)}
          onSaved={() => {
            setAgregando(false);
            void fetchData();
          }}
        />
      )}

      {loading ? (
        <p className="text-ink-500 text-sm">Cargando…</p>
      ) : (
        <>
          <table className="w-full text-sm mt-2 hidden md:table">
            <thead className="text-2xs uppercase text-ink-500 border-b border-cream-300">
              <tr>
                <th className="text-left py-1">Tipo de envío</th>
                <th className="text-right py-1">Precio</th>
                <th className="text-right py-1">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {envios
                .filter((e) => e.activo)
                .map((e) =>
                  editId === e.id ? (
                    <tr key={e.id} className="border-b border-cream-200">
                      <td colSpan={3} className="py-2">
                        <EnvioForm
                          envio={e}
                          onCancel={() => setEditId(null)}
                          onSaved={() => {
                            setEditId(null);
                            void fetchData();
                          }}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={e.id} className="border-b border-cream-200">
                      <td className="py-1.5 font-medium text-ink-900">
                        {e.nombre}
                        <div className="text-2xs font-normal text-ink-500">
                          {e.canales.length > 0
                            ? `Aparece en: ${e.canales.map(labelCanal).join(', ')}`
                            : 'No aparece en ningún canal'}
                        </div>
                      </td>
                      <td className="py-1.5 text-right font-mono">
                        ${Number(e.monto).toLocaleString('es-AR')}
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          onClick={() => setEditId(e.id)}
                          className="text-2xs text-teresita-700 hover:underline mr-3"
                        >
                          editar
                        </button>
                        <button
                          onClick={() => eliminar(e.id, e.nombre)}
                          className="text-2xs text-pomodoro-600 hover:underline"
                        >
                          quitar
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              {envios.filter((e) => e.activo).length === 0 && (
                <tr>
                  <td colSpan={3} className="py-3 text-center text-ink-500 text-sm italic">
                    No hay tipos de envío. Agregá al menos uno.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Tarjetas (mobile) */}
          <div className="md:hidden divide-y divide-cream-200 mt-2">
            {envios
              .filter((e) => e.activo)
              .map((e) =>
                editId === e.id ? (
                  <div key={e.id} className="py-2">
                    <EnvioForm
                      envio={e}
                      onCancel={() => setEditId(null)}
                      onSaved={() => {
                        setEditId(null);
                        void fetchData();
                      }}
                    />
                  </div>
                ) : (
                  <div key={e.id} className="py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-ink-900 truncate">{e.nombre}</div>
                        <div className="text-2xs font-normal text-ink-500">
                          {e.canales.length > 0
                            ? `Aparece en: ${e.canales.map(labelCanal).join(', ')}`
                            : 'No aparece en ningún canal'}
                        </div>
                      </div>
                      <div className="shrink-0 text-right font-mono text-ink-900">
                        ${Number(e.monto).toLocaleString('es-AR')}
                      </div>
                    </div>
                    <div className="flex gap-3 mt-2">
                      <button
                        onClick={() => setEditId(e.id)}
                        className="text-2xs text-teresita-700 hover:underline"
                      >
                        editar
                      </button>
                      <button
                        onClick={() => eliminar(e.id, e.nombre)}
                        className="text-2xs text-pomodoro-600 hover:underline"
                      >
                        quitar
                      </button>
                    </div>
                  </div>
                ),
              )}
            {envios.filter((e) => e.activo).length === 0 && (
              <div className="py-3 text-center text-ink-500 text-sm italic">
                No hay tipos de envío. Agregá al menos uno.
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function EnvioForm({
  envio,
  onCancel,
  onSaved,
}: {
  envio?: Envio;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [nombre, setNombre] = useState(envio?.nombre ?? '');
  const [monto, setMonto] = useState(envio ? Number(envio.monto).toString() : '');
  const [canales, setCanales] = useState<string[]>(envio?.canales ?? CANALES_ENVIO_DEFAULT);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCanal = (c: string) =>
    setCanales((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  async function guardar() {
    if (!nombre.trim()) return setError('Falta el nombre');
    const m = Number(monto);
    if (!isFinite(m) || m <= 0) return setError('Poné un precio válido');
    if (canales.length === 0)
      return setError('Elegí al menos un canal donde aparece este envío');
    setGuardando(true);
    setError(null);
    try {
      const body = { nombre: nombre.trim(), monto: m.toFixed(2), canales };
      if (envio) {
        await api.patch(`/admin/configuracion/envios/${envio.id}`, body);
      } else {
        await api.post('/admin/configuracion/envios', body);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="rounded-md border border-saffron-600/40 bg-saffron-100/40 p-3 space-y-2 mb-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-2xs uppercase text-ink-500">Nombre</span>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Ej: Envío simple, Zona sur…"
            className="input w-full text-sm"
            maxLength={80}
            autoFocus
          />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase text-ink-500">Precio ($)</span>
          <input
            type="number"
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            placeholder="3800"
            step="0.01"
            min="0"
            className="input w-full text-sm"
          />
        </label>
      </div>
      <div className="space-y-1">
        <span className="text-2xs uppercase text-ink-500">
          Aparece al cobrar en estos pedidos
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1">
          {CANALES_ENVIO_OPCIONES.map((c) => (
            <label key={c.value} className="flex items-center gap-1.5 text-xs text-ink-700">
              <input
                type="checkbox"
                checked={canales.includes(c.value)}
                onChange={() => toggleCanal(c.value)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
        <p className="text-2xs text-ink-500 italic">
          En mostrador y take-away nunca aparece — el envío es solo para entregas a domicilio.
        </p>
      </div>
      {error && <p className="text-2xs text-pomodoro-600">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={guardar} disabled={guardando}>
          {guardando ? 'Guardando…' : envio ? 'Guardar cambios' : 'Agregar envío'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
