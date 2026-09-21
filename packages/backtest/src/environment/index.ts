/**
 * `@totalfinance/backtest/environment` — the deterministic trading-agent environment (Stage 7B.1, AT4).
 * `createTradingEnvironment` drives `portfolioBacktest`'s own loop from outside with the familiar
 * `reset` / `step` contract: the next-observation law, real open orders with cancel/replace and
 * idempotent retry, typed rejections that never throw, and a chained trace identity.
 */

export { createTradingEnvironment } from './environment.js';
export {
  AGENT_BENCH_RUN_CEILING,
  agentBaselines,
  runAgentBench,
  scoreAgentTranscript,
} from './bench.js';
export type { BaselinePolicy } from './bench.js';
export { requireEnvironmentEpisodeInput, runEnvironmentEpisode } from './episode.js';
export {
  ENVIRONMENT_EPISODE_IDS,
  environmentEpisode,
  listEnvironmentEpisodes,
} from './episodes.js';
export {
  MAXIMUM_ENVIRONMENT_STEPS,
  RATIONALE_BYTE_LIMIT,
  requireEnvironmentAction,
  requireEnvironmentLimits,
  requireEnvironmentOrder,
  requireFeatureRecipes,
  requireRewardComposition,
  requireTradingEnvironmentDefinition,
} from './validate.js';
export type {
  ActionMask,
  AgentBenchEpisodeReport,
  AgentBenchInput,
  AgentBenchOperational,
  AgentBenchReport,
  AgentBenchStrategy,
  AgentTranscript,
  AgentTranscriptCall,
  AgentTranscriptExpectation,
  AgentTranscriptScore,
  ActionMaskEntry,
  EnvironmentAction,
  EnvironmentEpisode,
  EnvironmentEpisodeId,
  EnvironmentEpisodeInput,
  EnvironmentEpisodeResult,
  EnvironmentEpisodeStep,
  EnvironmentFeatures,
  EnvironmentIdentity,
  EnvironmentLimits,
  EnvironmentLimitsView,
  EnvironmentObservation,
  EnvironmentOrder,
  EnvironmentPortfolioView,
  EnvironmentProvenance,
  EnvironmentRejection,
  EnvironmentRejectionCode,
  EnvironmentResetOptions,
  EnvironmentResetResult,
  EnvironmentStepOutcome,
  EnvironmentStepResult,
  EpisodeInformation,
  FeatureRecipes,
  InstrumentFreshness,
  LimitBreach,
  LimitUtilization,
  MaskReason,
  OpenOrder,
  OpenOrderReason,
  RewardBreakdown,
  RewardComponent,
  RewardComposition,
  RewardFrame,
  TradingEnvironment,
  TradingEnvironmentDefinition,
  TradingPolicy,
} from './types.js';
