/** Returns and rolling volatility (spec §13.3). */

import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { requirePeriod, requireAnnualization } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

export interface RollingVolatilityParameters {
  period: number;
  /** Bars per year: multiplies the per-period stddev by √annualization (252 daily, 52 weekly, 12 monthly); `1` = per-bar. Required. */
  annualization: number;
}

class ReturnsStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  value: number | null = null;
  next(value: number): number | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    const r = (value - this.prev) / this.prev;
    this.prev = value;
    this.value = r;
    return r;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('returns', { prev: this.prev, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): ReturnsStream {
    const state = readSnapshot(snapshot, 'returns');
    const x = new ReturnsStream();
    x.prev = state.numberOrNull('prev');
    x.value = state.cached<number>('value');
    return x;
  }
}

class LogReturnsStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  value: number | null = null;
  next(value: number): number | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    const r = Math.log(value / this.prev);
    this.prev = value;
    this.value = r;
    return r;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('logReturns', { prev: this.prev, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): LogReturnsStream {
    const state = readSnapshot(snapshot, 'logReturns');
    const x = new LogReturnsStream();
    x.prev = state.numberOrNull('prev');
    x.value = state.cached<number>('value');
    return x;
  }
}

class RollingVolatilityStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  private buf: number[] = [];
  value: number | null = null;
  private readonly period: number;
  private readonly scale: number;
  constructor(parameters: { period: number; scale: number }) {
    requireStreamParameters(
      'RollingVolatilityStream.constructor#0',
      'RollingVolatilityStream',
      parameters,
    );
    const { period, scale } = parameters;
    this.period = period;
    this.scale = scale;
  }
  next(value: number): number | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    const r = (value - this.prev) / this.prev;
    this.prev = value;
    this.buf.push(r);
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
    const sd = Math.sqrt(acc / (this.period - 1)); // sample std
    this.value = sd * Math.sqrt(this.scale);
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rollingVolatility', {
      period: this.period,
      scale: this.scale,
      prev: this.prev,
      buf: [...this.buf],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RollingVolatilityStream {
    const state = readSnapshot(snapshot, 'rollingVolatility');
    const x = new RollingVolatilityStream({
      period: state.lookback('period'),
      scale: state.number('scale'),
    });
    x.prev = state.numberOrNull('prev');
    x.buf = state.numbers('buf');
    x.value = state.cached<number>('value');
    return x;
  }
}

export const returns = withBuiltinMetadata(
  makeIndicator<Record<never, never>, number, number>(
    () => new ReturnsStream(),
    ReturnsStream.fromJSON,
    () => NaN,
  ),
  builtinMetadata.returnsMetadata,
);

export const logReturns = withBuiltinMetadata(
  makeIndicator<Record<never, never>, number, number>(
    () => new LogReturnsStream(),
    LogReturnsStream.fromJSON,
    () => NaN,
  ),
  builtinMetadata.logReturnsMetadata,
);

export const rollingVolatility = withBuiltinMetadata(
  makeIndicator<RollingVolatilityParameters, number, number>(
    (p) =>
      new RollingVolatilityStream({
        period: requirePeriod(p.period, 'rollingVolatility', 'period', 2),
        scale: requireAnnualization(p.annualization, 'rollingVolatility'),
      }),
    RollingVolatilityStream.fromJSON,
    () => NaN,
  ),
  builtinMetadata.rollingVolatilityMetadata,
);

export { ReturnsStream, LogReturnsStream, RollingVolatilityStream };
