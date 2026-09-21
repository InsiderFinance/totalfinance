/** Bollinger Bands (spec §13.3). */

import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { requirePeriod, requirePositive } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

export interface BollingerParameters {
  /** SMA lookback. Defaults to 20 (Bollinger; universal); echoed via `.explain()`. */
  period?: number;
  /** Band width in standard deviations. Defaults to 2. */
  standardDeviation?: number;
}

export interface BollingerPoint {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  percentB: number;
}

class BollingerStream implements IndicatorStream<number, BollingerPoint> {
  private buf: number[] = [];
  value: BollingerPoint | null = null;
  private readonly period: number;
  private readonly standardDeviation: number;
  constructor(parameters: { period: number; standardDeviation: number }) {
    requireStreamParameters('BollingerStream.constructor#0', 'BollingerStream', parameters);
    const { period, standardDeviation } = parameters;
    this.period = period;
    this.standardDeviation = standardDeviation;
  }

  next(value: number): BollingerPoint | null {
    this.buf.push(value);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) {
      this.value = null;
      return null;
    }
    let sum = 0;
    for (const x of this.buf) sum += x;
    const mean = sum / this.period;
    let acc = 0;
    for (const x of this.buf) {
      const d = x - mean;
      acc += d * d;
    }
    const std = Math.sqrt(acc / this.period); // population std (Bollinger convention)
    const upper = mean + this.standardDeviation * std;
    const lower = mean - this.standardDeviation * std;
    const width = upper - lower;
    this.value = {
      upper,
      middle: mean,
      lower,
      bandwidth: mean === 0 ? NaN : width / mean,
      percentB: width === 0 ? NaN : (value - lower) / width,
    };
    return this.value;
  }

  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('bbands', {
      period: this.period,
      standardDeviation: this.standardDeviation,
      buf: [...this.buf],
      value: this.value,
    });
  }

  static fromJSON(snapshot: TechnicalAnalysisSnapshot): BollingerStream {
    const state = readSnapshot(snapshot, 'bbands');
    const x = new BollingerStream({
      period: state.lookback('period'),
      standardDeviation: state.number('standardDeviation'),
    });
    x.buf = state.numbers('buf');
    x.value = state.cached<BollingerPoint>('value');
    return x;
  }
}

const nanPoint = (): BollingerPoint => ({
  upper: NaN,
  middle: NaN,
  lower: NaN,
  bandwidth: NaN,
  percentB: NaN,
});

export const bbands = withBuiltinMetadata(
  makeIndicator<BollingerParameters, number, BollingerPoint>(
    (p) =>
      new BollingerStream({
        period: requirePeriod(p.period ?? 20, 'bbands'),
        standardDeviation: requirePositive(p.standardDeviation ?? 2, 'bbands', 'standardDeviation'),
      }),
    BollingerStream.fromJSON,
    nanPoint,
  ),
  builtinMetadata.bbandsMetadata,
);

export { BollingerStream };
