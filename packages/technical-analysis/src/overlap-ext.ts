import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import { ErrorCode, InputError } from '@totalfinance/core';
/**
 * Modern moving averages & overlap studies (spec §13.3; pandas-ta parity).
 *
 * Weighted-MA family (Fibonacci / sine / Pascal), Jurik MA, Holt-Winters MA, Rainbow MA, MA ribbon,
 * Gann HiLo Activator, and the VWAP overlays (bands / session / rolling-anchored). Plus the
 * pandas/TradingView price-source aliases `hl2`, `hlc3`, `ohlc4`, `wcp` and the `zlma` MA alias.
 */

import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { SmaStream, trima, zlema } from './moving-averages.js';
import { MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS } from './limits.js';
import { requireSnapshotArrayCardinality } from './snapshot-cardinality.js';
import { averagePrice, medianPrice, typicalPrice, weightedClose } from './transforms.js';
import {
  requireInRange,
  requireOneOf,
  requireParallelStreamCount,
  requirePeriod,
  requirePositive,
} from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

const nan = (): number => NaN;

export interface PeriodParameters {
  period: number;
}

// ───────────────────────── generic windowed weighted MA ─────────────────────────

class WeightedMovingAverageStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  private readonly denom: number;
  value: number | null = null;
  private readonly kind: string;
  private readonly weights: number[];
  constructor(parameters: { kind: string; weights: number[] }) {
    requireStreamParameters(
      'WeightedMovingAverageStream.constructor#0',
      'WeightedMovingAverageStream',
      parameters,
    );
    const { kind, weights } = parameters;
    this.kind = kind;
    this.weights = weights;

    let d = 0;
    for (const w of weights) d += w;
    this.denom = d;
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.weights.length) this.buf.shift();
    if (this.buf.length < this.weights.length) {
      this.value = null;
      return null;
    }
    let num = 0;
    for (let i = 0; i < this.weights.length; i++) num += this.buf[i]! * this.weights[i]!;
    this.value = this.denom === 0 ? NaN : num / this.denom;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, {
      weights: [...this.weights],
      buf: [...this.buf],
      value: this.value,
    });
  }
  static restore(kind: string) {
    return (s: TechnicalAnalysisSnapshot): WeightedMovingAverageStream => {
      const state = readSnapshot(s, kind);
      const x = new WeightedMovingAverageStream({ kind, weights: state.numbers('weights') });
      x.buf = state.numbers('buf');
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

function fibonacciWeights(n: number): number[] {
  const f = new Array<number>(n);
  for (let i = 0; i < n; i++) f[i] = i < 2 ? 1 : f[i - 1]! + f[i - 2]!;
  return f; // ascending → most-recent (last) gets the largest weight
}
function sineWeights(n: number): number[] {
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) w[i] = Math.sin((Math.PI * (i + 1)) / (n + 1));
  return w;
}
function pascalWeights(n: number): number[] {
  // binomial coefficients C(n-1, k)
  const w = new Array<number>(n);
  let c = 1;
  for (let k = 0; k < n; k++) {
    w[k] = c;
    c = (c * (n - 1 - k)) / (k + 1);
  }
  return w;
}

export const fwma = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) =>
      new WeightedMovingAverageStream({
        kind: 'fwma',
        weights: fibonacciWeights(requirePeriod(p.period, 'fwma')),
      }),
    WeightedMovingAverageStream.restore('fwma'),
    nan,
  ),
  builtinMetadata.fwmaMetadata,
);
export const sineWma = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) =>
      new WeightedMovingAverageStream({
        kind: 'sineWma',
        weights: sineWeights(requirePeriod(p.period, 'sineWma')),
      }),
    WeightedMovingAverageStream.restore('sineWma'),
    nan,
  ),
  builtinMetadata.sineWmaMetadata,
);
export const pascalWma = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) =>
      new WeightedMovingAverageStream({
        kind: 'pascalWma',
        weights: pascalWeights(requirePeriod(p.period, 'pascalWma')),
      }),
    WeightedMovingAverageStream.restore('pascalWma'),
    nan,
  ),
  builtinMetadata.pascalWmaMetadata,
);
/** Symmetric (triangular) weighted MA — identical to the triangular MA (`trima`). */
export const symmetricWma = trima;

// ───────────────────────── Jurik MA ─────────────────────────

export interface JmaParameters {
  period: number;
  /** Lag/overshoot trade-off, −100…100 (default 0). */
  phase?: number;
  /** Smoothing power on β (default 1). */
  power?: number;
}

class JmaStream implements IndicatorStream<number, number> {
  private e0 = 0;
  private e1 = 0;
  private e2 = 0;
  private jma = 0;
  private readonly beta: number;
  private readonly alpha: number;
  private readonly phaseRatio: number;
  value: number | null = null;
  constructor(parameters: { period: number; phase: number; power: number }) {
    requireStreamParameters('JmaStream.constructor#0', 'JmaStream', parameters);
    const { period, phase, power } = parameters;
    this.beta = (0.45 * (period - 1)) / (0.45 * (period - 1) + 2);
    this.alpha = Math.pow(this.beta, power);
    this.phaseRatio = phase < -100 ? 0.5 : phase > 100 ? 2.5 : phase / 100 + 1.5;
  }
  next(source: number): number | null {
    const { alpha, beta, phaseRatio } = this;
    this.e0 = (1 - alpha) * source + alpha * this.e0;
    this.e1 = (source - this.e0) * (1 - beta) + beta * this.e1;
    this.e2 = (this.e0 + phaseRatio * this.e1 - this.jma) * (1 - alpha) ** 2 + alpha ** 2 * this.e2;
    this.jma = this.e2 + this.jma;
    this.value = this.jma;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('jma', {
      beta: this.beta,
      alpha: this.alpha,
      phaseRatio: this.phaseRatio,
      e0: this.e0,
      e1: this.e1,
      e2: this.e2,
      jma: this.jma,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): JmaStream {
    const state = readSnapshot(snapshot, 'jma');
    const x = new JmaStream({ period: 2, phase: 0, power: 1 });
    Object.assign(x, {
      beta: state.number('beta'),
      alpha: state.number('alpha'),
      phaseRatio: state.number('phaseRatio'),
      e0: state.number('e0'),
      e1: state.number('e1'),
      e2: state.number('e2'),
      jma: state.number('jma'),
    });
    x.value = state.cached<number>('value');
    return x;
  }
}

export const jma = withBuiltinMetadata(
  makeIndicator<JmaParameters, number, number>(
    (p) =>
      new JmaStream({
        period: requirePeriod(p.period, 'jma'),
        phase: requireInRange(p.phase ?? 0, 'jma', 'phase', -100, 100),
        power: requirePositive(p.power ?? 1, 'jma', 'power'),
      }),
    JmaStream.fromJSON,
    nan,
  ),
  builtinMetadata.jmaMetadata,
);

// ───────────────────────── Holt-Winters MA ─────────────────────────

export interface HwmaParameters {
  /** Level smoothing (levelSmoothing). Default 0.2. */
  levelSmoothing?: number;
  /** Trend smoothing (trendSmoothing). Default 0.1. */
  trendSmoothing?: number;
  /** Acceleration smoothing (accelerationSmoothing). Default 0.1. */
  accelerationSmoothing?: number;
}

class HwmaStream implements IndicatorStream<number, number> {
  private f: number | null = null;
  private v = 0;
  private a = 0;
  value: number | null = null;
  private readonly levelSmoothing: number;
  private readonly trendSmoothing: number;
  private readonly accelerationSmoothing: number;
  constructor(parameters: {
    levelSmoothing: number;
    trendSmoothing: number;
    accelerationSmoothing: number;
  }) {
    requireStreamParameters('HwmaStream.constructor#0', 'HwmaStream', parameters);
    const { levelSmoothing, trendSmoothing, accelerationSmoothing } = parameters;
    this.levelSmoothing = levelSmoothing;
    this.trendSmoothing = trendSmoothing;
    this.accelerationSmoothing = accelerationSmoothing;
  }
  next(price: number): number | null {
    if (this.f === null) {
      this.f = price;
      this.v = 0;
      this.a = 0;
      this.value = price;
      return price;
    }
    const fPrev = this.f;
    const vPrev = this.v;
    const aPrev = this.a;
    this.f =
      (1 - this.levelSmoothing) * (fPrev + vPrev + 0.5 * aPrev) + this.levelSmoothing * price;
    this.v = (1 - this.trendSmoothing) * (vPrev + aPrev) + this.trendSmoothing * (this.f - fPrev);
    this.a =
      (1 - this.accelerationSmoothing) * aPrev + this.accelerationSmoothing * (this.v - vPrev);
    this.value = this.f + this.v + 0.5 * this.a;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    // NB: the velocity term is serialized as `vel`, not `v` — `v` is reserved by the framework for
    // the snapshot schema version (stamped centrally), so a `v` field here would be clobbered.
    return snapshotOf('hwma', {
      levelSmoothing: this.levelSmoothing,
      trendSmoothing: this.trendSmoothing,
      accelerationSmoothing: this.accelerationSmoothing,
      f: this.f,
      vel: this.v,
      a: this.a,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): HwmaStream {
    const state = readSnapshot(snapshot, 'hwma');
    const x = new HwmaStream({
      levelSmoothing: state.number('levelSmoothing'),
      trendSmoothing: state.number('trendSmoothing'),
      accelerationSmoothing: state.number('accelerationSmoothing'),
    });
    Object.assign(x, { f: state.numberOrNull('f'), v: state.number('vel'), a: state.number('a') });
    x.value = state.cached<number>('value');
    return x;
  }
}

export const holtWinterMovingAverage = withBuiltinMetadata(
  makeIndicator<HwmaParameters, number, number>(
    (p) =>
      new HwmaStream({
        levelSmoothing: requireInRange(
          p.levelSmoothing ?? 0.2,
          'holtWinterMovingAverage',
          'levelSmoothing',
          0,
          1,
        ),
        trendSmoothing: requireInRange(
          p.trendSmoothing ?? 0.1,
          'holtWinterMovingAverage',
          'trendSmoothing',
          0,
          1,
        ),
        accelerationSmoothing: requireInRange(
          p.accelerationSmoothing ?? 0.1,
          'holtWinterMovingAverage',
          'accelerationSmoothing',
          0,
          1,
        ),
      }),
    HwmaStream.fromJSON,
    nan,
  ),
  builtinMetadata.holtWinterMovingAverageMetadata,
);

// ───────────────────────── Rainbow MA ─────────────────────────

export interface RainbowParameters {
  period?: number;
  levels?: number;
}

class RainbowMovingAverageStream implements IndicatorStream<number, number> {
  private smas: SmaStream[];
  value: number | null = null;
  constructor(parameters: { period: number; levels: number }) {
    requireStreamParameters(
      'RainbowMovingAverageStream.constructor#0',
      'RainbowMovingAverageStream',
      parameters,
    );
    const { period, levels } = parameters;
    requireParallelStreamCount(levels, 'RainbowMovingAverageStream', 'levels');
    this.smas = Array.from({ length: levels }, () => new SmaStream(period));
  }
  next(value: number): number | null {
    let cur: number | null = value;
    let sum = 0;
    for (const s of this.smas) {
      cur = s.next(cur);
      if (cur === null) {
        this.value = null;
        return null;
      }
      sum += cur;
    }
    this.value = sum / this.smas.length;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rainbowMovingAverage', {
      smas: this.smas.map((s) => s.toJSON()),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RainbowMovingAverageStream {
    requireSnapshotArrayCardinality(snapshot, 'rainbowMovingAverage', 'smas', {
      minimumLength: 1,
      maximumLength: MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS,
      unit: 'nested snapshots',
    });
    const state = readSnapshot(snapshot, 'rainbowMovingAverage');
    const x = new RainbowMovingAverageStream({ period: 1, levels: 1 });
    const smas = state.children('smas');
    requireParallelStreamCount(smas.length, 'RainbowMovingAverageStream.fromJSON', 'smas.length');
    x.smas = smas.map((snap) => SmaStream.fromJSON(snap));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const rainbowMovingAverage = withBuiltinMetadata(
  makeIndicator<RainbowParameters, number, number>(
    (p) =>
      new RainbowMovingAverageStream({
        period: requirePeriod(p.period ?? 2, 'rainbowMovingAverage'),
        levels: requireParallelStreamCount(p.levels ?? 10, 'rainbowMovingAverage', 'levels'),
      }),
    RainbowMovingAverageStream.fromJSON,
    nan,
  ),
  builtinMetadata.rainbowMovingAverageMetadata,
);

// ───────────────────────── MA ribbon ─────────────────────────

export interface MovingAverageRibbonParameters {
  periods?: number[];
}

class MovingAverageRibbonStream implements IndicatorStream<number, number[]> {
  private smas: SmaStream[];
  value: number[] | null = null;
  constructor(periods: number[]) {
    requireParallelStreamCount(periods.length, 'MovingAverageRibbonStream', 'periods.length');
    this.smas = periods.map((p) => new SmaStream(p));
  }
  next(value: number): number[] | null {
    // feed EVERY sub-MA on every bar (they are independent) — never short-circuit, or the
    // longer-period MAs get starved during the shorter ones' warmup.
    const vals = this.smas.map((s) => s.next(value));
    if (vals.some((r) => r === null)) {
      this.value = null;
      return null;
    }
    this.value = vals as number[];
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('movingAverageRibbon', {
      smas: this.smas.map((s) => s.toJSON()),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MovingAverageRibbonStream {
    requireSnapshotArrayCardinality(snapshot, 'movingAverageRibbon', 'smas', {
      minimumLength: 1,
      maximumLength: MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS,
      unit: 'nested snapshots',
    });
    const state = readSnapshot(snapshot, 'movingAverageRibbon');
    const x = Object.create(MovingAverageRibbonStream.prototype) as MovingAverageRibbonStream;
    const smas = state.children('smas');
    requireParallelStreamCount(smas.length, 'MovingAverageRibbonStream.fromJSON', 'smas.length');
    x.smas = smas.map((snap) => SmaStream.fromJSON(snap));
    x.value = state.cached<number[]>('value');
    return x;
  }
}

const DEFAULT_RIBBON = [10, 20, 30, 40, 50];
export const movingAverageRibbon = withBuiltinMetadata(
  makeIndicator<MovingAverageRibbonParameters, number, number[]>(
    (p) => {
      if (p.periods !== undefined && !Array.isArray(p.periods)) {
        throw new InputError(
          `movingAverageRibbon: periods must be an array of periods when provided. Received ${p.periods === null ? 'null' : typeof p.periods}.`,
          { code: ErrorCode.InputWrongType, context: { field: 'periods' } },
        );
      }
      const periods = p.periods ?? DEFAULT_RIBBON;
      requireParallelStreamCount(periods.length, 'movingAverageRibbon', 'periods.length');
      return new MovingAverageRibbonStream(
        periods.map((n, i) => requirePeriod(n, 'movingAverageRibbon', `periods[${i}]`)),
      );
    },
    MovingAverageRibbonStream.fromJSON,
    (p) => (p.periods ?? DEFAULT_RIBBON).map(() => NaN),
  ),
  builtinMetadata.movingAverageRibbonMetadata,
);

// ───────────────────────── Gann HiLo Activator ─────────────────────────

export interface GannHiLoPoint {
  /** The active HiLo line. */
  value: number;
  /** +1 trend up (line = SMA of lows), −1 trend down (line = SMA of highs). */
  trend: number;
}

class GannHiLoStream implements IndicatorStream<BarInput, GannHiLoPoint> {
  private smaHigh: SmaStream;
  private smaLow: SmaStream;
  private prevSmaHigh: number | null = null;
  private prevSmaLow = 0;
  private trend = 1;
  value: GannHiLoPoint | null = null;
  constructor(period: number) {
    requirePeriod(period, 'GannHiLoStream', 'period', 1, 'bars');
    this.smaHigh = new SmaStream(period);
    this.smaLow = new SmaStream(period);
  }
  next(bar: BarInput): GannHiLoPoint | null {
    const sh = this.smaHigh.next(bar.high);
    const sl = this.smaLow.next(bar.low);
    if (sh === null || sl === null) {
      this.value = null;
      return null;
    }
    if (this.prevSmaHigh !== null) {
      if (bar.close > this.prevSmaHigh) this.trend = 1;
      else if (bar.close < this.prevSmaLow) this.trend = -1;
    }
    this.prevSmaHigh = sh;
    this.prevSmaLow = sl;
    this.value = { value: this.trend === 1 ? sl : sh, trend: this.trend };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('gannHighLowActivator', {
      smaHigh: this.smaHigh.toJSON(),
      smaLow: this.smaLow.toJSON(),
      prevSmaHigh: this.prevSmaHigh,
      prevSmaLow: this.prevSmaLow,
      trend: this.trend,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): GannHiLoStream {
    const state = readSnapshot(snapshot, 'gannHighLowActivator');
    const x = new GannHiLoStream(1);
    x.smaHigh = SmaStream.fromJSON(state.child('smaHigh'));
    x.smaLow = SmaStream.fromJSON(state.child('smaLow'));
    Object.assign(x, {
      prevSmaHigh: state.numberOrNull('prevSmaHigh'),
      prevSmaLow: state.number('prevSmaLow'),
      trend: state.number('trend'),
    });
    x.value = state.cached<GannHiLoPoint>('value');
    return x;
  }
}

export const gannHighLowActivator = withBuiltinMetadata(
  makeIndicator<{ period?: number }, BarInput, GannHiLoPoint>(
    (p) => new GannHiLoStream(requirePeriod(p.period ?? 3, 'gannHighLowActivator')),
    GannHiLoStream.fromJSON,
    () => ({ value: NaN, trend: NaN }),
  ),
  builtinMetadata.gannHighLowActivatorMetadata,
);

// ───────────────────────── VWAP bands ─────────────────────────

export interface VwapBandsParameters {
  multiplier?: number;
}
export interface VwapBandsPoint {
  vwap: number;
  upper: number;
  lower: number;
}

class VwapBandsStream implements IndicatorStream<BarInput, VwapBandsPoint> {
  private cumPV = 0;
  private cumV = 0;
  private cumPV2 = 0;
  value: VwapBandsPoint | null = null;
  constructor(private readonly mult: number) {}
  next(bar: BarInput): VwapBandsPoint | null {
    const tp = (bar.high + bar.low + bar.close) / 3;
    const v = bar.volume ?? 0;
    this.cumPV += tp * v;
    this.cumV += v;
    this.cumPV2 += tp * tp * v;
    const vwap = this.cumV === 0 ? tp : this.cumPV / this.cumV;
    const variance = this.cumV === 0 ? 0 : Math.max(0, this.cumPV2 / this.cumV - vwap * vwap);
    const sd = Math.sqrt(variance);
    this.value = { vwap, upper: vwap + this.mult * sd, lower: vwap - this.mult * sd };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('vwapBands', {
      mult: this.mult,
      cumPV: this.cumPV,
      cumV: this.cumV,
      cumPV2: this.cumPV2,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VwapBandsStream {
    const state = readSnapshot(snapshot, 'vwapBands');
    const x = new VwapBandsStream(state.number('mult'));
    Object.assign(x, {
      cumPV: state.number('cumPV'),
      cumV: state.number('cumV'),
      cumPV2: state.number('cumPV2'),
    });
    x.value = state.cached<VwapBandsPoint>('value');
    return x;
  }
}

export const vwapBands = withBuiltinMetadata(
  makeIndicator<VwapBandsParameters, BarInput, VwapBandsPoint>(
    (p) => new VwapBandsStream(requirePositive(p.multiplier ?? 2, 'vwapBands', 'multiplier')),
    VwapBandsStream.fromJSON,
    () => ({ vwap: NaN, upper: NaN, lower: NaN }),
  ),
  builtinMetadata.vwapBandsMetadata,
);

// ───────────────────────── session VWAP (periodic reset) ─────────────────────────

export interface SessionVwapParameters {
  /** Reset the cumulative VWAP every `resetEvery` bars (one trading session's bar count). */
  resetEvery: number;
}

class SessionVwapStream implements IndicatorStream<BarInput, number> {
  private idx = 0;
  private cumPV = 0;
  private cumV = 0;
  value: number | null = null;
  constructor(private readonly resetEvery: number) {
    requirePeriod(resetEvery, 'SessionVwapStream', 'resetEvery', 1, 'bars');
  }
  next(bar: BarInput): number | null {
    if (this.idx % this.resetEvery === 0) {
      this.cumPV = 0;
      this.cumV = 0;
    }
    this.idx++;
    const tp = (bar.high + bar.low + bar.close) / 3;
    const v = bar.volume ?? 0;
    this.cumPV += tp * v;
    this.cumV += v;
    this.value = this.cumV === 0 ? tp : this.cumPV / this.cumV;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('sessionVwap', {
      resetEvery: this.resetEvery,
      idx: this.idx,
      cumPV: this.cumPV,
      cumV: this.cumV,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SessionVwapStream {
    const state = readSnapshot(snapshot, 'sessionVwap');
    const x = new SessionVwapStream(state.number('resetEvery'));
    Object.assign(x, {
      idx: state.number('idx'),
      cumPV: state.number('cumPV'),
      cumV: state.number('cumV'),
    });
    x.value = state.cached<number>('value');
    return x;
  }
}

export const sessionVwap = withBuiltinMetadata(
  makeIndicator<SessionVwapParameters, BarInput, number>(
    (p) =>
      new SessionVwapStream(requirePeriod(p.resetEvery, 'sessionVwap', 'resetEvery', 1, 'bars')),
    SessionVwapStream.fromJSON,
    nan,
  ),
  builtinMetadata.sessionVwapMetadata,
);

// ───────────────────────── rolling auto-anchored VWAP ─────────────────────────

export interface RollingAnchoredVwapParameters {
  /** Rolling lookback to search for the anchor extreme. */
  lookback?: number;
  /** Anchor on the rolling-window lowest low (`'low'`, default) or highest high (`'high'`). */
  anchor?: 'low' | 'high';
}
export interface AnchoredVwapPoint {
  vwap: number;
  /** Bars ago of the current anchor (0 = current bar). */
  anchorBarsAgo: number;
}

class RollingAnchoredVwapStream implements IndicatorStream<BarInput, AnchoredVwapPoint> {
  private tp: number[] = [];
  private volumes: number[] = [];
  private ext: number[] = []; // the high or low used to pick the anchor
  value: AnchoredVwapPoint | null = null;
  private readonly lookback: number;
  private readonly anchorLow: boolean;
  constructor(parameters: { lookback: number; anchorLow: boolean }) {
    requireStreamParameters(
      'RollingAnchoredVwapStream.constructor#0',
      'RollingAnchoredVwapStream',
      parameters,
    );
    const { lookback, anchorLow } = parameters;
    this.lookback = lookback;
    this.anchorLow = anchorLow;
  }
  next(bar: BarInput): AnchoredVwapPoint | null {
    this.tp.push((bar.high + bar.low + bar.close) / 3);
    this.volumes.push(bar.volume ?? 0);
    this.ext.push(this.anchorLow ? bar.low : bar.high);
    if (this.tp.length > this.lookback) {
      this.tp.shift();
      this.volumes.shift();
      this.ext.shift();
    }
    if (this.tp.length < this.lookback) {
      this.value = null;
      return null;
    }
    // anchor = the rolling-window extreme
    let anchorIdx = 0;
    for (let i = 1; i < this.ext.length; i++) {
      if (
        this.anchorLow ? this.ext[i]! < this.ext[anchorIdx]! : this.ext[i]! > this.ext[anchorIdx]!
      ) {
        anchorIdx = i;
      }
    }
    let pv = 0;
    let vv = 0;
    for (let i = anchorIdx; i < this.tp.length; i++) {
      pv += this.tp[i]! * this.volumes[i]!;
      vv += this.volumes[i]!;
    }
    const last = this.tp.length - 1;
    this.value = {
      vwap: vv === 0 ? this.tp[last]! : pv / vv,
      anchorBarsAgo: last - anchorIdx,
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rollingAnchoredVwap', {
      lookback: this.lookback,
      anchorLow: this.anchorLow,
      tp: [...this.tp],
      volumes: [...this.volumes],
      ext: [...this.ext],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RollingAnchoredVwapStream {
    const state = readSnapshot(snapshot, 'rollingAnchoredVwap');
    const x = new RollingAnchoredVwapStream({
      lookback: state.lookback('lookback'),
      anchorLow: state.boolean('anchorLow'),
    });
    x.tp = state.numbers('tp');
    x.volumes = state.numbers('volumes');
    x.ext = state.numbers('ext');
    x.value = state.cached<AnchoredVwapPoint>('value');
    return x;
  }
}

export const rollingAnchoredVwap = withBuiltinMetadata(
  makeIndicator<RollingAnchoredVwapParameters, BarInput, AnchoredVwapPoint>(
    (p) =>
      new RollingAnchoredVwapStream({
        lookback: requirePeriod(p.lookback ?? 50, 'rollingAnchoredVwap', 'lookback'),
        anchorLow:
          requireOneOf(p.anchor ?? 'low', ['low', 'high'], 'rollingAnchoredVwap', 'anchor') ===
          'low',
      }),
    RollingAnchoredVwapStream.fromJSON,
    () => ({ vwap: NaN, anchorBarsAgo: NaN }),
  ),
  builtinMetadata.rollingAnchoredVwapMetadata,
);

// ───────────────────────── price-source aliases ─────────────────────────

/** (high + low) / 2 — alias of `medianPrice`. */
export const hl2 = medianPrice;
/** (high + low + close) / 3 — alias of `typicalPrice`. */
export const hlc3 = typicalPrice;
/** (open + high + low + close) / 4 — alias of `averagePrice`. */
export const ohlc4 = averagePrice;
/** (high + low + 2·close) / 4 — alias of `weightedClose`. */
export const wcp = weightedClose;
/** Zero-lag EMA — alias of `zlema`. */
export const zlma = zlema;

export {
  WeightedMovingAverageStream,
  JmaStream,
  HwmaStream,
  RainbowMovingAverageStream,
  MovingAverageRibbonStream,
  GannHiLoStream,
  VwapBandsStream,
  SessionVwapStream,
  RollingAnchoredVwapStream,
};
