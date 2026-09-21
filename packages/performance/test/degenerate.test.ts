/**
 * Review fixes for two silent-NaN classes (design law #4: NaN only alongside explicit diagnostics):
 *   1. `requireSeries` element guard — `sharpe(['a','b','c'])` used to return a silent NaN because
 *      only the CONTAINER was checked; element 0 is now probed with a typed teaching error.
 *   2. Degenerate-NaN honesty — explain paths of metrics that return NaN BY DESIGN (zero variance,
 *      no non-zero periods, empty series) now push a `input.degenerate` warning saying why, instead
 *      of `{ value: NaN, warnings: [] }`. Plain-call behavior is unchanged.
 * Plus the `turnover`/`exposure` guard message, which had lost its `${fn}` interpolation.
 */

import { describe, expect, it } from 'vitest';
import { InputError, WarningCode } from '@totalfinance/core';
import type { Diagnostics } from '@totalfinance/core';
import {
  annualizedReturn,
  annualizedVolatility,
  analyze,
  beta,
  calmar,
  expectancy,
  exposure,
  hitRate,
  informationRatio,
  maxDrawdown,
  maxDrawdownFromReturns,
  omega,
  profitFactor,
  sharpe,
  sortino,
  trackingError,
  treynor,
  turnover,
  winLossStatistics,
} from '@totalfinance/performance';

const codes = (d: Diagnostics): string[] => d.warnings.map((w) => w.code);
const DEGENERATE: string = WarningCode.DegenerateInput; // 'input.degenerate'

describe('requireSeries element guard — a series of strings throws, never a silent NaN', () => {
  it("sharpe(['a','b','c']) throws a typed teaching error naming the function", () => {
    const bad = ['a', 'b', 'c'] as unknown as number[];
    expect(() => sharpe(bad)).toThrow(InputError);
    expect(() => sharpe(bad)).toThrow(/sharpe: returns\[0\] must be a finite number/);
  });

  it('the guard feeds every series metric in the package', () => {
    const bad = ['0.01', '0.02'] as unknown as number[];
    expect(() => hitRate(bad)).toThrow(/hitRate/);
    expect(() => omega(bad)).toThrow(/omega/);
    expect(() => annualizedReturn(bad)).toThrow(/annualizedReturn/);
    expect(() => sortino(bad)).toThrow(/sortino/);
    expect(() => beta(bad, bad)).toThrow(/beta/);
  });

  it('a Float64Array still passes; empty arrays report null (Law 7 — never a bare NaN)', () => {
    const f = new Float64Array([0.01, -0.02, 0.015, 0.004]);
    expect(Number.isFinite(sharpe(f))).toBe(true);
    expect(sharpe([])).toBeNull();
    expect(annualizedReturn([])).toBeNull();
  });
});

describe('degenerate honesty — undefined metrics are NULL with the reason disclosed (D3)', () => {
  it('sharpe.explain on a zero-variance series carries input.degenerate', () => {
    const e = sharpe.explain([0.01, 0.01, 0.01]);
    expect(e.value).toBeNull();
    expect(codes(e.diagnostics)).toContain(DEGENERATE);
  });

  it('hitRate.explain([0, 0]) carries input.degenerate', () => {
    const e = hitRate.explain([0, 0]);
    expect(e.value).toBeNull();
    expect(codes(e.diagnostics)).toContain(DEGENERATE);
  });

  it('no-non-zero-period ratios, zero-downside sortino, and empty-series metrics all disclose', () => {
    expect(codes(omega.explain([0, 0]).diagnostics)).toContain(DEGENERATE);
    expect(codes(profitFactor.explain([0, 0]).diagnostics)).toContain(DEGENERATE);
    expect(codes(winLossStatistics.explain([0, 0]).diagnostics)).toContain(DEGENERATE);
    expect(codes(sortino.explain([0.01, 0.02]).diagnostics)).toContain(DEGENERATE);
    expect(codes(annualizedReturn.explain([]).diagnostics)).toContain(DEGENERATE);
    expect(codes(annualizedVolatility.explain([]).diagnostics)).toContain(DEGENERATE);
    expect(codes(expectancy.explain([]).diagnostics)).toContain(DEGENERATE);
    expect(codes(calmar.explain([]).diagnostics)).toContain(DEGENERATE);
  });

  it('benchmark-relative: zero-variance benchmark (beta/treynor) and perfect tracking (IR)', () => {
    const r = [0.01, -0.02, 0.015];
    const flat = [0.01, 0.01, 0.01];
    expect(codes(beta.explain(r, flat).diagnostics)).toContain(DEGENERATE);
    expect(codes(treynor.explain(r, flat).diagnostics)).toContain(DEGENERATE);
    expect(codes(informationRatio.explain(r, r).diagnostics)).toContain(DEGENERATE);
  });

  it('reports one-period tracking error as null with a named disclosure', () => {
    expect(trackingError([0.01], [0.01])).toBeNull();
    const explained = trackingError.explain([0.01], [0.01]);
    expect(explained.value).toBeNull();
    expect(codes(explained.diagnostics)).toContain(DEGENERATE);

    const summary = analyze({ returns: [0.01] }, { benchmark: [0.01] });
    expect(summary.trackingError).toBeNull();
    expect(
      summary.warnings.some(
        (warning) =>
          warning.code === 'performance.undefined_metric' &&
          (warning.context?.['metrics'] as unknown[]).includes('trackingError'),
      ),
    ).toBe(true);
  });

  it('activity metrics disclose an empty weight series', () => {
    expect(codes(turnover.explain([]).diagnostics)).toContain(DEGENERATE);
    expect(codes(exposure.explain([]).diagnostics)).toContain(DEGENERATE);
  });

  it('plain calls report null too — JSON-safe everywhere (D3); healthy explains carry no warning', () => {
    expect(sharpe([0.01, 0.01, 0.01])).toBeNull();
    expect(hitRate([0, 0])).toBeNull();
    // The null survives serialization intact — the exact corruption JSON.stringify(NaN) caused.
    expect(JSON.parse(JSON.stringify({ v: sharpe([0.01, 0.01, 0.01]) })).v).toBeNull();
    const healthy = sharpe.explain([0.01, -0.02, 0.015, 0.004]);
    expect(Number.isFinite(healthy.value)).toBe(true);
    expect(healthy.diagnostics.warnings).toEqual([]);
  });

  it('the degenerate warning is informational and explains itself', () => {
    const w = sharpe
      .explain([0.01, 0.01, 0.01])
      .diagnostics.warnings.find((x) => x.code === DEGENERATE);
    expect(w?.severity).toBe('info');
    expect(w?.message).toMatch(/undefined —/);
  });
});

describe('activity guard names the function (review fix: the message lost its ${fn})', () => {
  it('turnover/exposure on a non-array weights input name the metric in the error', () => {
    expect(() => turnover({} as never)).toThrow(/turnover: weights/);
    expect(() => exposure({} as never)).toThrow(/exposure: weights/);
  });
});

describe('an empty series has no drawdown to report (C hygiene)', () => {
  it('maxDrawdown and maxDrawdownFromReturns refuse an empty series with a typed error', () => {
    expect(() => maxDrawdown([])).toThrow(/maxDrawdown: equity must not be empty/);
    expect(() => maxDrawdownFromReturns([])).toThrow(
      /maxDrawdownFromReturns: returns must not be empty/,
    );
    expect(() => maxDrawdown.explain([])).toThrow(/must not be empty/);
    // A one-point series is a peak with no decline — that is a drawdown of zero, not an error.
    expect(maxDrawdown([100]).maxDrawdown).toBe(0);
  });
});
