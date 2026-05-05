'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

interface Parametro {
  id: string;
  clave: string;
  valor: string;
  tipo: 'string' | 'number' | 'boolean' | 'json';
  descripcion: string | null;
  categoria: string | null;
  editable: boolean;
  actualizadoAt: string;
  actualizadoPor: string | null;
}

const CATEGORIA_LABELS: Record<string, { label: string; icon: string }> = {
  descuentos: { label: 'Descuentos', icon: '💚' },
  seguridad: { label: 'Seguridad', icon: '🔒' },
  ticket: { label: 'Tickets', icon: '🧾' },
  local: { label: 'Datos del local', icon: '🏪' },
};

export default function ConfigParametrosPage() {
  const [parametros, setParametros] = useState<Parametro[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get<{ parametros: Parametro[] }>('/admin/configuracion/parametros');
      // Ocultamos la categoría 'local' acá — tiene su propia tab
      setParametros(res.parametros.filter((p) => p.categoria !== 'local'));
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('Error al cargar parámetros');
      }
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Agrupar por categoría
  const grupos = parametros.reduce<Record<string, Parametro[]>>((acc, p) => {
    const cat = p.categoria ?? 'otros';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(p);
    return acc;
  }, {});

  async function guardar(p: Parametro) {
    const valorNuevo = edits[p.clave] ?? p.valor;
    if (valorNuevo === p.valor) return;
    setSaving(p.clave);
    setError(null);
    setOkMsg(null);
    try {
      await api.patch(`/admin/configuracion/parametros/${p.clave}`, { valor: valorNuevo });
      setOkMsg(`✓ "${p.descripcion ?? p.clave}" actualizado`);
      setEdits((e) => {
        const ne = { ...e };
        delete ne[p.clave];
        return ne;
      });
      void fetchData();
      setTimeout(() => setOkMsg(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-md text-ink-900">Parámetros del sistema</h2>
        <p className="text-sm text-ink-500">
          Cada cambio queda registrado con tu nombre y la fecha en el audit log.
        </p>
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}
      {okMsg && (
        <div className="bg-basil-100 text-basil-600 px-4 py-2 rounded text-sm">{okMsg}</div>
      )}

      {Object.entries(grupos).map(([cat, params]) => {
        const catInfo = CATEGORIA_LABELS[cat] ?? { label: cat, icon: '⚙️' };
        return (
          <section key={cat} className="card overflow-hidden">
            <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
              <h3 className="font-display text-md text-ink-900">
                <span className="mr-2">{catInfo.icon}</span>
                {catInfo.label}
              </h3>
            </header>
            <div className="divide-y divide-cream-200">
              {params.map((p) => {
                const valorEdit = edits[p.clave] ?? p.valor;
                const cambia = valorEdit !== p.valor;
                return (
                  <div key={p.id} className="px-4 py-3 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center">
                    <div>
                      <div className="text-sm text-ink-900">{p.descripcion}</div>
                      <div className="text-2xs font-mono text-ink-500">{p.clave}</div>
                      {p.actualizadoPor && (
                        <div className="text-2xs text-ink-300 mt-0.5">
                          modificado por {p.actualizadoPor} el{' '}
                          {new Date(p.actualizadoAt).toLocaleDateString('es-AR')}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {p.tipo === 'boolean' ? (
                        <select
                          value={valorEdit}
                          onChange={(e) =>
                            setEdits((s) => ({ ...s, [p.clave]: e.target.value }))
                          }
                          className="input w-32 text-sm py-1.5"
                          disabled={!p.editable}
                        >
                          <option value="true">Activado</option>
                          <option value="false">Desactivado</option>
                        </select>
                      ) : p.tipo === 'number' ? (
                        <input
                          type="number"
                          step="0.01"
                          value={valorEdit}
                          onChange={(e) =>
                            setEdits((s) => ({ ...s, [p.clave]: e.target.value }))
                          }
                          className="input w-32 text-sm py-1.5 font-mono text-right"
                          disabled={!p.editable}
                        />
                      ) : (
                        <input
                          type="text"
                          value={valorEdit}
                          onChange={(e) =>
                            setEdits((s) => ({ ...s, [p.clave]: e.target.value }))
                          }
                          className="input w-64 text-sm py-1.5"
                          disabled={!p.editable}
                        />
                      )}
                      <Button
                        size="sm"
                        disabled={!cambia || saving === p.clave || !p.editable}
                        onClick={() => guardar(p)}
                        className={cn(!cambia && 'opacity-30')}
                      >
                        {saving === p.clave ? '...' : 'Guardar'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
