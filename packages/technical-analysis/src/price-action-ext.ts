/**
 * Smart-Money-Concept price-action detectors (spec §13.3; ICT/SMC parity).
 *
 * Fair Value Gaps (3-bar imbalance), Order Blocks (last opposite candle before a displacement break),
 * and Liquidity Sweeps (a rolling-extreme taken out then rejected). Unlike the swing-based tools in
 * `./price-action` — which look forward to confirm a swing and so are batch functions — these three
 * are causal (they confirm on a known bar), so they are full streaming indicators with batch≡stream
 * parity and serializable state.
 *
 * Output convention (like the candlestick patterns): a dense per-bar record whose `direction` is
 * +1 bullish / −1 bearish / 0 no event; the zone/level fields are `NaN` on a no-event bar. Filter to
 * the event bars with `r.direction !== 0`.
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
import { requireInRange, requirePeriod, requirePositive } from './validate.js';

const openOf = (bar: BarInput): number => bar.open ?? bar.close;

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

// ───────────────────────── Fair Value Gap ─────────────────────────

export interface ZonePoint {
  /** +1 bullish, −1 bearish, 0 none. */
  direction: number;
  /** Upper bound of the zone (NaN when none). */
  top: number;
  /** Lower bound of the zone (NaN when none). */
  bottom: number;
  /** Zone midpoint (NaN when none). */
  mid: number;
}

export interface FvgParameters {
  /** Minimum gap height as a percent of its midpoint to qualify (filters noise). Default 0. */
  minimumGapPercent?: number;
}

const noZone = (): ZonePoint => ({ direction: 0, top: NaN, bottom: NaN, mid: NaN });
const nanZone = (): ZonePoint => ({ direction: NaN, top: NaN, bottom: NaN, mid: NaN });

/** The prior-bar extremes an FVG scan keeps; a named type so its restorer can check the shape. */
interface HighLow {
  high: number;
  low: number;
}

class FvgStream implements IndicatorStream<BarInput, ZonePoint> {
  private prev: HighLow[] = []; // the two prior bars
  value: ZonePoint | null = null;
  constructor(private readonly minimumGapPercent: number) {}
  next(bar: BarInput): ZonePoint | null {
    if (this.prev.length < 2) {
      this.prev.push({ high: bar.high, low: bar.low });
      this.value = null;
      return null;
    }
    const c1 = this.prev[0]!; // bar i−2
    let out = noZone();
    if (bar.low > c1.high) {
      out = this.zone({ direction: 1, top: bar.low, bottom: c1.high });
    } else if (bar.high < c1.low) {
      out = this.zone({ direction: -1, top: c1.low, bottom: bar.high });
    }
    this.prev.push({ high: bar.high, low: bar.low });
    this.prev.shift();
    this.value = out;
    return out;
  }
  private zone(input: { direction: number; top: number; bottom: number }): ZonePoint {
    const { direction, top, bottom } = input;
    const mid = (top + bottom) / 2;
    if (
      this.minimumGapPercent > 0 &&
      mid !== 0 &&
      ((top - bottom) / Math.abs(mid)) * 100 < this.minimumGapPercent
    ) {
      return noZone();
    }
    return { direction, top, bottom, mid };
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('fairValueGaps', {
      minimumGapPercent: this.minimumGapPercent,
      // Deep-copied like every other stream's window: `this.prev` is mutated in place on the next
      // bar (push + shift), so handing out the live array made an already-captured snapshot change
      // underneath its holder — a "snapshot" that is not a snapshot.
      prev: this.prev.map((p) => ({ ...p })),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): FvgStream {
    const state = readSnapshot(snapshot, 'fairValueGaps');
    const x = new FvgStream(state.number('minimumGapPercent'));
    x.prev = state.records<HighLow>('prev').map((p) => ({ ...p }));
    x.value = state.cached<ZonePoint>('value');
    return x;
  }
}

export const fairValueGaps = makeIndicator<FvgParameters, BarInput, ZonePoint>(
  (p) =>
    new FvgStream(
      requireInRange(p.minimumGapPercent ?? 0, 'fairValueGaps', 'minimumGapPercent', 0, Infinity),
    ),
  FvgStream.fromJSON,
  nanZone,
);

// ───────────────────────── Order Block ─────────────────────────

export interface OrderBlockParameters {
  /** How many bars an origin candle stays eligible to be broken. Default 5. */
  lookback?: number;
}

interface Candle {
  high: number;
  low: number;
  age: number;
}

class OrderBlockStream implements IndicatorStream<BarInput, ZonePoint> {
  private lastDown: Candle | null = null; // most recent bearish candle (a bullish OB origin)
  private lastUp: Candle | null = null; // most recent bullish candle (a bearish OB origin)
  value: ZonePoint | null = null;
  constructor(private readonly lookback: number) {}
  next(bar: BarInput): ZonePoint | null {
    if (this.lastDown) this.lastDown.age++;
    if (this.lastUp) this.lastUp.age++;
    let out = noZone();
    if (this.lastDown && this.lastDown.age <= this.lookback && bar.close > this.lastDown.high) {
      out = this.zone(1, this.lastDown);
      this.lastDown = null;
    } else if (this.lastUp && this.lastUp.age <= this.lookback && bar.close < this.lastUp.low) {
      out = this.zone(-1, this.lastUp);
      this.lastUp = null;
    }
    if (this.lastDown && this.lastDown.age > this.lookback) this.lastDown = null;
    if (this.lastUp && this.lastUp.age > this.lookback) this.lastUp = null;
    const o = openOf(bar);
    if (bar.close < o) this.lastDown = { high: bar.high, low: bar.low, age: 0 };
    else if (bar.close > o) this.lastUp = { high: bar.high, low: bar.low, age: 0 };
    this.value = out;
    return out;
  }
  private zone(direction: number, c: Candle): ZonePoint {
    return { direction, top: c.high, bottom: c.low, mid: (c.high + c.low) / 2 };
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('orderBlocks', {
      lookback: this.lookback,
      // Deep-copied: `age` is incremented IN PLACE on every later bar, so a live reference let an
      // already-captured snapshot silently age along with the stream it was supposed to freeze.
      lastDown: this.lastDown === null ? null : { ...this.lastDown },
      lastUp: this.lastUp === null ? null : { ...this.lastUp },
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): OrderBlockStream {
    const state = readSnapshot(snapshot, 'orderBlocks');
    const x = new OrderBlockStream(state.lookback('lookback'));
    const lastDown = state.recordOrNull<Candle>('lastDown');
    const lastUp = state.recordOrNull<Candle>('lastUp');
    x.lastDown = lastDown === null ? null : { ...lastDown };
    x.lastUp = lastUp === null ? null : { ...lastUp };
    x.value = state.cached<ZonePoint>('value');
    return x;
  }
}

export const orderBlocks = makeIndicator<OrderBlockParameters, BarInput, ZonePoint>(
  (p) => new OrderBlockStream(requirePeriod(p.lookback ?? 5, 'orderBlocks', 'lookback')),
  OrderBlockStream.fromJSON,
  nanZone,
);

// ───────────────────────── Liquidity Sweep ─────────────────────────

export interface LiquiditySweepParameters {
  /** Rolling window of prior bars whose extreme defines the liquidity level. Default 20. */
  lookback?: number;
}
export interface LiquiditySweepPoint {
  /** +1 buy-side sweep (high taken then rejected), −1 sell-side, 0 none. */
  direction: number;
  /** The swept liquidity level (the prior-window extreme), NaN when none. */
  level: number;
}

class LiquiditySweepStream implements IndicatorStream<BarInput, LiquiditySweepPoint> {
  private highs: number[] = [];
  private lows: number[] = [];
  value: LiquiditySweepPoint | null = null;
  constructor(private readonly lookback: number) {}
  next(bar: BarInput): LiquiditySweepPoint | null {
    if (this.highs.length < this.lookback) {
      this.highs.push(bar.high);
      this.lows.push(bar.low);
      this.value = null;
      return null;
    }
    const hh = maxOf(this.highs);
    const ll = minOf(this.lows);
    let direction = 0;
    let level = NaN;
    if (bar.high > hh && bar.close < hh) {
      direction = 1; // swept the highs, closed back below — buy-side liquidity grab
      level = hh;
    } else if (bar.low < ll && bar.close > ll) {
      direction = -1; // swept the lows, closed back above — sell-side liquidity grab
      level = ll;
    }
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    this.highs.shift();
    this.lows.shift();
    this.value = { direction, level };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('liquiditySweeps', {
      lookback: this.lookback,
      highs: [...this.highs],
      lows: [...this.lows],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): LiquiditySweepStream {
    const state = readSnapshot(snapshot, 'liquiditySweeps');
    const x = new LiquiditySweepStream(state.lookback('lookback'));
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<LiquiditySweepPoint>('value');
    return x;
  }
}

export const liquiditySweeps = makeIndicator<
  LiquiditySweepParameters,
  BarInput,
  LiquiditySweepPoint
>(
  (p) => new LiquiditySweepStream(requirePeriod(p.lookback ?? 20, 'liquiditySweeps', 'lookback')),
  LiquiditySweepStream.fromJSON,
  () => ({ direction: NaN, level: NaN }),
);

// ───────────────────────── pandas-ta SMC sweep scalar ─────────────────────────

export interface SmcSweepParameters {
  /** Prior-window swing high/low lookback. Default 15. */
  period?: number;
  /** Wick must exceed `body * wickMultiplier`. Default 1.5. */
  wickMultiplier?: number;
}

class SmcSweepStream implements IndicatorStream<BarInput, number> {
  private highs: number[] = [];
  private lows: number[] = [];
  value: number | null = null;
  constructor(
    private readonly period: number,
    private readonly wickMultiplier: number,
  ) {}
  next(bar: BarInput): number | null {
    if (this.highs.length < this.period) {
      this.highs.push(bar.high);
      this.lows.push(bar.low);
      this.value = 0;
      return this.value;
    }
    const swingHigh = maxOf(this.highs);
    const swingLow = minOf(this.lows);
    const open = openOf(bar);
    const body = Math.abs(bar.close - open);
    const lowerWick = Math.min(open, bar.close) - bar.low;
    const upperWick = bar.high - Math.max(open, bar.close);
    const bull =
      bar.low < swingLow &&
      bar.close > swingLow &&
      bar.close > open &&
      lowerWick > body * this.wickMultiplier;
    const bear =
      bar.high > swingHigh &&
      bar.close < swingHigh &&
      bar.close < open &&
      upperWick > body * this.wickMultiplier;
    this.value = bull ? 1 : bear ? -1 : 0;
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    this.highs.shift();
    this.lows.shift();
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('smcSweep', {
      period: this.period,
      wickMultiplier: this.wickMultiplier,
      highs: [...this.highs],
      lows: [...this.lows],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SmcSweepStream {
    const state = readSnapshot(snapshot, 'smcSweep');
    const x = new SmcSweepStream(state.lookback('period'), state.number('wickMultiplier'));
    x.highs = state.numbers('highs');
    x.lows = state.numbers('lows');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** pandas-ta `smc_sweep`: +1 bullish low sweep, -1 bearish high sweep, 0 none. */
export const smcSweep = makeIndicator<SmcSweepParameters, BarInput, number>(
  (p) =>
    new SmcSweepStream(
      requirePeriod(p.period ?? 15, 'smcSweep'),
      requirePositive(p.wickMultiplier ?? 1.5, 'smcSweep', 'wickMultiplier'),
    ),
  SmcSweepStream.fromJSON,
  () => NaN,
);

// ───────────────────────── causal confirmed-swing primitive ─────────────────────────

/**
 * Streaming swing detector. A swing high at bar j (strict: higher than the `strength` bars on each
 * side) is only *confirmed* once `strength` later bars exist — so confirmation lags the swing bar by
 * `strength`, but every confirmation is causal (it uses no bar later than the current one). `push`
 * returns the swing(s) confirmed on the current bar (the bar `strength` ago), or `null` while the
 * `2·strength+1` window is still filling.
 */
class SwingTracker {
  private buf: BarInput[] = [];
  private readonly size: number;
  /** Most recent confirmed swing-high / swing-low prices. */
  lastHigh: number | null = null;
  lastLow: number | null = null;
  constructor(private readonly strength: number) {
    this.size = 2 * strength + 1;
  }
  push(bar: BarInput): { high: number | null; low: number | null } | null {
    this.buf.push(bar);
    if (this.buf.length > this.size) this.buf.shift();
    if (this.buf.length < this.size) return null;
    const c = this.buf[this.strength]!;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= this.strength; k++) {
      if (
        c.high <= this.buf[this.strength - k]!.high ||
        c.high <= this.buf[this.strength + k]!.high
      ) {
        isHigh = false;
      }
      if (c.low >= this.buf[this.strength - k]!.low || c.low >= this.buf[this.strength + k]!.low) {
        isLow = false;
      }
    }
    const high = isHigh ? c.high : null;
    const low = isLow ? c.low : null;
    if (high !== null) this.lastHigh = high;
    if (low !== null) this.lastLow = low;
    return { high, low };
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('swingTracker', {
      strength: this.strength,
      buf: this.buf.map((b) => ({ ...b })),
      lastHigh: this.lastHigh,
      lastLow: this.lastLow,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SwingTracker {
    const state = readSnapshot(snapshot, 'swingTracker');
    const x = new SwingTracker(state.number('strength'));
    x.buf = state.records<BarInput>('buf').map((b) => ({ ...b }));
    x.lastHigh = state.numberOrNull('lastHigh');
    x.lastLow = state.numberOrNull('lastLow');
    return x;
  }
}

// ───────────────────────── trailing stops ─────────────────────────

export interface TrailingStopPoint {
  /** The trailing stop line. */
  stop: number;
  /** +1 long (price above the stop), −1 short. */
  trend: number;
}

export interface SwingTrailingStopParameters {
  /** Swing strength (bars on each side). Default 2. */
  strength?: number;
}

class SwingTrailingStopStream implements IndicatorStream<BarInput, TrailingStopPoint> {
  private tracker: SwingTracker;
  private trend = 0;
  private stop = NaN;
  private started = false;
  value: TrailingStopPoint | null = null;
  constructor(strength: number) {
    this.tracker = new SwingTracker(strength);
  }
  next(bar: BarInput): TrailingStopPoint | null {
    this.tracker.push(bar);
    const hi = this.tracker.lastHigh;
    const lo = this.tracker.lastLow;
    if (hi === null || lo === null) {
      this.value = null;
      return null; // need both rails before a stop exists
    }
    if (!this.started) {
      this.trend = 1;
      this.stop = lo;
      this.started = true;
    } else if (this.trend === 1) {
      this.stop = Math.max(this.stop, lo); // ratchet up — a trailing stop never loosens
      if (bar.close < this.stop) {
        this.trend = -1;
        this.stop = hi;
      }
    } else {
      this.stop = Math.min(this.stop, hi);
      if (bar.close > this.stop) {
        this.trend = 1;
        this.stop = lo;
      }
    }
    this.value = { stop: this.stop, trend: this.trend };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('swingTrailingStop', {
      tracker: this.tracker.toJSON(),
      trend: this.trend,
      stop: this.stop,
      started: this.started,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): SwingTrailingStopStream {
    const state = readSnapshot(snapshot, 'swingTrailingStop');
    const x = new SwingTrailingStopStream(1);
    x.tracker = SwingTracker.fromJSON(state.child('tracker'));
    x.trend = state.number('trend');
    x.stop = state.number('stop');
    x.started = state.boolean('started');
    x.value = state.cached<TrailingStopPoint>('value');
    return x;
  }
}

/** Structure-based trailing stop: trails the most recent confirmed swing low (long) / high (short). */
export const swingTrailingStop = makeIndicator<
  SwingTrailingStopParameters,
  BarInput,
  TrailingStopPoint
>(
  (p) =>
    new SwingTrailingStopStream(requirePeriod(p.strength ?? 2, 'swingTrailingStop', 'strength')),
  SwingTrailingStopStream.fromJSON,
  () => ({ stop: NaN, trend: NaN }),
);

export interface AtrTrailingStopParameters {
  period?: number;
  multiplier?: number;
}

class AtrTrailingStopStream implements IndicatorStream<BarInput, TrailingStopPoint> {
  private atr: AtrStream;
  private stop = NaN;
  private previousClose = NaN;
  private started = false;
  value: TrailingStopPoint | null = null;
  constructor(
    period: number,
    private readonly mult: number,
  ) {
    this.atr = new AtrStream(period);
  }
  next(bar: BarInput): TrailingStopPoint | null {
    const atr = this.atr.next(bar);
    if (atr === null) {
      this.value = null;
      return null;
    }
    const nLoss = this.mult * atr;
    const c = bar.close;
    if (!this.started) {
      this.stop = c - nLoss;
      this.previousClose = c;
      this.started = true;
      this.value = { stop: this.stop, trend: c > this.stop ? 1 : -1 };
      return this.value;
    }
    const prevStop = this.stop;
    const pc = this.previousClose;
    // Vervoort / UT-Bot ATR trailing stop: trail within a leg, flip on a confirmed close cross.
    if (c > prevStop && pc > prevStop) this.stop = Math.max(prevStop, c - nLoss);
    else if (c < prevStop && pc < prevStop) this.stop = Math.min(prevStop, c + nLoss);
    else if (c > prevStop) this.stop = c - nLoss;
    else this.stop = c + nLoss;
    this.previousClose = c;
    this.value = { stop: this.stop, trend: c > this.stop ? 1 : -1 };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('atrTrailingStop', {
      mult: this.mult,
      atr: this.atr.toJSON(),
      stop: this.stop,
      previousClose: this.previousClose,
      started: this.started,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): AtrTrailingStopStream {
    const state = readSnapshot(snapshot, 'atrTrailingStop');
    const x = new AtrTrailingStopStream(1, state.number('mult'));
    x.atr = AtrStream.fromJSON(state.child('atr'));
    x.stop = state.number('stop');
    x.previousClose = state.number('previousClose');
    x.started = state.boolean('started');
    x.value = state.cached<TrailingStopPoint>('value');
    return x;
  }
}

/** ATR trailing stop (Vervoort / UT-Bot): close-anchored `close ± multiplier·ATR`, trailed per leg. */
export const atrTrailingStop = makeIndicator<
  AtrTrailingStopParameters,
  BarInput,
  TrailingStopPoint
>(
  (p) =>
    new AtrTrailingStopStream(
      requirePeriod(p.period ?? 14, 'atrTrailingStop'),
      requirePositive(p.multiplier ?? 3, 'atrTrailingStop', 'multiplier'),
    ),
  AtrTrailingStopStream.fromJSON,
  () => ({ stop: NaN, trend: NaN }),
);

// ───────────────────────── equal highs / equal lows (liquidity pools) ─────────────────────────

export interface EqualLevelParameters {
  /** Swing strength (bars on each side). Default 2. */
  strength?: number;
  /** Max fractional distance between consecutive swings to count as "equal". Default 0.001 (0.1%). */
  tolerance?: number;
}
export interface EqualLevelPoint {
  /** 1 when the swing confirmed on this bar matches the prior swing within tolerance, else 0. */
  detected: number;
  /** The (averaged) equal level when detected, else `null`. */
  level: number | null;
  /** Size of the current equal cluster (≥2 when detected, else 0). */
  count: number;
}

class EqualLevelStream implements IndicatorStream<BarInput, EqualLevelPoint> {
  private tracker: SwingTracker;
  private prev: number | null = null;
  private cluster = 1;
  value: EqualLevelPoint | null = null;
  constructor(
    strength: number,
    private readonly tolerance: number,
    private readonly high: boolean,
  ) {
    this.tracker = new SwingTracker(strength);
  }
  next(bar: BarInput): EqualLevelPoint | null {
    const r = this.tracker.push(bar);
    if (r === null) {
      this.value = null;
      return null;
    }
    const swing = this.high ? r.high : r.low;
    let detected = 0;
    let level: number | null = null;
    if (swing !== null) {
      if (
        this.prev !== null &&
        Math.abs(swing - this.prev) <= this.tolerance * Math.abs(this.prev)
      ) {
        this.cluster += 1;
        detected = 1;
        level = (swing + this.prev) / 2;
      } else {
        this.cluster = 1;
      }
      this.prev = swing;
    }
    this.value = { detected, level, count: detected ? this.cluster : 0 };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    // `high` is NOT serialized: it already IS the kind above, and a snapshot that disagreed with its
    // own kind would restore as whichever one the factory was bound to.
    return snapshotOf(this.high ? 'equalHighs' : 'equalLows', {
      tolerance: this.tolerance,
      tracker: this.tracker.toJSON(),
      prev: this.prev,
      cluster: this.cluster,
      value: this.value,
    });
  }
  static restore(high: boolean) {
    return (s: TechnicalAnalysisSnapshot): EqualLevelStream => {
      const state = readSnapshot(s, high ? 'equalHighs' : 'equalLows');
      const x = new EqualLevelStream(1, state.number('tolerance'), high);
      x.tracker = SwingTracker.fromJSON(state.child('tracker'));
      x.prev = state.numberOrNull('prev');
      x.cluster = state.number('cluster');
      x.value = state.cached<EqualLevelPoint>('value');
      return x;
    };
  }
}

const equalLevel = (high: boolean, functionName: string) =>
  makeIndicator<EqualLevelParameters, BarInput, EqualLevelPoint>(
    (p) =>
      new EqualLevelStream(
        requirePeriod(p.strength ?? 2, functionName, 'strength'),
        requireInRange(p.tolerance ?? 0.001, functionName, 'tolerance', 0, Infinity),
        high,
      ),
    EqualLevelStream.restore(high),
    () => ({ detected: NaN, level: NaN, count: NaN }),
  );

/** Equal highs — consecutive swing highs within `tolerance` (a buy-side liquidity pool). */
export const equalHighs = equalLevel(true, 'equalHighs');
/** Equal lows — consecutive swing lows within `tolerance` (a sell-side liquidity pool). */
export const equalLows = equalLevel(false, 'equalLows');
