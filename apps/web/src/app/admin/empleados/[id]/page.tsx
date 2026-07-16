'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

// Conceptos de pago a empleado. Sueldo/Jornada/Horas extra/Feriado/Vacaciones/
// Aguinaldo son tipos de sueldo (categoría "Sueldos"); Adelanto y Comisión van
// a sus categorías; Otro es extraordinario. (Paso previo a hacerlos lista
// configurable — ver patrón de "listas blandas".)
type EmpConcepto =
  | 'SUELDO'
  | 'JORNADA'
  | 'HORAS_EXTRA'
  | 'FERIADO'
  | 'VACACIONES'
  | 'AGUINALDO'
  | 'ADELANTO'
  | 'COMISION'
  | 'OTRO';

const EMP_CONCEPTOS: Array<{ value: EmpConcepto; label: string }> = [
  { value: 'SUELDO', label: 'Sueldo' },
  { value: 'JORNADA', label: 'Jornada' },
  { value: 'HORAS_EXTRA', label: 'Horas extra' },
  { value: 'FERIADO', label: 'Feriado' },
  { value: 'VACACIONES', label: 'Vacaciones' },
  { value: 'AGUINALDO', label: 'Aguinaldo' },
  { value: 'ADELANTO', label: 'Adelanto' },
  { value: 'COMISION', label: 'Comisión' },
  { value: 'OTRO', label: 'Otro' },
];

interface Empleado {
  id: string;
  nombre: string;
  apellido: string | null;
  dni: string | null;
  cuil: string | null;
  puesto: string;
  sueldoBase: string | null;
  formaPago: string | null;
  telefono: string | null;
  email: string | null;
  fechaIngreso: string | null;
  observaciones: string | null;
  activo: boolean;
}

interface MovimientoEmpleado {
  id: string;
  monto: string;
  fechaComputo: string;
  estado: string;
  observacion: string | null;
  categoria: { nombre: string };
  cuentaOrigen: { nombre: string } | null;
  usuario: { nombre: string };
}

interface Detalle {
  empleado: Empleado;
  movimientos: MovimientoEmpleado[];
  totales: {
    total: string;
    sueldos: string;
    adelantos: string;
    comisiones: string;
    otros: string;
  };
}

interface Cuenta {
  id: string;
  nombre: string;
  tipo: string;
  saldoActual: string;
}

const PUESTO_LABEL: Record<string, string> = {
  CAJERO: 'Cajero',
  COCINERO: 'Cocinero',
  ENCARGADO: 'Encargado',
  MOTOQUERO: 'Motoquero',
  ADMINISTRATIVO: 'Administrativo',
  OTRO: 'Otro',
};

export default function EmpleadoDetallePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<Detalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPagar, setShowPagar] = useState(false);
  const [showEditar, setShowEditar] = useState(false);
  // Etiqueta del concepto con la que se abre el modal (de la lista configurable).
  const [tipoConcepto, setTipoConcepto] = useState<string>('Sueldo');

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get<Detalle>(`/admin/empleados/${id}`);
      setData(res);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudo cargar el empleado');
      }
    }
  }, [id]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (error) return <div className="text-pomodoro-600 p-6">{error}</div>;
  if (!data) return <div className="text-ink-500 p-6">Cargando...</div>;

  const e = data.empleado;
  const totales = data.totales;

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header>
        <Link href="/admin/empleados" className="text-sm text-ink-500 hover:underline">
          ← Volver a empleados
        </Link>
        <div className="flex items-baseline justify-between mt-1">
          <div>
            <h1 className="font-display text-xl text-ink-900">
              {e.nombre} {e.apellido ?? ''}
            </h1>
            <p className="text-sm text-ink-500">
              <span className="text-2xs font-medium px-2 py-0.5 rounded bg-cream-200 text-ink-700 mr-2">
                {PUESTO_LABEL[e.puesto] ?? e.puesto}
              </span>
              {e.formaPago && `pago ${e.formaPago}`}
              {e.telefono && ` · ${e.telefono}`}
              {e.dni && ` · DNI ${e.dni}`}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowEditar(true)}>
              Editar datos
            </Button>
            <Button onClick={() => setShowPagar(true)}>+ Cargar pago</Button>
          </div>
        </div>
      </header>

      {/* KPIs del año */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase">Sueldo base</div>
          {e.sueldoBase ? (
            <MoneyAmount value={e.sueldoBase} hero fit className="text-md text-ink-900" />
          ) : (
            <span className="text-ink-300 text-md">—</span>
          )}
        </div>
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase">Sueldos pagados</div>
          <MoneyAmount value={totales.sueldos} hero fit className="text-md text-basil-600" />
          <div className="text-2xs text-ink-500 mt-1">en el año</div>
        </div>
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase">Adelantos</div>
          <MoneyAmount value={totales.adelantos} hero fit className="text-md text-saffron-600" />
        </div>
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase">Comisiones</div>
          <MoneyAmount value={totales.comisiones} hero fit className="text-md text-ocean-600" />
        </div>
      </section>

      {/* Historial */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
          <h2 className="font-display text-md text-ink-900">
            Historial de pagos ({data.movimientos.length})
          </h2>
        </header>
        {data.movimientos.length === 0 ? (
          <div className="px-4 py-8 text-center text-ink-500 text-sm">
            Sin movimientos registrados aún. Cargá el primer pago con el botón de arriba.
          </div>
        ) : (
          <>
          <table className="w-full text-sm hidden md:table">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-4 py-2">Fecha</th>
                <th className="text-left px-4 py-2">Concepto</th>
                <th className="text-left px-4 py-2">Cuenta</th>
                <th className="text-left px-4 py-2">Observación</th>
                <th className="text-right px-4 py-2">Monto</th>
                <th className="px-4 py-2">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.movimientos.map((m) => {
                const conceptoColor =
                  m.categoria.nombre === 'Sueldos'
                    ? 'text-basil-600'
                    : m.categoria.nombre === 'Adelanto a empleado'
                      ? 'text-saffron-600'
                      : m.categoria.nombre === 'Comisiones'
                        ? 'text-ocean-600'
                        : 'text-ink-700';
                return (
                  <tr
                    key={m.id}
                    className={cn(m.estado === 'ANULADO' && 'opacity-50 line-through')}
                  >
                    <td className="px-4 py-2 font-mono text-xs text-ink-700">
                      {new Date(m.fechaComputo).toLocaleDateString('es-AR', {
                        timeZone: 'America/Argentina/Buenos_Aires',
                        day: '2-digit',
                        month: '2-digit',
                        year: '2-digit',
                      })}
                    </td>
                    <td className={cn('px-4 py-2 font-medium', conceptoColor)}>
                      {m.categoria.nombre}
                    </td>
                    <td className="px-4 py-2 text-ink-700 text-xs">
                      {m.cuentaOrigen?.nombre ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-ink-500 text-xs italic max-w-xs truncate">
                      {m.observacion ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <MoneyAmount value={m.monto} className="text-pomodoro-600" />
                    </td>
                    <td className="px-4 py-2 text-center text-2xs uppercase tracking-wider">
                      {m.estado === 'CONFIRMADO' && (
                        <span className="text-basil-600">confirmado</span>
                      )}
                      {m.estado === 'ANULADO' && (
                        <span className="text-pomodoro-600">anulado</span>
                      )}
                      {m.estado === 'PENDIENTE' && (
                        <span className="text-saffron-600">pendiente</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Tarjetas (mobile) */}
          <div className="md:hidden divide-y divide-cream-200">
            {data.movimientos.map((m) => {
              const conceptoColor =
                m.categoria.nombre === 'Sueldos'
                  ? 'text-basil-600'
                  : m.categoria.nombre === 'Adelanto a empleado'
                    ? 'text-saffron-600'
                    : m.categoria.nombre === 'Comisiones'
                      ? 'text-ocean-600'
                      : 'text-ink-700';
              return (
                <div
                  key={m.id}
                  className={cn('p-3', m.estado === 'ANULADO' && 'opacity-50 line-through')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className={cn('font-medium truncate', conceptoColor)}>
                        {m.categoria.nombre}
                      </div>
                      <div className="text-2xs font-mono text-ink-500 truncate mt-0.5">
                        {new Date(m.fechaComputo).toLocaleDateString('es-AR', {
                          timeZone: 'America/Argentina/Buenos_Aires',
                          day: '2-digit',
                          month: '2-digit',
                          year: '2-digit',
                        })}{' '}
                        · {m.cuentaOrigen?.nombre ?? '—'}
                      </div>
                      {m.observacion && (
                        <div className="text-2xs text-ink-500 italic truncate mt-0.5">
                          {m.observacion}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <MoneyAmount value={m.monto} className="text-pomodoro-600" />
                      <div className="text-2xs uppercase tracking-wider mt-0.5">
                        {m.estado === 'CONFIRMADO' && (
                          <span className="text-basil-600">confirmado</span>
                        )}
                        {m.estado === 'ANULADO' && (
                          <span className="text-pomodoro-600">anulado</span>
                        )}
                        {m.estado === 'PENDIENTE' && (
                          <span className="text-saffron-600">pendiente</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </>
        )}
      </section>

      {/* Modal cargar pago */}
      {showPagar && (
        <ModalCargarPago
          empleadoId={id}
          tipoInicial={tipoConcepto}
          onClose={() => setShowPagar(false)}
          onCreated={() => {
            setShowPagar(false);
            void fetchData();
          }}
        />
      )}

      {/* Modal editar empleado */}
      {showEditar && (
        <ModalEditarEmpleado
          empleado={data.empleado}
          onClose={() => setShowEditar(false)}
          onSaved={() => {
            setShowEditar(false);
            void fetchData();
          }}
        />
      )}

      {/* Acceso rápido para cargar distintos conceptos */}
      <div className="flex gap-2 pt-2">
        {(['Sueldo', 'Adelanto', 'Comisión', 'Otro'] as const).map((et) => (
          <Button
            key={et}
            variant="secondary"
            size="sm"
            onClick={() => {
              setTipoConcepto(et);
              setShowPagar(true);
            }}
          >
            + {et === 'Sueldo' ? 'Pago de sueldo' : et}
          </Button>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal cargar pago a empleado
// ────────────────────────────────────────────────────────────────────────

type MetodoEmp = 'EFECTIVO' | 'TRANSFERENCIA' | 'DEPOSITO' | 'CHEQUE' | 'MERCADOPAGO_QR' | 'OTRO';

const METODOS_EMP: Array<{ value: MetodoEmp; label: string }> = [
  { value: 'EFECTIVO', label: 'Efectivo' },
  { value: 'TRANSFERENCIA', label: 'Transferencia' },
  { value: 'DEPOSITO', label: 'Depósito' },
  { value: 'MERCADOPAGO_QR', label: 'MercadoPago' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'OTRO', label: 'Otro' },
];

interface PagoLinea {
  cuentaId: string;
  monto: string;
  metodo: MetodoEmp;
  numeroReferencia: string;
}

function ModalCargarPago({
  empleadoId,
  tipoInicial,
  onClose,
  onCreated,
}: {
  empleadoId: string;
  tipoInicial: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  // Concepto = etiqueta de la lista configurable `concepto_pago_empleado`.
  const [concepto, setConcepto] = useState<string>(tipoInicial);
  const [conceptos, setConceptos] = useState<string[]>(EMP_CONCEPTOS.map((c) => c.label));
  const [monto, setMonto] = useState('');
  // Multicuenta: el pago se puede repartir en varias cuentas (cada una con su
  // monto y método). Con una sola línea funciona igual que antes.
  const [pagos, setPagos] = useState<PagoLinea[]>([
    { cuentaId: '', monto: '', metodo: 'EFECTIVO', numeroReferencia: '' },
  ]);
  const [observacion, setObservacion] = useState('');
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [c, ops] = await Promise.all([
          api.get<{ cuentas: Cuenta[] }>('/admin/cuentas'),
          api
            .get<{ opciones: Array<{ etiqueta: string }> }>(
              '/configuracion/opciones/concepto_pago_empleado',
            )
            .catch(() => ({ opciones: [] as Array<{ etiqueta: string }> })),
        ]);
        setCuentas(c.cuentas);
        if (ops.opciones.length > 0) setConceptos(ops.opciones.map((o) => o.etiqueta));
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  // ── Multicuenta: cálculo de reparto ──
  const montoNum = Number(monto || 0);
  const totalAsignado = pagos.reduce((acc, p) => acc + Number(p.monto || 0), 0);
  const faltante = montoNum - totalAsignado;
  const cuadra = Math.abs(faltante) < 0.5;

  // Auto-fill: con UNA sola cuenta, su monto = total del pago. Solo se reparte
  // a mano cuando hay 2+ cuentas.
  useEffect(() => {
    if (pagos.length === 1 && montoNum > 0) {
      const totalStr = montoNum.toFixed(2);
      if (pagos[0]!.monto !== totalStr) {
        setPagos((arr) => arr.map((p, i) => (i === 0 ? { ...p, monto: totalStr } : p)));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [montoNum, pagos.length]);

  function setPago(idx: number, patch: Partial<PagoLinea>) {
    setPagos((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function addPago() {
    const restoSugerido = Math.max(0, faltante);
    setPagos((arr) => [
      ...arr,
      {
        cuentaId: '',
        monto: restoSugerido > 0 ? restoSugerido.toFixed(2) : '',
        metodo: 'EFECTIVO',
        numeroReferencia: '',
      },
    ]);
  }
  function removePago(idx: number) {
    setPagos((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }
  function autocompletarResto(idx: number) {
    const otras = pagos.reduce((acc, p, i) => (i === idx ? acc : acc + Number(p.monto || 0)), 0);
    const resto = Math.max(0, montoNum - otras);
    setPago(idx, { monto: resto.toFixed(2) });
  }

  async function submit() {
    setError(null);
    if (!monto || montoNum <= 0) return setError('Falta el monto');
    if (pagos.some((p) => !p.cuentaId)) return setError('Hay una línea de cuenta sin elegir');
    if (pagos.some((p) => Number(p.monto || 0) <= 0)) {
      return setError('Cada cuenta tiene que tener un monto > 0');
    }
    if (!cuadra) {
      return setError(
        faltante > 0
          ? `Falta asignar $${faltante.toFixed(2)} entre cuentas`
          : `Asignaste $${(-faltante).toFixed(2)} de más`,
      );
    }
    const ids = pagos.map((p) => p.cuentaId);
    if (new Set(ids).size !== ids.length) {
      return setError('No podés repetir la misma cuenta dos veces');
    }
    setGuardando(true);
    try {
      await api.post(`/admin/empleados/${empleadoId}/movimientos`, {
        conceptoEtiqueta: concepto,
        observacion: observacion || undefined,
        pagos: pagos.map((p) => ({
          cuentaId: p.cuentaId,
          monto: p.monto,
          metodo: p.metodo,
          numeroReferencia: p.numeroReferencia || undefined,
        })),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar el pago');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-lg p-5 shadow-modal max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Cargar pago a empleado</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Concepto</label>
            <div className="grid grid-cols-3 gap-2">
              {conceptos.map((et) => (
                <button
                  key={et}
                  type="button"
                  onClick={() => setConcepto(et)}
                  className={cn(
                    'py-2 px-2 rounded-md text-xs font-medium border transition-colors',
                    concepto === et
                      ? 'bg-basil-600 text-white border-basil-600'
                      : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
                  )}
                >
                  {et}
                </button>
              ))}
            </div>
            <p className="text-2xs text-ink-500 mt-1">
              ¿Falta un concepto? Agregalo en Configuración → Listas y opciones.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Monto</label>
            <input
              type="number"
              step="0.01"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              className="input font-mono text-lg"
              placeholder="0.00"
              autoFocus
            />
          </div>

          {/* Cuentas (multicuenta): repartir el pago en una o varias cuentas */}
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Sale de
              <span className="text-2xs text-ink-500 font-normal ml-1">
                (podés repartir en varias cuentas)
              </span>
            </label>
            <div className="space-y-2">
              {pagos.map((linea, idx) => {
                const necesitaRef = ['TRANSFERENCIA', 'CHEQUE', 'DEPOSITO'].includes(linea.metodo);
                return (
                  <div
                    key={idx}
                    className="rounded-md border border-cream-300 p-2 space-y-2 bg-cream-50/40"
                  >
                    <div className="flex gap-2 items-start">
                      <select
                        value={linea.cuentaId}
                        onChange={(e) => setPago(idx, { cuentaId: e.target.value })}
                        className="input text-sm flex-1"
                      >
                        <option value="">Elegí cuenta...</option>
                        {cuentas.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.nombre}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        value={linea.monto}
                        onChange={(e) => setPago(idx, { monto: e.target.value })}
                        placeholder="0.00"
                        className="input text-sm font-mono w-28 text-right"
                      />
                      {pagos.length > 1 && Math.abs(faltante) > 0.5 && (
                        <button
                          type="button"
                          onClick={() => autocompletarResto(idx)}
                          className="px-2 py-1.5 text-2xs bg-saffron-100 text-saffron-600 rounded border border-saffron-600/40 hover:bg-saffron-600 hover:text-white whitespace-nowrap"
                          title="Autocompletar con el resto que falta"
                        >
                          Resto
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removePago(idx)}
                        disabled={pagos.length === 1}
                        className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded disabled:opacity-30"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="flex gap-2 items-center">
                      <select
                        value={linea.metodo}
                        onChange={(e) => setPago(idx, { metodo: e.target.value as MetodoEmp })}
                        className="input text-xs py-1.5 w-40"
                      >
                        {METODOS_EMP.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      {necesitaRef && (
                        <input
                          type="text"
                          value={linea.numeroReferencia}
                          onChange={(e) => setPago(idx, { numeroReferencia: e.target.value })}
                          className="input text-xs py-1.5 font-mono flex-1"
                          placeholder="Nº operación / referencia"
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={addPago}
              className="mt-2 text-xs text-teresita-700 hover:underline"
            >
              + Agregar otra cuenta
            </button>

            {/* Resumen Asignado / Falta / Sobra (solo cuando hay reparto) */}
            {montoNum > 0 && pagos.length > 1 && (
              <div className="mt-2 bg-surface-sunken rounded-md px-3 py-2 grid grid-cols-2 gap-y-1 text-sm font-mono">
                <span className="text-ink-700">Asignado:</span>
                <span
                  className={cn(
                    'text-right',
                    cuadra && totalAsignado > 0 && 'text-basil-600 font-semibold',
                  )}
                >
                  $ {totalAsignado.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                </span>
                {Math.abs(faltante) > 0.5 ? (
                  <>
                    <span
                      className={cn(
                        'font-semibold',
                        faltante > 0 ? 'text-pomodoro-600' : 'text-saffron-600',
                      )}
                    >
                      {faltante > 0 ? 'Falta:' : 'Sobra:'}
                    </span>
                    <span
                      className={cn(
                        'text-right font-semibold',
                        faltante > 0 ? 'text-pomodoro-600' : 'text-saffron-600',
                      )}
                    >
                      $ {Math.abs(faltante).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </span>
                  </>
                ) : (
                  totalAsignado > 0 && (
                    <>
                      <span className="text-basil-600">✓ Cuadra</span>
                      <span></span>
                    </>
                  )
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Observación (opcional)
            </label>
            <input
              type="text"
              value={observacion}
              onChange={(e) => setObservacion(e.target.value)}
              className="input"
              placeholder="ej. sueldo abril, adelanto vacaciones..."
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        <footer className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={guardando}>
            {guardando ? 'Guardando...' : 'Registrar pago'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal editar empleado (datos básicos: puesto, forma de pago, sueldo, etc.)
// ────────────────────────────────────────────────────────────────────────

const PUESTO_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'CAJERO', label: 'Cajero' },
  { value: 'COCINERO', label: 'Cocinero' },
  { value: 'ENCARGADO', label: 'Encargado' },
  { value: 'MOTOQUERO', label: 'Motoquero' },
  { value: 'ADMINISTRATIVO', label: 'Administrativo' },
  { value: 'OTRO', label: 'Otro' },
];

const FORMAS_PAGO = ['mensual', 'quincenal', 'jornal', 'comisión', 'mixto'] as const;

function ModalEditarEmpleado({
  empleado,
  onClose,
  onSaved,
}: {
  empleado: Empleado;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nombre, setNombre] = useState(empleado.nombre);
  const [apellido, setApellido] = useState(empleado.apellido ?? '');
  const [puesto, setPuesto] = useState(empleado.puesto);
  const [formaPago, setFormaPago] = useState(empleado.formaPago ?? 'mensual');
  const [sueldoBase, setSueldoBase] = useState(empleado.sueldoBase ?? '');
  const [telefono, setTelefono] = useState(empleado.telefono ?? '');
  const [dni, setDni] = useState(empleado.dni ?? '');
  const [cuil, setCuil] = useState(empleado.cuil ?? '');
  const [email, setEmail] = useState(empleado.email ?? '');
  const [observaciones, setObservaciones] = useState(empleado.observaciones ?? '');
  const [activo, setActivo] = useState(empleado.activo);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cambia =
    nombre !== empleado.nombre ||
    apellido !== (empleado.apellido ?? '') ||
    puesto !== empleado.puesto ||
    formaPago !== (empleado.formaPago ?? '') ||
    sueldoBase !== (empleado.sueldoBase ?? '') ||
    telefono !== (empleado.telefono ?? '') ||
    dni !== (empleado.dni ?? '') ||
    cuil !== (empleado.cuil ?? '') ||
    email !== (empleado.email ?? '') ||
    observaciones !== (empleado.observaciones ?? '') ||
    activo !== empleado.activo;

  async function submit() {
    if (!nombre.trim()) return setError('Falta el nombre');
    setGuardando(true);
    setError(null);
    try {
      // Solo enviar los campos que cambiaron
      const patch: Record<string, unknown> = {};
      if (nombre !== empleado.nombre) patch.nombre = nombre;
      if (apellido !== (empleado.apellido ?? '')) patch.apellido = apellido || null;
      if (puesto !== empleado.puesto) patch.puesto = puesto;
      if (formaPago !== (empleado.formaPago ?? '')) patch.formaPago = formaPago || null;
      if (sueldoBase !== (empleado.sueldoBase ?? '')) {
        patch.sueldoBase = sueldoBase || null;
      }
      if (telefono !== (empleado.telefono ?? '')) patch.telefono = telefono || null;
      if (dni !== (empleado.dni ?? '')) patch.dni = dni || null;
      if (cuil !== (empleado.cuil ?? '')) patch.cuil = cuil || null;
      if (email !== (empleado.email ?? '')) patch.email = email || null;
      if (observaciones !== (empleado.observaciones ?? ''))
        patch.observaciones = observaciones || null;
      if (activo !== empleado.activo) patch.activo = activo;

      await api.patch(`/admin/empleados/${empleado.id}`, patch);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-lg shadow-modal max-h-[90vh] flex flex-col">
        <header className="px-5 py-4 border-b border-cream-300 flex justify-between items-center">
          <h2 className="font-display text-lg text-teresita-700">Editar empleado</h2>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900 text-xl leading-none">
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Nombre</label>
              <input
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Apellido</label>
              <input
                type="text"
                value={apellido}
                onChange={(e) => setApellido(e.target.value)}
                className="input"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Puesto</label>
              <select
                value={puesto}
                onChange={(e) => setPuesto(e.target.value)}
                className="input"
              >
                {PUESTO_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">
                Forma de pago
              </label>
              <select
                value={formaPago}
                onChange={(e) => setFormaPago(e.target.value)}
                className="input"
              >
                {FORMAS_PAGO.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">
                Sueldo base
              </label>
              <input
                type="number"
                step="0.01"
                value={sueldoBase}
                onChange={(e) => setSueldoBase(e.target.value)}
                className="input font-mono"
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Teléfono</label>
              <input
                type="text"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                className="input"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">DNI</label>
              <input
                type="text"
                value={dni}
                onChange={(e) => setDni(e.target.value)}
                className="input font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">CUIL</label>
              <input
                type="text"
                value={cuil}
                onChange={(e) => setCuil(e.target.value)}
                className="input font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Observaciones</label>
            <textarea
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              className="input min-h-[60px]"
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={activo}
              onChange={(e) => setActivo(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-ink-700">Empleado activo</span>
            {!activo && (
              <span className="text-2xs text-pomodoro-600 ml-2">
                desactivar oculta al empleado del listado por default
              </span>
            )}
          </label>
        </div>

        {error && (
          <div className="px-5 py-2 bg-pomodoro-100 text-pomodoro-600 text-sm">{error}</div>
        )}

        <footer className="px-5 py-3 border-t border-cream-300 bg-surface-sunken flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!cambia || guardando} onClick={() => void submit()}>
            {guardando ? 'Guardando...' : 'Guardar cambios'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
