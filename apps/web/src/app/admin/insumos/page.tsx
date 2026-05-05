'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface Proveedor {
  id: string;
  nombre: string;
  categoriaPrincipal: string | null;
  cuit: string | null;
  telefono: string | null;
  saldoAdeudado: string;
  facturasPendientes: number;
  proximoVencimiento: string | null;
  activo: boolean;
}

interface Insumo {
  id: string;
  nombre: string;
  categoria: string;
  unidadCompra: string;
  presentacion: string | null;
  stockActual: string;
  stockMinimo: string | null;
  proveedorPrincipal: { id: string; nombre: string } | null;
  proveedores: Array<{
    id: string;
    nombre: string;
    esPrincipal: boolean;
    precioUltimo: string | null;
    fechaUltimoPrecio: string | null;
  }>;
  precioVigente: string | null;
  fechaVigente: string | null;
  diasDesdePrecio: number | null;
  frescura: 'reciente' | 'medio' | 'viejo' | null;
}

const UNIDAD_LABEL: Record<string, string> = {
  KG: 'kg',
  GRAMOS: 'g',
  UNIDAD: 'u',
  LITRO: 'L',
  CAJA: 'caja',
  BOLSA: 'bolsa',
  PAQUETE: 'paq',
  DOCENA: 'doc',
  OTRO: '—',
};

const CATEGORIA_LABEL: Record<string, string> = {
  VERDULERIA: 'Verdulería',
  LACTEOS: 'Lácteos',
  CARNES: 'Carnes',
  POLLO: 'Pollo',
  HUEVOS: 'Huevos',
  HARINAS: 'Harinas',
  CONDIMENTOS: 'Condimentos',
  ENVASES: 'Envases',
  LIMPIEZA: 'Limpieza',
  BEBIDAS: 'Bebidas',
  SIN_TACC: 'Sin TACC',
  POSTRES: 'Postres',
  OTROS: 'Otros',
};

type Tab = 'proveedores' | 'insumos';

export default function InsumosYProveedoresPage() {
  const [tab, setTab] = useState<Tab>('proveedores');

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-xl text-ink-900">Insumos y proveedores</h1>
          <p className="text-sm text-ink-500">Catálogo de insumos y proveedores con saldos.</p>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-cream-300">
        {(
          [
            { v: 'proveedores', label: 'Proveedores' },
            { v: 'insumos', label: 'Insumos' },
          ] as const
        ).map((t) => (
          <button
            key={t.v}
            onClick={() => setTab(t.v)}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors border-b-2',
              tab === t.v
                ? 'border-teresita-700 text-teresita-700'
                : 'border-transparent text-ink-500 hover:text-ink-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'proveedores' ? <ProveedoresTab /> : <InsumosTab />}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Tab: Proveedores
// ────────────────────────────────────────────────────────────────────────

function ProveedoresTab() {
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      const res = await api.get<{ proveedores: Proveedor[] }>(
        `/admin/proveedores?${params.toString()}`,
      );
      setProveedores(res.proveedores);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los proveedores');
      }
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const totalAdeudado = proveedores.reduce((acc, p) => acc + Number(p.saldoAdeudado), 0);
  const conSaldo = proveedores.filter((p) => Number(p.saldoAdeudado) > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-ink-500">
          {proveedores.length} proveedores · {conSaldo.length} con saldo adeudado
        </p>
        <div className="text-right">
          <div className="text-2xs text-ink-500 uppercase">Total adeudado</div>
          <MoneyAmount value={totalAdeudado.toFixed(2)} className="text-lg text-pomodoro-600" />
        </div>
      </div>

      <section className="card p-3">
        <input
          type="search"
          placeholder="🔍 Buscar proveedor..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input"
        />
      </section>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Proveedor</th>
              <th className="text-left px-4 py-2">Categoría</th>
              <th className="text-right px-4 py-2">Facturas pendientes</th>
              <th className="text-right px-4 py-2">Saldo adeudado</th>
              <th className="text-left px-4 py-2">Próx. venc.</th>
              <th className="px-4 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {loading && (
              <tr>
                <td colSpan={6} className="text-center text-ink-500 py-8">
                  Cargando...
                </td>
              </tr>
            )}
            {!loading && proveedores.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-ink-500 py-8">
                  Sin proveedores
                </td>
              </tr>
            )}
            {proveedores.map((p) => {
              const saldo = Number(p.saldoAdeudado);
              const venc = p.proximoVencimiento ? new Date(p.proximoVencimiento) : null;
              const venceProximo = venc && venc.getTime() < Date.now() + 7 * 86400 * 1000;
              const vencido = venc && venc.getTime() < Date.now();
              return (
                <tr key={p.id} className="hover:bg-cream-100 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/insumos/${p.id}`}
                      className="font-medium text-ink-900 hover:text-teresita-700"
                    >
                      {p.nombre}
                    </Link>
                    {p.cuit && (
                      <div className="text-2xs font-mono text-ink-500">{p.cuit}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-700 text-xs">
                    {p.categoriaPrincipal ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-700 font-mono">
                    {p.facturasPendientes}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {saldo > 0 ? (
                      <MoneyAmount
                        value={p.saldoAdeudado}
                        className="text-pomodoro-600 font-medium"
                      />
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {venc ? (
                      <span
                        className={cn(
                          'font-mono',
                          vencido && 'text-pomodoro-600 font-semibold',
                          !vencido && venceProximo && 'text-saffron-600',
                          !vencido && !venceProximo && 'text-ink-500',
                        )}
                      >
                        {vencido && '⚠ '}
                        {venc.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}
                      </span>
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-300">
                    <Link href={`/admin/insumos/${p.id}`} className="hover:text-teresita-700">
                      →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Tab: Insumos (búsqueda por insumo)
// ────────────────────────────────────────────────────────────────────────

function InsumosTab() {
  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [search, setSearch] = useState('');
  const [categoria, setCategoria] = useState('');
  const [expandido, setExpandido] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '500' });
      if (search.trim()) params.set('q', search.trim());
      if (categoria) params.set('categoria', categoria);
      const res = await api.get<{ insumos: Insumo[] }>(
        `/admin/insumos-catalogo?${params.toString()}`,
      );
      setInsumos(res.insumos);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los insumos');
      }
    } finally {
      setLoading(false);
    }
  }, [search, categoria]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const categorias = useMemo(() => {
    return Array.from(new Set(insumos.map((i) => i.categoria))).sort();
  }, [insumos]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-500">
        {insumos.length} insumos en catálogo · buscá por nombre y vé qué proveedor lo provee al
        mejor precio.
      </p>

      <section className="card p-3 flex flex-wrap gap-3 items-center">
        <input
          type="search"
          placeholder="🔍 Buscar insumo (ej: harina, mozzarella, huevos)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input flex-1 min-w-[260px]"
        />
        <select
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
          className="input w-auto"
        >
          <option value="">Todas las categorías</option>
          {categorias.map((c) => (
            <option key={c} value={c}>
              {CATEGORIA_LABEL[c] ?? c}
            </option>
          ))}
        </select>
      </section>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Insumo</th>
              <th className="text-left px-4 py-2">Categoría</th>
              <th className="text-left px-4 py-2">Presentación / unidad</th>
              <th className="text-left px-4 py-2">Proveedor principal</th>
              <th className="text-right px-4 py-2">Precio actual</th>
              <th className="text-left px-4 py-2">Última actualización</th>
              <th className="px-3 py-2 w-8"></th>
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
            {!loading && insumos.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-ink-500 py-8">
                  No hay insumos en el catálogo todavía. Cargá uno desde la página del proveedor.
                </td>
              </tr>
            )}
            {insumos.map((i) => {
              const expanded = expandido === i.id;
              const presentacion =
                i.presentacion ??
                `por ${UNIDAD_LABEL[i.unidadCompra] ?? i.unidadCompra.toLowerCase()}`;
              return (
                <FilaInsumo
                  key={i.id}
                  insumo={i}
                  expanded={expanded}
                  presentacion={presentacion}
                  onToggle={() => setExpandido(expanded ? null : i.id)}
                />
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function FilaInsumo({
  insumo: i,
  expanded,
  presentacion,
  onToggle,
}: {
  insumo: Insumo;
  expanded: boolean;
  presentacion: string;
  onToggle: () => void;
}) {
  const tieneVarios = i.proveedores.length > 1;
  const frescuraTone =
    i.frescura === 'reciente'
      ? 'bg-basil-100 text-basil-600'
      : i.frescura === 'medio'
        ? 'bg-saffron-100 text-saffron-600'
        : i.frescura === 'viejo'
          ? 'bg-pomodoro-100 text-pomodoro-600'
          : 'bg-cream-200 text-ink-500';
  const frescuraLabel =
    i.diasDesdePrecio === null
      ? 'sin precio'
      : i.diasDesdePrecio === 0
        ? 'hoy'
        : i.diasDesdePrecio === 1
          ? 'ayer'
          : `hace ${i.diasDesdePrecio} días`;

  return (
    <>
      <tr className="hover:bg-cream-100 transition-colors">
        <td className="px-4 py-3">
          <div className="font-medium text-ink-900">{i.nombre}</div>
          {Number(i.stockActual) > 0 && (
            <div className="text-2xs text-ink-500">stock: {i.stockActual}</div>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-ink-700">
          {CATEGORIA_LABEL[i.categoria] ?? i.categoria}
        </td>
        <td className="px-4 py-3 text-xs text-ink-700">{presentacion}</td>
        <td className="px-4 py-3 text-xs">
          {i.proveedorPrincipal ? (
            <Link
              href={`/admin/insumos/${i.proveedorPrincipal.id}`}
              className="text-teresita-700 hover:underline"
            >
              {i.proveedorPrincipal.nombre}
            </Link>
          ) : (
            <span className="text-ink-300">— sin asignar</span>
          )}
          {tieneVarios && (
            <span className="ml-1 text-2xs text-ink-500">
              (+{i.proveedores.length - 1} más)
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          {i.precioVigente ? (
            <MoneyAmount value={i.precioVigente} className="font-mono" />
          ) : (
            <span className="text-ink-300">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-xs">
          <span
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded',
              frescuraTone,
            )}
          >
            {i.frescura === 'reciente' && '↑'}
            {i.frescura === 'medio' && '⏰'}
            {i.frescura === 'viejo' && '⚠'}
            {frescuraLabel}
          </span>
        </td>
        <td className="px-3 py-3 text-right">
          {tieneVarios && (
            <button
              onClick={onToggle}
              className="text-xs text-teresita-700 hover:underline whitespace-nowrap"
            >
              {expanded ? '−' : '+'} {expanded ? 'cerrar' : 'comparar'}
            </button>
          )}
        </td>
      </tr>
      {expanded && tieneVarios && (
        <tr>
          <td colSpan={7} className="px-4 py-3 bg-cream-100">
            <div className="text-2xs uppercase tracking-wider text-ink-500 mb-2">
              Proveedores que venden este insumo
            </div>
            <table className="w-full text-xs">
              <thead className="text-ink-500">
                <tr>
                  <th className="text-left py-1">Proveedor</th>
                  <th className="text-right py-1">Precio</th>
                  <th className="text-left py-1">Última actualización</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {i.proveedores.map((p) => {
                  const fecha = p.fechaUltimoPrecio ? new Date(p.fechaUltimoPrecio) : null;
                  return (
                    <tr key={p.id}>
                      <td className="py-1.5">
                        <Link
                          href={`/admin/insumos/${p.id}`}
                          className="text-ink-900 hover:text-teresita-700"
                        >
                          {p.nombre}
                        </Link>
                        {p.esPrincipal && (
                          <span className="ml-2 text-2xs bg-teresita-50 text-teresita-700 px-1.5 py-0.5 rounded">
                            principal
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right font-mono">
                        {p.precioUltimo ? (
                          <MoneyAmount value={p.precioUltimo} />
                        ) : (
                          <span className="text-ink-300">—</span>
                        )}
                      </td>
                      <td className="py-1.5 text-ink-700">
                        {fecha
                          ? fecha.toLocaleDateString('es-AR', {
                              day: '2-digit',
                              month: '2-digit',
                              year: 'numeric',
                            })
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
