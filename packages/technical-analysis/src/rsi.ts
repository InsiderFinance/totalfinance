/**
 * `@insiderfinance/totalfinance/technical-analysis/rsi` — Wilder's Relative Strength Index (spec §13.3).
 *
 * A lean deep entrypoint: the framework and RSI's own contract, never the discovery registry.
 */

import * as builtinMetadata from './builtin-metadata.js';
import { withBuiltinMetadata } from './indicator-metadata.js';
import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { requirePeriod } from './validate.js';

export interface RsiParameters {
  /** Wilder lookback. Defaults to 14 (TA-Lib and pandas-ta agree); echoed via `.explain()`. */
  period?: number;
}

class RsiStream implements IndicatorStream<number, number> {
  private prev: number | null = null;
  private count = 0;
  private sumGain = 0;
  private sumLoss = 0;
  private averageGain = 0;
  private averageLoss = 0;
  private seeded = false;
  value: number | null = null;

  constructor(private readonly period: number) {
    requirePeriod(period, 'RsiStream');
  }

  private rsi(): number {
    if (this.averageLoss === 0) return 100;
    const rs = this.averageGain / this.averageLoss;
    return 100 - 100 / (1 + rs);
  }

  next(value: number): number | null {
    if (this.prev === null) {
      this.prev = value;
      this.value = null;
      return null;
    }
    const change = value - this.prev;
    this.prev = value;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    this.count++;

    if (!this.seeded) {
      this.sumGain += gain;
      this.sumLoss += loss;
      if (this.count === this.period) {
        this.averageGain = this.sumGain / this.period;
        this.averageLoss = this.sumLoss / this.period;
        this.seeded = true;
        this.value = this.rsi();
        return this.value;
      }
      this.value = null;
      return null;
    }

    this.averageGain = (this.averageGain * (this.period - 1) + gain) / this.period;
    this.averageLoss = (this.averageLoss * (this.period - 1) + loss) / this.period;
    this.value = this.rsi();
    return this.value;
  }

  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('rsi', {
      period: this.period,
      prev: this.prev,
      count: this.count,
      sumGain: this.sumGain,
      sumLoss: this.sumLoss,
      averageGain: this.averageGain,
      averageLoss: this.averageLoss,
      seeded: this.seeded,
      value: this.value,
    });
  }

  static fromJSON(snapshot: TechnicalAnalysisSnapshot): RsiStream {
    const state = readSnapshot(snapshot, 'rsi');
    const x = new RsiStream(state.lookback('period'));
    x.prev = state.numberOrNull('prev');
    x.count = state.number('count');
    x.sumGain = state.number('sumGain');
    x.sumLoss = state.number('sumLoss');
    x.averageGain = state.number('averageGain');
    x.averageLoss = state.number('averageLoss');
    x.seeded = state.boolean('seeded');
    x.value = state.cached<number>('value');
    return x;
  }
}

/**
 * Wilder's RSI (period 14 default, disclosed via `.explain()`).
 *
 * Flat-series convention: when the average loss over the window is zero (a flat or monotonically
 * rising series), TotalFinance returns **100** (the RS → ∞ limit; TradingView's convention). TA-Lib
 * emits 0 there and pandas-ta NaN — see `docs/compatibility/talib-differences.md`.
 */
export const rsi = withBuiltinMetadata(
  makeIndicator<RsiParameters, number, number>(
    (p) => new RsiStream(requirePeriod(p.period ?? 14, 'rsi')),
    RsiStream.fromJSON,
    () => NaN,
  ),
  builtinMetadata.rsiMetadata,
);

export { RsiStream };
