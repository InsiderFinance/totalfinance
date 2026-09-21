/** Numeric policy and small helpers (spec §7.1). Public analytics use IEEE-754 `number`. */

import { ErrorCode, InputError } from './errors.js';
import { ensureKnownKeys } from './invariants.js';

/** True only for a real, finite number (rejects `NaN`, `Infinity`, and non-numbers). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

export function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export interface BetweenOptions {
  /** Include the bounds (default `true`). */
  inclusive?: boolean;
}

/**
 * Range predicate. Replaces wrapped-number DSLs (design law #2): use
 * `between(Math.abs(delta), 0.25, 0.35)` rather than `delta.abs().between(...)`.
 */
export function between(
  value: number,
  min: number,
  max: number,
  options: BetweenOptions = {},
): boolean {
  // Positional front door: between(NaN, 0, 1) used to answer false as if it had CHECKED.
  for (const [name, v] of [
    ['value', value],
    ['min', min],
    ['max', max],
  ] as const) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new InputError(
        `between: ${name} must be a number — between(0.5, 0, 1). Received ${v === null ? 'null' : v === undefined ? 'undefined' : typeof v === 'number' ? String(v) : typeof v}.`,
        { code: ErrorCode.InputWrongType, context: { field: name } },
      );
    }
  }
  ensureKnownKeys('between', 'options', options, ['inclusive']);
  if (options.inclusive !== undefined && typeof options.inclusive !== 'boolean') {
    throw new InputError(
      `between: inclusive must be a boolean when provided. Received ${options.inclusive === null ? 'null' : typeof options.inclusive}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'inclusive' } },
    );
  }
  const inclusive = options.inclusive ?? true;
  return inclusive ? value >= min && value <= max : value > min && value < max;
}

/** Clamp `value` into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Round half-away-from-zero to `decimals` places, robust to floating-point representation.
 *
 * Total over the double domain: `decimals` must be an integer in [-323, 323] (10^±323 spans the
 * whole representable grid — beyond it nothing survives double precision), and the extremes are
 * exact identities rather than overflow artifacts: an integer input with `decimals >= 0` is
 * returned unchanged (so `round(1e16, 0)` is 1e16, not 1e16+2, and `round(Number.MAX_VALUE, 2)`
 * is MAX_VALUE, not Infinity), and when the requested grid is coarser than the value's own ulp the
 * value is already its rounded self.
 */
export function round(value: number, decimals = 0): number {
  if (!Number.isInteger(decimals) || decimals < -323 || decimals > 323) {
    throw new InputError(
      `round: decimals must be an integer in [-323, 323] (the double-precision grid). Received ${String(decimals)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'decimals', value: decimals } },
    );
  }
  if (!Number.isFinite(value)) return value;
  // An integer is a fixed point of rounding to >= 0 decimals. This also sidesteps two failure
  // modes of scale-and-round: the epsilon nudge corrupting integers at/near 2^53 (where one ulp
  // is a whole unit), and MAX_VALUE * (1 + ε) overflowing to Infinity.
  if (decimals >= 0 && Number.isInteger(value)) return value;
  const factor = 10 ** decimals;
  // The epsilon nudge corrects cases like round(1.005, 2) where the stored double sits a hair
  // below the true half. It must scale WITH the value (relative, not absolute) so portfolio-sized
  // numbers like round(1234567.005, 2) get the same correction as values near 1.
  // Multiplying by (1 + ε) grows the MAGNITUDE for either sign (more positive / more negative),
  // which is what half-away-from-zero needs on both sides of the axis.
  let nudged = value * (1 + Number.EPSILON);
  if (!Number.isFinite(nudged)) nudged = value; // the nudge overflowed — fall back to un-nudged
  const scaled = nudged * factor;
  // Scaled past 2^53 — or clean over/underflow, which `10 ** ±309…323` reaches on its own — means
  // every double in reach is already an integer on the requested grid, so rounding is the
  // identity: return the EXACT input rather than a round-tripped approximation.
  if (!Number.isFinite(scaled) || Math.abs(scaled) >= 2 ** 53) return value;
  return Math.round(scaled) / factor;
}

/** `toFixed` that never throws on non-finite input and never returns `"NaN"` silently. */
export function toFixedSafe(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'NaN' : value > 0 ? '∞' : '-∞';
  return value.toFixed(decimals);
}

export interface FormatMoneyOptions {
  currency?: string;
  locale?: string;
  decimals?: number;
}

/** Format a number as currency using the platform `Intl` (browser-safe). */
export function formatMoney(value: number, options: FormatMoneyOptions = {}): string {
  // A formatter fed garbage must teach, never render "$NaN" into a report.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `formatMoney: value must be a finite number — formatMoney(1234.5). Received ${value === null ? 'null' : value === undefined ? 'undefined' : typeof value === 'number' ? String(value) : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'value' } },
    );
  }
  ensureKnownKeys('formatMoney', 'options', options, ['currency', 'locale', 'decimals']);
  for (const field of ['currency', 'locale'] as const) {
    const v = options[field];
    if (v !== undefined && typeof v !== 'string') {
      throw new InputError(
        `formatMoney: ${field} must be a string when provided. Received ${v === null ? 'null' : typeof v}.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
  if (
    options.decimals !== undefined &&
    (typeof options.decimals !== 'number' || !Number.isFinite(options.decimals))
  ) {
    throw new InputError(
      `formatMoney: decimals must be a finite number when provided. Received ${options.decimals === null ? 'null' : typeof options.decimals}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'decimals' } },
    );
  }
  const currency = options.currency ?? 'USD';
  const locale = options.locale ?? 'en-US';
  const fmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    ...(options.decimals !== undefined
      ? { minimumFractionDigits: options.decimals, maximumFractionDigits: options.decimals }
      : {}),
  });
  return fmt.format(value);
}

export interface FormatPercentOptions {
  /** Fraction digits (default `2`). */
  decimals?: number;
  /** If `true`, the input is already a percentage (e.g. `22`) rather than a fraction (`0.22`). */
  asPercentagePoints?: boolean;
  locale?: string;
}

/** Format a fraction (`0.22`) as a percent string (`"22.00%"`). */
export function formatPercent(value: number, options: FormatPercentOptions = {}): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `formatPercent: value must be a finite number — formatPercent(0.0425). Received ${value === null ? 'null' : value === undefined ? 'undefined' : typeof value === 'number' ? String(value) : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'value' } },
    );
  }
  ensureKnownKeys('formatPercent', 'options', options, [
    'decimals',
    'asPercentagePoints',
    'locale',
  ]);
  if (
    options.decimals !== undefined &&
    (typeof options.decimals !== 'number' || !Number.isFinite(options.decimals))
  ) {
    throw new InputError(
      `formatPercent: decimals must be a finite number when provided. Received ${options.decimals === null ? 'null' : typeof options.decimals}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'decimals' } },
    );
  }
  if (options.locale !== undefined && typeof options.locale !== 'string') {
    throw new InputError(
      `formatPercent: locale must be a string when provided. Received ${options.locale === null ? 'null' : typeof options.locale}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'locale' } },
    );
  }
  if (options.asPercentagePoints !== undefined && typeof options.asPercentagePoints !== 'boolean') {
    throw new InputError(
      `formatPercent: asPercentagePoints must be a boolean when provided — a truthy string must never rescale the value. Received ${options.asPercentagePoints === null ? 'null' : typeof options.asPercentagePoints}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'asPercentagePoints' } },
    );
  }
  const decimals = options.decimals ?? 2;
  const locale = options.locale ?? 'en-US';
  const fraction = options.asPercentagePoints ? value / 100 : value;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(fraction);
}
