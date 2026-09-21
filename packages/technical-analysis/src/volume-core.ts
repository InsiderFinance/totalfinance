/**
 * Volume & order-flow indicators (spec §13.3).
 *
 * Accumulation/Distribution line, Chaikin Oscillator & Money Flow, Money Flow Index, Price-Volume
 * Trend, Ease of Movement, Force Index, Negative & Positive Volume Index, Klinger Volume Oscillator,
 * Volume Flow Indicator, relative volume, a simple bar-based Cumulative Volume Delta, plus the
 * volume-profile and order-book-imbalance utilities. OBV and cumulative VWAP live in `./bars`.
 *
 * Bars without a `volume` field are treated as zero-volume. CVD here is a bar-based proxy (it signs
 * volume by close-to-close direction); trade-level aggressor CVD lives in `@totalfinance/structure`.
 */

import {
  ensureFiniteWhenPresent,
  CONVENTIONS_VERSION,
  WarningCode,
  ensureKnownKeys,
  facade,
  requireArgumentArray,
  requireArgumentObject,
  warning,
} from '@totalfinance/core';
import type { QuantWarning } from '@totalfinance/core';
import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { EmaStream, SmaStream } from './moving-averages.js';
import { dirtyRows, dirtySamples, isDirtySample } from './nan-policy.js';
import { requireInRange, requireNonNegative, requirePeriod, requirePositive } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

const nanNum = (): number => NaN;

export interface PeriodParameters {
  period: number;
}

function volumeOf(bar: BarInput): number {
  return bar.volume ?? 0;
}
/** Money-flow multiplier: where the close sits within the bar's range, in [−1, 1]. */
function moneyFlowMultiplier(bar: BarInput): number {
  const range = bar.high - bar.low;
  return range === 0 ? 0 : (bar.close - bar.low - (bar.high - bar.close)) / range;
}

// ───────────────────────── Accumulation / Distribution line ─────────────────────────

class AdLineStream implements IndicatorStream<BarInput, number> {
  private ad = 0;
  value: number | null = null;
  next(bar: BarInput): number | null {
    this.ad += moneyFlowMultiplier(bar) * volumeOf(bar);
    this.value = this.ad;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('adLine', { ad: this.ad, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AdLineStream {
    const state = readSnapshot(snapshot, 'adLine');
    const x = new AdLineStream();
    x.ad = state.number('ad');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const adLine = makeIndicator<Record<never, never>, BarInput, number>(
  () => new AdLineStream(),
  AdLineStream.fromJSON,
  nanNum,
);

// ───────────────────────── Chaikin Oscillator ─────────────────────────

export interface ChaikinOscParameters {
  fast?: number;
  slow?: number;
}

class ChaikinOscStream implements IndicatorStream<BarInput, number> {
  private adInner: AdLineStream;
  private fast: EmaStream;
  private slow: EmaStream;
  value: number | null = null;
  constructor(parameters: { fast: number; slow: number }) {
    requireStreamParameters('ChaikinOscStream.constructor#0', 'ChaikinOscStream', parameters);
    const { fast, slow } = parameters;
    this.adInner = new AdLineStream();
    this.fast = new EmaStream(fast);
    this.slow = new EmaStream(slow);
  }
  next(bar: BarInput): number | null {
    const ad = this.adInner.next(bar)!;
    const f = this.fast.next(ad);
    const s = this.slow.next(ad);
    if (f === null || s === null) {
      this.value = null;
      return null;
    }
    this.value = f - s;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('chaikinOsc', {
      ad: this.adInner.toJSON(),
      fast: this.fast.toJSON(),
      slow: this.slow.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ChaikinOscStream {
    const state = readSnapshot(snapshot, 'chaikinOsc');
    const x = new ChaikinOscStream({ fast: 1, slow: 1 });
    x.adInner = AdLineStream.fromJSON(state.child('ad'));
    x.fast = EmaStream.fromJSON(state.child('fast'));
    x.slow = EmaStream.fromJSON(state.child('slow'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const chaikinOscillator = makeIndicator<ChaikinOscParameters, BarInput, number>(
  (p) =>
    new ChaikinOscStream({
      fast: requirePeriod(p.fast ?? 3, 'chaikinOscillator', 'fast'),
      slow: requirePeriod(p.slow ?? 10, 'chaikinOscillator', 'slow'),
    }),
  ChaikinOscStream.fromJSON,
  nanNum,
);

// ───────────────────────── Chaikin Money Flow ─────────────────────────

class CmfStream implements IndicatorStream<BarInput, number> {
  private mfv: number[] = [];
  private volumes: number[] = [];
  private sumMfv = 0;
  private sumVolume = 0;
  /** Non-finite rows inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'CmfStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): number | null {
    const v = volumeOf(bar);
    const mfv = moneyFlowMultiplier(bar) * v;
    this.mfv.push(mfv);
    this.volumes.push(v);
    // Interior-NaN policy: only finite rows enter the running sums.
    if (isDirtySample(mfv) || isDirtySample(v)) this.nanCount++;
    else {
      this.sumMfv += mfv;
      this.sumVolume += v;
    }
    if (this.mfv.length > this.period) {
      const goneMfv = this.mfv.shift()!;
      const goneVolume = this.volumes.shift()!;
      if (isDirtySample(goneMfv) || isDirtySample(goneVolume)) this.nanCount--;
      else {
        this.sumMfv -= goneMfv;
        this.sumVolume -= goneVolume;
      }
    }
    if (this.mfv.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      this.value = NaN;
      return this.value;
    }
    this.value = this.sumVolume === 0 ? 0 : this.sumMfv / this.sumVolume;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('cmf', {
      period: this.period,
      mfv: [...this.mfv],
      volumes: [...this.volumes],
      sumMfv: this.sumMfv,
      sumVolume: this.sumVolume,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CmfStream {
    const state = readSnapshot(snapshot, 'cmf');
    const x = new CmfStream(state.lookback('period'));
    Object.assign(x, { sumMfv: state.number('sumMfv'), sumVolume: state.number('sumVolume') });
    x.mfv = state.numbers('mfv');
    x.volumes = state.numbers('volumes');
    x.nanCount = dirtyRows(x.mfv, x.volumes);
    x.value = state.cached<number>('value');
    return x;
  }
}

export const chaikinMoneyFlow = makeIndicator<{ period?: number }, BarInput, number>(
  (p) => new CmfStream(requirePeriod(p.period ?? 20, 'chaikinMoneyFlow')),
  CmfStream.fromJSON,
  nanNum,
  { period: 20 },
);

// ───────────────────────── Money Flow Index ─────────────────────────

class MfiStream implements IndicatorStream<BarInput, number> {
  private prevTp: number | null = null;
  private pos: number[] = [];
  private neg: number[] = [];
  private sumPos = 0;
  private sumNeg = 0;
  /** Non-finite rows inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'MfiStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): number | null {
    const tp = (bar.high + bar.low + bar.close) / 3;
    const rawMF = tp * volumeOf(bar);
    if (this.prevTp === null) {
      this.prevTp = tp;
      this.value = null;
      return null;
    }
    // A non-finite typical price or money flow is neither up nor down under `>`/`<`, so it would
    // enter the window as a silent 0/0; carry it through as NaN so the gate can see it.
    const bad = isDirtySample(tp) || isDirtySample(this.prevTp) || isDirtySample(rawMF);
    const p = bad ? NaN : tp > this.prevTp ? rawMF : 0;
    const n = bad ? NaN : tp < this.prevTp ? rawMF : 0;
    this.prevTp = tp;
    this.pos.push(p);
    this.neg.push(n);
    // Interior-NaN policy: only finite rows enter the running sums.
    if (bad) this.nanCount++;
    else {
      this.sumPos += p;
      this.sumNeg += n;
    }
    if (this.pos.length > this.period) {
      const gonePos = this.pos.shift()!;
      const goneNeg = this.neg.shift()!;
      if (isDirtySample(gonePos) || isDirtySample(goneNeg)) this.nanCount--;
      else {
        this.sumPos -= gonePos;
        this.sumNeg -= goneNeg;
      }
    }
    if (this.pos.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      this.value = NaN;
      return this.value;
    }
    // Clamp away rolling-sum float drift (a window of zero down-flows can leave sumNeg ≈ −1e-13,
    // which would otherwise push the money ratio negative and MFI above 100).
    const pos = Math.max(0, this.sumPos);
    const neg = Math.max(0, this.sumNeg);
    this.value = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('mfi', {
      period: this.period,
      prevTp: this.prevTp,
      pos: [...this.pos],
      neg: [...this.neg],
      sumPos: this.sumPos,
      sumNeg: this.sumNeg,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MfiStream {
    const state = readSnapshot(snapshot, 'mfi');
    const x = new MfiStream(state.lookback('period'));
    Object.assign(x, {
      prevTp: state.numberOrNull('prevTp'),
      sumPos: state.number('sumPos'),
      sumNeg: state.number('sumNeg'),
    });
    x.pos = state.numbers('pos');
    x.neg = state.numbers('neg');
    x.nanCount = dirtyRows(x.pos, x.neg);
    x.value = state.cached<number>('value');
    return x;
  }
}

export const mfi = makeIndicator<{ period?: number }, BarInput, number>(
  // Money-Flow Index lookback defaults to 14 (universal); echoed via `.explain()`.
  (p) => new MfiStream(requirePeriod(p.period ?? 14, 'mfi')),
  MfiStream.fromJSON,
  nanNum,
);

// ───────────────────────── Price-Volume Trend ─────────────────────────

class PvtStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private pvt = 0;
  value: number | null = null;
  next(bar: BarInput): number | null {
    if (this.previousClose !== null && this.previousClose !== 0) {
      this.pvt += ((bar.close - this.previousClose) / this.previousClose) * volumeOf(bar);
    }
    this.previousClose = bar.close;
    this.value = this.pvt;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('pvt', {
      previousClose: this.previousClose,
      pvt: this.pvt,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PvtStream {
    const state = readSnapshot(snapshot, 'pvt');
    const x = new PvtStream();
    x.previousClose = state.numberOrNull('previousClose');
    x.pvt = state.number('pvt');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const pvt = makeIndicator<Record<never, never>, BarInput, number>(
  () => new PvtStream(),
  PvtStream.fromJSON,
  nanNum,
);

// ───────────────────────── Ease of Movement ─────────────────────────

export interface EomParameters {
  period: number;
  /** Volume scale to keep the box ratio in a sane range. Default 1e8. */
  scale?: number;
}

class EomStream implements IndicatorStream<BarInput, number> {
  private prevMid: number | null = null;
  private sma: SmaStream;
  value: number | null = null;
  private readonly scale: number;
  constructor(parameters: { period: number; scale: number }) {
    requireStreamParameters('EomStream.constructor#0', 'EomStream', parameters);
    const { period, scale } = parameters;
    this.scale = scale;

    this.sma = new SmaStream(period);
  }
  next(bar: BarInput): number | null {
    const mid = (bar.high + bar.low) / 2;
    if (this.prevMid === null) {
      this.prevMid = mid;
      this.value = null;
      return null;
    }
    const distance = mid - this.prevMid;
    this.prevMid = mid;
    const range = bar.high - bar.low;
    const boxRatio = range === 0 ? 0 : volumeOf(bar) / this.scale / range;
    const emv = boxRatio === 0 ? 0 : distance / boxRatio;
    this.value = this.sma.next(emv);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('eom', {
      scale: this.scale,
      prevMid: this.prevMid,
      sma: this.sma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): EomStream {
    const state = readSnapshot(snapshot, 'eom');
    const x = new EomStream({ period: 1, scale: state.number('scale') });
    Object.assign(x, { prevMid: state.numberOrNull('prevMid') });
    x.sma = SmaStream.fromJSON(state.child('sma'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const easeOfMovement = makeIndicator<EomParameters, BarInput, number>(
  (p) =>
    new EomStream({
      period: requirePeriod(p.period, 'easeOfMovement', 'period', 1, 'bars'),
      scale: requirePositive(p.scale ?? 1e8, 'easeOfMovement', 'scale'),
    }),
  EomStream.fromJSON,
  nanNum,
);

// ───────────────────────── Force Index ─────────────────────────

class ForceIndexStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private ema: EmaStream;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'ForceIndexStream', 'period', 1, 'bars');
    this.ema = new EmaStream(period);
  }
  next(bar: BarInput): number | null {
    if (this.previousClose === null) {
      this.previousClose = bar.close;
      this.value = null;
      return null;
    }
    const fi1 = (bar.close - this.previousClose) * volumeOf(bar);
    this.previousClose = bar.close;
    this.value = this.ema.next(fi1);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('forceIndex', {
      previousClose: this.previousClose,
      ema: this.ema.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ForceIndexStream {
    const state = readSnapshot(snapshot, 'forceIndex');
    const x = new ForceIndexStream(1);
    Object.assign(x, { previousClose: state.numberOrNull('previousClose') });
    x.ema = EmaStream.fromJSON(state.child('ema'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const forceIndex = makeIndicator<{ period?: number }, BarInput, number>(
  (p) => new ForceIndexStream(requirePeriod(p.period ?? 13, 'forceIndex')),
  ForceIndexStream.fromJSON,
  nanNum,
  { period: 13 },
);

// ───────────────────────── Negative / Positive Volume Index ─────────────────────────

class VolumeIndexStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private previousVolume = 0;
  private idx = 1000;
  value: number | null = null;
  private readonly positive: boolean;
  private readonly kind: string;
  constructor(parameters: { positive: boolean; kind: string }) {
    requireStreamParameters('VolumeIndexStream.constructor#0', 'VolumeIndexStream', parameters);
    const { positive, kind } = parameters;
    this.positive = positive;
    this.kind = kind;
  }
  next(bar: BarInput): number | null {
    const v = volumeOf(bar);
    if (this.previousClose !== null) {
      const trigger = this.positive ? v > this.previousVolume : v < this.previousVolume;
      if (trigger && this.previousClose !== 0) {
        this.idx = this.idx * (1 + (bar.close - this.previousClose) / this.previousClose);
      }
    }
    this.previousClose = bar.close;
    this.previousVolume = v;
    this.value = this.idx;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    // `positive` is NOT serialized: it is implied by the kind (`pvi` / `nvi`) and bound into
    // `VolumeIndexStream.restore(positive, kind)`.
    return snapshotOf(this.kind, {
      previousClose: this.previousClose,
      previousVolume: this.previousVolume,
      idx: this.idx,
      value: this.value,
    });
  }
  static restore(positive: boolean, kind: string) {
    return (s: TechnicalAnalysisSnapshot): VolumeIndexStream => {
      const state = readSnapshot(s, kind);
      const x = new VolumeIndexStream({ positive, kind });
      Object.assign(x, {
        previousClose: state.numberOrNull('previousClose'),
        previousVolume: state.number('previousVolume'),
        idx: state.number('idx'),
      });
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

export const nvi = makeIndicator<Record<never, never>, BarInput, number>(
  () => new VolumeIndexStream({ positive: false, kind: 'nvi' }),
  VolumeIndexStream.restore(false, 'nvi'),
  nanNum,
);
export const pvi = makeIndicator<Record<never, never>, BarInput, number>(
  () => new VolumeIndexStream({ positive: true, kind: 'pvi' }),
  VolumeIndexStream.restore(true, 'pvi'),
  nanNum,
);

// ───────────────────────── Klinger Volume Oscillator ─────────────────────────

export interface KlingerParameters {
  fast?: number;
  slow?: number;
  signal?: number;
}
export interface KlingerPoint {
  klinger: number;
  signal: number;
}

class KlingerStream implements IndicatorStream<BarInput, KlingerPoint> {
  private prevHlc: number | null = null;
  private prevTrend = 1;
  private prevDm = 0;
  private prevCm = 0;
  private fast: EmaStream;
  private slow: EmaStream;
  private signalEma: EmaStream;
  value: KlingerPoint | null = null;
  constructor(parameters: { fast: number; slow: number; signal: number }) {
    requireStreamParameters('KlingerStream.constructor#0', 'KlingerStream', parameters);
    const { fast, slow, signal } = parameters;
    this.fast = new EmaStream(fast);
    this.slow = new EmaStream(slow);
    this.signalEma = new EmaStream(signal);
  }
  next(bar: BarInput): KlingerPoint | null {
    const hlc = bar.high + bar.low + bar.close;
    const dm = bar.high - bar.low;
    if (this.prevHlc === null) {
      this.prevHlc = hlc;
      this.prevDm = dm;
      this.prevCm = dm;
      this.value = null;
      return null;
    }
    const trend = hlc >= this.prevHlc ? 1 : -1;
    const cm = trend === this.prevTrend ? this.prevCm + dm : this.prevDm + dm;
    const vf = cm === 0 ? 0 : volumeOf(bar) * Math.abs(2 * (dm / cm) - 1) * trend * 100;
    this.prevHlc = hlc;
    this.prevTrend = trend;
    this.prevDm = dm;
    this.prevCm = cm;
    const f = this.fast.next(vf);
    const s = this.slow.next(vf);
    if (f === null || s === null) {
      this.value = null;
      return null;
    }
    const kvo = f - s;
    const sig = this.signalEma.next(kvo);
    if (sig === null) {
      this.value = null;
      return null;
    }
    this.value = { klinger: kvo, signal: sig };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('klinger', {
      prevHlc: this.prevHlc,
      prevTrend: this.prevTrend,
      prevDm: this.prevDm,
      prevCm: this.prevCm,
      fast: this.fast.toJSON(),
      slow: this.slow.toJSON(),
      signal: this.signalEma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): KlingerStream {
    const state = readSnapshot(snapshot, 'klinger');
    const x = new KlingerStream({ fast: 1, slow: 1, signal: 1 });
    Object.assign(x, {
      prevHlc: state.numberOrNull('prevHlc'),
      prevTrend: state.number('prevTrend'),
      prevDm: state.number('prevDm'),
      prevCm: state.number('prevCm'),
    });
    x.fast = EmaStream.fromJSON(state.child('fast'));
    x.slow = EmaStream.fromJSON(state.child('slow'));
    x.signalEma = EmaStream.fromJSON(state.child('signal'));
    x.value = state.cached<KlingerPoint>('value');
    return x;
  }
}

export const klinger = makeIndicator<KlingerParameters, BarInput, KlingerPoint>(
  (p) =>
    new KlingerStream({
      fast: requirePeriod(p.fast ?? 34, 'klinger', 'fast'),
      slow: requirePeriod(p.slow ?? 55, 'klinger', 'slow'),
      signal: requirePeriod(p.signal ?? 13, 'klinger', 'signal'),
    }),
  KlingerStream.fromJSON,
  () => ({ klinger: NaN, signal: NaN }),
);

// ───────────────────────── Volume Flow Indicator (Katsanos) ─────────────────────────

export interface VfiParameters {
  period?: number;
  coefficient?: number;
  volumeCutoff?: number;
  smooth?: number;
}

class VfiStream implements IndicatorStream<BarInput, number> {
  private prevTp: number | null = null;
  private inter: number[] = []; // log typical-price changes for the 30-bar standardDeviation
  private vcp: number[] = []; // capped, signed volume contributions
  private volumeBuffer: number[] = [];
  private volumeSum = 0;
  /** Non-finite samples inside the volume window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  private smoothEma: EmaStream;
  value: number | null = null;
  private readonly period: number;
  private readonly coefficient: number;
  private readonly volumeCutoff: number;
  constructor(parameters: {
    period: number;
    coefficient: number;
    volumeCutoff: number;
    smooth: number;
  }) {
    requireStreamParameters('VfiStream.constructor#0', 'VfiStream', parameters);
    const { period, coefficient, volumeCutoff, smooth } = parameters;
    this.period = period;
    this.coefficient = coefficient;
    this.volumeCutoff = volumeCutoff;

    this.smoothEma = new EmaStream(smooth);
  }
  next(bar: BarInput): number | null {
    const tp = (bar.high + bar.low + bar.close) / 3;
    const v = volumeOf(bar);
    this.volumeBuffer.push(v);
    // Interior-NaN policy: only finite volumes enter the running sum.
    if (isDirtySample(v)) this.nanCount++;
    else this.volumeSum += v;
    if (this.volumeBuffer.length > this.period) {
      const gone = this.volumeBuffer.shift()!;
      if (isDirtySample(gone)) this.nanCount--;
      else this.volumeSum -= gone;
    }

    // While the window (or this bar) is dirty, HOLD every piece of state — the log-return history,
    // the signed-volume window, the previous typical price and the smoothing EMA. Feeding any of
    // them a NaN would latch VFI permanently; holding makes the gap a run of NaN the indicator
    // recovers from. (`NaN <= 0` is false, so the guard below cannot catch a non-finite price.)
    if (this.nanCount > 0 || isDirtySample(tp)) {
      // Still warmup ⇒ still `null`: a gap must never be mistaken for the first real value (that
      // would move `diagnostics.warmup` earlier than the indicator can actually compute).
      this.value = this.vcp.length >= this.period ? NaN : null;
      return this.value;
    }
    if (this.prevTp === null || this.prevTp <= 0 || tp <= 0) {
      this.prevTp = tp;
      this.value = null;
      return null;
    }
    const interVal = Math.log(tp) - Math.log(this.prevTp);
    this.inter.push(interVal);
    if (this.inter.length > 30) this.inter.shift();

    const vave = this.volumeBuffer.length > 0 ? this.volumeSum / this.volumeBuffer.length : 0;
    const vmax = vave * this.volumeCutoff;
    const vc = Math.min(v, vmax);

    // rolling stddev of `inter` over (up to) 30 bars
    let cutoff = 0;
    if (this.inter.length >= 2) {
      let sum = 0;
      for (const x of this.inter) sum += x;
      const mean = sum / this.inter.length;
      let acc = 0;
      for (const x of this.inter) {
        const d = x - mean;
        acc += d * d;
      }
      const sd = Math.sqrt(acc / (this.inter.length - 1));
      cutoff = this.coefficient * sd * bar.close;
    }
    const mf = tp - this.prevTp;
    const signedVc = mf > cutoff ? vc : mf < -cutoff ? -vc : 0;
    this.prevTp = tp;

    this.vcp.push(signedVc);
    if (this.vcp.length > this.period) this.vcp.shift();
    if (this.vcp.length < this.period || vave === 0) {
      this.value = null;
      return null;
    }
    let vcpSum = 0;
    for (const x of this.vcp) vcpSum += x;
    const raw = vcpSum / vave;
    this.value = this.smoothEma.next(raw);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('vfi', {
      period: this.period,
      coefficient: this.coefficient,
      volumeCutoff: this.volumeCutoff,
      prevTp: this.prevTp,
      inter: [...this.inter],
      vcp: [...this.vcp],
      volumeBuffer: [...this.volumeBuffer],
      volumeSum: this.volumeSum,
      smooth: this.smoothEma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VfiStream {
    const state = readSnapshot(snapshot, 'vfi');
    const x = new VfiStream({
      period: state.lookback('period'),
      coefficient: state.number('coefficient'),
      volumeCutoff: state.number('volumeCutoff'),
      smooth: 1,
    });
    Object.assign(x, {
      prevTp: state.numberOrNull('prevTp'),
      volumeSum: state.number('volumeSum'),
    });
    x.inter = state.numbers('inter');
    x.vcp = state.numbers('vcp');
    x.volumeBuffer = state.numbers('volumeBuffer');
    x.nanCount = dirtySamples(x.volumeBuffer);
    x.smoothEma = EmaStream.fromJSON(state.child('smooth'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const vfi = makeIndicator<VfiParameters, BarInput, number>(
  (p) =>
    new VfiStream({
      period: requirePeriod(p.period ?? 130, 'vfi'),
      coefficient: requirePositive(p.coefficient ?? 0.2, 'vfi', 'coefficient'),
      volumeCutoff: requirePositive(p.volumeCutoff ?? 2.5, 'vfi', 'volumeCutoff'),
      smooth: requirePeriod(p.smooth ?? 3, 'vfi', 'smooth'),
    }),
  VfiStream.fromJSON,
  nanNum,
);

// ───────────────────────── relative volume ─────────────────────────

class RelativeVolumeStream implements IndicatorStream<BarInput, number> {
  private sma: SmaStream;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'RelativeVolumeStream', 'period', 1, 'bars');
    this.sma = new SmaStream(period);
  }
  next(bar: BarInput): number | null {
    const v = volumeOf(bar);
    const avg = this.sma.next(v);
    this.value = avg === null ? null : avg === 0 ? NaN : v / avg;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('relativeVolume', { sma: this.sma.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RelativeVolumeStream {
    const state = readSnapshot(snapshot, 'relativeVolume');
    const x = new RelativeVolumeStream(1);
    x.sma = SmaStream.fromJSON(state.child('sma'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const relativeVolume = makeIndicator<PeriodParameters, BarInput, number>(
  (p) => new RelativeVolumeStream(requirePeriod(p.period, 'relativeVolume', 'period', 1, 'bars')),
  RelativeVolumeStream.fromJSON,
  nanNum,
);

// ───────────────────────── Cumulative Volume Delta (bar proxy) ─────────────────────────

class CvdStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private cvd = 0;
  value: number | null = null;
  next(bar: BarInput): number | null {
    if (this.previousClose !== null) {
      const dir = bar.close > this.previousClose ? 1 : bar.close < this.previousClose ? -1 : 0;
      this.cvd += dir * volumeOf(bar);
    }
    this.previousClose = bar.close;
    this.value = this.cvd;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('cvd', {
      previousClose: this.previousClose,
      cvd: this.cvd,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CvdStream {
    const state = readSnapshot(snapshot, 'cvd');
    const x = new CvdStream();
    x.previousClose = state.numberOrNull('previousClose');
    x.cvd = state.number('cvd');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const cvd = makeIndicator<Record<never, never>, BarInput, number>(
  () => new CvdStream(),
  CvdStream.fromJSON,
  nanNum,
);

// ───────────────────────── volume profile (batch utility) ─────────────────────────

export interface VolumeProfileParameters {
  /** Number of price buckets. Default 24. */
  bins?: number;
  /** Fraction of total volume that defines the value area. Default 0.7. */
  valueAreaFraction?: number;
}
const VOLUME_PROFILE_PARAMS_KEYS = ['bins', 'valueAreaFraction'] as const;
export interface VolumeBin {
  low: number;
  high: number;
  volume: number;
}
/** Volume-profile report (Law 2): the bins and levels plus conventions and diagnostics. */
export interface VolumeProfile {
  bins: VolumeBin[];
  /** Point of control: price-bin midpoint with the most volume; null for an empty series. */
  poc: number | null;
  /** Value-area price bounds containing `valueAreaFraction` of total volume around the POC (nulls when empty). */
  valueArea: { low: number | null; high: number | null };
  totalVolume: number;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; bins: number; valueAreaFraction: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Fixed-range volume profile: each bar's volume is spread across the price buckets its high-low range
 * overlaps, **in proportion to the overlap** (a bar contributing 90% of its range to one bucket gives
 * that bucket 90% of its volume), giving volume-by-price, the point of control, and the value area.
 * A zero-range bar puts its whole volume in the bucket holding its close.
 */
export function volumeProfile(
  bars: ArrayLike<BarInput>,
  parameters: VolumeProfileParameters = {},
): VolumeProfile {
  requireArgumentArray('volumeProfile', 'bars', bars);
  requireArgumentObject('volumeProfile', 'parameters', parameters);
  // Law 12: an unknown param (a `valuAreaPct` typo) teaches instead of being silently ignored.
  ensureKnownKeys('volumeProfile', 'parameters', parameters, VOLUME_PROFILE_PARAMS_KEYS);
  ensureFiniteWhenPresent(parameters.bins, 'bins', 'volumeProfile');
  ensureFiniteWhenPresent(parameters.valueAreaFraction, 'valueAreaFraction', 'volumeProfile');
  const binCount = requirePeriod(parameters.bins ?? 24, 'volumeProfile', 'bins');
  const vaPct = requireInRange(
    parameters.valueAreaFraction ?? 0.7,
    'volumeProfile',
    'valueAreaFraction',
    0,
    1,
  );
  const assumptions = {
    conventionsVersion: CONVENTIONS_VERSION,
    bins: binCount,
    valueAreaFraction: vaPct,
  };
  if (bars.length === 0) {
    // Law 7: an empty series has no POC/value area — nulls with a reason, never NaN.
    return {
      bins: [],
      poc: null,
      valueArea: { low: null, high: null },
      totalVolume: 0,
      assumptions,
      diagnostics: {
        warnings: [
          warning(
            WarningCode.DegenerateInput,
            'volumeProfile: empty bar series — there is no profile; poc and valueArea are null.',
            'warn',
            { bars: 0 },
          ),
        ],
      },
    };
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  const span = hi - lo || 1;
  const width = span / binCount;
  const volumes = new Array<number>(binCount).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const v = volumeOf(b);
    const range = b.high - b.low;
    if (range === 0) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((b.close - lo) / width)));
      volumes[idx]! += v;
      continue;
    }
    // Spread the bar's volume across the buckets its range overlaps, weighted by HOW MUCH of the
    // range falls in each — the docstring's promise. Splitting it equally instead (the previous
    // behavior) mis-assigned any bar that straddles a boundary unevenly: a bar covering 5 points of
    // one bucket and 0.1 of the next handed both the same volume, which then moves the POC and the
    // value area. Σ of the shares is 1 by construction (Σ overlaps = the bar's range).
    const first = Math.min(binCount - 1, Math.max(0, Math.floor((b.low - lo) / width)));
    const last = Math.min(binCount - 1, Math.max(0, Math.floor((b.high - lo) / width)));
    let allocated = 0;
    for (let k = first; k <= last; k++) {
      const bucketLow = lo + k * width;
      const bucketHigh = bucketLow + width;
      const overlap = Math.min(b.high, bucketHigh) - Math.max(b.low, bucketLow);
      if (overlap <= 0) continue;
      const share = (v * overlap) / range;
      volumes[k]! += share;
      allocated += share;
    }
    // Float guard: hand any residue (or the whole amount, if the clamped span degenerated) to the
    // bucket holding the close, so the profile's total always equals the traded volume.
    const residual = v - allocated;
    if (residual !== 0) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((b.close - lo) / width)));
      volumes[idx]! += residual;
    }
  }
  const bins: VolumeBin[] = volumes.map((volume, i) => ({
    low: lo + i * width,
    high: lo + (i + 1) * width,
    volume,
  }));
  let total = 0;
  let pocIdx = 0;
  for (let i = 0; i < bins.length; i++) {
    total += bins[i]!.volume;
    if (bins[i]!.volume > bins[pocIdx]!.volume) pocIdx = i;
  }
  // grow the value area outward from the POC until it holds vaPct of total volume
  let valueAreaVolume = bins[pocIdx]!.volume;
  let lowIdx = pocIdx;
  let highIdx = pocIdx;
  const target = total * vaPct;
  while (valueAreaVolume < target && (lowIdx > 0 || highIdx < bins.length - 1)) {
    const below = lowIdx > 0 ? bins[lowIdx - 1]!.volume : -1;
    const above = highIdx < bins.length - 1 ? bins[highIdx + 1]!.volume : -1;
    if (above >= below) {
      highIdx++;
      valueAreaVolume += bins[highIdx]!.volume;
    } else {
      lowIdx--;
      valueAreaVolume += bins[lowIdx]!.volume;
    }
  }
  return {
    bins,
    poc: (bins[pocIdx]!.low + bins[pocIdx]!.high) / 2,
    valueArea: { low: bins[lowIdx]!.low, high: bins[highIdx]!.high },
    totalVolume: total,
    assumptions,
    diagnostics: { warnings: [] },
  };
}

// ───────────────────────── order-book imbalance ─────────────────────────

export interface OrderBookLevel {
  bidSize: number;
  askSize: number;
}
const ORDER_BOOK_LEVEL_KEYS = ['bidSize', 'askSize'] as const;

/** Order-book-imbalance envelope (Law 2): the imbalance plus conventions and diagnostics. */
export interface OrderBookImbalanceResult {
  /** Imbalance in [−1, 1], or null when both sizes are zero (disclosed in diagnostics). */
  value: number | null;
  /** Applied conventions, echoed (Law 2 grammar). */
  assumptions: { conventionsVersion: string };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Single-level order-book imbalance in [−1, 1]: +1 all bid, −1 all ask, 0 balanced. A level with
 * zero size on both sides has no imbalance — `value` is null with a diagnostics warning (Law 7).
 */
function orderBookImbalanceResult(level: OrderBookLevel): OrderBookImbalanceResult {
  requireArgumentObject('orderBookImbalance', 'level', level);
  // Law 12: an unknown field (a `bidSze` typo) teaches instead of being silently ignored.
  ensureKnownKeys('orderBookImbalance', 'level', level, ORDER_BOOK_LEVEL_KEYS);
  requireNonNegative(level.bidSize, 'orderBookImbalance', 'bidSize');
  requireNonNegative(level.askSize, 'orderBookImbalance', 'askSize');
  const assumptions = { conventionsVersion: CONVENTIONS_VERSION };
  const total = level.bidSize + level.askSize;
  if (total === 0) {
    return {
      value: null,
      assumptions,
      diagnostics: {
        warnings: [
          warning(
            WarningCode.DegenerateInput,
            'orderBookImbalance: both sizes are zero — the imbalance is undefined (null).',
            'warn',
            { bidSize: level.bidSize, askSize: level.askSize },
          ),
        ],
      },
    };
  }
  return {
    value: (level.bidSize - level.askSize) / total,
    assumptions,
    diagnostics: { warnings: [] },
  };
}

/** Plain single-level imbalance; use `.explain()` for zero-depth diagnostics. */
export const orderBookImbalance = facade(
  'orderBookImbalance',
  (level: OrderBookLevel): number | null => orderBookImbalanceResult(level).value,
  orderBookImbalanceResult,
);

export {
  AdLineStream,
  ChaikinOscStream,
  CmfStream,
  MfiStream,
  PvtStream,
  EomStream,
  ForceIndexStream,
  VolumeIndexStream,
  KlingerStream,
  VfiStream,
  RelativeVolumeStream,
  CvdStream,
};
