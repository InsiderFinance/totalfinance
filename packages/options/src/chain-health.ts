/** Pure, bounded quote-quality and model-compatibility reporting for a single underlying. */
import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  WarningCode,
  requireRepresentableResult,
  ensureEnum,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  isQuantError,
  missingFieldError,
  requireArgumentObject,
  resolveAsOf,
  resolveValuationAsOf,
  validateResolvedExpiry,
  yearFraction,
  type Assumptions,
  type MarketInputs,
  type OptionContract,
  type OptionQuote,
  type PriceSource,
  type QuantWarning,
} from '@totalfinance/core';
import {
  blackScholesImpliedVolatility,
  blackScholesPrice,
  blackScholesPriceBounds,
} from '@totalfinance/options/black-scholes';
import type { DiscreteDividend } from '@totalfinance/options';
import { invertEngine } from './american-iv.js';
import { engines, type OptionPricingEngine } from './engines.js';

/** Canonical quote fields; only timestamp absence is relaxed so it can be reported honestly. */
export interface OptionChainHealthQuote extends Omit<OptionQuote, 'timestampMs'> {
  /** Epoch milliseconds when known. Missing is reported, never replaced by market.asOf. */
  timestampMs?: number;
}

export interface OptionChainHealthMarket extends Pick<MarketInputs, 'asOf'> {
  /** All quote and expected-contract underlyings must match exactly. */
  underlying: string;
  /** Required only when BSM assessment is requested. */
  spot?: number;
  /** Annual continuous risk-free rate, decimal; required only for BSM assessment. */
  riskFreeRate?: number;
  /**
   * Annual continuous yield, decimal. The package dividend rule applies: omitted means 0 (no
   * continuous yield), echoed in `assumptions.dividendYield` and disclosed by a warning when the
   * model assessment defaulted it.
   */
  dividendYield?: number;
  /** Nonempty cash schedules are validated but explicitly unsupported by this BSM report. */
  dividends?: readonly DiscreteDividend[];
}

/** The model path requires real caller-supplied economics; the quote-only path does not. */
export type OptionChainHealthModelMarket = OptionChainHealthMarket &
  Required<Pick<MarketInputs, 'spot' | 'riskFreeRate'>>;

export interface OptionChainHealthConfig {
  /**
   * Omit for quote-only health. `'black-scholes-merton'` names the dynamics: European rows invert
   * closed-form Black–Scholes–Merton and American rows invert the Bjerksund–Stensland 2002 engine
   * under the same dynamics, each inside its own style's no-arbitrage band. No row is ever priced
   * as the other exercise style.
   */
  model?: 'black-scholes-merton';
  /** No fallback to last/mark. mid uses explicit mid, otherwise the bid/ask midpoint. */
  priceSource: PriceSource;
  /** Non-negative elapsed milliseconds; stale iff age strictly exceeds this threshold. */
  maximumQuoteAgeMs: number;
  /** Non-negative spread / bid-ask midpoint ratio; wide iff strictly greater. */
  maximumRelativeSpread: number;
  /** Default 1; positive safe integer ≤10,000. Distinct expiration instants, including expired ones. */
  minimumExpiries?: number;
  /** Default 1; positive safe integer ≤10,000; per expiration instant AND exercise style. */
  minimumStrikesPerExpiry?: number;
  /** Optional smaller row budget; default and hard ceiling 10,000. No silent truncation. */
  maximumQuotes?: number;
  /** Model rows only. Closed optional σ bracket; defaults 1e-7 and 5, hard bounds, never expanded. */
  solver?: { lowerVolatilityBound?: number; upperVolatilityBound?: number };
}

export type OptionChainHealthInput = {
  /** Dense, open observation records. Unconsumed provider metadata is neither traversed nor copied. */
  quotes: readonly OptionChainHealthQuote[];
  /** Optional dense explicit universe (≤10,000). No exchange listing universe is inferred. */
  expectedContracts?: readonly OptionContract[];
} & (
  | {
      market: OptionChainHealthModelMarket;
      config: OptionChainHealthConfig & { model: 'black-scholes-merton' };
    }
  | {
      market: OptionChainHealthMarket;
      config: OptionChainHealthConfig & { model?: never; solver?: never };
    }
);

export type OptionChainHealthIssue =
  | 'stale'
  | 'future'
  | 'missing_timestamp'
  | 'missing_bid'
  | 'missing_ask'
  | 'missing_price'
  | 'crossed'
  | 'wide'
  | 'expired';

export type OptionChainHealthModelStatus =
  | 'not-requested'
  | 'compatible'
  | 'model-incompatible'
  | 'unsupported'
  | 'not-evaluated'
  | 'unavailable';

export interface OptionChainHealthModelResult {
  /** Compatibility with the specified model, NOT a verdict that a market observation is bad. */
  status: OptionChainHealthModelStatus;
  /**
   * The engine this row's bounds and inverse come from under the requested dynamics — closed-form
   * BSM for a European contract, Bjerksund–Stensland 2002 for an American one. Null when no model
   * assessment was requested.
   */
  engine: 'black-scholes-merton' | 'bjerksund-stensland-2002' | null;
  /**
   * The style's no-arbitrage price band per underlying share, or null when not evaluable: the
   * discounted band for a European row, the undiscounted intrinsic-to-spot/strike band for an
   * American row.
   */
  bounds: { lower: number; upper: number } | null;
  /** Every applicable unsupported assumption, not just the first one encountered. */
  unsupportedReasons: ('discrete_dividends' | 'adjusted_deliverable')[];
  impliedVolatility: number | null;
  solver: {
    status: 'converged' | 'not-run' | 'unavailable' | 'failed';
    /** null when no model assessment was requested. */
    method: 'brent' | null;
    converged: boolean;
    iterations: number;
    /** Null only on success. Failed inverses never receive a guessed or supplied IV. */
    reason: string | null;
    /** Absolute repricing residual per share; null if no finite solve was accepted. */
    priceResidual: number | null;
  };
}

/** Pricing identity only: accounting/venue metadata is not used to scale or interpret premiums. */
export type OptionChainHealthContract = Pick<
  OptionContract,
  'underlying' | 'type' | 'style' | 'strike' | 'expiry' | 'expiresAt' | 'expiryConvention'
>;

export interface OptionChainHealthRow {
  /** Input order is preserved, including duplicate observations. */
  quoteIndex: number;
  contract: OptionChainHealthContract;
  timestampMs: number | null;
  ageMs: number | null;
  selectedPrice: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  /** null for absent/crossed sides or two zero sides; the reason is in diagnostics.warnings. */
  relativeSpread: number | null;
  timeToExpiryYears: number;
  issues: OptionChainHealthIssue[];
  model: OptionChainHealthModelResult;
  diagnostics: { warnings: QuantWarning[] };
}

export interface OptionChainHealthExpiryCoverage {
  expiresAt: number;
  style: OptionContract['style'];
  expired: boolean;
  quoteCount: number;
  selectedPriceCount: number;
  solvedCount: number;
  strikes: number[];
  callStrikes: number[];
  putStrikes: number[];
  /** Missing side at an observed strike, NOT proof that the exchange lists that side. */
  missingCallStrikes: number[];
  missingPutStrikes: number[];
  belowMinimumStrikes: boolean;
}

/** Concrete report shape, directly assignable to createAnalysisArtifact's result without a cast. */
export type OptionChainHealthReport = {
  rows: OptionChainHealthRow[];
  summary: {
    quoteCount: number;
    quotesWithIssues: number;
    issueCounts: Record<OptionChainHealthIssue, number>;
    modelStatusCounts: Record<OptionChainHealthModelStatus, number>;
    solvedCount: number;
  };
  coverage: {
    /** Sorted by expiration instant, then style (code-unit order); no locale or clock dependency. */
    expiries: OptionChainHealthExpiryCoverage[];
    expiryCount: number;
    belowMinimumExpiries: boolean;
    duplicateQuoteCount: number;
    /** null means no expected universe supplied; [] means the supplied universe is covered. */
    missingContracts: OptionChainHealthContract[] | null;
    expectedContractCount: number | null;
  };
  assumptions: Assumptions<{
    underlying: string;
    spot?: number;
    riskFreeRate?: number;
    dividendYield?: number;
    dividends: DiscreteDividend[];
    modelAssessment: 'not-requested' | 'black-scholes-merton';
    priceSource: PriceSource;
    priceUnit: 'per-underlying-share';
    impliedVolatilityUnit: 'annualized-decimal';
    /** Each row is bounded and inverted under its own contract's exercise style. */
    exercisePolicy: 'by-contract-style' | 'not-assessed';
    /** Present when a model was requested: the engine each exercise style is assessed with. */
    exerciseEngines?: { european: 'black-scholes-merton'; american: 'bjerksund-stensland-2002' };
    quotePolicy: 'report-only';
    coverageIdentity: 'underlying-expiresAt-style-type-strike';
    maximumQuoteAgeMs: number;
    maximumRelativeSpread: number;
    minimumExpiries: number;
    minimumStrikesPerExpiry: number;
    maximumQuotes: number;
    lowerVolatilityBound: number | null;
    upperVolatilityBound: number | null;
    maximumSolverIterations: number;
  }>;
  diagnostics: { warnings: QuantWarning[] };
};

const NAME = 'optionChainHealth';
const EXAMPLE_CALL =
  "optionChainHealth({ quotes: [], market: { underlying: 'X', asOf: '2026-01-01T00:00:00Z', spot: 100, riskFreeRate: 0, dividendYield: 0 }, config: { model: 'black-scholes-merton', priceSource: 'mid', maximumQuoteAgeMs: 60000, maximumRelativeSpread: 0.1 } })";
const MAX_ROWS = 10_000;
const MAX_DIVIDENDS = 1_000;
const MAX_TEXT = 256;
const MAX_DATE_MS = 8.64e15;
const PRICE_FIELDS = ['bid', 'ask', 'mid', 'last', 'mark'] as const;
const ISSUES: readonly OptionChainHealthIssue[] = [
  'stale',
  'future',
  'missing_timestamp',
  'missing_bid',
  'missing_ask',
  'missing_price',
  'crossed',
  'wide',
  'expired',
];

function invalid(field: string, message: string, code: string = ErrorCode.InputOutOfRange): never {
  throw new InputError(`${NAME}: ${field} ${message}`, {
    code,
    context: { function: NAME, field },
  });
}

function requiredField(value: unknown, field: string): void {
  if (value === undefined) throw missingFieldError(NAME, field, EXAMPLE_CALL);
}

function numberField(value: unknown, field: string, minimum = -Infinity): asserts value is number {
  requiredField(value, field);
  ensureFiniteWhenPresent(value, field, NAME);
  if ((value as number) < minimum) invalid(field, `must be ≥ ${minimum}.`);
}

function textField(value: unknown, field: string): asserts value is string {
  requiredField(value, field);
  if (typeof value !== 'string') invalid(field, 'must be a string.', ErrorCode.InputWrongType);
  if (value.length > MAX_TEXT || value.trim().length === 0) {
    invalid(field, `must be nonblank and at most ${MAX_TEXT} characters.`);
  }
}

function controlObject(value: unknown, field: string): void {
  if (field !== 'input') requiredField(value, field);
  requireArgumentObject(NAME, field, value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(field, 'must be a plain object of named controls.', ErrorCode.InputWrongType);
  }
}

function countField(value: unknown, field: string): void {
  numberField(value, field, 1);
  if (!Number.isSafeInteger(value) || value > MAX_ROWS) {
    invalid(field, `must be a positive safe integer ≤ ${MAX_ROWS}.`);
  }
}

/** Length refusal comes BEFORE reading index zero; density is validated in the subsequent pass. */
function arrayBudget(value: unknown, field: string, maximum: number): asserts value is unknown[] {
  requiredField(value, field);
  if (!Array.isArray(value)) invalid(field, 'must be a dense array.', ErrorCode.InputWrongType);
  if (value.length > maximum) invalid(field, `exceeds the ${maximum}-element work limit.`);
}

function dense(value: readonly unknown[], field: string): void {
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i))
      invalid(
        `${field}[${i}]`,
        'is a sparse slot; provide an observation.',
        ErrorCode.InputWrongShape,
      );
  }
}

function indexed<T>(field: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!isQuantError(error)) throw error;
    throw new InputError(`${NAME}: ${field}: ${error.message}`, {
      code: error.code,
      context: { function: NAME, field },
    });
  }
}

function contractData(
  contract: OptionContract,
  field: string,
  underlying: string,
): OptionChainHealthContract {
  requiredField(contract, field);
  requireArgumentObject(NAME, field, contract);
  textField(contract.underlying, `${field}.underlying`);
  if (contract.underlying !== underlying)
    invalid(
      `${field}.underlying`,
      'must match market.underlying; use a separate report per underlying.',
    );
  requiredField(contract.type, `${field}.type`);
  ensureEnum(contract.type, ['call', 'put'] as const, `${field}.type`, NAME);
  requiredField(contract.style, `${field}.style`);
  ensureEnum(contract.style, ['european', 'american'] as const, `${field}.style`, NAME);
  numberField(contract.strike, `${field}.strike`, Number.MIN_VALUE);
  textField(contract.expiry, `${field}.expiry`);
  // Check primitives before the shared cross-field validator formats them. Invalid plain JSON
  // objects must receive indexed QuantErrors, never invoke caller-controlled coercion hooks.
  numberField(contract.expiresAt, `${field}.expiresAt`);
  requiredField(contract.expiryConvention, `${field}.expiryConvention`);
  ensureEnum(
    contract.expiryConvention,
    ['us-equity-close', 'explicit-instant'] as const,
    `${field}.expiryConvention`,
    NAME,
  );
  indexed(field, () =>
    validateResolvedExpiry(NAME, contract.expiry, contract.expiresAt, contract.expiryConvention),
  );
  // These fields affect support, so validate them even though no accounting metadata is copied.
  if (contract.adjusted !== undefined && typeof contract.adjusted !== 'boolean')
    invalid(`${field}.adjusted`, 'must be boolean when present.', ErrorCode.InputWrongType);
  if (contract.deliverable !== undefined) {
    requireArgumentObject(NAME, `${field}.deliverable`, contract.deliverable);
  }
  return {
    underlying: contract.underlying,
    type: contract.type,
    style: contract.style,
    strike: contract.strike,
    expiry: contract.expiry,
    expiresAt: contract.expiresAt,
    expiryConvention: contract.expiryConvention,
  };
}

function identity(contract: OptionChainHealthContract): string {
  return JSON.stringify([
    contract.underlying,
    contract.expiresAt,
    contract.style,
    contract.type,
    contract.strike,
  ]);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareContracts(a: OptionChainHealthContract, b: OptionChainHealthContract): number {
  return (
    a.expiresAt - b.expiresAt ||
    compareText(a.style, b.style) ||
    a.strike - b.strike ||
    compareText(a.type, b.type) ||
    compareText(a.expiry, b.expiry)
  );
}

function warn(code: string, message: string): QuantWarning {
  return { code: `options.chain_health.${code}`, message, severity: 'warn' };
}

function modelResult(reason: string): OptionChainHealthModelResult {
  return {
    status: 'not-evaluated',
    engine: null,
    bounds: null,
    unsupportedReasons: [],
    impliedVolatility: null,
    solver: {
      status: 'not-run',
      method: 'brent',
      converged: false,
      iterations: 0,
      reason,
      priceResidual: null,
    },
  };
}

/** The residual an accepted inverse must reprice within, per share (relative, floored at MIN_VALUE). */
function acceptableResidual(selectedPrice: number): number {
  return Math.max(1e-7 * selectedPrice, Number.MIN_VALUE);
}

function evaluateModel(input: {
  quote: OptionChainHealthQuote;
  market: (OptionChainHealthModelMarket & { dividendYield: number; asOf: number }) | null;
  americanEngine: OptionPricingEngine;
  selectedPrice: number | null;
  timeToExpiryYears: number;
  crossed: boolean;
  lowerVolatilityBound: number;
  upperVolatilityBound: number;
}): OptionChainHealthModelResult {
  const {
    quote,
    market,
    americanEngine,
    selectedPrice,
    timeToExpiryYears,
    crossed,
    lowerVolatilityBound,
    upperVolatilityBound,
  } = input;
  const result = modelResult('missing_price');
  if (market === null) {
    result.status = 'not-requested';
    result.solver.method = null;
    result.solver.reason = 'model_assessment_not_requested';
    return result;
  }
  const american = quote.contract.style === 'american';
  result.engine = american ? 'bjerksund-stensland-2002' : 'black-scholes-merton';
  if (market.dividends !== undefined && market.dividends.length > 0)
    result.unsupportedReasons.push('discrete_dividends');
  if (quote.contract.adjusted === true || quote.contract.deliverable !== undefined)
    result.unsupportedReasons.push('adjusted_deliverable');
  if (result.unsupportedReasons.length > 0) {
    result.status = 'unsupported';
    result.solver.reason = 'unsupported_assumptions';
    return result;
  }
  if (timeToExpiryYears <= 0) {
    result.solver.reason = 'expired';
    return result;
  }
  if (crossed) {
    result.solver.reason = 'crossed_market';
    return result;
  }
  if (selectedPrice === null) return result;
  if (american) {
    // The American row is bounded and inverted by the one engine-inversion kernel every American
    // door uses: the undiscounted intrinsic-to-spot/strike band, then Brent over the engine on
    // exactly the configured σ bracket (never widened — it is the caller's resolvability window).
    const inversion = invertEngine({
      functionName: NAME,
      contract: quote.contract,
      market: {
        spot: market.spot,
        riskFreeRate: market.riskFreeRate,
        dividendYield: market.dividendYield,
        asOf: market.asOf,
        price: selectedPrice,
      },
      engine: americanEngine,
      bracket: { lowerVolatilityBound, upperVolatilityBound },
    });
    result.bounds = inversion.bounds;
    result.solver.iterations = inversion.iterations;
    switch (inversion.status) {
      case 'below-lower-bound':
      case 'above-upper-bound':
        result.status = 'model-incompatible';
        result.solver.reason =
          inversion.status === 'below-lower-bound'
            ? 'below_model_lower_bound'
            : 'above_model_upper_bound';
        return result;
      case 'no-time-value':
        result.status = 'compatible';
        result.solver.status = 'unavailable';
        result.solver.reason = 'no_identifiable_time_value';
        return result;
      case 'no-convergence':
        result.status = 'compatible';
        result.solver.status = 'failed';
        result.solver.reason = inversion.belowFloor
          ? 'price_below_resolvable'
          : inversion.aboveCeiling
            ? 'price_above_resolvable'
            : 'no_convergence';
        return result;
      case 'solved': {
        result.status = 'compatible';
        if (inversion.residual! <= acceptableResidual(selectedPrice)) {
          result.impliedVolatility = inversion.value;
          result.solver = {
            status: 'converged',
            method: 'brent',
            converged: true,
            iterations: inversion.iterations,
            reason: null,
            priceResidual: inversion.residual,
          };
        } else {
          result.solver.status = 'failed';
          result.solver.reason = 'repricing_residual_not_acceptable';
        }
        return result;
      }
    }
  }
  const pricing = {
    type: quote.contract.type,
    spot: market.spot,
    strike: quote.contract.strike,
    timeToExpiryYears,
    riskFreeRate: market.riskFreeRate,
    dividendYield: market.dividendYield,
  };
  const bounds = blackScholesPriceBounds(pricing);
  // Both discounted legs must be representable. A call's lower bound can hide an overflowed
  // discounted strike behind max(0, -Infinity), and the put has the symmetric failure.
  const oppositeBounds = blackScholesPriceBounds({
    ...pricing,
    type: pricing.type === 'call' ? 'put' : 'call',
  });
  if (
    !Number.isFinite(bounds.lower) ||
    !Number.isFinite(bounds.upper) ||
    bounds.upper <= 0 ||
    !Number.isFinite(oppositeBounds.upper) ||
    oppositeBounds.upper <= 0
  ) {
    result.status = 'unavailable';
    result.solver.reason = 'non_finite_or_underflowed_model_bounds';
    return result;
  }
  result.bounds = bounds;
  // Strict comparisons describe model compatibility, not quote validity. The solver's own
  // tolerance is preserved separately in its reason if it refuses a near-boundary inverse.
  if (selectedPrice < bounds.lower || selectedPrice > bounds.upper) {
    result.status = 'model-incompatible';
    result.solver.reason =
      selectedPrice < bounds.lower ? 'below_model_lower_bound' : 'above_model_upper_bound';
    return result;
  }
  result.status = 'compatible';
  if (selectedPrice === bounds.lower || selectedPrice === bounds.upper) {
    result.solver.status = 'unavailable';
    result.solver.reason =
      selectedPrice === bounds.lower
        ? 'no_identifiable_time_value'
        : 'upper_bound_no_finite_implied_volatility';
    return result;
  }
  const solved = blackScholesImpliedVolatility({
    ...pricing,
    price: selectedPrice,
    lowerVolatilityBound,
    upperVolatilityBound,
  });
  result.solver.iterations = solved.iterations;
  result.solver.status = 'failed';
  result.solver.reason = solved.reason ?? 'no_convergence';
  if (solved.converged && Number.isFinite(solved.value) && solved.value > 0) {
    const repriced = blackScholesPrice({ ...pricing, volatility: solved.value });
    const residual = Math.abs(repriced - selectedPrice);
    if (Number.isFinite(residual) && residual <= acceptableResidual(selectedPrice)) {
      result.impliedVolatility = solved.value;
      result.solver = {
        status: 'converged',
        method: 'brent',
        converged: true,
        iterations: solved.iterations,
        reason: null,
        priceResidual: residual,
      };
    } else {
      result.solver.reason = 'repricing_residual_not_acceptable';
    }
  }
  return result;
}

/**
 * Consolidated chain-health report. Structural malformations throw indexed InputError; absent
 * prices/timestamps, empty chains and unavailable inverses are valid reports, never fake IVs.
 *
 * Omit config.model for quote health and coverage only: market needs just underlying and asOf,
 * with no invented spot/rate/yield. Each model.status is 'not-requested', bounds/IV are null and
 * the solver is not run. Select config.model: 'black-scholes-merton' to additionally assess
 * compatibility under BSM dynamics, supplying market.spot and riskFreeRate (dividendYield follows
 * the package rule: omitted is 0, echoed and disclosed). Each row is assessed under its OWN
 * exercise style — a European row against the discounted closed-form band and inverse, an American
 * row against the undiscounted intrinsic band and the Bjerksund–Stensland 2002 engine — never as
 * the other style. This is quote health plus SELECTED model compatibility, NOT certification of all
 * option pricing. Nonempty canonical DiscreteDividend schedules and adjusted deliverables report
 * unsupported; no escrowed-dividend approximation is performed here.
 *
 * No clock, rate, exercise, or quote-source inference. Prices are per underlying share;
 * multiplier and unconsumed provider fields are ignored. Stale/future/wide quotes are retained and
 * may be inverted with their warnings attached; crossed markets are not inverted. BSM compatibility
 * is NOT proof of quote validity, nor is incompatibility proof of a bad market observation. This
 * report checks individual model bounds, not cross-strike/calendar static arbitrage.
 *
 * Controls are closed. Quote/contract/dividend observations are open and never mutated. Coverage
 * counts all observations (including expired/unavailable), not an automatically filtered universe.
 * Expected contracts use pricing identity; different venue/multiplier metadata does not create a
 * second slot. A missing call/put side is only an observed-grid gap unless explicitly expected.
 *
 * Work: ≤10,000 quotes, ≤10,000 expected contracts, ≤1,000 dividends, bounded strings and at most
 * 100 Brent iterations per quote. All lengths are checked before row traversal or result allocation.
 * Rows preserve input order; coverage and missing-contract identities are sorted deterministically.
 *
 * @example
 * ```ts
 * import { option, optionChainHealth } from '@totalfinance/options';
 *
 * const contract = option.call({
 *   underlying: 'X', style: 'european', strike: 100,
 *   expiry: '2027-01-01T00:00:00Z',
 * });
 * const report = optionChainHealth({
 *   quotes: [{ contract, timestampMs: 1767225600000, bid: 7.9, ask: 8.1 }],
 *   market: { underlying: 'X', spot: 100, asOf: '2026-01-01T00:00:00Z', riskFreeRate: 0, dividendYield: 0 },
 *   config: {
 *     model: 'black-scholes-merton', priceSource: 'mid', maximumQuoteAgeMs: 60_000,
 *     maximumRelativeSpread: 0.1,
 *   },
 * });
 * if (!report.rows[0]?.model.solver.converged) throw new Error('IV unavailable');
 * // One-year ATM price 8 => annualized IV about 0.20086744, NOT an assumed 20%.
 * if (Math.abs(report.rows[0].model.impliedVolatility! - 0.20086744) > 1e-7) throw new Error('Unexpected IV');
 * if (report.coverage.expiries[0]?.missingPutStrikes[0] !== 100) throw new Error('Expected unobserved put side');
 *
 * const quotesOnly = optionChainHealth({
 *   quotes: [{ contract, timestampMs: 1767225600000, bid: 9, ask: 7 }],
 *   market: { underlying: 'X', asOf: '2026-01-01T00:00:00Z' },
 *   config: { priceSource: 'mid', maximumQuoteAgeMs: 60_000, maximumRelativeSpread: 0.1 },
 * });
 * if (quotesOnly.summary.issueCounts.crossed !== 1) throw new Error('Expected crossed quote');
 * if (quotesOnly.rows[0]?.model.status !== 'not-requested') throw new Error('No model requested');
 * ```
 */
export function optionChainHealth(input: OptionChainHealthInput): OptionChainHealthReport {
  controlObject(input, 'input');
  ensureKnownKeys(NAME, 'input', input, ['quotes', 'market', 'config', 'expectedContracts']);
  controlObject(input.config, 'config');
  const { config, market } = input;
  ensureKnownKeys(NAME, 'config', config, [
    'model',
    'priceSource',
    'maximumQuoteAgeMs',
    'maximumRelativeSpread',
    'minimumExpiries',
    'minimumStrikesPerExpiry',
    'maximumQuotes',
    'solver',
  ]);
  controlObject(market, 'market');
  ensureKnownKeys(NAME, 'market', market, [
    'underlying',
    'spot',
    'asOf',
    'riskFreeRate',
    'dividendYield',
    'dividends',
  ]);
  if (config.model !== undefined)
    ensureEnum(config.model, ['black-scholes-merton'] as const, 'config.model', NAME);
  requiredField(config.priceSource, 'config.priceSource');
  ensureEnum(
    config.priceSource,
    ['bid', 'ask', 'mid', 'last', 'mark'] as const,
    'config.priceSource',
    NAME,
  );
  numberField(config.maximumQuoteAgeMs, 'config.maximumQuoteAgeMs', 0);
  numberField(config.maximumRelativeSpread, 'config.maximumRelativeSpread', 0);
  if (config.minimumExpiries !== undefined)
    countField(config.minimumExpiries, 'config.minimumExpiries');
  if (config.minimumStrikesPerExpiry !== undefined)
    countField(config.minimumStrikesPerExpiry, 'config.minimumStrikesPerExpiry');
  const minimumExpiries = config.minimumExpiries ?? 1;
  const minimumStrikesPerExpiry = config.minimumStrikesPerExpiry ?? 1;
  if (config.maximumQuotes !== undefined) countField(config.maximumQuotes, 'config.maximumQuotes');
  const maximumQuotes = config.maximumQuotes ?? MAX_ROWS;
  if (config.solver !== undefined) {
    if (config.model === undefined)
      invalid(
        'config.solver',
        "requires config.model: 'black-scholes-merton'; omit solver for quote-only health.",
      );
    controlObject(config.solver, 'config.solver');
    ensureKnownKeys(NAME, 'config.solver', config.solver, [
      'lowerVolatilityBound',
      'upperVolatilityBound',
    ]);
    for (const key of ['lowerVolatilityBound', 'upperVolatilityBound'] as const) {
      if (config.solver[key] !== undefined)
        numberField(config.solver[key], `config.solver.${key}`, Number.MIN_VALUE);
    }
  }
  const lowerVolatilityBound = config.solver?.lowerVolatilityBound ?? 1e-7;
  const upperVolatilityBound = config.solver?.upperVolatilityBound ?? 5;
  if (lowerVolatilityBound >= upperVolatilityBound)
    invalid('config.solver', 'requires 0 < lowerVolatilityBound < upperVolatilityBound.');
  // Check ALL lengths before traversing ANY observation array (including malformed later arrays).
  arrayBudget(input.quotes, 'quotes', maximumQuotes);
  if (input.expectedContracts !== undefined)
    arrayBudget(input.expectedContracts, 'expectedContracts', MAX_ROWS);
  if (market.dividends !== undefined)
    arrayBudget(market.dividends, 'market.dividends', MAX_DIVIDENDS);
  textField(market.underlying, 'market.underlying');
  if (config.model !== undefined || market.spot !== undefined)
    numberField(market.spot, 'market.spot', Number.MIN_VALUE);
  if (config.model !== undefined || market.riskFreeRate !== undefined)
    numberField(market.riskFreeRate, 'market.riskFreeRate');
  if (market.dividendYield !== undefined) numberField(market.dividendYield, 'market.dividendYield');
  // The package dividend rule: an omitted yield is 0, echoed, and disclosed below when a model
  // assessment actually used the default.
  const dividendYieldDefaulted = config.model !== undefined && market.dividendYield === undefined;
  requiredField(market.asOf, 'market.asOf');
  if (typeof market.asOf === 'number') numberField(market.asOf, 'market.asOf');
  if (typeof market.asOf === 'string') textField(market.asOf, 'market.asOf');
  const asOf = indexed('market.asOf', () => resolveValuationAsOf(market.asOf, NAME));
  if (Math.abs(asOf) > MAX_DATE_MS)
    invalid('market.asOf', 'must be within the representable date range (±8.64e15 ms).');
  const modelMarket:
    | (OptionChainHealthModelMarket & { dividendYield: number; asOf: number })
    | null =
    config.model === undefined
      ? null
      : {
          ...market,
          spot: market.spot!,
          riskFreeRate: market.riskFreeRate!,
          dividendYield: market.dividendYield ?? 0,
          asOf,
        };
  const americanEngine = engines.bjerksundStensland2002();
  dense(input.quotes, 'quotes');
  if (input.expectedContracts !== undefined) dense(input.expectedContracts, 'expectedContracts');
  if (market.dividends !== undefined) {
    dense(market.dividends, 'market.dividends');
    for (let i = 0; i < market.dividends.length; i++) {
      const dividend = market.dividends[i]!;
      const field = `market.dividends[${i}]`;
      requireArgumentObject(NAME, field, dividend);
      textField(dividend.exDate, `${field}.exDate`);
      indexed(`${field}.exDate`, () => resolveAsOf(dividend.exDate, NAME));
      numberField(dividend.amount, `${field}.amount`, 0);
    }
  }
  // Validate the full request before any inversion, including expected-universe malformations.
  const expected = input.expectedContracts?.map((contract, i) =>
    contractData(contract, `expectedContracts[${i}]`, market.underlying),
  );
  const contracts = input.quotes.map((quote, i) => {
    const field = `quotes[${i}]`;
    requireArgumentObject(NAME, field, quote);
    const contract = contractData(quote.contract, `${field}.contract`, market.underlying);
    for (const key of PRICE_FIELDS)
      if (quote[key] !== undefined) numberField(quote[key], `${field}.${key}`, 0);
    if (quote.timestampMs !== undefined) {
      numberField(quote.timestampMs, `${field}.timestampMs`);
      if (Math.abs(quote.timestampMs) > MAX_DATE_MS)
        invalid(`${field}.timestampMs`, 'must be within ±8.64e15 epoch ms.');
    }
    return contract;
  });
  const rows = input.quotes.map((quote, quoteIndex): OptionChainHealthRow => {
    const contract = contracts[quoteIndex]!;
    const issues: OptionChainHealthIssue[] = [];
    const warnings: QuantWarning[] = [];
    const ageMs = quote.timestampMs === undefined ? null : asOf - quote.timestampMs;
    if (ageMs === null) issues.push('missing_timestamp');
    else if (ageMs < 0) issues.push('future');
    else if (ageMs > config.maximumQuoteAgeMs) issues.push('stale');
    if (quote.bid === undefined) issues.push('missing_bid');
    if (quote.ask === undefined) issues.push('missing_ask');
    const crossed = quote.bid !== undefined && quote.ask !== undefined && quote.bid > quote.ask;
    const spread =
      quote.bid === undefined || quote.ask === undefined ? null : quote.ask - quote.bid;
    // Sum before halving preserves subnormal midpoint rounding (including equal MIN_VALUE
    // sides). If the sum overflows, both halves are large enough to divide exactly first.
    const sideSum =
      quote.bid === undefined || quote.ask === undefined ? null : quote.bid + quote.ask;
    const midpoint =
      sideSum === null
        ? null
        : Number.isFinite(sideSum)
          ? sideSum / 2
          : quote.bid! / 2 + quote.ask! / 2;
    // Normalize by the positive ask, not the already-rounded midpoint. For bid=MIN_VALUE,
    // ask=4*MIN_VALUE the exact ratio is 1.2 even though the midpoint cannot represent 2.5 units.
    const relativeSpread =
      spread === null || crossed || quote.ask === 0
        ? null
        : (2 * (spread / quote.ask!)) / (1 + quote.bid! / quote.ask!);
    if (crossed) issues.push('crossed');
    if (relativeSpread !== null && relativeSpread > config.maximumRelativeSpread)
      issues.push('wide');
    const selectedPrice =
      config.priceSource === 'mid' ? (quote.mid ?? midpoint) : (quote[config.priceSource] ?? null);
    if (selectedPrice === null) issues.push('missing_price');
    const timeToExpiryYears = yearFraction(asOf, contract.expiresAt, 'ACT/365F');
    if (timeToExpiryYears <= 0) issues.push('expired');
    issues.sort((a, b) => ISSUES.indexOf(a) - ISSUES.indexOf(b));
    for (const issue of issues)
      warnings.push(
        warn(
          issue,
          `quotes[${quoteIndex}]: ${issue}; observation retained, not automatically filtered.`,
        ),
      );
    if (relativeSpread === null)
      warnings.push(
        warn(
          'relative_spread_unavailable',
          `quotes[${quoteIndex}].relativeSpread is null: sides are absent/crossed or both zero.`,
        ),
      );
    const model = evaluateModel({
      quote,
      market: modelMarket,
      americanEngine,
      selectedPrice,
      timeToExpiryYears,
      crossed,
      lowerVolatilityBound,
      upperVolatilityBound,
    });
    if (model.status !== 'not-requested' && !model.solver.converged)
      warnings.push(
        warn(
          'implied_volatility_unavailable',
          `quotes[${quoteIndex}]: ${model.solver.reason}; model status ${model.status}. This is not proof of a bad quote.`,
        ),
      );
    return {
      quoteIndex,
      contract,
      timestampMs: quote.timestampMs ?? null,
      ageMs,
      selectedPrice,
      bid: quote.bid ?? null,
      ask: quote.ask ?? null,
      spread,
      relativeSpread,
      timeToExpiryYears,
      issues,
      model,
      diagnostics: { warnings },
    };
  });
  const groups = new Map<
    string,
    { rows: OptionChainHealthRow[]; strikes: Set<number>; calls: Set<number>; puts: Set<number> }
  >();
  const seen = new Set<string>();
  let duplicateQuoteCount = 0;
  for (const row of rows) {
    const key = JSON.stringify([row.contract.expiresAt, row.contract.style]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { rows: [], strikes: new Set(), calls: new Set(), puts: new Set() };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.strikes.add(row.contract.strike);
    (row.contract.type === 'call' ? group.calls : group.puts).add(row.contract.strike);
    const quoteIdentity = identity(row.contract);
    if (seen.has(quoteIdentity)) duplicateQuoteCount++;
    seen.add(quoteIdentity);
  }
  const sorted = (values: Set<number>): number[] => [...values].sort((a, b) => a - b);
  const expiries = [...groups.values()]
    .map(
      (group): OptionChainHealthExpiryCoverage => ({
        expiresAt: group.rows[0]!.contract.expiresAt,
        style: group.rows[0]!.contract.style,
        expired: group.rows[0]!.contract.expiresAt <= asOf,
        quoteCount: group.rows.length,
        selectedPriceCount: group.rows.filter((row) => row.selectedPrice !== null).length,
        solvedCount: group.rows.filter((row) => row.model.solver.converged).length,
        strikes: sorted(group.strikes),
        callStrikes: sorted(group.calls),
        putStrikes: sorted(group.puts),
        missingCallStrikes: sorted(group.strikes).filter((strike) => !group.calls.has(strike)),
        missingPutStrikes: sorted(group.strikes).filter((strike) => !group.puts.has(strike)),
        belowMinimumStrikes: group.strikes.size < minimumStrikesPerExpiry,
      }),
    )
    .sort((a, b) => a.expiresAt - b.expiresAt || compareText(a.style, b.style));
  const expectedUnique =
    expected === undefined ? null : new Map<string, OptionChainHealthContract>();
  for (const contract of expected?.sort(compareContracts) ?? [])
    expectedUnique!.set(identity(contract), contract);
  const missingContracts =
    expectedUnique === null
      ? null
      : [...expectedUnique.values()].filter((contract) => !seen.has(identity(contract)));
  const expiryCount = new Set(expiries.map((expiry) => expiry.expiresAt)).size;
  const issueCounts: Record<OptionChainHealthIssue, number> = {
    stale: 0,
    future: 0,
    missing_timestamp: 0,
    missing_bid: 0,
    missing_ask: 0,
    missing_price: 0,
    crossed: 0,
    wide: 0,
    expired: 0,
  };
  const modelStatusCounts: Record<OptionChainHealthModelStatus, number> = {
    'not-requested': 0,
    compatible: 0,
    'model-incompatible': 0,
    unsupported: 0,
    'not-evaluated': 0,
    unavailable: 0,
  };
  for (const row of rows) {
    for (const issue of row.issues) issueCounts[issue]++;
    modelStatusCounts[row.model.status]++;
  }
  const warnings: QuantWarning[] = [];
  if (config.model === undefined)
    warnings.push({
      code: WarningCode.OptionsChainHealthModelNotRequested,
      severity: 'info',
      message:
        'Quote health and coverage only: model bounds and implied volatility are null because no model assessment was requested. No spot, rate, yield, or exercise approximation was assumed.',
    });
  if (dividendYieldDefaulted)
    warnings.push(
      warn(
        'dividend_yield_defaulted',
        'market.dividendYield was omitted; the model assessment assumed a continuous yield of 0 (echoed in assumptions.dividendYield). Pass the yield to assess a dividend payer.',
      ),
    );
  if (rows.length === 0)
    warnings.push(
      warn('empty_chain', 'No observed quotes; IV and observed coverage are unavailable.'),
    );
  for (const issue of ISSUES)
    if (issueCounts[issue] > 0)
      warnings.push(warn(issue, `${issueCounts[issue]} quote(s): ${issue}. See rows for details.`));
  const unsolved = rows.filter((row) => !row.model.solver.converged).length;
  if (unsolved > 0 && config.model !== undefined)
    warnings.push(
      warn(
        'implied_volatility_unavailable',
        `${unsolved} quote(s) have no accepted IV; see per-row model/solver reasons. Model incompatibility is not proof of a bad quote.`,
      ),
    );
  if (duplicateQuoteCount > 0)
    warnings.push(
      warn(
        'duplicate_quotes',
        `${duplicateQuoteCount} duplicate pricing-identity observation(s) retained; coverage counts distinct slots.`,
      ),
    );
  if (
    expiryCount < minimumExpiries ||
    expiries.some(
      (expiry) =>
        expiry.belowMinimumStrikes ||
        expiry.missingCallStrikes.length > 0 ||
        expiry.missingPutStrikes.length > 0,
    ) ||
    (missingContracts?.length ?? 0) > 0
  )
    warnings.push(
      warn(
        'sparse_coverage',
        'Observed expiry/strike coverage is sparse against configured minima, paired sides, or the explicit expected universe. No listing universe was inferred.',
      ),
    );
  if (rows.some((row) => row.relativeSpread === null))
    warnings.push(
      warn(
        'relative_spread_unavailable',
        'Some relative spreads are null; see per-row diagnostics for reasons.',
      ),
    );
  const report: OptionChainHealthReport = {
    rows,
    summary: {
      quoteCount: rows.length,
      quotesWithIssues: rows.filter((row) => row.issues.length > 0).length,
      issueCounts,
      modelStatusCounts,
      solvedCount: rows.length - unsolved,
    },
    coverage: {
      expiries,
      expiryCount,
      belowMinimumExpiries: expiryCount < minimumExpiries,
      duplicateQuoteCount,
      missingContracts,
      expectedContractCount: expectedUnique?.size ?? null,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      ...(config.model === undefined
        ? {}
        : {
            model: config.model,
            compounding: 'continuous' as const,
            exerciseEngines: {
              european: 'black-scholes-merton' as const,
              american: 'bjerksund-stensland-2002' as const,
            },
          }),
      modelAssessment: config.model ?? 'not-requested',
      dayCount: 'ACT/365F',
      asOf,
      underlying: market.underlying,
      ...(market.spot === undefined ? {} : { spot: market.spot }),
      ...(market.riskFreeRate === undefined ? {} : { riskFreeRate: market.riskFreeRate }),
      ...(modelMarket === null
        ? market.dividendYield === undefined
          ? {}
          : { dividendYield: market.dividendYield }
        : { dividendYield: modelMarket.dividendYield }),
      ...(modelMarket === null
        ? {}
        : {
            dividendModel: market.dividends?.length
              ? ('discreteSchedule' as const)
              : modelMarket.dividendYield === 0
                ? ('none' as const)
                : ('continuousYield' as const),
          }),
      dividends: market.dividends?.map(({ exDate, amount }) => ({ exDate, amount })) ?? [],
      priceSource: config.priceSource,
      priceUnit: 'per-underlying-share',
      impliedVolatilityUnit: 'annualized-decimal',
      exercisePolicy: config.model === undefined ? 'not-assessed' : 'by-contract-style',
      quotePolicy: 'report-only',
      coverageIdentity: 'underlying-expiresAt-style-type-strike',
      maximumQuoteAgeMs: config.maximumQuoteAgeMs,
      maximumRelativeSpread: config.maximumRelativeSpread,
      minimumExpiries,
      minimumStrikesPerExpiry,
      maximumQuotes,
      lowerVolatilityBound: config.model === undefined ? null : lowerVolatilityBound,
      upperVolatilityBound: config.model === undefined ? null : upperVolatilityBound,
      maximumSolverIterations: config.model === undefined ? 0 : 100,
    },
    diagnostics: { warnings },
  };
  return requireRepresentableResult(NAME, report);
}
