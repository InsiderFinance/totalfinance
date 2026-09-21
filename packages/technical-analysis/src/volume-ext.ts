/**
 * Modern volume indicators (spec §13.3; pandas-ta parity).
 *
 * Archer OBV (OBV + fast/slow EMAs + long/short run signals), the Bill Williams Market Facilitation
 * Index, Price·Volume, Price Volume Rank, the Volume Oscillator, and Williams Accumulation/
 * Distribution. Plus the conventional aliases `efi`→`forceIndex`, `emv`→`easeOfMovement`,
 * `kvo`→`klinger`.
 */

import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { ObvStream } from './bars.js';
import { EmaStream } from './moving-averages.js';
import { easeOfMovement, forceIndex, klinger } from './volume-core.js';
import { requireBooleanWhenPresent, requirePeriod } from './validate.js';

const nan = (): number => NaN;

// ───────────────────────── Archer OBV ─────────────────────────

export interface ArcherObvParameters {
  /** Fast EMA length on OBV. Default 4. */
  fast?: number;
  /** Slow EMA length on OBV. Default 12. */
  slow?: number;
  /** Lookback for the rising/falling run check on the two EMAs. Default 2. */
  runLength?: number;
}
export interface ArcherObvPoint {
  obv: number;
  /** Fast EMA of OBV. */
  fast: number;
  /** Slow EMA of OBV. */
  slow: number;
  /** 1 when both EMAs are rising over `runLength` — a long-run signal. */
  long: number;
  /** 1 when both EMAs are falling over `runLength` — a short-run signal. */
  short: number;
}

class ArcherObvStream implements IndicatorStream<BarInput, ArcherObvPoint> {
  private obv: ObvStream;
  private fastEma: EmaStream;
  private slowEma: EmaStream;
  private fastBuf: number[] = [];
  private slowBuf: number[] = [];
  value: ArcherObvPoint | null = null;
  private readonly runLength: number;
  constructor({ fast, slow, runLength }: { fast: number; slow: number; runLength: number }) {
    this.runLength = runLength;

    this.obv = new ObvStream();
    this.fastEma = new EmaStream(fast);
    this.slowEma = new EmaStream(slow);
  }
  next(bar: BarInput): ArcherObvPoint | null {
    const obv = this.obv.next(bar)!; // OBV emits from the first bar
    // Both EMAs consume OBV every bar (independent of each other).
    const fast = this.fastEma.next(obv);
    const slow = this.slowEma.next(obv);
    if (fast === null || slow === null) {
      this.value = null;
      return null;
    }
    this.fastBuf.push(fast);
    this.slowBuf.push(slow);
    if (this.fastBuf.length > this.runLength + 1) {
      this.fastBuf.shift();
      this.slowBuf.shift();
    }
    if (this.fastBuf.length < this.runLength + 1) {
      this.value = null;
      return null;
    }
    const fLast = this.fastBuf[this.fastBuf.length - 1]!;
    const sLast = this.slowBuf[this.slowBuf.length - 1]!;
    const fFirst = this.fastBuf[0]!;
    const sFirst = this.slowBuf[0]!;
    const long = fLast > fFirst && sLast > sFirst ? 1 : 0;
    const short = fLast < fFirst && sLast < sFirst ? 1 : 0;
    this.value = { obv, fast, slow, long, short };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('archerObv', {
      runLength: this.runLength,
      obv: this.obv.toJSON(),
      fastEma: this.fastEma.toJSON(),
      slowEma: this.slowEma.toJSON(),
      fastBuf: [...this.fastBuf],
      slowBuf: [...this.slowBuf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ArcherObvStream {
    const state = readSnapshot(snapshot, 'archerObv');
    const x = new ArcherObvStream({ fast: 1, slow: 1, runLength: state.number('runLength') });
    x.obv = ObvStream.fromJSON(state.child('obv'));
    x.fastEma = EmaStream.fromJSON(state.child('fastEma'));
    x.slowEma = EmaStream.fromJSON(state.child('slowEma'));
    x.fastBuf = state.numbers('fastBuf');
    x.slowBuf = state.numbers('slowBuf');
    x.value = state.cached<ArcherObvPoint>('value');
    return x;
  }
}

export const archerObv = makeIndicator<ArcherObvParameters, BarInput, ArcherObvPoint>(
  (p) =>
    new ArcherObvStream({
      fast: requirePeriod(p.fast ?? 4, 'archerObv', 'fast'),
      slow: requirePeriod(p.slow ?? 12, 'archerObv', 'slow'),
      runLength: requirePeriod(p.runLength ?? 2, 'archerObv', 'runLength'),
    }),
  ArcherObvStream.fromJSON,
  () => ({ obv: NaN, fast: NaN, slow: NaN, long: NaN, short: NaN }),
);

// ───────────────────────── Market Facilitation Index ─────────────────────────

class MarketFacilitationIndexStream implements IndicatorStream<BarInput, number> {
  value: number | null = null;
  next(bar: BarInput): number | null {
    const v = bar.volume ?? 0;
    this.value = v <= 0 ? NaN : (bar.high - bar.low) / v;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('marketFacilitationIndex', { value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MarketFacilitationIndexStream {
    const state = readSnapshot(snapshot, 'marketFacilitationIndex');
    const x = new MarketFacilitationIndexStream();
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Bill Williams Market Facilitation Index — (high − low) / volume. */
export const marketFacilitationIndex = makeIndicator<Record<string, never>, BarInput, number>(
  () => new MarketFacilitationIndexStream(),
  MarketFacilitationIndexStream.fromJSON,
  nan,
);

// ───────────────────────── Price · Volume ─────────────────────────

export interface PriceVolumeParameters {
  /** Multiply by the sign of the close-to-close change (needs a prior bar). Default false. */
  signed?: boolean;
}

class PriceVolumeStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  value: number | null = null;
  constructor(private readonly signed: boolean) {}
  next(bar: BarInput): number | null {
    const pv = bar.close * (bar.volume ?? 0);
    if (!this.signed) {
      this.value = pv;
      return this.value;
    }
    if (this.previousClose === null) {
      this.previousClose = bar.close;
      this.value = null; // direction undefined on the first bar
      return null;
    }
    const sign = Math.sign(bar.close - this.previousClose);
    this.previousClose = bar.close;
    this.value = pv * sign;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('priceVolume', {
      signed: this.signed,
      previousClose: this.previousClose,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PriceVolumeStream {
    const state = readSnapshot(snapshot, 'priceVolume');
    const x = new PriceVolumeStream(state.boolean('signed'));
    x.previousClose = state.numberOrNull('previousClose');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Price · Volume — close × volume, optionally signed by the close-to-close direction. */
export const priceVolume = makeIndicator<PriceVolumeParameters, BarInput, number>(
  (p) =>
    new PriceVolumeStream(
      requireBooleanWhenPresent(p.signed, 'priceVolume', 'signed') === undefined
        ? (p.signed ?? false)
        : (p.signed as boolean),
    ),
  PriceVolumeStream.fromJSON,
  nan,
);

// ───────────────────────── Price Volume Rank ─────────────────────────

class PriceVolumeRankStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private prevVolume = 0;
  value: number | null = null;
  next(bar: BarInput): number | null {
    const v = bar.volume ?? 0;
    if (this.previousClose === null) {
      this.previousClose = bar.close;
      this.prevVolume = v;
      this.value = null;
      return null;
    }
    const priceUp = bar.close > this.previousClose;
    const volumeUp = v > this.prevVolume;
    this.previousClose = bar.close;
    this.prevVolume = v;
    this.value = priceUp ? (volumeUp ? 1 : 2) : volumeUp ? 3 : 4;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('priceVolumeRank', {
      previousClose: this.previousClose,
      prevVolume: this.prevVolume,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): PriceVolumeRankStream {
    const state = readSnapshot(snapshot, 'priceVolumeRank');
    const x = new PriceVolumeRankStream();
    x.previousClose = state.numberOrNull('previousClose');
    x.prevVolume = state.number('prevVolume');
    x.value = state.cached<number>('value');
    return x;
  }
}

/**
 * Price Volume Rank — 1: price↑ & volume↑, 2: price↑ & volume↓, 3: price↓ & volume↑,
 * 4: price↓ & volume↓ (ties count as "down").
 */
export const priceVolumeRank = makeIndicator<Record<string, never>, BarInput, number>(
  () => new PriceVolumeRankStream(),
  PriceVolumeRankStream.fromJSON,
  nan,
);

// ───────────────────────── Volume Oscillator ─────────────────────────

export interface VolumeOscillatorParameters {
  /** Fast EMA length on volume. Default 5. */
  fast?: number;
  /** Slow EMA length on volume. Default 10. */
  slow?: number;
}

class VolumeOscillatorStream implements IndicatorStream<BarInput, number> {
  private fastEma: EmaStream;
  private slowEma: EmaStream;
  value: number | null = null;
  constructor(fast: number, slow: number) {
    this.fastEma = new EmaStream(fast);
    this.slowEma = new EmaStream(slow);
  }
  next(bar: BarInput): number | null {
    const v = bar.volume ?? 0;
    const fast = this.fastEma.next(v);
    const slow = this.slowEma.next(v); // both independent EMAs of volume
    if (fast === null || slow === null) {
      this.value = null;
      return null;
    }
    this.value = slow === 0 ? 0 : (100 * (fast - slow)) / slow;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('volumeOscillator', {
      fastEma: this.fastEma.toJSON(),
      slowEma: this.slowEma.toJSON(),
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): VolumeOscillatorStream {
    const state = readSnapshot(snapshot, 'volumeOscillator');
    const x = new VolumeOscillatorStream(1, 1);
    x.fastEma = EmaStream.fromJSON(state.child('fastEma'));
    x.slowEma = EmaStream.fromJSON(state.child('slowEma'));
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Volume Oscillator — 100·(EMA_fast(volume) − EMA_slow(volume)) / EMA_slow(volume). */
export const volumeOscillator = makeIndicator<VolumeOscillatorParameters, BarInput, number>(
  (p) =>
    new VolumeOscillatorStream(
      requirePeriod(p.fast ?? 5, 'volumeOscillator', 'fast'),
      requirePeriod(p.slow ?? 10, 'volumeOscillator', 'slow'),
    ),
  VolumeOscillatorStream.fromJSON,
  nan,
);

// ───────────────────────── Williams Accumulation / Distribution ─────────────────────────

class WilliamsAdStream implements IndicatorStream<BarInput, number> {
  private previousClose: number | null = null;
  private wad = 0;
  value: number | null = null;
  next(bar: BarInput): number | null {
    if (this.previousClose !== null) {
      if (bar.close > this.previousClose) {
        this.wad += bar.close - Math.min(bar.low, this.previousClose); // close − true low
      } else if (bar.close < this.previousClose) {
        this.wad += bar.close - Math.max(bar.high, this.previousClose); // close − true high
      }
    }
    this.previousClose = bar.close;
    this.value = this.wad;
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('williamsAd', {
      previousClose: this.previousClose,
      wad: this.wad,
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): WilliamsAdStream {
    const state = readSnapshot(snapshot, 'williamsAd');
    const x = new WilliamsAdStream();
    x.previousClose = state.numberOrNull('previousClose');
    x.wad = state.number('wad');
    x.value = state.cached<number>('value');
    return x;
  }
}

/** Williams Accumulation/Distribution — running sum of close − true-low/high on up/down days. */
export const williamsAd = makeIndicator<Record<string, never>, BarInput, number>(
  () => new WilliamsAdStream(),
  WilliamsAdStream.fromJSON,
  nan,
);

// ───────────────────────── conventional aliases ─────────────────────────

/** Elder's Force Index (alias of `forceIndex`). */
export const efi = forceIndex;
/** Ease of Movement (alias of `easeOfMovement`). */
export const emv = easeOfMovement;
/** Klinger Volume Oscillator (alias of `klinger`). */
export const kvo = klinger;
