'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

/**
 * Traducción del menú de RAPPI.
 *
 * El menú lo maneja la encargada en la web de RAPPI. Acá se dice, para cada
 * producto y cada extra de RAPPI, a qué producto o sabor del POS corresponde,
 * así cada pedido se cuenta como lo que es. El precio siempre es el de RAPPI:
 * acá no se toca ningún precio.
 *
 * Lo que llega sin traducir NO se pierde: entra igual, como "RAPPI — sin
 * traducir", y aparece acá arriba de todo como pendiente. Al traducirlo, las
 * ventas anteriores se corrigen solas.
 */

type Tipo = 'PRODUCTO' | 'TOPPING';
type Estado = 'PENDIENTE' | 'TRADUCIDO' | 'IGNORAR';

interface Traduccion {
  id: string;
  tipo: Tipo;
  idExterno: string;
  nombreExterno: string;
  skuExterno: string | null;
  categoriaExterna: string | null;
  precioExterno: string | null;
  estado: Estado;
  origenTraduccion: string | null;
  origen: string;
  vecesVisto: number;
  vistoAt: string;
  cantidadPorUnidad: string | null;
  producto: { id: string; nombre: string; codigo: string | null; porPeso: boolean; cantidadDefault: string | null } | null;
  opcion: { id: string; nombre: string; codigo: string | null; grupo: string } | null;
  sugerencias: Array<{ id: string; nombre: string; detalle?: string }>;
}

interface Resumen {
  productos: { pendientes: number; traducidos: number; ignorados: number };
  toppings: { pendientes: number; traducidos: number; ignorados: number };
  pendientes: number;
}

interface ProductoPOS { id: string; nombre: string; codigo: string | null }
interface GrupoPOS { id: string; nombre: string; opciones: Array<{ id: string; nombre: string; activa: boolean }> }

const ESTADOS: Array<{ v: Estado | ''; label: string }> = [
  { v: 'PENDIENTE', label: 'Pendientes' },
  { v: 'TRADUCIDO', label: 'Traducidos' },
  { v: 'IGNORAR', label: 'Ignorados' },
  { v: '', label: 'Todos' },
];

export default function RappiMenuPage() {
  const [filas, setFilas] = useState<Traduccion[]>([]);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [estado, setEstado] = useState<Estado | ''>('PENDIENTE');
  const [tipo, setTipo] = useState<Tipo | ''>('');
  const [q, setQ] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [grupos, setGrupos] = useState<GrupoPOS[]>([]);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const params = new URLSearchParams();
      if (estado) params.set('estado', estado);
      if (tipo) params.set('tipo', tipo);
      if (q.trim()) params.set('q', q.trim());
      const r = await api.get<{ traducciones: Traduccion[]; resumen: Resumen }>(`/admin/rappi/traducciones?${params}`);
      setFilas(r.traducciones);
      setResumen(r.resumen);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar');
    } finally {
      setCargando(false);
    }
  }, [estado, tipo, q]);

  useEffect(() => { void cargar(); }, [cargar]);
  useEffect(() => {
    api.get<{ grupos: GrupoPOS[] }>('/admin/modificadores/grupos').then((r) => setGrupos(r.grupos)).catch(() => setGrupos([]));
  }, []);

  async function decidir(t: Traduccion, body: Record<string, unknown>) {
    setOcupado(t.id);
    try {
      const r = await api.put<{ detalle: string }>(`/admin/rappi/traducciones/${t.id}`, body);
      setAviso(`${t.nombreExterno}: ${r.detalle}`);
      await cargar();
    } catch (e) {
      setAviso(`${t.nombreExterno}: ${e instanceof Error ? e.message : 'no se pudo guardar'}`);
    } finally {
      setOcupado(null);
    }
  }

  async function importar() {
    setOcupado('importar');
    try {
      const r = await api.post<{ ok: boolean; detalle: string }>('/admin/rappi/traducciones/importar-menu', {});
      setAviso(r.detalle);
      await cargar();
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No se pudo traer el menú');
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg text-teresita-700">Menú de RAPPI → productos del POS</h2>
          <p className="text-sm text-ink-500 max-w-2xl">
            El menú se maneja en la web de RAPPI. Acá se dice qué producto o sabor nuestro es cada cosa de RAPPI, para
            que los pedidos se cuenten bien. El precio es siempre el de RAPPI. Lo que llega sin traducir entra igual
            (como "RAPPI — sin traducir") y queda acá como pendiente; al traducirlo, las ventas anteriores se corrigen solas.
          </p>
          <Link href="/admin/configuracion/integraciones" className="text-xs text-teresita-700 underline">← volver a Integraciones</Link>
        </div>
        <Button variant="secondary" size="sm" disabled={ocupado !== null} onClick={() => void importar()}>
          {ocupado === 'importar' ? 'Trayendo…' : 'Traer el menú de RAPPI'}
        </Button>
      </header>

      {resumen && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Chip tono={resumen.pendientes > 0 ? 'rojo' : 'verde'} texto={`${resumen.pendientes} pendientes`} />
          <Chip tono="neutro" texto={`${resumen.productos.traducidos} productos traducidos`} />
          <Chip tono="neutro" texto={`${resumen.toppings.traducidos} extras traducidos`} />
          <Chip tono="neutro" texto={`${resumen.productos.ignorados + resumen.toppings.ignorados} ignorados`} />
        </div>
      )}
      {aviso && <p className="text-sm text-ink-700 rounded-lg bg-cream-100 border border-cream-300 p-2">{aviso}</p>}
      {error && <p className="text-sm text-pomodoro-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {ESTADOS.map((e) => (
            <button key={e.v} type="button" onClick={() => setEstado(e.v)}
              className={cn('px-3 py-1 rounded-full text-xs border', estado === e.v ? 'bg-teresita-700 text-white border-teresita-700' : 'bg-white border-cream-300 text-ink-700')}>
              {e.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {([['', 'Productos y extras'], ['PRODUCTO', 'Productos'], ['TOPPING', 'Extras']] as Array<[Tipo | '', string]>).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setTipo(v)}
              className={cn('px-3 py-1 rounded-full text-xs border', tipo === v ? 'bg-teresita-700 text-white border-teresita-700' : 'bg-white border-cream-300 text-ink-700')}>
              {label}
            </button>
          ))}
        </div>
        <input className="input w-56" placeholder="buscar por nombre de RAPPI" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {cargando && filas.length === 0 ? (
        <p className="text-sm text-ink-500">Cargando…</p>
      ) : filas.length === 0 ? (
        <div className="card p-5 text-sm text-ink-500">
          {estado === 'PENDIENTE'
            ? 'No hay nada pendiente. Si todavía no llegó ningún pedido, apretá "Traer el menú de RAPPI" para traducir todo antes del primero.'
            : 'Nada que mostrar con este filtro.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filas.map((t) => (
            <Fila key={t.id} t={t} grupos={grupos} ocupado={ocupado === t.id} onDecidir={(body) => void decidir(t, body)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({ tono, texto }: { tono: 'rojo' | 'verde' | 'neutro'; texto: string }) {
  return (
    <span className={cn('rounded-full px-2.5 py-1', tono === 'rojo' ? 'bg-pomodoro-100 text-pomodoro-600' : tono === 'verde' ? 'bg-basil-100 text-basil-600' : 'bg-cream-100 text-ink-700')}>
      {texto}
    </span>
  );
}

function Fila({ t, grupos, ocupado, onDecidir }: { t: Traduccion; grupos: GrupoPOS[]; ocupado: boolean; onDecidir: (body: Record<string, unknown>) => void }) {
  const [buscando, setBuscando] = useState(false);
  const [gramos, setGramos] = useState(t.cantidadPorUnidad ?? '');
  const traducido = t.estado === 'TRADUCIDO';
  const auto = t.origenTraduccion?.startsWith('AUTO');

  return (
    <div className={cn('card p-3 sm:p-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-start', t.estado === 'PENDIENTE' && 'border-pomodoro-600/30')}>
      {/* Lo de RAPPI */}
      <div>
        <div className="text-2xs uppercase tracking-wide text-ink-500">{t.tipo === 'PRODUCTO' ? 'Producto de RAPPI' : `Extra de RAPPI${t.categoriaExterna ? ` · ${t.categoriaExterna}` : ''}`}</div>
        <div className="font-medium text-ink-900">{t.nombreExterno}</div>
        <div className="text-xs text-ink-500 flex flex-wrap gap-x-3">
          {t.precioExterno && <span><MoneyAmount value={t.precioExterno} /> en RAPPI</span>}
          {t.skuExterno && <span className="font-mono">sku {t.skuExterno}</span>}
          <span>{t.vecesVisto > 0 ? `en ${t.vecesVisto} pedido${t.vecesVisto === 1 ? '' : 's'}` : 'del menú, sin pedidos todavía'}</span>
        </div>
      </div>

      {/* Lo nuestro */}
      <div className="space-y-1.5">
        {t.estado === 'IGNORAR' ? (
          <div className="text-sm text-ink-500">Se ignora: no entra en las ventas.</div>
        ) : traducido && (t.producto || t.opcion) ? (
          <div>
            <div className="text-sm text-ink-900">
              → {t.producto ? <>{t.producto.nombre}{t.producto.codigo && <span className="font-mono text-xs text-ink-500"> {t.producto.codigo}</span>}</> : <>{t.opcion!.nombre} <span className="text-xs text-ink-500">({t.opcion!.grupo})</span></>}
              {auto && <span className="ml-2 text-2xs rounded-full bg-saffron-100 text-saffron-600 px-1.5 py-0.5" title="Se tradujo sola: revisá que esté bien">automática</span>}
            </div>
            {t.producto?.porPeso && (
              <label className="text-xs text-ink-700 flex items-center gap-2">
                gramos por unidad de RAPPI
                <input className="input w-24" type="number" min={1} value={gramos} placeholder={t.producto.cantidadDefault ? String(Number(t.producto.cantidadDefault)) : ''}
                  onChange={(e) => setGramos(e.target.value)}
                  onBlur={() => { const n = Number(gramos); if ((n > 0 ? n : null) !== (t.cantidadPorUnidad ? Number(t.cantidadPorUnidad) : null)) onDecidir({ cantidadPorUnidad: n > 0 ? n : null }); }} />
              </label>
            )}
            {!buscando && <button type="button" className="text-xs text-teresita-700 underline" onClick={() => setBuscando(true)}>cambiar</button>}
          </div>
        ) : (
          <div className="text-sm text-pomodoro-600">Sin traducir{t.vecesVisto > 0 ? ': entró como "RAPPI — sin traducir"' : ''}.</div>
        )}

        {(t.estado === 'PENDIENTE' || buscando) && (
          <div className="space-y-1.5">
            {t.sugerencias.length > 0 && !buscando && (
              <div className="flex flex-wrap gap-1.5">
                {t.sugerencias.map((s) => (
                  <button key={s.id} type="button" disabled={ocupado} onClick={() => onDecidir(t.tipo === 'PRODUCTO' ? { productoId: s.id } : { opcionId: s.id })}
                    className="text-xs rounded-lg border border-teresita-700/40 bg-white px-2 py-1 text-ink-900 hover:bg-cream-100">
                    ¿es {s.nombre}{s.detalle ? ` (${s.detalle})` : ''}?
                  </button>
                ))}
              </div>
            )}
            {t.tipo === 'PRODUCTO' ? (
              <BuscadorProducto disabled={ocupado} onElegir={(id) => { setBuscando(false); onDecidir({ productoId: id }); }} />
            ) : (
              <select className="input w-full" disabled={ocupado} defaultValue="" onChange={(e) => { if (e.target.value) { setBuscando(false); onDecidir({ opcionId: e.target.value }); } }}>
                <option value="">elegir el sabor / extra nuestro…</option>
                {grupos.map((g) => (
                  <optgroup key={g.id} label={g.nombre}>
                    {g.opciones.filter((o) => o.activa).map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {/* Acciones */}
      <div className="flex sm:flex-col gap-1.5 text-xs">
        {t.estado !== 'IGNORAR' && (
          <button type="button" disabled={ocupado} className="text-ink-500 underline" onClick={() => onDecidir({ estado: 'IGNORAR' })}>ignorar</button>
        )}
        {t.estado !== 'PENDIENTE' && (
          <button type="button" disabled={ocupado} className="text-ink-500 underline" onClick={() => { setBuscando(false); onDecidir({ estado: 'PENDIENTE' }); }}>volver a pendiente</button>
        )}
      </div>
    </div>
  );
}

/** Busca productos del POS por nombre o código y deja elegir uno. */
function BuscadorProducto({ disabled, onElegir }: { disabled: boolean; onElegir: (id: string) => void }) {
  const [texto, setTexto] = useState('');
  const [resultados, setResultados] = useState<ProductoPOS[]>([]);
  const consulta = useMemo(() => texto.trim(), [texto]);

  useEffect(() => {
    if (consulta.length < 2) { setResultados([]); return; }
    const h = setTimeout(() => {
      api.get<ProductoPOS[] | { productos: ProductoPOS[] }>(`/catalogo/productos?q=${encodeURIComponent(consulta)}&limit=12`)
        .then((r) => setResultados((Array.isArray(r) ? r : r.productos ?? []).map((p) => ({ id: p.id, nombre: p.nombre, codigo: p.codigo ?? null }))))
        .catch(() => setResultados([]));
    }, 250);
    return () => clearTimeout(h);
  }, [consulta]);

  return (
    <div className="relative">
      <input className="input w-full" disabled={disabled} placeholder="buscar producto nuestro por nombre o código" value={texto} onChange={(e) => setTexto(e.target.value)} />
      {resultados.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-56 overflow-auto rounded-lg border border-cream-300 bg-white shadow">
          {resultados.map((p) => (
            <li key={p.id}>
              <button type="button" className="w-full text-left px-3 py-1.5 text-sm hover:bg-cream-100" onClick={() => { setTexto(''); setResultados([]); onElegir(p.id); }}>
                {p.nombre}{p.codigo && <span className="font-mono text-xs text-ink-500"> {p.codigo}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
