/**
 * Time-series diagnostics (spec §9.1): autocorrelation, unit-root / stationarity tests, cointegration,
 * long-memory, and mean-reversion speed.
 *
 * Every test statistic is returned in ONE shape ({@link TestResult}) so callers branch uniformly:
 * `{ statistic, pValue?, criticalValues?, method }`.
 *
 * Honesty notes on the reference distributions:
 *   - `augmentedDickeyFullerTest` reports the standard asymptotic Dickey–Fuller critical values (constant `'c'` and
 *     constant+trend `'ct'` variants). The `pValue` is an APPROXIMATION: a monotone quadratic
 *     interpolation of the statistic across the tabulated critical values in probit space. It is a
 *     coarse stand-in for MacKinnon's (1994) response-surface p-value and should be treated as
 *     indicative, not exact. The reject/accept decision should use `criticalValues` directly.
 *   - `kpssTest` reports the KPSS (1992) asymptotic critical values (its null is stationarity, so the
 *     decision inverts ADF). Its `pValue` uses the same interpolation caveat.
 *   - `ljungBox` p-values are exact given the χ² reference (chi-square survival from `./distributions`).
 */

import { ensureKnownKeys, requireArgumentObject, ErrorCode, InputError } from '@totalfinance/core';
import { chiSquare } from './distributions.js';
import { normalCdf, normalInverseCdf } from './normal.js';
import { ols } from './regression.js';

/** Uniform result shape for every hypothesis test in this module. */
export interface TestResult {
  /** The test statistic. */
  statistic: number;
  /** Approximate (or, for Ljung–Box, exact) p-value, when defined. */
  pValue?: number;
  /** Asymptotic critical values at the 1% / 5% / 10% levels, when the test tabulates them. */
  criticalValues?: { '1%': number; '5%': number; '10%': number };
  /** Human-readable identifier of the test and its configuration. */
  method: string;
}

// ───────────────────────── autocorrelation ─────────────────────────

function requireSeries(x: number[], minLen: number, functionName: string): void {
  if (x.length < minLen) {
    throw new InputError(
      `${functionName}: series must have at least ${minLen} observations, got ${x.length}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { length: x.length, minLength: minLen },
      },
    );
  }
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]!)) {
      throw new InputError(`${functionName}: series contains a non-finite value at index ${i}.`, {
        code: ErrorCode.InputNotFinite,
        context: { index: i, value: x[i] },
      });
    }
  }
}

function seriesMean(x: number[]): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]!;
  return s / x.length;
}

/**
 * Sample autocorrelation function through `maxLag`, using the biased (÷N) estimator that guarantees a
 * positive-semidefinite sequence. Returns `[1, ρ₁, …, ρ_maxLag]` — index 0 is lag 0 and equals 1 exactly.
 */
export function acf(series: number[], maxLag: number): number[] {
  requireSeries(series, 2, 'acf');
  // Safe integer (2026-08-23 review, P0): the lag loop is data-bounded by the same-line
  // `maxLag >= series.length` check, but the integer test itself must reject values past 2^53 for
  // the reason it exists at all — exactness (its acceptance is what let 1e308 count as an "integer").
  if (!Number.isSafeInteger(maxLag) || maxLag < 0 || maxLag >= series.length) {
    throw new InputError(
      `acf: maxLag must be an integer in [0, ${series.length - 1}], got ${maxLag}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { maxLag, length: series.length },
      },
    );
  }
  const n = series.length;
  const mu = seriesMean(series);
  const dev = series.map((v) => v - mu);
  let c0 = 0;
  for (let i = 0; i < n; i++) c0 += dev[i]! * dev[i]!;
  c0 /= n;
  const out = new Array<number>(maxLag + 1);
  out[0] = 1;
  for (let k = 1; k <= maxLag; k++) {
    let ck = 0;
    for (let t = 0; t < n - k; t++) ck += dev[t]! * dev[t + k]!;
    ck /= n;
    out[k] = c0 > 0 ? ck / c0 : 0;
  }
  return out;
}

/**
 * Partial autocorrelation function through `maxLag` via the Durbin–Levinson recursion on the sample
 * ACF. Returns `[1, φ₁₁, …, φ_maxLag,maxLag]` (index 0 = 1 by convention).
 */
export function pacf(series: number[], maxLag: number): number[] {
  requireSeries(series, 2, 'pacf');
  // Safe integer (2026-08-23 review, P0): data-bounded by `maxLag >= series.length`; see acf.
  if (!Number.isSafeInteger(maxLag) || maxLag < 0 || maxLag >= series.length) {
    throw new InputError(
      `pacf: maxLag must be an integer in [0, ${series.length - 1}], got ${maxLag}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { maxLag, length: series.length },
      },
    );
  }
  const rho = acf(series, maxLag);
  const pac = new Array<number>(maxLag + 1);
  pac[0] = 1;
  if (maxLag === 0) return pac;
  // Durbin–Levinson: φ_{k,k} is the reflection coefficient at order k.
  let phi = new Array<number>(maxLag + 1).fill(0);
  phi[1] = rho[1]!;
  pac[1] = rho[1]!;
  let v = 1 - rho[1]! * rho[1]!;
  for (let k = 2; k <= maxLag; k++) {
    let num = rho[k]!;
    for (let j = 1; j < k; j++) num -= phi[j]! * rho[k - j]!;
    const reflect = v > 0 ? num / v : 0;
    const next = phi.slice();
    next[k] = reflect;
    for (let j = 1; j < k; j++) next[j] = phi[j]! - reflect * phi[k - j]!;
    phi = next;
    pac[k] = reflect;
    v *= 1 - reflect * reflect;
  }
  return pac;
}

// ───────────────────────── Ljung–Box ─────────────────────────

export interface LjungBoxOptions {
  /**
   * Number of parameters ESTIMATED from the same series before the test (e.g. `p + q` for the
   * residuals of an ARMA(p, q) fit). The reference distribution loses one degree of freedom per
   * fitted parameter: `Q ~ χ²(lags − fittedParameterCount)`. Default 0 — the raw white-noise null,
   * which is the right reference only for a series that was NOT fitted.
   */
  fittedParameterCount?: number;
}

/**
 * Ljung–Box portmanteau test for autocorrelation up to `lags`:
 * `Q = N(N+2) Σ_{k=1}^{h} ρ̂ₖ² / (N−k)`, distributed `χ²(h)` under the white-noise null. The p-value is
 * the exact chi-square survival function.
 *
 * On ARMA RESIDUALS the white-noise null is the wrong reference: fitting `p + q` parameters to the
 * same data absorbs autocorrelation the statistic then fails to see, so `χ²(h)` is too conservative
 * and the test under-rejects. Pass `fittedParameterCount` to use the standard corrected reference
 * `χ²(h − p − q)` (Box–Jenkins); the returned `method` discloses the degrees of freedom actually
 * used. The statistic itself is unchanged — only the reference distribution moves.
 */
export function ljungBox(
  series: number[],
  lags: number,
  options: LjungBoxOptions = {},
): TestResult {
  requireSeries(series, 2, 'ljungBox');
  // Safe integer (2026-08-23 review, P0): data-bounded by `lags >= series.length`; see acf.
  if (!Number.isSafeInteger(lags) || lags < 1 || lags >= series.length) {
    throw new InputError(
      `ljungBox: lags must be an integer in [1, ${series.length - 1}], got ${lags}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { lags, length: series.length },
      },
    );
  }
  requireArgumentObject('ljungBox', 'options', options);
  ensureKnownKeys('ljungBox', 'options', options, ['fittedParameterCount']);
  if (options.fittedParameterCount === null) {
    throw new InputError(
      'ljungBox: fittedParameterCount must not be null — omit the field to use the raw white-noise null. Received null.',
      { code: ErrorCode.InputWrongType, context: { field: 'fittedParameterCount' } },
    );
  }
  const fitted = options.fittedParameterCount ?? 0;
  // Safe integer (2026-08-23 review, P0): bounded by `fitted >= lags` (itself data-bounded above).
  if (!Number.isSafeInteger(fitted) || fitted < 0 || fitted >= lags) {
    throw new InputError(
      `ljungBox: fittedParameterCount must be an integer in [0, ${lags - 1}] (the χ² reference has lags − fittedParameterCount degrees of freedom, which must stay ≥ 1), got ${fitted}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { fittedParameterCount: fitted, lags },
      },
    );
  }
  const n = series.length;
  const rho = acf(series, lags);
  let q = 0;
  for (let k = 1; k <= lags; k++) {
    const r = rho[k]!;
    q += (r * r) / (n - k);
  }
  q *= n * (n + 2);
  const degreesOfFreedom = lags - fitted;
  const pValue = 1 - chiSquare.cdf(q, degreesOfFreedom);
  const method =
    fitted === 0
      ? `Ljung-Box (lags=${lags})`
      : `Ljung-Box (lags=${lags}, fittedParameterCount=${fitted}, dof=${degreesOfFreedom})`;
  return { statistic: q, pValue, method };
}

// ───────────────────────── p-value interpolation ─────────────────────────

/**
 * Approximate a p-value by interpolating the statistic across tabulated `(statistic, probability)`
 * anchors in probit space (`z = Φ⁻¹(p)`), then mapping back with `Φ`. The interpolation is
 * piecewise-linear in `z` through the critical-value anchors, with linear extrapolation beyond the
 * outermost anchors — monotone by construction, reproducing the anchors exactly. It is a coarse
 * stand-in for a full response-surface p-value (see the module header), not a substitute for it.
 */
function probitInterpPValue(stat: number, anchors: Array<[number, number]>): number {
  // Sort ascending by statistic and map probabilities into probit space.
  const zs = anchors
    .map(([s, p]) => [s, normalInverseCdf(p)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const m = zs.length;
  const lerp = (s0: number, z0: number, s1: number, z1: number): number =>
    z0 + ((z1 - z0) * (stat - s0)) / (s1 - s0);
  let z: number;
  if (stat <= zs[0]![0]) {
    z = lerp(zs[0]![0], zs[0]![1], zs[1]![0], zs[1]![1]); // extrapolate on the first segment
  } else if (stat >= zs[m - 1]![0]) {
    z = lerp(zs[m - 2]![0], zs[m - 2]![1], zs[m - 1]![0], zs[m - 1]![1]); // last segment
  } else {
    let i = 0;
    while (i < m - 1 && stat > zs[i + 1]![0]) i += 1;
    z = lerp(zs[i]![0], zs[i]![1], zs[i + 1]![0], zs[i + 1]![1]);
  }
  return Math.min(1, Math.max(0, normalCdf(z)));
}

// ───────────────────────── ADF ─────────────────────────

/**
 * Standard asymptotic Dickey–Fuller critical values for the τ statistic (constant, and constant+trend).
 * These are the widely tabulated large-sample values (Fuller 1976 / MacKinnon 1994 response surface at
 * `T → ∞`).
 */
const ADF_CV = {
  c: { '1%': -3.43, '5%': -2.86, '10%': -2.57 },
  ct: { '1%': -3.96, '5%': -3.41, '10%': -3.12 },
} as const;

export interface AugmentedDickeyFullerOptions {
  /** Deterministic terms: `'c'` = constant (default), `'ct'` = constant + linear trend. */
  regression?: 'c' | 'ct';
  /** Number of augmenting lagged differences (default 0 ⇒ plain Dickey–Fuller). */
  lags?: number;
}

/**
 * Augmented Dickey–Fuller test for a unit root. Regresses `Δyₜ` on `y_{t−1}`, a constant (and a trend
 * for `'ct'`), and `lags` lagged differences; the statistic is the t-ratio on `y_{t−1}`. A very negative
 * statistic (below the critical value) rejects the unit-root null in favour of stationarity.
 */
export function augmentedDickeyFullerTest(
  series: number[],
  options: AugmentedDickeyFullerOptions = {},
): TestResult {
  requireArgumentObject('augmentedDickeyFullerTest', 'options', options);
  ensureKnownKeys('augmentedDickeyFullerTest', 'options', options, ['regression', 'lags']);
  if (
    options.regression !== undefined &&
    options.regression !== 'c' &&
    options.regression !== 'ct'
  ) {
    throw new InputError(
      `augmentedDickeyFullerTest: regression must be 'c' | 'ct' when provided. Received ${options.regression === null ? 'null' : JSON.stringify(options.regression)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'regression' } },
    );
  }
  if (
    options.lags !== undefined &&
    (typeof options.lags !== 'number' || !Number.isFinite(options.lags))
  ) {
    throw new InputError(
      `augmentedDickeyFullerTest: lags must be a finite number when provided. Received ${options.lags === null ? 'null' : typeof options.lags}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'lags' } },
    );
  }
  const regression = options.regression ?? 'c';
  const lags = options.lags ?? 0;
  // Safe integer (2026-08-23 review, P0): the design-matrix loops are data-bounded by the
  // `requireSeries(series, 2·lags + 4, …)` row-count check below (an absurd lags demands a series no
  // array can hold and refuses), but the integer test itself must reject values past 2^53 — above
  // that, `2 * lags + 4` and the row indices are no longer exact.
  if (!Number.isSafeInteger(lags) || lags < 0) {
    throw new InputError(
      `augmentedDickeyFullerTest: lags must be a non-negative integer, got ${lags}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { lags },
      },
    );
  }
  /**
   * The regression below has `n − 1 − lags` rows (one per `t` from `lags+1` to `n−1`) and
   * `lags + 2` columns for `'c'` — intercept, the level `y_{t−1}`, and one per lagged difference —
   * plus a trend column for `'ct'`. OLS needs strictly more rows than columns, i.e.
   * `n ≥ 2·lags + 4` (`+5` with the trend). The old `lags + 4` counted the lags once instead of
   * twice, so every `lags ≥ 1` call that was 1–2 observations short passed this guard and died
   * inside `ols` with `needs more observations than coefficients (n=3 ≤ k=3)` — a message about an
   * internal design matrix, from a function the caller never invoked.
   */
  const minLen = 2 * lags + 4 + (regression === 'ct' ? 1 : 0);
  requireSeries(series, minLen, 'augmentedDickeyFullerTest');
  const n = series.length;
  const dy = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) dy[i] = series[i + 1]! - series[i]!;

  const ys: number[] = [];
  const rows: number[][] = [];
  const start = lags + 1; // first t (original index) with all lagged terms defined
  for (let t = start; t <= n - 1; t++) {
    const row: number[] = [series[t - 1]!]; // level y_{t−1}
    for (let j = 1; j <= lags; j++) row.push(dy[t - 1 - j]!); // Δy_{t−j}
    if (regression === 'ct') row.push(t); // linear trend
    rows.push(row);
    ys.push(dy[t - 1]!); // Δyₜ
  }

  const fit = ols(ys, rows, { intercept: true });
  const statistic = fit.tStatistics[1]!; // index 0 = intercept, index 1 = coefficient on y_{t−1}
  const cv = ADF_CV[regression];
  const pValue = probitInterpPValue(statistic, [
    [cv['1%'], 0.01],
    [cv['5%'], 0.05],
    [cv['10%'], 0.1],
  ]);
  return {
    statistic,
    pValue,
    criticalValues: { '1%': cv['1%'], '5%': cv['5%'], '10%': cv['10%'] },
    method: `ADF (${regression}, lags=${lags})`,
  };
}

// ───────────────────────── KPSS ─────────────────────────

/** KPSS (1992) asymptotic critical values (upper tail): level `'c'` and trend `'ct'` stationarity. */
const KPSS_CV = {
  c: { '1%': 0.739, '5%': 0.463, '10%': 0.347 },
  ct: { '1%': 0.216, '5%': 0.146, '10%': 0.119 },
} as const;

export interface KpssOptions {
  /** `'c'` = level stationarity (default), `'ct'` = trend stationarity. */
  regression?: 'c' | 'ct';
}

/** Bartlett-kernel long-run variance of a mean-zero residual series with bandwidth `l`. */
function longRunVariance(e: number[], l: number): number {
  const n = e.length;
  let g0 = 0;
  for (let t = 0; t < n; t++) g0 += e[t]! * e[t]!;
  g0 /= n;
  let s = g0;
  for (let j = 1; j <= l; j++) {
    let gj = 0;
    for (let t = j; t < n; t++) gj += e[t]! * e[t - j]!;
    gj /= n;
    s += 2 * (1 - j / (l + 1)) * gj;
  }
  return s;
}

/**
 * Kwiatkowski–Phillips–Schmidt–Shin (KPSS) stationarity test. The null is (level or trend)
 * stationarity, so a LARGE statistic (above the critical value) rejects stationarity — the mirror image
 * of ADF. The bandwidth for the long-run variance defaults to `⌊4·(T/100)^¼⌋`.
 */
export function kpssTest(series: number[], options: KpssOptions = {}): TestResult {
  requireArgumentObject('kpssTest', 'options', options);
  ensureKnownKeys('kpssTest', 'options', options, ['regression', 'lags']);
  if (
    options.regression !== undefined &&
    options.regression !== 'c' &&
    options.regression !== 'ct'
  ) {
    throw new InputError(
      `kpssTest: regression must be 'c' | 'ct' when provided. Received ${options.regression === null ? 'null' : JSON.stringify(options.regression)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'regression' } },
    );
  }
  const rawLags = (options as Record<string, unknown>)['lags'];
  if (rawLags !== undefined && (typeof rawLags !== 'number' || !Number.isFinite(rawLags))) {
    throw new InputError(
      `kpssTest: lags must be a finite number when provided. Received ${rawLags === null ? 'null' : typeof rawLags}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'lags' } },
    );
  }
  const regression = options.regression ?? 'c';
  requireSeries(series, 4, 'kpssTest');
  const n = series.length;
  // Residuals from the deterministic regression: demean ('c') or detrend ('ct').
  const design: number[][] =
    regression === 'ct' ? series.map((_, i) => [i + 1]) : series.map(() => [] as number[]);
  const fit = ols(series, design, { intercept: true });
  const e = fit.residuals;
  // Partial sums Sₜ = Σ_{i≤t} êᵢ.
  const partial = new Array<number>(n);
  let run = 0;
  let sumSq = 0;
  for (let t = 0; t < n; t++) {
    run += e[t]!;
    partial[t] = run;
    sumSq += run * run;
  }
  const l = Math.floor(4 * Math.pow(n / 100, 0.25));
  const lrv = longRunVariance(e, l);
  const statistic = lrv > 0 ? sumSq / (n * n * lrv) : 0;
  const cv = KPSS_CV[regression];
  // KPSS rejects for large statistics, so the anchor mapping is decreasing in the statistic.
  const pValue = probitInterpPValue(statistic, [
    [cv['1%'], 0.01],
    [cv['5%'], 0.05],
    [cv['10%'], 0.1],
  ]);
  return {
    statistic,
    pValue,
    criticalValues: { '1%': cv['1%'], '5%': cv['5%'], '10%': cv['10%'] },
    method: `KPSS (${regression}, bandwidth=${l})`,
  };
}

// ───────────────────────── Engle–Granger cointegration ─────────────────────────

/**
 * Engle–Granger residual-based cointegration critical values for the ADF τ statistic on ESTIMATED
 * residuals (constant, single regressor / N = 2 variables). These are MacKinnon's asymptotic
 * response-surface values and are materially more negative than the ordinary ADF table, because the
 * residuals were fitted — using the raw ADF critical values here would overstate significance.
 */
const EG_CV = { '1%': -3.9, '5%': -3.34, '10%': -3.04 } as const;

export interface EngleGrangerResult {
  /** Slope of the cointegrating regression `y = α + β·x + resid`. */
  beta: number;
  /** Intercept of the cointegrating regression. */
  alpha: number;
  /** ADF test on the regression residuals (the cointegration test statistic). */
  residualAugmentedDickeyFuller: TestResult;
  /** `true` when the residual ADF statistic falls below the 5% Engle–Granger critical value. */
  cointegrated: boolean;
}

/**
 * Engle–Granger two-step cointegration test. Step 1 regresses `y` on `x` (with intercept); step 2 runs
 * an ADF test on the residuals. Because the residuals are estimated, the decision uses the
 * residual-based Engle–Granger critical value (≈ −3.34 at 5% for one regressor), not the raw ADF table.
 */
export function engleGranger(dependent: number[], independent: number[]): EngleGrangerResult {
  requireSeries(dependent, 6, 'engleGranger');
  requireSeries(independent, 6, 'engleGranger');
  if (dependent.length !== independent.length) {
    throw new InputError(
      `engleGranger: the dependent and independent series must be equal length (${dependent.length} vs ${independent.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { dependentLength: dependent.length, independentLength: independent.length },
      },
    );
  }
  const fit = ols(
    dependent,
    independent.map((value) => [value]),
    { intercept: true },
  );
  const alpha = fit.coefficients[0]!;
  const beta = fit.coefficients[1]!;
  const adf = augmentedDickeyFullerTest(fit.residuals, { regression: 'c', lags: 0 });
  // The residual τ statistic is correct, but its significance must be read off the Engle–Granger
  // residual-based distribution, not the raw ADF table. Re-derive the p-value and critical values from
  // the EG anchors so what we EXPOSE matches the test we ran (design law #4 — don't answer a different
  // question by reporting ordinary-ADF significance for an estimated-residual test).
  const pValue = probitInterpPValue(adf.statistic, [
    [EG_CV['1%'], 0.01],
    [EG_CV['5%'], 0.05],
    [EG_CV['10%'], 0.1],
  ]);
  const residualAugmentedDickeyFuller: TestResult = {
    statistic: adf.statistic,
    pValue,
    criticalValues: { '1%': EG_CV['1%'], '5%': EG_CV['5%'], '10%': EG_CV['10%'] },
    method: 'Engle–Granger residual ADF (c, lags=0)',
  };
  const cointegrated = adf.statistic < EG_CV['5%'];
  return { beta, alpha, residualAugmentedDickeyFuller, cointegrated };
}

// ───────────────────────── Hurst exponent (R/S) ─────────────────────────

/**
 * Hurst exponent via rescaled-range (R/S) analysis. For a geometric progression of window sizes the
 * mean rescaled range `⟨R/S⟩ₙ` scales as `nᴴ`; `H` is the slope of `log⟨R/S⟩` on `log n`. R/S is
 * computed on the input series AS GIVEN, so the usual reading — `H ≈ 0.5` random walk, `H > 0.5`
 * persistence/trending, `H < 0.5` mean reversion — assumes an INCREMENT (returns) series. Passing an
 * integrated level series (e.g. a price path) instead yields `H ≈ 1`.
 *
 * BIAS CAVEAT — read this before calling 0.55 "persistence". This is PLAIN R/S with no Anis–Lloyd
 * (1976) small-sample correction, and plain R/S is biased UPWARD at every finite sample size: for
 * independent data `E[R/S]ₙ` is not `n^0.5`, so the slope is not 0.5 either. Measured on this
 * implementation over 20 seeds of iid normal input (mean, and the spread across seeds):
 *
 *   - `n = 512` → `H ≈ 0.565` (0.52 … 0.65)
 *   - `n = 4096` → `H ≈ 0.538` (0.48 … 0.59)
 *   - `n = 32768` → `H ≈ 0.534` (0.51 … 0.56)
 *
 * The bias shrinks with `n` but is still ~0.03 at 32k points, and the seed-to-seed spread is wider
 * than the bias itself. So a lone `H = 0.55` on 4k observations is evidence of NOTHING. Compare
 * against a shuffled (or synthetic iid) version of your own series at the SAME length rather than
 * against the textbook 0.5, or use a corrected estimator. The ORDERING (anti-persistent < iid <
 * persistent, as the test suite asserts) is reliable; the absolute level is not.
 */
export function hurstExponent(series: number[]): number {
  // Needs at least two dyadic window sizes (8 and 16) to fit a slope ⇒ n ≥ 32.
  requireSeries(series, 32, 'hurstExponent');
  const n = series.length;
  const logSizes: number[] = [];
  const logRs: number[] = [];
  for (let w = 8; w <= Math.floor(n / 2); w *= 2) {
    const chunks = Math.floor(n / w);
    let rsSum = 0;
    let count = 0;
    for (let c = 0; c < chunks; c++) {
      const off = c * w;
      let m = 0;
      for (let i = 0; i < w; i++) m += series[off + i]!;
      m /= w;
      let cumulativeSum = 0;
      let minC = Infinity;
      let maxC = -Infinity;
      let sq = 0;
      for (let i = 0; i < w; i++) {
        const d = series[off + i]! - m;
        cumulativeSum += d;
        if (cumulativeSum < minC) minC = cumulativeSum;
        if (cumulativeSum > maxC) maxC = cumulativeSum;
        sq += d * d;
      }
      const range = maxC - minC;
      const s = Math.sqrt(sq / w);
      if (s > 0 && range > 0) {
        rsSum += range / s;
        count += 1;
      }
    }
    if (count > 0) {
      logSizes.push(Math.log(w));
      logRs.push(Math.log(rsSum / count));
    }
  }
  if (logSizes.length < 2) {
    throw new InputError('hurstExponent: not enough distinct window sizes to estimate a slope.', {
      code: ErrorCode.InputOutOfRange,
      context: { length: n, points: logSizes.length },
    });
  }
  // Slope of a simple least-squares line through (log n, log R/S).
  const k = logSizes.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < k; i++) {
    sx += logSizes[i]!;
    sy += logRs[i]!;
  }
  const mx = sx / k;
  const my = sy / k;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < k; i++) {
    const dx = logSizes[i]! - mx;
    sxx += dx * dx;
    sxy += dx * (logRs[i]! - my);
  }
  return sxx > 0 ? sxy / sxx : NaN;
}

// ───────────────────────── OU half-life ─────────────────────────

/**
 * Half-life of mean reversion from an AR(1) fit `xₜ = a + b·x_{t−1} + εₜ`:
 * `halfLife = −ln 2 / ln b`. Defined (positive) only for a mean-reverting series with `0 < b < 1`;
 * returns `NaN` when `b ≤ 0` and a non-positive value when `b ≥ 1` (no reversion), by construction.
 */
export function ouHalfLife(series: number[]): number {
  requireSeries(series, 3, 'ouHalfLife');
  const n = series.length;
  const ys: number[] = [];
  const rows: number[][] = [];
  for (let t = 1; t < n; t++) {
    ys.push(series[t]!);
    rows.push([series[t - 1]!]);
  }
  const fit = ols(ys, rows, { intercept: true });
  const b = fit.coefficients[1]!;
  if (b <= 0) return NaN;
  return -Math.LN2 / Math.log(b);
}
