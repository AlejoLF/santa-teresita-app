import { formatARS, formatARSDecimal } from '@sta/shared';
import { cn } from '@/lib/cn';

interface MoneyAmountProps {
  value: number | string | bigint;
  withDecimals?: boolean;
  className?: string;
  hero?: boolean;
}

export function MoneyAmount({
  value,
  withDecimals = false,
  className,
  hero = false,
}: MoneyAmountProps) {
  const formatted = withDecimals ? formatARSDecimal(value) : formatARS(value);
  return (
    <span className={cn(hero ? 'hero-number' : 'font-mono num', className)}>{formatted}</span>
  );
}
