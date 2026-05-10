'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface Cuenta {
  id: string;
  nombre: string;
  tipo: string;
}
interface Categoria {
  id: string;
  nombre: string;
  tipo: 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA' | 'AMBOS';
  esOperativa: boolean;
}
interface Movimiento {
  id: string;
  tipo: 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA_INTERNA' | 'AJUSTE' | 'LIQUIDACION';
  monto: string;
  fechaComputo: string;
  estado: 'PENDIENTE' | 'CONFIRMADO' | 'ANULADO';
  observacion: string | null;
  cuentaOrigen?: { nombre: string } | null;
  cuentaDestino?: { nombre: string } | null;
  categoria: { nombre: string };
  usuario: { nombre: string };
}

interface Listado {
  movimientos: Movimiento[];
  total: number;
  page: number;
  pageSize: number;
  sumas: { ingresos: string; egresos: string; neto: string };
}

const PAGE_SIZE = 50;

export default function AdminMovimientosPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cuentaIdParam = searchParams.get('cuentaId') ?? '';

  const [data, setData] = useState<Listado | null>(null);
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [tipoFiltro, setTipoFiltro] = useState<string>('');
  const [cuentaFiltro, setCuentaFiltro] = useState<string>(cuentaIdParam);
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Sincronizar filtro con URL al cambiar (back/forward o navegación lateral)
  useEffect(() => {
    setCuentaFiltro(cuentaIdParam);
    setPage(1);
  }, [cuentaIdParam]);

  const fetchMovimientos = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (tipoFiltro) params.set('tipo', tipoFiltro);
      if (cuentaFiltro) params.set('cuentaId', cuentaFiltro);
      const res = await api.get<Listado>(`/admin/movimientos?${params.toString()}`);
      setData(res);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los movimientos');
      }
    } finally {
      setLoading(false);
    }
  }, [page, tipoFiltro, cuentaFiltro]);

  // Mantener URL en sync con el filtro (para que se pueda compartir el link)
  function setCuentaFiltroSync(id: string) {
    setCuentaFiltro(id);
    setPage(1);
    const next = new URLSearchParams(searchParams.toString());
    if (id) next.set('cuentaId', id);
    else next.delete('cuentaId');
    router.replace(`/admin/movimientos${next.toString() ? `?${next.toString()}` : ''}`);
  }

  useEffect(() => {
    void fetchMovimientos();
  }, [fetchMovimientos]);

  useEffect(() => {
    (async () => {
      try {
        const [c, cat] = await Promise.all([
          api.get<{ cuentas: Cuenta[] }>('/admin/cuentas'),
          api.get<{ categorias: Categoria[] }>('/admin/categorias-movimiento'),
        ]);
        setCuentas(c.cuentas);
        setCategorias(cat.categorias);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-xl text-ink-900">Movimientos</h1>
          <p className="text-sm text-ink-500">
            {data?.total ?? 0} movimiento{(data?.total ?? 0) !== 1 && 's'}
          </p>
        </div>
        <Button onClick={() => setShowForm(true)}>+ Nuevo movimiento</Button>
      </header>

      {/* Sumas */}
      {data && (
        <section className="grid grid-cols-3 gap-4">
          <div className="card p-4">
            <div className="text-xs text-ink-500 uppercase tracking-wide">Ingresos</div>
            <MoneyAmount value={data.sumas.ingresos} className="text-lg text-basil-600" />
          </div>
          <div className="card p-4">
            <div className="text-xs text-ink-500 uppercase tracking-wide">Egresos</div>
            <MoneyAmount value={data.sumas.egresos} className="text-lg text-pomodoro-600" />
          </div>
          <div className="card p-4">
            <div className="text-xs text-ink-500 uppercase tracking-wide">Neto</div>
            <MoneyAmount
              value={data.sumas.neto}
              className={cn(
                'text-lg',
                Number(data.sumas.neto) >= 0 ? 'text-teresita-700' : 'text-pomodoro-600',
              )}
            />
          </div>
        </section>
      )}

      {/* Filtros */}
      <section className="card p-3 flex flex-wrap gap-3 items-center">
        <select
          value={tipoFiltro}
          onChange={(e) => {
            setTipoFiltro(e.target.value);
            setPage(1);
          }}
          className="input w-auto"
        >
          <option value="">Todos los tipos</option>
          <option value="INGRESO">Ingresos</option>
          <option value="EGRESO">Egresos</option>
          <option value="TRANSFERENCIA_INTERNA">Transferencias</option>
          <option value="AJUSTE">Ajustes</option>
        </select>
        <select
          value={cuentaFiltro}
          onChange={(e) => setCuentaFiltroSync(e.target.value)}
          className="input w-auto"
        >
          <option value="">Todas las cuentas</option>
          {cuentas.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>
        {cuentaFiltro && (
          <button
            onClick={() => setCuentaFiltroSync('')}
            className="text-xs text-teresita-700 hover:underline"
          >
            ✕ quitar filtro de cuenta
          </button>
        )}
      </section>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {/* Tabla */}
      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Fecha</th>
              <th className="text-left px-4 py-2">Tipo</th>
              <th className="text-left px-4 py-2">Categoría</th>
              <th className="text-left px-4 py-2">Cuenta</th>
              <th className="text-right px-4 py-2">Monto</th>
              <th className="text-left px-4 py-2">Usuario</th>
              <th className="text-center px-4 py-2">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {loading && (
              <tr>
                <td colSpan={7} className="text-center text-ink-500 py-8">
                  Cargando...
                </td>
              </tr>
            )}
            {!loading && data?.movimientos.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-ink-500 py-8">
                  Sin movimientos
                </td>
              </tr>
            )}
            {data?.movimientos.map((m) => {
              const esIngreso = m.tipo === 'INGRESO' || m.tipo === 'LIQUIDACION';
              const esEgreso = m.tipo === 'EGRESO';
              const cuenta =
                m.tipo === 'TRANSFERENCIA_INTERNA'
                  ? `${m.cuentaOrigen?.nombre ?? '—'} → ${m.cuentaDestino?.nombre ?? '—'}`
                  : m.cuentaOrigen?.nombre ?? m.cuentaDestino?.nombre ?? '—';
              return (
                <tr
                  key={m.id}
                  className={cn('hover:bg-cream-100', m.estado === 'ANULADO' && 'opacity-50')}
                >
                  <td className="px-4 py-2 font-mono text-ink-700 text-xs">
                    {new Date(m.fechaComputo).toLocaleDateString('es-AR', {
                      day: '2-digit',
                      month: '2-digit',
                    })}{' '}
                    {new Date(m.fechaComputo).toLocaleTimeString('es-AR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={cn(
                        'text-2xs font-medium px-2 py-0.5 rounded uppercase',
                        esIngreso && 'bg-basil-100 text-basil-600',
                        esEgreso && 'bg-pomodoro-100 text-pomodoro-600',
                        m.tipo === 'TRANSFERENCIA_INTERNA' && 'bg-ocean-100 text-ocean-600',
                        m.tipo === 'AJUSTE' && 'bg-saffron-100 text-saffron-600',
                      )}
                    >
                      {m.tipo.toLowerCase().replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ink-700">{m.categoria.nombre}</td>
                  <td className="px-4 py-2 text-ink-700 text-xs">{cuenta}</td>
                  <td className="px-4 py-2 text-right">
                    <MoneyAmount
                      value={m.monto}
                      className={cn(
                        esIngreso && 'text-basil-600',
                        esEgreso && 'text-pomodoro-600',
                        m.estado === 'ANULADO' && 'line-through',
                      )}
                    />
                  </td>
                  <td className="px-4 py-2 text-ink-500 text-xs">{m.usuario.nombre}</td>
                  <td className="px-4 py-2 text-center">
                    <span
                      className={cn(
                        'text-2xs font-medium uppercase tracking-wider',
                        m.estado === 'CONFIRMADO' && 'text-basil-600',
                        m.estado === 'ANULADO' && 'text-pomodoro-600',
                        m.estado === 'PENDIENTE' && 'text-saffron-600',
                      )}
                    >
                      {m.estado.toLowerCase()}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-2 text-sm">
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← Anterior
          </Button>
          <span className="text-ink-500 mx-2">
            Página {page} de {totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page === totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Siguiente →
          </Button>
        </nav>
      )}

      {showForm && (
        <FormNuevoMovimiento
          cuentas={cuentas}
          categorias={categorias}
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            void fetchMovimientos();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Form crear movimiento
// ────────────────────────────────────────────────────────────────────────

interface EmpleadoLite {
  id: string;
  nombre: string;
  apellido: string | null;
  puesto: string;
}

interface ProveedorLite {
  id: string;
  nombre: string;
  saldoAdeudado: string;
  facturasPendientes: number;
}

type MetodoPagoProveedor =
  | 'EFECTIVO'
  | 'TRANSFERENCIA'
  | 'DEPOSITO'
  | 'CHEQUE'
  | 'MERCADOPAGO_QR'
  | 'OTRO';

const METODOS_PAGO_PROVEEDOR: Array<{ value: MetodoPagoProveedor; label: string }> = [
  { value: 'TRANSFERENCIA', label: '🏦 Transferencia' },
  { value: 'EFECTIVO', label: '💵 Efectivo' },
  { value: 'DEPOSITO', label: '🏦 Depósito' },
  { value: 'CHEQUE', label: '📝 Cheque' },
  { value: 'MERCADOPAGO_QR', label: '📱 MP / QR' },
  { value: 'OTRO', label: 'Otro' },
];

const CONCEPTOS_SUELDO = [
  { value: 'JORNADA', label: 'Jornada' },
  { value: 'HORAS_EXTRA', label: 'Horas extra' },
  { value: 'AGUINALDO', label: 'Aguinaldo' },
  { value: 'VACACIONES', label: 'Vacaciones' },
  { value: 'ADELANTO', label: 'Adelanto' },
  { value: 'OTRO', label: 'Otro' },
] as const;
type ConceptoTipo = (typeof CONCEPTOS_SUELDO)[number]['value'];

interface ConceptoLinea {
  tipo: ConceptoTipo;
  monto: string;
  detalle?: string;
}

interface CuentaLinea {
  cuentaId: string;
  monto: string;
}

function FormNuevoMovimiento({
  cuentas,
  categorias,
  onClose,
  onCreated,
}: {
  cuentas: Cuenta[];
  categorias: Categoria[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tipo, setTipo] = useState<'INGRESO' | 'EGRESO' | 'TRANSFERENCIA_INTERNA'>('EGRESO');
  const [monto, setMonto] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  // Multi-cuenta para INGRESO / EGRESO. Para TRANSFERENCIA_INTERNA usamos un origen y un destino únicos.
  const [cuentasLineas, setCuentasLineas] = useState<CuentaLinea[]>([
    { cuentaId: '', monto: '' },
  ]);
  const [cuentaDestinoId, setCuentaDestinoId] = useState(''); // sólo para TRANSFERENCIA
  const [observacion, setObservacion] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Empleados (cargado on-demand cuando se elige una categoría de personal)
  const [empleados, setEmpleados] = useState<EmpleadoLite[]>([]);
  const [empleadoId, setEmpleadoId] = useState<string>('');
  const [conceptos, setConceptos] = useState<ConceptoLinea[]>([
    { tipo: 'JORNADA', monto: '' },
  ]);

  // Proveedores (cargado on-demand cuando se elige categoría "Insumos / Pago a proveedor")
  const [proveedores, setProveedores] = useState<ProveedorLite[]>([]);
  const [proveedorId, setProveedorId] = useState<string>('');
  const [metodoPago, setMetodoPago] = useState<MetodoPagoProveedor>('TRANSFERENCIA');

  // Categorías disponibles para el tipo elegido
  const categoriasFiltradas = categorias.filter((c) => {
    if (tipo === 'TRANSFERENCIA_INTERNA') return c.tipo === 'TRANSFERENCIA' || c.tipo === 'AMBOS';
    return c.tipo === tipo || c.tipo === 'AMBOS';
  });

  // ¿Es egreso a empleado? (Sueldos / Adelanto a empleado)
  const categoriaActual = categorias.find((c) => c.id === categoriaId);
  const esCategoriaSueldo =
    tipo === 'EGRESO' &&
    categoriaActual !== undefined &&
    /sueldo|adelanto a empleado/i.test(categoriaActual.nombre);

  // ¿Es egreso a proveedor? (Insumos / Pago a proveedor)
  const esCategoriaProveedor =
    tipo === 'EGRESO' &&
    categoriaActual !== undefined &&
    /insumos|proveedor/i.test(categoriaActual.nombre);

  // Proveedor seleccionado actual (para mostrar saldo y nombre en el resumen)
  const proveedorActual = proveedores.find((p) => p.id === proveedorId);

  // Cargar empleados cuando se entra a categoría de sueldo
  useEffect(() => {
    if (esCategoriaSueldo && empleados.length === 0) {
      void (async () => {
        try {
          const res = await api.get<{ empleados: EmpleadoLite[] }>('/admin/empleados');
          setEmpleados(res.empleados);
        } catch {
          /* silencioso */
        }
      })();
    }
  }, [esCategoriaSueldo, empleados.length]);

  // Cargar proveedores cuando se entra a categoría de pago a proveedor
  useEffect(() => {
    if (esCategoriaProveedor && proveedores.length === 0) {
      void (async () => {
        try {
          const res = await api.get<{ proveedores: ProveedorLite[] }>('/admin/proveedores');
          setProveedores(res.proveedores);
        } catch {
          /* silencioso */
        }
      })();
    }
  }, [esCategoriaProveedor, proveedores.length]);

  // Sumatoria de conceptos (cuando aplica) — sobrescribe el monto manual
  const sumaConceptos = conceptos.reduce((acc, c) => acc + Number(c.monto || 0), 0);
  useEffect(() => {
    if (esCategoriaSueldo && sumaConceptos > 0) {
      setMonto(sumaConceptos.toFixed(2));
    }
  }, [esCategoriaSueldo, sumaConceptos]);

  // Resetear categoría si no aplica al tipo nuevo
  useEffect(() => {
    if (categoriaId && !categoriasFiltradas.some((c) => c.id === categoriaId)) {
      setCategoriaId('');
    }
  }, [tipo, categoriaId, categoriasFiltradas]);

  function setConcepto(idx: number, patch: Partial<ConceptoLinea>) {
    setConceptos((arr) => arr.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function addConcepto() {
    setConceptos((arr) => [...arr, { tipo: 'OTRO', monto: '' }]);
  }
  function removeConcepto(idx: number) {
    setConceptos((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }

  // Helpers multi-cuenta (sólo aplica a INGRESO / EGRESO)
  const usaMulti = tipo !== 'TRANSFERENCIA_INTERNA';
  const totalAsignado = cuentasLineas.reduce((acc, c) => acc + Number(c.monto || 0), 0);
  const montoNum = Number(monto || 0);
  const faltante = montoNum - totalAsignado;
  const cuadra = Math.abs(faltante) < 0.5;

  // Auto-fill: cuando hay UNA sola cuenta destino, monto = monto total del
  // movimiento. Se distribuye manualmente solo cuando hay 2+ cuentas. Antes
  // el campo arrancaba vacío y había que retipear el total.
  useEffect(() => {
    if (usaMulti && cuentasLineas.length === 1 && montoNum > 0) {
      const totalStr = montoNum.toFixed(2);
      if (cuentasLineas[0]!.monto !== totalStr) {
        setCuentasLineas((arr) =>
          arr.map((c, i) => (i === 0 ? { ...c, monto: totalStr } : c)),
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [montoNum, cuentasLineas.length, usaMulti]);

  function setCuentaLinea(idx: number, patch: Partial<CuentaLinea>) {
    setCuentasLineas((arr) => arr.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function addCuentaLinea() {
    const restoSugerido = Math.max(0, faltante);
    setCuentasLineas((arr) => [
      ...arr,
      { cuentaId: '', monto: restoSugerido > 0 ? restoSugerido.toFixed(2) : '' },
    ]);
  }
  function removeCuentaLinea(idx: number) {
    setCuentasLineas((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }
  function autocompletarResto(idx: number) {
    const otras = cuentasLineas.reduce(
      (acc, c, i) => (i === idx ? acc : acc + Number(c.monto || 0)),
      0,
    );
    const resto = Math.max(0, montoNum - otras);
    setCuentaLinea(idx, { monto: resto.toFixed(2) });
  }

  async function submit() {
    setError(null);
    if (!monto || montoNum <= 0) return setError('Monto inválido');
    if (!categoriaId) return setError('Elegí una categoría');

    if (usaMulti) {
      if (cuentasLineas.some((c) => !c.cuentaId)) {
        return setError('Hay una línea de cuenta sin elegir');
      }
      if (cuentasLineas.some((c) => Number(c.monto || 0) <= 0)) {
        return setError('Cada cuenta tiene que tener un monto > 0');
      }
      if (!cuadra) {
        return setError(
          faltante > 0
            ? `Falta asignar $${faltante.toFixed(2)} entre cuentas`
            : `Asignaste $${(-faltante).toFixed(2)} de más`,
        );
      }
      // Cuentas distintas (no permitir misma cuenta dos veces)
      const ids = cuentasLineas.map((c) => c.cuentaId);
      if (new Set(ids).size !== ids.length) {
        return setError('No podés repetir la misma cuenta dos veces');
      }
    } else {
      // TRANSFERENCIA_INTERNA: usa la primera línea como origen + cuentaDestinoId
      const origen = cuentasLineas[0]?.cuentaId;
      if (!origen || !cuentaDestinoId)
        return setError('Elegí cuenta origen y destino');
      if (origen === cuentaDestinoId)
        return setError('Origen y destino no pueden ser la misma cuenta');
    }

    if (esCategoriaSueldo) {
      if (!empleadoId) return setError('Elegí qué empleado va a cobrar');
      if (conceptos.some((c) => Number(c.monto) <= 0))
        return setError('Cada concepto tiene que tener monto > 0');
    }

    if (esCategoriaProveedor) {
      if (!proveedorId) return setError('Elegí el proveedor a quién se le paga');
      if (cuentasLineas.length !== 1 || !cuentasLineas[0]?.cuentaId) {
        return setError('Para pago a proveedor elegí una sola cuenta de origen');
      }
    }

    setGuardando(true);
    try {
      // Caso especial: pago a proveedor con FIFO automático sobre facturas pendientes.
      // Solo soportamos 1 cuenta para este flujo (el caso multi-cuenta se hace por
      // el wizard de "pagos-multicuenta" en la sección de Insumos/Proveedores).
      if (esCategoriaProveedor && proveedorId) {
        await api.post('/admin/egreso-a-proveedor', {
          proveedorId,
          monto,
          cuentaId: cuentasLineas[0]!.cuentaId,
          metodo: metodoPago,
          observaciones: observacion || undefined,
        });
        onCreated();
        return;
      }

      if (!usaMulti) {
        // TRANSFERENCIA_INTERNA simple
        await api.post('/admin/movimientos', {
          tipo,
          monto,
          categoriaId,
          cuentaOrigenId: cuentasLineas[0]!.cuentaId,
          cuentaDestinoId,
          observacion: observacion || undefined,
        });
      } else if (cuentasLineas.length === 1) {
        // Una sola cuenta — flujo normal
        const linea = cuentasLineas[0]!;
        await api.post('/admin/movimientos', {
          tipo,
          monto,
          categoriaId,
          cuentaOrigenId: tipo === 'EGRESO' ? linea.cuentaId : undefined,
          cuentaDestinoId: tipo === 'INGRESO' ? linea.cuentaId : undefined,
          observacion: observacion || undefined,
          ...(esCategoriaSueldo && {
            entidadId: empleadoId,
            conceptos: conceptos.map((c) => ({
              tipo: c.tipo,
              monto: c.monto,
              detalle: c.detalle || undefined,
            })),
          }),
        });
      } else {
        // Multi-cuenta: creamos N movimientos enlazados con tag (1/3, 2/3...)
        const total = cuentasLineas.length;
        const obs = observacion || `${tipo === 'EGRESO' ? 'Egreso' : 'Ingreso'} multi-cuenta`;
        for (let i = 0; i < cuentasLineas.length; i++) {
          const linea = cuentasLineas[i]!;
          await api.post('/admin/movimientos', {
            tipo,
            monto: linea.monto,
            categoriaId,
            cuentaOrigenId: tipo === 'EGRESO' ? linea.cuentaId : undefined,
            cuentaDestinoId: tipo === 'INGRESO' ? linea.cuentaId : undefined,
            observacion: `${obs} (parte ${i + 1}/${total})`,
            ...(esCategoriaSueldo &&
              i === 0 && {
                entidadId: empleadoId,
                conceptos: conceptos.map((c) => ({
                  tipo: c.tipo,
                  monto: c.monto,
                  detalle: c.detalle || undefined,
                })),
              }),
            ...(esCategoriaSueldo && i > 0 && { entidadId: empleadoId }),
          });
        }
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear el movimiento');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-lg shadow-modal max-h-[90vh] flex flex-col">
        <header className="px-5 py-4 border-b border-cream-300 flex justify-between items-center">
          <h2 className="font-display text-lg text-teresita-700">Nuevo movimiento</h2>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900 text-xl leading-none">
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Tipo */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-2">Tipo</label>
            <div className="grid grid-cols-3 gap-2">
              {(['INGRESO', 'EGRESO', 'TRANSFERENCIA_INTERNA'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTipo(t)}
                  className={cn(
                    'py-2 px-3 rounded-md text-sm font-medium border transition-colors',
                    tipo === t
                      ? t === 'INGRESO'
                        ? 'bg-basil-600 text-white border-basil-600'
                        : t === 'EGRESO'
                          ? 'bg-pomodoro-600 text-white border-pomodoro-600'
                          : 'bg-ocean-600 text-white border-ocean-600'
                      : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
                  )}
                >
                  {t === 'TRANSFERENCIA_INTERNA' ? 'Transferencia' : t.toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Monto */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">Monto</label>
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

          {/* Categoría */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">Categoría</label>
            <select
              value={categoriaId}
              onChange={(e) => setCategoriaId(e.target.value)}
              className="input"
            >
              <option value="">Elegí categoría...</option>
              {categoriasFiltradas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                  {!c.esOperativa && ' · no operativa'}
                </option>
              ))}
            </select>
          </div>

          {/* Sub-form para Insumos / Pago a proveedor */}
          {esCategoriaProveedor && (
            <div className="rounded-md border border-saffron-600/40 bg-saffron-100/40 p-3 space-y-3">
              <div className="text-2xs uppercase tracking-wider text-saffron-600 font-semibold">
                Pago a proveedor · alocación automática
              </div>
              <div>
                <label className="block text-2xs font-medium text-ink-700 mb-1">Proveedor</label>
                <select
                  value={proveedorId}
                  onChange={(e) => setProveedorId(e.target.value)}
                  className="input text-sm"
                >
                  <option value="">Elegí proveedor...</option>
                  {proveedores
                    .slice()
                    .sort((a, b) => Number(b.saldoAdeudado) - Number(a.saldoAdeudado))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre}
                        {Number(p.saldoAdeudado) > 0
                          ? ` · debe $${Number(p.saldoAdeudado).toLocaleString('es-AR', { minimumFractionDigits: 2 })} (${p.facturasPendientes} fact.)`
                          : ' · sin deuda'}
                      </option>
                    ))}
                </select>
              </div>

              {proveedorActual && (
                <div className="bg-white rounded-md p-2.5 border border-cream-300 text-xs space-y-1">
                  <div className="flex justify-between items-baseline">
                    <span className="text-ink-500">Saldo pendiente:</span>
                    <span
                      className={cn(
                        'font-mono font-semibold tabular-nums',
                        Number(proveedorActual.saldoAdeudado) > 0
                          ? 'text-pomodoro-600'
                          : 'text-basil-600',
                      )}
                    >
                      <MoneyAmount value={proveedorActual.saldoAdeudado} />
                    </span>
                  </div>
                  {Number(monto || 0) > 0 && (
                    <>
                      <div className="flex justify-between items-baseline">
                        <span className="text-ink-500">Pago a aplicar:</span>
                        <span className="font-mono tabular-nums">
                          <MoneyAmount value={Number(monto).toFixed(2)} />
                        </span>
                      </div>
                      <hr className="border-cream-200 my-1" />
                      <div className="flex justify-between items-baseline">
                        <span className="text-ink-700 font-medium">Saldo nuevo:</span>
                        {(() => {
                          const nuevo = Math.max(
                            0,
                            Number(proveedorActual.saldoAdeudado) - Number(monto || 0),
                          );
                          const exceso =
                            Number(monto || 0) - Number(proveedorActual.saldoAdeudado);
                          return (
                            <div className="text-right">
                              <span className="font-mono font-semibold tabular-nums text-basil-600">
                                <MoneyAmount value={nuevo.toFixed(2)} />
                              </span>
                              {exceso > 0.01 && (
                                <div className="text-2xs text-saffron-600">
                                  Excedente $
                                  {exceso.toLocaleString('es-AR', { minimumFractionDigits: 2 })}{' '}
                                  · queda como saldo a favor
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                      <p className="text-2xs text-ink-400 mt-1.5">
                        Se aplica FIFO sobre {proveedorActual.facturasPendientes}{' '}
                        factura{proveedorActual.facturasPendientes !== 1 ? 's' : ''} pendiente
                        {proveedorActual.facturasPendientes !== 1 ? 's' : ''} (la más vieja
                        primero).
                      </p>
                    </>
                  )}
                </div>
              )}

              <div>
                <label className="block text-2xs font-medium text-ink-700 mb-1">Método de pago</label>
                <select
                  value={metodoPago}
                  onChange={(e) => setMetodoPago(e.target.value as MetodoPagoProveedor)}
                  className="input text-sm"
                >
                  {METODOS_PAGO_PROVEEDOR.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Sub-form para Sueldos / Adelanto a empleado */}
          {esCategoriaSueldo && (
            <div className="rounded-md border border-pomodoro-100 bg-pomodoro-50/40 p-3 space-y-3">
              <div className="text-2xs uppercase tracking-wider text-pomodoro-600 font-semibold">
                Pago a empleado · desglose por concepto
              </div>
              <div>
                <label className="block text-2xs font-medium text-ink-700 mb-1">Empleado</label>
                <select
                  value={empleadoId}
                  onChange={(e) => setEmpleadoId(e.target.value)}
                  className="input text-sm"
                >
                  <option value="">Elegí empleado...</option>
                  {empleados.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.nombre} {e.apellido ?? ''} · {e.puesto.toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-2xs font-medium text-ink-700 mb-1">
                  Conceptos (la suma se aplica como monto total)
                </label>
                <div className="space-y-2">
                  {conceptos.map((c, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={c.tipo}
                        onChange={(e) =>
                          setConcepto(idx, { tipo: e.target.value as ConceptoTipo })
                        }
                        className="input text-xs py-1.5 flex-1"
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
                        className="input text-xs py-1.5 font-mono w-32 text-right"
                      />
                      <button
                        type="button"
                        onClick={() => removeConcepto(idx)}
                        disabled={conceptos.length === 1}
                        className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded text-xs disabled:opacity-30"
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
                  <div className="mt-2 text-xs text-ink-700">
                    Total a pagar:{' '}
                    <span className="font-mono font-semibold text-pomodoro-600">
                      {new Intl.NumberFormat('es-AR', {
                        style: 'currency',
                        currency: 'ARS',
                      }).format(sumaConceptos)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Cuentas: para INGRESO/EGRESO permitimos múltiples cuentas (split).
              Para TRANSFERENCIA_INTERNA: 1 origen + 1 destino. */}
          {usaMulti ? (
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1">
                {tipo === 'EGRESO' ? 'Sale de' : 'Entra a'}
                <span className="text-2xs text-ink-500 font-normal ml-1">
                  (podés repartir en varias cuentas)
                </span>
              </label>
              <div className="space-y-2">
                {cuentasLineas.map((linea, idx) => (
                  <div key={idx} className="flex gap-2 items-start">
                    <select
                      value={linea.cuentaId}
                      onChange={(e) => setCuentaLinea(idx, { cuentaId: e.target.value })}
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
                      onChange={(e) => setCuentaLinea(idx, { monto: e.target.value })}
                      placeholder="0.00"
                      className="input text-sm font-mono w-32 text-right"
                    />
                    {cuentasLineas.length > 1 && Math.abs(faltante) > 0.5 && (
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
                      onClick={() => removeCuentaLinea(idx)}
                      disabled={cuentasLineas.length === 1}
                      className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={addCuentaLinea}
                className="mt-2 text-xs text-teresita-700 hover:underline"
              >
                + Agregar otra cuenta
              </button>

              {/* Resumen Asignado / Faltante / Sobra */}
              {montoNum > 0 && cuentasLineas.length > 0 && (
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
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1">Sale de</label>
                <select
                  value={cuentasLineas[0]?.cuentaId ?? ''}
                  onChange={(e) => setCuentaLinea(0, { cuentaId: e.target.value, monto: monto })}
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
                <label className="block text-sm font-medium text-ink-700 mb-1">Entra a</label>
                <select
                  value={cuentaDestinoId}
                  onChange={(e) => setCuentaDestinoId(e.target.value)}
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
            </>
          )}

          {/* Observación */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Observación (opcional)
            </label>
            <input
              type="text"
              value={observacion}
              onChange={(e) => setObservacion(e.target.value)}
              className="input"
              placeholder="ej. número de operación, persona, contexto..."
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
          <Button onClick={() => void submit()} disabled={guardando}>
            {guardando ? 'Guardando...' : 'Crear movimiento'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
