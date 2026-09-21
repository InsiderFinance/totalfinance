import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import * as ta from '@totalfinance/technical-analysis';
import * as perf from '@totalfinance/performance';
import * as strat from '@totalfinance/strategy';

/**
 * DX0.8 — the first-touch property gate. The most natural first call for each hardened facade must
 * either RETURN A VALUE or throw a typed `QuantError` (subclass). A raw `TypeError`/`RangeError`
 * escaping any public facade fails CI — this is the invariant that kills "Regime A" (crash-on-missing
 * -parameters) permanently. DX7.2 generalizes this to every export of all 13 packages; here we lock the
 * ta / performance / strategy surface hardened in DX0.
 */

const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);
const bars = closes.map((c, i) => ({
  open: i > 0 ? closes[i - 1]! : c,
  high: c + 1,
  low: c - 1,
  close: c,
  volume: 1000 + i,
}));
const returns = Array.from(
  { length: 120 },
  (_, i) => 0.0004 + 0.01 * Math.sin(i / 5) - (i % 7) * 0.001,
);

/** Each entry runs the most natural first call for a facade; it must return or throw a QuantError. */
const FIRST_TOUCH: ReadonlyArray<readonly [string, () => unknown]> = [
  // @totalfinance/technical-analysis — no-parameters first calls (industry defaults engage or a teaching error is thrown)
  ['technical-analysis.rsi(closes)', () => ta.rsi(closes)],
  ['technical-analysis.macd(closes)', () => ta.macd(closes)],
  ['technical-analysis.ema(closes)', () => ta.ema(closes)], // Tier-2: throws a teaching QuantError (no universal default)
  ['technical-analysis.sma(closes)', () => ta.sma(closes)], // Tier-2
  ['technical-analysis.bbands(closes)', () => ta.bbands(closes)],
  ['technical-analysis.atr(bars)', () => ta.atr(bars)],
  ['technical-analysis.adx(bars)', () => ta.adx(bars)],
  ['technical-analysis.stochastic(bars)', () => ta.stochastic(bars)],
  ['technical-analysis.mfi(bars)', () => ta.mfi(bars)],
  ['technical-analysis.williamsR(bars)', () => ta.williamsR(bars)],
  ['technical-analysis.stoch(bars)', () => ta.stoch(bars)],
  // @totalfinance/performance — no-options first calls (252 default engages)
  ['performance.sharpe(returns)', () => perf.sharpe(returns)],
  ['performance.sortino(returns)', () => perf.sortino(returns)],
  ['performance.annualizedReturn(returns)', () => perf.annualizedReturn(returns)],
  ['performance.analyze({returns})', () => perf.analyze({ returns })],
  // @totalfinance/strategy — a wrong-shape guess must teach, not crash
  ['strategy.ironCondor({})', () => strat.ironCondor({} as never)],
  ['strategy.bullCallSpread({})', () => strat.bullCallSpread({} as never)],
];

describe('first-touch: no hardened public facade leaks a raw TypeError/RangeError', () => {
  for (const [label, thunk] of FIRST_TOUCH) {
    it(label, () => {
      let value: unknown;
      let error: unknown;
      try {
        value = thunk();
      } catch (e) {
        error = e;
      }
      if (error !== undefined) {
        expect(error instanceof TypeError, `${label} threw a raw TypeError: ${String(error)}`).toBe(
          false,
        );
        expect(
          error instanceof RangeError,
          `${label} threw a raw RangeError: ${String(error)}`,
        ).toBe(false);
        expect(isQuantError(error), `${label} threw a non-QuantError: ${String(error)}`).toBe(true);
      } else {
        expect(value, `${label} returned undefined`).toBeDefined();
      }
    });
  }
});
