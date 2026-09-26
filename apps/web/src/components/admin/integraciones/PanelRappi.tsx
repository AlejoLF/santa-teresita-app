'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

/**
 * El panel de RAPPI dentro de Configuración → Integraciones.
 *
 * Cada botón es una capacidad del checklist de certificación de RAPPI
 * (docs/RAPPI-INTEGRACION.md). El orden de las secciones es el orden en que
 * hay que hacer las cosas: credenciales → tienda → webhooks → menú → órdenes.
 * Abajo de todo, el registro de cada llamada que le hicimos a RAPPI, con lo que
 * respondió — el espejo del buzón.
 */

interface Estado {
  ambiente: 'dev' | 'prod';
  dominios: { legacy: string; nuevo: string };
  credencialesConfiguradas: boolean;
  firmaConfigurada: boolean;
  ingestaConfigurada: boolean;
  /** Lo que el server encontró raro en sus variables RAPPI_*, y desde cuándo corre. */
  entorno: {
    problemas: Array<{ variable: string; problema: string; grave: boolean }>;
    version: string;
    arrancoAt: string;
    rol: string;
  };
  config: {
    storeId: string | null;
    storeNombre: string | null;
    storeIntegrationId: string | null;
    clientIntegrationId: string | null;
    tomarAutomatico: boolean;
    tiempoCocinaMin: number | null;
    menu: { enviadoAt: string | null; items: number | null; estado: string | null; estadoAt: string | null };
  };
  webhooks: { base: string; esLocal: boolean; porEvento: Record<string, string> | null; ultimoPingAt: string | null };
  catalogo: { publicables: number; sinCodigo: number; porPesoSinCantidad: number };
  ultimaLlamada: { hechoAt: string; ok: boolean; contexto: string | null; status: number | null } | null;
  registroListo: boolean;
}

interface Tienda { integrationId: string; rappiId: string; name: string }

interface Llamada {
  id: string; hechoAt: string; metodo: string; ruta: string; contexto: string | null;
  status: number | null; ok: boolean; ms: number; requestBody: unknown; responseBody: unknown;
  responseTexto: string | null; error: string | null;
}

interface OrdenRappi {
  id: string; numero: number; estado: string; total: string; fechaApertura: string;
  idExternoCanal: string | null; enRappi: string;
  items: Array<{ nombreSnapshot: string; cantidad: string }>;
}

const EVENTOS_A_CARGAR: Array<{ evento: string; para: string }> = [
  { evento: 'NEW_ORDER', para: 'Pedidos nuevos' },
  { evento: 'ORDER_EVENT_CANCEL', para: 'Cancelaciones (REQUERIDO)' },
  { evento: 'PING', para: 'PING (RAPPI chequea que estemos vivos)' },
  { evento: 'MENU_APPROVED', para: 'Menú aprobado' },
  { evento: 'MENU_REJECTED', para: 'Menú rechazado' },
  { evento: 'STORE_CONNECTIVITY', para: 'Tienda conectada / desconectada' },
  { evento: 'STORE_PROVISIONING_STATUS', para: 'Resultado del aprovisionamiento' },
];

const CANCEL_TYPES = [
  ['ITEM_OUT_OF_STOCK', 'Sin stock de un producto'],
  ['ITEM_NOT_FOUND', 'Un producto no existe'],
  ['ITEM_WRONG_PRICE', 'Precio equivocado'],
  ['ORDER_MISSING_INFORMATION', 'Falta información'],
  ['ORDER_MISSING_ADDRESS_INFORMATION', 'Falta la dirección'],
  ['ORDER_TOTAL_INCORRECT', 'Total incorrecto'],
] as const;

function hora(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fechaHora(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** "hace 3 min" / "hace 2 h" / "hace 5 días", para que se lea sin hacer cuentas. */
function hace(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

function Copiable({ valor, etiqueta }: { valor: string; etiqueta: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="rounded-lg border border-cream-300 bg-cream-50 p-2.5">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-2xs uppercase tracking-wider text-ink-500">{etiqueta}</span>
        <button type="button" className="text-2xs text-teresita-700 hover:underline shrink-0"
          onClick={() => { void navigator.clipboard?.writeText(valor); setCopiado(true); setTimeout(() => setCopiado(false), 1500); }}>
          {copiado ? '✓ copiado' : 'copiar'}
        </button>
      </div>
      <p className="font-mono text-2xs text-ink-900 break-all">{valor}</p>
    </div>
  );
}

function Chip({ ok, texto }: { ok: boolean | null; texto: string }) {
  return (
    <span className={cn('text-2xs px-2 py-0.5 rounded-full whitespace-nowrap',
      ok === null ? 'bg-cream-200 text-ink-700' : ok ? 'bg-teresita-100 text-teresita-900' : 'bg-pomodoro-100 text-pomodoro-600')}>
      {texto}
    </span>
  );
}

/** Lo que RAPPI respondió, en criollo, para mostrarlo debajo del botón que se tocó. */
function Resultado({ r }: { r: { ok?: boolean; status?: number; explicacion?: string | null; error?: string; detalle?: string; mensaje?: string | null } | null }) {
  if (!r) return null;
  const ok = r.ok ?? !r.error;
  return (
    <p className={cn('text-xs mt-1', ok ? 'text-teresita-900' : 'text-pomodoro-600')}>
      {ok ? '✓' : '✗'} {r.detalle ?? r.mensaje ?? r.explicacion ?? r.error ?? (r.status ? `RAPPI respondió ${r.status}` : 'listo')}
    </p>
  );
}

export function PanelRappi() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [tiendas, setTiendas] = useState<Tienda[] | null>(null);
  const [llamadas, setLlamadas] = useState<Llamada[]>([]);
  const [ordenes, setOrdenes] = useState<OrdenRappi[]>([]);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [res, setRes] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [menuPreview, setMenuPreview] = useState<{ resumen: { productos: number; toppings: number; categorias: number; excluidos: Array<{ nombre: string; motivo: string }>; combosOmitidos: number; lista: string } } | null>(null);
  const [clientId, setClientId] = useState('');
  const [tiempoCocina, setTiempoCocina] = useState('');
  const [rechazo, setRechazo] = useState<{ id: string; tipo: string; motivo: string } | null>(null);

  const cargar = useCallback(async () => {
    const [e, l, o] = await Promise.allSettled([
      api.get<Estado>('/admin/rappi/estado'),
      api.get<{ llamadas: Llamada[] }>('/admin/rappi/llamadas?limite=30'),
      api.get<{ ordenes: OrdenRappi[] }>('/admin/rappi/ordenes?limite=15'),
    ]);
    if (e.status === 'fulfilled') {
      setEstado(e.value);
      setClientId(e.value.config.clientIntegrationId ?? '');
      setTiempoCocina(e.value.config.tiempoCocinaMin?.toString() ?? '');
    }
    if (l.status === 'fulfilled') setLlamadas(l.value.llamadas);
    if (o.status === 'fulfilled') setOrdenes(o.value.ordenes);
    const f = [e, l, o].find((x) => x.status === 'rejected');
    setError(f && f.status === 'rejected' ? (f.reason instanceof Error ? f.reason.message : 'No se pudo cargar') : null);
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  /** Corre una acción contra RAPPI, guarda lo que respondió bajo `clave`, y refresca. */
  async function accion(clave: string, fn: () => Promise<unknown>) {
    setOcupado(clave);
    try {
      const r = await fn();
      setRes((prev) => ({ ...prev, [clave]: r }));
    } catch (e) {
      setRes((prev) => ({ ...prev, [clave]: { ok: false, error: e instanceof Error ? e.message : 'falló' } }));
    } finally {
      setOcupado(null);
      void cargar();
    }
  }
  const r = (clave: string) => (res[clave] as never) ?? null;
  const cfg = estado?.config;
  const storeId = cfg?.storeId;

  if (!estado) return <section className="card p-5"><p className="text-sm text-ink-500">Cargando RAPPI…</p></section>;

  return (
    <section className="card p-5 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg text-teresita-700">RAPPI — integración</h2>
          <p className="text-sm text-ink-500">
            Lo que RAPPI nos pide para certificar: cada botón es un ítem de su lista. Ambiente{' '}
            <strong>{estado.ambiente === 'dev' ? 'de prueba (DEV)' : 'PRODUCCIÓN'}</strong>.
          </p>
          <p className="text-xs text-ink-500 mt-1">
            El server que responde es la versión <span className="font-mono">{estado.entorno.version}</span> y arrancó el{' '}
            {fechaHora(estado.entorno.arrancoAt)} ({hace(estado.entorno.arrancoAt)}). Si cambiaste variables después de esa hora, ese cambio todavía no está corriendo.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void cargar()}>Actualizar</Button>
      </div>
      {error && <p className="text-sm text-pomodoro-600">{error}</p>}

      {/* ── 1. Credenciales ── */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <Chip ok={estado.credencialesConfiguradas} texto={estado.credencialesConfiguradas ? 'credenciales cargadas' : 'faltan RAPPI_CLIENT_ID / SECRET'} />
        <Chip ok={estado.ingestaConfigurada} texto={estado.ingestaConfigurada ? 'ingesta prendida' : 'falta CHANNEL_INGEST_TOKEN'} />
        <Chip ok={estado.firmaConfigurada} texto={estado.firmaConfigurada ? 'firma de webhooks exigida' : 'sin RAPPI_WEBHOOK_SECRET: se acepta todo'} />
        <Chip ok={storeId ? true : null} texto={storeId ? `tienda ${cfg?.storeNombre ?? storeId}` : 'sin tienda elegida'} />
        <Chip ok={estado.webhooks.ultimoPingAt ? true : null} texto={estado.webhooks.ultimoPingAt ? `último PING ${hora(estado.webhooks.ultimoPingAt)}` : 'RAPPI todavía no hizo PING'} />
      </div>
      {estado.entorno.problemas.length > 0 && (
        <div className={cn('rounded-lg border p-3 text-sm text-ink-700', estado.entorno.problemas.some((p) => p.grave) ? 'border-pomodoro-600/30 bg-pomodoro-100' : 'border-saffron-600/30 bg-saffron-100')}>
          {!estado.credencialesConfiguradas && (
            <p className="mb-2"><strong>Todo lo que va hacia RAPPI está apagado.</strong> Los pedidos que RAPPI mande igual entran.</p>
          )}
          <p className="mb-1">En las variables del server ({estado.entorno.rol === 'cloud' ? 'Railway → el servicio de la API → Variables' : 'el .env del server'}):</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {estado.entorno.problemas.map((p, i) => (
              <li key={i} className={p.grave ? '' : 'text-ink-500'}>
                <code className="font-mono">{p.variable}</code> {p.problema}
              </li>
            ))}
          </ul>
          {!estado.credencialesConfiguradas && (
            <p className="mt-2 text-xs text-ink-500">
              Si en Railway las ves cargadas: fijate que estén en el servicio de la API (no en otro servicio ni sólo como variables compartidas del proyecto), con el nombre exacto, y que el último deploy en <em>Deployments</em> esté en verde — si falló, sigue corriendo el anterior. La hora de arranque de arriba dice qué deploy es el que está respondiendo.
            </p>
          )}
        </div>
      )}
      {estado.credencialesConfiguradas && (
        <div>
          <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion('cred', () => api.post('/admin/rappi/credenciales/probar', {}))}>
            {ocupado === 'cred' ? 'Probando…' : 'Probar credenciales'}
          </Button>
          <Resultado r={r('cred')} />
        </div>
      )}

      {/* ── 2. Tienda ── */}
      <div className="border-t border-cream-200 pt-4 space-y-2">
        <h3 className="font-medium text-ink-900">1 · Tienda</h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={ocupado !== null || !estado.credencialesConfiguradas}
            onClick={() => void accion('tiendas', async () => { const x = await api.post<{ tiendas: Tienda[] }>('/admin/rappi/tiendas/listar', {}); setTiendas(x.tiendas); return { ok: true, detalle: `${x.tiendas.length} tienda(s)` }; })}>
            {ocupado === 'tiendas' ? 'Consultando…' : 'Listar tiendas'}
          </Button>
          {storeId && (
            <>
              <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion('integrada', () => api.put(`/admin/rappi/tiendas/${storeId}/integrada`, { integrada: true }))}>Activar integración</Button>
              <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion('integrada', () => api.put(`/admin/rappi/tiendas/${storeId}/integrada`, { integrada: false }))}>Desactivar</Button>
              <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion('abierta', () => api.put(`/admin/rappi/tiendas/${storeId}/habilitada`, { habilitada: true }))}>Abrir tienda</Button>
              <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion('abierta', () => api.put(`/admin/rappi/tiendas/${storeId}/habilitada`, { habilitada: false }))}>Cerrar tienda</Button>
              <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion('horarios', () => api.post(`/admin/rappi/tiendas/${storeId}/horarios`, {}))}>Enviar horarios (los de los turnos)</Button>
              <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion('aprov', () => api.post(`/admin/rappi/tiendas/${storeId}/aprovisionar`, { nombre: cfg?.storeNombre ?? 'Santa Teresita' }))}>Aprovisionar (auto-onboarding)</Button>
            </>
          )}
        </div>
        <Resultado r={r('tiendas')} /><Resultado r={r('integrada')} /><Resultado r={r('abierta')} /><Resultado r={r('horarios')} /><Resultado r={r('aprov')} />
        {tiendas && tiendas.length > 1 && (
          <select className="input w-auto" value={storeId ?? ''} onChange={(e) => {
            const t = tiendas.find((x) => x.rappiId === e.target.value);
            if (t) void accion('elegir', () => api.put('/admin/rappi/config', { storeId: t.rappiId, storeNombre: t.name, storeIntegrationId: t.integrationId }));
          }}>
            <option value="">Elegí la tienda…</option>
            {tiendas.map((t) => <option key={t.rappiId} value={t.rappiId}>{t.name} ({t.rappiId})</option>)}
          </select>
        )}
      </div>

      {/* ── 3. Webhooks ── */}
      <div className="border-t border-cream-200 pt-4 space-y-2">
        <h3 className="font-medium text-ink-900">2 · Webhooks — las direcciones que RAPPI tiene que tener</h3>
        {estado.webhooks.esLocal && (
          <p className="text-2xs text-saffron-600">Estás en la app instalada: estas direcciones son de esta computadora. Abrí esto desde el navegador para las buenas.</p>
        )}
        <p className="text-xs text-ink-500">
          Una por evento. Se cargan a mano en el portal de RAPPI (módulo Webhooks), o con el botón si tenés el clientId de la integración.
          Llevan la clave adentro: no las pegues en un chat.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {estado.webhooks.porEvento && EVENTOS_A_CARGAR.map(({ evento, para }) => (
            <div key={evento} className="space-y-1">
              <Copiable etiqueta={`${evento} — ${para}`} valor={estado.webhooks.porEvento![evento]!} />
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" disabled={ocupado !== null || !cfg?.clientIntegrationId || estado.webhooks.esLocal}
                  onClick={() => void accion(`sus-${evento}`, () => api.post('/admin/rappi/webhooks/suscribir', { evento }))}>
                  Suscribir por API
                </Button>
                <Resultado r={r(`sus-${evento}`)} />
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-ink-700">clientId de la integración (lo da RAPPI):</label>
          <input className="input w-64 font-mono text-xs" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="por ejemplo 3f2a…" />
          <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion('clientid', () => api.put('/admin/rappi/config', { clientIntegrationId: clientId.trim() || null }))}>Guardar</Button>
        </div>
      </div>

      {/* ── 4. Menú ── */}
      <div className="border-t border-cream-200 pt-4 space-y-2">
        <h3 className="font-medium text-ink-900">3 · Menú</h3>
        <p className="text-xs text-ink-500">
          Se arma desde el catálogo con los precios de la lista RAPPI. {estado.catalogo.publicables} productos con código
          {estado.catalogo.sinCodigo > 0 && <span className="text-saffron-600"> · {estado.catalogo.sinCodigo} sin código (no se publican)</span>}
          {estado.catalogo.porPesoSinCantidad > 0 && <span className="text-saffron-600"> · {estado.catalogo.porPesoSinCantidad} por peso sin cantidad por defecto (no se publican)</span>}.
          {cfg?.menu.enviadoAt && <> Último envío {hora(cfg.menu.enviadoAt)} ({cfg.menu.items} productos) → <strong>{cfg.menu.estado ?? 'sin respuesta'}</strong>{cfg.menu.estadoAt && ` el ${hora(cfg.menu.estadoAt)}`}.</>}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion('preview', async () => { const m = await api.get<typeof menuPreview>('/admin/rappi/menu/vista-previa'); setMenuPreview(m); return { ok: true, detalle: `${m!.resumen.productos} productos, ${m!.resumen.toppings} sabores/extras, ${m!.resumen.categorias} categorías` }; })}>Vista previa</Button>
          <Button size="sm" disabled={ocupado !== null || !storeId} onClick={() => { if (confirm('¿Enviar el menú a RAPPI? Reemplaza el que tenga.')) void accion('menu', () => api.post('/admin/rappi/menu/enviar', {})); }}>Enviar menú a RAPPI</Button>
          <Button variant="secondary" size="sm" disabled={ocupado !== null || !storeId} onClick={() => void accion('menuest', () => api.get('/admin/rappi/menu/estado'))}>Consultar aprobación</Button>
        </div>
        <Resultado r={r('preview')} /><Resultado r={r('menu')} /><Resultado r={r('menuest')} />
        {menuPreview && menuPreview.resumen.excluidos.length > 0 && (
          <details className="text-xs text-ink-700">
            <summary className="cursor-pointer text-saffron-600">{menuPreview.resumen.excluidos.length} productos quedan afuera — ver por qué</summary>
            <ul className="mt-1 list-disc pl-5">{menuPreview.resumen.excluidos.map((x) => <li key={x.nombre}>{x.nombre}: {x.motivo}</li>)}</ul>
          </details>
        )}
      </div>

      {/* ── 5. Órdenes ── */}
      <div className="border-t border-cream-200 pt-4 space-y-2">
        <h3 className="font-medium text-ink-900">4 · Pedidos</h3>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-ink-700 cursor-pointer">
            <input type="checkbox" className="w-4 h-4" checked={cfg?.tomarAutomatico ?? false} disabled={ocupado !== null}
              onChange={(e) => void accion('auto', () => api.put('/admin/rappi/config', { tomarAutomatico: e.target.checked }))} />
            Tomar los pedidos automáticamente al llegar
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-700">
            tiempo de cocina (min)
            <input className="input w-20" type="number" min={1} max={180} value={tiempoCocina} onChange={(e) => setTiempoCocina(e.target.value)}
              onBlur={() => void accion('cocina', () => api.put('/admin/rappi/config', { tiempoCocinaMin: tiempoCocina ? Number(tiempoCocina) : null }))} />
          </label>
        </div>
        <p className="text-2xs text-ink-500">
          RAPPI cancela sola lo que no se toma en 6 minutos. Con esto apagado, hay que tomar cada pedido acá abajo.
        </p>
        {ordenes.length === 0 ? <p className="text-sm text-ink-500 italic">Todavía no entró ningún pedido de RAPPI.</p> : (
          <div className="divide-y divide-cream-200">
            {ordenes.map((o) => (
              <div key={o.id} className="py-2 flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink-900">#{o.numero} · <span className="font-mono text-xs">{o.idExternoCanal}</span> · {hora(o.fechaApertura)}</div>
                  <div className="text-2xs text-ink-500 truncate">{o.items.map((i) => `${i.cantidad}× ${i.nombreSnapshot}`).join(', ')}</div>
                </div>
                <MoneyAmount value={o.total} className="text-sm" />
                <Chip ok={o.estado === 'ANULADA' ? false : o.enRappi === 'SIN_RESPUESTA' ? null : true}
                  texto={o.estado === 'ANULADA' ? 'anulada' : o.enRappi === 'TOMADA' ? 'tomada' : o.enRappi === 'RECHAZADA' ? 'rechazada' : o.enRappi === 'LISTA' ? 'lista para retiro' : 'sin responder a RAPPI'} />
                {o.idExternoCanal && o.estado !== 'ANULADA' && (
                  <div className="flex gap-1">
                    <Button size="sm" disabled={ocupado !== null} onClick={() => void accion(`o-${o.id}`, () => api.post(`/admin/rappi/ordenes/${o.idExternoCanal}/tomar`, {}))}>Tomar</Button>
                    <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void accion(`o-${o.id}`, () => api.post(`/admin/rappi/ordenes/${o.idExternoCanal}/lista`, {}))}>Lista</Button>
                    <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => setRechazo({ id: o.idExternoCanal!, tipo: 'ORDER_MISSING_INFORMATION', motivo: '' })}>Rechazar</Button>
                  </div>
                )}
                <div className="w-full"><Resultado r={r(`o-${o.id}`)} /></div>
              </div>
            ))}
          </div>
        )}
        {rechazo && (
          <div className="rounded-lg border border-cream-300 p-3 space-y-2 text-sm">
            <p className="font-medium">Rechazar el pedido {rechazo.id}</p>
            <select className="input w-full" value={rechazo.tipo} onChange={(e) => setRechazo({ ...rechazo, tipo: e.target.value })}>
              {CANCEL_TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
            <input className="input w-full" placeholder="Motivo (lo ve RAPPI)" value={rechazo.motivo} onChange={(e) => setRechazo({ ...rechazo, motivo: e.target.value })} />
            <div className="flex gap-2">
              <Button size="sm" disabled={!rechazo.motivo.trim() || ocupado !== null} onClick={() => { const rj = rechazo; setRechazo(null); void accion('rechazo', () => api.post(`/admin/rappi/ordenes/${rj.id}/rechazar`, { cancelType: rj.tipo, reason: rj.motivo.trim() })); }}>Confirmar rechazo</Button>
              <Button variant="secondary" size="sm" onClick={() => setRechazo(null)}>Cancelar</Button>
            </div>
            <p className="text-2xs text-ink-500">Los motivos "por producto" exigen decir cuál: si RAPPI lo rechaza, usá "Falta información".</p>
          </div>
        )}
        <Resultado r={r('rechazo')} />
      </div>

      {/* ── 6. Registro ── */}
      <div className="border-t border-cream-200 pt-4 space-y-2">
        <h3 className="font-medium text-ink-900">Lo que le dijimos a RAPPI</h3>
        {!estado.registroListo && (
          <p className="text-2xs text-saffron-600">Falta correr Cloud Migrate: la tabla del registro todavía no existe. Las llamadas se hacen igual, pero no quedan anotadas.</p>
        )}
        {llamadas.length === 0 ? <p className="text-sm text-ink-500 italic">Todavía no se hizo ninguna llamada.</p> : (
          <div className="divide-y divide-cream-200">
            {llamadas.map((l) => {
              const esta = abierta === l.id;
              return (
                <div key={l.id} className="py-1.5">
                  <button type="button" className="w-full text-left flex items-start gap-2 hover:bg-cream-50 rounded px-1 py-0.5" onClick={() => setAbierta(esta ? null : l.id)}>
                    <Chip ok={l.ok} texto={l.ok ? 'ok' : 'falló'} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs text-ink-700">{hora(l.hechoAt)} · {l.contexto ?? l.ruta}</span>
                      {l.error && <span className="block text-2xs text-pomodoro-600">{l.error}</span>}
                    </span>
                    <span className="text-2xs font-mono text-ink-400 shrink-0">{l.status ?? '—'} · {l.ms} ms</span>
                  </button>
                  {esta && (
                    <div className="mt-1 px-1 space-y-1">
                      <p className="text-2xs font-mono text-ink-500">{l.metodo} {l.ruta}</p>
                      {l.requestBody != null && <pre className="text-2xs font-mono bg-cream-100 text-ink-700 p-2 rounded overflow-x-auto max-h-48">{JSON.stringify(l.requestBody, null, 2)}</pre>}
                      <pre className="text-2xs font-mono bg-ink-900 text-cream-100 p-2 rounded overflow-x-auto max-h-48">{l.responseBody != null ? JSON.stringify(l.responseBody, null, 2) : (l.responseTexto ?? '(sin cuerpo)')}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
