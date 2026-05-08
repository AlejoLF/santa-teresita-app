'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Inputs de cliente para el flujo cargar-pedido cuando es delivery propio
 * (canal TELEFONO / WHATSAPP). Soporta dos formas de auto-rellenar:
 *
 *  1. Tipear el teléfono → debounce 300ms → autocomplete dropdown con hasta
 *     5 clientes que matchean el prefijo. Al elegir, se cargan nombre +
 *     dirección default + indicaciones.
 *
 *  2. Click en 🔍 al lado del nombre → modal con búsqueda por nombre. Lista
 *     todos los matches con sus direcciones (etiqueta, calle, etc.) para
 *     que la cajera elija "qué María" cuando hay varias homónimas. Al elegir
 *     una dirección, se completa el formulario.
 *
 * Diseño: la cajera atiende por teléfono — el flujo más común es "soy
 * fulano, mi número es X" → ella tipea el número y obtiene autocomplete
 * directo. El modal por nombre es el fallback ("no me acuerdo el número").
 */

interface DireccionShort {
  id: string;
  etiqueta: string;
  calle: string;
  numero: string;
  piso: string | null;
  depto: string | null;
  entreCalles: string | null;
  localidad: string;
  indicaciones: string | null;
  esDefault: boolean;
}

interface ClienteShort {
  id: string;
  tipo: string;
  nombre: string;
  apellido: string | null;
  telefono: string | null;
  email: string | null;
  ventasCount: number;
  direcciones: DireccionShort[];
}

function direccionFlatString(d: DireccionShort): string {
  const partes = [
    [d.calle, d.numero].filter(Boolean).join(' '),
    d.piso ? `piso ${d.piso}` : null,
    d.depto ? `dpto ${d.depto}` : null,
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  return partes.join(' ');
}

export function ClienteDeliveryFields({
  nombre,
  telefono,
  direccion,
  indicaciones,
  onNombre,
  onTelefono,
  onDireccion,
  onIndicaciones,
}: {
  nombre: string;
  telefono: string;
  direccion: string;
  indicaciones: string;
  onNombre: (v: string) => void;
  onTelefono: (v: string) => void;
  onDireccion: (v: string) => void;
  onIndicaciones: (v: string) => void;
}) {
  const [sugerencias, setSugerencias] = useState<ClienteShort[]>([]);
  const [mostrandoSugerencias, setMostrandoSugerencias] = useState(false);
  const [modalAbierto, setModalAbierto] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search por teléfono
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const tel = telefono.trim();
    // Mínimo 3 dígitos para no spamear con cada tecla
    if (tel.length < 3) {
      setSugerencias([]);
      setMostrandoSugerencias(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const r = await api.get<{ clientes: ClienteShort[] }>(
            `/clientes/buscar?telefono=${encodeURIComponent(tel)}`,
          );
          setSugerencias(r.clientes);
          setMostrandoSugerencias(r.clientes.length > 0);
        } catch {
          setSugerencias([]);
          setMostrandoSugerencias(false);
        }
      })();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [telefono]);

  function aplicarCliente(c: ClienteShort, d?: DireccionShort) {
    const dir = d ?? c.direcciones.find((x) => x.esDefault) ?? c.direcciones[0];
    const nombreCompleto = c.apellido ? `${c.nombre} ${c.apellido}` : c.nombre;
    onNombre(nombreCompleto);
    if (c.telefono) onTelefono(c.telefono);
    if (dir) {
      onDireccion(direccionFlatString(dir));
      const indicacionesPartes: string[] = [];
      if (dir.entreCalles) indicacionesPartes.push(`entre ${dir.entreCalles}`);
      if (dir.indicaciones) indicacionesPartes.push(dir.indicaciones);
      onIndicaciones(indicacionesPartes.join(' · '));
    }
    setMostrandoSugerencias(false);
    setModalAbierto(false);
  }

  return (
    <>
      {/* Nombre + Teléfono */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="relative">
          <input
            type="text"
            value={nombre}
            onChange={(e) => onNombre(e.target.value)}
            placeholder="Nombre"
            maxLength={120}
            className="input text-sm py-1 px-2 pr-8 w-full"
          />
          <button
            type="button"
            onClick={() => setModalAbierto(true)}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-ink-500 hover:text-teresita-700 px-1"
            title="Buscar cliente por nombre"
            aria-label="Buscar cliente por nombre"
          >
            🔍
          </button>
        </div>
        <div className="relative">
          <input
            type="tel"
            value={telefono}
            onChange={(e) => onTelefono(e.target.value)}
            onFocus={() => sugerencias.length > 0 && setMostrandoSugerencias(true)}
            onBlur={() => {
              // Delay para que el click en una sugerencia alcance a dispararse
              setTimeout(() => setMostrandoSugerencias(false), 150);
            }}
            placeholder="Teléfono"
            maxLength={40}
            className="input text-sm py-1 px-2 w-full"
          />
          {mostrandoSugerencias && sugerencias.length > 0 && (
            <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-white border border-cream-300 rounded-md shadow-lg max-h-64 overflow-y-auto">
              {sugerencias.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => aplicarCliente(c)}
                  className="w-full text-left px-2 py-1.5 hover:bg-cream-100 border-b border-cream-200 last:border-b-0"
                >
                  <div className="text-sm text-ink-900 font-medium">
                    {c.nombre} {c.apellido ?? ''}{' '}
                    <span className="text-ink-500 font-normal">· {c.telefono}</span>
                  </div>
                  {c.direcciones[0] && (
                    <div className="text-2xs text-ink-500 truncate">
                      {direccionFlatString(c.direcciones[0])}
                      {c.direcciones.length > 1 && ` (+${c.direcciones.length - 1} más)`}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <input
        type="text"
        value={direccion}
        onChange={(e) => onDireccion(e.target.value)}
        placeholder="Dirección (calle, número, piso/dpto)"
        maxLength={300}
        className="input text-sm py-1 px-2 w-full"
      />
      <input
        type="text"
        value={indicaciones}
        onChange={(e) => onIndicaciones(e.target.value)}
        placeholder="Indicaciones (opcional — entre calles, timbre, color de casa…)"
        maxLength={300}
        className="input text-2xs py-1 px-2 w-full"
      />

      {modalAbierto && (
        <BuscarPorNombreModal
          onCerrar={() => setModalAbierto(false)}
          onElegir={aplicarCliente}
        />
      )}
    </>
  );
}

function BuscarPorNombreModal({
  onCerrar,
  onElegir,
}: {
  onCerrar: () => void;
  onElegir: (c: ClienteShort, d?: DireccionShort) => void;
}) {
  const [query, setQuery] = useState('');
  const [resultados, setResultados] = useState<ClienteShort[]>([]);
  const [cargando, setCargando] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResultados([]);
      return;
    }
    setCargando(true);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const r = await api.get<{ clientes: ClienteShort[] }>(
            `/clientes/buscar?nombre=${encodeURIComponent(query.trim())}`,
          );
          setResultados(r.clientes);
        } catch {
          setResultados([]);
        } finally {
          setCargando(false);
        }
      })();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  return (
    <div
      className="fixed inset-0 z-50 bg-ink-900/50 flex items-start justify-center p-4 pt-16"
      onClick={onCerrar}
    >
      <div
        className="bg-white rounded-lg shadow-modal w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-cream-300 flex items-center justify-between">
          <div>
            <div className="font-display text-md text-teresita-700">Buscar cliente</div>
            <div className="text-2xs text-ink-500">
              Tipeá el nombre y elegí la dirección a la que se entrega
            </div>
          </div>
          <button
            onClick={onCerrar}
            className="text-ink-500 text-2xl leading-none hover:text-pomodoro-600"
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>

        <div className="px-4 py-3 border-b border-cream-300">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ej. María, Pérez, Sharon…"
            className="input text-sm py-2 px-3 w-full"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {cargando && (
            <p className="text-center text-ink-500 py-6 text-sm">Buscando…</p>
          )}
          {!cargando && query.trim().length >= 2 && resultados.length === 0 && (
            <p className="text-center text-ink-500 py-6 text-sm">
              Sin resultados para "{query}"
            </p>
          )}
          {!cargando && query.trim().length < 2 && (
            <p className="text-center text-ink-500 py-6 text-sm">
              Escribí al menos 2 letras
            </p>
          )}
          <ul className="divide-y divide-cream-200">
            {resultados.map((c) => (
              <li key={c.id} className="px-4 py-2">
                <div className="flex items-baseline justify-between">
                  <div className="text-sm font-medium text-ink-900">
                    {c.nombre} {c.apellido ?? ''}
                  </div>
                  <div className="text-2xs text-ink-500">
                    {c.telefono ? `📞 ${c.telefono}` : 'sin teléfono'}
                    {c.ventasCount > 0 && ` · ${c.ventasCount} ventas`}
                  </div>
                </div>
                {c.direcciones.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => onElegir(c)}
                    className="mt-1 text-2xs text-teresita-700 hover:underline"
                  >
                    Sin direcciones — elegir solo el cliente →
                  </button>
                ) : (
                  <div className="mt-1 space-y-0.5">
                    {c.direcciones.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => onElegir(c, d)}
                        className={cn(
                          'block w-full text-left text-2xs px-2 py-1 rounded',
                          'hover:bg-saffron-100 border border-transparent hover:border-saffron-200',
                        )}
                      >
                        <span className="font-medium text-ink-700">{d.etiqueta}:</span>{' '}
                        <span className="text-ink-700">{direccionFlatString(d)}</span>
                        {d.entreCalles && (
                          <span className="text-ink-500"> · entre {d.entreCalles}</span>
                        )}
                        {d.esDefault && (
                          <span className="ml-1 text-2xs text-teresita-700">★</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
