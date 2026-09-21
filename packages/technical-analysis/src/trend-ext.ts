/**
 * Modern trend indicators & trend-following signal helpers (spec §13.3; pandas-ta parity).
 *
 * Choppiness Index, Chande Kroll Stop, Central Pivot Range, the decay lines, the
 * increasing/decreasing trend tests and their two-series long/short-run combinations, PMax
 * (MA-based Supertrend), Q Stick, TTM Trend, the Vertical Horizontal Filter, and the
 * `trendSignals`/`crossSignals` state machines that turn a trend/oscillator series into
 * entry/exit flags.
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
import {
  movingAverage,
  MOVING_AVERAGE_NAMES,
  type MovingAverageName,
  type Pair,
} from './statistics.js';
import {
  requireBooleanWhenPresent,
  requireFinite,
  requirePeriod,
  requirePositive,
} from './validate.js';

const nan = (): number => NaN;

function maxOf(xs: readonly number[]): number {
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! > m) m = xs[i]!;
  return m;
}
function minOf(xs: readonly number[]): number {
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! < m) m = xs[i]!;
  return m;
}

export interface PeriodParameters {
  period: number;
}

// ───────────────────────── Choppiness Index ─────────────────────────

class ChoppinessStream implements IndicatorStream<BarInput, number> {
  private tr: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private previousClose: number | null = null;
  private readonly logP: number;
  value: number | null = null;
  constructor(private readonly period: number) {
    this.logP = Math.log10(period);
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
    this.tr.push(tr);
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.tr.length > this.period) {
      this.tr.shift();
      this.highs.shift();
      this.lows.shift();
    }
    if (this.tr.length < this.period) {
      this.value = null;
      return null;
    }
    let sumTr = 0;
    for (const t of this.tr) sumTr += t;
    const range = maxOf(this.highs) - minOf(this.lows);
    this.value = range <= 0 || sumTr <= 0 ? 0 : (100 * Math.log10(sumTr / range)) / this.logP;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('choppinessIndex', {
      period: this.period,
      tr: [...this.tr],
      highs: [...this.highs],
      lows: [...this.lows],
      previousClose: this.previousClose,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ChoppinessStream {
    const state = readSnapshot(snapshot, 'choppinessIndex');
    const x = new ChoppinessStream(state.lookback('period'));
    x.tr = state.numbers('tr');
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.previousClose = state.numberOrNull('previousClose');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const choppinessIndex = makeIndicator<{ period?: number }, BarInput, number>(
  (p) => new ChoppinessStream(requirePeriod(p.period ?? 14, 'choppinessIndex', 'period', 2)),
  ChoppinessStream.fromJSON,
  nan,
);

// ───────────────────────── Chande Kroll Stop ─────────────────────────

export interface ChandeKrollStopParameters {
  /** ATR length + first-stage high/low lookback (TA `p`). Default 10. */
  atrPeriod?: number;
  /** ATR multiplier (TA `x`). Default 1. */
  multiplier?: number;
  /** Second-stage stop lookback (TA `q`). Default 9. */
  period?: number;
}
export interface ChandeKrollStopPoint {
  /** Long stop — highest first-stage high-stop over the lookback (trails above price). */
  long: number;
  /** Short stop — lowest first-stage low-stop over the lookback (trails below price). */
  short: number;
}

class ChandeKrollStopStream implements IndicatorStream<BarInput, ChandeKrollStopPoint> {
  private atr: AtrStream;
  private highs: number[] = [];
  private lows: number[] = [];
  private highStops: number[] = [];
  private lowStops: number[] = [];
  value: ChandeKrollStopPoint | null = null;
  private readonly atrPeriod: number;
  private readonly mult: number;
  private readonly period: number;
  constructor({ atrPeriod, mult, period }: { atrPeriod: number; mult: number; period: number }) {
    this.atrPeriod = atrPeriod;
    this.mult = mult;
    this.period = period;

    this.atr = new AtrStream(atrPeriod);
  }
  next(bar: BarInput): ChandeKrollStopPoint | null {
    const atr = this.atr.next(bar);
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.highs.length > this.atrPeriod) {
      this.highs.shift();
      this.lows.shift();
    }
    if (atr === null || this.highs.length < this.atrPeriod) {
      this.value = null;
      return null;
    }
    const highStop = maxOf(this.highs) - this.mult * atr;
    const lowStop = minOf(this.lows) + this.mult * atr;
    this.highStops.push(highStop);
    this.lowStops.push(lowStop);
    if (this.highStops.length > this.period) {
      this.highStops.shift();
      this.lowStops.shift();
    }
    if (this.highStops.length < this.period) {
      this.value = null;
      return null;
    }
    this.value = { long: maxOf(this.highStops), short: minOf(this.lowStops) };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('chandeKrollStop', {
      atrPeriod: this.atrPeriod,
      mult: this.mult,
      period: this.period,
      atr: this.atr.toJSON(),
      highs: [...this.highs],
      lows: [...this.lows],
      highStops: [...this.highStops],
      lowStops: [...this.lowStops],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ChandeKrollStopStream {
    const state = readSnapshot(snapshot, 'chandeKrollStop');
    const x = new ChandeKrollStopStream({
      atrPeriod: state.lookback('atrPeriod'),
      mult: state.number('mult'),
      period: state.lookback('period'),
    });
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.highStops = state.numbers('highStops');
    x.lowStops = state.numbers('lowStops');
    x.value = state.cached<ChandeKrollStopPoint>('value');
    return x;
  }
}

export const chandeKrollStop = makeIndicator<
  ChandeKrollStopParameters,
  BarInput,
  ChandeKrollStopPoint
>(
  (p) =>
    new ChandeKrollStopStream({
      atrPeriod: requirePeriod(p.atrPeriod ?? 10, 'chandeKrollStop', 'atrPeriod'),
      mult: requirePositive(p.multiplier ?? 1, 'chandeKrollStop', 'multiplier'),
      period: requirePeriod(p.period ?? 9, 'chandeKrollStop', 'period'),
    }),
  ChandeKrollStopStream.fromJSON,
  () => ({ long: NaN, short: NaN }),
);

// ───────────────────────── Central Pivot Range ─────────────────────────

export interface CprPoint {
  /** Pivot = (H + L + C) / 3 of the prior bar. */
  pivot: number;
  /** Top central = 2·pivot − bottomCentral. */
  topCentral: number;
  /** Bottom central = (H + L) / 2 of the prior bar. */
  bottomCentral: number;
}

class CentralPivotRangeStream implements IndicatorStream<BarInput, CprPoint> {
  private prev: BarInput | null = null;
  value: CprPoint | null = null;
  next(bar: BarInput): CprPoint | null {
    const prior = this.prev;
    this.prev = bar;
    if (prior === null) {
      this.value = null;
      return null;
    }
    const pivot = (prior.high + prior.low + prior.close) / 3;
    const bottomCentral = (prior.high + prior.low) / 2;
    const topCentral = 2 * pivot - bottomCentral;
    this.value = { pivot, topCentral, bottomCentral };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('centralPivotRange', { prev: this.prev, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CentralPivotRangeStream {
    const state = readSnapshot(snapshot, 'centralPivotRange');
    const x = new CentralPivotRangeStream();
    x.prev = state.recordOrNull<BarInput>('prev');
    x.value = state.cached<CprPoint>('value');
    return x;
  }
}

export const centralPivotRange = makeIndicator<Record<string, never>, BarInput, CprPoint>(
  () => new CentralPivotRangeStream(),
  CentralPivotRangeStream.fromJSON,
  () => ({ pivot: NaN, topCentral: NaN, bottomCentral: NaN }),
);

// ───────────────────────── decay lines ─────────────────────────

class DecayStream implements IndicatorStream<number, number> {
  private previousClose: number | null = null;
  value: number | null = null;
  constructor(
    private readonly kind: string,
    private readonly step: number,
  ) {}
  next(close: number): number | null {
    const prev = this.previousClose;
    this.previousClose = close;
    this.value = prev === null ? close : Math.max(close, prev - this.step);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, {
      step: this.step,
      previousClose: this.previousClose,
      value: this.value,
    });
  }
  static restore(kind: string) {
    return (s: TechnicalAnalysisSnapshot): DecayStream => {
      const state = readSnapshot(s, kind);
      const x = new DecayStream(kind, state.number('step'));
      x.previousClose = state.numberOrNull('previousClose');
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

/** Linear decay floor — the series may rise freely but falls no faster than `1/period` per bar. */
export const linearDecay = makeIndicator<{ period?: number }, number, number>(
  (p) => new DecayStream('linearDecay', 1 / requirePeriod(p.period ?? 5, 'linearDecay')),
  DecayStream.restore('linearDecay'),
  nan,
);
/** Exponential decay floor — same shape, with an `exp(−period)` step (decays far more slowly). */
export const exponentialDecay = makeIndicator<{ period?: number }, number, number>(
  (p) =>
    new DecayStream(
      'exponentialDecay',
      Math.exp(-requirePeriod(p.period ?? 5, 'exponentialDecay')),
    ),
  DecayStream.restore('exponentialDecay'),
  nan,
);

// ───────────────────────── increasing / decreasing ─────────────────────────

export interface TrendTestParameters {
  /** Lookback (compare against the value `period` bars ago). Default 1. */
  period?: number;
  /** Require every step in the window to move the same way (default false → just endpoints). */
  strict?: boolean;
}

class TrendTestStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  constructor(
    private readonly kind: string,
    private readonly period: number,
    private readonly strict: boolean,
    private readonly up: boolean,
  ) {}
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period + 1) this.buf.shift();
    if (this.buf.length < this.period + 1) {
      this.value = null;
      return null;
    }
    let ok: boolean;
    if (this.strict) {
      ok = true;
      for (let i = 1; i < this.buf.length; i++) {
        if (this.up ? !(this.buf[i]! > this.buf[i - 1]!) : !(this.buf[i]! < this.buf[i - 1]!)) {
          ok = false;
          break;
        }
      }
    } else {
      const first = this.buf[0]!;
      const last = this.buf[this.buf.length - 1]!;
      ok = this.up ? last > first : last < first;
    }
    this.value = ok ? 1 : 0;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, {
      period: this.period,
      strict: this.strict,
      up: this.up,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static restore(kind: string) {
    return (s: TechnicalAnalysisSnapshot): TrendTestStream => {
      const state = readSnapshot(s, kind);
      const x = new TrendTestStream(
        kind,
        state.lookback('period'),
        state.boolean('strict'),
        state.boolean('up'),
      );
      x.buf = state.numbers('buf');
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

/** 1 when the series is higher than `period` bars ago (strict → every step rose). */
export const increasing = makeIndicator<TrendTestParameters, number, number>(
  (p) =>
    new TrendTestStream(
      'increasing',
      requirePeriod(p.period ?? 1, 'increasing'),
      requireBooleanWhenPresent(p.strict, 'increasing', 'strict') ?? false,
      true,
    ),
  TrendTestStream.restore('increasing'),
  nan,
  { period: 1, strict: false },
);
/** 1 when the series is lower than `period` bars ago (strict → every step fell). */
export const decreasing = makeIndicator<TrendTestParameters, number, number>(
  (p) =>
    new TrendTestStream(
      'decreasing',
      requirePeriod(p.period ?? 1, 'decreasing'),
      requireBooleanWhenPresent(p.strict, 'decreasing', 'strict') ?? false,
      false,
    ),
  TrendTestStream.restore('decreasing'),
  nan,
  { period: 1, strict: false },
);

// ───────────────────────── long-run / short-run (two-series) ─────────────────────────

class RunStream implements IndicatorStream<Pair, number> {
  private xs: number[] = [];
  private ys: number[] = [];
  value: number | null = null;
  constructor(
    private readonly kind: string,
    private readonly period: number,
    private readonly up: boolean,
  ) {}
  next(pair: Pair): number | null {
    this.xs.push(pair.x);
    this.ys.push(pair.y);
    if (this.xs.length > this.period + 1) {
      this.xs.shift();
      this.ys.shift();
    }
    if (this.xs.length < this.period + 1) {
      this.value = null;
      return null;
    }
    const xMove = this.up
      ? this.xs[this.xs.length - 1]! > this.xs[0]!
      : this.xs[this.xs.length - 1]! < this.xs[0]!;
    const yMove = this.up
      ? this.ys[this.ys.length - 1]! > this.ys[0]!
      : this.ys[this.ys.length - 1]! < this.ys[0]!;
    this.value = xMove && yMove ? 1 : 0;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, {
      period: this.period,
      up: this.up,
      xs: [...this.xs],
      ys: [...this.ys],
      value: this.value,
    });
  }
  static restore(kind: string) {
    return (s: TechnicalAnalysisSnapshot): RunStream => {
      const state = readSnapshot(s, kind);
      const x = new RunStream(kind, state.lookback('period'), state.boolean('up'));
      x.xs = state.numbers('xs');
      x.ys = state.numbers('ys');
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

/** 1 when fast (`x`) and slow (`y`) are both rising over the lookback — a confirmed up-run. */
export const longRun = makeIndicator<{ period?: number }, Pair, number>(
  (p) => new RunStream('longRun', requirePeriod(p.period ?? 2, 'longRun'), true),
  RunStream.restore('longRun'),
  nan,
);
/** 1 when fast (`x`) and slow (`y`) are both falling over the lookback — a confirmed down-run. */
export const shortRun = makeIndicator<{ period?: number }, Pair, number>(
  (p) => new RunStream('shortRun', requirePeriod(p.period ?? 2, 'shortRun'), false),
  RunStream.restore('shortRun'),
  nan,
);

// ───────────────────────── Archer Moving Averages Trends ─────────────────────────

export interface AmatParameters {
  fast?: number;
  slow?: number;
  lookback?: number;
  movingAverageType?: MovingAverageName;
}
export interface AmatPoint {
  long: number;
  short: number;
}

class AmatStream implements IndicatorStream<number, AmatPoint> {
  private fastMa: IndicatorStream<number, number>;
  private slowMa: IndicatorStream<number, number>;
  private longRunStream: IndicatorStream<Pair, number>;
  private shortRunStream: IndicatorStream<Pair, number>;
  value: AmatPoint | null = null;
  private readonly fast: number;
  private readonly slow: number;
  private readonly lookback: number;
  private readonly movingAverageType: MovingAverageName;
  constructor({
    fast,
    slow,
    lookback,
    movingAverageType,
  }: {
    fast: number;
    slow: number;
    lookback: number;
    movingAverageType: MovingAverageName;
  }) {
    this.fast = fast;
    this.slow = slow;
    this.lookback = lookback;
    this.movingAverageType = movingAverageType;

    this.fastMa = movingAverage.stream({ period: fast, movingAverageType });
    this.slowMa = movingAverage.stream({ period: slow, movingAverageType });
    this.longRunStream = longRun.stream({ period: lookback });
    this.shortRunStream = shortRun.stream({ period: lookback });
  }
  next(value: number): AmatPoint | null {
    const fast = this.fastMa.next(value);
    const slow = this.slowMa.next(value);
    if (fast === null || slow === null) {
      this.value = null;
      return null;
    }
    const pair = { x: fast, y: slow };
    const long = this.longRunStream.next(pair);
    const short = this.shortRunStream.next(pair);
    if (long === null || short === null) {
      this.value = null;
      return null;
    }
    this.value = { long, short };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('amat', {
      fast: this.fast,
      slow: this.slow,
      lookback: this.lookback,
      // Persisted snapshot KEY, deliberately still `maType`. The envelope's `kind` is public and
      // moved with the rename; the `state` interior is declared opaque in OPAQUE_STATE_ENVELOPES —
      // consumers round-trip it without branching on keys — so renaming it would invalidate every
      // stored snapshot (SCHEMA_VERSION is global, spec D5 does not migrate) for no naming gain.
      maType: this.movingAverageType,
      fastMa: this.fastMa.toJSON(),
      slowMa: this.slowMa.toJSON(),
      longRun: this.longRunStream.toJSON(),
      shortRun: this.shortRunStream.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AmatStream {
    const state = readSnapshot(snapshot, 'amat');
    const x = new AmatStream({
      fast: state.lookback('fast'),
      slow: state.lookback('slow'),
      lookback: state.lookback('lookback'),
      // Left key = constructor argument (renamed); quoted key = persisted state (deliberately not).
      movingAverageType: state.literal<MovingAverageName>('maType', MOVING_AVERAGE_NAMES),
    });
    x.fastMa = movingAverage.fromJSON(state.child('fastMa'));
    x.slowMa = movingAverage.fromJSON(state.child('slowMa'));
    x.longRunStream = longRun.fromJSON(state.child('longRun'));
    x.shortRunStream = shortRun.fromJSON(state.child('shortRun'));
    x.value = state.cached<AmatPoint>('value');
    return x;
  }
}

/** Archer Moving Averages Trends (pandas-ta `amat`). */
export const amat = makeIndicator<AmatParameters, number, AmatPoint>(
  (p) =>
    new AmatStream({
      fast: requirePeriod(p.fast ?? 8, 'amat', 'fast'),
      slow: requirePeriod(p.slow ?? 21, 'amat', 'slow'),
      lookback: requirePeriod(p.lookback ?? 2, 'amat', 'lookback'),
      movingAverageType: p.movingAverageType ?? 'ema',
    }),
  AmatStream.fromJSON,
  () => ({ long: NaN, short: NaN }),
);

// ───────────────────────── PMax (MA-based Supertrend) ─────────────────────────

export interface PmaxParameters {
  period?: number;
  multiplier?: number;
}
export interface PmaxPoint {
  /** The trailing stop line. */
  pmax: number;
  /** +1 long (MA above the stop), −1 short. */
  trend: number;
}

class PmaxStream implements IndicatorStream<BarInput, PmaxPoint> {
  private ema: EmaStream;
  private atr: AtrStream;
  private longStop = 0;
  private shortStop = 0;
  private dir = 1;
  private prevMa: number | null = null;
  private started = false;
  value: PmaxPoint | null = null;
  constructor(
    period: number,
    private readonly mult: number,
  ) {
    this.ema = new EmaStream(period);
    this.atr = new AtrStream(period);
  }
  next(bar: BarInput): PmaxPoint | null {
    const ma = this.ema.next(bar.close);
    const atr = this.atr.next(bar);
    if (ma === null || atr === null) {
      this.value = null;
      return null;
    }
    if (!this.started) {
      this.longStop = ma - this.mult * atr;
      this.shortStop = ma + this.mult * atr;
      this.dir = bar.close >= ma ? 1 : -1;
      this.prevMa = ma;
      this.started = true;
      this.value = { pmax: this.dir === 1 ? this.longStop : this.shortStop, trend: this.dir };
      return this.value;
    }
    const prevLong = this.longStop;
    const prevShort = this.shortStop;
    const prevMa = this.prevMa!;
    let ls = ma - this.mult * atr;
    if (prevMa > prevLong) ls = Math.max(ls, prevLong);
    let ss = ma + this.mult * atr;
    if (prevMa < prevShort) ss = Math.min(ss, prevShort);
    let dir = this.dir;
    if (dir === 1 && ma < prevLong) dir = -1;
    else if (dir === -1 && ma > prevShort) dir = 1;
    this.longStop = ls;
    this.shortStop = ss;
    this.dir = dir;
    this.prevMa = ma;
    this.value = { pmax: dir === 1 ? ls : ss, trend: dir };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('pMax', {
      mult: this.mult,
      ema: this.ema.toJSON(),
      atr: this.atr.toJSON(),
      longStop: this.longStop,
      shortStop: this.shortStop,
      dir: this.dir,
      prevMa: this.prevMa,
      started: this.started,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PmaxStream {
    const state = readSnapshot(snapshot, 'pMax');
    const x = new PmaxStream(1, state.number('mult'));
    x.ema = EmaStream.fromJSON(state.child('ema'));
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.longStop = state.number('longStop');
    x.shortStop = state.number('shortStop');
    x.dir = state.number('dir');
    x.prevMa = state.numberOrNull('prevMa');
    x.started = state.boolean('started');
    x.value = state.cached<PmaxPoint>('value');
    return x;
  }
}

export const pMax = makeIndicator<PmaxParameters, BarInput, PmaxPoint>(
  (p) =>
    new PmaxStream(
      requirePeriod(p.period ?? 10, 'pMax'),
      requirePositive(p.multiplier ?? 3, 'pMax', 'multiplier'),
    ),
  PmaxStream.fromJSON,
  () => ({ pmax: NaN, trend: NaN }),
);

// ───────────────────────── Q Stick ─────────────────────────

class QstickStream implements IndicatorStream<BarInput, number> {
  private sma: SmaStream;
  value: number | null = null;
  constructor(period: number) {
    this.sma = new SmaStream(period);
  }
  next(bar: BarInput): number | null {
    this.value = this.sma.next(bar.close - (bar.open ?? bar.close));
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('qstick', { sma: this.sma.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): QstickStream {
    const state = readSnapshot(snapshot, 'qstick');
    const x = new QstickStream(1);
    x.sma = SmaStream.fromJSON(state.child('sma'));
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Q Stick — SMA of (close − open); positive = bullish bodies dominate. */
export const qstick = makeIndicator<{ period?: number }, BarInput, number>(
  (p) => new QstickStream(requirePeriod(p.period ?? 10, 'qstick')),
  QstickStream.fromJSON,
  nan,
);

// ───────────────────────── TTM Trend ─────────────────────────

class TtmTrendStream implements IndicatorStream<BarInput, number> {
  private sma: SmaStream;
  value: number | null = null;
  constructor(period: number) {
    this.sma = new SmaStream(period);
  }
  next(bar: BarInput): number | null {
    const avg = this.sma.next((bar.high + bar.low) / 2);
    if (avg === null) {
      this.value = null;
      return null;
    }
    this.value = bar.close > avg ? 1 : -1;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('ttmTrend', { sma: this.sma.toJSON(), value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TtmTrendStream {
    const state = readSnapshot(snapshot, 'ttmTrend');
    const x = new TtmTrendStream(1);
    x.sma = SmaStream.fromJSON(state.child('sma'));
    x.value = state.cached<number>('value');
    return x;
  }
}

/** TTM Trend — +1 when close is above the SMA of HL2 over the lookback, −1 otherwise. */
export const ttmTrend = makeIndicator<{ period?: number }, BarInput, number>(
  (p) => new TtmTrendStream(requirePeriod(p.period ?? 6, 'ttmTrend')),
  TtmTrendStream.fromJSON,
  nan,
);

// ───────────────────────── Vertical Horizontal Filter ─────────────────────────

class VhfStream implements IndicatorStream<number, number> {
  private closes: number[] = [];
  private diffs: number[] = [];
  private previousClose: number | null = null;
  value: number | null = null;
  constructor(private readonly period: number) {}
  next(close: number): number | null {
    if (this.previousClose !== null) {
      this.diffs.push(Math.abs(close - this.previousClose));
      if (this.diffs.length > this.period) this.diffs.shift();
    }
    this.previousClose = close;
    this.closes.push(close);
    if (this.closes.length > this.period) this.closes.shift();
    if (this.closes.length < this.period || this.diffs.length < this.period) {
      this.value = null;
      return null;
    }
    const num = maxOf(this.closes) - minOf(this.closes);
    let denom = 0;
    for (const d of this.diffs) denom += d;
    this.value = denom === 0 ? 0 : num / denom;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('verticalHorizontalFilter', {
      period: this.period,
      closes: [...this.closes],
      diffs: [...this.diffs],
      previousClose: this.previousClose,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VhfStream {
    const state = readSnapshot(snapshot, 'verticalHorizontalFilter');
    const x = new VhfStream(state.lookback('period'));
    x.closes = state.numbers('closes');
    x.diffs = state.numbers('diffs');
    x.previousClose = state.numberOrNull('previousClose');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Vertical Horizontal Filter — trend strength = range / summed absolute change. */
export const verticalHorizontalFilter = makeIndicator<{ period?: number }, number, number>(
  (p) => new VhfStream(requirePeriod(p.period ?? 28, 'verticalHorizontalFilter')),
  VhfStream.fromJSON,
  nan,
);

// ───────────────────────── trend / cross signal state machines ─────────────────────────

export interface TrendSignalPoint {
  /** Current position state: 1 in-trend / 0 flat. */
  trend: number;
  /** 1 on the bar a position is opened. */
  entry: number;
  /** 1 on the bar a position is closed. */
  exit: number;
}

class TrendSignalsStream implements IndicatorStream<number, TrendSignalPoint> {
  private prevTrend = 0;
  value: TrendSignalPoint | null = null;
  next(value: number): TrendSignalPoint | null {
    const trend = value > 0 ? 1 : 0;
    const entry = trend === 1 && this.prevTrend === 0 ? 1 : 0;
    const exit = trend === 0 && this.prevTrend === 1 ? 1 : 0;
    this.prevTrend = trend;
    this.value = { trend, entry, exit };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('trendSignals', { prevTrend: this.prevTrend, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TrendSignalsStream {
    const state = readSnapshot(snapshot, 'trendSignals');
    const x = new TrendSignalsStream();
    x.prevTrend = state.number('prevTrend');
    x.value = state.cached<TrendSignalPoint>('value');
    return x;
  }
}

/** Turn a trend series (>0 ⇒ in-trend) into trend/entry/exit flags. */
export const trendSignals = makeIndicator<Record<string, never>, number, TrendSignalPoint>(
  () => new TrendSignalsStream(),
  TrendSignalsStream.fromJSON,
  () => ({ trend: NaN, entry: NaN, exit: NaN }),
);

export interface CrossSignalParameters {
  /** Enter long when the series crosses up through this level. Default 0. */
  above?: number;
  /** Exit when the series crosses down through this level. Default 0. */
  below?: number;
}

class CrossSignalsStream implements IndicatorStream<number, TrendSignalPoint> {
  private prev: number | null = null;
  private pos = 0;
  value: TrendSignalPoint | null = null;
  constructor(
    private readonly above: number,
    private readonly below: number,
  ) {}
  next(value: number): TrendSignalPoint | null {
    const prev = this.prev;
    this.prev = value;
    if (prev === null) {
      this.value = null;
      return null;
    }
    const crossUp = prev <= this.above && value > this.above;
    const crossDown = prev >= this.below && value < this.below;
    let entry = 0;
    let exit = 0;
    if (this.pos === 0 && crossUp) {
      this.pos = 1;
      entry = 1;
    } else if (this.pos === 1 && crossDown) {
      this.pos = 0;
      exit = 1;
    }
    this.value = { trend: this.pos, entry, exit };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('crossSignals', {
      above: this.above,
      below: this.below,
      prev: this.prev,
      pos: this.pos,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CrossSignalsStream {
    const state = readSnapshot(snapshot, 'crossSignals');
    const x = new CrossSignalsStream(state.number('above'), state.number('below'));
    x.prev = state.numberOrNull('prev');
    x.pos = state.number('pos');
    x.value = state.cached<TrendSignalPoint>('value');
    return x;
  }
}

/** Cross-based long/flat state machine: enter when the series crosses above `above`, exit below `below`. */
export const crossSignals = makeIndicator<CrossSignalParameters, number, TrendSignalPoint>(
  (p) =>
    new CrossSignalsStream(
      requireFinite(p.above ?? 0, 'crossSignals', 'above'),
      requireFinite(p.below ?? 0, 'crossSignals', 'below'),
    ),
  CrossSignalsStream.fromJSON,
  () => ({ trend: NaN, entry: NaN, exit: NaN }),
);
