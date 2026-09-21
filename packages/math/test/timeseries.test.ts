import { describe, expect, it } from 'vitest';
import {
  acf,
  augmentedDickeyFullerTest,
  engleGranger,
  hurstExponent,
  kpssTest,
  ljungBox,
  mulberry32,
  normalInverseCdf,
  ols,
  ouHalfLife,
  pacf,
} from '@totalfinance/math';

/**
 * Goldens policy (spec §9.1 asks for statsmodels fixtures). This suite does NOT ship fabricated
 * statsmodels/`arch` vectors — we cannot execute Python in this environment, and inventing reference
 * numbers would violate design law #4 ("never fabricate"). Instead every statistic is pinned by:
 *   1. an EXACT closed-form golden hand-derived in the test (acf/pacf/Ljung–Box/OU half-life), or
 *   2. an INDEPENDENT-computation consistency check (the ADF t-ratio recomputed from `ols` directly),
 *      or
 *   3. a DETERMINISTIC property/ordering test on a seeded series (unit-root vs stationary, cointegrated
 *      vs not, persistent vs random-walk Hurst).
 * These pin the arithmetic precisely where a closed form exists and pin behaviour where it does not.
 */

/** Deterministic standard-normal draws from a seeded generator (no clock, reproducible). */
function normals(n: number, seed: number): number[] {
  const randomNumberGenerator = mulberry32(seed);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = normalInverseCdf(randomNumberGenerator.next());
  return out;
}

describe('acf — biased sample autocorrelation (exact golden)', () => {
  // x = [1,2,3,4,5], mean 3, deviations [-2,-1,0,1,2], c0 = 10/5 = 2.
  // c1 = (2+0+0+2)/5 = 0.8 → ρ1 = 0.4; c2 = (0−1+0)/5 = −0.2 → ρ2 = −0.1;
  // c3 = (−2−2)/5 = −0.8 → ρ3 = −0.4; c4 = (−4)/5 = −0.8 → ρ4 = −0.4.
  const x = [1, 2, 3, 4, 5];

  it('matches the hand-computed ACF vector', () => {
    const r = acf(x, 4);
    expect(r[0]).toBe(1);
    expect(r[1]).toBeCloseTo(0.4, 12);
    expect(r[2]).toBeCloseTo(-0.1, 12);
    expect(r[3]).toBeCloseTo(-0.4, 12);
    expect(r[4]).toBeCloseTo(-0.4, 12);
  });

  it('rejects an out-of-range lag rather than returning garbage', () => {
    expect(() => acf(x, 5)).toThrow();
    expect(() => acf(x, -1)).toThrow();
  });
});

describe('pacf — Durbin–Levinson (exact golden)', () => {
  // From the ACF above: φ11 = ρ1 = 0.4; v1 = 1 − 0.16 = 0.84;
  // φ22 = (ρ2 − φ11·ρ1)/v1 = (−0.1 − 0.16)/0.84 = −0.26/0.84 = −0.3095238…
  const x = [1, 2, 3, 4, 5];

  it('first two partial autocorrelations match the recursion by hand', () => {
    const p = pacf(x, 2);
    expect(p[0]).toBe(1);
    expect(p[1]).toBeCloseTo(0.4, 12); // φ11 = ρ1
    expect(p[2]).toBeCloseTo(-0.26 / 0.84, 12);
  });
});

describe('ljungBox — portmanteau statistic (exact golden vs χ²(2) closed form)', () => {
  // Q = N(N+2)·Σ ρ²ₖ/(N−k) = 5·7·(0.16/4 + 0.01/3) = 35·0.043333… = 1.5166667.
  // χ²(2) survival is the closed form e^(−Q/2), so the exact chi-square CDF must reproduce it.
  const x = [1, 2, 3, 4, 5];

  it('statistic and p-value match the hand computation', () => {
    const res = ljungBox(x, 2);
    const expected = 35 * (0.16 / 4 + 0.01 / 3);
    expect(res.statistic).toBeCloseTo(expected, 10);
    expect(res.pValue!).toBeCloseTo(Math.exp(-expected / 2), 10);
    expect(res.method).toContain('Ljung-Box');
  });

  it('flags strong autocorrelation with a tiny p-value', () => {
    // A clean linear ramp is heavily autocorrelated ⇒ large Q, small p.
    const ramp = Array.from({ length: 60 }, (_, i) => i);
    const res = ljungBox(ramp, 10);
    expect(res.pValue!).toBeLessThan(0.01);
  });
});

describe('augmentedDickeyFullerTest — augmented Dickey–Fuller', () => {
  it('t-ratio equals an independent OLS of Δy on [y₋₁, const] (consistency golden)', () => {
    const x = normals(120, 7).reduce<number[]>((acc, e, i) => {
      acc.push(i === 0 ? e : acc[i - 1]! + e); // random walk
      return acc;
    }, []);
    const adf = augmentedDickeyFullerTest(x, { regression: 'c', lags: 0 });

    // Rebuild the DF regression by hand: Δyₜ = a + ρ·y_{t−1}.
    const dy: number[] = [];
    const lagged: number[][] = [];
    for (let t = 1; t < x.length; t++) {
      dy.push(x[t]! - x[t - 1]!);
      lagged.push([x[t - 1]!]);
    }
    const fit = ols(dy, lagged, { intercept: true });
    expect(adf.statistic).toBeCloseTo(fit.tStatistics[1]!, 10);
    expect(adf.criticalValues).toEqual({ '1%': -3.43, '5%': -2.86, '10%': -2.57 });
    expect(adf.pValue!).toBeGreaterThanOrEqual(0);
    expect(adf.pValue!).toBeLessThanOrEqual(1);
  });

  it('rejects the unit root for a stationary AR(1) but not for a random walk', () => {
    const e = normals(400, 11);
    // Stationary AR(1): xₜ = 0.2·x_{t−1} + εₜ (mean-reverting).
    const stationary: number[] = [0];
    for (let t = 1; t < e.length; t++) stationary.push(0.2 * stationary[t - 1]! + e[t]!);
    // Unit root: xₜ = x_{t−1} + εₜ.
    const walk: number[] = [0];
    for (let t = 1; t < e.length; t++) walk.push(walk[t - 1]! + e[t]!);

    const adfStat = augmentedDickeyFullerTest(stationary, { regression: 'c' });
    const adfWalk = augmentedDickeyFullerTest(walk, { regression: 'c' });
    expect(adfStat.statistic).toBeLessThan(adfStat.criticalValues!['5%']); // reject unit root
    expect(adfWalk.statistic).toBeGreaterThan(adfWalk.criticalValues!['10%']); // fail to reject
  });

  it('supports the trend variant and augmenting lags', () => {
    const x = normals(200, 3).map((_, i, arr) => arr.slice(0, i + 1).reduce((s, v) => s + v, 0));
    const res = augmentedDickeyFullerTest(x, { regression: 'ct', lags: 2 });
    expect(res.criticalValues).toEqual({ '1%': -3.96, '5%': -3.41, '10%': -3.12 });
    expect(res.method).toContain('ct');
    expect(Number.isFinite(res.statistic)).toBe(true);
  });
});

describe('kpssTest — stationarity null (inverts ADF)', () => {
  it('does not reject a white-noise level but rejects a random walk', () => {
    const noise = normals(300, 21); // stationary around 0
    const walk: number[] = [0];
    const e = normals(300, 22);
    for (let t = 1; t < e.length; t++) walk.push(walk[t - 1]! + e[t]!);

    const kNoise = kpssTest(noise, { regression: 'c' });
    const kWalk = kpssTest(walk, { regression: 'c' });
    expect(kNoise.statistic).toBeLessThan(kNoise.criticalValues!['5%']); // stationary: keep the null
    expect(kWalk.statistic).toBeGreaterThan(kWalk.criticalValues!['1%']); // walk: reject stationarity
    expect(kNoise.method).toContain('KPSS');
  });
});

describe('engleGranger — two-step cointegration', () => {
  it('detects a genuine cointegrating relation and recovers β', () => {
    const e = normals(300, 31);
    const x: number[] = [0];
    for (let t = 1; t < e.length; t++) x.push(x[t - 1]! + e[t]!); // I(1) driver
    const noise = normals(300, 32);
    const y = x.map((v, i) => 5 + 2 * v + 0.25 * noise[i]!); // y = 5 + 2x + stationary resid

    const res = engleGranger(y, x);
    expect(res.beta).toBeCloseTo(2, 1);
    expect(res.alpha).toBeCloseTo(5, 0);
    expect(res.cointegrated).toBe(true);
  });

  it('does not flag two independent random walks as cointegrated', () => {
    const ea = normals(300, 41);
    const eb = normals(300, 42);
    const a: number[] = [0];
    const b: number[] = [0];
    for (let t = 1; t < ea.length; t++) {
      a.push(a[t - 1]! + ea[t]!);
      b.push(b[t - 1]! + eb[t]!);
    }
    expect(engleGranger(a, b).cointegrated).toBe(false);
  });

  // Regression for an external-review finding: the residual test EXPOSED ordinary ADF critical values
  // (−2.86 at 5%) and their p-value, even though the residuals were estimated. It must report the
  // Engle–Granger residual-based distribution (−3.34 at 5%) so the exposed significance matches the test.
  it('exposes Engle–Granger residual critical values, not the raw ADF table', () => {
    const e = normals(120, 71);
    const x: number[] = [0];
    for (let t = 1; t < e.length; t++) x.push(x[t - 1]! + e[t]!);
    const noise = normals(120, 72);
    const y = x.map((v, i) => 1 + 1.5 * v + 0.2 * noise[i]!);
    const res = engleGranger(y, x);
    expect(res.residualAugmentedDickeyFuller.criticalValues).toEqual({
      '1%': -3.9,
      '5%': -3.34,
      '10%': -3.04,
    });
    expect(res.residualAugmentedDickeyFuller.method).toMatch(/Engle–Granger/);
    // The decision boolean agrees with the exposed 5% critical value.
    expect(res.cointegrated).toBe(
      res.residualAugmentedDickeyFuller.statistic <
        res.residualAugmentedDickeyFuller.criticalValues!['5%'],
    );
  });
});

describe('hurstExponent — rescaled-range analysis (on a returns/increment series)', () => {
  it('orders anti-persistent < iid (≈ 0.5) < persistent', () => {
    // R/S is computed on the input as given; the "0.5 = random walk" reading is for an increment
    // series, so pass returns. iid ⇒ H ≈ 0.5; AR(1) φ>0 ⇒ persistent (H>0.5); φ<0 ⇒ anti (H<0.5).
    const e = normals(2048, 51);
    const persistent: number[] = [e[0]!];
    const anti: number[] = [e[0]!];
    for (let t = 1; t < e.length; t++) {
      persistent.push(0.6 * persistent[t - 1]! + e[t]!);
      anti.push(-0.6 * anti[t - 1]! + e[t]!);
    }
    const hIid = hurstExponent(e);
    const hPersist = hurstExponent(persistent);
    const hAnti = hurstExponent(anti);

    expect(hIid).toBeGreaterThan(0.4);
    expect(hIid).toBeLessThan(0.65);
    expect(hAnti).toBeLessThan(hIid);
    expect(hPersist).toBeGreaterThan(hIid);
  });

  it('reports H ≈ 1 for an integrated (random-walk level) series', () => {
    const e = normals(2048, 53);
    const walk: number[] = [e[0]!];
    for (let t = 1; t < e.length; t++) walk.push(walk[t - 1]! + e[t]!);
    expect(hurstExponent(walk)).toBeGreaterThan(0.85);
  });

  it('requires at least 32 observations (two dyadic windows)', () => {
    expect(() => hurstExponent(normals(31, 1))).toThrow();
  });
});

describe('ouHalfLife — AR(1) mean-reversion speed (exact goldens)', () => {
  it('recovers halfLife = −ln2/ln b for a noiseless geometric decay', () => {
    // xₜ = 0.5·x_{t−1} exactly ⇒ b = 0.5, halfLife = −ln2/ln0.5 = 1.
    const half = Array.from({ length: 12 }, (_, i) => 100 * Math.pow(0.5, i));
    expect(ouHalfLife(half)).toBeCloseTo(1, 9);

    // b = 0.9 ⇒ halfLife = −ln2/ln0.9 ≈ 6.5788.
    const slow = Array.from({ length: 12 }, (_, i) => 100 * Math.pow(0.9, i));
    expect(ouHalfLife(slow)).toBeCloseTo(-Math.LN2 / Math.log(0.9), 8);
  });

  it('returns NaN when the AR(1) coefficient is non-positive (no reversion defined)', () => {
    // Alternating sign ⇒ b < 0.
    const alt = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    expect(Number.isNaN(ouHalfLife(alt))).toBe(true);
  });
});
