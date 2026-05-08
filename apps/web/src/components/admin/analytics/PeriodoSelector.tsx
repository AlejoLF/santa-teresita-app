'use client';

export type Periodo = 'hoy' | 'semana' | 'mes' | 'trimestre' | 'anio' | 'custom';

const PERIODOS: Array<{ key: Periodo; label: string }> = [
  { key: 'hoy', label: 'Hoy' },
  { key: 'semana', label: '7 días' },
  { key: 'mes', label: '30 días' },
  { key: 'trimestre', label: '90 días' },
  { key: 'anio', label: '1 año' },
];

export function PeriodoSelector({
  periodo,
  onChange,
  desde,
  hasta,
  onDesde,
  onHasta,
}: {
  periodo: Periodo;
  onChange: (p: Periodo) => void;
  desde: string;
  hasta: string;
  onDesde: (s: string) => void;
  onHasta: (s: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {PERIODOS.map((p) => (
        <button
          key={p.key}
          onClick={() => onChange(p.key)}
          className={
            periodo === p.key
              ? 'px-3 py-1.5 rounded-md bg-teresita-700 text-cream-50 text-sm font-medium'
              : 'px-3 py-1.5 rounded-md bg-cream-200 text-ink-700 text-sm hover:bg-cream-300'
          }
        >
          {p.label}
        </button>
      ))}
      <button
        onClick={() => onChange('custom')}
        className={
          periodo === 'custom'
            ? 'px-3 py-1.5 rounded-md bg-teresita-700 text-cream-50 text-sm font-medium'
            : 'px-3 py-1.5 rounded-md bg-cream-200 text-ink-700 text-sm hover:bg-cream-300'
        }
      >
        Custom
      </button>
      {periodo === 'custom' && (
        <div className="flex items-center gap-2 ml-2">
          <input
            type="date"
            value={desde}
            onChange={(e) => onDesde(e.target.value)}
            className="px-2 py-1 rounded border border-cream-300 text-sm bg-white"
          />
          <span className="text-ink-500 text-sm">a</span>
          <input
            type="date"
            value={hasta}
            onChange={(e) => onHasta(e.target.value)}
            className="px-2 py-1 rounded border border-cream-300 text-sm bg-white"
          />
        </div>
      )}
    </div>
  );
}
