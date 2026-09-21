/**
 * Single source of truth for WHICH committed golden fixtures are *numerically asserted* — as opposed
 * to merely *present* in a fixture file. The golden generators emit a few reference series that are
 * deliberately NOT asserted (documented different-definition cases); counting those as "proven" would
 * over-state coverage. The parity tests drive their assertions from these lists, and
 * `catalog-parity.test.ts` derives its proof-coverage set from them, so the two can never disagree.
 *
 * A consistency test in `pandas-ta-golden.test.ts` / `tulipy-golden.test.ts` asserts that these lists
 * partition the actual fixture contents exactly (every entry is classified, none invented).
 */

// ── pandas-ta ──
/** Exact element-wise match (~1e-7). */
export const PANDAS_EXACT = [
  'ao',
  'cmf',
  'chop',
  'coppock',
  'cti',
  'massi',
  'efi',
  'psl',
  'vhf',
  'ebsw',
  'fwma',
  'hma',
  'pwma',
  'sinwma',
  'swma',
  'vwma',
  'zScore',
  'mad',
  'skew',
  'kurtosis',
  'median',
  'ui',
  'pdist',
] as const;
/** Converges to pandas-ta after the EMA/RMA seed transient decays (coverage enforced; ~1e-5). */
export const PANDAS_EXACT_SEED = ['rma', 'zlma'] as const;
/** Multi-output, asserted exact on every output. */
export const PANDAS_MULTI = ['tsi', 'vortex', 'drawdown', 'cdl_z'] as const;
/** Asserted, but with a documented convention/approximation (percent scale, ATR transient, …). */
export const PANDAS_BRIDGE = ['bias', 'supertrend', 'amat', 'alma'] as const;
/** Present in the fixture as a reference, but a different definition → intentionally NOT asserted. */
export const PANDAS_FIXTURE_ONLY = ['nvi', 'pvi', 'pgo'] as const;
export const PANDAS_ASSERTED: readonly string[] = [
  ...PANDAS_EXACT,
  ...PANDAS_EXACT_SEED,
  ...PANDAS_MULTI,
  ...PANDAS_BRIDGE,
];

// ── pandas-ta (extended / long-tail) ──
// Second wave: indicators that previously had only name-resolution coverage, now asserted against
// pandas-ta-ext-golden.json. Fixture names (snake_case) below; the TotalFinance canonical names they
// certify (for proof-coverage accounting) are in PANDAS_EXT_PROVEN_QK.
/** Exact / near-exact element-wise match (≤1e-3; most ≤1e-13). */
export const PANDAS_EXT_EXACT = [
  'decreasing',
  'increasing',
  'er',
  'hwma',
  'log_return',
  'percent_return',
  'mcgd',
  'quantile',
  'slope',
  'accbands',
  'brar',
  'donchian',
  'eom',
  'eri',
  'ha',
  'ichimoku',
  'pvol',
  'pvr',
  'pvo',
  'rvgi',
  'thermo',
  'ttm_trend',
  'qqe',
  'stochrsi',
  'aberration',
  'cksp',
  'kc',
  'cfo',
] as const;
/** Converges after a Wilder/recursive seed transient (coverage enforced; asserted from an offset). */
export const PANDAS_EXT_CONVERGE = ['ssf', 'hwc', 'adx', 'dm', 'rsx', 'kdj'] as const;
/** Asserted exact after a documented percent-scale convention (TotalFinance fraction vs pandas ×100). */
export const PANDAS_EXT_BRIDGE = ['pvt', 'kst', 'smi'] as const;
/** Asserted on an exact integer signal (the squeeze on-state flag). */
export const PANDAS_EXT_FLAG = ['squeeze'] as const;
/** Present as a reference but a documented different definition → intentionally NOT asserted. */
export const PANDAS_EXT_FIXTURE_ONLY = [
  'cg',
  'decay',
  'edecay',
  'dpo',
  'entropy',
  'vidya',
  'ssf3',
  'stc',
  'jma',
  'fisher',
  'hilo',
  'inertia',
  'kvo',
  'nvi',
  'pvi',
  'pgo',
  'rvi',
  'squeeze_pro',
  'aobv',
  'long_run',
  'short_run',
] as const;
export const PANDAS_EXT_ASSERTED: readonly string[] = [
  ...PANDAS_EXT_EXACT,
  ...PANDAS_EXT_CONVERGE,
  ...PANDAS_EXT_BRIDGE,
  ...PANDAS_EXT_FLAG,
];
/**
 * TotalFinance canonical names certified by the pandas-ta-ext suite — drives proof-coverage accounting.
 * NB: the pandas `cfo` fixture certifies TotalFinance's **forecastOscillator** (pandas-ta's CFO is the
 * one-bar TSF-forecast variant), not TotalFinance's regression-value `cfo`; `dm` certifies `dmi`.
 */
export const PANDAS_EXT_PROVEN_QK: readonly string[] = [
  'decreasing',
  'increasing',
  'efficiencyRatio',
  'holtWinterMovingAverage',
  'logReturns',
  'returns',
  'mcginley',
  'rollingQuantile',
  'slope',
  'accelerationBands',
  'brar',
  'donchian',
  'easeOfMovement',
  'elderRay',
  'heikinAshi',
  'ichimoku',
  'priceVolume',
  'priceVolumeRank',
  'pvo',
  'relativeVigorIndex',
  'elderThermometer',
  'ttmTrend',
  'qqe',
  'stochRsi',
  'aberration',
  'chandeKrollStop',
  'keltner',
  'forecastOscillator',
  'superSmoother',
  'holtWinterChannel',
  'adx',
  'dmi',
  'rsx',
  'kdj',
  'pvt',
  'kst',
  'smiErgodic',
  'squeeze',
];
/** TotalFinance canonical names certified by closed-form / structural oracles (no external library). */
export const CLOSED_FORM_PROVEN_QK: readonly string[] = [
  'adxr',
  'standardError',
  'lag',
  'centralPivotRange',
];

/**
 * Long-tail names certified by closed-form correctness oracles (`closed-form-oracles.test.ts`): each
 * is recomputed from its published defining formula using TotalFinance's golden-certified primitives
 * (SMA/EMA/VWMA/ATR/STDDEV/LINREG/TRIX/OBV/RMA) and asserted equal. This proves the implementation is
 * internally correct where no single external library agrees on the convention (or has no entry).
 */
export const CLOSED_FORM_ORACLE_QK: readonly string[] = [
  'volumeOscillator',
  'volumeWeightedMacd',
  'archerObv',
  'nvi',
  'pvi',
  'chaikinVolatility',
  'historicalVolatility',
  'dsp',
  'vwap',
  'rainbowMovingAverage',
  'movingAverageRibbon',
  'vidya',
  'linearDecay',
  'exponentialDecay',
  'centerOfGravity',
  'cfo',
  'trixHistogram',
  'dpo',
  'laguerreRsi',
  'fisherTransform',
  'trendSignals',
  'crossSignals',
  'beta',
  'macdFix',
  'macdExt',
  'pgo',
  'relativeVolatilityIndex',
  'klinger',
  'kvo', // same registered function as `klinger` (dual-named); certified via the klinger oracle
  'entropy',
  'emv',
  'chandelierExit',
  'gannHighLowActivator',
  'longRun',
  'shortRun',
  'inertia',
  'schaffTrendCycle',
  'projectionOscillator',
  'pMax',
  // batch 4 — chosen public-formula oracles (Jurik / Katsanos / LazyBear / DeMark)
  'jma',
  'vfi',
  'squeezePro',
  'tdSequential',
];

// ── tulipy ──
/** Exact element-wise match. */
export const TULIPY_EXACT = ['crossover', 'crossany', 'qstick', 'wad', 'marketfi'] as const;
/** Warmup-aligned + values match except isolated phase singularities. */
export const TULIPY_CONVERGE = ['msw'] as const;
export const TULIPY_ASSERTED: readonly string[] = [...TULIPY_EXACT, ...TULIPY_CONVERGE];

// ── TA-Lib ──
/**
 * TA-Lib fixtures that are PRESENT but NOT asserted against TA-Lib's own values — these are the
 * documented-difference functions whose TotalFinance value follows a different reference (TradingView,
 * Ehlers, a different definition). Excluded from proof-coverage accounting. (MACD and CMO are
 * asserted against their TradingView/simple-sum oracles, so they are NOT here.)
 */
// STOCHRSI is NOT here: it is asserted bit-for-bit against TA-Lib in talib-modes.test.ts (TA-Lib's
// `fastk` is the raw %K → `kPeriod: 1`). CMO and OBV also gained exact `talib: true` modes there, but
// they were already asserted (CMO via its simple-sum oracle, OBV via the +volume[0] bridge).
export const TALIB_FIXTURE_ONLY = [
  'MACDFIX',
  'BETA',
  'ADXR',
  'HT_DCPHASE',
  'HT_SINE',
  'HT_TRENDMODE',
] as const;
