import type {
  DayCount,
  Diagnostics,
  EpochMs,
  InterestCompounding,
  QuantWarning,
  RateCurve,
  RateCurvePoint,
} from '@totalfinance/core';
import type {
  MarketSnapshot,
  ScenarioOverride,
  ScenarioSet,
  ScenarioShock,
} from '@totalfinance/core/artifacts';
import type {
  MarketRequirement,
  ObservationValueByKind,
  Pricer,
  PricerCapabilities,
  PricerValuationResult,
  DiscountCurveRequirement,
  DividendYieldRequirement,
  ForwardRequirement,
  ImpliedVolatilityRequirement,
  RiskFreeRateRequirement,
  SpotRequirement,
  ValuationInstantRequirement,
} from '@totalfinance/core/pricing';
import type { CurrencyPairQuote } from '@totalfinance/foreign-exchange';
import type { PortfolioState } from '@totalfinance/portfolio';
import type { TaylorPnlResult } from '@totalfinance/risk';

/** Shared identity, scaling, and grouping fields for a scenario target. */
export interface ScenarioTargetBaseInput {
  id: string;
  quantity: number;
  contractMultiplier: number;
  currency: string;
  underlying?: string;
  strategy?: string;
  account?: string;
  book?: string;
  tags?: readonly string[];
}

/** Bind one concrete instrument to the pricer that understands it. */
export interface FullRevaluationScenarioTargetInput<TInstrument> extends ScenarioTargetBaseInput {
  instrument: TInstrument;
  instrumentDescriptor?: unknown;
  pricer: Pricer<NoInfer<TInstrument>, PricerValuationResult>;
}

/** One named Taylor factor and the level at which the supplied sensitivities were measured. */
export interface TaylorFactorLevel {
  readonly subject: string;
  readonly level: number;
}

/** Base valuation instant for time sensitivities. */
export interface TaylorValuationInstantLevel {
  readonly level: EpochMs;
}

/** Explicit base levels used by a Taylor approximation. */
export interface TaylorFactors {
  readonly spot?: TaylorFactorLevel;
  readonly volatility?: TaylorFactorLevel;
  readonly riskFreeRate?: TaylorFactorLevel;
  readonly dividend?: TaylorFactorLevel;
  readonly valuationInstant?: TaylorValuationInstantLevel;
}

/** Raw per-unit derivatives in the exact units consumed by `taylorPnl`. */
/**
 * Greeks for a Taylor target in TotalFinance's ONE unit system — the units `@totalfinance/options` reports
 * (theta per calendar day, vega per volatility point, rho and phi per 1%, second-order terms in the
 * options package's conventions). See `@totalfinance/risk`'s `PositionGreeks`; the Taylor engine converts
 * internally.
 */
export interface TaylorSensitivities {
  delta?: number;
  gamma?: number;
  vega?: number;
  theta?: number;
  rho?: number;
  vanna?: number;
  vomma?: number;
  charm?: number;
  veta?: number;
  vera?: number;
  deltaRate?: number;
  thetaRate?: number;
  rhoConvexity?: number;
  thetaConvexity?: number;
  /** φ = ∂V/∂q per 1% dividend yield (the options package's `phi`). */
  phi?: number;
}

/** Builder input for an explicit Greeks-Taylor approximation. */
export interface TaylorScenarioTargetInput extends ScenarioTargetBaseInput {
  baseValuePerUnit: number;
  greeks: TaylorSensitivities;
  factors: TaylorFactors;
}

/** Builder input for the common one-unit spot-asset target. */
export interface SpotScenarioTargetInput {
  id: string;
  symbol: string;
  quantity: number;
  currency: string;
  strategy?: string;
  account?: string;
  book?: string;
  tags?: readonly string[];
}

/** Serializable identity and capabilities of the behavior bound to a target. */
export interface ScenarioPricerDescriptor {
  readonly name: string;
  readonly version: string;
  readonly capabilities: Readonly<PricerCapabilities>;
}

/** Serializable fields common to every target-axis row. */
export interface ScenarioTargetDescriptorBase {
  readonly id: string;
  readonly quantity: number;
  readonly contractMultiplier: number;
  readonly currency: string;
  readonly underlying?: string;
  readonly strategy?: string;
  readonly account?: string;
  readonly book?: string;
  readonly tags: readonly string[];
  readonly targetDescriptorHash: string;
}

/** Serializable full-revaluation target descriptor; behavior is deliberately absent. */
export interface FullRevaluationScenarioTargetDescriptor extends ScenarioTargetDescriptorBase {
  readonly valuationMethod: 'full-revaluation';
  readonly instrumentDescriptor: unknown;
  readonly instrumentDescriptorHash: string;
  readonly pricer: ScenarioPricerDescriptor;
}

/** Serializable Taylor target descriptor. */
export interface TaylorScenarioTargetDescriptor extends ScenarioTargetDescriptorBase {
  readonly valuationMethod: 'taylor';
  readonly taylor: {
    readonly baseValuePerUnit: number;
    readonly sensitivities: Readonly<TaylorSensitivities>;
    readonly factors: TaylorFactors;
  };
  readonly taylorDescriptorHash: string;
}

/** Complete public target data, without the private instrument/pricer binding. */
export type ScenarioTargetDescriptor =
  | FullRevaluationScenarioTargetDescriptor
  | TaylorScenarioTargetDescriptor;

declare const scenarioTargetBrand: unique symbol;

/** Opaque, builder-produced scenario target. */
export type ScenarioTarget = ScenarioTargetDescriptor & {
  readonly [scenarioTargetBrand]: true;
};

/** The public three-builder target namespace. */
export interface ScenarioTargetBuilders {
  fullRevaluation<TInstrument>(
    input: FullRevaluationScenarioTargetInput<TInstrument>,
  ): ScenarioTarget;
  taylor(input: TaylorScenarioTargetInput): ScenarioTarget;
  spot(input: SpotScenarioTargetInput): ScenarioTarget;
}

/** Plain instrument consumed by the first-party spot pricer. */
export interface SpotAssetInstrument {
  readonly symbol: string;
}

/** Recursively readonly view of canonical scenario callback data. */
export type ScenarioReadonlyData<T> = T extends object
  ? { readonly [TKey in keyof T]: ScenarioReadonlyData<T[TKey]> }
  : T;

/** Readonly curve pillar supplied to or returned from a scenario callback. */
export interface ScenarioReadonlyRateCurvePoint {
  readonly date: RateCurvePoint['date'];
  readonly zeroRate: RateCurvePoint['zeroRate'];
}

/** Readonly callback view of core's existing plain-data `RateCurve`. */
export interface ScenarioReadonlyRateCurve {
  readonly currency: RateCurve['currency'];
  readonly asOf: RateCurve['asOf'];
  readonly dayCount: RateCurve['dayCount'];
  readonly compounding: ScenarioReadonlyData<RateCurve['compounding']>;
  readonly points: readonly ScenarioReadonlyRateCurvePoint[];
  readonly interpolation?: RateCurve['interpolation'];
}

/**
 * Named, tool-walkable readonly projection of core's existing `MarketObservation` union.
 *
 * The arm/value grammar remains owned by `@totalfinance/core/pricing`; this view references those
 * source types directly and changes only mutability at the callback boundary.
 */
export type ScenarioReadonlyMarketObservation =
  | {
      readonly requirement: Readonly<ValuationInstantRequirement>;
      readonly value: ObservationValueByKind['valuationInstant'];
    }
  | {
      readonly requirement: Readonly<SpotRequirement>;
      readonly value: ObservationValueByKind['spot'];
    }
  | {
      readonly requirement: Readonly<ForwardRequirement>;
      readonly value: ObservationValueByKind['forward'];
    }
  | {
      readonly requirement: Readonly<ImpliedVolatilityRequirement>;
      readonly value: ObservationValueByKind['impliedVolatility'];
    }
  | {
      readonly requirement: Readonly<RiskFreeRateRequirement>;
      readonly value: ObservationValueByKind['riskFreeRate'];
    }
  | {
      readonly requirement: Readonly<DividendYieldRequirement>;
      readonly value: ObservationValueByKind['dividendYield'];
    }
  | {
      readonly requirement: Readonly<DiscountCurveRequirement>;
      readonly value: ScenarioReadonlyRateCurve;
    };

/** Frozen, behavior-free input supplied to one market resolver call. */
export interface ScenarioMarketResolverInput {
  readonly requirement: ScenarioReadonlyData<MarketRequirement>;
  readonly market: ScenarioReadonlyData<MarketSnapshot>;
  readonly target: ScenarioReadonlyData<ScenarioTargetDescriptor>;
}

/** One synchronous, per-call market-requirement resolver. */
export interface ScenarioMarketResolver {
  name: string;
  version: string;
  resolve(
    this: undefined,
    input: ScenarioMarketResolverInput,
  ): ScenarioReadonlyMarketObservation | undefined;
}

/** Frozen, behavior-free input supplied to one custom-factor handler call. */
export interface ScenarioFactorHandlerInput {
  readonly instruction: ScenarioReadonlyData<ScenarioShock | ScenarioOverride>;
  readonly observations: readonly ScenarioReadonlyMarketObservation[];
  readonly target: ScenarioReadonlyData<ScenarioTargetDescriptor>;
}

/** One synchronous, per-call owner of a non-reserved scenario factor. */
export interface ScenarioFactorHandler {
  factor: string;
  name: string;
  version: string;
  apply(
    this: undefined,
    input: ScenarioFactorHandlerInput,
  ): readonly ScenarioReadonlyMarketObservation[] | undefined;
}

/** Closed execution options for `runScenarios`. */
export interface RunScenariosOptions {
  failureMode?: 'fail-fast' | 'collect';
  seed?: number;
  maximumValuationCells?: number;
  maximumWorkUnits?: number;
  marketResolvers?: readonly ScenarioMarketResolver[];
  factorHandlers?: readonly ScenarioFactorHandler[];
}

/** One complete shared-scenario request. */
export interface RunScenariosInput {
  scenarioSet: ScenarioSet;
  market: MarketSnapshot;
  targets: readonly ScenarioTarget[];
  reportingCurrency?: string;
  currencyConversions?: readonly CurrencyPairQuote[];
  options?: RunScenariosOptions;
}

/** Stable scenario-axis metadata. */
export interface ScenarioAxisRow {
  readonly scenarioIndex: number;
  readonly name: string;
  readonly scenarioHash: string;
  readonly overrideCount: number;
  readonly shockCount: number;
}

/** Stable target-axis metadata. */
export type ScenarioTargetAxisRow = ScenarioTargetDescriptor & {
  readonly targetIndex: number;
};

/** Serializable name/version identity for a callback used by the run. */
export interface ScenarioBehaviorIdentity {
  readonly name: string;
  readonly version: string;
}

/** Exact currency quote and orientation used for one conversion. */
export interface ScenarioCurrencyConversionUse {
  readonly sourceQuoteIndex: number;
  readonly orientation: 'direct' | 'inverted';
  readonly quote: Readonly<CurrencyPairQuote>;
}

/** Shared coordinates recorded for every applied instruction. */
export interface ScenarioAppliedInstructionBase {
  readonly phase: 'override' | 'shock';
  readonly instructionIndex: number;
  readonly factor: string;
  readonly target?: string;
  readonly subject: string;
}

/** Scalar or foreign-exchange instruction detail. */
export interface ScenarioAppliedScalarInstruction extends ScenarioAppliedInstructionBase {
  readonly detail: 'scalar' | 'foreign-exchange-rate';
  readonly before: number;
  readonly after: number;
}

/** Compact discount-curve instruction detail. */
export interface ScenarioAppliedCurveInstruction extends ScenarioAppliedInstructionBase {
  readonly detail: 'discount-curve';
  readonly pillarCount: number;
  readonly beforeCurveHash: string;
  readonly afterCurveHash: string;
}

/** Compact custom-handler instruction detail. */
export interface ScenarioAppliedCustomInstruction extends ScenarioAppliedInstructionBase {
  readonly detail: 'custom';
  readonly handler: ScenarioBehaviorIdentity;
  readonly beforeObservationsHash: string;
  readonly afterObservationsHash: string;
}

/** Lossless identity of an instruction applied to one target cell. */
export type ScenarioAppliedInstruction =
  | ScenarioAppliedScalarInstruction
  | ScenarioAppliedCurveInstruction
  | ScenarioAppliedCustomInstruction;

/** Detached Gate-C pricing result retained without discarding domain-specific fields. */
export type ScenarioPricingResult = Readonly<Record<string, unknown>> & {
  readonly value: number;
  readonly assumptions: Readonly<Record<string, unknown>>;
  readonly diagnostics: Readonly<Diagnostics> & {
    readonly warnings: readonly QuantWarning[];
  };
};

/** Valuation method used by one target. */
export type ScenarioValuationMethod = 'full-revaluation' | 'taylor';

/** Successful value fields common to base and scenario cells. */
export interface ScenarioSuccessfulValueFields {
  readonly targetIndex: number;
  readonly targetId: string;
  readonly quantity: number;
  readonly contractMultiplier: number;
  readonly valuationCurrency: string;
  readonly reportingCurrency: string;
  readonly valuePerUnit: number;
  readonly positionValue: number;
  readonly reportingPositionValue: number;
  readonly currencyConversion: ScenarioCurrencyConversionUse | null;
  readonly observationOrFactorSetHash: string;
  readonly appliedInstructions: readonly ScenarioAppliedInstruction[];
  readonly resolvers: readonly ScenarioBehaviorIdentity[];
  readonly factorHandlers: readonly ScenarioBehaviorIdentity[];
  readonly effectiveSeed: number | null;
}

/** Successful full-revaluation cell payload. */
export type ScenarioFullRevaluationValue = ScenarioSuccessfulValueFields & {
  readonly valuationMethod: 'full-revaluation';
  readonly pricer: ScenarioPricerDescriptor;
  readonly pricingResult: ScenarioPricingResult;
};

/** Successful Taylor scenario cell payload. */
export type ScenarioTaylorValue = ScenarioSuccessfulValueFields & {
  readonly valuationMethod: 'taylor';
  readonly taylorResult: Readonly<TaylorPnlResult>;
};

/** Behavior-free execution failure safe to retain in an artifact. */
export interface ScenarioExecutionFailure {
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>> | null;
  readonly contextStatus: 'absent' | 'preserved' | 'omitted-unsafe';
  readonly targetIndex: number;
  readonly targetId: string;
  readonly scenarioIndex: number | null;
  readonly scenarioName: string | null;
  readonly valuationMethod: ScenarioValuationMethod;
}

/** Base valuation cell. */
export type ScenarioBaseCell =
  | (ScenarioFullRevaluationValue & {
      readonly kind: 'base';
      readonly status: 'complete';
    })
  | (ScenarioSuccessfulValueFields & {
      readonly kind: 'base';
      readonly status: 'complete';
      readonly valuationMethod: 'taylor';
      readonly baseValueSource: 'supplied-base-value-per-unit';
    })
  | {
      readonly kind: 'base';
      readonly status: 'failed';
      readonly targetIndex: number;
      readonly targetId: string;
      readonly valuationMethod: ScenarioValuationMethod;
      readonly valuePerUnit: null;
      readonly positionValue: null;
      readonly reportingPositionValue: null;
      readonly failure: ScenarioExecutionFailure;
    };

/** Scenario valuation cell. */
export type ScenarioCell =
  | ((ScenarioFullRevaluationValue | ScenarioTaylorValue) & {
      readonly kind: 'scenario';
      readonly status: 'complete';
      readonly scenarioIndex: number;
      readonly scenarioName: string;
      readonly localPnl: number;
      readonly reportingPnl: number;
    })
  | {
      readonly kind: 'scenario';
      readonly status: 'failed';
      readonly targetIndex: number;
      readonly targetId: string;
      readonly scenarioIndex: number;
      readonly scenarioName: string;
      readonly valuationMethod: ScenarioValuationMethod;
      readonly valuePerUnit: null;
      readonly positionValue: null;
      readonly reportingPositionValue: null;
      readonly localPnl: null;
      readonly reportingPnl: null;
      readonly failure: ScenarioExecutionFailure;
    }
  | {
      readonly kind: 'scenario';
      readonly status: 'blocked';
      readonly targetIndex: number;
      readonly targetId: string;
      readonly scenarioIndex: number;
      readonly scenarioName: string;
      readonly valuationMethod: ScenarioValuationMethod;
      readonly valuePerUnit: null;
      readonly positionValue: null;
      readonly reportingPositionValue: null;
      readonly localPnl: null;
      readonly reportingPnl: null;
      readonly blockedByBaseFailure: ScenarioExecutionFailure;
    };

/** One deterministic aggregate row. */
export interface ScenarioAggregateRow {
  readonly group: 'target' | 'underlying' | 'strategy' | 'account' | 'book' | 'tag' | 'grand-total';
  readonly key: string;
  readonly reportingCurrency: string;
  readonly status: 'complete' | 'incomplete';
  readonly baseValue: number | null;
  readonly scenarioValue: number | null;
  readonly pnl: number | null;
  readonly targetIds: readonly string[];
  readonly failedTargetIds: readonly string[];
  readonly reason?: string;
}

/** Aggregate rows for the base axis. */
export interface ScenarioBaseAggregateSet {
  readonly kind: 'base';
  readonly scenarioIndex: null;
  readonly scenarioName: null;
  readonly rows: readonly ScenarioAggregateRow[];
}

/** Aggregate rows for one scenario. */
export interface ScenarioOutcomeAggregateSet {
  readonly kind: 'scenario';
  readonly scenarioIndex: number;
  readonly scenarioName: string;
  readonly rows: readonly ScenarioAggregateRow[];
}

/** Canonical JSON-safe parameters needed to reproduce a run. */
export interface ScenarioReplayParameters {
  readonly reportingCurrency: string;
  readonly currencyConversions: readonly Readonly<CurrencyPairQuote>[];
  readonly failureMode: 'fail-fast' | 'collect';
  readonly seed: number | null;
  readonly maximumValuationCells: number;
  readonly maximumWorkUnits: number;
  readonly resolvers: readonly ScenarioBehaviorIdentity[];
  readonly factorHandlers: readonly ScenarioBehaviorIdentity[];
  readonly timeShockDayCount: 'ACT/365F';
  readonly millisecondsPerYear: 31_536_000_000;
  readonly resultLayout: 'scenario-major-v1';
}

/** Complete assumptions and execution laws applied by the runner. */
export interface ScenarioRunAssumptions {
  readonly conventionsVersion: string;
  readonly scenarioSetName: string;
  readonly scenarioSetHash: string;
  readonly marketSnapshotHash: string;
  readonly marketAsOf: EpochMs;
  readonly inputRateDayCount: DayCount | null;
  readonly inputRateCompounding: InterestCompounding | null;
  readonly resolvedScalarRateDayCount: 'ACT/365F';
  readonly resolvedScalarRateCompounding: 'continuous';
  readonly reportingCurrency: string;
  readonly currencyConversionPolicy: 'direct-or-inverse-only';
  readonly tagAggregationPolicy: 'overlapping-non-additive; grand total is target-based';
  readonly valuationUnitScaling: 'valuePerUnit * quantity * contractMultiplier';
  readonly timeShockDayCount: 'ACT/365F';
  readonly millisecondsPerYear: 31_536_000_000;
  readonly failureMode: 'fail-fast' | 'collect';
  readonly baseSeed: number | null;
  readonly seedDerivation: 'seed + targetIndex; common across base and scenarios' | null;
  readonly resolvers: readonly ScenarioBehaviorIdentity[];
  readonly factorHandlers: readonly ScenarioBehaviorIdentity[];
  readonly resultLayout: 'scenario-major-v1';
  readonly workBudgets: {
    readonly valuationCells: {
      readonly configured: number;
      readonly default: 10_000;
      readonly hardMaximum: 50_000;
    };
    readonly workUnits: {
      readonly configured: number;
      readonly default: 20_000_000;
      readonly hardMaximum: 100_000_000;
    };
  };
  readonly replayParameters: ScenarioReplayParameters;
}

/** Estimated and observed value for one execution metric. */
export interface ScenarioMetric {
  readonly estimated: number;
  readonly actual: number | null;
  readonly unavailableReason: string | null;
}

/** Bounded-work and execution counters for one run. */
export interface ScenarioRunMetrics {
  readonly valuationCells: ScenarioMetric;
  readonly pricerCalls: ScenarioMetric;
  readonly taylorCalls: ScenarioMetric;
  readonly supportsCalls: ScenarioMetric;
  readonly requirements: ScenarioMetric;
  readonly resolverCalls: ScenarioMetric;
  readonly factorHandlerCalls: ScenarioMetric;
  readonly inputDataWorkUnits: ScenarioMetric;
  readonly transformationWorkUnits: ScenarioMetric;
  readonly valuationResultWorkUnits: ScenarioMetric;
  readonly resultEnvelopeWorkUnits: ScenarioMetric;
  readonly failureSnapshotWorkUnits: ScenarioMetric;
  readonly totalWorkUnits: ScenarioMetric;
  readonly successfulCells: ScenarioMetric;
  readonly failedCells: ScenarioMetric;
  readonly blockedCells: ScenarioMetric;
}

/** Warnings, failures, unused inputs, and bounded-work evidence. */
export interface ScenarioRunDiagnostics {
  readonly warnings: readonly QuantWarning[];
  readonly failures: readonly ScenarioExecutionFailure[];
  readonly unusedCurrencyConversions: readonly Readonly<CurrencyPairQuote>[];
  readonly metrics: ScenarioRunMetrics;
}

/** Stable flat-grid indexing contract. */
export interface ScenarioResultLayout {
  readonly order: 'scenario-major-v1';
  readonly targetCount: number;
  readonly scenarioCount: number;
  readonly cellsPerScenario: number;
  readonly cellCount: number;
  readonly indexFormula: 'scenarioIndex * targetCount + targetIndex';
}

/** Complete shared scenario analysis result. */
export type ScenarioRunResult = Readonly<Record<string, unknown>> & {
  readonly layout: ScenarioResultLayout;
  readonly scenarioAxis: readonly ScenarioAxisRow[];
  readonly targetAxis: readonly ScenarioTargetAxisRow[];
  readonly base: readonly ScenarioBaseCell[];
  readonly cells: readonly ScenarioCell[];
  readonly aggregates: {
    readonly base: ScenarioBaseAggregateSet;
    readonly scenarios: readonly ScenarioOutcomeAggregateSet[];
  };
  readonly assumptions: ScenarioRunAssumptions;
  readonly diagnostics: ScenarioRunDiagnostics;
};

/** Identity and grouping supplied by a durable-portfolio binding. */
export interface ScenarioPortfolioBindingBaseInput {
  id: string;
  accountId: string;
  instrumentId: string;
  strategy?: string;
  book?: string;
  tags?: readonly string[];
}

/** Full-revaluation durable-portfolio binding. */
export interface FullRevaluationScenarioPortfolioBindingInput<
  TInstrument,
> extends ScenarioPortfolioBindingBaseInput {
  instrument: TInstrument;
  instrumentDescriptor?: unknown;
  pricer: Pricer<NoInfer<TInstrument>, PricerValuationResult>;
}

/** Taylor durable-portfolio binding. */
export interface TaylorScenarioPortfolioBindingInput extends ScenarioPortfolioBindingBaseInput {
  baseValuePerUnit: number;
  greeks: TaylorSensitivities;
  factors: TaylorFactors;
}

/** Serializable durable-portfolio binding identity. */
export interface ScenarioPortfolioBindingDescriptorBase {
  readonly id: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly strategy?: string;
  readonly book?: string;
  readonly tags: readonly string[];
  readonly bindingDescriptorHash: string;
}

/** Serializable full-revaluation durable-portfolio binding descriptor. */
export interface FullRevaluationScenarioPortfolioBindingDescriptor extends ScenarioPortfolioBindingDescriptorBase {
  readonly valuationMethod: 'full-revaluation';
  readonly instrumentDescriptor: unknown;
  readonly instrumentDescriptorHash: string;
  readonly pricer: ScenarioPricerDescriptor;
}

/** Serializable Taylor durable-portfolio binding descriptor. */
export interface TaylorScenarioPortfolioBindingDescriptor extends ScenarioPortfolioBindingDescriptorBase {
  readonly valuationMethod: 'taylor';
  readonly taylor: {
    readonly baseValuePerUnit: number;
    readonly sensitivities: Readonly<TaylorSensitivities>;
    readonly factors: TaylorFactors;
  };
  readonly taylorDescriptorHash: string;
}

/** Complete public durable-portfolio binding data. */
export type ScenarioPortfolioBindingDescriptor =
  | FullRevaluationScenarioPortfolioBindingDescriptor
  | TaylorScenarioPortfolioBindingDescriptor;

declare const scenarioPortfolioBindingBrand: unique symbol;

/** Opaque, builder-produced durable-portfolio scenario binding. */
export type ScenarioPortfolioBinding = ScenarioPortfolioBindingDescriptor & {
  readonly [scenarioPortfolioBindingBrand]: true;
};

/** The public two-builder durable-portfolio binding namespace. */
export interface ScenarioPortfolioBindingBuilders {
  fullRevaluation<TInstrument>(
    input: FullRevaluationScenarioPortfolioBindingInput<TInstrument>,
  ): ScenarioPortfolioBinding;
  taylor(input: TaylorScenarioPortfolioBindingInput): ScenarioPortfolioBinding;
}

/** Convert one detached durable portfolio state into runner targets. */
export interface ScenarioTargetsFromPortfolioInput {
  state: PortfolioState;
  bindings: readonly ScenarioPortfolioBinding[];
}

/** Explicit behavior-only handoff used by artifact replay fixtures. */
export interface ScenarioReplayTargetBinding {
  readonly targetId: string;
  readonly target: ScenarioTarget;
}
