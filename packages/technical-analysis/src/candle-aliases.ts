/**
 * TA-Lib-compatible candlestick access (spec §13.3).
 *
 * `cdlPattern(bars, name)` runs a single pattern by either its TotalFinance name (`engulfing`) or its
 * TA-Lib `CDL*` name (`CDLENGULFING`) — or `'all'` to scan the whole catalog. `CDL_ALIASES` is the
 * full TA-Lib → TotalFinance name map. `cdlInside` is the inside-bar pattern facade.
 */

import { requireArgumentArray, ErrorCode, InputError } from '@totalfinance/core';
import { candlesticks, candlestickNames, detectCandles, type CandleMatch } from './candlesticks.js';
import {
  type BarInput,
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
  makeIndicator,
  snapshotOf,
  readSnapshot,
} from './framework.js';
import { requireAtMost, requireNonNegativeInt, requireOneOf, requirePeriod } from './validate.js';
import { requireStreamParameters } from './stream-validation.js';

/** TA-Lib `CDL*` function name → TotalFinance catalog name. */
export const CDL_ALIASES: Readonly<Record<string, string>> = {
  CDL2CROWS: 'twoCrows',
  CDL3BLACKCROWS: 'threeBlackCrows',
  CDL3INSIDE: 'threeInside',
  CDL3LINESTRIKE: 'threeLineStrike',
  CDL3OUTSIDE: 'threeOutside',
  CDL3STARSINSOUTH: 'threeStarsInSouth',
  CDL3WHITESOLDIERS: 'threeWhiteSoldiers',
  CDLABANDONEDBABY: 'abandonedBaby',
  CDLADVANCEBLOCK: 'advanceBlock',
  CDLBELTHOLD: 'beltHold',
  CDLBREAKAWAY: 'breakaway',
  CDLCLOSINGMARUBOZU: 'closingMarubozu',
  CDLCONCEALBABYSWALL: 'concealBabySwallow',
  CDLCOUNTERATTACK: 'counterattack',
  CDLDARKCLOUDCOVER: 'darkCloudCover',
  CDLDOJI: 'doji',
  CDLDOJISTAR: 'dojiStar',
  CDLDRAGONFLYDOJI: 'dragonflyDoji',
  CDLENGULFING: 'engulfing',
  CDLEVENINGDOJISTAR: 'eveningDojiStar',
  CDLEVENINGSTAR: 'eveningStar',
  CDLGAPSIDESIDEWHITE: 'gapSideSideWhite',
  CDLGRAVESTONEDOJI: 'gravestoneDoji',
  CDLHAMMER: 'hammer',
  CDLHANGINGMAN: 'hangingMan',
  CDLHARAMI: 'harami',
  CDLHARAMICROSS: 'haramiCross',
  CDLHIGHWAVE: 'highWave',
  CDLHIKKAKE: 'hikkake',
  CDLHIKKAKEMOD: 'hikkakeMod',
  CDLHOMINGPIGEON: 'homingPigeon',
  CDLIDENTICAL3CROWS: 'identicalThreeCrows',
  CDLINNECK: 'inNeck',
  CDLINSIDE: 'inside',
  CDLINVERTEDHAMMER: 'invertedHammer',
  CDLKICKING: 'kicking',
  CDLKICKINGBYLENGTH: 'kickingByLength',
  CDLLADDERBOTTOM: 'ladderBottom',
  CDLLONGLEGGEDDOJI: 'longLeggedDoji',
  CDLLONGLINE: 'longLine',
  CDLMARUBOZU: 'marubozu',
  CDLMATCHINGLOW: 'matchingLow',
  CDLMATHOLD: 'matHold',
  CDLMORNINGDOJISTAR: 'morningDojiStar',
  CDLMORNINGSTAR: 'morningStar',
  CDLONNECK: 'onNeck',
  CDLPIERCING: 'piercing',
  CDLRICKSHAWMAN: 'rickshawMan',
  CDLRISEFALL3METHODS: 'riseFallThreeMethods',
  CDLSEPARATINGLINES: 'separatingLines',
  CDLSHOOTINGSTAR: 'shootingStar',
  CDLSHORTLINE: 'shortLine',
  CDLSPINNINGTOP: 'spinningTop',
  CDLSTALLEDPATTERN: 'stalledPattern',
  CDLSTICKSANDWICH: 'stickSandwich',
  CDLTAKURI: 'takuri',
  CDLTASUKIGAP: 'tasukiGap',
  CDLTHRUSTING: 'thrusting',
  CDLTRISTAR: 'triStar',
  CDLUNIQUE3RIVER: 'uniqueThreeRiver',
  CDLUPSIDEGAP2CROWS: 'upsideGapTwoCrows',
  CDLXSIDEGAP3METHODS: 'xSideGapThreeMethods',
};

/** pandas-ta `cdl_pattern(name=...)` pattern name → TotalFinance catalog name. */
export const PANDAS_CDL_ALIASES: Readonly<Record<string, string>> = {
  '2crows': 'twoCrows',
  '3blackcrows': 'threeBlackCrows',
  '3inside': 'threeInside',
  '3linestrike': 'threeLineStrike',
  '3outside': 'threeOutside',
  '3starsinsouth': 'threeStarsInSouth',
  '3whitesoldiers': 'threeWhiteSoldiers',
  abandonedbaby: 'abandonedBaby',
  advanceblock: 'advanceBlock',
  belthold: 'beltHold',
  breakaway: 'breakaway',
  closingmarubozu: 'closingMarubozu',
  concealbabyswall: 'concealBabySwallow',
  counterattack: 'counterattack',
  darkcloudcover: 'darkCloudCover',
  doji: 'doji',
  dojistar: 'dojiStar',
  dragonflydoji: 'dragonflyDoji',
  engulfing: 'engulfing',
  eveningdojistar: 'eveningDojiStar',
  eveningstar: 'eveningStar',
  gapsidesidewhite: 'gapSideSideWhite',
  gravestonedoji: 'gravestoneDoji',
  hammer: 'hammer',
  hangingman: 'hangingMan',
  harami: 'harami',
  haramicross: 'haramiCross',
  highwave: 'highWave',
  hikkake: 'hikkake',
  hikkakemod: 'hikkakeMod',
  homingpigeon: 'homingPigeon',
  identical3crows: 'identicalThreeCrows',
  inside: 'inside',
  inneck: 'inNeck',
  invertedhammer: 'invertedHammer',
  kicking: 'kicking',
  kickingbylength: 'kickingByLength',
  ladderbottom: 'ladderBottom',
  longleggeddoji: 'longLeggedDoji',
  longline: 'longLine',
  marubozu: 'marubozu',
  matchinglow: 'matchingLow',
  mathold: 'matHold',
  morningdojistar: 'morningDojiStar',
  morningstar: 'morningStar',
  onneck: 'onNeck',
  piercing: 'piercing',
  rickshawman: 'rickshawMan',
  risefall3methods: 'riseFallThreeMethods',
  separatinglines: 'separatingLines',
  shootingstar: 'shootingStar',
  shortline: 'shortLine',
  spinningtop: 'spinningTop',
  stalledpattern: 'stalledPattern',
  sticksandwich: 'stickSandwich',
  takuri: 'takuri',
  tasukigap: 'tasukiGap',
  thrusting: 'thrusting',
  tristar: 'triStar',
  unique3river: 'uniqueThreeRiver',
  upsidegap2crows: 'upsideGapTwoCrows',
  xsidegap3methods: 'xSideGapThreeMethods',
};

/** Resolve a TotalFinance or TA-Lib `CDL*` pattern name to the TotalFinance catalog name (throws if unknown). */
export function resolveCandleName(name: string): string {
  if (typeof name !== 'string') {
    throw new InputError(
      `resolveCandleName: name must be an indicator name string, got ${
        name === null ? 'null' : typeof name
      }.`,
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  const pandasKey = name.toLowerCase().replace(/^cdl_/, '').replace(/_/g, '');
  const resolved = CDL_ALIASES[name.toUpperCase()] ?? PANDAS_CDL_ALIASES[pandasKey] ?? name;
  return requireOneOf(resolved, candlestickNames, 'cdlPattern', 'name');
}

/**
 * Run a single candlestick pattern by TotalFinance or TA-Lib name, returning the aligned ±100/0 series.
 * Pass `'all'` to scan the full catalog (returns per-bar matches instead).
 */
export function cdlPattern(bars: ArrayLike<BarInput>, name: string): number[];
export function cdlPattern(bars: ArrayLike<BarInput>, name: 'all'): CandleMatch[][];
export function cdlPattern(bars: ArrayLike<BarInput>, name: string): number[] | CandleMatch[][] {
  requireArgumentArray('cdlPattern', 'bars', bars);
  if (name === 'all') return detectCandles(bars);
  return candlesticks[resolveCandleName(name)]!(bars, {});
}

/** Inside-bar pattern (TA-Lib `CDLINSIDE`): +100 bullish inside, −100 bearish inside, else 0. */
export const cdlInside = candlesticks['inside']!;
/** Dedicated Doji pattern accessor (pandas-ta `cdl_doji`). */
export const cdlDoji = candlesticks['doji']!;

export interface CandleZParameters {
  period?: number;
  /** Delta degrees of freedom for the sample standard deviation. Default 1. */
  ddof?: number;
}
export interface CandleZPoint {
  open: number;
  high: number;
  low: number;
  close: number;
}

function zLast(xs: readonly number[], ddof: number): number {
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / xs.length;
  let acc = 0;
  for (const x of xs) acc += (x - mean) ** 2;
  const variance = acc / (xs.length - ddof);
  const sd = Math.sqrt(variance);
  return sd === 0 ? NaN : (xs[xs.length - 1]! - mean) / sd;
}

class CandleZStream implements IndicatorStream<BarInput, CandleZPoint> {
  private open: number[] = [];
  private high: number[] = [];
  private low: number[] = [];
  private close: number[] = [];
  value: CandleZPoint | null = null;
  private readonly period: number;
  private readonly ddof: number;
  constructor(parameters: { period: number; ddof: number }) {
    requireStreamParameters('CandleZStream.constructor#0', 'CandleZStream', parameters);
    const { period, ddof } = parameters;
    this.period = period;
    this.ddof = ddof;
  }
  next(bar: BarInput): CandleZPoint | null {
    this.open.push(bar.open ?? bar.close);
    this.high.push(bar.high);
    this.low.push(bar.low);
    this.close.push(bar.close);
    if (this.open.length > this.period) {
      this.open.shift();
      this.high.shift();
      this.low.shift();
      this.close.shift();
    }
    if (this.open.length < this.period) {
      this.value = null;
      return null;
    }
    this.value = {
      open: zLast(this.open, this.ddof),
      high: zLast(this.high, this.ddof),
      low: zLast(this.low, this.ddof),
      close: zLast(this.close, this.ddof),
    };
    return this.value;
  }
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('cdlZ', {
      period: this.period,
      ddof: this.ddof,
      open: [...this.open],
      high: [...this.high],
      low: [...this.low],
      close: [...this.close],
      value: this.value,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CandleZStream {
    const state = readSnapshot(snapshot, 'cdlZ');
    const x = new CandleZStream({
      period: state.lookback('period'),
      ddof: state.number('ddof'),
    });
    x.open = state.numbers('open');
    x.high = state.numbers('high');
    x.low = state.numbers('low');
    x.close = state.numbers('close');
    x.value = state.cached<CandleZPoint>('value');
    return x;
  }
}

/** pandas-ta `cdl_z`: rolling sample z-score normalization of OHLC candles. */
export const cdlZ = makeIndicator<CandleZParameters, BarInput, CandleZPoint>(
  (p) => {
    const period = requirePeriod(p.period ?? 30, 'cdlZ', 'period', 2);
    const ddof = requireNonNegativeInt(p.ddof ?? 1, 'cdlZ', 'ddof');
    requireAtMost(ddof, period - 1, 'cdlZ', 'ddof', 'period - 1');
    return new CandleZStream({ period, ddof });
  },
  CandleZStream.fromJSON,
  () => ({ open: NaN, high: NaN, low: NaN, close: NaN }),
);

export { CandleZStream };
