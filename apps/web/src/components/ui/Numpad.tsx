'use client';

import { useEffect, useCallback } from 'react';
import { cn } from '@/lib/cn';

interface NumpadProps {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onClear?: () => void;
  onSubmit?: () => void;
  disabled?: boolean;
  className?: string;
  showSubmit?: boolean;
  submitLabel?: string;
}

/**
 * Numpad táctil 3×4 con bindings de teclado físico.
 * Usado en login (PIN), cobro (efectivo recibido), aprobación in-line.
 */
export function Numpad({
  onDigit,
  onBackspace,
  onClear,
  onSubmit,
  disabled,
  className,
  showSubmit = false,
  submitLabel = 'OK',
}: NumpadProps) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        onDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        onBackspace();
      } else if (e.key === 'Enter' && onSubmit) {
        e.preventDefault();
        onSubmit();
      } else if ((e.key === 'Escape' || e.key === 'Delete') && onClear) {
        e.preventDefault();
        onClear();
      }
    },
    [disabled, onDigit, onBackspace, onSubmit, onClear],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const buttons: Array<{ label: string; onClick: () => void; variant?: 'digit' | 'action' }> = [
    { label: '1', onClick: () => onDigit('1') },
    { label: '2', onClick: () => onDigit('2') },
    { label: '3', onClick: () => onDigit('3') },
    { label: '4', onClick: () => onDigit('4') },
    { label: '5', onClick: () => onDigit('5') },
    { label: '6', onClick: () => onDigit('6') },
    { label: '7', onClick: () => onDigit('7') },
    { label: '8', onClick: () => onDigit('8') },
    { label: '9', onClick: () => onDigit('9') },
    { label: 'C', onClick: onClear ?? (() => {}), variant: 'action' },
    { label: '0', onClick: () => onDigit('0') },
    { label: '⌫', onClick: onBackspace, variant: 'action' },
  ];

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="grid grid-cols-3 gap-2">
        {buttons.map((b, i) => (
          <button
            key={i}
            type="button"
            disabled={disabled}
            onClick={b.onClick}
            className={cn(
              'h-16 rounded-lg text-2xl font-medium transition-colors duration-instant ease-out',
              'disabled:cursor-not-allowed disabled:opacity-50',
              b.variant === 'action'
                ? 'bg-cream-200 text-ink-700 hover:bg-cream-300 active:bg-cream-300'
                : 'bg-white text-ink-900 shadow-sm border border-cream-300 hover:bg-cream-50 active:bg-cream-100',
            )}
            aria-label={b.label === '⌫' ? 'Borrar' : b.label === 'C' ? 'Limpiar' : `Tecla ${b.label}`}
          >
            {b.label}
          </button>
        ))}
      </div>
      {showSubmit && onSubmit && (
        <button
          type="button"
          disabled={disabled}
          onClick={onSubmit}
          className="btn btn-primary text-lg py-4 mt-1"
        >
          {submitLabel}
        </button>
      )}
    </div>
  );
}
