'use client';

import { useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { useAnalytics, Card, Cargando, ErrorBanner, fmtPesos, fmtNum, type TabProps } from './_shared';
import { InfoTooltip } from './InfoTooltip';

interface MapaData {
  pinesHoy: Array<{
    venta_id: string;
    numero: number;
    total: string;
    estado: string;
    estado_delivery: string | null;
    cliente: string;
    telefono: string | null;
    direccion: string;
    lat: number | null;
    lng: number | null;
    demora_min: number | null;
  }>;
  heatmap: Array<{ lat: number; lng: number; cantidad: number; monto: string }>;
  geocodingPendiente: number;
}

// Centro aproximado de La Plata (donde está el local).
const CENTRO_LA_PLATA = { lat: -34.9215, lng: -57.9545 };
const ZOOM_DEFAULT = 13;

// Color por estado del delivery
const COLOR_PIN: Record<string, string> = {
  PENDIENTE: '#c2410c',  // saffron
  EN_RUTA: '#1f4d3c',    // teresita
  ENTREGADO: '#15803d',  // basil
  NO_ENTREGADO: '#b91c1c', // pomodoro
  DEVUELTO: '#5c5c58',
};

type Modo = 'operativo' | 'analitico';

export function TabMapa(props: TabProps) {
  const { data, error, cargando } = useAnalytics<MapaData>('/admin/analytics/mapa', props);
  const [modo, setModo] = useState<Modo>('operativo');
  const mapaRef = useRef<HTMLDivElement>(null);

  // Lazy-load MapLibre solo cuando estamos en este tab — evita inflar el bundle inicial.
  useEffect(() => {
    if (!mapaRef.current || !data) return;

    let cancelled = false;
    let mapInstance: MaplibreMap | null = null;

    (async () => {
      const maplibre = await import('maplibre-gl');
      if (cancelled || !mapaRef.current) return;

      mapInstance = new maplibre.Map({  // eslint-disable-line @typescript-eslint/no-non-null-assertion
        container: mapaRef.current,
        // Tile gratis sin API key — OpenStreetMap raster
        style: {
          version: 8,
          sources: {
            osm: {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              attribution: '© OpenStreetMap',
            },
          },
          layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
        },
        center: [CENTRO_LA_PLATA.lng, CENTRO_LA_PLATA.lat],
        zoom: ZOOM_DEFAULT,
      });
      mapInstance.on('load', () => {
        if (cancelled || !mapInstance) return;

        if (modo === 'operativo') {
          // Pines individuales del día
          for (const p of data.pinesHoy) {
            if (p.lat == null || p.lng == null) continue;
            const color = COLOR_PIN[p.estado_delivery ?? p.estado] ?? '#5c5c58';
            const marker = new maplibre.Marker({ color });
            const popup = new maplibre.Popup({ offset: 25 }).setHTML(`
              <div style="font-family:system-ui;font-size:12px;line-height:1.4;min-width:180px">
                <div style="font-weight:600;color:#0f0f0e">#${p.numero} — ${p.cliente}</div>
                <div style="color:#5c5c58;font-size:11px">${p.direccion}</div>
                ${p.telefono ? `<div style="color:#5c5c58;font-size:11px">📞 ${p.telefono}</div>` : ''}
                <div style="margin-top:4px"><strong>${fmtPesos(p.total)}</strong></div>
                <div style="font-size:11px;color:#5c5c58">
                  ${p.estado_delivery ?? p.estado}${p.demora_min != null ? ` · ${p.demora_min}min` : ''}
                </div>
              </div>
            `);
            marker.setLngLat([p.lng, p.lat]).setPopup(popup).addTo(mapInstance!);
          }
        } else {
          // Heatmap layer (analitico)
          const features = data.heatmap.map((h) => ({
            type: 'Feature' as const,
            properties: { peso: h.cantidad, monto: Number(h.monto) },
            geometry: { type: 'Point' as const, coordinates: [h.lng, h.lat] },
          }));
          mapInstance!.addSource('heatmap', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features },
          });
          mapInstance!.addLayer({
            id: 'heatmap-layer',
            type: 'heatmap',
            source: 'heatmap',
            maxzoom: 17,
            paint: {
              'heatmap-weight': ['interpolate', ['linear'], ['get', 'peso'], 0, 0, 50, 1],
              'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 11, 1, 17, 3],
              'heatmap-color': [
                'interpolate',
                ['linear'],
                ['heatmap-density'],
                0, 'rgba(31,77,60,0)',
                0.2, 'rgba(31,77,60,0.4)',
                0.5, 'rgba(46,112,83,0.7)',
                0.8, 'rgba(194,65,12,0.85)',
                1, 'rgba(185,28,28,1)',
              ],
              'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 11, 20, 17, 60],
              'heatmap-opacity': 0.85,
            },
          });
        }
      });
    })();

    return () => {
      cancelled = true;
      try {
        mapInstance?.remove();
      } catch {}
    };
  }, [data, modo]);

  if (cargando && !data) return <Cargando alto={500} />;
  if (error) return <ErrorBanner mensaje={error} />;
  if (!data) return null;

  const sinGeocodear = data.pinesHoy.filter((p) => p.lat == null || p.lng == null).length;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex bg-cream-200 rounded-md p-0.5">
            <button
              onClick={() => setModo('operativo')}
              className={
                modo === 'operativo'
                  ? 'px-3 py-1.5 rounded text-sm font-medium bg-white text-teresita-700 shadow-sm'
                  : 'px-3 py-1.5 rounded text-sm text-ink-500'
              }
            >
              Modo operativo (hoy)
            </button>
            <button
              onClick={() => setModo('analitico')}
              className={
                modo === 'analitico'
                  ? 'px-3 py-1.5 rounded text-sm font-medium bg-white text-teresita-700 shadow-sm'
                  : 'px-3 py-1.5 rounded text-sm text-ink-500'
              }
            >
              Heatmap del período
            </button>
          </div>
          <InfoTooltip>
            <strong>Modo operativo</strong>: pines individuales de los deliveries del día,
            coloreados por estado (pendiente / en ruta / entregado). Click en un pin →
            cliente, dirección, teléfono, demora actual.
            <br /><br />
            <strong>Modo analítico</strong>: heatmap del período seleccionado en la barra
            de arriba. Color = densidad de pedidos. Identifica zonas de alta demanda
            (foco de marketing geo-targeted) vs zonas blancas (oportunidades de pauta).
          </InfoTooltip>
        </div>

        {modo === 'operativo' && (
          <div className="flex flex-wrap gap-2 mb-3 text-2xs">
            {Object.entries(COLOR_PIN).map(([estado, color]) => (
              <span key={estado} className="inline-flex items-center gap-1 px-2 py-1 bg-cream-100 rounded">
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                {estado}
              </span>
            ))}
          </div>
        )}

        {data.geocodingPendiente > 0 && (
          <div className="bg-saffron-100 border-l-4 border-saffron-600 p-2 mb-3 text-xs">
            ⚠ Hay <strong>{fmtNum(data.geocodingPendiente)}</strong> direcciones de los últimos 90 días sin geocodificar.
            Aparecerán en el mapa cuando un job batch las procese vía Nominatim
            (próxima iteración). Las nuevas ventas que se cargan ahora se
            geocodifican on-write.
          </div>
        )}

        <div
          ref={mapaRef}
          className="w-full rounded-md border border-cream-300"
          style={{ height: 520, background: '#f0e9dc' }}
        />

        {modo === 'operativo' && sinGeocodear > 0 && (
          <p className="text-2xs text-ink-500 italic mt-2">
            {sinGeocodear} de {data.pinesHoy.length} pedidos del día no tienen coordenadas — no se ven en el mapa.
          </p>
        )}
      </Card>

      {modo === 'operativo' && (
        <Card titulo={`Lista de pedidos de hoy (${fmtNum(data.pinesHoy.length)})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cream-300 text-ink-500 text-xs uppercase tracking-wide">
                  <th className="py-2 px-2 text-left font-medium">#</th>
                  <th className="py-2 px-2 text-left font-medium">Cliente</th>
                  <th className="py-2 px-2 text-left font-medium">Dirección</th>
                  <th className="py-2 px-2 text-right font-medium">Total</th>
                  <th className="py-2 px-2 text-center font-medium">Estado</th>
                  <th className="py-2 px-2 text-right font-medium">Demora</th>
                </tr>
              </thead>
              <tbody>
                {data.pinesHoy.map((p) => (
                  <tr key={p.venta_id} className="border-b border-cream-200">
                    <td className="py-2 px-2 font-medium">#{p.numero}</td>
                    <td className="py-2 px-2">{p.cliente}</td>
                    <td className="py-2 px-2 text-ink-500 truncate max-w-xs">{p.direccion}</td>
                    <td className="py-2 px-2 text-right">{fmtPesos(p.total)}</td>
                    <td className="py-2 px-2 text-center">
                      <span
                        className="px-2 py-0.5 rounded text-2xs font-medium text-white"
                        style={{
                          backgroundColor: COLOR_PIN[p.estado_delivery ?? p.estado] ?? '#5c5c58',
                        }}
                      >
                        {p.estado_delivery ?? p.estado}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-right">
                      {p.demora_min != null ? `${p.demora_min}min` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.pinesHoy.length === 0 && (
              <p className="text-sm text-ink-500 italic text-center py-6">
                Aún no hay deliveries cargados hoy.
              </p>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
