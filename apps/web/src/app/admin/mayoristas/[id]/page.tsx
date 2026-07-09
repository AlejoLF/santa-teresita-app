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
  // Detalle de productos — el resumen impreso los lista debajo de cada remito.
  items?: Array<{ nombre: string; cantidad: string; precioUnitario: string; subtotal: string }>;
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
    const money = (v: unknown) =>
      Number(v ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
    const cant = (v: unknown) => Number(v ?? 0).toLocaleString('es-AR');
    // Bloque por remito: encabezado (nº · fecha · total) + tabla de productos
    // con cantidades, valores unitarios y total por línea.
    const bloques = enRango
      .map((r) => {
        const items = r.items ?? [];
        const filasItems = items
          .map(
            (it) =>
              `<tr><td>${esc(it.nombre)}</td><td class="num">${cant(it.cantidad)}</td><td class="num">$ ${money(it.precioUnitario)}</td><td class="num">$ ${money(it.subtotal)}</td></tr>`,
          )
          .join('');
        return `<section class="remito">
          <div class="rem-head">
            <span class="rem-num">Remito #${r.numero}</span>
            <span class="rem-fecha">${new Date(r.fecha).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}</span>
            <span class="rem-total">$ ${money(r.total)}</span>
          </div>
          ${
            items.length > 0
              ? `<table class="items"><thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">P. unitario</th><th class="num">Total</th></tr></thead><tbody>${filasItems}</tbody></table>`
              : `<div class="sin-items">${r.itemsCount} ítems (sin detalle)</div>`
          }
          ${r.observaciones ? `<div class="obs">Obs: ${esc(r.observaciones)}</div>` : ''}
        </section>`;
      })
      .join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Resumen ${esc(c.nombre)}</title>
      <style>
      body{font-family:system-ui,sans-serif;padding:24px 28px 60px;color:#1a1a1a}
      /* Membrete de la fábrica — centrado a página */
      .membrete{text-align:center;margin-bottom:18px;padding-bottom:12px;border-bottom:2px solid #1a1a1a}
      .membrete .nombre{font-size:20px;font-weight:700;letter-spacing:2px;text-transform:uppercase}
      .membrete .desc{font-size:12px;color:#555;margin-top:2px}
      .membrete .dir{font-size:12px;color:#555;margin-top:1px}
      h1{font-size:16px;margin:0 0 4px} .sub{color:#666;font-size:12px;margin-bottom:14px}
      .remito{margin-bottom:14px;break-inside:avoid}
      .rem-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;background:#f3f0ea;border:1px solid #ddd;border-bottom:none;padding:5px 8px;font-size:13px}
      .rem-num{font-weight:700} .rem-fecha{color:#555} .rem-total{font-weight:700;margin-left:auto}
      table.items{width:100%;border-collapse:collapse;font-size:12px;border:1px solid #ddd}
      table.items th,table.items td{padding:4px 8px;border-bottom:1px solid #eee;text-align:left}
      table.items th{text-transform:uppercase;font-size:10px;color:#666;background:#fafafa}
      td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
      .sin-items{border:1px solid #ddd;padding:5px 8px;font-size:12px;color:#666}
      .obs{font-size:11px;color:#777;padding:3px 8px;border:1px solid #ddd;border-top:none}
      .total{font-size:17px;font-weight:bold;text-align:right;margin-top:16px}
      /* Pie de página en cada hoja impresa */
      .pie{position:fixed;bottom:8px;left:0;right:0;text-align:center;font-size:10px;color:#888}
      </style></head>
      <body>
      <div class="membrete">
        <div class="nombre">Santa Teresita Pastas</div>
        <div class="desc">Fábrica de pastas artesanales</div>
        <div class="dir">Av. 44 e/ 12 y Plaza Paso · La Plata, Buenos Aires</div>
      </div>
      <h1>Resumen de cuenta — ${esc(c.nombre)}</h1>
      <div class="sub">${c.cuit ? 'CUIT ' + esc(c.cuit) + ' · ' : ''}Período ${new Date(
        desde,
      ).toLocaleDateString('es-AR', { timeZone: 'UTC' })} a ${new Date(hasta).toLocaleDateString('es-AR', { timeZone: 'UTC' })} · ${
      enRango.length
    } remitos</div>
      ${bloques}
      <div class="total">TOTAL: $ ${totalRango.toLocaleString('es-AR', {
        minimumFractionDigits: 2,
      })}</div>
      <div class="pie">Santa Teresita Pastas · Av. 44 e/ 12 y Plaza Paso, La Plata</div>
      <script>window.onload=function(){window.print()}</script></body></html>`;
    // Abrimos el resumen como un documento navegable (Blob) en una pestaña
    // nueva. Antes se usaba window.open('', '_blank', 'width=...,height=...'):
    // ese string de features hace que el navegador lo trate como POPUP y lo
    // bloquee → "no pasaba nada" al hacer click. Sin features, es una pestaña
    // normal (no se bloquea). El doc trae un script que abre el diálogo de
    // impresión; desde ahí se imprime o se "Guarda como PDF". Si aún así el
    // navegador bloquea la pestaña, caemos a descargar el archivo.
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) {
      const a = document.createElement('a');
      a.href = url;
      a.download = `resumen-${c.nombre}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    // Liberamos el Blob después de un rato (ya cargado en la pestaña nueva).
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
          <>
          <table className="w-full text-sm hidden md:table">
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
                    {new Date(r.fecha).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}
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

          {/* Tarjetas (mobile) */}
          <div className="md:hidden divide-y divide-cream-200">
            {data.remitos.map((r) => (
              <div key={r.id} className={cn('p-3', r.estado === 'ANULADO' && 'opacity-50')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-ink-900 truncate">
                      <span className="font-mono text-ink-700">#{r.numero}</span> ·{' '}
                      {new Date(r.fecha).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}
                    </div>
                    <div className="text-2xs font-mono text-ink-500 truncate">
                      {r.itemsCount} ítems
                      {r.observaciones && ` · ${r.observaciones}`}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <MoneyAmount
                      value={r.total}
                      className={cn(r.estado === 'ANULADO' && 'line-through')}
                    />
                    <div className="text-2xs uppercase tracking-wider">
                      {r.estado === 'ANULADO' ? (
                        <span className="text-pomodoro-600">anulado</span>
                      ) : (
                        <span className="text-basil-600">pendiente</span>
                      )}
                    </div>
                    {r.estado !== 'ANULADO' && (
                      <button
                        onClick={() => anularRemito(r.id, r.numero)}
                        className="text-pomodoro-600 hover:underline text-xs mt-0.5"
                      >
                        Anular
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          </>
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
          <>
          <table className="w-full text-sm hidden md:table">
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
                    {new Date(m.fecha).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}
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

          {/* Tarjetas (mobile) */}
          <div className="md:hidden divide-y divide-cream-200">
            {data.cobros.map((m) => (
              <div key={m.id} className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-ink-900 truncate">{m.cuenta}</div>
                    <div className="text-2xs font-mono text-ink-500 truncate">
                      {new Date(m.fecha).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}
                      {m.observacion && ` · ${m.observacion}`}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <MoneyAmount value={m.monto} className="text-basil-600" />
                  </div>
                </div>
              </div>
            ))}
          </div>
          </>
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
