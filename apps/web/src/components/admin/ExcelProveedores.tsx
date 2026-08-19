'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * El puente con "Proveedores 2026.xlsx", el cuaderno de trabajo de la
 * encargada.
 *
 * ── Por qué TODO empieza con una simulación ─────────────────────────────
 *
 * Ese archivo no es un reporte que genera el sistema: es donde ella lleva la
 * cuenta a mano desde hace años, con sus fórmulas y sus notas pegadas a las
 * celdas. Escribir ahí sin mirar antes es la clase de error que se descubre
 * una semana después y ya no se puede desarmar.
 *
 * Así que cada acción tiene dos pasos: primero "ver qué haría" —que calcula
 * todo y no toca el archivo— y recién después "escribir". El primero es
 * gratis y se puede repetir; el segundo pide confirmación.
 *
 * ── Y por qué no pisa lo que ella escribió ──────────────────────────────
 *
 * Si una celda ya tiene un valor DISTINTO al calculado, se marca como
 * diferencia y se deja intacta. Puede ser un ajuste que ella hizo a mano por
 * algo que el sistema no sabe. Pisarla requiere pedirlo explícitamente con la
 * casilla de abajo.
 */

// ── Formas que devuelve el API ───────────────────────────────────────────

interface CeldaDeuda {
  etiqueta: string;
  ref: string;
  concepto: 'RECIBIDO' | 'PAGOS';
  terminos: Array<{ detalle: string; monto: number }>;
  total: number;
  valorPrevio: string | number | null;
  estado: 'NUEVA' | 'IGUAL' | 'DIFERENCIA';
}

interface ResultadoDeudas {
  archivo: string;
  semana: string;
  desde: string;
  hasta: string;
  celdas: CeldaDeuda[];
  escritas: number;
  diferencias: number;
  filasSinMapeo: string[];
  proveedoresSinFila: Array<{ id: string; nombre: string; total: number }>;
  simulado: boolean;
}

interface ResultadoImportacion {
  proveedoresNuevos: string[];
  proveedoresExistentes: string[];
  insumosCreados: number;
  insumosActualizados: number;
  preciosCargados: number;
  sinPrecio: string[];
  duplicadosEnExcel: string[];
  simulado: boolean;
}

interface CeldaCantidad {
  insumo: string;
  proveedor: string;
  ref: string;
  cantidad: number;
  valorPrevio: number | null;
  estado: 'NUEVA' | 'IGUAL' | 'DIFERENCIA';
}

interface ResultadoCantidades {
  semana: string;
  celdas: CeldaCantidad[];
  escritas: number;
  diferencias: number;
  itemsSinInsumo: Array<{ descripcion: string; proveedor: string; cantidad: number }>;
  simulado: boolean;
}

interface Estructura {
  archivo: string;
  etiquetas: string[];
  semanas: Array<{ etiqueta: string; desde: string; hasta: string }>;
  mapeos: Array<{
    id: string;
    etiquetaExcel: string;
    proveedorId: string;
    proveedorNombre: string;
    tiposComprobante: string[];
    activo: boolean;
  }>;
  sugerencias: Array<{ etiqueta: string; sugerido: { id: string; nombre: string } | null }>;
}

const fmt = (n: number) =>
  `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** El día que eligió el usuario, al mediodía, para que el huso no lo corra al día anterior. */
function aIso(fecha: string): string {
  return new Date(`${fecha}T12:00:00`).toISOString();
}

function hoyLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Cuántas celdas se escribirían realmente con las opciones elegidas. */
function aEscribir(
  celdas: Array<{ estado: 'NUEVA' | 'IGUAL' | 'DIFERENCIA' }>,
  pisar: boolean,
): number {
  return celdas.filter((c) => c.estado === 'NUEVA' || (c.estado === 'DIFERENCIA' && pisar)).length;
}

const ESTADO_CLASS: Record<string, string> = {
  NUEVA: 'bg-teresita-100 text-teresita-900',
  IGUAL: 'bg-cream-200 text-ink-500',
  DIFERENCIA: 'bg-saffron-100 text-saffron-700',
};

const ESTADO_LABEL: Record<string, string> = {
  NUEVA: 'se escribe',
  IGUAL: 'ya estaba',
  DIFERENCIA: 'no coincide',
};

export function ExcelProveedores() {
  const [estructura, setEstructura] = useState<Estructura | null>(null);
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);

  const fetchEstructura = useCallback(async () => {
    try {
      const e = await api.get<Estructura>('/admin/excel-proveedores/estructura');
      setEstructura(e);
      setErrorArchivo(null);
    } catch (e) {
      setEstructura(null);
      setErrorArchivo(e instanceof Error ? e.message : 'No se pudo abrir el Excel');
    }
  }, []);

  useEffect(() => {
    void fetchEstructura();
  }, [fetchEstructura]);

  return (
    <div className="space-y-4">
      {/* Si el archivo no está a mano, todo lo de abajo va a fallar igual.
          Vale más decirlo una vez arriba y con la causa probable. */}
      {errorArchivo && (
        <div className="bg-saffron-100 text-saffron-700 px-4 py-3 rounded text-sm space-y-1">
          <p className="font-medium">No se pudo abrir &quot;Proveedores 2026.xlsx&quot;.</p>
          <p className="text-2xs">{errorArchivo}</p>
          <p className="text-2xs">
            Revisá que la carpeta sincronizada del Drive esté montada en el servidor y que el
            archivo no esté abierto por otra persona.
          </p>
        </div>
      )}

      {estructura && (
        <p className="text-2xs text-ink-500 px-1">
          Archivo: <span className="font-mono">{estructura.archivo}</span> ·{' '}
          {estructura.semanas.length} semanas · {estructura.etiquetas.length} filas de proveedor
        </p>
      )}

      <PanelDeudas habilitado={!errorArchivo} />
      <PanelCompras habilitado={!errorArchivo} />
      <PanelMapeo estructura={estructura} onCambio={fetchEstructura} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Hoja "Deudas" — lo recibido y lo pagado de la semana
// ────────────────────────────────────────────────────────────────────────

function PanelDeudas({ habilitado }: { habilitado: boolean }) {
  const [fecha, setFecha] = useState(hoyLocal());
  const [pisar, setPisar] = useState(false);
  const [r, setR] = useState<ResultadoDeudas | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function correr(simular: boolean) {
    setCargando(true);
    setError(null);
    setOk(null);
    try {
      const res = await api.post<ResultadoDeudas>('/admin/excel-proveedores/volcar', {
        fecha: aIso(fecha),
        simular,
        pisarDiferencias: pisar,
      });
      setR(res);
      if (!simular) {
        setOk(
          res.escritas === 0
            ? 'No hizo falta escribir nada: el Excel ya estaba al día.'
            : `Listo: ${res.escritas} celda${res.escritas === 1 ? '' : 's'} escrita${res.escritas === 1 ? '' : 's'} en la semana ${res.semana}.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo procesar');
    } finally {
      setCargando(false);
    }
  }

  const pendientes = r ? aEscribir(r.celdas, pisar) : 0;

  return (
    <section className="card p-4 space-y-3">
      <header>
        <h3 className="font-display text-md text-ink-900">Deudas — lo recibido y lo pagado</h3>
        <p className="text-2xs text-ink-500">
          Escribe en la fila de cada proveedor lo que llegó y lo que se le pagó en la semana. El
          resto de la planilla (el &quot;Arranco&quot; y los totales) se recalcula solo.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-2xs text-ink-500">
          <span className="block mb-1">Semana que contiene el día</span>
          <input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className="input text-sm py-1"
          />
        </label>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void correr(true)}
          disabled={cargando || !habilitado}
        >
          {cargando ? 'Calculando…' : 'Ver qué se escribiría'}
        </Button>
        {r && pendientes > 0 && (
          <Button size="sm" onClick={() => void correr(false)} disabled={cargando}>
            Escribir {pendientes} celda{pendientes === 1 ? '' : 's'} en el Excel
          </Button>
        )}
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}
      {ok && <div className="bg-teresita-100 text-teresita-900 px-3 py-2 rounded text-sm">{ok}</div>}

      {r && (
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            Semana <strong>{r.semana}</strong> ({r.desde} al {r.hasta}) ·{' '}
            {r.celdas.length === 0 ? (
              <span className="text-ink-500">no hay movimiento para volcar</span>
            ) : (
              <>
                {pendientes} para escribir
                {r.diferencias > 0 && (
                  <span className="text-saffron-700"> · {r.diferencias} no coinciden</span>
                )}
              </>
            )}
          </p>

          {r.diferencias > 0 && (
            <label className="flex items-start gap-2 text-2xs text-saffron-700 cursor-pointer bg-saffron-100 px-3 py-2 rounded">
              <input
                type="checkbox"
                checked={pisar}
                onChange={(e) => setPisar(e.target.checked)}
                className="w-4 h-4 mt-0.5"
              />
              <span>
                Pisar las celdas que no coinciden. Por defecto se dejan como están: lo que la
                encargada escribió a mano puede ser un ajuste que el sistema no conoce.
              </span>
            </label>
          )}

          {r.celdas.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
                  <tr>
                    <th className="text-left px-2 py-1.5">Proveedor (fila)</th>
                    <th className="text-left px-2 py-1.5">Celda</th>
                    <th className="text-left px-2 py-1.5">Concepto</th>
                    <th className="text-right px-2 py-1.5">Total</th>
                    <th className="text-right px-2 py-1.5">Tenía</th>
                    <th className="text-left px-2 py-1.5">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-cream-200">
                  {r.celdas.map((c) => (
                    <tr key={c.ref}>
                      <td className="px-2 py-1.5 text-ink-700">{c.etiqueta}</td>
                      <td className="px-2 py-1.5 font-mono text-2xs text-ink-500">{c.ref}</td>
                      <td className="px-2 py-1.5 text-ink-600 text-2xs">
                        {c.concepto === 'RECIBIDO' ? 'Recibido' : 'Pagos'}
                        {/* Un término por comprobante: así se ve de dónde
                            salió el total sin abrir el sistema. */}
                        {c.terminos.length > 1 && (
                          <span className="text-ink-300"> ({c.terminos.length} comprobantes)</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmt(c.total)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-2xs text-ink-500">
                        {c.valorPrevio === null || c.valorPrevio === '' ? '—' : String(c.valorPrevio)}
                      </td>
                      <td className="px-2 py-1.5">
                        <span
                          className={cn('text-2xs px-1.5 py-0.5 rounded', ESTADO_CLASS[c.estado])}
                        >
                          {ESTADO_LABEL[c.estado]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Lo que el volcado NO cubre. Sin esto, esa plata desaparece del
              Excel y nadie se entera. */}
          {r.proveedoresSinFila.length > 0 && (
            <div className="bg-saffron-100 text-saffron-700 px-3 py-2 rounded text-2xs">
              <p className="font-medium mb-1">
                Estos proveedores tuvieron movimiento pero no tienen fila asignada, así que no se
                escriben:
              </p>
              <ul className="space-y-0.5">
                {r.proveedoresSinFila.map((p) => (
                  <li key={p.id}>
                    {p.nombre} — {fmt(p.total)}
                  </li>
                ))}
              </ul>
              <p className="mt-1">Asignales una fila abajo, en &quot;Filas del Excel&quot;.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Hoja "Compras" — catálogo y cantidades
// ────────────────────────────────────────────────────────────────────────

function PanelCompras({ habilitado }: { habilitado: boolean }) {
  const [imp, setImp] = useState<ResultadoImportacion | null>(null);
  const [cant, setCant] = useState<ResultadoCantidades | null>(null);
  const [fecha, setFecha] = useState(hoyLocal());
  const [pisar, setPisar] = useState(false);
  const [cargando, setCargando] = useState<'import' | 'cantidades' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function importar(simular: boolean) {
    setCargando('import');
    setError(null);
    setOk(null);
    try {
      const r = await api.post<ResultadoImportacion>('/admin/excel-compras/importar', { simular });
      setImp(r);
      if (!simular) {
        setOk(
          `Importado: ${r.insumosCreados} productos nuevos, ${r.insumosActualizados} actualizados, ${r.preciosCargados} con precio.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo importar');
    } finally {
      setCargando(null);
    }
  }

  async function volcarCantidades(simular: boolean) {
    setCargando('cantidades');
    setError(null);
    setOk(null);
    try {
      const r = await api.post<ResultadoCantidades>('/admin/excel-compras/volcar', {
        fecha: aIso(fecha),
        simular,
        pisarDiferencias: pisar,
      });
      setCant(r);
      if (!simular) {
        setOk(
          r.escritas === 0
            ? 'No hizo falta escribir nada: las cantidades ya estaban.'
            : `Listo: ${r.escritas} cantidad${r.escritas === 1 ? '' : 'es'} escrita${r.escritas === 1 ? '' : 's'} en la semana ${r.semana}.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo volcar');
    } finally {
      setCargando(null);
    }
  }

  const pendientes = cant ? aEscribir(cant.celdas, pisar) : 0;

  return (
    <section className="card p-4 space-y-4">
      <header>
        <h3 className="font-display text-md text-ink-900">Compras — productos y cantidades</h3>
        <p className="text-2xs text-ink-500">
          La hoja con todos los productos de cada proveedor, su presentación y su precio.
        </p>
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}
      {ok && <div className="bg-teresita-100 text-teresita-900 px-3 py-2 rounded text-sm">{ok}</div>}

      {/* ── Traer los productos ── */}
      <div className="space-y-2 border-b border-cream-200 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-700 mr-auto">Traer los productos al sistema</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void importar(true)}
            disabled={cargando !== null || !habilitado}
          >
            {cargando === 'import' ? 'Leyendo…' : 'Ver qué traería'}
          </Button>
          {imp && imp.simulado && (
            <Button size="sm" onClick={() => void importar(false)} disabled={cargando !== null}>
              Importar
            </Button>
          )}
        </div>
        <p className="text-2xs text-ink-500">
          Se puede correr las veces que haga falta: cada producto se reconoce por su nombre en el
          Excel, así que actualiza en vez de duplicar.
        </p>

        {imp && (
          <div className="text-2xs text-ink-600 space-y-1 bg-cream-100 rounded px-3 py-2">
            <p>
              {imp.insumosCreados} productos nuevos · {imp.insumosActualizados} ya estaban ·{' '}
              {imp.preciosCargados} con precio en la hoja
            </p>
            {imp.proveedoresNuevos.length > 0 && (
              <p>
                Proveedores que se crean: <strong>{imp.proveedoresNuevos.join(', ')}</strong>
              </p>
            )}
            {imp.sinPrecio.length > 0 && (
              <p className="text-saffron-700">
                {imp.sinPrecio.length} productos sin precio en la hoja — se cargan igual, el precio
                se completa a mano desde la ficha del proveedor.
              </p>
            )}
            {/* Un producto repetido en la hoja se importa una sola vez: la
                fila de abajo nunca recibiría cantidades y quedaría vacía sin
                que se entienda por qué. */}
            {imp.duplicadosEnExcel.length > 0 && (
              <p className="text-saffron-700">
                Repetidos en la hoja (se toma el de más arriba, conviene borrar el otro):{' '}
                {imp.duplicadosEnExcel.join(' · ')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Volcar las cantidades de la semana ── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <span className="text-sm text-ink-700 mr-auto self-center">
            Escribir las cantidades compradas de la semana
          </span>
          <label className="text-2xs text-ink-500">
            <span className="block mb-1">Semana del día</span>
            <input
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              className="input text-sm py-1"
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void volcarCantidades(true)}
            disabled={cargando !== null || !habilitado}
          >
            {cargando === 'cantidades' ? 'Calculando…' : 'Ver qué se escribiría'}
          </Button>
          {cant && pendientes > 0 && (
            <Button
              size="sm"
              onClick={() => void volcarCantidades(false)}
              disabled={cargando !== null}
            >
              Escribir {pendientes}
            </Button>
          )}
        </div>

        {cant && (
          <div className="space-y-2">
            <p className="text-sm text-ink-700">
              Semana <strong>{cant.semana}</strong> ·{' '}
              {cant.celdas.length === 0
                ? 'no hay compras cargadas para esta semana'
                : `${pendientes} para escribir`}
              {cant.diferencias > 0 && (
                <span className="text-saffron-700"> · {cant.diferencias} no coinciden</span>
              )}
            </p>

            {cant.diferencias > 0 && (
              <label className="flex items-center gap-2 text-2xs text-saffron-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pisar}
                  onChange={(e) => setPisar(e.target.checked)}
                  className="w-4 h-4"
                />
                Pisar las cantidades que no coinciden
              </label>
            )}

            {cant.celdas.length > 0 && (
              <div className="overflow-x-auto max-h-80">
                <table className="w-full text-sm">
                  <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
                    <tr>
                      <th className="text-left px-2 py-1.5">Producto</th>
                      <th className="text-left px-2 py-1.5">Proveedor</th>
                      <th className="text-left px-2 py-1.5">Celda</th>
                      <th className="text-right px-2 py-1.5">Cantidad</th>
                      <th className="text-left px-2 py-1.5">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cream-200">
                    {cant.celdas.map((c) => (
                      <tr key={c.ref}>
                        <td className="px-2 py-1.5 text-ink-700">{c.insumo}</td>
                        <td className="px-2 py-1.5 text-ink-600 text-2xs">{c.proveedor}</td>
                        <td className="px-2 py-1.5 font-mono text-2xs text-ink-500">{c.ref}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{c.cantidad}</td>
                        <td className="px-2 py-1.5">
                          <span
                            className={cn('text-2xs px-1.5 py-0.5 rounded', ESTADO_CLASS[c.estado])}
                          >
                            {ESTADO_LABEL[c.estado]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Ítems que el OCR no supo a qué producto corresponden. No se les
                inventa una fila: escribir en el renglón equivocado es peor
                que no escribir. */}
            {cant.itemsSinInsumo.length > 0 && (
              <div className="bg-saffron-100 text-saffron-700 px-3 py-2 rounded text-2xs">
                <p className="font-medium mb-1">
                  Estos ítems de las facturas no están vinculados a ningún producto, así que no se
                  escriben:
                </p>
                <ul className="space-y-0.5">
                  {cant.itemsSinInsumo.slice(0, 15).map((i, n) => (
                    <li key={`${i.proveedor}-${i.descripcion}-${n}`}>
                      {i.descripcion} ({i.proveedor}) — {i.cantidad}
                    </li>
                  ))}
                </ul>
                {cant.itemsSinInsumo.length > 15 && (
                  <p className="mt-1">y {cant.itemsSinInsumo.length - 15} más.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Mapeo fila del Excel ↔ proveedor del sistema
// ────────────────────────────────────────────────────────────────────────

/**
 * Las filas de la hoja NO son proveedores uno a uno: "Grafipack en Blanco" y
 * "Grafipack en Negro" son el mismo proveedor partido según el comprobante,
 * y "Verduras" o "Limpieza" son rubros que juntan a varios. Por eso esto se
 * carga a mano una vez y no se adivina: mezclar la cuenta de dos proveedores
 * se descubre tarde y se limpia peor.
 */
function PanelMapeo({
  estructura,
  onCambio,
}: {
  estructura: Estructura | null;
  onCambio: () => Promise<void>;
}) {
  const [proveedores, setProveedores] = useState<Array<{ id: string; nombre: string }>>([]);
  const [abierto, setAbierto] = useState(false);
  const [guardando, setGuardando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lo que se eligió en el selector de cada fila, antes de guardarlo.
  const [seleccion, setSeleccion] = useState<Record<string, string>>({});
  const [tipos, setTipos] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!abierto) return;
    api
      .get<{ proveedores: Array<{ id: string; nombre: string }> }>('/admin/proveedores')
      .then((r) => setProveedores(r.proveedores))
      .catch(() => setProveedores([]));
  }, [abierto]);

  // `sugeridoId` es el fallback: si nunca tocó el selector, vale lo que el
  // selector está mostrando (la sugerencia). Que el botón haga lo que se ve.
  async function asignar(etiqueta: string, sugeridoId?: string) {
    const proveedorId = seleccion[etiqueta] || sugeridoId;
    if (!proveedorId) return;
    setGuardando(etiqueta);
    setError(null);
    try {
      await api.post('/admin/excel-proveedores/mapeo', {
        etiquetaExcel: etiqueta,
        proveedorId,
        // Vacío = todos los comprobantes de ese proveedor van a esta fila.
        tiposComprobante: (tipos[etiqueta] ?? '')
          .split(',')
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean),
      });
      await onCambio();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el mapeo');
    } finally {
      setGuardando(null);
    }
  }

  async function quitar(id: string) {
    setGuardando(id);
    setError(null);
    try {
      await api.delete(`/admin/excel-proveedores/mapeo/${id}`);
      await onCambio();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo quitar el mapeo');
    } finally {
      setGuardando(null);
    }
  }

  if (!estructura) return null;

  const porEtiqueta = new Map<string, Estructura['mapeos']>();
  for (const m of estructura.mapeos) {
    porEtiqueta.set(m.etiquetaExcel, [...(porEtiqueta.get(m.etiquetaExcel) ?? []), m]);
  }
  const sugerido = new Map(estructura.sugerencias.map((s) => [s.etiqueta, s.sugerido]));
  const sinAsignar = estructura.etiquetas.filter((e) => !porEtiqueta.has(e)).length;

  return (
    <section className="card p-4 space-y-3">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-md text-ink-900">Filas del Excel</h3>
          <p className="text-2xs text-ink-500">
            A qué proveedor del sistema corresponde cada fila de la planilla.{' '}
            {sinAsignar > 0 ? (
              <span className="text-saffron-700">
                {sinAsignar} de {estructura.etiquetas.length} sin asignar.
              </span>
            ) : (
              <span>Todas asignadas.</span>
            )}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setAbierto((v) => !v)}>
          {abierto ? 'Ocultar' : 'Ver y editar'}
        </Button>
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}

      {abierto && (
        <div className="space-y-1">
          {estructura.etiquetas.map((etiqueta) => {
            const mapeos = porEtiqueta.get(etiqueta) ?? [];
            const sug = sugerido.get(etiqueta);
            return (
              <div
                key={etiqueta}
                className="flex flex-wrap items-center gap-2 py-2 border-b border-cream-200 last:border-0"
              >
                <span className="text-sm text-ink-700 w-48 shrink-0">{etiqueta}</span>

                {mapeos.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 flex-1">
                    {mapeos.map((m) => (
                      <span
                        key={m.id}
                        className="inline-flex items-center gap-1.5 bg-steel-50 text-steel-700 text-2xs px-2 py-1 rounded"
                      >
                        {m.proveedorNombre}
                        {m.tiposComprobante.length > 0 && (
                          <span className="text-ink-500">({m.tiposComprobante.join('/')})</span>
                        )}
                        <button
                          onClick={() => void quitar(m.id)}
                          disabled={guardando === m.id}
                          className="text-ink-500 hover:text-pomodoro-600"
                          aria-label={`Quitar ${m.proveedorNombre}`}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-2xs text-ink-300 flex-1">sin asignar</span>
                )}

                <select
                  value={seleccion[etiqueta] ?? sug?.id ?? ''}
                  onChange={(e) => setSeleccion({ ...seleccion, [etiqueta]: e.target.value })}
                  className="input text-2xs py-1 w-44"
                >
                  <option value="">
                    {sug ? `sugerido: ${sug.nombre}` : 'elegir proveedor…'}
                  </option>
                  {proveedores.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
                <input
                  value={tipos[etiqueta] ?? ''}
                  onChange={(e) => setTipos({ ...tipos, [etiqueta]: e.target.value })}
                  placeholder="A, B  (opcional)"
                  title="Sólo si esta fila lleva ciertos comprobantes de ese proveedor (por ejemplo A y B en una fila, X en otra). Vacío = todos."
                  className="input text-2xs py-1 w-32"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void asignar(etiqueta, sug?.id)}
                  disabled={guardando === etiqueta || !(seleccion[etiqueta] || sug?.id)}
                >
                  {guardando === etiqueta ? '…' : 'Asignar'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
