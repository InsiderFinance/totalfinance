import { describe, expect, it } from 'vitest';
import { type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { type Pair, pairs } from '@totalfinance/technical-analysis/statistics';

describe('paired rolling regression', () => {
  const x = [1, 2, 3, 4, 5];
  const y = [2, 4, 6, 8, 10]; // y = 2x → perfect linear fit
  const p = pairs(x, y);

  it('covariance (sample) is the unbiased covariance (closed form)', () => {
    // covPop = 4, sample = 4·5/4 = 5
    expect(ta.covariance(p, { period: 5 }).at(-1)!).toBeCloseTo(5, 9);
    expect(ta.covariance(p, { period: 5, sample: false }).at(-1)!).toBeCloseTo(4, 9);
  });
  it('rSquared is 1 on a perfect linear relationship', () => {
    expect(ta.rSquared(p, { period: 5 }).at(-1)!).toBeCloseTo(1, 12);
  });
  it('rollingRegression returns slope/intercept/rSquared (closed form)', () => {
    const r = ta.rollingRegression(p, { period: 5 }).at(-1)!;
    expect(r.slope).toBeCloseTo(2, 9);
    expect(r.intercept).toBeCloseTo(0, 9);
    expect(r.rSquared).toBeCloseTo(1, 12);
  });
  it('rSquared is below 1 for an imperfect relationship', () => {
    const noisy = pairs([1, 2, 3, 4, 5], [2, 5, 5, 9, 10]);
    expect(ta.rSquared(noisy, { period: 5 }).at(-1)!).toBeLessThan(1);
  });
});

describe('pair statistics on price-level inputs (centered moments)', () => {
  // The one-pass Σx²/n − x̄² cancelled to rounding noise on price levels.
  const ramp = Array.from({ length: 20 }, (_, i) => 100 + i);
  const flat = Array<number>(20).fill(0.1);

  it('a flat window is degenerate: zero slope, rSquared, covariance and correlation', () => {
    // A flat x regressed to slope −1024 before.
    expect(ta.rollingRegression(pairs(flat, ramp), { period: 20 }).at(-1)!.slope).toBe(0);
    expect(ta.rSquared(pairs(ramp, flat), { period: 20 }).at(-1)).toBe(0);
    expect(ta.covariance(pairs(flat, ramp), { period: 20 }).at(-1)).toBe(0);
    expect(ta.correl(pairs(Array(20).fill(4321.37), ramp), { period: 20 }).at(-1)).toBe(0);
    // …and a flat 0.07 window correlated to NaN.
    expect(ta.correl(pairs(Array(20).fill(0.07), ramp), { period: 20 }).at(-1)).toBe(0);
  });

  it('perfect relationships stay inside the correlation and r-squared bounds', () => {
    expect(ta.correl(pairs([100, 103], [100, 103]), { period: 2 }).at(-1)).toBe(1);
    expect(ta.correl(pairs([100, 103], [-100, -103]), { period: 2 }).at(-1)).toBe(-1);
    // Rounding put ≈26% of these one ULP outside the bounds (Math.acos(r) → NaN).
    for (let k = 0; k < 400; k++) {
      const n = 2 + (k % 6);
      const x = Array.from({ length: n }, (_, i) => 100 + ((i * 37 + k * 11) % 97) / 7);
      for (const scale of [1, 2, -1, 0.5, 3]) {
        const p = pairs(
          x,
          x.map((v) => v * scale),
        );
        expect(Math.abs(ta.correl(p, { period: n }).at(-1)!)).toBeLessThanOrEqual(1);
        expect(ta.rSquared(p, { period: n }).at(-1)!).toBeLessThanOrEqual(1);
        expect(ta.rollingRegression(p, { period: n }).at(-1)!.rSquared).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(ta.cti(x, { period: n }).at(-1)!)).toBeLessThanOrEqual(1);
    }
  });

  it('matches a centered reference on a large offset with tick-size moves', () => {
    const x = Array.from({ length: 30 }, (_, i) => 98_765.43 + 0.01 * Math.sin(i * 1.7));
    const y = x.map((v, i) => v + 0.003 * Math.cos(i * 2.3));
    // Deviations from the leading price are exact, then centered by the mean.
    const dx = x.map((v) => v - x[0]!);
    const dy = y.map((v) => v - y[0]!);
    const mx = dx.reduce((a, b) => a + b) / 30;
    const my = dy.reduce((a, b) => a + b) / 30;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = 0; i < 30; i++) {
      sxx += (dx[i]! - mx) ** 2;
      syy += (dy[i]! - my) ** 2;
      sxy += (dx[i]! - mx) * (dy[i]! - my);
    }
    const p = pairs(x, y);
    const regression = ta.rollingRegression(p, { period: 30 }).at(-1)!;
    // Before: slope 1.0417 vs 0.9873, correl 0.9823 vs 0.9562, covariance off by 2%.
    expect(regression.slope).toBeCloseTo(sxy / sxx, 9);
    expect(regression.rSquared).toBeCloseTo((sxy * sxy) / (sxx * syy), 9);
    expect(ta.correl(p, { period: 30 }).at(-1)!).toBeCloseTo(sxy / Math.sqrt(sxx * syy), 9);
    expect(ta.covariance(p, { period: 30, sample: false }).at(-1)! / (sxy / 30)).toBeCloseTo(1, 9);
  });
});

describe('barSince / valueWhen', () => {
  it('barSince counts bars since the last true condition (closed form)', () => {
    expect(ta.barSince([0, 1, 0, 0, 1, 0], {})).toEqual([NaN, 0, 1, 2, 0, 1]);
  });
  it('valueWhen returns the source at the last true (occurrence 0)', () => {
    const cond = [0, 1, 0, 1, 0];
    const src = [10, 20, 30, 40, 50];
    expect(ta.valueWhen(pairs(cond, src), {})).toEqual([NaN, 20, 20, 40, 40]);
  });
  it('valueWhen with occurrence 1 returns the prior true', () => {
    const cond = [0, 1, 0, 1, 0];
    const src = [10, 20, 30, 40, 50];
    expect(ta.valueWhen(pairs(cond, src), { occurrence: 1 })).toEqual([NaN, NaN, NaN, 20, 20]);
  });
});

describe('aliases', () => {
  const s = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const p = pairs(
    s,
    s.map((v, i) => v + Math.cos(i / 2) * 3),
  );
  it('rollingMean = sma, rollingBeta = beta, rollingCorrelation = correl', () => {
    expect(ta.rollingMean(s, { period: 10 })).toEqual(ta.sma(s, { period: 10 }));
    expect(ta.rollingBeta(p, { period: 10 })).toEqual(ta.beta(p, { period: 10 }));
    expect(ta.rollingCorrelation(p, { period: 10 })).toEqual(ta.correl(p, { period: 10 }));
  });
  it('highestBars = rollingMaxIndex, lowestBars = rollingMinIndex', () => {
    expect(ta.highestBars(s, { period: 10 })).toEqual(ta.rollingMaxIndex(s, { period: 10 }));
    expect(ta.lowestBars(s, { period: 10 })).toEqual(ta.rollingMinIndex(s, { period: 10 }));
  });
});

describe('features-ext slice-3 parity & snapshots', () => {
  const xs = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 4) * 10 + i * 0.1);
  const ys = xs.map((v, i) => 0.5 * v + Math.cos(i / 3) * 4);
  const ps = pairs(xs, ys);
  const cond = Array.from({ length: 80 }, (_, i) => Math.sin(i / 5)); // x>0 ~half the time
  const condPairs = pairs(cond, xs);
  const boolSeries = Array.from({ length: 80 }, (_, i) => (i % 4 === 0 ? 1 : 0));

  it('pair indicators match their streams', () => {
    const cases: [
      Indicator<Record<string, unknown>, Pair, unknown>,
      Record<string, unknown>,
      Pair[],
    ][] = [
      [ta.covariance as never, { period: 20 }, ps],
      [ta.rSquared as never, { period: 20 }, ps],
      [ta.rollingRegression as never, { period: 20 }, ps],
      [ta.valueWhen as never, { occurrence: 1 }, condPairs],
    ];
    for (const [ind, parameters, data] of cases) {
      const batch = ind.explain(data, parameters);
      const stream = ind.stream(parameters);
      for (let i = 0; i < data.length; i++) {
        const e = stream.next(data[i]!);
        if (i < batch.diagnostics.warmup) expect(e).toBeNull();
        else expect(e).toEqual(batch.value[i]);
      }
    }
  });
  it('barSince matches its stream', () => {
    const batch = ta.barSince.explain(boolSeries, {});
    const stream = ta.barSince.stream({});
    for (let i = 0; i < boolSeries.length; i++) {
      const e = stream.next(boolSeries[i]!);
      if (i < batch.diagnostics.warmup) expect(e).toBeNull();
      else expect(e).toEqual(batch.value[i]);
    }
  });
  it('rollingRegression and valueWhen round-trip mid-stream', () => {
    const refR = ta.rollingRegression.stream({ period: 20 });
    const expR = ps.map((p) => refR.next(p));
    const partR = ta.rollingRegression.stream({ period: 20 });
    for (let i = 0; i < 40; i++) partR.next(ps[i]!);
    const restoredR = ta.rollingRegression.fromJSON(JSON.parse(JSON.stringify(partR.toJSON())));
    for (let i = 40; i < ps.length; i++) expect(restoredR.next(ps[i]!)).toEqual(expR[i]);

    const refV = ta.valueWhen.stream({ occurrence: 1 });
    const expV = condPairs.map((p) => refV.next(p));
    const partV = ta.valueWhen.stream({ occurrence: 1 });
    for (let i = 0; i < 40; i++) partV.next(condPairs[i]!);
    const restoredV = ta.valueWhen.fromJSON(JSON.parse(JSON.stringify(partV.toJSON())));
    for (let i = 40; i < condPairs.length; i++)
      expect(restoredV.next(condPairs[i]!)).toEqual(expV[i]);
  });
});
