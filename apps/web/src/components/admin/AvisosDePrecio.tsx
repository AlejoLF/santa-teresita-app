'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * "Este producto aumentó un X%" — la pantalla donde eso se resuelve.
 *
 * El aviso lo levanta el sistema cuando entra una factura con un precio
 * unitario distinto del último conocido. NO toca el precio solo: un aumento
 * puede ser real, pero también un error de lectura del OCR, otra presentación
 * (vino el bidón de 5 L en vez del de 1 L) o un recargo puntual. Actualizar
 * en silencio ensucia el costo de todo lo que usa ese insumo, y eso no se
 * descubre hasta que la rentabilidad no cierra, meses después.
 *
 * Por eso acá hay dos botones y nada más: aprobar (mueve el precio) o
 * rechazar (lo deja como estaba). Las dos decisiones quedan registradas.
 *
 * ── Por qué se muestra el precio viejo Y el nuevo, grandes ──────────────
 *
 * El porcentaje solo no alcanza para decidir: "aumentó 12%" no dice nada si
 * no se ve que pasó de $9.365 a $10.489. Con los dos números a la vista se
 * reconoce de una un salto imposible (un cero de más del OCR) sin abrir la
 * factura.
 */

interface Aviso {
  id: string;
  insumoId: string;
  insumoNombre: string;
  presentacion: string | null;
  proveedorId: string;
  proveedor: string;
  precioAnterior: number;
  precioNuevo: number;
  variacionPct: number;
  estado: 'PENDIENTE' | 'APROBADA' | 'RECHAZADA';
  detectadaAt: string;
  aplicadaEnExcel: boolean;
  mensaje: string;
}

type Filtro = 'PENDIENTE' | 'APROBADA' | 'RECHAZADA';

const fmt = (n: number) =>
  `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function AvisosDePrecio({ onCambio }: { onCambio?: (pendientes: number) => void }) {
  const [filtro, setFiltro] = useState<Filtro>('PENDIENTE');
  const [avisos, setAvisos] = useState<Aviso[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolviendo, setResolviendo] = useState<string | null>(null);
  // Escribir también el precio nuevo en la hoja `Compras`. Va tildado: si el
  // Excel queda con el precio viejo, la encargada sigue pidiendo con ese
  // número y el aviso no sirvió de nada.
  const [tambienExcel, setTambienExcel] = useState(true);
  const [avisoExcel, setAvisoExcel] = useState<string | null>(null);

  const fetchAvisos = useCallback(async () => {
    try {
      const r = await api.get<{ alertas: Aviso[] }>(`/admin/alertas-precio?estado=${filtro}`);
      setAvisos(r.alertas);
      setError(null);
      if (filtro === 'PENDIENTE') onCambio?.(r.alertas.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los avisos');
    }
  }, [filtro, onCambio]);

  useEffect(() => {
    void fetchAvisos();
  }, [fetchAvisos]);

  async function resolver(a: Aviso, aprobar: boolean) {
    setResolviendo(a.id);
    setError(null);
    setAvisoExcel(null);
    try {
      const r = await api.post<{ avisoExcel: string | null; celdaExcel: string | null }>(
        `/admin/alertas-precio/${a.id}/resolver`,
        { aprobar, actualizarExcel: aprobar && tambienExcel },
      );
      // El precio del sistema ya quedó bien aunque el Excel no se haya podido
      // escribir. Se avisa, pero no se deshace nada.
      if (r.avisoExcel) setAvisoExcel(r.avisoExcel);
      await fetchAvisos();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo resolver el aviso');
    } finally {
      setResolviendo(null);
    }
  }

  if (error && !avisos) return <div className="text-pomodoro-600 text-sm">{error}</div>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex gap-1">
          {(
            [
              { v: 'PENDIENTE', label: 'Sin resolver' },
              { v: 'APROBADA', label: 'Aprobados' },
              { v: 'RECHAZADA', label: 'Rechazados' },
            ] as const
          ).map((f) => (
            <button
              key={f.v}
              onClick={() => setFiltro(f.v)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-colors',
                filtro === f.v
                  ? 'bg-steel-50 text-steel-700 font-medium'
                  : 'text-ink-500 hover:text-ink-700',
              )}
            >
              {f.label}
            </button>
          ))}
        </nav>

        {filtro === 'PENDIENTE' && (
          <label className="flex items-center gap-2 text-2xs text-ink-500 cursor-pointer">
            <input
              type="checkbox"
              checked={tambienExcel}
              onChange={(e) => setTambienExcel(e.target.checked)}
              className="w-4 h-4"
            />
            Al aprobar, actualizar también el precio en el Excel
          </label>
        )}
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}
      {avisoExcel && (
        <div className="bg-saffron-100 text-saffron-700 px-3 py-2 rounded text-sm">{avisoExcel}</div>
      )}

      {!avisos ? (
        <div className="text-ink-500 text-sm px-4 py-6">Cargando avisos…</div>
      ) : avisos.length === 0 ? (
        <p className="text-sm text-ink-500 italic px-1 py-8 text-center">
          {filtro === 'PENDIENTE'
            ? 'No hay ningún aumento esperando revisión ✨'
            : 'Todavía no hay avisos en este estado.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {avisos.map((a) => {
            const subio = a.variacionPct > 0;
            return (
              <li
                key={a.id}
                className={cn(
                  'card p-4 border-l-4',
                  a.estado !== 'PENDIENTE'
                    ? 'border-l-cream-300'
                    : subio
                      ? 'border-l-pomodoro-600'
                      : 'border-l-saffron-600',
                )}
              >
                <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-ink-900 font-medium">
                      {a.insumoNombre}
                      {a.presentacion && (
                        <span className="text-ink-500 font-normal"> · {a.presentacion}</span>
                      )}
                    </div>
                    <div className="text-2xs text-ink-500 mt-0.5">
                      <Link
                        href={`/admin/insumos/${a.proveedorId}`}
                        className="hover:text-steel-700 hover:underline"
                      >
                        {a.proveedor}
                      </Link>{' '}
                      · detectado el{' '}
                      {new Date(a.detectadaAt).toLocaleDateString('es-AR', {
                        day: '2-digit',
                        month: '2-digit',
                        year: '2-digit',
                      })}
                      {a.estado === 'APROBADA' && a.aplicadaEnExcel && ' · escrito en el Excel'}
                    </div>
                  </div>

                  {/* Los dos precios y el salto, en grande: es la información
                      con la que se decide. */}
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="text-2xs text-ink-500">antes</div>
                      <div className="font-mono text-sm text-ink-500 line-through">
                        {fmt(a.precioAnterior)}
                      </div>
                    </div>
                    <div className="text-ink-300">→</div>
                    <div className="text-right">
                      <div className="text-2xs text-ink-500">ahora</div>
                      <div className="font-mono text-md text-ink-900 font-semibold">
                        {fmt(a.precioNuevo)}
                      </div>
                    </div>
                    <div
                      className={cn(
                        'font-mono text-md font-semibold px-2 py-1 rounded',
                        subio
                          ? 'bg-pomodoro-100 text-pomodoro-600'
                          : 'bg-saffron-100 text-saffron-700',
                      )}
                    >
                      {subio ? '+' : ''}
                      {a.variacionPct.toFixed(1).replace('.0', '')}%
                    </div>
                  </div>

                  {a.estado === 'PENDIENTE' ? (
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        onClick={() => void resolver(a, true)}
                        disabled={resolviendo === a.id}
                      >
                        {resolviendo === a.id ? '…' : 'Aprobar'}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void resolver(a, false)}
                        disabled={resolviendo === a.id}
                      >
                        Rechazar
                      </Button>
                    </div>
                  ) : (
                    <span className="text-2xs text-ink-500 shrink-0">
                      {a.estado === 'APROBADA' ? 'Aprobado' : 'Rechazado'}
                    </span>
                  )}
                </div>

                {/* La frase entera, tal como la arma el sistema. Es la que se
                    lee de un vistazo cuando los números de arriba no alcanzan. */}
                <p className="text-2xs text-ink-500 mt-2">{a.mensaje}</p>
              </li>
            );
          })}
        </ul>
      )}

      {filtro === 'PENDIENTE' && avisos && avisos.length > 0 && (
        <p className="text-2xs text-ink-500 px-1">
          Aprobar cambia el precio de ese producto para ese proveedor. Rechazar lo deja como estaba
          — el precio viejo sigue valiendo hasta que llegue otra factura.
        </p>
      )}
    </div>
  );
}
