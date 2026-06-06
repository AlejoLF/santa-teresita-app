'use client';

import { fmtPesos, fmtFecha } from '@/lib/format';
import { useAutoRefresh } from '@/lib/useAutoRefresh';
import { RefreshIndicator } from './RefreshIndicator';

interface Empleado {
  id: string;
  nombre: string;
  apellido: string | null;
  puesto: string;
  sueldo: string | null;
  forma: string | null;
  telefono: string | null;
  ingreso: string | null;
  activo: boolean;
}

const PUESTO_LABEL: Record<string, string> = {
  COCINERO: 'Cocina',
  CAJERO: 'Caja',
  REPARTIDOR: 'Reparto',
  ENCARGADO: 'Encargado',
  MOZO: 'Salón',
  AYUDANTE: 'Ayudante',
  OTRO: 'Otro',
};

export function TabEmpleados() {
  const { data, error, loading, refreshing, lastUpdated, refetch } = useAutoRefresh<{
    empleados: Empleado[];
  }>(async () => {
    const r = await fetch('/api/empleados');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { empleados: Empleado[] };
  });

  if (error && !data) {
    return (
      <div className="p-4">
        <div className="bg-pomodoro-100 border-l-4 border-pomodoro-600 p-2 rounded-r text-xs text-pomodoro-600">
          ⚠ {error}
        </div>
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div className="p-4 space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-cream-200 animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const activos = data.empleados.filter((e) => e.activo);
  const inactivos = data.empleados.filter((e) => !e.activo);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-md text-ink-900">
          Equipo · {activos.length} activo{activos.length === 1 ? '' : 's'}
        </h2>
        <RefreshIndicator lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refetch} />
      </div>

      {data.empleados.length === 0 && (
        <p className="text-sm text-ink-500 italic text-center py-8">Sin empleados cargados.</p>
      )}

      <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
        {activos.map((e) => (
          <Card key={e.id} e={e} />
        ))}
      </div>

      {inactivos.length > 0 && (
        <>
          <h3 className="font-display text-sm text-ink-500 mt-2">Inactivos</h3>
          <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2 opacity-60">
            {inactivos.map((e) => (
              <Card key={e.id} e={e} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Card({ e }: { e: Empleado }) {
  return (
    <div className="bg-white rounded-md border border-cream-300 p-3 flex justify-between items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink-900 truncate">
          {e.nombre}
          {e.apellido ? ` ${e.apellido}` : ''}
        </p>
        <p className="text-2xs text-ink-500">
          {PUESTO_LABEL[e.puesto] ?? e.puesto}
          {e.forma ? ` · ${e.forma}` : ''}
          {e.ingreso ? ` · desde ${fmtFecha(e.ingreso)}` : ''}
        </p>
      </div>
      {e.sueldo && (
        <p className="text-sm font-mono text-teresita-700 whitespace-nowrap">{fmtPesos(e.sueldo)}</p>
      )}
    </div>
  );
}
