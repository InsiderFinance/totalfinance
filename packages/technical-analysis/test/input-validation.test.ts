import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { barsFromColumns, columnsFromBars, stoch } from '../src/index.js';
import * as ta from '../src/index.js';

/**
 * DX §1.2 — the TA facade choke point validates the SERIES, not just the parameters. The old failure
 * mode was silence: `rsi("hello")` → `[null×5]`, `stoch({ high, low, close })` → `[undefined]`.
 * Garbage now throws typed teaching errors; valid numeric arrays with NaN gaps stay legal.
 */
const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
const bars = closes.map((c) => ({ high: c + 2, low: c - 2, close: c }));

describe('series validation (dx §1.2)', () => {
  it('a string instead of a series throws a typed teaching error', () => {
    let caught: unknown;
    try {
      ta.rsi('hello' as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect((caught as Error).message).toContain('technicalAnalysis.rsi');
  });

  it('string ELEMENTS are rejected by index, not silently coerced to nulls', () => {
    let caught: unknown;
    try {
      ta.rsi([1, 2, 'x', 4] as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect((caught as Error).message).toContain('series[2]');
  });

  it('columnar arrays into a bars indicator teach barsFromColumns instead of returning garbage', () => {
    let caught: unknown;
    try {
      stoch({ high: [1, 2], low: [0, 1], close: [0.5, 1.5] } as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect((caught as Error).message).toContain('barsFromColumns');
  });

  it('the same validation guards .explain()', () => {
    expect(() => ta.rsi.explain('hello' as never)).toThrowError(/technicalAnalysis\.rsi/);
  });

  it('valid input still computes; NaN gaps remain legal', () => {
    const withGap = [...closes];
    withGap[10] = NaN;
    expect(ta.sma(withGap, { period: 5 })).toHaveLength(withGap.length);
    expect(stoch(bars)).toHaveLength(bars.length);
  });
});

describe('barsFromColumns / columnsFromBars', () => {
  it('round-trips columns through bars', () => {
    const cols = { high: [2, 3], low: [0, 1], close: [1, 2] };
    const rows = barsFromColumns(cols);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ high: 3, low: 1, close: 2 });
    expect(columnsFromBars(rows)).toEqual(cols);
    // And the converted rows feed straight into a bars indicator.
    expect(stoch(barsFromColumns(columnsFromBars(bars)))).toHaveLength(bars.length);
  });

  it('mismatched column lengths throw a typed error naming the column', () => {
    expect(() => barsFromColumns({ high: [1, 2], low: [1] })).toThrowError(/low has 1/);
  });

  it('garbage input throws typed', () => {
    let caught: unknown;
    try {
      barsFromColumns('hello' as never);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
  });
});

describe('explain envelope (dx §2.2 — one envelope law)', () => {
  it('rsi.explain(closes) echoes the default period it ran with', () => {
    const r = ta.rsi.explain(closes);
    expect(r.assumptions.indicator).toBe('rsi');
    expect(r.assumptions.parameters).toEqual({ period: 14 });
    expect(r.assumptions.conventionsVersion).toBeTypeOf('string');
    expect(r.diagnostics.warmup).toBe(14);
    expect(r.diagnostics.warnings).toEqual([]);
  });

  it('caller parameters override declared defaults in the echo', () => {
    const r = ta.macd.explain(closes, { fast: 5 });
    expect(r.assumptions.parameters).toEqual({ fast: 5, slow: 26, signal: 9 });
  });

  it('bbands/stochastic/atr/adx declare their industry defaults', () => {
    expect(ta.bbands.explain(closes).assumptions.parameters).toEqual({
      period: 20,
      standardDeviation: 2,
    });
    expect(ta.stochastic.explain(bars).assumptions.parameters).toEqual({
      kPeriod: 14,
      dPeriod: 3,
      smoothK: 1,
    });
    expect(ta.atr.explain(bars).assumptions.parameters).toEqual({ period: 14 });
    expect(ta.adx.explain(bars).assumptions.parameters).toEqual({ period: 14 });
  });
});
