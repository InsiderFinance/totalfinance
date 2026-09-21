/**
 * Candlestick pattern catalog (spec §13.3) — the full TA-Lib `CDL*` set.
 *
 * Each pattern is a serializable streaming indicator over `BarInput[]` that emits TA-Lib's signal
 * scale: `+100` bullish, `−100` bearish, `0` no pattern (and the NaN sentinel during warmup). The
 * shared `CandleView` provides TA-Lib's candle-average thresholds (body / range / shadow averages over
 * the trailing 10- or 5-bar window *before* the pattern), so "long body", "doji", "short shadow",
 * "near"/"equal" all scale to recent volatility exactly as TA-Lib's default candle settings do.
 *
 * Where TA-Lib's reference assigns a fixed bullish/bearish sign to a shape (hammer vs hanging-man,
 * inverted-hammer vs shooting-star), this catalog follows the same convention — the caller applies
 * trend context. Thresholds use TA-Lib's default factors (BodyLong 1×, BodyDoji 0.1×, Near 0.2×, …).
 */

import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import { requireArgumentArray } from '@totalfinance/core';
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

const BODY_AVG = 10;
const RANGE_AVG10 = 10;
const RANGE_AVG5 = 5;
const SHADOW_AVG = 10;

function bodyOf(bar: BarInput): number {
  return Math.abs(bar.close - (bar.open ?? bar.close));
}
function rangeOf(bar: BarInput): number {
  return bar.high - bar.low;
}
function upperOf(bar: BarInput): number {
  return bar.high - Math.max(bar.open ?? bar.close, bar.close);
}
function lowerOf(bar: BarInput): number {
  return Math.min(bar.open ?? bar.close, bar.close) - bar.low;
}

/**
 * A read-only view of the last `len + 10` bars positioned at the current bar, exposing geometry and
 * TA-Lib candle-average thresholds. `i` is an offset back from the current bar (0 = current,
 * 1 = previous, …); the pattern spans offsets `0 … len − 1`.
 */
export class CandleView {
  readonly bodyAverage: number;
  readonly rangeAverage10: number;
  readonly rangeAverage5: number;
  readonly shadowAverage: number;
  private readonly history: BarInput[];
  private readonly length: number;
  constructor(parameters: { history: BarInput[]; length: number }) {
    requireStreamParameters('CandleView.constructor#0', 'CandleView', parameters);
    const { history, length } = parameters;
    this.history = history;
    this.length = length;

    const n = history.length;
    // averages over the bars *before* the oldest pattern bar (offset `len` … back)
    const meanBack = (count: number, f: (bar: BarInput) => number): number => {
      let sum = 0;
      for (let k = 0; k < count; k++) sum += f(history[n - 1 - (length + k)]!);
      return sum / count;
    };
    this.bodyAverage = meanBack(BODY_AVG, bodyOf);
    this.rangeAverage10 = meanBack(RANGE_AVG10, rangeOf);
    this.rangeAverage5 = meanBack(RANGE_AVG5, rangeOf);
    this.shadowAverage = meanBack(SHADOW_AVG, (b) => upperOf(b) + lowerOf(b));
  }
  private at(index: number): BarInput {
    return this.history[this.history.length - 1 - index]!;
  }
  open(index: number): number {
    const b = this.at(index);
    return b.open ?? b.close;
  }
  high(index: number): number {
    return this.at(index).high;
  }
  low(index: number): number {
    return this.at(index).low;
  }
  close(index: number): number {
    return this.at(index).close;
  }
  body(index: number): number {
    return bodyOf(this.at(index));
  }
  signedBody(index: number): number {
    return this.close(index) - this.open(index);
  }
  upper(index: number): number {
    return upperOf(this.at(index));
  }
  lower(index: number): number {
    return lowerOf(this.at(index));
  }
  range(index: number): number {
    return rangeOf(this.at(index));
  }
  white(index: number): boolean {
    return this.close(index) > this.open(index);
  }
  black(index: number): boolean {
    return this.close(index) < this.open(index);
  }
  bodyHigh(index: number): number {
    return Math.max(this.open(index), this.close(index));
  }
  bodyLow(index: number): number {
    return Math.min(this.open(index), this.close(index));
  }
  // threshold predicates (TA-Lib candle settings)
  longBody(index: number): boolean {
    return this.body(index) > this.bodyAverage;
  }
  veryLongBody(index: number): boolean {
    return this.body(index) > 3 * this.bodyAverage;
  }
  shortBody(index: number): boolean {
    return this.body(index) < this.bodyAverage;
  }
  dojiBody(index: number): boolean {
    return this.body(index) <= 0.1 * this.rangeAverage10;
  }
  longUpper(index: number): boolean {
    return this.upper(index) > this.body(index);
  }
  longLower(index: number): boolean {
    return this.lower(index) > this.body(index);
  }
  veryLongLower(index: number): boolean {
    return this.lower(index) > 3 * this.body(index);
  }
  shortUpper(index: number): boolean {
    return this.upper(index) < this.shadowAverage;
  }
  shortLower(index: number): boolean {
    return this.lower(index) < this.shadowAverage;
  }
  veryShortUpper(index: number): boolean {
    return this.upper(index) < 0.1 * this.rangeAverage10;
  }
  veryShortLower(index: number): boolean {
    return this.lower(index) < 0.1 * this.rangeAverage10;
  }
  near(first: number, second: number): boolean {
    return Math.abs(first - second) <= 0.2 * this.rangeAverage5;
  }
  far(first: number, second: number): boolean {
    return Math.abs(first - second) >= 0.6 * this.rangeAverage5;
  }
  equalish(first: number, second: number): boolean {
    return Math.abs(first - second) <= 0.05 * this.rangeAverage5;
  }
  /** Real bodies of the two bars do not overlap, `barIndex` gapping up over `priorBarIndex`. */
  bodyGapUp(barIndex: number, priorBarIndex: number): boolean {
    return this.bodyLow(barIndex) > this.bodyHigh(priorBarIndex);
  }
  bodyGapDown(barIndex: number, priorBarIndex: number): boolean {
    return this.bodyHigh(barIndex) < this.bodyLow(priorBarIndex);
  }
  gapUp(barIndex: number, priorBarIndex: number): boolean {
    return this.low(barIndex) > this.high(priorBarIndex);
  }
  gapDown(barIndex: number, priorBarIndex: number): boolean {
    return this.high(barIndex) < this.low(priorBarIndex);
  }
}

export type CandleDetector = (view: CandleView) => number;

interface PatternDef {
  /** Number of bars the pattern spans. */
  length: number;
  detect: CandleDetector;
}

// ───────────────────────── the catalog ─────────────────────────
// Detectors index bars 0 = current (most recent) … len-1 = oldest.

const P: Record<string, PatternDef> = {
  doji: {
    length: 1,
    detect: (v) => (v.dojiBody(0) ? 100 : 0),
  },
  dojiStar: {
    length: 2,
    detect: (v) => {
      if (!v.longBody(1) || !v.dojiBody(0)) return 0;
      if (v.white(1) && v.bodyGapUp(0, 1)) return -100;
      if (v.black(1) && v.bodyGapDown(0, 1)) return 100;
      return 0;
    },
  },
  dragonflyDoji: {
    length: 1,
    detect: (v) => (v.dojiBody(0) && v.veryShortUpper(0) && v.longLower(0) ? 100 : 0),
  },
  gravestoneDoji: {
    length: 1,
    detect: (v) => (v.dojiBody(0) && v.veryShortLower(0) && v.longUpper(0) ? -100 : 0),
  },
  longLeggedDoji: {
    length: 1,
    detect: (v) => (v.dojiBody(0) && (v.longUpper(0) || v.longLower(0)) ? 100 : 0),
  },
  rickshawMan: {
    length: 1,
    detect: (v) => {
      if (!v.dojiBody(0)) return 0;
      const mid = (v.high(0) + v.low(0)) / 2;
      return v.longUpper(0) &&
        v.longLower(0) &&
        v.near(v.bodyHigh(0), mid) &&
        v.near(v.bodyLow(0), mid)
        ? 100
        : 0;
    },
  },
  takuri: {
    length: 1,
    detect: (v) => (v.dojiBody(0) && v.veryShortUpper(0) && v.lower(0) > 3 * v.body(0) ? 100 : 0),
  },
  marubozu: {
    length: 1,
    detect: (v) => {
      if (!v.longBody(0) || !v.veryShortUpper(0) || !v.veryShortLower(0)) return 0;
      return v.white(0) ? 100 : -100;
    },
  },
  closingMarubozu: {
    length: 1,
    detect: (v) => {
      if (!v.longBody(0)) return 0;
      if (v.white(0) && v.veryShortUpper(0)) return 100;
      if (v.black(0) && v.veryShortLower(0)) return -100;
      return 0;
    },
  },
  beltHold: {
    length: 1,
    detect: (v) => {
      if (!v.longBody(0)) return 0;
      if (v.white(0) && v.veryShortLower(0)) return 100;
      if (v.black(0) && v.veryShortUpper(0)) return -100;
      return 0;
    },
  },
  spinningTop: {
    length: 1,
    detect: (v) =>
      v.shortBody(0) && v.upper(0) > v.body(0) && v.lower(0) > v.body(0)
        ? v.white(0)
          ? 100
          : -100
        : 0,
  },
  highWave: {
    length: 1,
    detect: (v) =>
      v.shortBody(0) && v.longUpper(0) && v.longLower(0) ? (v.white(0) ? 100 : -100) : 0,
  },
  longLine: {
    length: 1,
    detect: (v) =>
      v.longBody(0) && v.shortUpper(0) && v.shortLower(0) ? (v.white(0) ? 100 : -100) : 0,
  },
  shortLine: {
    length: 1,
    detect: (v) =>
      v.shortBody(0) && v.shortUpper(0) && v.shortLower(0) ? (v.white(0) ? 100 : -100) : 0,
  },
  hammer: {
    length: 1,
    // small body riding at the top of the range: long lower shadow, very short upper shadow
    detect: (v) => (v.shortBody(0) && v.longLower(0) && v.veryShortUpper(0) ? 100 : 0),
  },
  invertedHammer: {
    length: 1,
    detect: (v) => (v.shortBody(0) && v.longUpper(0) && v.veryShortLower(0) ? 100 : 0),
  },
  hangingMan: {
    length: 1,
    detect: (v) => (v.shortBody(0) && v.longLower(0) && v.veryShortUpper(0) ? -100 : 0),
  },
  shootingStar: {
    length: 1,
    detect: (v) => (v.shortBody(0) && v.longUpper(0) && v.veryShortLower(0) ? -100 : 0),
  },
  engulfing: {
    length: 2,
    detect: (v) => {
      // current real body engulfs the previous real body, opposite colour
      if (
        v.white(0) &&
        v.black(1) &&
        v.close(0) >= v.open(1) &&
        v.open(0) <= v.close(1) &&
        (v.close(0) > v.open(1) || v.open(0) < v.close(1))
      )
        return 100;
      if (
        v.black(0) &&
        v.white(1) &&
        v.open(0) >= v.close(1) &&
        v.close(0) <= v.open(1) &&
        (v.open(0) > v.close(1) || v.close(0) < v.open(1))
      )
        return -100;
      return 0;
    },
  },
  harami: {
    length: 2,
    detect: (v) => {
      if (!v.longBody(1) || !v.shortBody(0)) return 0;
      const inside = v.bodyHigh(0) <= v.bodyHigh(1) && v.bodyLow(0) >= v.bodyLow(1);
      if (!inside) return 0;
      if (v.black(1) && v.white(0)) return 100;
      if (v.white(1) && v.black(0)) return -100;
      return 0;
    },
  },
  haramiCross: {
    length: 2,
    detect: (v) => {
      if (!v.longBody(1) || !v.dojiBody(0)) return 0;
      const inside = v.bodyHigh(0) <= v.bodyHigh(1) && v.bodyLow(0) >= v.bodyLow(1);
      if (!inside) return 0;
      return v.black(1) ? 100 : -100;
    },
  },
  piercing: {
    length: 2,
    detect: (v) => {
      if (!(v.black(1) && v.longBody(1) && v.white(0) && v.longBody(0))) return 0;
      const mid = (v.open(1) + v.close(1)) / 2;
      return v.open(0) < v.low(1) && v.close(0) > mid && v.close(0) < v.open(1) ? 100 : 0;
    },
  },
  darkCloudCover: {
    length: 2,
    detect: (v) => {
      if (!(v.white(1) && v.longBody(1) && v.black(0))) return 0;
      const mid = (v.open(1) + v.close(1)) / 2;
      return v.open(0) > v.high(1) && v.close(0) < mid && v.close(0) > v.open(1) ? -100 : 0;
    },
  },
  thrusting: {
    length: 2,
    detect: (v) => {
      if (!(v.black(1) && v.longBody(1) && v.white(0))) return 0;
      const mid = (v.open(1) + v.close(1)) / 2;
      return v.open(0) < v.low(1) && v.close(0) > v.close(1) && v.close(0) <= mid ? -100 : 0;
    },
  },
  onNeck: {
    length: 2,
    detect: (v) => {
      if (!(v.black(1) && v.longBody(1) && v.white(0))) return 0;
      return v.open(0) < v.low(1) && v.near(v.close(0), v.low(1)) ? -100 : 0;
    },
  },
  inNeck: {
    length: 2,
    detect: (v) => {
      if (!(v.black(1) && v.longBody(1) && v.white(0))) return 0;
      return v.open(0) < v.low(1) && v.close(0) >= v.close(1) && v.near(v.close(0), v.close(1))
        ? -100
        : 0;
    },
  },
  counterattack: {
    length: 2,
    detect: (v) => {
      if (!v.longBody(0) || !v.longBody(1)) return 0;
      if (v.black(1) && v.white(0) && v.equalish(v.close(0), v.close(1))) return 100;
      if (v.white(1) && v.black(0) && v.equalish(v.close(0), v.close(1))) return -100;
      return 0;
    },
  },
  separatingLines: {
    length: 2,
    detect: (v) => {
      if (!v.longBody(0)) return 0;
      if (v.black(1) && v.white(0) && v.equalish(v.open(0), v.open(1)) && v.veryShortLower(0))
        return 100;
      if (v.white(1) && v.black(0) && v.equalish(v.open(0), v.open(1)) && v.veryShortUpper(0))
        return -100;
      return 0;
    },
  },
  matchingLow: {
    length: 2,
    detect: (v) => (v.black(1) && v.black(0) && v.equalish(v.close(0), v.close(1)) ? 100 : 0),
  },
  homingPigeon: {
    length: 2,
    detect: (v) => {
      if (!(v.black(1) && v.longBody(1) && v.black(0) && v.shortBody(0))) return 0;
      return v.bodyHigh(0) <= v.bodyHigh(1) && v.bodyLow(0) >= v.bodyLow(1) ? 100 : 0;
    },
  },
  kicking: {
    length: 2,
    detect: (v) => {
      const m0 = v.longBody(0) && v.veryShortUpper(0) && v.veryShortLower(0);
      const m1 = v.longBody(1) && v.veryShortUpper(1) && v.veryShortLower(1);
      if (!m0 || !m1) return 0;
      if (v.black(1) && v.white(0) && v.gapUp(0, 1)) return 100;
      if (v.white(1) && v.black(0) && v.gapDown(0, 1)) return -100;
      return 0;
    },
  },
  kickingByLength: {
    length: 2,
    detect: (v) => {
      const m0 = v.longBody(0) && v.veryShortUpper(0) && v.veryShortLower(0);
      const m1 = v.longBody(1) && v.veryShortUpper(1) && v.veryShortLower(1);
      if (!m0 || !m1) return 0;
      // signed by the longer marubozu
      if (v.black(1) && v.white(0) && v.gapUp(0, 1)) return 100;
      if (v.white(1) && v.black(0) && v.gapDown(0, 1)) return -100;
      return 0;
    },
  },
  morningStar: {
    length: 3,
    detect: (v) => {
      if (!(v.black(2) && v.longBody(2))) return 0;
      if (!v.shortBody(1) || !v.bodyGapDown(1, 2)) return 0;
      if (!(v.white(0) && v.longBody(0))) return 0;
      const mid2 = (v.open(2) + v.close(2)) / 2;
      return v.close(0) > mid2 ? 100 : 0;
    },
  },
  eveningStar: {
    length: 3,
    detect: (v) => {
      if (!(v.white(2) && v.longBody(2))) return 0;
      if (!v.shortBody(1) || !v.bodyGapUp(1, 2)) return 0;
      if (!(v.black(0) && v.longBody(0))) return 0;
      const mid2 = (v.open(2) + v.close(2)) / 2;
      return v.close(0) < mid2 ? -100 : 0;
    },
  },
  morningDojiStar: {
    length: 3,
    detect: (v) => {
      if (!(v.black(2) && v.longBody(2))) return 0;
      if (!v.dojiBody(1) || !v.bodyGapDown(1, 2)) return 0;
      if (!(v.white(0) && v.longBody(0))) return 0;
      const mid2 = (v.open(2) + v.close(2)) / 2;
      return v.close(0) > mid2 ? 100 : 0;
    },
  },
  eveningDojiStar: {
    length: 3,
    detect: (v) => {
      if (!(v.white(2) && v.longBody(2))) return 0;
      if (!v.dojiBody(1) || !v.bodyGapUp(1, 2)) return 0;
      if (!(v.black(0) && v.longBody(0))) return 0;
      const mid2 = (v.open(2) + v.close(2)) / 2;
      return v.close(0) < mid2 ? -100 : 0;
    },
  },
  abandonedBaby: {
    length: 3,
    detect: (v) => {
      if (!v.dojiBody(1)) return 0;
      // bullish: long black, gap-down doji (full gap), long white gapping up
      if (
        v.black(2) &&
        v.longBody(2) &&
        v.gapDown(1, 2) &&
        v.white(0) &&
        v.longBody(0) &&
        v.gapUp(0, 1)
      )
        return 100;
      if (
        v.white(2) &&
        v.longBody(2) &&
        v.gapUp(1, 2) &&
        v.black(0) &&
        v.longBody(0) &&
        v.gapDown(0, 1)
      )
        return -100;
      return 0;
    },
  },
  triStar: {
    length: 3,
    detect: (v) => {
      if (!(v.dojiBody(2) && v.dojiBody(1) && v.dojiBody(0))) return 0;
      if (v.bodyGapUp(1, 2) && v.bodyGapDown(0, 1)) return -100;
      if (v.bodyGapDown(1, 2) && v.bodyGapUp(0, 1)) return 100;
      return 0;
    },
  },
  threeWhiteSoldiers: {
    length: 3,
    detect: (v) => {
      for (let i = 0; i < 3; i++) if (!(v.white(i) && v.longBody(i) && v.shortUpper(i))) return 0;
      // each opens within the prior body and closes higher
      if (
        v.open(1) > v.open(2) &&
        v.open(1) <= v.close(2) &&
        v.close(1) > v.close(2) &&
        v.open(0) > v.open(1) &&
        v.open(0) <= v.close(1) &&
        v.close(0) > v.close(1)
      )
        return 100;
      return 0;
    },
  },
  threeBlackCrows: {
    length: 3,
    detect: (v) => {
      for (let i = 0; i < 3; i++) if (!(v.black(i) && v.longBody(i) && v.shortLower(i))) return 0;
      if (
        v.open(1) < v.open(2) &&
        v.open(1) >= v.close(2) &&
        v.close(1) < v.close(2) &&
        v.open(0) < v.open(1) &&
        v.open(0) >= v.close(1) &&
        v.close(0) < v.close(1)
      )
        return -100;
      return 0;
    },
  },
  identicalThreeCrows: {
    length: 3,
    detect: (v) => {
      for (let i = 0; i < 3; i++) if (!(v.black(i) && v.longBody(i))) return 0;
      if (
        v.close(1) < v.close(2) &&
        v.close(0) < v.close(1) &&
        v.near(v.open(1), v.close(2)) &&
        v.near(v.open(0), v.close(1))
      )
        return -100;
      return 0;
    },
  },
  threeInside: {
    length: 3,
    detect: (v) => {
      // first two form a harami, third confirms
      if (
        v.longBody(2) &&
        v.shortBody(1) &&
        v.bodyHigh(1) <= v.bodyHigh(2) &&
        v.bodyLow(1) >= v.bodyLow(2)
      ) {
        if (v.black(2) && v.white(0) && v.close(0) > v.close(2)) return 100;
        if (v.white(2) && v.black(0) && v.close(0) < v.close(2)) return -100;
      }
      return 0;
    },
  },
  threeOutside: {
    length: 3,
    detect: (v) => {
      // first two form an engulfing, third confirms
      if (
        v.white(1) &&
        v.black(2) &&
        v.close(1) > v.open(2) &&
        v.open(1) < v.close(2) &&
        v.close(0) > v.close(1)
      )
        return 100;
      if (
        v.black(1) &&
        v.white(2) &&
        v.open(1) > v.close(2) &&
        v.close(1) < v.open(2) &&
        v.close(0) < v.close(1)
      )
        return -100;
      return 0;
    },
  },
  threeLineStrike: {
    length: 4,
    detect: (v) => {
      // three soldiers/crows then a wide opposite engulfing bar
      const upTrend =
        v.white(3) &&
        v.white(2) &&
        v.white(1) &&
        v.close(2) > v.close(3) &&
        v.close(1) > v.close(2);
      const dnTrend =
        v.black(3) &&
        v.black(2) &&
        v.black(1) &&
        v.close(2) < v.close(3) &&
        v.close(1) < v.close(2);
      if (upTrend && v.black(0) && v.open(0) > v.close(1) && v.close(0) < v.open(3)) return -100;
      if (dnTrend && v.white(0) && v.open(0) < v.close(1) && v.close(0) > v.open(3)) return 100;
      return 0;
    },
  },
  twoCrows: {
    length: 3,
    detect: (v) => {
      if (!(v.white(2) && v.longBody(2))) return 0;
      if (!(v.black(1) && v.bodyGapUp(1, 2))) return 0;
      if (!v.black(0)) return 0;
      return v.open(0) < v.open(1) &&
        v.open(0) > v.close(1) &&
        v.close(0) > v.open(2) &&
        v.close(0) < v.close(2)
        ? -100
        : 0;
    },
  },
  upsideGapTwoCrows: {
    length: 3,
    detect: (v) => {
      if (!(v.white(2) && v.longBody(2))) return 0;
      if (!(v.black(1) && v.bodyGapUp(1, 2))) return 0;
      if (
        !(v.black(0) && v.open(0) > v.open(1) && v.close(0) < v.close(1) && v.close(0) > v.close(2))
      )
        return 0;
      return -100;
    },
  },
  advanceBlock: {
    length: 3,
    detect: (v) => {
      if (!(v.white(2) && v.white(1) && v.white(0))) return 0;
      if (!(v.close(1) > v.close(2) && v.close(0) > v.close(1))) return 0;
      if (
        !(
          v.open(1) > v.open(2) &&
          v.open(1) <= v.close(2) &&
          v.open(0) > v.open(1) &&
          v.open(0) <= v.close(1)
        )
      )
        return 0;
      // weakening: shrinking bodies / growing upper shadows
      if (
        v.longBody(2) &&
        v.shortUpper(2) &&
        v.body(1) < v.body(2) &&
        v.body(0) < v.body(1) &&
        (v.upper(0) > v.upper(1) || v.upper(1) > v.upper(2))
      )
        return -100;
      return 0;
    },
  },
  stalledPattern: {
    length: 3,
    detect: (v) => {
      if (!(v.white(2) && v.white(1) && v.white(0))) return 0;
      if (!(v.close(1) > v.close(2) && v.close(0) > v.close(1))) return 0;
      if (!(v.longBody(2) && v.longBody(1) && v.shortBody(0))) return 0;
      // third is a small body riding on the shoulder of the second
      return v.open(0) >= v.close(1) - v.body(1) * 0.1 && v.open(0) <= v.high(1) ? -100 : 0;
    },
  },
  threeStarsInSouth: {
    length: 3,
    detect: (v) => {
      if (!(v.black(2) && v.longBody(2) && v.longLower(2))) return 0;
      if (
        !(
          v.black(1) &&
          v.open(1) < v.open(2) &&
          v.open(1) > v.close(2) &&
          v.low(1) >= v.low(2) &&
          v.lower(1) > 0
        )
      )
        return 0;
      if (
        !(
          v.black(0) &&
          v.shortBody(0) &&
          v.veryShortLower(0) &&
          v.low(0) > v.low(1) &&
          v.high(0) < v.high(1)
        )
      )
        return 0;
      return 100;
    },
  },
  concealBabySwallow: {
    length: 4,
    detect: (v) => {
      // two black marubozu, third black with high gap & long upper shadow into prior body, fourth engulfs
      if (!(v.black(3) && v.veryLongBody(3) && v.veryShortUpper(3) && v.veryShortLower(3)))
        return 0;
      if (!(v.black(2) && v.veryLongBody(2) && v.veryShortUpper(2) && v.veryShortLower(2)))
        return 0;
      if (!(v.black(1) && v.gapDown(1, 2) && v.upper(1) > 0 && v.high(1) > v.close(2))) return 0;
      if (!(v.black(0) && v.high(0) > v.high(1) && v.low(0) < v.low(1))) return 0;
      return 100;
    },
  },
  ladderBottom: {
    length: 5,
    detect: (v) => {
      for (let i = 2; i <= 4; i++) if (!v.black(i)) return 0;
      if (!(v.open(3) < v.open(4) && v.open(3) > v.close(4) && v.close(3) < v.close(4))) return 0;
      if (!(v.open(2) < v.open(3) && v.open(2) > v.close(3) && v.close(2) < v.close(3))) return 0;
      if (!(v.black(1) && v.upper(1) > 0)) return 0; // bar with an upper shadow
      if (!(v.white(0) && v.open(0) > v.open(1))) return 0; // gap up white
      return 100;
    },
  },
  riseFallThreeMethods: {
    length: 5,
    detect: (v) => {
      if (v.white(4) && v.longBody(4) && v.white(0) && v.longBody(0)) {
        const small = v.black(3) || v.black(2) || v.black(1);
        const within =
          Math.max(v.high(3), v.high(2), v.high(1)) <= v.high(4) &&
          Math.min(v.low(3), v.low(2), v.low(1)) >= v.low(4);
        if (
          small &&
          within &&
          v.shortBody(3) &&
          v.shortBody(2) &&
          v.shortBody(1) &&
          v.close(0) > v.close(4)
        )
          return 100;
      }
      if (v.black(4) && v.longBody(4) && v.black(0) && v.longBody(0)) {
        const small = v.white(3) || v.white(2) || v.white(1);
        const within =
          Math.max(v.high(3), v.high(2), v.high(1)) <= v.high(4) &&
          Math.min(v.low(3), v.low(2), v.low(1)) >= v.low(4);
        if (
          small &&
          within &&
          v.shortBody(3) &&
          v.shortBody(2) &&
          v.shortBody(1) &&
          v.close(0) < v.close(4)
        )
          return -100;
      }
      return 0;
    },
  },
  matHold: {
    length: 5,
    detect: (v) => {
      if (!(v.white(4) && v.longBody(4) && v.white(0) && v.longBody(0))) return 0;
      const small = v.shortBody(3) && v.shortBody(2) && v.shortBody(1);
      const within = Math.min(v.low(3), v.low(2), v.low(1)) > v.low(4);
      return small && within && v.close(0) > Math.max(v.high(3), v.high(2), v.high(1)) ? 100 : 0;
    },
  },
  tasukiGap: {
    length: 3,
    detect: (v) => {
      // upside: white, gap-up white, then black opening in the 2nd body, closing inside the gap
      if (
        v.white(2) &&
        v.white(1) &&
        v.bodyGapUp(1, 2) &&
        v.black(0) &&
        v.open(0) > v.bodyLow(1) &&
        v.open(0) < v.bodyHigh(1) &&
        v.close(0) > v.bodyHigh(2) &&
        v.close(0) < v.bodyLow(1)
      )
        return 100;
      if (
        v.black(2) &&
        v.black(1) &&
        v.bodyGapDown(1, 2) &&
        v.white(0) &&
        v.open(0) < v.bodyHigh(1) &&
        v.open(0) > v.bodyLow(1) &&
        v.close(0) < v.bodyLow(2) &&
        v.close(0) > v.bodyHigh(1)
      )
        return -100;
      return 0;
    },
  },
  gapSideSideWhite: {
    length: 3,
    detect: (v) => {
      if (!(v.white(1) && v.white(0))) return 0;
      const sim = v.near(v.body(0), v.body(1)) && v.near(v.open(0), v.open(1));
      if (!sim) return 0;
      if (v.bodyGapUp(1, 2) && v.bodyGapUp(0, 2)) return 100;
      if (v.bodyGapDown(1, 2) && v.bodyGapDown(0, 2)) return -100;
      return 0;
    },
  },
  xSideGapThreeMethods: {
    length: 3,
    detect: (v) => {
      // upside gap filled: two white with a gap, third black closes the gap
      if (
        v.white(2) &&
        v.white(1) &&
        v.bodyGapUp(1, 2) &&
        v.black(0) &&
        v.open(0) > v.bodyLow(1) &&
        v.open(0) < v.bodyHigh(1) &&
        v.close(0) > v.bodyLow(2) &&
        v.close(0) < v.bodyHigh(2)
      )
        return 100;
      if (
        v.black(2) &&
        v.black(1) &&
        v.bodyGapDown(1, 2) &&
        v.white(0) &&
        v.open(0) < v.bodyHigh(1) &&
        v.open(0) > v.bodyLow(1) &&
        v.close(0) > v.bodyLow(2) &&
        v.close(0) < v.bodyHigh(2)
      )
        return -100;
      return 0;
    },
  },
  stickSandwich: {
    length: 3,
    detect: (v) => {
      if (!(v.black(2) && v.white(1) && v.black(0))) return 0;
      return v.equalish(v.close(0), v.close(2)) && v.open(1) > v.close(2) && v.close(1) > v.high(2)
        ? 100
        : 0;
    },
  },
  uniqueThreeRiver: {
    length: 3,
    detect: (v) => {
      if (!(v.black(2) && v.longBody(2))) return 0;
      if (
        !(
          v.black(1) &&
          v.open(1) <= v.open(2) &&
          v.open(1) > v.close(2) &&
          v.close(1) > v.close(2) &&
          v.low(1) < v.low(2)
        )
      )
        return 0;
      if (!(v.white(0) && v.shortBody(0) && v.open(0) > v.low(1) && v.close(0) < v.close(1)))
        return 0;
      return 100;
    },
  },
  breakaway: {
    length: 5,
    detect: (v) => {
      // bullish: long black, gap-down black, two lower bars, white closing into the gap
      if (
        v.black(4) &&
        v.longBody(4) &&
        v.black(3) &&
        v.bodyGapDown(3, 4) &&
        v.close(2) < v.close(3) &&
        v.close(1) < v.close(2) &&
        v.white(0) &&
        v.longBody(0) &&
        v.close(0) > v.bodyHigh(3) &&
        v.close(0) < v.bodyLow(4)
      )
        return 100;
      if (
        v.white(4) &&
        v.longBody(4) &&
        v.white(3) &&
        v.bodyGapUp(3, 4) &&
        v.close(2) > v.close(3) &&
        v.close(1) > v.close(2) &&
        v.black(0) &&
        v.longBody(0) &&
        v.close(0) < v.bodyLow(3) &&
        v.close(0) > v.bodyHigh(4)
      )
        return -100;
      return 0;
    },
  },
  hikkake: {
    length: 3,
    detect: (v) => {
      // inside bar (1) within bar (2), then bar (0) breaks one side
      if (v.high(1) < v.high(2) && v.low(1) > v.low(2)) {
        if (v.high(0) < v.high(1) && v.low(0) < v.low(1)) return 100; // false breakdown → bullish
        if (v.low(0) > v.low(1) && v.high(0) > v.high(1)) return -100; // false breakout → bearish
      }
      return 0;
    },
  },
  hikkakeMod: {
    length: 3,
    detect: (v) => {
      // modified hikkake adds a context bar; here approximated by the inside-bar break with confirmation
      if (v.high(1) < v.high(2) && v.low(1) > v.low(2)) {
        if (v.high(0) < v.high(1) && v.low(0) < v.low(1) && v.close(0) > v.open(0)) return 100;
        if (v.low(0) > v.low(1) && v.high(0) > v.high(1) && v.close(0) < v.open(0)) return -100;
      }
      return 0;
    },
  },
  inside: {
    length: 2,
    detect: (v) => {
      // strict inside bar: this bar's range sits entirely within the prior bar's range
      if (!(v.high(0) < v.high(1) && v.low(0) > v.low(1))) return 0;
      return v.white(0) ? 100 : v.black(0) ? -100 : 0;
    },
  },
};

// ───────────────────────── streaming engine ─────────────────────────

class CandleStream implements IndicatorStream<BarInput, number> {
  private hist: BarInput[] = [];
  value: number | null = null;
  private readonly name: string;
  private readonly length: number;
  private readonly detect: CandleDetector;
  constructor(parameters: { name: string; length: number; detect: CandleDetector }) {
    requireStreamParameters('CandleStream.constructor#0', 'CandleStream', parameters);
    const { name, length, detect } = parameters;
    this.name = name;
    this.length = length;
    this.detect = detect;
  }
  private get need(): number {
    return this.length + BODY_AVG; // need the pattern plus the 10-bar average window before it
  }
  next(bar: BarInput): number | null {
    this.hist.push(bar);
    if (this.hist.length > this.need) this.hist.shift();
    if (this.hist.length < this.need) {
      this.value = null;
      return null;
    }
    this.value = this.detect(new CandleView({ history: this.hist, length: this.length }));
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf(`cdl:${this.name}`, {
      hist: this.hist.map((b) => ({ ...b })),
      value: this.value,
    });
  }
  static restore(name: string, length: number, detect: CandleDetector) {
    return (s: TechnicalAnalysisSnapshot): CandleStream => {
      const state = readSnapshot(s, `cdl:${name}`);
      const x = new CandleStream({ name, length, detect });
      x.hist = state.records<BarInput>('hist').map((b) => ({ ...b }));
      x.value = state.cached<number>('value');
      return x;
    };
  }
}

function candlePattern(name: string, def: PatternDef) {
  return withBuiltinMetadata(
    makeIndicator<Empty, BarInput, number>(
      () => new CandleStream({ name, length: def.length, detect: def.detect }),
      CandleStream.restore(name, def.length, def.detect),
      () => NaN,
    ),
    builtinMetadata.candlestickMetadata,
  );
}

/** All candlestick patterns, keyed by name → an aligned batch+stream indicator emitting ±100 / 0. */
export const candlesticks = Object.fromEntries(
  Object.entries(P).map(([name, def]) => [name, candlePattern(name, def)]),
) as Record<string, ReturnType<typeof candlePattern>>;

/** Names of every catalogued candlestick pattern. */
export const candlestickNames = Object.keys(P);

export interface CandleMatch {
  pattern: string;
  signal: number;
}

/**
 * Scan bars with the whole catalog, returning the matched patterns (non-zero signal) at each bar.
 * Index `i` of the result lists patterns that complete on bar `i`.
 */
export function detectCandles(bars: ArrayLike<BarInput>): CandleMatch[][] {
  requireArgumentArray('detectCandles', 'bars', bars);
  const out: CandleMatch[][] = Array.from({ length: bars.length }, () => []);
  for (const [name, ind] of Object.entries(candlesticks)) {
    const series = ind(bars, {});
    for (let i = 0; i < series.length; i++) {
      const s = series[i]!;
      if (!Number.isNaN(s) && s !== 0) out[i]!.push({ pattern: name, signal: s });
    }
  }
  return out;
}

export { CandleStream };
