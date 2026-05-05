'use client';

import { cn } from '@/lib/cn';

interface PinInputProps {
  value: string;
  length?: number;
  obscured?: boolean;
  hasError?: boolean;
  className?: string;
}

/**
 * Display de PIN. NO es input — solo muestra los dígitos ingresados via Numpad.
 * Optimizado para Wireframe 01: 4 círculos con bordes verdes que se "llenan"
 * cuando se ingresa el dígito.
 */
export function PinInput({
  value,
  length = 4,
  obscured = true,
  hasError = false,
  className,
}: PinInputProps) {
  const slots = Array.from({ length }, (_, i) => value[i] ?? '');
  return (
    <div className={cn('flex gap-3 items-center justify-center', className)}>
      {slots.map((digit, i) => (
        <div
          key={i}
          className={cn(
            'relative h-16 w-14 rounded-lg border-2 transition-all duration-fast',
            digit
              ? hasError
                ? 'border-pomodoro-600 bg-pomodoro-100'
                : 'border-teresita-700 bg-teresita-50'
              : 'border-cream-300 bg-white',
          )}
          aria-label={digit ? `Dígito ${i + 1} ingresado` : `Dígito ${i + 1} pendiente`}
        >
          <div className="flex h-full w-full items-center justify-center">
            {digit && (
              <span
                className={cn(
                  'text-2xl font-mono font-semibold',
                  hasError ? 'text-pomodoro-600' : 'text-teresita-900',
                )}
              >
                {obscured ? '•' : digit}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
