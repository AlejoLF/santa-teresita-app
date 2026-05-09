'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Card "Acerca de" para la pantalla de Configuración del admin.
 * Muestra:
 *   - Versión del .exe instalado (vía /version del API local).
 *   - Versión del web deployado (commit SHA + branch + mensaje + fecha de
 *     build, inyectado por Vercel en build time vía next.config.mjs).
 *
 * Útil para diagnóstico: si la encargada reporta un bug, podemos
 * preguntarle "qué versión te dice 'Acerca de'?" y saber exactamente qué
 * código está corriendo.
 */
export function AcercaDe() {
  const [apiVersion, setApiVersion] = useState<string>('cargando…');
  const [apiTime, setApiTime] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ version: string; time: string }>('/version')
      .then((r) => {
        if (cancelled) return;
        setApiVersion(r.version || 'sin versión');
        setApiTime(r.time);
      })
      .catch(() => {
        if (!cancelled) setApiVersion('error consultando API local');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sha = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7);
  const branch = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF ?? '';
  const message = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE ?? '';
  const deployTime = process.env.NEXT_PUBLIC_VERCEL_DEPLOY_TIME ?? '';

  return (
    <div className="card p-5 border-l-4 border-ink-500">
      <div className="flex items-start gap-3 mb-3">
        <span className="text-2xl">ℹ️</span>
        <div>
          <h3 className="font-display text-md text-ink-900">Acerca de Santa Teresita</h3>
          <p className="text-xs text-ink-500">
            Información de versión instalada — útil para reportar bugs
          </p>
        </div>
      </div>

      <dl className="text-sm space-y-1 ml-9">
        <div className="grid grid-cols-[140px_1fr] gap-2">
          <dt className="text-ink-500 text-xs uppercase tracking-wider">App (.exe)</dt>
          <dd className="font-mono text-ink-900">{apiVersion}</dd>
        </div>
        {apiTime && (
          <div className="grid grid-cols-[140px_1fr] gap-2">
            <dt className="text-ink-500 text-xs uppercase tracking-wider">API arranque</dt>
            <dd className="font-mono text-ink-700 text-2xs">
              {new Date(apiTime).toLocaleString('es-AR', {
                timeZone: 'America/Argentina/Buenos_Aires',
              })}
            </dd>
          </div>
        )}
        {sha && (
          <div className="grid grid-cols-[140px_1fr] gap-2">
            <dt className="text-ink-500 text-xs uppercase tracking-wider">UI commit</dt>
            <dd className="font-mono text-ink-900">
              <a
                href={`https://github.com/AlejoLF/santa-teresita-app/commit/${process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teresita-700 hover:underline"
              >
                {sha}
              </a>
              {branch && <span className="text-ink-500"> · {branch}</span>}
            </dd>
          </div>
        )}
        {message && (
          <div className="grid grid-cols-[140px_1fr] gap-2">
            <dt className="text-ink-500 text-xs uppercase tracking-wider">UI mensaje</dt>
            <dd className="text-ink-700 text-2xs italic">{message}</dd>
          </div>
        )}
        {deployTime && (
          <div className="grid grid-cols-[140px_1fr] gap-2">
            <dt className="text-ink-500 text-xs uppercase tracking-wider">UI deploy</dt>
            <dd className="font-mono text-ink-700 text-2xs">
              {new Date(deployTime).toLocaleString('es-AR', {
                timeZone: 'America/Argentina/Buenos_Aires',
              })}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
