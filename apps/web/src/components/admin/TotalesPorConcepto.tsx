'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import {
  FiltroPeriodo,
  paramsPeriodo,
  type PeriodoBusqueda,
} from '@/components/admin/BusquedaTabla';

/**
 * Lo pagado en el período, DISCRIMINADO por concepto.
 *
 * El pedido de la encargada, textual: que los números estén "siempre arriba de
 * todo, grandes y claros", y que digan cuánto se fue en cada cosa —jornada,
 * horas extra, plus, adelanto— y no un único total que no explica nada.
 *
 * Cada número es además un BOTÓN: abre el detalle de los movimientos que lo
 * componen. Un total sin eso es un dato que hay que creer — no se puede ver de
 * qué está hecho ni encontrar el pago mal cargado que lo infla. Por eso van en
 * un recuadro con borde y no como texto suelto: que se vea que se puede tocar
 * antes de tocarlo.
 *
 * El mismo componente va en la pantalla general de Empleados y en la ficha de
 * cada uno, a propósito: son la misma pregunta a distinta escala, y que se vean
 * igual evita tener que volver a entenderlos.
 *
 * Cuando no se pagó nada en el período se dice con todas las letras en vez de
 * mostrar una fila de ceros — un cero no distingue "no hubo pagos" de "todavía
 * no cargó".
 */

export interface ConceptoTotal {
  concepto: string;
  monto: string;
  cantidad: number;
}

export function TotalesPorConcepto({
  porConcepto,
  total,
  titulo = 'Pagado en el período',
  cargando = false,
  periodo,
  desde,
  hasta,
  empleadoId,
}: {
  porConcepto: ConceptoTotal[];
  /** El total. Si no viene, se suma de los conceptos. */
  total?: string;
  titulo?: string;
  cargando?: boolean;
  /**
   * El filtro con el que se calcularon estos números. El detalle abre con el
   * MISMO, así lo que se ve adentro suma exactamente lo que dice el botón; de
   * ahí se puede seguir acotando sin tocar la pantalla de atrás.
   */
  periodo: PeriodoBusqueda;
  desde: string;
  hasta: string;
  /** En la ficha de un empleado, para abrir el detalle ya acotado a él. */
  empleadoId?: string;
}) {
  const suma = total ?? porConcepto.reduce((acc, c) => acc + Number(c.monto), 0).toFixed(2);
  const hayAlgo = porConcepto.length > 0 && Number(suma) !== 0;
  // `null` = cerrado. `{ concepto: null }` = abierto con todos los conceptos.
  const [detalle, setDetalle] = useState<{ concepto: string | null } | null>(null);

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-2xs uppercase tracking-wider text-ink-500">{titulo}</span>
        {cargando && <span className="text-2xs text-ink-500">actualizando…</span>}
      </div>

      <button
        type="button"
        onClick={() => setDetalle({ concepto: null })}
        disabled={!hayAlgo}
        className={cn(
          'mt-1 w-full text-left rounded-lg border px-3 py-2 transition-colors',
          hayAlgo
            ? 'border-teresita-300 bg-teresita-50 hover:bg-teresita-100 cursor-pointer'
            : 'border-cream-300 bg-transparent cursor-default',
        )}
        title={hayAlgo ? 'Ver todos los pagos del período' : undefined}
      >
        <MoneyAmount value={suma} hero fit className="text-teresita-700" />
        {hayAlgo && (
          <span className="block text-2xs text-teresita-700 mt-0.5">
            tocá para ver el detalle →
          </span>
        )}
      </button>

      {!hayAlgo ? (
        <p className="text-sm text-ink-500 mt-2">No se registran pagos en el período elegido.</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
          {porConcepto.map((c) => (
            <button
              key={c.concepto}
              type="button"
              onClick={() => setDetalle({ concepto: c.concepto })}
              className="min-w-0 text-left rounded-lg border border-cream-300 bg-white px-3 py-2 hover:border-teresita-300 hover:bg-teresita-50 transition-colors"
              title={`Ver los ${c.cantidad} pagos de ${c.concepto}`}
            >
              <div className="text-2xs uppercase tracking-wider text-ink-500 truncate">
                {c.concepto}
              </div>
              <MoneyAmount value={c.monto} fit className="text-md text-ink-900" />
              <div className="text-2xs text-ink-500">
                {c.cantidad} pago{c.cantidad !== 1 && 's'}
              </div>
            </button>
          ))}
        </div>
      )}

      {detalle && (
        <ModalPagos
          concepto={detalle.concepto}
          periodoInicial={periodo}
          desdeInicial={desde}
          hastaInicial={hasta}
          empleadoInicial={empleadoId ?? ''}
          onClose={() => setDetalle(null)}
        />
      )}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   El detalle
// ────────────────────────────────────────────────────────────────────────

interface PagoDetalle {
  id: string;
  monto: string;
  fecha: string;
  concepto: string;
  categoria: string;
  cuenta: string | null;
  cargadoPor: string;
  observacion: string | null;
  empleadoId: string | null;
  empleado: string | null;
}

interface OpcionEmpleado {
  id: string;
  nombre: string;
  apellido: string | null;
  activo: boolean;
}

const PAGE_SIZE = 20;

/**
 * Los movimientos detrás de un número.
 *
 * Abre con el mismo filtro con el que se calculó el total —así lo de adentro
 * suma lo que decía el botón— y desde ahí se puede acotar más: otro período, u
 * otro empleado.
 *
 * El empleado va en un desplegable y no en un buscador por texto a pedido
 * expreso: son una decena de personas conocidas, y una lista se recorre con el
 * pulgar sin tener que acordarse de cómo se escribe el apellido.
 */
function ModalPagos({
  concepto,
  periodoInicial,
  desdeInicial,
  hastaInicial,
  empleadoInicial,
  onClose,
}: {
  concepto: string | null;
  periodoInicial: PeriodoBusqueda;
  desdeInicial: string;
  hastaInicial: string;
  empleadoInicial: string;
  onClose: () => void;
}) {
  const [periodo, setPeriodo] = useState<PeriodoBusqueda>(periodoInicial);
  const [desde, setDesde] = useState(desdeInicial);
  const [hasta, setHasta] = useState(hastaInicial);
  const [empleadoId, setEmpleadoId] = useState(empleadoInicial);
  const [page, setPage] = useState(1);

  const [pagos, setPagos] = useState<PagoDetalle[]>([]);
  const [totalMonto, setTotalMonto] = useState('0');
  const [totalFilas, setTotalFilas] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [recortado, setRecortado] = useState(false);
  const [opciones, setOpciones] = useState<OpcionEmpleado[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cambiar un filtro vuelve a la página 1: quedarse en la 7 mostraría vacío
  // sin ninguna razón visible.
  useEffect(() => {
    setPage(1);
  }, [periodo, desde, hasta, empleadoId]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ empleados: OpcionEmpleado[] }>('/admin/empleados/opciones');
        setOpciones(res.empleados);
      } catch {
        // El desplegable es una comodidad: si falla, el detalle se sigue viendo.
      }
    })();
  }, []);

  const fetchData = useCallback(async () => {
    setCargando(true);
    try {
      const params = paramsPeriodo(periodo, desde, hasta);
      if (concepto) params.set('concepto', concepto);
      if (empleadoId) params.set('empleadoId', empleadoId);
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      const res = await api.get<{
        pagos: PagoDetalle[];
        totalMonto: string;
        total: number;
        totalPages: number;
        recortado: boolean;
      }>(`/admin/empleados/pagos?${params.toString()}`);
      setPagos(res.pagos);
      setTotalMonto(res.totalMonto);
      setTotalFilas(res.total);
      setTotalPages(res.totalPages);
      setRecortado(res.recortado);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudo cargar el detalle');
      }
    } finally {
      setCargando(false);
    }
  }, [concepto, periodo, desde, hasta, empleadoId, page]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Escape cierra: en el celular el botón queda arriba y lejos del pulgar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-ink-900/50 flex items-start sm:items-center justify-center z-40 p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-3xl shadow-modal max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-cream-300 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-lg text-teresita-700 truncate">
              {concepto ?? 'Todos los pagos'}
            </h2>
            <div className="flex items-baseline gap-2 flex-wrap">
              <MoneyAmount value={totalMonto} className="text-md text-ink-900" />
              <span className="text-2xs text-ink-500">
                {cargando ? 'buscando…' : `${totalFilas} pago${totalFilas === 1 ? '' : 's'}`}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-ink-500 hover:text-ink-900 text-lg leading-none px-2"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </header>

        <div className="px-4 py-3 border-b border-cream-200 space-y-2.5">
          <select
            value={empleadoId}
            onChange={(e) => setEmpleadoId(e.target.value)}
            className="input w-full"
          >
            <option value="">Todos los empleados</option>
            {opciones.map((o) => (
              <option key={o.id} value={o.id}>
                {o.nombre}
                {o.apellido ? ` ${o.apellido}` : ''}
                {!o.activo && ' (inactivo)'}
              </option>
            ))}
          </select>
          <FiltroPeriodo
            periodo={periodo}
            onPeriodo={setPeriodo}
            desde={desde}
            onDesde={setDesde}
            hasta={hasta}
            onHasta={setHasta}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="m-4 bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
          {!error && pagos.length === 0 && !cargando && (
            <p className="px-4 py-8 text-center text-sm text-ink-500">
              No hay pagos que cumplan con esos filtros.
            </p>
          )}
          {pagos.length > 0 && (
            <ul className="divide-y divide-cream-200">
              {pagos.map((p) => (
                <li key={p.id} className="px-4 py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-ink-900 truncate">
                      {p.empleado ?? 'Sin empleado'}
                    </div>
                    <div className="text-2xs text-ink-500 truncate">
                      {new Date(p.fecha).toLocaleDateString('es-AR', {
                        timeZone: 'America/Argentina/Buenos_Aires',
                        day: '2-digit',
                        month: '2-digit',
                        year: '2-digit',
                      })}
                      {' · '}
                      {p.concepto}
                      {p.cuenta && ` · ${p.cuenta}`}
                    </div>
                    {p.observacion && (
                      <div className="text-2xs text-ink-500 italic truncate">{p.observacion}</div>
                    )}
                  </div>
                  <MoneyAmount value={p.monto} className="shrink-0 text-pomodoro-600" />
                </li>
              ))}
            </ul>
          )}
          {recortado && (
            <p className="px-4 py-3 text-2xs text-saffron-600">
              Son demasiados pagos para mostrarlos todos juntos. Acotá el período para que los
              números de arriba sean exactos.
            </p>
          )}
        </div>

        {totalPages > 1 && (
          <footer className="px-4 py-2.5 border-t border-cream-300 flex items-center justify-center gap-2 text-sm">
            <Button
              variant="secondary"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((x) => Math.max(1, x - 1))}
            >
              ← Anterior
            </Button>
            <span className="text-ink-500 mx-1 text-2xs">
              Página {page} de {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page === totalPages}
              onClick={() => setPage((x) => Math.min(totalPages, x + 1))}
            >
              Siguiente →
            </Button>
          </footer>
        )}
      </div>
    </div>
  );
}
