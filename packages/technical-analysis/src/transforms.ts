/**
 * Price transforms and candle geometry (spec §13.3 Transforms).
 *
 * These are the building blocks the rest of the catalog composes on: typical / median / weighted /
 * average price, candle body & shadow & range geometry, true range, gaps, and the Heikin-Ashi
 * transform. Each is exposed as a framework indicator (aligned batch + serializable stream) so it
 * drops straight into pipelines and the registry. Stateless transforms emit from the first bar
 * (`warmup = 0`); `gap` needs a prior bar (`warmup = 1`).
 *
 * `open` defaults to `close` when a bar omits it — some feeds carry only HLC.
 */

import {
  ensureFinite,
  ensureFiniteWhenPresent,
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
import { requireStreamParameters } from './stream-validation.js';

type Empty = Record<never, never>;

// ---- single-bar pure helpers (the math, shared with candlesticks / price-action) ----

function openOf(bar: BarInput): number {
  return bar.open ?? bar.close;
}
function tpOf(bar: BarInput): number {
  return (bar.high + bar.low + bar.close) / 3;
}
function mpOf(bar: BarInput): number {
  return (bar.high + bar.low) / 2;
}
function wcOf(bar: BarInput): number {
  return (bar.high + bar.low + 2 * bar.close) / 4;
}
function apOf(bar: BarInput): number {
  return (openOf(bar) + bar.high + bar.low + bar.close) / 4;
}
/** Signed real body: positive when the candle closes above its open. */
function bodyOf(bar: BarInput): number {
  return bar.close - openOf(bar);
}
function upperShadowOf(bar: BarInput): number {
  return bar.high - Math.max(openOf(bar), bar.close);
}
function lowerShadowOf(bar: BarInput): number {
  return Math.min(openOf(bar), bar.close) - bar.low;
}
function rangeOf(bar: BarInput): number {
  return bar.high - bar.low;
}
/**
 * `trueRange` is the one accessor with a second, POSITIONAL argument, and it is a price like the
 * others — an omitted `previousClose` made every comparison against `undefined` false and returned
 * `high - low`, a plain range wearing the name of a true range. Silently the wrong indicator.
 */
function guardedTrueRange(bar: BarInput, previousClose: number): number {
  ensureFinite(previousClose, 'previousClose', 'bar.trueRange');
  return trueRangeOf(bar, previousClose);
}

function trueRangeOf(bar: BarInput, previousClose: number): number {
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - previousClose),
    Math.abs(bar.low - previousClose),
  );
}

/**
 * Single-bar transform helpers, grouped for reuse by the candlestick and price-action modules.
 * Pure functions over one bar (and, for `trueRange`, the prior close).
 */
/**
 * Built PER ACCESSOR from the fields that accessor actually requires.
 *
 * Every `bar.*` method shared one constant naming `bar.typical`, so nine of them answered a missing
 * field with a worked call to a tenth. The example also listed fields the failing accessor does not
 * take — `bar.range` needs `high`/`low`, not `open`/`close` — which turns a correction into a second
 * puzzle. Deriving it from `(name, fields)` keeps the example true by construction.
 */
const BAR_FIELD_VALUES: Record<string, number> = {
  open: 100,
  high: 101.5,
  low: 99.5,
  close: 100.8,
  volume: 1_000,
};

function barExampleCall(functionName: string, fields: readonly string[]): string {
  const shown = fields.length > 0 ? fields : ['high', 'low', 'close'];
  const body = shown.map((f) => `${f}: ${BAR_FIELD_VALUES[f] ?? 1}`).join(', ');
  return `${functionName}({ ${body} })`;
}

const BAR_HINTS: Record<string, string> = {
  open: 'optional — falls back to close when a feed carries only HLC',
};

/**
 * Guard one single-bar accessor: the input must be a bar object carrying the fields THIS accessor
 * actually reads (first-touch law).
 *
 * The per-accessor field list is not decoration. `bar.range` reads `high`/`low` and `bar.body` reads
 * `close`; requiring a uniform OHLC everywhere would reject bars that are perfectly valid for the
 * accessor being called. `open` is never required by any of them — every helper reads it as
 * `bar.open ?? bar.close`, so a bar without one is a documented shape, not a defect. It is still
 * type-checked WHEN PRESENT, because a present-but-garbage `open` silently wins over that fallback.
 *
 * The streaming facades (`typicalPrice`, `realBody`, …) deliberately bypass this and call the raw
 * helpers: those validate their series once at the boundary and then run per bar.
 */
function guardedBar<A extends unknown[], R>(
  name: string,
  fields: readonly string[],
  fn: (bar: BarInput, ...rest: A) => R,
): (bar: BarInput, ...rest: A) => R {
  return (bar: BarInput, ...rest: A): R => {
    const functionName = `bar.${name}`;
    requireArgumentObject(functionName, 'bar', bar);
    requireFiniteFields(functionName, bar, fields, {
      exampleCall: () => barExampleCall(functionName, fields),
      hints: BAR_HINTS,
    });
    // `open` is OPTIONAL (it falls back to `close`), but a present-and-garbage one wins over that
    // fallback — so it runs the same ladder a required field does, and a string reports `wrong_type`.
    ensureFiniteWhenPresent((bar as { open?: unknown }).open, 'open', functionName);
    return fn(bar, ...rest);
  };
}

const HL = ['high', 'low'] as const;
const HLC = ['high', 'low', 'close'] as const;

export const bar = {
  // `openOf` falls back to `close`, so `close` is what it truly requires.
  open: guardedBar('open', ['close'], openOf),
  typical: guardedBar('typical', HLC, tpOf),
  median: guardedBar('median', HL, mpOf),
  weighted: guardedBar('weighted', HLC, wcOf),
  average: guardedBar('average', HLC, apOf),
  body: guardedBar('body', ['close'], bodyOf),
  upperShadow: guardedBar('upperShadow', ['high', 'close'], upperShadowOf),
  lowerShadow: guardedBar('lowerShadow', ['low', 'close'], lowerShadowOf),
  range: guardedBar('range', HL, rangeOf),
  trueRange: guardedBar('trueRange', HL, guardedTrueRange),
} as const;

// ---- stateless per-bar indicator facades ----

class MapBarStream implements IndicatorStream<BarInput, number> {
  value: number | null = null;
  private readonly kind: string;
  private readonly project: (bar: BarInput) => number;
  constructor(parameters: { kind: string; project: (bar: BarInput) => number }) {
    requireStreamParameters('MapBarStream.constructor#0', 'MapBarStream', parameters);
    const { kind, project } = parameters;
    this.kind = kind;
    this.project = project;
  }
  next(bar: BarInput): number | null {
    this.value = this.project(bar);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(this.kind, { value: this.value });
  }
}

function statelessBar(kind: string, fn: (bar: BarInput) => number) {
  return makeIndicator<Empty, BarInput, number>(
    () => new MapBarStream({ kind, project: fn }),
    (s) => {
      const state = readSnapshot(s, kind);
      const x = new MapBarStream({ kind, project: fn });
      x.value = state.cached<number>('value');
      return x;
    },
    () => NaN,
  );
}

export const typicalPrice = statelessBar('typicalPrice', tpOf);
export const medianPrice = statelessBar('medianPrice', mpOf);
export const weightedClose = statelessBar('weightedClose', wcOf);
export const averagePrice = statelessBar('averagePrice', apOf);
export const realBody = statelessBar('realBody', bodyOf);
export const upperShadow = statelessBar('upperShadow', upperShadowOf);
export const lowerShadow = statelessBar('lowerShadow', lowerShadowOf);
export const candleRange = statelessBar('candleRange', rangeOf);

// ---- true range (needs the prior close; emits from the first bar) ----

class TrueRangeStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  value: number | null = null;
  next(bar: BarInput): number | null {
    const tr =
      this.previousClose === null ? bar.high - bar.low : trueRangeOf(bar, this.previousClose);
    this.previousClose = bar.close;
    this.value = tr;
    return tr;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('trueRange', { previousClose: this.previousClose, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): TrueRangeStream {
    const state = readSnapshot(snapshot, 'trueRange');
    const x = new TrueRangeStream();
    x.previousClose = state.numberOrNull('previousClose');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const trueRange = makeIndicator<Empty, BarInput, number>(
  () => new TrueRangeStream(),
  TrueRangeStream.fromJSON,
  () => NaN,
);

// ---- gap (open minus prior close; warmup 1) ----

class GapStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  value: number | null = null;
  next(bar: BarInput): number | null {
    if (this.previousClose === null) {
      this.previousClose = bar.close;
      this.value = null;
      return null;
    }
    const g = openOf(bar) - this.previousClose;
    this.previousClose = bar.close;
    this.value = g;
    return g;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('gap', { previousClose: this.previousClose, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): GapStream {
    const state = readSnapshot(snapshot, 'gap');
    const x = new GapStream();
    x.previousClose = state.numberOrNull('previousClose');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const gap = makeIndicator<Empty, BarInput, number>(
  () => new GapStream(),
  GapStream.fromJSON,
  () => NaN,
);

// ---- Heikin-Ashi (smoothed candles; also re-exported by chart-types) ----

export interface HeikinAshiBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

class HeikinAshiStream implements IndicatorStream<BarInput, HeikinAshiBar> {
  private prevOpen: number | null = null;
  private previousClose = 0;
  value: HeikinAshiBar | null = null;
  next(bar: BarInput): HeikinAshiBar | null {
    const haClose = (openOf(bar) + bar.high + bar.low + bar.close) / 4;
    const haOpen =
      this.prevOpen === null
        ? (openOf(bar) + bar.close) / 2
        : (this.prevOpen + this.previousClose) / 2;
    const haHigh = Math.max(bar.high, haOpen, haClose);
    const haLow = Math.min(bar.low, haOpen, haClose);
    this.prevOpen = haOpen;
    this.previousClose = haClose;
    this.value = { open: haOpen, high: haHigh, low: haLow, close: haClose };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('heikinAshi', {
      prevOpen: this.prevOpen,
      previousClose: this.previousClose,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): HeikinAshiStream {
    const state = readSnapshot(snapshot, 'heikinAshi');
    const x = new HeikinAshiStream();
    x.prevOpen = state.numberOrNull('prevOpen');
    x.previousClose = state.number('previousClose');
    x.value = state.cached<HeikinAshiBar>('value');
    return x;
  }
}

const nanHa = (): HeikinAshiBar => ({ open: NaN, high: NaN, low: NaN, close: NaN });

export const heikinAshi = makeIndicator<Empty, BarInput, HeikinAshiBar>(
  () => new HeikinAshiStream(),
  HeikinAshiStream.fromJSON,
  nanHa,
);

export { MapBarStream, TrueRangeStream, GapStream, HeikinAshiStream };
