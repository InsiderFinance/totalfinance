import { describe, expect, it } from 'vitest';
import {
  analyze,
  annualizedReturn,
  annualizedVolatility,
  calmar,
  sharpe,
  sortino,
} from '@totalfinance/performance';

/**
 * DX0 first-touch law for @totalfinance/performance: the natural first call `sharpe(returns)` used
 * to crash with `TypeError: reading 'periodsPerYear'`. Now `periodsPerYear` is the Tier-1 daily
 * convention (252) — it defaults, engages, and is echoed by `analyze`'s assumptions.
 */

// A per-period return series with a positive drift and real dispersion (so ratios are finite).
const returns = Array.from(
  { length: 120 },
  (_, i) => 0.0004 + 0.01 * Math.sin(i / 5) - (i % 7) * 0.001,
);

describe('performance first touch — the natural first call returns a value with no options', () => {
  it('scalar metrics do not throw and return finite numbers', () => {
    for (const [name, v] of [
      ['sharpe', sharpe(returns)],
      ['sortino', sortino(returns)],
      ['annualizedReturn', annualizedReturn(returns)],
      ['annualizedVolatility', annualizedVolatility(returns)],
      ['calmar', calmar(returns)],
    ] as const) {
      expect(Number.isFinite(v), `${name} should be finite`).toBe(true);
    }
  });

  it('analyze({ returns }) works and echoes the applied 252 convention', () => {
    const summary = analyze({ returns });
    expect(Number.isFinite(summary.sharpe)).toBe(true);
    expect(summary.assumptions.periodsPerYear).toBe(252);
    expect(summary.assumptions.riskFreeRate).toBe(0);
  });

  it('the 252 default genuinely ENGAGES — no-options equals the explicit standard call', () => {
    expect(sharpe(returns)).toBe(sharpe(returns, { periodsPerYear: 252 }));
    expect(annualizedVolatility(returns)).toBe(
      annualizedVolatility(returns, { periodsPerYear: 252 }),
    );
    expect(annualizedReturn(returns)).toBe(annualizedReturn(returns, { periodsPerYear: 252 }));
  });
});
