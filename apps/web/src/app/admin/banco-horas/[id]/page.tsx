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
  const [tipos, setTipos] = useState<Array<{ id: string; nombre: string }>>([]);
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
      .get<{ tiposHora: Array<{ id: string; nombre: string; activo: boolean }> }>(
        '/admin/banco-horas-config',
      )
      .then((r) => setTipos(r.tiposHora.filter((t) => t.activo)))
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
            )}
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
          <div className="text-2xs uppercase tracking-wider text-ink-500">Adelantos</div>
          <MoneyAmount value={d.saldo.adelantosPendientes} className="text-lg text-saffron-600" />
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wider text-ink-500">Saldo</div>
          <MoneyAmount
            value={d.saldo.saldo}
            className={cn('text-lg font-medium', saldoNum < 0 && 'text-pomodoro-600')}
          />
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

      {modal && (
        <ModalAccion
          tipo={modal}
          empleadoId={id}
          nombre={nombre}
          saldo={d.saldo}
          tipos={tipos}
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

function ModalAccion({
  tipo,
  empleadoId,
  nombre,
  saldo,
  tipos,
  cuentas,
  onClose,
  onHecho,
}: {
  tipo: 'horas' | 'adelanto' | 'liquidar';
  empleadoId: string;
  nombre: string;
  saldo: Detalle['saldo'];
  tipos: Array<{ id: string; nombre: string }>;
  cuentas: Array<{ id: string; nombre: string }>;
  onClose: () => void;
  onHecho: () => void;
}) {
  const [fecha, setFecha] = useState(hoyInput());
  const [horas, setHoras] = useState('8');
  const [tipoHoraId, setTipoHoraId] = useState('');
  const [monto, setMonto] = useState('');
  const [cuentaId, setCuentaId] = useState('');
  const [observacion, setObservacion] = useState('');
  const [yaCargado, setYaCargado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (tipos.length && !tipoHoraId) setTipoHoraId(tipos[0]!.id);
    if (cuentas.length && !cuentaId) setCuentaId(cuentas[0]!.id);
  }, [tipos, cuentas, tipoHoraId, cuentaId]);

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

  async function enviar() {
    setEnviando(true);
    setError(null);
    try {
      if (tipo === 'horas') {
        await api.post(`/admin/banco-horas/${empleadoId}/horas`, {
          fecha: new Date(`${fecha}T12:00:00`).toISOString(),
          horas: Number(horas),
          ...(tipoHoraId && { tipoHoraId }),
          ...(observacion.trim() && { observacion: observacion.trim() }),
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
          cuentaId,
          metodo: 'EFECTIVO',
          ...(observacion.trim() && { observacion: observacion.trim() }),
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
  const aPagar = Number(saldo.saldo);

  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center p-4 z-50">
      <div className="card p-4 w-full max-w-sm space-y-3">
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
            <div className="bg-cream-100 rounded p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-ink-500">{saldo.horasPendientes} hs</span>
                <MoneyAmount value={saldo.montoHoras} />
              </div>
              <div className="flex justify-between">
                <span className="text-ink-500">− adelantos</span>
                <MoneyAmount value={saldo.adelantosPendientes} className="text-saffron-600" />
              </div>
              <div className="flex justify-between font-medium border-t border-cream-300 pt-1">
                <span>A pagar</span>
                <MoneyAmount value={saldo.saldo} />
              </div>
            </div>
            {aPagar < 0 && (
              <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-2xs">
                Los adelantos superan las horas trabajadas. Cargá las horas que falten antes
                de liquidar.
              </div>
            )}
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
              (tipo === 'liquidar' && aPagar < 0)
            }
          >
            {enviando ? 'Guardando…' : titulo}
          </Button>
        </div>
      </div>
    </div>
  );
}
