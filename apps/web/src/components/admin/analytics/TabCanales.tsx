'use client';

import { useAnalytics, Card, Cargando, ErrorBanner, fmtPesos, fmtNum, TablaSimple, type TabProps } from './_shared';
import { InfoTooltip } from './InfoTooltip';

interface CanalesData {
  canales: Array<{
    canal: string;
    cantidad: number;
    monto: string;
    ticket_promedio: string;
    anuladas_cantidad: number;
    anuladas_pct: number;
    comisionPct: number;
    comisionMonto: string;
    montoNeto: string;
  }>;
  dso: Array<{ canal: string; dso_dias: number | null }>;
  aging: Array<{
    cuenta: string;
    monto_total: string;
    dias_0_7: string;
    dias_8_15: string;
    dias_16_30: string;
    dias_31plus: string;
  }>;
}

const CANAL_LABEL: Record<string, string> = {
  MOSTRADOR: 'Mostrador',
  TELEFONO: 'Teléfono',
  WHATSAPP: 'WhatsApp',
  WEB: 'Web',
  RAPPI: 'RAPPI',
  PEDIDOS_YA: 'Pedidos YA',
  MERCADO_LIBRE: 'Mercado Libre',
  DELIVERATE: 'DELIVERATE',
};

export function TabCanales(props: TabProps) {
  const { data, error, cargando } = useAnalytics<CanalesData>('/admin/analytics/canales', props);

  if (cargando && !data) return <Cargando alto={500} />;
  if (error) return <ErrorBanner mensaje={error} />;
  if (!data) return null;

  const totalNeto = data.canales.reduce((acc, c) => acc + Number(c.montoNeto), 0);
  const totalBruto = data.canales.reduce((acc, c) => acc + Number(c.monto), 0);
  const totalComisiones = data.canales.reduce((acc, c) => acc + Number(c.comisionMonto), 0);
  const dsoMap = new Map(data.dso.map((d) => [d.canal, d.dso_dias]));

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card p-3">
          <p className="text-xs text-ink-500 uppercase tracking-wide font-medium">Bruto facturado</p>
          <p className="text-xl font-semibold text-ink-900">{fmtPesos(totalBruto)}</p>
        </div>
        <div className="card p-3">
          <p className="text-xs text-ink-500 uppercase tracking-wide font-medium">
            Total comisiones de plataformas
            <InfoTooltip>
              <strong>Comisiones</strong> que cobran las plataformas externas
              (RAPPI ~25%, Pedidos YA ~22%, Mercado Libre ~13%, DELIVERATE ~5%).
              Estos % se descuentan del bruto antes de la liquidación.
              <br />
              <br />
              <em>NOTA</em>: los porcentajes vienen del default. Si negociaste
              otros, hay que cambiarlos en el código (próxima iteración:
              configurables desde Configuración → Sistema).
            </InfoTooltip>
          </p>
          <p className="text-xl font-semibold text-pomodoro-600">−{fmtPesos(totalComisiones)}</p>
        </div>
        <div className="card p-3 bg-basil-100">
          <p className="text-xs text-basil-600 uppercase tracking-wide font-medium">Neto post-comisión</p>
          <p className="text-xl font-semibold text-basil-600">{fmtPesos(totalNeto)}</p>
        </div>
      </div>

      <Card
        titulo="Performance por canal"
        tooltip={
          <InfoTooltip>
            <strong>Comparación canal a canal</strong> con los datos que más
            mueven la aguja para un negocio gastronómico:
            <ul className="ml-3 list-disc mt-1">
              <li><strong>Ticket promedio</strong>: si difiere mucho entre canales hay que entender por qué (ej. RAPPI suele tener tickets más altos por cobertura de minimum).</li>
              <li><strong>Tasa de anulación</strong>: si un canal supera 5% es señal de fricción operativa (ítems sin stock, demoras, errores).</li>
              <li><strong>Comisión</strong>: lo que se queda la plataforma. Pesa mucho en el resultado final — RAPPI a 25% sobre $1M = $250K menos.</li>
              <li><strong>DSO</strong> (Days Sales Outstanding): días entre venta y cobro real en cuenta. Mostrador es 0; las plataformas pagan a 7-30d.</li>
            </ul>
          </InfoTooltip>
        }
      >
        <TablaSimple
          columnas={[
            { key: 'canal', label: 'Canal' },
            { key: 'cantidad', label: 'Ventas', align: 'right' },
            { key: 'ticket', label: 'Ticket prom.', align: 'right' },
            { key: 'bruto', label: 'Bruto', align: 'right' },
            { key: 'comision', label: 'Comisión %', align: 'right' },
            { key: 'neto', label: 'Neto', align: 'right' },
            { key: 'anuladas', label: 'Anul. %', align: 'right' },
            { key: 'dso', label: 'DSO (días)', align: 'right' },
          ]}
          filas={data.canales.map((c) => ({
            canal: CANAL_LABEL[c.canal] ?? c.canal,
            cantidad: fmtNum(c.cantidad),
            ticket: fmtPesos(c.ticket_promedio),
            bruto: fmtPesos(c.monto),
            comision: c.comisionPct > 0 ? `${c.comisionPct}%` : '—',
            neto: <span className="font-semibold">{fmtPesos(c.montoNeto)}</span>,
            anuladas: c.anuladas_pct > 5 ? (
              <span className="text-pomodoro-600">{c.anuladas_pct.toFixed(1)}%</span>
            ) : (
              `${c.anuladas_pct.toFixed(1)}%`
            ),
            dso: (() => {
              const v = dsoMap.get(c.canal);
              return v == null ? '—' : v.toFixed(1);
            })(),
          }))}
        />
      </Card>

      <Card
        titulo="Aging de cuentas a cobrar"
        tooltip={
          <InfoTooltip>
            <strong>Aging</strong> = clasificación de saldos pendientes de
            liquidación según hace cuánto están vencidos. Métrica clásica de
            cuentas a cobrar:
            <ul className="ml-3 list-disc mt-1">
              <li><strong>0-7 días</strong>: dentro del ciclo normal de la mayoría de plataformas.</li>
              <li><strong>8-15 días</strong>: aceptable.</li>
              <li><strong>16-30</strong>: atención (ya pasó la fecha esperada de liquidación).</li>
              <li><strong>31+</strong>: investigar — RAPPI/PYA tienen plazo máx ~30 días.</li>
            </ul>
            Un saldo grande en 31+ puede indicar facturación trabada por algún error administrativo (CUIT, alias bancario, etc.).
          </InfoTooltip>
        }
      >
        <TablaSimple
          columnas={[
            { key: 'cuenta', label: 'Cuenta' },
            { key: 'total', label: 'Total pendiente', align: 'right' },
            { key: 'd07', label: '0-7 días', align: 'right' },
            { key: 'd815', label: '8-15 días', align: 'right' },
            { key: 'd1630', label: '16-30 días', align: 'right' },
            { key: 'd31', label: '31+ días', align: 'right' },
          ]}
          filas={data.aging.map((a) => ({
            cuenta: a.cuenta,
            total: <span className="font-semibold">{fmtPesos(a.monto_total)}</span>,
            d07: fmtPesos(a.dias_0_7),
            d815: fmtPesos(a.dias_8_15),
            d1630: fmtPesos(a.dias_16_30),
            d31: Number(a.dias_31plus) > 0 ? (
              <span className="text-pomodoro-600">{fmtPesos(a.dias_31plus)}</span>
            ) : (
              fmtPesos(a.dias_31plus)
            ),
          }))}
          vacioMsg="No hay liquidaciones pendientes."
        />
      </Card>
    </>
  );
}
