'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface Cliente {
  id: string;
  tipo: 'CASUAL' | 'REGISTRADO' | 'CORPORATIVO' | 'PLATAFORMA';
  nombre: string;
  apellido: string | null;
  telefono: string | null;
  email: string | null;
  cuitCuil: string | null;
  fechaNacimiento: string | null;
  observaciones: string | null;
  activo: boolean;
}

interface Direccion {
  id: string;
  etiqueta: string;
  calle: string;
  numero: string;
  piso: string | null;
  depto: string | null;
  entreCalles: string | null;
  localidad: string;
  codigoPostal: string | null;
  indicaciones: string | null;
  esDefault: boolean;
}

interface VentaResumen {
  id: string;
  numero: number;
  numeroOrdenTurno: number;
  canal: string;
  modalidad: string;
  estado: 'PROCESADA' | 'FINALIZADA' | 'ANULADA';
  total: string;
  fechaApertura: string;
  fechaFinalizacion: string | null;
}

interface Detalle {
  cliente: Cliente & { direcciones: Direccion[] };
  ventas: VentaResumen[];
  stats: {
    totalComprado: string;
    ventasFinalizadas: number;
    ticketPromedio: string;
    ultimaVenta: string | null;
  };
}

const TIPO_LABEL: Record<Cliente['tipo'], { label: string; cls: string }> = {
  CASUAL: { label: 'Casual', cls: 'bg-cream-200 text-ink-500' },
  REGISTRADO: { label: 'Registrado', cls: 'bg-teresita-50 text-teresita-700' },
  CORPORATIVO: { label: 'Corporativo', cls: 'bg-ocean-100 text-ocean-600' },
  PLATAFORMA: { label: 'Plataforma', cls: 'bg-saffron-100 text-saffron-600' },
};

export default function ClienteDetallePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<Detalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEditar, setShowEditar] = useState(false);
  const [showAgregarDir, setShowAgregarDir] = useState(false);
  const [editandoDir, setEditandoDir] = useState<Direccion | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get<Detalle>(`/admin/clientes/${id}`);
      setData(res);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudo cargar el cliente');
      }
    }
  }, [id]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (error) return <div className="text-pomodoro-600 p-6">{error}</div>;
  if (!data) return <div className="text-ink-500 p-6">Cargando...</div>;

  const c = data.cliente;
  const tipoStyle = TIPO_LABEL[c.tipo];

  async function eliminarDireccion(d: Direccion) {
    if (!confirm(`¿Eliminar la dirección "${d.etiqueta}"?`)) return;
    try {
      await api.delete(`/admin/clientes/${id}/direcciones/${d.id}`);
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo eliminar');
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header>
        <Link href="/admin/clientes" className="text-sm text-ink-500 hover:underline">
          ← Volver a clientes
        </Link>
        <div className="flex items-baseline justify-between mt-1">
          <div>
            <h1 className="font-display text-xl text-ink-900">
              {c.nombre} {c.apellido ?? ''}
            </h1>
            <div className="flex items-center gap-3 mt-1 text-sm">
              <span
                className={cn(
                  'text-2xs font-medium px-2 py-0.5 rounded uppercase',
                  tipoStyle.cls,
                )}
              >
                {tipoStyle.label}
              </span>
              {c.telefono && <span className="text-ink-700">📞 {c.telefono}</span>}
              {c.email && <span className="text-ink-500">{c.email}</span>}
              {c.cuitCuil && <span className="text-ink-500 font-mono">CUIT {c.cuitCuil}</span>}
              {!c.activo && (
                <span className="text-2xs text-pomodoro-600 font-medium">INACTIVO</span>
              )}
            </div>
          </div>
          <Button variant="secondary" onClick={() => setShowEditar(true)}>
            Editar datos
          </Button>
        </div>
      </header>

      {/* Stats */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Total comprado</div>
          <MoneyAmount value={data.stats.totalComprado} hero className="text-md text-teresita-700" />
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Ventas finalizadas</div>
          <span className="hero-number text-md text-ink-900">{data.stats.ventasFinalizadas}</span>
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Ticket promedio</div>
          <MoneyAmount value={data.stats.ticketPromedio} hero className="text-md text-ink-900" />
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Última venta</div>
          <span className="text-sm text-ink-900 font-mono">
            {data.stats.ultimaVenta
              ? new Date(data.stats.ultimaVenta).toLocaleDateString('es-AR')
              : '—'}
          </span>
        </div>
      </section>

      {/* Direcciones */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken flex items-center justify-between">
          <h2 className="font-display text-md text-ink-900">
            Direcciones ({c.direcciones.length})
          </h2>
          <Button size="sm" onClick={() => setShowAgregarDir(true)}>
            + Nueva dirección
          </Button>
        </header>
        {c.direcciones.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-500">
            Sin direcciones. Agregá una para usar en deliveries.
          </div>
        ) : (
          <div className="divide-y divide-cream-200">
            {c.direcciones.map((d) => (
              <div key={d.id} className="px-4 py-3 flex justify-between gap-3">
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-ink-900">{d.etiqueta}</span>
                    {d.esDefault && (
                      <span className="text-2xs text-basil-600 font-medium uppercase">
                        ★ default
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-ink-700">
                    {d.calle} {d.numero}
                    {d.piso && `, piso ${d.piso}`}
                    {d.depto && `, depto ${d.depto}`}
                    {' · '}
                    {d.localidad}
                    {d.codigoPostal && ` (${d.codigoPostal})`}
                  </div>
                  {d.entreCalles && (
                    <div className="text-2xs text-ink-500">entre {d.entreCalles}</div>
                  )}
                  {d.indicaciones && (
                    <div className="text-xs italic text-saffron-600 mt-1">
                      ⚠ {d.indicaciones}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 text-xs">
                  <button
                    onClick={() => setEditandoDir(d)}
                    className="text-teresita-700 hover:underline"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => eliminarDireccion(d)}
                    className="text-pomodoro-600 hover:underline"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Historial de ventas */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
          <h2 className="font-display text-md text-ink-900">
            Historial de ventas ({data.ventas.length})
          </h2>
        </header>
        {data.ventas.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-500">
            Sin ventas registradas todavía.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-4 py-2">Fecha</th>
                <th className="text-left px-4 py-2">Pedido</th>
                <th className="text-left px-4 py-2">Canal</th>
                <th className="text-left px-4 py-2">Modalidad</th>
                <th className="text-right px-4 py-2">Total</th>
                <th className="text-center px-4 py-2">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.ventas.map((v) => (
                <tr
                  key={v.id}
                  className={cn(v.estado === 'ANULADA' && 'opacity-50')}
                >
                  <td className="px-4 py-2 font-mono text-xs text-ink-700">
                    {new Date(v.fechaApertura).toLocaleDateString('es-AR', {
                      day: '2-digit',
                      month: '2-digit',
                      year: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-2 font-mono">
                    <Link
                      href={`/venta/${v.id}`}
                      className="text-teresita-700 hover:underline"
                    >
                      #{String(v.numeroOrdenTurno).padStart(3, '0')}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-ink-700 text-xs">
                    {v.canal.replace('_', ' ')}
                  </td>
                  <td className="px-4 py-2 text-ink-500 text-xs">
                    {v.modalidad.replace('_', ' ').toLowerCase()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <MoneyAmount value={v.total} />
                  </td>
                  <td className="px-4 py-2 text-center text-2xs uppercase">
                    {v.estado === 'PROCESADA' && (
                      <span className="text-saffron-600">abierto</span>
                    )}
                    {v.estado === 'FINALIZADA' && <span className="text-basil-600">cerrado</span>}
                    {v.estado === 'ANULADA' && (
                      <span className="text-pomodoro-600">anulado</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {c.observaciones && (
        <section className="card p-4">
          <h3 className="text-2xs font-medium uppercase text-ink-500 mb-1">Observaciones</h3>
          <p className="text-sm text-ink-700 italic">{c.observaciones}</p>
        </section>
      )}

      {showEditar && (
        <ModalEditarCliente
          cliente={c}
          onClose={() => setShowEditar(false)}
          onSaved={() => {
            setShowEditar(false);
            void fetchData();
          }}
        />
      )}
      {showAgregarDir && (
        <ModalDireccion
          clienteId={id}
          onClose={() => setShowAgregarDir(false)}
          onSaved={() => {
            setShowAgregarDir(false);
            void fetchData();
          }}
        />
      )}
      {editandoDir && (
        <ModalDireccion
          clienteId={id}
          direccion={editandoDir}
          onClose={() => setEditandoDir(null)}
          onSaved={() => {
            setEditandoDir(null);
            void fetchData();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal editar cliente
// ────────────────────────────────────────────────────────────────────────

function ModalEditarCliente({
  cliente,
  onClose,
  onSaved,
}: {
  cliente: Cliente;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tipo, setTipo] = useState(cliente.tipo);
  const [nombre, setNombre] = useState(cliente.nombre);
  const [apellido, setApellido] = useState(cliente.apellido ?? '');
  const [telefono, setTelefono] = useState(cliente.telefono ?? '');
  const [email, setEmail] = useState(cliente.email ?? '');
  const [cuit, setCuit] = useState(cliente.cuitCuil ?? '');
  const [observaciones, setObservaciones] = useState(cliente.observaciones ?? '');
  const [activo, setActivo] = useState(cliente.activo);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!nombre.trim()) return setError('Falta el nombre');
    setGuardando(true);
    try {
      await api.patch(`/admin/clientes/${cliente.id}`, {
        tipo,
        nombre,
        apellido: apellido || null,
        telefono: telefono || null,
        email: email || null,
        cuitCuil: cuit || null,
        observaciones: observaciones || null,
        activo,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Editar cliente</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Tipo</label>
            <select
              value={tipo}
              onChange={(e) => setTipo(e.target.value as Cliente['tipo'])}
              className="input"
            >
              <option value="REGISTRADO">Registrado</option>
              <option value="CORPORATIVO">Corporativo / Mayorista</option>
              <option value="CASUAL">Casual</option>
              <option value="PLATAFORMA">Plataforma</option>
            </select>
          </div>
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
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Teléfono</label>
            <input
              type="tel"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              className="input font-mono"
            />
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
            <label className="block text-xs font-medium text-ink-700 mb-1">CUIT/CUIL</label>
            <input
              type="text"
              value={cuit}
              onChange={(e) => setCuit(e.target.value)}
              className="input font-mono"
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
            <span className="text-sm text-ink-700">Cliente activo</span>
          </label>
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
            {guardando ? 'Guardando...' : 'Guardar'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal agregar/editar dirección
// ────────────────────────────────────────────────────────────────────────

function ModalDireccion({
  clienteId,
  direccion,
  onClose,
  onSaved,
}: {
  clienteId: string;
  direccion?: Direccion;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!direccion;
  const [etiqueta, setEtiqueta] = useState(direccion?.etiqueta ?? 'Casa');
  const [calle, setCalle] = useState(direccion?.calle ?? '');
  const [numero, setNumero] = useState(direccion?.numero ?? '');
  const [piso, setPiso] = useState(direccion?.piso ?? '');
  const [depto, setDepto] = useState(direccion?.depto ?? '');
  const [entreCalles, setEntreCalles] = useState(direccion?.entreCalles ?? '');
  const [localidad, setLocalidad] = useState(direccion?.localidad ?? 'La Plata');
  const [codigoPostal, setCodigoPostal] = useState(direccion?.codigoPostal ?? '');
  const [indicaciones, setIndicaciones] = useState(direccion?.indicaciones ?? '');
  const [esDefault, setEsDefault] = useState(direccion?.esDefault ?? false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!calle.trim() || !numero.trim()) return setError('Falta calle o número');
    setGuardando(true);
    try {
      const data = {
        etiqueta,
        calle,
        numero,
        piso: piso || null,
        depto: depto || null,
        entreCalles: entreCalles || null,
        localidad,
        codigoPostal: codigoPostal || null,
        indicaciones: indicaciones || null,
        esDefault,
      };
      if (isEdit) {
        await api.patch(`/admin/clientes/${clienteId}/direcciones/${direccion!.id}`, data);
      } else {
        await api.post(`/admin/clientes/${clienteId}/direcciones`, data);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-lg text-teresita-700 mb-3">
          {isEdit ? 'Editar dirección' : 'Nueva dirección'}
        </h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Etiqueta</label>
            <input
              type="text"
              value={etiqueta}
              onChange={(e) => setEtiqueta(e.target.value)}
              className="input"
              placeholder="Casa, Trabajo, Local centro..."
              autoFocus
            />
          </div>
          <div className="grid grid-cols-[2fr_1fr] gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Calle</label>
              <input
                type="text"
                value={calle}
                onChange={(e) => setCalle(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Número</label>
              <input
                type="text"
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                className="input font-mono"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Piso</label>
              <input
                type="text"
                value={piso}
                onChange={(e) => setPiso(e.target.value)}
                className="input font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Depto</label>
              <input
                type="text"
                value={depto}
                onChange={(e) => setDepto(e.target.value)}
                className="input font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Entre calles</label>
            <input
              type="text"
              value={entreCalles}
              onChange={(e) => setEntreCalles(e.target.value)}
              className="input"
              placeholder="ej. 13 y 14"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Localidad</label>
              <input
                type="text"
                value={localidad}
                onChange={(e) => setLocalidad(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">CP</label>
              <input
                type="text"
                value={codigoPostal}
                onChange={(e) => setCodigoPostal(e.target.value)}
                className="input font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Indicaciones para el repartidor
            </label>
            <textarea
              value={indicaciones}
              onChange={(e) => setIndicaciones(e.target.value)}
              className="input min-h-[60px]"
              placeholder="ej. tocar timbre fuerte, no funciona portero, perro grande..."
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={esDefault}
              onChange={(e) => setEsDefault(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-ink-700">Marcar como dirección predeterminada</span>
          </label>
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
            {guardando ? 'Guardando...' : isEdit ? 'Guardar' : 'Crear dirección'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
