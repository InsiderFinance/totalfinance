/**
 * Earnings / event-vol modeling (`calibrateEventVolatility`, `calibrateEventMove`). Verifies that a synthetic term
 * structure with a known (σ_base, J) is recovered by the fit, that pre+post and all-post-event sets
 * both identify, that an underdetermined single expiry throws (and is solved with baseVolatility), that a
 * vol-falls-through-event structure yields eventMove 0 with a warning, the calibration statistics, and
 * the guards.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError, optionExpiryToMs, yearFraction, resolveAsOf } from '@totalfinance/core';
import {
  type AtmVolatilityPoint,
  calibrateEventMove,
  calibrateEventVolatility,
} from '@totalfinance/volatility';

const ASOF = '2026-05-01T10:00:00-04:00'; // an intraday ET instant: day counts run on the market date

/** A term structure that EXACTLY follows the additive-event-variance model for a given (σ_base, J). */
function synthTerm(
  baseVolatility: number,
  eventMove: number,
  eventDate: string,
  expiries: readonly string[],
): AtmVolatilityPoint[] {
  const asOfMs = resolveAsOf(ASOF);
  const eventMs = optionExpiryToMs(eventDate);
  return expiries.map((expiry) => {
    const t = yearFraction(asOfMs, optionExpiryToMs(expiry), 'ACT/365F');
    const spans = optionExpiryToMs(expiry) >= eventMs;
    const v = baseVolatility * baseVolatility * t + (spans ? eventMove * eventMove : 0);
    return { expiry, atmVolatility: Math.sqrt(v / t) };
  });
}

describe('calibrateEventVolatility — recovers a known event jump', () => {
  it('recovers σ_base and J from a pre+post term structure (R² = 1)', () => {
    const term = synthTerm(0.3, 0.05, '2026-05-11', [
      '2026-05-08',
      '2026-05-15',
      '2026-05-31',
      '2026-06-30',
    ]);
    const r = calibrateEventVolatility({
      termStructure: term,
      eventDate: '2026-05-11',
      asOf: ASOF,
    });
    expect(r.baseVolatility).toBeCloseTo(0.3, 6);
    expect(r.eventMove).toBeCloseTo(0.05, 6); // a 5% implied earnings move
    expect(r.eventVariance).toBeCloseTo(0.0025, 8);
    expect(r.rSquared).toBeCloseTo(1, 8);
    expect(r.daysToEvent).toBe(10);
    // The pre-event expiry does not span; the rest do.
    expect(r.perExpiry.map((e) => e.spansEvent)).toEqual([false, true, true, true]);
    for (const e of r.perExpiry) expect(Math.abs(e.residual)).toBeLessThan(1e-9); // exact fit
  });

  it('identifies both from an all-post-event set (≥ 2 maturities)', () => {
    const term = synthTerm(0.25, 0.04, '2026-05-03', [
      '2026-05-08',
      '2026-05-15',
      '2026-05-31',
      '2026-06-30',
    ]);
    const r = calibrateEventVolatility({
      termStructure: term,
      eventDate: '2026-05-03',
      asOf: ASOF,
    });
    expect(r.perExpiry.every((e) => e.spansEvent)).toBe(true);
    expect(r.baseVolatility).toBeCloseTo(0.25, 6);
    expect(r.eventMove).toBeCloseTo(0.04, 6);
  });
});

describe('calibrateEventVolatility — identifiability', () => {
  it('throws on an underdetermined single expiry, but solves it when baseVolatility is pinned', () => {
    const one = synthTerm(0.3, 0.05, '2026-05-11', ['2026-05-31']);
    expect(() =>
      calibrateEventVolatility({ termStructure: one, eventDate: '2026-05-11', asOf: ASOF }),
    ).toThrowError();
    // Pin the continuous vol → the jump is recovered from the single spanning expiry.
    const pinned = calibrateEventVolatility({
      termStructure: one,
      eventDate: '2026-05-11',
      asOf: ASOF,
      baseVolatility: 0.3,
    });
    expect(pinned.baseVolatility).toBeCloseTo(0.3, 10);
    expect(pinned.eventMove).toBeCloseTo(0.05, 6);
  });
});

describe('calibrateEventVolatility — no fabricated premium', () => {
  it('a vol that falls through the event yields eventMove 0 with a disclosed warning', () => {
    // Pre-event 7d at 0.40 (base), post-event 30d at only 0.30 → negative event excess.
    const term: AtmVolatilityPoint[] = [
      { expiry: '2026-05-08', atmVolatility: 0.4 },
      { expiry: '2026-05-31', atmVolatility: 0.3 },
    ];
    const r = calibrateEventVolatility({
      termStructure: term,
      eventDate: '2026-05-11',
      asOf: ASOF,
    });
    expect(r.eventMove).toBe(0);
    expect(
      r.diagnostics.warnings.some((w) => w.message.includes('no positive event premium')),
    ).toBe(true);
  });

  it('warns when no expiry spans the event (jump unidentifiable)', () => {
    const term = synthTerm(0.3, 0, '2026-06-30', ['2026-05-08', '2026-05-15']); // event after all expiries
    const r = calibrateEventVolatility({
      termStructure: term,
      eventDate: '2026-06-30',
      asOf: ASOF,
    });
    expect(r.eventMove).toBe(0);
    expect(r.baseVolatility).toBeCloseTo(0.3, 6);
    expect(r.diagnostics.warnings.some((w) => w.message.includes('no expiry spans'))).toBe(true);
  });
});

describe('calibrateEventMove — implied vs realized', () => {
  it('computes the ratio, overpriced fraction, bias, and MAE', () => {
    const r = calibrateEventMove([
      { impliedMove: 0.05, realizedMove: 0.03, date: '2026-01-28' },
      { impliedMove: 0.06, realizedMove: 0.08, date: '2026-04-29' },
      { impliedMove: 0.04, realizedMove: 0.02, date: '2025-10-30' },
    ]);
    expect(r.count).toBe(3);
    expect(r.averageImplied).toBeCloseTo(0.05, 10);
    expect(r.averageRealized).toBeCloseTo(0.043333, 5);
    expect(r.ratio).toBeCloseTo(13 / 15, 10); // averageRealized/averageImplied < 1 ⇒ straddles rich on average
    expect(r.overpricedFraction).toBeCloseTo(2 / 3, 6); // sold-straddle won 2 of 3
    expect(r.bias).toBeCloseTo(-0.006667, 5); // realized below implied on average
    expect(r.meanAbsoluteError).toBeCloseTo(0.02, 6);
    expect(r.perEvent[0]!.overpriced).toBe(true);
    expect(r.perEvent[1]!.overpriced).toBe(false);
  });
});

describe('earnings — envelope & guards', () => {
  it('calibrateEventVolatility throws on garbage, empty term structure, bad eventDate, and a pre-asOf expiry', () => {
    expect(() => calibrateEventVolatility(undefined as never)).toThrowError();
    expect(() =>
      calibrateEventVolatility({ termStructure: [], eventDate: '2026-05-11', asOf: ASOF }),
    ).toThrowError();
    try {
      calibrateEventVolatility({
        termStructure: synthTerm(0.3, 0.05, '2026-05-11', ['2026-05-31']),
        eventDate: 5 as never,
        asOf: ASOF,
      });
      expect.unreachable('a non-string eventDate should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
    expect(() =>
      calibrateEventVolatility({
        termStructure: [{ expiry: '2026-04-01', atmVolatility: 0.3 }],
        eventDate: '2026-05-11',
        asOf: ASOF,
      }),
    ).toThrowError(); // expiry before asOf
  });

  it('calibrateEventMove guards empty history and a negative realized move', () => {
    expect(() => calibrateEventMove([])).toThrowError();
    expect(() => calibrateEventMove([{ impliedMove: 0.05, realizedMove: -0.01 }])).toThrowError();
    expect(() => calibrateEventMove([{ impliedMove: 0, realizedMove: 0.02 }])).toThrowError();
  });
});
