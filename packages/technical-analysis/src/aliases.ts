/**
 * Cross-library name aliases (spec §13.5 — naming/compatibility).
 *
 * TotalFinance uses camelCase canonical names. Traders coming from TA-Lib (`WILLR`), pandas-ta (`willr`)
 * or TradingView (`Williams %R`) can resolve those to the canonical indicator via
 * `resolveIndicator` / `resolveIndicatorName`. Resolution is case-insensitive and prefers an exact
 * canonical match, so `RSI`, `rsi` and `Rsi` all map to `rsi`. The same `ALIAS_TABLE` drives the
 * generated compatibility matrix (`compatibilityMatrixMarkdown`).
 *
 * Aliases are curated, not guessed: a row only lists an external name when that library genuinely
 * exposes the indicator under it. The `totalfinance` field of every row is validated against the live
 * registry at module load, so a typo or a removed indicator fails fast.
 */

import { ErrorCode, InputError } from '@totalfinance/core';
import {
  getIndicator,
  hasIndicator,
  listIndicators,
  type RegisteredIndicator,
} from './registry.js';

export interface IndicatorAliasRow {
  /** Canonical TotalFinance name (must be registered). */
  totalfinance: string;
  /** TA-Lib function name(s), uppercase. */
  talib?: string | string[];
  /** pandas-ta name(s), snake_case. */
  pandas?: string | string[];
  /** TradingView display name. */
  tradingview?: string;
}

/**
 * Curated TotalFinance ↔ TA-Lib ↔ pandas-ta ↔ TradingView name map. Grouped by family for readability;
 * the order is informational only (resolution and the matrix index it independently).
 */
export const ALIAS_TABLE: readonly IndicatorAliasRow[] = [
  // ── transforms / price ──────────────────────────────────────────────────
  {
    totalfinance: 'typicalPrice',
    talib: 'TYPPRICE',
    pandas: ['hlc3', 'typprice'],
    tradingview: 'Typical Price',
  },
  {
    totalfinance: 'medianPrice',
    talib: 'MEDPRICE',
    pandas: ['hl2', 'medprice'],
    tradingview: 'Median Price',
  },
  {
    totalfinance: 'averagePrice',
    talib: 'AVGPRICE',
    pandas: ['avgprice', 'ohlc4'],
    tradingview: 'Average Price',
  },
  {
    totalfinance: 'weightedClose',
    talib: 'WCLPRICE',
    pandas: 'wcp',
    tradingview: 'Weighted Close',
  },
  { totalfinance: 'trueRange', talib: 'TRANGE', pandas: 'true_range' },
  { totalfinance: 'heikinAshi', pandas: 'ha', tradingview: 'Heikin Ashi' },
  { totalfinance: 'returns', pandas: 'percent_return' },
  { totalfinance: 'logReturns', pandas: 'log_return' },
  { totalfinance: 'drawdown', pandas: 'drawdown' },

  // ── moving averages ─────────────────────────────────────────────────────
  { totalfinance: 'sma', talib: 'SMA', pandas: 'sma', tradingview: 'SMA' },
  { totalfinance: 'ema', talib: 'EMA', pandas: 'ema', tradingview: 'EMA' },
  { totalfinance: 'wma', talib: 'WMA', pandas: 'wma', tradingview: 'WMA' },
  { totalfinance: 'rma', pandas: 'rma', tradingview: 'RMA' },
  { totalfinance: 'dema', talib: 'DEMA', pandas: 'dema' },
  { totalfinance: 'tema', talib: 'TEMA', pandas: 'tema' },
  { totalfinance: 'trima', talib: 'TRIMA', pandas: 'trima' },
  { totalfinance: 't3', talib: 'T3', pandas: 't3' },
  { totalfinance: 'kama', talib: 'KAMA', pandas: 'kama' },
  { totalfinance: 'mama', talib: 'MAMA', pandas: 'mama' },
  { totalfinance: 'hma', pandas: 'hma', tradingview: 'HMA' },
  { totalfinance: 'zlema', pandas: 'zlma', tradingview: 'ZLEMA' },
  { totalfinance: 'alma', pandas: 'alma', tradingview: 'ALMA' },
  { totalfinance: 'vidya', pandas: 'vidya', tradingview: 'VIDYA' },
  { totalfinance: 'mcginley', pandas: 'mcgd', tradingview: 'McGinley Dynamic' },
  { totalfinance: 'superSmoother', pandas: 'ssf' },
  { totalfinance: 'vwma', pandas: 'vwma', tradingview: 'VWMA' },
  { totalfinance: 'movingAverage', talib: 'MA', pandas: 'ma' },
  { totalfinance: 'midpoint', talib: 'MIDPOINT', pandas: 'midpoint' },
  { totalfinance: 'midprice', talib: 'MIDPRICE', pandas: 'midprice' },
  { totalfinance: 'fwma', pandas: 'fwma' },
  { totalfinance: 'sineWma', pandas: 'sinwma' },
  { totalfinance: 'pascalWma', pandas: 'pwma' },
  { totalfinance: 'symmetricWma', pandas: 'swma' },
  { totalfinance: 'jma', pandas: 'jma' },
  { totalfinance: 'holtWinterMovingAverage', pandas: 'hwma' },
  { totalfinance: 'rainbowMovingAverage', pandas: 'rainbow' },
  { totalfinance: 'movingAverageRibbon', pandas: 'mmar' },
  { totalfinance: 'gannHighLowActivator', pandas: 'hilo', tradingview: 'Gann HiLo Activator' },

  // ── momentum / oscillators ──────────────────────────────────────────────
  { totalfinance: 'rsi', talib: 'RSI', pandas: 'rsi', tradingview: 'RSI' },
  { totalfinance: 'macd', talib: 'MACD', pandas: 'macd', tradingview: 'MACD' },
  { totalfinance: 'macdExt', talib: 'MACDEXT', pandas: 'macdext' },
  { totalfinance: 'macdFix', talib: 'MACDFIX', pandas: 'macdfix' },
  { totalfinance: 'roc', talib: 'ROC', pandas: 'roc' },
  { totalfinance: 'rocp', talib: 'ROCP', pandas: 'rocp' },
  { totalfinance: 'rocr', talib: 'ROCR', pandas: 'rocr' },
  { totalfinance: 'rocr100', talib: 'ROCR100', pandas: 'rocr100' },
  { totalfinance: 'momentum', talib: 'MOM', pandas: 'mom' },
  { totalfinance: 'cmo', talib: 'CMO', pandas: 'cmo' },
  { totalfinance: 'apo', talib: 'APO', pandas: 'apo' },
  { totalfinance: 'ppo', talib: 'PPO', pandas: 'ppo' },
  {
    totalfinance: 'stochRsi',
    talib: 'STOCHRSI',
    pandas: 'stochrsi',
    tradingview: 'Stochastic RSI',
  },
  { totalfinance: 'trix', talib: 'TRIX', pandas: 'trix' },
  { totalfinance: 'dpo', pandas: 'dpo' },
  { totalfinance: 'tsi', pandas: 'tsi', tradingview: 'TSI' },
  { totalfinance: 'kst', pandas: 'kst', tradingview: 'KST' },
  { totalfinance: 'cci', talib: 'CCI', pandas: 'cci', tradingview: 'CCI' },
  { totalfinance: 'williamsR', talib: 'WILLR', pandas: 'willr', tradingview: 'Williams %R' },
  { totalfinance: 'awesomeOscillator', pandas: 'ao', tradingview: 'Awesome Oscillator' },
  { totalfinance: 'ultimateOscillator', talib: 'ULTOSC', pandas: 'uo' },
  { totalfinance: 'fisherTransform', pandas: 'fisher', tradingview: 'Fisher Transform' },
  { totalfinance: 'stochastic', talib: 'STOCH', pandas: 'stoch', tradingview: 'Stochastic' },
  { totalfinance: 'stochFast', talib: 'STOCHF', pandas: 'stochf' },
  { totalfinance: 'bop', talib: 'BOP', pandas: 'bop' },
  { totalfinance: 'bias', pandas: 'bias' },
  { totalfinance: 'cfo', pandas: 'cfo' },
  { totalfinance: 'forecastOscillator', pandas: 'fosc' },
  { totalfinance: 'cti', pandas: 'cti' },
  { totalfinance: 'coppock', pandas: 'coppock', tradingview: 'Coppock Curve' },
  { totalfinance: 'efficiencyRatio', pandas: 'er' },
  { totalfinance: 'centerOfGravity', pandas: 'cg' },
  { totalfinance: 'psychologicalLine', pandas: 'psl' },
  { totalfinance: 'slope', pandas: 'slope' },
  { totalfinance: 'pvo', pandas: 'pvo' },
  { totalfinance: 'elderRay', pandas: 'eri', tradingview: 'Elder Ray' },
  { totalfinance: 'brar', pandas: 'brar' },
  { totalfinance: 'kdj', pandas: 'kdj', tradingview: 'KDJ' },
  { totalfinance: 'relativeVigorIndex', pandas: 'rvgi', tradingview: 'RVGI' },
  { totalfinance: 'pgo', pandas: 'pgo' },
  { totalfinance: 'inertia', pandas: 'inertia' },
  { totalfinance: 'laguerreRsi', pandas: 'lrsi' },
  { totalfinance: 'qqe', pandas: 'qqe', tradingview: 'QQE' },
  { totalfinance: 'rsx', pandas: 'rsx' },
  { totalfinance: 'schaffTrendCycle', pandas: 'stc', tradingview: 'Schaff Trend Cycle' },
  { totalfinance: 'squeeze', pandas: 'squeeze', tradingview: 'TTM Squeeze' },
  { totalfinance: 'squeezePro', pandas: 'squeeze_pro' },
  { totalfinance: 'projectionOscillator', pandas: 'po' },
  { totalfinance: 'smcSweep', pandas: 'smc_sweep' },
  { totalfinance: 'tdSequential', pandas: 'td_seq', tradingview: 'TD Sequential' },
  { totalfinance: 'trixHistogram', pandas: 'trixh' },
  { totalfinance: 'smiErgodic', pandas: 'smi', tradingview: 'SMI Ergodic' },
  { totalfinance: 'volumeWeightedMacd', pandas: 'vwmacd' },

  // ── trend ───────────────────────────────────────────────────────────────
  { totalfinance: 'adx', talib: 'ADX', pandas: 'adx', tradingview: 'ADX' },
  { totalfinance: 'adxr', talib: 'ADXR', pandas: 'adxr' },
  { totalfinance: 'dmi', pandas: 'dm' },
  { totalfinance: 'dx', talib: 'DX', pandas: 'dx' },
  { totalfinance: 'plusDI', talib: 'PLUS_DI' },
  { totalfinance: 'minusDI', talib: 'MINUS_DI' },
  { totalfinance: 'plusDM', talib: 'PLUS_DM', pandas: 'plus_dm' },
  { totalfinance: 'minusDM', talib: 'MINUS_DM', pandas: 'minus_dm' },
  { totalfinance: 'aroon', talib: 'AROON', pandas: 'aroon', tradingview: 'Aroon' },
  { totalfinance: 'aroonOscillator', talib: 'AROONOSC', pandas: 'aroonosc' },
  { totalfinance: 'psar', talib: 'SAR', pandas: 'psar', tradingview: 'Parabolic SAR' },
  { totalfinance: 'psarExt', talib: 'SAREXT', pandas: 'sarext' },
  { totalfinance: 'supertrend', pandas: 'supertrend', tradingview: 'Supertrend' },
  { totalfinance: 'ichimoku', pandas: 'ichimoku', tradingview: 'Ichimoku Cloud' },
  { totalfinance: 'vortex', pandas: 'vortex', tradingview: 'Vortex' },
  { totalfinance: 'linreg', talib: 'LINEARREG', pandas: 'linreg' },
  { totalfinance: 'linregSlope', talib: 'LINEARREG_SLOPE', pandas: 'linregslope' },
  { totalfinance: 'linregIntercept', talib: 'LINEARREG_INTERCEPT', pandas: 'linregintercept' },
  { totalfinance: 'linregAngle', talib: 'LINEARREG_ANGLE', pandas: 'linregangle' },
  { totalfinance: 'tsf', talib: 'TSF', pandas: 'tsf' },
  { totalfinance: 'chandelierExit', pandas: 'ce', tradingview: 'Chandelier Exit' },
  { totalfinance: 'choppinessIndex', pandas: 'chop', tradingview: 'Choppiness Index' },
  { totalfinance: 'chandeKrollStop', pandas: 'cksp', tradingview: 'Chande Kroll Stop' },
  {
    totalfinance: 'centralPivotRange',
    pandas: ['cpr', 'cpr_option'],
    tradingview: 'Central Pivot Range',
  },
  { totalfinance: 'amat', pandas: 'amat' },
  { totalfinance: 'linearDecay', pandas: ['decay', 'linear_decay'] },
  { totalfinance: 'exponentialDecay', pandas: 'edecay' },
  { totalfinance: 'increasing', pandas: 'increasing' },
  { totalfinance: 'decreasing', pandas: 'decreasing' },
  { totalfinance: 'longRun', pandas: 'long_run' },
  { totalfinance: 'shortRun', pandas: 'short_run' },
  { totalfinance: 'pMax', pandas: 'pmax', tradingview: 'PMax' },
  { totalfinance: 'qstick', pandas: 'qstick' },
  { totalfinance: 'ttmTrend', pandas: 'ttm_trend', tradingview: 'TTM Trend' },
  { totalfinance: 'verticalHorizontalFilter', pandas: 'vhf' },
  { totalfinance: 'trendSignals', pandas: 'tsignals' },
  { totalfinance: 'crossSignals', pandas: 'xsignals' },

  // ── volatility / channels ───────────────────────────────────────────────
  { totalfinance: 'atr', talib: 'ATR', pandas: 'atr', tradingview: 'ATR' },
  { totalfinance: 'natr', talib: 'NATR', pandas: 'natr' },
  { totalfinance: 'bbands', talib: 'BBANDS', pandas: 'bbands', tradingview: 'Bollinger Bands' },
  { totalfinance: 'keltner', pandas: 'kc', tradingview: 'Keltner Channels' },
  { totalfinance: 'donchian', pandas: 'donchian', tradingview: 'Donchian Channels' },
  { totalfinance: 'standardDeviation', talib: 'STDDEV', pandas: 'stdev' },
  { totalfinance: 'variance', talib: 'VAR', pandas: 'variance' },
  {
    totalfinance: 'relativeVolatilityIndex',
    pandas: 'rvi',
    tradingview: 'Relative Volatility Index',
  },
  { totalfinance: 'aberration', pandas: 'aberration' },
  { totalfinance: 'accelerationBands', pandas: 'accbands', tradingview: 'Acceleration Bands' },
  { totalfinance: 'historicalVolatility', pandas: ['hvol', 'avolume'] },
  { totalfinance: 'chaikinVolatility', pandas: 'cvi' },
  { totalfinance: 'holtWinterChannel', pandas: 'hwc' },
  { totalfinance: 'massIndex', pandas: 'massi', tradingview: 'Mass Index' },
  { totalfinance: 'priceDistance', pandas: 'pdist' },
  { totalfinance: 'elderThermometer', pandas: 'thermo' },
  { totalfinance: 'ulcerIndex', pandas: 'ui', tradingview: 'Ulcer Index' },

  // ── volume ──────────────────────────────────────────────────────────────
  { totalfinance: 'obv', talib: 'OBV', pandas: 'obv', tradingview: 'OBV' },
  { totalfinance: 'vwap', pandas: 'vwap', tradingview: 'VWAP' },
  { totalfinance: 'adLine', talib: 'AD', pandas: 'ad', tradingview: 'Accumulation/Distribution' },
  { totalfinance: 'chaikinOscillator', talib: 'ADOSC', pandas: 'adosc' },
  { totalfinance: 'chaikinMoneyFlow', pandas: 'cmf', tradingview: 'CMF' },
  { totalfinance: 'mfi', talib: 'MFI', pandas: 'mfi', tradingview: 'Money Flow Index' },
  { totalfinance: 'pvt', pandas: 'pvt', tradingview: 'Price Volume Trend' },
  { totalfinance: 'easeOfMovement', pandas: 'eom', tradingview: 'Ease of Movement' },
  { totalfinance: 'forceIndex', pandas: 'efi', tradingview: 'Force Index' },
  { totalfinance: 'nvi', pandas: 'nvi' },
  { totalfinance: 'pvi', pandas: 'pvi' },
  { totalfinance: 'klinger', pandas: 'kvo', tradingview: 'Klinger Oscillator' },
  { totalfinance: 'archerObv', pandas: 'aobv' },
  {
    totalfinance: 'marketFacilitationIndex',
    pandas: 'marketfi',
    tradingview: 'Market Facilitation Index',
  },
  { totalfinance: 'priceVolume', pandas: 'pvol' },
  { totalfinance: 'priceVolumeRank', pandas: 'pvr' },
  { totalfinance: 'volumeOscillator', pandas: 'vosc', tradingview: 'Volume Oscillator' },
  { totalfinance: 'williamsAd', pandas: 'wad', tradingview: 'Williams A/D' },

  // ── cycle (Hilbert transform) ───────────────────────────────────────────
  { totalfinance: 'dsp', pandas: 'dsp' },
  { totalfinance: 'ebsw', pandas: 'ebsw' },
  { totalfinance: 'msw', pandas: 'msw' },
  { totalfinance: 'htDcPeriod', talib: 'HT_DCPERIOD', pandas: 'ht_dcperiod' },
  { totalfinance: 'htDcPhase', talib: 'HT_DCPHASE', pandas: 'ht_dcphase' },
  { totalfinance: 'htPhasor', talib: 'HT_PHASOR', pandas: 'ht_phasor' },
  { totalfinance: 'htSine', talib: 'HT_SINE', pandas: 'ht_sine' },
  { totalfinance: 'htTrendMode', talib: 'HT_TRENDMODE', pandas: 'ht_trendmode' },
  { totalfinance: 'htTrendline', talib: 'HT_TRENDLINE', pandas: 'ht_trendline' },

  // ── price action (smart money concepts) ─────────────────────────────────
  { totalfinance: 'fairValueGaps', tradingview: 'Fair Value Gap' },
  { totalfinance: 'orderBlocks', tradingview: 'Order Block' },
  { totalfinance: 'liquiditySweeps', tradingview: 'Liquidity Sweep' },
  { totalfinance: 'equalHighs', tradingview: 'Equal Highs' },
  { totalfinance: 'equalLows', tradingview: 'Equal Lows' },
  { totalfinance: 'atrTrailingStop', tradingview: 'ATR Trailing Stop' },
  { totalfinance: 'swingTrailingStop', tradingview: 'Swing Trailing Stop' },

  // ── candlestick wrappers ────────────────────────────────────────────────
  { totalfinance: 'cdlDoji', pandas: 'cdl_doji' },
  { totalfinance: 'cdlInside', pandas: 'cdl_inside' },
  { totalfinance: 'cdlZ', pandas: 'cdl_z' },

  // ── statistics / operators ──────────────────────────────────────────────
  { totalfinance: 'beta', talib: 'BETA', pandas: 'beta' },
  { totalfinance: 'correl', talib: 'CORREL', pandas: 'correl' },
  { totalfinance: 'rollingMin', talib: 'MIN', pandas: 'rolling_min' },
  { totalfinance: 'rollingMax', talib: 'MAX', pandas: 'rolling_max' },
  { totalfinance: 'rollingSum', talib: 'SUM', pandas: 'rolling_sum' },
  { totalfinance: 'rollingMinIndex', talib: 'MININDEX' },
  { totalfinance: 'rollingMaxIndex', talib: 'MAXINDEX' },
  { totalfinance: 'rollingMinMax', talib: 'MINMAX' },
  { totalfinance: 'rollingMinMaxIndex', talib: 'MINMAXINDEX' },
  { totalfinance: 'mad', pandas: ['mad', 'md'] },
  { totalfinance: 'rollingMedian', pandas: 'median' },
  { totalfinance: 'rollingQuantile', pandas: 'quantile' },
  { totalfinance: 'skew', pandas: 'skew' },
  { totalfinance: 'kurtosis', pandas: 'kurtosis' },
  { totalfinance: 'entropy', pandas: 'entropy' },
  // pandas-ta exposes no standard-error function (only `stdev` / `tos_stdevall`), and the curation
  // rule is that a row lists an external name only when that library genuinely has it — the previous
  // `pandas: 'standardError'` was TotalFinance's own camelCase name echoed back, which pandas-ta would
  // never accept.
  { totalfinance: 'standardError' },
  { totalfinance: 'zScore', pandas: 'zscore' },
  { totalfinance: 'tosStdevAll', pandas: 'tos_stdevall' },
  { totalfinance: 'acos', talib: 'ACOS', pandas: 'acos' },
  { totalfinance: 'asin', talib: 'ASIN', pandas: 'asin' },
  { totalfinance: 'atan', talib: 'ATAN', pandas: 'atan' },
  { totalfinance: 'ceil', talib: 'CEIL', pandas: 'ceil' },
  { totalfinance: 'cos', talib: 'COS', pandas: 'cos' },
  { totalfinance: 'cosh', talib: 'COSH', pandas: 'cosh' },
  { totalfinance: 'exp', talib: 'EXP', pandas: 'exp' },
  { totalfinance: 'floor', talib: 'FLOOR', pandas: 'floor' },
  { totalfinance: 'ln', talib: 'LN', pandas: 'ln' },
  { totalfinance: 'log10', talib: 'LOG10', pandas: 'log10' },
  { totalfinance: 'sin', talib: 'SIN', pandas: 'sin' },
  { totalfinance: 'sinh', talib: 'SINH', pandas: 'sinh' },
  { totalfinance: 'sqrt', talib: 'SQRT', pandas: 'sqrt' },
  { totalfinance: 'tan', talib: 'TAN', pandas: 'tan' },
  { totalfinance: 'tanh', talib: 'TANH', pandas: 'tanh' },
  { totalfinance: 'add', talib: 'ADD', pandas: 'add' },
  { totalfinance: 'sub', talib: 'SUB', pandas: 'sub' },
  { totalfinance: 'mult', talib: 'MULT', pandas: 'mult' },
  { totalfinance: 'div', talib: 'DIV', pandas: 'div' },
  { totalfinance: 'crossover', pandas: 'crossover' },
  { totalfinance: 'crossany', pandas: 'crossany' },
  { totalfinance: 'barSince', tradingview: 'BarsSince' },
  { totalfinance: 'valueWhen', tradingview: 'ValueWhen' },
  { totalfinance: 'highestBars', tradingview: 'HighestBars' },
  { totalfinance: 'lowestBars', tradingview: 'LowestBars' },
];

const toArray = (x?: string | string[]): string[] =>
  x === undefined ? [] : Array.isArray(x) ? x : [x];

const externalNames = (row: IndicatorAliasRow): string[] => [
  ...toArray(row.talib),
  ...toArray(row.pandas),
  ...(row.tradingview ? [row.tradingview] : []),
];

// ── build the resolution indices (validated at module load) ────────────────

/** Lowercased canonical name → canonical name (case-insensitive canonical lookup). */
const lowerCanonical = new Map<string, string>();
for (const e of listIndicators()) {
  lowerCanonical.set(e.name.toLowerCase(), e.name);
}

/** Lowercased external alias → canonical name. */
const aliasIndex = new Map<string, string>();
const seenCanonical = new Set<string>();
for (const row of ALIAS_TABLE) {
  if (!hasIndicator(row.totalfinance)) {
    throw new InputError(
      `aliasTable: Alias table references unregistered indicator "${row.totalfinance}".`,
      {
        code: ErrorCode.RegistryUnknownAliasTarget,
        context: { name: row.totalfinance },
      },
    );
  }
  if (seenCanonical.has(row.totalfinance)) {
    throw new InputError(`aliasTable: Duplicate alias row for "${row.totalfinance}".`, {
      code: ErrorCode.RegistryDuplicateAliasRow,
      context: { name: row.totalfinance },
    });
  }
  seenCanonical.add(row.totalfinance);
  for (const name of externalNames(row)) {
    const key = name.toLowerCase();
    const existing = aliasIndex.get(key);
    if (existing && existing !== row.totalfinance) {
      throw new InputError(
        `aliasTable: Alias "${name}" is claimed by both "${existing}" and "${row.totalfinance}".`,
        { code: ErrorCode.RegistryAliasConflict, context: { alias: name } },
      );
    }
    aliasIndex.set(key, row.totalfinance);
  }
}

/**
 * Resolve any TotalFinance / TA-Lib / pandas-ta / TradingView name (case-insensitive) to the canonical
 * TotalFinance indicator name. An exact canonical name wins over a case variant, which wins over an
 * external alias. Returns `undefined` if nothing matches.
 */
export function resolveIndicatorName(name: string): string | undefined {
  if (typeof name !== 'string') {
    throw new InputError(
      `resolveIndicatorName: name must be an indicator name string, got ${name === null ? 'null' : typeof name}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {},
      },
    );
  }
  if (hasIndicator(name)) return name;
  const lc = name.toLowerCase();
  return lowerCanonical.get(lc) ?? aliasIndex.get(lc);
}

/** Resolve a name (any convention) to its registered indicator, or `undefined`. */
export function resolveIndicator(name: string): RegisteredIndicator | undefined {
  if (typeof name !== 'string') {
    throw new InputError(
      `resolveIndicator: name must be an indicator name string, got ${name === null ? 'null' : typeof name}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {},
      },
    );
  }
  const canonical = resolveIndicatorName(name);
  return canonical ? getIndicator(canonical) : undefined;
}

/** The alias row for a canonical TotalFinance name, if one exists. */
export function aliasesOf(canonical: string): IndicatorAliasRow | undefined {
  return ALIAS_TABLE.find((r) => r.totalfinance === canonical);
}

// ── compatibility matrix documentation ─────────────────────────────────────

const CATEGORY_ORDER = [
  'transform',
  'moving-average',
  'momentum',
  'trend',
  'volatility',
  'volume',
  'cycle',
  'math',
  'performance',
  'statistic',
  'candlestick',
  'price-action',
  'custom',
] as const;

/** Render the TotalFinance ↔ TA-Lib ↔ pandas-ta ↔ TradingView name map as a Markdown matrix. */
export function compatibilityMatrixMarkdown(): string {
  const cell = (x?: string | string[]): string => {
    const arr = toArray(x);
    return arr.length ? arr.map((n) => `\`${n}\``).join(', ') : '—';
  };
  const byCategory = new Map<string, IndicatorAliasRow[]>();
  for (const row of ALIAS_TABLE) {
    const cat = getIndicator(row.totalfinance)?.category ?? 'custom';
    (byCategory.get(cat) ?? byCategory.set(cat, []).get(cat)!).push(row);
  }
  const lines: string[] = ['# TotalFinance indicator compatibility matrix', ''];
  lines.push(
    `Cross-reference of TotalFinance canonical names against TA-Lib, pandas-ta and TradingView. ` +
      `Any name below resolves via \`resolveIndicator\` (case-insensitive). ` +
      `${ALIAS_TABLE.length} of ${listIndicators().length} registered indicators are mapped.`,
    '',
  );
  for (const cat of CATEGORY_ORDER) {
    const rows = byCategory.get(cat);
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) => a.totalfinance.localeCompare(b.totalfinance));
    lines.push(`## ${cat} (${rows.length})`, '');
    lines.push('| TotalFinance | TA-Lib | pandas-ta | TradingView |', '| --- | --- | --- | --- |');
    for (const r of rows) {
      lines.push(
        `| \`${r.totalfinance}\` | ${cell(r.talib)} | ${cell(r.pandas)} | ${r.tradingview ? r.tradingview : '—'} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
