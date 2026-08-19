'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

/**
 * Los productos que se le compran a un proveedor, editables en la misma fila.
 *
 * Se edita ahí mismo y no en un modal porque el uso real es repasar la lista
 * después de una visita del proveedor y corregir tres o cuatro precios
 * seguidos. Con un modal por producto eso son doce clics de más.
 *
 * El PRECIO es del vínculo insumo-proveedor, no del insumo: el mismo producto
 * puede costar distinto según a quién se le compre. Por eso lo que se manda al
 * guardar lleva siempre el `proveedorId` de esta ficha.
 */

const CATEGORIAS = [
  'VERDULERIA', 'LACTEOS', 'CARNES', 'POLLO', 'HUEVOS', 'HARINAS',
  'CONDIMENTOS', 'ENVASES', 'LIMPIEZA', 'BEBIDAS', 'SIN_TACC', 'POSTRES', 'OTROS',
] as const;

const UNIDADES = [
  'KG', 'GRAMOS', 'UNIDAD', 'LITRO', 'CAJA', 'BOLSA', 'PAQUETE', 'DOCENA', 'OTRO',
] as const;

const UNIDAD_LABEL: Record<string, string> = {
  KG: 'kg', GRAMOS: 'gramos', UNIDAD: 'unidad', LITRO: 'litro', CAJA: 'caja',
  BOLSA: 'bolsa', PAQUETE: 'paquete', DOCENA: 'docena', OTRO: 'otro',
};

interface ProveedorDeInsumo {
  id: string;
  nombre: string;
  esPrincipal: boolean;
  precioUltimo: string | null;
  fechaUltimoPrecio: string | null;
}

export interface InsumoRow {
  id: string;
  nombre: string;
  activo: boolean;
  categoria: string;
  unidadCompra: string;
  presentacion: string | null;
  nombreExcelCompras: string | null;
  proveedores: ProveedorDeInsumo[];
  diasDesdePrecio: number | null;
  frescura: 'reciente' | 'medio' | 'viejo' | null;
}

/** Lo que se está editando en una fila. */
interface Borrador {
  nombre: string;
  presentacion: string;
  unidadCompra: string;
  categoria: string;
  precio: string;
}

export function InsumosDelProveedor({ proveedorId }: { proveedorId: string }) {
  const [insumos, setInsumos] = useState<InsumoRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [verInactivos, setVerInactivos] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [borrador, setBorrador] = useState<Borrador | null>(null);
  const [guardando, setGuardando] = useState(false);

  const fetchInsumos = useCallback(async () => {
    try {
      const p = new URLSearchParams({ proveedorId, limit: '500' });
      if (verInactivos) p.set('incluirInactivos', 'true');
      const r = await api.get<{ insumos: InsumoRow[] }>(`/admin/insumos-catalogo?${p}`);
      setInsumos(r.insumos);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los insumos');
    }
  }, [proveedorId, verInactivos]);

  useEffect(() => {
    void fetchInsumos();
  }, [fetchInsumos]);

  /** El precio de ESTE proveedor, que no es necesariamente el vigente. */
  function precioDeEsteProveedor(i: InsumoRow): string | null {
    return i.proveedores.find((p) => p.id === proveedorId)?.precioUltimo ?? null;
  }

  function abrirEdicion(i: InsumoRow) {
    setEditando(i.id);
    setBorrador({
      nombre: i.nombre,
      presentacion: i.presentacion ?? '',
      unidadCompra: i.unidadCompra,
      categoria: i.categoria,
      precio: precioDeEsteProveedor(i) ?? '',
    });
  }

  async function guardar(i: InsumoRow) {
    if (!borrador) return;
    setGuardando(true);
    setError(null);
    try {
      const previo = precioDeEsteProveedor(i);
      const cambioPrecio = borrador.precio !== '' && borrador.precio !== previo;
      await api.patch(`/admin/insumos-catalogo/${i.id}`, {
        nombre: borrador.nombre.trim(),
        presentacion: borrador.presentacion.trim() || null,
        unidadCompra: borrador.unidadCompra,
        categoria: borrador.categoria,
        // El precio sólo viaja si cambió: mandarlo igual re-estamparía la
        // fecha del último precio y "actualizado hace 2 días" mentiría.
        ...(cambioPrecio ? { proveedorId, precio: Number(borrador.precio).toFixed(2) } : {}),
      });
      setEditando(null);
      setBorrador(null);
      await fetchInsumos();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setGuardando(false);
    }
  }

  async function toggleActivo(i: InsumoRow) {
    try {
      await api.patch(`/admin/insumos-catalogo/${i.id}`, { activo: !i.activo });
      await fetchInsumos();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar el estado');
    }
  }

  if (error && !insumos) return <div className="text-pomodoro-600 text-sm">{error}</div>;
  if (!insumos) return <div className="text-ink-500 text-sm px-4 py-6">Cargando insumos…</div>;

  const filtrados = busqueda.trim()
    ? insumos.filter((i) =>
        `${i.nombre} ${i.presentacion ?? ''}`.toLowerCase().includes(busqueda.toLowerCase()),
      )
    : insumos;

  const sinPrecio = insumos.filter((i) => !precioDeEsteProveedor(i)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar producto…"
          className="input text-sm flex-1 min-w-[180px]"
        />
        <label className="flex items-center gap-2 text-2xs text-ink-500 cursor-pointer">
          <input
            type="checkbox"
            checked={verInactivos}
            onChange={(e) => setVerInactivos(e.target.checked)}
            className="w-4 h-4"
          />
          Ver los dados de baja
        </label>
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-500">
        <span>{insumos.length} productos</span>
        {sinPrecio > 0 && <span className="text-saffron-600">{sinPrecio} sin precio cargado</span>}
      </div>

      {filtrados.length === 0 ? (
        <p className="text-sm text-ink-500 italic px-1 py-6 text-center">
          {insumos.length === 0
            ? 'Este proveedor no tiene productos cargados. Se cargan solos al importar la hoja "Compras" del Excel.'
            : 'Ningún producto coincide con la búsqueda.'}
        </p>
      ) : (
        <div className="card overflow-hidden">
          {/* Tabla en escritorio */}
          <table className="w-full text-sm hidden md:table">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-3 py-2">Producto</th>
                <th className="text-left px-3 py-2">Presentación</th>
                <th className="text-left px-3 py-2">Unidad</th>
                <th className="text-right px-3 py-2">Precio</th>
                <th className="px-3 py-2 w-32"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {filtrados.map((i) => {
                const enEdicion = editando === i.id;
                const precio = precioDeEsteProveedor(i);
                return (
                  <tr key={i.id} className={cn(!i.activo && 'opacity-50')}>
                    <td className="px-3 py-2 text-ink-700">
                      {enEdicion ? (
                        <input
                          value={borrador!.nombre}
                          onChange={(e) => setBorrador({ ...borrador!, nombre: e.target.value })}
                          className="input text-sm py-1 w-full"
                        />
                      ) : (
                        <>
                          {i.nombre}
                          {/* Sin nombre en el Excel, las compras de este
                              producto no se le van a poder escribir a su fila. */}
                          {!i.nombreExcelCompras && (
                            <span
                              className="ml-2 text-2xs text-saffron-600"
                              title="No está vinculado a ninguna fila de la hoja Compras: las cantidades compradas no se le van a escribir"
                            >
                              sin fila en el Excel
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-600">
                      {enEdicion ? (
                        <input
                          value={borrador!.presentacion}
                          onChange={(e) =>
                            setBorrador({ ...borrador!, presentacion: e.target.value })
                          }
                          placeholder="ej. 5 Lts."
                          className="input text-sm py-1 w-full"
                        />
                      ) : (
                        (i.presentacion ?? '—')
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-600">
                      {enEdicion ? (
                        <select
                          value={borrador!.unidadCompra}
                          onChange={(e) =>
                            setBorrador({ ...borrador!, unidadCompra: e.target.value })
                          }
                          className="input text-sm py-1"
                        >
                          {UNIDADES.map((u) => (
                            <option key={u} value={u}>
                              {UNIDAD_LABEL[u]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        (UNIDAD_LABEL[i.unidadCompra] ?? i.unidadCompra)
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {enEdicion ? (
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={borrador!.precio}
                          onChange={(e) => setBorrador({ ...borrador!, precio: e.target.value })}
                          className="input text-sm py-1 w-28 text-right font-mono"
                        />
                      ) : precio ? (
                        <span className="inline-flex items-center gap-2">
                          <MoneyAmount value={precio} />
                          {i.diasDesdePrecio != null && (
                            <span
                              className={cn(
                                'text-2xs',
                                i.frescura === 'viejo'
                                  ? 'text-pomodoro-600'
                                  : i.frescura === 'medio'
                                    ? 'text-saffron-600'
                                    : 'text-ink-400',
                              )}
                              title={`Último precio hace ${i.diasDesdePrecio} días`}
                            >
                              {i.diasDesdePrecio}d
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-2xs text-saffron-600">sin precio</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {enEdicion ? (
                        <span className="inline-flex gap-1">
                          <Button size="sm" onClick={() => void guardar(i)} disabled={guardando}>
                            {guardando ? '…' : 'Guardar'}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setEditando(null);
                              setBorrador(null);
                            }}
                          >
                            ✕
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex gap-3">
                          <button
                            onClick={() => abrirEdicion(i)}
                            className="text-2xs text-teresita-700 hover:underline"
                          >
                            editar
                          </button>
                          <button
                            onClick={() => void toggleActivo(i)}
                            className="text-2xs text-ink-500 hover:underline"
                          >
                            {i.activo ? 'dar de baja' : 'reactivar'}
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Tarjetas en celular: una tabla de 5 columnas no entra */}
          <div className="md:hidden divide-y divide-cream-200">
            {filtrados.map((i) => {
              const enEdicion = editando === i.id;
              const precio = precioDeEsteProveedor(i);
              return (
                <div key={i.id} className={cn('p-3 space-y-2', !i.activo && 'opacity-50')}>
                  {enEdicion ? (
                    <>
                      <input
                        value={borrador!.nombre}
                        onChange={(e) => setBorrador({ ...borrador!, nombre: e.target.value })}
                        className="input text-sm"
                      />
                      <div className="flex gap-2">
                        <input
                          value={borrador!.presentacion}
                          onChange={(e) =>
                            setBorrador({ ...borrador!, presentacion: e.target.value })
                          }
                          placeholder="Presentación"
                          className="input text-sm flex-1"
                        />
                        <select
                          value={borrador!.unidadCompra}
                          onChange={(e) =>
                            setBorrador({ ...borrador!, unidadCompra: e.target.value })
                          }
                          className="input text-sm w-28"
                        >
                          {UNIDADES.map((u) => (
                            <option key={u} value={u}>
                              {UNIDAD_LABEL[u]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={borrador!.precio}
                          onChange={(e) => setBorrador({ ...borrador!, precio: e.target.value })}
                          placeholder="Precio"
                          className="input text-sm flex-1 text-right font-mono"
                        />
                        <Button size="sm" onClick={() => void guardar(i)} disabled={guardando}>
                          {guardando ? '…' : 'Guardar'}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setEditando(null);
                            setBorrador(null);
                          }}
                        >
                          ✕
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm text-ink-800">{i.nombre}</span>
                        {precio ? (
                          <MoneyAmount value={precio} className="whitespace-nowrap" />
                        ) : (
                          <span className="text-2xs text-saffron-600 whitespace-nowrap">
                            sin precio
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-2xs text-ink-500">
                        <span>
                          {i.presentacion ?? '—'} · {UNIDAD_LABEL[i.unidadCompra] ?? i.unidadCompra}
                        </span>
                        <span className="flex gap-3">
                          <button
                            onClick={() => abrirEdicion(i)}
                            className="text-teresita-700 hover:underline"
                          >
                            editar
                          </button>
                          <button onClick={() => void toggleActivo(i)} className="hover:underline">
                            {i.activo ? 'baja' : 'reactivar'}
                          </button>
                        </span>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
