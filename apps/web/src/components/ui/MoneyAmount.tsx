import { formatARS, formatARSDecimal } from '@sta/shared';
import { cn } from '@/lib/cn';
import { FitText } from './FitText';

interface MoneyAmountProps {
  value: number | string | bigint;
  withDecimals?: boolean;
  className?: string;
  hero?: boolean;
  /**
   * Auto-encoge el número para que entre en su caja (ver FitText). Usalo en
   * montos grandes y visibles dentro de tarjetas/KPIs angostos — sobre todo en
   * mobile, donde un total largo se desbordaba del recuadro.
   */
  fit?: boolean;
  /** Alineación cuando fit está activo (default: left). */
  align?: 'left' | 'right' | 'center';
}

export function MoneyAmount({
  value,
  withDecimals = false,
  className,
  hero = false,
  fit = false,
  align,
}: MoneyAmountProps) {
  const formatted = withDecimals ? formatARSDecimal(value) : formatARS(value);
  const classes = cn(hero ? 'hero-number' : 'font-mono num', className);
  if (fit) {
    return (
      <FitText className={classes} align={align}>
        {formatted}
      </FitText>
    );
  }
  return <span className={classes}>{formatted}</span>;
}
