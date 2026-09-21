/**
 * Option-expiration helpers (dx WS-6.2 / R10) — the dates options traders actually plan around.
 *
 * Weekly expirations are Fridays; monthly (OPEX) is the 3rd Friday; quarterly is the 3rd Friday of
 * Mar/Jun/Sep/Dec. When the Friday is a full market holiday (e.g. Good Friday), the expiration
 * shifts to the preceding business day — derived from the calendar's own holiday data, never
 * hardcoded. Pure: no clock reads; all dates are ISO `YYYY-MM-DD`.
 */

import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isQuantError,
  isoDateToEpochMs,
} from '@totalfinance/core';
import { requireCalendar } from './trading-calendar.js';
import type { Calendar } from '@totalfinance/core';

export type ExpirationKind = 'weekly' | 'monthly' | 'quarterly';

/** EXACT `expirations` range fields (Law 12) — a typo like `fom` must teach, never scan nothing. */
const EXPIRATION_RANGE_KEYS = ['from', 'to', 'kind'] as const;

const DAY_MS = 86_400_000;
const FRIDAY = 5;
const QUARTER_MONTHS = new Set([2, 5, 8, 11]); // Mar, Jun, Sep, Dec (0-based)
const MAX_RANGE_DAYS = 366 * 50; // guard against runaway ranges

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parse a caller-supplied ISO date, keeping the CONTEXT core's parser cannot know: which facade
 * was called and which field held the bad value. Core throws `Invalid ISO date "…"` — true but
 * anonymous, so `expirations(NYSE, { from: '2026-1-1', to: … })` used to read as if the library
 * had no idea where the string came from. Re-thrown with the function prefix, the field name in
 * `context.field`, and the original error preserved on `cause`.
 */
function parseDateField(functionName: string, field: string, value: string): number {
  try {
    return isoDateToEpochMs(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(`${functionName}: ${field} — ${detail}`, {
      code: isQuantError(error) ? error.code : ErrorCode.InputWrongType,
      context: { function: functionName, field, value },
      cause: error,
    });
  }
}

function nthFridayOfMonth(ms: number): number {
  // Rank of this Friday within its month: 1st..5th.
  const dayOfMonth = new Date(ms).getUTCDate();
  return Math.ceil(dayOfMonth / 7);
}

function isExpirationFriday(ms: number, kind: ExpirationKind): boolean {
  if (new Date(ms).getUTCDay() !== FRIDAY) return false;
  if (kind === 'weekly') return true;
  if (nthFridayOfMonth(ms) !== 3) return false;
  return kind === 'monthly' || QUARTER_MONTHS.has(new Date(ms).getUTCMonth());
}

/** Shift an expiration off a full holiday to the preceding business day (data-driven). */
function settle(calendar: Calendar, iso: string): string {
  return calendar.isBusinessDay(iso) ? iso : calendar.previousBusinessDay(iso);
}

/**
 * Option expirations in `[from, to]` (inclusive), holiday-shifted per the calendar. `kind`
 * defaults to `'monthly'` (the classic OPEX dates).
 */
export function expirations(
  calendar: Calendar,
  range: { from: string; to: string; kind?: ExpirationKind },
): string[] {
  const functionName = 'calendars.expirations';
  requireCalendar(functionName, calendar);
  if (
    (range as { kind?: unknown } | null)?.kind !== undefined &&
    typeof (range as { kind?: unknown }).kind !== 'string'
  ) {
    throw new InputError(
      `${functionName}: range.kind must be an expiration-kind string when provided. Received ${(range as { kind?: unknown }).kind === null ? 'null' : typeof (range as { kind?: unknown }).kind}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'kind' } },
    );
  }
  if (
    range === null ||
    typeof range !== 'object' ||
    range.from === undefined ||
    range.to === undefined
  ) {
    throw new InputError(
      `${functionName}: expected { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', kind? }.`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName },
      },
    );
  }
  ensureKnownKeys(functionName, 'range', range, EXPIRATION_RANGE_KEYS);
  const kind = range.kind ?? 'monthly';
  if (kind !== 'weekly' && kind !== 'monthly' && kind !== 'quarterly') {
    throw new InputError(
      `${functionName}: kind must be 'weekly' | 'monthly' | 'quarterly', got "${String(kind)}".`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { kind },
      },
    );
  }
  const fromMs = parseDateField(functionName, 'from', range.from);
  const toMs = parseDateField(functionName, 'to', range.to);
  if (toMs < fromMs) {
    throw new InputError(`${functionName}: to (${range.to}) is before from (${range.from}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { from: range.from, to: range.to },
    });
  }
  if ((toMs - fromMs) / DAY_MS > MAX_RANGE_DAYS) {
    throw new InputError(
      `${functionName}: range exceeds ${MAX_RANGE_DAYS / 366} years — narrow it.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { from: range.from, to: range.to },
      },
    );
  }
  const out: string[] = [];
  // Iterate Fridays only: jump to the first Friday ≥ from, then step by 7 days. The settled
  // (holiday-shifted) date may land before `from` — filter after shifting.
  const fromDow = new Date(fromMs).getUTCDay();
  let ms = fromMs + ((FRIDAY - fromDow + 7) % 7) * DAY_MS;
  for (; ms <= toMs + 6 * DAY_MS; ms += 7 * DAY_MS) {
    if (!isExpirationFriday(ms, kind)) continue;
    const settled = settle(calendar, toIso(ms));
    const settledMs = isoDateToEpochMs(settled);
    if (settledMs >= fromMs && settledMs <= toMs) out.push(settled);
  }
  return out;
}

/**
 * The first expiration strictly after `date` (`kind` defaults to `'weekly'` — the nearest Friday
 * expiry, holiday-shifted).
 */
export function nextExpiry(
  calendar: Calendar,
  date: string,
  kind: ExpirationKind = 'weekly',
): string {
  const functionName = 'calendars.nextExpiry';
  requireCalendar(functionName, calendar);
  const startMs = parseDateField(functionName, 'date', date);
  // Look ahead far enough for the sparsest kind (quarterly ⇒ ≤ ~14 weeks between expiries).
  const horizonDays = kind === 'weekly' ? 21 : kind === 'monthly' ? 60 : 120;
  const found = expirations(calendar, {
    from: toIso(startMs + DAY_MS),
    to: toIso(startMs + horizonDays * DAY_MS),
    kind,
  });
  const next = found.find((d) => isoDateToEpochMs(d) > startMs);
  if (next === undefined) {
    throw new InputError(
      `${functionName}: no ${kind} expiration found within ${horizonDays} days of ${date}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { date, kind },
      },
    );
  }
  return next;
}

/**
 * Trading sessions remaining until an expiry — the days-to-expiry number traders scale
 * volatility with (`√(tradingDays / 252)`), counted on THIS calendar's actual schedule
 * rather than calendar days ÷ 7 × 5.
 *
 * Counts trading sessions in `(from, expiry]`: the `from` date itself is excluded (it is
 * already underway), the expiry date is included when it is a trading day. Same-day expiry
 * → `0`. An `expiry` before `from` is a typed error, never a negative count.
 */
export function tradingDaysToExpiry(calendar: Calendar, from: string, expiry: string): number {
  const functionName = 'calendars.tradingDaysToExpiry';
  requireCalendar(functionName, calendar);
  const fromMs = parseDateField(functionName, 'from', from);
  const expiryMs = parseDateField(functionName, 'expiry', expiry);
  if (expiryMs < fromMs) {
    throw new InputError(
      `${functionName}: expiry ${expiry} is before ${from} — an already-expired contract has no days to expiry.`,
      { code: ErrorCode.InputOutOfRange, context: { from, expiry } },
    );
  }
  return calendar.businessDaysBetween(from, expiry);
}
