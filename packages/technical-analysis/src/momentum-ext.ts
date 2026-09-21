/**
 * Modern momentum / oscillator coverage (spec §13.3; pandas-ta parity) — part 1.
 *
 * bias, CFO, forecast oscillator, Coppock, CTI, efficiency ratio, center of gravity, psychological
 * line, slope, PVO, Elder Ray, BRAR, KDJ, RVGI, PGO, TRIX histogram, SMI Ergodic, volume-weighted
 * MACD. Each composes the proven base streams and is a serializable batch+stream facade. (RSI, MACD,
 * Stochastic and the Phase-4 oscillators live in their own modules; the harder cycle-style oscillators
 * — QQE, RSX, Schaff, Laguerre, TD Sequential, Squeeze — land in the next slice.)
 */

import {
  ErrorCode,
  InputError,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { type MacdPoint } from './macd.js';
import { EmaStream, SmaStream, VwmaStream, WmaStream } from './moving-averages.js';
import { RocStream, TrixStream, TsiStream } from './oscillators.js';
import { RsiStream } from './rsi.js';
import { LinregStream } from './trend.js';
import { RviStream } from './volatility.js';
import { dirtyRows, dirtySamples, isDirtySample } from './nan-policy.js';
import { requireInRange, requirePeriod, requirePositive } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

const nan = (): number => NaN;

// ───────────────────────── bias ─────────────────────────

export interface PeriodParameters {
  period: number;
}

class BiasStream implements IndicatorStream<number, number> {
  private sma: SmaStream;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'BiasStream');
    this.sma = new SmaStream(period);
  }
  next(value: number): number | null {
    const m = this.sma.next(value);
    this.value = m === null ? null : m === 0 ? NaN : ((value - m) / m) * 100;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('bias', { sma: this.sma.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): BiasStream {
    const state = readSnapshot(snapshot, 'bias');
    const x = new BiasStream(1);
    x.sma = SmaStream.fromJSON(state.child('sma'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const bias = makeIndicator<{ period?: number }, number, number>(
  (p) => new BiasStream(requirePeriod(p.period ?? 26, 'bias')),
  BiasStream.fromJSON,
  nan,
);

// ───────────────────────── CFO / forecast oscillator ─────────────────────────

class LinregOscStream implements IndicatorStream<number, number> {
  private lin: LinregStream;
  value: number | null = null;
  private readonly kind: string;
  private readonly useForecast: boolean;
  constructor(parameters: { period: number; kind: string; useForecast: boolean }) {
    requireStreamParameters('LinregOscStream.constructor#0', 'LinregOscStream', parameters);
    const { period, kind, useForecast } = parameters;
    this.kind = kind;
    this.useForecast = useForecast;

    this.lin = new LinregStream(period);
  }
  next(value: number): number | null {
    const r = this.lin.next(value);
    if (r === null) {
      this.value = null;
      return null;
    }
    const ref = this.useForecast ? r.forecast : r.value;
    this.value = value === 0 ? NaN : ((value - ref) / value) * 100;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    // `useForecast` is NOT serialized: `LinregOscStream.restore(kind, useForecast)` is bound to it,
    // so a stored copy would be a field nothing reads — change it and the restore ignores you.
    return snapshotOf(this.kind, {
      lin: this.lin.toJSON(),
      value: this.value,
    });
  }
  static restore(kind: string, useForecast: boolean) {
    return (s: TechnicalAnalysisSnapshot): LinregOscStream => {
      const state = readSnapshot(s, kind);
      const x = new LinregOscStream({ period: 1, kind, useForecast });
      x.lin = LinregStream.fromJSON(state.child('lin'));
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

/** Chande Forecast Oscillator: % distance of price from its linear-regression value. */
export const cfo = makeIndicator<{ period?: number }, number, number>(
  (p) =>
    new LinregOscStream({
      period: requirePeriod(p.period ?? 14, 'cfo'),
      kind: 'cfo',
      useForecast: false,
    }),
  LinregOscStream.restore('cfo', false),
  nan,
);
/** Forecast Oscillator: % distance of price from its time-series forecast (one bar ahead). */
export const forecastOscillator = makeIndicator<{ period?: number }, number, number>(
  (p) =>
    new LinregOscStream({
      period: requirePeriod(p.period ?? 14, 'forecastOscillator'),
      kind: 'forecastOscillator',
      useForecast: true,
    }),
  LinregOscStream.restore('forecastOscillator', true),
  nan,
);

// ───────────────────────── Coppock curve ─────────────────────────

export interface CoppockParameters {
  longRoc?: number;
  shortRoc?: number;
  wma?: number;
}

class CoppockStream implements IndicatorStream<number, number> {
  private rocLong: RocStream;
  private rocShort: RocStream;
  private wma: WmaStream;
  value: number | null = null;
  constructor(parameters: { longRoc: number; shortRoc: number; wmaPeriod: number }) {
    requireStreamParameters('CoppockStream.constructor#0', 'CoppockStream', parameters);
    const { longRoc, shortRoc, wmaPeriod } = parameters;
    this.rocLong = new RocStream({ period: longRoc, mode: 'roc' });
    this.rocShort = new RocStream({ period: shortRoc, mode: 'roc' });
    this.wma = new WmaStream(wmaPeriod);
  }
  next(value: number): number | null {
    const rl = this.rocLong.next(value);
    const rs = this.rocShort.next(value);
    if (rl === null || rs === null) {
      this.value = null;
      return null;
    }
    this.value = this.wma.next(rl + rs);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('coppock', {
      rocLong: this.rocLong.toJSON(),
      rocShort: this.rocShort.toJSON(),
      wma: this.wma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CoppockStream {
    const state = readSnapshot(snapshot, 'coppock');
    const x = new CoppockStream({ longRoc: 1, shortRoc: 1, wmaPeriod: 1 });
    x.rocLong = RocStream.restore('roc')(state.child('rocLong'));
    x.rocShort = RocStream.restore('roc')(state.child('rocShort'));
    x.wma = WmaStream.fromJSON(state.child('wma'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const coppock = makeIndicator<CoppockParameters, number, number>(
  (p) =>
    new CoppockStream({
      longRoc: requirePeriod(p.longRoc ?? 14, 'coppock', 'longRoc'),
      shortRoc: requirePeriod(p.shortRoc ?? 11, 'coppock', 'shortRoc'),
      wmaPeriod: requirePeriod(p.wma ?? 10, 'coppock', 'wma'),
    }),
  CoppockStream.fromJSON,
  nan,
);

// ───────────────────────── CTI (correlation trend, Ehlers) ─────────────────────────

class CtiStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  private readonly sumX: number;
  private readonly sumX2: number;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'CtiStream');
    const n = period;
    this.sumX = (n * (n - 1)) / 2;
    this.sumX2 = ((n - 1) * n * (2 * n - 1)) / 6;
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    const n = this.period;
    let sumY = 0;
    let sumXY = 0;
    let sumY2 = 0;
    for (let i = 0; i < n; i++) {
      const y = this.buf[i]!;
      sumY += y;
      sumXY += i * y;
      sumY2 += y * y;
    }
    const denom = Math.sqrt((n * this.sumX2 - this.sumX * this.sumX) * (n * sumY2 - sumY * sumY));
    this.value = denom === 0 ? 0 : (n * sumXY - this.sumX * sumY) / denom;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('cti', { period: this.period, buf: [...this.buf], value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CtiStream {
    const state = readSnapshot(snapshot, 'cti');
    const x = new CtiStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const cti = makeIndicator<{ period?: number }, number, number>(
  (p) => new CtiStream(requirePeriod(p.period ?? 12, 'cti')),
  CtiStream.fromJSON,
  nan,
);

// ───────────────────────── efficiency ratio (Kaufman) ─────────────────────────

class EfficiencyRatioStream implements IndicatorStream<number, number> {
  private prices: number[] = [];
  private diffs: number[] = [];
  private volatilitySum = 0;
  /** Non-finite samples inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'EfficiencyRatioStream');
  }
  next(value: number): number | null {
    if (this.prices.length > 0) {
      const d = Math.abs(value - this.prices[this.prices.length - 1]!);
      this.diffs.push(d);
      // Interior-NaN policy: only finite deltas enter the running sum.
      if (isDirtySample(d)) this.nanCount++;
      else this.volatilitySum += d;
      if (this.diffs.length > this.period) {
        const gone = this.diffs.shift()!;
        if (isDirtySample(gone)) this.nanCount--;
        else this.volatilitySum -= gone;
      }
    }
    this.prices.push(value);
    if (this.prices.length > this.period + 1) this.prices.shift();
    if (this.diffs.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      this.value = NaN;
      return this.value;
    }
    const change = Math.abs(value - this.prices[0]!);
    this.value = this.volatilitySum === 0 ? 0 : change / this.volatilitySum;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('efficiencyRatio', {
      period: this.period,
      prices: [...this.prices],
      diffs: [...this.diffs],
      volatilitySum: this.volatilitySum,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): EfficiencyRatioStream {
    const state = readSnapshot(snapshot, 'efficiencyRatio');
    const x = new EfficiencyRatioStream(state.lookback('period'));
    Object.assign(x, { volatilitySum: state.number('volatilitySum') });
    x.prices = state.numbers('prices');
    x.diffs = state.numbers('diffs');
    x.nanCount = dirtySamples(x.diffs);
    x.value = state.cached<number>('value');
    return x;
  }
}

export const efficiencyRatio = makeIndicator<{ period?: number }, number, number>(
  (p) => new EfficiencyRatioStream(requirePeriod(p.period ?? 10, 'efficiencyRatio')),
  EfficiencyRatioStream.fromJSON,
  nan,
);

// ───────────────────────── center of gravity (Ehlers) ─────────────────────────

class CenterOfGravityStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'CenterOfGravityStream');
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    const n = this.period;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const price = this.buf[n - 1 - i]!; // i bars ago (0 = current)
      num += (1 + i) * price;
      den += price;
    }
    this.value = den === 0 ? 0 : -num / den + (n + 1) / 2;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('centerOfGravity', {
      period: this.period,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CenterOfGravityStream {
    const state = readSnapshot(snapshot, 'centerOfGravity');
    const x = new CenterOfGravityStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const centerOfGravity = makeIndicator<{ period?: number }, number, number>(
  (p) => new CenterOfGravityStream(requirePeriod(p.period ?? 10, 'centerOfGravity')),
  CenterOfGravityStream.fromJSON,
  nan,
);

// ───────────────────────── psychological line ─────────────────────────

class PsychologicalLineStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  private ups: number[] = [];
  private sum = 0;
  /** Non-finite samples inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'PsychologicalLineStream');
  }
  next(value: number): number | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    // A non-finite bar is not an "up" bar under `>`; recording it as 0 would understate the ratio
    // with no disclosure, so it enters the window as NaN and gates the output instead.
    const bad = isDirtySample(value) || isDirtySample(this.prev);
    const up = bad ? NaN : value > this.prev ? 1 : 0;
    this.prev = value;
    this.ups.push(up);
    if (bad) this.nanCount++;
    else this.sum += up;
    if (this.ups.length > this.period) {
      const gone = this.ups.shift()!;
      if (isDirtySample(gone)) this.nanCount--;
      else this.sum -= gone;
    }
    if (this.ups.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      this.value = NaN;
      return this.value;
    }
    this.value = (100 * this.sum) / this.period;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('psychologicalLine', {
      period: this.period,
      prev: this.prev,
      ups: [...this.ups],
      sum: this.sum,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PsychologicalLineStream {
    const state = readSnapshot(snapshot, 'psychologicalLine');
    const x = new PsychologicalLineStream(state.lookback('period'));
    Object.assign(x, { prev: state.numberOrNull('prev'), sum: state.number('sum') });
    x.ups = state.numbers('ups');
    x.nanCount = dirtySamples(x.ups);
    x.value = state.cached<number>('value');
    return x;
  }
}

export const psychologicalLine = makeIndicator<{ period?: number }, number, number>(
  (p) => new PsychologicalLineStream(requirePeriod(p.period ?? 12, 'psychologicalLine')),
  PsychologicalLineStream.fromJSON,
  nan,
);

// ───────────────────────── slope (rise / run) ─────────────────────────

class SlopeStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'SlopeStream');
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period + 1) this.buf.shift();
    if (this.buf.length < this.period + 1) {
      this.value = null;
      return null;
    }
    this.value = (value - this.buf[0]!) / this.period;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('slope', { period: this.period, buf: [...this.buf], value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SlopeStream {
    const state = readSnapshot(snapshot, 'slope');
    const x = new SlopeStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const slope = makeIndicator<{ period?: number }, number, number>(
  (p) => new SlopeStream(requirePeriod(p.period ?? 1, 'slope')),
  SlopeStream.fromJSON,
  nan,
);

// ───────────────────────── PVO (percentage volume oscillator) ─────────────────────────

export interface PvoParameters {
  fast?: number;
  slow?: number;
  signal?: number;
}
export interface PvoPoint {
  pvo: number;
  signal: number;
  histogram: number;
}

class PvoStream implements IndicatorStream<BarInput, PvoPoint> {
  private fast: EmaStream;
  private slow: EmaStream;
  private signalEma: EmaStream;
  value: PvoPoint | null = null;
  constructor(parameters: { fast: number; slow: number; signal: number }) {
    requireStreamParameters('PvoStream.constructor#0', 'PvoStream', parameters);
    const { fast, slow, signal } = parameters;
    this.fast = new EmaStream(fast);
    this.slow = new EmaStream(slow);
    this.signalEma = new EmaStream(signal);
  }
  next(bar: BarInput): PvoPoint | null {
    const volume = bar.volume ?? 0;
    const f = this.fast.next(volume);
    const s = this.slow.next(volume);
    if (f === null || s === null || s === 0) {
      this.value = null;
      return null;
    }
    const pvo = ((f - s) / s) * 100;
    const sig = this.signalEma.next(pvo);
    if (sig === null) {
      this.value = null;
      return null;
    }
    this.value = { pvo, signal: sig, histogram: pvo - sig };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('pvo', {
      fast: this.fast.toJSON(),
      slow: this.slow.toJSON(),
      signal: this.signalEma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PvoStream {
    const state = readSnapshot(snapshot, 'pvo');
    const x = new PvoStream({ fast: 1, slow: 1, signal: 1 });
    x.fast = EmaStream.fromJSON(state.child('fast'));
    x.slow = EmaStream.fromJSON(state.child('slow'));
    x.signalEma = EmaStream.fromJSON(state.child('signal'));
    x.value = state.cached<PvoPoint>('value');
    return x;
  }
}

export const pvo = makeIndicator<PvoParameters, BarInput, PvoPoint>(
  (p) =>
    new PvoStream({
      fast: requirePeriod(p.fast ?? 12, 'pvo', 'fast'),
      slow: requirePeriod(p.slow ?? 26, 'pvo', 'slow'),
      signal: requirePeriod(p.signal ?? 9, 'pvo', 'signal'),
    }),
  PvoStream.fromJSON,
  () => ({ pvo: NaN, signal: NaN, histogram: NaN }),
);

// ───────────────────────── Elder Ray ─────────────────────────

export interface ElderRayPoint {
  bull: number;
  bear: number;
}

class ElderRayStream implements IndicatorStream<BarInput, ElderRayPoint> {
  private ema: EmaStream;
  value: ElderRayPoint | null = null;
  constructor(period: number) {
    requirePeriod(period, 'ElderRayStream');
    this.ema = new EmaStream(period);
  }
  next(bar: BarInput): ElderRayPoint | null {
    const e = this.ema.next(bar.close);
    if (e === null) {
      this.value = null;
      return null;
    }
    this.value = { bull: bar.high - e, bear: bar.low - e };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('elderRay', { ema: this.ema.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ElderRayStream {
    const state = readSnapshot(snapshot, 'elderRay');
    const x = new ElderRayStream(1);
    x.ema = EmaStream.fromJSON(state.child('ema'));
    x.value = state.cached<ElderRayPoint>('value');
    return x;
  }
}

export const elderRay = makeIndicator<{ period?: number }, BarInput, ElderRayPoint>(
  (p) => new ElderRayStream(requirePeriod(p.period ?? 13, 'elderRay')),
  ElderRayStream.fromJSON,
  () => ({ bull: NaN, bear: NaN }),
);

// ───────────────────────── BRAR ─────────────────────────

export interface BrarPoint {
  /**
   * AR, the popularity index: `100 · Σ(high − open) / Σ(open − low)` over the window. Measures
   * intraday strength against the open.
   */
  popularityIndex: number;
  /**
   * BR, the willingness index: `100 · Σmax(0, high − prevClose) / Σmax(0, prevClose − low)`.
   * Measures strength against the PRIOR close, which is what distinguishes it from AR.
   */
  willingnessIndex: number;
}

class BrarStream implements IndicatorStream<BarInput, BrarPoint> {
  private previousClose: number | null = null;
  private hoSum = 0; // Σ(high − open)
  private olSum = 0; // Σ(open − low)
  private hcSum = 0; // Σ(high − previousClose)
  private clSum = 0; // Σ(previousClose − low)
  private ho: number[] = [];
  private ol: number[] = [];
  private hc: number[] = [];
  private cl: number[] = [];
  /** Non-finite rows inside each window — the interior-NaN gate (see `./nan-policy`). */
  private nanHoOl = 0;
  private nanHcCl = 0;
  value: BrarPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'BrarStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): BrarPoint | null {
    const open = bar.open ?? bar.close;
    const ho = bar.high - open;
    const ol = open - bar.low;
    this.ho.push(ho);
    this.ol.push(ol);
    // Interior-NaN policy: only finite rows enter the running sums.
    if (isDirtySample(ho) || isDirtySample(ol)) this.nanHoOl++;
    else {
      this.hoSum += ho;
      this.olSum += ol;
    }
    if (this.previousClose !== null) {
      // `Math.max(0, NaN)` is NaN, so a bad prior close stays visible rather than clamping to 0.
      const hc = Math.max(0, bar.high - this.previousClose);
      const cl = Math.max(0, this.previousClose - bar.low);
      this.hc.push(hc);
      this.cl.push(cl);
      if (isDirtySample(hc) || isDirtySample(cl)) this.nanHcCl++;
      else {
        this.hcSum += hc;
        this.clSum += cl;
      }
    }
    this.previousClose = bar.close;
    if (this.ho.length > this.period) {
      const goneHo = this.ho.shift()!;
      const goneOl = this.ol.shift()!;
      if (isDirtySample(goneHo) || isDirtySample(goneOl)) this.nanHoOl--;
      else {
        this.hoSum -= goneHo;
        this.olSum -= goneOl;
      }
    }
    if (this.hc.length > this.period) {
      const goneHc = this.hc.shift()!;
      const goneCl = this.cl.shift()!;
      if (isDirtySample(goneHc) || isDirtySample(goneCl)) this.nanHcCl--;
      else {
        this.hcSum -= goneHc;
        this.clSum -= goneCl;
      }
    }
    if (this.ho.length < this.period || this.hc.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanHoOl > 0 || this.nanHcCl > 0) {
      this.value = { popularityIndex: NaN, willingnessIndex: NaN };
      return this.value;
    }
    this.value = {
      popularityIndex: this.olSum === 0 ? 0 : (100 * this.hoSum) / this.olSum,
      willingnessIndex: this.clSum === 0 ? 0 : (100 * this.hcSum) / this.clSum,
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('brar', {
      period: this.period,
      previousClose: this.previousClose,
      hoSum: this.hoSum,
      olSum: this.olSum,
      hcSum: this.hcSum,
      clSum: this.clSum,
      ho: [...this.ho],
      ol: [...this.ol],
      hc: [...this.hc],
      cl: [...this.cl],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): BrarStream {
    const state = readSnapshot(snapshot, 'brar');
    const x = new BrarStream(state.lookback('period'));
    Object.assign(x, {
      previousClose: state.numberOrNull('previousClose'),
      hoSum: state.number('hoSum'),
      olSum: state.number('olSum'),
      hcSum: state.number('hcSum'),
      clSum: state.number('clSum'),
    });
    x.ho = state.numbers('ho');
    x.ol = state.numbers('ol');
    x.hc = state.numbers('hc');
    x.cl = state.numbers('cl');
    x.nanHoOl = dirtyRows(x.ho, x.ol);
    x.nanHcCl = dirtyRows(x.hc, x.cl);
    x.value = state.cached<BrarPoint>('value');
    return x;
  }
}

export const brar = makeIndicator<{ period?: number }, BarInput, BrarPoint>(
  (p) => new BrarStream(requirePeriod(p.period ?? 26, 'brar')),
  BrarStream.fromJSON,
  () => ({ popularityIndex: NaN, willingnessIndex: NaN }),
);

// ───────────────────────── KDJ ─────────────────────────

export interface KdjParameters {
  period?: number;
  signal?: number;
}
export interface KdjPoint {
  k: number;
  d: number;
  j: number;
}

class KdjStream implements IndicatorStream<BarInput, KdjPoint> {
  private highs: number[] = [];
  private lows: number[] = [];
  private k: number | null = null;
  private d: number | null = null;
  private readonly alpha: number;
  value: KdjPoint | null = null;
  private readonly period: number;
  constructor(parameters: { period: number; signal: number }) {
    requireStreamParameters('KdjStream.constructor#0', 'KdjStream', parameters);
    const { period, signal } = parameters;
    this.period = period;

    this.alpha = 1 / signal;
  }
  next(bar: BarInput): KdjPoint | null {
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
    let hh = this.highs[0]!;
    let ll = this.lows[0]!;
    for (let i = 1; i < this.period; i++) {
      if (this.highs[i]! > hh) hh = this.highs[i]!;
      if (this.lows[i]! < ll) ll = this.lows[i]!;
    }
    const rsv = hh === ll ? 50 : (100 * (bar.close - ll)) / (hh - ll);
    this.k = this.k === null ? rsv : this.k + this.alpha * (rsv - this.k);
    this.d = this.d === null ? this.k : this.d + this.alpha * (this.k - this.d);
    this.value = { k: this.k, d: this.d, j: 3 * this.k - 2 * this.d };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('kdj', {
      period: this.period,
      alpha: this.alpha,
      highs: [...this.highs],
      lows: [...this.lows],
      k: this.k,
      d: this.d,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): KdjStream {
    const state = readSnapshot(snapshot, 'kdj');
    const x = new KdjStream({ period: state.lookback('period'), signal: 1 });
    Object.assign(x, {
      alpha: state.number('alpha'),
      k: state.numberOrNull('k'),
      d: state.numberOrNull('d'),
    });
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<KdjPoint>('value');
    return x;
  }
}

export const kdj = makeIndicator<KdjParameters, BarInput, KdjPoint>(
  (p) =>
    new KdjStream({
      period: requirePeriod(p.period ?? 9, 'kdj'),
      signal: requirePeriod(p.signal ?? 3, 'kdj', 'signal'),
    }),
  KdjStream.fromJSON,
  () => ({ k: NaN, d: NaN, j: NaN }),
);

// ───────────────────────── Relative Vigor Index (RVGI) ─────────────────────────

export interface RvgiPoint {
  rvi: number;
  signal: number;
}

class RvgiStream implements IndicatorStream<BarInput, RvgiPoint> {
  private co: number[] = []; // close − open, last 4
  private hl: number[] = []; // high − low, last 4
  private numSma: SmaStream;
  private denSma: SmaStream;
  private rvis: number[] = []; // last 4 RVI values for the signal swma
  value: RvgiPoint | null = null;
  constructor(period: number) {
    requirePeriod(period, 'RvgiStream');
    this.numSma = new SmaStream(period);
    this.denSma = new SmaStream(period);
  }
  private static swma4(a: number[]): number {
    // most-recent-last; weights 1,2,2,1 over the last four
    const n = a.length;
    return (a[n - 1]! + 2 * a[n - 2]! + 2 * a[n - 3]! + a[n - 4]!) / 6;
  }
  next(bar: BarInput): RvgiPoint | null {
    const open = bar.open ?? bar.close;
    this.co.push(bar.close - open);
    this.hl.push(bar.high - bar.low);
    if (this.co.length > 4) {
      this.co.shift();
      this.hl.shift();
    }
    if (this.co.length < 4) {
      this.value = null;
      return null;
    }
    const num = RvgiStream.swma4(this.co);
    const den = RvgiStream.swma4(this.hl);
    const numS = this.numSma.next(num);
    const denS = this.denSma.next(den);
    if (numS === null || denS === null) {
      this.value = null;
      return null;
    }
    const rvi = denS === 0 ? 0 : numS / denS;
    this.rvis.push(rvi);
    if (this.rvis.length > 4) this.rvis.shift();
    if (this.rvis.length < 4) {
      this.value = null;
      return null;
    }
    this.value = { rvi, signal: RvgiStream.swma4(this.rvis) };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rvgi', {
      co: [...this.co],
      hl: [...this.hl],
      numSma: this.numSma.toJSON(),
      denSma: this.denSma.toJSON(),
      rvis: [...this.rvis],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RvgiStream {
    const state = readSnapshot(snapshot, 'rvgi');
    const x = new RvgiStream(1);
    x.numSma = SmaStream.fromJSON(state.child('numSma'));
    x.denSma = SmaStream.fromJSON(state.child('denSma'));
    x.co = state.numbers('co');
    x.hl = state.numbers('hl');
    x.rvis = state.numbers('rvis');
    x.value = state.cached<RvgiPoint>('value');
    return x;
  }
}

export const relativeVigorIndex = makeIndicator<{ period?: number }, BarInput, RvgiPoint>(
  (p) => new RvgiStream(requirePeriod(p.period ?? 14, 'relativeVigorIndex')),
  RvgiStream.fromJSON,
  () => ({ rvi: NaN, signal: NaN }),
);

// ───────────────────────── PGO (Pretty Good Oscillator) ─────────────────────────

class PgoStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private sma: SmaStream;
  private trEma: EmaStream;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'PgoStream', 'period', 1, 'bars');
    this.sma = new SmaStream(period);
    this.trEma = new EmaStream(period);
  }
  next(bar: BarInput): number | null {
    const tr =
      this.previousClose === null
        ? bar.high - bar.low
        : Math.max(
            bar.high - bar.low,
            Math.abs(bar.high - this.previousClose),
            Math.abs(bar.low - this.previousClose),
          );
    this.previousClose = bar.close;
    const m = this.sma.next(bar.close);
    const atr = this.trEma.next(tr);
    if (m === null || atr === null) {
      this.value = null;
      return null;
    }
    this.value = atr === 0 ? 0 : (bar.close - m) / atr;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('pgo', {
      previousClose: this.previousClose,
      sma: this.sma.toJSON(),
      trEma: this.trEma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PgoStream {
    const state = readSnapshot(snapshot, 'pgo');
    const x = new PgoStream(1);
    Object.assign(x, { previousClose: state.numberOrNull('previousClose') });
    x.sma = SmaStream.fromJSON(state.child('sma'));
    x.trEma = EmaStream.fromJSON(state.child('trEma'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const pgo = makeIndicator<{ period?: number }, BarInput, number>(
  (p) => new PgoStream(requirePeriod(p.period ?? 14, 'pgo')),
  PgoStream.fromJSON,
  nan,
);

// ───────────────────────── TRIX histogram ─────────────────────────

export interface TrixHistogramPoint {
  trix: number;
  signal: number;
  histogram: number;
}

class TrixHistogramStream implements IndicatorStream<number, TrixHistogramPoint> {
  private trix: TrixStream;
  private signalEma: EmaStream;
  value: TrixHistogramPoint | null = null;
  constructor(parameters: { period: number; signal: number }) {
    requireStreamParameters('TrixHistogramStream.constructor#0', 'TrixHistogramStream', parameters);
    const { period, signal } = parameters;
    this.trix = new TrixStream(period);
    this.signalEma = new EmaStream(signal);
  }
  next(value: number): TrixHistogramPoint | null {
    const t = this.trix.next(value);
    if (t === null) {
      this.value = null;
      return null;
    }
    const sig = this.signalEma.next(t);
    if (sig === null) {
      this.value = null;
      return null;
    }
    this.value = { trix: t, signal: sig, histogram: t - sig };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('trixHistogram', {
      trix: this.trix.toJSON(),
      signal: this.signalEma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TrixHistogramStream {
    const state = readSnapshot(snapshot, 'trixHistogram');
    const x = new TrixHistogramStream({ period: 1, signal: 1 });
    x.trix = TrixStream.fromJSON(state.child('trix'));
    x.signalEma = EmaStream.fromJSON(state.child('signal'));
    x.value = state.cached<TrixHistogramPoint>('value');
    return x;
  }
}

export interface TrixHistogramParameters {
  period?: number;
  signal?: number;
}
export const trixHistogram = makeIndicator<TrixHistogramParameters, number, TrixHistogramPoint>(
  (p) =>
    new TrixHistogramStream({
      period: requirePeriod(p.period ?? 15, 'trixHistogram'),
      signal: requirePeriod(p.signal ?? 9, 'trixHistogram', 'signal'),
    }),
  TrixHistogramStream.fromJSON,
  () => ({ trix: NaN, signal: NaN, histogram: NaN }),
);

// ───────────────────────── SMI Ergodic ─────────────────────────

export interface SmiParameters {
  long?: number;
  short?: number;
  signal?: number;
}
export interface SmiPoint {
  smi: number;
  signal: number;
  oscillator: number;
}

class SmiErgodicStream implements IndicatorStream<number, SmiPoint> {
  private tsi: TsiStream;
  value: SmiPoint | null = null;
  constructor(parameters: { long: number; short: number; signal: number }) {
    requireStreamParameters('SmiErgodicStream.constructor#0', 'SmiErgodicStream', parameters);
    const { long, short, signal } = parameters;
    this.tsi = new TsiStream({ long, short, signal });
  }
  next(value: number): SmiPoint | null {
    const t = this.tsi.next(value);
    if (t === null) {
      this.value = null;
      return null;
    }
    this.value = { smi: t.tsi, signal: t.signal, oscillator: t.tsi - t.signal };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('smiErgodic', { tsi: this.tsi.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SmiErgodicStream {
    const state = readSnapshot(snapshot, 'smiErgodic');
    const x = new SmiErgodicStream({ long: 1, short: 1, signal: 1 });
    x.tsi = TsiStream.fromJSON(state.child('tsi'));
    x.value = state.cached<SmiPoint>('value');
    return x;
  }
}

export const smiErgodic = makeIndicator<SmiParameters, number, SmiPoint>(
  (p) =>
    new SmiErgodicStream({
      long: requirePeriod(p.long ?? 20, 'smiErgodic', 'long'),
      short: requirePeriod(p.short ?? 5, 'smiErgodic', 'short'),
      signal: requirePeriod(p.signal ?? 5, 'smiErgodic', 'signal'),
    }),
  SmiErgodicStream.fromJSON,
  () => ({ smi: NaN, signal: NaN, oscillator: NaN }),
);

// ───────────────────────── volume-weighted MACD ─────────────────────────

export interface VwMacdParameters {
  fast?: number;
  slow?: number;
  signal?: number;
}

class VolumeWeightedMacdStream implements IndicatorStream<BarInput, MacdPoint> {
  private fast: VwmaStream;
  private slow: VwmaStream;
  private signalEma: EmaStream;
  value: MacdPoint | null = null;
  constructor(parameters: { fast: number; slow: number; signal: number }) {
    requireStreamParameters(
      'VolumeWeightedMacdStream.constructor#0',
      'VolumeWeightedMacdStream',
      parameters,
    );
    const { fast, slow, signal } = parameters;
    this.fast = new VwmaStream(fast);
    this.slow = new VwmaStream(slow);
    this.signalEma = new EmaStream(signal);
  }
  next(bar: BarInput): MacdPoint | null {
    const f = this.fast.next(bar);
    const s = this.slow.next(bar);
    if (f === null || s === null) {
      this.value = null;
      return null;
    }
    const macd = f - s;
    const sig = this.signalEma.next(macd);
    if (sig === null) {
      this.value = null;
      return null;
    }
    this.value = { macd, signal: sig, histogram: macd - sig };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('volumeWeightedMacd', {
      fast: this.fast.toJSON(),
      slow: this.slow.toJSON(),
      signal: this.signalEma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VolumeWeightedMacdStream {
    const state = readSnapshot(snapshot, 'volumeWeightedMacd');
    const x = new VolumeWeightedMacdStream({ fast: 1, slow: 1, signal: 1 });
    x.fast = VwmaStream.fromJSON(state.child('fast'));
    x.slow = VwmaStream.fromJSON(state.child('slow'));
    x.signalEma = EmaStream.fromJSON(state.child('signal'));
    x.value = state.cached<MacdPoint>('value');
    return x;
  }
}

export const volumeWeightedMacd = makeIndicator<VwMacdParameters, BarInput, MacdPoint>(
  (p) =>
    new VolumeWeightedMacdStream({
      fast: requirePeriod(p.fast ?? 12, 'volumeWeightedMacd', 'fast'),
      slow: requirePeriod(p.slow ?? 26, 'volumeWeightedMacd', 'slow'),
      signal: requirePeriod(p.signal ?? 9, 'volumeWeightedMacd', 'signal'),
    }),
  VolumeWeightedMacdStream.fromJSON,
  () => ({ macd: NaN, signal: NaN, histogram: NaN }),
);

// ───────────────────────── inertia (linreg of RVI) ─────────────────────────

export interface InertiaParameters {
  period?: number;
  rviPeriod?: number;
}

class InertiaStream implements IndicatorStream<number, number> {
  private rvi: RviStream;
  private lin: LinregStream;
  value: number | null = null;
  constructor(parameters: { period: number; rviPeriod: number }) {
    requireStreamParameters('InertiaStream.constructor#0', 'InertiaStream', parameters);
    const { period, rviPeriod } = parameters;
    this.rvi = new RviStream({ stdevPeriod: rviPeriod, smoothPeriod: rviPeriod });
    this.lin = new LinregStream(period);
  }
  next(value: number): number | null {
    const r = this.rvi.next(value);
    if (r === null) {
      this.value = null;
      return null;
    }
    const l = this.lin.next(r);
    this.value = l === null ? null : l.value;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('inertia', {
      rvi: this.rvi.toJSON(),
      lin: this.lin.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): InertiaStream {
    const state = readSnapshot(snapshot, 'inertia');
    const x = new InertiaStream({ period: 1, rviPeriod: 2 });
    x.rvi = RviStream.fromJSON(state.child('rvi'));
    x.lin = LinregStream.fromJSON(state.child('lin'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const inertia = makeIndicator<InertiaParameters, number, number>(
  (p) =>
    new InertiaStream({
      period: requirePeriod(p.period ?? 20, 'inertia'),
      rviPeriod: requirePeriod(p.rviPeriod ?? 14, 'inertia', 'rviPeriod', 2),
    }),
  InertiaStream.fromJSON,
  nan,
);

// ───────────────────────── Laguerre RSI (Ehlers) ─────────────────────────

export interface LaguerreParameters {
  gamma?: number;
}

class LaguerreRsiStream implements IndicatorStream<number, number> {
  private l0: number | null = null;
  private l1 = 0;
  private l2 = 0;
  private l3 = 0;
  value: number | null = null;
  constructor(private readonly gamma: number) {}
  next(price: number): number | null {
    const g = this.gamma;
    if (this.l0 === null) {
      this.l0 = price;
      this.l1 = price;
      this.l2 = price;
      this.l3 = price;
      this.value = 0;
      return 0;
    }
    const l0 = (1 - g) * price + g * this.l0;
    const l1 = -g * l0 + this.l0 + g * this.l1;
    const l2 = -g * l1 + this.l1 + g * this.l2;
    const l3 = -g * l2 + this.l2 + g * this.l3;
    let cu = 0;
    let cd = 0;
    if (l0 >= l1) cu += l0 - l1;
    else cd += l1 - l0;
    if (l1 >= l2) cu += l1 - l2;
    else cd += l2 - l1;
    if (l2 >= l3) cu += l2 - l3;
    else cd += l3 - l2;
    this.l0 = l0;
    this.l1 = l1;
    this.l2 = l2;
    this.l3 = l3;
    this.value = cu + cd === 0 ? 0 : cu / (cu + cd);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('laguerreRsi', {
      gamma: this.gamma,
      l0: this.l0,
      l1: this.l1,
      l2: this.l2,
      l3: this.l3,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): LaguerreRsiStream {
    const state = readSnapshot(snapshot, 'laguerreRsi');
    const x = new LaguerreRsiStream(state.number('gamma'));
    Object.assign(x, {
      l0: state.numberOrNull('l0'),
      l1: state.number('l1'),
      l2: state.number('l2'),
      l3: state.number('l3'),
    });
    x.value = state.cached<number>('value');
    return x;
  }
}

export const laguerreRsi = makeIndicator<LaguerreParameters, number, number>(
  (p) => new LaguerreRsiStream(requireInRange(p.gamma ?? 0.5, 'laguerreRsi', 'gamma', 0, 1)),
  LaguerreRsiStream.fromJSON,
  nan,
);

// ───────────────────────── QQE (Quantitative Qualitative Estimation) ─────────────────────────

export interface QqeParameters {
  rsiPeriod?: number;
  smooth?: number;
  factor?: number;
}
export interface QqePoint {
  rsiMovingAverage: number;
  longBand: number;
  shortBand: number;
}

class QqeStream implements IndicatorStream<number, QqePoint> {
  private rsi: RsiStream;
  private rsiMaEma: EmaStream;
  private atrMa: EmaStream;
  private darEma: EmaStream;
  private prevRsiMa: number | null = null;
  private longBand = 0;
  private shortBand = 0;
  private initialized = false;
  value: QqePoint | null = null;
  private readonly factor: number;
  constructor(parameters: { rsiPeriod: number; smooth: number; factor: number }) {
    requireStreamParameters('QqeStream.constructor#0', 'QqeStream', parameters);
    const { rsiPeriod, smooth, factor } = parameters;
    this.factor = factor;

    const wilders = 2 * rsiPeriod - 1;
    this.rsi = new RsiStream(rsiPeriod);
    this.rsiMaEma = new EmaStream(smooth);
    this.atrMa = new EmaStream(wilders);
    this.darEma = new EmaStream(wilders);
  }
  next(value: number): QqePoint | null {
    const r = this.rsi.next(value);
    if (r === null) {
      this.value = null;
      return null;
    }
    const rm = this.rsiMaEma.next(r);
    if (rm === null) {
      this.value = null;
      return null;
    }
    if (this.prevRsiMa === null) {
      this.prevRsiMa = rm;
      this.value = null;
      return null;
    }
    const atrRsi = Math.abs(rm - this.prevRsiMa);
    const m1 = this.atrMa.next(atrRsi);
    if (m1 === null) {
      this.prevRsiMa = rm;
      this.value = null;
      return null;
    }
    const d = this.darEma.next(m1);
    if (d === null) {
      this.prevRsiMa = rm;
      this.value = null;
      return null;
    }
    const dar = d * this.factor;
    const newLong = rm - dar;
    const newShort = rm + dar;
    if (!this.initialized) {
      this.longBand = newLong;
      this.shortBand = newShort;
      this.initialized = true;
    } else {
      const pl = this.longBand;
      const ps = this.shortBand;
      this.longBand = this.prevRsiMa > pl && rm > pl ? Math.max(pl, newLong) : newLong;
      this.shortBand = this.prevRsiMa < ps && rm < ps ? Math.min(ps, newShort) : newShort;
    }
    this.prevRsiMa = rm;
    this.value = { rsiMovingAverage: rm, longBand: this.longBand, shortBand: this.shortBand };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('qqe', {
      factor: this.factor,
      rsi: this.rsi.toJSON(),
      rsiMaEma: this.rsiMaEma.toJSON(),
      atrMa: this.atrMa.toJSON(),
      darEma: this.darEma.toJSON(),
      prevRsiMa: this.prevRsiMa,
      longBand: this.longBand,
      shortBand: this.shortBand,
      initialized: this.initialized,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): QqeStream {
    const state = readSnapshot(snapshot, 'qqe');
    const x = new QqeStream({ rsiPeriod: 2, smooth: 1, factor: state.number('factor') });
    x.rsi = RsiStream.fromJSON(state.child('rsi'));
    x.rsiMaEma = EmaStream.fromJSON(state.child('rsiMaEma'));
    x.atrMa = EmaStream.fromJSON(state.child('atrMa'));
    x.darEma = EmaStream.fromJSON(state.child('darEma'));
    Object.assign(x, {
      prevRsiMa: state.numberOrNull('prevRsiMa'),
      longBand: state.number('longBand'),
      shortBand: state.number('shortBand'),
      initialized: state.boolean('initialized'),
    });
    x.value = state.cached<QqePoint>('value');
    return x;
  }
}

export const qqe = makeIndicator<QqeParameters, number, QqePoint>(
  (p) =>
    new QqeStream({
      rsiPeriod: requirePeriod(p.rsiPeriod ?? 14, 'qqe', 'rsiPeriod'),
      smooth: requirePeriod(p.smooth ?? 5, 'qqe', 'smooth'),
      factor: requirePositive(p.factor ?? 4.236, 'qqe', 'factor'),
    }),
  QqeStream.fromJSON,
  () => ({ rsiMovingAverage: NaN, longBand: NaN, shortBand: NaN }),
);

// ───────────────────────── RSX (Jurik) ─────────────────────────

/**
 * Jurik RSX — the cascaded double-smoother momentum/|momentum| ratio mapped to [0, 100]. Uses the
 * canonical Jurik filter cascade; the reference's f88/f90 warmup counter is replaced by the framework
 * warmup (emits once `period` bars have been seen).
 */
class RsxStream implements IndicatorStream<number, number> {
  private count = 0;
  private f10: number | null = null;
  private readonly f18: number;
  private readonly f20: number;
  private f28 = 0;
  private f30 = 0;
  private f38 = 0;
  private f40 = 0;
  private f48 = 0;
  private f50 = 0;
  private f58 = 0;
  private f60 = 0;
  private f68 = 0;
  private f70 = 0;
  private f78 = 0;
  private f80 = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'RsxStream');
    this.f18 = 3 / (period + 2);
    this.f20 = 1 - this.f18;
  }
  next(price: number): number | null {
    this.count++;
    const f8 = 100 * price;
    if (this.f10 === null) {
      this.f10 = f8;
      this.value = null;
      return null;
    }
    const v8 = f8 - this.f10;
    this.f10 = f8;
    const { f18, f20 } = this;
    this.f28 = f20 * this.f28 + f18 * v8;
    this.f30 = f18 * this.f28 + f20 * this.f30;
    const vC = this.f28 * 1.5 - this.f30 * 0.5;
    this.f38 = f20 * this.f38 + f18 * vC;
    this.f40 = f18 * this.f38 + f20 * this.f40;
    const v10 = this.f38 * 1.5 - this.f40 * 0.5;
    this.f48 = f20 * this.f48 + f18 * v10;
    this.f50 = f18 * this.f48 + f20 * this.f50;
    const v14 = this.f48 * 1.5 - this.f50 * 0.5;
    this.f58 = f20 * this.f58 + f18 * Math.abs(v8);
    this.f60 = f18 * this.f58 + f20 * this.f60;
    const v18 = this.f58 * 1.5 - this.f60 * 0.5;
    this.f68 = f20 * this.f68 + f18 * v18;
    this.f70 = f18 * this.f68 + f20 * this.f70;
    const v1C = this.f68 * 1.5 - this.f70 * 0.5;
    this.f78 = f20 * this.f78 + f18 * v1C;
    this.f80 = f18 * this.f78 + f20 * this.f80;
    const v20 = this.f78 * 1.5 - this.f80 * 0.5;
    if (this.count <= this.period) {
      this.value = null;
      return null;
    }
    const raw = v20 === 0 ? 50 : (v14 / v20 + 1) * 50;
    this.value = Math.max(0, Math.min(100, raw));
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rsx', {
      period: this.period,
      count: this.count,
      f10: this.f10,
      f28: this.f28,
      f30: this.f30,
      f38: this.f38,
      f40: this.f40,
      f48: this.f48,
      f50: this.f50,
      f58: this.f58,
      f60: this.f60,
      f68: this.f68,
      f70: this.f70,
      f78: this.f78,
      f80: this.f80,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RsxStream {
    const state = readSnapshot(snapshot, 'rsx');
    const x = new RsxStream(state.lookback('period'));
    Object.assign(x, {
      count: state.number('count'),
      f10: state.numberOrNull('f10'),
      f28: state.number('f28'),
      f30: state.number('f30'),
      f38: state.number('f38'),
      f40: state.number('f40'),
      f48: state.number('f48'),
      f50: state.number('f50'),
      f58: state.number('f58'),
      f60: state.number('f60'),
      f68: state.number('f68'),
      f70: state.number('f70'),
      f78: state.number('f78'),
      f80: state.number('f80'),
    });
    x.value = state.cached<number>('value');
    return x;
  }
}

export const rsx = makeIndicator<{ period?: number }, number, number>(
  (p) => new RsxStream(requirePeriod(p.period ?? 14, 'rsx')),
  RsxStream.fromJSON,
  nan,
);

// ───────────────────────── Schaff Trend Cycle ─────────────────────────

export interface StcParameters {
  fast?: number;
  slow?: number;
  cycle?: number;
}

class SchaffTrendCycleStream implements IndicatorStream<number, number> {
  private emaFast: EmaStream;
  private emaSlow: EmaStream;
  private macdBuf: number[] = [];
  private d1: number | null = null;
  private d1Buf: number[] = [];
  private d2: number | null = null;
  value: number | null = null;
  private readonly cycle: number;
  constructor(parameters: { fast: number; slow: number; cycle: number }) {
    requireStreamParameters(
      'SchaffTrendCycleStream.constructor#0',
      'SchaffTrendCycleStream',
      parameters,
    );
    const { fast, slow, cycle } = parameters;
    this.cycle = cycle;

    this.emaFast = new EmaStream(fast);
    this.emaSlow = new EmaStream(slow);
  }
  private static stoch(buf: number[], cur: number, prevSmoothed: number | null): number {
    let lo = buf[0]!;
    let hi = buf[0]!;
    for (const x of buf) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    return hi === lo ? (prevSmoothed ?? 0) : (100 * (cur - lo)) / (hi - lo);
  }
  next(value: number): number | null {
    const ef = this.emaFast.next(value);
    const es = this.emaSlow.next(value);
    if (ef === null || es === null) {
      this.value = null;
      return null;
    }
    const macd = ef - es;
    this.macdBuf.push(macd);
    if (this.macdBuf.length > this.cycle) this.macdBuf.shift();
    if (this.macdBuf.length < this.cycle) {
      this.value = null;
      return null;
    }
    const stoch1 = SchaffTrendCycleStream.stoch(this.macdBuf, macd, this.d1);
    this.d1 = this.d1 === null ? stoch1 : this.d1 + 0.5 * (stoch1 - this.d1);
    this.d1Buf.push(this.d1);
    if (this.d1Buf.length > this.cycle) this.d1Buf.shift();
    if (this.d1Buf.length < this.cycle) {
      this.value = null;
      return null;
    }
    const stoch2 = SchaffTrendCycleStream.stoch(this.d1Buf, this.d1, this.d2);
    this.d2 = this.d2 === null ? stoch2 : this.d2 + 0.5 * (stoch2 - this.d2);
    this.value = Math.max(0, Math.min(100, this.d2));
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('schaffTrendCycle', {
      cycle: this.cycle,
      emaFast: this.emaFast.toJSON(),
      emaSlow: this.emaSlow.toJSON(),
      macdBuf: [...this.macdBuf],
      d1: this.d1,
      d1Buf: [...this.d1Buf],
      d2: this.d2,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SchaffTrendCycleStream {
    const state = readSnapshot(snapshot, 'schaffTrendCycle');
    const x = new SchaffTrendCycleStream({ fast: 1, slow: 1, cycle: state.number('cycle') });
    x.emaFast = EmaStream.fromJSON(state.child('emaFast'));
    x.emaSlow = EmaStream.fromJSON(state.child('emaSlow'));
    Object.assign(x, { d1: state.numberOrNull('d1'), d2: state.numberOrNull('d2') });
    x.macdBuf = state.numbers('macdBuf');
    x.d1Buf = state.numbers('d1Buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const schaffTrendCycle = makeIndicator<StcParameters, number, number>(
  (p) =>
    new SchaffTrendCycleStream({
      fast: requirePeriod(p.fast ?? 23, 'schaffTrendCycle', 'fast'),
      slow: requirePeriod(p.slow ?? 50, 'schaffTrendCycle', 'slow'),
      cycle: requirePeriod(p.cycle ?? 10, 'schaffTrendCycle', 'cycle'),
    }),
  SchaffTrendCycleStream.fromJSON,
  nan,
);

// ───────────────────────── TTM Squeeze ─────────────────────────

function popStdev(buf: number[]): number {
  const n = buf.length;
  let sum = 0;
  for (const x of buf) sum += x;
  const mean = sum / n;
  let acc = 0;
  for (const x of buf) {
    const d = x - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / n);
}
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

/** Shared Bollinger-inside-Keltner squeeze machinery + the LazyBear momentum histogram. */
class SqueezeCore {
  private previousClose: number | null = null;
  private smaKc: SmaStream;
  private trSma: SmaStream;
  private smaBb: SmaStream;
  private bbBuf: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private lin: LinregStream;
  readonly bollingerBandPeriod: number;
  readonly bollingerStandardDeviations: number;
  readonly keltnerChannelPeriod: number;
  constructor(parameters: {
    bollingerBandPeriod: number;
    bollingerStandardDeviations: number;
    keltnerChannelPeriod: number;
  }) {
    requireStreamParameters('SqueezeCore.constructor#0', 'SqueezeCore', parameters);
    const { bollingerBandPeriod, bollingerStandardDeviations, keltnerChannelPeriod } = parameters;
    this.bollingerBandPeriod = bollingerBandPeriod;
    this.bollingerStandardDeviations = bollingerStandardDeviations;
    this.keltnerChannelPeriod = keltnerChannelPeriod;

    this.smaKc = new SmaStream(keltnerChannelPeriod);
    this.trSma = new SmaStream(keltnerChannelPeriod);
    this.smaBb = new SmaStream(bollingerBandPeriod);
    this.lin = new LinregStream(keltnerChannelPeriod);
  }
  /** Returns null until both bands and the momentum regression are warm. */
  update(bar: BarInput): {
    upperBollingerBand: number;
    lowerBollingerBand: number;
    keltnerChannelMiddle: number;
    keltnerChannelRange: number;
    momentum: number;
  } | null {
    // Public per-tick entry: a malformed bar used to fold NaN into every band and poison the
    // window state for all later ticks (first-touch law). Three typeof checks per tick is noise
    // next to the window arithmetic that follows.
    requireArgumentObject('SqueezeCore.update', 'bar', bar);
    requireFiniteFields('SqueezeCore.update', bar, ['high', 'low', 'close'], {
      exampleCall: 'SqueezeCore.update({ high: 11, low: 9, close: 10.5 })',
    });
    const tr =
      this.previousClose === null
        ? bar.high - bar.low
        : Math.max(
            bar.high - bar.low,
            Math.abs(bar.high - this.previousClose),
            Math.abs(bar.low - this.previousClose),
          );
    this.previousClose = bar.close;
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.highs.length > this.keltnerChannelPeriod) {
      this.highs.shift();
      this.lows.shift();
    }
    this.bbBuf.push(bar.close);
    if (this.bbBuf.length > this.bollingerBandPeriod) this.bbBuf.shift();
    const keltnerChannelMiddle = this.smaKc.next(bar.close);
    const keltnerChannelRange = this.trSma.next(tr);
    const bbMid = this.smaBb.next(bar.close);
    if (keltnerChannelMiddle === null || keltnerChannelRange === null || bbMid === null)
      return null;
    if (
      this.highs.length < this.keltnerChannelPeriod ||
      this.bbBuf.length < this.bollingerBandPeriod
    )
      return null;
    const hh = maxOf(this.highs);
    const ll = minOf(this.lows);
    const mm = ((hh + ll) / 2 + keltnerChannelMiddle) / 2;
    const lr = this.lin.next(bar.close - mm);
    if (lr === null) return null;
    const dev = this.bollingerStandardDeviations * popStdev(this.bbBuf);
    return {
      upperBollingerBand: bbMid + dev,
      lowerBollingerBand: bbMid - dev,
      keltnerChannelMiddle,
      keltnerChannelRange,
      momentum: lr.value,
    };
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('squeezeCore', {
      bollingerBandPeriod: this.bollingerBandPeriod,
      bollingerStandardDeviations: this.bollingerStandardDeviations,
      keltnerChannelPeriod: this.keltnerChannelPeriod,
      previousClose: this.previousClose,
      smaKc: this.smaKc.toJSON(),
      trSma: this.trSma.toJSON(),
      smaBb: this.smaBb.toJSON(),
      bbBuf: [...this.bbBuf],
      highs: [...this.highs],
      lows: [...this.lows],
      lin: this.lin.toJSON(),
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SqueezeCore {
    const state = readSnapshot(snapshot, 'squeezeCore');
    const x = new SqueezeCore({
      bollingerBandPeriod: state.number('bollingerBandPeriod'),
      bollingerStandardDeviations: state.number('bollingerStandardDeviations'),
      keltnerChannelPeriod: state.number('keltnerChannelPeriod'),
    });
    Object.assign(x, { previousClose: state.numberOrNull('previousClose') });
    x.smaKc = SmaStream.fromJSON(state.child('smaKc'));
    x.trSma = SmaStream.fromJSON(state.child('trSma'));
    x.smaBb = SmaStream.fromJSON(state.child('smaBb'));
    x.lin = LinregStream.fromJSON(state.child('lin'));
    x.bbBuf = state.numbers('bbBuf');
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    return x;
  }
}

export interface SqueezeParameters {
  bollingerBandPeriod?: number;
  bollingerStandardDeviations?: number;
  keltnerChannelPeriod?: number;
  keltnerChannelMultiplier?: number;
}
export interface SqueezePoint {
  /** 1 when the Bollinger Bands sit inside the Keltner Channel (squeeze on), else 0. */
  on: number;
  /** LazyBear squeeze momentum histogram. */
  momentum: number;
}

class SqueezeStream implements IndicatorStream<BarInput, SqueezePoint> {
  private core: SqueezeCore;
  value: SqueezePoint | null = null;
  private readonly keltnerChannelMultiplier: number;
  constructor(parameters: {
    bollingerBandPeriod: number;
    bollingerStandardDeviations: number;
    keltnerChannelPeriod: number;
    keltnerChannelMultiplier: number;
  }) {
    requireStreamParameters('SqueezeStream.constructor#0', 'SqueezeStream', parameters);
    const {
      bollingerBandPeriod,
      bollingerStandardDeviations,
      keltnerChannelPeriod,
      keltnerChannelMultiplier,
    } = parameters;
    this.keltnerChannelMultiplier = keltnerChannelMultiplier;

    this.core = new SqueezeCore({
      bollingerBandPeriod,
      bollingerStandardDeviations,
      keltnerChannelPeriod,
    });
  }
  next(bar: BarInput): SqueezePoint | null {
    const o = this.core.update(bar);
    if (o === null) {
      this.value = null;
      return null;
    }
    const upperKC = o.keltnerChannelMiddle + this.keltnerChannelMultiplier * o.keltnerChannelRange;
    const lowerKC = o.keltnerChannelMiddle - this.keltnerChannelMultiplier * o.keltnerChannelRange;
    const on = o.lowerBollingerBand > lowerKC && o.upperBollingerBand < upperKC ? 1 : 0;
    this.value = { on, momentum: o.momentum };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('squeeze', {
      keltnerChannelMultiplier: this.keltnerChannelMultiplier,
      core: this.core.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SqueezeStream {
    const state = readSnapshot(snapshot, 'squeeze');
    const x = new SqueezeStream({
      bollingerBandPeriod: 1,
      bollingerStandardDeviations: 1,
      keltnerChannelPeriod: 1,
      keltnerChannelMultiplier: state.number('keltnerChannelMultiplier'),
    });
    x.core = SqueezeCore.fromJSON(state.child('core'));
    x.value = state.cached<SqueezePoint>('value');
    return x;
  }
}

export const squeeze = makeIndicator<SqueezeParameters, BarInput, SqueezePoint>(
  (p) =>
    new SqueezeStream({
      bollingerBandPeriod: requirePeriod(
        p.bollingerBandPeriod ?? 20,
        'squeeze',
        'bollingerBandPeriod',
      ),
      bollingerStandardDeviations: requirePositive(
        p.bollingerStandardDeviations ?? 2,
        'squeeze',
        'bollingerStandardDeviations',
      ),
      keltnerChannelPeriod: requirePeriod(
        p.keltnerChannelPeriod ?? 20,
        'squeeze',
        'keltnerChannelPeriod',
      ),
      keltnerChannelMultiplier: requirePositive(
        p.keltnerChannelMultiplier ?? 1.5,
        'squeeze',
        'keltnerChannelMultiplier',
      ),
    }),
  SqueezeStream.fromJSON,
  () => ({ on: NaN, momentum: NaN }),
);

// ───────────────────────── SqueezePro (3 compression levels) ─────────────────────────

export interface SqueezeProParameters {
  bollingerBandPeriod?: number;
  bollingerStandardDeviations?: number;
  keltnerChannelPeriod?: number;
  /**
   * Keltner multipliers, wide → tight. Default 2.0 / 1.5 / 1.0.
   *
   * Named for the CHANNEL, not the compression level they detect. As `low`/`mid`/`high` they
   * inverted against their own values — `lowMultiplier` was the LARGEST number (2.0, the widest
   * channel, the loosest squeeze) — so the reader had to know which of the two scales the word
   * referred to. The point's fields are now `lowCompression`/`normalCompression`/
   * `highCompression`, so both halves of the indicator say which scale they are on.
   */
  wideKeltnerChannelMultiplier?: number;
  normalKeltnerChannelMultiplier?: number;
  narrowKeltnerChannelMultiplier?: number;
}
export interface SqueezeProPoint {
  /**
   * The three compression levels, named for what they measure.
   *
   * `low`/`mid`/`high` sat beside multipliers that ran the other way — the loosest squeeze uses the
   * WIDEST channel (×2) — so a reader had to know which of two scales each word referred to. Renamed
   * while breaking changes are still cheap.
   */
  /** Loosest compression (BB inside KC×wideKeltnerChannelMultiplier). */
  lowCompression: number;
  /** Normal compression. */
  normalCompression: number;
  /** Tightest compression (BB inside KC×narrowKeltnerChannelMultiplier). */
  highCompression: number;
  momentum: number;
}

class SqueezeProStream implements IndicatorStream<BarInput, SqueezeProPoint> {
  private core: SqueezeCore;
  value: SqueezeProPoint | null = null;
  private readonly wideKeltnerChannelMultiplier: number;
  private readonly normalKeltnerChannelMultiplier: number;
  private readonly narrowKeltnerChannelMultiplier: number;
  constructor(parameters: {
    bollingerBandPeriod: number;
    bollingerStandardDeviations: number;
    keltnerChannelPeriod: number;
    wideKeltnerChannelMultiplier: number;
    normalKeltnerChannelMultiplier: number;
    narrowKeltnerChannelMultiplier: number;
  }) {
    requireStreamParameters('SqueezeProStream.constructor#0', 'SqueezeProStream', parameters);
    const {
      bollingerBandPeriod,
      bollingerStandardDeviations,
      keltnerChannelPeriod,
      wideKeltnerChannelMultiplier,
      normalKeltnerChannelMultiplier,
      narrowKeltnerChannelMultiplier,
    } = parameters;
    this.wideKeltnerChannelMultiplier = wideKeltnerChannelMultiplier;
    this.normalKeltnerChannelMultiplier = normalKeltnerChannelMultiplier;
    this.narrowKeltnerChannelMultiplier = narrowKeltnerChannelMultiplier;

    this.core = new SqueezeCore({
      bollingerBandPeriod,
      bollingerStandardDeviations,
      keltnerChannelPeriod,
    });
  }
  private inside(
    o: {
      upperBollingerBand: number;
      lowerBollingerBand: number;
      keltnerChannelMiddle: number;
      keltnerChannelRange: number;
    },
    mult: number,
  ): number {
    return o.lowerBollingerBand > o.keltnerChannelMiddle - mult * o.keltnerChannelRange &&
      o.upperBollingerBand < o.keltnerChannelMiddle + mult * o.keltnerChannelRange
      ? 1
      : 0;
  }
  next(bar: BarInput): SqueezeProPoint | null {
    const o = this.core.update(bar);
    if (o === null) {
      this.value = null;
      return null;
    }
    this.value = {
      lowCompression: this.inside(o, this.wideKeltnerChannelMultiplier),
      normalCompression: this.inside(o, this.normalKeltnerChannelMultiplier),
      highCompression: this.inside(o, this.narrowKeltnerChannelMultiplier),
      momentum: o.momentum,
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('squeezePro', {
      wideKeltnerChannelMultiplier: this.wideKeltnerChannelMultiplier,
      normalKeltnerChannelMultiplier: this.normalKeltnerChannelMultiplier,
      narrowKeltnerChannelMultiplier: this.narrowKeltnerChannelMultiplier,
      core: this.core.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SqueezeProStream {
    const state = readSnapshot(snapshot, 'squeezePro');
    const x = new SqueezeProStream({
      bollingerBandPeriod: 1,
      bollingerStandardDeviations: 1,
      keltnerChannelPeriod: 1,
      wideKeltnerChannelMultiplier: state.number('wideKeltnerChannelMultiplier'),
      normalKeltnerChannelMultiplier: state.number('normalKeltnerChannelMultiplier'),
      narrowKeltnerChannelMultiplier: state.number('narrowKeltnerChannelMultiplier'),
    });
    x.core = SqueezeCore.fromJSON(state.child('core'));
    x.value = state.cached<SqueezeProPoint>('value');
    return x;
  }
}

/**
 * The three multipliers must WIDEN monotonically, or the levels stop meaning what they are named.
 *
 * Positivity was checked and ordering was not, so `wide: 1, narrow: 2` was accepted and inverted the
 * whole indicator: `lowCompression` (the loosest squeeze) would be computed from the TIGHTEST
 * channel. The canonical warmup shipped exactly that inversion, which is how a defaults table can
 * teach a configuration the implementation never intended.
 *
 * Returns nothing — it exists for the throw.
 */
interface OrderedMultipliers {
  wideKeltnerChannelMultiplier: number;
  normalKeltnerChannelMultiplier: number;
  narrowKeltnerChannelMultiplier: number;
}

/**
 * The three Keltner multipliers, each validated as a NUMBER before their ORDERING is judged.
 *
 * RV10 — order of validation is part of the contract. This checked `wide > normal > narrow` first
 * and left positivity to three separate `requirePositive` calls spread in after it, so
 * `wideKeltnerChannelMultiplier: NaN` reported `input.out_of_range` with the message "must satisfy
 * wideKeltnerChannelMultiplier > normalKeltnerChannelMultiplier > …". `NaN > 1.5` is false, so a
 * TYPE failure was reported as a RELATION failure, and the caller was told to reorder three numbers
 * when one of them was not a number. `Infinity` happened to read correctly only because
 * `Infinity > 1.5` is true and it fell through to the finiteness check — the taxonomy was right by
 * luck on one input class and wrong on the other.
 *
 * Ordering is a relation between three already-valid numbers, so it cannot be judged until they are
 * known to be numbers. Validating and returning them here also removes the duplicate
 * `requirePositive` calls at the call site, where the object-literal evaluation order was the only
 * thing sequencing the two checks.
 */
function requireOrderedMultipliers(p: SqueezeProParameters): OrderedMultipliers {
  const wide = requirePositive(
    p.wideKeltnerChannelMultiplier ?? 2.0,
    'squeezePro',
    'wideKeltnerChannelMultiplier',
  );
  const normal = requirePositive(
    p.normalKeltnerChannelMultiplier ?? 1.5,
    'squeezePro',
    'normalKeltnerChannelMultiplier',
  );
  const narrow = requirePositive(
    p.narrowKeltnerChannelMultiplier ?? 1.0,
    'squeezePro',
    'narrowKeltnerChannelMultiplier',
  );
  if (!(wide > normal && normal > narrow)) {
    throw new InputError(
      'squeezePro: the Keltner multipliers must satisfy ' +
        'wideKeltnerChannelMultiplier > normalKeltnerChannelMultiplier > ' +
        `narrowKeltnerChannelMultiplier; got wideKeltnerChannelMultiplier=${wide}, ` +
        `normalKeltnerChannelMultiplier=${normal}, narrowKeltnerChannelMultiplier=${narrow}.` +
        '\n  e.g. squeezePro(bars, { wideKeltnerChannelMultiplier: 2, ' +
        'normalKeltnerChannelMultiplier: 1.5, narrowKeltnerChannelMultiplier: 1 })',
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'squeezePro',
          wideKeltnerChannelMultiplier: wide,
          normalKeltnerChannelMultiplier: normal,
          narrowKeltnerChannelMultiplier: narrow,
        },
      },
    );
  }
  return {
    wideKeltnerChannelMultiplier: wide,
    normalKeltnerChannelMultiplier: normal,
    narrowKeltnerChannelMultiplier: narrow,
  };
}

export const squeezePro = makeIndicator<SqueezeProParameters, BarInput, SqueezeProPoint>(
  (p) =>
    new SqueezeProStream({
      bollingerBandPeriod: requirePeriod(
        p.bollingerBandPeriod ?? 20,
        'squeezePro',
        'bollingerBandPeriod',
      ),
      bollingerStandardDeviations: requirePositive(
        p.bollingerStandardDeviations ?? 2,
        'squeezePro',
        'bollingerStandardDeviations',
      ),
      keltnerChannelPeriod: requirePeriod(
        p.keltnerChannelPeriod ?? 20,
        'squeezePro',
        'keltnerChannelPeriod',
      ),
      ...requireOrderedMultipliers(p),
    }),
  SqueezeProStream.fromJSON,
  () => ({ lowCompression: NaN, normalCompression: NaN, highCompression: NaN, momentum: NaN }),
);

// ───────────────────────── projection oscillator (Widner) ─────────────────────────

export interface ProjectionPoint {
  po: number;
  upper: number;
  lower: number;
}

class ProjectionOscillatorStream implements IndicatorStream<BarInput, ProjectionPoint> {
  private lin: LinregStream;
  private highs: number[] = [];
  private lows: number[] = [];
  value: ProjectionPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'ProjectionOscillatorStream');
    this.lin = new LinregStream(period);
  }
  next(bar: BarInput): ProjectionPoint | null {
    const lr = this.lin.next(bar.close);
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.highs.length > this.period) {
      this.highs.shift();
      this.lows.shift();
    }
    if (lr === null || this.highs.length < this.period) {
      this.value = null;
      return null;
    }
    const slope = lr.slope;
    const n = this.period;
    let pu = -Infinity;
    let pl = Infinity;
    for (let i = 0; i < n; i++) {
      // i bars ago, projected forward to now along the regression slope
      const hi = this.highs[n - 1 - i]! + slope * i;
      const lo = this.lows[n - 1 - i]! + slope * i;
      if (hi > pu) pu = hi;
      if (lo < pl) pl = lo;
    }
    const po = pu === pl ? 50 : (100 * (bar.close - pl)) / (pu - pl);
    this.value = { po, upper: pu, lower: pl };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('projectionOscillator', {
      period: this.period,
      lin: this.lin.toJSON(),
      highs: [...this.highs],
      lows: [...this.lows],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ProjectionOscillatorStream {
    const state = readSnapshot(snapshot, 'projectionOscillator');
    const x = new ProjectionOscillatorStream(state.lookback('period'));
    x.lin = LinregStream.fromJSON(state.child('lin'));
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<ProjectionPoint>('value');
    return x;
  }
}

export const projectionOscillator = makeIndicator<{ period?: number }, BarInput, ProjectionPoint>(
  (p) => new ProjectionOscillatorStream(requirePeriod(p.period ?? 14, 'projectionOscillator')),
  ProjectionOscillatorStream.fromJSON,
  () => ({ po: NaN, upper: NaN, lower: NaN }),
);

// ───────────────────────── TD Sequential (DeMark core) ─────────────────────────

export interface TdSequentialParameters {
  /** Comparison lookback for the setup (DeMark uses 4). */
  lookback?: number;
}
export interface TdSequentialPoint {
  /** Active setup count, 1–9 (0 if none). */
  setup: number;
  /** Active countdown count, 1–13 (0 if none). */
  countdown: number;
  /** +1 sell side (price strength), −1 buy side (price weakness), 0 none. */
  direction: number;
}

/**
 * Core TD Sequential: the price-flip setup (1–9) and a basic countdown (1–13). This implements the
 * essential setup/countdown signal, not the full DeMark ruleset (no perfection / cancellation /
 * deferral qualifiers).
 */
class TdSequentialStream implements IndicatorStream<BarInput, TdSequentialPoint> {
  private closes: number[] = []; // last lookback+1 closes
  private bars: BarInput[] = []; // last 3 bars (for low[2]/high[2])
  private buySetup = 0;
  private sellSetup = 0;
  private armed = 0; // +1 sell countdown, −1 buy countdown, 0 none
  private countdown = 0;
  value: TdSequentialPoint | null = null;
  constructor(private readonly lookback: number) {
    requirePeriod(lookback, 'TdSequentialStream', 'lookback', 1, 'bars');
  }
  next(bar: BarInput): TdSequentialPoint | null {
    this.closes.push(bar.close);
    if (this.closes.length > this.lookback + 1) this.closes.shift();
    this.bars.push(bar);
    if (this.bars.length > 3) this.bars.shift();
    if (this.closes.length < this.lookback + 1) {
      this.value = null;
      return null;
    }
    const refClose = this.closes[0]!; // `lookback` bars ago
    let setup = 0;
    let direction = 0;
    if (bar.close < refClose) {
      const was = this.buySetup;
      this.buySetup = Math.min(this.buySetup + 1, 9);
      this.sellSetup = 0;
      if (was === 8 && this.buySetup === 9) {
        this.armed = -1;
        this.countdown = 0;
      }
      setup = this.buySetup;
      direction = -1;
    } else if (bar.close > refClose) {
      const was = this.sellSetup;
      this.sellSetup = Math.min(this.sellSetup + 1, 9);
      this.buySetup = 0;
      if (was === 8 && this.sellSetup === 9) {
        this.armed = 1;
        this.countdown = 0;
      }
      setup = this.sellSetup;
      direction = 1;
    } else {
      this.buySetup = 0;
      this.sellSetup = 0;
    }
    if (this.armed !== 0 && this.bars.length === 3) {
      const ago2 = this.bars[0]!; // 2 bars ago
      if (this.armed === -1 && bar.close <= ago2.low && this.countdown < 13) this.countdown++;
      else if (this.armed === 1 && bar.close >= ago2.high && this.countdown < 13) this.countdown++;
      if (this.countdown >= 13) this.armed = 0; // countdown complete
    }
    this.value = { setup, countdown: this.countdown, direction };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('tdSequential', {
      lookback: this.lookback,
      closes: [...this.closes],
      bars: this.bars.map((x) => ({ ...x })),
      buySetup: this.buySetup,
      sellSetup: this.sellSetup,
      armed: this.armed,
      countdown: this.countdown,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TdSequentialStream {
    const state = readSnapshot(snapshot, 'tdSequential');
    const x = new TdSequentialStream(state.lookback('lookback'));
    Object.assign(x, {
      buySetup: state.number('buySetup'),
      sellSetup: state.number('sellSetup'),
      armed: state.number('armed'),
      countdown: state.number('countdown'),
    });
    x.closes = state.numbers('closes');
    x.bars = state.records<BarInput>('bars').map((y) => ({ ...y }));
    x.value = state.cached<TdSequentialPoint>('value');
    return x;
  }
}

export const tdSequential = makeIndicator<TdSequentialParameters, BarInput, TdSequentialPoint>(
  (p) => new TdSequentialStream(requirePeriod(p.lookback ?? 4, 'tdSequential', 'lookback')),
  TdSequentialStream.fromJSON,
  () => ({ setup: NaN, countdown: NaN, direction: NaN }),
);

export {
  BiasStream,
  LinregOscStream,
  CoppockStream,
  CtiStream,
  EfficiencyRatioStream,
  CenterOfGravityStream,
  PsychologicalLineStream,
  SlopeStream,
  PvoStream,
  ElderRayStream,
  BrarStream,
  KdjStream,
  RvgiStream,
  PgoStream,
  TrixHistogramStream,
  SmiErgodicStream,
  VolumeWeightedMacdStream,
  InertiaStream,
  LaguerreRsiStream,
  QqeStream,
  RsxStream,
  SchaffTrendCycleStream,
  SqueezeCore,
  SqueezeStream,
  SqueezeProStream,
  ProjectionOscillatorStream,
  TdSequentialStream,
};
