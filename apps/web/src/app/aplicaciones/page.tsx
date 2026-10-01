'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

/**
 * Los pedidos que entran por las apps, para el mostrador. Cada tarjeta lleva
 * los DOS números: el id de la plataforma (para buscarlo en su portal) y el
 * número de orden nuestro (para buscarlo en el POS). Se refresca sola cada
 * 10 segundos; un pedido nuevo sin responder se marca y suena.
 */

interface Pedido {
  id: string;
  numero: number;
  numeroOrdenTurno: number;
  canal: string;
  idPlataforma: string | null;
  modalidad: string;
  estado: 'PROCESADA' | 'FINALIZADA' | 'ANULADA';
  enPlataforma: 'SIN_RESPUESTA' | 'TOMADA' | 'RECHAZADA' | 'LISTA';
  total: string;
  fechaApertura: string;
  fechaAnulacion: string | null;
  motivoAnulacion: string | null;
  observaciones: string | null;
  tieneCocina: boolean;
  comandaImpresa: boolean;
  cliente: { id: string | null; nombre: string | null; telefono: string | null } | null;
  entrega: { direccion: string | null; indicaciones: string | null; estado: string | null } | null;
  items: Array<{ id: string; nombre: string; cantidad: string; unidad: string; precioUnitario: string; total: string; observacion: string | null; modificadores: Array<{ grupo: string; opcion: string }> }>;
  extras: {
    metodoEntrega?: string; medioPago?: string; tiempoCocinaMin?: number; creadoEnRappi?: string; agendadoPara?: string | null;
    totalRappi?: number; totalAPagar?: number; envio?: number; propina?: number;
    cliente?: { nombre?: string; telefono?: string; email?: string };
    entrega?: Record<string, string | number | boolean>;
  } | null;
}

const CANCEL_TYPES = [
  ['ITEM_OUT_OF_STOCK', 'Sin stock de un producto'],
  ['ITEM_NOT_FOUND', 'Un producto no existe'],
  ['ITEM_WRONG_PRICE', 'Precio equivocado'],
  ['ORDER_MISSING_INFORMATION', 'Falta información'],
  ['ORDER_MISSING_ADDRESS_INFORMATION', 'Falta la dirección'],
  ['ORDER_TOTAL_INCORRECT', 'Total incorrecto'],
] as const;
const etiquetaCancel = (v: string): string => CANCEL_TYPES.find(([k]) => k === v)?.[1] ?? '';

const CANAL_LABEL: Record<string, string> = { RAPPI: 'RAPPI', PEDIDOS_YA: 'PedidosYa', MERCADO_LIBRE: 'Mercado Libre' };
const PAGO_LABEL: Record<string, string> = { cc: 'tarjeta por la app', cash: 'efectivo al repartidor', rappipay: 'RappiPay', rappi_pay: 'RappiPay' };
const ENTREGA_LABEL: Record<string, string> = {
  address: 'Dirección', full_address: 'Dirección', street: 'Calle', address_line: 'Dirección', direccion: 'Dirección', city: 'Ciudad', neighborhood: 'Barrio',
  complement: 'Piso / depto', apartment: 'Depto', floor: 'Piso', reference: 'Referencia', instructions: 'Indicaciones', notes: 'Notas', phone: 'Teléfono',
  latitude: 'Lat', longitude: 'Long', lat: 'Lat', lng: 'Long', delivery_code: 'Código de entrega', pickup_code: 'Código de retiro', code: 'Código',
};

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' });
}
function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit' });
}
function hace(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}
function esHoy(iso: string): boolean {
  const f = (d: Date) => d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  return f(new Date(iso)) === f(new Date());
}

/** Dos pitidos cortos, sin archivo de audio. Si el navegador no deja, no pasa nada. */
function sonar() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.25].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.15);
    });
  } catch {
    /* sin sonido */
  }
}

function Chip({ tono, texto, title }: { tono: 'verde' | 'rojo' | 'naranja' | 'gris'; texto: string; title?: string }) {
  return (
    <span title={title} className={cn('text-2xs px-2 py-0.5 rounded-full whitespace-nowrap font-medium',
      tono === 'verde' ? 'bg-teresita-100 text-teresita-900' : tono === 'rojo' ? 'bg-pomodoro-100 text-pomodoro-600' : tono === 'naranja' ? 'bg-saffron-100 text-saffron-600' : 'bg-cream-200 text-ink-700')}>
      {texto}
    </span>
  );
}

function Copiable({ valor, className }: { valor: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" title="Copiar" className={cn('font-mono hover:underline', className)}
      onClick={() => { void navigator.clipboard?.writeText(valor); setOk(true); setTimeout(() => setOk(false), 1200); }}>
      {valor}{ok ? ' ✓' : ''}
    </button>
  );
}

export default function AplicacionesPage() {
  const [pedidos, setPedidos] = useState<Pedido[] | null>(null);
  const [tomarAutomatico, setTomarAutomatico] = useState(false);
  const [vista, setVista] = useState<'activos' | 'todos'>('activos');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [resultados, setResultados] = useState<Record<string, { ok: boolean; detalle: string }>>({});
  const [rechazo, setRechazo] = useState<{ id: string; tipo: string; motivo: string } | null>(null);
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const [sonido, setSonido] = useState(true);
  const vistosRef = useRef<Set<string> | null>(null);
  const ocupadoRef = useRef<string | null>(null);
  ocupadoRef.current = ocupado;

  const cargar = useCallback(async (silencioso = false) => {
    try {
      const r = await api.get<{ pedidos: Pedido[]; tomarAutomatico: boolean }>(`/aplicaciones/pedidos?vista=${vista}&limite=60`);
      setTomarAutomatico(r.tomarAutomatico);
      setPedidos(r.pedidos);
      setError(null);
      // Pedido nuevo sin responder → suena (sólo a partir de la segunda carga,
      // para no pitar por los que ya estaban al abrir la pestaña).
      const ids = new Set(r.pedidos.map((p) => p.id));
      if (vistosRef.current && silencioso) {
        const nuevos = r.pedidos.filter((p) => !vistosRef.current!.has(p.id) && p.enPlataforma === 'SIN_RESPUESTA' && p.estado !== 'ANULADA');
        if (nuevos.length && sonido) sonar();
      }
      vistosRef.current = ids;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { window.location.href = '/login'; return; }
      setError(e instanceof Error ? e.message : 'No se pudo cargar');
    }
  }, [vista, sonido]);

  useEffect(() => { vistosRef.current = null; void cargar(); }, [cargar]);
  useEffect(() => {
    const id = setInterval(() => { if (ocupadoRef.current === null && !document.hidden) void cargar(true); }, 10_000);
    return () => clearInterval(id);
  }, [cargar]);

  async function accion(p: Pedido, que: 'tomar' | 'lista' | 'rechazar', body?: unknown) {
    setOcupado(p.id);
    try {
      const r = await api.post<{ ok: boolean; detalle?: string; status?: number }>(`/aplicaciones/pedidos/${p.id}/${que}`, body ?? {});
      setResultados((prev) => ({ ...prev, [p.id]: { ok: r.ok, detalle: r.detalle ?? (r.ok ? 'listo' : `RAPPI respondió ${r.status ?? ''}`) } }));
    } catch (e) {
      setResultados((prev) => ({ ...prev, [p.id]: { ok: false, detalle: e instanceof Error ? e.message : 'No se pudo' } }));
    } finally {
      setOcupado(null);
      void cargar();
    }
  }

  const toggle = (id: string) => setAbiertos((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const sinResponder = (pedidos ?? []).filter((p) => p.enPlataforma === 'SIN_RESPUESTA' && p.estado !== 'ANULADA').length;

  return (
    <div className="p-3 lg:p-6 max-w-5xl mx-auto space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="font-display text-xl text-ink-900">Pedidos de las apps</h1>
          {sinResponder > 0 && <Chip tono="rojo" texto={`${sinResponder} sin responder`} />}
          {tomarAutomatico
            ? <Chip tono="verde" texto="se toman solos al llegar" title="Configurado en Admin → Integraciones → RAPPI" />
            : <Chip tono="naranja" texto="hay que tomarlos a mano (6 min)" title="RAPPI cancela sola lo que no se toma en 6 minutos" />}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1 cursor-pointer text-ink-700">
            <input type="checkbox" checked={sonido} onChange={(e) => setSonido(e.target.checked)} /> sonido
          </label>
          <div className="flex rounded-lg overflow-hidden border border-cream-300">
            {(['activos', 'todos'] as const).map((v) => (
              <button key={v} type="button" onClick={() => setVista(v)}
                className={cn('px-3 py-1', vista === v ? 'bg-saffron-600 text-white' : 'bg-white text-ink-700 hover:bg-cream-100')}>
                {v === 'activos' ? 'Últimas 24 h' : 'Todos'}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={() => void cargar()}>Actualizar</Button>
        </div>
      </div>
      <p className="text-2xs text-ink-500">Se actualiza sola cada 10 segundos. Cada pedido tiene su número de RAPPI (para buscarlo en el portal) y su número de orden del POS.</p>
      {error && <p className="text-sm text-pomodoro-600">{error}</p>}

      {pedidos === null ? (
        <p className="text-sm text-ink-500">Cargando…</p>
      ) : pedidos.length === 0 ? (
        <div className="card p-8 text-center text-ink-500">
          {vista === 'activos' ? 'No entró ningún pedido por las apps en las últimas 24 horas.' : 'Todavía no entró ningún pedido por las apps.'}
        </div>
      ) : (
        <div className="space-y-2">
          {pedidos.map((p) => {
            const viva = p.estado !== 'ANULADA';
            const nuevo = viva && p.enPlataforma === 'SIN_RESPUESTA';
            const puedeTomar = nuevo;
            const puedeListo = viva && p.enPlataforma === 'TOMADA';
            const puedeRechazar = nuevo;
            const abierto = abiertos.has(p.id);
            const res = resultados[p.id];
            const retira = p.modalidad === 'TAKE_AWAY';
            const entregaExtra = p.extras?.entrega ? Object.entries(p.extras.entrega).filter(([k]) => !/^(lat|lng|latitude|longitude)$/.test(k)) : [];
            return (
              <div key={p.id} className={cn('card p-3 lg:p-4 space-y-2 border-l-4', nuevo ? 'border-l-pomodoro-600 ring-2 ring-pomodoro-600/30' : p.estado === 'ANULADA' ? 'border-l-ink-300 opacity-70' : p.enPlataforma === 'LISTA' ? 'border-l-teresita-500' : 'border-l-saffron-600')}>
                {/* ── cabecera: los dos números ── */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Chip tono="naranja" texto={CANAL_LABEL[p.canal] ?? p.canal} />
                  <span className="font-display text-lg text-ink-900">#{p.numeroOrdenTurno}</span>
                  <span className="text-xs text-ink-500">orden POS <span className="font-mono text-ink-700">{p.numero}</span></span>
                  {p.idPlataforma && (
                    <span className="text-xs text-ink-500">{CANAL_LABEL[p.canal] ?? p.canal} <Copiable valor={p.idPlataforma} className="text-ink-900" /></span>
                  )}
                  <span className="text-xs text-ink-500">{esHoy(p.fechaApertura) ? hora(p.fechaApertura) : `${fechaCorta(p.fechaApertura)} ${hora(p.fechaApertura)}`} · {hace(p.fechaApertura)}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <Chip tono="gris" texto={retira ? 'retira en el local' : 'delivery de la app'} />
                    <Chip tono={p.estado === 'ANULADA' ? 'rojo' : p.enPlataforma === 'SIN_RESPUESTA' ? 'rojo' : p.enPlataforma === 'RECHAZADA' ? 'gris' : 'verde'}
                      texto={p.estado === 'ANULADA' ? 'anulada' : p.enPlataforma === 'TOMADA' ? 'tomada' : p.enPlataforma === 'RECHAZADA' ? 'rechazada' : p.enPlataforma === 'LISTA' ? 'lista para retiro' : 'sin responder'} />
                    <MoneyAmount value={p.total} className="text-md font-medium" />
                  </span>
                </div>

                {/* ── ítems ── */}
                <ul className="text-sm text-ink-900 space-y-0.5">
                  {p.items.map((i) => (
                    <li key={i.id} className="flex flex-wrap gap-x-2">
                      <span className="font-medium">{Number(i.cantidad) % 1 === 0 ? Number(i.cantidad) : i.cantidad}×</span>
                      <span>{i.nombre}</span>
                      {i.modificadores.length > 0 && <span className="text-ink-500">({i.modificadores.map((m) => m.opcion).filter(Boolean).join(', ')})</span>}
                      {i.observacion && <span className="text-saffron-600 italic">“{i.observacion}”</span>}
                      <MoneyAmount value={i.total} className="ml-auto text-xs text-ink-500" />
                    </li>
                  ))}
                </ul>

                {/* ── cliente y entrega ── */}
                {(p.cliente || p.entrega || entregaExtra.length > 0) && (
                  <div className="text-xs text-ink-700 flex flex-wrap gap-x-4 gap-y-0.5">
                    {p.cliente?.nombre && (
                      <span>👤 {p.cliente.id ? <Link href={`/admin/clientes/${p.cliente.id}`} className="hover:underline">{p.cliente.nombre}</Link> : p.cliente.nombre}{p.cliente.telefono && <> · 📞 {p.cliente.telefono}</>}</span>
                    )}
                    {p.entrega?.direccion && <span>📍 {p.entrega.direccion}</span>}
                    {p.entrega?.indicaciones && <span className="italic">{p.entrega.indicaciones}</span>}
                  </div>
                )}

                {/* ── acciones ── */}
                {p.idPlataforma && p.canal === 'RAPPI' && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button size="sm" disabled={ocupado !== null || !puedeTomar} title={puedeTomar ? undefined : 'Ya se respondió'} onClick={() => void accion(p, 'tomar')}>
                      {p.enPlataforma === 'TOMADA' || p.enPlataforma === 'LISTA' ? 'Tomada' : 'Tomar'}
                    </Button>
                    <Button variant="secondary" size="sm" disabled={ocupado !== null || !puedeListo} title={puedeListo ? undefined : p.enPlataforma === 'LISTA' ? 'Ya avisada' : 'Primero hay que tomarla'} onClick={() => void accion(p, 'lista')}>
                      {p.enPlataforma === 'LISTA' ? 'Lista' : 'Listo'}
                    </Button>
                    <Button variant={rechazo?.id === p.id ? 'destructive' : 'secondary'} size="sm" disabled={ocupado !== null || !puedeRechazar}
                      title={puedeRechazar ? undefined : p.enPlataforma === 'RECHAZADA' ? 'Ya rechazada' : 'Una orden tomada no se rechaza: se cancela desde RAPPI'}
                      onClick={() => setRechazo(rechazo?.id === p.id ? null : { id: p.id, tipo: 'ORDER_MISSING_INFORMATION', motivo: etiquetaCancel('ORDER_MISSING_INFORMATION') })}>
                      {p.enPlataforma === 'RECHAZADA' ? 'Rechazada' : 'Rechazar'}
                    </Button>
                    <button type="button" className="text-xs text-ink-500 hover:underline ml-1" onClick={() => toggle(p.id)}>{abierto ? 'menos detalle' : 'más detalle'}</button>
                    <Link href={`/venta/${p.id}`} className="text-xs text-teresita-700 hover:underline ml-auto">ver en el POS →</Link>
                  </div>
                )}
                {rechazo?.id === p.id && (
                  <div className="rounded-lg border border-pomodoro-600/30 bg-pomodoro-100/40 p-3 space-y-2 text-sm">
                    <p className="font-medium text-ink-900">Rechazar el pedido #{p.numeroOrdenTurno} en RAPPI</p>
                    <select className="input w-full" value={rechazo.tipo}
                      onChange={(e) => setRechazo({ ...rechazo, tipo: e.target.value, motivo: rechazo.motivo.trim() === etiquetaCancel(rechazo.tipo) ? etiquetaCancel(e.target.value) : rechazo.motivo })}>
                      {CANCEL_TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                    </select>
                    <input className="input w-full" autoFocus maxLength={300} placeholder="Motivo (lo ve RAPPI)" value={rechazo.motivo} onChange={(e) => setRechazo({ ...rechazo, motivo: e.target.value })} />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={!rechazo.motivo.trim() || ocupado !== null}
                        onClick={() => { const rj = rechazo; setRechazo(null); void accion(p, 'rechazar', { cancelType: rj.tipo, reason: rj.motivo.trim() }); }}>
                        Confirmar rechazo
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setRechazo(null)}>No rechazar</Button>
                    </div>
                  </div>
                )}
                {res && <p className={cn('text-xs', res.ok ? 'text-teresita-900' : 'text-pomodoro-600')}>{res.ok ? '✓' : '✗'} {res.detalle}</p>}
                {p.estado === 'ANULADA' && p.motivoAnulacion && <p className="text-xs text-pomodoro-600">Anulada: {p.motivoAnulacion}</p>}

                {/* ── detalle de la app ── */}
                {abierto && (
                  <div className="rounded-lg bg-cream-50 border border-cream-200 p-3 text-xs text-ink-700 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {p.extras?.medioPago && <div><span className="text-ink-500">Pagó:</span> {PAGO_LABEL[p.extras.medioPago] ?? p.extras.medioPago}</div>}
                    {typeof p.extras?.tiempoCocinaMin === 'number' && <div><span className="text-ink-500">Tiempo de cocina pedido:</span> {p.extras.tiempoCocinaMin} min</div>}
                    {p.extras?.metodoEntrega && <div><span className="text-ink-500">Tipo de entrega:</span> {p.extras.metodoEntrega}</div>}
                    {p.extras?.agendadoPara && <div><span className="text-ink-500">Agendado para:</span> {p.extras.agendadoPara}</div>}
                    {typeof p.extras?.totalRappi === 'number' && <div><span className="text-ink-500">Total en {CANAL_LABEL[p.canal] ?? p.canal}:</span> ${p.extras.totalRappi.toLocaleString('es-AR')}</div>}
                    {typeof p.extras?.envio === 'number' && p.extras.envio > 0 && <div><span className="text-ink-500">Envío que cobra la app:</span> ${p.extras.envio.toLocaleString('es-AR')}</div>}
                    {typeof p.extras?.propina === 'number' && p.extras.propina > 0 && <div><span className="text-ink-500">Propina:</span> ${p.extras.propina.toLocaleString('es-AR')}</div>}
                    {p.extras?.cliente?.email && <div><span className="text-ink-500">Email:</span> {p.extras.cliente.email}</div>}
                    {entregaExtra.map(([k, v]) => <div key={k}><span className="text-ink-500">{ENTREGA_LABEL[k] ?? k}:</span> {String(v)}</div>)}
                    {p.observaciones && <div className="sm:col-span-2"><span className="text-ink-500">Notas:</span> {p.observaciones}</div>}
                    <div className="sm:col-span-2 text-ink-500">
                      {p.tieneCocina ? (p.comandaImpresa ? 'Comanda de cocina impresa.' : 'Comanda de cocina pendiente de imprimir.') : 'Sin comanda de cocina.'}
                      {p.extras?.creadoEnRappi && <> · Creado en la app: {p.extras.creadoEnRappi}</>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
