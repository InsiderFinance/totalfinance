/**
 * Multi-expiry option strategies (spec §12, app OPC parity): calendars, diagonals, and the double
 * diagonal. Each leg carries its own `expiry`, so the position must be valued with `Position.value()`
 * (which prices every leg at its own time-to-expiry) — typically **at the near expiry**, where the
 * short leg expires to intrinsic while the long leg still carries time value. The static expiration
 * `metrics()`/payoff assumes a single terminal and is NOT meaningful for these; use `value()` /
 * `scenarioTable()` at the near-expiry date instead.
 *
 * Every structure is short the near-dated leg and long the far-dated leg, mirroring the app OPC.
 *
 * Validation (R4): every builder requires its per-shape slots — a missing `nearExpiry`/`farExpiry`
 * would otherwise silently build a degenerate flat "calendar" (both legs sharing one expiry, or
 * none) with nonsense metrics. A bare `expiry` key (the single-expiry builders' spelling) is
 * REJECTED with a teaching error naming the per-side fields, and `nearExpiry` must resolve to a
 * time strictly before `farExpiry`.
 */

import { ErrorCode, InputError, optionExpiryToMs } from '@totalfinance/core';
import { legs } from './legs.js';
import { Position } from './position.js';
import type { LegInput, PositionConfig } from './types.js';
import type { UnitInput } from './strategies.js';
import { rejectRetiredKey, validateSlots } from './validate.js';

const units = (o: UnitInput): number => o.quantity ?? 1;
const build = (ls: LegInput[], config?: PositionConfig): Position => new Position(ls, config);

/**
 * Validate the two expiries of a multi-expiry builder: reject the single-expiry `expiry` spelling
 * (teaching the per-side fields), require both to parse, and require `nearExpiry` strictly before
 * `farExpiry` — equal or inverted expiries would silently build a structure that is not "short the
 * near leg, long the far leg" (a same-expiry "calendar" is a guaranteed-loss flat position).
 */
function validateExpiries(
  i: { nearExpiry: string; farExpiry: string },
  functionName: string,
): void {
  rejectRetiredKey(
    i,
    'expiry',
    functionName,
    'this structure spans two expiries — use nearExpiry/farExpiry, not expiry.',
  );
  const near = optionExpiryToMs(i.nearExpiry);
  const far = optionExpiryToMs(i.farExpiry);
  if (near >= far) {
    throw new InputError(
      `${functionName}: nearExpiry must be strictly before farExpiry (the structure is short the near leg, ` +
        `long the far leg), got nearExpiry=${i.nearExpiry}, farExpiry=${i.farExpiry}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { nearExpiry: i.nearExpiry, farExpiry: i.farExpiry },
      },
    );
  }
}

const CALENDAR_SHAPE = '{ strike, nearExpiry, farExpiry, shortPremium?, longPremium?, quantity? }';
const DIAGONAL_SHAPE =
  '{ shortStrike, nearExpiry, longStrike, farExpiry, shortPremium?, longPremium?, quantity? }';
const SIDE_SHAPE = '{ shortStrike, longStrike, shortPremium?, longPremium? }';
const DOUBLE_DIAGONAL_SHAPE = `{ nearExpiry, farExpiry, call: ${SIDE_SHAPE}, put: ${SIDE_SHAPE}, quantity? }`;

/**
 * A calendar (horizontal) spread: same strike, short near leg + long far leg. Multi-expiry by
 * construction, so there is deliberately NO single `expiry` field — the per-side
 * `nearExpiry`/`farExpiry` are the only spelling (a bare `expiry` throws a teaching error).
 */
export interface CalendarInput extends Omit<UnitInput, 'expiry'> {
  strike: number;
  /** Near expiry of the short leg (`YYYY-MM-DD` → 16:00 ET, or a datetime). */
  nearExpiry: string;
  /** Premium received on the short near leg. */
  shortPremium?: number;
  /** Far expiry of the long leg. */
  farExpiry: string;
  /** Premium paid on the long far leg. */
  longPremium?: number;
}

export const calendarCallSpread = (i: CalendarInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.calendarCallSpread';
  validateSlots(i, ['strike', 'nearExpiry', 'farExpiry'], functionName, CALENDAR_SHAPE);
  validateExpiries(i, functionName);
  const n = units(i);
  return build(
    [
      legs.call({
        strike: i.strike,
        premium: i.shortPremium,
        quantity: -n,
        expiry: i.nearExpiry,
      }),
      legs.call({ strike: i.strike, premium: i.longPremium, quantity: n, expiry: i.farExpiry }),
    ],
    c,
  );
};

export const calendarPutSpread = (i: CalendarInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.calendarPutSpread';
  validateSlots(i, ['strike', 'nearExpiry', 'farExpiry'], functionName, CALENDAR_SHAPE);
  validateExpiries(i, functionName);
  const n = units(i);
  return build(
    [
      legs.put({
        strike: i.strike,
        premium: i.shortPremium,
        quantity: -n,
        expiry: i.nearExpiry,
      }),
      legs.put({ strike: i.strike, premium: i.longPremium, quantity: n, expiry: i.farExpiry }),
    ],
    c,
  );
};

/**
 * A diagonal spread: short near leg and long far leg at different strikes. No single `expiry`
 * field exists (see {@link CalendarInput}); either strike ordering is valid.
 */
export interface DiagonalInput extends Omit<UnitInput, 'expiry'> {
  shortStrike: number;
  shortPremium?: number;
  nearExpiry: string;
  longStrike: number;
  longPremium?: number;
  farExpiry: string;
}

export const diagonalCallSpread = (i: DiagonalInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.diagonalCallSpread';
  validateSlots(
    i,
    ['shortStrike', 'longStrike', 'nearExpiry', 'farExpiry'],
    functionName,
    DIAGONAL_SHAPE,
  );
  validateExpiries(i, functionName);
  const n = units(i);
  return build(
    [
      legs.call({
        strike: i.shortStrike,
        premium: i.shortPremium,
        quantity: -n,
        expiry: i.nearExpiry,
      }),
      legs.call({
        strike: i.longStrike,
        premium: i.longPremium,
        quantity: n,
        expiry: i.farExpiry,
      }),
    ],
    c,
  );
};

export const diagonalPutSpread = (i: DiagonalInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.diagonalPutSpread';
  validateSlots(
    i,
    ['shortStrike', 'longStrike', 'nearExpiry', 'farExpiry'],
    functionName,
    DIAGONAL_SHAPE,
  );
  validateExpiries(i, functionName);
  const n = units(i);
  return build(
    [
      legs.put({
        strike: i.shortStrike,
        premium: i.shortPremium,
        quantity: -n,
        expiry: i.nearExpiry,
      }),
      legs.put({
        strike: i.longStrike,
        premium: i.longPremium,
        quantity: n,
        expiry: i.farExpiry,
      }),
    ],
    c,
  );
};

/** One diagonal side (call or put): short near strike + long far strike. */
export interface DoubleDiagonalSide {
  shortStrike: number;
  shortPremium?: number;
  longStrike: number;
  longPremium?: number;
}

/**
 * Double diagonal: a short near-dated strangle financing a long far-dated strangle. No single
 * `expiry` field exists (see {@link CalendarInput}).
 */
export interface DoubleDiagonalInput extends Omit<UnitInput, 'expiry'> {
  nearExpiry: string;
  farExpiry: string;
  call: DoubleDiagonalSide;
  put: DoubleDiagonalSide;
}

export const doubleDiagonal = (i: DoubleDiagonalInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.doubleDiagonal';
  validateSlots(i, ['nearExpiry', 'farExpiry', 'call', 'put'], functionName, DOUBLE_DIAGONAL_SHAPE);
  validateExpiries(i, functionName);
  validateSlots(i.call, ['shortStrike', 'longStrike'], functionName, `call: ${SIDE_SHAPE}`);
  validateSlots(i.put, ['shortStrike', 'longStrike'], functionName, `put: ${SIDE_SHAPE}`);
  const n = units(i);
  return build(
    [
      legs.call({
        strike: i.call.longStrike,
        premium: i.call.longPremium,
        quantity: n,
        expiry: i.farExpiry,
      }),
      legs.call({
        strike: i.call.shortStrike,
        premium: i.call.shortPremium,
        quantity: -n,
        expiry: i.nearExpiry,
      }),
      legs.put({
        strike: i.put.longStrike,
        premium: i.put.longPremium,
        quantity: n,
        expiry: i.farExpiry,
      }),
      legs.put({
        strike: i.put.shortStrike,
        premium: i.put.shortPremium,
        quantity: -n,
        expiry: i.nearExpiry,
      }),
    ],
    c,
  );
};
