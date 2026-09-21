/**
 * Overlap, statistic, and operator functions (spec §13.3; TA-Lib parity).
 *
 * `movingAverage` (MA-type dispatcher), `mavp` (variable-period MA), `midpoint`, `midprice`, `bop`, `stochFast`,
 * `beta` / `correl` (paired-series), and the rolling operators (`rollingMin/Max/Sum` and their
 * bars-ago index variants). All but `mavp` are aligned batch+stream facades; `mavp` is a batch
 * function because its period varies per bar.
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
import {
  DemaStream,
  EmaStream,
  HmaStream,
  KamaStream,
  RmaStream,
  SmaStream,
  T3Stream,
  TemaStream,
  TrimaStream,
  WmaStream,
  ZlemaStream,
} from './moving-averages.js';
import {
  requireAtMost,
  requireFinite,
  requireOneOf,
  requirePeriod,
  requireSameLength,
} from './validate.js';
import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import { requireStreamParameters } from './stream-validation.js';

type Empty = Record<never, never>;
const nan = (): number => NaN;

export interface PeriodParameters {
  period: number;
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

// ───────────────────────── movingAverage — MA-type dispatcher ─────────────────────────

export type MovingAverageName =
  | 'sma'
  | 'ema'
  | 'wma'
  | 'rma'
  | 'dema'
  | 'tema'
  | 'trima'
  | 'kama'
  | 't3'
  | 'hma'
  | 'zlema';
export const MOVING_AVERAGE_NAMES: readonly MovingAverageName[] = [
  'sma',
  'ema',
  'wma',
  'rma',
  'dema',
  'tema',
  'trima',
  'kama',
  't3',
  'hma',
  'zlema',
];

export interface MovingAverageParameters {
  period: number;
  movingAverageType?: MovingAverageName;
}

function movingAverageStreamByName(
  name: MovingAverageName,
  period: number,
): IndicatorStream<number, number> {
  switch (name) {
    case 'sma':
      return new SmaStream(period);
    case 'ema':
      return new EmaStream(period);
    case 'wma':
      return new WmaStream(period);
    case 'rma':
      return new RmaStream(period);
    case 'dema':
      return new DemaStream(period);
    case 'tema':
      return new TemaStream(period);
    case 'trima':
      return new TrimaStream(period);
    case 'kama':
      return new KamaStream({ period, fast: 2, slow: 30 });
    case 't3':
      return new T3Stream({ period, volumeFactor: 0.7 });
    case 'hma':
      return new HmaStream(period);
    case 'zlema':
      return new ZlemaStream(period);
  }
}

function restoreMovingAverageByKind(s: TechnicalAnalysisSnapshot): IndicatorStream<number, number> {
  switch (s.kind) {
    case 'sma':
      return SmaStream.fromJSON(s);
    case 'ema':
      return EmaStream.fromJSON(s);
    case 'wma':
      return WmaStream.fromJSON(s);
    case 'rma':
      return RmaStream.fromJSON(s);
    case 'dema':
      return DemaStream.fromJSON(s);
    case 'tema':
      return TemaStream.fromJSON(s);
    case 'trima':
      return TrimaStream.fromJSON(s);
    case 'kama':
      return KamaStream.fromJSON(s);
    case 't3':
      return T3Stream.fromJSON(s);
    case 'hma':
      return HmaStream.fromJSON(s);
    case 'zlema':
      return ZlemaStream.fromJSON(s);
    default:
      throw new InputError(
        `movingAverage.fromJSON: unknown moving-average snapshot kind "${String(s.kind)}".`,
        { code: ErrorCode.SnapshotUnknownKind, context: { kind: s.kind } },
      );
  }
}

export const movingAverage = withBuiltinMetadata(
  makeIndicator<MovingAverageParameters, number, number>(
    (p) =>
      movingAverageStreamByName(
        requireOneOf(
          p.movingAverageType ?? 'sma',
          MOVING_AVERAGE_NAMES,
          'movingAverage',
          'movingAverageType',
        ),
        requirePeriod(p.period, 'movingAverage'),
      ),
    restoreMovingAverageByKind,
    nan,
  ),
  builtinMetadata.movingAverageMetadata,
);

/**
 * Variable-period MA (TA-Lib MAVP): the period for bar `i` comes from `periods[i]`, clamped to
 * `[minPeriod, maxPeriod]` and rounded. Batch only — the per-bar period makes a single streaming state
 * ill-defined. Computes each distinct period's MA once, then selects per bar.
 */
export interface MavpParameters {
  minPeriod?: number;
  maxPeriod?: number;
  movingAverageType?: MovingAverageName;
}
const MAVP_KEYS = ['minPeriod', 'maxPeriod', 'movingAverageType'] as const;
export interface MavpInput {
  series: ArrayLike<number>;
  periods: ArrayLike<number>;
  parameters?: MavpParameters;
}

export function mavp(input: MavpInput): number[] {
  requireArgumentObject('mavp', 'input', input);
  ensureKnownKeys('mavp', 'input', input, ['series', 'periods', 'parameters']);
  const { series, periods, parameters = {} } = input;
  requireArgumentArray('mavp', 'periods', periods);
  requireArgumentArray('mavp', 'series', series);
  requireArgumentObject('mavp', 'parameters', parameters);
  // Law 12: an unknown param (a `maxperiod` typo) teaches instead of being silently ignored.
  ensureKnownKeys('mavp', 'parameters', parameters, MAVP_KEYS);
  for (const field of ['minPeriod', 'maxPeriod', 'movingAverageType'] as const) {
    if ((parameters as Record<string, unknown>)[field] === null) {
      throw new InputError(
        `mavp: parameters.${field} must not be null — omit the field to use the default. Received null.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
  const lo = requirePeriod(parameters.minPeriod ?? 2, 'mavp', 'minPeriod');
  const hi = requirePeriod(parameters.maxPeriod ?? 30, 'mavp', 'maxPeriod');
  requireAtMost(lo, hi, 'mavp', 'minPeriod', 'maxPeriod');
  const movingAverageType = requireOneOf(
    parameters.movingAverageType ?? 'sma',
    MOVING_AVERAGE_NAMES,
    'mavp',
    'movingAverageType',
  );
  const arr = Array.from(series);
  requireSameLength(periods.length, arr.length, 'mavp', 'periods', 'series');
  const clamped = Array.from(periods, (p, i) => {
    requireFinite(p, 'mavp', `periods[${i}]`);
    return Math.min(hi, Math.max(lo, Math.round(p)));
  });
  const cache = new Map<number, number[]>();
  const out = new Array<number>(arr.length).fill(NaN);
  for (let i = 0; i < arr.length; i++) {
    const period = clamped[i]!;
    let col = cache.get(period);
    if (!col) {
      col = movingAverage(arr, { period, movingAverageType });
      cache.set(period, col);
    }
    out[i] = col[i]!;
  }
  return out;
}

// ───────────────────────── midpoint / midprice ─────────────────────────

class MidpointStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'MidpointStream');
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    this.value = (maxOf(this.buf) + minOf(this.buf)) / 2;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('midpoint', { period: this.period, buf: [...this.buf], value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MidpointStream {
    const state = readSnapshot(snapshot, 'midpoint');
    const x = new MidpointStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const midpoint = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, number>(
    (p) => new MidpointStream(requirePeriod(p.period, 'midpoint')),
    MidpointStream.fromJSON,
    nan,
  ),
  builtinMetadata.midpointMetadata,
);

class MidpriceStream implements IndicatorStream<BarInput, number> {
  private highs: number[] = [];
  private lows: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'MidpriceStream', 'period', 1, 'bars');
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
    this.value = (maxOf(this.highs) + minOf(this.lows)) / 2;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('midprice', {
      period: this.period,
      highs: [...this.highs],
      lows: [...this.lows],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MidpriceStream {
    const state = readSnapshot(snapshot, 'midprice');
    const x = new MidpriceStream(state.lookback('period'));
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const midprice = withBuiltinMetadata(
  makeIndicator<PeriodParameters, BarInput, number>(
    (p) => new MidpriceStream(requirePeriod(p.period, 'midprice', 'period', 1, 'bars')),
    MidpriceStream.fromJSON,
    nan,
  ),
  builtinMetadata.midpriceMetadata,
);

// ───────────────────────── bop — balance of power ─────────────────────────

class BopStream implements IndicatorStream<BarInput, number> {
  value: number | null = null;
  next(bar: BarInput): number | null {
    const range = bar.high - bar.low;
    const open = bar.open ?? bar.close;
    this.value = range === 0 ? 0 : (bar.close - open) / range;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('bop', { value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): BopStream {
    const state = readSnapshot(snapshot, 'bop');
    const x = new BopStream();
    x.value = state.cached<number>('value');
    return x;
  }
}

export const bop = withBuiltinMetadata(
  makeIndicator<Empty, BarInput, number>(() => new BopStream(), BopStream.fromJSON, nan),
  builtinMetadata.bopMetadata,
);

// ───────────────────────── stochFast ─────────────────────────

// A true alias of `stochastic` (one implementation): with the default `smoothK: 1` the stochastic
// IS the fast stochastic. Registered under both names; see `bars.ts`.
export { stochFast } from './bars.js';

// ───────────────────────── beta / correl (paired input) ─────────────────────────

export interface Pair {
  x: number;
  y: number;
}

class BetaStream implements IndicatorStream<Pair, number> {
  private prev: Pair | null = null;
  private rx: number[] = [];
  private ry: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'BetaStream', 'period', 1, 'pair');
  }
  next(pair: Pair): number | null {
    if (this.prev === null || this.prev.x === 0 || this.prev.y === 0) {
      this.prev = pair;
      this.value = null;
      return null;
    }
    this.rx.push((pair.x - this.prev.x) / this.prev.x);
    this.ry.push((pair.y - this.prev.y) / this.prev.y);
    this.prev = pair;
    if (this.rx.length > this.period) {
      this.rx.shift();
      this.ry.shift();
    }
    if (this.rx.length < this.period) {
      this.value = null;
      return null;
    }
    const n = this.period;
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sx += this.rx[i]!;
      sy += this.ry[i]!;
      sxy += this.rx[i]! * this.ry[i]!;
      syy += this.ry[i]! * this.ry[i]!;
    }
    const covariance = sxy / n - (sx / n) * (sy / n);
    const varY = syy / n - (sy / n) * (sy / n);
    this.value = varY === 0 ? 0 : covariance / varY;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('beta', {
      period: this.period,
      prev: this.prev,
      rx: [...this.rx],
      ry: [...this.ry],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): BetaStream {
    const state = readSnapshot(snapshot, 'beta');
    const x = new BetaStream(state.lookback('period'));
    x.prev = state.recordOrNull<Pair>('prev');
    x.rx = state.numbers('rx');
    x.ry = state.numbers('ry');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const beta = withBuiltinMetadata(
  makeIndicator<PeriodParameters, Pair, number>(
    (p) => new BetaStream(requirePeriod(p.period, 'beta', 'period', 1, 'pair')),
    BetaStream.fromJSON,
    nan,
  ),
  builtinMetadata.betaMetadata,
);

class CorrelStream implements IndicatorStream<Pair, number> {
  private xs: number[] = [];
  private ys: number[] = [];
  value: number | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'CorrelStream', 'period', 1, 'pair');
  }
  next(pair: Pair): number | null {
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
    const n = this.period;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += this.xs[i]!;
      sy += this.ys[i]!;
      sxx += this.xs[i]! * this.xs[i]!;
      syy += this.ys[i]! * this.ys[i]!;
      sxy += this.xs[i]! * this.ys[i]!;
    }
    const denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    this.value = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('correl', {
      period: this.period,
      xs: [...this.xs],
      ys: [...this.ys],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CorrelStream {
    const state = readSnapshot(snapshot, 'correl');
    const x = new CorrelStream(state.lookback('period'));
    x.xs = state.numbers('xs');
    x.ys = state.numbers('ys');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const correl = withBuiltinMetadata(
  makeIndicator<PeriodParameters, Pair, number>(
    (p) => new CorrelStream(requirePeriod(p.period, 'correl', 'period', 1, 'pair')),
    CorrelStream.fromJSON,
    nan,
  ),
  builtinMetadata.correlMetadata,
);

/** Zip two equal-length series into the `Pair[]` that `beta` / `correl` consume. Throws on a length
 *  mismatch — silent truncation would mask a benchmark/asset alignment bug. */
export function pairs(x: ArrayLike<number>, y: ArrayLike<number>): Pair[] {
  requireArgumentArray('pairs', 'y', y);
  requireArgumentArray('pairs', 'x', x);
  const n = requireSameLength(x.length, y.length, 'pairs', 'x', 'y');
  const out = new Array<Pair>(n);
  for (let i = 0; i < n; i++) out[i] = { x: x[i]!, y: y[i]! };
  return out;
}

// ───────────────────────── rolling operators ─────────────────────────

type RollMode = 'min' | 'max' | 'sum' | 'minIndex' | 'maxIndex';

class RollStream implements IndicatorStream<number, number> {
  private buf: number[] = [];
  value: number | null = null;
  private readonly period: number;
  private readonly mode: RollMode;
  constructor(parameters: { period: number; mode: RollMode }) {
    requireStreamParameters('RollStream.constructor#0', 'RollStream', parameters);
    const { period, mode } = parameters;
    this.period = period;
    this.mode = mode;
  }
  next(value: number): number | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    switch (this.mode) {
      case 'sum': {
        let s = 0;
        for (const x of this.buf) s += x;
        this.value = s;
        break;
      }
      case 'min':
        this.value = minOf(this.buf);
        break;
      case 'max':
        this.value = maxOf(this.buf);
        break;
      case 'minIndex': {
        let idx = 0;
        for (let i = 1; i < this.period; i++) if (this.buf[i]! < this.buf[idx]!) idx = i;
        this.value = this.period - 1 - idx; // bars ago (0 = current)
        break;
      }
      case 'maxIndex': {
        let idx = 0;
        for (let i = 1; i < this.period; i++) if (this.buf[i]! > this.buf[idx]!) idx = i;
        this.value = this.period - 1 - idx;
        break;
      }
    }
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(`roll:${this.mode}`, {
      period: this.period,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static restore(mode: RollMode) {
    return (s: TechnicalAnalysisSnapshot): RollStream => {
      const state = readSnapshot(s, `roll:${mode}`);
      const x = new RollStream({ period: state.lookback('period'), mode });
      x.buf = state.numbers('buf');
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

function rollFacade(mode: RollMode) {
  // Teaching errors must show a CALLABLE name (`rollingMin(series, …)`), not the internal
  // `rolling:min` stream kind.
  const fnName = `rolling${mode[0]!.toUpperCase()}${mode.slice(1)}`;
  return makeIndicator<PeriodParameters, number, number>(
    (p) => new RollStream({ period: requirePeriod(p.period, fnName), mode }),
    RollStream.restore(mode),
    nan,
  );
}

export const rollingMin = withBuiltinMetadata(
  rollFacade('min'),
  builtinMetadata.rollingMinMetadata,
);
export const rollingMax = withBuiltinMetadata(
  rollFacade('max'),
  builtinMetadata.rollingMaxMetadata,
);
export const rollingSum = withBuiltinMetadata(
  rollFacade('sum'),
  builtinMetadata.rollingSumMetadata,
);
/** Bars ago (0 = current bar) of the lowest value in the window. */
export const rollingMinIndex = withBuiltinMetadata(
  rollFacade('minIndex'),
  builtinMetadata.rollingMinIndexMetadata,
);
/** Bars ago (0 = current bar) of the highest value in the window. */
export const rollingMaxIndex = withBuiltinMetadata(
  rollFacade('maxIndex'),
  builtinMetadata.rollingMaxIndexMetadata,
);

export interface MinMaxPoint {
  min: number;
  max: number;
}
export interface MinMaxIndexPoint {
  minIndex: number;
  maxIndex: number;
}

class MinMaxStream implements IndicatorStream<number, MinMaxPoint> {
  private buf: number[] = [];
  value: MinMaxPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'MinMaxStream');
  }
  next(value: number): MinMaxPoint | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    this.value = { min: minOf(this.buf), max: maxOf(this.buf) };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rollingMinMax', {
      period: this.period,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MinMaxStream {
    const state = readSnapshot(snapshot, 'rollingMinMax');
    const x = new MinMaxStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<MinMaxPoint>('value');
    return x;
  }
}

export const rollingMinMax = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, MinMaxPoint>(
    (p) => new MinMaxStream(requirePeriod(p.period, 'rollingMinMax')),
    MinMaxStream.fromJSON,
    () => ({ min: NaN, max: NaN }),
  ),
  builtinMetadata.rollingMinMaxMetadata,
);

class MinMaxIndexStream implements IndicatorStream<number, MinMaxIndexPoint> {
  private buf: number[] = [];
  value: MinMaxIndexPoint | null = null;
  constructor(private readonly period: number) {
    requirePeriod(period, 'MinMaxIndexStream');
  }
  next(value: number): MinMaxIndexPoint | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    let lo = 0;
    let hi = 0;
    for (let i = 1; i < this.period; i++) {
      if (this.buf[i]! < this.buf[lo]!) lo = i;
      if (this.buf[i]! > this.buf[hi]!) hi = i;
    }
    this.value = { minIndex: this.period - 1 - lo, maxIndex: this.period - 1 - hi };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rollingMinMaxIndex', {
      period: this.period,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MinMaxIndexStream {
    const state = readSnapshot(snapshot, 'rollingMinMaxIndex');
    const x = new MinMaxIndexStream(state.lookback('period'));
    x.buf = state.numbers('buf');
    x.value = state.cached<MinMaxIndexPoint>('value');
    return x;
  }
}

export const rollingMinMaxIndex = withBuiltinMetadata(
  makeIndicator<PeriodParameters, number, MinMaxIndexPoint>(
    (p) => new MinMaxIndexStream(requirePeriod(p.period, 'rollingMinMaxIndex')),
    MinMaxIndexStream.fromJSON,
    () => ({ minIndex: NaN, maxIndex: NaN }),
  ),
  builtinMetadata.rollingMinMaxIndexMetadata,
);

export {
  MidpointStream,
  MidpriceStream,
  BopStream,
  BetaStream,
  CorrelStream,
  RollStream,
  MinMaxStream,
  MinMaxIndexStream,
};
