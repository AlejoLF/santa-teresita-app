'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

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
  const [tipoConcepto, setTipoConcepto] = useState<'SUELDO' | 'ADELANTO' | 'COMISION' | 'OTRO'>(
    'SUELDO',
  );

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
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Sueldo base</div>
          {e.sueldoBase ? (
            <MoneyAmount value={e.sueldoBase} hero className="text-md text-ink-900" />
          ) : (
            <span className="text-ink-300 text-md">—</span>
          )}
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Sueldos pagados</div>
          <MoneyAmount value={totales.sueldos} hero className="text-md text-basil-600" />
          <div className="text-2xs text-ink-500 mt-1">en el año</div>
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Adelantos</div>
          <MoneyAmount value={totales.adelantos} hero className="text-md text-saffron-600" />
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Comisiones</div>
          <MoneyAmount value={totales.comisiones} hero className="text-md text-ocean-600" />
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
          <table className="w-full text-sm">
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
        {(['SUELDO', 'ADELANTO', 'COMISION', 'OTRO'] as const).map((t) => (
          <Button
            key={t}
            variant="secondary"
            size="sm"
            onClick={() => {
              setTipoConcepto(t);
              setShowPagar(true);
            }}
          >
            + {t === 'SUELDO' ? 'Pago de sueldo' : t === 'ADELANTO' ? 'Adelanto' : t === 'COMISION' ? 'Comisión' : 'Otro pago'}
          </Button>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal cargar pago a empleado
// ────────────────────────────────────────────────────────────────────────

function ModalCargarPago({
  empleadoId,
  tipoInicial,
  onClose,
  onCreated,
}: {
  empleadoId: string;
  tipoInicial: 'SUELDO' | 'ADELANTO' | 'COMISION' | 'OTRO';
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tipoConcepto, setTipoConcepto] =
    useState<'SUELDO' | 'ADELANTO' | 'COMISION' | 'OTRO'>(tipoInicial);
  const [monto, setMonto] = useState('');
  const [cuentaId, setCuentaId] = useState('');
  const [metodo, setMetodo] = useState<
    'EFECTIVO' | 'TRANSFERENCIA' | 'DEPOSITO' | 'CHEQUE' | 'MERCADOPAGO_QR' | 'OTRO'
  >('EFECTIVO');
  const [numeroReferencia, setNumeroReferencia] = useState('');
  const [observacion, setObservacion] = useState('');
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ cuentas: Cuenta[] }>('/admin/cuentas');
        setCuentas(res.cuentas);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  async function submit() {
    setError(null);
    if (!monto || Number(monto) <= 0) return setError('Falta el monto');
    if (!cuentaId) return setError('Elegí la cuenta de origen');
    setGuardando(true);
    try {
      await api.post(`/admin/empleados/${empleadoId}/movimientos`, {
        tipoConcepto,
        monto,
        cuentaOrigenId: cuentaId,
        metodo,
        observacion: observacion || undefined,
        numeroReferencia: numeroReferencia || undefined,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar el pago');
    } finally {
      setGuardando(false);
    }
  }

  const necesitaRef = ['TRANSFERENCIA', 'CHEQUE', 'DEPOSITO'].includes(metodo);

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Cargar pago a empleado</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Concepto</label>
            <div className="grid grid-cols-2 gap-2">
              {(['SUELDO', 'ADELANTO', 'COMISION', 'OTRO'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTipoConcepto(t)}
                  className={cn(
                    'py-2 px-3 rounded-md text-sm font-medium border transition-colors',
                    tipoConcepto === t
                      ? t === 'SUELDO'
                        ? 'bg-basil-600 text-white border-basil-600'
                        : t === 'ADELANTO'
                          ? 'bg-saffron-600 text-white border-saffron-600'
                          : t === 'COMISION'
                            ? 'bg-ocean-600 text-white border-ocean-600'
                            : 'bg-ink-700 text-white border-ink-700'
                      : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
                  )}
                >
                  {t === 'SUELDO'
                    ? 'Sueldo'
                    : t === 'ADELANTO'
                      ? 'Adelanto'
                      : t === 'COMISION'
                        ? 'Comisión'
                        : 'Otro'}
                </button>
              ))}
            </div>
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">
                Cuenta de origen
              </label>
              <select
                value={cuentaId}
                onChange={(e) => setCuentaId(e.target.value)}
                className="input"
              >
                <option value="">Elegí cuenta...</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Método</label>
              <select
                value={metodo}
                onChange={(e) => setMetodo(e.target.value as typeof metodo)}
                className="input"
              >
                <option value="EFECTIVO">Efectivo</option>
                <option value="TRANSFERENCIA">Transferencia</option>
                <option value="DEPOSITO">Depósito</option>
                <option value="MERCADOPAGO_QR">MercadoPago</option>
                <option value="CHEQUE">Cheque</option>
                <option value="OTRO">Otro</option>
              </select>
            </div>
          </div>

          {necesitaRef && (
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">
                Nº de operación / referencia
              </label>
              <input
                type="text"
                value={numeroReferencia}
                onChange={(e) => setNumeroReferencia(e.target.value)}
                className="input font-mono"
                placeholder="ej. OP-12345"
              />
            </div>
          )}

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
          <Button onClick={submit} disabled={guardando}>
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
          <Button disabled={!cambia || guardando} onClick={submit}>
            {guardando ? 'Guardando...' : 'Guardar cambios'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
