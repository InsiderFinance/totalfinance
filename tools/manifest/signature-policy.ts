/**
 * Human-reviewed exceptions and grammar overrides for the public-callable inventory.
 *
 * Most grammars are inferred structurally. Entries belong here only when a callable is deliberately
 * different from that inference or when a retained non-trivial positional signature needs an
 * explicit rationale. Keys are the stable callable IDs emitted by `signature-inventory.ts`.
 *
 * Phase 3A starts with this map empty. Generate the inventory, migrate unsafe APIs, then add only
 * genuinely natural positional exceptions. A stale key fails the conformance test.
 */

import type { CallGrammar } from './signature-inventory.js';

export interface SignaturePolicy {
  grammar?: CallGrammar;
  rationale?: string;
}

function retained(ids: readonly string[], rationale: string): Record<string, SignaturePolicy> {
  return Object.fromEntries(ids.map((id) => [id, { rationale }]));
}

const EXECUTION_PROTOCOL =
  'Reviewed strategy protocol: symbol, indicator stream, and source field are type-distinct and follow registration order; a wrapper would add ceremony without preventing a plausible transposition.';
const DATE_GRAMMAR =
  'Reviewed calendar grammar: subject/from/to and year/month/day follow universal chronological order; wrapping these conventional coordinates would obscure rather than clarify the operation.';
const RANGE_GRAMMAR =
  'Reviewed range grammar: value/min/max is a universal mathematical ordering, reinforced by the function name and optional trailing policy.';
const CORE_INFRASTRUCTURE =
  'Reviewed infrastructure helper: value/schema comes first and human-readable field/function context follows; arguments are role-distinct and used to construct diagnostics or facades.';
const RATE_FACTOR_GRAMMAR =
  'Reviewed scalar-factor grammar: rate and time are the only numeric coordinates and the trailing compounding enum makes the convention explicit.';
const MATHEMATICAL_GRAMMAR =
  'Reviewed mathematical kernel: parameter order follows standard notation (function/data first, coordinates or bounds next, options last); these are composable math primitives, not homogeneous financial requests.';
const FIXED_INCOME_GRAMMAR =
  'Reviewed fixed-income primitive: the subject or curve value comes first, followed by a conventional interval/term and a type-distinct convention or options object; no long homogeneous scalar vector is exposed.';
const SERIES_GRAMMAR =
  'Reviewed series operation: one or more series/streams lead, followed by a window, field, or options object; the types and established series-first order make transposition implausible.';
const FLUENT_GRAMMAR =
  'Reviewed fluent-builder method: field/indicator/parameters/alias are distinct concepts in pipeline order; an extra request wrapper would make fluent composition noisier without preventing a plausible mistake.';
const VOL_EVALUATOR_GRAMMAR =
  'Reviewed volatility evaluator: a calibrated parameter/surface object is the subject and the remaining coordinates use conventional strike-moneyness/time or from/to order; model parameters themselves stay named.';
const STATE_TIME_GRAMMAR =
  'Reviewed state/time evaluator: the first coordinate is the current state or level and the second is elapsed/remaining time, matching the mathematical function f(state, time); there are only two coordinates.';
const LATTICE_COORDINATE_GRAMMAR =
  'Reviewed lattice/index primitive: (step, node) or (left index, right index) is conventional coordinate order and the operation has exactly two integer coordinates.';
const TWO_ENDPOINT_GRAMMAR =
  'Reviewed two-endpoint operation: the pair is an explicitly named interval, comparison, or start/end move; with only two coordinates, positional order is the conventional mathematical API.';

export const SIGNATURE_POLICIES: Readonly<Record<string, SignaturePolicy>> = {
  ...retained(['@totalfinance/backtest:StrategyContext#indicator'], EXECUTION_PROTOCOL),
  ...retained(
    ['@totalfinance/calendars:nextExpiry', '@totalfinance/calendars:tradingDaysToExpiry'],
    DATE_GRAMMAR,
  ),
  ...retained(['@totalfinance/core:between', '@totalfinance/core:clamp'], RANGE_GRAMMAR),
  // FC7 (2026-08-28): the same (functionName, label, value) order as core's own guards — the
  // human-readable context leads and the value under test follows; the three are type-distinct.
  ...retained(['@totalfinance/portfolio:requirePortfolioEventEnvelope'], CORE_INFRASTRUCTURE),
  // Stage 4.6 (2026-09-03): the normalized-fill guard and the universe-history guard, in the same
  // (functionName, label, value) order as the envelope guard beside them.
  ...retained(['@totalfinance/portfolio:requireNormalizedFill'], CORE_INFRASTRUCTURE),
  ...retained(['@totalfinance/research:requireUniverseHistory'], CORE_INFRASTRUCTURE),
  // Stage 4.6 slice 1 (2026-09-03): the execution vocabulary's closed guards, same order.
  ...retained(
    [
      '@totalfinance/backtest:requireOrderIntent',
      '@totalfinance/backtest:requireFillDecision',
      '@totalfinance/backtest:requireExecutionPolicy',
      '@totalfinance/backtest:requireMarketObservation',
      '@totalfinance/backtest:requireFillContext',
      '@totalfinance/backtest:requireMarginPolicy',
    ],
    CORE_INFRASTRUCTURE,
  ),
  // Stage 4.6 slice 2 (2026-09-03): the cross-sectional request guard, same order.
  ...retained(['@totalfinance/backtest:requireCrossSectionalBacktestRequest'], CORE_INFRASTRUCTURE),
  // Stage 4.6 slice 3 (2026-09-04): the grid-request guard, the same (functionName, label, value) order.
  ...retained(
    ['@totalfinance/backtest:requireCrossSectionalBacktestGridRequest'],
    CORE_INFRASTRUCTURE,
  ),
  // Stage 4.6 slice 4 (2026-09-04): the options-backtest request guard, the same order.
  ...retained(['@totalfinance/backtest:requireOptionsBacktestConfig'], CORE_INFRASTRUCTURE),
  // Stage 4.6 slice 6 (2026-09-04): the out-of-sample request guards, the same order.
  ...retained(
    [
      '@totalfinance/backtest:requireCrossSectionalWalkForwardRequest',
      '@totalfinance/backtest:requireCrossSectionalPurgedFoldsRequest',
    ],
    CORE_INFRASTRUCTURE,
  ),
  // Stage 4.6 slice 5 (2026-09-04): the portfolio-backtest guards, the same order.
  ...retained(
    [
      '@totalfinance/backtest:requirePortfolioBacktestRequest',
      '@totalfinance/backtest:requirePortfolioStepperRequest',
      '@totalfinance/backtest:requireTradingEnvironmentDefinition',
      '@totalfinance/backtest:requireEnvironmentAction',
      '@totalfinance/backtest:requireEnvironmentOrder',
      '@totalfinance/backtest:requireEnvironmentLimits',
      '@totalfinance/backtest:requireRewardComposition',
      '@totalfinance/backtest:requireFeatureRecipes',
      '@totalfinance/backtest:requireEnvironmentEpisodeInput',
    ],
    CORE_INFRASTRUCTURE,
  ),
  // Stage 7B.2 slice 1 (2026-09-05): the trade-lifecycle guards, the same (functionName, label, value) order.
  ...retained(
    [
      '@totalfinance/portfolio:requireTradeOrder',
      '@totalfinance/portfolio:requireTradeIntent',
      '@totalfinance/portfolio:requireExecutionPlan',
      '@totalfinance/portfolio:requireTradePolicy',
      '@totalfinance/portfolio:requirePreflightInstrument',
      '@totalfinance/portfolio:requirePreflightCostRates',
      '@totalfinance/portfolio:requireGrantVariance',
      '@totalfinance/portfolio:requirePreflightReport',
      '@totalfinance/portfolio:requireAuthorizationGrant',
      '@totalfinance/portfolio:requireExecutionJournalEvent',
      '@totalfinance/portfolio:requireExecutionOrderState',
      '@totalfinance/portfolio:requireExecutionJournalState',
      '@totalfinance/backtest:requirePaperInstrument',
      '@totalfinance/backtest:requireCreatePaperBrokerInput',
      '@totalfinance/workflows:requireCapabilities',
      '@totalfinance/backtest:requireAccountingPolicy',
      '@totalfinance/backtest:requireInstrumentSpecification',
      '@totalfinance/backtest:requirePortfolioMarketData',
    ],
    CORE_INFRASTRUCTURE,
  ),
  // Stage 7A (2026-09-03): the JSON Schema document guard, in the same (functionName, field, value) order.
  ...retained(['@totalfinance/core:requireJSONSchema'], CORE_INFRASTRUCTURE),
  // Stage 7A (2026-09-03): the operation kit's row cap (rows, field, operation id, max), the
  // transport-edge error mapper (error, operation) — moved from @totalfinance/mcp unchanged — and the
  // operation guard (functionName, field, value) in core's own guard order.
  ...retained(
    [
      '@totalfinance/workflows:capRows',
      '@totalfinance/workflows:extendObjectSchema',
      '@totalfinance/workflows:requireOperation',
      '@totalfinance/workflows:toOperationError',
      // Stage 7A slice 3 (2026-09-03): the handle/store guards in core's (functionName, field, value)
      // order, the two-positional `handleUriOf(kind, id)`, and `applyJobPatch(functionName, current, patch)`.
      '@totalfinance/workflows:handleUriOf',
      '@totalfinance/workflows:requireResourceHandle',
      '@totalfinance/workflows:requireArtifactPut',
      '@totalfinance/workflows:requireArtifactListFilter',
      '@totalfinance/workflows:requireJobRecord',
      '@totalfinance/workflows:applyJobPatch',
    ],
    CORE_INFRASTRUCTURE,
  ),
  ...retained(
    ['@totalfinance/core:compoundFactor', '@totalfinance/core:discountFactor'],
    RATE_FACTOR_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/core:ensureEnum',
      '@totalfinance/core:ensureFinite',
      '@totalfinance/core:ensureFiniteWhenPresent',
      '@totalfinance/core:ensureKnownKeys',
      '@totalfinance/core:ensureNonNegative',
      '@totalfinance/core:ensurePositive',
      '@totalfinance/core:facade',
      '@totalfinance/core:missingFieldError',
      '@totalfinance/core:requireArgumentArray',
      '@totalfinance/core:requireArgumentObject',
      '@totalfinance/core:requireFiniteFields',
      '@totalfinance/core:seriesFacade',
      '@totalfinance/core:validate',
      '@totalfinance/core:validateClosedRequest',
      '@totalfinance/core:validateResolvedExpiry',
      '@totalfinance/core:warning',
      '@totalfinance/core:wrongShapeError',
      '@totalfinance/core:optionalObservationValue',
      '@totalfinance/core:requireObservationValue',
      '@totalfinance/core:validateMarketObservation',
      '@totalfinance/core:validateMarketRequirement',
      '@totalfinance/core:requireFittedModelSummary',
      '@totalfinance/core:requireRateCurveData',
      '@totalfinance/foreign-exchange:requireCurrencyCode',
      '@totalfinance/foreign-exchange:requireCurrencyPairQuote',
      '@totalfinance/performance:degenerateAwareDiagnostics',
      '@totalfinance/performance:requireSeries',
      '@totalfinance/research:requireMarketEvent',
      '@totalfinance/research:requireReturnObservations',
      '@totalfinance/research:requireScreenFilter',
      '@totalfinance/research:requireUniverseObservation',
      '@totalfinance/research:requireUniverseObservations',
    ],
    CORE_INFRASTRUCTURE,
  ),
  ...retained(
    [
      '@totalfinance/core:lastWeekdayOfMonth',
      '@totalfinance/core:nthWeekdayOfMonth',
      '@totalfinance/core:observedHoliday',
      '@totalfinance/core:usEquityCloseUtcMs',
      '@totalfinance/core:yearFraction',
      '@totalfinance/core:ymd',
    ],
    DATE_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/fixed-income:addMonths',
      '@totalfinance/fixed-income:adjustDate',
      '@totalfinance/fixed-income:daysInMonth',
      '@totalfinance/fixed-income:yearFraction',
    ],
    DATE_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/fixed-income:ShortRateTree#rollback',
      '@totalfinance/fixed-income:GaussianShortRateModel#discountBond',
      '@totalfinance/fixed-income:GaussianShortRateModel#zeroRate',
      '@totalfinance/fixed-income:ShortRateModel#discountBond',
      '@totalfinance/fixed-income:ShortRateModel#zeroRate',
      '@totalfinance/fixed-income:YieldCurve#forwardRate',
      '@totalfinance/fixed-income:YieldCurve#bumpPillar',
      '@totalfinance/fixed-income:discountFromZero',
      '@totalfinance/fixed-income:yieldToCall',
      '@totalfinance/fixed-income:yieldToCall.explain',
      '@totalfinance/fixed-income:zeroFromDiscount',
    ],
    FIXED_INCOME_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/math:adaptiveSimpson',
      '@totalfinance/math:adaptiveSimpsonSafe',
      '@totalfinance/math:bfgs',
      '@totalfinance/math:bicubicInterp',
      '@totalfinance/math:bilinearInterp',
      '@totalfinance/math:bisection',
      '@totalfinance/math:bivariateNormalCdf',
      '@totalfinance/math:bootstrap',
      '@totalfinance/math:bracketExpand',
      '@totalfinance/math:brent',
      '@totalfinance/math:brentMin',
      '@totalfinance/math:controlVariateEstimate',
      '@totalfinance/math:correlation',
      '@totalfinance/math:covariance',
      '@totalfinance/math:differentialEvolution',
      '@totalfinance/math:findRoot',
      '@totalfinance/math:gamma.cdf',
      '@totalfinance/math:gamma.inverseCdf',
      '@totalfinance/math:gaussLegendre',
      '@totalfinance/math:goldenSectionMin',
      '@totalfinance/math:halley',
      '@totalfinance/math:haltonSequence',
      '@totalfinance/math:householder',
      '@totalfinance/math:levenbergMarquardt',
      '@totalfinance/math:linearInterp',
      '@totalfinance/math:makeBicubicInterpolator',
      '@totalfinance/math:makeLinearInterpolator',
      '@totalfinance/math:makeNaturalCubicSpline',
      '@totalfinance/math:makePchipInterpolator',
      '@totalfinance/math:nelderMead',
      '@totalfinance/math:newton',
      '@totalfinance/math:normalSample',
      '@totalfinance/math:ols',
      '@totalfinance/math:qrSolve',
      '@totalfinance/math:quantile',
      '@totalfinance/math:regularizedBeta',
      '@totalfinance/math:ljungBox',
      '@totalfinance/math:ridder',
      '@totalfinance/math:rollingCorrelation',
      '@totalfinance/math:rollingCovariance',
      '@totalfinance/math:rollingStandardDeviation',
      '@totalfinance/math:secant',
      '@totalfinance/math:validateInterpolationData',
    ],
    MATHEMATICAL_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/technical-analysis:FeaturePipeline#applyBars',
      '@totalfinance/technical-analysis:FeaturePipeline#applySeries',
      '@totalfinance/technical-analysis:FeaturePipeline#bbands',
      '@totalfinance/technical-analysis:FeaturePipeline#ema',
      '@totalfinance/technical-analysis:FeaturePipeline#macd',
      '@totalfinance/technical-analysis:FeaturePipeline#rollingVolatility',
      '@totalfinance/technical-analysis:FeaturePipeline#rsi',
      '@totalfinance/technical-analysis:FeaturePipeline#sma',
      '@totalfinance/technical-analysis:FeaturePipeline#wma',
      '@totalfinance/technical-analysis:SignalBuilder#ema',
      '@totalfinance/technical-analysis:SignalBuilder#rsi',
      '@totalfinance/technical-analysis:SignalBuilder#sma',
      '@totalfinance/technical-analysis:SignalBuilder#use',
      '@totalfinance/technical-analysis:SignalBuilder#useBars',
      '@totalfinance/technical-analysis:SignalBuilder#wma',
    ],
    FLUENT_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/technical-analysis:between',
      '@totalfinance/technical-analysis:collect',
      '@totalfinance/technical-analysis:collectAsync',
      '@totalfinance/technical-analysis:makeIndicator',
      '@totalfinance/technical-analysis:resample',
    ],
    SERIES_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/volatility:VolatilitySurface#impliedVolatilityByMoneyness',
      '@totalfinance/volatility:calendarSkew',
      '@totalfinance/volatility:calendarSkew.explain',
      '@totalfinance/volatility:essviTotalVariance',
      '@totalfinance/volatility:essviVolatility',
      '@totalfinance/volatility:forwardSkew',
      '@totalfinance/volatility:forwardSkew.explain',
      '@totalfinance/volatility:forwardVolatility',
      '@totalfinance/volatility:forwardVolatility.explain',
      '@totalfinance/volatility:ssviTotalVariance',
      '@totalfinance/volatility:ssviVolatility',
      '@totalfinance/volatility:sviVolatility',
    ],
    VOL_EVALUATOR_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/options:DupireLocalVolatilityInput#impliedVolatility',
      '@totalfinance/options:LocalVolatilityMonteCarloEstimateInput#localVolatility',
      '@totalfinance/options:LocalVolatilityPriceMonteCarloRequest#localVolatility',
      '@totalfinance/strategy:OptimizerThesis#pdf',
      '@totalfinance/strategy:ProbabilityMonteCarloInput#localVolatility',
      '@totalfinance/volatility:LocalVolatilitySurface#localVolatility',
      '@totalfinance/volatility:LocalVolatilitySurfaceInput#impliedVolatility',
    ],
    STATE_TIME_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/fixed-income:ShortRateTree#shortRate',
      '@totalfinance/options:EquityLattice#spotAt',
      '@totalfinance/technical-analysis:CandleView#bodyGapDown',
      '@totalfinance/technical-analysis:CandleView#bodyGapUp',
      '@totalfinance/technical-analysis:CandleView#gapDown',
      '@totalfinance/technical-analysis:CandleView#gapUp',
    ],
    LATTICE_COORDINATE_GRAMMAR,
  ),
  ...retained(
    [
      '@totalfinance/technical-analysis:CandleView#equalish',
      '@totalfinance/technical-analysis:CandleView#far',
      '@totalfinance/technical-analysis:CandleView#near',
      '@totalfinance/technical-analysis:fibRetracement',
      '@totalfinance/technical-analysis:priceAction.fibRetracement',
      '@totalfinance/volatility:RiskNeutralDistribution#probabilityBetween',
      '@totalfinance/volatility:VannaVolga5Density#probabilityBetween',
      '@totalfinance/volatility:VannaVolgaDensity#probabilityBetween',
    ],
    TWO_ENDPOINT_GRAMMAR,
  ),
};
