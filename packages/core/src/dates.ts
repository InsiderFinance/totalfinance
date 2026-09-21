/**
 * Date, day-count, and compounding helpers (spec §7.2, §7.4).
 *
 * These operate on explicit inputs only — ISO date strings or epoch milliseconds — and never read
 * the system clock (design law #5). 30/360 needs calendar components, so date-based day counts
 * accept either an ISO date or an epoch (converted via UTC).
 */

import { ErrorCode, InputError } from './errors.js';
import type { InterestCompounding, DayCount, EpochMs } from './time.js';

const MS_PER_DAY = 86_400_000;

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** Parse an ISO `YYYY-MM-DD` date into calendar components, validating it is a real date. */
export function parseIsoDate(value: string): CalendarDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    throw new InputError(`parseIsoDate: Invalid ISO date "${value}" (expected YYYY-MM-DD).`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'date', value },
    });
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Probe via setUTCFullYear, NOT `new Date(Date.UTC(...))`: Date.UTC remaps years 0–99 to
  // 1900–1999 (the legacy two-digit convention), which made every 0000–0099 date — leap or not —
  // misreport as "not a valid calendar date".
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new InputError(`parseIsoDate: "${value}" is not a valid calendar date.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'date', value },
    });
  }
  return { year, month, day };
}

/** Convert an ISO `YYYY-MM-DD` date to epoch milliseconds at UTC midnight. */
export function isoDateToEpochMs(value: string): EpochMs {
  const { year, month, day } = parseIsoDate(value);
  // Same two-digit-year hazard as the parse probe: build the epoch with the literal year.
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getTime();
}

function toCalendarDate(input: string | EpochMs): CalendarDate {
  if (typeof input === 'string') return parseIsoDate(input);
  const d = new Date(input);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function toMs(input: string | EpochMs): EpochMs {
  return typeof input === 'string' ? isoDateToEpochMs(input) : input;
}

/**
 * Year fraction between two dates under a day-count convention.
 *
 * - `ACT/365F` and `ACT/360` use actual elapsed days.
 * - `30/360` uses the US (NASD) bond-basis adjustment on calendar components.
 */
export function yearFraction(
  from: string | EpochMs,
  to: string | EpochMs,
  dayCount: DayCount = 'ACT/365F',
): number {
  if (dayCount === '30/360') {
    const a = toCalendarDate(from);
    const b = toCalendarDate(to);
    let d1 = a.day;
    let d2 = b.day;
    if (d1 === 31) d1 = 30;
    if (d2 === 31 && d1 === 30) d2 = 30;
    return (360 * (b.year - a.year) + 30 * (b.month - a.month) + (d2 - d1)) / 360;
  }
  const days = (toMs(to) - toMs(from)) / MS_PER_DAY;
  return dayCount === 'ACT/360' ? days / 360 : days / 365;
}

/** Periods per year for a discrete convention; `null` for the two non-discrete forms. */
export function compoundingPeriodsPerYear(compounding: InterestCompounding): number | null {
  if (typeof compounding === 'object') {
    if (!Number.isFinite(compounding.periodsPerYear) || compounding.periodsPerYear <= 0) {
      throw new InputError(
        `compounding.periodsPerYear must be a finite number > 0. Received ${String(compounding.periodsPerYear)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'periodsPerYear' } },
      );
    }
    return compounding.periodsPerYear;
  }
  switch (compounding) {
    case 'continuous':
    case 'simple':
      return null;
    case 'annual':
      return 1;
    case 'semiannual':
      return 2;
    case 'quarterly':
      return 4;
    case 'monthly':
      return 12;
    default:
      throw new InputError(
        `compoundingPeriodsPerYear: Unknown compounding "${String(compounding)}".`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { field: 'compounding', value: compounding },
        },
      );
  }
}

/** A periodic rate at or below −100% has no real growth factor: `(1 + r/m) ≤ 0` (FC0 domain law). */
function requirePeriodicRateAboveFloor(annualRate: number, periodsPerYear: number): void {
  if (annualRate / periodsPerYear <= -1) {
    throw new InputError(
      `requirePeriodicRateAboveFloor: annualRate ${annualRate} is at or below −100% per period for periodsPerYear ${periodsPerYear} — the growth factor (1 + r/m) is not positive.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'annualRate', value: annualRate } },
    );
  }
}

/** Discount factor for `rate` over `years` under any {@link InterestCompounding} form. */
export function discountFactor(
  annualRate: number,
  years: number,
  compounding: InterestCompounding = 'continuous',
): number {
  const periods = compoundingPeriodsPerYear(compounding);
  if (periods === null) {
    return compounding === 'simple' ? 1 / (1 + annualRate * years) : Math.exp(-annualRate * years);
  }
  requirePeriodicRateAboveFloor(annualRate, periods);
  return Math.pow(1 + annualRate / periods, -periods * years);
}

/** Compound (growth) factor for `rate` over `years` under any {@link InterestCompounding} form. */
export function compoundFactor(
  annualRate: number,
  years: number,
  compounding: InterestCompounding = 'continuous',
): number {
  const periods = compoundingPeriodsPerYear(compounding);
  if (periods === null) {
    return compounding === 'simple' ? 1 + annualRate * years : Math.exp(annualRate * years);
  }
  requirePeriodicRateAboveFloor(annualRate, periods);
  return Math.pow(1 + annualRate / periods, periods * years);
}
