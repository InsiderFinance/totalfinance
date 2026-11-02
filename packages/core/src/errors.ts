/**
 * TotalFinance error model (spec §7.5).
 *
 * Every error carries a machine-readable, SemVer-stable `code` and optional structured `context`.
 * Codes are public API: tools, MCP clients, and user error handlers branch on them, so they change
 * only in major versions.
 */

import * as ValidationCode from './validation-codes.js';

export interface QuantErrorOptions {
  /** Stable, machine-readable code, e.g. `input.negative_spot`. */
  code: string;
  /** Structured context for programmatic handling and good error messages. */
  context?: Record<string, unknown>;
  /** Underlying cause, preserved on the standard `Error.cause` chain. */
  cause?: unknown;
}

/** Base class for every TotalFinance error. */
export class QuantError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(message: string, options: QuantErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    if (options.context !== undefined) this.context = options.context;
    // Preserve the prototype chain when compiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Versioned JSON shape. `message` is a non-enumerable Error property, so a bare
   * `JSON.stringify(error)` used to drop the one field a human needs; `serialization: 1` lets a
   * consumer detect future shape changes.
   */
  toJSON(): {
    serialization: 1;
    name: string;
    code: string;
    message: string;
    context?: Record<string, unknown>;
  } {
    return {
      serialization: 1,
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.context !== undefined ? { context: this.context } : {}),
    };
  }
}

/** Invalid or nonsensical input (programmer error or malformed payload). */
export class InputError extends QuantError {}

/** A numerical solver failed to converge. Never silently replaced with a guess (design law #4). */
export class ConvergenceError extends QuantError {}

/** Inputs violate a no-arbitrage condition (e.g. a price below intrinsic value). */
export class ArbitrageError extends QuantError {}

/** A data-quality problem (crossed/locked market, stale quote, bad print). */
export class DataError extends QuantError {}

/** A requested operation is not supported by the selected engine/model/contract. */
export class UnsupportedError extends QuantError {}

/** The library was configured in a contradictory or unusable way. */
export class ConfigurationError extends QuantError {}

/**
 * A LIBRARY defect surfaced loudly (Law 7 runtime postcondition): a successful facade/analysis
 * result was about to carry an undisclosed NaN/Infinity. This is never a user-input error — if
 * you see it, please report it with the inputs; the honest alternatives are `null`-with-reason
 * or a disclosed diagnostic, and the function failed to produce either.
 */
export class PostconditionError extends QuantError {}

/** Type guard: is this value a QuantError (and optionally a specific code)? */
export function isQuantError(value: unknown, code?: string): value is QuantError {
  return value instanceof QuantError && (code === undefined || value.code === code);
}

/**
 * Canonical error codes used in the 0.0.1 surface. The set is open — packages may introduce new
 * codes — but these are documented and stable.
 *
 * Literal readonly declarations preserve the public property order and exact code types. The pure
 * compact initializer below avoids retaining two spellings of every code in compute bundles;
 * guard-only consumers can still discard the catalog while retaining the error classes.
 */
type ErrorCodeRegistry = {
  readonly InputNaN: 'input.nan';
  readonly InputNotFinite: 'input.not_finite';
  readonly InputNegativeSpot: 'input.negative_spot';
  readonly InputNegativeStrike: 'input.negative_strike';
  readonly InputNegativeVolatility: 'input.negative_volatility';
  readonly InputNegativeTime: 'input.negative_time';
  readonly InputOutOfRange: 'input.out_of_range';
  readonly InputInvalidEnum: 'input.invalid_enum';
  readonly InputMissingField: 'input.missing_field';
  readonly InputUnknownField: 'input.unknown_field';
  readonly InputWrongType: 'input.wrong_type';
  /** The argument is an object but not the expected SHAPE (right type, wrong slots) — distinct from a
   * single missing field. Emitted by {@link wrongShapeError}. */
  readonly InputWrongShape: 'input.wrong_shape';
  readonly ImpliedVolatilityNoConvergence: 'implied_volatility.no_convergence';
  readonly ImpliedVolatilityBelowIntrinsic: 'implied_volatility.below_intrinsic';
  readonly ImpliedVolatilityAboveMax: 'implied_volatility.above_max_bound';
  readonly EngineUnsupportedContract: 'engine.unsupported_contract';
  // Reserved for the Phase-8 data-quality layer (crossed/stale quote rejection); kept intentionally.
  readonly DataCrossedMarket: 'data.crossed_market';
  readonly DataUnsupportedCapability: 'data.unsupported_capability';
  readonly DataContractVersionUnsupported: 'data.contract_version_unsupported';
  readonly DataAuthenticationRequired: 'data.authentication_required';
  readonly DataEntitlementRequired: 'data.entitlement_required';
  readonly DataRateLimited: 'data.rate_limited';
  readonly DataAllowanceExhausted: 'data.allowance_exhausted';
  readonly DataSnapshotExpired: 'data.snapshot_expired';
  readonly DataInvalidCursor: 'data.invalid_cursor';
  readonly DataNotFound: 'data.not_found';
  readonly DataInvalidRequest: 'data.invalid_request';
  readonly DataInvalidResponse: 'data.invalid_response';
  readonly DataUnavailable: 'data.unavailable';
  readonly DataAborted: 'data.aborted';
  readonly DataNonconformant: 'data.nonconformant';
  readonly DataStaleQuote: 'data.stale_quote';
  readonly SolverNoConvergence: 'solver.no_convergence';
  readonly LinalgNoConvergence: 'linalg.no_convergence';
  readonly LinalgNotPositiveDefinite: 'linalg.not_positive_definite';
  readonly LinalgSingular: 'linalg.singular';
  readonly IntegrationMaxDepth: 'integration.max_depth';
  readonly InterpolationOutOfDomain: 'interpolation.out_of_domain';
  readonly InterpolationDuplicateKnots: 'interpolation.duplicate_knots';
  readonly InterpolationInvalidGrid: 'interpolation.invalid_grid';
  readonly OptimizeInvalidBounds: 'optimize.invalid_bounds';
  readonly VolatilityExpiryNotFound: 'volatility.expiry_not_found';
  readonly VolatilityCalendarArbitrage: 'volatility.calendar_arbitrage';
  readonly StrategyInvalidChartRange: 'strategy.invalid_chart_range';
  /** A calendar/timezone resolution failed (unknown zone, unresolvable local time). Emitted by core's
   * time layer, which owns the registry — so it lives here, not as a raw inline literal. */
  readonly TimeTimezoneResolutionFailed: 'time.timezone_resolution_failed';
  /** A pricing path was given a date with no time of day; a valuation instant must name one. */
  readonly TimeValuationInstantRequired: 'time.valuation_instant_required';

  // ── Phase 3 registry consolidation (P3.1c) ──────────────────────────────────────────────────
  // Every leaf-package error code, registered centrally: the shrink-only legacy ratchet in
  // tools/codes-conformance.test.ts is now EMPTY and stays empty — an unregistered code anywhere
  // in the monorepo is a CI failure. Call-site classification: these appear only in typed-error
  // constructors. Semantics live at the emit sites; the registry guarantees greppable stability.
  readonly BacktestDuplicateHandler: 'backtest.duplicate_handler';
  readonly BacktestMixedSymbols: 'backtest.mixed_symbols';
  /** An open option leg has no usable current-snapshot mark (missing, ambiguous, stale, or
   * unpriceable contract quote) and the request's missing-mark policy is to refuse (Preview P1). */
  readonly BacktestMarkUnavailable: 'backtest.mark_unavailable';
  /** Stage 4.6 (FC8) — the `reject` intrabar ambiguity policy met a bar where two orders could
   * have touched in either sequence; the run refuses rather than pick a sequence silently. */
  readonly BacktestAmbiguousIntrabar: 'backtest.ambiguous_intrabar';
  /** Stage 4.6 (FC8) — a quote fill under `staleQuotes.behavior: 'reject'` met a quote older than the policy's maximum age. */
  readonly BacktestStaleQuote: 'backtest.stale_quote';
  /** Stage 4.6 (FC8) — a caller-supplied fill model or instrument adapter failed its conformance suite. */
  readonly BacktestAdapterNonconformant: 'backtest.adapter_nonconformant';
  /** Stage 4.6 (FC8) — a run's row count is above the ceiling one synchronous run may read. */
  readonly BacktestInputTooLarge: 'backtest.input_too_large';
  /** Stage 4.6 (FC8) — a 'delisted' universe exit with no delistingReturn while a position is open. */
  readonly BacktestDelistingReturnMissing: 'backtest.delisting_return_missing';
  /** Stage 4.6 (FC8) — a return or feature names an instrument the universe history never lists. */
  readonly BacktestUniverseMembershipUnknown: 'backtest.universe_membership_unknown';
  /** Stage 4.6 (FC8) — the emitted portfolio events do not fold to the equity the engine reports (an invariant). */
  readonly BacktestLedgerReconciliationFailed: 'backtest.ledger_reconciliation_failed';
  /** Stage 7B.1 (AT4) — step() or finish() on a trading environment before reset(). */
  readonly EnvironmentNotReset: 'environment.not_reset';
  /** Stage 7B.1 (AT4) — a rejection row, never thrown: an order id repeated inside an episode (an idempotent retry). */
  readonly EnvironmentDuplicateOrder: 'environment.duplicate_order';
  /** Stage 7B.1 (AT4) — a rejection row, never thrown: an order that would breach a declared limit. */
  readonly EnvironmentLimitBreach: 'environment.limit_breach';
  /** Stage 7B.1 (AT4) — a rejection row, never thrown: an order the action mask disallows. */
  readonly EnvironmentActionDisallowed: 'environment.action_disallowed';
  /** Stage 7B.1 (AT4) — a rejection row, never thrown: an order naming an instrument the environment does not hold. */
  readonly EnvironmentUnknownInstrument: 'environment.unknown_instrument';
  /** Stage 7B.1 (AT4) — a rejection row, never thrown: an order or cancellation of the wrong shape. */
  readonly EnvironmentOrderInvalid: 'environment.order_invalid';
  /** Stage 7B.1 (AT4) — a rejection row, never thrown: an action of the wrong shape; the step proceeds as hold. */
  readonly EnvironmentActionInvalid: 'environment.action_invalid';
  /** Stage 7B.1 (AT4) — a rejection row, never thrown: a step after the episode ended. */
  readonly EnvironmentEpisodeOver: 'environment.episode_over';
  /** Stage 7B.2 (AT5) — a trade intent or plan that cannot be normalized (a duplicate line, an unknown instrument). */
  readonly TradePlanInvalid: 'trade.plan_invalid';
  /** Stage 7B.2 (AT5) — preflight denied the plan; a grant cannot be minted over it. */
  readonly TradePreflightDenied: 'trade.preflight_denied';
  /** Stage 7B.2 (AT5) — an authorization grant that does not cover the execution asked of it (its reasons name the bindings). */
  readonly TradeGrantInvalid: 'trade.grant_invalid';
  /** Stage 7B.2 (AT5) — an authorization grant past its expiry. */
  readonly TradeGrantExpired: 'trade.grant_expired';
  /** Repairs B6 — the grant already licensed a submission; a grant is consumed by its first successful one. */
  readonly TradeGrantConsumed: 'trade.grant_consumed';
  /** Stage 7B.2 (AT5) — an idempotency key already used for a different plan. */
  readonly TradeIdempotencyConflict: 'trade.idempotency_conflict';
  /** Stage 7B.2 (AT5) — the kill switch is on: every submission refuses until resumed. */
  readonly TradeHalted: 'trade.halted';
  /** Stage 7B.2 (AT5) — live execution is not available in the open library; adapters ship under AT8. */
  readonly TradeLiveUnavailable: 'trade.live_unavailable';
  /** Stage 7B.2 (AT5) — an execution-journal event that the order's state cannot accept. */
  readonly TradeJournalTransitionInvalid: 'trade.journal_transition_invalid';
  /** Stage 7B.2 (AT5) — an operation whose required capabilities the caller did not grant. */
  readonly OperationCapabilityMissing: 'operation.capability_missing';
  readonly OperationToolFiltered: 'operation.tool_filtered';
  /** Stage 4.6 (FC8) — a grid's cartesian product is above the variations one synchronous sweep may run. */
  readonly BacktestGridTooLarge: 'backtest.grid_too_large';
  /** Stage 4.6 (FC8) — an options book above the open positions one synchronous book may hold. */
  readonly BacktestBookTooLarge: 'backtest.book_too_large';
  /** Stage 4.6 (FC8) — a merger or spin-off on an open option leg; the deliverable cannot be adjusted. */
  readonly BacktestUnsupportedCorporateAction: 'backtest.unsupported_corporate_action';
  /** Stage 7A — the protocol-neutral operation runtime and registry (`@insiderfinance/totalfinance/workflows`). */
  readonly OperationUnknown: 'operation.unknown';
  readonly OperationRegistrationRefused: 'operation.registration_refused';
  readonly OperationInputTooLarge: 'operation.input_too_large';
  readonly OperationDeadlineExceeded: 'operation.deadline_exceeded';
  readonly OperationCancelled: 'operation.cancelled';
  readonly OperationInternal: 'operation.internal';
  readonly OperationHandleStoreMissing: 'operation.handle_store_missing';
  readonly OperationHandleUnknown: 'operation.handle_unknown';
  readonly OperationHandleKindMismatch: 'operation.handle_kind_mismatch';
  readonly InputLengthMismatch: 'input.length_mismatch';
  /** A selection list names the same entry twice — a duplicate is never silently collapsed. */
  readonly InputDuplicateEntry: 'input.duplicate_entry';
  readonly McpDeadlineExceeded: 'mcp.deadline_exceeded';
  readonly McpInputTooLarge: 'mcp.input_too_large';
  readonly McpInternalError: 'mcp.internal_error';
  readonly PostconditionNonFinite: 'postcondition.non_finite_result';
  readonly McpUnknownTool: 'mcp.unknown_tool';
  readonly PipelineDuplicateAlias: 'pipeline.duplicate_alias';
  readonly PipelineLengthMismatch: 'pipeline.length_mismatch';
  readonly RegistryAliasConflict: 'registry.alias_conflict';
  readonly RegistryDuplicateAliasRow: 'registry.duplicate_alias_row';
  readonly RegistryDuplicateIndicator: 'registry.duplicate_indicator';
  readonly RegistryUnknownAliasTarget: 'registry.unknown_alias_target';
  readonly SignalUnknownReference: 'signal.unknown_reference';
  readonly SnapshotInvalidVersion: 'snapshot.invalid_version';
  readonly SnapshotKindMismatch: 'snapshot.kind_mismatch';
  readonly SnapshotUnknownKind: 'snapshot.unknown_kind';
  readonly SnapshotUnsupportedVersion: 'snapshot.unsupported_version';
  /**
   * A value handed to a snapshot restorer is not an envelope. 3B.N7 retired
   * `snapshot.reserved_field` in the same change: that code guarded a stream serializing its own `v`
   * into a FLAT snapshot, and the `{ kind, schemaVersion, state }` envelope makes the collision
   * structurally impossible — indicator state can no longer reach the envelope's own fields.
   */
  readonly SnapshotWrongShape: 'snapshot.wrong_shape';
  readonly StrategyDeltaRequired: 'strategy.delta_required';
  readonly StrategyMultiExpiryExpirationAnalytics: 'strategy.multi_expiry_expiration_analytics';
  /** A call-site `expiry` contradicts the expiry materialized on the position's option legs. */
  readonly StrategyExpiryConflict: 'strategy.expiry_conflict';
  readonly StrategyStrikeUnavailable: 'strategy.strike_unavailable';
  readonly VolatilityForwardUnavailable: 'volatility.forward_unavailable';
  readonly VolatilitySnapshotVersionMismatch: 'volatility.snapshot_version_mismatch';

  // ── 2026-08-02 defect-fix wave ──────────────────────────────────────────────────────────────
  // Registered ahead of their emit sites (which land in the same PR) so the fix slices cannot race
  // on this registry. Each closes a reviewed silent-wrong-number or fabricated-success defect.
  /** A lattice's risk-neutral branch probabilities left [0, 1] (drift outran diffusion). */
  readonly EngineProbabilityOutOfRange: 'engine.probability_out_of_range';
  /** A successful engine result violated a no-arbitrage output bound (e.g. C > S·e^{-qT}). */
  readonly EngineResultOutOfBounds: 'engine.result_out_of_bounds';
  /** Warning: the engine's grid/truncation is too coarse for the requested regime. */
  readonly EngineDiscretizationInadequate: 'engine.discretization_inadequate';
  /** The target premium is below the smallest price the solver can resolve to a volatility. */
  readonly ImpliedVolatilityPriceBelowResolvable: 'implied_volatility.price_below_resolvable';
  /** Warning: covariance condition number too large for the optimizer's answer to be trusted. */
  readonly RiskIllConditionedCovariance: 'risk.ill_conditioned_covariance';
  /** Warning: the requested tail quantile lies beyond the sample's resolvable range. */
  readonly RiskQuantileBeyondSample: 'risk.quantile_beyond_sample';
  /** Warning: a calibrated fit deviates materially from its input data (likely arbitrageable). */
  readonly VolatilityCalibrationFitDeviation: 'volatility.calibration_fit_deviation';
  /** A variance forecast came back negative; the model output cannot be consumed as a variance. */
  readonly VolatilityNegativeVarianceForecast: 'volatility.negative_variance_forecast';
  /** An iterative series/loop hit its budget without converging; the value is not returned. */
  readonly MathIterationLimit: 'math.iteration_limit';
  /** Warning: a resting order's prices/quantity were adjusted for a corporate action (split). */
  readonly BacktestOrderSplitAdjusted: 'backtest.order_split_adjusted';
  /** Warning: a coupon rate looks like a percent typed as a decimal (e.g. 5 for 5%). */
  readonly InputSuspiciousCouponRate: 'input.suspicious_coupon_rate';
  /** Warning: a yield looks like a percent typed as a decimal (e.g. 5 for 5%). */
  readonly InputSuspiciousYield: 'input.suspicious_yield';
  /** Warning: model parameters violate the Feller condition; the variance floor is attainable. */
  readonly ModelFellerConditionViolated: 'model.feller_condition_violated';

  // ── Gate C structural extension contracts (docs/specs/gate-c-extension-contracts.md) ────────
  // The Pricer/requirements protocol in `@insiderfinance/totalfinance/core/pricing` emits these; they are registered
  // here because core owns the registry (F15) and because the conformance kit BRANCHES on
  // `pricer.requirement_unsatisfied` — a third-party pricer must throw exactly this code for a
  // missing required observation, so the code is load-bearing public API from its first commit.
  /** A required market observation is absent from the observations handed to a pricer. */
  readonly PricerRequirementUnsatisfied: 'pricer.requirement_unsatisfied';
  /** A market-requirement descriptor is malformed (unknown kind, missing/mistyped subject field). */
  readonly PricerRequirementInvalid: 'pricer.requirement_invalid';
  /** A market observation's value has the wrong type/shape for its requirement's kind. */
  readonly PricerObservationInvalid: 'pricer.observation_invalid';
  /** A pricer failed the behavioral conformance kit (`validatePricer`) against its own fixtures. */
  readonly PricerNonconformant: 'pricer.nonconformant';

  // ── Stage 4.4b shared cross-domain scenario runner (`@insiderfinance/totalfinance/scenarios`) ────────────────
  /** A scenario override or shock matched no used observation, Taylor factor, FX quote, or handler. */
  readonly ScenarioInstructionUnmatched: 'scenario.instruction_unmatched';
  /** A target's bound pricer returned false from its one preflight `supports` call. */
  readonly ScenarioTargetUnsupported: 'scenario.target_unsupported';
  /** One base/scenario valuation failed after the complete request and execution plan passed. */
  readonly ScenarioCellFailed: 'scenario.cell_failed';

  // ── Gate B artifact spine (`@insiderfinance/totalfinance/core/artifacts`) ──────────────────────────────────────
  /** A value has no canonical JSON form (Date/Map/Set/typed array/class instance/bigint/function
   * — or the reserved `{ nonFinite }` wrapper supplied as literal data). The canonical serializer
   * refuses rather than guessing a meaning into every content hash. */
  readonly SerializationUnsupportedValue: 'serialization.unsupported_value';
  /** An older-schema envelope was read with no registered migration covering a required step —
   * schema upgrades are explicit, never silent. */
  readonly ArtifactMigrationMissing: 'artifact.migration_missing';
  /** A second migration was registered for the same `(kind, fromVersion)` — two upgrades for one
   * stored shape cannot both be the truth. */
  readonly ArtifactDuplicateMigration: 'artifact.duplicate_migration';
  /** A saved analysis artifact's `id` does not equal the content hash of its body — the artifact
   * was edited after creation (or assembled by hand); its provenance chain cannot be trusted. */
  readonly ArtifactIdMismatch: 'artifact.id_mismatch';
  /** `compareAnalysisArtifacts` received two artifacts of different `artifactType`s — a leaf-by-leaf
   * comparison across result schemas would compare unrelated numbers under shared names. */
  readonly ArtifactTypeMismatch: 'artifact.type_mismatch';
  /** A domain artifact verb received an artifact or report of another package, model family, or
   * research kind (Stage 4.5) — the teaching names the owner. */
  readonly ArtifactFamilyMismatch: 'artifact.family_mismatch';
  /** A stored fitted-model `modelVersion` / research `runVersion` is newer than this build, or older
   * with no registered report migration — evaluating a stored parameter set under different
   * semantics is a silent wrong number, so it is refused (Stage 4.5 Decision 5). */
  readonly ArtifactModelVersionUnsupported: 'artifact.model_version_unsupported';
  /** The stored inputs carried a non-serializable callback (a custom predicate or expected-return
   * model); replay cannot re-issue the producing call and names the field (Stage 4.5). */
  readonly ArtifactNotReplayable: 'artifact.not_replayable';
  /** Caller-supplied rows for a referenced table do not hash to the artifact's table handle — a
   * replay over different data would be a replay of a different run (Stage 4.5). */
  readonly ArtifactReferencedDataMismatch: 'artifact.referenced_data_mismatch';
  /** An embedded calibration or run input exceeds `maximumEmbeddedBytes`; the teaching says to
   * reference the bulk row set through a table handle instead (Stage 4.5 Decision 9). */
  readonly ArtifactEmbeddedInputTooLarge: 'artifact.embedded_input_too_large';
  /** The model family has no evaluator, warm start, stability, or holdout operation — an exact or
   * closed-form fit has no search to start and a statistic has nothing to evaluate (Stage 4.5). */
  readonly ArtifactOperationUnsupported: 'artifact.operation_unsupported';

  // ── FC7 durable portfolio ledger (`@insiderfinance/totalfinance/portfolio`) ────────────────────────────────────
  /** A `(sourceId, eventId)` pair was replayed with a DIFFERENT event body. The duplicate boundary
   * makes replay idempotent for identical deliveries; a changed payload under the same identity is
   * a conflict that must be heard, never a silent overwrite or a silent no-op. */
  readonly PortfolioDuplicateEventConflict: 'portfolio.duplicate_event_conflict';
  /** A `specific-lot` relief selection names a lot that does not exist in the position or carries
   * less remaining quantity than the selection claims — lot relief never guesses a substitute. */
  readonly PortfolioLotUnavailable: 'portfolio.lot_unavailable';
  /** A valuation needs a mark (an instrument price or a currency-pair quote to the base currency)
   * that the supplied market/conversion inputs do not carry. An unavailable mark is a typed
   * failure, never an interpolated or stale guess. */
  readonly PortfolioMarkUnavailable: 'portfolio.mark_unavailable';
  /** An `admin.reversal`/`admin.correction` names an `original` the fold never applied under that
   * `(sourceId, eventId)` — a reversal repairs an applied fact, never an imagined one. */
  readonly PortfolioReversalTargetMissing: 'portfolio.reversal_target_missing';
  /** The applied fact cannot be reversed exactly: the supplied `original` differs from what was
   * applied, it was already reversed, its lots were relieved by later fills, or its family has no
   * exact inverse in this build. History is never approximated — record a correcting event. */
  readonly PortfolioReversalInfeasible: 'portfolio.reversal_infeasible';
};

/** Materialize the catalog without retaining both PascalCase names and snake_case duplicates.
 * The declaration above is the exact literal contract; the registry test checks every value and
 * enumeration position. This pure initializer performs no I/O or financial computation. */
function errorCodeRegistry(encoded: string): ErrorCodeRegistry {
  const registry: Record<string, string> = {};
  for (const entry of encoded.split(' ')) {
    const [name, code] = entry.split(':');
    registry[name!] =
      code ??
      name!
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace('_', '.');
  }
  return registry as ErrorCodeRegistry;
}

export const ErrorCode = {
  .../* @__PURE__ */ errorCodeRegistry(
    'InputNaN:input.nan InputNotFinite InputNegativeSpot InputNegativeStrike InputNegativeVolatility InputNegativeTime InputOutOfRange InputInvalidEnum InputMissingField InputUnknownField InputWrongType InputWrongShape ImpliedVolatilityNoConvergence:implied_volatility.no_convergence ImpliedVolatilityBelowIntrinsic:implied_volatility.below_intrinsic ImpliedVolatilityAboveMax:implied_volatility.above_max_bound EngineUnsupportedContract DataCrossedMarket DataUnsupportedCapability DataContractVersionUnsupported DataAuthenticationRequired DataEntitlementRequired DataRateLimited DataAllowanceExhausted DataSnapshotExpired DataInvalidCursor DataNotFound DataInvalidRequest DataInvalidResponse DataUnavailable DataAborted DataNonconformant DataStaleQuote SolverNoConvergence LinalgNoConvergence LinalgNotPositiveDefinite LinalgSingular IntegrationMaxDepth InterpolationOutOfDomain InterpolationDuplicateKnots InterpolationInvalidGrid OptimizeInvalidBounds VolatilityExpiryNotFound VolatilityCalendarArbitrage StrategyInvalidChartRange TimeTimezoneResolutionFailed TimeValuationInstantRequired BacktestDuplicateHandler BacktestMixedSymbols BacktestMarkUnavailable BacktestAmbiguousIntrabar BacktestStaleQuote BacktestAdapterNonconformant BacktestInputTooLarge BacktestDelistingReturnMissing BacktestUniverseMembershipUnknown BacktestLedgerReconciliationFailed EnvironmentNotReset EnvironmentDuplicateOrder EnvironmentLimitBreach EnvironmentActionDisallowed EnvironmentUnknownInstrument EnvironmentOrderInvalid EnvironmentActionInvalid EnvironmentEpisodeOver TradePlanInvalid TradePreflightDenied TradeGrantInvalid TradeGrantExpired TradeGrantConsumed TradeIdempotencyConflict TradeHalted TradeLiveUnavailable TradeJournalTransitionInvalid OperationCapabilityMissing OperationToolFiltered BacktestGridTooLarge BacktestBookTooLarge BacktestUnsupportedCorporateAction OperationUnknown OperationRegistrationRefused OperationInputTooLarge OperationDeadlineExceeded OperationCancelled OperationInternal OperationHandleStoreMissing OperationHandleUnknown OperationHandleKindMismatch InputLengthMismatch InputDuplicateEntry McpDeadlineExceeded McpInputTooLarge McpInternalError PostconditionNonFinite:postcondition.non_finite_result McpUnknownTool PipelineDuplicateAlias PipelineLengthMismatch RegistryAliasConflict RegistryDuplicateAliasRow RegistryDuplicateIndicator RegistryUnknownAliasTarget SignalUnknownReference SnapshotInvalidVersion SnapshotKindMismatch SnapshotUnknownKind SnapshotUnsupportedVersion SnapshotWrongShape StrategyDeltaRequired StrategyMultiExpiryExpirationAnalytics StrategyExpiryConflict StrategyStrikeUnavailable VolatilityForwardUnavailable VolatilitySnapshotVersionMismatch EngineProbabilityOutOfRange EngineResultOutOfBounds EngineDiscretizationInadequate ImpliedVolatilityPriceBelowResolvable:implied_volatility.price_below_resolvable RiskIllConditionedCovariance RiskQuantileBeyondSample VolatilityCalibrationFitDeviation VolatilityNegativeVarianceForecast MathIterationLimit BacktestOrderSplitAdjusted InputSuspiciousCouponRate InputSuspiciousYield ModelFellerConditionViolated PricerRequirementUnsatisfied PricerRequirementInvalid PricerObservationInvalid PricerNonconformant ScenarioInstructionUnmatched ScenarioTargetUnsupported ScenarioCellFailed SerializationUnsupportedValue ArtifactMigrationMissing ArtifactDuplicateMigration ArtifactIdMismatch ArtifactTypeMismatch ArtifactFamilyMismatch ArtifactModelVersionUnsupported ArtifactNotReplayable ArtifactReferencedDataMismatch ArtifactEmbeddedInputTooLarge ArtifactOperationUnsupported PortfolioDuplicateEventConflict PortfolioLotUnavailable PortfolioMarkUnavailable PortfolioReversalTargetMissing PortfolioReversalInfeasible',
  ),
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Build the canonical "a required field is missing" error (design law #4 / the first-touch law).
 * One voice across every facade: it names the field and shows a WORKING example call, so the message
 * teaches the fix instead of leaking a raw `TypeError` from a property access.
 *
 * ```
 * InputError [input.missing_field]: sma: period is required.
 *   e.g. sma(closes, { period: 20 })
 * ```
 */
export function missingFieldError(
  functionName: string,
  field: string,
  example: string,
  hint?: string,
): InputError {
  const lines = [`${functionName}: ${field} is required.`, `  e.g. ${example}`];
  // The hint carries what the call shape cannot: a unit trap, a range, a name collision. It is a
  // SECOND line rather than a replacement, because the example has to stay pasteable.
  if (hint !== undefined) lines.push(`  ${field}: ${hint}`);
  return new InputError(lines.join('\n'), {
    code: ValidationCode.InputMissingField,
    context: { function: functionName, field, example, ...(hint === undefined ? {} : { hint }) },
  });
}

/**
 * Build a "this object isn't the expected shape" error that echoes the keys the caller DID pass. The
 * received-keys echo turns the error into documentation of the expected shape — a reasonable wrong
 * guess (`{ putLongStrike: … }`) is answered with the real slot names rather than a raw `TypeError`.
 */
export function wrongShapeError(
  functionName: string,
  expected: string,
  received: unknown,
): InputError {
  const keys =
    received !== null && typeof received === 'object' ? Object.keys(received as object) : [];
  return new InputError(
    `${functionName}: expected ${expected}.\n  received keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}`,
    {
      // A wrong-shape object is not a single missing field — it has its own code so a caller/agent can
      // dispatch on "you passed the wrong slots" separately from "you omitted one field" (F15).
      code: ValidationCode.InputWrongShape,
      context: { function: functionName, expected, receivedKeys: keys },
    },
  );
}
