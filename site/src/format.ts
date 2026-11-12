import type { ValueFormat } from './types';

/**
 * Display formatting for results, charts and tables. Values stay in the library's units; only the
 * presentation changes (a decimal rate 0.05 displays as 5.00%). Non-finite values are explained,
 * never shown as NaN or Infinity.
 */
const cache = new Map<string, Intl.NumberFormat>();
function formatter(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let found = cache.get(key);
  if (!found) {
    found = new Intl.NumberFormat('en-US', options);
    cache.set(key, found);
  }
  return found;
}

export function describeNonFinite(value: number): string {
  if (value === Infinity) return 'Unbounded';
  if (value === -Infinity) return 'Unbounded loss';
  return 'Not defined';
}

/** Significant digits that keep small Greeks and large valuations readable. */
function plain(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && magnitude < 0.0001)
    return formatter('scientific', { notation: 'scientific', maximumFractionDigits: 3 }).format(
      value,
    );
  if (magnitude >= 1000)
    return formatter('plain-large', { maximumFractionDigits: 2 }).format(value);
  return formatter('plain', { maximumSignificantDigits: 6, maximumFractionDigits: 6 }).format(
    value,
  );
}

export function formatValue(
  value: number | string | null | undefined,
  format: ValueFormat = 'number',
): string {
  if (value === null || value === undefined) return 'Not defined';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return describeNonFinite(value);
  switch (format) {
    case 'integer':
      return formatter('integer', { maximumFractionDigits: 0 }).format(value);
    case 'currency':
      return Math.abs(value) >= 100000
        ? formatter('currency-large', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 0,
          }).format(value)
        : formatter('currency', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(value);
    case 'decimal-percent':
      return `${formatter('percent', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value * 100)}%`;
    case 'percent':
      return `${formatter('percent', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;
    case 'basis-points':
      return `${formatter('bps', { maximumFractionDigits: 1 }).format(value)} bp`;
    case 'compact':
      return Math.abs(value) >= 10000
        ? formatter('compact', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
        : plain(value);
    case 'date':
      return new Date(value).toISOString().slice(0, 10);
    default:
      return plain(value);
  }
}

/** Short tick labels: compact, few decimals, sized to the axis step. */
export function formatTick(value: number, format: ValueFormat = 'number', step = 0): string {
  if (!Number.isFinite(value)) return '';
  const decimals = step > 0 ? Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9))) : 2;
  switch (format) {
    case 'decimal-percent': {
      const percentDecimals =
        step > 0 ? Math.max(0, Math.min(4, -Math.floor(Math.log10(step * 100) + 1e-9))) : 1;
      return `${(value * 100).toFixed(percentDecimals)}%`;
    }
    case 'percent':
      return `${value.toFixed(Math.min(decimals, 2))}%`;
    case 'currency':
    case 'compact':
    case 'number':
    case 'integer':
    case 'basis-points':
      if (Math.abs(value) >= 10000)
        return formatter('tick-compact', { notation: 'compact', maximumFractionDigits: 1 }).format(
          value,
        );
      return formatter(`tick-${decimals}`, {
        maximumFractionDigits: decimals,
        minimumFractionDigits: 0,
      }).format(value);
    case 'date':
      return new Date(value).toISOString().slice(0, 10);
  }
}

/** Display of a number control's current value next to its slider. */
export function formatControl(value: number, display: string | undefined): string {
  switch (display) {
    case 'decimal-percent':
      return `${formatter('control-percent', { maximumFractionDigits: 3 }).format(value * 100)}%`;
    case 'currency':
      return formatter('control-currency', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(value);
    case 'basis-points':
      return `${value} bp`;
    case 'years':
      return `${value} ${value === 1 ? 'year' : 'years'}`;
    case 'days':
      return `${value} ${value === 1 ? 'day' : 'days'}`;
    case 'integer':
      return formatter('control-integer', { maximumFractionDigits: 0 }).format(value);
    default:
      return formatter('control-number', { maximumFractionDigits: 6 }).format(value);
  }
}
