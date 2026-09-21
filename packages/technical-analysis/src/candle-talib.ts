/**
 * TA-Lib-compatible **adaptive** candlestick engine (spec §13.4).
 *
 * TotalFinance's default candlestick detectors (`candlesticks.ts`) use *fixed* body/shadow ratios and a
 * 0/1 presence flag — fast, deterministic, and stable across instruments. TA-Lib instead uses
 * *adaptive* thresholds: each "is this body long / this shadow short / …" test compares against a
 * **trailing average** of the relevant range over the preceding N bars (its `TA_SetCandleSettings`),
 * and emits a signed ±100 (occasionally ±200). This module reproduces that engine exactly, so callers
 * who need bit-for-bit TA-Lib candlestick output can opt into it.
 *
 * The default settings below mirror TA-Lib's `TA_RestoreCandleDefaultSettings` (range type, average
 * period, factor). `candleAverage` is the adaptive threshold; the pattern functions apply TA-Lib's
 * exact comparison logic. Verified against the TA-Lib 0.6.x golden for the implemented patterns.
 */

import {
  requireArgumentArray,
  requireArgumentObject,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  requireFiniteFields,
  ErrorCode,
  InputError,
} from '@totalfinance/core';
import type { BarInput } from './framework.js';
import { requireNonNegative, requireOneOf, requirePeriod } from './validate.js';

export type CandleRangeType = 'realBody' | 'highLow' | 'shadows';
export interface CandleSetting {
  range: CandleRangeType;
  /** Trailing-average period; 0 means "use the current bar's range" (no averaging). */
  averagePeriod: number;
  factor: number;
}
const CANDLE_SETTING_KEYS = ['range', 'averagePeriod', 'factor'] as const;
const CANDLE_RANGE_TYPES = [
  'realBody',
  'highLow',
  'shadows',
] as const satisfies readonly CandleRangeType[];

/** TA-Lib default candle settings (`TA_RestoreCandleDefaultSettings`). */
export const CANDLE_SETTINGS = {
  bodyLong: { range: 'realBody', averagePeriod: 10, factor: 1.0 },
  bodyVeryLong: { range: 'realBody', averagePeriod: 10, factor: 3.0 },
  bodyShort: { range: 'realBody', averagePeriod: 10, factor: 1.0 },
  bodyDoji: { range: 'highLow', averagePeriod: 10, factor: 0.1 },
  shadowLong: { range: 'realBody', averagePeriod: 0, factor: 1.0 },
  shadowVeryLong: { range: 'realBody', averagePeriod: 0, factor: 3.0 },
  shadowShort: { range: 'shadows', averagePeriod: 10, factor: 1.0 },
  shadowVeryShort: { range: 'highLow', averagePeriod: 10, factor: 0.1 },
  near: { range: 'highLow', averagePeriod: 5, factor: 0.2 },
  far: { range: 'highLow', averagePeriod: 5, factor: 0.6 },
  equal: { range: 'highLow', averagePeriod: 5, factor: 0.05 },
} as const satisfies Record<string, CandleSetting>;

export type CandleSettingName = keyof typeof CANDLE_SETTINGS;

/** Open, falling back to the close for openless bars (so realBody = 0 ⇒ treated as a doji). */
const openOf = (bar: BarInput): number => bar.open ?? bar.close;
const realBody = (bar: BarInput): number => Math.abs(bar.close - openOf(bar));
const highLow = (bar: BarInput): number => bar.high - bar.low;
const upperShadow = (bar: BarInput): number => bar.high - Math.max(openOf(bar), bar.close);
const lowerShadow = (bar: BarInput): number => Math.min(openOf(bar), bar.close) - bar.low;
const shadows = (bar: BarInput): number => upperShadow(bar) + lowerShadow(bar);
/** Candle color: +1 white (close ≥ open), −1 black. */
export const candleColor = (bar: BarInput): number => {
  requireArgumentObject('candleColor', 'bar', bar);
  // Color reads close and (when present) open — a bar missing close must teach, never report -1.
  requireFiniteFields('candleColor', bar, ['close'], {
    exampleCall: 'candleColor({ open: 10, high: 11, low: 9, close: 10.5 })',
  });
  ensureFiniteWhenPresent((bar as { open?: unknown }).open, 'open', 'candleColor');
  return bar.close >= openOf(bar) ? 1 : -1;
};

function rangeOf(b: BarInput, type: CandleRangeType): number {
  return type === 'realBody' ? realBody(b) : type === 'highLow' ? highLow(b) : shadows(b);
}

/**
 * TA-Lib's `TA_CANDLEAVERAGE` at every bar: `factor · (avg of `range` over the preceding `averagePeriod`
 * bars) / denom`, where `denom = 2` for the Shadows range type (it sums two shadows) else `1`. With
 * `averagePeriod = 0` the current bar's own range is used. Bars before the trailing window is full get
 * `NaN` (the pattern is in its lookback there).
 */
export function candleAverage(bars: ArrayLike<BarInput>, setting: CandleSetting): number[] {
  requireArgumentObject('candleAverage', 'setting', setting);
  // Law 12: an unknown field (an `avgperiod` typo) teaches instead of being silently ignored.
  ensureKnownKeys('candleAverage', 'setting', setting, CANDLE_SETTING_KEYS);
  requireArgumentArray('candleAverage', 'bars', bars);
  const { range, averagePeriod, factor } = setting;
  // Every consumed field runs its ladder: an omitted or null averagePeriod used to yield an
  // all-NaN column instead of teaching (first-touch law).
  requireOneOf(range, CANDLE_RANGE_TYPES, 'candleAverage', 'setting.range');
  // Zero selects TA-Lib's current-bar rule; positive values are lookbacks and share the package's
  // one-million-bar safety ceiling instead of accepting a nonsensical multi-billion-bar window.
  requirePeriod(averagePeriod, 'candleAverage', 'setting.averagePeriod', 0, 'bars');
  requireNonNegative(factor, 'candleAverage', 'setting.factor');
  const denom = range === 'shadows' ? 2 : 1;
  const out = new Array<number>(bars.length).fill(NaN);
  if (averagePeriod === 0) {
    for (let i = 0; i < bars.length; i++) out[i] = (factor * rangeOf(bars[i]!, range)) / denom;
    return out;
  }
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i >= averagePeriod) {
      // trailing window covers [i-averagePeriod, i-1]
      out[i] = (factor * (sum / averagePeriod)) / denom;
      sum -= rangeOf(bars[i - averagePeriod]!, range);
    }
    sum += rangeOf(bars[i]!, range);
  }
  return out;
}

const setting = (name: CandleSettingName): CandleSetting => CANDLE_SETTINGS[name];

/**
 * CDLDOJI (TA-Lib): +100 when the real body is no larger than `BodyDoji`'s adaptive threshold (a
 * fraction of the trailing high-low average), else 0. Doji is non-directional, so it is never −100.
 */
export function cdlDojiTalib(bars: ArrayLike<BarInput>): number[] {
  requireArgumentArray('cdlDojiTalib', 'bars', bars);
  const avg = candleAverage(bars, setting('bodyDoji'));
  const out = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isNaN(avg[i]!)) continue;
    if (realBody(bars[i]!) <= avg[i]!) out[i] = 100;
  }
  return out;
}

/**
 * CDLMARUBOZU (TA-Lib): a long real body (`BodyLong`) with both shadows shorter than the
 * `ShadowVeryShort` threshold → ±100 by candle color (white +100, black −100), else 0.
 */
export function cdlMarubozuTalib(bars: ArrayLike<BarInput>): number[] {
  requireArgumentArray('cdlMarubozuTalib', 'bars', bars);
  const bodyLong = candleAverage(bars, setting('bodyLong'));
  const svs = candleAverage(bars, setting('shadowVeryShort'));
  const out = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isNaN(bodyLong[i]!) || Number.isNaN(svs[i]!)) continue;
    const b = bars[i]!;
    if (realBody(b) > bodyLong[i]! && upperShadow(b) < svs[i]! && lowerShadow(b) < svs[i]!) {
      out[i] = candleColor(b) * 100;
    }
  }
  return out;
}

/**
 * CDLCLOSINGMARUBOZU (TA-Lib): a long real body where the shadow on the *close* side is shorter than
 * `ShadowVeryShort` (the open-side shadow is unconstrained) → ±100 by color, else 0.
 */
export function cdlClosingMarubozuTalib(bars: ArrayLike<BarInput>): number[] {
  requireArgumentArray('cdlClosingMarubozuTalib', 'bars', bars);
  const bodyLong = candleAverage(bars, setting('bodyLong'));
  const svs = candleAverage(bars, setting('shadowVeryShort'));
  const out = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    if (Number.isNaN(bodyLong[i]!) || Number.isNaN(svs[i]!)) continue;
    const b = bars[i]!;
    if (realBody(b) > bodyLong[i]!) {
      const closeSideShadow = candleColor(b) === 1 ? upperShadow(b) : lowerShadow(b);
      if (closeSideShadow < svs[i]!) out[i] = candleColor(b) * 100;
    }
  }
  return out;
}

const PATTERNS: Record<string, (bars: ArrayLike<BarInput>) => number[]> = {
  doji: cdlDojiTalib,
  marubozu: cdlMarubozuTalib,
  closingMarubozu: cdlClosingMarubozuTalib,
};

/** Pattern names implemented with exact TA-Lib adaptive parity in this module. */
export const TALIB_CANDLE_NAMES = Object.keys(PATTERNS);

/** Case-insensitive lookup (so `CDLDOJI`, `cdl_doji`, `doji`, `closingMarubozu` all resolve). */
const BY_LOWER: Record<string, (bars: ArrayLike<BarInput>) => number[]> = {};
for (const [k, v] of Object.entries(PATTERNS)) BY_LOWER[k.toLowerCase()] = v;

/**
 * Run an adaptive TA-Lib candlestick pattern by name (camelCase or `CDL*`), returning the ±100/0
 * series. Throws for patterns not yet ported to the adaptive engine (use the fixed-ratio detectors in
 * `candlesticks.ts` for those — see `TALIB_CANDLE_NAMES` for what's available here).
 */
export function talibCandle(name: string, bars: ArrayLike<BarInput>): number[] {
  if (typeof name !== 'string') {
    throw new InputError(
      `talibCandle: name must be an indicator name string, got ${name === null ? 'null' : typeof name}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {},
      },
    );
  }
  const key = name.toLowerCase().replace(/^cdl_?/, '');
  const fn = BY_LOWER[key];
  if (!fn) {
    throw new InputError(
      `talibCandle: pattern "${name}" is not implemented in the adaptive engine. ` +
        `Available: ${TALIB_CANDLE_NAMES.join(', ')} (the fixed-ratio detectors in candlesticks cover the rest).`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { name, valid: [...TALIB_CANDLE_NAMES] },
      },
    );
  }
  return fn(bars);
}
