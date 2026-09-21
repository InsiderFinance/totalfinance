import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  adx,
  atr,
  bb,
  bbands,
  ema,
  macd,
  mfi,
  rsi,
  sma,
  stoch,
  stochastic,
  williamsR,
  willr,
} from '@totalfinance/technical-analysis';

/**
 * DX0 first-touch law: the most natural first call for each package — `rsi(closes)` with no parameters
 * object — must NOT crash with a raw `TypeError` from library internals. Industry-standard parameters
 * (RSI 14, MACD 12/26/9, BBands 20/2, ATR/ADX/stoch/MFI/WilliamsR 14) default and engage; parameters
 * with no universal default (plain MA period) throw a TYPED teaching error instead.
 */

const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);
const bars = closes.map((c, i) => ({
  open: i > 0 ? closes[i - 1]! : c,
  high: c + 1,
  low: c - 1,
  close: c,
  volume: 1000 + i,
}));

/** The last finite (post-warmup) value of an aligned series. */
function lastReal(xs: number[]): number {
  for (let i = xs.length - 1; i >= 0; i--) if (Number.isFinite(xs[i]!)) return xs[i]!;
  return NaN;
}

describe('ta first touch — industry-default indicators return values with no parameters', () => {
  it('series indicators (rsi/macd/bbands)', () => {
    expect(Number.isFinite(lastReal(rsi(closes)))).toBe(true);
    expect(Number.isFinite(lastReal(macd(closes).map((p) => p.macd)))).toBe(true);
    expect(Number.isFinite(lastReal(bbands(closes).map((p) => p.middle)))).toBe(true);
  });

  it('bar indicators (atr/adx/stochastic/mfi/williamsR)', () => {
    expect(Number.isFinite(lastReal(atr(bars)))).toBe(true);
    expect(Number.isFinite(lastReal(adx(bars).map((p) => p.adx)))).toBe(true);
    expect(Number.isFinite(lastReal(stochastic(bars).map((p) => p.k)))).toBe(true);
    expect(Number.isFinite(lastReal(mfi(bars)))).toBe(true);
    expect(Number.isFinite(lastReal(williamsR(bars)))).toBe(true);
  });

  it('the defaults genuinely ENGAGE — a no-parameters call equals the explicit standard call', () => {
    expect(rsi(closes)).toEqual(rsi(closes, { period: 14 }));
    expect(bbands(closes)).toEqual(bbands(closes, { period: 20, standardDeviation: 2 }));
    expect(macd(closes)).toEqual(macd(closes, { fast: 12, slow: 26, signal: 9 }));
    expect(stochastic(bars)).toEqual(stochastic(bars, { kPeriod: 14, dPeriod: 3 }));
    expect(atr(bars)).toEqual(atr(bars, { period: 14 }));
  });
});

describe('ta first touch — Tier-2 parameters (no universal default) teach instead of crashing', () => {
  it('sma/ema without a period throw a typed missing-field error, never a raw TypeError', () => {
    for (const [name, fn] of [
      ['sma', sma],
      ['ema', ema],
    ] as const) {
      let caught: unknown;
      try {
        fn(closes);
      } catch (e) {
        caught = e;
      }
      expect(
        isQuantError(caught, 'input.missing_field'),
        `${name} should throw missing_field`,
      ).toBe(true);
      expect((caught as Error).message).toContain('period');
      expect((caught as Error).message).toContain('{ period:');
      // The failure must be a typed QuantError, not a bare TypeError from a property access.
      expect(caught instanceof TypeError).toBe(false);
    }
  });
});

describe('ta classic aliases resolve as real bindings (DX0.5)', () => {
  it('stoch/willr/bb are the canonical functions', () => {
    expect(stoch).toBe(stochastic);
    expect(willr).toBe(williamsR);
    expect(bb).toBe(bbands);
  });
});
