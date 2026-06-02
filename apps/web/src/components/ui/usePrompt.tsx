'use client';

import { useCallback, useState } from 'react';
import { Button } from './Button';

interface PromptOptions {
  /** Título opcional del modal. */
  title?: string;
  /** Texto explicativo. Soporta saltos de línea (\n). */
  message: string;
  /** Valor inicial del input. */
  defaultValue?: string;
  /** Placeholder del input. */
  placeholder?: string;
  /** Label del botón de confirmar (default "Aceptar"). */
  confirmLabel?: string;
}

interface PromptState extends PromptOptions {
  resolve: (value: string | null) => void;
}

/**
 * Reemplazo in-app de `window.prompt()`.
 *
 * Electron NO soporta `window.prompt()`: devuelve `null` en silencio, así que
 * cualquier acción que dependa de él "no hace nada" dentro del .exe (aunque
 * funcione perfecto en el navegador en dev). Este hook ofrece un reemplazo
 * promise-based con el mismo contrato que `prompt()`:
 *
 *   const valor = await prompt({ message: '…', defaultValue: '…' });
 *   if (valor === null) return; // el usuario canceló
 *
 * Uso:
 *   const { prompt, promptModal } = usePrompt();
 *   // …
 *   return (
 *     <div>
 *       {promptModal}
 *       …
 *     </div>
 *   );
 */
export function usePrompt() {
  const [state, setState] = useState<PromptState | null>(null);

  const prompt = useCallback((opts: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      setState({ ...opts, resolve });
    });
  }, []);

  const close = useCallback((value: string | null) => {
    setState((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const promptModal = state ? <PromptDialog state={state} onClose={close} /> : null;

  return { prompt, promptModal };
}

function PromptDialog({
  state,
  onClose,
}: {
  state: PromptState;
  onClose: (value: string | null) => void;
}) {
  const [value, setValue] = useState(state.defaultValue ?? '');

  return (
    <div
      className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-50 p-4"
      onClick={() => onClose(null)}
    >
      <div
        className="card w-full max-w-md p-5 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {state.title && (
          <h2 className="font-display text-lg text-teresita-700 mb-2">{state.title}</h2>
        )}
        <p className="text-sm text-ink-700 whitespace-pre-line mb-3">{state.message}</p>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={state.placeholder}
          className="input"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') onClose(value);
            else if (e.key === 'Escape') onClose(null);
          }}
        />
        <footer className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onClose(null)}>
            Cancelar
          </Button>
          <Button onClick={() => onClose(value)}>{state.confirmLabel ?? 'Aceptar'}</Button>
        </footer>
      </div>
    </div>
  );
}
