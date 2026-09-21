/**
 * `@totalfinance/risk` — risk & portfolio analytics (spec §12.2). Depends only on `@totalfinance/core`,
 * `@totalfinance/math` and `@totalfinance/performance`; importing a VaR helper never drags in option pricing.
 *
 * Four pillars, each also available as a focused sub-path import:
 *   • `./var`       VaR / CVaR (parametric · historical · Monte-Carlo) + portfolio decomposition
 *   • `./scenario`  stress & scenario testing with Greeks-Taylor P&L explain
 *   • `./factor`    factor / PCA exposure
 *   • `./optimize`  min-variance · max-Sharpe · mean-variance · risk parity · HRP · Kelly
 *
 * Return/performance metrics (Sharpe, Sortino, drawdown, …) live in `@totalfinance/performance`
 * (the nested namespace re-export was removed in P3.3 — one namespace level per concept).
 */

export {
  valueAtRisk,
  expectedShortfall,
  valueAtRiskReport,
  portfolioVariance,
  portfolioVolatility,
  riskContributions,
  diversificationRatio,
  portfolioVaR,
} from './value-at-risk.js';
export type {
  VaRMethod,
  VaROptions,
  VaRResult,
  RiskContributionRow,
  RiskContributionsResult,
  ParametricPortfolioVaROptions,
  ParametricPortfolioVaRInput,
  MonteCarloPortfolioVaRInput,
  PortfolioVaRResult,
  MonteCarloPortfolioVaRResult,
  HistoricalPortfolioVaROptions,
  HistoricalPortfolioVaRInput,
  HistoricalPortfolioVaRResult,
  PortfolioVaRInput,
  PortfolioVaROutput,
} from './value-at-risk.js';

export { shock, scenario, taylorPnl, stressTest, scenarioGrid } from './scenario.js';
export type {
  ShockKind,
  ShockFactor,
  Shock,
  Scenario,
  PositionGreeks,
  Position,
  PnlAttribution,
  TaylorPnlResult,
  PositionScenarioResult,
  ScenarioResult,
  StressOptions,
  StressTestResult,
  ResolvedGridShock,
  ScenarioGridResult,
} from './scenario.js';

export { explainPnl, explainPositionPnl, explainPortfolioPnl } from './pnl-explain.js';
export type {
  PnlMove,
  PnlExplain,
  PnlMarket,
  LegPnlExplain,
  PositionPnlExplain,
  PortfolioPnlItem,
  PortfolioPnlExplain,
  ExplainPnlInput,
  ExplainPositionPnlInput,
} from './pnl-explain.js';
// The structural shape of a strategy `Position` that the book / VaR / P&L-explain analytics accept.
// Risk owns these mirrors so it never imports `@totalfinance/strategy` (the layering points strategy → risk).
export type {
  StrategyLegKind,
  StrategyLeg,
  StrategyOptionLeg,
  StrategyStockLeg,
  StrategyMarkToMarketMarket,
  StrategyLegValuation,
  StrategyMarkToMarketResult,
  StrategyPayoffMetrics,
  StrategyPosition,
} from './strategy-shape.js';
export { analyzeBook } from './book.js';
export type {
  BookPosition,
  BookOptions,
  BookGreeks,
  PositionRisk,
  UnderlyingRisk,
  BookRisk,
} from './book.js';
export { bookVaR } from './book-var.js';
export type {
  BookVaRPosition,
  BookVaROptions,
  UnderlyingRiskFactor,
  BookVaRComponent,
  BookVaRMethodResult,
  BookVaRResult,
} from './book-var.js';
// The covariance on-ramp (D11): returns → covariance()/meanReturns() → optimizer.
export { covariance, meanReturns } from './covariance.js';
export type {
  CovarianceInput,
  CovarianceOptions,
  CovarianceValue,
  CovarianceResult,
  MeanReturnsInput,
} from './covariance.js';

export { pca, factorExposure, covarianceToCorrelation } from './factor.js';
export type { PcaComponent, PcaResult, FactorExposureResult } from './factor.js';
// Return attribution: factor P&L (regression) + Brinson (allocation/selection/interaction).
export { factorAttribution, brinsonAttribution, linkAttribution } from './attribution.js';
export type {
  FactorSeries,
  FactorAttributionInput,
  FactorContribution,
  FactorAttribution,
  BrinsonSegment,
  SegmentEffect,
  BrinsonAttributionOptions,
  BrinsonAttribution,
  AttributionPeriod,
  LinkAttributionOptions,
  LinkingCoefficient,
  LinkedAttribution,
} from './attribution.js';

export {
  concentration,
  liquidity,
  marketImpact,
  margin,
  nakedCallMargin,
  nakedPutMargin,
  optionsMargin,
  aggregateGreeks,
  betaWeightedDelta,
} from './portfolio.js';
export type {
  AggregateGreeksResult,
  ConcentrationResult,
  ConcentrationValues,
  LiquidityPosition,
  LiquidityResult,
  MarketImpactInput,
  MarketImpactResult,
  MarginResult,
  NakedMarginInput,
  NakedMarginOptions,
  NakedMarginResult,
  OptionMarginLeg,
  OptionsMarginOptions,
  OptionsMarginResult,
  PortfolioGreeks,
  BetaWeightedPosition,
  BetaWeightedDeltaResult,
} from './portfolio.js';

export {
  minVariance,
  maxSharpe,
  meanVariance,
  riskParity,
  hrp,
  kelly,
  blackLitterman,
  conditionalValueAtRiskOptimize,
} from './optimize.js';
export type {
  OptimizeConstraints,
  OptimizeResult,
  MaxSharpeOptions,
  MeanVarianceOptions,
  KellyOptions,
  GroupConstraint,
  TurnoverConstraint,
  BlackLittermanView,
  BlackLittermanOptions,
  BlackLittermanResult,
  CVaROptimizeOptions,
  CVaROptimizeResult,
} from './optimize.js';
// Risk-side portfolio construction (FC7 slice 4): explicit-method expected returns and the
// constrained efficient frontier composed over the optimizers above.
export { estimateExpectedReturns } from './expected-returns.js';
export type {
  EstimateExpectedReturnsInput,
  ExpectedReturnsMethod,
  HistoricalMeanExpectedReturnsInput,
  ExponentiallyWeightedExpectedReturnsInput,
  CapitalAssetPricingExpectedReturnsInput,
  SuppliedExpectedReturnsInput,
  ExpectedReturnsValue,
  ExpectedReturnsResult,
} from './expected-returns.js';
export { efficientFrontier } from './frontier.js';
export type {
  EfficientFrontierGrid,
  EfficientFrontierGridKind,
  EfficientFrontierInput,
  EfficientFrontierResult,
  EfficientFrontierValue,
  FrontierPoint,
  FrontierPortfolio,
} from './frontier.js';

// Research hygiene (spec §15.5): probabilistic/deflated Sharpe, multiple-testing correction,
// walk-forward & purged/embargoed CV, sweep diagnostics, leakage & survivorship warnings.
export {
  sharpeStatistics,
  probabilisticSharpeRatio,
  deflatedSharpeRatio,
  adjustPValues,
  walkForwardSplits,
  purgedKFold,
  parameterSweepDiagnostics,
  checkLeakage,
  survivorshipWarning,
  probabilityOfBacktestOverfitting,
} from './research.js';
export type {
  SharpeStatistics,
  SharpeStatisticsReport,
  ProbabilisticSharpeResult,
  DeflatedSharpeResult,
  LeakageIssue,
  LeakageReport,
  MultipleTestMethod,
  MultipleTestOptions,
  MultipleTestResult,
  Split,
  WalkForwardOptions,
  PurgedKFoldOptions,
  ParameterSweepResult,
  SurvivorshipContext,
  BacktestOverfittingProbabilityOptions,
  BacktestOverfittingProbabilityResult,
} from './research.js';
// Research-protocol pack (Tier 3, agent-native): hypothesis → deflated Sharpe → OOS → honest verdict.
export { researchProtocol } from './research-protocol.js';
export type { ResearchProtocolInput, ResearchVerdict } from './research-protocol.js';
// Kelly bet-sizing pack (Tier 2, Sizing): edge → growth-optimal fraction, sized sanely (fractional,
// drawdown-capped, multi-period growth). Distinct from the portfolio `kelly()` in optimize.ts.
export { kellyBet, shrunkKelly, costAwareKelly } from './kelly.js';
export type {
  KellyBetInput,
  KellySizing,
  BinaryEdge,
  EdgeOutcome,
  ShrunkKellyInput,
  ShrunkKelly,
  CostAwareKellyInput,
  CostAwareKelly,
} from './kelly.js';
// EVT tail-risk pack (Tier 2, Tail machinery): GPD peaks-over-threshold fit + extreme VaR/ES vs
// empirical/normal, drawdown-at-risk (CDaR), and a coherent spectral risk measure.
export {
  fitGeneralizedParetoTail,
  extremeValueTailRisk,
  drawdownAtRisk,
  spectralRisk,
  meanExcessPlot,
} from './evt.js';
export type {
  GeneralizedParetoFit,
  GeneralizedParetoFitOptions,
  ExtremeValueTailRisk,
  DrawdownAtRisk,
  SpectralRisk,
  MeanExcessPlotOptions,
  MeanExcessPoint,
  MeanExcessPlot,
} from './evt.js';

// The nested `performance` namespace re-export was DELETED (P3.3, one namespace level):
// import performance metrics from '@totalfinance/performance' or the umbrella's `performance`.
