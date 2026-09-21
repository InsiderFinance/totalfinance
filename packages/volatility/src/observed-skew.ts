/** Observed-chain skew: supplied IV/delta only, with no surface fit or pricing-model inference. */
import {
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  type MarketInputs,
  type OptionQuote,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  missingFieldError,
  requireArgumentObject,
  requireFiniteFields,
  resolveValuationAsOf,
  resolvedExpiry,
  validateResolvedExpiry,
  yearFraction,
} from '@totalfinance/core';
import type { RiskReversalConvention } from './skew.js';

/** Canonical quote plus vendor delta. Records are open to vendor decoration, never mutated. */
export interface ObservedSkewConfig {
  /** Exact expiry label in the chain; no nearest-expiry substitution. */
  expiry: string;
  /** Default callMinusPut. Equity put-skew displays should explicitly select putMinusCall. */
  riskReversalConvention?: RiskReversalConvention;
  /** Minimum IV-bearing quote records before aggregate reads are available; default 6, integer ≥ 1. */
  minimumContracts?: number;
  /** Maximum absolute signed-delta distance from ±0.25; default 0.12, in [0, 1]. */
  deltaTolerance?: number;
  /** Maximum absolute signed-delta distance from ±0.10; default 0.05, in [0, 1]. */
  tailDeltaTolerance?: number;
  /** Symmetric K/spot − 1 window for OLS; default 0.10, in (0, 1]. Needs ≥ 4 OTM points. */
  slopeWindow?: number;
}

export interface ObservedSkewInput {
  quotes: readonly OptionQuote[];
  /** No rate, yield, volatility, clock default, or forward inference is used. */
  market: Pick<MarketInputs, 'spot' | 'asOf'>;
  config: ObservedSkewConfig;
}

/** Reasons are data availability, not malformed-input errors (which throw typed InputError). */
export type ObservedSkewUnavailableReason =
  | 'expiry_not_found'
  | 'expired'
  | 'insufficient_contracts'
  | 'no_usable_implied_volatility'
  | 'missing_delta'
  | 'outside_delta_tolerance'
  | 'missing_wing'
  | 'missing_otm_side'
  | 'insufficient_slope_points'
  | 'degenerate_moneyness'
  | 'non_finite_result';

/** An actual supplied observation. quoteIndex traces back to the original input, not a sorted copy. */
export interface ObservedSkewObservation {
  quoteIndex: number;
  type: 'call' | 'put';
  strike: number;
  impliedVolatility: number;
  delta: number | null;
  openInterest: number | null;
  timestampMs: number;
}

export interface ObservedSkewAtm {
  strike: number;
  /** Arithmetic mean of ALL usable observations at the nearest spot strike (decimal IV). */
  impliedVolatility: number;
  observations: ObservedSkewObservation[];
}

export interface ObservedSkewWing {
  targetDelta: number;
  tolerance: number;
  selected: ObservedSkewObservation | null;
  /** Distance of the nearest eligible delta, even when rejected by the tolerance gate. */
  nearestDeltaDistance: number | null;
  unavailableReason: ObservedSkewUnavailableReason | null;
}

export interface ObservedSkewSmilePoint {
  strike: number;
  /** K/spot − 1, NOT log-moneyness. */
  moneyness: number;
  call: ObservedSkewObservation | null;
  put: ObservedSkewObservation | null;
  /** Put below spot, call at/above spot; never replaced with an ITM-side quote. Decimal IV. */
  otmImpliedVolatility: number | null;
  otmUnavailableReason: 'missing_otm_side' | null;
  /** Decimal IV spread to the mean ATM read; unavailable when either input is unavailable. */
  impliedVolatilityVsAtm: number | null;
}

export interface ObservedSkewMetrics {
  expiry: string;
  expiresAt: number;
  /** Signed ACT/365F horizon; analytics are unavailable at/after expiry. */
  timeToExpiryYears: number;
  /** Ceiling of positive elapsed 24-hour days to expiry, not trading-day count. */
  daysToExpiry: number;
  underlying: string | null;
  /** Selected-expiry, non-future, IV-bearing observations (missing delta still counts). */
  contractCount: number;
  /** Non-null gates all aggregate metrics; raw smile observations remain available for inspection. */
  unavailableReason: ObservedSkewUnavailableReason | null;
  atm: ObservedSkewAtm | null;
  put25Delta: ObservedSkewWing;
  call25Delta: ObservedSkewWing;
  put10Delta: ObservedSkewWing;
  call10Delta: ObservedSkewWing;
  /** Decimal IV differences, signed per the echoed RR convention. */
  riskReversal25Delta: number | null;
  riskReversal10Delta: number | null;
  /** Mean of observed wings minus mean ATM, in decimal IV. */
  butterfly25Delta: number | null;
  butterfly10Delta: number | null;
  /**
   * OLS d(decimal IV)/d(K/spot − 1), using ≥ 4 observed OTM smile points inside slopeWindow.
   * Numerically identical to IV percentage points per 1% moneyness; NOT the model skew's log slope.
   */
  skewSlope: number | null;
  slopePointCount: number;
  unavailableReasons: {
    atm: ObservedSkewUnavailableReason | null;
    riskReversal25Delta: ObservedSkewUnavailableReason | null;
    riskReversal10Delta: ObservedSkewUnavailableReason | null;
    butterfly25Delta: ObservedSkewUnavailableReason | null;
    butterfly10Delta: ObservedSkewUnavailableReason | null;
    skewSlope: ObservedSkewUnavailableReason | null;
  };
  /** Ascending strikes, with actual side observations for app smile/term-read conversion. */
  smile: ObservedSkewSmilePoint[];
  excludedQuotes: Array<{
    quoteIndex: number;
    reason: 'other_expiry' | 'future_quote' | 'missing_implied_volatility';
  }>;
}

export type ObservedSkewAssumptions = {
  spot: number;
  impliedVolatilitySource: 'provided';
  deltaSource: 'provided';
  atmMethod: 'nearest-spot-strike-mean';
  wingMethod: 'nearest-provided-delta';
  smileMethod: 'observed-otm-only';
  slopeMethod: 'ols-implied-volatility-vs-moneyness';
  /** Lower strike wins equal distances. Same-strike ties use latest timestamp, then delta, IV, OI. */
  tieBreak: 'lower-strike-latest-timestamp-delta-implied-volatility-open-interest-input-index';
  /** ATM/sample counts retain all rows; smile sides choose one actual row by the tie-break rule. */
  duplicatePolicy: 'retain-observations-select-smile-side';
  riskReversalConvention: RiskReversalConvention;
  minimumContracts: number;
  deltaTolerance: number;
  tailDeltaTolerance: number;
  slopeWindow: number;
};

export type ObservedSkewResult = Computed<ObservedSkewMetrics, ObservedSkewAssumptions>;

const FN = 'observedSkew';
const EXAMPLE =
  "observedSkew({ quotes, market: { spot: 100, asOf: '2026-06-01T20:00:00Z' }, config: { expiry: '2026-07-17' } })";

function requiredObject(value: unknown, path: string): void {
  if (value === undefined) throw missingFieldError(FN, path, EXAMPLE);
  requireArgumentObject(FN, path, value);
}

function requiredString(value: unknown, path: string): void {
  if (value === undefined) throw missingFieldError(FN, path, EXAMPLE);
  if (typeof value !== 'string') {
    throw new InputError(`${FN}: ${path} must be a string.`, {
      code: ErrorCode.InputWrongType,
      context: { field: path, received: value === null ? 'null' : typeof value },
    });
  }
  if (value.trim().length === 0) {
    throw new InputError(`${FN}: ${path} must not be empty.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: path },
    });
  }
}

function enumField(value: unknown, path: string, allowed: readonly string[]): void {
  if (value === undefined) throw missingFieldError(FN, path, EXAMPLE);
  if (!allowed.includes(value as string)) {
    throw new InputError(`${FN}: ${path} must be ${allowed.join(' | ')}.`, {
      code: ErrorCode.InputInvalidEnum,
      context: { field: path, allowed },
    });
  }
}

function timestamp(value: number, path: string): void {
  ensureFinite(value, path, FN);
  if (Math.abs(value) > 8.64e15) {
    throw new InputError(`${FN}: ${path} must be representable epoch milliseconds.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: path, value },
    });
  }
}

function validateInput(input: ObservedSkewInput): number {
  requiredObject(input, 'input');
  ensureKnownKeys(FN, 'input', input, ['quotes', 'market', 'config']);
  if (input.quotes === undefined) throw missingFieldError(FN, 'quotes', EXAMPLE);
  if (!Array.isArray(input.quotes)) {
    throw new InputError(`${FN}: quotes must be an array of canonical option quotes. ${EXAMPLE}`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'quotes' },
    });
  }
  requiredObject(input.market, 'market');
  ensureKnownKeys(FN, 'market', input.market, ['spot', 'asOf']);
  requireFiniteFields(FN, input.market, ['spot'], { path: 'market', exampleCall: EXAMPLE });
  ensurePositive(input.market.spot, 'market.spot', FN);
  if (input.market.asOf === undefined) throw missingFieldError(FN, 'market.asOf', EXAMPLE);
  if (typeof input.market.asOf === 'number') ensureFinite(input.market.asOf, 'market.asOf', FN);
  const asOf = resolveValuationAsOf(input.market.asOf, FN);
  timestamp(asOf, 'market.asOf');
  requiredObject(input.config, 'config');
  ensureKnownKeys(FN, 'config', input.config, [
    'expiry',
    'riskReversalConvention',
    'minimumContracts',
    'deltaTolerance',
    'tailDeltaTolerance',
    'slopeWindow',
  ]);
  requiredString(input.config.expiry, 'config.expiry');
  if (input.config.riskReversalConvention !== undefined) {
    enumField(input.config.riskReversalConvention, 'config.riskReversalConvention', [
      'callMinusPut',
      'putMinusCall',
    ]);
  }
  for (const key of [
    'minimumContracts',
    'deltaTolerance',
    'tailDeltaTolerance',
    'slopeWindow',
  ] as const) {
    const value = input.config[key];
    ensureFiniteWhenPresent(value, `config.${key}`, FN);
    if (value === undefined) continue;
    const valid =
      key === 'minimumContracts'
        ? Number.isSafeInteger(value) && value >= 1
        : value <= 1 && (key === 'slopeWindow' ? value > 0 : value >= 0);
    if (!valid) {
      throw new InputError(
        `${FN}: config.${key} must be ${
          key === 'minimumContracts'
            ? 'a positive safe integer'
            : key === 'slopeWindow'
              ? 'in (0, 1]'
              : 'in [0, 1]'
        }.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `config.${key}`, value },
        },
      );
    }
  }
  return asOf;
}

type ValidatedExpiry = Pick<OptionQuote['contract'], 'expiresAt' | 'expiryConvention'>;

function validateQuote(
  quote: OptionQuote,
  index: number,
  validatedExpiries: Map<string, ValidatedExpiry>,
): void {
  const path = `quotes[${index}]`;
  requiredObject(quote, path);
  requiredObject(quote.contract, `${path}.contract`);
  const c = quote.contract;
  requiredString(c.underlying, `${path}.contract.underlying`);
  requiredString(c.expiry, `${path}.contract.expiry`);
  enumField(c.type, `${path}.contract.type`, ['call', 'put']);
  enumField(c.style, `${path}.contract.style`, ['american', 'european']);
  requireFiniteFields(FN, c, ['strike', 'expiresAt'], {
    path: `${path}.contract`,
    exampleCall: EXAMPLE,
  });
  ensurePositive(c.strike, `${path}.contract.strike`, FN);
  enumField(c.expiryConvention, `${path}.contract.expiryConvention`, [
    'us-equity-close',
    'explicit-instant',
  ]);
  // Cache successful coordinate triples, not contract objects or expiry labels alone. Each row's
  // required/type/domain checks above still run, and either changed coordinate re-enters core's
  // complete cross-field validator. The map is invocation-local; later calls cannot inherit trust.
  const validated = validatedExpiries.get(c.expiry);
  if (
    validated === undefined ||
    validated.expiresAt !== c.expiresAt ||
    validated.expiryConvention !== c.expiryConvention
  ) {
    validateResolvedExpiry(FN, c.expiry, c.expiresAt, c.expiryConvention);
    validatedExpiries.set(c.expiry, {
      expiresAt: c.expiresAt,
      expiryConvention: c.expiryConvention,
    });
  }
  requireFiniteFields(FN, quote, ['timestampMs'], { path, exampleCall: EXAMPLE });
  timestamp(quote.timestampMs, `${path}.timestampMs`);
  for (const field of ['impliedVolatility', 'openInterest'] as const) {
    ensureFiniteWhenPresent(quote[field], `${path}.${field}`, FN);
  }
  // A row's delta rides `greeks.delta` (the one chain row): signed, provided, never recomputed.
  if (quote.greeks !== undefined) {
    requiredObject(quote.greeks, `${path}.greeks`);
    ensureFiniteWhenPresent(quote.greeks.delta, `${path}.greeks.delta`, FN);
  }
  const delta = quote.greeks?.delta;
  if (quote.impliedVolatility !== undefined)
    ensurePositive(quote.impliedVolatility, `${path}.impliedVolatility`, FN);
  if (quote.openInterest !== undefined)
    ensureNonNegative(quote.openInterest, `${path}.openInterest`, FN);
  if (
    delta !== undefined &&
    (c.type === 'call' ? delta < 0 || delta > 1 : delta < -1 || delta > 0)
  ) {
    throw new InputError(
      `${FN}: ${path}.greeks.delta must be signed ${c.type} delta in ${
        c.type === 'call' ? '[0, 1]' : '[-1, 0]'
      }. No delta is recomputed.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: `${path}.greeks.delta`, type: c.type, delta },
      },
    );
  }
}

function compare(a: ObservedSkewObservation, b: ObservedSkewObservation): number {
  return (
    a.strike - b.strike ||
    b.timestampMs - a.timestampMs ||
    (a.delta ?? 2) - (b.delta ?? 2) ||
    a.impliedVolatility - b.impliedVolatility ||
    (a.openInterest ?? -1) - (b.openInterest ?? -1) ||
    a.quoteIndex - b.quoteIndex
  );
}

function mean(values: readonly number[]): number {
  let result = 0;
  values.forEach((value, i) => {
    result += (value - result) / (i + 1);
  });
  return result;
}

/** A few rounding units for subtraction/division of the supplied operands, not a sampling band. */
function roundoff(scale: number): number {
  return 4 * Number.EPSILON * scale;
}

function tiedDistance({
  distance,
  minimum,
  scale,
}: {
  distance: number;
  minimum: number;
  scale: number;
}): boolean {
  // An exactly observed target beats any nonzero distance, even one within rounding slack.
  return distance === minimum || (minimum > 0 && distance - minimum <= roundoff(scale));
}

function wing(
  rows: ObservedSkewObservation[],
  target: number,
  tolerance: number,
  gate: ObservedSkewUnavailableReason | null,
): ObservedSkewWing {
  const side = rows.filter((row) => row.type === (target > 0 ? 'call' : 'put'));
  let minimum = Infinity;
  for (const row of side) {
    if (row.delta === null) continue;
    minimum = Math.min(minimum, Math.abs(row.delta - target));
  }
  // Compare to the global minimum, not a moving approximate winner (approximate equality is not
  // transitive). Rows are already in disclosed tie-break order, so the first numeric tie wins.
  const nearest =
    side.find(
      (row) =>
        row.delta !== null &&
        tiedDistance({
          distance: Math.abs(row.delta - target),
          minimum,
          scale: Math.max(Math.abs(row.delta), Math.abs(target) + minimum),
        }),
    ) ?? null;
  const distance = nearest === null ? Infinity : Math.abs(nearest.delta! - target);
  const outside =
    distance > tolerance &&
    (tolerance === 0 ||
      distance - tolerance >
        roundoff(Math.max(Math.abs(nearest?.delta ?? 0), Math.abs(target), tolerance)));
  const reason =
    gate ??
    (side.length === 0
      ? 'no_usable_implied_volatility'
      : nearest === null
        ? 'missing_delta'
        : outside
          ? 'outside_delta_tolerance'
          : null);
  return {
    targetDelta: target,
    tolerance,
    selected: reason === null ? nearest : null,
    nearestDeltaDistance: nearest === null ? null : distance,
    unavailableReason: reason,
  };
}

/**
 * Observe a single expiry. Compose separate calls for a term structure; compare their mean ATM IVs
 * only when available. IV/RR/BF/spreads are decimals (multiply by 100 for IV-point displays).
 * Missing IV/delta is omission, not null/NaN/zero. Missing wings and insufficient/expired samples
 * return null with reasons. Supplied malformed values throw; no alternate quote/date shapes,
 * delta recomputation, interpolation, forward adjustment or tail extrapolation is performed.
 * Distance ties and inclusive boundaries allow only 4 × machine epsilon at the arithmetic operand
 * scale. Ties are measured against the global minimum, then use the disclosed lower-strike order;
 * an exact observed target always wins and a zero delta tolerance remains strictly exact.
 */
export function observedSkew(input: ObservedSkewInput): ObservedSkewResult {
  const asOf = validateInput(input);
  const { quotes, market, config } = input;
  const { expiresAt, expiryConvention } = resolvedExpiry(config.expiry);
  const minimumContracts = config.minimumContracts ?? 6;
  const deltaTolerance = config.deltaTolerance ?? 0.12;
  const tailDeltaTolerance = config.tailDeltaTolerance ?? 0.05;
  const slopeWindow = config.slopeWindow ?? 0.1;
  const convention = config.riskReversalConvention ?? 'callMinusPut';
  const rows: ObservedSkewObservation[] = [];
  const excludedQuotes: ObservedSkewMetrics['excludedQuotes'] = [];
  const warnings: QuantWarning[] = [];
  const underlyings = new Set<string>();
  const validatedExpiries = new Map<string, ValidatedExpiry>();
  let matching = 0;
  for (let i = 0; i < quotes.length; i++) {
    const quote = quotes[i]!;
    validateQuote(quote, i, validatedExpiries);
    if (quote.contract.expiry !== config.expiry) {
      excludedQuotes.push({ quoteIndex: i, reason: 'other_expiry' });
      continue;
    }
    matching++;
    underlyings.add(quote.contract.underlying);
    if (quote.timestampMs > asOf) {
      excludedQuotes.push({ quoteIndex: i, reason: 'future_quote' });
    } else if (quote.impliedVolatility === undefined) {
      excludedQuotes.push({ quoteIndex: i, reason: 'missing_implied_volatility' });
    } else {
      rows.push({
        quoteIndex: i,
        type: quote.contract.type,
        strike: quote.contract.strike,
        impliedVolatility: quote.impliedVolatility,
        delta: quote.greeks?.delta ?? null,
        openInterest: quote.openInterest ?? null,
        timestampMs: quote.timestampMs,
      });
    }
  }
  if (underlyings.size > 1) {
    throw new InputError(
      `${FN}: selected expiry contains multiple underlyings; supply one underlying's chain for market.spot.`,
      {
        code: ErrorCode.InputWrongShape,
        context: { underlyings: [...underlyings] },
      },
    );
  }
  rows.sort(compare);
  const gate: ObservedSkewUnavailableReason | null =
    matching === 0
      ? 'expiry_not_found'
      : expiresAt <= asOf
        ? 'expired'
        : rows.length < minimumContracts
          ? 'insufficient_contracts'
          : null;
  let atm: ObservedSkewAtm | null = null;
  if (gate === null) {
    let minimum = Infinity;
    for (const row of rows) {
      minimum = Math.min(minimum, Math.abs(row.strike - market.spot));
    }
    const nearest = rows.find((row) =>
      tiedDistance({
        distance: Math.abs(row.strike - market.spot),
        minimum,
        scale: Math.max(row.strike, market.spot),
      }),
    )!;
    const observations = rows.filter((row) => row.strike === nearest.strike);
    atm = {
      strike: nearest.strike,
      impliedVolatility: mean(observations.map((row) => row.impliedVolatility)),
      observations,
    };
  }
  const put25Delta = wing(rows, -0.25, deltaTolerance, gate);
  const call25Delta = wing(rows, 0.25, deltaTolerance, gate);
  const put10Delta = wing(rows, -0.1, tailDeltaTolerance, gate);
  const call10Delta = wing(rows, 0.1, tailDeltaTolerance, gate);
  const byStrike = new Map<
    number,
    { call: ObservedSkewObservation | null; put: ObservedSkewObservation | null }
  >();
  let duplicateCount = 0;
  for (const row of rows) {
    const pair = byStrike.get(row.strike) ?? { call: null, put: null };
    if (pair[row.type] === null) pair[row.type] = row;
    else duplicateCount++;
    byStrike.set(row.strike, pair);
  }
  const smile: ObservedSkewSmilePoint[] = [...byStrike].map(([strike, pair]) => {
    const moneyness = strike / market.spot - 1;
    ensureFinite(moneyness, 'derived moneyness', FN);
    const otm = strike >= market.spot ? pair.call : pair.put;
    return {
      strike,
      moneyness,
      ...pair,
      otmImpliedVolatility: otm?.impliedVolatility ?? null,
      otmUnavailableReason: otm === null ? 'missing_otm_side' : null,
      impliedVolatilityVsAtm:
        otm !== null && atm !== null ? otm.impliedVolatility - atm.impliedVolatility : null,
    };
  });
  const slopePoints = smile.filter(
    (point) =>
      point.otmImpliedVolatility !== null &&
      (Math.abs(point.moneyness) <= slopeWindow ||
        Math.abs(point.moneyness) - slopeWindow <=
          roundoff(Math.max(1, point.strike / market.spot))),
  );
  let slopeReason: ObservedSkewUnavailableReason | null =
    gate ?? (slopePoints.length < 4 ? 'insufficient_slope_points' : null);
  let skewSlope: number | null = null;
  if (slopeReason === null) {
    const xs = slopePoints.map((point) => point.moneyness);
    const ys = slopePoints.map((point) => point.otmImpliedVolatility!);
    const meanX = mean(xs);
    const meanY = mean(ys);
    let covariance = 0;
    let variance = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i]! - meanX;
      covariance += dx * (ys[i]! - meanY);
      variance += dx * dx;
    }
    if (variance === 0) slopeReason = 'degenerate_moneyness';
    else if (!Number.isFinite(covariance / variance)) slopeReason = 'non_finite_result';
    else skewSlope = covariance / variance;
  }
  const rr = (call: ObservedSkewWing, put: ObservedSkewWing): number | null =>
    call.selected && put.selected
      ? (convention === 'callMinusPut' ? 1 : -1) *
        (call.selected.impliedVolatility - put.selected.impliedVolatility)
      : null;
  const bf = (call: ObservedSkewWing, put: ObservedSkewWing): number | null =>
    call.selected && put.selected && atm
      ? mean([call.selected.impliedVolatility, put.selected.impliedVolatility]) -
        atm.impliedVolatility
      : null;
  const bodyReason =
    gate ?? (call25Delta.selected === null || put25Delta.selected === null ? 'missing_wing' : null);
  const tailReason =
    gate ?? (call10Delta.selected === null || put10Delta.selected === null ? 'missing_wing' : null);
  const unavailableReasons: ObservedSkewMetrics['unavailableReasons'] = {
    atm: gate,
    riskReversal25Delta: bodyReason,
    riskReversal10Delta: tailReason,
    butterfly25Delta: bodyReason,
    butterfly10Delta: tailReason,
    skewSlope: slopeReason,
  };
  for (const [field, reason] of Object.entries(unavailableReasons)) {
    if (reason !== null)
      warnings.push({
        code: WarningCode.VolatilityObservedSkewUnavailable,
        severity: 'warn',
        message: `${FN}: ${field} is unavailable (${reason}); no value was interpolated or invented.`,
        context: { field, reason },
      });
  }
  for (const reason of ['future_quote', 'missing_implied_volatility'] as const) {
    const indices = excludedQuotes
      .filter((row) => row.reason === reason)
      .map((row) => row.quoteIndex);
    if (indices.length)
      warnings.push({
        code: WarningCode.VolatilityObservedSkewQuoteExcluded,
        severity: 'warn',
        message: `${FN}: excluded ${indices.length} selected-expiry quote(s): ${reason}.`,
        context: { reason, quoteIndices: indices },
      });
  }
  const missingDeltaIndices = rows.filter((row) => row.delta === null).map((row) => row.quoteIndex);
  if (missingDeltaIndices.length)
    warnings.push({
      code: WarningCode.VolatilityObservedSkewMissingDelta,
      severity: 'info',
      message: `${FN}: ${missingDeltaIndices.length} IV-bearing quote(s) lack delta; they contribute to ATM/smile, never wing selection.`,
      context: { quoteIndices: missingDeltaIndices },
    });
  if (duplicateCount)
    warnings.push({
      code: WarningCode.VolatilityObservedSkewDuplicateContract,
      severity: 'info',
      message: `${FN}: ${duplicateCount} repeated strike/type observation(s); ATM/sample counts retain all, smile sides use the disclosed deterministic tie-break.`,
      context: { duplicateCount },
    });
  const timeToExpiryYears = yearFraction(asOf, expiresAt, 'ACT/365F');
  return {
    value: {
      expiry: config.expiry,
      expiresAt,
      timeToExpiryYears,
      daysToExpiry: Math.max(0, Math.ceil((expiresAt - asOf) / 86_400_000)),
      underlying: [...underlyings][0] ?? null,
      contractCount: rows.length,
      unavailableReason: gate,
      atm,
      put25Delta,
      call25Delta,
      put10Delta,
      call10Delta,
      riskReversal25Delta: rr(call25Delta, put25Delta),
      riskReversal10Delta: rr(call10Delta, put10Delta),
      butterfly25Delta: bf(call25Delta, put25Delta),
      butterfly10Delta: bf(call10Delta, put10Delta),
      skewSlope,
      slopePointCount: slopePoints.length,
      unavailableReasons,
      smile,
      excludedQuotes,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      asOf,
      spot: market.spot,
      dayCount: 'ACT/365F',
      timeToExpiryYears,
      expiryConvention,
      impliedVolatilitySource: 'provided',
      deltaSource: 'provided',
      atmMethod: 'nearest-spot-strike-mean',
      wingMethod: 'nearest-provided-delta',
      smileMethod: 'observed-otm-only',
      slopeMethod: 'ols-implied-volatility-vs-moneyness',
      tieBreak: 'lower-strike-latest-timestamp-delta-implied-volatility-open-interest-input-index',
      duplicatePolicy: 'retain-observations-select-smile-side',
      riskReversalConvention: convention,
      minimumContracts,
      deltaTolerance,
      tailDeltaTolerance,
      slopeWindow,
    },
    diagnostics: { engine: 'observed-chain-skew', method: 'provided-delta-sampling', warnings },
  };
}
