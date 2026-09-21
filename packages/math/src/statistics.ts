/**
 * Descriptive, rolling, and robust statistics (spec §8.2).
 *
 * Conventions:
 *   - `variance`/`standardDeviation` default to the SAMPLE estimator (÷ n-1); pass `{ population: true }` for ÷n.
 *   - `sum` uses Kahan compensated summation, so `mean`/`variance` stay accurate on long series.
 *   - `variance` is two-pass (subtracts the mean first), so huge constant offsets do not destroy
 *     precision; `welfordVariance` is the online single-pass equivalent.
 *   - NaN handling on the SCALAR/whole-series reductions is explicit via `nanPolicy`:
 *       · `propagate` (default): if ANY input is NaN, a scalar result is NaN and a series result is
 *         an all-NaN array of the input's length. NaN is never silently swallowed by a comparison or
 *         a partial sort.
 *       · `omit`: NaNs are dropped before computing (paired-deletion for two-series stats).
 *       · `throw`: any NaN throws `InputError(InputNaN)`.
 *     The ROLLING functions do NOT take a `nanPolicy`; they always PROPAGATE per window — a window
 *     containing a NaN yields NaN for that index and recovers once the NaN leaves the window (matching
 *     TA warmup). Per-window `omit`/`throw` are intentionally unsupported (an `omit` window would have
 *     an ambiguous, variable width) — which is why their options type is `PopulationOptions`: a
 *     `nanPolicy` there is an UNKNOWN field and teaches, never an accepted no-op.
 *   - Two-series stats require equal lengths; they throw rather than silently truncating.
 *   - Options objects are CLOSED (Law 12): an unknown key and a wrong-typed field throw typed
 *     `InputError`s at the boundary — a misspelled `nanPolicy` silently changing NaN semantics is
 *     exactly the bug class the policy exists to kill. Validation runs ONCE per external call;
 *     internal delegation goes through private helpers in `statistics-internal.ts`. Optional fields
 *     treat `undefined` as omission; `null` is not omission — the declarations are non-nullable and
 *     the runtime matches them.
 */

import { ErrorCode, InputError } from '@totalfinance/core';
import {
  covarianceValidated,
  kahanSum,
  meanOf,
  type OptionFieldKind,
  optionsSpec,
  POPULATION_OPTIONS_SPEC,
  prepare,
  preparePair,
  requireEqualLength,
  validateOptions,
} from './statistics-internal.js';

export type NanPolicy = 'propagate' | 'omit' | 'throw';

export interface StatisticsOptions {
  nanPolicy?: NanPolicy;
}

/** The estimator choice alone — the whole contract of the rolling family and `covarianceMatrix`. */
export interface PopulationOptions {
  /** Use the population estimator (÷n) instead of the sample estimator (÷(n-1)). */
  population?: boolean;
}

export interface VarianceOptions extends StatisticsOptions, PopulationOptions {}

const STATISTICS_OPTIONS_SPEC = optionsSpec({
  nanPolicy: 'nanPolicy',
} as const satisfies Record<keyof StatisticsOptions, OptionFieldKind>);

const VARIANCE_OPTIONS_SPEC = optionsSpec({
  nanPolicy: 'nanPolicy',
  population: 'boolean',
} as const satisfies Record<keyof VarianceOptions, OptionFieldKind>);

/** Kahan-compensated sum — minimizes rounding error over long series. */
export function sum(xs: ArrayLike<number>, options?: StatisticsOptions): number {
  validateOptions('sum', options, STATISTICS_OPTIONS_SPEC);
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  return kahanSum(data);
}

function meanValidated(xs: ArrayLike<number>, options?: StatisticsOptions): number {
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  if (data.length === 0) return NaN;
  return meanOf(data);
}

export function mean(xs: ArrayLike<number>, options?: StatisticsOptions): number {
  validateOptions('mean', options, STATISTICS_OPTIONS_SPEC);
  return meanValidated(xs, options);
}

function minOf(data: ArrayLike<number>): number {
  let m = data[0]!;
  for (let i = 1; i < data.length; i++) if (data[i]! < m) m = data[i]!;
  return m;
}

function maxOf(data: ArrayLike<number>): number {
  let m = data[0]!;
  for (let i = 1; i < data.length; i++) if (data[i]! > m) m = data[i]!;
  return m;
}

export function min(xs: ArrayLike<number>, options?: StatisticsOptions): number {
  validateOptions('min', options, STATISTICS_OPTIONS_SPEC);
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  if (data.length === 0) return NaN;
  return minOf(data);
}

export function max(xs: ArrayLike<number>, options?: StatisticsOptions): number {
  validateOptions('max', options, STATISTICS_OPTIONS_SPEC);
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  if (data.length === 0) return NaN;
  return maxOf(data);
}

/** Two-pass variance over already-validated options (public boundary ran the checks). */
function varianceValidated(xs: ArrayLike<number>, options?: VarianceOptions): number {
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  const n = data.length;
  const ddof = options?.population ? 0 : 1;
  if (n - ddof <= 0) return NaN;
  const mu = meanOf(data);
  let acc = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i]! - mu;
    const y = d * d - c;
    const t = acc + y;
    c = t - acc - y;
    acc = t;
  }
  return acc / (n - ddof);
}

/** Two-pass variance (stable under large constant offsets). */
export function variance(xs: ArrayLike<number>, options?: VarianceOptions): number {
  validateOptions('variance', options, VARIANCE_OPTIONS_SPEC);
  return varianceValidated(xs, options);
}

export function standardDeviation(xs: ArrayLike<number>, options?: VarianceOptions): number {
  // Validate once, under this function's own name, then delegate to the UNVALIDATED body — the
  // first version re-validated on every internal frame, which a benchmark showed was 3.6x on
  // small series, not "costs nothing".
  validateOptions('standardDeviation', options, VARIANCE_OPTIONS_SPEC);
  return Math.sqrt(varianceValidated(xs, options));
}

/** Online (Welford) variance — single pass, numerically stable. Equivalent to `variance`. */
export function welfordVariance(xs: ArrayLike<number>, options?: VarianceOptions): number {
  validateOptions('welfordVariance', options, VARIANCE_OPTIONS_SPEC);
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  const n = data.length;
  const ddof = options?.population ? 0 : 1;
  if (n - ddof <= 0) return NaN;
  let mean = 0;
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    const x = data[i]!;
    const delta = x - mean;
    mean += delta / (i + 1);
    m2 += delta * (x - mean);
  }
  return m2 / (n - ddof);
}

function sorted(xs: ArrayLike<number>): number[] {
  return Array.from(xs as ArrayLike<number>).sort((a, b) => a - b);
}

/** Type-7 quantile over CLEAN data — callers have already applied the NaN policy. */
function quantileRaw(data: ArrayLike<number>, probability: number): number {
  const n = data.length;
  if (n === 0) return NaN;
  if (probability === 0) return minOf(data);
  if (probability === 1) return maxOf(data);
  const a = sorted(data);
  const h = (n - 1) * probability;
  const lo = Math.floor(h);
  const frac = h - lo;
  const lower = a[lo]!;
  const upper = a[Math.min(lo + 1, n - 1)]!;
  // An integer h interpolates nothing — return the order statistic itself. The general form
  // `lower + frac * (upper - lower)` would compute `0 * Infinity = NaN` here when the spread
  // overflows (e.g. order statistics near ±Number.MAX_VALUE), a representable answer lost to
  // arithmetic (2026-08-23, fourth external review).
  if (frac === 0) return lower;
  const spread = upper - lower;
  if (Number.isFinite(spread)) return lower + frac * spread;
  // Convex fallback for spreads past MAX_VALUE: each term is bounded by its endpoint and the
  // endpoints have opposite signs (that is the only way the spread overflows), so the sum cannot.
  return lower * (1 - frac) + upper * frac;
}

function quantileValidated(
  xs: ArrayLike<number>,
  probability: number,
  options?: StatisticsOptions,
): number {
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  return quantileRaw(data, probability);
}

export function median(xs: ArrayLike<number>, options?: StatisticsOptions): number {
  // Own-name validation, then the unvalidated body — the error says `median`, and `quantile`
  // never re-runs the option checks.
  validateOptions('median', options, STATISTICS_OPTIONS_SPEC);
  return quantileValidated(xs, 0.5, options);
}

/**
 * Quantile via the type-7 (linear interpolation of order statistics) method — the default used by
 * NumPy and R. `p` is in [0, 1].
 */
export function quantile(
  xs: ArrayLike<number>,
  probability: number,
  options?: StatisticsOptions,
): number {
  // p out of [0, 1] is the classic percentile-vs-fraction unit mistake (quantile(xs, 95)); a silent
  // clamp to max would be a plausible-looking wrong answer, so it throws like NumPy/R instead.
  if (!(probability >= 0 && probability <= 1)) {
    throw new InputError(
      `quantile: p is a fraction in [0, 1] — use 0.95, not 95. Received ${probability}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'p', value: probability },
      },
    );
  }
  validateOptions('quantile', options, STATISTICS_OPTIONS_SPEC);
  return quantileValidated(xs, probability, options);
}

function centralMoment(xs: ArrayLike<number>, k: number, mu: number): number {
  const n = xs.length;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (xs[i]! - mu) ** k;
  return acc / n;
}

/** Population skewness (third standardized moment). */
export function skewness(xs: ArrayLike<number>, options?: StatisticsOptions): number {
  validateOptions('skewness', options, STATISTICS_OPTIONS_SPEC);
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  const mu = meanOf(data);
  const m2 = centralMoment(data, 2, mu);
  const m3 = centralMoment(data, 3, mu);
  return m2 === 0 ? NaN : m3 / m2 ** 1.5;
}

export interface KurtosisOptions extends StatisticsOptions {
  /** Return excess kurtosis (subtract 3). Default `true`. */
  excess?: boolean;
}

const KURTOSIS_OPTIONS_SPEC = optionsSpec({
  nanPolicy: 'nanPolicy',
  excess: 'boolean',
} as const satisfies Record<keyof KurtosisOptions, OptionFieldKind>);

/** Population kurtosis; excess (−3) by default. */
export function kurtosis(xs: ArrayLike<number>, options?: KurtosisOptions): number {
  validateOptions('kurtosis', options, KURTOSIS_OPTIONS_SPEC);
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  const mu = meanOf(data);
  const m2 = centralMoment(data, 2, mu);
  const m4 = centralMoment(data, 4, mu);
  if (m2 === 0) return NaN;
  const k = m4 / (m2 * m2);
  return options?.excess === false ? k : k - 3;
}

// ---- robust statistics ----

export interface MedianAbsoluteDeviationOptions extends StatisticsOptions {
  /** Scale by 1.4826 for consistency with the normal stddev (default `true`). */
  scale?: boolean;
}

const MEDIAN_ABSOLUTE_DEVIATION_OPTIONS_SPEC = optionsSpec({
  nanPolicy: 'nanPolicy',
  scale: 'boolean',
} as const satisfies Record<keyof MedianAbsoluteDeviationOptions, OptionFieldKind>);

/** Median absolute deviation. */
export function medianAbsoluteDeviation(
  xs: ArrayLike<number>,
  options?: MedianAbsoluteDeviationOptions,
): number {
  validateOptions('medianAbsoluteDeviation', options, MEDIAN_ABSOLUTE_DEVIATION_OPTIONS_SPEC);
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  const n = data.length;
  if (n === 0) return NaN;
  const med = quantileRaw(data, 0.5);
  const dev = new Array<number>(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(data[i]! - med);
  const m = quantileRaw(dev, 0.5);
  return options?.scale === false ? m : m * 1.4826;
}

export interface WinsorizeOptions extends StatisticsOptions {
  /** Lower tail fraction to clip (default 0.05). */
  lower?: number;
  /** Upper tail fraction to clip (default 0.05). */
  upper?: number;
}

const WINSORIZE_OPTIONS_SPEC = optionsSpec({
  nanPolicy: 'nanPolicy',
  lower: 'finiteNumber',
  upper: 'finiteNumber',
} as const satisfies Record<keyof WinsorizeOptions, OptionFieldKind>);

/** A tail fraction outside [0, 1] silently clips to garbage quantiles; teach instead. */
function requireTailFraction(value: number, field: string): void {
  if (value < 0 || value > 1) {
    // The classic mistake is a percentage; suggest the division only when it would land in range.
    const percentHint = value > 1 && value <= 100 ? ` — did you mean ${value / 100}?` : '';
    throw new InputError(
      `winsorize: ${field} is a tail fraction in [0, 1] (0.05 clips the 5% tail). ` +
        `Received ${value}${percentHint}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: 'winsorize', field, value },
      },
    );
  }
}

/**
 * Winsorize: clip values beyond the lower/upper quantiles to those quantiles. Returns a new array.
 * Under `propagate`, a NaN anywhere yields an all-NaN array of the input's length.
 */
export function winsorize(xs: ArrayLike<number>, options?: WinsorizeOptions): number[] {
  validateOptions('winsorize', options, WINSORIZE_OPTIONS_SPEC);
  const lowerP = options?.lower ?? 0.05;
  const upperP = options?.upper ?? 0.05;
  // Previously an out-of-range fraction surfaced as `quantile`'s [0, 1] error — a rejection under
  // the wrong function's name. Now it teaches as winsorize's own field.
  requireTailFraction(lowerP, 'options.lower');
  requireTailFraction(upperP, 'options.upper');
  // Each tail can be valid while the PAIR is nonsense: at lower + upper > 1 the clip quantiles
  // cross and every value collapses into an inverted range ({ lower: 0.8, upper: 0.8 } turned
  // [1..5] into [4.2, 4.2, 4.2, 4.2, 1.8]) — a plausible-looking wrong answer, so it teaches.
  if (lowerP + upperP > 1) {
    throw new InputError(
      `winsorize: options.lower + options.upper must be <= 1 — the tails overlap ` +
        `(${lowerP} + ${upperP} = ${lowerP + upperP}) and the clip bounds cross.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: 'winsorize', lower: lowerP, upper: upperP },
      },
    );
  }
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return new Array<number>(xs.length).fill(NaN);
  const lo = quantileRaw(data, lowerP);
  const hi = quantileRaw(data, 1 - upperP);
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    out[i] = v < lo ? lo : v > hi ? hi : v;
  }
  return out;
}

export interface TrimmedMeanOptions extends StatisticsOptions {
  /**
   * Fraction dropped from EACH tail before averaging (default 0.1), in [0, 0.5]. At 0.5 nothing
   * but the middle remains and the result is the median; the same fallback applies whenever the
   * two trims would consume the whole sample.
   */
  fraction?: number;
}

const TRIMMED_MEAN_OPTIONS_SPEC = optionsSpec({
  nanPolicy: 'nanPolicy',
  fraction: 'finiteNumber',
} as const satisfies Record<keyof TrimmedMeanOptions, OptionFieldKind>);

/** Trimmed mean: drop `fraction` of the data from each tail, then average the rest. */
export function trimmedMean(xs: ArrayLike<number>, options?: TrimmedMeanOptions): number {
  validateOptions('trimmedMean', options, TRIMMED_MEAN_OPTIONS_SPEC);
  const fraction = options?.fraction ?? 0.1;
  // A negative trim silently became an ordinary mean and > 0.5 silently became the median — two
  // plausible answers to a question the caller did not ask. The domain is [0, 0.5]: each tail
  // drops `fraction`, so past one half the two trims overlap.
  if (fraction < 0 || fraction > 0.5) {
    throw new InputError(
      `trimmedMean: options.fraction is dropped from EACH tail, so it lives in [0, 0.5] ` +
        `(0.5 keeps only the middle and returns the median). Received ${fraction}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: 'trimmedMean', field: 'options.fraction', value: fraction },
      },
    );
  }
  const data = prepare(xs, options?.nanPolicy);
  if (data === null) return NaN;
  const n = data.length;
  if (n === 0) return NaN;
  if (fraction === 0) return meanOf(data);
  const a = sorted(data);
  const k = Math.floor(n * fraction);
  if (2 * k >= n) return quantileRaw(a, 0.5);
  return meanOf(a.slice(k, n - k));
}

// ---- rolling stats ----

/**
 * A rolling window must be a positive integer — a fractional window corrupts array indexing. A SAFE
 * integer (2026-08-23 review, P0): every rolling caller is data-bounded (`window > n` returns the
 * all-NaN vector immediately, so no loop or allocation ever runs off this value), but above 2^53 an
 * "integer" window is no longer exact and the `window > n` / index comparisons operate on a number
 * the caller never had.
 */
function requireWindow(window: number, functionName: string): void {
  if (!Number.isSafeInteger(window) || window < 1) {
    throw new InputError(`${functionName}: window must be a positive integer, got ${window}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { window },
    });
  }
}

/**
 * Rolling mean. Output length equals input; the first `window-1` values are `NaN`. A window holding
 * a non-finite value — or whose own sum overflows — is reported `NaN`, never `±Infinity` (see
 * {@link finiteOrNaN}).
 */
export function rollingMean(xs: ArrayLike<number>, window: number): number[] {
  requireWindow(window, 'rollingMean');
  const n = xs.length;
  const out = new Array<number>(n).fill(NaN);
  if (window > n) return out;
  let acc = 0;
  // Non-finite values (NaN AND ±Infinity) are excluded from `acc` and counted, so a poisoned window
  // recovers once the value leaves it. Adding Infinity to the accumulator would be permanent:
  // `acc -= Infinity` on exit yields NaN forever.
  let badCount = 0;
  for (let i = 0; i < n; i++) {
    const v = xs[i]!;
    if (!Number.isFinite(v)) badCount++;
    else acc += v;
    if (i >= window) {
      const old = xs[i - window]!;
      if (!Number.isFinite(old)) badCount--;
      else acc -= old;
    }
    if (i >= window - 1) out[i] = badCount > 0 ? NaN : finiteOrNaN(acc / window);
  }
  return out;
}

/**
 * ONE non-finite policy for the whole rolling family (design law #4): a window containing any
 * non-finite value — `NaN` **or** `±Infinity` — emits `NaN`, and so does a window whose statistic is
 * itself non-finite (an overflowing sum of squares). `rollingMean` has always screened `!isFinite`;
 * the covariance-family screened only `Number.isNaN`, so an `Infinity` in the window reached the
 * arithmetic and the result depended on where the infinity landed — `NaN` here, `±Infinity` there.
 * "Poisoned window ⇒ NaN" is now a decision, not an accident of IEEE-754.
 */
function finiteOrNaN(value: number): number {
  return Number.isFinite(value) ? value : NaN;
}

/**
 * Rolling standard deviation (sample by default). Aligned with `NaN` warmup. Takes
 * {@link PopulationOptions}, not `VarianceOptions`: the rolling family has no `nanPolicy` (see the
 * module conventions), so the field is rejected as unknown rather than accepted and ignored.
 */
export function rollingStandardDeviation(
  xs: ArrayLike<number>,
  window: number,
  options?: PopulationOptions,
): number[] {
  requireWindow(window, 'rollingStandardDeviation');
  validateOptions('rollingStandardDeviation', options, POPULATION_OPTIONS_SPEC);
  const n = xs.length;
  const out = new Array<number>(n).fill(NaN);
  if (window <= 1 || window > n) return out;
  const ddof = options?.population ? 0 : 1;
  for (let i = window - 1; i < n; i++) {
    let s = 0;
    let poisoned = false;
    for (let j = i - window + 1; j <= i; j++) {
      const v = xs[j]!;
      if (!Number.isFinite(v)) {
        poisoned = true;
        break;
      }
      s += v;
    }
    if (poisoned) {
      out[i] = NaN;
      continue;
    }
    const mu = s / window;
    let acc = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const d = xs[j]! - mu;
      acc += d * d;
    }
    out[i] = finiteOrNaN(Math.sqrt(acc / (window - ddof)));
  }
  return out;
}

/** Covariance of two equal-length series (sample by default). Throws on unequal lengths. */
export function covariance(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  options?: VarianceOptions,
): number {
  validateOptions('covariance', options, VARIANCE_OPTIONS_SPEC);
  return covarianceValidated(xs, ys, options, 'covariance');
}

/** Pearson correlation coefficient. Throws on unequal lengths. */
export function correlation(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  options?: StatisticsOptions,
): number {
  validateOptions('correlation', options, STATISTICS_OPTIONS_SPEC);
  requireEqualLength(xs, ys, 'correlation');
  const pair = preparePair(xs, ys, options?.nanPolicy);
  if (pair === null) return NaN;
  const sx = Math.sqrt(varianceValidated(pair.xs));
  const sy = Math.sqrt(varianceValidated(pair.ys));
  if (sx === 0 || sy === 0) return NaN;
  return covarianceValidated(pair.xs, pair.ys, undefined, 'correlation') / (sx * sy);
}

/**
 * Rolling covariance over a window. Aligned with `NaN` warmup. Takes {@link PopulationOptions} for
 * the same reason as {@link rollingStandardDeviation}.
 */
export function rollingCovariance(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  window: number,
  options?: PopulationOptions,
): number[] {
  requireWindow(window, 'rollingCovariance');
  const n = requireEqualLength(xs, ys, 'rollingCovariance');
  validateOptions('rollingCovariance', options, POPULATION_OPTIONS_SPEC);
  const out = new Array<number>(n).fill(NaN);
  if (window <= 1 || window > n) return out;
  const ddof = options?.population ? 0 : 1;
  for (let i = window - 1; i < n; i++) {
    let sx = 0;
    let sy = 0;
    let poisoned = false;
    for (let j = i - window + 1; j <= i; j++) {
      const a = xs[j]!;
      const b = ys[j]!;
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        poisoned = true;
        break;
      }
      sx += a;
      sy += b;
    }
    if (poisoned) {
      out[i] = NaN;
      continue;
    }
    const mx = sx / window;
    const my = sy / window;
    let acc = 0;
    for (let j = i - window + 1; j <= i; j++) acc += (xs[j]! - mx) * (ys[j]! - my);
    out[i] = finiteOrNaN(acc / (window - ddof));
  }
  return out;
}

/** Rolling Pearson correlation over a window. Aligned with `NaN` warmup. */
export function rollingCorrelation(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  window: number,
): number[] {
  requireWindow(window, 'rollingCorrelation');
  const n = requireEqualLength(xs, ys, 'rollingCorrelation');
  const out = new Array<number>(n).fill(NaN);
  if (window <= 1 || window > n) return out;
  for (let i = window - 1; i < n; i++) {
    let sx = 0;
    let sy = 0;
    let poisoned = false;
    for (let j = i - window + 1; j <= i; j++) {
      const a = xs[j]!;
      const b = ys[j]!;
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        poisoned = true;
        break;
      }
      sx += a;
      sy += b;
    }
    if (poisoned) {
      out[i] = NaN;
      continue;
    }
    const mx = sx / window;
    const my = sy / window;
    let covariance = 0;
    let vx = 0;
    let vy = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const dx = xs[j]! - mx;
      const dy = ys[j]! - my;
      covariance += dx * dy;
      vx += dx * dx;
      vy += dy * dy;
    }
    // The ratio can be finite even when its parts are not: an overflowing `vy` sends
    // `cov / √(vx·vy)` to 0, so a perfectly correlated pair reported a correlation of ZERO. Screen
    // the accumulators, not just the answer.
    const degenerate =
      vx === 0 ||
      vy === 0 ||
      !Number.isFinite(vx) ||
      !Number.isFinite(vy) ||
      !Number.isFinite(covariance);
    out[i] = degenerate ? NaN : finiteOrNaN(covariance / Math.sqrt(vx * vy));
  }
  return out;
}
