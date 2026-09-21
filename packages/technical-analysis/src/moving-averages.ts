/**
 * Moving averages (spec §13.3).
 *
 * The core three (SMA, EMA, WMA) plus the extended family: Wilder/RMA, DEMA, TEMA, TRIMA, T3, KAMA,
 * MAMA/FAMA, HMA, ZLEMA, ALMA, VIDYA, FRAMA, McGinley Dynamic, Ehlers Super Smoother, volume-weighted
 * MA, and rolling / anchored VWAP. Every one is a serializable stream wrapped into the aligned
 * batch+stream facade by `makeIndicator`, so batch output equals stream output by construction.
 */

import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import { ErrorCode, InputError } from '@totalfinance/core';

import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { dirtyRows, dirtySamples, isDirtySample } from './nan-policy.js';
import { requireSnapshotArrayCardinality } from './snapshot-cardinality.js';
import { requireStreamParameters } from './stream-validation.js';
import {
  requireAtMost,
  requireInRange,
  requireNonNegativeInt,
  requirePeriod,
  requirePositive,
} from './validate.js';

export interface PeriodParameters {
  period: number;
}

// ───────────────────────── core: SMA / EMA / WMA ─────────────────────────

class SmaStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  private sum = 0;
  /** Non-finite samples inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'SmaStream');
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (isDirtySample(value)) this.nanCount++;
    else this.sum += value;
    if (this.buf.length > this.period) {
      const gone = this.buf.shift()!;
      if (isDirtySample(gone)) this.nanCount--;
      else this.sum -= gone;
    }
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    this.value = this.nanCount > 0 ? NaN : this.sum / this.period;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('sma', {
      period: this.period,
      buf: [...this.buf],
      sum: this.sum,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SmaStream {
    requireSnapshotArrayCardinality(snapshot, 'sma', 'buf', {
      maximumLengthField: 'period',
      unit: 'samples',
    });
    const state = readSnapshot(snapshot, 'sma');
    const x = new SmaStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.sum = state.number('sum');
    x.nanCount = dirtySamples(x.buf);
    x.value = state.cached<number>('value');
    return x;
  }
}

class EmaStream implements IndicatorStream<number, number> {
  private count = 0;
  private seedSum = 0;
  private ema: number | null = null;
  private readonly k: number;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'EmaStream');
    this.k = 2 / (period + 1);
  }
  next(value: number): number | null {
    this.count++;
    if (this.ema === null) {
      this.seedSum += value;
      if (this.count === this.period) this.ema = this.seedSum / this.period;
    } else {
      this.ema = (value - this.ema) * this.k + this.ema;
    }
    this.value = this.count >= this.period ? this.ema : null;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('ema', {
      period: this.period,
      count: this.count,
      seedSum: this.seedSum,
      ema: this.ema,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): EmaStream {
    const state = readSnapshot(snapshot, 'ema');
    const x = new EmaStream(state.lookback('period'));
    x.count = state.number('count');
    x.seedSum = state.number('seedSum');
    x.ema = state.numberOrNull('ema');
    x.value = state.cached<number>('value');
    return x;
  }
}

class WmaStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'WmaStream');
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length === this.period) {
      const denom = (this.period * (this.period + 1)) / 2;
      let num = 0;
      for (let i = 0; i < this.period; i++) num += this.buf[i]! * (i + 1);
      this.value = num / denom;
    } else {
      this.value = null;
    }
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('wma', { period: this.period, buf: [...this.buf], value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): WmaStream {
    const state = readSnapshot(snapshot, 'wma');
    const x = new WmaStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── Wilder / RMA (SMMA) ─────────────────────────

class RmaStream implements IndicatorStream<number, number> {
  private count = 0;
  private seedSum = 0;
  private rma: number | null = null;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'RmaStream');
  }
  next(value: number): number | null {
    if (this.rma === null) {
      this.count++;
      this.seedSum += value;
      if (this.count === this.period) {
        this.rma = this.seedSum / this.period;
        this.value = this.rma;
        return this.rma;
      }
      this.value = null;
      return null;
    }
    this.rma = (this.rma * (this.period - 1) + value) / this.period;
    this.value = this.rma;
    return this.rma;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rma', {
      period: this.period,
      count: this.count,
      seedSum: this.seedSum,
      rma: this.rma,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RmaStream {
    const state = readSnapshot(snapshot, 'rma');
    const x = new RmaStream(state.lookback('period'));
    x.count = state.number('count');
    x.seedSum = state.number('seedSum');
    x.rma = state.numberOrNull('rma');
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── DEMA / TEMA (composed EMAs) ─────────────────────────

class DemaStream implements IndicatorStream<number, number> {
  private ema1: EmaStream;
  private ema2: EmaStream;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'DemaStream');
    this.ema1 = new EmaStream(period);
    this.ema2 = new EmaStream(period);
  }
  next(value: number): number | null {
    const e1 = this.ema1.next(value);
    if (e1 === null) {
      this.value = null;
      return null;
    }
    const e2 = this.ema2.next(e1);
    if (e2 === null) {
      this.value = null;
      return null;
    }
    this.value = 2 * e1 - e2;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('dema', {
      ema1: this.ema1.toJSON(),
      ema2: this.ema2.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): DemaStream {
    const state = readSnapshot(snapshot, 'dema');
    const x = new DemaStream(1);
    x.ema1 = EmaStream.fromJSON(state.child('ema1'));
    x.ema2 = EmaStream.fromJSON(state.child('ema2'));
    x.value = state.cached<number>('value');
    return x;
  }
}

class TemaStream implements IndicatorStream<number, number> {
  private ema1: EmaStream;
  private ema2: EmaStream;
  private ema3: EmaStream;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'TemaStream');
    this.ema1 = new EmaStream(period);
    this.ema2 = new EmaStream(period);
    this.ema3 = new EmaStream(period);
  }
  next(value: number): number | null {
    const e1 = this.ema1.next(value);
    if (e1 === null) {
      this.value = null;
      return null;
    }
    const e2 = this.ema2.next(e1);
    if (e2 === null) {
      this.value = null;
      return null;
    }
    const e3 = this.ema3.next(e2);
    if (e3 === null) {
      this.value = null;
      return null;
    }
    this.value = 3 * e1 - 3 * e2 + e3;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('tema', {
      ema1: this.ema1.toJSON(),
      ema2: this.ema2.toJSON(),
      ema3: this.ema3.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TemaStream {
    const state = readSnapshot(snapshot, 'tema');
    const x = new TemaStream(1);
    x.ema1 = EmaStream.fromJSON(state.child('ema1'));
    x.ema2 = EmaStream.fromJSON(state.child('ema2'));
    x.ema3 = EmaStream.fromJSON(state.child('ema3'));
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── TRIMA (triangular weights) ─────────────────────────

class TrimaStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  private readonly weights: number[];
  private readonly denom: number;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'TrimaStream');
    this.weights = new Array<number>(period);
    let d = 0;
    for (let i = 0; i < period; i++) {
      const w = Math.min(i + 1, period - i); // 1,2,…,peak,…,2,1
      this.weights[i] = w;
      d += w;
    }
    this.denom = d;
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    let num = 0;
    for (let i = 0; i < this.period; i++) num += this.buf[i]! * this.weights[i]!;
    this.value = num / this.denom;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('trima', { period: this.period, buf: [...this.buf], value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TrimaStream {
    const state = readSnapshot(snapshot, 'trima');
    const x = new TrimaStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── T3 (Tillson) ─────────────────────────

export interface T3Parameters {
  period: number;
  /** Tillson volume factor (0–1). Default 0.7. */
  volumeFactor?: number;
}

class T3Stream implements IndicatorStream<number, number> {
  private e: EmaStream[];
  private readonly c1: number;
  private readonly c2: number;
  private readonly c3: number;
  private readonly c4: number;
  value: number | null = null;
  constructor(parameters: { period: number; volumeFactor: number }) {
    requireStreamParameters('T3Stream.constructor#0', 'T3Stream', parameters);
    const { period, volumeFactor } = parameters;
    this.e = [0, 0, 0, 0, 0, 0].map(() => new EmaStream(period));
    const b = volumeFactor;
    const b2 = b * b;
    const b3 = b2 * b;
    this.c1 = -b3;
    this.c2 = 3 * b2 + 3 * b3;
    this.c3 = -6 * b2 - 3 * b - 3 * b3;
    this.c4 = 1 + 3 * b + b3 + 3 * b2;
  }
  next(value: number): number | null {
    let cur: number | null = value;
    const out: number[] = [];
    for (const ema of this.e) {
      cur = ema.next(cur);
      if (cur === null) {
        this.value = null;
        return null;
      }
      out.push(cur);
    }
    // out = [e1..e6]; T3 = c1·e6 + c2·e5 + c3·e4 + c4·e3
    this.value = this.c1 * out[5]! + this.c2 * out[4]! + this.c3 * out[3]! + this.c4 * out[2]!;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('t3', {
      c1: this.c1,
      c2: this.c2,
      c3: this.c3,
      c4: this.c4,
      e: this.e.map((x) => x.toJSON()),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): T3Stream {
    requireSnapshotArrayCardinality(snapshot, 't3', 'e', {
      exactLength: 6,
      unit: 'nested snapshots',
    });
    const state = readSnapshot(snapshot, 't3');
    const x = new T3Stream({ period: 1, volumeFactor: 0.7 });
    Object.assign(x, {
      c1: state.number('c1'),
      c2: state.number('c2'),
      c3: state.number('c3'),
      c4: state.number('c4'),
    });
    const children = state.children('e');
    if (children.length !== 6) {
      throw new InputError(
        `T3Stream.fromJSON: e must contain exactly 6 nested snapshots. Received ${children.length}.`,
        {
          code: ErrorCode.SnapshotWrongShape,
          context: {
            function: 'T3Stream.fromJSON',
            field: 'e',
            length: children.length,
            expectedLength: 6,
          },
        },
      );
    }
    x.e = children.map((snap) => EmaStream.fromJSON(snap));
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── KAMA (Kaufman adaptive) ─────────────────────────

export interface KamaParameters {
  period: number;
  /** Fast EMA constant period. Default 2. */
  fast?: number;
  /** Slow EMA constant period. Default 30. */
  slow?: number;
}

class KamaStream implements IndicatorStream<number, number> {
  private prices: number[] = [];
  private diffs: number[] = [];
  private volatilitySum = 0;
  /** Non-finite samples inside the volatility window — the interior-NaN gate (`./nan-policy`). */
  private nanCount = 0;
  private kama: number | null = null;
  private readonly fastSC: number;
  private readonly slowSC: number;
  value: number | null = null;
  private readonly period: number;
  constructor(parameters: { period: number; fast: number; slow: number }) {
    requireStreamParameters('KamaStream.constructor#0', 'KamaStream', parameters);
    const { period, fast, slow } = parameters;
    this.period = period;

    this.fastSC = 2 / (fast + 1);
    this.slowSC = 2 / (slow + 1);
  }
  next(value: number): number | null {
    if (this.prices.length > 0) {
      const d = Math.abs(value - this.prices[this.prices.length - 1]!);
      this.diffs.push(d);
      // Interior-NaN policy: only finite deltas enter the volatility sum, which would otherwise latch
      // to NaN for the rest of the series after a single missing print.
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
      // HOLD the recursion (do not feed it NaN — that latches the filter permanently) and emit NaN
      // until the bad sample leaves the window; KAMA then resumes from its last good state.
      this.value = NaN;
      return this.value;
    }
    const change = Math.abs(value - this.prices[0]!); // price[t] − price[t−period]
    const er = this.volatilitySum === 0 ? 0 : change / this.volatilitySum;
    const sc = (er * (this.fastSC - this.slowSC) + this.slowSC) ** 2;
    if (this.kama === null) {
      // Seed with the previous price (price[t−1]) — Kaufman's original initialization, which
      // TA-Lib also uses (it primes the recursion with the bar just before the first output).
      this.kama = this.prices[this.prices.length - 2]!;
    }
    this.kama = this.kama + sc * (value - this.kama);
    this.value = this.kama;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('kama', {
      period: this.period,
      fastSC: this.fastSC,
      slowSC: this.slowSC,
      prices: [...this.prices],
      diffs: [...this.diffs],
      volatilitySum: this.volatilitySum,
      kama: this.kama,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): KamaStream {
    const state = readSnapshot(snapshot, 'kama');
    const x = new KamaStream({ period: state.lookback('period'), fast: 2, slow: 30 });
    Object.assign(x, {
      fastSC: state.number('fastSC'),
      slowSC: state.number('slowSC'),
      volatilitySum: state.number('volatilitySum'),
      kama: state.numberOrNull('kama'),
    });
    x.prices = state.numbers('prices');
    x.diffs = state.numbers('diffs');
    x.nanCount = dirtySamples(x.diffs);
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── HMA (Hull) ─────────────────────────

class HmaStream implements IndicatorStream<number, number> {
  private wmaHalf: WmaStream;
  private wmaFull: WmaStream;
  private wmaSqrt: WmaStream;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'HmaStream');
    this.wmaHalf = new WmaStream(Math.max(1, Math.floor(period / 2)));
    this.wmaFull = new WmaStream(period);
    this.wmaSqrt = new WmaStream(Math.max(1, Math.round(Math.sqrt(period))));
  }
  next(value: number): number | null {
    const half = this.wmaHalf.next(value);
    const full = this.wmaFull.next(value);
    if (half === null || full === null) {
      this.value = null;
      return null;
    }
    const raw = 2 * half - full;
    this.value = this.wmaSqrt.next(raw);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('hma', {
      wmaHalf: this.wmaHalf.toJSON(),
      wmaFull: this.wmaFull.toJSON(),
      wmaSqrt: this.wmaSqrt.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): HmaStream {
    const state = readSnapshot(snapshot, 'hma');
    const x = new HmaStream(1);
    x.wmaHalf = WmaStream.fromJSON(state.child('wmaHalf'));
    x.wmaFull = WmaStream.fromJSON(state.child('wmaFull'));
    x.wmaSqrt = WmaStream.fromJSON(state.child('wmaSqrt'));
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── ZLEMA (zero-lag EMA) ─────────────────────────

class ZlemaStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  private ema: EmaStream;
  private readonly lag: number;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'ZlemaStream');
    this.ema = new EmaStream(period);
    this.lag = Math.floor((period - 1) / 2);
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.lag + 1) this.buf.shift();
    const lagged = this.buf.length > this.lag ? this.buf[0]! : value;
    this.value = this.ema.next(2 * value - lagged);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('zlema', {
      lag: this.lag,
      buf: [...this.buf],
      ema: this.ema.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ZlemaStream {
    const state = readSnapshot(snapshot, 'zlema');
    const x = new ZlemaStream(1);
    Object.assign(x, { lag: state.number('lag') });
    x.buf = state.numbers('buf');
    x.ema = EmaStream.fromJSON(state.child('ema'));
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── ALMA (Arnaud Legoux) ─────────────────────────

export interface AlmaParameters {
  period: number;
  /** Phase offset 0–1 (1 = responsive, 0 = smooth). Default 0.85. */
  offset?: number;
  /** Gaussian width. Default 6. */
  sigma?: number;
}

class AlmaStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  private readonly weights: number[];
  private readonly denom: number;
  value: number | null = null;
  constructor(parameters: { period: number; offset: number; sigma: number }) {
    requireStreamParameters('AlmaStream.constructor#0', 'AlmaStream', parameters);
    const { period, offset, sigma } = parameters;
    const m = offset * (period - 1);
    const s = period / sigma;
    this.weights = new Array<number>(period);
    let d = 0;
    for (let i = 0; i < period; i++) {
      const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
      this.weights[i] = w;
      d += w;
    }
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
    this.value = num / this.denom;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('alma', {
      weights: [...this.weights],
      denom: this.denom,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AlmaStream {
    const state = readSnapshot(snapshot, 'alma');
    const x = new AlmaStream({ period: 1, offset: 0.85, sigma: 6 });
    const w = state.numbers('weights');
    Object.assign(x, { weights: w, denom: state.number('denom') });
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── VIDYA (Chande variable index) ─────────────────────────

export interface VidyaParameters {
  period: number;
  /** CMO lookback driving the volatility index. Default = period. */
  cmoPeriod?: number;
}

class VidyaStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  private ups: number[] = [];
  private downs: number[] = [];
  private sumUp = 0;
  private sumDown = 0;
  /** Non-finite samples inside the CMO window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  private vidya: number | null = null;
  private readonly alpha: number;
  value: number | null = null;
  private readonly cmoPeriod: number;
  constructor(parameters: { period: number; cmoPeriod: number }) {
    requireStreamParameters('VidyaStream.constructor#0', 'VidyaStream', parameters);
    const { period, cmoPeriod } = parameters;
    this.cmoPeriod = cmoPeriod;

    this.alpha = 2 / (period + 1);
  }
  next(value: number): number | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    const ch = value - this.prev;
    this.prev = value;
    // A non-finite change is neither a gain nor a loss under `>`/`<`, so it would enter the window
    // as a silent 0/0; carry it through as NaN so the gate can see it.
    const bad = isDirtySample(ch);
    const up = bad ? NaN : ch > 0 ? ch : 0;
    const dn = bad ? NaN : ch < 0 ? -ch : 0;
    this.ups.push(up);
    this.downs.push(dn);
    // Interior-NaN policy: only finite gains/losses enter the running sums.
    if (bad) this.nanCount++;
    else {
      this.sumUp += up;
      this.sumDown += dn;
    }
    if (this.ups.length > this.cmoPeriod) {
      const goneUp = this.ups.shift()!;
      const goneDown = this.downs.shift()!;
      if (isDirtySample(goneUp) || isDirtySample(goneDown)) this.nanCount--;
      else {
        this.sumUp -= goneUp;
        this.sumDown -= goneDown;
      }
    }
    if (this.ups.length < this.cmoPeriod) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      // HOLD the recursion rather than feeding it NaN (which would latch VIDYA forever).
      this.value = NaN;
      return this.value;
    }
    const denom = this.sumUp + this.sumDown;
    const cmo = denom === 0 ? 0 : Math.abs(this.sumUp - this.sumDown) / denom; // |CMO|/100 ∈ [0,1]
    const a = this.alpha * cmo;
    if (this.vidya === null) this.vidya = value;
    this.vidya = a * value + (1 - a) * this.vidya;
    this.value = this.vidya;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('vidya', {
      cmoPeriod: this.cmoPeriod,
      alpha: this.alpha,
      prev: this.prev,
      ups: [...this.ups],
      downs: [...this.downs],
      sumUp: this.sumUp,
      sumDown: this.sumDown,
      vidya: this.vidya,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VidyaStream {
    const state = readSnapshot(snapshot, 'vidya');
    const x = new VidyaStream({ period: 1, cmoPeriod: state.lookback('cmoPeriod') });
    Object.assign(x, {
      alpha: state.number('alpha'),
      prev: state.numberOrNull('prev'),
      sumUp: state.number('sumUp'),
      sumDown: state.number('sumDown'),
      vidya: state.numberOrNull('vidya'),
    });
    x.ups = state.numbers('ups');
    x.downs = state.numbers('downs');
    x.nanCount = dirtyRows(x.ups, x.downs);
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── McGinley Dynamic ─────────────────────────

/**
 * McGinley Dynamic (John R. McGinley) — an EMA-like average whose smoothing constant self-adjusts by
 * the ratio of price to the current average, so it speeds up in fast markets and slows in quiet ones.
 * Registered as `mcginley`; pandas-ta calls it `mcgd`.
 */
class McGinleyStream implements IndicatorStream<number, number> {
  private md: number | null = null;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'McGinleyStream');
  }
  next(value: number): number | null {
    if (this.md === null) {
      this.md = value;
    } else {
      const ratio = value / this.md;
      this.md = this.md + (value - this.md) / (this.period * ratio ** 4);
    }
    this.value = this.md;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('mcginley', { period: this.period, md: this.md, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): McGinleyStream {
    const state = readSnapshot(snapshot, 'mcginley');
    const x = new McGinleyStream(state.lookback('period'));
    x.md = state.numberOrNull('md');
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── Ehlers Super Smoother (2-pole) ─────────────────────────

class SuperSmootherStream implements IndicatorStream<number, number> {
  private p1: number | null = null; // price[t-1]
  private s1: number | null = null; // ss[t-1]
  private s2: number | null = null; // ss[t-2]
  private readonly c1: number;
  private readonly c2: number;
  private readonly c3: number;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'SuperSmootherStream');
    const a1 = Math.exp((-1.414 * Math.PI) / period);
    const b1 = 2 * a1 * Math.cos((1.414 * Math.PI) / period);
    this.c2 = b1;
    this.c3 = -a1 * a1;
    this.c1 = 1 - this.c2 - this.c3;
  }
  next(value: number): number | null {
    if (this.p1 === null) {
      // first bar: seed filter with the price
      this.p1 = value;
      this.s1 = value;
      this.s2 = value;
      this.value = value;
      return value;
    }
    const ss =
      this.c1 * ((value + this.p1) / 2) +
      this.c2 * (this.s1 as number) +
      this.c3 * (this.s2 as number);
    this.p1 = value;
    this.s2 = this.s1;
    this.s1 = ss;
    this.value = ss;
    return ss;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('superSmoother', {
      c1: this.c1,
      c2: this.c2,
      c3: this.c3,
      p1: this.p1,
      s1: this.s1,
      s2: this.s2,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SuperSmootherStream {
    const state = readSnapshot(snapshot, 'superSmoother');
    const x = new SuperSmootherStream(1);
    Object.assign(x, {
      c1: state.number('c1'),
      c2: state.number('c2'),
      c3: state.number('c3'),
      p1: state.numberOrNull('p1'),
      s1: state.numberOrNull('s1'),
      s2: state.numberOrNull('s2'),
    });
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── VWMA (volume-weighted) ─────────────────────────

class VwmaStream implements IndicatorStream<BarInput, number> {
  private pv: number[] = [];
  private volumes: number[] = [];
  private sumPV = 0;
  private sumV = 0;
  /** Non-finite samples inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'VwmaStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): number | null {
    const v = bar.volume ?? 0;
    const pv = bar.close * v;
    this.pv.push(pv);
    this.volumes.push(v);
    // Interior-NaN policy: only finite samples enter the running sums.
    if (isDirtySample(pv) || isDirtySample(v)) this.nanCount++;
    else {
      this.sumPV += pv;
      this.sumV += v;
    }
    if (this.pv.length > this.period) {
      const gonePV = this.pv.shift()!;
      const goneV = this.volumes.shift()!;
      if (isDirtySample(gonePV) || isDirtySample(goneV)) this.nanCount--;
      else {
        this.sumPV -= gonePV;
        this.sumV -= goneV;
      }
    }
    if (this.pv.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      this.value = NaN;
      return this.value;
    }
    this.value = this.sumV === 0 ? bar.close : this.sumPV / this.sumV;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('vwma', {
      period: this.period,
      pv: [...this.pv],
      volumes: [...this.volumes],
      sumPV: this.sumPV,
      sumV: this.sumV,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VwmaStream {
    const state = readSnapshot(snapshot, 'vwma');
    const x = new VwmaStream(state.lookback('period'));
    Object.assign(x, { sumPV: state.number('sumPV'), sumV: state.number('sumV') });
    x.pv = state.numbers('pv');
    x.volumes = state.numbers('volumes');
    x.nanCount = dirtyRows(x.pv, x.volumes);
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── rolling VWAP (windowed) ─────────────────────────

class RollingVwapStream implements IndicatorStream<BarInput, number> {
  private pv: number[] = [];
  private volumes: number[] = [];
  private sumPV = 0;
  private sumV = 0;
  /** Non-finite samples inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'RollingVwapStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): number | null {
    const tp = (bar.high + bar.low + bar.close) / 3;
    const v = bar.volume ?? 0;
    const pv = tp * v;
    this.pv.push(pv);
    this.volumes.push(v);
    // Interior-NaN policy: only finite samples enter the running sums.
    if (isDirtySample(pv) || isDirtySample(v)) this.nanCount++;
    else {
      this.sumPV += pv;
      this.sumV += v;
    }
    if (this.pv.length > this.period) {
      const gonePV = this.pv.shift()!;
      const goneV = this.volumes.shift()!;
      if (isDirtySample(gonePV) || isDirtySample(goneV)) this.nanCount--;
      else {
        this.sumPV -= gonePV;
        this.sumV -= goneV;
      }
    }
    if (this.pv.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      this.value = NaN;
      return this.value;
    }
    this.value = this.sumV === 0 ? tp : this.sumPV / this.sumV;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rollingVwap', {
      period: this.period,
      pv: [...this.pv],
      volumes: [...this.volumes],
      sumPV: this.sumPV,
      sumV: this.sumV,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RollingVwapStream {
    const state = readSnapshot(snapshot, 'rollingVwap');
    const x = new RollingVwapStream(state.lookback('period'));
    Object.assign(x, { sumPV: state.number('sumPV'), sumV: state.number('sumV') });
    x.pv = state.numbers('pv');
    x.volumes = state.numbers('volumes');
    x.nanCount = dirtyRows(x.pv, x.volumes);
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── anchored VWAP ─────────────────────────

export interface AnchoredVwapParameters {
  /** Bar index (0-based) from which accumulation starts. Bars before the anchor emit null. */
  anchor: number;
}

class AnchoredVwapStream implements IndicatorStream<BarInput, number> {
  private idx = 0;
  private cumPV = 0;
  private cumV = 0;
  value: number | null = null;
  constructor(private readonly anchor: number) {}
  next(bar: BarInput): number | null {
    const i = this.idx++;
    if (i < this.anchor) {
      this.value = null;
      return null;
    }
    const tp = (bar.high + bar.low + bar.close) / 3;
    const v = bar.volume ?? 0;
    this.cumPV += tp * v;
    this.cumV += v;
    this.value = this.cumV === 0 ? tp : this.cumPV / this.cumV;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('anchoredVwap', {
      anchor: this.anchor,
      idx: this.idx,
      cumPV: this.cumPV,
      cumV: this.cumV,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AnchoredVwapStream {
    const state = readSnapshot(snapshot, 'anchoredVwap');
    const x = new AnchoredVwapStream(state.number('anchor'));
    Object.assign(x, {
      idx: state.number('idx'),
      cumPV: state.number('cumPV'),
      cumV: state.number('cumV'),
    });
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── MAMA / FAMA (MESA adaptive, Ehlers) ─────────────────────────

export interface MamaParameters {
  /** Fast adaptation limit. Default 0.5. */
  fastLimit?: number;
  /** Slow adaptation limit. Default 0.05. */
  slowLimit?: number;
}

export interface MamaPoint {
  mama: number;
  fama: number;
}

const RAD2DEG = 180 / Math.PI;

/** Push onto a fixed-length history ring (index 0 = most recent). */
function pushRing(ring: number[], v: number, length: number): void {
  ring.unshift(v);
  if (ring.length > length) ring.pop();
}
function at(ring: number[], i: number): number {
  return ring[i] ?? 0;
}

class MamaStream implements IndicatorStream<BarInput, MamaPoint> {
  private count = 0;
  private price: number[] = [];
  private smooth: number[] = [];
  private detrender: number[] = [];
  private i1: number[] = [];
  private q1: number[] = [];
  private i2 = 0;
  private q2 = 0;
  private re = 0;
  private im = 0;
  private period = 0;
  private smoothPeriod = 0;
  private phase = 0;
  private mama: number | null = null;
  private fama = 0;
  value: MamaPoint | null = null;
  private readonly fastLimit: number;
  private readonly slowLimit: number;
  constructor(parameters: { fastLimit: number; slowLimit: number }) {
    requireStreamParameters('MamaStream.constructor#0', 'MamaStream', parameters);
    const { fastLimit, slowLimit } = parameters;
    this.fastLimit = fastLimit;
    this.slowLimit = slowLimit;
  }

  next(bar: BarInput): MamaPoint | null {
    const p = (bar.high + bar.low) / 2;
    pushRing(this.price, p, 8);
    this.count++;
    if (this.count <= 6) {
      // fill FIR history before the Hilbert transform is meaningful
      pushRing(this.smooth, p, 8);
      pushRing(this.detrender, 0, 8);
      pushRing(this.i1, 0, 8);
      pushRing(this.q1, 0, 8);
      this.value = null;
      return null;
    }
    const adj = 0.075 * this.period + 0.54;
    const smooth =
      (4 * at(this.price, 0) + 3 * at(this.price, 1) + 2 * at(this.price, 2) + at(this.price, 3)) /
      10;
    pushRing(this.smooth, smooth, 8);
    const detrender =
      (0.0962 * at(this.smooth, 0) +
        0.5769 * at(this.smooth, 2) -
        0.5769 * at(this.smooth, 4) -
        0.0962 * at(this.smooth, 6)) *
      adj;
    pushRing(this.detrender, detrender, 8);

    // in-phase and quadrature
    const q1 =
      (0.0962 * at(this.detrender, 0) +
        0.5769 * at(this.detrender, 2) -
        0.5769 * at(this.detrender, 4) -
        0.0962 * at(this.detrender, 6)) *
      adj;
    const i1 = at(this.detrender, 3);
    pushRing(this.q1, q1, 8);
    pushRing(this.i1, i1, 8);

    const jI =
      (0.0962 * at(this.i1, 0) +
        0.5769 * at(this.i1, 2) -
        0.5769 * at(this.i1, 4) -
        0.0962 * at(this.i1, 6)) *
      adj;
    const jQ =
      (0.0962 * at(this.q1, 0) +
        0.5769 * at(this.q1, 2) -
        0.5769 * at(this.q1, 4) -
        0.0962 * at(this.q1, 6)) *
      adj;

    let i2 = i1 - jQ;
    let q2 = q1 + jI;
    i2 = 0.2 * i2 + 0.8 * this.i2;
    q2 = 0.2 * q2 + 0.8 * this.q2;

    let re = i2 * this.i2 + q2 * this.q2;
    let im = i2 * this.q2 - q2 * this.i2;
    re = 0.2 * re + 0.8 * this.re;
    im = 0.2 * im + 0.8 * this.im;
    this.i2 = i2;
    this.q2 = q2;
    this.re = re;
    this.im = im;

    const prevPeriod = this.period;
    let period = prevPeriod;
    if (im !== 0 && re !== 0) period = 360 / (RAD2DEG * Math.atan(im / re));
    if (period > 1.5 * prevPeriod && prevPeriod > 0) period = 1.5 * prevPeriod;
    if (period < 0.67 * prevPeriod && prevPeriod > 0) period = 0.67 * prevPeriod;
    if (period < 6) period = 6;
    if (period > 50) period = 50;
    period = 0.2 * period + 0.8 * prevPeriod;
    this.period = period;
    this.smoothPeriod = 0.33 * period + 0.67 * this.smoothPeriod;

    const prevPhase = this.phase;
    this.phase = i1 !== 0 ? RAD2DEG * Math.atan(q1 / i1) : prevPhase;
    let deltaPhase = prevPhase - this.phase;
    if (deltaPhase < 1) deltaPhase = 1;
    let alpha = this.fastLimit / deltaPhase;
    if (alpha < this.slowLimit) alpha = this.slowLimit;

    if (this.mama === null) {
      this.mama = p;
      this.fama = p;
    } else {
      this.mama = alpha * p + (1 - alpha) * this.mama;
      this.fama = 0.5 * alpha * this.mama + (1 - 0.5 * alpha) * this.fama;
    }
    this.value = { mama: this.mama, fama: this.fama };
    return this.value;
  }

  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('mama', {
      fastLimit: this.fastLimit,
      slowLimit: this.slowLimit,
      count: this.count,
      price: [...this.price],
      smooth: [...this.smooth],
      detrender: [...this.detrender],
      i1: [...this.i1],
      q1: [...this.q1],
      i2: this.i2,
      q2: this.q2,
      re: this.re,
      im: this.im,
      period: this.period,
      smoothPeriod: this.smoothPeriod,
      phase: this.phase,
      mama: this.mama,
      fama: this.fama,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MamaStream {
    const state = readSnapshot(snapshot, 'mama');
    const x = new MamaStream({
      fastLimit: state.number('fastLimit'),
      slowLimit: state.number('slowLimit'),
    });
    Object.assign(x, {
      count: state.number('count'),
      i2: state.number('i2'),
      q2: state.number('q2'),
      re: state.number('re'),
      im: state.number('im'),
      period: state.number('period'),
      smoothPeriod: state.number('smoothPeriod'),
      phase: state.number('phase'),
      mama: state.numberOrNull('mama'),
      fama: state.number('fama'),
    });
    x.price = state.numbers('price');
    x.smooth = state.numbers('smooth');
    x.detrender = state.numbers('detrender');
    x.i1 = state.numbers('i1');
    x.q1 = state.numbers('q1');
    x.value = state.cached<MamaPoint>('value');
    return x;
  }
}

// ───────────────────────── FRAMA (fractal adaptive, Ehlers) ─────────────────────────

export interface FramaParameters {
  /** Lookback (rounded up to an even number). Default 16. */
  period: number;
}

class FramaStream implements IndicatorStream<BarInput, number> {
  private highs: number[] = [];
  private lows: number[] = [];
  private closes: number[] = [];
  private frama: number | null = null;
  private readonly n: number;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'FramaStream', 'period', 2);
    this.n = period % 2 === 0 ? period : period + 1; // FRAMA needs an even window
  }
  next(bar: BarInput): number | null {
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    this.closes.push(bar.close);
    if (this.highs.length > this.n) {
      this.highs.shift();
      this.lows.shift();
      this.closes.shift();
    }
    if (this.highs.length < this.n) {
      this.value = null;
      return null;
    }
    const half = this.n / 2;
    const rangeOver = (h: number[], l: number[]): number =>
      (Math.max(...h) - Math.min(...l)) / h.length;
    const n1 = rangeOver(this.highs.slice(0, half), this.lows.slice(0, half));
    const n2 = rangeOver(this.highs.slice(half), this.lows.slice(half));
    const n3 = rangeOver(this.highs, this.lows);
    let d = 1;
    if (n1 > 0 && n2 > 0 && n3 > 0) d = (Math.log(n1 + n2) - Math.log(n3)) / Math.LN2;
    let alpha = Math.exp(-4.6 * (d - 1));
    if (alpha < 0.01) alpha = 0.01;
    if (alpha > 1) alpha = 1;
    const price = bar.close;
    if (this.frama === null) this.frama = price;
    this.frama = alpha * price + (1 - alpha) * this.frama;
    this.value = this.frama;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('frama', {
      n: this.n,
      highs: [...this.highs],
      lows: [...this.lows],
      closes: [...this.closes],
      frama: this.frama,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): FramaStream {
    const state = readSnapshot(snapshot, 'frama');
    const x = new FramaStream(state.number('n'));
    Object.assign(x, { frama: state.numberOrNull('frama') });
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.closes = state.numbers('closes');
    x.value = state.cached<number>('value');
    return x;
  }
}

// ───────────────────────── facades ─────────────────────────

const nan = (): number => NaN;

export const sma = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new SmaStream(requirePeriod(p.period, 'sma')),
    SmaStream.fromJSON,
    nan,
  ),
  builtinMetadata.smaMetadata,
);
export const ema = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new EmaStream(requirePeriod(p.period, 'ema')),
    EmaStream.fromJSON,
    nan,
  ),
  builtinMetadata.emaMetadata,
);
export const wma = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new WmaStream(requirePeriod(p.period, 'wma')),
    WmaStream.fromJSON,
    nan,
  ),
  builtinMetadata.wmaMetadata,
);
export const rma = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new RmaStream(requirePeriod(p.period, 'rma')),
    RmaStream.fromJSON,
    nan,
  ),
  builtinMetadata.rmaMetadata,
);
export const dema = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new DemaStream(requirePeriod(p.period, 'dema')),
    DemaStream.fromJSON,
    nan,
  ),
  builtinMetadata.demaMetadata,
);
export const tema = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new TemaStream(requirePeriod(p.period, 'tema')),
    TemaStream.fromJSON,
    nan,
  ),
  builtinMetadata.temaMetadata,
);
export const trima = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new TrimaStream(requirePeriod(p.period, 'trima')),
    TrimaStream.fromJSON,
    nan,
  ),
  builtinMetadata.trimaMetadata,
);
export const t3 = withBuiltinMetadata(
  makeIndicator<T3Parameters, number, number>(
    (p) =>
      new T3Stream({
        period: requirePeriod(p.period, 't3'),
        volumeFactor: requireInRange(p.volumeFactor ?? 0.7, 't3', 'volumeFactor', 0, 1),
      }),
    T3Stream.fromJSON,
    nan,
  ),
  builtinMetadata.t3Metadata,
);
export const kama = withBuiltinMetadata(
  makeIndicator<KamaParameters, number, number>(
    (p) =>
      new KamaStream({
        period: requirePeriod(p.period, 'kama'),
        fast: requirePeriod(p.fast ?? 2, 'kama', 'fast'),
        slow: requirePeriod(p.slow ?? 30, 'kama', 'slow'),
      }),
    KamaStream.fromJSON,
    nan,
  ),
  builtinMetadata.kamaMetadata,
);
export const hma = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new HmaStream(requirePeriod(p.period, 'hma')),
    HmaStream.fromJSON,
    nan,
  ),
  builtinMetadata.hmaMetadata,
);
export const zlema = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new ZlemaStream(requirePeriod(p.period, 'zlema')),
    ZlemaStream.fromJSON,
    nan,
  ),
  builtinMetadata.zlemaMetadata,
);
export const alma = withBuiltinMetadata(
  makeIndicator<AlmaParameters, number, number>(
    (p) =>
      new AlmaStream({
        period: requirePeriod(p.period, 'alma'),
        offset: requireInRange(p.offset ?? 0.85, 'alma', 'offset', 0, 1),
        sigma: requirePositive(p.sigma ?? 6, 'alma', 'sigma'),
      }),
    AlmaStream.fromJSON,
    nan,
  ),
  builtinMetadata.almaMetadata,
);
export const vidya = withBuiltinMetadata(
  makeIndicator<VidyaParameters, number, number>(
    (p) =>
      new VidyaStream({
        period: requirePeriod(p.period, 'vidya'),
        cmoPeriod: requirePeriod(p.cmoPeriod ?? p.period, 'vidya', 'cmoPeriod'),
      }),
    VidyaStream.fromJSON,
    nan,
  ),
  builtinMetadata.vidyaMetadata,
);
export const mcginley = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new McGinleyStream(requirePeriod(p.period, 'mcginley')),
    McGinleyStream.fromJSON,
    nan,
  ),
  builtinMetadata.mcginleyMetadata,
);
export const superSmoother = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new SuperSmootherStream(requirePeriod(p.period, 'superSmoother')),
    SuperSmootherStream.fromJSON,
    nan,
  ),
  builtinMetadata.superSmootherMetadata,
);
export const vwma = withBuiltinMetadata(
  makeIndicator<PeriodParameters, BarInput, number>(
    (p) => new VwmaStream(requirePeriod(p.period, 'vwma', 'period', 1, 'bars')),
    VwmaStream.fromJSON,
    nan,
  ),
  builtinMetadata.vwmaMetadata,
);
export const rollingVwap = withBuiltinMetadata(
  makeIndicator<PeriodParameters, BarInput, number>(
    (p) => new RollingVwapStream(requirePeriod(p.period, 'rollingVwap', 'period', 1, 'bars')),
    RollingVwapStream.fromJSON,
    nan,
  ),
  builtinMetadata.rollingVwapMetadata,
);
export const anchoredVwap = withBuiltinMetadata(
  makeIndicator<AnchoredVwapParameters, BarInput, number>(
    (p) =>
      new AnchoredVwapStream(requireNonNegativeInt(p.anchor, 'anchoredVwap', 'anchor', 'bars')),
    AnchoredVwapStream.fromJSON,
    nan,
  ),
  builtinMetadata.anchoredVwapMetadata,
);
export const frama = withBuiltinMetadata(
  makeIndicator<FramaParameters, BarInput, number>(
    (p) => new FramaStream(requirePeriod(p.period, 'frama', 'period', 1, 'bars')),
    FramaStream.fromJSON,
    nan,
  ),
  builtinMetadata.framaMetadata,
);
export const mama = withBuiltinMetadata(
  makeIndicator<MamaParameters, BarInput, MamaPoint>(
    (p) => {
      // `alpha` is used directly as a smoothing weight, so enforce 0 < slowLimit ≤ fastLimit ≤ 1.
      const fastLimit = p.fastLimit ?? 0.5;
      const slowLimit = p.slowLimit ?? 0.05;
      requirePositive(fastLimit, 'mama', 'fastLimit');
      requirePositive(slowLimit, 'mama', 'slowLimit');
      requireInRange(fastLimit, 'mama', 'fastLimit', 0, 1);
      requireInRange(slowLimit, 'mama', 'slowLimit', 0, 1);
      requireAtMost(slowLimit, fastLimit, 'mama', 'slowLimit', 'fastLimit');
      return new MamaStream({ fastLimit, slowLimit });
    },
    MamaStream.fromJSON,
    () => ({ mama: NaN, fama: NaN }),
  ),
  builtinMetadata.mamaMetadata,
);

export {
  SmaStream,
  EmaStream,
  WmaStream,
  RmaStream,
  DemaStream,
  TemaStream,
  TrimaStream,
  T3Stream,
  KamaStream,
  HmaStream,
  ZlemaStream,
  AlmaStream,
  VidyaStream,
  McGinleyStream,
  SuperSmootherStream,
  VwmaStream,
  RollingVwapStream,
  AnchoredVwapStream,
  FramaStream,
  MamaStream,
};
