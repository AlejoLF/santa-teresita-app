'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface Cuenta {
  id: string;
  nombre: string;
  tipo: 'EFECTIVO' | 'BANCO' | 'WALLET';
  banco: string | null;
  cbuCvu: string | null;
  alias: string | null;
  saldoActual: string;
  metodoActualizacion: 'MANUAL' | 'API_MP' | 'BELVO' | 'IMPORT_EXTRACTO';
  comisionMensual: string | null;
  activa: boolean;
}

interface CuentaACobrarRef {
  id: string;
  nombre: string;
  tipo: string;
}

interface Posnet {
  id: string;
  nombre: string;
  marca: string;
  modelo: string | null;
  adquirente: string | null;
  ubicacion: string | null;
  soportaIntegracion: boolean;
  activo: boolean;
  cuentaDestino: { id: string; nombre: string } | null;
  cuentaACobrarDebito: { id: string; nombre: string } | null;
  cuentaACobrarCredito: { id: string; nombre: string } | null;
}

interface PosnetsResp {
  posnets: Posnet[];
  cuentas: Array<{ id: string; nombre: string; tipo: string }>;
  cuentasACobrar: CuentaACobrarRef[];
}

export default function ConfigCuentasPage() {
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [posnetsData, setPosnetsData] = useState<PosnetsResp | null>(null);
  const [editingCuenta, setEditingCuenta] = useState<Cuenta | null>(null);
  const [showNuevaCuenta, setShowNuevaCuenta] = useState(false);
  const [editingPosnet, setEditingPosnet] = useState<Posnet | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        api.get<{ cuentas: Cuenta[] }>('/admin/configuracion/cuentas'),
        api.get<PosnetsResp>('/admin/configuracion/posnets'),
      ]);
      setCuentas(c.cuentas);
      setPosnetsData(p);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('Error al cargar');
      }
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {/* CUENTAS */}
      <section>
        <header className="flex items-baseline justify-between mb-3">
          <div>
            <h2 className="font-display text-md text-ink-900">Cuentas</h2>
            <p className="text-sm text-ink-500">
              Caja física + cuentas bancarias + wallets. Los saldos se ajustan con cada movimiento.
            </p>
          </div>
          <Button onClick={() => setShowNuevaCuenta(true)}>+ Nueva cuenta</Button>
        </header>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
              <tr>
                <th className="text-left px-4 py-2">Cuenta</th>
                <th className="text-left px-4 py-2">Tipo</th>
                <th className="text-left px-4 py-2">CBU / Alias</th>
                <th className="text-left px-4 py-2">Sync</th>
                <th className="text-right px-4 py-2">Saldo</th>
                <th className="text-center px-4 py-2">Estado</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {cuentas.map((c) => (
                <tr key={c.id} className={cn(!c.activa && 'opacity-50')}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink-900">{c.nombre}</div>
                    {c.banco && <div className="text-2xs text-ink-500">{c.banco}</div>}
                  </td>
                  <td className="px-4 py-3 text-ink-700 text-xs">
                    {c.tipo === 'EFECTIVO' ? '💵' : c.tipo === 'BANCO' ? '🏦' : '📱'}{' '}
                    {c.tipo.toLowerCase()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-500">
                    {c.cbuCvu || c.alias || '—'}
                  </td>
                  <td className="px-4 py-3 text-2xs text-ink-500">
                    {c.metodoActualizacion === 'MANUAL'
                      ? 'manual'
                      : c.metodoActualizacion === 'API_MP'
                        ? 'API MP'
                        : c.metodoActualizacion === 'BELVO'
                          ? 'Belvo'
                          : 'extracto'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <MoneyAmount value={c.saldoActual} />
                  </td>
                  <td className="px-4 py-3 text-center text-2xs uppercase tracking-wider">
                    {c.activa ? (
                      <span className="text-basil-600">activa</span>
                    ) : (
                      <span className="text-ink-500">inactiva</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditingCuenta(c)}
                      className="text-teresita-700 hover:underline text-xs"
                    >
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* POSNETS */}
      <section>
        <header className="flex items-baseline justify-between mb-3">
          <div>
            <h2 className="font-display text-md text-ink-900">Posnets</h2>
            <p className="text-sm text-ink-500">
              Por cada posnet, vincular cuenta destino + cuentas a cobrar (débito y crédito).
            </p>
          </div>
          <Button onClick={() => setEditingPosnet('new')}>+ Nuevo posnet</Button>
        </header>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
              <tr>
                <th className="text-left px-4 py-2">Posnet</th>
                <th className="text-left px-4 py-2">Adquirente</th>
                <th className="text-left px-4 py-2">Ubicación</th>
                <th className="text-left px-4 py-2">Cuenta destino</th>
                <th className="text-center px-4 py-2">Integración</th>
                <th className="text-center px-4 py-2">Estado</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {posnetsData?.posnets.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-ink-500 py-8">
                    Sin posnets configurados todavía.
                  </td>
                </tr>
              )}
              {posnetsData?.posnets.map((p) => (
                <tr key={p.id} className={cn(!p.activo && 'opacity-50')}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink-900">{p.nombre}</div>
                    <div className="text-2xs text-ink-500">
                      {p.marca}
                      {p.modelo && ` · ${p.modelo}`}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink-700 text-xs">{p.adquirente ?? '—'}</td>
                  <td className="px-4 py-3 text-ink-500 text-xs">{p.ubicacion ?? '—'}</td>
                  <td className="px-4 py-3 text-ink-700 text-xs">
                    {p.cuentaDestino?.nombre ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-center text-2xs">
                    {p.soportaIntegracion ? (
                      <span className="text-basil-600">✓ integrado</span>
                    ) : (
                      <span className="text-ink-500">manual</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center text-2xs uppercase tracking-wider">
                    {p.activo ? (
                      <span className="text-basil-600">activo</span>
                    ) : (
                      <span className="text-ink-500">inactivo</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditingPosnet(p)}
                      className="text-teresita-700 hover:underline text-xs"
                    >
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showNuevaCuenta && (
        <ModalCuenta
          onClose={() => setShowNuevaCuenta(false)}
          onSaved={() => {
            setShowNuevaCuenta(false);
            void fetchData();
          }}
        />
      )}
      {editingCuenta && (
        <ModalCuenta
          cuenta={editingCuenta}
          onClose={() => setEditingCuenta(null)}
          onSaved={() => {
            setEditingCuenta(null);
            void fetchData();
          }}
        />
      )}
      {editingPosnet && posnetsData && (
        <ModalPosnet
          posnet={editingPosnet === 'new' ? null : editingPosnet}
          cuentas={posnetsData.cuentas}
          cuentasACobrar={posnetsData.cuentasACobrar}
          onClose={() => setEditingPosnet(null)}
          onSaved={() => {
            setEditingPosnet(null);
            void fetchData();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal Cuenta (crear / editar)
// ────────────────────────────────────────────────────────────────────────

function ModalCuenta({
  cuenta,
  onClose,
  onSaved,
}: {
  cuenta?: Cuenta;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!cuenta;
  const [nombre, setNombre] = useState(cuenta?.nombre ?? '');
  const [tipo, setTipo] = useState<Cuenta['tipo']>(cuenta?.tipo ?? 'BANCO');
  const [banco, setBanco] = useState(cuenta?.banco ?? '');
  const [cbuCvu, setCbuCvu] = useState(cuenta?.cbuCvu ?? '');
  const [alias, setAlias] = useState(cuenta?.alias ?? '');
  const [comisionMensual, setComisionMensual] = useState(cuenta?.comisionMensual ?? '');
  const [activa, setActiva] = useState(cuenta?.activa ?? true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!nombre.trim()) return setError('Falta el nombre');
    setGuardando(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/configuracion/cuentas/${cuenta!.id}`, {
          nombre,
          banco: banco || null,
          cbuCvu: cbuCvu || null,
          alias: alias || null,
          comisionMensual: comisionMensual || null,
          activa,
        });
      } else {
        await api.post('/admin/configuracion/cuentas', {
          nombre,
          tipo,
          banco: banco || undefined,
          cbuCvu: cbuCvu || undefined,
          alias: alias || undefined,
          comisionMensual: comisionMensual || undefined,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal">
        <h2 className="font-display text-lg text-teresita-700 mb-3">
          {isEdit ? 'Editar cuenta' : 'Nueva cuenta'}
        </h2>

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
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Tipo</label>
              <select
                value={tipo}
                onChange={(e) => setTipo(e.target.value as Cuenta['tipo'])}
                className="input"
              >
                <option value="EFECTIVO">Efectivo</option>
                <option value="BANCO">Bancaria</option>
                <option value="WALLET">Wallet (MP, Cuenta DNI)</option>
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Banco / Entidad</label>
            <input
              type="text"
              value={banco}
              onChange={(e) => setBanco(e.target.value)}
              className="input"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">CBU/CVU</label>
              <input
                type="text"
                value={cbuCvu}
                onChange={(e) => setCbuCvu(e.target.value)}
                className="input font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Alias</label>
              <input
                type="text"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                className="input font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Comisión mensual (opcional)
            </label>
            <input
              type="number"
              step="0.01"
              value={comisionMensual}
              onChange={(e) => setComisionMensual(e.target.value)}
              className="input font-mono"
              placeholder="0.00"
            />
          </div>
          {isEdit && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={activa}
                onChange={(e) => setActiva(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm text-ink-700">Cuenta activa</span>
            </label>
          )}
        </div>

        {error && (
          <div className="mt-3 bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        <footer className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={guardando}>
            {guardando ? 'Guardando...' : isEdit ? 'Guardar' : 'Crear cuenta'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal Posnet (crear / editar)
// ────────────────────────────────────────────────────────────────────────

function ModalPosnet({
  posnet,
  cuentas,
  cuentasACobrar,
  onClose,
  onSaved,
}: {
  posnet: Posnet | null;
  cuentas: Array<{ id: string; nombre: string; tipo: string }>;
  cuentasACobrar: CuentaACobrarRef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!posnet;
  const [nombre, setNombre] = useState(posnet?.nombre ?? '');
  const [marca, setMarca] = useState(posnet?.marca ?? '');
  const [modelo, setModelo] = useState(posnet?.modelo ?? '');
  const [adquirente, setAdquirente] = useState(posnet?.adquirente ?? '');
  const [ubicacion, setUbicacion] = useState(posnet?.ubicacion ?? '');
  const [cuentaDestinoId, setCuentaDestinoId] = useState(posnet?.cuentaDestino?.id ?? '');
  const [cuentaACobrarDebitoId, setCuentaACobrarDebitoId] = useState(
    posnet?.cuentaACobrarDebito?.id ?? '',
  );
  const [cuentaACobrarCreditoId, setCuentaACobrarCreditoId] = useState(
    posnet?.cuentaACobrarCredito?.id ?? '',
  );
  const [soportaIntegracion, setSoportaIntegracion] = useState(
    posnet?.soportaIntegracion ?? false,
  );
  const [activo, setActivo] = useState(posnet?.activo ?? true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!nombre.trim() || !marca.trim()) return setError('Falta nombre o marca');
    setGuardando(true);
    try {
      const data = {
        nombre,
        marca,
        modelo: modelo || undefined,
        adquirente: adquirente || undefined,
        ubicacion: ubicacion || undefined,
        cuentaDestinoId: cuentaDestinoId || undefined,
        cuentaACobrarDebitoId: cuentaACobrarDebitoId || undefined,
        cuentaACobrarCreditoId: cuentaACobrarCreditoId || undefined,
        soportaIntegracion,
        ...(isEdit && { activo }),
      };
      if (isEdit) {
        await api.patch(`/admin/configuracion/posnets/${posnet!.id}`, {
          ...data,
          cuentaDestinoId: cuentaDestinoId || null,
          cuentaACobrarDebitoId: cuentaACobrarDebitoId || null,
          cuentaACobrarCreditoId: cuentaACobrarCreditoId || null,
          modelo: modelo || null,
          adquirente: adquirente || null,
          ubicacion: ubicacion || null,
        });
      } else {
        await api.post('/admin/configuracion/posnets', data);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  }

  const cobrarDebito = cuentasACobrar.filter((c) => c.tipo === 'TARJETA_DEBITO');
  const cobrarCredito = cuentasACobrar.filter((c) =>
    ['TARJETA_CREDITO', 'TARJETA_CUOTAS'].includes(c.tipo),
  );

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-lg p-5 shadow-modal max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-lg text-teresita-700 mb-3">
          {isEdit ? 'Editar posnet' : 'Nuevo posnet'}
        </h2>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Nombre</label>
              <input
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="input"
                placeholder="ej. Posnet mostrador"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Marca</label>
              <input
                type="text"
                value={marca}
                onChange={(e) => setMarca(e.target.value)}
                className="input"
                placeholder="ej. Lapos, MP Point"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Modelo</label>
              <input
                type="text"
                value={modelo}
                onChange={(e) => setModelo(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Adquirente</label>
              <input
                type="text"
                value={adquirente}
                onChange={(e) => setAdquirente(e.target.value)}
                className="input"
                placeholder="Prisma, Fiserv, MP..."
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Ubicación</label>
            <input
              type="text"
              value={ubicacion}
              onChange={(e) => setUbicacion(e.target.value)}
              className="input"
              placeholder="mostrador / móvil / etc"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Cuenta destino (donde cae la liquidación)
            </label>
            <select
              value={cuentaDestinoId}
              onChange={(e) => setCuentaDestinoId(e.target.value)}
              className="input"
            >
              <option value="">— sin asignar —</option>
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
            <p className="text-2xs text-ink-500 mt-1">
              Banco / wallet donde el adquirente acredita la plata cuando termina el plazo de
              liquidación.
            </p>
          </div>

          <div className="bg-ocean-100 border border-ocean-600/20 rounded-md p-3 text-xs text-ocean-600">
            <strong className="text-sm">¿Qué son las cuentas a cobrar?</strong>
            <p className="mt-1 text-ink-700">
              Cuando alguien paga con tarjeta, la plata no entra al banco al instante: queda en
              "limbo" hasta que el adquirente la libere (débito ~2 días, crédito ~15 días). Esa
              plata pendiente se asigna a una <strong>cuenta a cobrar</strong> y aparece en el
              dashboard como "próximos depósitos". Cuando la liquidación llega al banco, se
              concilia automáticamente.
            </p>
            <p className="mt-1 text-ink-700">
              Si las dejás sin asignar, el posnet cobra igual pero perdés el seguimiento de
              cuándo cae cada plata.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">
                Cuenta a cobrar — débito
              </label>
              <select
                value={cuentaACobrarDebitoId}
                onChange={(e) => setCuentaACobrarDebitoId(e.target.value)}
                className="input"
              >
                <option value="">— sin asignar —</option>
                {cobrarDebito.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
              <p className="text-2xs text-ink-500 mt-1">
                Para cobros con tarjeta de débito. Acredita en ~2 días hábiles.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">
                Cuenta a cobrar — crédito
              </label>
              <select
                value={cuentaACobrarCreditoId}
                onChange={(e) => setCuentaACobrarCreditoId(e.target.value)}
                className="input"
              >
                <option value="">— sin asignar —</option>
                {cobrarCredito.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
              <p className="text-2xs text-ink-500 mt-1">
                Para cobros con tarjeta de crédito. Acredita en ~15-18 días hábiles.
              </p>
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={soportaIntegracion}
              onChange={(e) => setSoportaIntegracion(e.target.checked)}
              className="w-4 h-4"
            />
            <div>
              <span className="text-sm text-ink-700">Soporta integración</span>
              <p className="text-2xs text-ink-500">
                Posnets modernos (MP Point, Ualá, Modo). El sistema le manda el monto y se ahorra
                la doble carga.
              </p>
            </div>
          </label>
          {isEdit && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={activo}
                onChange={(e) => setActivo(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm text-ink-700">Posnet activo</span>
            </label>
          )}
        </div>

        {error && (
          <div className="mt-3 bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        <footer className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={guardando}>
            {guardando ? 'Guardando...' : isEdit ? 'Guardar' : 'Crear posnet'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
