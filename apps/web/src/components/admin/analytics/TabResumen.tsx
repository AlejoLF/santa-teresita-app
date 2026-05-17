'use client';

import { useAnalytics, Card, Cargando, ErrorBanner, fmtPesos, fmtPct, fmtNum, type TabProps } from './_shared';
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
} from 'recharts';

interface ResumenData {
  kpis: {
    ventasTotal: string;
    ventasCantidad: number;
    ticketPromedio: string;
    descuentoTotal: string;
    variacionVentasPct: number | null;
    anuladasMonto: string;
    anuladasCantidad: number;
    egresosTotal: string;
    resultadoNeto: string;
  };
  sparklines: Array<{ fecha: string; ventas: string; egresos: string }>;
  porHora: Array<{ hora: number; monto: number; cantidad: number }>;
  proyeccion: {
    diasTranscurridos: number;
    diasTotales: number;
    ventasHasta: string;
    proyeccionTotal: string;
    promedioPorDia: string;
  } | null;
}

export function TabResumen(props: TabProps) {
  const { data, error, cargando } = useAnalytics<ResumenData>('/admin/analytics/resumen', props);

  if (cargando && !data) return <Cargando alto={400} />;
  if (error) return <ErrorBanner mensaje={error} />;
  if (!data) return null;

  const k = data.kpis;
  const sparkVentas = data.sparklines.map((s) => ({ fecha: s.fecha.slice(5), v: Number(s.ventas) }));
  const sparkEgresos = data.sparklines.map((s) => ({ fecha: s.fecha.slice(5), v: Number(s.egresos) }));
  const proy = data.proyeccion;
  // Defensivo: si el API en uso es una versión anterior (o sirve una respuesta
  // cacheada) sin `porHora`, no crasheamos — mostramos la sección vacía.
  const porHora = data.porHora ?? [];

  return (
    <>
      {/* KPI grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPIBox
          titulo="Ventas"
          valor={fmtPesos(k.ventasTotal)}
          delta={k.variacionVentasPct}
          subtitulo={`${fmtNum(k.ventasCantidad)} ventas`}
          spark={sparkVentas}
          color="basil"
        />
        <KPIBox
          titulo="Ticket promedio"
          valor={fmtPesos(k.ticketPromedio)}
          tooltip={
            <>
              <strong>Ticket promedio</strong> = total facturado ÷ cantidad de ventas finalizadas. Excluye anuladas.
            </>
          }
        />
        <KPIBox
          titulo="Anuladas"
          valor={fmtPesos(k.anuladasMonto)}
          subtitulo={`${fmtNum(k.anuladasCantidad)} ventas`}
          color="pomodoro"
          tooltip={
            <>
              <strong>Anulaciones</strong> = ventas marcadas como ANULADA por el cajero (con motivo). No incluyen las que se finalizaron y devolvieron por otra vía.
            </>
          }
        />
        <KPIBox
          titulo="Resultado neto"
          valor={fmtPesos(k.resultadoNeto)}
          subtitulo={`Egresos: ${fmtPesos(k.egresosTotal)}`}
          color={Number(k.resultadoNeto) >= 0 ? 'basil' : 'pomodoro'}
          tooltip={
            <>
              <strong>Resultado neto</strong> = ventas finalizadas − egresos del período. No es la utilidad real (no contempla CMV ni costos fijos prorrateados); es un proxy de generación de caja del período.
            </>
          }
        />
      </div>

      {/* Proyección de mes */}
      {proy && (
        <Card
          titulo="Proyección de cierre del mes"
          tooltip={
            <InfoTooltip>
              <strong>Proyección lineal</strong> = (ventas mes hasta hoy ÷ días transcurridos) × días totales del mes. Asume que el ritmo se mantiene. Útil como referencia, no como compromiso — los meses no son lineales (fines de semana, feriados, eventos).
            </InfoTooltip>
          }
        >
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-ink-500">Acumulado</p>
              <p className="text-lg font-semibold text-ink-900">{fmtPesos(proy.ventasHasta)}</p>
            </div>
            <div>
              <p className="text-xs text-ink-500">Promedio diario</p>
              <p className="text-lg font-semibold text-ink-900">{fmtPesos(proy.promedioPorDia)}</p>
            </div>
            <div>
              <p className="text-xs text-ink-500">Proyección al cierre</p>
              <p className="text-lg font-semibold text-teresita-700">{fmtPesos(proy.proyeccionTotal)}</p>
            </div>
            <div>
              <p className="text-xs text-ink-500">Días</p>
              <p className="text-lg font-semibold text-ink-900">
                {proy.diasTranscurridos} <span className="text-ink-500 text-sm font-normal">/ {proy.diasTotales}</span>
              </p>
              <div className="w-full h-1 bg-cream-200 rounded-full mt-1 overflow-hidden">
                <div
                  className="h-full bg-teresita-700"
                  style={{ width: `${(proy.diasTranscurridos / proy.diasTotales) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Ventas por hora del día — agregado del período seleccionado */}
      <Card
        titulo="Ventas por hora"
        tooltip={
          <InfoTooltip>
            Suma de las ventas finalizadas por <strong>hora del día</strong> a lo largo de
            todo el período seleccionado (en horario de La Plata). Sirve para ver las
            franjas de mayor demanda. Se ajusta al período elegido arriba.
          </InfoTooltip>
        }
      >
        {porHora.length === 0 ? (
          <p className="text-sm text-ink-500 py-8 text-center">
            Sin ventas en el período seleccionado.
          </p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart
                data={porHora.map((h) => ({
                  hora: `${String(h.hora).padStart(2, '0')}:00`,
                  monto: h.monto,
                  cantidad: h.cantidad,
                }))}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="hora" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => fmtPesos(v)} />
                <Tooltip
                  formatter={(v, name) =>
                    name === 'monto' ? fmtPesos(Number(v)) : `${fmtNum(Number(v))} ventas`
                  }
                  contentStyle={{
                    background: '#fff',
                    border: '1px solid #e5e7eb',
                    borderRadius: 6,
                  }}
                />
                <Bar dataKey="monto" fill="#1f4d3c" radius={[3, 3, 0, 0]} name="monto" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Series de ventas + egresos */}
      <Card titulo="Evolución diaria">
        <div className="h-64">
          <ResponsiveContainer>
            <LineChart data={data.sparklines.map((s) => ({ fecha: s.fecha, ventas: Number(s.ventas), egresos: Number(s.egresos) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="fecha" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => fmtPesos(v)} />
              <Tooltip
                formatter={(v) => fmtPesos(Number(v))}
                contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6 }}
              />
              <Line type="monotone" dataKey="ventas" stroke="#1f4d3c" strokeWidth={2} dot={false} name="Ventas" />
              <Line type="monotone" dataKey="egresos" stroke="#b91c1c" strokeWidth={2} dot={false} name="Egresos" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </>
  );
}

function KPIBox({
  titulo,
  valor,
  delta,
  subtitulo,
  spark,
  color = 'teresita',
  tooltip,
}: {
  titulo: string;
  valor: string;
  delta?: number | null;
  subtitulo?: string;
  spark?: Array<{ fecha: string; v: number }>;
  color?: 'teresita' | 'basil' | 'pomodoro';
  tooltip?: React.ReactNode;
}) {
  const colorClass =
    color === 'basil' ? 'text-basil-600' : color === 'pomodoro' ? 'text-pomodoro-600' : 'text-teresita-700';
  return (
    <div className="card p-3">
      <div className="flex items-center mb-1">
        <p className="text-xs text-ink-500 uppercase tracking-wide font-medium">{titulo}</p>
        {tooltip && <InfoTooltip>{tooltip}</InfoTooltip>}
      </div>
      <p className={`text-xl font-semibold ${colorClass}`}>{valor}</p>
      {(subtitulo || delta != null) && (
        <p className="text-xs text-ink-500 mt-0.5">
          {subtitulo && <span>{subtitulo}</span>}
          {delta != null && (
            <span
              className={`ml-2 ${delta >= 0 ? 'text-basil-600' : 'text-pomodoro-600'}`}
              title="Variación vs período inmediato anterior de igual duración"
            >
              {fmtPct(delta)}
            </span>
          )}
        </p>
      )}
      {spark && spark.length > 1 && (
        <div className="h-8 mt-1">
          <ResponsiveContainer>
            <LineChart data={spark}>
              <Line type="monotone" dataKey="v" stroke="#1f4d3c" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
