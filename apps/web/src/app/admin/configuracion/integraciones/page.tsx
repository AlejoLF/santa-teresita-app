'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Configuración → Integraciones.
 *
 * La pantalla que faltaba cuando un pedido de plataforma "no aparece". Antes,
 * esa frase podía significar cinco cosas distintas —el token no está puesto, la
 * plataforma manda otro, el formato no es el nuestro, hay un SKU sin mapear, o
 * llegó fuera de horario— y ninguna dejaba rastro del lado del local.
 *
 * Arriba, si estamos listos para recibir y con qué URL. Abajo, todo lo que
 * golpeó la puerta y qué pasó con cada cosa.
 */

interface Estado {
  tokenConfigurado: boolean;
  tokenLargo: number;
  urls: { conHeader: string; webhookRappi: string | null; webhookPedidosYa: string | null };
  urlEsLocal: boolean;
  catalogo: { publicables: number; sinCodigo: number; advertencia: string | null };
  horario: { hayTurnoAbierto: boolean; advertencia: string | null };
  ultimaRecepcion: { recibidoAt: string; resultado: string; detalle: string | null } | null;
}

interface Recepcion {
  id: string;
  recibidoAt: string;
  ruta: string;
  metodo: string;
  ip: string | null;
  headers: Record<string, string>;
  body: unknown;
  bodyTexto: string | null;
  bytes: number;
  status: number;
  resultado: string;
  detalle: string | null;
  canal: string | null;
  idExternoCanal: string | null;
  ventaId: string | null;
}

/** Qué significa cada resultado, en criollo, y de qué color se ve. */
const RESULTADOS: Record<string, { texto: string; tono: string }> = {
  OK: { texto: 'Entró y salió la comanda', tono: 'bg-teresita-100 text-teresita-800' },
  DUPLICADO: { texto: 'Repetido — ya estaba cargado', tono: 'bg-cream-200 text-ink-700' },
  SIN_TOKEN_CONFIGURADO: {
    texto: 'La ingesta está apagada en el server',
    tono: 'bg-pomodoro-100 text-pomodoro-700',
  },
  TOKEN_INVALIDO: { texto: 'Token equivocado', tono: 'bg-pomodoro-100 text-pomodoro-700' },
  BODY_INVALIDO: { texto: 'Formato que no entendemos', tono: 'bg-saffron-100 text-saffron-800' },
  SIN_ADAPTADOR: {
    texto: 'Llegó bien, falta traducir su formato',
    tono: 'bg-saffron-100 text-saffron-800',
  },
  SKU_FALTANTE: { texto: 'Producto sin código', tono: 'bg-saffron-100 text-saffron-800' },
  FUERA_DE_HORARIO: { texto: 'Fuera de horario', tono: 'bg-saffron-100 text-saffron-800' },
  ERROR: { texto: 'Error del sistema', tono: 'bg-pomodoro-100 text-pomodoro-700' },
};

function hora(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function Copiable({ valor, etiqueta }: { valor: string; etiqueta: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="rounded-lg border border-cream-300 bg-cream-50 p-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-2xs uppercase tracking-wider text-ink-500">{etiqueta}</span>
        <button
          type="button"
          className="text-2xs text-teresita-700 hover:underline shrink-0"
          onClick={() => {
            void navigator.clipboard?.writeText(valor);
            setCopiado(true);
            setTimeout(() => setCopiado(false), 1500);
          }}
        >
          {copiado ? '✓ copiado' : 'copiar'}
        </button>
      </div>
      <p className="font-mono text-2xs text-ink-900 break-all">{valor}</p>
    </div>
  );
}

export default function IntegracionesPage() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [recepciones, setRecepciones] = useState<Recepcion[]>([]);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [soloErrores, setSoloErrores] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const [e, r] = await Promise.all([
        api.get<Estado>('/admin/channel/estado'),
        api.get<{ recepciones: Recepcion[] }>(
          `/admin/channel/recepciones?limite=40${soloErrores ? '&soloErrores=true' : ''}`,
        ),
      ]);
      setEstado(e);
      setRecepciones(r.recepciones);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar');
    } finally {
      setCargando(false);
    }
  }, [soloErrores]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <div className="space-y-6 max-w-4xl">
      <section className="card p-5">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-display text-lg text-teresita-700">Pedidos de plataformas</h2>
          <Button variant="secondary" onClick={() => void cargar()} disabled={cargando}>
            {cargando ? 'Actualizando…' : 'Actualizar'}
          </Button>
        </div>
        <p className="text-sm text-ink-500 mb-4">
          RAPPI, Pedidos YA y Mercado Libre mandan sus pedidos acá. Esta pantalla dice si estamos
          listos para recibirlos y muestra todo lo que llegó.
        </p>

        {error && <p className="text-sm text-pomodoro-600 mb-3">{error}</p>}

        {estado && (
          <div className="space-y-3">
            {!estado.tokenConfigurado ? (
              <div className="rounded-lg border border-pomodoro-300 bg-pomodoro-100 p-4">
                <p className="font-medium text-pomodoro-700 mb-1">La ingesta está apagada.</p>
                <p className="text-sm text-ink-700">
                  Falta la variable <code className="font-mono">CHANNEL_INGEST_TOKEN</code> en el
                  server. Mientras no esté, cualquier pedido que mande una plataforma se rechaza,
                  sin importar que todo lo demás esté bien.
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-teresita-700/20 bg-teresita-50 p-3">
                  <p className="text-sm text-teresita-800">
                    ✓ La ingesta está prendida y esperando pedidos.
                  </p>
                </div>

                <p className="text-xs text-ink-700 pt-1">
                  <strong>Esta es la dirección que hay que cargar en RAPPI.</strong> Lleva la clave
                  adentro — tratala como una contraseña, no la pegues en un chat ni en un mail.
                </p>
                {estado.urls.webhookRappi && (
                  <Copiable etiqueta="RAPPI" valor={estado.urls.webhookRappi} />
                )}
                {estado.urls.webhookPedidosYa && (
                  <Copiable etiqueta="Pedidos YA" valor={estado.urls.webhookPedidosYa} />
                )}

                {estado.urlEsLocal && (
                  <div className="rounded-lg border border-saffron-300 bg-saffron-100 p-3 text-sm text-ink-700">
                    <strong>Ojo:</strong> estás viendo esto desde la app instalada, así que la
                    dirección de arriba es la de esta computadora y RAPPI no la puede alcanzar.
                    Abrí esta misma pantalla desde el navegador (la versión en la nube) para sacar
                    la dirección buena.
                  </div>
                )}
              </>
            )}

            <div className="grid gap-2 sm:grid-cols-2 pt-1">
              <div className="rounded-lg border border-cream-300 p-3">
                <p className="text-2xs uppercase tracking-wider text-ink-500">Catálogo</p>
                <p className="text-sm text-ink-900">
                  {estado.catalogo.publicables} productos con código
                </p>
                {estado.catalogo.advertencia && (
                  <p className="text-2xs text-saffron-700 mt-1">{estado.catalogo.advertencia}</p>
                )}
              </div>
              <div className="rounded-lg border border-cream-300 p-3">
                <p className="text-2xs uppercase tracking-wider text-ink-500">Turno</p>
                <p className="text-sm text-ink-900">
                  {estado.horario.hayTurnoAbierto ? 'Hay caja abierta' : 'Sin caja abierta'}
                </p>
                {estado.horario.advertencia && (
                  <p className="text-2xs text-saffron-700 mt-1">{estado.horario.advertencia}</p>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-1">
          <h2 className="font-display text-lg text-teresita-700">Lo que llegó</h2>
          <label className="flex items-center gap-2 text-xs text-ink-700">
            <input
              type="checkbox"
              checked={soloErrores}
              onChange={(e) => setSoloErrores(e.target.checked)}
            />
            Sólo los que fallaron
          </label>
        </div>
        <p className="text-sm text-ink-500 mb-4">
          Cada vez que una plataforma golpea la puerta queda anotado acá, entre y no entre. Si
          hiciste una prueba y esta lista está vacía, el pedido nunca salió de la plataforma —
          revisá la dirección cargada allá.
        </p>

        {recepciones.length === 0 ? (
          <p className="text-sm text-ink-500 italic py-6 text-center">
            Todavía no llegó nada.
          </p>
        ) : (
          <div className="divide-y divide-cream-200">
            {recepciones.map((r) => {
              const info = RESULTADOS[r.resultado] ?? {
                texto: r.resultado,
                tono: 'bg-cream-200 text-ink-700',
              };
              const esta = abierta === r.id;
              return (
                <div key={r.id} className="py-2">
                  <button
                    type="button"
                    className="w-full text-left flex items-start gap-2 hover:bg-cream-50 rounded px-1 py-1"
                    onClick={() => setAbierta(esta ? null : r.id)}
                  >
                    <span
                      className={cn(
                        'text-2xs px-2 py-0.5 rounded-full whitespace-nowrap shrink-0',
                        info.tono,
                      )}
                    >
                      {info.texto}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs text-ink-700">
                        {hora(r.recibidoAt)}
                        {r.canal && ` · ${r.canal}`}
                        {r.idExternoCanal && ` · pedido ${r.idExternoCanal}`}
                      </span>
                      {r.detalle && (
                        <span className="block text-2xs text-ink-500 mt-0.5">{r.detalle}</span>
                      )}
                    </span>
                    <span className="text-2xs font-mono text-ink-400 shrink-0">{r.status}</span>
                  </button>

                  {esta && (
                    <div className="mt-2 space-y-2 px-1">
                      <div>
                        <p className="text-2xs uppercase tracking-wider text-ink-500 mb-1">
                          Lo que mandaron ({r.bytes} bytes)
                        </p>
                        <pre className="text-2xs font-mono bg-ink-900 text-cream-100 p-3 rounded overflow-x-auto max-h-72">
                          {r.body
                            ? JSON.stringify(r.body, null, 2)
                            : (r.bodyTexto ?? '(sin cuerpo)')}
                        </pre>
                      </div>
                      <div>
                        <p className="text-2xs uppercase tracking-wider text-ink-500 mb-1">
                          Encabezados (las claves van tapadas)
                        </p>
                        <pre className="text-2xs font-mono bg-cream-100 text-ink-700 p-3 rounded overflow-x-auto max-h-48">
                          {JSON.stringify(r.headers, null, 2)}
                        </pre>
                      </div>
                      <p className="text-2xs text-ink-400 font-mono">
                        {r.metodo} {r.ruta}
                        {r.ip && ` · desde ${r.ip}`}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
