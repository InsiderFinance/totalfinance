import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CDL_ALIASES,
  cdlPattern,
  mavp,
  resolveCandleName,
  resolveIndicatorName,
  volumeProfile,
} from '@totalfinance/technical-analysis';
import {
  CLOSED_FORM_ORACLE_QK,
  CLOSED_FORM_PROVEN_QK,
  PANDAS_ASSERTED,
  PANDAS_EXT_PROVEN_QK,
  TALIB_FIXTURE_ONLY,
  TULIPY_ASSERTED,
} from './golden/proof-manifest';

const talibNonCdl = [
  'BBANDS',
  'DEMA',
  'EMA',
  'HT_TRENDLINE',
  'KAMA',
  'MA',
  'MAMA',
  'MIDPOINT',
  'MIDPRICE',
  'SAR',
  'SAREXT',
  'SMA',
  'T3',
  'TEMA',
  'TRIMA',
  'WMA',
  'ADX',
  'ADXR',
  'APO',
  'AROON',
  'AROONOSC',
  'BOP',
  'CCI',
  'CMO',
  'DX',
  'MACD',
  'MACDEXT',
  'MACDFIX',
  'MFI',
  'MINUS_DI',
  'MINUS_DM',
  'MOM',
  'PLUS_DI',
  'PLUS_DM',
  'PPO',
  'ROC',
  'ROCP',
  'ROCR',
  'ROCR100',
  'RSI',
  'STOCH',
  'STOCHF',
  'STOCHRSI',
  'TRIX',
  'ULTOSC',
  'WILLR',
  'AD',
  'ADOSC',
  'OBV',
  'HT_DCPERIOD',
  'HT_DCPHASE',
  'HT_PHASOR',
  'HT_SINE',
  'HT_TRENDMODE',
  'AVGPRICE',
  'MEDPRICE',
  'TYPPRICE',
  'WCLPRICE',
  'ATR',
  'NATR',
  'TRANGE',
  'BETA',
  'CORREL',
  'LINEARREG',
  'LINEARREG_ANGLE',
  'LINEARREG_INTERCEPT',
  'LINEARREG_SLOPE',
  'STDDEV',
  'TSF',
  'VAR',
  'ACOS',
  'ASIN',
  'ATAN',
  'CEIL',
  'COS',
  'COSH',
  'EXP',
  'FLOOR',
  'LN',
  'LOG10',
  'SIN',
  'SINH',
  'SQRT',
  'TAN',
  'TANH',
  'ADD',
  'DIV',
  'MAX',
  'MAXINDEX',
  'MIN',
  'MININDEX',
  'MINMAX',
  'MINMAXINDEX',
  'MULT',
  'SUB',
  'SUM',
] as const;

const pandasPatterns = [
  '2crows',
  '3blackcrows',
  '3inside',
  '3linestrike',
  '3outside',
  '3starsinsouth',
  '3whitesoldiers',
  'abandonedbaby',
  'advanceblock',
  'belthold',
  'breakaway',
  'closingmarubozu',
  'concealbabyswall',
  'counterattack',
  'darkcloudcover',
  'doji',
  'dojistar',
  'dragonflydoji',
  'engulfing',
  'eveningdojistar',
  'eveningstar',
  'gapsidesidewhite',
  'gravestonedoji',
  'hammer',
  'hangingman',
  'harami',
  'haramicross',
  'highwave',
  'hikkake',
  'hikkakemod',
  'homingpigeon',
  'identical3crows',
  'inside',
  'inneck',
  'invertedhammer',
  'kicking',
  'kickingbylength',
  'ladderbottom',
  'longleggeddoji',
  'longline',
  'marubozu',
  'matchinglow',
  'mathold',
  'morningdojistar',
  'morningstar',
  'onneck',
  'piercing',
  'rickshawman',
  'risefall3methods',
  'separatinglines',
  'shootingstar',
  'shortline',
  'spinningtop',
  'stalledpattern',
  'sticksandwich',
  'takuri',
  'tasukigap',
  'thrusting',
  'tristar',
  'unique3river',
  'upsidegap2crows',
  'xsidegap3methods',
] as const;

const pandasIndicators = [
  'cdl_doji',
  'cdl_inside',
  'cdl_z',
  'ha',
  'dsp',
  'ebsw',
  'ht_dcperiod',
  'ht_dcphase',
  'ht_phasor',
  'ht_sine',
  'ht_trendmode',
  'msw',
  'ao',
  'apo',
  'bias',
  'bop',
  'brar',
  'cci',
  'cfo',
  'cg',
  'cmo',
  'coppock',
  'cti',
  'dm',
  'er',
  'eri',
  'fisher',
  'fosc',
  'inertia',
  'kdj',
  'kst',
  'lrsi',
  'macd',
  'macdext',
  'macdfix',
  'mom',
  'pgo',
  'po',
  'ppo',
  'psl',
  'pvo',
  'qqe',
  'roc',
  'rocp',
  'rocr',
  'rocr100',
  'rsi',
  'rsx',
  'rvgi',
  'stc',
  'slope',
  'smc_sweep',
  'smi',
  'squeeze',
  'squeeze_pro',
  'stoch',
  'stochf',
  'stochrsi',
  'td_seq',
  'trix',
  'trixh',
  'tsi',
  'uo',
  'vwmacd',
  'willr',
  'alma',
  'avgprice',
  'dema',
  'ema',
  'fwma',
  'hilo',
  'hl2',
  'hlc3',
  'hma',
  'ht_trendline',
  'hwma',
  'ichimoku',
  'jma',
  'kama',
  'linreg',
  'linregangle',
  'linregintercept',
  'linregslope',
  'ma',
  'mama',
  'mmar',
  'medprice',
  'mcgd',
  'midpoint',
  'midprice',
  'ohlc4',
  'pwma',
  'rainbow',
  'rma',
  'sinwma',
  'sma',
  'ssf',
  'supertrend',
  'swma',
  't3',
  'tema',
  'tsf',
  'trima',
  'typprice',
  'vidya',
  'vwap',
  'vwma',
  'wcp',
  'wma',
  'zlma',
  'drawdown',
  'log_return',
  'percent_return',
  'beta',
  'correl',
  'entropy',
  'kurtosis',
  'mad',
  'md',
  'median',
  'quantile',
  'skew',
  'stdev',
  'standardError',
  'tos_stdevall',
  'variance',
  'zScore',
  'adx',
  'adxr',
  'amat',
  'aroon',
  'chop',
  'cksp',
  'cpr',
  'cpr_option',
  'decay',
  'decreasing',
  'dpo',
  'dx',
  'edecay',
  'increasing',
  'long_run',
  'minus_dm',
  'psar',
  'plus_dm',
  'pmax',
  'qstick',
  'sarext',
  'short_run',
  'tsignals',
  'ttm_trend',
  'vhf',
  'vortex',
  'xsignals',
  'aberration',
  'accbands',
  'avolume',
  'atr',
  'bbands',
  'ce',
  'cvi',
  'donchian',
  'hvol',
  'hwc',
  'kc',
  'massi',
  'natr',
  'pdist',
  'rvi',
  'thermo',
  'true_range',
  'ui',
  'ad',
  'adosc',
  'aobv',
  'cmf',
  'efi',
  'eom',
  'emv',
  'kvo',
  'marketfi',
  'mfi',
  'nvi',
  'obv',
  'pvi',
  'pvol',
  'pvr',
  'pvt',
  'vfi',
  'vosc',
  'wad',
  'add',
  'sub',
  'mult',
  'div',
  'rolling_max',
  'rolling_min',
  'rolling_sum',
  'asin',
  'acos',
  'atan',
  'ceil',
  'cos',
  'cosh',
  'exp',
  'floor',
  'ln',
  'log10',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'crossover',
  'crossany',
  'lag',
] as const;

function hasCandleName(name: string): boolean {
  try {
    return Boolean(resolveCandleName(name));
  } catch {
    return false;
  }
}

// NOTE: the tests in this block prove NAME RESOLUTION (every catalog name maps to a TotalFinance
// indicator) — NOT numerical parity. Numerical proof is tracked separately below.
describe('TA-Lib / pandas-ta catalog — name resolution', () => {
  it('resolves every non-candlestick TA-Lib function name', () => {
    const missing = talibNonCdl.filter((name) => !resolveIndicatorName(name));
    expect(missing).toEqual([]);
  });

  it('resolves every TA-Lib CDL pattern name through cdlPattern', () => {
    const missing = Object.keys(CDL_ALIASES).filter((name) => !hasCandleName(name));
    expect(missing).toEqual([]);
  });

  it('resolves every pandas-ta-classic indicator name except the dispatcher itself', () => {
    const missing = pandasIndicators.filter((name) => !resolveIndicatorName(name));
    expect(missing).toEqual([]);
  });

  it('supports pandas-ta-classic vp as the fixed-range volumeProfile utility', () => {
    expect(typeof volumeProfile).toBe('function');
  });

  it('supports TA-Lib/pandas-ta MAVP as the variable-period moving-average utility', () => {
    expect(typeof mavp).toBe('function');
  });

  it('resolves every pandas-ta-classic cdl_pattern name', () => {
    const missing = pandasPatterns.filter((name) => !hasCandleName(name));
    expect(missing).toEqual([]);
    expect(typeof cdlPattern).toBe('function');
  });
});

// ── numerical proof coverage (the honest counterpart to name resolution) ──
// A catalog name is "proven" when TotalFinance reproduces its values against an external golden
// (TA-Lib / pandas-ta / tulipy) or a closed-form oracle — not merely that a same-named indicator
// exists. The remainder is an EXPLICIT, bounded allowlist so the gap is tracked, never hidden: as
// golden coverage grows, names move out of this list and the assertion forces it to stay in sync.

function goldenNames(file: string): string[] {
  const json = JSON.parse(
    readFileSync(fileURLToPath(new URL(`./golden/${file}`, import.meta.url)), 'utf8'),
  ) as { entries: Array<{ name?: string; fn?: string }> };
  return json.entries.map((e) => e.name ?? e.fn ?? '');
}

/**
 * TotalFinance canonical names with a numerical proof path. Derived from the proof manifest — a fixture
 * being PRESENT is not enough; it must be actually ASSERTED. TA-Lib counts every fixture function
 * except the documented-not-asserted ones; pandas-ta/tulipy count only their asserted lists.
 */
function provenSet(): Set<string> {
  const proven = new Set<string>();
  const add = (n: string): void => {
    const q = resolveIndicatorName(n);
    if (q) proven.add(q);
  };
  const talibSkip = new Set<string>(TALIB_FIXTURE_ONLY);
  for (const n of goldenNames('talib-golden.json')) if (!talibSkip.has(n)) add(n);
  for (const n of PANDAS_ASSERTED) add(n);
  for (const n of TULIPY_ASSERTED) add(n);
  // pandas-ta-ext suite + closed-form oracles are listed by TotalFinance canonical name directly (the
  // pandas 'cfo' fixture certifies forecastOscillator, not cfo, so a name-resolution map would lie).
  for (const n of PANDAS_EXT_PROVEN_QK) proven.add(n);
  for (const n of CLOSED_FORM_PROVEN_QK) proven.add(n);
  for (const n of CLOSED_FORM_ORACLE_QK) proven.add(n);
  // closed-form / behavioral oracles (utilities-behavioral.test.ts, talib-golden bridges)
  for (const n of ['crossover', 'crossany', 'smcSweep', 'volumeProfile', 'tosStdevAll', 'mavp']) {
    proven.add(n);
  }
  return proven;
}

// pandas-ta names certified through the candlestick golden suite (talib-candles-golden.test.ts).
const CANDLE_COVERED = new Set(['cdl_doji', 'cdl_inside']);

// Catalog entries that currently have ONLY name resolution — no numerical proof yet. Tracked so the
// gap is visible and bounded; shrink this as golden/closed-form coverage expands.
const PANDAS_NAME_ONLY = ['ht_dcphase', 'ht_sine', 'ht_trendmode', 'sarext'].sort();

describe('pandas-ta catalog — numerical proof coverage', () => {
  it('every catalog entry is numerically proven, candlestick-certified, or on the tracked name-only allowlist', () => {
    const proven = provenSet();
    const nameOnly = pandasIndicators
      .filter((name) => {
        if (hasCandleName(name) || CANDLE_COVERED.has(name)) return false;
        const q = resolveIndicatorName(name);
        return !(q && proven.has(q));
      })
      .sort();
    expect(nameOnly).toEqual(PANDAS_NAME_ONLY);
  });

  it('numerical proof covers nearly the whole catalog (no regression below 95%)', () => {
    const proven = pandasIndicators.length - PANDAS_NAME_ONLY.length;
    expect(proven / pandasIndicators.length).toBeGreaterThanOrEqual(0.95);
  });
});
