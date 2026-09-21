/** MACD — Moving Average Convergence/Divergence (spec §13.3). */

import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { EmaStream } from './moving-averages.js';
import { requirePeriod } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

export interface MacdParameters {
  fast?: number;
  slow?: number;
  signal?: number;
}

export interface MacdPoint {
  macd: number;
  signal: number;
  histogram: number;
}

class MacdStream implements IndicatorStream<number, MacdPoint> {
  private fast: EmaStream;
  private slow: EmaStream;
  private signalEma: EmaStream;
  value: MacdPoint | null = null;

  constructor(parameters: { fast: number; slow: number; signal: number }) {
    requireStreamParameters('MacdStream.constructor#0', 'MacdStream', parameters);
    const { fast, slow, signal } = parameters;
    this.fast = new EmaStream(fast);
    this.slow = new EmaStream(slow);
    this.signalEma = new EmaStream(signal);
  }

  next(value: number): MacdPoint | null {
    const f = this.fast.next(value);
    const s = this.slow.next(value);
    if (f === null || s === null) {
      this.value = null;
      return null;
    }
    const macd = f - s;
    const sig = this.signalEma.next(macd);
    if (sig === null) {
      this.value = null;
      return null;
    }
    this.value = { macd, signal: sig, histogram: macd - sig };
    return this.value;
  }

  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('macd', {
      fast: this.fast.toJSON(),
      slow: this.slow.toJSON(),
      signal: this.signalEma.toJSON(),
      value: this.value,
    });
  }

  static fromJSON(snapshot: TechnicalAnalysisSnapshot): MacdStream {
    const state = readSnapshot(snapshot, 'macd');
    const x = new MacdStream({ fast: 1, slow: 1, signal: 1 });
    x.fast = EmaStream.fromJSON(state.child('fast'));
    x.slow = EmaStream.fromJSON(state.child('slow'));
    x.signalEma = EmaStream.fromJSON(state.child('signal'));
    x.value = state.cached<MacdPoint>('value');
    return x;
  }
}

const nanPoint = (): MacdPoint => ({ macd: NaN, signal: NaN, histogram: NaN });

export const macd = withBuiltinMetadata(
  makeIndicator<MacdParameters, number, MacdPoint>(
    (p) =>
      new MacdStream({
        fast: requirePeriod(p.fast ?? 12, 'macd', 'fast'),
        slow: requirePeriod(p.slow ?? 26, 'macd', 'slow'),
        signal: requirePeriod(p.signal ?? 9, 'macd', 'signal'),
      }),
    MacdStream.fromJSON,
    nanPoint,
  ),
  builtinMetadata.macdMetadata,
);

export { MacdStream };
