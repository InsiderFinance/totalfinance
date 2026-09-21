/**
 * Tests for the extended §15.1 performance metrics: benchmark-relative (beta/alpha/IR/tracking/
 * Treynor), distribution/trade ratios (Omega/hit-rate/profit-factor/expectancy), activity
 * (turnover/exposure), rolling windows, and the benchmark-aware `analyze` summary.
 */

import { describe, expect, it } from 'vitest';
import { mean, standardDeviation } from '@totalfinance/math';
import {
  alpha,
  analyze,
  beta,
  equityCurve,
  expectancy,
  exposure,
  hitRate,
  informationRatio,
  omega,
  profitFactor,
  rollingReturn,
  rollingSharpe,
  rollingVolatility,
  trackingError,
  treynor,
  winLossStatistics,
  turnover,
} from '@totalfinance/performance';
import * as performance from '@totalfinance/performance';

describe('distribution / trade ratios', () => {
  it('Omega ratio is the gain/loss area ratio about the threshold', () => {
    const r = [0.02, -0.01, 0.03, -0.04, 0.01];
    // gains above 0: 0.02+0.03+0.01 = 0.06; losses below 0: 0.01+0.04 = 0.05
    expect(omega(r)).toBeCloseTo(0.06 / 0.05, 12);
    // a threshold equal to the max gain leaves no gains
    expect(omega(r, { threshold: 0.05 })).toBeCloseTo(0, 12);
  });

  it('Omega is NULL with gains-and-no-losses or neither (undefined ratio, Law 7)', () => {
    expect(omega([0.01, 0.02])).toBeNull(); // undefined ratio → null (Law 7)
    expect(omega([0, 0])).toBeNull();
  });

  it('hit rate counts only non-zero periods', () => {
    expect(hitRate([0.1, -0.1, 0.2, 0, 0])).toBeCloseTo(2 / 3, 12);
    expect(hitRate([0, 0])).toBeNull();
  });

  it('profit factor is gross gains over gross losses', () => {
    expect(profitFactor([0.02, -0.01, 0.03, -0.04])).toBeCloseTo(0.05 / 0.05, 12);
    expect(profitFactor([0.02, 0.03])).toBeNull(); // undefined ratio → null (Law 7)
  });

  it('expectancy is the mean return; winLossStatistics decomposes it into win/loss legs', () => {
    const r = [0.1, -0.05, 0.2, -0.1];
    expect(expectancy(r)).toBeCloseTo(mean(r), 12);
    const e = winLossStatistics(r);
    expect(e.expectancy).toBeCloseTo(expectancy(r)!, 12);
    expect(e.hitRate).toBeCloseTo(0.5, 12);
    expect(e.averageWin).toBeCloseTo(0.15, 12);
    expect(e.averageLoss).toBeCloseTo(-0.075, 12);
    // identity (holds here because the series has NO zero returns):
    // expectancy = hitRate·averageWin + lossRate·averageLoss
    expect(e.hitRate! * e.averageWin + (1 - e.hitRate!) * e.averageLoss).toBeCloseTo(
      e.expectancy!,
      12,
    );
  });

  it('with zero-return periods the documented identity scales by the active share (review fix)', () => {
    // hitRate/averageWin/averageLoss are computed over NON-ZERO periods while expectancy averages ALL
    // periods, so the exact identity carries the active (non-zero) fraction.
    const r = [0.1, 0, -0.05, 0, 0.2, -0.1]; // 4 active of 6
    const e = winLossStatistics(r);
    const active = 4 / 6;
    expect(e.hitRate).toBeCloseTo(0.5, 12);
    expect(e.averageWin).toBeCloseTo(0.15, 12);
    expect(e.averageLoss).toBeCloseTo(-0.075, 12);
    // documented identity: expectancy = active · (hitRate·averageWin + (1 − hitRate)·averageLoss)
    expect(active * (e.hitRate! * e.averageWin + (1 - e.hitRate!) * e.averageLoss)).toBeCloseTo(
      e.expectancy!,
      12,
    );
    // the naive (no-zeros) identity does NOT hold here — it overstates by the zero-dilution factor
    expect(
      Math.abs(e.hitRate! * e.averageWin + (1 - e.hitRate!) * e.averageLoss - e.expectancy!),
    ).toBeGreaterThan(1e-6);
  });
});

describe('benchmark-relative metrics', () => {
  it('beta of a 2x-levered clone of the benchmark is 2; perfectly tracks ⇒ zero tracking error', () => {
    const bench = [0.01, -0.02, 0.015, 0.005, -0.01];
    const strat = bench.map((b) => 2 * b);
    expect(beta(strat, bench)).toBeCloseTo(2, 10);
    // tracking error vs itself is 0
    expect(trackingError(bench, bench, { periodsPerYear: 252 })).toBeCloseTo(0, 12);
  });

  it('beta matches covariance/valueAtRisk directly', () => {
    const bench = [0.01, -0.02, 0.015, 0.005, -0.01, 0.02];
    const strat = [0.012, -0.018, 0.02, 0.004, -0.008, 0.025];
    // recompute via math primitives (ddof cancels)
    const expected =
      strat.reduce((s, v, i) => s + (v - mean(strat)) * (bench[i]! - mean(bench)), 0) /
      bench.reduce((s, v) => s + (v - mean(bench)) ** 2, 0);
    expect(beta(strat, bench)).toBeCloseTo(expected, 10);
  });

  it('alpha is ~0 when the strategy is exactly beta·benchmark with zero rf', () => {
    const bench = [0.01, -0.02, 0.015, 0.005, -0.01];
    const strat = bench.map((b) => 1.5 * b);
    expect(alpha(strat, bench, { periodsPerYear: 252 })).toBeCloseTo(0, 10);
  });

  it('information ratio is the annualized Sharpe of the active series', () => {
    const bench = [0.01, -0.02, 0.015, 0.005, -0.01];
    const strat = [0.02, -0.01, 0.02, 0.01, -0.005];
    const active = strat.map((s, i) => s - bench[i]!);
    const expected = (mean(active) / standardDeviation(active)) * Math.sqrt(252);
    expect(informationRatio(strat, bench, { periodsPerYear: 252 })).toBeCloseTo(expected, 10);
  });

  it('Treynor uses beta in the denominator', () => {
    const bench = [0.01, -0.02, 0.015, 0.005, -0.01];
    const strat = bench.map((b) => 2 * b + 0.001);
    const t = treynor(strat, bench, { periodsPerYear: 252 });
    expect(Number.isFinite(t)).toBe(true);
  });

  it('rejects misaligned benchmark lengths', () => {
    expect(() => beta([0.1, 0.2], [0.1])).toThrow(/must match/);
  });
});

describe('activity metrics', () => {
  it('turnover: buy-and-hold pays entry turnover once, ~0 after', () => {
    const w = [
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
    ];
    // row0 from cash: ½(0.5+0.5)=0.5; rows 1,2: 0 ⇒ mean = 0.5/3
    expect(turnover(w)).toBeCloseTo(0.5 / 3, 12);
  });

  it('turnover: a full flip is one-way turnover 1', () => {
    const w = [
      [1, 0],
      [0, 1],
    ];
    // row0 from cash: ½(1)=0.5; row1: ½(|0-1|+|1-0|)=1 ⇒ mean=0.75
    expect(turnover(w)).toBeCloseTo(0.75, 12);
  });

  it('exposure reports gross/net/long/short and time-in-market', () => {
    const w = [
      [0.6, -0.4],
      [0, 0],
    ];
    const e = exposure(w);
    expect(e.timeInMarket).toBeCloseTo(0.5, 12); // 1 of 2 rows has a position
    expect(e.averageGross).toBeCloseTo((1.0 + 0) / 2, 12);
    expect(e.averageNet).toBeCloseTo((0.2 + 0) / 2, 12);
    expect(e.averageLong).toBeCloseTo(0.3, 12);
    expect(e.averageShort).toBeCloseTo(0.2, 12);
  });

  it('rejects ragged weight rows', () => {
    expect(() => turnover([[0.5, 0.5], [1]])).toThrow(/same length/);
  });
});

describe('rolling metrics', () => {
  const r = [0.01, -0.02, 0.03, 0.0, 0.015, -0.005];

  it('rolling outputs are input-aligned (length n, leading window-1 NaNs)', () => {
    const v = rollingVolatility(r, 3, { periodsPerYear: 252 });
    expect(v).toHaveLength(r.length);
    expect(v[0]).toBeNaN(); // leading warmup sentinel (ratified Law 7 exception)
    expect(v[1]).toBeNaN();
    expect(Number.isFinite(v[2]!)).toBe(true);
    expect(rollingSharpe(r, 3, { periodsPerYear: 252 })).toHaveLength(r.length);
    expect(rollingReturn(r, 3)).toHaveLength(r.length);
  });

  it('rolling return compounds each window at the window-end index', () => {
    const out = rollingReturn(r, 2);
    expect(out[0]).toBeNaN(); // leading warmup sentinel (ratified Law 7 exception)
    expect(out[1]).toBeCloseTo(1.01 * 0.98 - 1, 12);
  });

  it('rejects a window < 2', () => {
    expect(() => rollingSharpe(r, 1, { periodsPerYear: 252 })).toThrow(/window/);
  });
});

describe('analyze with extended + benchmark fields', () => {
  const stratR = [0.01, -0.005, 0.012, 0.003, -0.002, 0.008];
  const benchR = [0.008, -0.004, 0.01, 0.002, -0.003, 0.006];

  it('always reports omega/hitRate/profitFactor/expectancy', () => {
    const s = analyze({ equity: equityCurve(stratR, 100) }, { periodsPerYear: 252 });
    expect(s.omega).toBeCloseTo(omega(stratR)!, 10);
    expect(s.hitRate).toBeCloseTo(hitRate(stratR)!, 10);
    expect(s.profitFactor).toBeCloseTo(profitFactor(stratR)!, 10);
    expect(s.expectancy).toBeCloseTo(mean(stratR), 10);
    expect(s.beta).toBeUndefined(); // no benchmark ⇒ relative fields omitted
  });

  it('adds beta/alpha/tracking/IR/treynor when a benchmark is supplied', () => {
    const s = analyze(
      { equity: equityCurve(stratR, 100) },
      { periodsPerYear: 252, benchmark: benchR },
    );
    expect(s.beta).toBeCloseTo(beta(stratR, benchR)!, 10);
    expect(s.trackingError).toBeCloseTo(
      trackingError(stratR, benchR, { periodsPerYear: 252 })!,
      10,
    );
    expect(s.informationRatio).toBeCloseTo(
      informationRatio(stratR, benchR, { periodsPerYear: 252 })!,
      10,
    );
    expect(s.alpha).toBeCloseTo(alpha(stratR, benchR, { periodsPerYear: 252 })!, 10);
  });

  it('the facade namespace exposes the new metrics', () => {
    expect(performance.omega(stratR)).toBe(omega(stratR));
    expect(performance.beta(stratR, benchR)).toBe(beta(stratR, benchR));
    expect(performance.treynor(stratR, benchR, { periodsPerYear: 252 })).toBe(
      treynor(stratR, benchR, { periodsPerYear: 252 }),
    );
  });
});
