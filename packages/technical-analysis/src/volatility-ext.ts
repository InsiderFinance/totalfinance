/**
 * Modern volatility indicators & channels (spec §13.3; pandas-ta parity).
 *
 * Aberration bands, Acceleration Bands, the Holt-Winters Channel, the Mass Index, Price Distance,
 * Elder's Market Thermometer, the Ulcer Index, generic ATR Bands, ATR-as-percent, and the
 * Volatility Stop trailing line. (`relativeVolatilityIndex` already ships in `./volatility`.)
 */

import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { AtrStream } from './bars.js';
import { EmaStream, SmaStream } from './moving-averages.js';
import type { ChannelPoint } from './volatility.js';
import { requireInRange, requirePeriod, requirePositive } from './validate.js';

const nan = (): number => NaN;
const nanChannel = (): ChannelPoint => ({ upper: NaN, middle: NaN, lower: NaN });

function maxOf(xs: readonly number[]): number {
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! > m) m = xs[i]!;
  return m;
}
function sumOf(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

// ───────────────────────── Aberration ─────────────────────────

export interface AberrationParameters {
  /** SMA length for the zero-line of HLC3. Default 5. */
  period?: number;
  /** ATR length for the band offset. Default 15. */
  atrPeriod?: number;
}
export interface AberrationPoint {
  /** Zero-line: SMA of HLC3. */
  zeroLine: number;
  /** Upper band: zeroLine + ATR. */
  upperBand: number;
  /** Lower band: zeroLine − ATR. */
  lowerBand: number;
  /** The ATR offset itself. */
  atr: number;
}

class AberrationStream implements IndicatorStream<BarInput, AberrationPoint> {
  private sma: SmaStream;
  private atr: AtrStream;
  value: AberrationPoint | null = null;
  constructor(period: number, atrPeriod: number) {
    this.sma = new SmaStream(period);
    this.atr = new AtrStream(atrPeriod);
  }
  next(bar: BarInput): AberrationPoint | null {
    const zeroLine = this.sma.next((bar.high + bar.low + bar.close) / 3);
    const atr = this.atr.next(bar);
    if (zeroLine === null || atr === null) {
      this.value = null;
      return null;
    }
    this.value = { zeroLine, upperBand: zeroLine + atr, lowerBand: zeroLine - atr, atr };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('aberration', {
      sma: this.sma.toJSON(),
      atr: this.atr.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AberrationStream {
    const state = readSnapshot(snapshot, 'aberration');
    const x = new AberrationStream(1, 1);
    x.sma = SmaStream.fromJSON(state.child('sma'));
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.value = state.cached<AberrationPoint>('value');
    return x;
  }
}

export const aberration = makeIndicator<AberrationParameters, BarInput, AberrationPoint>(
  (p) =>
    new AberrationStream(
      requirePeriod(p.period ?? 5, 'aberration'),
      requirePeriod(p.atrPeriod ?? 15, 'aberration', 'atrPeriod'),
    ),
  AberrationStream.fromJSON,
  () => ({ zeroLine: NaN, upperBand: NaN, lowerBand: NaN, atr: NaN }),
);

// ───────────────────────── Acceleration Bands ─────────────────────────

export interface AccelerationBandsParameters {
  period?: number;
  /** Width factor on the high−low/high+low ratio. Default 4. */
  multiplier?: number;
}

class AccelerationBandsStream implements IndicatorStream<BarInput, ChannelPoint> {
  private upper: SmaStream;
  private mid: SmaStream;
  private lower: SmaStream;
  value: ChannelPoint | null = null;
  constructor(
    period: number,
    private readonly mult: number,
  ) {
    this.upper = new SmaStream(period);
    this.mid = new SmaStream(period);
    this.lower = new SmaStream(period);
  }
  next(bar: BarInput): ChannelPoint | null {
    const denom = bar.high + bar.low;
    const ratio = denom === 0 ? 0 : (this.mult * (bar.high - bar.low)) / denom;
    // Feed all three independent SMAs every bar (no short-circuit starvation).
    const u = this.upper.next(bar.high * (1 + ratio));
    const m = this.mid.next(bar.close);
    const l = this.lower.next(bar.low * (1 - ratio));
    if (u === null || m === null || l === null) {
      this.value = null;
      return null;
    }
    this.value = { upper: u, middle: m, lower: l };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('accelerationBands', {
      mult: this.mult,
      upper: this.upper.toJSON(),
      mid: this.mid.toJSON(),
      lower: this.lower.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AccelerationBandsStream {
    const state = readSnapshot(snapshot, 'accelerationBands');
    const x = new AccelerationBandsStream(1, state.number('mult'));
    x.upper = SmaStream.fromJSON(state.child('upper'));
    x.mid = SmaStream.fromJSON(state.child('mid'));
    x.lower = SmaStream.fromJSON(state.child('lower'));
    x.value = state.cached<ChannelPoint>('value');
    return x;
  }
}

export const accelerationBands = makeIndicator<AccelerationBandsParameters, BarInput, ChannelPoint>(
  (p) =>
    new AccelerationBandsStream(
      requirePeriod(p.period ?? 20, 'accelerationBands'),
      requirePositive(p.multiplier ?? 4, 'accelerationBands', 'multiplier'),
    ),
  AccelerationBandsStream.fromJSON,
  nanChannel,
);

// ───────────────────────── Holt-Winters Channel ─────────────────────────

export interface HoltWinterChannelParameters {
  /** Level smoothing. Default 0.2. */
  levelSmoothing?: number;
  /** Trend smoothing. Default 0.1. */
  trendSmoothing?: number;
  /** Acceleration smoothing. Default 0.1. */
  accelerationSmoothing?: number;
  /** Variance smoothing for the channel width. Default 0.1. */
  varianceSmoothing?: number;
  /** Standard-deviation multiplier for the bands. Default 1. */
  scalar?: number;
}

class HoltWinterChannelStream implements IndicatorStream<number, ChannelPoint> {
  private lastF = 0;
  private lastV = 0;
  private lastA = 0;
  private lastVar = 0;
  private lastResult = 0;
  private started = false;
  value: ChannelPoint | null = null;
  private readonly levelSmoothing: number;
  private readonly trendSmoothing: number;
  private readonly accelerationSmoothing: number;
  private readonly varianceSmoothing: number;
  private readonly scalar: number;
  constructor({
    levelSmoothing,
    trendSmoothing,
    accelerationSmoothing,
    varianceSmoothing,
    scalar,
  }: {
    levelSmoothing: number;
    trendSmoothing: number;
    accelerationSmoothing: number;
    varianceSmoothing: number;
    scalar: number;
  }) {
    this.levelSmoothing = levelSmoothing;
    this.trendSmoothing = trendSmoothing;
    this.accelerationSmoothing = accelerationSmoothing;
    this.varianceSmoothing = varianceSmoothing;
    this.scalar = scalar;
  }
  next(price: number): ChannelPoint | null {
    if (!this.started) {
      this.lastF = price;
      this.lastResult = price;
      this.started = true;
    }
    const F =
      (1 - this.levelSmoothing) * (this.lastF + this.lastV + 0.5 * this.lastA) +
      this.levelSmoothing * price;
    const V =
      (1 - this.trendSmoothing) * (this.lastV + this.lastA) +
      this.trendSmoothing * (F - this.lastF);
    const A =
      (1 - this.accelerationSmoothing) * this.lastA + this.accelerationSmoothing * (V - this.lastV);
    const result = F + V + 0.5 * A;
    const variance =
      (1 - this.varianceSmoothing) * this.lastVar +
      this.varianceSmoothing * (price - this.lastResult) ** 2;
    const standardDeviation = Math.sqrt(this.lastVar); // uses the prior variance, per the HWC definition
    this.lastF = F;
    this.lastV = V;
    this.lastA = A;
    this.lastVar = variance;
    this.lastResult = result;
    this.value = {
      upper: result + this.scalar * standardDeviation,
      middle: result,
      lower: result - this.scalar * standardDeviation,
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('holtWinterChannel', {
      levelSmoothing: this.levelSmoothing,
      trendSmoothing: this.trendSmoothing,
      accelerationSmoothing: this.accelerationSmoothing,
      varianceSmoothing: this.varianceSmoothing,
      scalar: this.scalar,
      lastF: this.lastF,
      lastV: this.lastV,
      lastA: this.lastA,
      lastVar: this.lastVar,
      lastResult: this.lastResult,
      started: this.started,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): HoltWinterChannelStream {
    const state = readSnapshot(snapshot, 'holtWinterChannel');
    const x = new HoltWinterChannelStream({
      levelSmoothing: state.number('levelSmoothing'),
      trendSmoothing: state.number('trendSmoothing'),
      accelerationSmoothing: state.number('accelerationSmoothing'),
      varianceSmoothing: state.number('varianceSmoothing'),
      scalar: state.number('scalar'),
    });
    x.lastF = state.number('lastF');
    x.lastV = state.number('lastV');
    x.lastA = state.number('lastA');
    x.lastVar = state.number('lastVar');
    x.lastResult = state.number('lastResult');
    x.started = state.boolean('started');
    x.value = state.cached<ChannelPoint>('value');
    return x;
  }
}

export const holtWinterChannel = makeIndicator<HoltWinterChannelParameters, number, ChannelPoint>(
  (p) =>
    new HoltWinterChannelStream({
      levelSmoothing: requireInRange(
        p.levelSmoothing ?? 0.2,
        'holtWinterChannel',
        'levelSmoothing',
        0,
        1,
      ),
      trendSmoothing: requireInRange(
        p.trendSmoothing ?? 0.1,
        'holtWinterChannel',
        'trendSmoothing',
        0,
        1,
      ),
      accelerationSmoothing: requireInRange(
        p.accelerationSmoothing ?? 0.1,
        'holtWinterChannel',
        'accelerationSmoothing',
        0,
        1,
      ),
      varianceSmoothing: requireInRange(
        p.varianceSmoothing ?? 0.1,
        'holtWinterChannel',
        'varianceSmoothing',
        0,
        1,
      ),
      scalar: requirePositive(p.scalar ?? 1, 'holtWinterChannel', 'scalar'),
    }),
  HoltWinterChannelStream.fromJSON,
  nanChannel,
);

// ───────────────────────── Mass Index ─────────────────────────

export interface MassIndexParameters {
  /** EMA length for the high−low range and its re-smoothing. Default 9. */
  fast?: number;
  /** Summation window for the EMA ratio. Default 25. */
  slow?: number;
}

class MassIndexStream implements IndicatorStream<BarInput, number> {
  private ema1: EmaStream;
  private ema2: EmaStream;
  private ratios: number[] = [];
  value: number | null = null;
  constructor(
    fast: number,
    private readonly slow: number,
  ) {
    this.ema1 = new EmaStream(fast);
    this.ema2 = new EmaStream(fast);
  }
  next(bar: BarInput): number | null {
    const e1 = this.ema1.next(bar.high - bar.low);
    if (e1 === null) {
      this.value = null;
      return null;
    }
    const e2 = this.ema2.next(e1); // cascade — e2 consumes e1
    if (e2 === null) {
      this.value = null;
      return null;
    }
    this.ratios.push(e2 === 0 ? 1 : e1 / e2);
    if (this.ratios.length > this.slow) this.ratios.shift();
    if (this.ratios.length < this.slow) {
      this.value = null;
      return null;
    }
    this.value = sumOf(this.ratios);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('massIndex', {
      slow: this.slow,
      ema1: this.ema1.toJSON(),
      ema2: this.ema2.toJSON(),
      ratios: [...this.ratios],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MassIndexStream {
    const state = readSnapshot(snapshot, 'massIndex');
    const x = new MassIndexStream(1, state.lookback('slow'));
    x.ema1 = EmaStream.fromJSON(state.child('ema1'));
    x.ema2 = EmaStream.fromJSON(state.child('ema2'));
    x.ratios = state.numbers('ratios');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const massIndex = makeIndicator<MassIndexParameters, BarInput, number>(
  (p) =>
    new MassIndexStream(
      requirePeriod(p.fast ?? 9, 'massIndex', 'fast'),
      requirePeriod(p.slow ?? 25, 'massIndex', 'slow'),
    ),
  MassIndexStream.fromJSON,
  nan,
);

// ───────────────────────── Price Distance ─────────────────────────

class PriceDistanceStream implements IndicatorStream<BarInput, number> {
  private closes: number[] = [];
  value: number | null = null;
  constructor(private readonly drift: number) {}
  next(bar: BarInput): number | null {
    const open = bar.open ?? bar.close;
    if (this.closes.length < this.drift) {
      this.closes.push(bar.close);
      this.value = null;
      return null;
    }
    const previousClose = this.closes[0]!; // close `drift` bars ago
    this.value =
      2 * (bar.high - bar.low) + Math.abs(open - previousClose) - Math.abs(bar.close - open);
    this.closes.push(bar.close);
    this.closes.shift();
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('priceDistance', {
      drift: this.drift,
      closes: [...this.closes],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PriceDistanceStream {
    const state = readSnapshot(snapshot, 'priceDistance');
    const x = new PriceDistanceStream(state.number('drift'));
    x.closes = state.numbers('closes');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Price Distance — 2·(H−L) + |open − close[drift]| − |close − open|. */
export const priceDistance = makeIndicator<{ drift?: number }, BarInput, number>(
  (p) => new PriceDistanceStream(requirePeriod(p.drift ?? 1, 'priceDistance', 'drift')),
  PriceDistanceStream.fromJSON,
  nan,
);

// ───────────────────────── Elder's Market Thermometer ─────────────────────────

export interface ElderThermometerParameters {
  period?: number;
  /** "Quiet market" factor — thermo below `movingAverage·long` flags a long-friendly regime. Default 2. */
  long?: number;
  /** "Hot market" factor — thermo above `movingAverage·short` flags volatility. Default 0.5. */
  short?: number;
}
export interface ElderThermometerPoint {
  thermo: number;
  movingAverage: number;
  /** 1 when thermo < movingAverage·long (calm). */
  long: number;
  /** 1 when thermo > movingAverage·short (active). */
  short: number;
}

class ElderThermometerStream implements IndicatorStream<BarInput, ElderThermometerPoint> {
  private movingAverage: EmaStream;
  private prevHigh: number | null = null;
  private prevLow = 0;
  value: ElderThermometerPoint | null = null;
  private readonly longK: number;
  private readonly shortK: number;
  constructor({ period, longK, shortK }: { period: number; longK: number; shortK: number }) {
    this.longK = longK;
    this.shortK = shortK;

    this.movingAverage = new EmaStream(period);
  }
  next(bar: BarInput): ElderThermometerPoint | null {
    if (this.prevHigh === null) {
      this.prevHigh = bar.high;
      this.prevLow = bar.low;
      this.value = null;
      return null;
    }
    const thermo = Math.max(Math.abs(this.prevLow - bar.low), Math.abs(bar.high - this.prevHigh));
    this.prevHigh = bar.high;
    this.prevLow = bar.low;
    const m = this.movingAverage.next(thermo);
    if (m === null) {
      this.value = null;
      return null;
    }
    this.value = {
      thermo,
      movingAverage: m,
      long: thermo < m * this.longK ? 1 : 0,
      short: thermo > m * this.shortK ? 1 : 0,
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('elderThermometer', {
      longK: this.longK,
      shortK: this.shortK,
      // Persisted snapshot KEY stays `ma` — the `state` interior is opaque by contract.
      ma: this.movingAverage.toJSON(),
      prevHigh: this.prevHigh,
      prevLow: this.prevLow,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ElderThermometerStream {
    const state = readSnapshot(snapshot, 'elderThermometer');
    const x = new ElderThermometerStream({
      period: 1,
      longK: state.number('longK'),
      shortK: state.number('shortK'),
    });
    x.movingAverage = EmaStream.fromJSON(state.child('ma'));
    x.prevHigh = state.numberOrNull('prevHigh');
    x.prevLow = state.number('prevLow');
    x.value = state.cached<ElderThermometerPoint>('value');
    return x;
  }
}

export const elderThermometer = makeIndicator<
  ElderThermometerParameters,
  BarInput,
  ElderThermometerPoint
>(
  (p) =>
    new ElderThermometerStream({
      period: requirePeriod(p.period ?? 20, 'elderThermometer'),
      longK: requirePositive(p.long ?? 2, 'elderThermometer', 'long'),
      shortK: requirePositive(p.short ?? 0.5, 'elderThermometer', 'short'),
    }),
  ElderThermometerStream.fromJSON,
  () => ({ thermo: NaN, movingAverage: NaN, long: NaN, short: NaN }),
);

// ───────────────────────── Ulcer Index ─────────────────────────

class UlcerIndexStream implements IndicatorStream<number, number> {
  private closes: number[] = [];
  private sq: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {}
  next(close: number): number | null {
    this.closes.push(close);
    if (this.closes.length > this.period) this.closes.shift();
    if (this.closes.length < this.period) {
      this.value = null;
      return null;
    }
    const hc = maxOf(this.closes);
    const downside = hc === 0 ? 0 : (100 * (close - hc)) / hc;
    this.sq.push(downside * downside);
    if (this.sq.length > this.period) this.sq.shift();
    if (this.sq.length < this.period) {
      this.value = null;
      return null;
    }
    this.value = Math.sqrt(sumOf(this.sq) / this.period);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('ulcerIndex', {
      period: this.period,
      closes: [...this.closes],
      sq: [...this.sq],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): UlcerIndexStream {
    const state = readSnapshot(snapshot, 'ulcerIndex');
    const x = new UlcerIndexStream(state.lookback('period'));
    x.closes = state.numbers('closes');
    x.sq = state.numbers('sq');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Ulcer Index — RMS of percent drawdown from the rolling `period` high close. */
export const ulcerIndex = makeIndicator<{ period?: number }, number, number>(
  (p) => new UlcerIndexStream(requirePeriod(p.period ?? 14, 'ulcerIndex')),
  UlcerIndexStream.fromJSON,
  nan,
);

// ───────────────────────── ATR Bands ─────────────────────────

export interface AtrBandsParameters {
  period?: number;
  multiplier?: number;
}

class AtrBandsStream implements IndicatorStream<BarInput, ChannelPoint> {
  private sma: SmaStream;
  private atr: AtrStream;
  value: ChannelPoint | null = null;
  constructor(
    period: number,
    private readonly mult: number,
  ) {
    this.sma = new SmaStream(period);
    this.atr = new AtrStream(period);
  }
  next(bar: BarInput): ChannelPoint | null {
    const mid = this.sma.next(bar.close);
    const atr = this.atr.next(bar);
    if (mid === null || atr === null) {
      this.value = null;
      return null;
    }
    this.value = { upper: mid + this.mult * atr, middle: mid, lower: mid - this.mult * atr };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('atrBands', {
      mult: this.mult,
      sma: this.sma.toJSON(),
      atr: this.atr.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AtrBandsStream {
    const state = readSnapshot(snapshot, 'atrBands');
    const x = new AtrBandsStream(1, state.number('mult'));
    x.sma = SmaStream.fromJSON(state.child('sma'));
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.value = state.cached<ChannelPoint>('value');
    return x;
  }
}

/** ATR Bands — SMA(close) ± multiplier·ATR (an SMA-centred ATR channel). */
export const atrBands = makeIndicator<AtrBandsParameters, BarInput, ChannelPoint>(
  (p) =>
    new AtrBandsStream(
      requirePeriod(p.period ?? 14, 'atrBands'),
      requirePositive(p.multiplier ?? 2, 'atrBands', 'multiplier'),
    ),
  AtrBandsStream.fromJSON,
  nanChannel,
);

// ───────────────────────── ATR percent ─────────────────────────

class PercentAtrStream implements IndicatorStream<BarInput, number> {
  private atr: AtrStream;
  value: number | null = null;
  constructor(period: number) {
    this.atr = new AtrStream(period);
  }
  next(bar: BarInput): number | null {
    const atr = this.atr.next(bar);
    if (atr === null) {
      this.value = null;
      return null;
    }
    this.value = bar.close === 0 ? NaN : (100 * atr) / bar.close;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('percentAtr', { atr: this.atr.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PercentAtrStream {
    const state = readSnapshot(snapshot, 'percentAtr');
    const x = new PercentAtrStream(1);
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.value = state.cached<number>('value');
    return x;
  }
}

/** ATR as a percent of close (a.k.a. ATRP). */
export const percentAtr = makeIndicator<{ period?: number }, BarInput, number>(
  (p) => new PercentAtrStream(requirePeriod(p.period ?? 14, 'percentAtr')),
  PercentAtrStream.fromJSON,
  nan,
);

// ───────────────────────── Volatility Stop ─────────────────────────

export interface VolatilityStopParameters {
  period?: number;
  multiplier?: number;
}
export interface VolatilityStopPoint {
  /** The trailing stop line. */
  stop: number;
  /** +1 long (price above the stop), −1 short. */
  trend: number;
}

class VolatilityStopStream implements IndicatorStream<BarInput, VolatilityStopPoint> {
  private atr: AtrStream;
  private stop = 0;
  private trend = 1;
  private started = false;
  value: VolatilityStopPoint | null = null;
  constructor(
    period: number,
    private readonly mult: number,
  ) {
    this.atr = new AtrStream(period);
  }
  next(bar: BarInput): VolatilityStopPoint | null {
    const atr = this.atr.next(bar);
    if (atr === null) {
      this.value = null;
      return null;
    }
    const offset = this.mult * atr;
    if (!this.started) {
      this.trend = 1;
      this.stop = bar.close - offset;
      this.started = true;
      this.value = { stop: this.stop, trend: this.trend };
      return this.value;
    }
    if (this.trend === 1) {
      this.stop = Math.max(this.stop, bar.close - offset); // ratchet the stop up
      if (bar.close < this.stop) {
        this.trend = -1;
        this.stop = bar.close + offset;
      }
    } else {
      this.stop = Math.min(this.stop, bar.close + offset); // ratchet the stop down
      if (bar.close > this.stop) {
        this.trend = 1;
        this.stop = bar.close - offset;
      }
    }
    this.value = { stop: this.stop, trend: this.trend };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('volatilityStop', {
      mult: this.mult,
      atr: this.atr.toJSON(),
      stop: this.stop,
      trend: this.trend,
      started: this.started,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VolatilityStopStream {
    const state = readSnapshot(snapshot, 'volatilityStop');
    const x = new VolatilityStopStream(1, state.number('mult'));
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.stop = state.number('stop');
    x.trend = state.number('trend');
    x.started = state.boolean('started');
    x.value = state.cached<VolatilityStopPoint>('value');
    return x;
  }
}

export const volatilityStop = makeIndicator<
  VolatilityStopParameters,
  BarInput,
  VolatilityStopPoint
>(
  (p) =>
    new VolatilityStopStream(
      requirePeriod(p.period ?? 20, 'volatilityStop'),
      requirePositive(p.multiplier ?? 2, 'volatilityStop', 'multiplier'),
    ),
  VolatilityStopStream.fromJSON,
  () => ({ stop: NaN, trend: NaN }),
);
