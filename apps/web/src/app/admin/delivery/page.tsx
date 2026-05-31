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
}

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
        <table className="w-full text-sm mt-2">
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
        <table className="w-full text-sm mt-2">
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
                    <td className="py-1.5 font-medium text-ink-900">{e.nombre}</td>
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
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    if (!nombre.trim()) return setError('Falta el nombre');
    const m = Number(monto);
    if (!isFinite(m) || m <= 0) return setError('Poné un precio válido');
    setGuardando(true);
    setError(null);
    try {
      const body = { nombre: nombre.trim(), monto: m.toFixed(2) };
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
