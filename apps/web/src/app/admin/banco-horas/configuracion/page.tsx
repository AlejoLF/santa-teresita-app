'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';

/**
 * Categorías laborales y tipos de hora.
 *
 * El aumento de una categoría pasa SIEMPRE por el modal de impacto: con
 * revaluación, subir el valor no toca sólo las horas futuras — mueve toda la
 * deuda acumulada de golpe (SPEC §14.6). Si no se ve antes de confirmar, la
 * encargada se entera cuando ya está hecho.
 */

interface Categoria {
  id: string;
  nombre: string;
  valorHora: string;
  activo: boolean;
  empleados: number;
}
interface TipoHora {
  id: string;
  nombre: string;
  multiplicador: string | null;
  valorHoraFijo: string | null;
  activo: boolean;
}
interface Impacto {
  empleadosAfectados: number;
  horasPendientes: string;
  valorActual: string;
  valorNuevo: string;
  deudaAntes: string;
  deudaDespues: string;
  diferencia: string;
}

export default function ConfigBancoHorasPage() {
  const [cats, setCats] = useState<Categoria[]>([]);
  const [tipos, setTipos] = useState<TipoHora[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Categoria | null>(null);
  const [nuevaCat, setNuevaCat] = useState(false);
  const [nuevoTipo, setNuevoTipo] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const r = await api.get<{ categorias: Categoria[]; tiposHora: TipoHora[] }>(
        '/admin/banco-horas-config',
      );
      setCats(r.categorias);
      setTipos(r.tiposHora);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar');
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <Link href="/admin/banco-horas" className="text-2xs text-ink-500 hover:text-teresita-700">
        ← Banco de horas
      </Link>

      <header>
        <h1 className="font-display text-xl text-ink-900">Categorías y tipos de hora</h1>
        <p className="text-sm text-ink-500">
          El valor hora se define por categoría: cambiarlo acá afecta a todos los empleados de esa
          categoría, sin tener que editarlos uno por uno.
        </p>
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-ink-900">Categorías</h2>
          <Button size="sm" variant="secondary" onClick={() => setNuevaCat(true)}>
            + Nueva
          </Button>
        </div>
        <div className="card divide-y divide-cream-200">
          {cats.length === 0 && (
            <p className="p-4 text-sm text-ink-500 italic">
              Todavía no hay categorías. Creá una para poder cargarle horas a alguien.
            </p>
          )}
          {cats.map((c) => (
            <div key={c.id} className="p-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-ink-900">{c.nombre}</div>
                <div className="text-2xs text-ink-500">
                  {c.empleados} empleado{c.empleados !== 1 && 's'}
                  {!c.activo && ' · inactiva'}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <MoneyAmount value={c.valorHora} className="font-mono" />
                <span className="text-2xs text-ink-500">/h</span>
                <Button size="sm" variant="secondary" onClick={() => setEditando(c)}>
                  Cambiar
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-ink-900">Tipos de hora</h2>
          <Button size="sm" variant="secondary" onClick={() => setNuevoTipo(true)}>
            + Nuevo
          </Button>
        </div>
        <div className="card divide-y divide-cream-200">
          {tipos.map((t) => (
            <div key={t.id} className="p-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-ink-900">{t.nombre}</div>
                <div className="text-2xs text-ink-500">
                  {t.multiplicador
                    ? `×${Number(t.multiplicador)} sobre la categoría — sube sola cuando sube el valor hora`
                    : `valor fijo — no sigue a la categoría, se actualiza aparte`}
                </div>
              </div>
              <div className="font-mono text-sm text-ink-900">
                {t.multiplicador ? `×${Number(t.multiplicador)}` : <MoneyAmount value={t.valorHoraFijo!} />}
              </div>
            </div>
          ))}
        </div>
      </section>

      {nuevaCat && (
        <ModalNuevaCategoria
          onClose={() => setNuevaCat(false)}
          onHecho={() => {
            setNuevaCat(false);
            void cargar();
          }}
        />
      )}
      {nuevoTipo && (
        <ModalNuevoTipo
          onClose={() => setNuevoTipo(false)}
          onHecho={() => {
            setNuevoTipo(false);
            void cargar();
          }}
        />
      )}
      {editando && (
        <ModalCambiarValor
          categoria={editando}
          onClose={() => setEditando(null)}
          onHecho={() => {
            setEditando(null);
            void cargar();
          }}
        />
      )}
    </div>
  );
}

function ModalNuevaCategoria({ onClose, onHecho }: { onClose: () => void; onHecho: () => void }) {
  const [nombre, setNombre] = useState('');
  const [valor, setValor] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center p-4 z-50">
      <div className="card p-4 w-full max-w-sm space-y-3">
        <h2 className="font-display text-lg text-ink-900">Nueva categoría</h2>
        <label className="block text-2xs text-ink-500">
          Nombre
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Cocina, Mostrador, Reparto…"
            className="input w-full mt-1 text-sm"
          />
        </label>
        <label className="block text-2xs text-ink-500">
          Valor hora
          <input
            type="number"
            min="1"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            className="input w-full mt-1 text-sm"
          />
        </label>
        {error && <p className="text-2xs text-pomodoro-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            size="sm"
            disabled={!nombre.trim() || !(Number(valor) > 0)}
            onClick={async () => {
              try {
                await api.post('/admin/banco-horas-config/categorias', {
                  nombre: nombre.trim(),
                  valorHora: Number(valor),
                });
                onHecho();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'No se pudo crear');
              }
            }}
          >
            Crear
          </Button>
        </div>
      </div>
    </div>
  );
}

function ModalNuevoTipo({ onClose, onHecho }: { onClose: () => void; onHecho: () => void }) {
  const [nombre, setNombre] = useState('');
  const [forma, setForma] = useState<'multiplicador' | 'fijo'>('multiplicador');
  const [valor, setValor] = useState('1.5');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center p-4 z-50">
      <div className="card p-4 w-full max-w-sm space-y-3">
        <h2 className="font-display text-lg text-ink-900">Nuevo tipo de hora</h2>
        <label className="block text-2xs text-ink-500">
          Nombre
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Extra 50%, Feriado, Nocturna…"
            className="input w-full mt-1 text-sm"
          />
        </label>
        <div className="space-y-1">
          <span className="text-2xs text-ink-500">Cómo se calcula</span>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              checked={forma === 'multiplicador'}
              onChange={() => {
                setForma('multiplicador');
                setValor('1.5');
              }}
              className="mt-1"
            />
            <span>
              Multiplicador sobre la categoría
              <span className="block text-2xs text-ink-500">
                Sube sola cuando sube el valor hora de la categoría.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              checked={forma === 'fijo'}
              onChange={() => {
                setForma('fijo');
                setValor('');
              }}
              className="mt-1"
            />
            <span>
              Valor fijo por hora
              <span className="block text-2xs text-ink-500">
                No sigue a la categoría: hay que actualizarlo a mano cuando corresponda.
              </span>
            </span>
          </label>
        </div>
        <label className="block text-2xs text-ink-500">
          {forma === 'multiplicador' ? 'Multiplicador (1.5 = 50% más)' : 'Valor por hora'}
          <input
            type="number"
            step={forma === 'multiplicador' ? '0.1' : '1'}
            min="0.1"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            className="input w-full mt-1 text-sm"
          />
        </label>
        {error && <p className="text-2xs text-pomodoro-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            size="sm"
            disabled={!nombre.trim() || !(Number(valor) > 0)}
            onClick={async () => {
              try {
                await api.post('/admin/banco-horas-config/tipos-hora', {
                  nombre: nombre.trim(),
                  ...(forma === 'multiplicador'
                    ? { multiplicador: Number(valor) }
                    : { valorHoraFijo: Number(valor) }),
                });
                onHecho();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'No se pudo crear');
              }
            }}
          >
            Crear
          </Button>
        </div>
      </div>
    </div>
  );
}

function ModalCambiarValor({
  categoria,
  onClose,
  onHecho,
}: {
  categoria: Categoria;
  onClose: () => void;
  onHecho: () => void;
}) {
  const [valor, setValor] = useState(categoria.valorHora);
  const [impacto, setImpacto] = useState<Impacto | null>(null);
  const [error, setError] = useState<string | null>(null);

  // El impacto se recalcula mientras escribe: es la información que decide si
  // confirma o no, así que tiene que estar antes del clic, no después.
  useEffect(() => {
    const n = Number(valor);
    if (!(n > 0) || n === Number(categoria.valorHora)) {
      setImpacto(null);
      return;
    }
    const t = setTimeout(() => {
      void api
        .get<Impacto>(
          `/admin/banco-horas-config/categorias/${categoria.id}/impacto?valorHora=${n}`,
        )
        .then(setImpacto)
        .catch(() => setImpacto(null));
    }, 300);
    return () => clearTimeout(t);
  }, [valor, categoria]);

  const dif = impacto ? Number(impacto.diferencia) : 0;

  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center p-4 z-50">
      <div className="card p-4 w-full max-w-sm space-y-3">
        <h2 className="font-display text-lg text-ink-900">{categoria.nombre}</h2>
        <label className="block text-2xs text-ink-500">
          Valor hora
          <input
            type="number"
            min="1"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            className="input w-full mt-1 text-sm"
          />
        </label>

        {impacto && dif !== 0 && (
          <div className="bg-saffron-100 text-saffron-700 px-3 py-2 rounded text-2xs space-y-1">
            <p className="font-medium">Esto no afecta sólo a las horas futuras.</p>
            <p>
              Las {impacto.horasPendientes} hs pendientes de {impacto.empleadosAfectados}{' '}
              empleado{impacto.empleadosAfectados !== 1 && 's'} pasan a valer:
            </p>
            <p className="font-mono">
              <MoneyAmount value={impacto.deudaAntes} /> →{' '}
              <MoneyAmount value={impacto.deudaDespues} />
            </p>
            <p className="font-medium">
              La deuda {dif > 0 ? 'sube' : 'baja'}{' '}
              <MoneyAmount value={Math.abs(dif).toFixed(2)} />.
            </p>
          </div>
        )}
        {impacto && dif === 0 && (
          <p className="text-2xs text-ink-500">
            Nadie tiene horas pendientes en esta categoría, así que sólo aplica de acá en
            adelante.
          </p>
        )}

        {error && <p className="text-2xs text-pomodoro-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            size="sm"
            disabled={!(Number(valor) > 0) || Number(valor) === Number(categoria.valorHora)}
            onClick={async () => {
              try {
                await api.patch(`/admin/banco-horas-config/categorias/${categoria.id}`, {
                  valorHora: Number(valor),
                });
                onHecho();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'No se pudo guardar');
              }
            }}
          >
            Confirmar
          </Button>
        </div>
      </div>
    </div>
  );
}
