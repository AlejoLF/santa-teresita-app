import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { FitText } from '@/components/ui/FitText';
import { cn } from '@/lib/cn';

interface KpiCardProps {
  label: string;
  value: string | number;
  format?: 'money' | 'count';
  hint?: string | React.ReactNode;
  trend?: { pct: number; direction: 'up' | 'down' | 'flat' } | null;
  accent?: 'default' | 'success' | 'warning' | 'danger';
  /** Si se pasa, la tarjeta es clickeable (abre el detalle de ese recuadro). */
  onClick?: () => void;
}

export function KpiCard({
  label,
  value,
  format = 'money',
  hint,
  trend,
  accent = 'default',
  onClick,
}: KpiCardProps) {
  const accentClass = {
    default: '',
    success: 'border-l-4 border-basil-600',
    warning: 'border-l-4 border-saffron-600',
    danger: 'border-l-4 border-pomodoro-600',
  }[accent];

  return (
    <div
      className={cn(
        'card p-5 flex flex-col gap-2 min-w-0',
        accentClass,
        onClick && 'cursor-pointer hover:shadow-md hover:ring-1 hover:ring-teresita-700/20 transition-all',
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      <div className="text-xs text-ink-500 uppercase tracking-wide">{label}</div>
      {/* Auto-encoge en vez de recortar: antes el número se clippeaba (escondía
          dígitos) en las grillas angostas (xl:grid-cols-5). Ahora siempre entra. */}
      {format === 'money' ? (
        <MoneyAmount value={value} hero fit className="text-lg text-teresita-900 tabular-nums" />
      ) : (
        <FitText className="hero-number text-lg text-teresita-900 tabular-nums">{value}</FitText>
      )}
      {trend && (
        <div
          className={cn(
            'text-xs font-mono',
            trend.direction === 'up' && 'text-basil-600',
            trend.direction === 'down' && 'text-pomodoro-600',
            trend.direction === 'flat' && 'text-ink-500',
          )}
        >
          {trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'}{' '}
          {Math.abs(trend.pct).toFixed(1)}% vs ayer
        </div>
      )}
      {hint && <div className="text-xs text-ink-500 border-t border-cream-200 pt-2">{hint}</div>}
    </div>
  );
}
