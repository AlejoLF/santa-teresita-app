'use client';

import { useAnalytics, Card, Cargando, ErrorBanner, fmtPesos, type TabProps } from './_shared';
import { InfoTooltip } from './InfoTooltip';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from 'recharts';

interface TendenciasData {
  heatmap: Array<{ dia: number; hora: number; cantidad: number; total: string }>;
  yoy: Array<{ mes: string; total: string }>;
  rolling: Array<{ fecha: string; total: string; ma7: string; ma28: string }>;
}

const DIAS_LABEL = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export function TabTendencias(props: TabProps) {
  const { data, error, cargando } = useAnalytics<TendenciasData>('/admin/analytics/tendencias', props);

  if (cargando && !data) return <Cargando alto={500} />;
  if (error) return <ErrorBanner mensaje={error} />;
  if (!data) return null;

  // Heatmap día×hora — armamos matriz 7×24
  const matriz: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const c of data.heatmap) {
    if (c.dia >= 0 && c.dia < 7 && c.hora >= 0 && c.hora < 24) {
      matriz[c.dia]![c.hora] = Number(c.total);
      if (Number(c.total) > max) max = Number(c.total);
    }
  }

  // YoY: agrupamos por mes-del-año comparando anio-actual vs anio-anterior
  const ahora = new Date();
  const anioActual = ahora.getFullYear();
  const yoyData: Array<{ mes: string; actual: number; anterior: number }> = [];
  for (let m = 0; m < 12; m++) {
    const mesActual = `${anioActual}-${String(m + 1).padStart(2, '0')}`;
    const mesAnterior = `${anioActual - 1}-${String(m + 1).padStart(2, '0')}`;
    const a = data.yoy.find((r) => r.mes === mesActual);
    const b = data.yoy.find((r) => r.mes === mesAnterior);
    yoyData.push({
      mes: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'][m]!,
      actual: a ? Number(a.total) : 0,
      anterior: b ? Number(b.total) : 0,
    });
  }

  return (
    <>
      <Card
        titulo="Heatmap día × hora"
        tooltip={
          <InfoTooltip>
            <strong>Heatmap día × hora</strong> = mapa de calor donde cada celda
            representa la suma facturada en ese día de la semana × hora del día.
            Identifica los rushes reales (ej. sábado 13h vs jueves 21h) y zonas
            muertas. Color más intenso = más facturación.
          </InfoTooltip>
        }
      >
        <div className="overflow-x-auto">
          <table className="text-2xs">
            <thead>
              <tr>
                <th className="text-right pr-2 text-ink-500 font-normal"></th>
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} className="px-1 text-ink-500 font-normal text-center w-7">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Reordenamos: lunes primero */}
              {[1, 2, 3, 4, 5, 6, 0].map((dia) => (
                <tr key={dia}>
                  <td className="text-right pr-2 text-ink-500 font-medium">
                    {DIAS_LABEL[dia]}
                  </td>
                  {Array.from({ length: 24 }, (_, h) => {
                    const v = matriz[dia]![h]!;
                    const intensity = max > 0 ? v / max : 0;
                    return (
                      <td
                        key={h}
                        className="w-7 h-7 border border-cream-100 text-center"
                        style={{
                          backgroundColor:
                            intensity > 0
                              ? `rgba(31, 77, 60, ${0.12 + intensity * 0.78})`
                              : 'transparent',
                        }}
                        title={`${DIAS_LABEL[dia]} ${h}:00 — ${fmtPesos(v)}`}
                      >
                        {v > 0 && intensity > 0.6 ? (
                          <span className="text-white text-2xs">●</span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-2xs text-ink-500 italic mt-2">
          Hover sobre cada celda para ver el monto. Lunes a sábado, 0–23 hs.
        </p>
      </Card>

      <Card
        titulo="Comparativo año contra año (YoY)"
        tooltip={
          <InfoTooltip>
            <strong>YoY (Year-over-Year)</strong> = facturación del mismo mes del
            año actual vs año anterior. Permite separar crecimiento real de
            estacionalidad — un mes "alto" puede ser solo porque siempre es alto
            (ej. diciembre). Si la barra "actual" supera a "anterior", el negocio
            está creciendo en términos reales para ese mes.
          </InfoTooltip>
        }
      >
        <div className="h-64">
          <ResponsiveContainer>
            <BarChart data={yoyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => fmtPesos(v)} />
              <Tooltip
                formatter={(v) => fmtPesos(Number(v))}
                contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6 }}
              />
              <Legend />
              <Bar dataKey="anterior" fill="#9c9a93" name={`${anioActual - 1}`} />
              <Bar dataKey="actual" fill="#1f4d3c" name={`${anioActual}`} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card
        titulo="Promedio móvil 7d / 28d"
        tooltip={
          <InfoTooltip>
            <strong>Moving average (MA)</strong> = promedio de los últimos N días.
            <br />
            <strong>MA7</strong> suaviza ruido diario (fines de semana vs días de
            semana). <strong>MA28</strong> revela la tendencia mensual. Si MA7
            cruza por arriba de MA28 → tendencia alcista. Cruce por abajo →
            bajista.
          </InfoTooltip>
        }
      >
        <div className="h-64">
          <ResponsiveContainer>
            <LineChart
              data={data.rolling.map((r) => ({
                fecha: r.fecha.slice(5),
                total: Number(r.total),
                ma7: Number(r.ma7),
                ma28: Number(r.ma28),
              }))}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="fecha" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => fmtPesos(v)} />
              <Tooltip
                formatter={(v) => fmtPesos(Number(v))}
                contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6 }}
              />
              <Legend />
              <Line type="monotone" dataKey="total" stroke="#9c9a93" strokeWidth={1} dot={false} name="Diario" />
              <Line type="monotone" dataKey="ma7" stroke="#2e7053" strokeWidth={2} dot={false} name="MA 7d" />
              <Line type="monotone" dataKey="ma28" stroke="#1f4d3c" strokeWidth={2} dot={false} name="MA 28d" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </>
  );
}
