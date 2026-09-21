/**
 * Package-private built-in contracts, shared by leaf construction and registry discovery.
 * Named exports keep a leaf independent of the full catalog: never collect these into a runtime
 * lookup table on a compute path. Defaults remain values/functions, not serialized documentation.
 */
import type { BuiltinIndicatorMetadata } from './indicator-metadata.js';

/** A derived default reads the already-resolved sibling, after literal defaults and caller input. */
const sib =
  (name: string) =>
  (resolved: Record<string, unknown>): unknown =>
    resolved[name];

/** All generated candlestick facades share this parameter-free bars contract. */
export const candlestickMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const typicalPriceMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const medianPriceMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const weightedCloseMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const averagePriceMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const realBodyMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const upperShadowMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const lowerShadowMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const candleRangeMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const trueRangeMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const gapMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const heikinAshiMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const returnsMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const logReturnsMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const rollingVolatilityMetadata = {
  inputs: 'series',
  parameters: ['period', 'annualization'],
} satisfies BuiltinIndicatorMetadata;

export const smaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const emaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const wmaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const rmaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const demaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const temaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const trimaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const t3Metadata = {
  inputs: 'series',
  parameters: ['period', 'volumeFactor'],
  defaults: { volumeFactor: 0.7 },
} satisfies BuiltinIndicatorMetadata;

export const kamaMetadata = {
  inputs: 'series',
  parameters: ['period', 'fast', 'slow'],
  defaults: { fast: 2, slow: 30 },
} satisfies BuiltinIndicatorMetadata;

export const hmaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const zlemaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const almaMetadata = {
  inputs: 'series',
  parameters: ['period', 'offset', 'sigma'],
  defaults: { offset: 0.85, sigma: 6 },
} satisfies BuiltinIndicatorMetadata;

export const vidyaMetadata = {
  inputs: 'series',
  parameters: ['period', 'cmoPeriod'],
  defaults: { cmoPeriod: /* @__PURE__ */ sib('period') },
} satisfies BuiltinIndicatorMetadata;

export const mcginleyMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const superSmootherMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const vwmaMetadata = {
  inputs: 'bars',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const rollingVwapMetadata = {
  inputs: 'bars',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const anchoredVwapMetadata = {
  inputs: 'bars',
  parameters: ['anchor'],
} satisfies BuiltinIndicatorMetadata;

export const framaMetadata = {
  inputs: 'bars',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const mamaMetadata = {
  inputs: 'bars',
  parameters: ['fastLimit', 'slowLimit'],
  defaults: { fastLimit: 0.5, slowLimit: 0.05 },
  conventions: {
    input:
      'a BARS indicator on the (H+L)/2 median price (Ehlers’ original); TA-Lib applies any single series',
    reference: 'feed high = low = close to reproduce TA-Lib’s close-based MAMA',
  },
} satisfies BuiltinIndicatorMetadata;

export const movingAverageMetadata = {
  inputs: 'series',
  parameters: ['period', 'movingAverageType'],
  defaults: { movingAverageType: 'sma' },
} satisfies BuiltinIndicatorMetadata;

export const midpointMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const midpriceMetadata = {
  inputs: 'bars',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const fwmaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const sineWmaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const pascalWmaMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const symmetricWmaMetadata = trimaMetadata;

export const jmaMetadata = {
  inputs: 'series',
  parameters: ['period', 'phase', 'power'],
  defaults: { phase: 0, power: 1 },
} satisfies BuiltinIndicatorMetadata;

export const holtWinterMovingAverageMetadata = {
  inputs: 'series',
  parameters: ['levelSmoothing', 'trendSmoothing', 'accelerationSmoothing'],
  defaults: { levelSmoothing: 0.2, trendSmoothing: 0.1, accelerationSmoothing: 0.1 },
} satisfies BuiltinIndicatorMetadata;

export const rainbowMovingAverageMetadata = {
  inputs: 'series',
  parameters: ['period', 'levels'],
  defaults: { period: 2, levels: 10 },
} satisfies BuiltinIndicatorMetadata;

export const movingAverageRibbonMetadata = {
  inputs: 'series',
  parameters: ['periods'],
  defaults: { periods: [10, 20, 30, 40, 50] },
} satisfies BuiltinIndicatorMetadata;

export const gannHighLowActivatorMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 3 },
} satisfies BuiltinIndicatorMetadata;

export const vwapBandsMetadata = {
  inputs: 'bars',
  parameters: ['multiplier'],
  defaults: { multiplier: 2 },
} satisfies BuiltinIndicatorMetadata;

export const sessionVwapMetadata = {
  inputs: 'bars',
  parameters: ['resetEvery'],
} satisfies BuiltinIndicatorMetadata;

export const rollingAnchoredVwapMetadata = {
  inputs: 'bars',
  parameters: ['lookback', 'anchor'],
  defaults: { lookback: 50, anchor: 'low' },
} satisfies BuiltinIndicatorMetadata;

export const rsiMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 14 },
  conventions: {
    smoothing: 'wilder',
    // The one that surprises people: TA-Lib says 0 here and pandas-ta says NaN.
    flatSeries: 'returns 100 (the RS → ∞ limit, TradingView); TA-Lib returns 0, pandas-ta NaN',
    reference: 'bit-identical to TA-Lib on any series carrying both gains and losses',
  },
} satisfies BuiltinIndicatorMetadata;

export const macdMetadata = {
  inputs: 'series',
  parameters: ['fast', 'slow', 'signal'],
  defaults: { fast: 12, slow: 26, signal: 9 },
  conventions: {
    seeding: 'fast and slow EMAs seeded independently (TradingView)',
    reference: 'TA-Lib re-seeds the fast EMA at the slow period’s start and trims the line',
  },
} satisfies BuiltinIndicatorMetadata;

export const rocMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 10 },
} satisfies BuiltinIndicatorMetadata;

export const rocpMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 10 },
} satisfies BuiltinIndicatorMetadata;

export const rocrMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 10 },
} satisfies BuiltinIndicatorMetadata;

export const rocr100Metadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 10 },
} satisfies BuiltinIndicatorMetadata;

export const momentumMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 10 },
} satisfies BuiltinIndicatorMetadata;

export const cmoMetadata = {
  inputs: 'series',
  parameters: ['period', 'talib'],
  defaults: { period: 14, talib: false },
  conventions: {
    smoothing: "Chande's original simple sums (pandas-ta default), NOT Wilder",
    talibMode: 'cmo(…, { talib: true }) reproduces TA-Lib’s Wilder CMO (2·RSI − 100) exactly',
  },
} satisfies BuiltinIndicatorMetadata;

export const apoMetadata = {
  inputs: 'series',
  parameters: ['fast', 'slow'],
  defaults: { fast: 12, slow: 26 },
  conventions: { smoothing: 'EMA of fast/slow (TradingView); TA-Lib defaults to SMA (matype 0)' },
} satisfies BuiltinIndicatorMetadata;

export const ppoMetadata = {
  inputs: 'series',
  parameters: ['fast', 'slow', 'signal'],
  defaults: { fast: 12, slow: 26, signal: 9 },
  conventions: { smoothing: 'EMA of fast/slow (TradingView); TA-Lib defaults to SMA (matype 0)' },
} satisfies BuiltinIndicatorMetadata;

export const stochRsiMetadata = {
  inputs: 'series',
  parameters: ['rsiPeriod', 'stochPeriod', 'kPeriod', 'dPeriod'],
  defaults: { rsiPeriod: 14, stochPeriod: 14, kPeriod: 3, dPeriod: 3 },
  conventions: {
    smoothing: 'kPeriod/dPeriod smooth the RAW Stoch-RSI',
    flatWindow: 'returns 0 when the RSI window is flat, matching TA-Lib and pandas-ta',
    reference: 'exact vs TA-Lib with kPeriod: 1 (TA-Lib’s fastk is the raw %K)',
  },
} satisfies BuiltinIndicatorMetadata;

export const trixMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 30 },
  conventions: {
    firstValue:
      'first emitted at TA-Lib’s lookback 3·(period − 1) + 1; no value is fabricated earlier',
    zeroBase: 'a zero previous triple-EMA yields NaN, matching roc rather than reporting 0 change',
  },
} satisfies BuiltinIndicatorMetadata;

export const dpoMetadata = {
  inputs: 'series',
  parameters: ['period'],
  conventions: {
    form: "Pring's causal close[t − shift] − SMA(close, period)[t], shift = ⌊period/2⌋ + 1",
    lookahead:
      'none — pandas-ta’s centered=True result resolved BACKWARD so no value needs a future bar',
  },
} satisfies BuiltinIndicatorMetadata;

export const tsiMetadata = {
  inputs: 'series',
  parameters: ['long', 'short', 'signal'],
  defaults: { long: 25, short: 13, signal: 13 },
} satisfies BuiltinIndicatorMetadata;

export const kstMetadata = {
  inputs: 'series',
  parameters: ['rocPeriods', 'smaPeriods', 'signal'],
  defaults: { rocPeriods: [10, 15, 20, 30], smaPeriods: [10, 10, 10, 15], signal: 9 },
} satisfies BuiltinIndicatorMetadata;

export const connorsRsiMetadata = {
  inputs: 'series',
  parameters: ['rsiPeriod', 'streakPeriod', 'rankPeriod'],
  defaults: { rsiPeriod: 3, streakPeriod: 2, rankPeriod: 100 },
} satisfies BuiltinIndicatorMetadata;

export const macdExtMetadata = {
  inputs: 'series',
  parameters: [
    'fast',
    'slow',
    'signal',
    'fastMovingAverageType',
    'slowMovingAverageType',
    'signalMovingAverageType',
  ],
  defaults: {
    fast: 12,
    slow: 26,
    signal: 9,
    fastMovingAverageType: 'ema',
    slowMovingAverageType: 'ema',
    signalMovingAverageType: 'ema',
  },
} satisfies BuiltinIndicatorMetadata;

export const macdFixMetadata = {
  inputs: 'series',
  parameters: ['signal'],
  defaults: { signal: 9 },
  conventions: {
    seeding: 'fast and slow EMAs seeded independently (TradingView)',
    reference: 'TA-Lib re-seeds the fast EMA at the slow period’s start and trims the line',
  },
} satisfies BuiltinIndicatorMetadata;

export const cciMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const williamsRMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const awesomeOscillatorMetadata = {
  inputs: 'bars',
  parameters: ['fast', 'slow'],
  defaults: { fast: 5, slow: 34 },
} satisfies BuiltinIndicatorMetadata;

export const ultimateOscillatorMetadata = {
  inputs: 'bars',
  parameters: ['short', 'medium', 'long'],
  defaults: { short: 7, medium: 14, long: 28 },
} satisfies BuiltinIndicatorMetadata;

export const fisherTransformMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 9 },
} satisfies BuiltinIndicatorMetadata;

export const stochasticMetadata = {
  inputs: 'bars',
  parameters: ['kPeriod', 'dPeriod', 'smoothK'],
  defaults: { kPeriod: 14, dPeriod: 3, smoothK: 1 },
  conventions: {
    defaultForm: 'fast stochastic (smoothK: 1, raw %K); smoothK > 1 gives the classic slow form',
    flatWindow: 'returns 0 when the window high equals its low, matching TA-Lib and pandas-ta',
    reference: 'exact vs TA-Lib STOCH with { kPeriod, smoothK, dPeriod } and the SMA matype',
  },
} satisfies BuiltinIndicatorMetadata;

export const stochFastMetadata = {
  inputs: 'bars',
  parameters: ['kPeriod', 'dPeriod', 'smoothK'],
  defaults: { kPeriod: 14, dPeriod: 3, smoothK: 1 },
  conventions: {
    flatWindow: 'returns 0 when the window high equals its low, matching TA-Lib and pandas-ta',
  },
} satisfies BuiltinIndicatorMetadata;

export const bopMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const biasMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 26 },
} satisfies BuiltinIndicatorMetadata;

export const cfoMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const forecastOscillatorMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const coppockMetadata = {
  inputs: 'series',
  parameters: ['longRoc', 'shortRoc', 'wma'],
  defaults: { longRoc: 14, shortRoc: 11, wma: 10 },
} satisfies BuiltinIndicatorMetadata;

export const ctiMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 12 },
} satisfies BuiltinIndicatorMetadata;

export const efficiencyRatioMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 10 },
} satisfies BuiltinIndicatorMetadata;

export const centerOfGravityMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 10 },
} satisfies BuiltinIndicatorMetadata;

export const psychologicalLineMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 12 },
} satisfies BuiltinIndicatorMetadata;

export const slopeMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 1 },
} satisfies BuiltinIndicatorMetadata;

export const trixHistogramMetadata = {
  inputs: 'series',
  parameters: ['period', 'signal'],
  defaults: { period: 15, signal: 9 },
} satisfies BuiltinIndicatorMetadata;

export const smiErgodicMetadata = {
  inputs: 'series',
  parameters: ['long', 'short', 'signal'],
  defaults: { long: 20, short: 5, signal: 5 },
} satisfies BuiltinIndicatorMetadata;

export const pvoMetadata = {
  inputs: 'bars',
  parameters: ['fast', 'slow', 'signal'],
  defaults: { fast: 12, slow: 26, signal: 9 },
} satisfies BuiltinIndicatorMetadata;

export const elderRayMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 13 },
} satisfies BuiltinIndicatorMetadata;

export const brarMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 26 },
} satisfies BuiltinIndicatorMetadata;

export const kdjMetadata = {
  inputs: 'bars',
  parameters: ['period', 'signal'],
  defaults: { period: 9, signal: 3 },
} satisfies BuiltinIndicatorMetadata;

export const relativeVigorIndexMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const pgoMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const volumeWeightedMacdMetadata = {
  inputs: 'bars',
  parameters: ['fast', 'slow', 'signal'],
  defaults: { fast: 12, slow: 26, signal: 9 },
} satisfies BuiltinIndicatorMetadata;

export const inertiaMetadata = {
  inputs: 'series',
  parameters: ['period', 'rviPeriod'],
  defaults: { period: 20, rviPeriod: 14 },
} satisfies BuiltinIndicatorMetadata;

export const laguerreRsiMetadata = {
  inputs: 'series',
  parameters: ['gamma'],
  defaults: { gamma: 0.5 },
} satisfies BuiltinIndicatorMetadata;

export const qqeMetadata = {
  inputs: 'series',
  parameters: ['rsiPeriod', 'smooth', 'factor'],
  defaults: { rsiPeriod: 14, smooth: 5, factor: 4.236 },
} satisfies BuiltinIndicatorMetadata;

export const rsxMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const schaffTrendCycleMetadata = {
  inputs: 'series',
  parameters: ['fast', 'slow', 'cycle'],
  defaults: { fast: 23, slow: 50, cycle: 10 },
} satisfies BuiltinIndicatorMetadata;

export const squeezeMetadata = {
  inputs: 'bars',
  parameters: [
    'bollingerBandPeriod',
    'bollingerStandardDeviations',
    'keltnerChannelPeriod',
    'keltnerChannelMultiplier',
  ],
  defaults: {
    bollingerBandPeriod: 20,
    bollingerStandardDeviations: 2,
    keltnerChannelPeriod: 20,
    keltnerChannelMultiplier: 1.5,
  },
} satisfies BuiltinIndicatorMetadata;

export const squeezeProMetadata = {
  inputs: 'bars',
  parameters: [
    'bollingerBandPeriod',
    'bollingerStandardDeviations',
    'keltnerChannelPeriod',
    'wideKeltnerChannelMultiplier',
    'normalKeltnerChannelMultiplier',
    'narrowKeltnerChannelMultiplier',
  ],
  defaults: {
    bollingerBandPeriod: 20,
    bollingerStandardDeviations: 2,
    keltnerChannelPeriod: 20,
    wideKeltnerChannelMultiplier: 2,
    normalKeltnerChannelMultiplier: 1.5,
    narrowKeltnerChannelMultiplier: 1,
  },
} satisfies BuiltinIndicatorMetadata;

export const projectionOscillatorMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const tdSequentialMetadata = {
  inputs: 'bars',
  parameters: ['lookback'],
  defaults: { lookback: 4 },
} satisfies BuiltinIndicatorMetadata;

export const smcSweepMetadata = {
  inputs: 'bars',
  parameters: ['period', 'wickMultiplier'],
  defaults: { period: 15, wickMultiplier: 1.5 },
} satisfies BuiltinIndicatorMetadata;

export const adxMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
  conventions: {
    smoothing: 'wilder',
    seeding: 'RMA seed (TradingView); TA-Lib accumulates period − 1 then takes one Wilder step',
  },
} satisfies BuiltinIndicatorMetadata;

export const dmiMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const plusDIMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const minusDIMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const plusDMMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const minusDMMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const dxMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
  conventions: {
    smoothing: 'wilder',
    seeding: 'RMA seed (TradingView); TA-Lib accumulates period − 1 then takes one Wilder step',
    reference: 'converges to TA-Lib within ~1e-2 by ~6·period bars',
  },
} satisfies BuiltinIndicatorMetadata;

export const adxrMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
  conventions: {
    smoothing: 'wilder',
    lookback: 'averages ADX_t with ADX_{t−period}; TA-Lib reaches one bar less far (period − 1)',
    reference: 'approximate; documented rather than strictly asserted',
  },
} satisfies BuiltinIndicatorMetadata;

export const aroonMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const aroonOscillatorMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const psarMetadata = {
  inputs: 'bars',
  parameters: ['step', 'max'],
  defaults: { step: 0.02, max: 0.2 },
} satisfies BuiltinIndicatorMetadata;

export const psarExtMetadata = {
  inputs: 'bars',
  parameters: [
    'startValue',
    'offsetOnReverse',
    'accelInitLong',
    'accelLong',
    'accelMaxLong',
    'accelInitShort',
    'accelShort',
    'accelMaxShort',
  ],
  defaults: {
    startValue: 0,
    offsetOnReverse: 0,
    accelInitLong: 0.02,
    accelLong: 0.02,
    accelMaxLong: 0.2,
    accelInitShort: 0.02,
    accelShort: 0.02,
    accelMaxShort: 0.2,
  },
} satisfies BuiltinIndicatorMetadata;

export const supertrendMetadata = {
  inputs: 'bars',
  parameters: ['period', 'multiplier'],
  defaults: { multiplier: 3 },
  conventions: {
    seeding: 'seeds from the lower band, so the first direction is +1 (pandas-ta)',
  },
} satisfies BuiltinIndicatorMetadata;

export const ichimokuMetadata = {
  inputs: 'bars',
  parameters: ['conversion', 'base', 'spanB', 'displacement'],
  defaults: { conversion: 9, base: 26, spanB: 52, displacement: 26 },
} satisfies BuiltinIndicatorMetadata;

export const vortexMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const donchianTrendMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const chandelierExitMetadata = {
  inputs: 'bars',
  parameters: ['period', 'multiplier'],
  defaults: { multiplier: 3 },
} satisfies BuiltinIndicatorMetadata;

export const linregMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const linregSlopeMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const linregInterceptMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const linregAngleMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const tsfMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const choppinessIndexMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const chandeKrollStopMetadata = {
  inputs: 'bars',
  parameters: ['atrPeriod', 'multiplier', 'period'],
  defaults: { atrPeriod: 10, multiplier: 1, period: 9 },
} satisfies BuiltinIndicatorMetadata;

export const centralPivotRangeMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const amatMetadata = {
  inputs: 'series',
  parameters: ['fast', 'slow', 'lookback', 'movingAverageType'],
  defaults: { fast: 8, slow: 21, lookback: 2, movingAverageType: 'ema' },
} satisfies BuiltinIndicatorMetadata;

export const linearDecayMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 5 },
} satisfies BuiltinIndicatorMetadata;

export const exponentialDecayMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 5 },
} satisfies BuiltinIndicatorMetadata;

export const increasingMetadata = {
  inputs: 'series',
  parameters: ['period', 'strict'],
  defaults: { period: 1, strict: false },
} satisfies BuiltinIndicatorMetadata;

export const decreasingMetadata = {
  inputs: 'series',
  parameters: ['period', 'strict'],
  defaults: { period: 1, strict: false },
} satisfies BuiltinIndicatorMetadata;

export const longRunMetadata = {
  inputs: 'pair',
  parameters: ['period'],
  defaults: { period: 2 },
} satisfies BuiltinIndicatorMetadata;

export const shortRunMetadata = {
  inputs: 'pair',
  parameters: ['period'],
  defaults: { period: 2 },
} satisfies BuiltinIndicatorMetadata;

export const pMaxMetadata = {
  inputs: 'bars',
  parameters: ['period', 'multiplier'],
  defaults: { period: 10, multiplier: 3 },
} satisfies BuiltinIndicatorMetadata;

export const qstickMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 10 },
} satisfies BuiltinIndicatorMetadata;

export const ttmTrendMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 6 },
} satisfies BuiltinIndicatorMetadata;

export const verticalHorizontalFilterMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 28 },
} satisfies BuiltinIndicatorMetadata;

export const trendSignalsMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const crossSignalsMetadata = {
  inputs: 'series',
  parameters: ['above', 'below'],
  defaults: { above: 0, below: 0 },
} satisfies BuiltinIndicatorMetadata;

export const atrMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
  conventions: {
    smoothing: 'wilder',
    firstBar: "includes the first bar's range (TR[0] = H₀ − L₀, per Wilder); TA-Lib drops it",
    reference: 'converges to TA-Lib within ~1e-5 by ~5·period bars',
  },
} satisfies BuiltinIndicatorMetadata;

export const natrMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
  conventions: {
    smoothing: 'wilder',
    firstBar: "includes the first bar's range (per Wilder); TA-Lib drops it",
    reference: 'converges to TA-Lib within ~1e-5 by ~5·period bars',
  },
} satisfies BuiltinIndicatorMetadata;

export const keltnerMetadata = {
  inputs: 'bars',
  parameters: ['period', 'atrPeriod', 'multiplier'],
  defaults: { period: 20, atrPeriod: 10, multiplier: 2 },
} satisfies BuiltinIndicatorMetadata;

export const donchianMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const parkinsonMetadata = {
  inputs: 'bars',
  parameters: ['period', 'annualization'],
} satisfies BuiltinIndicatorMetadata;

export const garmanKlassMetadata = {
  inputs: 'bars',
  parameters: ['period', 'annualization'],
} satisfies BuiltinIndicatorMetadata;

export const rogersSatchellMetadata = {
  inputs: 'bars',
  parameters: ['period', 'annualization'],
} satisfies BuiltinIndicatorMetadata;

export const yangZhangMetadata = {
  inputs: 'bars',
  parameters: ['period', 'annualization'],
} satisfies BuiltinIndicatorMetadata;

export const chaikinVolatilityMetadata = {
  inputs: 'bars',
  parameters: ['period', 'rocPeriod'],
  defaults: { rocPeriod: /* @__PURE__ */ sib('period') },
} satisfies BuiltinIndicatorMetadata;

export const bbandsMetadata = {
  inputs: 'series',
  parameters: ['period', 'standardDeviation'],
  defaults: { period: 20, standardDeviation: 2 },
} satisfies BuiltinIndicatorMetadata;

export const bollingerBandWidthMetadata = {
  inputs: 'series',
  parameters: ['period', 'standardDeviation'],
  defaults: { standardDeviation: 2 },
} satisfies BuiltinIndicatorMetadata;

export const bollingerPercentBMetadata = {
  inputs: 'series',
  parameters: ['period', 'standardDeviation'],
  defaults: { standardDeviation: 2 },
} satisfies BuiltinIndicatorMetadata;

export const standardDeviationMetadata = {
  inputs: 'series',
  parameters: ['period', 'sample'],
  defaults: { sample: false },
} satisfies BuiltinIndicatorMetadata;

export const varianceMetadata = {
  inputs: 'series',
  parameters: ['period', 'sample'],
  defaults: { sample: false },
} satisfies BuiltinIndicatorMetadata;

export const historicalVolatilityMetadata = {
  inputs: 'series',
  parameters: ['period', 'annualization'],
} satisfies BuiltinIndicatorMetadata;

export const realizedVolatilityMetadata = {
  inputs: 'series',
  parameters: ['period', 'annualization'],
} satisfies BuiltinIndicatorMetadata;

export const relativeVolatilityIndexMetadata = {
  inputs: 'series',
  parameters: ['period', 'stdevPeriod'],
  defaults: { period: 14, stdevPeriod: /* @__PURE__ */ sib('period') },
} satisfies BuiltinIndicatorMetadata;

export const aberrationMetadata = {
  inputs: 'bars',
  parameters: ['period', 'atrPeriod'],
  defaults: { period: 5, atrPeriod: 15 },
} satisfies BuiltinIndicatorMetadata;

export const accelerationBandsMetadata = {
  inputs: 'bars',
  parameters: ['period', 'multiplier'],
  defaults: { period: 20, multiplier: 4 },
} satisfies BuiltinIndicatorMetadata;

export const holtWinterChannelMetadata = {
  inputs: 'series',
  parameters: [
    'levelSmoothing',
    'trendSmoothing',
    'accelerationSmoothing',
    'varianceSmoothing',
    'scalar',
  ],
  defaults: {
    levelSmoothing: 0.2,
    trendSmoothing: 0.1,
    accelerationSmoothing: 0.1,
    varianceSmoothing: 0.1,
    scalar: 1,
  },
} satisfies BuiltinIndicatorMetadata;

export const massIndexMetadata = {
  inputs: 'bars',
  parameters: ['fast', 'slow'],
  defaults: { fast: 9, slow: 25 },
} satisfies BuiltinIndicatorMetadata;

export const priceDistanceMetadata = {
  inputs: 'bars',
  parameters: ['drift'],
  defaults: { drift: 1 },
} satisfies BuiltinIndicatorMetadata;

export const elderThermometerMetadata = {
  inputs: 'bars',
  parameters: ['period', 'long', 'short'],
  defaults: { period: 20, long: 2, short: 0.5 },
} satisfies BuiltinIndicatorMetadata;

export const ulcerIndexMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const atrBandsMetadata = {
  inputs: 'bars',
  parameters: ['period', 'multiplier'],
  defaults: { period: 14, multiplier: 2 },
} satisfies BuiltinIndicatorMetadata;

export const percentAtrMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const volatilityStopMetadata = {
  inputs: 'bars',
  parameters: ['period', 'multiplier'],
  defaults: { period: 20, multiplier: 2 },
} satisfies BuiltinIndicatorMetadata;

export const obvMetadata = {
  inputs: 'bars',
  parameters: ['talib'],
  defaults: { talib: false },
  conventions: {
    seeding: 'seeds at 0; TA-Lib seeds at volume[0], so the two differ by that constant',
    reference: 'deltas are identical; qkOBV + volume[0] equals TA-Lib exactly',
  },
} satisfies BuiltinIndicatorMetadata;

export const vwapMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const adLineMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const chaikinOscillatorMetadata = {
  inputs: 'bars',
  parameters: ['fast', 'slow'],
  defaults: { fast: 3, slow: 10 },
  conventions: {
    seeding: 'EMA-seeded fast/slow (TradingView)',
    reference: 'converges to TA-Lib ADOSC within ~1e-4 by ~60 bars',
  },
} satisfies BuiltinIndicatorMetadata;

export const chaikinMoneyFlowMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const mfiMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const pvtMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const easeOfMovementMetadata = {
  inputs: 'bars',
  parameters: ['period', 'scale'],
  defaults: { scale: 1e8 },
} satisfies BuiltinIndicatorMetadata;

export const forceIndexMetadata = {
  inputs: 'bars',
  parameters: ['period'],
  defaults: { period: 13 },
} satisfies BuiltinIndicatorMetadata;

export const nviMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const pviMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const klingerMetadata = {
  inputs: 'bars',
  parameters: ['fast', 'slow', 'signal'],
  defaults: { fast: 34, slow: 55, signal: 13 },
} satisfies BuiltinIndicatorMetadata;

export const vfiMetadata = {
  inputs: 'bars',
  parameters: ['period', 'coefficient', 'volumeCutoff', 'smooth'],
  defaults: { period: 130, coefficient: 0.2, volumeCutoff: 2.5, smooth: 3 },
} satisfies BuiltinIndicatorMetadata;

export const relativeVolumeMetadata = {
  inputs: 'bars',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const cvdMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const archerObvMetadata = {
  inputs: 'bars',
  parameters: ['fast', 'slow', 'runLength'],
  defaults: { fast: 4, slow: 12, runLength: 2 },
} satisfies BuiltinIndicatorMetadata;

export const marketFacilitationIndexMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const priceVolumeMetadata = {
  inputs: 'bars',
  parameters: ['signed'],
  defaults: { signed: false },
} satisfies BuiltinIndicatorMetadata;

export const priceVolumeRankMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const volumeOscillatorMetadata = {
  inputs: 'bars',
  parameters: ['fast', 'slow'],
  defaults: { fast: 5, slow: 10 },
} satisfies BuiltinIndicatorMetadata;

export const williamsAdMetadata = {
  inputs: 'bars',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const efiMetadata = forceIndexMetadata;

export const emvMetadata = easeOfMovementMetadata;

export const kvoMetadata = klingerMetadata;

export const dspMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 14 },
} satisfies BuiltinIndicatorMetadata;

export const ebswMetadata = {
  inputs: 'series',
  parameters: ['period', 'bars'],
  defaults: { period: 40, bars: 10 },
  conventions: {
    reference:
      'bug-compatible with pandas-ta, INCLUDING its degree-valued arguments passed to radian trig; ' +
      'this is deliberately NOT Ehlers’ published filter',
  },
} satisfies BuiltinIndicatorMetadata;

export const mswMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 5 },
} satisfies BuiltinIndicatorMetadata;

export const htDcPeriodMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const htDcPhaseMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const htPhasorMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const htSineMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const htTrendModeMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const htTrendlineMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const betaMetadata = {
  inputs: 'pair',
  parameters: ['period'],
  conventions: {
    form: 'the FINANCIAL beta on returns, cov(Δx, Δy) / var(Δy), certified by closed-form oracle',
    reference: 'TA-Lib’s BETA uses a different internal regression, so the values differ',
  },
} satisfies BuiltinIndicatorMetadata;

export const correlMetadata = {
  inputs: 'pair',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const rollingMinMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const rollingMaxMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const rollingSumMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const rollingMinIndexMetadata = {
  inputs: 'series',
  parameters: ['period'],
  conventions: {
    form: 'bars SINCE the extreme (TradingView lowestbars, 0 = current bar); TA-Lib returns the absolute index',
  },
} satisfies BuiltinIndicatorMetadata;

export const rollingMaxIndexMetadata = {
  inputs: 'series',
  parameters: ['period'],
  conventions: {
    form: 'bars SINCE the extreme (TradingView highestbars, 0 = current bar); TA-Lib returns the absolute index',
  },
} satisfies BuiltinIndicatorMetadata;

export const rollingMinMaxMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const rollingMinMaxIndexMetadata = {
  inputs: 'series',
  parameters: ['period'],
  conventions: {
    form: 'bars SINCE each extreme (TradingView); TA-Lib returns absolute indices',
  },
} satisfies BuiltinIndicatorMetadata;

export const shiftMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 1 },
} satisfies BuiltinIndicatorMetadata;

export const lagMetadata = shiftMetadata;

export const diffMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 1 },
} satisfies BuiltinIndicatorMetadata;

export const changeMetadata = diffMetadata;

export const fractionalChangeMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 1 },
} satisfies BuiltinIndicatorMetadata;

export const cumMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const zScoreMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const normalizeMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const rescaleMetadata = {
  inputs: 'series',
  parameters: ['period', 'min', 'max'],
  defaults: { period: 20, min: 0, max: 1 },
} satisfies BuiltinIndicatorMetadata;

export const rollingMedianMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const madMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const standardErrorMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const rollingRankMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const percentRankMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const rollingQuantileMetadata = {
  inputs: 'series',
  parameters: ['period', 'quantile'],
  defaults: { period: 20, quantile: 0.5 },
} satisfies BuiltinIndicatorMetadata;

export const winsorizeMetadata = {
  inputs: 'series',
  parameters: ['period', 'lower', 'upper'],
  defaults: { period: 20, lower: 0.05, upper: 0.95 },
} satisfies BuiltinIndicatorMetadata;

export const skewMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const kurtosisMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const entropyMetadata = {
  inputs: 'series',
  parameters: ['period'],
  defaults: { period: 10 },
} satisfies BuiltinIndicatorMetadata;

export const covarianceMetadata = {
  inputs: 'pair',
  parameters: ['period', 'sample'],
  defaults: { period: 20, sample: true },
} satisfies BuiltinIndicatorMetadata;

export const rSquaredMetadata = {
  inputs: 'pair',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const rollingRegressionMetadata = {
  inputs: 'pair',
  parameters: ['period'],
  defaults: { period: 20 },
} satisfies BuiltinIndicatorMetadata;

export const barSinceMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const valueWhenMetadata = {
  inputs: 'pair',
  parameters: ['occurrence'],
  defaults: { occurrence: 0 },
} satisfies BuiltinIndicatorMetadata;

export const rollingMeanMetadata = smaMetadata;

export const rollingBetaMetadata = {
  inputs: 'pair',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const rollingCorrelationMetadata = correlMetadata;

export const highestBarsMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const lowestBarsMetadata = {
  inputs: 'series',
  parameters: ['period'],
} satisfies BuiltinIndicatorMetadata;

export const tosStdevAllMetadata = {
  inputs: 'series',
  parameters: ['period', 'stds', 'ddof'],
  defaults: { period: null, stds: [1, 2, 3], ddof: 1 },
} satisfies BuiltinIndicatorMetadata;

export const acosMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const asinMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const atanMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const ceilMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const cosMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const coshMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const expMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const floorMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const lnMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const log10Metadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const sinMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const sinhMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const sqrtMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const tanMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const tanhMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const addMetadata = {
  inputs: 'pair',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const subMetadata = {
  inputs: 'pair',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const multMetadata = {
  inputs: 'pair',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const divMetadata = {
  inputs: 'pair',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const crossoverMetadata = {
  inputs: 'pair',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const crossanyMetadata = {
  inputs: 'pair',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const drawdownMetadata = {
  inputs: 'series',
  parameters: [],
} satisfies BuiltinIndicatorMetadata;

export const cdlDojiMetadata = candlestickMetadata;

export const cdlInsideMetadata = candlestickMetadata;

export const cdlZMetadata = {
  inputs: 'bars',
  parameters: ['period', 'ddof'],
  defaults: { period: 30, ddof: 1 },
} satisfies BuiltinIndicatorMetadata;

export const fairValueGapsMetadata = {
  inputs: 'bars',
  parameters: ['minimumGapPercent'],
  defaults: { minimumGapPercent: 0 },
} satisfies BuiltinIndicatorMetadata;

export const orderBlocksMetadata = {
  inputs: 'bars',
  parameters: ['lookback'],
  defaults: { lookback: 5 },
} satisfies BuiltinIndicatorMetadata;

export const liquiditySweepsMetadata = {
  inputs: 'bars',
  parameters: ['lookback'],
  defaults: { lookback: 20 },
} satisfies BuiltinIndicatorMetadata;

export const swingTrailingStopMetadata = {
  inputs: 'bars',
  parameters: ['strength'],
  defaults: { strength: 2 },
} satisfies BuiltinIndicatorMetadata;

export const atrTrailingStopMetadata = {
  inputs: 'bars',
  parameters: ['period', 'multiplier'],
  defaults: { period: 14, multiplier: 3 },
} satisfies BuiltinIndicatorMetadata;

export const equalHighsMetadata = {
  inputs: 'bars',
  parameters: ['strength', 'tolerance'],
  defaults: { strength: 2, tolerance: 0.001 },
} satisfies BuiltinIndicatorMetadata;

export const equalLowsMetadata = {
  inputs: 'bars',
  parameters: ['strength', 'tolerance'],
  defaults: { strength: 2, tolerance: 0.001 },
} satisfies BuiltinIndicatorMetadata;

export const divergenceMetadata = {
  inputs: 'pair',
  parameters: ['swing', 'kinds'],
  defaults: {
    swing: { left: 5, right: 5 },
    kinds: ['bullish', 'bearish', 'hiddenBullish', 'hiddenBearish'],
  },
} satisfies BuiltinIndicatorMetadata;
