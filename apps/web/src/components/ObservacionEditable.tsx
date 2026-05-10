'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * UI compartida para mostrar/editar la observación de un item del pedido.
 *
 * Estados:
 *   - Sin observación: muestra un botón pequeño con ✏️ que abre el editor.
 *   - Con observación: muestra el bloque amarillo + botón ✏️ para editar.
 *   - Editando: input/textarea inline con auto-focus, Enter guarda, Esc cancela.
 *
 * `onSave` se llama con el texto nuevo (o '' para borrar). Si onSave devuelve
 * una promise, mostramos un estado "guardando…" hasta que resuelva.
 *
 * Diseño visual (fuente: cargar-pedido cart):
 *   - Bloque amarillo con borde izquierdo (saffron-100/600) cuando hay obs
 *   - Texto inline italic cuando es secundario (item dentro de paquete)
 */
export function ObservacionEditable({
  observacion,
  onSave,
  variant = 'block',
  disabled = false,
}: {
  observacion: string | null | undefined;
  onSave: (nueva: string) => void | Promise<void>;
  variant?: 'block' | 'inline';
  disabled?: boolean;
}) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(observacion ?? '');
  const [guardando, setGuardando] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setValor(observacion ?? '');
  }, [observacion]);

  useEffect(() => {
    if (editando && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editando]);

  async function commit() {
    const trimmed = valor.trim();
    if (trimmed === (observacion ?? '').trim()) {
      setEditando(false);
      return;
    }
    setGuardando(true);
    try {
      await onSave(trimmed);
      setEditando(false);
    } finally {
      setGuardando(false);
    }
  }

  function cancel() {
    setValor(observacion ?? '');
    setEditando(false);
  }

  if (editando) {
    return (
      <div className="mt-1 px-2.5 py-1.5 bg-saffron-100 border-l-4 border-saffron-600 rounded-r">
        <div className="flex items-center justify-between mb-1">
          <span className="text-2xs font-bold uppercase tracking-widest text-saffron-600">
            Observación
          </span>
          <span className="text-2xs text-ink-500">Enter ↵ guarda · Esc cancela</span>
        </div>
        <textarea
          ref={inputRef}
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          disabled={guardando}
          placeholder="ej. sin sal, bien tostado, separar la salsa…"
          rows={2}
          maxLength={500}
          className="w-full text-sm border border-saffron-300 rounded px-2 py-1 bg-white disabled:opacity-50"
        />
        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={cancel}
            disabled={guardando}
            className="text-xs text-ink-500 hover:text-ink-700 px-2 py-0.5"
          >
            Cancelar
          </button>
          <button
            onClick={() => void commit()}
            disabled={guardando}
            className="text-xs bg-saffron-600 text-white hover:bg-saffron-700 px-2 py-0.5 rounded disabled:opacity-50"
          >
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    );
  }

  if (!observacion) {
    return (
      <button
        type="button"
        onClick={() => !disabled && setEditando(true)}
        disabled={disabled}
        className="mt-0.5 text-2xs text-ink-300 hover:text-saffron-600 inline-flex items-center gap-1 disabled:opacity-30"
        title="Agregar observación"
      >
        <span>✏️</span>
        <span className="underline">agregar observación</span>
      </button>
    );
  }

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={() => !disabled && setEditando(true)}
        disabled={disabled}
        className="text-xs italic text-saffron-600 mt-0.5 hover:text-saffron-700 hover:underline text-left disabled:opacity-50"
        title="Click para editar"
      >
        {observacion} <span className="ml-1 not-italic">✏️</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => !disabled && setEditando(true)}
      disabled={disabled}
      className="mt-1 px-2.5 py-1.5 bg-saffron-100 border-l-4 border-saffron-600 rounded-r text-left w-full hover:bg-saffron-200/60 disabled:opacity-50"
      title="Click para editar la observación"
    >
      <div className="flex items-center justify-between">
        <span className="text-2xs font-bold uppercase tracking-widest text-saffron-600">
          ⚠ Observación
        </span>
        <span className="text-2xs text-ink-500">✏️</span>
      </div>
      <div className="text-sm font-bold text-ink-900 leading-tight">{observacion}</div>
    </button>
  );
}
