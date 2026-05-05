'use client';

import { useEffect, useState, useCallback } from 'react';
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
  activo: boolean;
  totalComprado: string;
  ventasFinalizadas: number;
  _count: { direcciones: number; ventas: number };
}

const TIPO_LABEL: Record<Cliente['tipo'], { label: string; cls: string }> = {
  CASUAL: { label: 'Casual', cls: 'bg-cream-200 text-ink-500' },
  REGISTRADO: { label: 'Registrado', cls: 'bg-teresita-50 text-teresita-700' },
  CORPORATIVO: { label: 'Corporativo', cls: 'bg-ocean-100 text-ocean-600' },
  PLATAFORMA: { label: 'Plataforma', cls: 'bg-saffron-100 text-saffron-600' },
};

const PAGE_SIZE = 50;

export default function ClientesListPage() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [tipoFiltro, setTipoFiltro] = useState<string>('');
  const [incluirInactivos, setIncluirInactivos] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        incluirInactivos: String(incluirInactivos),
      });
      if (search.trim()) params.set('q', search.trim());
      if (tipoFiltro) params.set('tipo', tipoFiltro);
      const res = await api.get<{ clientes: Cliente[]; total: number }>(
        `/admin/clientes?${params.toString()}`,
      );
      setClientes(res.clientes);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los clientes');
      }
    } finally {
      setLoading(false);
    }
  }, [page, search, tipoFiltro, incluirInactivos]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-xl text-ink-900">Clientes</h1>
          <p className="text-sm text-ink-500">
            {total} cliente{total !== 1 && 's'} registrado{total !== 1 && 's'}
          </p>
        </div>
        <Button onClick={() => setShowForm(true)}>+ Nuevo cliente</Button>
      </header>

      {/* Filtros */}
      <section className="card p-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="🔍 Buscar por nombre, teléfono, CUIT..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="input flex-1 min-w-[280px]"
        />
        <select
          value={tipoFiltro}
          onChange={(e) => {
            setTipoFiltro(e.target.value);
            setPage(1);
          }}
          className="input w-auto"
        >
          <option value="">Todos los tipos</option>
          <option value="REGISTRADO">Registrado</option>
          <option value="CORPORATIVO">Corporativo</option>
          <option value="PLATAFORMA">Plataforma</option>
          <option value="CASUAL">Casual</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-ink-700 cursor-pointer">
          <input
            type="checkbox"
            checked={incluirInactivos}
            onChange={(e) => {
              setIncluirInactivos(e.target.checked);
              setPage(1);
            }}
            className="w-4 h-4"
          />
          Mostrar inactivos
        </label>
      </section>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {/* Tabla */}
      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Cliente</th>
              <th className="text-left px-4 py-2">Tipo</th>
              <th className="text-left px-4 py-2">Contacto</th>
              <th className="text-center px-4 py-2">Direcciones</th>
              <th className="text-right px-4 py-2">Ventas</th>
              <th className="text-right px-4 py-2">Total comprado</th>
              <th className="px-4 py-2 w-8"></th>
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
            {!loading && clientes.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-ink-500 py-8">
                  Sin clientes que coincidan con los filtros
                </td>
              </tr>
            )}
            {clientes.map((c) => {
              const tipoStyle = TIPO_LABEL[c.tipo];
              return (
                <tr key={c.id} className={cn(!c.activo && 'opacity-50', 'hover:bg-cream-100')}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/clientes/${c.id}`}
                      className="font-medium text-ink-900 hover:text-teresita-700"
                    >
                      {c.nombre}
                      {c.apellido && ` ${c.apellido}`}
                    </Link>
                    {c.cuitCuil && (
                      <div className="text-2xs font-mono text-ink-500">CUIT {c.cuitCuil}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'text-2xs font-medium px-2 py-0.5 rounded uppercase',
                        tipoStyle.cls,
                      )}
                    >
                      {tipoStyle.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-700">
                    {c.telefono && <div>📞 {c.telefono}</div>}
                    {c.email && <div className="text-ink-500">{c.email}</div>}
                    {!c.telefono && !c.email && <span className="text-ink-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-ink-700 font-mono">
                    {c._count.direcciones}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-500 font-mono">
                    {c.ventasFinalizadas}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {Number(c.totalComprado) > 0 ? (
                      <MoneyAmount value={c.totalComprado} className="text-teresita-700" />
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/admin/clientes/${c.id}`} className="text-ink-300 hover:text-teresita-700">
                      →
                    </Link>
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
        <FormNuevoCliente
          onClose={() => setShowForm(false)}
          onCreated={(id) => {
            setShowForm(false);
            // Si el form se completó con datos suficientes, va al detalle directamente
            // sino refresh la lista.
            if (id) {
              window.location.href = `/admin/clientes/${id}`;
            } else {
              void fetchData();
            }
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Form crear cliente
// ────────────────────────────────────────────────────────────────────────

function FormNuevoCliente({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string | null) => void;
}) {
  const [tipo, setTipo] = useState<'REGISTRADO' | 'CORPORATIVO'>('REGISTRADO');
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [cuit, setCuit] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!nombre.trim()) return setError('Falta el nombre');
    setCreando(true);
    try {
      const created = await api.post<{ id: string }>('/admin/clientes', {
        tipo,
        nombre: nombre.trim(),
        apellido: apellido || undefined,
        telefono: telefono || undefined,
        email: email || undefined,
        cuitCuil: cuit || undefined,
        observaciones: observaciones || undefined,
      });
      onCreated(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear el cliente');
    } finally {
      setCreando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Nuevo cliente</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Tipo</label>
            <div className="grid grid-cols-2 gap-2">
              {(['REGISTRADO', 'CORPORATIVO'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTipo(t)}
                  className={cn(
                    'py-2 px-3 rounded-md text-sm font-medium border transition-colors',
                    tipo === t
                      ? t === 'REGISTRADO'
                        ? 'bg-teresita-700 text-cream-50 border-teresita-700'
                        : 'bg-ocean-600 text-white border-ocean-600'
                      : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
                  )}
                >
                  {t === 'REGISTRADO' ? 'Particular' : 'Corporativo / Mayorista'}
                </button>
              ))}
            </div>
          </div>

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

          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Teléfono</label>
            <input
              type="tel"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              className="input font-mono"
              placeholder="221 1234567"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Email (opcional)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
            />
          </div>

          {tipo === 'CORPORATIVO' && (
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">CUIT/CUIL</label>
              <input
                type="text"
                value={cuit}
                onChange={(e) => setCuit(e.target.value)}
                className="input font-mono"
                placeholder="20-12345678-9"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Observaciones (opcional)
            </label>
            <input
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              className="input"
              placeholder="ej. cliente del sur, prefiere viernes..."
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        <p className="text-2xs text-ink-500 mt-3">
          Después de crearlo, podés agregarle direcciones para usar en deliveries.
        </p>

        <footer className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={creando}>
            {creando ? 'Creando...' : 'Crear y ver detalle'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
