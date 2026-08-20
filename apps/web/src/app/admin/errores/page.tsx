'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * "Me tira error, dice STA-DB-7K4M2P" → acá se busca ese código y aparece qué
 * pasó realmente.
 *
 * Antes, cuando algo fallaba en el mostrador, lo único que se podía reportar
 * era "error interno del servidor", que no distingue una base caída de un
 * precio mal cargado de un bug nuestro. Ahora cada falla sale con un código
 * único, y este es el lugar donde ese código se convierte en un diagnóstico.
 *
 * ── Por qué se pierde al reiniciar ──────────────────────────────────────
 *
 * La lista vive en memoria del servidor. Es a propósito: si la base es justo
 * lo que está fallando, un registro que necesita escribir en la base no sirve
 * para nada — que es exactamente cuando más se lo necesita. Para lo que pasó
 * hace días está el log del servidor.
 */

type Categoria = 'VAL' | 'AUTH' | 'HORARIO' | 'DB' | 'CONN' | 'IMPR' | 'EXCEL' | 'REGLA' | 'SRV';

interface ErrorRegistrado {
  codigo: string;
  categoria: Categoria;
  status: number;
  mensaje: string;
  detalle: string;
  metodo: string;
  ruta: string;
  usuario: string | null;
  pcOrigen: string | null;
  at: string;
  stack: string | null;
}

/** Qué significa cada familia, en criollo. */
const QUE_ES: Record<Categoria, string> = {
  VAL: 'Un dato del pedido vino mal armado',
  AUTH: 'Sesión vencida o sin permiso',
  HORARIO: 'Fuera del horario del turno',
  DB: 'La base rechazó la operación',
  CONN: 'No se pudo hablar con la base',
  IMPR: 'Falló la impresión',
  EXCEL: 'Problema con el archivo de Excel',
  REGLA: 'Una regla del negocio lo impidió',
  SRV: 'Error inesperado del sistema',
};

/** Rojo lo que es un bug o la base; ámbar lo que es de uso; gris lo demás. */
const COLOR: Record<Categoria, string> = {
  SRV: 'bg-pomodoro-100 text-pomodoro-600',
  DB: 'bg-pomodoro-100 text-pomodoro-600',
  CONN: 'bg-pomodoro-100 text-pomodoro-600',
  IMPR: 'bg-saffron-100 text-saffron-700',
  EXCEL: 'bg-saffron-100 text-saffron-700',
  VAL: 'bg-cream-200 text-ink-600',
  AUTH: 'bg-cream-200 text-ink-600',
  HORARIO: 'bg-cream-200 text-ink-600',
  REGLA: 'bg-cream-200 text-ink-600',
};

export default function ErroresPage() {
  const [errores, setErrores] = useState<ErrorRegistrado[] | null>(null);
  const [codigo, setCodigo] = useState('');
  const [categoria, setCategoria] = useState<Categoria | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (codigo.trim()) p.set('codigo', codigo.trim());
      if (categoria) p.set('categoria', categoria);
      const r = await api.get<{ errores: ErrorRegistrado[] }>(`/admin/errores?${p}`);
      setErrores(r.errores);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los errores');
    }
  }, [codigo, categoria]);

  useEffect(() => {
    void buscar();
  }, [buscar]);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header>
        <h1 className="font-display text-xl text-ink-900">Errores</h1>
        <p className="text-sm text-ink-500">
          Cuando alguien del mostrador reporta un error, viene con un código como{' '}
          <span className="font-mono">STA-DB-7K4M2P</span>. Buscalo acá y vas a ver qué pasó.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-2xs text-ink-500 flex-1 min-w-[200px]">
          <span className="block mb-1">Código que te pasaron</span>
          <input
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            placeholder="STA-DB-7K4M2P — o parte del código"
            className="input text-sm w-full font-mono"
          />
        </label>
        <label className="text-2xs text-ink-500">
          <span className="block mb-1">Tipo</span>
          <select
            value={categoria}
            onChange={(e) => setCategoria(e.target.value as Categoria | '')}
            className="input text-sm py-1.5"
          >
            <option value="">todos</option>
            {(Object.keys(QUE_ES) as Categoria[]).map((c) => (
              <option key={c} value={c}>
                {c} — {QUE_ES[c]}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="secondary" onClick={() => void buscar()}>
          Buscar
        </Button>
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}

      {!errores ? (
        <p className="text-sm text-ink-500 px-1 py-6">Cargando…</p>
      ) : errores.length === 0 ? (
        <p className="text-sm text-ink-500 italic px-1 py-8 text-center">
          {codigo.trim()
            ? 'Ningún error con ese código. Puede ser de antes del último reinicio del sistema — en ese caso está en el log del servidor.'
            : 'No hubo errores desde que arrancó el sistema ✨'}
        </p>
      ) : (
        <ul className="space-y-2">
          {errores.map((e) => {
            const abiertoEste = abierto === e.codigo;
            return (
              <li key={e.codigo + e.at} className="card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-ink-900 font-semibold">{e.codigo}</span>
                  <span className={cn('text-2xs px-1.5 py-0.5 rounded', COLOR[e.categoria])}>
                    {QUE_ES[e.categoria]}
                  </span>
                  <span className="text-2xs text-ink-500 font-mono">
                    {e.metodo} {e.ruta} · {e.status}
                  </span>
                  <span className="text-2xs text-ink-500 ml-auto">
                    {new Date(e.at).toLocaleString('es-AR', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                    {e.usuario && ` · ${e.usuario}`}
                    {e.pcOrigen && ` · ${e.pcOrigen}`}
                  </span>
                </div>

                <p className="text-sm text-ink-700 mt-1.5">{e.mensaje}</p>

                {/* Lo técnico va plegado: es lo que sirve para arreglarlo, pero
                    abierto por defecto convierte la lista en una pared. */}
                <button
                  onClick={() => setAbierto(abiertoEste ? null : e.codigo)}
                  className="text-2xs text-steel-700 hover:underline mt-1"
                >
                  {abiertoEste ? 'Ocultar el detalle técnico' : 'Ver el detalle técnico'}
                </button>
                {abiertoEste && (
                  <div className="mt-2 space-y-2">
                    <pre className="text-2xs bg-cream-100 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                      {e.detalle}
                    </pre>
                    {e.stack && (
                      <pre className="text-2xs bg-cream-100 rounded p-2 overflow-x-auto max-h-64">
                        {e.stack}
                      </pre>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-2xs text-ink-500 px-1">
        La lista se borra cuando se reinicia el sistema. Lo de días anteriores queda en el log del
        servidor.
      </p>
    </div>
  );
}
