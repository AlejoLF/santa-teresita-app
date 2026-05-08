'use client';

import { useAnalytics, Card, Cargando, ErrorBanner, fmtPesos, fmtNum, fmtPct, TablaSimple, type TabProps } from './_shared';
import { InfoTooltip } from './InfoTooltip';

interface ProductosData {
  top: Array<{ producto_id: string; nombre: string; cantidad: string; monto: string; ocurrencias: number }>;
  abc: Array<{
    producto_id: string;
    nombre: string;
    monto: string;
    monto_acum: string;
    pct_acum: number;
    clase: string;
  }>;
  basket: Array<{ producto_a: string; producto_b: string; coocurrencias: number; support_pct: number }>;
  declinantes: Array<{
    producto_id: string;
    nombre: string;
    monto_actual: string;
    monto_anterior: string;
    variacion_pct: number;
  }>;
}

const CLASE_COLOR: Record<string, string> = {
  A: 'bg-basil-100 text-basil-600',
  B: 'bg-saffron-100 text-saffron-600',
  C: 'bg-cream-200 text-ink-700',
};

export function TabProductos(props: TabProps) {
  const { data, error, cargando } = useAnalytics<ProductosData>('/admin/analytics/productos', props);

  if (cargando && !data) return <Cargando alto={500} />;
  if (error) return <ErrorBanner mensaje={error} />;
  if (!data) return null;

  const conteoClase = data.abc.reduce<Record<string, { cantidad: number; monto: number }>>(
    (acc, r) => {
      if (!acc[r.clase]) acc[r.clase] = { cantidad: 0, monto: 0 };
      acc[r.clase]!.cantidad += 1;
      acc[r.clase]!.monto += Number(r.monto);
      return acc;
    },
    {},
  );

  return (
    <>
      <Card titulo="Top 30 productos del período">
        <TablaSimple
          columnas={[
            { key: 'nombre', label: 'Producto' },
            { key: 'cantidad', label: 'Cantidad', align: 'right' },
            { key: 'ocurrencias', label: 'Ventas', align: 'right' },
            { key: 'monto', label: 'Total', align: 'right' },
          ]}
          filas={data.top.map((p) => ({
            nombre: p.nombre,
            cantidad: fmtNum(Number(p.cantidad)),
            ocurrencias: fmtNum(p.ocurrencias),
            monto: fmtPesos(p.monto),
          }))}
        />
      </Card>

      <Card
        titulo="Análisis ABC (Pareto 80/20)"
        tooltip={
          <InfoTooltip>
            <strong>ABC analysis</strong> — herramienta clásica de gestión de
            inventario. Clasifica productos según su contribución a la
            facturación acumulada:
            <ul className="ml-3 list-disc mt-1">
              <li><strong>A</strong> = los pocos productos que generan el 80% del ingreso (foco máximo de stock + atención).</li>
              <li><strong>B</strong> = los siguientes que generan hasta el 95% (gestión normal).</li>
              <li><strong>C</strong> = la cola larga (95-100%, candidatos a discontinuar si tienen costos de mantenimiento).</li>
            </ul>
            La regla de Pareto sugiere que ~20% de los productos generan ~80% — si no, hay diversificación atípica.
          </InfoTooltip>
        }
      >
        <div className="grid grid-cols-3 gap-3 mb-4">
          {(['A', 'B', 'C'] as const).map((c) => (
            <div key={c} className={`p-3 rounded-md ${CLASE_COLOR[c]}`}>
              <p className="text-xs uppercase tracking-wide opacity-80">Clase {c}</p>
              <p className="text-lg font-bold">{conteoClase[c]?.cantidad ?? 0} productos</p>
              <p className="text-xs">{fmtPesos(conteoClase[c]?.monto ?? 0)}</p>
            </div>
          ))}
        </div>
        <TablaSimple
          columnas={[
            { key: 'clase', label: 'Clase', align: 'center' },
            { key: 'nombre', label: 'Producto' },
            { key: 'monto', label: 'Total', align: 'right' },
            { key: 'pct_acum', label: '% acumulado', align: 'right' },
          ]}
          filas={data.abc.slice(0, 30).map((p) => ({
            clase: <span className={`px-2 py-0.5 rounded text-2xs font-bold ${CLASE_COLOR[p.clase]}`}>{p.clase}</span>,
            nombre: p.nombre,
            monto: fmtPesos(p.monto),
            pct_acum: `${p.pct_acum.toFixed(1)}%`,
          }))}
        />
      </Card>

      <Card
        titulo="Análisis de cesta (basket analysis)"
        tooltip={
          <InfoTooltip>
            <strong>Basket analysis (Market Basket Analysis)</strong> —
            identifica productos que tienden a comprarse juntos en la misma
            venta. La métrica de <strong>support</strong> es el % de ventas
            totales del período que contienen ambos productos. Útil para:
            <ul className="ml-3 list-disc mt-1">
              <li>Diseñar combos / promos que combinen pares fuertes.</li>
              <li>Sugerencias de venta cruzada ("¿agregás X?").</li>
              <li>Layout del menú (productos complementarios cerca).</li>
            </ul>
            Solo se muestran pares con ≥2 co-ocurrencias en el período.
          </InfoTooltip>
        }
      >
        <TablaSimple
          columnas={[
            { key: 'a', label: 'Producto A' },
            { key: 'b', label: 'Producto B' },
            { key: 'co', label: 'Veces juntos', align: 'right' },
            { key: 'support', label: 'Support %', align: 'right' },
          ]}
          filas={data.basket.map((b) => ({
            a: b.producto_a,
            b: b.producto_b,
            co: fmtNum(b.coocurrencias),
            support: `${b.support_pct.toFixed(2)}%`,
          }))}
          vacioMsg="Aún no hay suficientes ventas con ≥2 productos para detectar pares frecuentes."
        />
      </Card>

      <Card
        titulo="Productos en declive"
        tooltip={
          <InfoTooltip>
            <strong>Productos en declive</strong> = aquellos cuya facturación en
            el período actual cayó más de un 30% respecto del período inmediato
            anterior de igual duración. Señal de alerta: stock probablemente
            sobrante, posible cambio de gusto del cliente, o competencia. Para
            cada uno: revisar si la receta cambió, si hubo problemas de
            disponibilidad, o si justifica discontinuar.
          </InfoTooltip>
        }
      >
        <TablaSimple
          columnas={[
            { key: 'nombre', label: 'Producto' },
            { key: 'anterior', label: 'Período anterior', align: 'right' },
            { key: 'actual', label: 'Período actual', align: 'right' },
            { key: 'variacion', label: 'Variación', align: 'right' },
          ]}
          filas={data.declinantes.map((d) => ({
            nombre: d.nombre,
            anterior: fmtPesos(d.monto_anterior),
            actual: fmtPesos(d.monto_actual),
            variacion: (
              <span className="text-pomodoro-600 font-medium">{fmtPct(d.variacion_pct)}</span>
            ),
          }))}
          vacioMsg="No hay productos con caída > 30% vs el período inmediato anterior."
        />
      </Card>
    </>
  );
}
