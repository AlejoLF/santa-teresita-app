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
        api.getCached<Me>('/auth/me', 5 * 60_000),
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

      <SmtpSection />
      <CierreEmailsSection />

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
//   Email destinatarios de cierres de caja
//   Vive en /admin/configuracion/usuarios porque conceptualmente es
//   "permisos / acceso" del admin a la información del local.
// ────────────────────────────────────────────────────────────────────────

function CierreEmailsSection() {
  const [emails, setEmails] = useState<string[]>([]);
  const [nuevo, setNuevo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    api
      .get<{ emails: string[] }>('/admin/configuracion/cierre-emails')
      .then((r) => setEmails(r.emails))
      .catch(() => setError('No se pudieron cargar los emails'))
      .finally(() => setLoading(false));
  }, []);

  async function guardar(lista: string[]) {
    setError(null);
    try {
      await api.put('/admin/configuracion/cierre-emails', { emails: lista });
      setEmails(lista);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    }
  }

  function agregar() {
    const e = nuevo.trim().toLowerCase();
    if (!e) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      setError('Email inválido');
      return;
    }
    if (emails.includes(e)) {
      setError('Ya está en la lista');
      return;
    }
    if (emails.length >= 10) {
      setError('Máximo 10 emails');
      return;
    }
    setNuevo('');
    void guardar([...emails, e]);
  }

  function quitar(e: string) {
    void guardar(emails.filter((x) => x !== e));
  }

  return (
    <section className="card p-4">
      <header className="mb-3">
        <h2 className="font-display text-md text-ink-900">
          📧 Emails para cierres de caja
        </h2>
        <p className="text-sm text-ink-500">
          Estos emails reciben automáticamente el resumen del cierre cuando la
          encargada lo envía. Podés agregar hasta 10 destinatarios.
        </p>
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm mb-2">
          {error}
        </div>
      )}
      {savedFlash && (
        <div className="bg-basil-100 text-basil-600 px-3 py-2 rounded text-sm mb-2">
          ✓ Guardado
        </div>
      )}

      {loading ? (
        <p className="text-ink-500 text-sm">Cargando...</p>
      ) : (
        <>
          <ul className="space-y-1 mb-3">
            {emails.length === 0 && (
              <li className="text-ink-500 text-sm italic">
                Sin emails configurados — los cierres no se envían a nadie hasta
                que agregues al menos uno.
              </li>
            )}
            {emails.map((e) => (
              <li
                key={e}
                className="flex items-center justify-between px-3 py-1.5 bg-surface-sunken rounded text-sm"
              >
                <span className="font-mono text-ink-900">{e}</span>
                <button
                  onClick={() => quitar(e)}
                  className="text-pomodoro-600 hover:text-pomodoro-700 text-2xs"
                  title="Quitar"
                >
                  ✕ quitar
                </button>
              </li>
            ))}
          </ul>

          <div className="flex gap-2">
            <input
              type="email"
              value={nuevo}
              onChange={(e) => setNuevo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && agregar()}
              placeholder="ej. dueño@ejemplo.com"
              className="input text-sm flex-1"
              maxLength={120}
            />
            <Button onClick={agregar} size="sm">
              + Agregar
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   SMTP — config del servidor de email
//   Antes vivía sólo en .env (no llegaba al .exe del local). Ahora la
//   encargada lo configura desde acá.
// ────────────────────────────────────────────────────────────────────────

interface SmtpConfig {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  passConfigurado: boolean;
  from: string;
  autoEnvioCierre: boolean;
  status: {
    modo: 'smtp' | 'ethereal';
    host: string | null;
    user: string | null;
    destinatarios: string[];
    passConfigurado: boolean;
  };
}

function SmtpSection() {
  const [cfg, setCfg] = useState<SmtpConfig | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [from, setFrom] = useState('');
  const [autoEnvio, setAutoEnvio] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  async function reload() {
    try {
      const r = await api.get<SmtpConfig>('/admin/configuracion/smtp');
      setCfg(r);
      setHost(r.host);
      setPort(r.port);
      setSecure(r.secure);
      setUser(r.user);
      setFrom(r.from);
      setAutoEnvio(r.autoEnvioCierre);
    } catch {
      setError('No se pudo cargar la config SMTP');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function guardar() {
    setSaving(true);
    setError(null);
    setSavedFlash(null);
    try {
      const body: Record<string, unknown> = {
        host,
        port: Number(port) || 587,
        secure,
        user,
        from,
        autoEnvioCierre: autoEnvio,
      };
      // Sólo enviamos pass si la encargada escribió uno nuevo. Vacío =
      // mantener el actual. '__CLEAR__' = borrar el guardado.
      if (pass.trim()) body.pass = pass.trim();
      await api.put('/admin/configuracion/smtp', body);
      setPass('');
      setSavedFlash('✓ Guardado');
      setTimeout(() => setSavedFlash(null), 3000);
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function probar() {
    const to = prompt('Email destinatario para el test:', cfg?.status.destinatarios[0] ?? '');
    if (!to) return;
    try {
      const r = await api.post<{
        isEthereal: boolean;
        previewUrl: string | null;
        recipients: string[];
      }>('/admin/email/test', { to });
      if (r.isEthereal) {
        alert(
          `⚠ SMTP no configurado (modo Ethereal). El email NO llegó a Gmail.\n\nPreview: ${r.previewUrl}\n\nGuardá la config SMTP arriba antes de probar de nuevo.`,
        );
      } else {
        alert(
          `✓ Email de prueba enviado a ${r.recipients.join(', ')}\n\n` +
            `Si no llega en ~1 minuto, chequear el spam del destinatario.\n` +
            `Si tampoco está en spam, abrir el panel "Diagnóstico" abajo.`,
        );
      }
    } catch (e) {
      // El backend ahora devuelve detalles de error de nodemailer (code,
      // command, response, responseCode) para que el admin sepa qué arreglar.
      const errAny = e as { body?: Record<string, unknown>; message?: string };
      const body = errAny?.body ?? {};
      const partes: string[] = [];
      partes.push('✗ ' + (errAny?.message ?? 'Error desconocido'));
      if (body.code) partes.push(`Código: ${body.code}`);
      if (body.command) partes.push(`Comando: ${body.command}`);
      if (body.responseCode) partes.push(`Response: ${body.responseCode}`);
      if (body.response) partes.push(`Server: ${body.response}`);
      partes.push('');
      partes.push('Pistas comunes:');
      partes.push('• EAUTH = pass mal (regenerá el App Password de Gmail)');
      partes.push('• ECONNECTION / ETIMEDOUT = no llega al servidor SMTP (firewall/red)');
      partes.push('• 535 5.7.8 = usuario/pass inválido');
      partes.push('• 550 = destinatario rechazado o bloqueado por Gmail');
      alert(partes.join('\n'));
    }
  }

  if (loading) return <p className="card p-4 text-ink-500 text-sm">Cargando SMTP…</p>;

  const enEthereal = cfg?.status.modo === 'ethereal';

  return (
    <section className="card p-4">
      <header className="mb-3">
        <h2 className="font-display text-md text-ink-900">
          ⚙️ Servidor SMTP (envío de email)
        </h2>
        <p className="text-sm text-ink-500">
          Configura el servidor que envía los cierres por email. Sin SMTP cargado, el
          sistema usa <strong>Ethereal</strong> (modo preview que NO llega a Gmail real).
        </p>
      </header>

      <div
        className={cn(
          'px-3 py-2 rounded text-xs mb-3',
          enEthereal
            ? 'bg-pomodoro-100 text-pomodoro-700'
            : 'bg-basil-100 text-basil-700',
        )}
      >
        {enEthereal ? (
          <>
            ⚠ <strong>Modo Ethereal</strong> — los emails NO se están enviando a Gmail.
            Cargá host/usuario/password abajo y guardá.
          </>
        ) : (
          <>
            ✓ <strong>SMTP activo</strong>: {cfg?.status.host} via{' '}
            {cfg?.status.user ?? '(sin auth)'} ·{' '}
            {cfg?.status.passConfigurado ? 'password configurado' : 'sin password'}
          </>
        )}
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm mb-2">
          {error}
        </div>
      )}
      {savedFlash && (
        <div className="bg-basil-100 text-basil-600 px-3 py-2 rounded text-sm mb-2">
          {savedFlash}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="space-y-1">
          <div className="text-2xs uppercase text-ink-500">Host</div>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.gmail.com"
            className="input w-full"
          />
        </label>
        <label className="space-y-1">
          <div className="text-2xs uppercase text-ink-500">Puerto</div>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="587"
            className="input w-full"
          />
        </label>
        <label className="space-y-1">
          <div className="text-2xs uppercase text-ink-500">Usuario (email completo)</div>
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="local@gmail.com"
            className="input w-full"
          />
        </label>
        <label className="space-y-1">
          <div className="text-2xs uppercase text-ink-500">
            Password{' '}
            {cfg?.passConfigurado && (
              <span className="text-basil-600 normal-case">(ya configurado — dejá vacío para conservar)</span>
            )}
          </div>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder={cfg?.passConfigurado ? '••••••••' : 'App Password de 16 chars'}
            className="input w-full"
          />
        </label>
        <label className="space-y-1 col-span-2">
          <div className="text-2xs uppercase text-ink-500">
            Remitente (cómo aparece en el email)
          </div>
          <input
            type="text"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder='Santa Teresita Pastas <local@gmail.com>'
            className="input w-full"
          />
          <p className="text-2xs text-ink-500">
            Si dejás <code>&lt;&gt;</code> vacío, se usa el usuario. Ej: <code>"Santa Teresita Pastas &lt;&gt;"</code>.
          </p>
        </label>
        <p className="col-span-2 text-2xs text-ink-500 bg-cream-100 rounded p-2">
          🔒 El tipo de cifrado se detecta solo según el puerto:{' '}
          <strong>587</strong> usa STARTTLS y <strong>465</strong> TLS directo. No tenés
          que configurar nada — para Gmail dejá el puerto en 587.
        </p>
        <label className="col-span-2 flex items-center gap-2 text-sm p-2 rounded bg-cream-100">
          <input
            type="checkbox"
            checked={autoEnvio}
            onChange={(e) => setAutoEnvio(e.target.checked)}
          />
          <span>
            <strong>Enviar email automáticamente al cerrar caja</strong> —
            sin esto, hay que clickear el botón "Enviar por email" en cada cierre.
          </span>
        </label>
      </div>

      <div className="mt-3 flex gap-2">
        <Button onClick={guardar} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar config'}
        </Button>
        <Button variant="secondary" onClick={probar}>
          ✉️ Probar (enviar email de test)
        </Button>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-2xs text-ink-500">
          ¿Cómo obtengo un App Password de Gmail?
        </summary>
        <ol className="text-2xs text-ink-700 mt-2 ml-4 list-decimal space-y-1">
          <li>
            Entrar a{' '}
            <a
              href="https://myaccount.google.com/security"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teresita-700 underline"
            >
              myaccount.google.com/security
            </a>{' '}
            y activar verificación en 2 pasos.
          </li>
          <li>
            Ir a{' '}
            <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teresita-700 underline"
            >
              myaccount.google.com/apppasswords
            </a>
            .
          </li>
          <li>
            Crear app password con nombre "Santa Teresita". Google devuelve 16 letras
            (ej. <code>abcd efgh ijkl mnop</code>).
          </li>
          <li>Copiar y pegar acá arriba (con o sin espacios, los limpiamos).</li>
        </ol>
      </details>
    </section>
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
