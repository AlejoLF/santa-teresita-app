'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

export interface InsumoSuggestion {
  id: string;
  nombre: string;
  categoria: string;
  unidadCompra: string;
  presentacion: string | null;
  proveedoresVinculo?: Array<{
    precioUltimo: string | null;
    fechaUltimoPrecio: string | null;
  }>;
}

interface InsumoAutocompleteProps {
  value: string;
  onChangeText: (text: string) => void;
  onSelect: (insumo: InsumoSuggestion | null) => void;
  proveedorId?: string;
  selectedInsumoId?: string | null;
  placeholder?: string;
  className?: string;
}

/**
 * Input con autocomplete que sugiere insumos del catálogo.
 * Si el usuario tipea algo nuevo, ofrece "Crear insumo: [texto]" — al
 * confirmar abre el modal de creación. Una vez creado, lo selecciona.
 */
export function InsumoAutocomplete({
  value,
  onChangeText,
  onSelect,
  proveedorId,
  selectedInsumoId,
  placeholder,
  className,
}: InsumoAutocompleteProps) {
  const [sugerencias, setSugerencias] = useState<InsumoSuggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(0);
  const [creandoNuevo, setCreandoNuevo] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetch = useCallback(
    async (q: string) => {
      try {
        const params = new URLSearchParams({ q, limit: '15' });
        if (proveedorId) params.set('proveedorId', proveedorId);
        const res = await api.get<{ insumos: InsumoSuggestion[] }>(
          `/admin/insumos-catalogo?${params.toString()}`,
        );
        setSugerencias(res.insumos);
      } catch {
        setSugerencias([]);
      }
    },
    [proveedorId],
  );

  // Debounced fetch
  useEffect(() => {
    if (!value || value.length < 2) {
      setSugerencias([]);
      return;
    }
    const id = setTimeout(() => void fetch(value), 200);
    return () => clearTimeout(id);
  }, [value, fetch]);

  // Cerrar al click fuera
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const matchExacto = sugerencias.find(
    (s) => s.nombre.toLowerCase() === value.trim().toLowerCase(),
  );
  const mostrarCrear = value.trim().length >= 2 && !matchExacto;

  function selectSugerencia(s: InsumoSuggestion) {
    onChangeText(s.nombre);
    onSelect(s);
    setShowDropdown(false);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown) return;
    const total = sugerencias.length + (mostrarCrear ? 1 : 0);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHoveredIdx((i) => Math.min(total - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHoveredIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hoveredIdx < sugerencias.length) {
        const s = sugerencias[hoveredIdx];
        if (s) selectSugerencia(s);
      } else if (mostrarCrear) {
        setCreandoNuevo(true);
      }
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChangeText(e.target.value);
          // Si cambia el texto manualmente, deselecciona el insumoId previo
          if (selectedInsumoId) onSelect(null);
          setShowDropdown(true);
          setHoveredIdx(0);
        }}
        onFocus={() => setShowDropdown(true)}
        onKeyDown={handleKey}
        placeholder={placeholder ?? 'Buscar o crear insumo...'}
        className={cn(
          'input',
          selectedInsumoId && 'border-basil-600 bg-basil-100/50',
        )}
      />
      {selectedInsumoId && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-basil-600 text-xs">
          ✓
        </span>
      )}

      {showDropdown && (sugerencias.length > 0 || mostrarCrear) && (
        <ul className="absolute z-10 left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-white border border-cream-300 rounded-md shadow-lg text-sm">
          {sugerencias.map((s, idx) => {
            const ult = s.proveedoresVinculo?.[0];
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => selectSugerencia(s)}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  className={cn(
                    'w-full text-left px-3 py-2 flex justify-between items-center',
                    hoveredIdx === idx ? 'bg-cream-100' : 'hover:bg-cream-50',
                  )}
                >
                  <div>
                    <div className="font-medium">{s.nombre}</div>
                    <div className="text-2xs text-ink-500">
                      {s.categoria} · {s.unidadCompra}
                      {s.presentacion && ` · ${s.presentacion}`}
                    </div>
                  </div>
                  {ult?.precioUltimo && (
                    <span className="text-xs font-mono text-ink-500">
                      último ${ult.precioUltimo}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {mostrarCrear && (
            <li className="border-t border-cream-200">
              <button
                type="button"
                onClick={() => setCreandoNuevo(true)}
                onMouseEnter={() => setHoveredIdx(sugerencias.length)}
                className={cn(
                  'w-full text-left px-3 py-2 text-teresita-700 font-medium',
                  hoveredIdx === sugerencias.length ? 'bg-teresita-50' : 'hover:bg-teresita-50',
                )}
              >
                + Crear insumo: <span className="italic">"{value}"</span>
              </button>
            </li>
          )}
        </ul>
      )}

      {creandoNuevo && (
        <ModalCrearInsumo
          nombreInicial={value}
          proveedorPrincipalId={proveedorId}
          onClose={() => setCreandoNuevo(false)}
          onCreated={(insumo) => {
            setCreandoNuevo(false);
            onChangeText(insumo.nombre);
            onSelect(insumo);
            setShowDropdown(false);
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal: crear insumo nuevo en el catálogo
// ────────────────────────────────────────────────────────────────────────

const CATEGORIAS = [
  'VERDULERIA',
  'LACTEOS',
  'CARNES',
  'POLLO',
  'HUEVOS',
  'HARINAS',
  'CONDIMENTOS',
  'ENVASES',
  'LIMPIEZA',
  'BEBIDAS',
  'SIN_TACC',
  'POSTRES',
  'OTROS',
] as const;

const UNIDADES = [
  'KG',
  'GRAMOS',
  'UNIDAD',
  'LITRO',
  'CAJA',
  'BOLSA',
  'PAQUETE',
  'DOCENA',
  'OTRO',
] as const;

function ModalCrearInsumo({
  nombreInicial,
  proveedorPrincipalId,
  onClose,
  onCreated,
}: {
  nombreInicial: string;
  proveedorPrincipalId?: string;
  onClose: () => void;
  onCreated: (insumo: InsumoSuggestion) => void;
}) {
  const [nombre, setNombre] = useState(nombreInicial);
  const [categoria, setCategoria] = useState<string>('OTROS');
  const [unidadCompra, setUnidadCompra] = useState<string>('UNIDAD');
  const [presentacion, setPresentacion] = useState('');
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!nombre.trim()) return setError('Falta el nombre');
    setCreando(true);
    setError(null);
    try {
      const created = await api.post<InsumoSuggestion>('/admin/insumos-catalogo', {
        nombre: nombre.trim(),
        categoria,
        unidadCompra,
        presentacion: presentacion || undefined,
        proveedorPrincipalId: proveedorPrincipalId || undefined,
      });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear el insumo');
    } finally {
      setCreando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal">
        <h2 className="font-display text-md text-teresita-700 mb-3">Nuevo insumo en catálogo</h2>
        <p className="text-xs text-ink-500 mb-4">
          Cargado una vez, queda disponible para futuras facturas con cualquier proveedor.
        </p>

        <div className="space-y-3">
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
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Categoría</label>
              <select
                value={categoria}
                onChange={(e) => setCategoria(e.target.value)}
                className="input"
              >
                {CATEGORIAS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Unidad</label>
              <select
                value={unidadCompra}
                onChange={(e) => setUnidadCompra(e.target.value)}
                className="input"
              >
                {UNIDADES.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Presentación (opcional)
            </label>
            <input
              type="text"
              value={presentacion}
              onChange={(e) => setPresentacion(e.target.value)}
              className="input"
              placeholder="ej. bolsa de 25kg, caja x 600 unid"
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        <footer className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={creando}
            className="btn btn-secondary"
          >
            Cancelar
          </button>
          <button onClick={() => void submit()} disabled={creando} className="btn btn-primary">
            {creando ? 'Creando...' : 'Crear y usar'}
          </button>
        </footer>
      </div>
    </div>
  );
}
