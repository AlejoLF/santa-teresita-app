'use client';

import { useState } from 'react';
import { PeriodoSelector, type Periodo } from '@/components/admin/analytics/PeriodoSelector';
import { TabResumen } from '@/components/admin/analytics/TabResumen';
import { TabTendencias } from '@/components/admin/analytics/TabTendencias';
import { TabClientes } from '@/components/admin/analytics/TabClientes';
import { TabProductos } from '@/components/admin/analytics/TabProductos';
import { TabCanales } from '@/components/admin/analytics/TabCanales';
import { TabEquipo } from '@/components/admin/analytics/TabEquipo';
import { TabMapa } from '@/components/admin/analytics/TabMapa';

type TabId =
  | 'resumen'
  | 'tendencias'
  | 'clientes'
  | 'productos'
  | 'canales'
  | 'equipo'
  | 'mapa';

const TABS: Array<{ id: TabId; label: string; icon: string; descripcion: string }> = [
  {
    id: 'resumen',
    label: 'Resumen',
    icon: '📊',
    descripcion: 'KPIs principales con tendencia (sparklines) y proyección de cierre.',
  },
  {
    id: 'tendencias',
    label: 'Tendencias',
    icon: '📈',
    descripcion: 'Heatmap día × hora, comparativo año contra año, promedio móvil.',
  },
  {
    id: 'clientes',
    label: 'Clientes',
    icon: '🤝',
    descripcion: 'Segmentación RFM, cohorte de retención, nuevos vs recurrentes, top 20.',
  },
  {
    id: 'productos',
    label: 'Productos',
    icon: '🍝',
    descripcion: 'Análisis de cesta, ABC (Pareto 80/20), productos en declive, top.',
  },
  {
    id: 'canales',
    label: 'Canales',
    icon: '🌐',
    descripcion: 'Comisiones netas, DSO, aging de cuentas a cobrar, tasa de anulación por canal.',
  },
  {
    id: 'equipo',
    label: 'Equipo',
    icon: '👥',
    descripcion: 'Performance por vendedor, tiempo de cocina, costo del descuento 10%.',
  },
  {
    id: 'mapa',
    label: 'Mapa',
    icon: '🗺️',
    descripcion: 'Mapa operativo del día (pines) + heatmap mensual de demanda por zona.',
  },
];

function isoHoy(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function AnalyticsPage() {
  const [tab, setTab] = useState<TabId>('resumen');
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const [customDesde, setCustomDesde] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [customHasta, setCustomHasta] = useState<string>(isoHoy);

  const tabActual = TABS.find((t) => t.id === tab)!;

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-6 max-w-7xl mx-auto">
      <header className="mb-4">
        <h1 className="font-display text-xl text-ink-900 mb-1">Analytics</h1>
        <p className="text-sm text-ink-500">
          Panel de inteligencia de negocio. Diseñado para análisis profundo
          (costo de comisiones por canal, retención de clientes, basket
          analysis, etc.). Cada métrica tiene una explicación académica al lado
          del título.
        </p>
      </header>

      <PeriodoSelector
        periodo={periodo}
        onChange={setPeriodo}
        desde={customDesde}
        hasta={customHasta}
        onDesde={setCustomDesde}
        onHasta={setCustomHasta}
      />

      {/* Tab bar — overflow horizontal scroll en mobile */}
      <div className="border-b border-cream-300 mb-4 overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <div className="flex gap-1 min-w-max">
          {TABS.map((t) => {
            const activa = t.id === tab;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={
                  activa
                    ? 'px-3 py-2 text-sm font-semibold border-b-2 border-teresita-700 text-teresita-700 whitespace-nowrap'
                    : 'px-3 py-2 text-sm text-ink-500 hover:text-ink-900 border-b-2 border-transparent whitespace-nowrap'
                }
              >
                <span className="mr-1">{t.icon}</span>
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-xs italic text-ink-500 mb-4">{tabActual.descripcion}</p>

      <div className="space-y-6">
        {tab === 'resumen' && (
          <TabResumen
            periodo={periodo}
            customDesde={customDesde}
            customHasta={customHasta}
          />
        )}
        {tab === 'tendencias' && (
          <TabTendencias
            periodo={periodo}
            customDesde={customDesde}
            customHasta={customHasta}
          />
        )}
        {tab === 'clientes' && (
          <TabClientes
            periodo={periodo}
            customDesde={customDesde}
            customHasta={customHasta}
          />
        )}
        {tab === 'productos' && (
          <TabProductos
            periodo={periodo}
            customDesde={customDesde}
            customHasta={customHasta}
          />
        )}
        {tab === 'canales' && (
          <TabCanales
            periodo={periodo}
            customDesde={customDesde}
            customHasta={customHasta}
          />
        )}
        {tab === 'equipo' && (
          <TabEquipo
            periodo={periodo}
            customDesde={customDesde}
            customHasta={customHasta}
          />
        )}
        {tab === 'mapa' && (
          <TabMapa
            periodo={periodo}
            customDesde={customDesde}
            customHasta={customHasta}
          />
        )}
      </div>
    </div>
  );
}
