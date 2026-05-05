'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface SesionCierre {
  id: string;
  fecha: string;
  turno: 'MANANA' | 'TARDE';
  estado: 'CERRADA' | 'APROBADA';
  horarioApertura: string;
  horarioCierre: string;
  existenciaInicial: string;
  existenciaFinal: string;
  recaudacionEsperada: string;
  diferencia: string;
  fechaAprobacion: string | null;
  usuarioApertura: { nombre: string };
  usuarioCierre: { nombre: string } | null;
  aprobadaAdmin: { nombre: string } | null;
  observaciones: string | null;
  emailEnviadoA: string | null;
  emailEnviadoAt: string | null;
}

export default function AdminCierresPage() {
  const [sesiones, setSesiones] = useState<SesionCierre[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [enviandoEmail, setEnviandoEmail] = useState<string | null>(null);
  const [sincronizandoExcel, setSincronizandoExcel] = useState<string | null>(null);
  const [resultadoEmail, setResultadoEmail] = useState<{
    sesionId: string;
    mensaje: string;
    previewUrl?: string | null;
    tone: 'success' | 'danger';
  } | null>(null);
  const [resultadoExcel, setResultadoExcel] = useState<{
    sesionId: string;
    mensaje: string;
    tone: 'success' | 'danger';
  } | null>(null);

  async function fetchData() {
    setLoading(true);
    try {
      const res = await api.get<{ sesiones: SesionCierre[] }>('/admin/caja/cierres');
      setSesiones(res.sesiones);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los cierres');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchData();
  }, []);

  async function aprobar(id: string) {
    try {
      await api.post(`/admin/caja/sesion/${id}/aprobar`, {});
      void fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al aprobar');
    }
  }

  async function enviarPorEmail(id: string) {
    const customTo = prompt(
      'Email destinatario (vacío = usa ADMIN_EMAIL_RECIPIENTS del .env):',
      '',
    );
    if (customTo === null) return; // canceló
    setEnviandoEmail(id);
    setResultadoEmail(null);
    try {
      const body: { to?: string[] } = customTo.trim()
        ? { to: customTo.split(',').map((s) => s.trim()).filter(Boolean) }
        : {};
      const res = await api.post<{
        ok: boolean;
        recipients: string[];
        previewUrl: string | null;
        isEthereal: boolean;
      }>(`/admin/caja/sesion/${id}/enviar-email`, body);
      setResultadoEmail({
        sesionId: id,
        mensaje: res.isEthereal
          ? `Email simulado (Ethereal) a ${res.recipients.join(', ')}. Mirá el preview ↗`
          : `Email enviado a ${res.recipients.join(', ')} ✓`,
        previewUrl: res.previewUrl,
        tone: 'success',
      });
      await fetchData();
    } catch (e) {
      setResultadoEmail({
        sesionId: id,
        mensaje: e instanceof Error ? e.message : 'Error al enviar el email',
        tone: 'danger',
      });
    } finally {
      setEnviandoEmail(null);
    }
  }

  async function sincronizarCashflow(id: string) {
    setSincronizandoExcel(id);
    setResultadoExcel(null);
    try {
      const res = await api.post<{
        ok: boolean;
        hoja: string;
        dia: string;
        celdasActualizadas: number;
        warnings: string[];
      }>(`/admin/caja/sesion/${id}/sincronizar-cashflow`, {});
      setResultadoExcel({
        sesionId: id,
        mensaje:
          `✓ CASHFLOW actualizado · hoja "${res.hoja}" · día ${res.dia} · ${res.celdasActualizadas} celdas` +
          (res.warnings.length > 0 ? ` · ${res.warnings.length} warnings` : ''),
        tone: 'success',
      });
    } catch (e) {
      setResultadoExcel({
        sesionId: id,
        mensaje: e instanceof Error ? e.message : 'Error sincronizando Excel',
        tone: 'danger',
      });
    } finally {
      setSincronizandoExcel(null);
    }
  }

  async function probarSmtp() {
    const to = prompt('Email destinatario para el test:', 'alejolafalce@gmail.com');
    if (!to) return;
    try {
      const res = await api.post<{
        ok: boolean;
        recipients: string[];
        previewUrl: string | null;
        isEthereal: boolean;
      }>('/admin/email/test', { to });
      alert(
        res.isEthereal
          ? `Test simulado (Ethereal). Preview: ${res.previewUrl}`
          : `✓ Email de prueba enviado a ${res.recipients.join(', ')}`,
      );
    } catch (e) {
      alert('Error: ' + (e instanceof Error ? e.message : 'desconocido'));
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-xl text-ink-900">Cierres de caja</h1>
          <p className="text-sm text-ink-500">{sesiones.length} sesiones cerradas</p>
        </div>
        <Button variant="ghost" size="sm" onClick={probarSmtp}>
          ✉️ Probar SMTP
        </Button>
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {loading && <div className="text-ink-500">Cargando...</div>}
      {!loading && sesiones.length === 0 && (
        <div className="card p-8 text-center text-ink-500">
          No hay sesiones cerradas todavía.
        </div>
      )}

      <div className="space-y-3">
        {sesiones.map((s) => {
          const dif = Number(s.diferencia);
          const necesitaAprobacion = s.estado === 'CERRADA';
          return (
            <div
              key={s.id}
              className={cn(
                'card p-4',
                necesitaAprobacion && 'border-l-4 border-saffron-600',
              )}
            >
              <div className="flex items-baseline justify-between mb-3">
                <div>
                  <span className="font-display text-md text-ink-900">
                    {new Date(s.fecha).toLocaleDateString('es-AR', {
                      weekday: 'short',
                      day: '2-digit',
                      month: 'short',
                    })}{' '}
                    · {s.turno === 'MANANA' ? 'Mañana' : 'Tarde'}
                  </span>
                  <div className="text-xs text-ink-500">
                    {new Date(s.horarioApertura).toLocaleTimeString('es-AR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    →{' '}
                    {new Date(s.horarioCierre).toLocaleTimeString('es-AR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' · cerró '}
                    {s.usuarioCierre?.nombre ?? '—'}
                  </div>
                </div>
                <span
                  className={cn(
                    'text-2xs font-medium px-2 py-0.5 rounded uppercase tracking-wider',
                    s.estado === 'APROBADA' ? 'bg-basil-100 text-basil-600' : 'bg-saffron-100 text-saffron-600',
                  )}
                >
                  {s.estado.toLowerCase()}
                </span>
              </div>

              <div className="grid grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-2xs text-ink-500 uppercase">Inicial</div>
                  <MoneyAmount value={s.existenciaInicial} />
                </div>
                <div>
                  <div className="text-2xs text-ink-500 uppercase">Esperado</div>
                  <MoneyAmount value={s.recaudacionEsperada} />
                </div>
                <div>
                  <div className="text-2xs text-ink-500 uppercase">Contado</div>
                  <MoneyAmount value={s.existenciaFinal} className="text-teresita-700" />
                </div>
                <div>
                  <div className="text-2xs text-ink-500 uppercase">Diferencia</div>
                  <MoneyAmount
                    value={s.diferencia}
                    className={cn(
                      Math.abs(dif) < 0.01 && 'text-basil-600',
                      dif < 0 && 'text-pomodoro-600 font-semibold',
                      dif > 0 && 'text-saffron-600',
                    )}
                  />
                </div>
              </div>

              {s.observaciones && (
                <p className="text-xs text-ink-700 italic mt-3 border-t border-cream-200 pt-2">
                  {s.observaciones}
                </p>
              )}

              {s.estado === 'APROBADA' && s.aprobadaAdmin && (
                <div className="text-2xs text-ink-500 mt-2">
                  ✓ Aprobada por {s.aprobadaAdmin.nombre}
                  {s.fechaAprobacion &&
                    ` el ${new Date(s.fechaAprobacion).toLocaleDateString('es-AR')}`}
                </div>
              )}

              {s.emailEnviadoAt && (
                <div className="text-2xs text-basil-600 mt-1">
                  ✉ Enviado a {s.emailEnviadoA} ·{' '}
                  {new Date(s.emailEnviadoAt).toLocaleString('es-AR')}
                </div>
              )}

              {resultadoEmail?.sesionId === s.id && (
                <div
                  className={cn(
                    'mt-2 px-3 py-2 rounded text-xs',
                    resultadoEmail.tone === 'success' && 'bg-basil-100 text-basil-600',
                    resultadoEmail.tone === 'danger' && 'bg-pomodoro-100 text-pomodoro-600',
                  )}
                >
                  {resultadoEmail.mensaje}
                  {resultadoEmail.previewUrl && (
                    <>
                      {' '}
                      <a
                        href={resultadoEmail.previewUrl}
                        target="_blank"
                        rel="noopener"
                        className="underline font-medium"
                      >
                        ver preview
                      </a>
                    </>
                  )}
                </div>
              )}

              {resultadoExcel?.sesionId === s.id && (
                <div
                  className={cn(
                    'mt-2 px-3 py-2 rounded text-xs',
                    resultadoExcel.tone === 'success' && 'bg-basil-100 text-basil-600',
                    resultadoExcel.tone === 'danger' && 'bg-pomodoro-100 text-pomodoro-600',
                  )}
                >
                  {resultadoExcel.mensaje}
                </div>
              )}

              <div className="mt-3 flex justify-end gap-2 flex-wrap">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => sincronizarCashflow(s.id)}
                  disabled={sincronizandoExcel === s.id}
                  title="Actualiza CASHFLOW 2026.xlsx con los datos del día"
                >
                  {sincronizandoExcel === s.id ? 'Sincronizando...' : '📊 Sincronizar CASHFLOW'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => enviarPorEmail(s.id)}
                  disabled={enviandoEmail === s.id}
                >
                  {enviandoEmail === s.id ? 'Enviando...' : '📧 Enviar por email'}
                </Button>
                {necesitaAprobacion && (
                  <Button size="sm" onClick={() => aprobar(s.id)}>
                    ✓ Aprobar cierre
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
