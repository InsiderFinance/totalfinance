/**
 * Regular & hidden price/indicator divergence detection (spec §13, WS6.3).
 *
 * A divergence compares two consecutive CONFIRMED price swings against the indicator readings at
 * those swings:
 *   - regular bullish  — price lower-low  + indicator higher-low  (across two swing lows)
 *   - regular bearish  — price higher-high + indicator lower-high  (across two swing highs)
 *   - hidden  bullish  — price higher-low  + indicator lower-low   (across two swing lows)
 *   - hidden  bearish  — price lower-high  + indicator higher-high (across two swing highs)
 *
 * Swings are price fractals confirmed by a `{ left, right }` window: a pivot at bar `p` is a swing low
 * when its price is the strict minimum of `[p−left, p+right]`, confirmed only once the right window is
 * complete (at bar `p+right`). Events are therefore CAUSAL — emitted at the confirmation bar, with the
 * two swings referencing earlier bars — so truncating the input at the confirmation bar still yields
 * the event (no repaint). Batch is derived from the stream; the indicator is registered under
 * `price-action`.
 */

import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import type { Pair } from './statistics.js';

/** The four standard divergence classes. */
export type DivergenceKind = 'bullish' | 'bearish' | 'hiddenBullish' | 'hiddenBearish';

/**
 * Signed class code for the aligned/streaming {@link DivergencePoint}: sign is bullish(+)/bearish(−),
 * magnitude is regular(1)/hidden(2). `0` marks a confirmed-nothing bar; `NaN` marks warmup.
 */
export type DivergenceCode = 0 | 1 | -1 | 2 | -2;

const CODE_OF: Record<DivergenceKind, DivergenceCode> = {
  bullish: 1,
  bearish: -1,
  hiddenBullish: 2,
  hiddenBearish: -2,
};
/** The kind family, DERIVED from the code table so a fifth divergence cannot be added past it. */
const DIVERGENCE_KINDS = Object.keys(CODE_OF) as readonly DivergenceKind[];

const KIND_OF: Record<number, DivergenceKind> = {
  1: 'bullish',
  [-1]: 'bearish',
  2: 'hiddenBullish',
  [-2]: 'hiddenBearish',
};

/**
 * One aligned/streaming point. All fields are numeric (so warmup slots are cleanly all-`NaN`): the
 * friendly string `kind` lives on {@link DivergenceEvent}, the event-list shape. `code` is `0` when a
 * bar confirms no divergence and `NaN` during warmup.
 */
export interface DivergencePoint {
  /** Confirmation bar index (`NaN` when no divergence / warmup). */
  index: number;
  /** Signed class code (see {@link DivergenceCode}); `0` none, `NaN` warmup. */
  code: number;
  /** `[earlier-swing, confirming-swing]` price (`[NaN, NaN]` when none). */
  priceSwings: [number, number];
  /** `[earlier-swing, confirming-swing]` indicator value (`[NaN, NaN]` when none). */
  indicatorSwings: [number, number];
}

/** A confirmed divergence event (the point-list form returned by {@link divergences}). */
export interface DivergenceEvent {
  /** Confirmation bar index. */
  index: number;
  kind: DivergenceKind;
  /** `[earlier-swing, confirming-swing]` price. */
  priceSwings: [number, number];
  /** `[earlier-swing, confirming-swing]` indicator value. */
  indicatorSwings: [number, number];
}

/** Fractal confirmation window: `left` bars before and `right` bars after the pivot. */
export interface SwingWindow {
  /** Bars to the left of a pivot that must be higher/lower. Defaults to 5; echoed via `.explain()`. */
  left?: number;
  /** Bars to the right that confirm the pivot. Defaults to 5; echoed via `.explain()`. */
  right?: number;
}

export interface DivergenceParameters {
  /** Fractal confirmation window (default `{ left: 5, right: 5 }`). */
  swing?: SwingWindow;
  /** Which divergence classes to emit (default all four). */
  kinds?: DivergenceKind[];
}
const DIVERGENCE_KEYS = ['swing', 'kinds'] as const;
const SWING_KEYS = ['left', 'right'] as const;

const ALL_KINDS: readonly DivergenceKind[] = [
  'bullish',
  'bearish',
  'hiddenBullish',
  'hiddenBearish',
];

/** Warmup sentinel: all-`NaN`, so the framework treats it as an empty warmup slot. */
const nanPoint = (): DivergencePoint => ({
  index: NaN,
  code: NaN,
  priceSwings: [NaN, NaN],
  indicatorSwings: [NaN, NaN],
});
/** Post-warmup "confirmed nothing" point (`code: 0`), distinct from the warmup sentinel. */
const nonePoint = (): DivergencePoint => ({
  index: NaN,
  code: 0,
  priceSwings: [NaN, NaN],
  indicatorSwings: [NaN, NaN],
});

interface Swing {
  index: number;
  price: number;
  indicator: number;
}

/** Stateful divergence detector over `(price, indicator)` pairs (`{ x: price, y: indicator }`). */
class DivergenceStream implements IndicatorStream<Pair, DivergencePoint> {
  private readonly window: number;
  private readonly buf: Pair[] = [];
  private i = -1;
  private lastLow: Swing | null = null;
  private lastHigh: Swing | null = null;
  value: DivergencePoint | null = null;

  constructor(
    private readonly left: number,
    private readonly right: number,
    private readonly kinds: ReadonlySet<DivergenceKind>,
  ) {
    this.window = left + right + 1;
  }

  next(pair: Pair): DivergencePoint | null {
    this.i++;
    this.buf.push(pair);
    if (this.buf.length > this.window) this.buf.shift();
    if (this.buf.length < this.window) {
      // Warmup: not enough bars to confirm the pivot's right window yet.
      this.value = null;
      return null;
    }

    const pivot = this.buf[this.left]!;
    const pivotIndex = this.i - this.right;
    let isLow = true;
    let isHigh = true;
    for (let k = 0; k < this.window; k++) {
      if (k === this.left) continue;
      const x = this.buf[k]!.x;
      if (!(pivot.x < x)) isLow = false;
      if (!(pivot.x > x)) isHigh = false;
    }

    let out = nonePoint();
    if (isLow) out = this.onSwing('low', pivotIndex, pivot);
    else if (isHigh) out = this.onSwing('high', pivotIndex, pivot);
    this.value = out;
    return out;
  }

  private onSwing(side: 'low' | 'high', index: number, pivot: Pair): DivergencePoint {
    const prev = side === 'low' ? this.lastLow : this.lastHigh;
    const current: Swing = { index, price: pivot.x, indicator: pivot.y };
    let out = nonePoint();
    if (prev !== null) {
      const regular: DivergenceKind = side === 'low' ? 'bullish' : 'bearish';
      const hidden: DivergenceKind = side === 'low' ? 'hiddenBullish' : 'hiddenBearish';
      const priceLower = current.price < prev.price;
      const priceHigher = current.price > prev.price;
      const indLower = current.indicator < prev.indicator;
      const indHigher = current.indicator > prev.indicator;
      // Regular: price makes a new extreme the indicator fails to confirm.
      // Hidden: price pulls back but the indicator makes the new extreme (continuation).
      const regularHit = side === 'low' ? priceLower && indHigher : priceHigher && indLower;
      const hiddenHit = side === 'low' ? priceHigher && indLower : priceLower && indHigher;
      if (regularHit && this.kinds.has(regular)) out = this.event(regular, prev, current);
      else if (hiddenHit && this.kinds.has(hidden)) out = this.event(hidden, prev, current);
    }
    if (side === 'low') this.lastLow = current;
    else this.lastHigh = current;
    return out;
  }

  private event(kind: DivergenceKind, prev: Swing, current: Swing): DivergencePoint {
    return {
      index: this.i, // the confirmation bar
      code: CODE_OF[kind],
      priceSwings: [prev.price, current.price],
      indicatorSwings: [prev.indicator, current.indicator],
    };
  }

  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('divergence', {
      left: this.left,
      right: this.right,
      kinds: [...this.kinds],
      buf: this.buf.map((p) => ({ x: p.x, y: p.y })),
      i: this.i,
      lastLow: this.lastLow === null ? null : { ...this.lastLow },
      lastHigh: this.lastHigh === null ? null : { ...this.lastHigh },
      value: this.value === null ? null : { ...this.value },
    });
  }

  static fromJSON(snapshot: TechnicalAnalysisSnapshot): DivergenceStream {
    const state = readSnapshot(snapshot, 'divergence');
    const stream = new DivergenceStream(
      state.number('left'),
      state.number('right'),
      new Set(state.literals<DivergenceKind>('kinds', DIVERGENCE_KINDS)),
    );
    // No NaN revival here any more. This restorer used to carry three helpers whose whole job was
    // turning JSON's `null` back into the NaN the stream had actually stored — a local patch for a
    // library-wide loss. `snapshotOf` now encodes non-finite numbers at the serialization boundary,
    // so the accessors hand back exactly what was written, for every indicator rather than this one.
    stream.buf.push(...state.records<Pair>('buf').map((p) => ({ x: p.x, y: p.y })));
    stream.i = state.number('i');
    stream.lastLow = copySwing(state.recordOrNull<Swing>('lastLow'));
    stream.lastHigh = copySwing(state.recordOrNull<Swing>('lastHigh'));
    stream.value = state.cached<DivergencePoint>('value');
    return stream;
  }
}

/** Deep-copy a serialized swing so a restored stream never shares live state with the snapshot. */
function copySwing(raw: Swing | null): Swing | null {
  return raw === null ? null : { ...raw };
}

function resolveSwing(
  swing: SwingWindow | undefined,
  functionName: string,
): { left: number; right: number } {
  // A defined non-object swing (a string, an array, null) must never silently mean "defaults" —
  // null is a wrong-typed value, not a second spelling of omission (the 350c2796 ruling).
  if (
    swing !== undefined &&
    (swing === null || typeof swing !== 'object' || Array.isArray(swing))
  ) {
    throw new InputError(
      `${functionName}: swing must be an object of named fields — { left: 5, right: 5 }. Received ${swing === null ? 'null' : Array.isArray(swing) ? 'an array' : typeof swing}.`,
      { code: ErrorCode.InputWrongType, context: { swing, function: functionName } },
    );
  }
  // Law 12 on the nested window too: `{ lef: 3 }` silently falling back to the defaults is the bug.
  if (swing !== undefined) {
    ensureKnownKeys(functionName, 'swing', swing, SWING_KEYS);
  }
  // Null members must not coalesce into the defaults either — `?? 5` reads null as "use 5".
  for (const name of SWING_KEYS) {
    if (swing?.[name] === null) {
      throw new InputError(
        `${functionName}: swing.${name} must not be null — omit the field to use the default (5). Received null.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: `swing.${name}`, function: functionName },
        },
      );
    }
  }
  const left = swing?.left ?? 5;
  const right = swing?.right ?? 5;
  for (const [name, v] of [
    ['left', left],
    ['right', right],
  ] as const) {
    // Safe integer (2026-08-23 review, P0): swing windows are data-bounded (a window wider than the
    // series finds no pivots), but past 2^53 the "integer" width is no longer exact and the pivot
    // index arithmetic would silently drift.
    if (!Number.isSafeInteger(v) || v < 1) {
      throw new InputError(`${functionName}: swing.${name} must be a positive integer, got ${v}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { [name]: v },
      });
    }
  }
  return { left, right };
}

function resolveKinds(
  kinds: DivergenceKind[] | undefined,
  functionName: string,
): Set<DivergenceKind> {
  if (kinds !== undefined && !Array.isArray(kinds)) {
    throw new InputError(
      `${functionName}: kinds must be an array of divergence kinds when provided — omit the field to detect all four. Received ${kinds === null ? 'null' : typeof kinds}.`,
      { code: ErrorCode.InputWrongType, context: { kinds, function: functionName } },
    );
  }
  const list = kinds ?? ALL_KINDS;
  for (const k of list) {
    if (!ALL_KINDS.includes(k)) {
      throw new InputError(`${functionName}: unknown divergence kind "${k}".`, {
        code: ErrorCode.InputInvalidEnum,
        context: { kind: k, valid: ALL_KINDS },
      });
    }
  }
  return new Set(list);
}

function makeStream(parameters: DivergenceParameters): DivergenceStream {
  const functionName = 'divergence';
  const { left, right } = resolveSwing(parameters.swing, functionName);
  const kinds = resolveKinds(parameters.kinds, functionName);
  return new DivergenceStream(left, right, kinds);
}

/**
 * The `divergence` indicator (registry name `divergence`, category `price-action`): a streaming
 * price/indicator divergence detector. Input is a `{ x: price, y: indicator }` pair per bar; each bar
 * yields a numeric {@link DivergencePoint} (`code: 0` when nothing confirms). For the friendly
 * event-list form with string `kind`, use {@link divergences}.
 */
export const divergence = makeIndicator<DivergenceParameters, Pair, DivergencePoint>(
  makeStream,
  DivergenceStream.fromJSON,
  nanPoint,
  { swing: { left: 5, right: 5 }, kinds: [...ALL_KINDS] },
);

/**
 * Detect regular & hidden divergences between a `price` series and an `indicator` series, returning
 * the confirmed events as a list (batch derived from the stream). Each event's `index` is the
 * confirmation bar; the swings reference earlier bars.
 */
export interface DivergencesInput {
  price: ArrayLike<number>;
  indicator: ArrayLike<number>;
  parameters?: DivergenceParameters;
}

export function divergences(input: DivergencesInput): DivergenceEvent[] {
  requireArgumentObject('divergences', 'input', input);
  ensureKnownKeys('divergences', 'input', input, ['price', 'indicator', 'parameters']);
  const { price, indicator, parameters = {} } = input;
  requireArgumentArray('divergences', 'indicator', indicator);
  requireArgumentArray('divergences', 'price', price);
  requireArgumentObject('divergences', 'parameters', parameters);
  ensureKnownKeys('divergences', 'parameters', parameters, DIVERGENCE_KEYS);
  const functionName = 'divergences';
  if (price.length !== indicator.length) {
    throw new InputError(
      `${functionName}: price and indicator must have equal length (${price.length} vs ${indicator.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { price: price.length, indicator: indicator.length },
      },
    );
  }
  const { left, right } = resolveSwing(parameters.swing, functionName);
  const kinds = resolveKinds(parameters.kinds, functionName);
  const stream = new DivergenceStream(left, right, kinds);
  const out: DivergenceEvent[] = [];
  for (let i = 0; i < price.length; i++) {
    const point = stream.next({ x: price[i]!, y: indicator[i]! });
    if (point !== null && point.code !== 0 && Number.isFinite(point.code)) {
      out.push({
        index: point.index,
        kind: KIND_OF[point.code]!,
        priceSwings: point.priceSwings,
        indicatorSwings: point.indicatorSwings,
      });
    }
  }
  return out;
}
