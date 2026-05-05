import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface KpiCardProps {
  label: string;
  value: string | number;
  format?: 'money' | 'count';
  hint?: string | React.ReactNode;
  trend?: { pct: number; direction: 'up' | 'down' | 'flat' } | null;
  accent?: 'default' | 'success' | 'warning' | 'danger';
}

export function KpiCard({
  label,
  value,
  format = 'money',
  hint,
  trend,
  accent = 'default',
}: KpiCardProps) {
  const accentClass = {
    default: '',
    success: 'border-l-4 border-basil-600',
    warning: 'border-l-4 border-saffron-600',
    danger: 'border-l-4 border-pomodoro-600',
  }[accent];

  return (
    <div className={cn('card p-5 flex flex-col gap-2 min-w-0', accentClass)}>
      <div className="text-xs text-ink-500 uppercase tracking-wide">{label}</div>
      <div className="min-w-0 overflow-hidden">
        {format === 'money' ? (
          <MoneyAmount
            value={value}
            hero
            className="text-lg text-teresita-900 tabular-nums whitespace-nowrap block"
          />
        ) : (
          <span className="hero-number text-lg text-teresita-900 tabular-nums whitespace-nowrap block">
            {value}
          </span>
        )}
      </div>
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
