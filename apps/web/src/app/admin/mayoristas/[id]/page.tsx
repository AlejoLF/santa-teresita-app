'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface Remito {
  id: string;
  numero: number;
  fecha: string;
  total: string;
  estado: 'PENDIENTE' | 'ANULADO';
  itemsCount: number;
  observaciones: string | null;
}
interface Cobro {
  id: string;
  fecha: string;
  monto: string;
  cuenta: string;
  usuario: string | null;
  observacion: string | null;
}
interface Detalle {
  cliente: {
    id: string;
    nombre: string;
    cuit: string | null;
    contacto: string | null;
    telefono: string | null;
    email: string | null;
    direccion: string | null;
    observaciones: string | null;
    activo: boolean;
    lista: { id: string; nombre: string };
  };
  saldo: string;
  totales: { remitado: string; cobrado: string };
  remitos: Remito[];
  cobros: Cobro[];
}
interface Cuenta {
  id: string;
  nombre: string;
  tipo: string;
}

function inicioMesISO(): string {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth(), 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function hoyISO(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

export default function MayoristaDetallePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<Detalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCobro, setShowCobro] = useState(false);
  const [showEditar, setShowEditar] = useState(false);
  // Filtro de período para el resumen a facturar.
  const [desde, setDesde] = useState(inicioMesISO());
  const [hasta, setHasta] = useState(hoyISO());

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get<Detalle>(`/admin/mayoristas/${id}`);
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

  async function anularRemito(remitoId: string, numero: number) {
    if (!confirm(`¿Anular el remito #${numero}? Deja de contar en la cuenta corriente.`)) return;
    try {
      await api.post(`/admin/mayoristas/remitos/${remitoId}/anular`, {});
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo anular el remito');
    }
  }

  if (error) return <div className="text-pomodoro-600 p-6">{error}</div>;
  if (!data) return <div className="text-ink-500 p-6">Cargando...</div>;

  const c = data.cliente;
  const saldoNum = Number(data.saldo);

  // Resumen del período (para facturar): remitos no anulados dentro del rango.
  const enRango = data.remitos.filter((r) => {
    if (r.estado === 'ANULADO') return false;
    const f = r.fecha.slice(0, 10);
    return f >= desde && f <= hasta;
  });
  const totalRango = enRango.reduce((acc, r) => acc + Number(r.total), 0);

  function imprimirResumen() {
    // Escape HTML — nombre/cuit del cliente van a un document.write same-origin;
    // sin escapar, un nombre con <img onerror=...> ejecuta JS y roba el token
    // de localStorage. Seguridad: stored XSS via document.write.
    const esc = (v: unknown) =>
      String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const filas = enRango
      .map(
        (r) =>
          `<tr><td>#${r.numero}</td><td>${new Date(r.fecha).toLocaleDateString('es-AR')}</td><td>${r.itemsCount} ítems</td><td style="text-align:right">$ ${Number(
            r.total,
          ).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td></tr>`,
      )
      .join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Resumen ${esc(c.nombre)}</title>
      <style>body{font-family:system-ui,sans-serif;padding:24px;color:#1a1a1a}
      h1{font-size:18px;margin:0 0 4px} .sub{color:#666;font-size:13px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}
      th{text-transform:uppercase;font-size:11px;color:#666}
      .total{font-size:16px;font-weight:bold;text-align:right;margin-top:16px}</style></head>
      <body><h1>Resumen de cuenta — ${esc(c.nombre)}</h1>
      <div class="sub">${c.cuit ? 'CUIT ' + esc(c.cuit) + ' · ' : ''}Período ${new Date(
        desde,
      ).toLocaleDateString('es-AR')} a ${new Date(hasta).toLocaleDateString('es-AR')} · ${
      enRango.length
    } remitos</div>
      <table><thead><tr><th>Remito</th><th>Fecha</th><th>Detalle</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${filas}</tbody></table>
      <div class="total">TOTAL A FACTURAR: $ ${totalRango.toLocaleString('es-AR', {
        minimumFractionDigits: 2,
      })}</div>
      <script>window.onload=function(){window.print()}</script></body></html>`;
    const w = window.open('', '_blank', 'width=800,height=600');
    if (w) {
      w.document.open();
      w.document.write(html);
      w.document.close();
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header>
        <Link href="/admin/mayoristas" className="text-sm text-ink-500 hover:underline">
          ← Volver a mayoristas
        </Link>
        <div className="flex items-baseline justify-between mt-1 flex-wrap gap-2">
          <div>
            <h1 className="font-display text-xl text-ink-900">
              {c.nombre}
              {!c.activo && (
                <span className="ml-2 text-2xs text-ink-500 uppercase">(inactivo)</span>
              )}
            </h1>
            <p className="text-sm text-ink-500">
              Lista: <span className="text-ink-700">{c.lista.nombre}</span>
              {c.cuit && ` · CUIT ${c.cuit}`}
              {c.telefono && ` · ${c.telefono}`}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowEditar(true)}>
              Editar
            </Button>
            <Button variant="secondary" onClick={() => setShowCobro(true)}>
              Registrar cobro
            </Button>
            <Link href={`/admin/mayoristas/${id}/remito`}>
              <Button>+ Nuevo remito</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* KPIs cuenta corriente */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Saldo adeudado</div>
          <MoneyAmount
            value={data.saldo}
            hero
            className={cn('text-lg', saldoNum > 0 ? 'text-pomodoro-600' : 'text-basil-600')}
          />
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Total remitado</div>
          <MoneyAmount value={data.totales.remitado} hero className="text-lg text-ink-900" />
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase">Total cobrado</div>
          <MoneyAmount value={data.totales.cobrado} hero className="text-lg text-basil-600" />
        </div>
      </section>

      {/* Resumen para facturar */}
      <section className="card p-4">
        <h2 className="font-display text-md text-ink-900 mb-2">Resumen para facturar</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-2xs uppercase text-ink-500 mb-1">Desde</label>
            <input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              className="input w-auto text-sm"
            />
          </div>
          <div>
            <label className="block text-2xs uppercase text-ink-500 mb-1">Hasta</label>
            <input
              type="date"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
              className="input w-auto text-sm"
            />
          </div>
          <div className="flex-1 text-sm text-ink-700">
            {enRango.length} remitos ·{' '}
            <span className="font-mono font-semibold text-ink-900">
              ${totalRango.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={imprimirResumen} disabled={enRango.length === 0}>
            🖨 Imprimir resumen
          </Button>
        </div>
      </section>

      {/* Remitos */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
          <h2 className="font-display text-md text-ink-900">Remitos ({data.remitos.length})</h2>
        </header>
        {data.remitos.length === 0 ? (
          <div className="px-4 py-8 text-center text-ink-500 text-sm">
            Sin remitos todavía. Cargá el primero con "+ Nuevo remito".
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-4 py-2">Remito</th>
                <th className="text-left px-4 py-2">Fecha</th>
                <th className="text-left px-4 py-2">Detalle</th>
                <th className="text-right px-4 py-2">Total</th>
                <th className="text-center px-4 py-2">Estado</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.remitos.map((r) => (
                <tr key={r.id} className={cn(r.estado === 'ANULADO' && 'opacity-50')}>
                  <td className="px-4 py-2 font-mono text-ink-700">#{r.numero}</td>
                  <td className="px-4 py-2 text-ink-700 text-xs">
                    {new Date(r.fecha).toLocaleDateString('es-AR')}
                  </td>
                  <td className="px-4 py-2 text-ink-500 text-xs">
                    {r.itemsCount} ítems
                    {r.observaciones && ` · ${r.observaciones}`}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <MoneyAmount
                      value={r.total}
                      className={cn(r.estado === 'ANULADO' && 'line-through')}
                    />
                  </td>
                  <td className="px-4 py-2 text-center text-2xs uppercase tracking-wider">
                    {r.estado === 'ANULADO' ? (
                      <span className="text-pomodoro-600">anulado</span>
                    ) : (
                      <span className="text-basil-600">pendiente</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {r.estado !== 'ANULADO' && (
                      <button
                        onClick={() => anularRemito(r.id, r.numero)}
                        className="text-pomodoro-600 hover:underline text-xs"
                      >
                        Anular
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Cobros */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
          <h2 className="font-display text-md text-ink-900">Cobros ({data.cobros.length})</h2>
        </header>
        {data.cobros.length === 0 ? (
          <div className="px-4 py-8 text-center text-ink-500 text-sm">
            Sin cobros registrados. Cuando el cliente pague, usá "Registrar cobro".
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-4 py-2">Fecha</th>
                <th className="text-left px-4 py-2">Cuenta</th>
                <th className="text-left px-4 py-2">Observación</th>
                <th className="text-right px-4 py-2">Monto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.cobros.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2 text-ink-700 text-xs">
                    {new Date(m.fecha).toLocaleDateString('es-AR')}
                  </td>
                  <td className="px-4 py-2 text-ink-700 text-xs">{m.cuenta}</td>
                  <td className="px-4 py-2 text-ink-500 text-xs italic">{m.observacion ?? '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <MoneyAmount value={m.monto} className="text-basil-600" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {showCobro && (
        <ModalCobro
          clienteId={id}
          saldoSugerido={data.saldo}
          onClose={() => setShowCobro(false)}
          onCreated={() => {
            setShowCobro(false);
            void fetchData();
          }}
        />
      )}
      {showEditar && (
        <ModalEditar
          cliente={data.cliente}
          onClose={() => setShowEditar(false)}
          onSaved={() => {
            setShowEditar(false);
            void fetchData();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal registrar cobro
// ────────────────────────────────────────────────────────────────────────

function ModalCobro({
  clienteId,
  saldoSugerido,
  onClose,
  onCreated,
}: {
  clienteId: string;
  saldoSugerido: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [monto, setMonto] = useState(Number(saldoSugerido) > 0 ? saldoSugerido : '');
  const [cuentaId, setCuentaId] = useState('');
  const [metodo, setMetodo] = useState<
    'EFECTIVO' | 'TRANSFERENCIA' | 'DEPOSITO' | 'CHEQUE' | 'MERCADOPAGO_QR' | 'OTRO'
  >('TRANSFERENCIA');
  const [numeroReferencia, setNumeroReferencia] = useState('');
  const [observacion, setObservacion] = useState('');
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const c = await api.get<{ cuentas: Cuenta[] }>('/admin/cuentas');
        setCuentas(c.cuentas);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  async function submit() {
    setError(null);
    if (!monto || Number(monto) <= 0) return setError('Falta el monto');
    if (!cuentaId) return setError('Elegí la cuenta donde entra la plata');
    setGuardando(true);
    try {
      await api.post(`/admin/mayoristas/${clienteId}/cobros`, {
        monto: Number(monto).toFixed(2),
        cuentaId,
        metodo,
        numeroReferencia: numeroReferencia || undefined,
        observacion: observacion || undefined,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al registrar el cobro');
    } finally {
      setGuardando(false);
    }
  }

  const necesitaRef = ['TRANSFERENCIA', 'CHEQUE', 'DEPOSITO'].includes(metodo);

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Registrar cobro</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Monto cobrado</label>
            <input
              type="number"
              step="0.01"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              className="input font-mono text-lg"
              placeholder="0.00"
              autoFocus
            />
            {Number(saldoSugerido) > 0 && (
              <p className="text-2xs text-ink-500 mt-1">
                Saldo adeudado actual: ${Number(saldoSugerido).toLocaleString('es-AR', {
                  minimumFractionDigits: 2,
                })}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Entra a</label>
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
                <option value="TRANSFERENCIA">Transferencia</option>
                <option value="EFECTIVO">Efectivo</option>
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
              placeholder="ej. factura 0001-00012345"
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
            {guardando ? 'Guardando...' : 'Registrar cobro'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal editar cliente
// ────────────────────────────────────────────────────────────────────────

function ModalEditar({
  cliente,
  onClose,
  onSaved,
}: {
  cliente: Detalle['cliente'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nombre, setNombre] = useState(cliente.nombre);
  const [listaPreciosId, setListaPreciosId] = useState(cliente.lista.id);
  const [cuit, setCuit] = useState(cliente.cuit ?? '');
  const [telefono, setTelefono] = useState(cliente.telefono ?? '');
  const [email, setEmail] = useState(cliente.email ?? '');
  const [direccion, setDireccion] = useState(cliente.direccion ?? '');
  const [observaciones, setObservaciones] = useState(cliente.observaciones ?? '');
  const [activo, setActivo] = useState(cliente.activo);
  const [listas, setListas] = useState<{ id: string; nombre: string }[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ listas: { id: string; nombre: string }[] }>(
          '/admin/mayoristas/listas',
        );
        setListas(res.listas);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  async function submit() {
    if (!nombre.trim()) return setError('Falta el nombre');
    setGuardando(true);
    setError(null);
    try {
      await api.patch(`/admin/mayoristas/${cliente.id}`, {
        nombre,
        listaPreciosId,
        cuit: cuit || null,
        telefono: telefono || null,
        email: email || null,
        direccion: direccion || null,
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
      <div className="card w-full max-w-lg p-5 shadow-modal max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Editar empresa</h2>
        <div className="space-y-3">
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
            <label className="block text-xs font-medium text-ink-700 mb-1">Lista de precios</label>
            <select
              value={listaPreciosId}
              onChange={(e) => setListaPreciosId(e.target.value)}
              className="input"
            >
              {listas.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nombre}
                </option>
              ))}
            </select>
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
              <label className="block text-xs font-medium text-ink-700 mb-1">Teléfono</label>
              <input
                type="text"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                className="input"
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
            <label className="block text-xs font-medium text-ink-700 mb-1">Dirección</label>
            <input
              type="text"
              value={direccion}
              onChange={(e) => setDireccion(e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Observaciones</label>
            <input
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              className="input"
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
