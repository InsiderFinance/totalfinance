/**
 * Rolling feature-engineering transforms (spec §13.3; ML-prep primitives).
 *
 * Lag operators (`shift`/`lag`, `diff`/`change`, `fractionalChange`, `cum`) and rolling standardization /
 * dispersion statistics (`zScore`, `normalize`, `rescale`, `rollingMedian`, `rollingMeanAbsoluteDeviation`, `standardError`). All are
 * causal series→series streaming indicators with batch≡stream parity and serializable state, so they
 * compose with the pipeline and the rest of the catalog.
 */

import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { sma } from './moving-averages.js';
import { type Pair, beta, correl, rollingMaxIndex, rollingMinIndex } from './statistics.js';
import {
  requireAtMost,
  requireBooleanWhenPresent,
  requireFinite,
  requireInRange,
  requireNonNegativeInt,
  requirePeriod,
  requirePositive,
} from './validate.js';

const nan = (): number => NaN;

/** Linear-interpolated quantile (numpy "type 7") of a window. */
function quantileOf(buf: readonly number[], q: number): number {
  const s = [...buf].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (pos - lo) * (s[hi]! - s[lo]!);
}

// ───────────────────────── lag operators ─────────────────────────

class LagStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  constructor(
    private readonly kind: string,
    private readonly period: number,
  ) {}
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period + 1) this.buf.shift();
    if (this.buf.length < this.period + 1) {
      this.value = null;
      return null;
    }
    const past = this.buf[0]!; // value `period` bars ago
    this.value =
      this.kind === 'shift'
        ? past
        : this.kind === 'diff'
          ? value - past
          : past === 0
            ? NaN
            : (value - past) / past; // fractionalChange
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, { period: this.period, buf: [...this.buf], value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): LagStream {
    const state = readSnapshot(snapshot, LAG_KINDS);
    const x = new LagStream(state.kind, state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

/**
 * The lag family: one `LagStream` class backs three public indicators, so its restorer cannot pin a
 * single kind. Declaring the family here — and typing `lagFacade` by it — makes the restorer's guard
 * and the facades that produce those snapshots impossible to drift apart: adding a fourth lag
 * indicator without listing it is a compile error, not a snapshot that restores as the wrong one.
 */
const LAG_KINDS = ['shift', 'diff', 'fractionalChange'] as const;
type LagKind = (typeof LAG_KINDS)[number];

const lagFacade = (kind: LagKind, functionName: string) =>
  makeIndicator<{ period?: number }, number, number>(
    (p) => new LagStream(kind, requirePeriod(p.period ?? 1, functionName)),
    LagStream.fromJSON,
    nan,
  );

/** Lag a series by `period` bars: `output[i] = input[i − period]`. */
export const shift = withBuiltinMetadata(
  lagFacade('shift', 'shift'),
  builtinMetadata.shiftMetadata,
);
/** Alias of `shift` (causal lag; leading is not possible in a streaming model). */
export const lag = shift;
/** Discrete difference: `input[i] − input[i − period]`. */
export const difference = withBuiltinMetadata(
  lagFacade('diff', 'diff'),
  builtinMetadata.diffMetadata,
);
/** Alias of `diff`. */
export const change = difference;
/** Fractional change: `(input[i] − input[i − period]) / input[i − period]`. */
export const fractionalChange = withBuiltinMetadata(
  lagFacade('fractionalChange', 'fractionalChange'),
  builtinMetadata.fractionalChangeMetadata,
);

// ───────────────────────── cumulative sum ─────────────────────────

class CumStream implements IndicatorStream<number, number> {
  private sum = 0;
  value: number | null = null;
  next(value: number): number | null {
    this.sum += value;
    this.value = this.sum;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('cum', { sum: this.sum, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CumStream {
    const state = readSnapshot(snapshot, 'cum');
    const x = new CumStream();
    x.sum = state.number('sum');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Running cumulative sum. */
export const cumulativeSum = withBuiltinMetadata(
  makeIndicator<Record<string, never>, number, number>(
    () => new CumStream(),
    CumStream.fromJSON,
    nan,
  ),
  builtinMetadata.cumMetadata,
);

// ───────────────────────── rolling window statistics ─────────────────────────

class RollingStatStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  private readonly kind: RollingStatKind;
  private readonly period: number;
  private readonly lo: number;
  private readonly hi: number;
  constructor({
    kind,
    period,
    lo = 0,
    hi = 1,
  }: {
    kind: RollingStatKind;
    period: number;
    lo?: number;
    hi?: number;
  }) {
    this.kind = kind;
    this.period = period;
    this.lo = lo;
    this.hi = hi;
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    this.value = this.compute(value);
    return this.value;
  }
  private compute(v: number): number {
    const n = this.period;
    const buf = this.buf;
    let sum = 0;
    for (const x of buf) sum += x;
    const mean = sum / n;
    switch (this.kind) {
      case 'zScore': {
        let a = 0;
        for (const x of buf) a += (x - mean) ** 2;
        const std = Math.sqrt(a / n);
        return std === 0 ? 0 : (v - mean) / std;
      }
      case 'mad': {
        let a = 0;
        for (const x of buf) a += Math.abs(x - mean);
        return a / n;
      }
      case 'standardError': {
        let a = 0;
        for (const x of buf) a += (x - mean) ** 2;
        return Math.sqrt(a / (n - 1)) / Math.sqrt(n);
      }
      case 'rollingMedian': {
        const s = [...buf].sort((p, q) => p - q);
        const m = n >> 1;
        return n % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
      }
      case 'normalize':
      case 'rescale': {
        let mn = buf[0]!;
        let mx = buf[0]!;
        for (const x of buf) {
          if (x < mn) mn = x;
          if (x > mx) mx = x;
        }
        const norm = mx === mn ? 0.5 : (v - mn) / (mx - mn); // flat window → midpoint
        return this.kind === 'normalize' ? norm : this.lo + norm * (this.hi - this.lo);
      }
      case 'rollingQuantile':
        return quantileOf(buf, this.lo);
      case 'rollingRank': {
        let c = 0;
        for (const x of buf) if (x < v) c++;
        return c + 1; // 1-based ordinal rank (ties take the lowest rank)
      }
      case 'percentRank': {
        let c = 0;
        for (const x of buf) if (x < v) c++;
        return (100 * c) / (n - 1); // percentile position within the window [0,100]
      }
      case 'winsorize': {
        const loQ = quantileOf(buf, this.lo);
        const hiQ = quantileOf(buf, this.hi);
        return Math.min(Math.max(v, loQ), hiQ);
      }
      case 'skew': {
        let m2 = 0;
        let m3 = 0;
        for (const x of buf) {
          const d = x - mean;
          m2 += d * d;
          m3 += d * d * d;
        }
        if (m2 === 0) return 0;
        const s = Math.sqrt(m2 / (n - 1)); // sample std
        return (n / ((n - 1) * (n - 2))) * (m3 / s ** 3); // bias-corrected G1
      }
      case 'kurtosis': {
        let m2 = 0;
        let m4 = 0;
        for (const x of buf) {
          const d = x - mean;
          const d2 = d * d;
          m2 += d2;
          m4 += d2 * d2;
        }
        if (m2 === 0) return 0;
        const s2 = m2 / (n - 1);
        const term1 = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * (m4 / (s2 * s2));
        const term2 = (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
        return term1 - term2; // bias-corrected excess kurtosis G2
      }
      case 'entropy': {
        let total = 0;
        for (const x of buf) total += x;
        if (total <= 0) return NaN;
        let e = 0;
        for (const x of buf) {
          const p = x / total; // pandas-ta: each value as a fraction of the window sum
          if (p > 0) e += -p * Math.log2(p);
        }
        return e;
      }
      default:
        return NaN;
    }
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, {
      period: this.period,
      lo: this.lo,
      hi: this.hi,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RollingStatStream {
    const state = readSnapshot(snapshot, ROLLING_STAT_KINDS);
    const x = new RollingStatStream({
      kind: state.kind,
      period: state.lookback('period'),
      lo: state.number('lo'),
      hi: state.number('hi'),
    });
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** The rolling-statistic family. Same contract as {@link LAG_KINDS}: the type is the guard. */
const ROLLING_STAT_KINDS = [
  'zScore',
  'normalize',
  'rollingMedian',
  'mad',
  'standardError',
  'rollingRank',
  'percentRank',
  'skew',
  'kurtosis',
  'entropy',
  // Three that build the stream DIRECTLY rather than through `rollingFacade`, because they take
  // extra parameters. The first version of this list was derived from the facade's call sites and
  // missed all three — which is why `RollingStatStream`'s constructor now takes `RollingStatKind`:
  // the compiler enumerates the family, not a grep.
  'rescale',
  'rollingQuantile',
  'winsorize',
] as const;
type RollingStatKind = (typeof ROLLING_STAT_KINDS)[number];

const rollingFacade = (
  kind: RollingStatKind,
  functionName: string,
  minPeriod = 1,
  defaultPeriod = 20,
) =>
  makeIndicator<{ period?: number }, number, number>(
    (p) =>
      new RollingStatStream({
        kind,
        period: requirePeriod(p.period ?? defaultPeriod, functionName, 'period', minPeriod),
      }),
    RollingStatStream.fromJSON,
    nan,
  );

/** Rolling z-score: `(value − mean) / populationStd` over the window (0 on a flat window). */
export const zScore = withBuiltinMetadata(
  rollingFacade('zScore', 'zScore', 2),
  builtinMetadata.zScoreMetadata,
);
/** Rolling min-max normalization to [0, 1] (0.5 on a flat window). */
export const normalize = withBuiltinMetadata(
  rollingFacade('normalize', 'normalize'),
  builtinMetadata.normalizeMetadata,
);
/** Rolling median. */
export const rollingMedian = withBuiltinMetadata(
  rollingFacade('rollingMedian', 'rollingMedian'),
  builtinMetadata.rollingMedianMetadata,
);
/** Rolling mean absolute deviation from the window mean. */
export const rollingMeanAbsoluteDeviation = withBuiltinMetadata(
  rollingFacade('mad', 'mad'),
  builtinMetadata.madMetadata,
);
/** Rolling standard error of the mean: sampleStd / √n. */
export const standardError = withBuiltinMetadata(
  rollingFacade('standardError', 'standardError', 2),
  builtinMetadata.standardErrorMetadata,
);

export interface RescaleParameters {
  period?: number;
  /** Target range minimum. Default 0. */
  min?: number;
  /** Target range maximum. Default 1. */
  max?: number;
}

/** Rolling rescale of the min-max-normalized value into [min, max]. */
export const rescale = withBuiltinMetadata(
  makeIndicator<RescaleParameters, number, number>(
    (p) => {
      const min = requireFinite(p.min ?? 0, 'rescale', 'min');
      const max = requireFinite(p.max ?? 1, 'rescale', 'max');
      requireAtMost(min, max, 'rescale', 'min', 'max');
      return new RollingStatStream({
        kind: 'rescale',
        period: requirePeriod(p.period ?? 20, 'rescale'),
        lo: min,
        hi: max,
      });
    },
    RollingStatStream.fromJSON,
    nan,
  ),
  builtinMetadata.rescaleMetadata,
);

/** Rolling 1-based ordinal rank of the current value within the window. */
export const rollingRank = withBuiltinMetadata(
  rollingFacade('rollingRank', 'rollingRank'),
  builtinMetadata.rollingRankMetadata,
);
/** Rolling percentile position of the current value within the window, in [0, 100]. */
export const percentRank = withBuiltinMetadata(
  rollingFacade('percentRank', 'percentRank', 2),
  builtinMetadata.percentRankMetadata,
);
/** Rolling sample skewness (bias-corrected Fisher-Pearson G1). */
export const skew = withBuiltinMetadata(
  rollingFacade('skew', 'skew', 3),
  builtinMetadata.skewMetadata,
);
/** Rolling sample excess kurtosis (bias-corrected G2). */
export const kurtosis = withBuiltinMetadata(
  rollingFacade('kurtosis', 'kurtosis', 4),
  builtinMetadata.kurtosisMetadata,
);
/** Rolling Shannon entropy (pandas-ta: each value as a fraction of the window sum), in bits. */
export const entropy = withBuiltinMetadata(
  rollingFacade('entropy', 'entropy', 1, 10),
  builtinMetadata.entropyMetadata,
);

export interface QuantileParameters {
  period?: number;
  /** Quantile in [0, 1]. Default 0.5 (median). */
  quantile?: number;
}

/** Rolling quantile (linear interpolation). */
export const rollingQuantile = withBuiltinMetadata(
  makeIndicator<QuantileParameters, number, number>(
    (p) =>
      new RollingStatStream({
        kind: 'rollingQuantile',
        period: requirePeriod(p.period ?? 20, 'rollingQuantile'),
        lo: requireInRange(p.quantile ?? 0.5, 'rollingQuantile', 'quantile', 0, 1),
        hi: 1,
      }),
    RollingStatStream.fromJSON,
    nan,
  ),
  builtinMetadata.rollingQuantileMetadata,
);

export interface WinsorizeParameters {
  period?: number;
  /** Lower quantile to clip to, in [0, 1]. Default 0.05. */
  lower?: number;
  /** Upper quantile to clip to, in [0, 1]. Default 0.95. */
  upper?: number;
}

/** Rolling winsorize: clip the current value to the window's [lower, upper] quantiles. */
export const winsorize = withBuiltinMetadata(
  makeIndicator<WinsorizeParameters, number, number>(
    (p) => {
      const lower = requireInRange(p.lower ?? 0.05, 'winsorize', 'lower', 0, 1);
      const upper = requireInRange(p.upper ?? 0.95, 'winsorize', 'upper', 0, 1);
      requireAtMost(lower, upper, 'winsorize', 'lower', 'upper');
      return new RollingStatStream({
        kind: 'winsorize',
        period: requirePeriod(p.period ?? 20, 'winsorize'),
        lo: lower,
        hi: upper,
      });
    },
    RollingStatStream.fromJSON,
    nan,
  ),
  builtinMetadata.winsorizeMetadata,
);

// ───────────────────────── paired rolling regression ─────────────────────────

interface PairMoments {
  n: number;
  meanX: number;
  meanY: number;
  covPop: number;
  varX: number;
  varY: number;
}

function pairMoments(xs: readonly number[], ys: readonly number[]): PairMoments {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
    syy += y * y;
  }
  const meanX = sx / n;
  const meanY = sy / n;
  return {
    n,
    meanX,
    meanY,
    covPop: sxy / n - meanX * meanY,
    varX: sxx / n - meanX * meanX,
    varY: syy / n - meanY * meanY,
  };
}

abstract class PairWindowStream<Out> implements IndicatorStream<Pair, Out> {
  protected xs: number[] = [];
  protected ys: number[] = [];
  value: Out | null = null;
  constructor(protected readonly period: number) {}
  next(pair: Pair): Out | null {
    this.xs.push(pair.x);
    this.ys.push(pair.y);
    if (this.xs.length > this.period) {
      this.xs.shift();
      this.ys.shift();
    }
    if (this.xs.length < this.period) {
      this.value = null;
      return null;
    }
    this.value = this.derive(pairMoments(this.xs, this.ys));
    return this.value;
  }
  protected abstract derive(m: PairMoments): Out;
  protected abstract kind(): string;
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind(), {
      period: this.period,
      xs: [...this.xs],
      ys: [...this.ys],
      value: this.value,
    });
  }
}

export interface CovarianceParameters {
  period?: number;
  /** Use the sample (n−1) denominator. Default true. */
  sample?: boolean;
}

class CovarianceStream extends PairWindowStream<number> {
  constructor(
    period: number,
    private readonly sample: boolean,
  ) {
    super(period);
  }
  protected derive(m: PairMoments): number {
    return this.sample ? (m.covPop * m.n) / (m.n - 1) : m.covPop;
  }
  protected kind(): string {
    return 'covariance';
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CovarianceStream {
    const state = readSnapshot(snapshot, 'covariance');
    const x = new CovarianceStream(state.lookback('period'), state.boolean('sample'));
    x.xs = state.numbers('xs');
    x.ys = state.numbers('ys');
    x.value = state.cached<number>('value');
    return x;
  }
  override toJSON(): TechnicalAnalysisSnapshot {
    const base = super.toJSON();
    return snapshotOf(base.kind, { ...base.state, sample: this.sample });
  }
}

/** Rolling covariance of a paired series (sample denominator by default). */
export const covariance = withBuiltinMetadata(
  makeIndicator<CovarianceParameters, Pair, number>(
    (p) =>
      new CovarianceStream(
        requirePeriod(p.period ?? 20, 'covariance', 'period', 2),
        requireBooleanWhenPresent(p.sample, 'covariance', 'sample') ?? true,
      ),
    CovarianceStream.fromJSON,
    nan,
  ),
  builtinMetadata.covarianceMetadata,
);

class RSquaredStream extends PairWindowStream<number> {
  protected derive(m: PairMoments): number {
    const denom = m.varX * m.varY;
    return denom <= 0 ? 0 : (m.covPop * m.covPop) / denom;
  }
  protected kind(): string {
    return 'rSquared';
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RSquaredStream {
    const state = readSnapshot(snapshot, 'rSquared');
    const x = new RSquaredStream(state.lookback('period'));
    x.xs = state.numbers('xs');
    x.ys = state.numbers('ys');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Rolling R² (squared Pearson correlation) of a paired series. */
export const rSquared = withBuiltinMetadata(
  makeIndicator<{ period?: number }, Pair, number>(
    (p) => new RSquaredStream(requirePeriod(p.period ?? 20, 'rSquared', 'period', 2)),
    RSquaredStream.fromJSON,
    nan,
  ),
  builtinMetadata.rSquaredMetadata,
);

export interface RegressionPoint {
  /** OLS slope of y on x. */
  slope: number;
  intercept: number;
  /** Coefficient of determination. */
  rSquared: number;
}

class RegressionStream extends PairWindowStream<RegressionPoint> {
  protected derive(m: PairMoments): RegressionPoint {
    const slope = m.varX === 0 ? 0 : m.covPop / m.varX;
    const denom = m.varX * m.varY;
    return {
      slope,
      intercept: m.meanY - slope * m.meanX,
      rSquared: denom <= 0 ? 0 : (m.covPop * m.covPop) / denom,
    };
  }
  protected kind(): string {
    return 'rollingRegression';
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RegressionStream {
    const state = readSnapshot(snapshot, 'rollingRegression');
    const x = new RegressionStream(state.lookback('period'));
    x.xs = state.numbers('xs');
    x.ys = state.numbers('ys');
    x.value = state.cached<RegressionPoint>('value');
    return x;
  }
}

/** Rolling ordinary-least-squares regression of y on x: `{ slope, intercept, rSquared }`. */
export const rollingRegression = withBuiltinMetadata(
  makeIndicator<{ period?: number }, Pair, RegressionPoint>(
    (p) => new RegressionStream(requirePeriod(p.period ?? 20, 'rollingRegression', 'period', 2)),
    RegressionStream.fromJSON,
    () => ({ slope: NaN, intercept: NaN, rSquared: NaN }),
  ),
  builtinMetadata.rollingRegressionMetadata,
);

export interface TosStdevAllParameters {
  /** Rolling window. Omit (or pass null) to use all history seen so far. */
  period?: number | null;
  /** Positive standard-deviation multipliers. Default [1, 2, 3]. */
  stds?: readonly number[];
  /** Delta degrees of freedom for the source-series standard deviation. Default 1. */
  ddof?: number;
}
export interface TosStdevAllPoint {
  /** Current value of the OLS centerline. */
  line: number;
  /** Lower bands, in the same order as `stds`. */
  lower: number[];
  /** Upper bands, in the same order as `stds`. */
  upper: number[];
}

function sortedStds(stds: readonly number[] | undefined): number[] {
  const out = stds && stds.length > 0 ? [...stds] : [1, 2, 3];
  for (let i = 0; i < out.length; i++) requirePositive(out[i]!, 'tosStdevAll', `stds[${i}]`);
  return out.sort((a, b) => a - b);
}

class TosStdevAllStream implements IndicatorStream<number, TosStdevAllPoint> {
  private buf: number[] = [];
  value: TosStdevAllPoint | null = null;
  constructor(
    private readonly period: number | null,
    private readonly stds: readonly number[],
    private readonly ddof: number,
  ) {}
  next(value: number): TosStdevAllPoint | null {
    this.buf.push(value);
    if (this.period !== null && this.buf.length > this.period) this.buf.shift();
    const n = this.buf.length;
    if ((this.period !== null && n < this.period) || n < 3 || this.ddof >= n) {
      this.value = null;
      return null;
    }
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const y = this.buf[i]!;
      sx += i;
      sy += y;
      sxx += i * i;
      sxy += i * y;
    }
    const denom = n * sxx - sx * sx;
    const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    const intercept = sy / n - slope * (sx / n);
    const line = slope * (n - 1) + intercept;
    const mean = sy / n;
    let acc = 0;
    for (const y of this.buf) acc += (y - mean) ** 2;
    const sd = Math.sqrt(acc / (n - this.ddof));
    this.value = {
      line,
      lower: this.stds.map((m) => line - m * sd),
      upper: this.stds.map((m) => line + m * sd),
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('tosStdevAll', {
      period: this.period,
      stds: [...this.stds],
      ddof: this.ddof,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TosStdevAllStream {
    const state = readSnapshot(snapshot, 'tosStdevAll');
    const x = new TosStdevAllStream(
      state.numberOrNull('period'),
      state.numbers('stds'),
      state.number('ddof'),
    );
    x.buf = state.numbers('buf');
    x.value = state.cached<TosStdevAllPoint>('value');
    return x;
  }
}

/**
 * Thinkorswim Standard Deviation All: OLS line plus source-standard-deviation bands.
 *
 * Omitting `period` uses **all history seen so far** (a causal, stream-friendly expanding window) —
 * a deliberate TotalFinance choice. This is NOT the single full-series regression overlay that ThinkorSwim
 * / pandas-ta's `tos_stdevall` draws (a constant line over the whole chart); pass an explicit `period`
 * for a fixed rolling window. See docs/compatibility/talib-differences.md.
 */
export const tosStdevAll = withBuiltinMetadata(
  makeIndicator<TosStdevAllParameters, number, TosStdevAllPoint>(
    (p) => {
      // `null` and `undefined` both mean the expanding all-history window, so the disclosed
      // `period: null` can be passed back verbatim and reproduce the same computation.
      const period = p.period == null ? null : requirePeriod(p.period, 'tosStdevAll', 'period', 3);
      const ddof = requireNonNegativeInt(p.ddof ?? 1, 'tosStdevAll', 'ddof');
      if (period !== null) requireAtMost(ddof, period - 1, 'tosStdevAll', 'ddof', 'period - 1');
      return new TosStdevAllStream(period, sortedStds(p.stds), ddof);
    },
    TosStdevAllStream.fromJSON,
    // Warmup rows keep the requested band count (NaN placeholders) so the output shape is stable for
    // chart columns, destructuring, and table pipelines.
    (p) => {
      const bands = sortedStds(p.stds).map(() => NaN);
      return { line: NaN, lower: [...bands], upper: [...bands] };
    },
  ),
  builtinMetadata.tosStdevAllMetadata,
);

// ───────────────────────── bar-since / value-when ─────────────────────────

class BarSinceStream implements IndicatorStream<number, number> {
  private since: number | null = null;
  value: number | null = null;
  next(value: number): number | null {
    if (value > 0) this.since = 0;
    else if (this.since !== null) this.since += 1;
    this.value = this.since; // null until the first true condition
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('barSince', { since: this.since, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): BarSinceStream {
    const state = readSnapshot(snapshot, 'barSince');
    const x = new BarSinceStream();
    x.since = state.numberOrNull('since');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Bars since the input condition (`> 0`) was last true (0 on a true bar; NaN before the first). */
export const barSince = withBuiltinMetadata(
  makeIndicator<Record<string, never>, number, number>(
    () => new BarSinceStream(),
    BarSinceStream.fromJSON,
    nan,
  ),
  builtinMetadata.barSinceMetadata,
);

export interface ValueWhenParameters {
  /** Which past occurrence: 0 = most recent true, 1 = the one before, … Default 0. */
  occurrence?: number;
}

class ValueWhenStream implements IndicatorStream<Pair, number> {
  private hist: number[] = []; // source values on true bars, most recent last (capped)
  value: number | null = null;
  constructor(private readonly occurrence: number) {}
  next(pair: Pair): number | null {
    if (pair.x > 0) {
      this.hist.push(pair.y);
      if (this.hist.length > this.occurrence + 1) this.hist.shift();
    }
    if (this.hist.length < this.occurrence + 1) {
      this.value = null;
      return null;
    }
    this.value = this.hist[this.hist.length - 1 - this.occurrence]!;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('valueWhen', {
      occurrence: this.occurrence,
      hist: [...this.hist],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ValueWhenStream {
    const state = readSnapshot(snapshot, 'valueWhen');
    const x = new ValueWhenStream(state.number('occurrence'));
    x.hist = state.numbers('hist');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** The source (`y`) value when the condition (`x > 0`) was last true (the `occurrence`-th most recent). */
export const valueWhen = withBuiltinMetadata(
  makeIndicator<ValueWhenParameters, Pair, number>(
    (p) => new ValueWhenStream(requireNonNegativeInt(p.occurrence ?? 0, 'valueWhen', 'occurrence')),
    ValueWhenStream.fromJSON,
    nan,
  ),
  builtinMetadata.valueWhenMetadata,
);

// ───────────────────────── conventional aliases ─────────────────────────

/** Rolling mean (alias of `sma`). */
export const rollingMean = sma;
/** Rolling beta vs a benchmark (alias of `beta`). */
export const rollingBeta = beta;
/** Rolling Pearson correlation (alias of `correl`). */
export const rollingCorrelation = correl;
/** Bars-ago of the rolling window high (alias of `rollingMaxIndex`). */
export const highestBars = rollingMaxIndex;
/** Bars-ago of the rolling window low (alias of `rollingMinIndex`). */
export const lowestBars = rollingMinIndex;
