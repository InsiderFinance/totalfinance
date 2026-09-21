/**
 * 2026-08-23 review P0 — count/resource safety, library-wide wave.
 *
 * `Number.isInteger(1e308)` is `true`, and above 2^53 a loop counter stops advancing — so a public
 * workload control validated with `Number.isInteger` and then used against loop indices was an
 * inexact (or non-advancing) count. Every backtest count here is bounded by the bar data itself,
 * so the discipline is safe-integer exactness: `2^53` refused typed, non-integers still refused.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError, type Bar } from '@totalfinance/core';
import { brokers, vectorized, walkForward } from '@totalfinance/backtest';

/** Capture the thrown value (the guards must throw typed QuantErrors, never return). */
function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const UNSAFE_COUNTS = [2 ** 53, 1e308] as const;
const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);

function bars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    symbol: 'TEST',
    timestampMs: t0 + i * DAY,
    open: c,
    high: c,
    low: c,
    close: c,
  }));
}

const CLOSES = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3));
const DATA = bars(CLOSES);

describe('walkForward — trainSize/testSize/step are safe integers (the window loop is data-bounded)', () => {
  const run = (w: { test: Bar[] }): ReturnType<typeof vectorized> =>
    vectorized({ data: w.test, signal: w.test.map(() => true) });

  it('refuses 2^53 / 1e308 / fractional counts typed on every parameter, and a realistic run still works', () => {
    for (const bad of [...UNSAFE_COUNTS, 10.5]) {
      expect(
        isQuantError(
          catching(() => walkForward({ data: DATA, trainSize: bad, testSize: 5, run })),
          'input.out_of_range',
        ),
        `trainSize ${bad}`,
      ).toBe(true);
      expect(
        isQuantError(
          catching(() => walkForward({ data: DATA, trainSize: 10, testSize: bad, run })),
          'input.out_of_range',
        ),
        `testSize ${bad}`,
      ).toBe(true);
      expect(
        isQuantError(
          catching(() => walkForward({ data: DATA, trainSize: 10, testSize: 5, step: bad, run })),
          'input.out_of_range',
        ),
        `step ${bad}`,
      ).toBe(true);
    }
    const wf = walkForward({ data: DATA, trainSize: 10, testSize: 5, run });
    expect(wf.windows.length).toBeGreaterThan(0);
  });
});

describe('vectorized — rebalance/warmup/executionLag are safe integers', () => {
  const signal = CLOSES.map(() => true);

  it('refuses a 2^53 / fractional numeric rebalance rule typed (i % rule needs an exact modulus)', () => {
    for (const bad of [...UNSAFE_COUNTS, 2.5]) {
      const caught = catching(() => vectorized({ data: DATA, signal, rebalance: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `rebalance ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('rebalance');
    }
    expect(vectorized({ data: DATA, signal, rebalance: 5 }).finalValue).toBeGreaterThan(0);
  });

  it('refuses a 2^53 / fractional signal warmup typed (an index threshold must be exact)', () => {
    for (const bad of [...UNSAFE_COUNTS, 3.5]) {
      const caught = catching(() =>
        vectorized({ data: DATA, signal: { value: signal.map(Number), warmup: bad } }),
      );
      expect(isQuantError(caught, 'input.out_of_range'), `warmup ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('warmup');
    }
    expect(
      vectorized({ data: DATA, signal: { value: signal.map(Number), warmup: 3 } }).finalValue,
    ).toBeGreaterThan(0);
  });

  it('refuses a 2^53 / fractional executionLag typed (an index offset must be exact)', () => {
    for (const bad of [...UNSAFE_COUNTS, 1.5]) {
      const caught = catching(() => vectorized({ data: DATA, signal, executionLag: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `executionLag ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('executionLag');
    }
    expect(vectorized({ data: DATA, signal, executionLag: 0 }).finalValue).toBeGreaterThan(0);
  });
});

describe('SimulatedBroker.exerciseOption — the contract quantity is a safe integer', () => {
  it('refuses a 2^53 / fractional quantity typed before touching positions', () => {
    const broker = brokers.simulated({ cash: 100_000, assignment: 'model' });
    broker.registerOption('C90', {
      underlying: 'XYZ',
      type: 'call',
      strike: 90,
      expiresAt: t0 + 30 * DAY,
      style: 'american',
    });
    for (const bad of [...UNSAFE_COUNTS, 1.5]) {
      const caught = catching(() =>
        broker.exerciseOption({ symbol: 'C90', quantity: bad, timestampMs: t0 }),
      );
      expect(isQuantError(caught, 'input.out_of_range'), `quantity ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('quantity');
    }
  });
});
