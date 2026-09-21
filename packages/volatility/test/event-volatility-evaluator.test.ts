/**
 * Stage 4.5 slice 2 — `eventVolatilityAtExpiry`, the forward door of `calibrateEventVolatility`:
 * one engine (the calibrator's own `perExpiry.fittedVolatility` is reproduced exactly at the fitted
 * expiries), honest forward evaluation at unfitted expiries (before and after the event), the fit's
 * `assumptions.asOf` as the maturity origin, and teaching refusals for malformed fits and expiries.
 */

import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  isQuantError,
  optionExpiryToMs,
  yearFraction,
  resolveAsOf,
} from '@totalfinance/core';
import {
  calibrateEventVolatility,
  eventVolatilityAtExpiry,
  type AtmVolatilityPoint,
} from '@totalfinance/volatility';

const ASOF = '2026-05-01T00:00:00Z'; // a valuation instant names its time of day
const EVENT = '2026-05-11';

function synthTerm(
  baseVolatility: number,
  eventMove: number,
  expiries: readonly string[],
): AtmVolatilityPoint[] {
  const asOfMs = resolveAsOf(ASOF);
  const eventMs = optionExpiryToMs(EVENT);
  return expiries.map((expiry) => {
    const t = yearFraction(asOfMs, optionExpiryToMs(expiry), 'ACT/365F');
    const spans = optionExpiryToMs(expiry) >= eventMs;
    const v = baseVolatility * baseVolatility * t + (spans ? eventMove * eventMove : 0);
    return { expiry, atmVolatility: Math.sqrt(v / t) };
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

const term = synthTerm(0.3, 0.05, ['2026-05-08', '2026-05-15', '2026-05-31', '2026-06-30']);
const fit = calibrateEventVolatility({ termStructure: term, eventDate: EVENT, asOf: ASOF });

describe('eventVolatilityAtExpiry', () => {
  it('carries asOf in the fit and reproduces the calibrator’s fitted volatilities at the fitted expiries', () => {
    expect(fit.assumptions.asOf).toBe(resolveAsOf(ASOF));
    const evaluated = eventVolatilityAtExpiry({
      fit,
      expiries: fit.perExpiry.map((row) => row.expiry),
    });
    evaluated.rows.forEach((row, index) => {
      const fitted = fit.perExpiry[index]!;
      expect(row.value).toBe(fitted.fittedVolatility);
      expect(row.timeToExpiryYears).toBe(fitted.timeToExpiryYears);
      expect(row.daysToExpiry).toBe(fitted.daysToExpiry);
      expect(row.spansEvent).toBe(fitted.spansEvent);
    });
    expect(evaluated.values).toEqual(evaluated.rows.map((row) => row.value));
    expect(fit.baseVariance).toBeCloseTo(0.09, 8);
    expect(evaluated.assumptions).toMatchObject({
      method: 'additive-event-variance',
      eventDate: EVENT,
      asOf: fit.assumptions.asOf,
      baseVolatility: fit.baseVolatility,
      eventMove: fit.eventMove,
    });
    expect(evaluated.diagnostics.warnings).toEqual([]);
  });

  it('evaluates unfitted expiries: no jump before the event, the jump after, converging to σ_base far out', () => {
    const evaluated = eventVolatilityAtExpiry({
      fit,
      expiries: ['2026-05-05', '2026-05-12', '2028-05-01'],
    });
    const [before, after, far] = evaluated.values as [number, number, number];
    expect(evaluated.rows[0]!.spansEvent).toBe(false);
    expect(before).toBeCloseTo(0.3, 6);
    expect(evaluated.rows[1]!.spansEvent).toBe(true);
    const tAfter = evaluated.rows[1]!.timeToExpiryYears;
    expect(after).toBeCloseTo(Math.sqrt((0.09 * tAfter + 0.0025) / tAfter), 6);
    expect(after).toBeGreaterThan(before);
    expect(far).toBeGreaterThan(0.3);
    expect(far - 0.3).toBeLessThan(0.01);
  });

  it('refuses a fit that is not a calibrateEventVolatility result, and expiries at or before asOf', () => {
    expect(
      codeOf(() =>
        eventVolatilityAtExpiry({
          fit: { baseVolatility: 0.3 } as never,
          expiries: ['2026-06-01'],
        }),
      ),
    ).toBe(ErrorCode.InputMissingField);
    expect(() =>
      eventVolatilityAtExpiry({
        fit: { baseVolatility: 0.3, eventVariance: 0.0025 } as never,
        expiries: ['2026-06-01'],
      }),
    ).toThrow(/calibrateEventVolatility\(/);
    expect(codeOf(() => eventVolatilityAtExpiry({ fit, expiries: [] }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    // An expiry ON the as-of date is after it (options expire at the close); the day before is not.
    expect(
      codeOf(() => eventVolatilityAtExpiry({ fit, expiries: ['2026-05-01'] })),
    ).toBeUndefined();
    expect(codeOf(() => eventVolatilityAtExpiry({ fit, expiries: ['2026-04-30'] }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => eventVolatilityAtExpiry({ fit, expiries: [20260601] } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      codeOf(() => eventVolatilityAtExpiry({ fit, expiries: ['2026-06-01'], extra: 1 } as never)),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() =>
        eventVolatilityAtExpiry({ fit: { ...fit, eventVariance: -1 }, expiries: ['2026-06-01'] }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
  });
});
