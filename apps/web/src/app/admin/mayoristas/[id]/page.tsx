'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  LineasDePago,
  useCuentas,
  sugerirCuenta,
  validarPagos,
  type LineaPago,
} from '@/components/admin/LineasDePago';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface Remito {
  id: string;
  numero: number;
  fecha: string;
  total: string;
  estado: 'PENDIENTE' | 'PAGADO' | 'ANULADO';
  pagadoAt?: string | null;
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
  descalce: { monto: string; remitos: number[] };
  creditoLibre: string;
  remitos: Remito[];
  cobros: Cobro[];
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

// ────────────────────────────────────────────────────────────────────────
//   Impresión — resumen de cuenta y remito individual comparten la papelería
// ────────────────────────────────────────────────────────────────────────

// Escape HTML. El nombre/CUIT del cliente van a un documento same-origin; sin
// escapar, un nombre con <img onerror=...> ejecuta JS y roba el token de
// localStorage. Seguridad: stored XSS vía document.write.
const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = (v: unknown) =>
  Number(v ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
const cant = (v: unknown) => Number(v ?? 0).toLocaleString('es-AR');
/** Fecha de un input date (YYYY-MM-DD): se lee como UTC para no correrla un día. */
const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleDateString('es-AR', { timeZone: 'UTC' });
/** Fecha de un timestamp de la DB: en TZ Argentina, como todo el sistema. */
const fechaLarga = (iso: string) =>
  new Date(iso).toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

/** Tabla de productos de un remito (o el conteo, si no vino el detalle). */
function tablaItems(r: Remito): string {
  const items = r.items ?? [];
  if (items.length === 0) return `<div class="sin-items">${r.itemsCount} ítems (sin detalle)</div>`;
  const filas = items
    .map(
      (it) =>
        `<tr><td>${esc(it.nombre)}</td><td class="num">${cant(it.cantidad)}</td><td class="num">$ ${money(it.precioUnitario)}</td><td class="num">$ ${money(it.subtotal)}</td></tr>`,
    )
    .join('');
  return `<table class="items"><thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">P. unitario</th><th class="num">Total</th></tr></thead><tbody>${filas}</tbody></table>`;
}

/** Bloque de un remito dentro del resumen: encabezado + tabla + observaciones. */
function bloqueRemito(r: Remito): string {
  return `<section class="remito">
    <div class="rem-head">
      <span class="rem-num">Remito #${r.numero}</span>
      <span class="rem-fecha">${fechaLarga(r.fecha)}</span>
      <span class="rem-total">$ ${money(r.total)}</span>
    </div>
    ${tablaItems(r)}
    ${r.observaciones ? `<div class="obs">Obs: ${esc(r.observaciones)}</div>` : ''}
  </section>`;
}

function documentoHtml(o: {
  titulo: string;
  encabezado: string;
  subtitulo: string;
  cuerpo: string;
  total: number;
}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.titulo)}</title>
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
    <h1>${o.encabezado}</h1>
    <div class="sub">${o.subtitulo}</div>
    ${o.cuerpo}
    <div class="total">TOTAL: $ ${money(o.total)}</div>
    <div class="pie">Santa Teresita Pastas · Av. 44 e/ 12 y Plaza Paso, La Plata</div>
    <script>window.onload=function(){window.print()}</script></body></html>`;
}

/**
 * Abre el documento como una pestaña navegable (Blob).
 *
 * NO usar window.open('', '_blank', 'width=...'): ese string de features hace
 * que el navegador lo trate como POPUP y lo bloquee → "no pasaba nada" al hacer
 * click. Sin features es una pestaña normal. Si aun así la bloquean, se cae a
 * descargar el archivo.
 */
function abrirImpresion(html: string, nombreArchivo: string) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if (!w) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${nombreArchivo}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
  // Remito abierto en el modal de detalle (null = cerrado).
  const [verRemito, setVerRemito] = useState<Remito | null>(null);
  // Confirmación de que el ticket se encoló (la impresión es asincrónica:
  // el agente lo levanta en el próximo poll, así que no hay feedback del papel).
  const [avisoImpresion, setAvisoImpresion] = useState<string | null>(null);
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
      setVerRemito(null);
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo anular el remito');
    }
  }

  // Marca/desmarca el remito como cobrado. NO mueve plata: el dinero entra por
  // "Registrar cobro". Esto sólo dice QUÉ remitos quedaron saldados.
  //
  // Por eso el aviso: usado sobre un remito que NO tiene un cobro detrás, deja
  // el remito en verde y la plata en ningún lado. Es lo que pasó con La
  // Juanita. Se puede seguir haciendo —sirve para imputar un cobro cargado "a
  // cuenta"— pero avisando cuando no hay con qué cubrirlo.
  async function marcarPagado(remitoId: string, pagado: boolean, totalRemito?: string) {
    if (pagado && data && Number(totalRemito ?? 0) > Number(data.creditoLibre) + 0.01) {
      const libre = Number(data.creditoLibre);
      const ok = window.confirm(
        (libre > 0
          ? `Este cliente tiene $${libre.toLocaleString('es-AR')} cobrados sin imputar, y el remito es de $${Number(totalRemito).toLocaleString('es-AR')}.`
          : 'Este cliente no tiene ningún cobro sin imputar.') +
          '\n\nMarcarlo cobrado NO registra la plata: no entra a ninguna cuenta ni al cierre del turno, y le baja la deuda igual.' +
          '\n\nSi el cliente pagó, cancelá y usá "Registrar cobro" (podés imputarle este remito ahí mismo).' +
          '\n\n¿Marcarlo cobrado igual?',
      );
      if (!ok) return;
    }
    try {
      await api.post(`/admin/mayoristas/remitos/${remitoId}/pagar`, { pagado });
      setVerRemito(null);
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar el estado del remito');
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

  // Documento imprimible del PERÍODO (el "resumen de cuenta" de siempre).
  function imprimirResumen() {
    abrirImpresion(
      documentoHtml({
        titulo: `Resumen ${c.nombre}`,
        encabezado: `Resumen de cuenta — ${esc(c.nombre)}`,
        subtitulo: `${c.cuit ? 'CUIT ' + esc(c.cuit) + ' · ' : ''}Período ${fechaCorta(
          desde,
        )} a ${fechaCorta(hasta)} · ${enRango.length} remitos`,
        cuerpo: enRango.map(bloqueRemito).join(''),
        total: totalRango,
      }),
      `resumen-${c.nombre}`,
    );
  }

  // El remito individual se imprime como TICKET en la comandera, igual que una
  // venta de mostrador: es el papel que se le entrega a la empresa junto con la
  // mercadería. NO es un A4 — el A4 es el "resumen de cuenta" del período, que
  // va al contador y se sigue armando en el navegador.
  async function imprimirRemito(r: Remito) {
    setAvisoImpresion(null);
    try {
      const out = await api.post<{ destino: string; numero: number }>(
        `/admin/mayoristas/remitos/${r.id}/imprimir`,
        {},
      );
      setAvisoImpresion(`Remito #${out.numero} enviado a la comandera ${out.destino}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo imprimir el remito');
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
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase">Saldo adeudado</div>
          <MoneyAmount
            value={data.saldo}
            hero
            fit
            className={cn('text-lg', saldoNum > 0 ? 'text-pomodoro-600' : 'text-basil-600')}
          />
        </div>
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase">Total remitado</div>
          <MoneyAmount value={data.totales.remitado} hero fit className="text-lg text-ink-900" />
        </div>
        <div className="card p-4 min-w-0">
          <div className="text-2xs text-ink-500 uppercase">Total cobrado</div>
          <MoneyAmount value={data.totales.cobrado} hero fit className="text-lg text-basil-600" />
        </div>
      </section>

      {/* Remitos marcados cobrados sin cobro registrado.
          El saldo ya NO los cuenta como deuda (si no, la ficha mostraba el
          remito en verde y el saldo igual al total remitado). Pero esa plata
          tampoco está en ninguna cuenta, así que el descalce se muestra en vez
          de quedar escondido en la diferencia entre dos números. */}
      {Number(data.descalce.monto) > 0 && (
        <section className="card p-4 border-l-4 border-pomodoro-500">
          <h2 className="font-display text-md text-ink-900">
            Hay $
            {Number(data.descalce.monto).toLocaleString('es-AR', {
              minimumFractionDigits: 2,
            })}{' '}
            marcados como cobrados sin cobro cargado
          </h2>
          <p className="text-sm text-ink-600 mt-1">
            {data.descalce.remitos.length > 0 && (
              <>
                Remito{data.descalce.remitos.length > 1 ? 's' : ''}{' '}
                {data.descalce.remitos.map((n) => `#${n}`).join(', ')}
                {': '}
              </>
            )}
            alguien usó &ldquo;Marcar cobrado&rdquo; sin registrar la plata, así que no entró a
            ninguna cuenta ni al cierre del turno. Si el cliente pagó, cargá el cobro con
            &ldquo;Registrar cobro&rdquo; e imputáselo. Si fue un error, volvé el remito a pendiente.
          </p>
        </section>
      )}

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

      {/* La impresión es asincrónica: el agente levanta el trabajo en su próximo
          poll (~3s). Sin este aviso, tocar 🖨 no da ninguna señal en pantalla y
          se termina imprimiendo tres veces el mismo remito. */}
      {avisoImpresion && (
        <div className="bg-basil-100 text-basil-700 px-4 py-2 rounded text-sm flex items-center justify-between gap-3">
          <span>🖨 {avisoImpresion}</span>
          <button
            onClick={() => setAvisoImpresion(null)}
            className="text-basil-700 hover:underline text-xs shrink-0"
          >
            Cerrar
          </button>
        </div>
      )}

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
                <th className="text-center px-4 py-2">Imprimir</th>
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
                  {/* La celda de detalle abre el remito: es lo que se buscaba
                      al hacer click sobre "N ítems" y antes no hacía nada. */}
                  <td className="px-4 py-2 text-xs">
                    <button
                      onClick={() => setVerRemito(r)}
                      className="text-teresita-700 hover:underline text-left"
                    >
                      {r.itemsCount} ítems
                      {r.observaciones && ` · ${r.observaciones}`}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <MoneyAmount
                      value={r.total}
                      className={cn(r.estado === 'ANULADO' && 'line-through')}
                    />
                  </td>
                  <td className="px-4 py-2 text-center text-2xs uppercase tracking-wider">
                    <EstadoRemitoBadge remito={r} />
                  </td>
                  {/* Imprimir está SIEMPRE disponible, incluso anulado: el papel
                      pudo haberse entregado y a veces hay que reponerlo. */}
                  <td className="px-4 py-2 text-center">
                    <button
                      onClick={() => void imprimirRemito(r)}
                      title={`Imprimir remito #${r.numero}`}
                      className="text-ink-500 hover:text-teresita-700 px-2 py-1 rounded hover:bg-cream-100"
                    >
                      🖨
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => setVerRemito(r)}
                      className="text-teresita-700 hover:underline text-xs mr-3"
                    >
                      Ver
                    </button>
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
                    <button
                      onClick={() => setVerRemito(r)}
                      className="text-2xs font-mono text-teresita-700 truncate hover:underline text-left"
                    >
                      {r.itemsCount} ítems
                      {r.observaciones && ` · ${r.observaciones}`}
                    </button>
                  </div>
                  <div className="shrink-0 text-right">
                    <MoneyAmount
                      value={r.total}
                      className={cn(r.estado === 'ANULADO' && 'line-through')}
                    />
                    <div className="text-2xs uppercase tracking-wider">
                      <EstadoRemitoBadge remito={r} />
                    </div>
                    <div className="flex items-center justify-end gap-2 mt-0.5">
                      <button
                        onClick={() => void imprimirRemito(r)}
                        title={`Imprimir remito #${r.numero}`}
                        className="text-ink-500 hover:text-teresita-700 text-xs"
                      >
                        🖨
                      </button>
                      <button
                        onClick={() => setVerRemito(r)}
                        className="text-teresita-700 hover:underline text-xs"
                      >
                        Ver
                      </button>
                    </div>
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
          remitosPendientes={data.remitos.filter((r) => r.estado === 'PENDIENTE')}
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
      {verRemito && (
        <ModalRemito
          clienteId={id}
          remito={verRemito}
          onClose={() => setVerRemito(null)}
          onImprimir={() => void imprimirRemito(verRemito)}
          onPagar={(pagado) => void marcarPagado(verRemito.id, pagado, verRemito.total)}
          onAnular={() => void anularRemito(verRemito.id, verRemito.numero)}
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
  remitosPendientes,
  onClose,
  onCreated,
}: {
  clienteId: string;
  saldoSugerido: string;
  remitosPendientes: Remito[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [monto, setMonto] = useState(Number(saldoSugerido) > 0 ? saldoSugerido : '');
  // Remitos que este cobro salda. Vacío = cobro "a cuenta", sin imputar (que es
  // como funcionaba antes de existir esta opción).
  const [imputados, setImputados] = useState<Set<string>>(new Set());
  const [observacion, setObservacion] = useState('');
  const cuentas = useCuentas();
  const [pagos, setPagos] = useState<LineaPago[]>([
    { metodo: 'TRANSFERENCIA', cuentaId: '', monto: '' },
  ]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cuando llegan las cuentas, la primera línea toma la sugerida y el monto
  // arranca en el saldo — el caso normal queda listo para confirmar.
  useEffect(() => {
    if (cuentas.length === 0) return;
    setPagos((prev) =>
      prev.map((l, i) =>
        i === 0 && !l.cuentaId
          ? {
              ...l,
              cuentaId: sugerirCuenta(l.metodo, cuentas)?.id ?? '',
              monto: l.monto || (Number(saldoSugerido) > 0 ? Number(saldoSugerido).toFixed(2) : ''),
            }
          : l,
      ),
    );
  }, [cuentas, saldoSugerido]);

  async function submit() {
    setError(null);
    if (!monto || Number(monto) <= 0) return setError('Falta el monto');
    const problema = validarPagos(pagos, Number(monto));
    if (problema) return setError(problema);
    setGuardando(true);
    try {
      await api.post(`/admin/mayoristas/${clienteId}/cobros`, {
        monto: Number(monto).toFixed(2),
        pagos: pagos.map((l) => ({
          metodo: l.metodo,
          cuentaId: l.cuentaId,
          monto: Number(l.monto).toFixed(2),
          numeroReferencia: l.numeroReferencia || undefined,
        })),
        observacion: observacion || undefined,
        remitoIds: imputados.size ? [...imputados] : undefined,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al registrar el cobro');
    } finally {
      setGuardando(false);
    }
  }

  const totalImputado = remitosPendientes
    .filter((r) => imputados.has(r.id))
    .reduce((acc, r) => acc + Number(r.total), 0);

  function toggleRemito(remitoId: string, total: string) {
    // El cálculo va FUERA de los updaters: React puede ejecutarlos dos veces
    // (StrictMode) y sumar el total del remito por duplicado.
    const estaba = imputados.has(remitoId);
    const next = new Set(imputados);
    if (estaba) next.delete(remitoId);
    else next.add(remitoId);
    setImputados(next);
    // El monto sigue a la selección: en la práctica se cobra lo que suman los
    // remitos elegidos, y tipearlo aparte es una fuente de errores. Sigue
    // siendo editable a mano para pagos parciales o con descuento.
    const delta = estaba ? -Number(total) : Number(total);
    const nuevoMonto = Math.max(0, Number(monto || 0) + delta).toFixed(2);
    setMonto(nuevoMonto);
    // Con un solo método, el monto de la línea sigue al total: obligar a
    // re-tipearlo sería pedir dos veces el mismo número.
    setPagos((prev) => (prev.length === 1 ? [{ ...prev[0]!, monto: nuevoMonto }] : prev));
  }

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
          <LineasDePago
            lineas={pagos}
            onChange={setPagos}
            cuentas={cuentas}
            total={Number(monto || 0)}
          />
          {remitosPendientes.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">
                ¿Qué remitos salda este cobro? (opcional)
              </label>
              <div className="max-h-40 overflow-y-auto border border-cream-300 rounded divide-y divide-cream-200">
                {remitosPendientes.map((r) => (
                  <label
                    key={r.id}
                    className="flex items-center gap-2 px-2 py-1.5 hover:bg-cream-100 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={imputados.has(r.id)}
                      onChange={() => toggleRemito(r.id, r.total)}
                    />
                    <span className="font-mono text-xs text-ink-700">#{r.numero}</span>
                    <span className="text-2xs text-ink-500">
                      {new Date(r.fecha).toLocaleDateString('es-AR', {
                        timeZone: 'America/Argentina/Buenos_Aires',
                      })}
                    </span>
                    <span className="ml-auto font-mono text-xs text-ink-900">
                      ${Number(r.total).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </span>
                  </label>
                ))}
              </div>
              {imputados.size > 0 && (
                <p className="text-2xs text-ink-500 mt-1">
                  {imputados.size} remito{imputados.size > 1 ? 's' : ''} · $
                  {totalImputado.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                  {Math.abs(totalImputado - Number(monto || 0)) > 0.009 && (
                    <span className="text-saffron-600">
                      {' '}
                      · el monto cobrado no coincide con lo seleccionado
                    </span>
                  )}
                </p>
              )}
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

// ────────────────────────────────────────────────────────────────────────
//   Estado del remito
// ────────────────────────────────────────────────────────────────────────

function EstadoRemitoBadge({ remito }: { remito: Remito }) {
  if (remito.estado === 'ANULADO') return <span className="text-pomodoro-600">anulado</span>;
  if (remito.estado === 'PAGADO') return <span className="text-basil-600">cobrado</span>;
  // Pendiente es el estado que pide acción: saffron lo destaca sin la carga
  // de alarma del rojo (que acá significa anulado).
  return <span className="text-saffron-600">pendiente</span>;
}

// ────────────────────────────────────────────────────────────────────────
//   Modal detalle de remito — ver qué se cargó, editar, cobrar, imprimir
// ────────────────────────────────────────────────────────────────────────

function ModalRemito({
  clienteId,
  remito,
  onClose,
  onImprimir,
  onPagar,
  onAnular,
}: {
  clienteId: string;
  remito: Remito;
  onClose: () => void;
  onImprimir: () => void;
  onPagar: (pagado: boolean) => void;
  onAnular: () => void;
}) {
  const items = remito.items ?? [];
  const editable = remito.estado === 'PENDIENTE';

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-2xl p-5 shadow-modal max-h-[90vh] flex flex-col">
        <header className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="font-display text-lg text-teresita-700">Remito #{remito.numero}</h2>
            <p className="text-xs text-ink-500">
              {fechaLarga(remito.fecha)} · <EstadoRemitoBadge remito={remito} />
              {remito.pagadoAt && ` · cobrado el ${fechaLarga(remito.pagadoAt)}`}
            </p>
          </div>
          <MoneyAmount value={remito.total} hero className="text-lg text-ink-900" />
        </header>

        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-sm text-ink-500 py-6 text-center">
              {remito.itemsCount} ítems — sin detalle cargado.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
                <tr>
                  <th className="text-left py-2">Producto</th>
                  <th className="text-right py-2">Cant.</th>
                  <th className="text-right py-2">P. unit.</th>
                  <th className="text-right py-2">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {items.map((it, i) => (
                  <tr key={i}>
                    <td className="py-2 text-ink-700">{it.nombre}</td>
                    <td className="py-2 text-right font-mono text-ink-700">
                      {Number(it.cantidad).toLocaleString('es-AR')}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-500">
                      ${money(it.precioUnitario)}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-900">
                      ${money(it.subtotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {remito.observaciones && (
            <p className="mt-3 text-xs text-ink-500">Obs: {remito.observaciones}</p>
          )}
        </div>

        <footer className="mt-4 pt-3 border-t border-cream-300 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
          <Button variant="secondary" onClick={onImprimir}>
            🖨 Imprimir
          </Button>
          {editable && (
            <Link href={`/admin/mayoristas/${clienteId}/remito?editar=${remito.id}`}>
              <Button variant="secondary">Editar</Button>
            </Link>
          )}
          {remito.estado !== 'ANULADO' &&
            (remito.estado === 'PAGADO' ? (
              <Button variant="secondary" onClick={() => onPagar(false)}>
                Volver a pendiente
              </Button>
            ) : (
              <Button onClick={() => onPagar(true)}>Marcar cobrado</Button>
            ))}
          {remito.estado !== 'ANULADO' && (
            <button onClick={onAnular} className="text-pomodoro-600 hover:underline text-sm px-2">
              Anular
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
