'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  function digit(d: string) {
    if (pin.length >= 8 || enviando) return;
    setPin((p) => p + d);
    setError(null);
  }

  function backspace() {
    setPin((p) => p.slice(0, -1));
    setError(null);
  }

  async function submit() {
    if (pin.length < 4 || enviando) return;
    setEnviando(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (r.ok) {
        router.push('/');
      } else {
        const body = await r.json().catch(() => ({}));
        setError(body.error ?? 'PIN incorrecto');
        setPin('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-cream-100 px-6 safe-top safe-bottom">
      <div className="text-center mb-8">
        <div className="text-6xl mb-2">🍝</div>
        <h1 className="font-display text-3xl text-teresita-700">Santa Teresita</h1>
        <p className="text-sm text-ink-500 mt-1">Panel de consulta</p>
      </div>

      <div className="w-full max-w-xs">
        <div className="bg-white rounded-lg shadow-sm border border-cream-300 p-4 mb-4">
          <div className="flex justify-center gap-2 h-12 items-center">
            {[0, 1, 2, 3, 4, 5, 6, 7].slice(0, Math.max(4, pin.length)).map((i) => (
              <div
                key={i}
                className={
                  i < pin.length
                    ? 'w-3 h-3 rounded-full bg-teresita-700'
                    : 'w-3 h-3 rounded-full bg-cream-300'
                }
              />
            ))}
          </div>
          {error && (
            <p className="text-pomodoro-600 text-xs text-center mt-2">⚠ {error}</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button
              key={d}
              onClick={() => digit(d)}
              disabled={enviando}
              className="aspect-square bg-white border border-cream-300 rounded-lg text-2xl font-medium text-ink-900 active:bg-cream-200 disabled:opacity-50"
            >
              {d}
            </button>
          ))}
          <button
            onClick={backspace}
            disabled={enviando || pin.length === 0}
            className="aspect-square bg-cream-200 border border-cream-300 rounded-lg text-xl text-ink-700 active:bg-cream-300 disabled:opacity-50"
            aria-label="Borrar"
          >
            ←
          </button>
          <button
            onClick={() => digit('0')}
            disabled={enviando}
            className="aspect-square bg-white border border-cream-300 rounded-lg text-2xl font-medium text-ink-900 active:bg-cream-200 disabled:opacity-50"
          >
            0
          </button>
          <button
            onClick={submit}
            disabled={enviando || pin.length < 4}
            className="aspect-square bg-teresita-700 text-cream-50 rounded-lg text-base font-semibold active:bg-teresita-900 disabled:opacity-50"
          >
            {enviando ? '...' : 'Entrar'}
          </button>
        </div>
      </div>

      <p className="text-2xs text-ink-300 mt-8 text-center max-w-xs">
        Solo administradores pueden acceder. Si el PIN no funciona, pedile a Alejo que verifique tu usuario en el panel desktop.
      </p>
    </div>
  );
}
