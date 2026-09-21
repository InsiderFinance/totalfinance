/**
 * The validation-spec roster (spec 3B.1b): which public boundaries get GENERATED runtime
 * validation specs.
 *
 * MEMBERSHIP is curated — a cluster opts in when it migrates to `validateClosedRequest`, so the
 * generated modules and their bundle cost stay proportional to the migrated surface. CONTENT is
 * generated — the per-contract field specs are projected from the checker-derived inventory by
 * `validation-specs.ts`, never hand-authored, because a hand-written key list and the declaration
 * it mirrors are two artifacts that drift.
 *
 * Adding a row here without running `pnpm validation:update` fails the drift gate; a row whose
 * boundary the inventory cannot resolve fails generation loudly.
 */

export interface ValidationRosterEntry {
  /** The package whose `src/generated/validation-specs.ts` carries the specs. */
  readonly package: string;
  /** Public boundary paths (the part after `pkg:`) whose object parameters get specs. */
  readonly boundaries: readonly string[];
}

/**
 * CURATED IEEE bound fields (C03: generate structure, curate meaning): fields whose documented
 * domain includes ±Infinity as the spelled "unbounded". Evidence, from the library's own code and
 * exact-identity tests:
 *
 *   - `CliquetInput.localCap` — doc: "default `+∞` (uncapped)"; resolver: `?? Infinity`.
 *   - `CliquetInput.globalFloor` / `globalCap` — resolver defaults `-Infinity` / `Infinity`,
 *     only relational checks.
 *   - `NapoleonInput.globalFloor` (napoleon + both reverseCliquet boundaries) — the MC/closed-form
 *     exact-identity test passes `-Infinity` as "unfloored".
 *
 * `localFloor` is NOT here: the resolver requires it finite and ≥ −1. NaN is rejected everywhere
 * regardless — no bound is ever spelled NaN. Keys are `boundary#argumentIndex`; boundaries that
 * share a contract must agree, and the generator throws when they do not.
 */
/**
 * CURATED artifact-valued fields (C05): the field holds a RICH ARTIFACT (a YieldCurve, a fitted
 * model) whose own curated instance guard teaches better than a projected member walk —
 * "expected a curve built by curves.fromZeroRates(...)" beats "discountCurve.discount is
 * required". The spec enforces PRESENCE and null only; the instance guard downstream owns shape.
 */
export const UNCHECKED_ARTIFACT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'priceMultiCurve#1': ['discountCurve', 'forecastCurve'],
  // `chains` is declared Iterable<ChainSnapshot> — a GENERATOR is legal input, and the projector
  // classifies iterables as 'array', whose walker check (Array.isArray) would reject it. The
  // boundary keeps its own hand iterable guard (Symbol.iterator), which is the honest shape test.
  'optionsBacktest#0': ['chains'],
};

export const NON_FINITE_BOUND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'cliquet.price#0': ['localCap', 'globalFloor', 'globalCap'],
  'cliquet.monteCarloPrice#0': ['localCap', 'globalFloor', 'globalCap'],
  'napoleon.monteCarloPrice#0': ['globalFloor'],
  'reverseCliquet.floorlessValue#0': ['globalFloor'],
  'reverseCliquet.monteCarloPrice#0': ['globalFloor'],
};

export const VALIDATION_ROSTER: readonly ValidationRosterEntry[] = [
  {
    // The options-backtest configuration tree (the deepest nested request in the library): the
    // 7-arm EntryRule discriminated union over `structure` (+ the `build` callback escape arm),
    // exit/roll triggers, the delta-hedge rule. Its ~45 member convictions were the largest
    // remaining defective surface after the coordinated tail sweep. Reviewed 2026-08-16.
    package: '@totalfinance/backtest',
    boundaries: ['optionsBacktest'],
  },
  {
    // The volatility package sweep (50 defective boundaries across 20 files): calibrators,
    // surface/slice evaluators, arbitrage reports, vanna-volga, term structure, and analytics.
    // Positional-scalar rows pruned after generation (2: calendarSkew, forwardVolatility) —
    // their guards are hand code per the solver precedent. Reviewed 2026-08-15.
    package: '@totalfinance/volatility',
    boundaries: [
      'arbitrageReport',
      'calibrateEssvi',
      'calibrateHestonSurface',
      'calibrateSabrSmile',
      'calibrateSsvi',
      'calibrateSvi',
      'calibrateVannaVolga',
      'calibrateVannaVolga5',
      'checkButterfly',
      'checkCalendar',
      'essviArbitrageFree',
      'essviTotalVariance',
      'essviVolatility',
      'eventVolatilityAtExpiry',
      'estimateVolatilitySpotBeta',
      'fitGarch',
      'fitHarRv',
      'forwardSkew',
      'garchForecast',
      'harRvForecast',
      'minimumVarianceDelta',
      'phiValue',
      'prepareSlices',
      'riskNeutralDistribution',
      'riskReversalButterfly',
      'sabrBartlettGreeks',
      'skew',
      'smileFromQuotes',
      'ssviArbitrageFree',
      'ssviSliceW',
      'ssviToSVI',
      'ssviTotalVariance',
      'ssviVolatility',
      'surfaceArbitrageReport',
      'surfacePCA',
      'surfacePcaScenarios',
      'sviButterflyFree',
      'sviG',
      'sviMinG',
      'sviTotalVariance',
      'sviVolatility',
      'swaptionCubeVolatility',
      'tailRiskIndex',
      'vannaVolga5Density',
      'varianceIndex',
      'varianceRiskPremiumTermStructure',
      'varianceSwapRate',
      'volatilityCone',
      'volatilitySurface',
    ],
  },
  {
    // The TA Stream-constructor back doors (68 classes across 19 files): the facades validate
    // through makeIndicator's resolve, but `new AlmaStream({ period: null })` built a poisoned
    // stream with no error. Constructors take RESOLVED all-required parameters; their specs come
    // from the same inventory field trees as every other boundary. Reviewed 2026-08-15.
    package: '@totalfinance/technical-analysis',
    boundaries: [
      'AlmaStream.constructor',
      'ApoStream.constructor',
      'AwesomeStream.constructor',
      'BarAggregator.constructor',
      'BinaryMathStream.constructor',
      'BollingerBandFieldStream.constructor',
      'BollingerStream.constructor',
      'CandleStream.constructor',
      'CandleView.constructor',
      'CandleZStream.constructor',
      'ChaikinOscStream.constructor',
      'ChaikinVolatilityStream.constructor',
      'ChandelierStream.constructor',
      'ConnorsRsiStream.constructor',
      'CoppockStream.constructor',
      'CrossPairStream.constructor',
      'EbswStream.constructor',
      'EomStream.constructor',
      'HistoricalVolatilityStream.constructor',
      'HtScalarStream.constructor',
      'HwmaStream.constructor',
      'IchimokuStream.constructor',
      'InertiaStream.constructor',
      'InformationBarAggregator.constructor',
      'JmaStream.constructor',
      'KamaStream.constructor',
      'KdjStream.constructor',
      'KeltnerStream.constructor',
      'KlingerStream.constructor',
      'KstStream.constructor',
      'LinregOscStream.constructor',
      'MacdStream.constructor',
      'MamaStream.constructor',
      'MapBarStream.constructor',
      'MomentStream.constructor',
      'PpoStream.constructor',
      'PsarExtStream.constructor',
      'PsarStream.constructor',
      'PvoStream.constructor',
      'QqeStream.constructor',
      'RainbowMovingAverageStream.constructor',
      'RangeVolatilityStream.constructor',
      'RealizedVolatilityStream.constructor',
      'RocStream.constructor',
      'RollStream.constructor',
      'RollingAnchoredVwapStream.constructor',
      'RollingVolatilityStream.constructor',
      'RviStream.constructor',
      'SchaffTrendCycleStream.constructor',
      'SignalContext.constructor',
      'SmiErgodicStream.constructor',
      'SqueezeCore.constructor',
      'SqueezeProStream.constructor',
      'SqueezeStream.constructor',
      'StochRsiStream.constructor',
      'StochasticStream.constructor',
      'SupertrendStream.constructor',
      'T3Stream.constructor',
      'TrixHistogramStream.constructor',
      'TsiStream.constructor',
      'UltimateStream.constructor',
      'UnaryMathStream.constructor',
      'VfiStream.constructor',
      'VidyaStream.constructor',
      'VolumeIndexStream.constructor',
      'VolumeWeightedMacdStream.constructor',
      'WeightedMovingAverageStream.constructor',
      'YangZhangStream.constructor',
    ],
  },
  {
    // The bonds cluster, spec-projectable half (8 of 12 defective boundaries): builder
    // specifications — including the true-union `Amortization` field, the branch path's first live
    // consumer — and the Bond artifact's projection-context methods. The four `.explain`
    // companions are NOT here: they are facade-template boundaries (`...callArguments: Args`, the
    // documented RV31 truncation-exception class) whose Law-12 enforcement belongs to the facade
    // wrapper, not to projected specs. Reviewed 2026-08-15.
    package: '@totalfinance/fixed-income',
    boundaries: [
      'priceMultiCurve',
      'yieldToCall',
      'Bond#accrued',
      'Bond#cashflows',
      'Bond#futureCashflows',
      'bonds.amortizing',
      'bonds.fixedRate',
      'bonds.floatingRateNote',
      'bonds.inflationLinked',
      'bonds.zeroCoupon',
    ],
  },
  {
    // The Law-12 unknown-key cluster's largest file (41 boundaries, exotics.ts), first migrated
    // consumer of the shared validator. Reviewed 2026-08-14.
    package: '@totalfinance/options',
    boundaries: [
      'heston.cosineExpansion',
      'heston.impliedVolatility',
      'heston.monteCarloEstimate',
      'heston.monteCarloPrice',
      'heston.price',
      'hestonCosineExpansionPrice',
      'hestonFirstOrderSteps',
      'hestonImpliedVolatility',
      'hestonMonteCarloEstimate',
      'hestonMonteCarloPrice',
      'hestonPrice',
      'OptionPricingEngine#supports',
      'dupireLocalVolatility',
      'engines.auto',
      'engines.binomial',
      'engines.finiteDifference.crankNicolson',
      'engines.heston',
      'engines.localVolatility',
      'engines.monteCarlo',
      'engines.sabr',
      'engines.trinomial',
      'localVolatility.fromImplied',
      'localVolatility.grid',
      'localVolatility.monteCarloEstimate',
      'localVolatility.monteCarloPrice',
      'localVolatilityGrid',
      'localVolatilityMonteCarloEstimate',
      'localVolatilityMonteCarloPrice',
      'sabr.monteCarloEstimate',
      'sabr.monteCarloPrice',
      'sabr.price',
      'sabr.volatility',
      'sabrMonteCarloEstimate',
      'sabrMonteCarloPrice',
      'sabrPrice',
      'sabrVolatility',
      'asian.geometricPrice',
      'asian.monteCarloPrice',
      'autocallable.monteCarloPrice',
      'barrier.monteCarloPrice',
      'barrier.price',
      'basket.approximatePrice',
      'basket.monteCarloPrice',
      'cliquet.monteCarloPrice',
      'cliquet.price',
      'compo.greeks',
      'compo.monteCarloPrice',
      'compo.price',
      'digital.extendedGreeks',
      'digital.greeks',
      'digital.monteCarloPrice',
      'digital.price',
      'doubleTouch.greeks',
      'doubleTouch.monteCarloPrice',
      'doubleTouch.price',
      'forwardStart.monteCarloPrice',
      'forwardStart.price',
      'inverseOption.barrier',
      'inverseOption.digital',
      'inverseOption.greeks',
      'inverseOption.monteCarloPrice',
      'inverseOption.price',
      'lookback.monteCarloPrice',
      'lookback.price',
      'napoleon.monteCarloPrice',
      'quanto.price',
      'rainbow.monteCarloPrice',
      'reverseCliquet.floorlessValue',
      'reverseCliquet.monteCarloPrice',
      'spread.monteCarloPrice',
      'spread.price',
      'touch.greeks',
      'touch.monteCarloPrice',
      'touch.price',
      'varianceSwap.hestonFairVariance',
      'varianceSwap.value',
      'volatilitySwap.approximateFairVolatility',
    ],
  },
];
