'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Cómo se paga una plata que entra: uno o varios métodos, cada uno con su
 * cuenta destino.
 *
 * Es el mismo gesto del cobro de una venta, traído a mayoristas. Las empresas
 * pagan mezclado —una parte por transferencia y el resto en efectivo— y con un
 * solo método había que cargar dos cobros a mano, o meter todo en una cuenta y
 * dejar el arqueo de la otra mal.
 *
 * Arranca con UNA línea, así el caso normal se ve igual que antes: método,
 * cuenta y listo. El botón de dividir aparece sólo cuando hace falta.
 */

export type MetodoCobro =
  | 'EFECTIVO'
  | 'TRANSFERENCIA'
  | 'DEPOSITO'
  | 'CHEQUE'
  | 'MERCADOPAGO_QR'
  | 'OTRO';

export interface LineaPago {
  metodo: MetodoCobro;
  cuentaId: string;
  monto: string;
  numeroReferencia?: string;
}

export interface CuentaShort {
  id: string;
  nombre: string;
  tipo?: string;
}

const METODOS: Array<{ value: MetodoCobro; label: string; icon: string }> = [
  { value: 'TRANSFERENCIA', label: 'Transfer.', icon: '🏦' },
  { value: 'EFECTIVO', label: 'Efectivo', icon: '💵' },
  { value: 'MERCADOPAGO_QR', label: 'MP / QR', icon: '📱' },
  { value: 'DEPOSITO', label: 'Depósito', icon: '🏧' },
  { value: 'CHEQUE', label: 'Cheque', icon: '📄' },
  { value: 'OTRO', label: 'Otro', icon: '•' },
];

/** Métodos donde el número de operación es lo que después permite conciliar. */
const CON_REFERENCIA: MetodoCobro[] = ['TRANSFERENCIA', 'CHEQUE', 'DEPOSITO'];

/** Cuenta razonable para un método, para no hacer elegir lo obvio. */
export function sugerirCuenta(metodo: MetodoCobro, cuentas: CuentaShort[]): CuentaShort | null {
  if (metodo === 'EFECTIVO') return cuentas.find((c) => c.tipo === 'EFECTIVO') ?? null;
  if (metodo === 'MERCADOPAGO_QR') {
    return (
      cuentas.find((c) => c.nombre.toLowerCase().includes('mercadopago')) ??
      cuentas.find((c) => c.tipo === 'WALLET') ??
      null
    );
  }
  return cuentas.find((c) => c.tipo === 'BANCO') ?? cuentas[0] ?? null;
}

/** Las cuentas del local. Hook aparte porque lo usan las dos pantallas. */
export function useCuentas(): CuentaShort[] {
  const [cuentas, setCuentas] = useState<CuentaShort[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const c = await api.get<{ cuentas: CuentaShort[] }>('/admin/cuentas');
        setCuentas(c.cuentas);
      } catch {
        /* silencioso: el select queda vacío y el submit avisa */
      }
    })();
  }, []);
  return cuentas;
}

export function lineaVacia(cuentas: CuentaShort[], metodo: MetodoCobro = 'TRANSFERENCIA'): LineaPago {
  return { metodo, cuentaId: sugerirCuenta(metodo, cuentas)?.id ?? '', monto: '' };
}

/**
 * Devuelve el problema que impide cobrar, o `null` si está todo bien.
 * Lo usan los dos formularios para no repetir (ni desincronizar) la validación.
 */
export function validarPagos(lineas: LineaPago[], total: number): string | null {
  if (lineas.some((l) => !l.cuentaId)) return 'Hay un pago sin cuenta destino';
  if (lineas.some((l) => !(Number(l.monto) > 0))) return 'Hay un pago sin monto';
  const suma = lineas.reduce((a, l) => a + Number(l.monto || 0), 0);
  const dif = total - suma;
  if (Math.abs(dif) > 0.01) {
    return dif > 0
      ? `Falta cubrir $${dif.toFixed(2)}`
      : `Asignaste $${(-dif).toFixed(2)} de más`;
  }
  return null;
}

export function LineasDePago({
  lineas,
  onChange,
  cuentas,
  total,
}: {
  lineas: LineaPago[];
  onChange: (lineas: LineaPago[]) => void;
  cuentas: CuentaShort[];
  /** Lo que hay que cubrir entre todas las líneas. */
  total: number;
}) {
  const suma = lineas.reduce((a, l) => a + Number(l.monto || 0), 0);
  const falta = total - suma;

  function setLinea(idx: number, patch: Partial<LineaPago>) {
    onChange(
      lineas.map((l, i) => {
        if (i !== idx) return l;
        const next = { ...l, ...patch };
        // Al cambiar de método, la cuenta sugerida acompaña — salvo que la
        // hayan elegido a mano en esta misma edición.
        if (patch.metodo && !patch.cuentaId) {
          next.cuentaId = sugerirCuenta(patch.metodo, cuentas)?.id ?? next.cuentaId;
        }
        return next;
      }),
    );
  }

  function agregar() {
    const yaHayEfectivo = lineas.some((l) => l.metodo === 'EFECTIVO');
    const metodo: MetodoCobro = yaHayEfectivo ? 'TRANSFERENCIA' : 'EFECTIVO';
    onChange([
      ...lineas,
      {
        metodo,
        cuentaId: sugerirCuenta(metodo, cuentas)?.id ?? '',
        monto: falta > 0 ? falta.toFixed(2) : '',
      },
    ]);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-ink-700">
          {lineas.length > 1 ? 'Cómo lo paga' : 'Método y cuenta'}
        </label>
        <button
          type="button"
          onClick={agregar}
          className="text-2xs text-teresita-700 hover:underline"
        >
          + otro método
        </button>
      </div>

      {lineas.map((l, idx) => (
        <div key={idx} className="rounded border border-cream-300 p-2 space-y-2">
          <div className="flex flex-wrap gap-1">
            {METODOS.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setLinea(idx, { metodo: m.value })}
                className={cn(
                  'text-2xs px-2 py-1 rounded border transition-colors',
                  l.metodo === m.value
                    ? 'border-teresita-700 bg-teresita-50 text-teresita-800'
                    : 'border-cream-300 text-ink-600 hover:bg-cream-100',
                )}
              >
                <span aria-hidden>{m.icon}</span> {m.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={l.cuentaId}
              onChange={(e) => setLinea(idx, { cuentaId: e.target.value })}
              className="input text-sm flex-1"
            >
              <option value="">Entra a...</option>
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
            <input
              type="number"
              step="0.01"
              value={l.monto}
              onChange={(e) => setLinea(idx, { monto: e.target.value })}
              placeholder="0.00"
              className="input w-28 text-right font-mono text-sm"
            />
            {lineas.length > 1 && (
              <button
                type="button"
                onClick={() => onChange(lineas.filter((_, i) => i !== idx))}
                className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded"
                title="Quitar este método"
              >
                ✕
              </button>
            )}
          </div>
          {CON_REFERENCIA.includes(l.metodo) && (
            <input
              type="text"
              value={l.numeroReferencia ?? ''}
              onChange={(e) => setLinea(idx, { numeroReferencia: e.target.value })}
              placeholder="Nº de operación / referencia"
              className="input font-mono text-sm"
            />
          )}
        </div>
      ))}

      <div className="flex items-center justify-between text-2xs">
        <button
          type="button"
          onClick={() =>
            onChange(
              lineas.map((l, i) =>
                i === lineas.length - 1
                  ? { ...l, monto: Math.max(0, Number(l.monto || 0) + falta).toFixed(2) }
                  : l,
              ),
            )
          }
          className={cn(
            'hover:underline',
            Math.abs(falta) > 0.01 ? 'text-teresita-700' : 'invisible',
          )}
        >
          completar con el resto
        </button>
        <span
          className={cn(
            'font-mono',
            Math.abs(falta) > 0.01 ? 'text-pomodoro-600' : 'text-basil-600',
          )}
        >
          {Math.abs(falta) <= 0.01
            ? '✓ cubierto'
            : falta > 0
              ? `faltan $${falta.toFixed(2)}`
              : `$${(-falta).toFixed(2)} de más`}
        </span>
      </div>
    </div>
  );
}
