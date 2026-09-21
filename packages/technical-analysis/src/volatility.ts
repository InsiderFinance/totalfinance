/**
 * Volatility indicators (spec §13.3).
 *
 * NATR, Bollinger Width & %B, Keltner Channels, Donchian Channels, rolling standard deviation &
 * variance, and the OHLC volatility-estimator family (close-to-close historical, Parkinson,
 * Garman-Klass, Rogers-Satchell, Yang-Zhang) plus Chaikin Volatility. ATR and Bollinger Bands live in
 * their own modules. Each indicator is a serializable stream wrapped into the aligned batch+stream
 * facade.
 *
 * Volatility estimators REQUIRE `annualization` — the bars per year that scales the per-bar σ by
 * √annualization (252 daily, 52 weekly, 12 monthly) or `1` for the per-bar σ. There is no default:
 * a per-bar σ handed to `@totalfinance/volatility`'s annualized consumers is wrong by √252, silently.
 */

import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { BollingerStream } from './bands.js';
import { AtrStream } from './bars.js';
import { EmaStream, RmaStream } from './moving-averages.js';
import { requirePeriod, requirePositive, requireAnnualization } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

const nanNum = (): number => NaN;

function maxOf(xs: number[]): number {
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! > m) m = xs[i]!;
  return m;
}
function minOf(xs: number[]): number {
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! < m) m = xs[i]!;
  return m;
}
function openOf(bar: BarInput): number {
  return bar.open ?? bar.close;
}

export interface PeriodParameters {
  /** Lookback window. Defaults: NATR 14, Donchian 20; echoed via `.explain()`. */
  period?: number;
}

// ───────────────────────── NATR ─────────────────────────

class NatrStream implements IndicatorStream<BarInput, number> {
  private atr: AtrStream;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'NatrStream', 'period', 1, 'bars');
    this.atr = new AtrStream(period);
  }
  next(bar: BarInput): number | null {
    const a = this.atr.next(bar);
    this.value = a === null || bar.close === 0 ? (a === null ? null : NaN) : (100 * a) / bar.close;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('natr', { atr: this.atr.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): NatrStream {
    const state = readSnapshot(snapshot, 'natr');
    const x = new NatrStream(1);
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const natr = withBuiltinMetadata(
  makeIndicator<PeriodParameters, BarInput, number>(
    (p) => new NatrStream(requirePeriod(p.period ?? 14, 'natr')),
    NatrStream.fromJSON,
    nanNum,
  ),
  builtinMetadata.natrMetadata,
);

// ───────────────────────── Bollinger Width & %B ─────────────────────────

export interface BollingerParameters {
  period: number;
  standardDeviation?: number;
}

class BollingerBandFieldStream implements IndicatorStream<number, number> {
  private inner: BollingerStream;
  value: number | null = null;
  private readonly field: 'bandwidth' | 'percentB';
  private readonly kind: string;
  constructor(parameters: {
    period: number;
    standardDeviation: number;
    field: 'bandwidth' | 'percentB';
    kind: string;
  }) {
    requireStreamParameters(
      'BollingerBandFieldStream.constructor#0',
      'BollingerBandFieldStream',
      parameters,
    );
    const { period, standardDeviation, field, kind } = parameters;
    this.field = field;
    this.kind = kind;

    this.inner = new BollingerStream({ period, standardDeviation: standardDeviation });
  }
  next(value: number): number | null {
    const r = this.inner.next(value);
    this.value = r === null ? null : r[this.field];
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    // `field` is NOT serialized: `BollingerBandFieldStream.restore(field, kind)` binds it, and it is implied by
    // the kind (`bollingerBandWidth` / `bollingerPercentB`) besides.
    return snapshotOf(this.kind, {
      inner: this.inner.toJSON(),
      value: this.value,
    });
  }
  static restore(field: 'bandwidth' | 'percentB', kind: string) {
    return (s: TechnicalAnalysisSnapshot): BollingerBandFieldStream => {
      const state = readSnapshot(s, kind);
      const x = new BollingerBandFieldStream({ period: 1, standardDeviation: 2, field, kind });
      x.inner = BollingerStream.fromJSON(state.child('inner'));
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

export const bollingerBandWidth = withBuiltinMetadata(
  makeIndicator<BollingerParameters, number, number>(
    (p) =>
      new BollingerBandFieldStream({
        period: requirePeriod(p.period, 'bollingerBandWidth'),
        standardDeviation: requirePositive(
          p.standardDeviation ?? 2,
          'bollingerBandWidth',
          'standardDeviation',
        ),
        field: 'bandwidth',
        kind: 'bollingerBandWidth',
      }),
    BollingerBandFieldStream.restore('bandwidth', 'bollingerBandWidth'),
    nanNum,
  ),
  builtinMetadata.bollingerBandWidthMetadata,
);
export const bollingerPercentB = withBuiltinMetadata(
  makeIndicator<BollingerParameters, number, number>(
    (p) =>
      new BollingerBandFieldStream({
        period: requirePeriod(p.period, 'bollingerPercentB'),
        standardDeviation: requirePositive(
          p.standardDeviation ?? 2,
          'bollingerPercentB',
          'standardDeviation',
        ),
        field: 'percentB',
        kind: 'bollingerPercentB',
      }),
    BollingerBandFieldStream.restore('percentB', 'bollingerPercentB'),
    nanNum,
  ),
  builtinMetadata.bollingerPercentBMetadata,
);

// ───────────────────────── Keltner Channels ─────────────────────────

export interface KeltnerParameters {
  /** EMA midline lookback. Defaults to 20 (the standard Keltner channel); echoed via `.explain()`. */
  period?: number;
  atrPeriod?: number;
  multiplier?: number;
}
export interface ChannelPoint {
  upper: number;
  middle: number;
  lower: number;
}

class KeltnerStream implements IndicatorStream<BarInput, ChannelPoint> {
  private ema: EmaStream;
  private atr: AtrStream;
  value: ChannelPoint | null = null;
  private readonly mult: number;
  constructor(parameters: { period: number; atrPeriod: number; mult: number }) {
    requireStreamParameters('KeltnerStream.constructor#0', 'KeltnerStream', parameters);
    const { period, atrPeriod, mult } = parameters;
    this.mult = mult;

    this.ema = new EmaStream(period);
    this.atr = new AtrStream(atrPeriod);
  }
  next(bar: BarInput): ChannelPoint | null {
    const mid = this.ema.next(bar.close);
    const a = this.atr.next(bar);
    if (mid === null || a === null) {
      this.value = null;
      return null;
    }
    this.value = { upper: mid + this.mult * a, middle: mid, lower: mid - this.mult * a };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('keltner', {
      ema: this.ema.toJSON(),
      atr: this.atr.toJSON(),
      mult: this.mult,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): KeltnerStream {
    const state = readSnapshot(snapshot, 'keltner');
    const x = new KeltnerStream({ period: 1, atrPeriod: 1, mult: state.number('mult') });
    x.ema = EmaStream.fromJSON(state.child('ema'));
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.value = state.cached<ChannelPoint>('value');
    return x;
  }
}

export const keltner = withBuiltinMetadata(
  makeIndicator<KeltnerParameters, BarInput, ChannelPoint>(
    (p) =>
      new KeltnerStream({
        period: requirePeriod(p.period ?? 20, 'keltner'),
        // The standard Keltner channel: EMA 20 mid, 10-period ATR bands, multiplier 2.
        atrPeriod: requirePeriod(p.atrPeriod ?? 10, 'keltner', 'atrPeriod'),
        mult: requirePositive(p.multiplier ?? 2, 'keltner', 'multiplier'),
      }),
    KeltnerStream.fromJSON,
    () => ({ upper: NaN, middle: NaN, lower: NaN }),
  ),
  builtinMetadata.keltnerMetadata,
);

// ───────────────────────── Donchian Channels ─────────────────────────

class DonchianStream implements IndicatorStream<BarInput, ChannelPoint> {
  private highs: number[] = [];
  private lows: number[] = [];
  value: ChannelPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'DonchianStream');
  }
  next(bar: BarInput): ChannelPoint | null {
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.highs.length > this.period) {
      this.highs.shift();
      this.lows.shift();
    }
    if (this.highs.length < this.period) {
      this.value = null;
      return null;
    }
    const upper = maxOf(this.highs);
    const lower = minOf(this.lows);
    this.value = { upper, middle: (upper + lower) / 2, lower };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('donchian', {
      period: this.period,
      highs: [...this.highs],
      lows: [...this.lows],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): DonchianStream {
    const state = readSnapshot(snapshot, 'donchian');
    const x = new DonchianStream(state.lookback('period'));
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<ChannelPoint>('value');
    return x;
  }
}

export const donchian = withBuiltinMetadata(
  makeIndicator<PeriodParameters, BarInput, ChannelPoint>(
    (p) => new DonchianStream(requirePeriod(p.period ?? 20, 'donchian')),
    DonchianStream.fromJSON,
    () => ({ upper: NaN, middle: NaN, lower: NaN }),
  ),
  builtinMetadata.donchianMetadata,
);

// ───────────────────────── rolling stddev / variance ─────────────────────────

export interface StandardDeviationParameters {
  period: number;
  /** Use the sample (n−1) estimator instead of the population (n) one. Default false. */
  sample?: boolean;
}

/** The moment family: one class computes both, and reads which one it is off the snapshot. */
const MOMENT_KINDS = ['standardDeviation', 'variance'] as const;
type MomentKind = (typeof MOMENT_KINDS)[number];

class MomentStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  private readonly period: number;
  private readonly sample: boolean;
  private readonly variance: boolean;
  private readonly kind: string;
  constructor(parameters: {
    period: number;
    sample: boolean;
    variance: boolean;
    kind: MomentKind;
  }) {
    requireStreamParameters('MomentStream.constructor#0', 'MomentStream', parameters);
    const { period, sample, variance, kind } = parameters;
    this.period = period;
    this.sample = sample;
    this.variance = variance;
    this.kind = kind;
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    let sum = 0;
    for (const x of this.buf) sum += x;
    const mean = sum / this.period;
    let acc = 0;
    for (const x of this.buf) {
      const d = x - mean;
      acc += d * d;
    }
    const denom = this.sample ? this.period - 1 : this.period;
    const varr = denom <= 0 ? 0 : Math.max(0, acc / denom);
    this.value = this.variance ? varr : Math.sqrt(varr);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, {
      period: this.period,
      sample: this.sample,
      variance: this.variance,
      buf: [...this.buf],
      value: this.value,
    });
  }
  // restore the sample/variance flags from the snapshot, not from baked-in args, so a `sample: true`
  // stream resumes in sample mode (streaming-parity law).
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MomentStream {
    const state = readSnapshot(snapshot, MOMENT_KINDS);
    const x = new MomentStream({
      period: state.lookback('period'),
      sample: state.boolean('sample'),
      variance: state.boolean('variance'),
      kind: state.kind,
    });
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const standardDeviation = withBuiltinMetadata(
  makeIndicator<StandardDeviationParameters, number, number>(
    (p) => {
      const sample = p.sample ?? false;
      return new MomentStream({
        period: requirePeriod(p.period, 'standardDeviation', 'period', sample ? 2 : 1),
        sample,
        variance: false,
        kind: 'standardDeviation',
      });
    },
    MomentStream.fromJSON,
    nanNum,
  ),
  builtinMetadata.standardDeviationMetadata,
);
export const variance = withBuiltinMetadata(
  makeIndicator<StandardDeviationParameters, number, number>(
    (p) => {
      const sample = p.sample ?? false;
      return new MomentStream({
        period: requirePeriod(p.period, 'variance', 'period', sample ? 2 : 1),
        sample,
        variance: true,
        kind: 'variance',
      });
    },
    MomentStream.fromJSON,
    nanNum,
  ),
  builtinMetadata.varianceMetadata,
);

// ───────────────────────── close-to-close historical volatility ─────────────────────────

export interface HistoricalVolatilityParameters {
  period: number;
  /** Bars per year: multiplies the per-bar σ by √annualization (252 daily, 52 weekly, 12 monthly); `1` = per-bar σ. Required. */
  annualization: number;
}

class HistoricalVolatilityStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  private buf: number[] = [];
  value: number | null = null;
  private readonly period: number;
  private readonly scale: number;
  constructor(parameters: { period: number; scale: number }) {
    requireStreamParameters(
      'HistoricalVolatilityStream.constructor#0',
      'HistoricalVolatilityStream',
      parameters,
    );
    const { period, scale } = parameters;
    this.period = period;
    this.scale = scale;
  }
  next(value: number): number | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    const r = Math.log(value / this.prev);
    this.prev = value;
    this.buf.push(r);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    let sum = 0;
    for (const x of this.buf) sum += x;
    const mean = sum / this.period;
    let acc = 0;
    for (const x of this.buf) {
      const d = x - mean;
      acc += d * d;
    }
    const sd = Math.sqrt(acc / (this.period - 1)); // sample std of log returns
    this.value = sd * Math.sqrt(this.scale);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('historicalVolatility', {
      period: this.period,
      scale: this.scale,
      prev: this.prev,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): HistoricalVolatilityStream {
    const state = readSnapshot(snapshot, 'historicalVolatility');
    const x = new HistoricalVolatilityStream({
      period: state.lookback('period'),
      scale: state.number('scale'),
    });
    Object.assign(x, { prev: state.numberOrNull('prev') });
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const historicalVolatility = withBuiltinMetadata(
  makeIndicator<HistoricalVolatilityParameters, number, number>(
    (p) =>
      new HistoricalVolatilityStream({
        period: requirePeriod(p.period, 'historicalVolatility', 'period', 2),
        scale: requireAnnualization(p.annualization, 'historicalVolatility'),
      }),
    HistoricalVolatilityStream.fromJSON,
    nanNum,
  ),
  builtinMetadata.historicalVolatilityMetadata,
);

/**
 * Realized volatility — the root-mean-square of log returns over the window (no mean subtraction, the
 * realized-variance convention), versus `historicalVolatility`'s sample standard deviation.
 */
class RealizedVolatilityStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  private buf: number[] = [];
  value: number | null = null;
  private readonly period: number;
  private readonly scale: number;
  constructor(parameters: { period: number; scale: number }) {
    requireStreamParameters(
      'RealizedVolatilityStream.constructor#0',
      'RealizedVolatilityStream',
      parameters,
    );
    const { period, scale } = parameters;
    this.period = period;
    this.scale = scale;
  }
  next(value: number): number | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    const r = Math.log(value / this.prev);
    this.prev = value;
    this.buf.push(r);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    let ss = 0;
    for (const x of this.buf) ss += x * x;
    this.value = Math.sqrt((ss / this.period) * this.scale);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('realizedVolatility', {
      period: this.period,
      scale: this.scale,
      prev: this.prev,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RealizedVolatilityStream {
    const state = readSnapshot(snapshot, 'realizedVolatility');
    const x = new RealizedVolatilityStream({
      period: state.lookback('period'),
      scale: state.number('scale'),
    });
    Object.assign(x, { prev: state.numberOrNull('prev') });
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const realizedVolatility = withBuiltinMetadata(
  makeIndicator<HistoricalVolatilityParameters, number, number>(
    (p) =>
      new RealizedVolatilityStream({
        period: requirePeriod(p.period, 'realizedVolatility'),
        scale: requireAnnualization(p.annualization, 'realizedVolatility'),
      }),
    RealizedVolatilityStream.fromJSON,
    nanNum,
  ),
  builtinMetadata.realizedVolatilityMetadata,
);

// ───────────────────────── range-based OHLC volatility estimators ─────────────────────────

const LN2_4 = 4 * Math.LN2;

/** Generic window of per-bar contributions → σ = √(mean·scale). */
class RangeVolatilityStream implements IndicatorStream<BarInput, number> {
  private buf: number[] = [];
  value: number | null = null;
  private readonly period: number;
  private readonly scale: number;
  private readonly term: (bar: BarInput) => number;
  private readonly kind: string;
  constructor(parameters: {
    period: number;
    scale: number;
    term: (bar: BarInput) => number;
    kind: string;
  }) {
    requireStreamParameters(
      'RangeVolatilityStream.constructor#0',
      'RangeVolatilityStream',
      parameters,
    );
    const { period, scale, term, kind } = parameters;
    this.period = period;
    this.scale = scale;
    this.term = term;
    this.kind = kind;
  }
  next(bar: BarInput): number | null {
    this.buf.push(this.term(bar));
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    let sum = 0;
    for (const x of this.buf) sum += x;
    const meanVar = sum / this.period;
    this.value = Math.sqrt(Math.max(0, meanVar) * this.scale);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, {
      period: this.period,
      scale: this.scale,
      buf: [...this.buf],
      value: this.value,
    });
  }
}

export interface RangeVolatilityParameters {
  period: number;
  /** Bars per year: multiplies the per-bar σ by √annualization (252 daily, 52 weekly, 12 monthly); `1` = per-bar σ. Required. */
  annualization: number;
}

function parkinsonTerm(bar: BarInput): number {
  const lr = Math.log(bar.high / bar.low);
  return (lr * lr) / LN2_4;
}
function garmanKlassTerm(bar: BarInput): number {
  const hl = Math.log(bar.high / bar.low);
  const co = Math.log(bar.close / openOf(bar));
  return 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co;
}
function rogersSatchellTerm(bar: BarInput): number {
  const o = openOf(bar);
  const hc = Math.log(bar.high / bar.close);
  const ho = Math.log(bar.high / o);
  const lc = Math.log(bar.low / bar.close);
  const lo = Math.log(bar.low / o);
  return hc * ho + lc * lo;
}

function rangeVolatilityFacade(kind: string, term: (bar: BarInput) => number) {
  return makeIndicator<RangeVolatilityParameters, BarInput, number>(
    (p) =>
      new RangeVolatilityStream({
        period: requirePeriod(p.period, kind, 'period', 1, 'bars'),
        scale: requireAnnualization(p.annualization, kind, 'bars'),
        term,
        kind,
      }),
    (s) => {
      const state = readSnapshot(s, kind);
      const x = new RangeVolatilityStream({
        period: state.lookback('period'),
        scale: state.number('scale'),
        term,
        kind,
      });
      Object.assign(x, { buf: state.numbers('buf'), value: state.cached<number>('value') });
      return x;
    },
    nanNum,
  );
}

export const parkinson = withBuiltinMetadata(
  rangeVolatilityFacade('parkinson', parkinsonTerm),
  builtinMetadata.parkinsonMetadata,
);
export const garmanKlass = withBuiltinMetadata(
  rangeVolatilityFacade('garmanKlass', garmanKlassTerm),
  builtinMetadata.garmanKlassMetadata,
);
export const rogersSatchell = withBuiltinMetadata(
  rangeVolatilityFacade('rogersSatchell', rogersSatchellTerm),
  builtinMetadata.rogersSatchellMetadata,
);

// ───────────────────────── Yang-Zhang volatility ─────────────────────────

class YangZhangStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private o: number[] = []; // overnight log returns ln(O_t / C_{t-1})
  private c: number[] = []; // open-close log returns ln(C_t / O_t)
  private rs: number[] = []; // Rogers-Satchell terms
  private readonly k: number;
  value: number | null = null;
  private readonly period: number;
  private readonly scale: number;
  constructor(parameters: { period: number; scale: number }) {
    requireStreamParameters('YangZhangStream.constructor#0', 'YangZhangStream', parameters);
    const { period, scale } = parameters;
    this.period = period;
    this.scale = scale;

    const n = period;
    this.k = 0.34 / (1.34 + (n + 1) / (n - 1));
  }
  next(bar: BarInput): number | null {
    if (this.previousClose === null) {
      this.previousClose = bar.close;
      this.value = null;
      return null;
    }
    const open = openOf(bar);
    this.o.push(Math.log(open / this.previousClose));
    this.c.push(Math.log(bar.close / open));
    this.rs.push(rogersSatchellTerm(bar));
    this.previousClose = bar.close;
    if (this.o.length > this.period) {
      this.o.shift();
      this.c.shift();
      this.rs.shift();
    }
    if (this.o.length < this.period) {
      this.value = null;
      return null;
    }
    const n = this.period;
    const variance = (xs: number[]): number => {
      let sum = 0;
      for (const x of xs) sum += x;
      const mean = sum / n;
      let acc = 0;
      for (const x of xs) {
        const d = x - mean;
        acc += d * d;
      }
      return acc / (n - 1);
    };
    const varO = variance(this.o);
    const varC = variance(this.c);
    let rsSum = 0;
    for (const x of this.rs) rsSum += x;
    const varRs = rsSum / n;
    const yz = varO + this.k * varC + (1 - this.k) * varRs;
    this.value = Math.sqrt(Math.max(0, yz) * this.scale);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('yangZhang', {
      period: this.period,
      scale: this.scale,
      previousClose: this.previousClose,
      o: [...this.o],
      c: [...this.c],
      rs: [...this.rs],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): YangZhangStream {
    const state = readSnapshot(snapshot, 'yangZhang');
    const x = new YangZhangStream({
      period: state.lookback('period'),
      scale: state.number('scale'),
    });
    Object.assign(x, { previousClose: state.numberOrNull('previousClose') });
    x.o = state.numbers('o');
    x.c = state.numbers('c');
    x.rs = state.numbers('rs');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const yangZhang = withBuiltinMetadata(
  makeIndicator<RangeVolatilityParameters, BarInput, number>(
    (p) =>
      new YangZhangStream({
        period: requirePeriod(p.period, 'yangZhang', 'period', 2, 'bars'),
        scale: requireAnnualization(p.annualization, 'yangZhang', 'bars'),
      }),
    YangZhangStream.fromJSON,
    nanNum,
  ),
  builtinMetadata.yangZhangMetadata,
);

// ───────────────────────── Chaikin Volatility ─────────────────────────

export interface ChaikinVolatilityParameters {
  period: number;
  rocPeriod?: number;
}

class ChaikinVolatilityStream implements IndicatorStream<BarInput, number> {
  private ema: EmaStream;
  private buf: number[] = [];
  value: number | null = null;
  private readonly rocPeriod: number;
  constructor(parameters: { period: number; rocPeriod: number }) {
    requireStreamParameters(
      'ChaikinVolatilityStream.constructor#0',
      'ChaikinVolatilityStream',
      parameters,
    );
    const { period, rocPeriod } = parameters;
    this.rocPeriod = rocPeriod;

    this.ema = new EmaStream(period);
  }
  next(bar: BarInput): number | null {
    const e = this.ema.next(bar.high - bar.low);
    if (e === null) {
      this.value = null;
      return null;
    }
    this.buf.push(e);
    if (this.buf.length > this.rocPeriod + 1) this.buf.shift();
    if (this.buf.length < this.rocPeriod + 1) {
      this.value = null;
      return null;
    }
    const past = this.buf[0]!;
    this.value = past === 0 ? NaN : ((e - past) / past) * 100;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('chaikinVolatility', {
      rocPeriod: this.rocPeriod,
      ema: this.ema.toJSON(),
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ChaikinVolatilityStream {
    const state = readSnapshot(snapshot, 'chaikinVolatility');
    const x = new ChaikinVolatilityStream({
      period: 1,
      rocPeriod: state.lookback('rocPeriod'),
    });
    x.ema = EmaStream.fromJSON(state.child('ema'));
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const chaikinVolatility = withBuiltinMetadata(
  makeIndicator<ChaikinVolatilityParameters, BarInput, number>(
    (p) =>
      new ChaikinVolatilityStream({
        period: requirePeriod(p.period, 'chaikinVolatility', 'period', 1, 'bars'),
        rocPeriod: requirePeriod(p.rocPeriod ?? p.period, 'chaikinVolatility', 'rocPeriod'),
      }),
    ChaikinVolatilityStream.fromJSON,
    nanNum,
  ),
  builtinMetadata.chaikinVolatilityMetadata,
);

// ───────────────────────── Relative Volatility Index (Dorsey) ─────────────────────────

/**
 * Relative Volatility Index — RSI's logic applied to the rolling standard deviation of price instead
 * of price change: up-day stdev and down-day stdev are Wilder-smoothed and ratioed into [0, 100].
 */
class RviStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  private buf: number[] = [];
  private posRma: RmaStream;
  private negRma: RmaStream;
  value: number | null = null;
  private readonly stdevPeriod: number;
  constructor(parameters: { stdevPeriod: number; smoothPeriod: number }) {
    requireStreamParameters('RviStream.constructor#0', 'RviStream', parameters);
    const { stdevPeriod, smoothPeriod } = parameters;
    this.stdevPeriod = stdevPeriod;

    this.posRma = new RmaStream(smoothPeriod);
    this.negRma = new RmaStream(smoothPeriod);
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.stdevPeriod) this.buf.shift();
    const havePrev = this.prev !== null;
    const prev = this.prev;
    this.prev = value;
    if (this.buf.length < this.stdevPeriod || !havePrev) {
      this.value = null;
      return null;
    }
    let sum = 0;
    for (const x of this.buf) sum += x;
    const mean = sum / this.stdevPeriod;
    let acc = 0;
    for (const x of this.buf) {
      const d = x - mean;
      acc += d * d;
    }
    const std = Math.sqrt(acc / (this.stdevPeriod - 1)); // sample std (pandas-ta convention)
    const up = value > prev! ? std : 0;
    const down = value < prev! ? std : 0;
    const pa = this.posRma.next(up);
    const na = this.negRma.next(down);
    if (pa === null || na === null) {
      this.value = null;
      return null;
    }
    this.value = pa + na === 0 ? 0 : (100 * pa) / (pa + na);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('relativeVolatilityIndex', {
      stdevPeriod: this.stdevPeriod,
      prev: this.prev,
      buf: [...this.buf],
      posRma: this.posRma.toJSON(),
      negRma: this.negRma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RviStream {
    const state = readSnapshot(snapshot, 'relativeVolatilityIndex');
    const x = new RviStream({ stdevPeriod: state.lookback('stdevPeriod'), smoothPeriod: 1 });
    Object.assign(x, { prev: state.numberOrNull('prev') });
    x.buf = state.numbers('buf');
    x.posRma = RmaStream.fromJSON(state.child('posRma'));
    x.negRma = RmaStream.fromJSON(state.child('negRma'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export interface RviParameters {
  period?: number;
  stdevPeriod?: number;
}
export const relativeVolatilityIndex = withBuiltinMetadata(
  makeIndicator<RviParameters, number, number>(
    (p) =>
      new RviStream({
        stdevPeriod: requirePeriod(
          p.stdevPeriod ?? p.period ?? 14,
          'relativeVolatilityIndex',
          'stdevPeriod',
          2,
        ),
        smoothPeriod: requirePeriod(p.period ?? 14, 'relativeVolatilityIndex'),
      }),
    RviStream.fromJSON,
    nanNum,
  ),
  builtinMetadata.relativeVolatilityIndexMetadata,
);

export {
  NatrStream,
  BollingerBandFieldStream,
  KeltnerStream,
  DonchianStream,
  MomentStream,
  HistoricalVolatilityStream,
  RealizedVolatilityStream,
  RangeVolatilityStream,
  YangZhangStream,
  ChaikinVolatilityStream,
  RviStream,
};

export * from './volatility-ext.js';
