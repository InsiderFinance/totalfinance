/**
 * `@totalfinance/backtest/environment` — the trading-agent environment's grammar (Stage 7B.1, AT4).
 * An environment is `portfolioBacktest`'s loop driven from outside: the same accounting, execution
 * policy, lifecycle, marks, and margin, with the orders decided by a policy or an agent on the
 * previous instant's observation.
 */
import type { Diagnostics, EpochMs, QuantWarning } from '@totalfinance/core';
import type { ErrorCode } from '@totalfinance/core';
import type { NormalizedFill, PolicyLimits, PortfolioEventEnvelope } from '@totalfinance/portfolio';
import type { OrderType, TimeInForce, OrderSide } from '../execution/types.js';
import type {
  InstrumentSpecification,
  LatestObservations,
  LiquidationRow,
  PortfolioBacktestResult,
  PortfolioStepperRequest,
  SessionPosition,
} from '../portfolio/types.js';

/** What an environment simulates: the stepper's request plus the episode bound, the limits, the reward, the features. */
export interface TradingEnvironmentDefinition extends PortfolioStepperRequest {
  /** The most steps an episode takes before `truncated` (default: the instant count; ceiling 100,000). */
  maximumSteps?: number;
  limits?: EnvironmentLimits;
  reward?: RewardComposition;
  features?: FeatureRecipes;
}

/** FC7's `PolicyLimits` verbatim plus three environment-only members (Decision 5). */
export interface EnvironmentLimits extends PolicyLimits {
  /** Default false: a sell that leaves an option position net short (and, for a call, uncovered) is disallowed. */
  allowUndefinedRiskOptions?: boolean;
  /** Base currency, per instrument: the largest absolute position value an order may project. */
  maximumPositionNotional?: number;
  /** What a post-trade breach does: end the episode (default) or record it and continue. */
  onBreach?: 'terminate' | 'reject-and-continue';
}

/** The declared reward composition — weights on the components below; absent components are reported with weight 0. */
export interface RewardComposition {
  /** On the step's net return, Δ NAV ÷ NAV before the step. */
  pnl?: number;
  /** On the INCREASE in drawdown from the episode's running peak (a recovery pays 0). */
  drawdown?: number;
  /** On traded notional ÷ NAV before the step. */
  turnover?: number;
  /** On commissions, fees, and slippage ÷ NAV before the step. */
  cost?: number;
  /** On the largest absolute position weight after the step. */
  concentration?: number;
  /** On gross exposure ÷ NAV after the step. */
  leverage?: number;
  /** On the count of limit breaches and disallowed orders in the step. */
  riskViolation?: number;
  /** On the step return minus the named instrument's bar return over the step. */
  benchmark?: { weight: number; instrumentId: string };
  /** Extra named terms (weight 1 each); a callback, so the definition is not replayable. */
  goal?: (frame: RewardFrame) => Record<string, number>;
}

/** What one step did, as the reward reads it — from the engine's frame, never from the ledger. */
export interface RewardFrame {
  step: number;
  asOf: EpochMs;
  netAssetValueBefore: number;
  netAssetValueAfter: number;
  /** Δ NAV ÷ NAV before the step (0 when the NAV before was not positive). */
  stepReturn: number;
  /** 1 − NAV ÷ running peak, before and after the step. */
  drawdownBefore: number;
  drawdownAfter: number;
  /** Σ |quantity × price × multiplier| of the step's fills, base currency. */
  tradedNotional: number;
  /** Σ commission + fees + slippage adjustment of the step's fills, base currency. */
  costs: number;
  grossExposure: number;
  largestPositionWeight: number;
  /** Limit breaches plus disallowed orders in the step. */
  violations: number;
  /** The benchmark instrument's bar-close return over the step, or null without two closes. */
  benchmarkReturn: number | null;
  fills: readonly NormalizedFill[];
  positions: readonly SessionPosition[];
}

export interface RewardComponent {
  value: number;
  weight: number;
  contribution: number;
}

/** Every component separately, plus the weighted total. */
export interface RewardBreakdown {
  total: number;
  components: Readonly<Record<string, RewardComponent>>;
}

/** Feature recipes evaluated over the bar closes at or before the instant only. */
export interface FeatureRecipes {
  /** Close-to-close returns over each lookback in bars. */
  lookbackReturns?: readonly number[];
  /**
   * Standard deviation of log returns over each lookback in bars, scaled by √annualization —
   * the bars per year (252 daily, 52 weekly, 12 monthly) or `1` for the per-bar σ. Required: the
   * environment never assumes the bar frequency.
   */
  realizedVolatility?: { lookbacks: readonly number[]; annualization: number };
  /** 1 − close ÷ running peak close, per instrument. */
  drawdown?: boolean;
}

/** The evaluated features, keyed by lookback then instrument; null where the prefix is too short. */
export interface EnvironmentFeatures {
  lookbackReturns: Readonly<Record<string, Readonly<Record<string, number | null>>>>;
  realizedVolatility: Readonly<Record<string, Readonly<Record<string, number | null>>>>;
  drawdown: Readonly<Record<string, number | null>>;
}

export interface InstrumentFreshness {
  /** The latest observation of the kind the execution policy fills on (the chain quote for an option). */
  latestTimestampMs: EpochMs | null;
  ageMs: number | null;
  /** Older than the execution policy's `staleQuotes.maximumAgeMs`. */
  stale: boolean;
  /** Every observation kind present at the instant. */
  kinds: string[];
}

export type MaskReason =
  | 'no-observation'
  | 'halted'
  | 'stale-quote'
  | 'position-limit'
  | 'notional-limit'
  | 'leverage-limit'
  | 'undefined-risk'
  | 'insufficient-buying-power'
  | 'episode-over';

/** Whether a buy or a sell of the instrument is allowed at the observation, and why not (Decision 6). */
export interface ActionMaskEntry {
  instrumentId: string;
  buy: boolean;
  sell: boolean;
  reasons: { buy: MaskReason[]; sell: MaskReason[] };
}

export type ActionMask = Readonly<Record<string, ActionMaskEntry>>;

export interface LimitUtilization {
  /** The limit's name in `EnvironmentLimits`. */
  limit: string;
  subject: string;
  value: number | null;
  bound: number;
  /** value ÷ bound for an upper bound; bound ÷ value for a floor; null when the value is unknown. */
  fraction: number | null;
}

/** A breach the FC7 monitor raised at the instant (`monitorPortfolio`, state raised or active). */
export interface LimitBreach {
  family: string;
  subject: string;
  value: number | null;
  threshold: number | null;
  message: string;
}

export interface EnvironmentLimitsView {
  utilization: LimitUtilization[];
  breaches: LimitBreach[];
}

/** One order an action submits — the execution grammar without the fields the environment stamps. */
export interface EnvironmentOrder {
  /** Assigned `${runId}:a${n}` when absent; a repeated id is an idempotent retry, never a second order. */
  orderId?: string;
  instrumentId: string;
  side: OrderSide;
  quantity: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  /** Default: the execution policy's. `day` expires with the session; `gtc` stays open until cancelled. */
  timeInForce?: TimeInForce;
}

/** Hold, or submit orders and cancel open ones. `rationale` is recorded, never read. */
export type EnvironmentAction =
  | { kind: 'hold'; rationale?: string }
  | {
      kind: 'orders';
      orders: readonly EnvironmentOrder[];
      cancel?: readonly string[];
      rationale?: string;
    };

/** Why an order is still open: submitted this step, or the market reason it did not fill. */
export type OpenOrderReason =
  | 'submitted'
  | 'partial'
  | 'not-triggered'
  | 'no-observation'
  | 'stale-quote'
  | 'halted'
  | 'locked-crossed'
  | 'insufficient-depth';

/** An order accepted and not yet resolved — it meets the market at the next instant. */
export interface OpenOrder {
  orderId: string;
  instrumentId: string;
  side: OrderSide;
  /** The quantity still to fill. */
  quantity: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: TimeInForce;
  submittedStep: number;
  submittedTimestampMs: EpochMs;
  reason: OpenOrderReason;
  /** How many instants the order has met the market. */
  attempts: number;
}

/** The environment's own rejection codes — registered in `ErrorCode`, never thrown (the engine's `backtest.*` codes pass through unchanged). */
export type EnvironmentRejectionCode =
  | typeof ErrorCode.EnvironmentDuplicateOrder
  | typeof ErrorCode.EnvironmentLimitBreach
  | typeof ErrorCode.EnvironmentActionDisallowed
  | typeof ErrorCode.EnvironmentUnknownInstrument
  | typeof ErrorCode.EnvironmentOrderInvalid
  | typeof ErrorCode.EnvironmentActionInvalid
  | typeof ErrorCode.EnvironmentEpisodeOver;

/** A typed rejection: never thrown, always a row with the step it happened at. */
export interface EnvironmentRejection {
  step: number;
  orderId: string | null;
  instrumentId: string | null;
  /** An `environment.*` code, or the engine's own (`backtest.unfilled.<reason>`, `backtest.data_missing`, …). */
  code: string;
  detail: string;
  source: 'environment' | 'engine';
}

/** The outcome of one action — what the previous step did, as the next observation reports it. */
export interface EnvironmentStepOutcome {
  step: number;
  action: EnvironmentAction;
  fills: NormalizedFill[];
  rejections: EnvironmentRejection[];
  liquidations: LiquidationRow[];
  events: PortfolioEventEnvelope[];
  warnings: QuantWarning[];
  reward: RewardBreakdown;
}

export interface EnvironmentProvenance {
  runId: string;
  /** The portfolio engine run this episode drives — the prefix of its event, fill, and source ids. */
  engineRunId: string;
  definitionHash: string;
  seed: number | null;
  executionPolicy: string;
  conventionsVersion: string;
  adapters: Array<{ instrumentId: string; kind: string; version: string }>;
}

export interface EnvironmentPortfolioView {
  netAssetValue: number;
  cash: readonly { currency: string; amount: number }[];
  positions: readonly SessionPosition[];
  /** Σ |position market value| in the base currency (positions without a mark are excluded). */
  grossExposure: number;
  /** Σ signed position market value in the base currency. */
  netExposure: number;
  /** NAV × the margin policy's buying-power multiplier − gross exposure. */
  buyingPower: number;
  openOrders: readonly OpenOrder[];
}

/** Only what was published at or before `asOf` — the no-leak law (Decision 4). */
export interface EnvironmentObservation {
  asOf: EpochMs;
  /** The instant's ordinal among the decision instants. */
  index: number;
  /** Steps since `reset`. */
  sequence: number;
  market: Readonly<Record<string, LatestObservations>>;
  instruments: Readonly<Record<string, InstrumentSpecification>>;
  portfolio: EnvironmentPortfolioView;
  limits: EnvironmentLimitsView;
  features: EnvironmentFeatures;
  freshness: Readonly<Record<string, InstrumentFreshness>>;
  actionMask: ActionMask;
  previous: EnvironmentStepOutcome | null;
  provenance: EnvironmentProvenance;
}

export interface EnvironmentIdentity {
  runId: string;
  step: number;
  /** Chains the previous trace hash with this step's canonical action; identical policies leave identical traces. */
  traceHash: string;
}

export interface EpisodeInformation {
  runId: string;
  engineRunId: string;
  definitionHash: string;
  seed: number | null;
  instantCount: number;
  maximumSteps: number;
  window: { fromTimestampMs: EpochMs | null; toTimestampMs: EpochMs | null };
}

export interface EnvironmentResetOptions {
  /** Overrides the definition's seed for this episode; part of the run identity. */
  seed?: number;
}

export interface EnvironmentResetResult {
  observation: EnvironmentObservation;
  episode: EpisodeInformation;
  identity: EnvironmentIdentity;
  /** An episode can be over at reset: a single instant, insolvency, or a limit breached at the start. */
  terminated: boolean;
  truncated: boolean;
  reason: EnvironmentStepResult['reason'];
}

export interface EnvironmentStepResult {
  observation: EnvironmentObservation;
  fills: NormalizedFill[];
  rejections: EnvironmentRejection[];
  liquidations: LiquidationRow[];
  events: PortfolioEventEnvelope[];
  warnings: QuantWarning[];
  reward: RewardBreakdown;
  /** An economic or policy terminal state was reached. */
  terminated: boolean;
  /** The data boundary or the step bound was reached. */
  truncated: boolean;
  /** Why the episode ended, when it did. */
  reason: 'insolvent' | 'limit-breach' | 'data-boundary' | 'maximum-steps' | null;
  identity: EnvironmentIdentity;
  diagnostics: {
    acceptedCount: number;
    rejectedCount: number;
    cancelledCount: number;
    /** Orders carried into the next instant because the market did not resolve them. */
    carriedCount: number;
    openOrderCount: number;
    rationaleTruncated: boolean;
  };
}

/** The familiar `reset` / `step` contract over the frozen simulator. */
export interface TradingEnvironment {
  /** The definition's identity, seed excluded. */
  readonly definitionHash: string;
  /** The decision instants an episode steps through. */
  readonly instantCount: number;
  reset(options?: EnvironmentResetOptions): EnvironmentResetResult;
  step(action: EnvironmentAction): EnvironmentStepResult;
  /** The engine's own result over the episode so far — the same shape `portfolioBacktest` returns; ends the episode. */
  finish(): PortfolioBacktestResult;
}

/** The catalogue's episode ids (Decision 8). */
export type EnvironmentEpisodeId =
  | 'trending'
  | 'mean-reverting'
  | 'range-bound'
  | 'volatility-expansion'
  | 'volatility-contraction'
  | 'overnight-gaps'
  | 'limit-moves'
  | 'stale-data'
  | 'missing-data'
  | 'duplicated-data'
  | 'corrected-data'
  | 'out-of-order-data'
  | 'wide-spreads'
  | 'thin-liquidity'
  | 'option-expiration'
  | 'margin-pressure'
  | 'retry-storm'
  | 'corporate-actions'
  | 'multi-currency'
  | 'model-market-disagreement';

/** One maintained scenario: a complete definition, its seed, and the expectations its suite asserts. */
export interface EnvironmentEpisode {
  id: EnvironmentEpisodeId;
  title: string;
  description: string;
  definition: TradingEnvironmentDefinition;
  seed: number;
  /** Decision instants the definition yields. */
  sessions: number;
  expectations: readonly string[];
}

/** A recorded episode: the definition, the seed, and the actions in order — the artifact spine's input. */
export interface EnvironmentEpisodeInput {
  definition: TradingEnvironmentDefinition;
  seed?: number;
  actions: readonly EnvironmentAction[];
}

export interface EnvironmentEpisodeStep {
  step: number;
  asOf: EpochMs;
  action: EnvironmentAction;
  traceHash: string;
  reward: RewardBreakdown;
  netAssetValue: number;
  fills: number;
  rejections: number;
  breaches: number;
}

export interface EnvironmentEpisodeResult {
  runId: string;
  engineRunId: string;
  definitionHash: string;
  seed: number | null;
  traceHash: string;
  steps: EnvironmentEpisodeStep[];
  rewards: number[];
  rewardTotal: number;
  terminated: boolean;
  truncated: boolean;
  reason: EnvironmentStepResult['reason'];
  /** The engine's own result over the episode — the same shape `portfolioBacktest` returns. */
  result: PortfolioBacktestResult;
  assumptions: {
    conventionsVersion: string;
    /** False with a `goal` callback or a custom adapter — the trace cannot re-issue behavior. */
    replayable: boolean;
    nextObservationLaw: string;
    executionPolicy: string;
    maximumSteps: number;
    instantCount: number;
  };
  diagnostics: Diagnostics & {
    stepCount: number;
    fillCount: number;
    rejectionCount: number;
    violationCount: number;
  };
}

/** A coded policy: the observation in, the action out. */
export type TradingPolicy = (observation: EnvironmentObservation) => EnvironmentAction;

/** A catalogue id, or a named declarative definition the bench runs like one. */
export type AgentBenchEpisode =
  | EnvironmentEpisodeId
  | { id: string; definition: TradingEnvironmentDefinition };

export interface AgentBenchInput {
  policy: { label: string; requires: FeatureRecipes | null; decide: TradingPolicy };
  /** Default: the whole catalogue. */
  episodes?: readonly AgentBenchEpisode[];
  /** Default: [42]. */
  seeds?: readonly number[];
  limits?: { maximumRuns?: number };
}

/** The absolute gates and the counts, per episode. */
export interface AgentBenchOperational {
  lookAhead: number;
  replayEquality: boolean;
  duplicateOrders: number;
  maskViolations: number;
  limitBreaches: number;
  externalOrderAttempts: 0;
  reconciled: boolean;
  passes: boolean;
}

export interface AgentBenchStrategy {
  totalReturn: number | null;
  annualizedVolatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number;
  turnover: number;
  cost: number;
  meanGrossExposure: number;
  violations: number;
  steps: number;
  finalValue: number;
  rewardTotal: number;
}

export interface AgentBenchEpisodeReport {
  id: string;
  seed: number;
  sessions: number;
  terminated: boolean;
  reason: EnvironmentStepResult['reason'];
  operational: AgentBenchOperational;
  strategy: AgentBenchStrategy;
}

/** The recorded episode behind one bench run — the artifact spine's input and its result. */
export interface AgentBenchTrace {
  id: string;
  seed: number;
  input: EnvironmentEpisodeInput;
  episode: EnvironmentEpisodeResult;
}

/** Operational conformance and strategy quality, reported separately — no single score by design. */
export interface AgentBenchReport {
  policy: string;
  episodes: AgentBenchEpisodeReport[];
  /** One recorded episode per run, in the order of `episodes`. */
  traces: AgentBenchTrace[];
  operational: {
    passes: boolean;
    failing: string[];
    lookAhead: number;
    duplicateOrders: number;
    maskViolations: number;
    limitBreaches: number;
    externalOrderAttempts: 0;
  };
  strategy: {
    meanTotalReturn: number | null;
    meanSharpe: number | null;
    meanMaxDrawdown: number | null;
    meanTurnover: number | null;
    meanCost: number | null;
    meanGrossExposure: number | null;
    violations: number;
  };
  assumptions: {
    episodes: string[];
    seeds: number[];
    runs: number;
    dimensions: string;
    leakageProbe: string;
    retrySuite: string;
  };
  diagnostics: Diagnostics;
}

/** One transport call as a harness recorded it. */
export interface AgentTranscriptCall {
  operation: string;
  arguments: unknown;
  ok: boolean;
  error?: { code: string; message?: string };
  result?: unknown;
  /** Bytes the call moved through the model's context, when the harness measured them. */
  bytes?: number;
}

export interface AgentTranscript {
  calls: AgentTranscriptCall[];
  answer: { text: string; citedArtifactIds?: string[]; refused?: boolean };
}

export interface AgentTranscriptExpectation {
  /** The operations the journey must call. */
  operations: string[];
  argumentPredicates?: Record<string, (args: unknown) => boolean>;
  /** The last successful result of `operation` must equal `direct` byte for byte (canonical JSON). */
  parity?: { operation: string; direct: unknown };
  mustRefuse?: boolean;
  artifactIds?: string[];
  budget?: { maximumCalls?: number; maximumBytes?: number };
}

export interface AgentTranscriptScore {
  operationSelection: number;
  firstAttemptValidity: number | null;
  recovery: number | null;
  argumentValidity: number | null;
  parity: boolean | null;
  refusal: boolean | null;
  traceability: number | null;
  calls: number;
  bytes: number;
  withinBudget: boolean | null;
  passes: boolean;
  assumptions: { deterministic: true; scoring: string };
  diagnostics: Diagnostics;
}
