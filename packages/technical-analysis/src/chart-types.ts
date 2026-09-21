/**
 * Alternative chart representations (spec §13.3).
 *
 * Heikin-Ashi (re-exported from `./transforms`), Renko, Kagi, Point & Figure, Three-Line-Break, and
 * the information-driven bar aggregations (range / tick / volume / dollar). Unlike indicators these
 * re-aggregate the series, so their output length differs from the input. Renko, Line-Break and the
 * bar aggregations expose serializable streams (`.next(bar)` returns the zero-or-more new units that
 * completed on that bar) plus a batch wrapper; Kagi and Point & Figure are batch constructions.
 *
 * These classes are NOT wrapped by the framework's `VersionedStream` (they are their own public
 * facade), so they follow the versioning law themselves: `toJSON()` returns a
 * {@link TechnicalAnalysisSnapshot} built by `snapshotOf` (which stamps `schemaVersion` centrally),
 * and every restore path reads state through `readSnapshot`, which validates the envelope, its
 * version and its `kind` before a single field is touched, and then checks each field it reads. Restores deep-copy any nested state so two streams
 * restored from one snapshot object never share live state.
 */

import {
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  type BarInput,
  type TechnicalAnalysisSnapshot,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { requireBooleanWhenPresent, requirePeriod, requirePositive } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

export { heikinAshi, type HeikinAshiBar } from './transforms.js';

function openOf(bar: BarInput): number {
  return bar.open ?? bar.close;
}
function volumeOf(bar: BarInput): number {
  return bar.volume ?? 0;
}

/** A streaming aggregator: each input bar yields zero or more completed output units. */
export interface AggregateStream<Out> {
  next(bar: BarInput): Out[];
  toJSON(): TechnicalAnalysisSnapshot;
}

// ───────────────────────── Renko ─────────────────────────

export interface RenkoParameters {
  brickSize: number;
}
const RENKO_KEYS = ['brickSize'] as const;
export interface RenkoBrick {
  open: number;
  close: number;
  direction: 1 | -1;
}

export class RenkoStream implements AggregateStream<RenkoBrick> {
  private dir = 0;
  private ref: number | null = null;
  constructor(private readonly brick: number) {
    // a non-positive brick makes the brick loops spin forever — fail loudly instead
    requirePositive(brick, 'renko', 'brickSize');
  }
  next(bar: BarInput): RenkoBrick[] {
    const p = bar.close;
    const out: RenkoBrick[] = [];
    const brick = this.brick;
    if (this.ref === null) {
      this.ref = p;
      return out;
    }
    if (this.dir >= 0) {
      while (p >= this.ref + brick) {
        this.ref += brick;
        out.push({ open: this.ref - brick, close: this.ref, direction: 1 });
        this.dir = 1;
      }
      if (this.dir === 1 ? p <= this.ref - 2 * brick : p <= this.ref - brick) {
        if (this.dir === 1) this.ref -= brick; // skip the gap brick on reversal
        while (p <= this.ref - brick) {
          this.ref -= brick;
          out.push({ open: this.ref + brick, close: this.ref, direction: -1 });
          this.dir = -1;
        }
      }
    } else {
      while (p <= this.ref - brick) {
        this.ref -= brick;
        out.push({ open: this.ref + brick, close: this.ref, direction: -1 });
      }
      if (p >= this.ref + 2 * brick) {
        this.ref += brick; // skip the gap brick on reversal
        while (p >= this.ref + brick) {
          this.ref += brick;
          out.push({ open: this.ref - brick, close: this.ref, direction: 1 });
          this.dir = 1;
        }
      }
    }
    return out;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('renko', { brick: this.brick, dir: this.dir, ref: this.ref });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RenkoStream {
    const state = readSnapshot(snapshot, 'renko');
    const x = new RenkoStream(state.number('brick'));
    x.dir = state.number('dir');
    x.ref = state.numberOrNull('ref');
    return x;
  }
}

export function renko(bars: ArrayLike<BarInput>, parameters: RenkoParameters): RenkoBrick[] {
  requireArgumentObject('renko', 'parameters', parameters);
  // Law 12: an unknown field (a `bricksize` typo) teaches instead of being silently ignored.
  ensureKnownKeys('renko', 'parameters', parameters, RENKO_KEYS);
  requireArgumentArray('renko', 'bars', bars);
  const stream = new RenkoStream(parameters.brickSize);
  const out: RenkoBrick[] = [];
  for (let i = 0; i < bars.length; i++) out.push(...stream.next(bars[i]!));
  return out;
}

// ───────────────────────── Three-Line Break ─────────────────────────

export interface LineBreakParameters {
  lines?: number;
}
const LINE_BREAK_KEYS = ['lines'] as const;
export interface LineBreakBar {
  open: number;
  close: number;
  direction: 1 | -1;
}

export class LineBreakStream implements AggregateStream<LineBreakBar> {
  private lines: LineBreakBar[] = [];
  private firstClose: number | null = null;
  constructor(private readonly count: number) {
    requirePeriod(count, 'lineBreak', 'lines');
  }
  next(bar: BarInput): LineBreakBar[] {
    const p = bar.close;
    if (this.lines.length === 0) {
      if (this.firstClose === null) {
        this.firstClose = p;
        return [];
      }
      if (p === this.firstClose) return [];
      const line: LineBreakBar = {
        open: this.firstClose,
        close: p,
        direction: p > this.firstClose ? 1 : -1,
      };
      this.lines.push(line);
      return [line];
    }
    const recent = this.lines.slice(-this.count);
    let hi = -Infinity;
    let lo = Infinity;
    for (const l of recent) {
      hi = Math.max(hi, l.open, l.close);
      lo = Math.min(lo, l.open, l.close);
    }
    const last = this.lines[this.lines.length - 1]!;
    if (p > hi) {
      const line: LineBreakBar = { open: last.close, close: p, direction: 1 };
      this.lines.push(line);
      return [line];
    }
    if (p < lo) {
      const line: LineBreakBar = { open: last.close, close: p, direction: -1 };
      this.lines.push(line);
      return [line];
    }
    return [];
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('lineBreak', {
      count: this.count,
      lines: this.lines.map((l) => ({ ...l })),
      firstClose: this.firstClose,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): LineBreakStream {
    const state = readSnapshot(snapshot, 'lineBreak');
    const x = new LineBreakStream(state.number('count'));
    x.lines = state.records<LineBreakBar>('lines').map((l) => ({ ...l }));
    x.firstClose = state.numberOrNull('firstClose');
    return x;
  }
}

export function lineBreak(
  bars: ArrayLike<BarInput>,
  parameters: LineBreakParameters = {},
): LineBreakBar[] {
  requireArgumentObject('lineBreak', 'parameters', parameters);
  ensureKnownKeys('lineBreak', 'parameters', parameters, LINE_BREAK_KEYS);
  requireArgumentArray('lineBreak', 'bars', bars);
  ensureFiniteWhenPresent(parameters.lines, 'lines', 'lineBreak');
  const stream = new LineBreakStream(parameters.lines ?? 3);
  const out: LineBreakBar[] = [];
  for (let i = 0; i < bars.length; i++) out.push(...stream.next(bars[i]!));
  return out;
}

// ───────────────────────── Kagi (batch) ─────────────────────────

export interface KagiParameters {
  /** Reversal amount. Absolute price by default, or a percent of price if `percent` is true. */
  reversal: number;
  percent?: boolean;
}
const KAGI_KEYS = ['reversal', 'percent'] as const;
export interface KagiSegment {
  from: number;
  to: number;
  direction: 1 | -1;
  /** Yang (thick) once price rises above the prior shoulder; yin (thin) below the prior waist. */
  line: 'yang' | 'yin';
}

export function kagi(bars: ArrayLike<BarInput>, parameters: KagiParameters): KagiSegment[] {
  requireArgumentObject('kagi', 'parameters', parameters);
  ensureKnownKeys('kagi', 'parameters', parameters, KAGI_KEYS);
  requireArgumentArray('kagi', 'bars', bars);
  requirePositive(parameters.reversal, 'kagi', 'reversal');
  // The percent flag flips reversal from absolute points to percent-of-reference — a truthy
  // string must never silently select the percent formula.
  requireBooleanWhenPresent(parameters.percent, 'kagi', 'percent');
  const segments: KagiSegment[] = [];
  if (bars.length === 0) return segments;
  const rev = (ref: number): number =>
    parameters.percent ? (ref * parameters.reversal) / 100 : parameters.reversal;
  let dir = 0;
  let anchor = bars[0]!.close;
  let extreme = anchor;
  let line: 'yang' | 'yin' = 'yin';
  let shoulder = anchor; // last local high turning point
  let waist = anchor; // last local low turning point

  for (let i = 1; i < bars.length; i++) {
    const p = bars[i]!.close;
    if (dir === 0) {
      if (p >= anchor + rev(anchor)) {
        dir = 1;
        extreme = p;
      } else if (p <= anchor - rev(anchor)) {
        dir = -1;
        extreme = p;
      }
      continue;
    }
    if (dir === 1) {
      if (p > extreme) {
        extreme = p;
        if (extreme > shoulder) line = 'yang';
      } else if (p <= extreme - rev(extreme)) {
        segments.push({ from: anchor, to: extreme, direction: 1, line });
        shoulder = extreme;
        anchor = extreme;
        extreme = p;
        dir = -1;
      }
    } else {
      if (p < extreme) {
        extreme = p;
        if (extreme < waist) line = 'yin';
      } else if (p >= extreme + rev(extreme)) {
        segments.push({ from: anchor, to: extreme, direction: -1, line });
        waist = extreme;
        anchor = extreme;
        extreme = p;
        dir = 1;
      }
    }
  }
  // provisional final segment
  if (dir !== 0) segments.push({ from: anchor, to: extreme, direction: dir as 1 | -1, line });
  return segments;
}

// ───────────────────────── Point & Figure (batch) ─────────────────────────

export interface PnfParameters {
  boxSize: number;
  reversal?: number;
}
const PNF_KEYS = ['boxSize', 'reversal'] as const;
export interface PnfColumn {
  kind: 'X' | 'O';
  low: number;
  high: number;
  boxes: number;
}

export function pointAndFigure(bars: ArrayLike<BarInput>, parameters: PnfParameters): PnfColumn[] {
  requireArgumentObject('pointAndFigure', 'parameters', parameters);
  ensureKnownKeys('pointAndFigure', 'parameters', parameters, PNF_KEYS);
  requireArgumentArray('pointAndFigure', 'bars', bars);
  const box = requirePositive(parameters.boxSize, 'pointAndFigure', 'boxSize');
  ensureFiniteWhenPresent(parameters.reversal, 'reversal', 'pointAndFigure');
  const reversal = requirePeriod(parameters.reversal ?? 3, 'pointAndFigure', 'reversal');
  const cols: PnfColumn[] = [];
  if (bars.length === 0) return cols;
  const idx = (p: number): number => Math.floor(p / box);
  let dir = 0; // 1 = X (up), −1 = O (down)
  let topIdx = idx(bars[0]!.high);
  let botIdx = idx(bars[0]!.low);

  const emit = (kind: 'X' | 'O', lowI: number, highI: number): void => {
    cols.push({ kind, low: lowI * box, high: (highI + 1) * box, boxes: highI - lowI + 1 });
  };

  for (let i = 0; i < bars.length; i++) {
    const hi = idx(bars[i]!.high);
    const lo = idx(bars[i]!.low);
    if (dir === 0) {
      if (hi > topIdx) {
        dir = 1;
        topIdx = hi;
      } else if (lo < botIdx) {
        dir = -1;
        botIdx = lo;
      }
    } else if (dir === 1) {
      if (hi > topIdx) {
        topIdx = hi;
      } else if (lo <= topIdx - reversal) {
        emit('X', botIdx, topIdx);
        dir = -1;
        botIdx = lo;
        topIdx = topIdx - 1; // new O column starts one box below the X top
      }
    } else {
      if (lo < botIdx) {
        botIdx = lo;
      } else if (hi >= botIdx + reversal) {
        emit('O', botIdx, topIdx);
        dir = 1;
        topIdx = hi;
        botIdx = botIdx + 1; // new X column starts one box above the O bottom
      }
    }
  }
  if (dir === 1) emit('X', botIdx, topIdx);
  else if (dir === -1) emit('O', botIdx, topIdx);
  return cols;
}

// ───────────────────────── information-driven bars ─────────────────────────

type CloseRule = (accumulated: AggBar, bar: BarInput) => boolean;

interface AggBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  dollar: number;
  ticks: number;
}

class BarAggregator implements AggregateStream<BarInput> {
  private acc: AggBar | null = null;
  private readonly kind: string;
  private readonly shouldClose: CloseRule;
  constructor(parameters: { kind: string; shouldClose: CloseRule }) {
    requireStreamParameters('BarAggregator.constructor#0', 'BarAggregator', parameters);
    const { kind, shouldClose } = parameters;
    this.kind = kind;
    this.shouldClose = shouldClose;
  }
  next(bar: BarInput): BarInput[] {
    if (this.acc === null) {
      this.acc = {
        open: openOf(bar),
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: volumeOf(bar),
        dollar: bar.close * volumeOf(bar),
        ticks: 1,
      };
    } else {
      this.acc.high = Math.max(this.acc.high, bar.high);
      this.acc.low = Math.min(this.acc.low, bar.low);
      this.acc.close = bar.close;
      this.acc.volume += volumeOf(bar);
      this.acc.dollar += bar.close * volumeOf(bar);
      this.acc.ticks += 1;
    }
    if (this.shouldClose(this.acc, bar)) {
      const done = this.acc;
      this.acc = null;
      return [
        { open: done.open, high: done.high, low: done.low, close: done.close, volume: done.volume },
      ];
    }
    return [];
  }
  /** Emit the final partial bar (if any) — used by the batch wrappers to flush. */
  flush(): BarInput[] {
    if (this.acc === null) return [];
    const done = this.acc;
    this.acc = null;
    return [
      { open: done.open, high: done.high, low: done.low, close: done.close, volume: done.volume },
    ];
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, { acc: this.acc === null ? null : { ...this.acc } });
  }
  /**
   * Restore this aggregator's forming-bar state from a snapshot produced by `toJSON()` (the close
   * rule is a function, so rebuild the aggregator via its factory — e.g. `aggregators.volume(500)` —
   * then restore). Validates the schema version and the snapshot `kind`, and deep-copies the state,
   * so restoring twice from one snapshot yields independent aggregators.
   */
  restore(snapshot: TechnicalAnalysisSnapshot): void {
    // No separate kind check: `readSnapshot` IS the identity guard, and running a second one after
    // the state had already been read is how the two could disagree.
    const state = readSnapshot(snapshot, this.kind);
    const acc = state.recordOrNull<AggBar>('acc');
    this.acc = acc == null ? null : { ...acc };
  }
}

function makeRangeAggregator(size: number): BarAggregator {
  requirePositive(size, 'rangeBars', 'size');
  return new BarAggregator({
    kind: 'rangeBars',
    shouldClose: (accumulated) => accumulated.high - accumulated.low >= size,
  });
}
function makeTickAggregator(count: number): BarAggregator {
  requirePeriod(count, 'tickBars', 'count');
  return new BarAggregator({
    kind: 'tickBars',
    shouldClose: (accumulated) => accumulated.ticks >= count,
  });
}
function makeVolumeAggregator(threshold: number): BarAggregator {
  requirePositive(threshold, 'volumeBars', 'volume');
  return new BarAggregator({
    kind: 'volumeBars',
    shouldClose: (accumulated) => accumulated.volume >= threshold,
  });
}
function makeDollarAggregator(threshold: number): BarAggregator {
  requirePositive(threshold, 'dollarBars', 'dollar');
  return new BarAggregator({
    kind: 'dollarBars',
    shouldClose: (accumulated) => accumulated.dollar >= threshold,
  });
}

/** Anything that yields completed bars per input bar and can flush a trailing partial. */
interface FlushableAgg {
  next(bar: BarInput): BarInput[];
  flush(): BarInput[];
}

function runAggregator(
  bars: ArrayLike<BarInput>,
  agg: FlushableAgg,
  functionName: string,
  flush: boolean | undefined,
): BarInput[] {
  // ONE ladder for all ten aggregator heads: `flush: null` used to coalesce into true and a
  // truthy string silently kept the default — a flag is a boolean, not a truthiness.
  const resolved = requireBooleanWhenPresent(flush, functionName, 'flush') ?? true;
  const out: BarInput[] = [];
  for (let i = 0; i < bars.length; i++) out.push(...agg.next(bars[i]!));
  if (resolved) out.push(...agg.flush());
  return out;
}

export interface RangeBarParameters {
  size: number;
  /** Emit the trailing partial bar. Default true. */
  flush?: boolean;
}
export interface CountBarParameters {
  count: number;
  flush?: boolean;
}
export interface VolumeBarParameters {
  volume: number;
  flush?: boolean;
}
export interface DollarBarParameters {
  dollar: number;
  flush?: boolean;
}
const RANGE_BAR_KEYS = ['size', 'flush'] as const;
const COUNT_BAR_KEYS = ['count', 'flush'] as const;
const VOLUME_BAR_KEYS = ['volume', 'flush'] as const;
const DOLLAR_BAR_KEYS = ['dollar', 'flush'] as const;

export function rangeBars(bars: ArrayLike<BarInput>, parameters: RangeBarParameters): BarInput[] {
  requireArgumentObject('rangeBars', 'parameters', parameters);
  ensureKnownKeys('rangeBars', 'parameters', parameters, RANGE_BAR_KEYS);
  requireArgumentArray('rangeBars', 'bars', bars);
  return runAggregator(bars, makeRangeAggregator(parameters.size), 'rangeBars', parameters.flush);
}
export function tickBars(bars: ArrayLike<BarInput>, parameters: CountBarParameters): BarInput[] {
  requireArgumentObject('tickBars', 'parameters', parameters);
  ensureKnownKeys('tickBars', 'parameters', parameters, COUNT_BAR_KEYS);
  requireArgumentArray('tickBars', 'bars', bars);
  return runAggregator(bars, makeTickAggregator(parameters.count), 'tickBars', parameters.flush);
}
export function volumeBars(bars: ArrayLike<BarInput>, parameters: VolumeBarParameters): BarInput[] {
  requireArgumentObject('volumeBars', 'parameters', parameters);
  ensureKnownKeys('volumeBars', 'parameters', parameters, VOLUME_BAR_KEYS);
  requireArgumentArray('volumeBars', 'bars', bars);
  return runAggregator(
    bars,
    makeVolumeAggregator(parameters.volume),
    'volumeBars',
    parameters.flush,
  );
}
export function dollarBars(bars: ArrayLike<BarInput>, parameters: DollarBarParameters): BarInput[] {
  requireArgumentObject('dollarBars', 'parameters', parameters);
  ensureKnownKeys('dollarBars', 'parameters', parameters, DOLLAR_BAR_KEYS);
  requireArgumentArray('dollarBars', 'bars', bars);
  return runAggregator(
    bars,
    makeDollarAggregator(parameters.dollar),
    'dollarBars',
    parameters.flush,
  );
}

// ───────────────────────── information-imbalance & run bars (de Prado) ─────────────────────────

/**
 * Imbalance & run bars sample on order-flow information rather than time. Each input bar is signed by
 * the tick rule (`b = sign(Δclose)`, carrying the prior sign when the close is unchanged) and weighted
 * by 1 (tick), volume, or dollar value. An *imbalance* bar closes when the absolute signed cumulative
 * imbalance `|Σ b·w|` reaches `threshold`; a *run* bar closes when the larger one-sided run
 * `max(Σ_{b>0} w, Σ_{b<0} w)` reaches it. The tick sign is continuous across bar boundaries (the prior
 * close persists), so bars adapt to clustered, directional flow.
 */
const INFO_WEIGHTS = ['tick', 'volume', 'dollar'] as const;
type InfoWeight = (typeof INFO_WEIGHTS)[number];
const INFO_MODES = ['imbalance', 'run'] as const;
type InfoMode = (typeof INFO_MODES)[number];

interface InfoAcc extends AggBar {
  imbalance: number;
  buyRun: number;
  sellRun: number;
}

class InformationBarAggregator implements AggregateStream<BarInput>, FlushableAgg {
  private acc: InfoAcc | null = null;
  private previousClose: number | null = null;
  private lastSign = 1; // tick-rule carry; the first bar counts as an up-tick
  private readonly kind: string;
  private readonly weight: InfoWeight;
  private readonly mode: InfoMode;
  private readonly threshold: number;
  constructor(parameters: { kind: string; weight: InfoWeight; mode: InfoMode; threshold: number }) {
    requireStreamParameters(
      'InformationBarAggregator.constructor#0',
      'InformationBarAggregator',
      parameters,
    );
    const { kind, weight, mode, threshold } = parameters;
    this.kind = kind;
    this.weight = weight;
    this.mode = mode;
    this.threshold = threshold;

    requirePositive(threshold, kind, 'threshold');
  }
  private weightOf(bar: BarInput): number {
    if (this.weight === 'tick') return 1;
    if (this.weight === 'volume') return volumeOf(bar);
    return bar.close * volumeOf(bar);
  }
  next(bar: BarInput): BarInput[] {
    let sign: number;
    if (this.previousClose === null) {
      sign = this.lastSign;
    } else {
      const d = bar.close - this.previousClose;
      sign = d > 0 ? 1 : d < 0 ? -1 : this.lastSign;
    }
    this.lastSign = sign;
    this.previousClose = bar.close;
    const w = this.weightOf(bar);
    if (this.acc === null) {
      this.acc = {
        open: openOf(bar),
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: volumeOf(bar),
        dollar: bar.close * volumeOf(bar),
        ticks: 1,
        imbalance: 0,
        buyRun: 0,
        sellRun: 0,
      };
    } else {
      this.acc.high = Math.max(this.acc.high, bar.high);
      this.acc.low = Math.min(this.acc.low, bar.low);
      this.acc.close = bar.close;
      this.acc.volume += volumeOf(bar);
      this.acc.dollar += bar.close * volumeOf(bar);
      this.acc.ticks += 1;
    }
    this.acc.imbalance += sign * w;
    if (sign > 0) this.acc.buyRun += w;
    else this.acc.sellRun += w;
    const metric =
      this.mode === 'imbalance'
        ? Math.abs(this.acc.imbalance)
        : Math.max(this.acc.buyRun, this.acc.sellRun);
    return metric >= this.threshold ? this.emit() : [];
  }
  private emit(): BarInput[] {
    const d = this.acc!;
    this.acc = null;
    return [{ open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }];
  }
  flush(): BarInput[] {
    return this.acc === null ? [] : this.emit();
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, {
      weight: this.weight,
      mode: this.mode,
      threshold: this.threshold,
      acc: this.acc === null ? null : { ...this.acc },
      previousClose: this.previousClose,
      lastSign: this.lastSign,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): InformationBarAggregator {
    const state = readSnapshot(snapshot, INFORMATION_BAR_KINDS);
    const x = new InformationBarAggregator({
      kind: state.kind,
      weight: state.literal<InfoWeight>('weight', INFO_WEIGHTS),
      mode: state.literal<InfoMode>('mode', INFO_MODES),
      threshold: state.number('threshold'),
    });
    // Deep-copy the forming-bar accumulator: assigning the snapshot's object by reference would
    // make every aggregator restored from one snapshot share (and corrupt) live state.
    const acc = state.recordOrNull<InfoAcc>('acc');
    x.acc = acc == null ? null : { ...acc };
    x.previousClose = state.numberOrNull('previousClose');
    x.lastSign = state.number('lastSign');
    return x;
  }
}

const IMBALANCE_KIND: Record<InfoWeight, string> = {
  tick: 'imbalanceBars',
  volume: 'volumeImbalanceBars',
  dollar: 'dollarImbalanceBars',
};
const RUN_KIND: Record<InfoWeight, string> = {
  tick: 'runBars',
  volume: 'volumeRunBars',
  dollar: 'dollarRunBars',
};

/**
 * The information-bar family — six public aggregators backed by one class, which reads which one it
 * is off the snapshot. DERIVED from the two kind tables rather than restated, so a seventh weight
 * cannot be added to a table and silently left out of the restorer's identity guard.
 */
const INFORMATION_BAR_KINDS: readonly string[] = [
  ...Object.values(IMBALANCE_KIND),
  ...Object.values(RUN_KIND),
];

const makeImbalanceAgg = (weight: InfoWeight, threshold: number): InformationBarAggregator =>
  new InformationBarAggregator({
    kind: IMBALANCE_KIND[weight],
    weight,
    mode: 'imbalance',
    threshold,
  });
const makeRunAgg = (weight: InfoWeight, threshold: number): InformationBarAggregator =>
  new InformationBarAggregator({
    kind: RUN_KIND[weight],
    weight,
    mode: 'run',
    threshold,
  });

export interface InformationBarParameters {
  /** Imbalance/run magnitude that closes a bar. */
  threshold: number;
  /** Emit the trailing partial bar. Default true. */
  flush?: boolean;
}
const INFO_BAR_KEYS = ['threshold', 'flush'] as const;

/** Tick imbalance bars — close on `|Σ sign(Δclose)|`. */
export function imbalanceBars(
  bars: ArrayLike<BarInput>,
  parameters: InformationBarParameters,
): BarInput[] {
  requireArgumentObject('imbalanceBars', 'parameters', parameters);
  ensureKnownKeys('imbalanceBars', 'parameters', parameters, INFO_BAR_KEYS);
  requireArgumentArray('imbalanceBars', 'bars', bars);
  return runAggregator(
    bars,
    makeImbalanceAgg('tick', parameters.threshold),
    'imbalanceBars',
    parameters.flush,
  );
}
/** Volume imbalance bars — signed volume `|Σ sign(Δclose)·volume|`. */
export function volumeImbalanceBars(
  bars: ArrayLike<BarInput>,
  parameters: InformationBarParameters,
): BarInput[] {
  requireArgumentObject('volumeImbalanceBars', 'parameters', parameters);
  ensureKnownKeys('volumeImbalanceBars', 'parameters', parameters, INFO_BAR_KEYS);
  requireArgumentArray('volumeImbalanceBars', 'bars', bars);
  return runAggregator(
    bars,
    makeImbalanceAgg('volume', parameters.threshold),
    'volumeImbalanceBars',
    parameters.flush,
  );
}
/** Dollar imbalance bars — signed dollar value `|Σ sign(Δclose)·close·volume|`. */
export function dollarImbalanceBars(
  bars: ArrayLike<BarInput>,
  parameters: InformationBarParameters,
): BarInput[] {
  requireArgumentObject('dollarImbalanceBars', 'parameters', parameters);
  ensureKnownKeys('dollarImbalanceBars', 'parameters', parameters, INFO_BAR_KEYS);
  requireArgumentArray('dollarImbalanceBars', 'bars', bars);
  return runAggregator(
    bars,
    makeImbalanceAgg('dollar', parameters.threshold),
    'dollarImbalanceBars',
    parameters.flush,
  );
}
/** Tick run bars — close on the larger one-sided tick run. */
export function runBars(
  bars: ArrayLike<BarInput>,
  parameters: InformationBarParameters,
): BarInput[] {
  requireArgumentObject('runBars', 'parameters', parameters);
  ensureKnownKeys('runBars', 'parameters', parameters, INFO_BAR_KEYS);
  requireArgumentArray('runBars', 'bars', bars);
  return runAggregator(bars, makeRunAgg('tick', parameters.threshold), 'runBars', parameters.flush);
}
/** Volume run bars — close on the larger one-sided volume run. */
export function volumeRunBars(
  bars: ArrayLike<BarInput>,
  parameters: InformationBarParameters,
): BarInput[] {
  requireArgumentObject('volumeRunBars', 'parameters', parameters);
  ensureKnownKeys('volumeRunBars', 'parameters', parameters, INFO_BAR_KEYS);
  requireArgumentArray('volumeRunBars', 'bars', bars);
  return runAggregator(
    bars,
    makeRunAgg('volume', parameters.threshold),
    'volumeRunBars',
    parameters.flush,
  );
}
/** Dollar run bars — close on the larger one-sided dollar run. */
export function dollarRunBars(
  bars: ArrayLike<BarInput>,
  parameters: InformationBarParameters,
): BarInput[] {
  requireArgumentObject('dollarRunBars', 'parameters', parameters);
  ensureKnownKeys('dollarRunBars', 'parameters', parameters, INFO_BAR_KEYS);
  requireArgumentArray('dollarRunBars', 'bars', bars);
  return runAggregator(
    bars,
    makeRunAgg('dollar', parameters.threshold),
    'dollarRunBars',
    parameters.flush,
  );
}

/** Streaming aggregators for live bar construction (each returns completed bars per input bar). */
export const aggregators = {
  range: (size: number): BarAggregator => makeRangeAggregator(size),
  tick: (count: number): BarAggregator => makeTickAggregator(count),
  volume: (threshold: number): BarAggregator => makeVolumeAggregator(threshold),
  dollar: (threshold: number): BarAggregator => makeDollarAggregator(threshold),
  imbalance: (threshold: number): InformationBarAggregator => makeImbalanceAgg('tick', threshold),
  volumeImbalance: (threshold: number): InformationBarAggregator =>
    makeImbalanceAgg('volume', threshold),
  dollarImbalance: (threshold: number): InformationBarAggregator =>
    makeImbalanceAgg('dollar', threshold),
  run: (threshold: number): InformationBarAggregator => makeRunAgg('tick', threshold),
  volumeRun: (threshold: number): InformationBarAggregator => makeRunAgg('volume', threshold),
  dollarRun: (threshold: number): InformationBarAggregator => makeRunAgg('dollar', threshold),
} as const;

export { BarAggregator, InformationBarAggregator };
