/** Diagnostics and warnings carried by every pro-API result (spec §5.2). */

import { ErrorCode, InputError } from './errors.js';
import { ensureKnownKeys, requireArgumentObject } from './invariants.js';
import type { SelectionReport } from './pricing.js';

export type WarningSeverity = 'info' | 'warn' | 'error';

/** A structured, machine-readable warning. `code` is stable public API. */
export interface QuantWarning {
  code: string;
  message: string;
  severity: WarningSeverity;
  context?: Record<string, unknown>;
}

/** Non-value metadata about how a result was computed. */
export interface Diagnostics {
  /** Pricing/solver engine name, e.g. `black-scholes-merton`. */
  engine?: string;
  /** Numerical method, e.g. `closed-form`, `brent`, `finite-difference`. */
  method?: string;
  /** Whether an iterative procedure converged. `false` means the value is not trustworthy. */
  converged?: boolean;
  /** Iteration count for iterative methods. */
  iterations?: number;
  /**
   * When a meta-engine (e.g. `engines.auto()`) selected a delegate, this is a one-sentence,
   * human-readable explanation of WHY that delegate was chosen (`engine` then names the delegate).
   * Absent when no auto-selection took place.
   */
  autoReason?: string;
  /**
   * The structured engine-selection report (Gate C, `@insiderfinance/totalfinance/core/pricing`): who was selected,
   * why, and — for automatic selection — every candidate considered with its verdict. This is the
   * machine-readable superset of `engine` + `autoReason` (which remain for compatibility);
   * `selected.name` always agrees with `engine` when both are present.
   */
  selection?: SelectionReport;
  /**
   * Named intermediate quantities the value decomposes into — a par spread's protection leg and
   * risky annuity, a forward variance's near/far legs. The H-series explain paths disclose their
   * arithmetic here so a caller can audit the ratio, not just receive it (3B.3).
   */
  decomposition?: Record<string, number>;
  /** Structured warnings; always present (possibly empty). */
  warnings: QuantWarning[];
  /** Wall-clock timing in milliseconds, when measured. */
  timingMs?: number;
  /**
   * Series facades: number of leading output slots that are warmup sentinels (null/NaN) while the
   * computation seeds. Equals the input length when the indicator never emitted.
   */
  warmup?: number;
  /**
   * Finite-difference engines: the ACTUAL bump sizes used for FD Greeks (spec P2.3) — adaptive
   * near the vol/time boundaries, so the caller can see exactly what was differenced.
   * Keys: `spotStep`, `volatilityStep`, `timeStepYears`, `rateStep`, and — extended Greeks only —
   * `dividendYieldStep`. Each is the actual step differenced, in the unit of the coordinate it
   * bumps. (This doc named the retired `hS`/`hSig`/`hT`/`hR`/`hQ` keys for one release after the
   * emit sites had moved to the semantic names, so a caller following it read `undefined`.)
   */
  finiteDifferenceBumps?: Record<string, number>;
}

/** Construct an empty diagnostics object with no warnings. */
export function emptyDiagnostics(): Diagnostics {
  return { warnings: [] };
}

/** Build a warning helper, defaulting severity to `warn`. */
export function warning(
  code: string,
  message: string,
  severity: WarningSeverity = 'warn',
  context?: Record<string, unknown>,
): QuantWarning {
  // A warning IS a public payload — a non-string code/message would be served to consumers.
  if (typeof code !== 'string' || code.length === 0 || typeof message !== 'string') {
    throw new InputError(
      `warning: code and message must be strings — warning('data.stale_quote', 'quote is 3h old'). Received (${code === undefined ? 'undefined' : typeof code}, ${message === undefined ? 'undefined' : typeof message}).`,
      { code: ErrorCode.InputWrongType, context: { field: 'code' } },
    );
  }
  return context !== undefined ? { code, message, severity, context } : { code, message, severity };
}

/**
 * Canonical warning codes. Like error codes, these are stable public API — consumers branch on them.
 * The set is open; packages may add codes, but documented ones do not change without a major version.
 *
 * Codes that are BOTH a thrown-error condition and an emitted warning (`implied_volatility.below_intrinsic`,
 * `implied_volatility.above_max_bound`, `implied_volatility.no_convergence`, `data.crossed_market`, `data.stale_quote`) live only in
 * {@link ErrorCode} — the single source of truth — and warning sites reference `ErrorCode.*` for the
 * code string, so no string is duplicated across the two registries (WS2.9).
 */
export const WarningCode = {
  DataLockedMarket: 'data.locked_market',
  DataZeroBidAsk: 'data.zero_bid_ask',
  SurfaceExtrapolated: 'volatility.surface_extrapolated',
  BinomialStepsRoundedOdd: 'binomial.steps_rounded_odd',
  GreeksNotComputed: 'greeks.not_computed',
  SuspiciousVolatility: 'input.suspicious_volatility',
  SuspiciousTime: 'input.suspicious_time',
  SuspiciousRiskFreeRate: 'input.suspicious_risk_free_rate',
  SuspiciousReturns: 'input.suspicious_returns',
  /** The result is NaN/degenerate BY DESIGN (empty series, zero variance) — disclosed, not fabricated. */
  DegenerateInput: 'input.degenerate',
  /** Elasticity Λ = Δ·S/V is undefined (price underflowed to 0) — reported as `null`, never NaN/∞. */
  LambdaUndefined: 'greeks.lambda_undefined',
  /** Fractional compounding of a ≤−100%-per-interval rate is undefined — reported as `null`, never NaN. */
  CompoundingUndefined: 'crypto.compounding_undefined',
  /** Compounded annualization exceeded IEEE-754 range — reported as `null`, never Infinity. */
  CompoundingOverflow: 'crypto.compounding_overflow',
  /** A degenerate/collinear covariance was eigenvalue-floored to keep the SPD postcondition. */
  CovarianceFloored: 'math.covariance_floored',
  /** Greeks were explicitly requested but this engine cannot compute them — request not honored. */
  GreeksUnsupportedByEngine: 'greeks.unsupported_by_engine',
  /** A structural limitation of the model/data the caller should know about (design law #4). */
  ModelLimitation: 'model.limitation',
  /** A valid reusable FX quote was supplied but no target required it in this scenario run. */
  ScenarioUnusedCurrencyConversion: 'scenario.unused_currency_conversion',

  // ── Phase 3 registry consolidation (P3.1c) — leaf-package warning codes, see ErrorCode note ──
  BacktestAssignment: 'backtest.assignment',
  BacktestDataDuplicateTimestamp: 'backtest.data_duplicate_timestamp',
  BacktestDataNonfinite: 'backtest.data_nonfinite',
  /** Stage 4.6 (FC8): a benchmark session had no return and counted as 0; the count rides the warning. */
  BacktestDataMissing: 'backtest.data_missing',
  /** Stage 4.6 (FC8) — a pre-trade limit rejected an entry (the row names the limit and the values). */
  BacktestLimitRejected: 'backtest.limit_rejected',
  /** Stage 4.6 (FC8) — a structure could not fill every leg under the fill policy (the row names the legs). */
  BacktestComboLegUnfilled: 'backtest.combo_leg_unfilled',
  /** Stage 4.6 (FC8) — maintenance margin breached under forcedLiquidation 'none'. */
  BacktestMarginBreach: 'backtest.margin_breach',
  /** Stage 4.6 (FC8) — a forced close under the declared liquidation policy (the row names the position and the shortfall). */
  BacktestForcedLiquidation: 'backtest.forced_liquidation',
  BacktestDataUnsorted: 'backtest.data_unsorted',
  BacktestEntrySkipped: 'backtest.entry_skipped',
  /** An open option leg could not be marked from its current-snapshot quote and the request's
   * named missing-mark fallback was applied (Preview P1) — the count of leg-snapshots is carried. */
  BacktestMarkFallback: 'backtest.mark_fallback',
  BacktestLookahead: 'backtest.lookahead',
  BacktestMarginRejected: 'backtest.margin_rejected',
  BacktestMarkedAtCost: 'backtest.marked_at_cost',
  BacktestNegativeCash: 'backtest.negative_cash',
  BacktestShortRejected: 'backtest.short_rejected',
  BacktestSignalWarmup: 'backtest.signal_warmup',
  CryptoCarryArbitrage: 'crypto.carry_arbitrage',
  CryptoExtremeFunding: 'crypto.extreme_funding',
  EstimateRiskNeutral: 'estimate.risk_neutral',
  FlowSweepsNotVenueVerified: 'flow.sweeps_not_venue_verified',
  HestonCosineExpansionUnstable: 'heston.cosine_expansion_unstable',
  HestonFellerViolated: 'heston.feller_violated',
  ImpliedVolatilityBracketExpanded: 'implied_volatility.bracket_expanded',
  ImpliedVolatilityFlatHistory: 'implied_volatility.flat_history',
  ImpliedVolatilityLowVega: 'implied_volatility.low_vega',
  LookbackZeroCarry: 'lookback.zero_carry',
  MathCovarianceEwmaEffectiveSample: 'math.covariance_ewma_effective_sample',
  MathCovarianceIllConditioned: 'math.covariance_ill_conditioned',
  MathCovarianceMethodAuto: 'math.covariance_method_auto',
  MathCovarianceSingular: 'math.covariance_singular',
  MonteCarloQuasiMonteCarloDimensionFallback: 'monte_carlo.quasi_monte_carlo_dimension_fallback',
  OptimizeNotConverged: 'optimize.not_converged',
  /** A library result reported this warning as a bare sentence; the envelope carries it typed. */
  OperationUntypedWarning: 'operation.untyped_warning',
  OptionsDividendsNone: 'options.dividends_none',
  OptionsDividendsPast: 'options.dividends_past',
  OptionsExerciseDiscreteDividends: 'options.exercise_discrete_dividends',
  /** Quote-only chain health was requested; model bounds and implied volatility are not assessed. */
  OptionsChainHealthModelNotRequested: 'options.chain_health.model_not_requested',
  PerformanceSuspiciousEquityInput: 'performance.suspicious_equity_input',
  PerformanceNonFiniteMetric: 'performance.non_finite_metric',
  /** `analyze` on a series with zero return periods: every metric is null (E3 degenerate summary). */
  PerformanceEmptySeries: 'performance.empty_series',
  /** Zero gross exposure: concentration metrics are undefined and reported as null. */
  RiskZeroGrossExposure: 'risk.zero_gross_exposure',
  /** `compareEngines`: one or more engines failed to price (per-row detail on the failed rows). */
  OptionsEngineFailed: 'options.engine_failed',
  /** `openingRange`: fewer bars than `periods` — the range covers the whole series. */
  TechnicalAnalysisOpeningRangeTruncated: 'technical_analysis.opening_range_truncated',
  /** `unusualness`: flat baseline — the z-score is undefined and reported null. */
  StructureFlatBaseline: 'structure.flat_baseline',
  /** Surface/model calibration finished without meeting tolerance — best-effort parameters returned. */
  VolatilityCalibrationNotConverged: 'volatility.calibration_not_converged',
  PerformanceUndefinedMetric: 'performance.undefined_metric',
  ResearchSurvivorshipBias: 'research.survivorship_bias',
  ResearchTrainTestLeakage: 'research.train_test_leakage',
  /** `probabilityOfBacktestOverfitting`: the oldest rows were trimmed so T divides into S blocks. */
  ResearchBacktestOverfittingProbabilityTrimmed:
    'research.backtest_overfitting_probability_trimmed',
  RiskBrinsonWeights: 'risk.brinson_weights',
  RiskCornishFisherConditionalValueAtRiskGaussianFallback:
    'risk.cornish_fisher_conditional_value_at_risk_gaussian_fallback',
  RiskCornishFisherOutOfDomain: 'risk.cornish_fisher_out_of_domain',
  RiskCostExceedsEdge: 'risk.cost_exceeds_edge',
  /** FC7 slice 4 (2026-08-29): estimateExpectedReturns received an asOf but no observation
   * timestamps — nothing could be screened for look-ahead. */
  RiskAsOfUnscreened: 'risk.as_of_unscreened',
  /** A frontier point with zero volatility has no Sharpe ratio (reported null with the reason). */
  RiskZeroVolatilitySharpe: 'risk.zero_volatility_sharpe',
  /** The constrained maximum return is unbounded (an asset without an upper bound and another
   * without a lower bound); a `points` grid fell back to a risk-aversion grid. */
  RiskFrontierUnboundedReturn: 'risk.frontier_unbounded_return',
  /** Solved frontier points are not monotone in volatility versus expected return. */
  RiskFrontierNotMonotone: 'risk.frontier_not_monotone',
  /** One or more requested frontier points could not be solved (kept with their reasons). */
  RiskFrontierPointsFailed: 'risk.frontier_points_failed',
  RiskExtremeValueConfidenceOutsideTail: 'risk.extreme_value_confidence_outside_tail',
  RiskExtremeValueDegenerateFit: 'risk.extreme_value_degenerate_fit',
  RiskExtremeValueFewExceedances: 'risk.extreme_value_few_exceedances',
  RiskExtremeValueInfiniteMean: 'risk.extreme_value_infinite_mean',
  RiskExtremeValueInfiniteVariance: 'risk.extreme_value_infinite_variance',
  RiskExtremeValueMleFallback: 'risk.extreme_value_mle_fallback',
  RiskHighCostDrag: 'risk.high_cost_drag',
  RiskInfeasibleConstraints: 'risk.infeasible_constraints',
  RiskInfeasibleTangency: 'risk.infeasible_tangency',
  RiskKellyEstimationNoEdge: 'risk.kelly_estimation_no_edge',
  RiskKellyEstimationThinSample: 'risk.kelly_estimation_thin_sample',
  RiskKellyFatTails: 'risk.kelly_fat_tails',
  RiskKellyNaiveOverbet: 'risk.kelly_naive_overbet',
  RiskKellyNegativeSum: 'risk.kelly_negative_sum',
  RiskKellyNoEdge: 'risk.kelly_no_edge',
  RiskKellyOver: 'risk.kelly_over',
  RiskKellyUnbounded: 'risk.kelly_unbounded',
  RiskMeanExcessNoLinearRegion: 'risk.mean_excess_no_linear_region',
  /** P&L explain: the unexplained residual dominates the total — the greek expansion broke down. */
  RiskPnlUnexplainedResidual: 'risk.pnl_unexplained_residual',
  /** `optionsMargin`: a net-short call makes the expiration loss unbounded — `maxLoss` is null. */
  RiskUnboundedLoss: 'risk.unbounded_loss',
  StrategyVolatilityFloored: 'strategy.volatility_floored',
  /** The reward-to-risk ratio is undefined: an unbounded profit or loss, or a zero maximum loss. */
  StrategyRiskRewardUndefined: 'strategy.risk_reward_undefined',
  /** `optimizeStrategy`: a candidate's capital requirement is zero — `thesisEvPerCapital` is null. */
  StrategyOptimizerZeroCapital: 'strategy.optimizer_zero_capital',
  StructureAggressorUnavailable: 'structure.aggressor_unavailable',
  StructureContractsSkipped: 'structure.contracts_skipped',
  /** Repeated contract rows remain additive and may count the same open interest more than once. */
  StructureDuplicateContractQuotes: 'structure.duplicate_contract_quotes',
  /** Every supplied quote was excluded; empty sums must not be read as measured zero exposure. */
  StructureNoEligibleQuotes: 'structure.no_eligible_quotes',
  VolatilityButterflyArbitrage: 'volatility.butterfly_arbitrage',
  VolatilityEssviButterfly: 'volatility.essvi_butterfly',
  VolatilityEssviCalendar: 'volatility.essvi_calendar',
  VolatilityEssviCalendarData: 'volatility.essvi_calendar_data',
  VolatilityEssviNotConverged: 'volatility.essvi_not_converged',
  VolatilityFitInsufficientData: 'volatility.fit_insufficient_data',
  VolatilityFitUnconverged: 'volatility.fit_unconverged',
  VolatilityShockDegradedToInterpolated: 'volatility.shock_degraded_to_interpolated',
  VolatilityShockFloored: 'volatility.shock_floored',
  VolatilitySkewDeltaExtrapolated: 'volatility.skew_delta_extrapolated',
  VolatilityObservedSkewUnavailable: 'volatility.observed_skew_unavailable',
  VolatilityObservedSkewQuoteExcluded: 'volatility.observed_skew_quote_excluded',
  /** C hygiene — a zero-variance edge has no Kelly fraction: the sizing is null, never an input error. */
  RiskKellyZeroVariance: 'risk.kelly_zero_variance',
  /** C hygiene — a zero-variance return series has no Sharpe ratio: the statistic is null. */
  RiskSharpeUndefined: 'risk.sharpe_undefined',
  /** B7 — `chainGreeks` returned some rows unchanged; `diagnostics.rows` names each reason. */
  OptionsChainGreeksRowsSkipped: 'chain_greeks.rows_skipped',
  VolatilityObservedSkewMissingDelta: 'volatility.observed_skew_missing_delta',
  VolatilityObservedSkewDuplicateContract: 'volatility.observed_skew_duplicate_contract',
  VolatilitySsviButterfly: 'volatility.ssvi_butterfly',
  VolatilitySsviCalendarData: 'volatility.ssvi_calendar_data',
  VolatilitySsviNotConverged: 'volatility.ssvi_not_converged',
  VolatilityStickyIndeterminate: 'volatility.sticky_indeterminate',
  VolatilityStickyWeakFit: 'volatility.sticky_weak_fit',
  VolatilitySurfaceQuotesSkipped: 'volatility.surface_quotes_skipped',
  VolatilitySurfaceSparse: 'volatility.surface_sparse',
  VolatilitySwaptionCubeExtrapolated: 'volatility.swaption_cube_extrapolated',
  VolatilitySwaptionNodePoorFit: 'volatility.swaption_node_poor_fit',
  /** Two artifacts under comparison or replay name different producing library versions — a
   * difference may be a library change rather than a market or parameter change (Stage 4.5). */
  ArtifactLibraryVersionDiffers: 'artifact.library_version_differs',
  /** Two artifacts under comparison were computed under different market snapshots — still
   * comparable, but the reader is told the market moved (Stage 4.5). */
  ArtifactComparisonDifferentMarket: 'artifact.comparison_different_market',
  /** Two research runs under comparison were computed over different universes or as-of dates —
   * still comparable, but the reader is told the population moved (Stage 4.5). */
  ArtifactComparisonDifferentUniverse: 'artifact.comparison_different_universe',
  /** A restored curve was evaluated outside its calibrated pillar range under its stored
   * extrapolation policy — counted and disclosed, never silent (Stage 4.5). */
  CurveExtrapolated: 'curve.extrapolated',
} as const;

export type WarningCode = (typeof WarningCode)[keyof typeof WarningCode];

/**
 * Plausibility warnings for the two classic quant footguns (the first-touch law §2.4). Facades stay
 * silent-and-correct on the plain-value path (a 2200% vol is legal — memecoins exist), but the
 * `.explain()` envelope should say what it sees. Never throws; returns `[]` when inputs look normal.
 *   - `vol > 3`         → likely a percent typed as a decimal (`vol: 22` → 2200%).
 *   - `t > 5` & integer → likely a day count typed as a year fraction (`t: 30` → a 30-year option).
 *   - `|rate| > 0.5`    → likely a percent typed as a decimal (`rate: 4.5` → a 450% risk-free rate).
 */
export function plausibilityWarnings(inputs: {
  volatility?: number;
  timeToExpiryYears?: number;
  riskFreeRate?: number;
}): QuantWarning[] {
  requireArgumentObject('plausibilityWarnings', 'inputs', inputs);
  ensureKnownKeys('plausibilityWarnings', 'inputs', inputs, [
    'volatility',
    'timeToExpiryYears',
    'riskFreeRate',
  ]);
  for (const field of ['volatility', 'timeToExpiryYears', 'riskFreeRate'] as const) {
    const v = inputs[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      throw new InputError(
        `plausibilityWarnings: ${field} must be a finite number when provided. Received ${v === null ? 'null' : typeof v}.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
  const out: QuantWarning[] = [];
  /**
   * These warnings TEACH, so every name in them must be a name the caller can type.
   *
   * They used to read `vol=0.2 … vol is a decimal`, `t=10 … t is a year fraction`, `rate=0.05 …` and
   * to serialize their context under `{ t }` and `{ rate }`. None of those fields exist: the inputs
   * are `volatility`, `timeToExpiryYears` and `riskFreeRate`. A diagnostic whose whole purpose is to
   * correct a caller cannot name the field wrongly, and a warning context is a public payload — a
   * consumer reads those keys.
   *
   * The local aliases are gone too. They are private and therefore permitted, but they are how the
   * short names reached the strings in the first place.
   */
  const { volatility, timeToExpiryYears, riskFreeRate } = inputs;
  if (volatility !== undefined && Number.isFinite(volatility) && volatility > 3) {
    out.push(
      warning(
        WarningCode.SuspiciousVolatility,
        `volatility=${volatility} implies ${(volatility * 100).toFixed(0)}% — volatility is a decimal; did you mean ${(volatility / 100).toFixed(4)}?`,
        'info',
        { volatility },
      ),
    );
  }
  if (
    timeToExpiryYears !== undefined &&
    Number.isFinite(timeToExpiryYears) &&
    timeToExpiryYears > 5 &&
    Number.isInteger(timeToExpiryYears)
  ) {
    out.push(
      warning(
        WarningCode.SuspiciousTime,
        `timeToExpiryYears=${timeToExpiryYears} is a very long horizon — timeToExpiryYears is a year fraction; if you meant ${timeToExpiryYears} days, use ${timeToExpiryYears}/365 = ${(timeToExpiryYears / 365).toFixed(4)}.`,
        'info',
        { timeToExpiryYears },
      ),
    );
  }
  if (riskFreeRate !== undefined && Number.isFinite(riskFreeRate) && Math.abs(riskFreeRate) > 0.5) {
    out.push(
      warning(
        WarningCode.SuspiciousRiskFreeRate,
        `riskFreeRate=${riskFreeRate} implies a ${(riskFreeRate * 100).toFixed(0)}% risk-free rate — riskFreeRate is a decimal; did you mean ${(riskFreeRate / 100).toFixed(4)}?`,
        'info',
        { riskFreeRate },
      ),
    );
  }
  return out;
}

/**
 * The third classic footgun (dx WS-3 / R6): a PRICE or equity series passed where per-period
 * RETURNS are expected. Returns are decimals (`0.01` = +1%); a series whose mean magnitude
 * exceeds 0.5 (50% per period) is almost certainly prices — a monotonic 100→160 price series
 * fed to `sharpe()` yields an absurd-but-silent 117. Warning only, never an error (a genuine
 * >50%/period return series is legal — it is just worth flagging). Returns `undefined` when the
 * series looks like returns.
 */
export function suspiciousReturnsWarning(returns: ArrayLike<number>): QuantWarning | undefined {
  const n = returns.length;
  if (n === 0) return undefined;
  let sumAbs = 0;
  let finite = 0;
  for (let i = 0; i < n; i++) {
    const v = returns[i]!;
    if (Number.isFinite(v)) {
      sumAbs += Math.abs(v);
      finite++;
    }
  }
  if (finite === 0) return undefined;
  const meanAbs = sumAbs / finite;
  if (meanAbs <= 0.5) return undefined;
  return warning(
    WarningCode.SuspiciousReturns,
    `mean |value| = ${meanAbs.toFixed(2)} — returns are decimals (0.01 = +1%); did you pass ` +
      `prices or an equity curve? Convert with simpleReturns(prices) first.`,
    'info',
    { meanAbs },
  );
}
