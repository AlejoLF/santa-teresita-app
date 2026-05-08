'use client';

import { useAnalytics, Card, Cargando, ErrorBanner, fmtPesos, fmtNum, TablaSimple, type TabProps } from './_shared';
import { InfoTooltip } from './InfoTooltip';
import {
  ScatterChart,
  Scatter,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Legend,
} from 'recharts';

interface ClientesData {
  rfm: Array<{
    cliente_id: string;
    nombre: string;
    telefono: string | null;
    recency_dias: number;
    frequency: number;
    monetary: string;
    ultima_compra: string;
    segmento: string;
  }>;
  segmentos: Array<{ segmento: string; cantidad: number; monto: string }>;
  cohort: Array<{ cohorte_mes: string; mes_compra: string; clientes: number }>;
  nuevosVsRecurrentes: Array<{ mes: string; nuevos: number; recurrentes: number }>;
  top: Array<{ cliente_id: string | null; nombre: string; cantidad: number; monto: string }>;
}

const SEGMENTO_COLOR: Record<string, string> = {
  VIP: '#1f4d3c',
  Fiel: '#2e7053',
  Activo: '#6fa086',
  'En riesgo': '#c2410c',
  Perdido: '#b91c1c',
};

export function TabClientes(props: TabProps) {
  const { data, error, cargando } = useAnalytics<ClientesData>('/admin/analytics/clientes', props);

  if (cargando && !data) return <Cargando alto={500} />;
  if (error) return <ErrorBanner mensaje={error} />;
  if (!data) return null;

  // Cohort matrix: para cada cohorte y cada mes desde la primer compra,
  // calcular % de clientes que volvieron
  const cohortes = Array.from(new Set(data.cohort.map((c) => c.cohorte_mes))).sort();
  const cohortMatrix: Array<{
    cohorte: string;
    base: number;
    valores: Array<{ ofs: number; pct: number; clientes: number }>;
  }> = [];
  for (const coh of cohortes) {
    const filas = data.cohort.filter((c) => c.cohorte_mes === coh);
    const base = filas.find((f) => f.mes_compra === coh)?.clientes ?? 0;
    const valores: Array<{ ofs: number; pct: number; clientes: number }> = [];
    if (base === 0) continue;
    const [yc, mc] = coh.split('-').map(Number);
    for (const f of filas) {
      const [y, m] = f.mes_compra.split('-').map(Number);
      const ofs = (y! - yc!) * 12 + (m! - mc!);
      valores.push({ ofs, pct: (f.clientes / base) * 100, clientes: f.clientes });
    }
    valores.sort((a, b) => a.ofs - b.ofs);
    cohortMatrix.push({ cohorte: coh, base, valores });
  }
  const maxOfs = Math.max(0, ...cohortMatrix.flatMap((c) => c.valores.map((v) => v.ofs)));

  return (
    <>
      <Card
        titulo="Distribución por segmento RFM"
        tooltip={
          <InfoTooltip>
            <strong>RFM (Recency, Frequency, Monetary)</strong> — segmentación
            estándar en marketing directo. Clasifica clientes según hace cuánto
            compraron (R), con qué frecuencia (F) y cuánto gastaron (M). Los
            <strong> VIP</strong> son la prioridad de retención; los{' '}
            <strong>en riesgo</strong> requieren acción (cupón, contacto); los{' '}
            <strong>perdidos</strong> ya no se recuperan en general.
            <br />
            <br />
            Reglas usadas: VIP = ≥5 compras y última ≤30 días. Fiel = ≥3 compras y
            última ≤60. Activo = última ≤90. En riesgo = última ≤180. Perdido = más
            de 180 días sin comprar.
          </InfoTooltip>
        }
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-4">
          {data.segmentos.map((s) => (
            <div
              key={s.segmento}
              className="rounded-md p-3 text-cream-50"
              style={{ backgroundColor: SEGMENTO_COLOR[s.segmento] || '#5c5c58' }}
            >
              <p className="text-xs uppercase tracking-wide opacity-90">{s.segmento}</p>
              <p className="text-lg font-bold">{fmtNum(s.cantidad)}</p>
              <p className="text-xs opacity-90">{fmtPesos(s.monto)}</p>
            </div>
          ))}
        </div>

        <p className="text-xs text-ink-500 mb-2">
          Cada punto = un cliente. Eje X = días desde última compra (cuanto más a la izquierda, más reciente). Eje Y = total gastado histórico (cuanto más arriba, más valioso).
        </p>
        <div className="h-72">
          <ResponsiveContainer>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                type="number"
                dataKey="recency_dias"
                name="Días desde última compra"
                tick={{ fontSize: 11 }}
                domain={[0, 'dataMax']}
              />
              <YAxis
                type="number"
                dataKey="monetary"
                name="Total gastado"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => fmtPesos(v)}
              />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  if (!active || !payload || !payload.length) return null;
                  const p = payload[0]!.payload as ClientesData['rfm'][0];
                  return (
                    <div className="bg-white p-2 border border-cream-300 rounded text-xs shadow">
                      <div className="font-semibold">{p.nombre}</div>
                      <div className="text-ink-500">{p.segmento}</div>
                      <div>Compras: {p.frequency}</div>
                      <div>Total: {fmtPesos(p.monetary)}</div>
                      <div>Última: hace {p.recency_dias} días</div>
                    </div>
                  );
                }}
              />
              {Object.keys(SEGMENTO_COLOR).map((seg) => (
                <Scatter
                  key={seg}
                  name={seg}
                  data={data.rfm
                    .filter((r) => r.segmento === seg)
                    .map((r) => ({
                      ...r,
                      monetary: Number(r.monetary),
                    }))}
                  fill={SEGMENTO_COLOR[seg]}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card
        titulo="Cohorte de retención"
        tooltip={
          <InfoTooltip>
            <strong>Cohort retention analysis</strong> — agrupa a los clientes
            según el mes en que hicieron su <em>primera</em> compra ("cohorte"),
            y mide qué porcentaje de cada cohorte volvió a comprar en los meses
            siguientes (M+1, M+2, ...). Si la curva cae rápido = retención
            pobre. Si se mantiene plana = clientes fieles.
            <br />
            <br />
            Lectura: una celda con 30% en M+2 significa que el 30% de los
            clientes que se incorporaron en ese mes volvieron 2 meses después.
          </InfoTooltip>
        }
      >
        {cohortMatrix.length === 0 ? (
          <p className="text-sm text-ink-500 italic text-center py-6">
            No hay suficientes datos históricos para calcular cohortes (requiere ventas en al menos 2 meses con cliente identificado).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="text-left py-2 px-2 text-ink-500 font-medium">Cohorte</th>
                  <th className="text-right py-2 px-2 text-ink-500 font-medium">Clientes</th>
                  {Array.from({ length: maxOfs + 1 }, (_, i) => (
                    <th key={i} className="text-center py-2 px-2 text-ink-500 font-medium w-14">
                      M+{i}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohortMatrix.map((row) => (
                  <tr key={row.cohorte} className="border-t border-cream-200">
                    <td className="py-2 px-2 font-medium">{row.cohorte}</td>
                    <td className="py-2 px-2 text-right text-ink-700">{row.base}</td>
                    {Array.from({ length: maxOfs + 1 }, (_, i) => {
                      const v = row.valores.find((x) => x.ofs === i);
                      const pct = v?.pct ?? 0;
                      return (
                        <td
                          key={i}
                          className="text-center py-2 px-2"
                          style={{
                            backgroundColor: pct > 0 ? `rgba(31, 77, 60, ${0.1 + (pct / 100) * 0.7})` : 'transparent',
                            color: pct > 50 ? 'white' : '#0f0f0e',
                          }}
                        >
                          {v ? `${pct.toFixed(0)}%` : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        titulo="Nuevos vs recurrentes (últimos 12 meses)"
        tooltip={
          <InfoTooltip>
            <strong>Cliente nuevo</strong> = mes en que hizo su primera compra.{' '}
            <strong>Recurrente</strong> = ya había comprado antes. Un negocio
            saludable depende menos de adquisición y más de recurrencia.
            Si % recurrentes &lt; 30% mes a mes, hay un problema de retención.
          </InfoTooltip>
        }
      >
        <div className="h-64">
          <ResponsiveContainer>
            <BarChart data={data.nuevosVsRecurrentes}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="nuevos" stackId="a" fill="#2e7053" name="Nuevos" />
              <Bar dataKey="recurrentes" stackId="a" fill="#1f4d3c" name="Recurrentes" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card titulo="Top 20 clientes del período">
        <TablaSimple
          columnas={[
            { key: 'nombre', label: 'Cliente' },
            { key: 'cantidad', label: 'Compras', align: 'right' },
            { key: 'monto', label: 'Total', align: 'right' },
          ]}
          filas={data.top.map((c) => ({
            nombre: c.nombre,
            cantidad: fmtNum(c.cantidad),
            monto: fmtPesos(c.monto),
          }))}
        />
      </Card>
    </>
  );
}
