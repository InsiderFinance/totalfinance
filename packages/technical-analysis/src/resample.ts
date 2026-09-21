/**
 * Multi-timeframe resampling and no-lookahead alignment (spec §13, WS6.2).
 *
 * `resample` aggregates timestamped bars into a higher timeframe on EPOCH-ALIGNED buckets
 * (`bucketStart = floor(ts / intervalMs) * intervalMs`). `alignToBars` projects a higher-timeframe
 * (HTF) series onto a lower-timeframe (LTF) index with a strictly-causal step-hold: an LTF bar only
 * ever sees an HTF bar whose bucket has already CLOSED, so the classic `request.security` repaint /
 * lookahead trap is structurally impossible.
 *
 * LIMITATION (documented, intentional): only epoch-aligned buckets are supported. Session-anchored
 * resampling (buckets that start at an exchange's session open rather than the Unix epoch) is NOT
 * included here.
 */

import {
  ErrorCode,
  InputError,
  ensureFinite,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import { requireBooleanWhenPresent } from './validate.js';

/** A timestamped OHLCV bar (ms since the Unix epoch). */
export interface TimeBar {
  /** Bar timestamp in milliseconds since the Unix epoch. */
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Traded volume; treated as 0 when absent. */
  volume?: number;
}

/** A resampled higher-timeframe bar: OHLCV plus the bucket VWAP and a forming-bucket flag. */
export interface ResampledBar {
  /** Bucket start (`floor(ts / intervalMs) * intervalMs`), ms since the epoch. */
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Summed volume over the bucket. */
  volume: number;
  /** Volume-weighted average of the typical price `(h+l+c)/3`; the last typical price if volume is 0. */
  vwap: number;
  /** `true` for the still-forming final bucket (only emitted with `includePartial: true`). */
  partial: boolean;
}

/** Named timeframes, or a raw millisecond interval. */
export type ResampleInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | number;

const INTERVAL_MS: Record<Exclude<ResampleInterval, number>, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

const NAMED = Object.keys(INTERVAL_MS) as Array<Exclude<ResampleInterval, number>>;

/** Resolve a timeframe to milliseconds, rejecting unknown names and non-positive numbers. */
function intervalToMs(interval: ResampleInterval, functionName: string): number {
  if (typeof interval === 'number') {
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new InputError(
        `${functionName}: a numeric interval must be a positive number of ms, got ${interval}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { interval },
        },
      );
    }
    return interval;
  }
  const ms = INTERVAL_MS[interval];
  if (ms === undefined) {
    throw new InputError(
      `${functionName}: unknown interval "${interval}"; use one of ${NAMED.join(', ')} or a ms number.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { interval, valid: NAMED },
      },
    );
  }
  return ms;
}

export interface ResampleOptions {
  /** Emit the final, still-forming bucket (flagged `partial: true`). Default `false`. */
  includePartial?: boolean;
}
const RESAMPLE_OPTS_KEYS = ['includePartial'] as const;

interface Bucket {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Σ(typicalPrice · volume) over the bucket, for the VWAP. */
  pv: number;
  /** The most recent typical price, used as the VWAP fallback when the bucket has zero volume. */
  lastTypical: number;
}

/**
 * Validate a single OHLCV bar (finite prices, `high ≥ low`, non-negative finite volume). A non-finite
 * price would silently poison the bucket's max-high/min-low/close aggregates with NaN under an
 * otherwise-successful return (design law #4 — no silent degradation).
 */
function validateBar(bar: TimeBar, i: number, functionName: string): void {
  ensureFinite(bar.timestampMs, `bars[${i}].timestampMs`, functionName);
  ensureFinite(bar.open, `bars[${i}].open`, functionName);
  ensureFinite(bar.high, `bars[${i}].high`, functionName);
  ensureFinite(bar.low, `bars[${i}].low`, functionName);
  ensureFinite(bar.close, `bars[${i}].close`, functionName);
  if (bar.high < bar.low) {
    throw new InputError(`${functionName}: bars[${i}] has high < low (${bar.high} < ${bar.low}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { index: i, high: bar.high, low: bar.low },
    });
  }
  if (bar.volume !== undefined && (!Number.isFinite(bar.volume) || bar.volume < 0)) {
    throw new InputError(
      `${functionName}: bars[${i}].volume must be a non-negative finite number, got ${bar.volume}.`,
      { code: ErrorCode.InputOutOfRange, context: { index: i, volume: bar.volume } },
    );
  }
}

function finalize(b: Bucket, partial: boolean): ResampledBar {
  const vwap = b.volume > 0 ? b.pv / b.volume : b.lastTypical;
  return {
    timestampMs: b.start,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    vwap,
    partial,
  };
}

/**
 * Resample ascending timestamped bars to a higher timeframe on epoch-aligned buckets. OHLC =
 * first-open / max-high / min-low / last-close; volume is summed; VWAP is volume-weighted over the
 * bucket's typical prices. Only COMPLETED buckets are emitted by default — the final (forming) bucket
 * is emitted only with `{ includePartial: true }` and flagged `partial: true`. Bars must be ascending
 * by `timestampMs` (throws otherwise).
 */
export function resample(
  bars: ArrayLike<TimeBar>,
  interval: ResampleInterval,
  options: ResampleOptions = {},
): ResampledBar[] {
  const functionName = 'resample';
  requireArgumentArray(functionName, 'bars', bars);
  requireArgumentObject(functionName, 'options', options);
  // Law 12: an unknown option (an `includePartials` typo) teaches instead of being silently ignored.
  ensureKnownKeys(functionName, 'options', options, RESAMPLE_OPTS_KEYS);
  const intervalMs = intervalToMs(interval, functionName);
  requireBooleanWhenPresent(options.includePartial, 'resample', 'includePartial');
  const includePartial = options.includePartial ?? false;
  const n = bars.length;
  const out: ResampledBar[] = [];
  let cur: Bucket | null = null;
  let prevTs = -Infinity;

  for (let i = 0; i < n; i++) {
    const bar = bars[i]!;
    validateBar(bar, i, functionName);
    if (bar.timestampMs < prevTs) {
      throw new InputError(
        `${functionName}: bars must be ascending by timestampMs (bars[${i}].timestampMs < bars[${i - 1}].timestampMs).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { index: i, timestampMs: bar.timestampMs, prevTs },
        },
      );
    }
    prevTs = bar.timestampMs;
    const start = Math.floor(bar.timestampMs / intervalMs) * intervalMs;
    const volume = bar.volume ?? 0;
    const typical = (bar.high + bar.low + bar.close) / 3;

    if (cur === null || start !== cur.start) {
      // A new bucket opened; the previous one is complete.
      if (cur !== null) out.push(finalize(cur, false));
      cur = {
        start,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume,
        pv: typical * volume,
        lastTypical: typical,
      };
    } else {
      cur.high = Math.max(cur.high, bar.high);
      cur.low = Math.min(cur.low, bar.low);
      cur.close = bar.close;
      cur.volume += volume;
      cur.pv += typical * volume;
      cur.lastTypical = typical;
    }
  }

  // The last bucket present in the input is the still-forming one — emit it only on request.
  if (cur !== null && includePartial) out.push(finalize(cur, true));
  return out;
}

export interface AlignOptions {
  /** The HTF bucket width in ms. Defaults to the smallest positive gap between consecutive HTF bars. */
  intervalMs?: number;
}
export interface AlignToBarsInput {
  higherSeries: ArrayLike<number>;
  higherBars: ArrayLike<TimeBar>;
  lowerBars: ArrayLike<TimeBar>;
  options?: AlignOptions;
}
const ALIGN_OPTS_KEYS = ['intervalMs'] as const;

/** Infer the HTF bucket width from the smallest positive gap between consecutive bar timestamps. */
function inferIntervalMs(higherBars: ArrayLike<TimeBar>): number {
  let smallestGapMs = Infinity;
  for (let j = 1; j < higherBars.length; j++) {
    const gap = higherBars[j]!.timestampMs - higherBars[j - 1]!.timestampMs;
    if (gap > 0 && gap < smallestGapMs) smallestGapMs = gap;
  }
  return smallestGapMs; // Infinity when there are fewer than two bars: no bucket ever "closes".
}

/**
 * Project a higher-timeframe series onto a lower-timeframe bar index, strictly causally (spec §13,
 * WS6.2). `higherSeries[j]` is a value computed on `higherBars[j]`, whose bucket `[ts, ts + iv)` is
 * usable only once it has CLOSED, i.e. at LTF times `≥ higherBars[j].timestampMs + intervalMs`. The LTF value at bar `i`
 * is a step-hold of the last HTF bar that has closed by `lowerBars[i].timestampMs`; it is `NaN` before the
 * first HTF bucket closes. No LTF output ever depends on an unclosed HTF bar — the `request.security`
 * lookahead is impossible by construction.
 *
 * `higherBars` must be ascending by `timestampMs`. The interval is `options.intervalMs` if given, else inferred as the
 * smallest positive gap between consecutive HTF bars (with a single HTF bar and no `intervalMs`, the
 * bar never becomes usable and every output is `NaN`).
 */
export function alignToBars(input: AlignToBarsInput): number[] {
  requireArgumentObject('alignToBars', 'input', input);
  ensureKnownKeys('alignToBars', 'input', input, [
    'higherSeries',
    'higherBars',
    'lowerBars',
    'options',
  ]);
  const { higherSeries, higherBars, lowerBars, options: options = {} } = input;
  requireArgumentArray('alignToBars', 'higherBars', higherBars);
  requireArgumentArray('alignToBars', 'higherSeries', higherSeries);
  requireArgumentArray('alignToBars', 'lowerBars', lowerBars);
  requireArgumentObject('alignToBars', 'options', options);
  ensureKnownKeys('alignToBars', 'options', options, ALIGN_OPTS_KEYS);
  const functionName = 'alignToBars';
  const hn = higherBars.length;
  if (higherSeries.length !== hn) {
    throw new InputError(
      `${functionName}: higherSeries and higherBars must have equal length (${higherSeries.length} vs ${hn}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { series: higherSeries.length, bars: hn },
      },
    );
  }
  for (let j = 0; j < hn; j++) {
    ensureFinite(higherBars[j]!.timestampMs, `higherBars[${j}].timestampMs`, functionName);
    if (j > 0 && higherBars[j]!.timestampMs < higherBars[j - 1]!.timestampMs) {
      throw new InputError(`${functionName}: higherBars must be ascending by timestampMs.`, {
        code: ErrorCode.InputOutOfRange,
        context: { index: j },
      });
    }
  }
  // The LTF index must be ascending too: the causal step-hold contract assumes a time-ordered lower
  // series, and an out-of-order LTF bar signals bad data rather than a meaningful query point.
  for (let i = 0; i < lowerBars.length; i++) {
    ensureFinite(lowerBars[i]!.timestampMs, `lowerBars[${i}].timestampMs`, functionName);
    if (i > 0 && lowerBars[i]!.timestampMs < lowerBars[i - 1]!.timestampMs) {
      throw new InputError(`${functionName}: lowerBars must be ascending by timestampMs.`, {
        code: ErrorCode.InputOutOfRange,
        context: { index: i },
      });
    }
  }
  const intervalMs = options.intervalMs ?? inferIntervalMs(higherBars);
  if (options.intervalMs !== undefined && !(options.intervalMs > 0)) {
    throw new InputError(
      `${functionName}: intervalMs must be positive, got ${options.intervalMs}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { intervalMs: options.intervalMs },
      },
    );
  }

  const ln = lowerBars.length;
  const out = new Array<number>(ln);
  for (let i = 0; i < ln; i++) {
    const lts = lowerBars[i]!.timestampMs;
    // Largest j with bucketEnd(j) = higherBars[j].ts + iv ≤ lts  ⟺  higherBars[j].ts ≤ lts − iv.
    // bucketEnd is ascending in j (bars ascending), so binary-search the rightmost qualifying bar.
    const target = lts - intervalMs;
    let lo = 0;
    let hi = hn - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (higherBars[mid]!.timestampMs <= target) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    out[i] = ans >= 0 ? higherSeries[ans]! : NaN;
  }
  return out;
}
