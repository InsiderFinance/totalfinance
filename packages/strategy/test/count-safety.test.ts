/**
 * Count/resource safety, library-wide wave (2026-08-23 review, P0).
 *
 * `Number.isInteger(1e308)` is `true` and `counter++` stops advancing at 2^53, so a workload
 * control validated with `Number.isInteger` and then looped or allocated was a non-terminating loop
 * or an absurd allocation. In this package: the price grid (`{ from, to, steps }`), the
 * Monte-Carlo probability simulation (paths × steps — the reviewer-named product), the optimizer's
 * quadrature grid, and the plain integer data heads (top, quantity).
 */

import { describe, expect, it } from 'vitest';
import { isQuantError, isoDateToEpochMs, resolvedExpiry } from '@totalfinance/core';
import type { OptionQuote } from '@totalfinance/core';
import type { OptimizerExpiry, ScanQuoteRow } from '@totalfinance/strategy';
import {
  legs,
  optimizeStrategy,
  scanStrategies,
  strategy,
  strategyFromChain,
} from '@totalfinance/strategy';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const ABSURD = [2 ** 53, 2 ** 53 + 2, 1e308, -(2 ** 53), 2.5] as const;

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-04-02';
const market = { asOf, expiry, volatility: 0.25, riskFreeRate: 0.04, spot: 100 } as const;

describe('2026-08-23 P0 — price grid steps', () => {
  const pos = strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]);

  it('refuses absurd step counts and teaches the 1,000,000 cap', () => {
    for (const bad of ABSURD) {
      const error = caught(() => pos.payoff({ prices: { from: 80, to: 120, steps: bad } }));
      expect(isQuantError(error, 'input.out_of_range'), `steps = ${bad}`).toBe(true);
    }
    const overCap = caught(() => pos.payoff({ prices: { from: 80, to: 120, steps: 1_000_001 } }));
    expect(String((overCap as Error).message)).toContain('1,000,000');
    expect(String((overCap as Error).message)).toContain('grid');
    expect(pos.payoff({ prices: { from: 90, to: 110, steps: 41 } }).points).toBeDefined();
  });
});

describe('2026-08-23 P0 — monteCarloProbability paths × steps (reviewer-named case)', () => {
  const pos = strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]);

  it('refuses absurd paths and steps with one typed teaching each', () => {
    for (const bad of ABSURD) {
      const paths = caught(() => pos.monteCarloProbability({ ...market, seed: 1, paths: bad }));
      expect(isQuantError(paths, 'input.out_of_range'), `paths = ${bad}`).toBe(true);
      const steps = caught(() => pos.monteCarloProbability({ ...market, seed: 1, steps: bad }));
      expect(isQuantError(steps, 'input.out_of_range'), `steps = ${bad}`).toBe(true);
    }
  });

  it('cap + 1 refusals name their bounds', () => {
    const paths = caught(() =>
      pos.monteCarloProbability({ ...market, seed: 1, paths: 10_000_001 }),
    );
    expect(String((paths as Error).message)).toContain('10,000,000');
    const steps = caught(() => pos.monteCarloProbability({ ...market, seed: 1, steps: 1_000_001 }));
    expect(String((steps as Error).message)).toContain('1,000,000');
  });

  it('paths × steps is bounded as a PRODUCT even when each factor is under its own cap', () => {
    // 1,000,000 paths (fine alone) × 200 steps (fine alone) = 2×10^8 path-steps > the 10^8 cap.
    const error = caught(() =>
      pos.monteCarloProbability({ ...market, seed: 1, paths: 1_000_000, steps: 200 }),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toContain('paths × steps');
    expect(String((error as Error).message)).toContain('100,000,000');
  });

  it('a realistic simulation still runs and reports a probability', () => {
    const r = pos.monteCarloProbability({ ...market, seed: 7, paths: 5_000, steps: 20 });
    expect(r.probabilityOfProfit).toBeGreaterThanOrEqual(0);
    expect(r.probabilityOfProfit).toBeLessThanOrEqual(1);
  });
});

describe('2026-08-23 P0 — optimizer and scanner integer heads', () => {
  const chain = (): ScanQuoteRow[] =>
    [80, 85, 90, 95, 100, 105, 110, 115, 120].map((strike) => ({ strike }));
  const optimizerExpiry: OptimizerExpiry = { expiry: '2026-06-20', chain: chain() };
  const optimizerBase = () => ({
    spot: 100,
    asOf: isoDateToEpochMs('2026-05-01'),
    riskFreeRate: 0.03,
    volatility: 0.25,
    expiries: [optimizerExpiry],
    thesis: { targetPrice: 108, volatility: 0.2 },
  });

  it('optimizeStrategy gridPoints refuses absurd grids and teaches the 100,000 cap', () => {
    for (const bad of [2 ** 53, 1e308, 2.5]) {
      const error = caught(() => optimizeStrategy({ ...optimizerBase(), gridPoints: bad }));
      expect(isQuantError(error, 'input.out_of_range'), `gridPoints = ${bad}`).toBe(true);
    }
    const overCap = caught(() => optimizeStrategy({ ...optimizerBase(), gridPoints: 100_001 }));
    expect(String((overCap as Error).message)).toContain('100,000');
    expect(String((overCap as Error).message)).toContain('candidate');
  });

  it('optimizeStrategy top and scanStrategies top refuse 2^53 (exactness, not workload)', () => {
    const optimizerTop = caught(() => optimizeStrategy({ ...optimizerBase(), top: 2 ** 53 }));
    expect(isQuantError(optimizerTop, 'input.out_of_range')).toBe(true);
    const scannerTop = caught(() => scanStrategies({ ...market, chain: chain(), top: 2 ** 53 }));
    expect(isQuantError(scannerTop, 'input.out_of_range')).toBe(true);
    // A realistic scan still ranks.
    const r = scanStrategies({ ...market, chain: chain(), top: 5 });
    expect(r.candidates.length).toBeLessThanOrEqual(5);
    expect(r.candidates.length).toBeGreaterThan(0);
  });
});

describe('2026-08-23 P0 — strategyFromChain quantity is a safe integer', () => {
  const quote = (type: 'call' | 'put', mid: number): OptionQuote => ({
    contract: {
      underlying: 'XYZ',
      type,
      style: 'american',
      strike: 100,
      expiry,
      ...resolvedExpiry(expiry),
    },
    timestampMs: 0,
    bid: mid - 0.1,
    ask: mid + 0.1,
    mid,
    impliedVolatility: 0.25,
    underlyingPrice: 100,
  });
  const rows = [quote('call', 5), quote('put', 4.8)];

  it('refuses 2^53 (a "contract count" that cannot be exact) and still builds real positions', () => {
    for (const bad of [2 ** 53, 1e308, 2.5]) {
      const error = caught(() =>
        strategyFromChain(rows, { type: 'straddle', expiry, quantity: bad }),
      );
      expect(isQuantError(error, 'input.out_of_range'), `quantity = ${bad}`).toBe(true);
    }
    const built = strategyFromChain(rows, { type: 'straddle', expiry, quantity: 2 });
    expect(built.legs).toHaveLength(2);
  });
});
