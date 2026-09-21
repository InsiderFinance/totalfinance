/**
 * Momentum oscillators (spec §13.3).
 *
 * StochRSI, PPO, APO, CCI, CMO, the ROC family, Momentum, Williams %R, TRIX, Ultimate Oscillator,
 * Awesome Oscillator, KST, TSI, Connors RSI, Fisher Transform, DPO, and the MACDEXT / MACDFIX MACD
 * variants. RSI, Stochastic and the base MACD live in their own modules. Each indicator is a
 * serializable stream wrapped into the aligned batch+stream facade.
 */

import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import { ErrorCode, InputError, requireArgumentObject } from '@totalfinance/core';
import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { type MacdPoint } from './macd.js';
import {
  DemaStream,
  EmaStream,
  RmaStream,
  SmaStream,
  TemaStream,
  TrimaStream,
  WmaStream,
} from './moving-averages.js';
import { RsiStream } from './rsi.js';
import { dirtyRows, dirtySamples, isDirtySample } from './nan-policy.js';
import { requireSnapshotArrayCardinality } from './snapshot-cardinality.js';
import { requireBooleanWhenPresent, requireOneOf, requirePeriod } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

const nan = (): number => NaN;

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

// ───────────────────────── ROC family & Momentum ─────────────────────────

export interface RocParameters {
  /** Lookback. Defaults to 10 for roc/rocp/rocr/rocr100/momentum; echoed via `.explain()`. */
  period?: number;
}

type RocMode = 'roc' | 'rocp' | 'rocr' | 'rocr100' | 'mom';

class RocStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  private readonly period: number;
  private readonly mode: RocMode;
  constructor(parameters: { period: number; mode: RocMode }) {
    requireStreamParameters('RocStream.constructor#0', 'RocStream', parameters);
    const { period, mode } = parameters;
    this.period = period;
    this.mode = mode;
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period + 1) this.buf.shift();
    if (this.buf.length < this.period + 1) {
      this.value = null;
      return null;
    }
    const past = this.buf[0]!;
    switch (this.mode) {
      case 'roc':
        this.value = past === 0 ? NaN : ((value - past) / past) * 100;
        break;
      case 'rocp':
        this.value = past === 0 ? NaN : (value - past) / past;
        break;
      case 'rocr':
        this.value = past === 0 ? NaN : value / past;
        break;
      case 'rocr100':
        this.value = past === 0 ? NaN : (value / past) * 100;
        break;
      case 'mom':
        this.value = value - past;
        break;
    }
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(`roc:${this.mode}`, {
      period: this.period,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static restore(mode: RocMode) {
    return (s: TechnicalAnalysisSnapshot): RocStream => {
      const state = readSnapshot(s, `roc:${mode}`);
      const x = new RocStream({ period: state.lookback('period'), mode });
      x.buf = state.numbers('buf');
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

function rocFacade(mode: RocMode, defaultPeriod: number) {
  return makeIndicator<RocParameters, number, number>(
    (p) => new RocStream({ period: requirePeriod(p.period ?? defaultPeriod, mode), mode }),
    RocStream.restore(mode),
    nan,
  );
}

export const roc = withBuiltinMetadata(rocFacade('roc', 10), builtinMetadata.rocMetadata);
export const rocp = withBuiltinMetadata(rocFacade('rocp', 10), builtinMetadata.rocpMetadata);
export const rocr = withBuiltinMetadata(rocFacade('rocr', 10), builtinMetadata.rocrMetadata);
export const rocr100 = withBuiltinMetadata(
  rocFacade('rocr100', 10),
  builtinMetadata.rocr100Metadata,
);
export const momentum = withBuiltinMetadata(rocFacade('mom', 10), builtinMetadata.momentumMetadata);

// ───────────────────────── CMO (Chande Momentum Oscillator) ─────────────────────────

export interface PeriodParameters {
  period: number;
}

class CmoStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  private ups: number[] = [];
  private downs: number[] = [];
  private sumUp = 0;
  private sumDown = 0;
  /** Non-finite samples inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'CmoStream');
  }
  next(value: number): number | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    const ch = value - this.prev;
    this.prev = value;
    // A non-finite change is neither a gain nor a loss under `>`/`<`, so it would silently enter the
    // window as 0/0 and quietly bias the oscillator; carry it through as NaN instead.
    const bad = isDirtySample(ch);
    const up = bad ? NaN : ch > 0 ? ch : 0;
    const dn = bad ? NaN : ch < 0 ? -ch : 0;
    this.ups.push(up);
    this.downs.push(dn);
    if (bad) this.nanCount++;
    else {
      this.sumUp += up;
      this.sumDown += dn;
    }
    if (this.ups.length > this.period) {
      const goneUp = this.ups.shift()!;
      const goneDown = this.downs.shift()!;
      if (isDirtySample(goneUp) || isDirtySample(goneDown)) this.nanCount--;
      else {
        this.sumUp -= goneUp;
        this.sumDown -= goneDown;
      }
    }
    if (this.ups.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      this.value = NaN;
      return this.value;
    }
    const denom = this.sumUp + this.sumDown;
    this.value = denom === 0 ? 0 : (100 * (this.sumUp - this.sumDown)) / denom;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('cmo', {
      period: this.period,
      prev: this.prev,
      ups: [...this.ups],
      downs: [...this.downs],
      sumUp: this.sumUp,
      sumDown: this.sumDown,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CmoStream {
    const state = readSnapshot(snapshot, 'cmo');
    const x = new CmoStream(state.lookback('period'));
    Object.assign(x, {
      prev: state.numberOrNull('prev'),
      sumUp: state.number('sumUp'),
      sumDown: state.number('sumDown'),
    });
    x.ups = state.numbers('ups');
    x.downs = state.numbers('downs');
    x.nanCount = dirtyRows(x.ups, x.downs);
    x.value = state.cached<number>('value');
    return x;
  }
}

/**
 * TA-Lib-compatible CMO: TA-Lib smooths the up/down sums with Wilder's RMA (like its RSI), so its
 * CMO is exactly `2·RSI − 100`. Reusing the (TA-Lib-certified) `RsiStream` reproduces TA-Lib's CMO
 * bit-for-bit, whereas the default `CmoStream` uses Chande's original simple sums (pandas-ta).
 */
class CmoTalibStream implements IndicatorStream<number, number> {
  private rsi: RsiStream;
  value: number | null = null;
  constructor(period: number) {
    this.rsi = new RsiStream(period);
  }
  next(value: number): number | null {
    const r = this.rsi.next(value);
    this.value = r === null ? null : 2 * r - 100;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('cmoTalib', { rsi: this.rsi.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CmoTalibStream {
    const state = readSnapshot(snapshot, 'cmoTalib');
    const x = new CmoTalibStream(1);
    x.rsi = RsiStream.fromJSON(state.child('rsi'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export interface CmoParameters {
  /** Lookback. Defaults to 14; echoed via `.explain()`. */
  period?: number;
  /** Reproduce TA-Lib's Wilder-smoothed CMO (`2·RSI − 100`) instead of Chande's simple sums. */
  talib?: boolean;
}
export const cmo = withBuiltinMetadata(
  makeIndicator<CmoParameters, number, number>(
    (p) =>
      (requireBooleanWhenPresent(p.talib, 'cmo', 'talib') ?? false)
        ? new CmoTalibStream(requirePeriod(p.period ?? 14, 'cmo'))
        : new CmoStream(requirePeriod(p.period ?? 14, 'cmo')),
    (s) => (s['kind'] === 'cmoTalib' ? CmoTalibStream.fromJSON(s) : CmoStream.fromJSON(s)),
    nan,
  ),
  builtinMetadata.cmoMetadata,
);

// ───────────────────────── APO / PPO ─────────────────────────

export interface ApoParameters {
  fast?: number;
  slow?: number;
}
export interface PpoParameters {
  fast?: number;
  slow?: number;
  signal?: number;
}
export interface PpoPoint {
  ppo: number;
  signal: number;
  histogram: number;
}

class ApoStream implements IndicatorStream<number, number> {
  private fast: EmaStream;
  private slow: EmaStream;
  value: number | null = null;
  constructor(parameters: { fast: number; slow: number }) {
    requireStreamParameters('ApoStream.constructor#0', 'ApoStream', parameters);
    const { fast, slow } = parameters;
    this.fast = new EmaStream(fast);
    this.slow = new EmaStream(slow);
  }
  next(value: number): number | null {
    const f = this.fast.next(value);
    const s = this.slow.next(value);
    if (f === null || s === null) {
      this.value = null;
      return null;
    }
    this.value = f - s;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('apo', {
      fast: this.fast.toJSON(),
      slow: this.slow.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ApoStream {
    const state = readSnapshot(snapshot, 'apo');
    const x = new ApoStream({ fast: 1, slow: 1 });
    x.fast = EmaStream.fromJSON(state.child('fast'));
    x.slow = EmaStream.fromJSON(state.child('slow'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const apo = withBuiltinMetadata(
  makeIndicator<ApoParameters, number, number>(
    (p) =>
      new ApoStream({
        fast: requirePeriod(p.fast ?? 12, 'apo', 'fast'),
        slow: requirePeriod(p.slow ?? 26, 'apo', 'slow'),
      }),
    ApoStream.fromJSON,
    nan,
  ),
  builtinMetadata.apoMetadata,
);

class PpoStream implements IndicatorStream<number, PpoPoint> {
  private fast: EmaStream;
  private slow: EmaStream;
  private signalEma: EmaStream;
  value: PpoPoint | null = null;
  constructor(parameters: { fast: number; slow: number; signal: number }) {
    requireStreamParameters('PpoStream.constructor#0', 'PpoStream', parameters);
    const { fast, slow, signal } = parameters;
    this.fast = new EmaStream(fast);
    this.slow = new EmaStream(slow);
    this.signalEma = new EmaStream(signal);
  }
  next(value: number): PpoPoint | null {
    const f = this.fast.next(value);
    const s = this.slow.next(value);
    if (f === null || s === null || s === 0) {
      this.value = null;
      return null;
    }
    const ppo = ((f - s) / s) * 100;
    const sig = this.signalEma.next(ppo);
    if (sig === null) {
      this.value = null;
      return null;
    }
    this.value = { ppo, signal: sig, histogram: ppo - sig };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('ppo', {
      fast: this.fast.toJSON(),
      slow: this.slow.toJSON(),
      signal: this.signalEma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PpoStream {
    const state = readSnapshot(snapshot, 'ppo');
    const x = new PpoStream({ fast: 1, slow: 1, signal: 1 });
    x.fast = EmaStream.fromJSON(state.child('fast'));
    x.slow = EmaStream.fromJSON(state.child('slow'));
    x.signalEma = EmaStream.fromJSON(state.child('signal'));
    x.value = state.cached<PpoPoint>('value');
    return x;
  }
}

export const ppo = withBuiltinMetadata(
  makeIndicator<PpoParameters, number, PpoPoint>(
    (p) =>
      new PpoStream({
        fast: requirePeriod(p.fast ?? 12, 'ppo', 'fast'),
        slow: requirePeriod(p.slow ?? 26, 'ppo', 'slow'),
        signal: requirePeriod(p.signal ?? 9, 'ppo', 'signal'),
      }),
    PpoStream.fromJSON,
    () => ({ ppo: NaN, signal: NaN, histogram: NaN }),
  ),
  builtinMetadata.ppoMetadata,
);

// ───────────────────────── StochRSI ─────────────────────────

export interface StochRsiParameters {
  rsiPeriod?: number;
  stochPeriod?: number;
  kPeriod?: number;
  dPeriod?: number;
}
export interface StochRsiPoint {
  k: number;
  d: number;
}

class StochRsiStream implements IndicatorStream<number, StochRsiPoint> {
  private rsi: RsiStream;
  private rsiBuf: number[] = [];
  private kSma: SmaStream;
  private dSma: SmaStream;
  private lastK: number | null = null;
  value: StochRsiPoint | null = null;
  private readonly stochPeriod: number;
  constructor(parameters: {
    rsiPeriod: number;
    stochPeriod: number;
    kPeriod: number;
    dPeriod: number;
  }) {
    requireStreamParameters('StochRsiStream.constructor#0', 'StochRsiStream', parameters);
    const { rsiPeriod, stochPeriod, kPeriod, dPeriod } = parameters;
    this.stochPeriod = stochPeriod;

    this.rsi = new RsiStream(rsiPeriod);
    this.kSma = new SmaStream(kPeriod);
    this.dSma = new SmaStream(dPeriod);
  }
  next(value: number): StochRsiPoint | null {
    const r = this.rsi.next(value);
    if (r === null) {
      this.value = null;
      return null;
    }
    this.rsiBuf.push(r);
    if (this.rsiBuf.length > this.stochPeriod) this.rsiBuf.shift();
    if (this.rsiBuf.length < this.stochPeriod) {
      this.value = null;
      return null;
    }
    const hi = maxOf(this.rsiBuf);
    const lo = minOf(this.rsiBuf);
    // Flat RSI window: 0/0 resolves to 0, matching pandas-ta's `stochrsi` (measured: 0 on a flat
    // series, 0.4.x) and TA-Lib's STOCHRSI — the same convention `stochastic` uses.
    const raw = hi === lo ? 0 : ((r - lo) / (hi - lo)) * 100;
    const k = this.kSma.next(raw);
    if (k === null) {
      this.value = null;
      return null;
    }
    this.lastK = k;
    const d = this.dSma.next(k);
    if (d === null) {
      this.value = null;
      return null;
    }
    this.value = { k, d };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('stochRsi', {
      stochPeriod: this.stochPeriod,
      rsi: this.rsi.toJSON(),
      rsiBuf: [...this.rsiBuf],
      kSma: this.kSma.toJSON(),
      dSma: this.dSma.toJSON(),
      lastK: this.lastK,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): StochRsiStream {
    const state = readSnapshot(snapshot, 'stochRsi');
    const x = new StochRsiStream({
      rsiPeriod: 1,
      stochPeriod: state.lookback('stochPeriod'),
      kPeriod: 1,
      dPeriod: 1,
    });
    x.rsi = RsiStream.fromJSON(state.child('rsi'));
    x.kSma = SmaStream.fromJSON(state.child('kSma'));
    x.dSma = SmaStream.fromJSON(state.child('dSma'));
    x.rsiBuf = state.numbers('rsiBuf');
    x.lastK = state.numberOrNull('lastK');
    x.value = state.cached<StochRsiPoint>('value');
    return x;
  }
}

export const stochRsi = withBuiltinMetadata(
  makeIndicator<StochRsiParameters, number, StochRsiPoint>(
    (p) =>
      new StochRsiStream({
        rsiPeriod: requirePeriod(p.rsiPeriod ?? 14, 'stochRsi', 'rsiPeriod'),
        stochPeriod: requirePeriod(p.stochPeriod ?? 14, 'stochRsi', 'stochPeriod'),
        kPeriod: requirePeriod(p.kPeriod ?? 3, 'stochRsi', 'kPeriod'),
        dPeriod: requirePeriod(p.dPeriod ?? 3, 'stochRsi', 'dPeriod'),
      }),
    StochRsiStream.fromJSON,
    () => ({ k: NaN, d: NaN }),
  ),
  builtinMetadata.stochRsiMetadata,
);

// ───────────────────────── TRIX ─────────────────────────

class TrixStream implements IndicatorStream<number, number> {
  private e1: EmaStream;
  private e2: EmaStream;
  private e3: EmaStream;
  private prev: number | null = null;
  value: number | null = null;
  constructor(period: number) {
    requirePeriod(period, 'TrixStream');
    this.e1 = new EmaStream(period);
    this.e2 = new EmaStream(period);
    this.e3 = new EmaStream(period);
  }
  next(value: number): number | null {
    const a = this.e1.next(value);
    if (a === null) {
      this.value = null;
      return null;
    }
    const b = this.e2.next(a);
    if (b === null) {
      this.value = null;
      return null;
    }
    const c = this.e3.next(b);
    if (c === null) {
      this.value = null;
      return null;
    }
    if (this.prev === null) {
      // The bar that produces the FIRST triple-EMA value has no prior one to take a rate of change
      // against, so it is warmup — not a 0% change. Emitting 0 here published a fabricated value one
      // bar ahead of TA-Lib's first TRIX output (its lookback is `3·(period − 1) + 1`), and a
      // fabricated 0 in a momentum series reads as "no momentum", not as "no data".
      this.prev = c;
      this.value = null;
      return null;
    }
    // Zero base ⇒ the rate of change is undefined: NaN, exactly like `roc` (never a silent 0).
    this.value = this.prev === 0 ? NaN : ((c - this.prev) / this.prev) * 100;
    this.prev = c;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('trix', {
      e1: this.e1.toJSON(),
      e2: this.e2.toJSON(),
      e3: this.e3.toJSON(),
      prev: this.prev,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TrixStream {
    const state = readSnapshot(snapshot, 'trix');
    const x = new TrixStream(1);
    x.e1 = EmaStream.fromJSON(state.child('e1'));
    x.e2 = EmaStream.fromJSON(state.child('e2'));
    x.e3 = EmaStream.fromJSON(state.child('e3'));
    x.prev = state.numberOrNull('prev');
    x.value = state.cached<number>('value');
    return x;
  }
}

/**
 * TRIX — the 1-bar rate of change of a triple-smoothed EMA, in percent.
 *
 * Warmup is TA-Lib's TRIX lookback, `3·(period − 1) + 1`: the triple EMA itself first exists at
 * `3·(period − 1)`, and the rate of change needs the bar after that.
 */
export const trix = withBuiltinMetadata(
  makeIndicator<{ period?: number }, number, number>(
    (p) => new TrixStream(requirePeriod(p.period ?? 30, 'trix')),
    TrixStream.fromJSON,
    nan,
  ),
  builtinMetadata.trixMetadata,
);

// ───────────────────────── DPO (Detrended Price Oscillator) ─────────────────────────

/**
 * Detrended Price Oscillator, Pring's causal form: `close[t − shift] − SMA(close, period)[t]` with
 * `shift = ⌊period/2⌋ + 1` (the same lag pandas-ta applies with `centered=True`, but resolved
 * BACKWARD so no value depends on a future bar).
 *
 * The SMA needs `period` bars and the lagged close needs `shift + 1`, and for a very short period the
 * SECOND is the binding one: `period ≤ 2` puts `close[t − shift]` outside a `period`-deep buffer, and
 * indexing it produced `undefined − sma` = NaN for the whole series. The window is sized to
 * `max(period, shift + 1)` so every period is well defined; for `period ≥ 3` (`shift + 1 ≤ period`)
 * the warmup and every value are exactly as before.
 */
class DpoStream implements IndicatorStream<number, number> {
  /** Trailing closes, newest last; capacity `capacity`. */
  private buf: number[] = [];
  /** Σ of the last `period` closes (finite samples only — see `./nan-policy`). */
  private sum = 0;
  private nanCount = 0;
  private readonly shift: number;
  private readonly capacity: number;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'DpoStream');
    this.shift = Math.floor(period / 2) + 1;
    this.capacity = Math.max(period, this.shift + 1);
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (isDirtySample(value)) this.nanCount++;
    else this.sum += value;
    // The SMA window is the last `period` entries: drop the one that just fell out of it.
    if (this.buf.length > this.period) {
      const leftSma = this.buf[this.buf.length - 1 - this.period]!;
      if (isDirtySample(leftSma)) this.nanCount--;
      else this.sum -= leftSma;
    }
    // …and the buffer itself only has to reach back far enough for the lagged close.
    if (this.buf.length > this.capacity) this.buf.shift();
    if (this.buf.length < this.capacity) {
      this.value = null;
      return null;
    }
    const past = this.buf[this.buf.length - 1 - this.shift]!;
    if (this.nanCount > 0 || isDirtySample(past)) {
      this.value = NaN;
      return this.value;
    }
    this.value = past - this.sum / this.period;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    // `shift` is NOT serialized: the constructor derives it from `period`, so a stored copy could
    // disagree with the period beside it and nothing would notice.
    return snapshotOf('dpo', {
      period: this.period,
      buf: [...this.buf],
      sum: this.sum,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): DpoStream {
    const state = readSnapshot(snapshot, 'dpo');
    const x = new DpoStream(state.lookback('period'));
    Object.assign(x, { sum: state.number('sum') });
    x.buf = state.numbers('buf');
    // Only the SMA window's tail feeds `sum`, so only its dirt gates emission.
    x.nanCount = dirtySamples(x.buf.slice(Math.max(0, x.buf.length - x.period)));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const dpo = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new DpoStream(requirePeriod(p.period, 'dpo')),
    DpoStream.fromJSON,
    nan,
  ),
  builtinMetadata.dpoMetadata,
);

// ───────────────────────── TSI (True Strength Index) ─────────────────────────

export interface TsiParameters {
  long?: number;
  short?: number;
  signal?: number;
}
export interface TsiPoint {
  tsi: number;
  signal: number;
}

class TsiStream implements IndicatorStream<number, TsiPoint> {
  private prev: number | null = null;
  private mLong: EmaStream;
  private mShort: EmaStream;
  private aLong: EmaStream;
  private aShort: EmaStream;
  private signalEma: EmaStream;
  value: TsiPoint | null = null;
  constructor(parameters: { long: number; short: number; signal: number }) {
    requireStreamParameters('TsiStream.constructor#0', 'TsiStream', parameters);
    const { long, short, signal } = parameters;
    this.mLong = new EmaStream(long);
    this.mShort = new EmaStream(short);
    this.aLong = new EmaStream(long);
    this.aShort = new EmaStream(short);
    this.signalEma = new EmaStream(signal);
  }
  next(value: number): TsiPoint | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    const mom = value - this.prev;
    this.prev = value;
    const ml = this.mLong.next(mom);
    const al = this.aLong.next(Math.abs(mom));
    if (ml === null || al === null) {
      this.value = null;
      return null;
    }
    const momSmooth = this.mShort.next(ml);
    const absSmooth = this.aShort.next(al);
    if (momSmooth === null || absSmooth === null) {
      this.value = null;
      return null;
    }
    const tsi = absSmooth === 0 ? 0 : (100 * momSmooth) / absSmooth;
    const sig = this.signalEma.next(tsi);
    if (sig === null) {
      this.value = null;
      return null;
    }
    this.value = { tsi, signal: sig };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('tsi', {
      prev: this.prev,
      mLong: this.mLong.toJSON(),
      mShort: this.mShort.toJSON(),
      aLong: this.aLong.toJSON(),
      aShort: this.aShort.toJSON(),
      signal: this.signalEma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TsiStream {
    const state = readSnapshot(snapshot, 'tsi');
    const x = new TsiStream({ long: 1, short: 1, signal: 1 });
    x.prev = state.numberOrNull('prev');
    x.mLong = EmaStream.fromJSON(state.child('mLong'));
    x.mShort = EmaStream.fromJSON(state.child('mShort'));
    x.aLong = EmaStream.fromJSON(state.child('aLong'));
    x.aShort = EmaStream.fromJSON(state.child('aShort'));
    x.signalEma = EmaStream.fromJSON(state.child('signal'));
    x.value = state.cached<TsiPoint>('value');
    return x;
  }
}

export const tsi = withBuiltinMetadata(
  makeIndicator<TsiParameters, number, TsiPoint>(
    (p) =>
      new TsiStream({
        long: requirePeriod(p.long ?? 25, 'tsi', 'long'),
        short: requirePeriod(p.short ?? 13, 'tsi', 'short'),
        signal: requirePeriod(p.signal ?? 13, 'tsi', 'signal'),
      }),
    TsiStream.fromJSON,
    () => ({ tsi: NaN, signal: NaN }),
  ),
  builtinMetadata.tsiMetadata,
);

// ───────────────────────── KST (Know Sure Thing) ─────────────────────────

export interface KstParameters {
  rocPeriods?: [number, number, number, number];
  smaPeriods?: [number, number, number, number];
  signal?: number;
}
export interface KstPoint {
  kst: number;
  signal: number;
}

class KstStream implements IndicatorStream<number, KstPoint> {
  private rocs: RocStream[];
  private smas: SmaStream[];
  private signalSma: SmaStream;
  value: KstPoint | null = null;
  constructor(parameters: { rocPeriods: number[]; smaPeriods: number[]; signal: number }) {
    // Cardinality is a first-touch invariant: reject a huge request from `.length` before the
    // generated deep validator traverses or copies element zero.
    requireArgumentObject('KstStream', 'parameters', parameters);
    const { rocPeriods, smaPeriods, signal } = parameters;
    requireKstPeriodTuple(rocPeriods, 'KstStream', 'rocPeriods');
    requireKstPeriodTuple(smaPeriods, 'KstStream', 'smaPeriods');
    requireStreamParameters('KstStream.constructor#0', 'KstStream', parameters);
    this.rocs = rocPeriods.map((p) => new RocStream({ period: p, mode: 'roc' }));
    this.smas = smaPeriods.map((p) => new SmaStream(p));
    this.signalSma = new SmaStream(signal);
  }
  next(value: number): KstPoint | null {
    // feed every ROC on every bar (they are independent) — short-circuiting would starve the
    // longer-period ROCs while the shorter ones warm up, corrupting both warmup and values.
    const rocVals = this.rocs.map((r) => r.next(value));
    const rcma: (number | null)[] = [null, null, null, null];
    for (let i = 0; i < 4; i++) {
      const rv = rocVals[i];
      if (rv != null) rcma[i] = this.smas[i]!.next(rv);
    }
    if (rcma.some((x) => x === null)) {
      this.value = null;
      return null;
    }
    const kst = 1 * rcma[0]! + 2 * rcma[1]! + 3 * rcma[2]! + 4 * rcma[3]!;
    const sig = this.signalSma.next(kst);
    if (sig === null) {
      this.value = null;
      return null;
    }
    this.value = { kst, signal: sig };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('kst', {
      rocs: this.rocs.map((r) => r.toJSON()),
      smas: this.smas.map((s) => s.toJSON()),
      signal: this.signalSma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): KstStream {
    for (const field of ['rocs', 'smas'] as const) {
      requireSnapshotArrayCardinality(snapshot, 'kst', field, {
        exactLength: 4,
        unit: 'nested snapshots',
      });
    }
    const state = readSnapshot(snapshot, 'kst');
    const x = new KstStream({ rocPeriods: [1, 1, 1, 1], smaPeriods: [1, 1, 1, 1], signal: 1 });
    const rocs = state.children('rocs');
    const smas = state.children('smas');
    for (const [field, children] of [
      ['rocs', rocs],
      ['smas', smas],
    ] as const) {
      if (children.length !== 4) {
        throw new InputError(
          `KstStream.fromJSON: ${field} must contain exactly four nested snapshots. Received ${children.length}.`,
          {
            code: ErrorCode.SnapshotWrongShape,
            context: {
              function: 'KstStream.fromJSON',
              field,
              length: children.length,
              expectedLength: 4,
            },
          },
        );
      }
    }
    x.rocs = rocs.map((snap) => RocStream.restore('roc')(snap));
    x.smas = smas.map((snap) => SmaStream.fromJSON(snap));
    x.signalSma = SmaStream.fromJSON(state.child('signal'));
    x.value = state.cached<KstPoint>('value');
    return x;
  }
}

function requireKstPeriodTuple(
  value: unknown,
  functionName: string,
  field: string,
): asserts value is number[] {
  if (!Array.isArray(value)) {
    throw new InputError(
      `${functionName}: ${field} must be an array containing exactly four periods. Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {
          function: functionName,
          field,
          received: value === null ? 'null' : typeof value,
        },
      },
    );
  }
  if (value.length !== 4) {
    throw new InputError(
      `${functionName}: ${field} must contain exactly four periods. Received ${value.length}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, length: value.length, expectedLength: 4 },
      },
    );
  }
}

export const kst = withBuiltinMetadata(
  makeIndicator<KstParameters, number, KstPoint>(
    (p) => {
      for (const field of ['rocPeriods', 'smaPeriods'] as const) {
        const v = (p as Record<string, unknown>)[field];
        if (v !== undefined && !Array.isArray(v)) {
          throw new InputError(
            `kst: ${field} must be an array of four periods when provided. Received ${v === null ? 'null' : typeof v}.`,
            { code: ErrorCode.InputWrongType, context: { field } },
          );
        }
        if (Array.isArray(v)) requireKstPeriodTuple(v, 'kst', field);
      }
      const rocPeriods = (p.rocPeriods ?? [10, 15, 20, 30]).map((n, i) =>
        requirePeriod(n, 'kst', `rocPeriods[${i}]`),
      ) as [number, number, number, number];
      const smaPeriods = (p.smaPeriods ?? [10, 10, 10, 15]).map((n, i) =>
        requirePeriod(n, 'kst', `smaPeriods[${i}]`),
      ) as [number, number, number, number];
      return new KstStream({
        rocPeriods: rocPeriods,
        smaPeriods: smaPeriods,
        signal: requirePeriod(p.signal ?? 9, 'kst', 'signal'),
      });
    },
    KstStream.fromJSON,
    () => ({ kst: NaN, signal: NaN }),
  ),
  builtinMetadata.kstMetadata,
);

// ───────────────────────── Connors RSI ─────────────────────────

export interface ConnorsRsiParameters {
  rsiPeriod?: number;
  streakPeriod?: number;
  rankPeriod?: number;
}

class ConnorsRsiStream implements IndicatorStream<number, number> {
  private priceRsi: RsiStream;
  private streakRsi: RsiStream;
  private prev: number | null = null;
  private streak = 0;
  private rocBuf: number[] = [];
  value: number | null = null;
  private readonly rankPeriod: number;
  constructor(parameters: { rsiPeriod: number; streakPeriod: number; rankPeriod: number }) {
    requireStreamParameters('ConnorsRsiStream.constructor#0', 'ConnorsRsiStream', parameters);
    const { rsiPeriod, streakPeriod, rankPeriod } = parameters;
    this.rankPeriod = rankPeriod;

    this.priceRsi = new RsiStream(rsiPeriod);
    this.streakRsi = new RsiStream(streakPeriod);
  }
  next(value: number): number | null {
    const pr = this.priceRsi.next(value);
    // streak update
    let roc1: number | null = null;
    if (this.prev !== null) {
      roc1 = this.prev === 0 ? 0 : ((value - this.prev) / this.prev) * 100;
      if (value > this.prev) this.streak = this.streak >= 0 ? this.streak + 1 : 1;
      else if (value < this.prev) this.streak = this.streak <= 0 ? this.streak - 1 : -1;
      else this.streak = 0;
    }
    this.prev = value;
    const sr = this.streakRsi.next(this.streak);

    // percent rank of roc1 against the trailing window of prior roc1 values
    let rank: number | null = null;
    if (roc1 !== null) {
      if (this.rocBuf.length >= this.rankPeriod) {
        let less = 0;
        for (const r of this.rocBuf) if (r < roc1) less++;
        rank = (less / this.rocBuf.length) * 100;
      }
      this.rocBuf.push(roc1);
      if (this.rocBuf.length > this.rankPeriod) this.rocBuf.shift();
    }

    if (pr === null || sr === null || rank === null) {
      this.value = null;
      return null;
    }
    this.value = (pr + sr + rank) / 3;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('connorsRsi', {
      rankPeriod: this.rankPeriod,
      priceRsi: this.priceRsi.toJSON(),
      streakRsi: this.streakRsi.toJSON(),
      prev: this.prev,
      streak: this.streak,
      rocBuf: [...this.rocBuf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ConnorsRsiStream {
    const state = readSnapshot(snapshot, 'connorsRsi');
    const x = new ConnorsRsiStream({
      rsiPeriod: 1,
      streakPeriod: 1,
      rankPeriod: state.lookback('rankPeriod'),
    });
    x.priceRsi = RsiStream.fromJSON(state.child('priceRsi'));
    x.streakRsi = RsiStream.fromJSON(state.child('streakRsi'));
    Object.assign(x, { prev: state.numberOrNull('prev'), streak: state.number('streak') });
    x.rocBuf = state.numbers('rocBuf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const connorsRsi = withBuiltinMetadata(
  makeIndicator<ConnorsRsiParameters, number, number>(
    (p) =>
      new ConnorsRsiStream({
        rsiPeriod: requirePeriod(p.rsiPeriod ?? 3, 'connorsRsi', 'rsiPeriod'),
        streakPeriod: requirePeriod(p.streakPeriod ?? 2, 'connorsRsi', 'streakPeriod'),
        rankPeriod: requirePeriod(p.rankPeriod ?? 100, 'connorsRsi', 'rankPeriod'),
      }),
    ConnorsRsiStream.fromJSON,
    nan,
  ),
  builtinMetadata.connorsRsiMetadata,
);

// ───────────────────────── CCI (Commodity Channel Index) ─────────────────────────

class CciStream implements IndicatorStream<BarInput, number> {
  private buf: number[] = [];
  private sum = 0;
  /** Non-finite samples inside the window — the interior-NaN gate (see `./nan-policy`). */
  private nanCount = 0;
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'CciStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): number | null {
    const tp = (bar.high + bar.low + bar.close) / 3;
    this.buf.push(tp);
    // Interior-NaN policy: only finite typical prices enter the running sum.
    if (isDirtySample(tp)) this.nanCount++;
    else this.sum += tp;
    if (this.buf.length > this.period) {
      const gone = this.buf.shift()!;
      if (isDirtySample(gone)) this.nanCount--;
      else this.sum -= gone;
    }
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    if (this.nanCount > 0) {
      this.value = NaN;
      return this.value;
    }
    const mean = this.sum / this.period;
    let dev = 0;
    for (const x of this.buf) dev += Math.abs(x - mean);
    const meanDev = dev / this.period;
    this.value = meanDev === 0 ? 0 : (tp - mean) / (0.015 * meanDev);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('cci', {
      period: this.period,
      buf: [...this.buf],
      sum: this.sum,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CciStream {
    const state = readSnapshot(snapshot, 'cci');
    const x = new CciStream(state.lookback('period'));
    Object.assign(x, { sum: state.number('sum') });
    x.buf = state.numbers('buf');
    x.nanCount = dirtySamples(x.buf);
    x.value = state.cached<number>('value');
    return x;
  }
}

export const cci = withBuiltinMetadata(
  makeIndicator<{ period?: number }, BarInput, number>(
    (p) => new CciStream(requirePeriod(p.period ?? 14, 'cci')),
    CciStream.fromJSON,
    nan,
  ),
  builtinMetadata.cciMetadata,
);

// ───────────────────────── Williams %R ─────────────────────────

class WilliamsRStream implements IndicatorStream<BarInput, number> {
  private highs: number[] = [];
  private lows: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'WilliamsRStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): number | null {
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
    const hh = maxOf(this.highs);
    const ll = minOf(this.lows);
    this.value = hh === ll ? 0 : (-100 * (hh - bar.close)) / (hh - ll);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('williamsR', {
      period: this.period,
      highs: [...this.highs],
      lows: [...this.lows],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): WilliamsRStream {
    const state = readSnapshot(snapshot, 'williamsR');
    const x = new WilliamsRStream(state.lookback('period'));
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const williamsR = withBuiltinMetadata(
  makeIndicator<{ period?: number }, BarInput, number>(
    // Williams %R lookback defaults to 14 (universal); echoed via `.explain()`.
    (p) => new WilliamsRStream(requirePeriod(p.period ?? 14, 'williamsR')),
    WilliamsRStream.fromJSON,
    nan,
  ),
  builtinMetadata.williamsRMetadata,
);

// ───────────────────────── Awesome Oscillator ─────────────────────────

export interface AwesomeParameters {
  fast?: number;
  slow?: number;
}

class AwesomeStream implements IndicatorStream<BarInput, number> {
  private fast: SmaStream;
  private slow: SmaStream;
  value: number | null = null;
  constructor(parameters: { fast: number; slow: number }) {
    requireStreamParameters('AwesomeStream.constructor#0', 'AwesomeStream', parameters);
    const { fast, slow } = parameters;
    this.fast = new SmaStream(fast);
    this.slow = new SmaStream(slow);
  }
  next(bar: BarInput): number | null {
    const m = (bar.high + bar.low) / 2;
    const f = this.fast.next(m);
    const s = this.slow.next(m);
    if (f === null || s === null) {
      this.value = null;
      return null;
    }
    this.value = f - s;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('awesome', {
      fast: this.fast.toJSON(),
      slow: this.slow.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AwesomeStream {
    const state = readSnapshot(snapshot, 'awesome');
    const x = new AwesomeStream({ fast: 1, slow: 1 });
    x.fast = SmaStream.fromJSON(state.child('fast'));
    x.slow = SmaStream.fromJSON(state.child('slow'));
    x.value = state.cached<number>('value');
    return x;
  }
}

export const awesomeOscillator = withBuiltinMetadata(
  makeIndicator<AwesomeParameters, BarInput, number>(
    (p) =>
      new AwesomeStream({
        fast: requirePeriod(p.fast ?? 5, 'awesomeOscillator', 'fast'),
        slow: requirePeriod(p.slow ?? 34, 'awesomeOscillator', 'slow'),
      }),
    AwesomeStream.fromJSON,
    nan,
  ),
  builtinMetadata.awesomeOscillatorMetadata,
);

// ───────────────────────── Ultimate Oscillator ─────────────────────────

export interface UltimateParameters {
  short?: number;
  medium?: number;
  long?: number;
}

class UltimateStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private bp: number[] = [];
  private tr: number[] = [];
  value: number | null = null;
  private readonly short: number;
  private readonly medium: number;
  private readonly long: number;
  constructor(parameters: { short: number; medium: number; long: number }) {
    requireStreamParameters('UltimateStream.constructor#0', 'UltimateStream', parameters);
    const { short, medium, long } = parameters;
    this.short = short;
    this.medium = medium;
    this.long = long;
  }
  private sumLast(arr: number[], n: number): number {
    let sum = 0;
    for (let i = arr.length - n; i < arr.length; i++) sum += arr[i]!;
    return sum;
  }
  next(bar: BarInput): number | null {
    if (this.previousClose === null) {
      this.previousClose = bar.close;
      this.value = null;
      return null;
    }
    const low = Math.min(bar.low, this.previousClose);
    const high = Math.max(bar.high, this.previousClose);
    this.bp.push(bar.close - low);
    this.tr.push(high - low);
    this.previousClose = bar.close;
    const cap = this.long;
    if (this.bp.length > cap) {
      this.bp.shift();
      this.tr.shift();
    }
    if (this.bp.length < this.long) {
      this.value = null;
      return null;
    }
    const avg = (n: number): number => {
      const trSum = this.sumLast(this.tr, n);
      return trSum === 0 ? 0 : this.sumLast(this.bp, n) / trSum;
    };
    this.value = (100 * (4 * avg(this.short) + 2 * avg(this.medium) + avg(this.long))) / 7;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('ultimate', {
      short: this.short,
      medium: this.medium,
      long: this.long,
      previousClose: this.previousClose,
      bp: [...this.bp],
      tr: [...this.tr],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): UltimateStream {
    const state = readSnapshot(snapshot, 'ultimate');
    const x = new UltimateStream({
      short: state.lookback('short'),
      medium: state.lookback('medium'),
      long: state.lookback('long'),
    });
    Object.assign(x, { previousClose: state.numberOrNull('previousClose') });
    x.bp = state.numbers('bp');
    x.tr = state.numbers('tr');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const ultimateOscillator = withBuiltinMetadata(
  makeIndicator<UltimateParameters, BarInput, number>(
    (p) =>
      new UltimateStream({
        short: requirePeriod(p.short ?? 7, 'ultimateOscillator', 'short'),
        medium: requirePeriod(p.medium ?? 14, 'ultimateOscillator', 'medium'),
        long: requirePeriod(p.long ?? 28, 'ultimateOscillator', 'long'),
      }),
    UltimateStream.fromJSON,
    nan,
  ),
  builtinMetadata.ultimateOscillatorMetadata,
);

// ───────────────────────── Fisher Transform ─────────────────────────

export interface FisherParameters {
  period?: number;
}
export interface FisherPoint {
  fisher: number;
  trigger: number;
}

class FisherStream implements IndicatorStream<BarInput, FisherPoint> {
  private highs: number[] = [];
  private lows: number[] = [];
  private val = 0;
  private fish = 0;
  value: FisherPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'FisherStream', 'period', 1, 'bars');
  }
  next(bar: BarInput): FisherPoint | null {
    const price = (bar.high + bar.low) / 2;
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
    const hh = maxOf(this.highs);
    const ll = minOf(this.lows);
    const raw = hh === ll ? 0 : ((price - ll) / (hh - ll) - 0.5) * 2;
    this.val = 0.33 * raw + 0.67 * this.val;
    let v = this.val;
    if (v > 0.999) v = 0.999;
    if (v < -0.999) v = -0.999;
    const prevFish = this.fish;
    this.fish = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * prevFish;
    this.value = { fisher: this.fish, trigger: prevFish };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('fisher', {
      period: this.period,
      highs: [...this.highs],
      lows: [...this.lows],
      val: this.val,
      fish: this.fish,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): FisherStream {
    const state = readSnapshot(snapshot, 'fisher');
    const x = new FisherStream(state.lookback('period'));
    Object.assign(x, { val: state.number('val'), fish: state.number('fish') });
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<FisherPoint>('value');
    return x;
  }
}

export const fisherTransform = withBuiltinMetadata(
  makeIndicator<FisherParameters, BarInput, FisherPoint>(
    (p) => new FisherStream(requirePeriod(p.period ?? 9, 'fisherTransform')),
    FisherStream.fromJSON,
    () => ({ fisher: NaN, trigger: NaN }),
  ),
  builtinMetadata.fisherTransformMetadata,
);

// ───────────────────────── MACDEXT / MACDFIX ─────────────────────────

export type MovingAverageType = 'sma' | 'ema' | 'wma' | 'dema' | 'tema' | 'trima' | 'rma';

export const MOVING_AVERAGE_TYPES: readonly MovingAverageType[] = [
  'sma',
  'ema',
  'wma',
  'dema',
  'tema',
  'trima',
  'rma',
];

function movingAverageStream(
  type: MovingAverageType,
  period: number,
): IndicatorStream<number, number> {
  switch (type) {
    case 'sma':
      return new SmaStream(period);
    case 'ema':
      return new EmaStream(period);
    case 'wma':
      return new WmaStream(period);
    case 'dema':
      return new DemaStream(period);
    case 'tema':
      return new TemaStream(period);
    case 'trima':
      return new TrimaStream(period);
    case 'rma':
      return new RmaStream(period);
  }
}

function restoreMovingAverage(s: TechnicalAnalysisSnapshot): IndicatorStream<number, number> {
  switch (s.kind) {
    case 'sma':
      return SmaStream.fromJSON(s);
    case 'ema':
      return EmaStream.fromJSON(s);
    case 'wma':
      return WmaStream.fromJSON(s);
    case 'dema':
      return DemaStream.fromJSON(s);
    case 'tema':
      return TemaStream.fromJSON(s);
    case 'trima':
      return TrimaStream.fromJSON(s);
    case 'rma':
      return RmaStream.fromJSON(s);
    default:
      throw new InputError(`macdExt.fromJSON: unknown MA snapshot kind "${String(s.kind)}".`, {
        code: ErrorCode.SnapshotUnknownKind,
        context: { kind: s.kind },
      });
  }
}

export interface MacdExtParameters {
  fast?: number;
  slow?: number;
  signal?: number;
  fastMovingAverageType?: MovingAverageType;
  slowMovingAverageType?: MovingAverageType;
  signalMovingAverageType?: MovingAverageType;
}

class MacdExtStream implements IndicatorStream<number, MacdPoint> {
  value: MacdPoint | null = null;
  private fast: IndicatorStream<number, number>;
  private slow: IndicatorStream<number, number>;
  private signalMovingAverage: IndicatorStream<number, number>;
  private readonly fastType: MovingAverageType;
  private readonly slowType: MovingAverageType;
  private readonly signalType: MovingAverageType;
  constructor({
    fast,
    slow,
    signalMovingAverage,
    fastType,
    slowType,
    signalType,
  }: {
    fast: IndicatorStream<number, number>;
    slow: IndicatorStream<number, number>;
    signalMovingAverage: IndicatorStream<number, number>;
    fastType: MovingAverageType;
    slowType: MovingAverageType;
    signalType: MovingAverageType;
  }) {
    this.fast = fast;
    this.slow = slow;
    this.signalMovingAverage = signalMovingAverage;
    this.fastType = fastType;
    this.slowType = slowType;
    this.signalType = signalType;
  }
  next(value: number): MacdPoint | null {
    const f = this.fast.next(value);
    const s = this.slow.next(value);
    if (f === null || s === null) {
      this.value = null;
      return null;
    }
    const macdLine = f - s;
    const sig = this.signalMovingAverage.next(macdLine);
    if (sig === null) {
      this.value = null;
      return null;
    }
    this.value = { macd: macdLine, signal: sig, histogram: macdLine - sig };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('macdExt', {
      fastType: this.fastType,
      slowType: this.slowType,
      signalType: this.signalType,
      fast: this.fast.toJSON(),
      slow: this.slow.toJSON(),
      // Persisted snapshot KEY stays `signalMa` — see the note on AmatStream.toJSON in trend-ext.ts.
      signalMa: this.signalMovingAverage.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MacdExtStream {
    const state = readSnapshot(snapshot, 'macdExt');
    const x = new MacdExtStream({
      fast: restoreMovingAverage(state.child('fast')),
      slow: restoreMovingAverage(state.child('slow')),
      // Left key = constructor argument (renamed); quoted key = persisted state (deliberately not).
      signalMovingAverage: restoreMovingAverage(state.child('signalMa')),
      fastType: state.literal<MovingAverageType>('fastType', MOVING_AVERAGE_TYPES),
      slowType: state.literal<MovingAverageType>('slowType', MOVING_AVERAGE_TYPES),
      signalType: state.literal<MovingAverageType>('signalType', MOVING_AVERAGE_TYPES),
    });
    x.value = state.cached<MacdPoint>('value');
    return x;
  }
}

export const macdExt = withBuiltinMetadata(
  makeIndicator<MacdExtParameters, number, MacdPoint>(
    (p) => {
      const fastMovingAverageType = requireOneOf(
        p.fastMovingAverageType ?? 'ema',
        MOVING_AVERAGE_TYPES,
        'macdExt',
        'fastMovingAverageType',
      );
      const slowMovingAverageType = requireOneOf(
        p.slowMovingAverageType ?? 'ema',
        MOVING_AVERAGE_TYPES,
        'macdExt',
        'slowMovingAverageType',
      );
      const signalMovingAverageType = requireOneOf(
        p.signalMovingAverageType ?? 'ema',
        MOVING_AVERAGE_TYPES,
        'macdExt',
        'signalMovingAverageType',
      );
      return new MacdExtStream({
        fast: movingAverageStream(
          fastMovingAverageType,
          requirePeriod(p.fast ?? 12, 'macdExt', 'fast'),
        ),
        slow: movingAverageStream(
          slowMovingAverageType,
          requirePeriod(p.slow ?? 26, 'macdExt', 'slow'),
        ),
        signalMovingAverage: movingAverageStream(
          signalMovingAverageType,
          requirePeriod(p.signal ?? 9, 'macdExt', 'signal'),
        ),
        fastType: fastMovingAverageType,
        slowType: slowMovingAverageType,
        signalType: signalMovingAverageType,
      });
    },
    MacdExtStream.fromJSON,
    () => ({ macd: NaN, signal: NaN, histogram: NaN }),
  ),
  builtinMetadata.macdExtMetadata,
);

export interface MacdFixParameters {
  signal?: number;
}

/** MACDFIX — fixed 12/26 EMA MACD with a configurable signal period (TA-Lib MACDFIX). */
export const macdFix = withBuiltinMetadata(
  makeIndicator<MacdFixParameters, number, MacdPoint>(
    (p) =>
      new MacdExtStream({
        fast: new EmaStream(12),
        slow: new EmaStream(26),
        signalMovingAverage: new EmaStream(requirePeriod(p.signal ?? 9, 'macdFix', 'signal')),
        fastType: 'ema',
        slowType: 'ema',
        signalType: 'ema',
      }),
    MacdExtStream.fromJSON,
    () => ({ macd: NaN, signal: NaN, histogram: NaN }),
  ),
  builtinMetadata.macdFixMetadata,
);

export {
  RocStream,
  CmoStream,
  ApoStream,
  PpoStream,
  StochRsiStream,
  TrixStream,
  DpoStream,
  TsiStream,
  KstStream,
  ConnorsRsiStream,
  CciStream,
  WilliamsRStream,
  AwesomeStream,
  UltimateStream,
  FisherStream,
  MacdExtStream,
};
