'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';

interface Parametro {
  id: string;
  clave: string;
  valor: string;
  tipo: 'string' | 'number' | 'boolean' | 'json';
  descripcion: string | null;
  categoria: string | null;
  editable: boolean;
}

const CAMPOS_LOCAL: Array<{ clave: string; label: string; placeholder?: string }> = [
  { clave: 'nombre_local', label: 'Nombre del local', placeholder: 'Santa Teresita Pastas' },
  {
    clave: 'direccion_local',
    label: 'Dirección',
    placeholder: 'Av. 44 e. 12 y Plaza Paso, La Plata',
  },
  { clave: 'telefono_local', label: 'Teléfono', placeholder: '(221) 123-4567' },
  { clave: 'instagram_local', label: 'Instagram', placeholder: '@santateresitapastas' },
  {
    clave: 'mensaje_footer_ticket',
    label: 'Mensaje en el ticket',
    placeholder: '¡Gracias por su compra!',
  },
];

export default function ConfigLocalPage() {
  const [parametros, setParametros] = useState<Record<string, Parametro>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [mostrarRedes, setMostrarRedes] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get<{ parametros: Parametro[] }>('/admin/configuracion/parametros');
      const map: Record<string, Parametro> = {};
      for (const p of res.parametros) {
        if (p.categoria === 'local' || p.categoria === 'ticket') map[p.clave] = p;
      }
      setParametros(map);
      const m = map['mostrar_redes_en_ticket'];
      if (m) setMostrarRedes(m.valor === 'true');
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('Error al cargar configuración');
      }
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  async function guardar() {
    setSaving(true);
    setError(null);
    setOkMsg(null);
    try {
      const tareas: Array<Promise<unknown>> = [];
      for (const [clave, valor] of Object.entries(edits)) {
        if (parametros[clave] && parametros[clave].valor !== valor) {
          tareas.push(api.patch(`/admin/configuracion/parametros/${clave}`, { valor }));
        }
      }
      const m = parametros['mostrar_redes_en_ticket'];
      if (m && m.valor !== String(mostrarRedes)) {
        tareas.push(
          api.patch('/admin/configuracion/parametros/mostrar_redes_en_ticket', {
            valor: String(mostrarRedes),
          }),
        );
      }
      if (tareas.length === 0) {
        setOkMsg('Nada para guardar.');
        setTimeout(() => setOkMsg(null), 2000);
        return;
      }
      await Promise.all(tareas);
      setEdits({});
      setOkMsg('✓ Cambios guardados');
      void fetchData();
      setTimeout(() => setOkMsg(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  const valor = (clave: string) => edits[clave] ?? parametros[clave]?.valor ?? '';

  return (
    <div className="max-w-2xl space-y-4">
      <header>
        <h2 className="font-display text-md text-ink-900">Datos del local</h2>
        <p className="text-sm text-ink-500">
          Estos datos aparecen en el ticket cliente impreso y en algunas vistas de la app.
        </p>
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}
      {okMsg && (
        <div className="bg-basil-100 text-basil-600 px-4 py-2 rounded text-sm">{okMsg}</div>
      )}

      <div className="card p-5 space-y-4">
        {CAMPOS_LOCAL.map((c) => (
          <div key={c.clave}>
            <label className="block text-xs font-medium text-ink-700 mb-1">{c.label}</label>
            <input
              type="text"
              value={valor(c.clave)}
              onChange={(e) =>
                setEdits((s) => ({ ...s, [c.clave]: e.target.value }))
              }
              placeholder={c.placeholder}
              className="input"
            />
          </div>
        ))}

        <hr className="border-cream-200" />

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={mostrarRedes}
            onChange={(e) => setMostrarRedes(e.target.checked)}
            className="w-4 h-4"
          />
          <div>
            <span className="text-sm text-ink-700">Mostrar redes sociales en el ticket</span>
            <p className="text-2xs text-ink-500">
              El Instagram, teléfono y dirección aparecen al pie del ticket cliente.
            </p>
          </div>
        </label>
      </div>

      <div className="flex justify-end">
        <Button onClick={guardar} disabled={saving}>
          {saving ? 'Guardando...' : 'Guardar cambios'}
        </Button>
      </div>

      {/* Preview del ticket */}
      <section className="card p-4 bg-cream-100">
        <h3 className="text-2xs uppercase tracking-wider text-ink-500 mb-2">
          Vista previa del footer del ticket
        </h3>
        <pre className="font-mono text-xs text-ink-700 whitespace-pre-wrap">
          {valor('mensaje_footer_ticket')}
          {mostrarRedes && (
            <>
              {'\n\n'}
              {valor('instagram_local') && `📷 ${valor('instagram_local')}\n`}
              {valor('telefono_local') && `📞 ${valor('telefono_local')}\n`}
              {valor('direccion_local') && `📍 ${valor('direccion_local')}`}
            </>
          )}
        </pre>
      </section>
    </div>
  );
}
