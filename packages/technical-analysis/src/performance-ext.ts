/** pandas-ta performance-style indicators that are useful inside TA pipelines. */

import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';

type Empty = Record<never, never>;

export interface DrawdownPoint {
  /** Peak-to-current decline in price/equity units. */
  drawdown: number;
  /** Peak-to-current decline as a positive fraction. */
  percent: number;
  /** Log drawdown: `log(peak) - log(value)`. */
  log: number;
}

class DrawdownStream implements IndicatorStream<number, DrawdownPoint> {
  private peak = -Infinity;
  value: DrawdownPoint | null = null;
  next(value: number): DrawdownPoint | null {
    if (value > this.peak) this.peak = value;
    this.value = {
      drawdown: this.peak - value,
      percent: this.peak === 0 ? NaN : 1 - value / this.peak,
      log: Math.log(this.peak) - Math.log(value),
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('drawdown', { peak: this.peak, value: this.value });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): DrawdownStream {
    const state = readSnapshot(snapshot, 'drawdown');
    const x = new DrawdownStream();
    x.peak = state.number('peak');
    x.value = state.cached<DrawdownPoint>('value');
    return x;
  }
}

export const drawdown = makeIndicator<Empty, number, DrawdownPoint>(
  () => new DrawdownStream(),
  DrawdownStream.fromJSON,
  () => ({ drawdown: NaN, percent: NaN, log: NaN }),
);

export { DrawdownStream };
