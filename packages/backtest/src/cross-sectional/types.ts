/**
 * `crossSectionalBacktest` (Stage 4.6, FC8 Decision 4) — the request and result grammar.
 *
 * The declarative one-line path: a returns dataset, a universe history, one signal (a research
 * recipe, a score, a screen, or a direct callback), a rebalance schedule, and a portfolio
 * construction. Every decision at a rebalance session is a call into `@totalfinance/research`; every
 * quantity is `@totalfinance/portfolio`'s `allocatePortfolio`; every fill is a `NormalizedFill` folded
 * by the FC7 reducer; every performance number is `@totalfinance/performance`. The engine owns the
 * loop and nothing else.
 */

import type { Diagnostics, EpochMs } from '@totalfinance/core';
import type { PerformanceSummary } from '@totalfinance/performance';
import type {
  InstrumentClassification,
  NormalizedFill,
  PortfolioLedgerSnapshot,
  PortfolioTimelineResult,
} from '@totalfinance/portfolio';
import type {
  FactorRecipe,
  FieldDefinition,
  MissingValuePolicy,
  ReturnObservation,
  ScoreComponent,
  ScreenFilter,
  ScreenOrdering,
  UniverseHistory,
  UniverseObservation,
} from '@totalfinance/research';
import type { CostModel, SlippageModel } from '../costs.js';
import type { ExecutionPolicy, ExecutionPolicyDescription } from '../execution/types.js';
import type { EquityPoint, Trade } from '../types.js';

// ---------------------------------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------------------------------

/** The point-in-time inputs a cross-sectional strategy reads. Prices are return-index levels. */
export interface CrossSectionalDataset {
  /** Features with `availableTimestampMs` — what a decision may see is decided by availability. */
  observations: readonly UniverseObservation[];
  /** Declared fields; nothing is inferred from the data. */
  fieldDefinitions: readonly FieldDefinition[];
  /** Per-instrument per-session simple returns; their session dates are the run's calendar. */
  returns: readonly ReturnObservation[];
  /** A benchmark's per-session simple returns (one `instrumentId`, e.g. an index proxy). */
  benchmarkReturns?: readonly ReturnObservation[];
  /** Grouping for sector-neutral targets and the recipe's sector neutralization. */
  groups?: Readonly<Record<string, string>>;
  /** The observation field that carries size (log market capitalization) for `sector-and-size`. */
  sizeField?: string;
  /** Grouping for the ledger's exposure reports (asset class, strategy, tags). */
  classification?: Readonly<Record<string, InstrumentClassification>>;
  /** Average daily volume in return-index units, for the participation constraint. */
  averageDailyVolumes?: Readonly<Record<string, number>>;
  /** Per-instrument betas for beta-neutral targets. */
  betas?: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------------------------------

/** One scored name a signal produced at a decision instant; higher is better. */
export interface SignalRow {
  instrumentId: string;
  score: number;
}

/** What a direct callback signal sees at a decision instant. */
export interface SignalContext {
  asOf: EpochMs;
  sessionDate: string;
  /** Eligible observations at the instant (availability, version, membership all applied). */
  eligible: readonly UniverseObservation[];
  fieldDefinitions: readonly FieldDefinition[];
  /** Members of the universe at the instant. */
  members: readonly string[];
  /** The names held going into this rebalance. */
  held: readonly string[];
}

export type CrossSectionalSignal =
  | { factorRecipe: FactorRecipe }
  | {
      score: {
        components: readonly ScoreComponent[];
        missingValuePolicy: 'exclude' | 'renormalize-weights';
      };
    }
  | {
      screen: {
        filter?: ScreenFilter;
        orderBy: readonly ScreenOrdering[];
        missingValuePolicy: MissingValuePolicy;
      };
    }
  | { callback: (context: SignalContext) => readonly SignalRow[] };

// ---------------------------------------------------------------------------------------------------
// Schedule and construction
// ---------------------------------------------------------------------------------------------------

export type RebalanceFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export interface RebalanceSchedule {
  frequency: RebalanceFrequency;
  /** Which session instant decides and fills: the open or the close of the rebalance session. */
  session: 'open' | 'close';
  /**
   * Hysteresis: a held name stays selected while its rank is within `(1 + bufferBand)` of the
   * selection threshold, so a name oscillating at the edge does not churn.
   */
  bufferBand?: number;
}

export type SideSelection = { topQuantile: number } | { count: number } | { fraction: number };
export type ShortSideSelection =
  | { bottomQuantile: number }
  | { count: number }
  | { fraction: number };
export type WeightingMethod =
  | 'equal-weight'
  | 'score-weight'
  | 'inverse-volatility'
  | 'risk-budget'
  | 'supplied-weights';
export type Neutrality = 'none' | 'dollar' | 'sector' | 'beta' | 'factor';

/** What a supplied-weights callback sees. */
export interface WeightContext {
  asOf: EpochMs;
  sessionDate: string;
  long: readonly SignalRow[];
  short: readonly SignalRow[];
  /** Trailing per-session returns per selected name, oldest first (as many as available). */
  trailingReturns: Readonly<Record<string, readonly number[]>>;
}

export interface PortfolioConstruction {
  method: WeightingMethod;
  long: SideSelection;
  short?: ShortSideSelection;
  neutrality?: Neutrality;
  /** For `neutrality: 'factor'`: the observation field whose exposure the weights are residualized against. */
  neutralizeAgainst?: { field: string };
  maximumPositions?: number;
  maximumPositionWeight?: number;
  minimumPositionWeight?: number;
  /** Fraction of net asset value traded per rebalance; a trim is reported, never silent. */
  maximumTurnover?: number;
  /** Fraction of a name's average daily volume one rebalance may trade. */
  maximumParticipation?: number;
  /** Sessions of trailing returns for `inverse-volatility` / `risk-budget` (default 63). */
  volatilityLookbackSessions?: number;
  /** For `risk-budget`: budgets per instrument (missing names share the remainder equally). */
  riskBudgets?: Readonly<Record<string, number>>;
  /** For `supplied-weights`: the caller's weights (fractions of net asset value, signed). */
  suppliedWeights?: (context: WeightContext) => Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------------

export interface CrossSectionalBacktestRequest {
  dataset: CrossSectionalDataset;
  universeHistory: UniverseHistory;
  signal: CrossSectionalSignal;
  rebalanceSchedule: RebalanceSchedule;
  portfolioConstruction: PortfolioConstruction;
  /** Decision 7's policy; omitted = `execution.simplified()`, and the result says so. */
  execution?: ExecutionPolicy;
  /** Cost models applied to every fill; omitted = the policy's (none for the simplified policy). */
  transactionCostModel?: { commission?: CostModel; slippage?: SlippageModel };
  /** Default 1,000,000 in `baseCurrency`. */
  initialCapital?: number;
  /** Default `'USD'`. */
  baseCurrency?: string;
  /** Restrict the run to sessions inside the window (inclusive instants). */
  window?: { fromTimestampMs?: EpochMs; toTimestampMs?: EpochMs };
  /** Default 252. */
  periodsPerYear?: number;
  riskFreeRate?: number;
  /** Seeds the bootstrap confidence intervals of the performance block; absent = none. */
  seed?: number;
}

// ---------------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------------

export type HoldingReason =
  | 'selected'
  | 'retained-in-buffer'
  | 'exited'
  | 'deselected'
  | 'delisted'
  | 'removed';

export interface HoldingRow {
  rebalanceIndex: number;
  instrumentId: string;
  side: 'long' | 'short';
  weight: number;
  quantity: number;
  score: number | null;
  rank: number | null;
  reason: HoldingReason;
}

export interface RebalanceGoal {
  goal: string;
  status: 'satisfied' | 'capped' | 'violated';
  detail: string;
}

export interface RebalanceRow {
  rebalanceIndex: number;
  sessionDate: string;
  asOf: EpochMs;
  memberCount: number;
  eligibleCount: number;
  scoredCount: number;
  longCount: number;
  shortCount: number;
  /** Fraction of net asset value traded (the allocator's turnover). */
  turnover: number;
  /** Costs charged at this rebalance, in base currency. */
  costs: number;
  netAssetValue: number;
  goals: RebalanceGoal[];
  exits: Array<{
    instrumentId: string;
    reason: 'delisted' | 'removed' | 'deselected';
    exitPrice: number;
  }>;
}

export interface AttributionRow {
  rebalanceIndex: number;
  sessionDate: string;
  /** Pearson IC of the signal against the next-period return; null when unmeasurable. */
  informationCoefficient: number | null;
  rankInformationCoefficient: number | null;
  /** Long-leg minus short-leg mean next-period return of the signal's quantiles. */
  spreadReturn: number | null;
  /** Fraction of this rebalance's selection not present in the previous one. */
  selectionTurnover: number | null;
  breadth: number;
  coverage: number;
}

export interface CrossSectionalAttribution {
  perRebalance: AttributionRow[];
  /** Mean rank information coefficient per horizon (in rebalances), across rebalances. */
  decay: Array<{
    horizonRebalances: number;
    meanRankInformationCoefficient: number | null;
    samples: number;
  }>;
  meanInformationCoefficient: number | null;
  meanRankInformationCoefficient: number | null;
  meanSpreadReturn: number | null;
}

export interface BenchmarkComparison {
  instrumentId: string;
  /** The benchmark's per-session simple returns aligned to the run's sessions. */
  returns: number[];
  activeReturn: number | null;
  trackingError: number | null;
  informationRatio: number | null;
  beta: number | null;
  alpha: number | null;
}

export interface CrossSectionalAssumptions {
  conventionsVersion: string;
  universeId: string;
  signal:
    | {
        kind: 'factor-recipe';
        recipeName: string;
        recipeVersion: number;
        direction: string;
        lagTradingSessions: number;
        neutralization: string;
      }
    | { kind: 'score'; components: number; missingValuePolicy: string }
    | { kind: 'screen'; orderBy: string[]; missingValuePolicy: string }
    | { kind: 'callback'; replayable: false };
  rebalanceSchedule: {
    frequency: RebalanceFrequency;
    session: 'open' | 'close';
    bufferBand: number | null;
  };
  sessionInstantConvention: string;
  pricing: string;
  portfolioConstruction: {
    method: WeightingMethod;
    long: SideSelection;
    short: ShortSideSelection | null;
    neutrality: Neutrality;
    maximumPositions: number | null;
    maximumPositionWeight: number | null;
    minimumPositionWeight: number | null;
    maximumTurnover: number | null;
    maximumParticipation: number | null;
    volatilityLookbackSessions: number;
    shortBookSizing: string;
  };
  execution: ExecutionPolicyDescription;
  costs: { commission: string; slippage: string };
  initialCapital: number;
  baseCurrency: string;
  periodsPerYear: number;
  riskFreeRate: number;
  seed: number | null;
  window: { fromTimestampMs: EpochMs | null; toTimestampMs: EpochMs | null };
  ledger: { sourceId: string; accountId: string; lotRelief: string };
  replayable: boolean;
}

export interface CrossSectionalDiagnostics extends Diagnostics {
  sessionCount: number;
  rebalanceCount: number;
  fillCount: number;
  rejectedFillCount: number;
  exitCount: number;
  delistingCount: number;
  cappedGoalCount: number;
  violatedGoalCount: number;
  /** The ledger's final base-currency NAV minus the reported `finalValue` — always 0 within 1e-9. */
  reconciliationResidual: number;
}

export interface CrossSectionalBacktestResult {
  rebalances: RebalanceRow[];
  holdings: HoldingRow[];
  points: EquityPoint[];
  returns: number[];
  trades: Trade[];
  fills: NormalizedFill[];
  ledger: PortfolioLedgerSnapshot;
  timeline: PortfolioTimelineResult;
  attribution: CrossSectionalAttribution;
  benchmark: BenchmarkComparison | null;
  performance: PerformanceSummary;
  /** Bootstrap confidence intervals of the performance block when a seed was given. */
  performanceConfidence: {
    iterations: number;
    seed: number;
    meanTotalReturn: number;
    standardDeviation: number;
    confidenceInterval95: [number, number];
  } | null;
  finalValue: number;
  runId: string;
  assumptions: CrossSectionalAssumptions;
  diagnostics: CrossSectionalDiagnostics;
}
