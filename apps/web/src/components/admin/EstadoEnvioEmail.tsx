'use client';

import { cn } from '@/lib/cn';

/**
 * Estado del email del cierre de caja. Desde el 23/11 el envío va EN COLA y lo
 * manda el servidor del local (S1), con reintentos: no se pierde si cierran el
 * programa y funciona desde el celular. Ver apps/api/src/services/cola-email-cierre.ts.
 */
export interface EnvioEmail {
  id: string;
  estado: 'PENDIENTE' | 'ENVIADO' | 'ERROR' | string;
  intentos: number;
  ultimoError: string | null;
  proximoIntentoAt: string;
  creadoAt: string;
  enviadoAt: string | null;
  enviadoA: string | null;
}

const hora = (iso: string) =>
  new Date(iso).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Lo que se le dice a la encargada después de tocar "Enviar por email". */
export function mensajeTrasPedir(envio: EnvioEmail): { mensaje: string; tone: 'success' | 'danger' | 'info' } {
  if (envio.estado === 'ENVIADO') {
    return { mensaje: `✓ Email enviado a ${envio.enviadoA ?? 'los destinatarios'}`, tone: 'success' };
  }
  if (envio.estado === 'ERROR') {
    return { mensaje: `✗ No se pudo enviar: ${envio.ultimoError ?? 'error desconocido'}`, tone: 'danger' };
  }
  if (envio.intentos > 0 && envio.ultimoError) {
    return {
      mensaje: `Quedó en cola: el primer intento falló (${envio.ultimoError}). Se reintenta solo.`,
      tone: 'info',
    };
  }
  return {
    mensaje:
      'Quedó en cola: lo manda el servidor del local en menos de un minuto, aunque cierres el programa.',
    tone: 'info',
  };
}

/** Renglón de estado bajo cada cierre (en cola / con error). El "enviado" lo muestra la pantalla. */
export function EstadoEnvioEmail({ envio, className }: { envio: EnvioEmail | null | undefined; className?: string }) {
  if (!envio || envio.estado === 'ENVIADO') return null;
  const error = envio.estado === 'ERROR';
  return (
    <div
      className={cn(
        'text-2xs rounded px-2 py-1',
        error ? 'bg-pomodoro-100 text-pomodoro-600' : 'bg-saffron-100 text-saffron-600',
        className,
      )}
    >
      {error ? (
        <>✗ El email no salió después de {envio.intentos} intentos: {envio.ultimoError ?? 'error desconocido'}</>
      ) : (
        <>
          ⏳ Email en cola desde {hora(envio.creadoAt)}
          {envio.intentos > 0 && envio.ultimoError
            ? ` · ${envio.intentos} intento${envio.intentos === 1 ? '' : 's'} fallido${envio.intentos === 1 ? '' : 's'} (${envio.ultimoError}) · próximo ${hora(envio.proximoIntentoAt)}`
            : ' · lo manda el servidor del local'}
        </>
      )}
    </div>
  );
}
