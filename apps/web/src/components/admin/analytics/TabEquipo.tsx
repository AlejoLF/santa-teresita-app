'use client';

import { useAnalytics, Card, Cargando, ErrorBanner, fmtPesos, fmtNum, TablaSimple, type TabProps } from './_shared';
import { InfoTooltip } from './InfoTooltip';

interface EquipoData {
  vendedores: Array<{
    usuario_id: string;
    nombre: string;
    cantidad: number;
    monto: string;
    ticket_promedio: string;
    anuladas_cantidad: number;
    anuladas_pct: number;
    items_por_venta: number;
  }>;
  cocina: { pedidos_con_cocina: number; pedidos_sin_cocina: number };
  descuentoEfectivo: {
    monto_total: string;
    cantidad_ventas: number;
    ventas_total: number;
    pct_ventas_con_descuento: number;
  };
}

export function TabEquipo(props: TabProps) {
  const { data, error, cargando } = useAnalytics<EquipoData>('/admin/analytics/equipo', props);

  if (cargando && !data) return <Cargando alto={500} />;
  if (error) return <ErrorBanner mensaje={error} />;
  if (!data) return null;

  return (
    <>
      <Card
        titulo="Performance por vendedor"
        tooltip={
          <InfoTooltip>
            Ranking de cajeros por facturación del período.
            <ul className="ml-3 list-disc mt-1">
              <li><strong>Ticket promedio</strong>: refleja capacidad de up-selling / cross-selling.</li>
              <li><strong>Items por venta</strong>: cuántos productos en promedio mete en cada ticket. Un cajero entrenado debería empujar la cesta a 3+ ítems.</li>
              <li><strong>% anuladas</strong>: si supera 3% indica problema de capacitación o frecuencia de errores. Cruzar con motivo de anulación para diagnosticar.</li>
            </ul>
          </InfoTooltip>
        }
      >
        <TablaSimple
          columnas={[
            { key: 'nombre', label: 'Vendedor' },
            { key: 'cantidad', label: 'Ventas', align: 'right' },
            { key: 'monto', label: 'Total', align: 'right' },
            { key: 'ticket', label: 'Ticket prom.', align: 'right' },
            { key: 'items', label: 'Items / venta', align: 'right' },
            { key: 'anul', label: '% anuladas', align: 'right' },
          ]}
          filas={data.vendedores.map((v) => ({
            nombre: v.nombre,
            cantidad: fmtNum(v.cantidad),
            monto: fmtPesos(v.monto),
            ticket: fmtPesos(v.ticket_promedio),
            items: v.items_por_venta?.toFixed(1) ?? '—',
            anul: v.anuladas_pct > 3 ? (
              <span className="text-pomodoro-600">{v.anuladas_pct.toFixed(1)}%</span>
            ) : (
              `${v.anuladas_pct.toFixed(1)}%`
            ),
          }))}
        />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card
          titulo="Cocina"
          tooltip={
            <InfoTooltip>
              Distribución de pedidos según si requirieron paso por cocina
              (porciones calientes, lasagnas, etc.) o no (solo pasta fresca,
              estantería, bebidas). Próxima iteración: tiempo desde "comanda
              impresa" hasta "pedido listo" como métrica de productividad de
              cocina.
            </InfoTooltip>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-saffron-100 p-4 rounded-md text-center">
              <p className="text-xs text-saffron-600 uppercase font-medium">Con cocina</p>
              <p className="text-2xl font-bold text-saffron-600">
                {fmtNum(data.cocina.pedidos_con_cocina)}
              </p>
            </div>
            <div className="bg-cream-200 p-4 rounded-md text-center">
              <p className="text-xs text-ink-500 uppercase font-medium">Sin cocina</p>
              <p className="text-2xl font-bold text-ink-700">
                {fmtNum(data.cocina.pedidos_sin_cocina)}
              </p>
            </div>
          </div>
        </Card>

        <Card
          titulo="Costo del descuento 10% efectivo"
          tooltip={
            <InfoTooltip>
              <strong>Descuento por pago en efectivo</strong> = el 10% que se le
              regala al cliente que paga con efectivo en mostrador. Es un
              incentivo para reducir comisiones de tarjetas y aumentar liquidez
              inmediata. Esta tarjeta muestra cuánto cuesta esa política en
              total.
              <br />
              <br />
              Para evaluar si vale la pena: comparar con la comisión que se
              evitaría si esos clientes hubieran pagado con tarjeta (~3-5%).
              Si el descuento &gt; comisión evitada, hay que recalibrar (bajar a
              5%, eliminar, etc.).
            </InfoTooltip>
          }
        >
          <p className="text-xs text-ink-500 uppercase tracking-wide font-medium">Total regalado</p>
          <p className="text-2xl font-bold text-pomodoro-600 mb-2">
            −{fmtPesos(data.descuentoEfectivo.monto_total)}
          </p>
          <p className="text-xs text-ink-500">
            {fmtNum(data.descuentoEfectivo.cantidad_ventas)} ventas con descuento de{' '}
            {fmtNum(data.descuentoEfectivo.ventas_total)} totales (
            {data.descuentoEfectivo.pct_ventas_con_descuento?.toFixed(1) ?? '0.0'}%)
          </p>
        </Card>
      </div>
    </>
  );
}
