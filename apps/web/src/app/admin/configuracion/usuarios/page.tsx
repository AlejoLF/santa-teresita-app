'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { PinInput } from '@/components/ui/PinInput';
import { Numpad } from '@/components/ui/Numpad';
import { cn } from '@/lib/cn';

interface Usuario {
  id: string;
  nombre: string;
  rol: 'VENDEDOR' | 'ADMIN';
  activo: boolean;
  pinUltimoCambioAt: string;
  intentosFallidos: number;
  bloqueadoHasta: string | null;
}

interface Me {
  usuario: { id: string; nombre: string; rol: string };
}

export default function ConfigUsuariosPage() {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCambiarPin, setShowCambiarPin] = useState(false);
  const [resetearPara, setResetearPara] = useState<Usuario | null>(null);
  const [showCrear, setShowCrear] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [me, list] = await Promise.all([
        api.get<Me>('/auth/me'),
        api.get<{ usuarios: Usuario[] }>('/admin/usuarios'),
      ]);
      setMeId(me.usuario.id);
      setUsuarios(list.usuarios);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los usuarios');
      }
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  async function toggleActivo(u: Usuario) {
    if (u.id === meId) {
      alert('No podés desactivarte a vos mismo.');
      return;
    }
    if (!confirm(`¿${u.activo ? 'Desactivar' : 'Activar'} el usuario "${u.nombre}"?`)) return;
    try {
      await api.patch(`/admin/usuarios/${u.id}`, { activo: !u.activo });
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al actualizar');
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="font-display text-md text-ink-900">Usuarios del sistema</h2>
          <p className="text-sm text-ink-500">
            Vendedor (PIN compartido) + admins (PIN personal). El audit log registra cada cambio.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowCambiarPin(true)}>
            Cambiar mi PIN
          </Button>
          <Button onClick={() => setShowCrear(true)}>+ Nuevo usuario</Button>
        </div>
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Usuario</th>
              <th className="text-left px-4 py-2">Rol</th>
              <th className="text-left px-4 py-2">PIN cambiado</th>
              <th className="text-center px-4 py-2">Intentos fallidos</th>
              <th className="text-center px-4 py-2">Estado</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {usuarios.map((u) => {
              const esYo = u.id === meId;
              const bloqueado =
                u.bloqueadoHasta && new Date(u.bloqueadoHasta) > new Date();
              return (
                <tr
                  key={u.id}
                  className={cn(!u.activo && 'opacity-50', esYo && 'bg-teresita-50')}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink-900">
                      {u.nombre}
                      {esYo && (
                        <span className="ml-2 text-2xs text-teresita-700 font-mono">(vos)</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'text-2xs font-medium px-2 py-0.5 rounded uppercase',
                        u.rol === 'ADMIN'
                          ? 'bg-teresita-50 text-teresita-700'
                          : 'bg-cream-200 text-ink-700',
                      )}
                    >
                      {u.rol.toLowerCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink-500 text-xs">
                    {new Date(u.pinUltimoCambioAt).toLocaleDateString('es-AR')}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {u.intentosFallidos > 0 ? (
                      <span className="text-saffron-600 font-mono">{u.intentosFallidos}</span>
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center text-2xs uppercase">
                    {bloqueado ? (
                      <span className="text-pomodoro-600">bloqueado</span>
                    ) : u.activo ? (
                      <span className="text-basil-600">activo</span>
                    ) : (
                      <span className="text-ink-500">inactivo</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => setResetearPara(u)}
                        className="text-teresita-700 hover:underline text-xs"
                      >
                        Resetear PIN
                      </button>
                      {!esYo && (
                        <button
                          onClick={() => toggleActivo(u)}
                          className="text-pomodoro-600 hover:underline text-xs ml-2"
                        >
                          {u.activo ? 'Desactivar' : 'Activar'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {showCambiarPin && (
        <ModalCambiarMiPin
          onClose={() => setShowCambiarPin(false)}
          onChanged={() => {
            setShowCambiarPin(false);
            void fetchData();
          }}
        />
      )}
      {resetearPara && (
        <ModalResetearPin
          usuario={resetearPara}
          onClose={() => setResetearPara(null)}
          onChanged={() => {
            setResetearPara(null);
            void fetchData();
          }}
        />
      )}
      {showCrear && (
        <ModalCrearUsuario
          onClose={() => setShowCrear(false)}
          onCreated={() => {
            setShowCrear(false);
            void fetchData();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal: cambiar mi propio PIN (3 inputs PIN — actual + nuevo + confirma)
// ────────────────────────────────────────────────────────────────────────

function ModalCambiarMiPin({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<'actual' | 'nuevo' | 'confirma'>('actual');
  const [pinActual, setPinActual] = useState('');
  const [pinNuevo, setPinNuevo] = useState('');
  const [pinConfirma, setPinConfirma] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const current = step === 'actual' ? pinActual : step === 'nuevo' ? pinNuevo : pinConfirma;
  const setCurrent = (v: string) => {
    if (step === 'actual') setPinActual(v);
    else if (step === 'nuevo') setPinNuevo(v);
    else setPinConfirma(v);
  };

  function appendDigit(d: string) {
    if (current.length >= 4) return;
    setCurrent(current + d);
  }
  function backspace() {
    setCurrent(current.slice(0, -1));
  }
  function clearAll() {
    setCurrent('');
    setError(null);
  }

  useEffect(() => {
    if (step === 'actual' && pinActual.length === 4) {
      setStep('nuevo');
    } else if (step === 'nuevo' && pinNuevo.length === 4) {
      if (pinNuevo === pinActual) {
        setError('El PIN nuevo debe ser distinto al actual');
        setPinNuevo('');
        return;
      }
      setStep('confirma');
    } else if (step === 'confirma' && pinConfirma.length === 4) {
      if (pinConfirma !== pinNuevo) {
        setError('Los PINs no coinciden. Volvé a confirmar.');
        setPinConfirma('');
        return;
      }
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinActual, pinNuevo, pinConfirma, step]);

  async function submit() {
    setGuardando(true);
    try {
      await api.post('/auth/cambiar-pin', { pinActual, pinNuevo });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cambiar PIN');
      setStep('actual');
      setPinActual('');
      setPinNuevo('');
      setPinConfirma('');
    } finally {
      setGuardando(false);
    }
  }

  const titulos = {
    actual: 'Ingresá tu PIN actual',
    nuevo: 'Elegí un PIN nuevo',
    confirma: 'Repetí el PIN nuevo',
  };

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-sm p-5 shadow-modal">
        <h2 className="font-display text-lg text-teresita-700 mb-1">Cambiar PIN</h2>
        <p className="text-sm text-ink-500 mb-5">{titulos[step]}</p>

        <div className="flex justify-center mb-4">
          <PinInput value={current} hasError={!!error} />
        </div>

        {error && (
          <div className="text-pomodoro-600 text-sm text-center mb-3">{error}</div>
        )}

        <Numpad
          onDigit={appendDigit}
          onBackspace={backspace}
          onClear={clearAll}
          disabled={guardando}
        />

        <div className="text-center mt-4 text-xs text-ink-500">
          Paso {step === 'actual' ? 1 : step === 'nuevo' ? 2 : 3} de 3
        </div>

        <footer className="flex justify-end mt-3">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal: resetear PIN de otro usuario
// ────────────────────────────────────────────────────────────────────────

function ModalResetearPin({
  usuario,
  onClose,
  onChanged,
}: {
  usuario: Usuario;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [pin, setPin] = useState('');
  const [confirma, setConfirma] = useState('');
  const [step, setStep] = useState<'nuevo' | 'confirma'>('nuevo');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const current = step === 'nuevo' ? pin : confirma;
  const setCurrent = (v: string) => {
    if (step === 'nuevo') setPin(v);
    else setConfirma(v);
  };

  function appendDigit(d: string) {
    if (current.length >= 4) return;
    setCurrent(current + d);
  }
  function backspace() {
    setCurrent(current.slice(0, -1));
  }
  function clearAll() {
    setCurrent('');
    setError(null);
  }

  useEffect(() => {
    if (step === 'nuevo' && pin.length === 4) {
      setStep('confirma');
    } else if (step === 'confirma' && confirma.length === 4) {
      if (confirma !== pin) {
        setError('Los PINs no coinciden');
        setConfirma('');
        return;
      }
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, confirma, step]);

  async function submit() {
    setGuardando(true);
    try {
      await api.post(`/admin/usuarios/${usuario.id}/reset-pin`, { pinNuevo: pin });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al resetear PIN');
      setStep('nuevo');
      setPin('');
      setConfirma('');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-sm p-5 shadow-modal">
        <h2 className="font-display text-lg text-teresita-700 mb-1">
          Resetear PIN — {usuario.nombre}
        </h2>
        <p className="text-sm text-ink-500 mb-5">
          {step === 'nuevo' ? 'Elegí un PIN nuevo' : 'Confirmá el PIN'}
        </p>
        <div className="flex justify-center mb-4">
          <PinInput value={current} hasError={!!error} />
        </div>
        {error && <div className="text-pomodoro-600 text-sm text-center mb-3">{error}</div>}
        <Numpad onDigit={appendDigit} onBackspace={backspace} onClear={clearAll} disabled={guardando} />
        <footer className="flex justify-end mt-3">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal: crear usuario nuevo
// ────────────────────────────────────────────────────────────────────────

function ModalCrearUsuario({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [nombre, setNombre] = useState('');
  const [rol, setRol] = useState<'VENDEDOR' | 'ADMIN'>('VENDEDOR');
  const [pin, setPin] = useState('');
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function appendDigit(d: string) {
    if (pin.length >= 4) return;
    setPin(pin + d);
  }
  function backspace() {
    setPin(pin.slice(0, -1));
  }

  async function submit() {
    setError(null);
    if (!nombre.trim()) return setError('Falta el nombre');
    if (pin.length !== 4) return setError('El PIN debe tener 4 dígitos');
    setCreando(true);
    try {
      await api.post('/admin/usuarios', { nombre: nombre.trim(), rol, pin });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear usuario');
    } finally {
      setCreando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Nuevo usuario</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Nombre</label>
            <input
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              className="input"
              placeholder="ej. Cajero PC3, María"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Rol</label>
            <div className="grid grid-cols-2 gap-2">
              {(['VENDEDOR', 'ADMIN'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRol(r)}
                  className={cn(
                    'py-2 px-3 rounded-md text-sm font-medium border transition-colors',
                    rol === r
                      ? 'bg-teresita-700 text-cream-50 border-teresita-700'
                      : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
                  )}
                >
                  {r === 'VENDEDOR' ? 'Vendedor' : 'Admin'}
                </button>
              ))}
            </div>
            <p className="text-2xs text-ink-500 mt-1">
              {rol === 'VENDEDOR'
                ? 'Solo accede a la pantalla de carga de pedidos.'
                : 'Acceso total al sistema.'}
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">PIN inicial</label>
            <div className="flex justify-center mb-3">
              <PinInput value={pin} />
            </div>
            <Numpad onDigit={appendDigit} onBackspace={backspace} onClear={() => setPin('')} />
          </div>
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
          <Button onClick={() => void submit()} disabled={creando}>
            {creando ? 'Creando...' : 'Crear usuario'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
