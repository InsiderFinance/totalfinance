import { describe, expect, it } from 'vitest';
import { sma, ema } from '@totalfinance/technical-analysis/moving-averages';
import { macd } from '@totalfinance/technical-analysis/macd';
import { bbands } from '@totalfinance/technical-analysis/bands';
import { features } from '@totalfinance/technical-analysis/pipeline';
import { rsi } from '@totalfinance/technical-analysis/rsi';
import { atr, vwap } from '@totalfinance/technical-analysis/bars';
import { returns } from '@totalfinance/technical-analysis/series';
import {
  makeIndicator,
  closes as closesOf,
  SCHEMA_VERSION,
  checkSnapshotVersion,
} from '@totalfinance/technical-analysis/framework';
import { typicalPrice } from '@totalfinance/technical-analysis/transforms';
import { roc, cci } from '@totalfinance/technical-analysis/oscillators';
import { supertrend } from '@totalfinance/technical-analysis/trend';
import { keltner } from '@totalfinance/technical-analysis/volatility';
import { mfi } from '@totalfinance/technical-analysis/volume';
import { candlesticks } from '@totalfinance/technical-analysis/candlesticks';
import { renko, imbalanceBars, dollarRunBars } from '@totalfinance/technical-analysis/chart-types';
import { pivots, fibRetracement, gapFill } from '@totalfinance/technical-analysis/price-action';
import { signal, crossOver } from '@totalfinance/technical-analysis/signal';
import { listIndicators } from '@totalfinance/technical-analysis/registry';
import { htDcPeriod } from '@totalfinance/technical-analysis/cycle';
import {
  movingAverage,
  rollingSum,
  beta,
  pairs,
} from '@totalfinance/technical-analysis/statistics';
import {
  zScore,
  cumulativeSum,
  skew,
  winsorize,
  covariance,
  barSince,
} from '@totalfinance/technical-analysis/features';
import { cdlPattern } from '@totalfinance/technical-analysis/candle-aliases';
import { coppock, kdj as kdjExt } from '@totalfinance/technical-analysis/momentum';
import { jma, vwapBands } from '@totalfinance/technical-analysis/overlap';
import { choppinessIndex, pMax } from '@totalfinance/technical-analysis/trend';
import { ulcerIndex, volatilityStop } from '@totalfinance/technical-analysis/volatility';
import { archerObv, williamsAd } from '@totalfinance/technical-analysis/volume';
import { resolveIndicator } from '@totalfinance/technical-analysis/aliases';
import { indicatorWarmups } from '@totalfinance/technical-analysis/warmup';
import {
  fairValueGaps,
  liquiditySweeps,
  atrTrailingStop,
  equalHighs,
} from '@totalfinance/technical-analysis/price-action';

// Each per-feature deep entrypoint resolves and exports a working indicator (design law #9).
describe('@totalfinance/technical-analysis deep entrypoints', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);

  it('moving-averages / macd / bands / pipeline / rsi are importable per-feature', () => {
    expect(sma(closes, { period: 10 })).toHaveLength(closes.length);
    expect(ema(closes, { period: 10 })).toHaveLength(closes.length);
    const m = macd(closes, { fast: 12, slow: 26, signal: 9 });
    expect(m).toHaveLength(closes.length);
    expect(bbands(closes, { period: 20 })).toHaveLength(closes.length);
    expect(rsi(closes, { period: 14 })).toHaveLength(closes.length);
    expect(typeof features).toBe('function');
  });

  it('bars / series / framework are importable per-feature', () => {
    const bars = closes.map((c, i) => ({
      open: c,
      high: c + 1,
      low: c - 1,
      close: c,
      volume: 100 + i,
    }));
    expect(atr(bars, { period: 14 })).toHaveLength(bars.length);
    expect(vwap(bars, {})).toHaveLength(bars.length);
    expect(returns(closes, {})).toHaveLength(closes.length);
    // framework: makeIndicator + closes helper are the building blocks for custom indicators.
    expect(typeof makeIndicator).toBe('function');
    expect(closesOf(bars)).toHaveLength(bars.length);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(() =>
      checkSnapshotVersion({ kind: 'sma', schemaVersion: SCHEMA_VERSION, state: {} }),
    ).not.toThrow();
  });

  it('Phase 4 family entrypoints (transforms / oscillators / trend / volatility / volume) resolve', () => {
    const bars = closes.map((c) => ({ open: c, high: c + 1, low: c - 1, close: c, volume: 100 }));
    expect(typicalPrice(bars, {})).toHaveLength(bars.length);
    expect(roc(closes, { period: 5 })).toHaveLength(closes.length);
    expect(cci(bars, { period: 14 })).toHaveLength(bars.length);
    expect(supertrend(bars, { period: 10 })).toHaveLength(bars.length);
    expect(keltner(bars, { period: 14 })).toHaveLength(bars.length);
    expect(mfi(bars, { period: 14 })).toHaveLength(bars.length);
  });

  it('candlesticks / chart-types / price-action / signal / registry entrypoints resolve', () => {
    const bars = closes.map((c) => ({ open: c, high: c + 1, low: c - 1, close: c, volume: 100 }));
    expect(candlesticks['doji']!(bars, {})).toHaveLength(bars.length);
    expect(Array.isArray(renko(bars, { brickSize: 1 }))).toBe(true);
    expect(Array.isArray(imbalanceBars(bars, { threshold: 3 }))).toBe(true);
    expect(Array.isArray(dollarRunBars(bars, { threshold: 1e6 }))).toBe(true);
    expect(pivots(bars[0]!, 'classic').pivot).toBeGreaterThan(0);
    expect(fibRetracement(100, 110)).toHaveLength(7);
    expect(Array.isArray(gapFill(bars).events)).toBe(true);
    const out = signal(bars)
      .sma('close', { period: 3 }, { as: 'f' })
      .when(crossOver('f', 'close'))
      .emit('x')
      .signals();
    expect(out).toHaveLength(bars.length);
    expect(listIndicators().length).toBeGreaterThan(120);
  });

  it('P0 parity entrypoints (cycle / stats / candle-aliases) resolve', () => {
    const bars = closes.map((c) => ({ open: c, high: c + 1, low: c - 1, close: c, volume: 100 }));
    expect(htDcPeriod(closes, {})).toHaveLength(closes.length);
    expect(movingAverage(closes, { period: 5, movingAverageType: 'ema' })).toHaveLength(
      closes.length,
    );
    expect(rollingSum(closes, { period: 5 })).toHaveLength(closes.length);
    expect(beta(pairs(closes, closes), { period: 10 })).toHaveLength(closes.length);
    expect(cdlPattern(bars, 'CDLDOJI')).toHaveLength(bars.length);
    expect(coppock(closes, {})).toHaveLength(closes.length);
    expect(zScore(closes, { period: 20 })).toHaveLength(closes.length);
    expect(cumulativeSum(closes, {})).toHaveLength(closes.length);
    expect(skew(closes, { period: 20 })).toHaveLength(closes.length);
    expect(winsorize(closes, { period: 20 })).toHaveLength(closes.length);
    expect(covariance(pairs(closes, closes), { period: 20 })).toHaveLength(closes.length);
    expect(barSince(closes, {})).toHaveLength(closes.length);
    expect(kdjExt(bars, {})).toHaveLength(bars.length);
    expect(jma(closes, { period: 7 })).toHaveLength(closes.length);
    expect(vwapBands(bars, {})).toHaveLength(bars.length);
    expect(choppinessIndex(bars, { period: 14 })).toHaveLength(bars.length);
    expect(pMax(bars, { period: 10 })).toHaveLength(bars.length);
    expect(ulcerIndex(closes, { period: 14 })).toHaveLength(closes.length);
    expect(volatilityStop(bars, { period: 20 })).toHaveLength(bars.length);
    expect(archerObv(bars, { fast: 4, slow: 12 })).toHaveLength(bars.length);
    expect(williamsAd(bars, {})).toHaveLength(bars.length);
    expect(resolveIndicator('WILLR')?.name).toBe('williamsR');
    expect(indicatorWarmups().length).toBeGreaterThan(120);
    expect(fairValueGaps(bars, {})).toHaveLength(bars.length);
    expect(liquiditySweeps(bars, { lookback: 10 })).toHaveLength(bars.length);
    expect(atrTrailingStop(bars, { period: 14 })).toHaveLength(bars.length);
    expect(equalHighs(bars, { strength: 2 })).toHaveLength(bars.length);
  });
});
