'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface ClienteMayoristaRow {
  id: string;
  nombre: string;
  cuit: string | null;
  telefono: string | null;
  activo: boolean;
  lista: { id: string; nombre: string };
  saldo: string;
}

interface ListaOpcion {
  id: string;
  nombre: string;
}

export default function MayoristasPage() {
  const [clientes, setClientes] = useState<ClienteMayoristaRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNuevo, setShowNuevo] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ clientes: ClienteMayoristaRow[] }>('/admin/mayoristas');
      setClientes(res.clientes);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los clientes mayoristas');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const totalAdeudado = clientes.reduce((acc, c) => acc + Number(c.saldo), 0);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-xl text-ink-900">Clientes / Cuenta Corriente</h1>
          <p className="text-sm text-ink-500">
            Empresas que compran a precio especial y pagan por cuenta corriente (remitos +
            cobro mensual).
          </p>
        </div>
        <Button onClick={() => setShowNuevo(true)}>+ Nueva empresa</Button>
      </header>

      {clientes.length > 0 && (
        <section className="card p-4 flex items-baseline justify-between">
          <span className="text-sm text-ink-500 uppercase tracking-wide">Total adeudado</span>
          <MoneyAmount
            value={totalAdeudado.toFixed(2)}
            className={cn('text-lg', totalAdeudado > 0 ? 'text-pomodoro-600' : 'text-basil-600')}
          />
        </section>
      )}

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      <section className="card overflow-hidden">
        <table className="w-full text-sm hidden md:table">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Empresa</th>
              <th className="text-left px-4 py-2">Lista de precios</th>
              <th className="text-left px-4 py-2">CUIT / Tel</th>
              <th className="text-right px-4 py-2">Saldo</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {loading && (
              <tr>
                <td colSpan={5} className="text-center text-ink-500 py-8">
                  Cargando...
                </td>
              </tr>
            )}
            {!loading && clientes.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-ink-500 py-8">
                  Sin clientes mayoristas todavía. Creá el primero con el botón de arriba.
                </td>
              </tr>
            )}
            {clientes.map((c) => (
              <tr key={c.id} className="hover:bg-cream-100">
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/mayoristas/${c.id}`}
                    className="font-medium text-teresita-700 hover:underline"
                  >
                    {c.nombre}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink-700 text-xs">{c.lista.nombre}</td>
                <td className="px-4 py-3 text-ink-500 text-xs">
                  {c.cuit || c.telefono || '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <MoneyAmount
                    value={c.saldo}
                    className={Number(c.saldo) > 0 ? 'text-pomodoro-600' : 'text-basil-600'}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/admin/mayoristas/${c.id}`}
                    className="text-teresita-700 hover:underline text-xs"
                  >
                    Ver cuenta →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Tarjetas (mobile) */}
        <div className="md:hidden divide-y divide-cream-200">
          {loading && <div className="p-6 text-center text-ink-500">Cargando...</div>}
          {!loading && clientes.length === 0 && (
            <div className="p-6 text-center text-ink-500">
              Sin clientes mayoristas todavía. Creá el primero con el botón de arriba.
            </div>
          )}
          {clientes.map((c) => (
            <Link key={c.id} href={`/admin/mayoristas/${c.id}`} className="block p-3 active:bg-cream-100">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-ink-900 truncate">{c.nombre}</div>
                  <div className="text-2xs font-mono text-ink-500 truncate">
                    {c.lista.nombre}
                    {(c.cuit || c.telefono) && ` · ${c.cuit || c.telefono}`}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <MoneyAmount
                    value={c.saldo}
                    className={Number(c.saldo) > 0 ? 'text-pomodoro-600' : 'text-basil-600'}
                  />
                  <div className="text-2xs text-teresita-700">Ver cuenta →</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {showNuevo && (
        <ModalNuevoCliente
          onClose={() => setShowNuevo(false)}
          onCreated={() => {
            setShowNuevo(false);
            void fetchData();
          }}
        />
      )}
    </div>
  );
}

function ModalNuevoCliente({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [nombre, setNombre] = useState('');
  const [listaPreciosId, setListaPreciosId] = useState('');
  const [cuit, setCuit] = useState('');
  const [contacto, setContacto] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [direccion, setDireccion] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [listas, setListas] = useState<ListaOpcion[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ listas: ListaOpcion[] }>('/admin/mayoristas/listas');
        setListas(res.listas);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  async function submit() {
    if (!nombre.trim()) return setError('Falta el nombre de la empresa');
    if (!listaPreciosId) return setError('Elegí la lista de precios del cliente');
    setGuardando(true);
    setError(null);
    try {
      await api.post('/admin/mayoristas', {
        nombre,
        listaPreciosId,
        cuit: cuit || undefined,
        contacto: contacto || undefined,
        telefono: telefono || undefined,
        email: email || undefined,
        direccion: direccion || undefined,
        observaciones: observaciones || undefined,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear el cliente');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-lg p-5 shadow-modal max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Nueva empresa (mayorista)</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Nombre / Razón social
            </label>
            <input
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              className="input"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Lista de precios (precio especial)
            </label>
            <select
              value={listaPreciosId}
              onChange={(e) => setListaPreciosId(e.target.value)}
              className="input"
            >
              <option value="">Elegí lista...</option>
              {listas.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nombre}
                </option>
              ))}
            </select>
            <p className="text-2xs text-ink-500 mt-1">
              Los remitos van a usar los precios de esta lista. Creá/ajustá listas en
              Productos → Lista de precios.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">CUIT</label>
              <input
                type="text"
                value={cuit}
                onChange={(e) => setCuit(e.target.value)}
                className="input font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Contacto</label>
              <input
                type="text"
                value={contacto}
                onChange={(e) => setContacto(e.target.value)}
                className="input"
                placeholder="persona de contacto"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Teléfono</label>
              <input
                type="text"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                className="input"
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
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Dirección</label>
            <input
              type="text"
              value={direccion}
              onChange={(e) => setDireccion(e.target.value)}
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
          <Button onClick={() => void submit()} disabled={guardando}>
            {guardando ? 'Guardando...' : 'Crear empresa'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
