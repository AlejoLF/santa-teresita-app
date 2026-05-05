'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface Empleado {
  id: string;
  nombre: string;
  apellido: string | null;
  puesto: 'CAJERO' | 'COCINERO' | 'ENCARGADO' | 'MOTOQUERO' | 'ADMINISTRATIVO' | 'OTRO';
  telefono: string | null;
  formaPago: string | null;
  sueldoBase: string | null;
  activo: boolean;
  sueldosPagadosMes: string;
  adelantosMes: string;
  comisionesMes: string;
  saldoSueldoMes: string;
}

const PUESTO_LABEL: Record<Empleado['puesto'], string> = {
  CAJERO: 'Cajero',
  COCINERO: 'Cocinero',
  ENCARGADO: 'Encargado',
  MOTOQUERO: 'Motoquero',
  ADMINISTRATIVO: 'Administrativo',
  OTRO: 'Otro',
};

export default function EmpleadosListPage() {
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [search, setSearch] = useState('');
  const [incluirInactivos, setIncluirInactivos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  // Modal de pago de sueldo. Si se abre desde una fila, viene con empleadoId pre-seleccionado.
  const [pagarSueldo, setPagarSueldo] = useState<{ empleadoId: string | null } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ incluirInactivos: String(incluirInactivos) });
      if (search.trim()) params.set('q', search.trim());
      const res = await api.get<{ empleados: Empleado[] }>(
        `/admin/empleados?${params.toString()}`,
      );
      setEmpleados(res.empleados);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los empleados');
      }
    } finally {
      setLoading(false);
    }
  }, [search, incluirInactivos]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const totalPagadoMes = empleados.reduce(
    (acc, e) =>
      acc +
      Number(e.sueldosPagadosMes) +
      Number(e.adelantosMes) +
      Number(e.comisionesMes),
    0,
  );

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-xl text-ink-900">Empleados</h1>
          <p className="text-sm text-ink-500">
            {empleados.length} empleado{empleados.length !== 1 && 's'} ·{' '}
            <MoneyAmount value={totalPagadoMes.toFixed(2)} /> pagado este mes
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => setPagarSueldo({ empleadoId: null })}
          >
            💵 Pagar sueldo
          </Button>
          <Button onClick={() => setShowForm(true)}>+ Nuevo empleado</Button>
        </div>
      </header>

      <section className="card p-3 flex items-center gap-3">
        <input
          type="search"
          placeholder="🔍 Buscar empleado..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input flex-1"
        />
        <label className="flex items-center gap-2 text-sm text-ink-700 cursor-pointer">
          <input
            type="checkbox"
            checked={incluirInactivos}
            onChange={(e) => setIncluirInactivos(e.target.checked)}
            className="w-4 h-4"
          />
          Mostrar inactivos
        </label>
      </section>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Empleado</th>
              <th className="text-left px-4 py-2">Puesto</th>
              <th className="text-left px-4 py-2">Forma de pago</th>
              <th className="text-right px-4 py-2">Sueldo base</th>
              <th className="text-right px-4 py-2">Pagado este mes</th>
              <th className="text-right px-4 py-2">Adelantos</th>
              <th className="text-right px-4 py-2">Saldo a pagar</th>
              <th className="px-4 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {loading && (
              <tr>
                <td colSpan={8} className="text-center text-ink-500 py-8">
                  Cargando...
                </td>
              </tr>
            )}
            {!loading && empleados.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-ink-500 py-8">
                  Sin empleados
                </td>
              </tr>
            )}
            {empleados.map((e) => {
              const pagado =
                Number(e.sueldosPagadosMes) + Number(e.adelantosMes) + Number(e.comisionesMes);
              return (
                <tr
                  key={e.id}
                  className={cn(
                    'hover:bg-cream-100 transition-colors',
                    !e.activo && 'opacity-50',
                  )}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/empleados/${e.id}`}
                      className="font-medium text-ink-900 hover:text-teresita-700"
                    >
                      {e.nombre}
                      {e.apellido && ` ${e.apellido}`}
                    </Link>
                    {e.telefono && (
                      <div className="text-2xs font-mono text-ink-500">{e.telefono}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-2xs font-medium px-2 py-0.5 rounded bg-cream-200 text-ink-700">
                      {PUESTO_LABEL[e.puesto]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink-500 text-xs">{e.formaPago ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    {e.sueldoBase ? (
                      <MoneyAmount value={e.sueldoBase} />
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {pagado > 0 ? (
                      <MoneyAmount value={pagado.toFixed(2)} className="text-basil-600" />
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {Number(e.adelantosMes) > 0 ? (
                      <MoneyAmount value={e.adelantosMes} className="text-saffron-600" />
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {Number(e.saldoSueldoMes) > 0 ? (
                      <MoneyAmount
                        value={e.saldoSueldoMes}
                        className="text-pomodoro-600 font-medium"
                      />
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => setPagarSueldo({ empleadoId: e.id })}
                      className="text-2xs text-teresita-700 hover:underline mr-2"
                      title="Pagar a este empleado"
                    >
                      💵 pagar
                    </button>
                    <Link
                      href={`/admin/empleados/${e.id}`}
                      className="text-2xs text-ink-500 hover:text-teresita-700"
                    >
                      ver →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {showForm && (
        <FormNuevoEmpleado
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            void fetchData();
          }}
        />
      )}

      {pagarSueldo && (
        <PagarSueldoModal
          empleadoIdPreseleccionado={pagarSueldo.empleadoId}
          empleados={empleados}
          onClose={() => setPagarSueldo(null)}
          onPagado={() => {
            setPagarSueldo(null);
            void fetchData();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Form crear empleado
// ────────────────────────────────────────────────────────────────────────

function FormNuevoEmpleado({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [puesto, setPuesto] = useState<Empleado['puesto']>('CAJERO');
  const [sueldoBase, setSueldoBase] = useState('');
  const [formaPago, setFormaPago] = useState('mensual');
  const [telefono, setTelefono] = useState('');
  const [dni, setDni] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!nombre.trim()) return setError('Falta el nombre');
    setCreando(true);
    try {
      await api.post('/admin/empleados', {
        nombre: nombre.trim(),
        apellido: apellido || undefined,
        puesto,
        sueldoBase: sueldoBase || undefined,
        formaPago: formaPago || undefined,
        telefono: telefono || undefined,
        dni: dni || undefined,
        observaciones: observaciones || undefined,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear empleado');
    } finally {
      setCreando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Nuevo empleado</h2>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Nombre</label>
              <input
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="input"
                autoFocus
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
                onChange={(e) => setPuesto(e.target.value as Empleado['puesto'])}
                className="input"
              >
                {(Object.keys(PUESTO_LABEL) as Array<keyof typeof PUESTO_LABEL>).map((k) => (
                  <option key={k} value={k}>
                    {PUESTO_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Forma de pago</label>
              <select
                value={formaPago}
                onChange={(e) => setFormaPago(e.target.value)}
                className="input"
              >
                <option value="mensual">Mensual</option>
                <option value="quincenal">Quincenal</option>
                <option value="jornal">Jornal</option>
                <option value="comisión">Comisión</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">
                Sueldo base (opcional)
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
              <label className="block text-xs font-medium text-ink-700 mb-1">DNI (opcional)</label>
              <input
                type="text"
                value={dni}
                onChange={(e) => setDni(e.target.value)}
                className="input font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Teléfono (opcional)
            </label>
            <input
              type="text"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Observaciones (opcional)
            </label>
            <input
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              className="input"
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
          <Button onClick={submit} disabled={creando}>
            {creando ? 'Creando...' : 'Crear empleado'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal: Pagar sueldo (con desglose por concepto)
// ────────────────────────────────────────────────────────────────────────

interface CuentaShort {
  id: string;
  nombre: string;
  tipo: string;
}
interface CategoriaMov {
  id: string;
  nombre: string;
  tipo: 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA' | 'AMBOS';
}

const CONCEPTOS_SUELDO = [
  { value: 'JORNADA', label: 'Jornada' },
  { value: 'HORAS_EXTRA', label: 'Horas extra' },
  { value: 'AGUINALDO', label: 'Aguinaldo' },
  { value: 'VACACIONES', label: 'Vacaciones' },
  { value: 'ADELANTO', label: 'Adelanto' },
  { value: 'OTRO', label: 'Otro' },
] as const;
type ConceptoTipo = (typeof CONCEPTOS_SUELDO)[number]['value'];
interface Concepto {
  tipo: ConceptoTipo;
  monto: string;
  detalle?: string;
}

function PagarSueldoModal({
  empleadoIdPreseleccionado,
  empleados,
  onClose,
  onPagado,
}: {
  empleadoIdPreseleccionado: string | null;
  empleados: Empleado[];
  onClose: () => void;
  onPagado: () => void;
}) {
  const [empleadoId, setEmpleadoId] = useState<string>(empleadoIdPreseleccionado ?? '');
  const [conceptos, setConceptos] = useState<Concepto[]>([
    { tipo: 'JORNADA', monto: '' },
  ]);
  const [cuentaOrigenId, setCuentaOrigenId] = useState('');
  const [observacion, setObservacion] = useState('');
  const [cuentas, setCuentas] = useState<CuentaShort[]>([]);
  const [categorias, setCategorias] = useState<CategoriaMov[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [c, cat] = await Promise.all([
          api.get<{ cuentas: CuentaShort[] }>('/admin/cuentas'),
          api.get<{ categorias: CategoriaMov[] }>('/admin/categorias-movimiento'),
        ]);
        setCuentas(c.cuentas);
        setCategorias(cat.categorias);
        // Sugerir Caja física por default
        const caja = c.cuentas.find((x) => x.tipo === 'EFECTIVO');
        if (caja) setCuentaOrigenId(caja.id);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  const empleado = empleados.find((e) => e.id === empleadoId);
  const sumaConceptos = conceptos.reduce((acc, c) => acc + Number(c.monto || 0), 0);

  // Categoría: si hay solo Adelantos → "Adelanto a empleado"; sino "Sueldos"
  const soloAdelantos =
    conceptos.length > 0 && conceptos.every((c) => c.tipo === 'ADELANTO');
  const categoriaSueldos = categorias.find((c) => /sueldo/i.test(c.nombre));
  const categoriaAdelanto = categorias.find((c) => /adelanto a empleado/i.test(c.nombre));
  const categoriaId = soloAdelantos
    ? categoriaAdelanto?.id ?? categoriaSueldos?.id
    : categoriaSueldos?.id;

  function setConcepto(idx: number, patch: Partial<Concepto>) {
    setConceptos((arr) => arr.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function addConcepto() {
    setConceptos((arr) => [...arr, { tipo: 'OTRO', monto: '' }]);
  }
  function removeConcepto(idx: number) {
    setConceptos((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }

  async function submit() {
    setError(null);
    if (!empleadoId) return setError('Elegí un empleado');
    if (!cuentaOrigenId) return setError('Elegí cuenta de origen');
    if (!categoriaId)
      return setError('No se encontró la categoría de Sueldos en el sistema');
    if (sumaConceptos <= 0) return setError('Ingresá al menos un concepto con monto');
    if (conceptos.some((c) => Number(c.monto || 0) <= 0))
      return setError('Cada concepto tiene que tener monto > 0');

    setEnviando(true);
    try {
      await api.post('/admin/movimientos', {
        tipo: 'EGRESO',
        monto: sumaConceptos.toFixed(2),
        categoriaId,
        cuentaOrigenId,
        entidadId: empleadoId,
        observacion: observacion || undefined,
        conceptos: conceptos.map((c) => ({
          tipo: c.tipo,
          monto: c.monto,
          detalle: c.detalle || undefined,
        })),
      });
      onPagado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al registrar el pago');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-ink-900/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-cream-50 rounded-lg shadow-modal w-full max-w-lg max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-cream-300 flex items-center justify-between">
          <div>
            <h2 className="font-display text-md text-teresita-700">💵 Pagar sueldo</h2>
            <p className="text-2xs text-ink-500">
              Registra un egreso a un empleado con desglose por concepto.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-ink-900 text-xl leading-none"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Empleado */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">Empleado</label>
            <select
              value={empleadoId}
              onChange={(e) => setEmpleadoId(e.target.value)}
              className="input"
              autoFocus
            >
              <option value="">Elegí empleado...</option>
              {empleados
                .filter((e) => e.activo)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.nombre} {e.apellido ?? ''} · {PUESTO_LABEL[e.puesto].toLowerCase()}
                  </option>
                ))}
            </select>
            {empleado && Number(empleado.saldoSueldoMes) > 0 && (
              <div className="text-2xs text-pomodoro-600 mt-1">
                Saldo a pagar mes:{' '}
                <MoneyAmount value={empleado.saldoSueldoMes} className="font-mono" />
              </div>
            )}
          </div>

          {/* Conceptos */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Conceptos a pagar
            </label>
            <div className="space-y-2">
              {conceptos.map((c, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={c.tipo}
                    onChange={(e) =>
                      setConcepto(idx, { tipo: e.target.value as ConceptoTipo })
                    }
                    className="input text-sm py-1.5 flex-1"
                  >
                    {CONCEPTOS_SUELDO.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    value={c.monto}
                    onChange={(e) => setConcepto(idx, { monto: e.target.value })}
                    placeholder="0.00"
                    className="input text-sm py-1.5 font-mono w-32 text-right"
                  />
                  <button
                    onClick={() => removeConcepto(idx)}
                    disabled={conceptos.length === 1}
                    className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded text-sm disabled:opacity-30"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {conceptos.some((c) => c.tipo === 'OTRO') && (
                <input
                  type="text"
                  value={conceptos.find((c) => c.tipo === 'OTRO')?.detalle ?? ''}
                  onChange={(e) => {
                    const idx = conceptos.findIndex((c) => c.tipo === 'OTRO');
                    if (idx >= 0) setConcepto(idx, { detalle: e.target.value });
                  }}
                  placeholder="Detalle del concepto 'Otro' (opcional)"
                  className="input text-xs py-1.5"
                />
              )}
            </div>
            <button
              type="button"
              onClick={addConcepto}
              className="mt-2 text-xs text-teresita-700 hover:underline"
            >
              + Agregar otro concepto
            </button>
            {sumaConceptos > 0 && (
              <div className="mt-3 bg-cream-100 rounded-md px-3 py-2 flex items-baseline justify-between">
                <span className="text-sm text-ink-700">Total a pagar:</span>
                <MoneyAmount
                  value={sumaConceptos.toFixed(2)}
                  className="font-mono text-md font-semibold text-pomodoro-600"
                />
              </div>
            )}
          </div>

          {/* Cuenta de origen */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Sale de la cuenta
            </label>
            <select
              value={cuentaOrigenId}
              onChange={(e) => setCuentaOrigenId(e.target.value)}
              className="input"
            >
              <option value="">Elegí cuenta...</option>
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre} ({c.tipo.toLowerCase()})
                </option>
              ))}
            </select>
          </div>

          {/* Observación */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Observación (opcional)
            </label>
            <input
              type="text"
              value={observacion}
              onChange={(e) => setObservacion(e.target.value)}
              placeholder="ej. quincena terminada el viernes, transferencia bancaria..."
              className="input"
            />
          </div>

          {error && (
            <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-cream-300 bg-surface-sunken flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={enviando || sumaConceptos <= 0}>
            {enviando ? 'Registrando...' : '✓ Registrar pago'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
