'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

interface Opcion {
  id: string;
  dominio: string;
  etiqueta: string;
  valor: string | null;
  atributos: Record<string, unknown> | null;
  orden: number;
  activo: boolean;
  esSistema: boolean;
}

// Dominios "de sistema" que la encargada puede editar. Reglas duras (métodos de
// pago, canales, tipos de cuenta) NO están acá — viven cableadas en el código.
const DOMINIOS_FIJOS: Array<{
  dominio: string;
  titulo: string;
  descripcion: string;
  conCategoria?: boolean;
}> = [
  {
    dominio: 'concepto_pago_empleado',
    titulo: '👥 Conceptos de pago a empleado',
    descripcion: 'Sueldo, jornada, horas extra, feriado, vacaciones… Cada uno va a una categoría contable.',
    conCategoria: true,
  },
  {
    dominio: 'motivo_anulacion',
    titulo: '🚫 Motivos de anulación de venta',
    descripcion: 'Aparecen como opciones al anular una venta.',
  },
  {
    dominio: 'etiqueta_cliente',
    titulo: '🏷️ Etiquetas de cliente',
    descripcion: 'Etiquetas libres para clasificar clientes (frecuente, mayorista, etc.).',
  },
];

const DOMINIO_LISTAS_PROPIAS = '_listas_propias_';

export default function ListasYOpcionesPage() {
  const [propias, setPropias] = useState<Opcion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nuevaPropia, setNuevaPropia] = useState('');

  const fetchPropias = useCallback(async () => {
    try {
      const r = await api.get<{ opciones: Opcion[] }>(
        `/admin/opciones/${DOMINIO_LISTAS_PROPIAS}`,
      );
      setPropias(r.opciones);
    } catch {
      /* silencioso */
    }
  }, []);

  useEffect(() => {
    void fetchPropias();
  }, [fetchPropias]);

  function slugify(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40);
  }

  async function crearListaPropia() {
    const nombre = nuevaPropia.trim();
    if (!nombre) return;
    const slug = slugify(nombre);
    if (!slug) {
      setError('Nombre inválido');
      return;
    }
    try {
      await api.post(`/admin/opciones/${DOMINIO_LISTAS_PROPIAS}`, { etiqueta: nombre, valor: slug });
      setNuevaPropia('');
      void fetchPropias();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear la lista');
    }
  }

  async function borrarListaPropia(o: Opcion) {
    if (!confirm(`¿Eliminar la lista propia "${o.etiqueta}" y todas sus opciones?`)) return;
    try {
      // Borrar los ítems de la lista + la entrada del registro.
      const items = await api.get<{ opciones: Opcion[] }>(`/admin/opciones/propia:${o.valor}`);
      await Promise.all(items.opciones.map((it) => api.delete(`/admin/opciones/${it.id}`)));
      await api.delete(`/admin/opciones/${o.id}`);
      void fetchPropias();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo eliminar la lista');
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <header>
        <h1 className="font-display text-xl text-ink-900">Listas y opciones</h1>
        <p className="text-sm text-ink-500">
          Personalizá las listas del sistema sin depender de nosotros. Lo que cambies acá
          aparece en los desplegables de toda la app.
        </p>
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}

      {DOMINIOS_FIJOS.map((d) => (
        <ListaEditor
          key={d.dominio}
          dominio={d.dominio}
          titulo={d.titulo}
          descripcion={d.descripcion}
          conCategoria={d.conCategoria}
        />
      ))}

      {/* Listas propias */}
      <section className="card p-4 border-l-4 border-ocean-600">
        <header className="mb-2">
          <h2 className="font-display text-md text-ink-900">🧩 Listas propias</h2>
          <p className="text-2xs text-ink-500">
            Creá tus propias listas de referencia (etiquetas). No afectan cálculos del sistema.
          </p>
        </header>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={nuevaPropia}
            onChange={(e) => setNuevaPropia(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && crearListaPropia()}
            placeholder="Nombre de la lista nueva (ej. Motivos de descuento)"
            className="input text-sm flex-1"
            maxLength={120}
          />
          <Button size="sm" onClick={crearListaPropia}>
            + Crear lista
          </Button>
        </div>
        {propias.length === 0 ? (
          <p className="text-xs text-ink-500 italic">Todavía no creaste ninguna lista propia.</p>
        ) : (
          <div className="space-y-4">
            {propias.map((o) => (
              <div key={o.id} className="border border-cream-200 rounded p-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-ink-900">{o.etiqueta}</span>
                  <button
                    onClick={() => borrarListaPropia(o)}
                    className="text-2xs text-pomodoro-600 hover:underline"
                  >
                    eliminar lista
                  </button>
                </div>
                <ListaEditor
                  dominio={`propia:${o.valor}`}
                  titulo=""
                  descripcion=""
                  compacto
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Editor reutilizable de una lista (cualquier dominio)
// ────────────────────────────────────────────────────────────────────────

function ListaEditor({
  dominio,
  titulo,
  descripcion,
  conCategoria,
  compacto,
}: {
  dominio: string;
  titulo: string;
  descripcion: string;
  conCategoria?: boolean;
  compacto?: boolean;
}) {
  const [opciones, setOpciones] = useState<Opcion[]>([]);
  const [categorias, setCategorias] = useState<Array<{ id: string; nombre: string }>>([]);
  const [nueva, setNueva] = useState('');
  const [nuevaCat, setNuevaCat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const r = await api.get<{ opciones: Opcion[] }>(`/admin/opciones/${dominio}`);
      setOpciones(r.opciones);
    } catch {
      setError('No se pudo cargar');
    } finally {
      setLoading(false);
    }
  }, [dominio]);

  useEffect(() => {
    void fetchData();
    if (conCategoria) {
      api
        .get<{ categorias: Array<{ id: string; nombre: string }> }>('/admin/categorias-movimiento')
        .then((r) => setCategorias(r.categorias))
        .catch(() => {});
    }
  }, [fetchData, conCategoria]);

  async function agregar() {
    const etiqueta = nueva.trim();
    if (!etiqueta) return;
    try {
      const body: Record<string, unknown> = { etiqueta };
      if (conCategoria && nuevaCat) body.atributos = { categoria: nuevaCat };
      await api.post(`/admin/opciones/${dominio}`, body);
      setNueva('');
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo agregar');
    }
  }

  async function eliminar(o: Opcion) {
    if (!confirm(`¿Eliminar "${o.etiqueta}"?`)) return;
    try {
      await api.delete(`/admin/opciones/${o.id}`);
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo eliminar');
    }
  }

  async function toggleActivo(o: Opcion) {
    try {
      await api.patch(`/admin/opciones/${o.id}`, { activo: !o.activo });
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  const cuerpo = (
    <>
      {error && <p className="text-2xs text-pomodoro-600 mb-1">{error}</p>}
      {loading ? (
        <p className="text-xs text-ink-500">Cargando…</p>
      ) : (
        <ul className="space-y-1 mb-2">
          {opciones.length === 0 && (
            <li className="text-xs text-ink-500 italic">Sin opciones todavía.</li>
          )}
          {opciones.map((o) => (
            <li
              key={o.id}
              className={cn(
                'flex items-center justify-between text-sm px-2 py-1 rounded bg-surface-sunken',
                !o.activo && 'opacity-50',
              )}
            >
              <span>
                {o.etiqueta}
                {conCategoria && o.atributos && typeof o.atributos.categoria === 'string' && (
                  <span className="text-2xs text-ink-500"> → {o.atributos.categoria as string}</span>
                )}
                {!o.activo && <span className="text-2xs text-ink-400"> (inactivo)</span>}
              </span>
              <span className="whitespace-nowrap">
                <button
                  onClick={() => toggleActivo(o)}
                  className="text-2xs text-ink-500 hover:underline mr-3"
                >
                  {o.activo ? 'desactivar' : 'activar'}
                </button>
                <button
                  onClick={() => eliminar(o)}
                  className="text-2xs text-pomodoro-600 hover:underline"
                >
                  eliminar
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={nueva}
          onChange={(e) => setNueva(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && agregar()}
          placeholder="Nueva opción…"
          className="input text-sm flex-1"
          maxLength={120}
        />
        {conCategoria && (
          <select
            value={nuevaCat}
            onChange={(e) => setNuevaCat(e.target.value)}
            className="input text-sm w-auto"
          >
            <option value="">Categoría…</option>
            {categorias.map((c) => (
              <option key={c.id} value={c.nombre}>
                {c.nombre}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" onClick={agregar}>
          + Agregar
        </Button>
      </div>
    </>
  );

  if (compacto) return <div>{cuerpo}</div>;

  return (
    <section className="card p-4">
      <header className="mb-2">
        <h2 className="font-display text-md text-ink-900">{titulo}</h2>
        <p className="text-2xs text-ink-500">{descripcion}</p>
      </header>
      {cuerpo}
    </section>
  );
}
