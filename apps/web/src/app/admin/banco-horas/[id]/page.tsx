'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

/** El libro de una persona + cargar horas, dar un adelanto y liquidar. */

interface Movimiento {
  id: string;
  tipo: 'HORAS_TRABAJADAS' | 'ADELANTO' | 'LIQUIDACION' | 'AJUSTE';
  horas: string | null;
  montoPesos: string | null;
  fecha: string;
  observacion: string | null;
  liquidado: boolean;
  tipoHora: string | null;
  /** Sólo viene cuando ese día fue una excepción (se trabajó en otra). */
  categoria: string | null;
  valorHoraFila: string | null;
  usuario: string;
}

interface Detalle {
  empleado: {
    id: string;
    nombre: string;
    apellido: string | null;
    categoria: string | null;
    categoriaLaboralId: string | null;
    valorHoraPropio: string | null;
    valorHora: string;
  };
  saldo: {
    horasPendientes: string;
    montoHoras: string;
    adelantosPendientes: string;
    saldo: string;
    sinValorHora: boolean;
  };
  movimientos: Movimiento[];
}

const ETIQUETA: Record<Movimiento['tipo'], string> = {
  HORAS_TRABAJADAS: 'Horas trabajadas',
  ADELANTO: 'Adelanto',
  LIQUIDACION: 'Liquidación',
  AJUSTE: 'Ajuste',
};

function hoyInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function BancoHorasEmpleadoPage() {
  const params = useParams();
  const id = params.id as string;

  const [d, setD] = useState<Detalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<'horas' | 'adelanto' | 'liquidar' | null>(null);
  const [editandoTarifa, setEditandoTarifa] = useState(false);
  const [tipos, setTipos] = useState<Array<{ id: string; nombre: string }>>([]);
  const [categorias, setCategorias] = useState<Array<{ id: string; nombre: string }>>([]);
  const [cuentas, setCuentas] = useState<Array<{ id: string; nombre: string }>>([]);

  const cargar = useCallback(async () => {
    try {
      const r = await api.get<Detalle>(`/admin/banco-horas/${id}`);
      setD(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar');
    }
  }, [id]);

  useEffect(() => {
    void cargar();
    void api
      .get<{
        tiposHora: Array<{ id: string; nombre: string; activo: boolean }>;
        categorias: Array<{ id: string; nombre: string; activo: boolean }>;
      }>('/admin/banco-horas-config')
      .then((r) => {
        setTipos(r.tiposHora.filter((t) => t.activo));
        setCategorias(r.categorias.filter((c) => c.activo));
      })
      .catch(() => {});
    void api
      .get<{ cuentas: Array<{ id: string; nombre: string }> }>('/admin/cuentas')
      .then((r) => setCuentas(r.cuentas))
      .catch(() => {});
  }, [cargar]);

  if (error) {
    return <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>;
  }
  if (!d) return <p className="text-ink-500 text-sm p-4">Cargando…</p>;

  const nombre = `${d.empleado.nombre}${d.empleado.apellido ? ' ' + d.empleado.apellido : ''}`;
  const saldoNum = Number(d.saldo.saldo);

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <Link href="/admin/banco-horas" className="text-2xs text-ink-500 hover:text-teresita-700">
        ← Banco de horas
      </Link>

      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-xl text-ink-900">{nombre}</h1>
          <p className="text-sm text-ink-500">
            {d.empleado.categoria ??
              (d.empleado.valorHoraPropio ? 'valor propio' : 'sin categoría')}{' '}
            ·{' '}
            {Number(d.empleado.valorHora) > 0 ? (
              <>
                <MoneyAmount value={d.empleado.valorHora} />/h
              </>
            ) : (
              <span className="text-saffron-700">sin valor hora</span>
            )}{' '}
            <button
              type="button"
              className="text-2xs text-teresita-700 hover:underline"
              onClick={() => setEditandoTarifa(true)}
            >
              cambiar
            </button>
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="secondary" onClick={() => setModal('horas')}>
            ➕ Cargar horas
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setModal('adelanto')}>
            💸 Adelanto
          </Button>
          <Button size="sm" onClick={() => setModal('liquidar')}>
            ✅ Liquidar
          </Button>
        </div>
      </header>

      {d.saldo.sinValorHora && (
        <div className="bg-saffron-100 text-saffron-700 px-3 py-2 rounded text-sm">
          Tiene horas cargadas pero no tiene valor hora, así que se están contando como $0.
          Asignale una categoría en Configuración → Categorías, o cargale un valor propio.
        </div>
      )}

      <section className="card p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
        <div>
          <div className="text-2xs uppercase tracking-wider text-ink-500">Horas pendientes</div>
          <div className="font-mono text-lg text-ink-900">{d.saldo.horasPendientes}</div>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wider text-ink-500">En pesos</div>
          <MoneyAmount value={d.saldo.montoHoras} className="text-lg text-basil-600" />
        </div>
        <div>
          {/* Deuda propia, no un descuento automático: se devuelve de a poco,
              los días que la encargada decide. */}
          <div className="text-2xs uppercase tracking-wider text-ink-500">Préstamos</div>
          <MoneyAmount value={d.saldo.adelantosPendientes} className="text-lg text-saffron-600" />
          <div className="text-2xs text-ink-400">que él debe</div>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wider text-ink-500">Diferencia</div>
          <MoneyAmount
            value={d.saldo.saldo}
            className={cn('text-lg font-medium', saldoNum < 0 && 'text-pomodoro-600')}
          />
          <div className="text-2xs text-ink-400">
            {saldoNum < 0 ? 'a favor del local' : 'si se cancelara todo'}
          </div>
        </div>
      </section>

      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-3 py-2">Fecha</th>
              <th className="text-left px-3 py-2">Detalle</th>
              <th className="text-right px-3 py-2">Horas</th>
              <th className="text-right px-3 py-2">Pesos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {d.movimientos.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center text-ink-500 py-8 italic">
                  Todavía no hay movimientos.
                </td>
              </tr>
            )}
            {d.movimientos.map((m) => (
              <tr key={m.id} className={cn(m.liquidado && 'opacity-50')}>
                <td className="px-3 py-2 text-xs font-mono text-ink-500 whitespace-nowrap">
                  {m.liquidado && '✅ '}
                  {new Date(m.fecha).toLocaleDateString('es-AR', {
                    day: '2-digit',
                    month: '2-digit',
                  })}
                </td>
                <td className="px-3 py-2">
                  {ETIQUETA[m.tipo]}
                  {m.tipoHora && m.tipo === 'HORAS_TRABAJADAS' && (
                    <span className="text-2xs text-ink-500"> · {m.tipoHora}</span>
                  )}
                  {/* La categoría sólo aparece si ese día fue una excepción:
                      repetir "Mostrador" en cada fila sería ruido, y el día que
                      dice "Cocina" tiene que saltar a la vista. */}
                  {m.categoria && (
                    <span className="ml-1 text-2xs bg-steel-100 text-steel-700 px-1.5 py-0.5 rounded">
                      {m.categoria}
                    </span>
                  )}
                  {m.observacion && (
                    <div className="text-2xs text-ink-500">{m.observacion}</div>
                  )}
                  <div className="text-2xs text-ink-400">{m.usuario}</div>
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {m.horas ? (
                    <span className={Number(m.horas) < 0 ? 'text-ink-500' : 'text-ink-900'}>
                      {Number(m.horas) > 0 ? '+' : ''}
                      {m.horas}
                    </span>
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {m.montoPesos ? (
                    <MoneyAmount value={m.montoPesos} className="text-saffron-600" />
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-2xs text-ink-500 px-1">
        Nada de esto se edita. Si hay un error, se corrige con un movimiento nuevo — así queda
        registrado qué pasó y quién lo hizo.
      </p>

      {editandoTarifa && (
        <ModalTarifa
          empleadoId={id}
          nombre={nombre}
          categoriaActual={d.empleado.categoriaLaboralId}
          valorPropioActual={d.empleado.valorHoraPropio}
          categorias={categorias}
          onClose={() => setEditandoTarifa(false)}
          onHecho={() => {
            setEditandoTarifa(false);
            void cargar();
          }}
        />
      )}

      {modal && (
        <ModalAccion
          tipo={modal}
          empleadoId={id}
          nombre={nombre}
          categoriaHabitual={
            d.empleado.categoria ??
            (d.empleado.valorHoraPropio ? 'valor propio' : 'sin categoría')
          }
          saldo={d.saldo}
          tipos={tipos}
          categorias={categorias}
          cuentas={cuentas}
          onClose={() => setModal(null)}
          onHecho={() => {
            setModal(null);
            void cargar();
          }}
        />
      )}
    </div>
  );
}
// ══════════════════════════════════════════════════════════════════════════
//   Cómo se paga: concepto + una o varias cuentas
// ══════════════════════════════════════════════════════════════════════════
//
// Es el mismo formulario que el pago de sueldo de la ficha del empleado, y a
// propósito: la encargada ya sabe repartir un pago entre efectivo y
// transferencia, y esto no es un pago distinto — es el mismo pago, con las
// horas atrás.

type Metodo = 'EFECTIVO' | 'TRANSFERENCIA' | 'DEPOSITO' | 'CHEQUE' | 'MERCADOPAGO_QR' | 'OTRO';

const METODOS: Array<{ v: Metodo; label: string }> = [
  { v: 'EFECTIVO', label: 'Efectivo' },
  { v: 'TRANSFERENCIA', label: 'Transferencia' },
  { v: 'DEPOSITO', label: 'Depósito' },
  { v: 'CHEQUE', label: 'Cheque' },
  { v: 'MERCADOPAGO_QR', label: 'MercadoPago' },
  { v: 'OTRO', label: 'Otro' },
];

interface Linea {
  cuentaId: string;
  monto: string;
  metodo: Metodo;
  numeroReferencia: string;
}

/**
 * Cómo se reparte lo que valen las horas: cuánto se le paga y cuánto va contra
 * el préstamo.
 *
 * El default cubre el día normal —se paga todo, el préstamo no se toca— así
 * que en el caso de todos los días no hay nada que tocar acá. Los campos están
 * porque el préstamo se devuelve de a poco, cuando ella decide, y porque a
 * veces se paga una parte y el resto queda para otro día.
 */
function Reparto({
  disponible,
  prestamos,
  pagado,
  setPagado,
  alPrestamo,
  setAlPrestamo,
}: {
  disponible: number;
  prestamos: number;
  pagado: string;
  setPagado: (v: string) => void;
  alPrestamo: string;
  setAlPrestamo: (v: string) => void;
}) {
  const p = Number(pagado || 0);
  const a = Number(alPrestamo || 0);
  const queda = Math.round((disponible - p - a) * 100) / 100;
  const excedido = queda < -0.005;
  const excedePrestamo = a > prestamos + 0.005;

  return (
    <div className="bg-cream-100 rounded p-3 space-y-2">
      <div className="flex justify-between text-sm font-medium">
        <span>Horas para cobrar</span>
        <MoneyAmount value={disponible.toFixed(2)} />
      </div>

      <label className="block text-2xs text-ink-500">
        Se le paga ahora
        <input
          type="number"
          step="0.01"
          min="0"
          value={pagado}
          onChange={(e) => setPagado(e.target.value)}
          className="input w-full mt-1 text-sm"
        />
      </label>

      {prestamos > 0 && (
        <label className="block text-2xs text-ink-500">
          Va contra el préstamo — debe{' '}
          <MoneyAmount value={prestamos.toFixed(2)} className="text-saffron-600" />
          <input
            type="number"
            step="0.01"
            min="0"
            value={alPrestamo}
            onChange={(e) => setAlPrestamo(e.target.value)}
            className="input w-full mt-1 text-sm"
          />
          <span className="block mt-1">
            Dejalo en 0 si esta vez no le descontás nada. El préstamo queda como está.
          </span>
        </label>
      )}

      <div className="flex justify-between text-2xs border-t border-cream-300 pt-2">
        <span className="text-ink-500">Queda sin cobrar, en horas</span>
        <MoneyAmount
          value={Math.max(0, queda).toFixed(2)}
          className={queda > 0.005 ? 'text-ink-700' : 'text-ink-300'}
        />
      </div>

      {excedido && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-2 py-1.5 rounded text-2xs">
          Estás repartiendo ${(p + a).toFixed(2)} y sólo hay ${disponible.toFixed(2)} en horas.
        </div>
      )}
      {excedePrestamo && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-2 py-1.5 rounded text-2xs">
          El préstamo pendiente es de ${prestamos.toFixed(2)}.
        </div>
      )}
    </div>
  );
}

function BloquePago({
  total,
  cuentas,
  concepto,
  setConcepto,
  conceptos,
  lineas,
  setLineas,
}: {
  total: number;
  cuentas: Array<{ id: string; nombre: string }>;
  concepto: string;
  setConcepto: (v: string) => void;
  conceptos: string[];
  lineas: Linea[];
  setLineas: (l: Linea[]) => void;
}) {
  const dividido = lineas.length > 1;
  const asignado = lineas.reduce((a, l) => a + Number(l.monto || 0), 0);
  const falta = Math.round((total - asignado) * 100) / 100;

  function set(i: number, cambio: Partial<Linea>) {
    setLineas(lineas.map((l, j) => (j === i ? { ...l, ...cambio } : l)));
  }

  return (
    <div className="space-y-3 border-t border-cream-300 pt-3">
      <label className="block text-2xs text-ink-500">
        Concepto
        <select
          value={concepto}
          onChange={(e) => setConcepto(e.target.value)}
          className="input w-full mt-1 text-sm"
        >
          {conceptos.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      {lineas.map((l, i) => (
        <div key={i} className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-2xs text-ink-500">
              Método
              <select
                value={l.metodo}
                onChange={(e) => set(i, { metodo: e.target.value as Metodo })}
                className="input w-full mt-1 text-sm"
              >
                {METODOS.map((m) => (
                  <option key={m.v} value={m.v}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-2xs text-ink-500">
              Cuenta
              <select
                value={l.cuentaId}
                onChange={(e) => set(i, { cuentaId: e.target.value })}
                className="input w-full mt-1 text-sm"
              >
                <option value="">Elegí una…</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {dividido && (
            <div className="flex items-end gap-2">
              <label className="block text-2xs text-ink-500 flex-1">
                Monto
                <input
                  type="number"
                  step="0.01"
                  value={l.monto}
                  onChange={(e) => set(i, { monto: e.target.value })}
                  className="input w-full mt-1 text-sm"
                />
              </label>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setLineas(lineas.filter((_, j) => j !== i))}
              >
                Quitar
              </Button>
            </div>
          )}
          {l.metodo !== 'EFECTIVO' && (
            <input
              value={l.numeroReferencia}
              onChange={(e) => set(i, { numeroReferencia: e.target.value })}
              className="input w-full text-sm"
              placeholder="N° de referencia (opcional)"
            />
          )}
        </div>
      ))}

      {dividido && falta !== 0 && (
        <div className="bg-saffron-100 text-saffron-700 px-3 py-2 rounded text-2xs">
          {falta > 0
            ? `Falta repartir $${falta.toFixed(2)}`
            : `Repartiste $${(-falta).toFixed(2)} de más`}
        </div>
      )}

      <button
        type="button"
        className="text-2xs text-teresita-700 hover:underline"
        onClick={() =>
          setLineas([
            ...lineas.map((l, i) =>
              // Al dividir por primera vez, la línea que había se queda con
              // todo: así el reparto arranca de un estado que ya cierra y sólo
              // hay que mover plata de una a la otra.
              i === 0 && lineas.length === 1 ? { ...l, monto: total.toFixed(2) } : l,
            ),
            { cuentaId: '', monto: '', metodo: 'TRANSFERENCIA' as Metodo, numeroReferencia: '' },
          ])
        }
      >
        + Dividir en otra cuenta
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//   El modal
// ══════════════════════════════════════════════════════════════════════════

interface PreviewPago {
  valorHora: string;
  montoNuevo: string;
  horasPendientes: string;
  montoPendiente: string;
  /** Lo que debe de préstamos. NO se descuenta solo. */
  prestamos: string;
  /** Techo de lo que se puede cobrar hoy: horas viejas + las nuevas. */
  montoHoras: string;
  sinValorHora: boolean;
}

function ModalAccion({
  tipo,
  empleadoId,
  nombre,
  categoriaHabitual,
  saldo,
  tipos,
  categorias,
  cuentas,
  onClose,
  onHecho,
}: {
  tipo: 'horas' | 'adelanto' | 'liquidar';
  empleadoId: string;
  nombre: string;
  /** Cómo se le paga habitualmente, para etiquetar la opción "la de siempre". */
  categoriaHabitual: string;
  saldo: Detalle['saldo'];
  tipos: Array<{ id: string; nombre: string }>;
  categorias: Array<{ id: string; nombre: string }>;
  cuentas: Array<{ id: string; nombre: string }>;
  onClose: () => void;
  onHecho: () => void;
}) {
  const [fecha, setFecha] = useState(hoyInput());
  const [horas, setHoras] = useState('8');
  const [tipoHoraId, setTipoHoraId] = useState('');
  // '' = la categoría de siempre del empleado. Sólo se manda si eligió otra.
  const [categoriaId, setCategoriaId] = useState('');
  const [monto, setMonto] = useState('');
  const [cuentaId, setCuentaId] = useState('');
  const [observacion, setObservacion] = useState('');
  const [yaCargado, setYaCargado] = useState<string | null>(null);
  const [pagarAhora, setPagarAhora] = useState(false);
  const [preview, setPreview] = useState<PreviewPago | null>(null);
  // Reparto: cuánto se le paga y cuánto va contra el préstamo. Vacío = todavía
  // no lo tocó, y vale el default (pagar todo, préstamo intacto).
  const [montoPagado, setMontoPagado] = useState('');
  const [alPrestamo, setAlPrestamo] = useState('0');
  const [tocoElReparto, setTocoElReparto] = useState(false);
  const [concepto, setConcepto] = useState('Sueldo');
  const [conceptos, setConceptos] = useState<string[]>(['Sueldo', 'Jornada', 'Horas extra']);
  const [lineas, setLineas] = useState<Linea[]>([
    { cuentaId: '', monto: '', metodo: 'EFECTIVO', numeroReferencia: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (tipos.length && !tipoHoraId) setTipoHoraId(tipos[0]!.id);
    if (cuentas.length && !cuentaId) setCuentaId(cuentas[0]!.id);
    if (cuentas.length && !lineas[0]!.cuentaId) {
      setLineas([{ ...lineas[0]!, cuentaId: cuentas[0]!.id }]);
    }
  }, [tipos, cuentas, tipoHoraId, cuentaId, lineas]);

  useEffect(() => {
    void api
      .get<{ opciones: Array<{ etiqueta: string }> }>(
        '/configuracion/opciones/concepto_pago_empleado',
      )
      .then((r) => {
        if (r.opciones.length) setConceptos(r.opciones.map((o) => o.etiqueta));
      })
      .catch(() => {});
  }, []);

  // Aviso de día repetido: el turno partido es legítimo, así que no se bloquea.
  // Pero el error frecuente no es el turno partido — es cargar dos veces lo mismo.
  useEffect(() => {
    if (tipo !== 'horas' || !fecha) return;
    const iso = new Date(`${fecha}T12:00:00`).toISOString();
    void api
      .get<{ horas: string }>(`/admin/banco-horas/${empleadoId}/dia?fecha=${iso}`)
      .then((r) => setYaCargado(Number(r.horas) > 0 ? r.horas : null))
      .catch(() => setYaCargado(null));
  }, [tipo, fecha, empleadoId]);

  // Cuánto quedaría a pagar. Lo calcula el servidor con el mismo código que
  // después cobra: si lo hiciera la pantalla, el número del cartel y el de la
  // caja podrían no coincidir.
  useEffect(() => {
    if (tipo !== 'horas' || !pagarAhora || !(Number(horas) > 0)) return setPreview(null);
    const qs = new URLSearchParams({ horas: String(Number(horas)) });
    if (tipoHoraId) qs.set('tipoHoraId', tipoHoraId);
    if (categoriaId) qs.set('categoriaLaboralId', categoriaId);
    let vigente = true;
    void api
      .get<PreviewPago>(`/admin/banco-horas/${empleadoId}/preview-pago?${qs}`)
      .then((r) => vigente && setPreview(r))
      .catch(() => vigente && setPreview(null));
    return () => {
      vigente = false;
    };
  }, [tipo, pagarAhora, horas, tipoHoraId, categoriaId, empleadoId]);

  // Lo que hay para cobrar HOY: en liquidar, las horas pendientes; en cargar,
  // ésas más las que se están cargando ahora.
  const disponible =
    tipo === 'liquidar' ? Number(saldo.montoHoras) : Number(preview?.montoHoras ?? 0);
  const prestamos =
    tipo === 'liquidar' ? Number(saldo.adelantosPendientes) : Number(preview?.prestamos ?? 0);

  // Mientras no lo toque, "se le paga" sigue al total: cargar 8 hs y pagarlas
  // es un solo gesto, sin escribir un número.
  const pagadoEfectivo = tocoElReparto
    ? Number(montoPagado || 0)
    : Math.max(0, Math.round((disponible - Number(alPrestamo || 0)) * 100) / 100);
  const totalAPagar = pagadoEfectivo;

  useEffect(() => {
    if (!tocoElReparto) setMontoPagado(disponible > 0 ? disponible.toFixed(2) : '');
  }, [disponible, tocoElReparto]);

  function cuerpoPago() {
    const dividido = lineas.length > 1;
    return {
      conceptoEtiqueta: concepto,
      ...(observacion.trim() && { observacion: observacion.trim() }),
      ...(dividido
        ? {
            pagos: lineas.map((l) => ({
              cuentaId: l.cuentaId,
              monto: l.monto,
              metodo: l.metodo,
              ...(l.numeroReferencia.trim() && { numeroReferencia: l.numeroReferencia.trim() }),
            })),
          }
        : { cuentaId: lineas[0]!.cuentaId, metodo: lineas[0]!.metodo }),
    };
  }

  async function enviar() {
    setEnviando(true);
    setError(null);
    try {
      if (tipo === 'horas') {
        await api.post(`/admin/banco-horas/${empleadoId}/horas`, {
          fecha: new Date(`${fecha}T12:00:00`).toISOString(),
          horas: Number(horas),
          ...(tipoHoraId && { tipoHoraId }),
          ...(categoriaId && { categoriaLaboralId: categoriaId }),
          ...(observacion.trim() && !pagarAhora && { observacion: observacion.trim() }),
          ...(pagarAhora && {
            pagarAhora: true,
            pago: cuerpoPago(),
            montoPagado: pagadoEfectivo,
            montoAlPrestamo: Number(alPrestamo || 0),
          }),
        });
      } else if (tipo === 'adelanto') {
        await api.post(`/admin/banco-horas/${empleadoId}/adelanto`, {
          monto: Number(monto),
          cuentaId,
          metodo: 'EFECTIVO',
          ...(observacion.trim() && { observacion: observacion.trim() }),
        });
      } else {
        await api.post(`/admin/banco-horas/${empleadoId}/liquidar`, {
          ...cuerpoPago(),
          montoPagado: pagadoEfectivo,
          montoAlPrestamo: Number(alPrestamo || 0),
        });
      }
      onHecho();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setEnviando(false);
    }
  }

  const titulo =
    tipo === 'horas' ? 'Cargar horas' : tipo === 'adelanto' ? 'Dar un adelanto' : 'Liquidar';
  const textoBoton =
    tipo === 'horas' && pagarAhora ? 'Cargar y pagar' : titulo;

  const faltaRepartir =
    lineas.length > 1 &&
    Math.abs(lineas.reduce((a, l) => a + Number(l.monto || 0), 0) - totalAPagar) > 0.009;
  const faltaCuenta = lineas.some((l) => !l.cuentaId);

  // El reparto no cierra: se aplica más de lo que valen las horas, se descuenta
  // más de lo que se debe, o no se aplica nada.
  const alPrestamoNum = Number(alPrestamo || 0);
  const repartoInvalido =
    disponible <= 0 ||
    totalAPagar + alPrestamoNum > disponible + 0.005 ||
    alPrestamoNum > prestamos + 0.005 ||
    totalAPagar + alPrestamoNum <= 0;

  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center p-4 z-50">
      <div className="card p-4 w-full max-w-md space-y-3 max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-lg text-ink-900">
          {titulo} — {nombre}
        </h2>

        {tipo === 'horas' && (
          <>
            <label className="block text-2xs text-ink-500">
              Día
              <input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                className="input w-full mt-1 text-sm"
              />
            </label>
            <label className="block text-2xs text-ink-500">
              Horas
              <input
                type="number"
                step="0.25"
                min="0.25"
                max="24"
                value={horas}
                onChange={(e) => setHoras(e.target.value)}
                className="input w-full mt-1 text-sm"
              />
            </label>

            {/* La categoría del día. Por defecto la de siempre: cambiarla es la
                excepción —el de Mostrador que cubrió Cocina— y no cambia la
                categoría del empleado, sólo la de este día. */}
            {categorias.length > 0 && (
              <label className="block text-2xs text-ink-500">
                Categoría de ese día
                <select
                  value={categoriaId}
                  onChange={(e) => setCategoriaId(e.target.value)}
                  className="input w-full mt-1 text-sm"
                >
                  <option value="">La de siempre — {categoriaHabitual}</option>
                  {categorias.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {categoriaId && (
              <p className="text-2xs text-ink-500">
                Sólo para este día. La categoría de {nombre} no cambia.
              </p>
            )}

            {tipos.length > 1 && (
              <label className="block text-2xs text-ink-500">
                Tipo de hora
                <select
                  value={tipoHoraId}
                  onChange={(e) => setTipoHoraId(e.target.value)}
                  className="input w-full mt-1 text-sm"
                >
                  {tipos.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nombre}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {yaCargado && (
              <div className="bg-saffron-100 text-saffron-700 px-3 py-2 rounded text-2xs">
                Ese día ya tiene <strong>{yaCargado} hs</strong> cargadas. Si es un turno
                partido está bien; si no, fijate de no cargarlo dos veces.
              </div>
            )}

            <label className="flex items-start gap-2 bg-cream-100 rounded p-3 cursor-pointer">
              <input
                type="checkbox"
                checked={pagarAhora}
                onChange={(e) => setPagarAhora(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm">
                Pagarle ahora
                <span className="block text-2xs text-ink-500">
                  Carga las horas y las paga en el acto. Sale de la caja del turno, igual que
                  un pago de sueldo.
                </span>
              </span>
            </label>

            {pagarAhora && preview && (
              <>
                <div className="bg-cream-100 rounded p-3 text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-ink-500">
                      {Number(horas).toFixed(2)} hs de hoy × ${preview.valorHora}
                    </span>
                    <MoneyAmount value={preview.montoNuevo} />
                  </div>
                  {Number(preview.horasPendientes) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-ink-500">
                        + {preview.horasPendientes} hs que ya tenía sin cobrar
                      </span>
                      <MoneyAmount value={preview.montoPendiente} />
                    </div>
                  )}
                </div>
                {preview.sinValorHora && (
                  <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-2xs">
                    Esas horas valen $0: {nombre} no tiene categoría ni valor propio. Asignale
                    una antes de pagarle.
                  </div>
                )}
                <Reparto
                  disponible={disponible}
                  prestamos={prestamos}
                  pagado={montoPagado}
                  setPagado={(v) => {
                    setTocoElReparto(true);
                    setMontoPagado(v);
                  }}
                  alPrestamo={alPrestamo}
                  setAlPrestamo={setAlPrestamo}
                />
                {/* Si no sale plata —sólo se descuenta del préstamo— no hay
                    nada que elegir: ni cuenta, ni método, ni concepto. */}
                {totalAPagar > 0 && (
                  <BloquePago
                    total={totalAPagar}
                    cuentas={cuentas}
                    concepto={concepto}
                    setConcepto={setConcepto}
                    conceptos={conceptos}
                    lineas={lineas}
                    setLineas={setLineas}
                  />
                )}
              </>
            )}
          </>
        )}

        {tipo === 'adelanto' && (
          <>
            <label className="block text-2xs text-ink-500">
              Monto
              <input
                type="number"
                min="1"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                className="input w-full mt-1 text-sm"
                placeholder="50000"
              />
            </label>
            <label className="block text-2xs text-ink-500">
              De qué cuenta sale
              <select
                value={cuentaId}
                onChange={(e) => setCuentaId(e.target.value)}
                className="input w-full mt-1 text-sm"
              >
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-2xs text-ink-500">
              Sale de la caja y queda registrado como egreso del turno, además de descontarse
              de su saldo.
            </p>
          </>
        )}

        {tipo === 'liquidar' && (
          <>
            <div className="bg-cream-100 rounded p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-500">{saldo.horasPendientes} hs sin cobrar</span>
                <MoneyAmount value={saldo.montoHoras} />
              </div>
            </div>
            {disponible <= 0 && (
              <div className="bg-saffron-100 text-saffron-700 px-3 py-2 rounded text-2xs">
                No tiene horas cargadas sin cobrar.
                {prestamos > 0 && ' Para descontarle del préstamo, cargale las horas primero.'}
              </div>
            )}
            {disponible > 0 && (
              <Reparto
                disponible={disponible}
                prestamos={prestamos}
                pagado={montoPagado}
                setPagado={(v) => {
                  setTocoElReparto(true);
                  setMontoPagado(v);
                }}
                alPrestamo={alPrestamo}
                setAlPrestamo={setAlPrestamo}
              />
            )}
            {totalAPagar > 0 && (
              <BloquePago
                total={totalAPagar}
                cuentas={cuentas}
                concepto={concepto}
                setConcepto={setConcepto}
                conceptos={conceptos}
                lineas={lineas}
                setLineas={setLineas}
              />
            )}
          </>
        )}

        <label className="block text-2xs text-ink-500">
          Observación (opcional)
          <input
            value={observacion}
            onChange={(e) => setObservacion(e.target.value)}
            className="input w-full mt-1 text-sm"
          />
        </label>

        {error && (
          <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-2xs">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={() => void enviar()}
            disabled={
              enviando ||
              (tipo === 'adelanto' && !(Number(monto) > 0)) ||
              // En las dos que mueven plata: que el reparto cierre, que no se
              // pase del préstamo, y que si sale plata haya cuenta elegida.
              ((tipo === 'liquidar' || (tipo === 'horas' && pagarAhora)) &&
                (repartoInvalido || (totalAPagar > 0 && (faltaCuenta || faltaRepartir)))) ||
              (tipo === 'horas' && pagarAhora && (!preview || preview.sinValorHora))
            }
          >
            {enviando ? 'Guardando…' : textoBoton}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//   De dónde sale su valor hora
// ══════════════════════════════════════════════════════════════════════════
//
// Hasta ahora esto sólo se podía cambiar por el API: la pantalla mostraba "sin
// categoría" y no daba forma de arreglarlo. Vive acá, en el banco de horas,
// porque es el único lugar donde ese número significa algo.

function ModalTarifa({
  empleadoId,
  nombre,
  categoriaActual,
  valorPropioActual,
  categorias,
  onClose,
  onHecho,
}: {
  empleadoId: string;
  nombre: string;
  categoriaActual: string | null;
  valorPropioActual: string | null;
  categorias: Array<{ id: string; nombre: string }>;
  onClose: () => void;
  onHecho: () => void;
}) {
  // Categoría y valor propio son excluyentes: el valor propio pisa a la
  // categoría, así que tenerlos juntos deja a la vista un dato que no se usa.
  const [modo, setModo] = useState<'categoria' | 'propio'>(
    valorPropioActual ? 'propio' : 'categoria',
  );
  const [categoriaId, setCategoriaId] = useState(categoriaActual ?? '');
  const [valorPropio, setValorPropio] = useState(valorPropioActual ?? '');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function guardar() {
    setEnviando(true);
    setError(null);
    try {
      await api.patch(`/admin/banco-horas/${empleadoId}/tarifa`, {
        categoriaLaboralId: modo === 'categoria' ? categoriaId || null : null,
        valorHoraPropio: modo === 'propio' && valorPropio ? Number(valorPropio) : null,
      });
      onHecho();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center p-4 z-50">
      <div className="card p-4 w-full max-w-sm space-y-3">
        <h2 className="font-display text-lg text-ink-900">Valor hora — {nombre}</h2>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant={modo === 'categoria' ? 'primary' : 'secondary'}
            onClick={() => setModo('categoria')}
          >
            Por categoría
          </Button>
          <Button
            size="sm"
            variant={modo === 'propio' ? 'primary' : 'secondary'}
            onClick={() => setModo('propio')}
          >
            Valor propio
          </Button>
        </div>

        {modo === 'categoria' ? (
          <label className="block text-2xs text-ink-500">
            Categoría
            <select
              value={categoriaId}
              onChange={(e) => setCategoriaId(e.target.value)}
              className="input w-full mt-1 text-sm"
            >
              <option value="">Sin categoría</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
            <span className="block mt-1">
              Si sube el valor de la categoría, sube también lo que se le debe por las horas
              que todavía no cobró.
            </span>
          </label>
        ) : (
          <label className="block text-2xs text-ink-500">
            Valor por hora, sólo para {nombre}
            <input
              type="number"
              step="0.01"
              min="1"
              value={valorPropio}
              onChange={(e) => setValorPropio(e.target.value)}
              className="input w-full mt-1 text-sm"
              placeholder="3900"
            />
            <span className="block mt-1">
              Pisa el de cualquier categoría. Un aumento general no lo toca: hay que cambiarlo
              a mano.
            </span>
          </label>
        )}

        {error && (
          <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-2xs">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={() => void guardar()}
            disabled={enviando || (modo === 'propio' && !(Number(valorPropio) > 0))}
          >
            {enviando ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>
    </div>
  );
}
