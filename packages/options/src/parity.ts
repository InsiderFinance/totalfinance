/**
 * `@insiderfinance/totalfinance/options/parity` — put-call parity, implied carry, and box-spread financing from a
 * snapshot option chain (spec §WS9.4).
 *
 * Put-call parity says the call/put mid at each strike sits on a straight line in the strike `K`:
 *
 *     C(K) − P(K) = e^(−rT)·(F − K) = S·e^(−qT) − K·e^(−rT)
 *
 * so a regression of the parity spread `y_K = C(K) − P(K)` on `K` recovers the forward and the
 * discount factor from one expiry's chain, with no volatility model:
 *
 *   - slope     = −e^(−rT)                     ⇒ implied discount factor  DF = −slope = e^(−rT)
 *   - intercept =  e^(−rT)·F = S·e^(−qT)       ⇒ implied forward          F  = −intercept / slope
 *   - implied financing rate                   ⇒ r* = −ln(DF) / T
 *   - implied dividend yield (given S)         ⇒ q  = r − ln(F/S) / T
 *
 * Every function returns the pro-API envelope `{ value, assumptions, diagnostics }` (spec §5.2):
 * `assumptions` echoes the applied conventions (day-count, `asOf`, time-to-expiry, price source,
 * outlier threshold), and `diagnostics` carries the per-strike parity residuals plus the MAD-based
 * outlier trim (count + strikes) so nothing is hidden. Quantitative degeneracy is reported via
 * `diagnostics.converged` and `diagnostics.warnings`, never a fabricated value (design law #4).
 * Malformed arguments (missing `rows`/`options`, bad numbers) throw an {@link InputError} with a stable
 * `input.*` code; chain-level gaps (a missing leg, too few usable strikes) throw a stable `parity.*`
 * code — see {@link ParityCode}.
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  selectQuotePrice,
  warning,
  requireArgumentArray,
  requireArgumentObject,
  resolveValuationAsOf,
} from '@totalfinance/core';
import type {
  Assumptions,
  Diagnostics,
  EpochMs,
  OptionQuote,
  PriceSource,
  QuantWarning,
} from '@totalfinance/core';
import { median } from '@totalfinance/math';
import { timeToExpiryYears } from './time.js';

const MODEL = 'put-call-parity';

/** Default MAD multiplier `k`: a strike whose parity residual exceeds `k·MAD` is trimmed. */
export const DEFAULT_OUTLIER_THRESHOLD = 3.5;

/** Default quote price source used to read each leg's price. */
const DEFAULT_SOURCE: PriceSource = 'mid';

/** Stable `parity.*` error/warning codes (public API; the set is open). */
export const ParityCode = {
  /** A specifically requested strike/leg quote is missing (box spread). */
  StrikeUnavailable: 'parity.strike_unavailable',
  /** Fewer than two usable strikes with both a call and a put — a line cannot be fit. */
  InsufficientStrikes: 'parity.insufficient_strikes',
  /** The regression slope is non-negative, so no positive discount factor exists. */
  NonPositiveDiscount: 'parity.nonpositive_discount',
  /** The implied forward came out non-positive / non-finite. */
  NonPositiveForward: 'parity.nonpositive_forward',
  /** The box debit is non-positive, so no real financing rate exists. */
  DegenerateBox: 'parity.degenerate_box',
  /** The regression-implied rate disagrees materially with the supplied rate. */
  RateMismatch: 'parity.rate_mismatch',
} as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-strike parity diagnostic echoed for every usable strike (design law: nothing hidden). */
export interface ParityStrikeResidual {
  strike: number;
  /** Call price at this strike (from the chosen `source`). */
  call: number;
  /** Put price at this strike. */
  put: number;
  /** Observed parity spread `C − P`. */
  spread: number;
  /** Fitted spread `intercept + slope·K` from the final (post-trim) regression. */
  fitted: number;
  /** `spread − fitted`. */
  residual: number;
  /** Whether this strike was dropped as a MAD outlier before the final fit. */
  trimmed: boolean;
}

/** Assumptions echoed by the regression-based parity functions. */
export type ParityAssumptions = Assumptions<{
  riskFreeRate: number;
  priceSource: PriceSource;
  outlierThreshold: number;
  spot?: number;
}>;

/** Diagnostics for the regression-based parity functions. Extends the shared {@link Diagnostics}. */
export interface ParityDiagnostics extends Diagnostics {
  /** Number of strikes used in the final fit (after trimming). */
  strikesUsed: number;
  /** Number of strikes trimmed as MAD outliers. */
  trimmedCount: number;
  /** The strikes that were trimmed, ascending. */
  trimmedStrikes: number[];
  /** Per-strike parity residuals for every usable strike (trimmed ones flagged). */
  perStrike: ParityStrikeResidual[];
  /** Median absolute deviation of the initial-fit residuals used for trimming. */
  medianAbsoluteDeviationResidual: number;
  /** Coefficient of determination of the final regression. */
  rSquared: number;
  /** Implied discount factor `DF = −slope = e^(−rT)`. */
  impliedDiscountFactor: number;
  /** Implied continuously-compounded financing rate `r* = −ln(DF)/T`. */
  impliedRate: number;
}

/** The rich envelope returned by {@link impliedForward}/{@link impliedDividendYield}/{@link impliedBorrow}. */
export interface ParityResult {
  value: number;
  assumptions: ParityAssumptions;
  diagnostics: ParityDiagnostics;
}

/** Assumptions echoed by {@link boxSpreadRate}. */
export type BoxSpreadAssumptions = Assumptions<{
  priceSource: PriceSource;
  lowerStrike: number;
  upperStrike: number;
}>;

/** Diagnostics for {@link boxSpreadRate}. */
export interface BoxSpreadDiagnostics extends Diagnostics {
  /** Net debit of the box `(C(k1) − C(k2)) + (P(k2) − P(k1))`. */
  debit: number;
  /** Strike width `k2 − k1`, the guaranteed expiry payoff. */
  width: number;
  /** `debit / width = e^(−rT)`, the implied discount factor. */
  discountFactor: number;
}

/** The rich envelope returned by {@link boxSpreadRate}. */
export interface BoxSpreadResult {
  value: number;
  assumptions: BoxSpreadAssumptions;
  diagnostics: BoxSpreadDiagnostics;
}

/** Options shared by the regression-based parity functions. */
export interface ImpliedForwardOptions {
  /** Continuously-compounded risk-free rate. */
  riskFreeRate: number;
  /** Snapshot time (epoch ms, 'YYYY-MM-DD', or zoned ISO datetime); time-to-expiry is measured from here under ACT/365F. */
  asOf: EpochMs | string;
  /** Quote price source per leg (default `mid`). */
  source?: PriceSource;
  /** MAD multiplier for outlier trimming (default {@link DEFAULT_OUTLIER_THRESHOLD}). */
  outlierThreshold?: number;
}

/** Options for {@link impliedDividendYield} — adds the spot needed to back out `q`. */
export interface ImpliedDividendYieldOptions extends ImpliedForwardOptions {
  spot: number;
}

/** Options for {@link impliedBorrow} — adds the spot used in diagnostics. */
export interface ImpliedBorrowOptions extends ImpliedForwardOptions {
  spot: number;
}

/** Options for {@link boxSpreadRate}. */
export interface BoxSpreadOptions {
  /** Snapshot time (epoch ms, 'YYYY-MM-DD', or zoned ISO datetime). */
  asOf: EpochMs | string;
  /** Quote price source per leg (default `mid`). */
  source?: PriceSource;
}

/** One cohesive request for put-call-parity forward inference. */
export interface ImpliedForwardInput {
  quotes: readonly OptionQuote[];
  expiry: string;
  options: ImpliedForwardOptions;
}

/** One cohesive request for dividend-yield inference from put-call parity. */
export interface ImpliedDividendYieldInput {
  quotes: readonly OptionQuote[];
  expiry: string;
  options: ImpliedDividendYieldOptions;
}

/** One cohesive request for borrow-spread inference from put-call parity. */
export interface ImpliedBorrowInput {
  quotes: readonly OptionQuote[];
  expiry: string;
  options: ImpliedBorrowOptions;
}

/** One cohesive request for a box-spread-implied financing rate. */
export interface BoxSpreadRateInput {
  quotes: readonly OptionQuote[];
  expiry: string;
  lowerStrike: number;
  upperStrike: number;
  options: BoxSpreadOptions;
}

// Law 12 allowlists — a misspelled option (`outlierThresold`, `sourse`) must teach, never be
// silently ignored in favour of the defaults.
const IMPLIED_FORWARD_KEYS = ['riskFreeRate', 'asOf', 'source', 'outlierThreshold'] as const;
/** Shared by {@link impliedDividendYield} and {@link impliedBorrow} (same options shape). */
const IMPLIED_CARRY_KEYS = [...IMPLIED_FORWARD_KEYS, 'spot'] as const;
const BOX_SPREAD_KEYS = ['asOf', 'source'] as const;
const IMPLIED_PARITY_REQUEST_KEYS = ['quotes', 'expiry', 'options'] as const;
const BOX_SPREAD_REQUEST_KEYS = [
  'quotes',
  'expiry',
  'lowerStrike',
  'upperStrike',
  'options',
] as const;

// ---------------------------------------------------------------------------
// Chain -> parity points
// ---------------------------------------------------------------------------

interface ParityPoint {
  strike: number;
  call: number;
  put: number;
  spread: number;
}

/**
 * Collect one `(strike, C−P)` point per strike that carries BOTH a finite call and put price at the
 * requested expiry and source. Later rows override earlier ones for the same strike+type.
 */
function collectParityPoints(
  rows: readonly OptionQuote[],
  expiry: string,
  source: PriceSource,
): ParityPoint[] {
  const byStrike = new Map<number, { call?: number; put?: number }>();
  for (const row of rows) {
    const c = row.contract;
    if (c.expiry !== expiry) continue;
    const price = selectQuotePrice(row, source);
    if (price === undefined || !Number.isFinite(price)) continue;
    let entry = byStrike.get(c.strike);
    if (entry === undefined) {
      entry = {};
      byStrike.set(c.strike, entry);
    }
    if (c.type === 'call') entry.call = price;
    else entry.put = price;
  }
  const points: ParityPoint[] = [];
  for (const [strike, { call, put }] of byStrike) {
    if (call !== undefined && put !== undefined) {
      points.push({ strike, call, put, spread: call - put });
    }
  }
  points.sort((a, b) => a.strike - b.strike);
  return points;
}

/** Find a single leg's price at an exact strike, throwing `parity.strike_unavailable` when absent. */
function requireLegPrice(
  rows: readonly OptionQuote[],
  expiry: string,
  strike: number,
  type: 'call' | 'put',
  source: PriceSource,
  functionName: string,
): number {
  for (const row of rows) {
    const c = row.contract;
    if (c.expiry === expiry && c.type === type && c.strike === strike) {
      const price = selectQuotePrice(row, source);
      if (price !== undefined && Number.isFinite(price)) return price;
    }
  }
  throw new InputError(
    `${functionName}: no ${type} quote at strike ${strike} for expiry "${expiry}" (source "${source}").`,
    {
      code: ParityCode.StrikeUnavailable,
      context: { strike, type, expiry, source, function: functionName },
    },
  );
}

// ---------------------------------------------------------------------------
// Ordinary least squares + MAD trimming
// ---------------------------------------------------------------------------

interface Line {
  slope: number;
  intercept: number;
}

/** Closed-form simple OLS of `ys` on `xs`. Returns `null` when the strikes have no spread. */
function ols(xs: readonly number[], ys: readonly number[]): Line | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** Coefficient of determination of `line` against the data. */
function rSquaredOf(xs: readonly number[], ys: readonly number[], line: Line): number {
  const n = ys.length;
  let my = 0;
  for (let i = 0; i < n; i++) my += ys[i]!;
  my /= n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fit = line.intercept + line.slope * xs[i]!;
    ssRes += (ys[i]! - fit) ** 2;
    ssTot += (ys[i]! - my) ** 2;
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : 1;
}

interface RegressionFit {
  line: Line;
  forward: number;
  discountFactor: number;
  impliedRate: number;
  timeToExpiryYears: number;
  perStrike: ParityStrikeResidual[];
  kept: ParityPoint[];
  trimmed: ParityPoint[];
  medianAbsoluteDeviationResidual: number;
  rSquared: number;
  warnings: QuantWarning[];
}

/**
 * Fit the parity line with MAD-based outlier trimming:
 *   1. OLS on all usable strikes.
 *   2. residual = (C−P) − fitted; MAD = median(|residual − median(residual)|).
 *   3. drop strikes whose |residual − median| exceeds `k·MAD`, then refit on the survivors.
 *
 * Trimming is skipped when there are too few strikes (< 4, so a survivor set stays ≥ 3) or when the
 * MAD is numerically ~0 (a clean/collinear chain), which keeps exact chains recovering exactly.
 */
function fitParity(
  points: ParityPoint[],
  k: number,
  functionName: string,
): Omit<RegressionFit, 'timeToExpiryYears'> {
  if (points.length < 2) {
    throw new InputError(
      `${functionName}: need at least 2 strikes with both a call and a put to fit parity; got ${points.length}.`,
      {
        code: ParityCode.InsufficientStrikes,
        context: { strikes: points.length, function: functionName },
      },
    );
  }

  const allStrikes = points.map((p) => p.strike);
  const allSpreads = points.map((p) => p.spread);
  const initial = ols(allStrikes, allSpreads);
  if (initial === null) {
    throw new InputError(
      `${functionName}: the strikes carry no spread (all identical), so parity cannot be regressed.`,
      {
        code: ParityCode.InsufficientStrikes,
        context: { strikes: points.length, function: functionName },
      },
    );
  }

  // MAD of initial-fit residuals.
  const residuals = points.map((p) => p.spread - (initial.intercept + initial.slope * p.strike));
  const medianResidual = median(residuals);
  const absDev = residuals.map((r) => Math.abs(r - medianResidual));
  const medianAbsoluteDeviationResidual = median(absDev);

  let maxAbsDev = 0;
  let sumAbsDev = 0;
  for (const d of absDev) {
    if (d > maxAbsDev) maxAbsDev = d;
    sumAbsDev += d;
  }

  // Guard: never trim a clean / collinear chain — no residual stands out from the spread scale.
  const spreadScale = Math.max(1, median(allSpreads.map((s) => Math.abs(s))));
  const clean = maxAbsDev <= 1e-9 * spreadScale;

  // Cutoff scale is the MAD (spec), with a mean-absolute-deviation fallback when the MAD is
  // degenerate — a lone outlier at the design centre leaves a majority of identical residuals, which
  // zeroes the MAD even though an obvious outlier exists. The reported `madResidual` stays the true MAD.
  const scale =
    medianAbsoluteDeviationResidual > 1e-12 * spreadScale
      ? medianAbsoluteDeviationResidual
      : sumAbsDev / absDev.length;
  const canTrim = points.length >= 4 && !clean && scale > 0;

  const kept: ParityPoint[] = [];
  const trimmed: ParityPoint[] = [];
  if (canTrim) {
    const cutoff = k * scale;
    for (let i = 0; i < points.length; i++) {
      if (Math.abs(residuals[i]! - medianResidual) > cutoff) trimmed.push(points[i]!);
      else kept.push(points[i]!);
    }
  }
  // Never trim below the 2 points a line needs; fall back to the full set if we would.
  const useAll = !canTrim || kept.length < 2;
  const fitPoints = useAll ? points : kept;

  const line =
    ols(
      fitPoints.map((p) => p.strike),
      fitPoints.map((p) => p.spread),
    ) ?? initial;

  const trimmedStrikes = new Set(useAll ? [] : trimmed.map((p) => p.strike));
  const perStrike: ParityStrikeResidual[] = points.map((p) => {
    const fitted = line.intercept + line.slope * p.strike;
    return {
      strike: p.strike,
      call: p.call,
      put: p.put,
      spread: p.spread,
      fitted,
      residual: p.spread - fitted,
      trimmed: trimmedStrikes.has(p.strike),
    };
  });

  const warnings: QuantWarning[] = [];
  const discountFactor = -line.slope;
  const forward = line.slope !== 0 ? -line.intercept / line.slope : NaN;
  const impliedRate = discountFactor > 0 ? -Math.log(discountFactor) : NaN;

  if (!(discountFactor > 0)) {
    warnings.push(
      warning(
        ParityCode.NonPositiveDiscount,
        `implied discount factor ${discountFactor} is non-positive; the parity slope is not a valid −e^(−rT).`,
        'error',
        { discountFactor },
      ),
    );
  }

  return {
    line,
    forward,
    discountFactor,
    impliedRate,
    perStrike,
    kept: useAll ? points : kept,
    trimmed: useAll ? [] : trimmed,
    medianAbsoluteDeviationResidual,
    rSquared: rSquaredOf(
      fitPoints.map((p) => p.strike),
      fitPoints.map((p) => p.spread),
      line,
    ),
    warnings,
  };
}

/**
 * Is this fit a valid parity line at all? The regression slope must be `−e^(−rT)`, i.e. strictly
 * NEGATIVE, so the implied discount factor is positive. A crossed / mispaired chain (puts and calls
 * swapped, one leg stale) regresses to a positive slope: every quantity downstream —
 * `F = −intercept/slope`, `q = r − ln(F/S)/T`, `r* = −ln(DF)/T` — is then arithmetic on an impossible
 * discount factor, and `F` in particular stays finite and positive, which is exactly how a crossed
 * chain used to come back `converged: true`. `impliedBorrow` has always gated here; the whole module
 * does now.
 */
function admissible(fit: Pick<RegressionFit, 'discountFactor'>): boolean {
  return Number.isFinite(fit.discountFactor) && fit.discountFactor > 0;
}

/**
 * Put-call parity `C − P = e^{−rt}(F − K)` is a EUROPEAN, single-underlying relationship. An
 * American contract carries early-exercise premium that biases the implied forward, and mixing
 * underlyings is meaningless — reject both rather than fit a confident-but-wrong `F` (design law #4).
 */
function assertEuropeanSingleUnderlying(
  rows: readonly OptionQuote[],
  expiry: string,
  functionName: string,
): void {
  let underlying: string | undefined;
  for (const row of rows) {
    const c = row.contract;
    if (c.expiry !== expiry) continue;
    if (c.style !== 'european') {
      throw new InputError(
        `${functionName}: put-call parity holds for EUROPEAN options only; the contract at strike ${c.strike} is '${c.style}' (early-exercise premium biases the implied forward).`,
        { code: ErrorCode.InputWrongType, context: { strike: c.strike, style: c.style } },
      );
    }
    if (underlying === undefined) underlying = c.underlying;
    else if (c.underlying !== underlying) {
      throw new InputError(
        `${functionName}: parity requires a single underlying; got both '${underlying}' and '${c.underlying}'.`,
        { code: ErrorCode.InputWrongType, context: { underlyings: [underlying, c.underlying] } },
      );
    }
  }
}

/** Run the parity regression for one expiry, resolving time-to-expiry from `asOf`. */
function parityRegression(
  rows: readonly OptionQuote[],
  expiry: string,
  source: PriceSource,
  k: number,
  asOf: EpochMs | string,
  functionName: string,
): RegressionFit {
  const t = timeToExpiryYears(resolveValuationAsOf(asOf, functionName), expiry, functionName);
  ensurePositive(t, 'timeToExpiryYears', functionName, ErrorCode.InputNegativeTime);
  assertEuropeanSingleUnderlying(rows, expiry, functionName);
  const points = collectParityPoints(rows, expiry, source);
  const fit = fitParity(points, k, functionName);
  return {
    ...fit,
    timeToExpiryYears: t,
    // T-dependent rate uses the resolved year-fraction.
    impliedRate: Number.isFinite(fit.impliedRate) ? fit.impliedRate / t : NaN,
  };
}

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

function parityAssumptions(input: {
  fit: RegressionFit;
  riskFreeRate: number;
  source: PriceSource;
  outlierThreshold: number;
  asOf: EpochMs | string;
  spot?: number;
}): ParityAssumptions {
  const { fit, riskFreeRate, source, outlierThreshold, asOf, spot } = input;
  const asOfMs = resolveValuationAsOf(asOf, 'parity');
  const base: ParityAssumptions = {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    asOf: asOfMs,
    timeToExpiryYears: fit.timeToExpiryYears,
    model: MODEL,
    engine: MODEL,
    riskFreeRate,
    priceSource: source,
    outlierThreshold,
  };
  return spot !== undefined ? { ...base, spot } : base;
}

function parityDiagnostics(
  fit: RegressionFit,
  converged: boolean,
  extraWarnings: QuantWarning[],
): ParityDiagnostics {
  return {
    engine: MODEL,
    method: 'ols-regression',
    converged,
    warnings: [...fit.warnings, ...extraWarnings],
    strikesUsed: fit.kept.length,
    trimmedCount: fit.trimmed.length,
    trimmedStrikes: fit.trimmed.map((p) => p.strike).sort((a, b) => a - b),
    perStrike: fit.perStrike,
    medianAbsoluteDeviationResidual: fit.medianAbsoluteDeviationResidual,
    rSquared: fit.rSquared,
    impliedDiscountFactor: fit.discountFactor,
    impliedRate: fit.impliedRate,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Implied forward `F` from put-call parity across one expiry's chain.
 *
 * Regresses `C(K) − P(K)` on `K`; from `slope = −e^(−rT)` and `intercept = e^(−rT)·F`,
 * `F = −intercept / slope`. The supplied `rate` is echoed and compared against the
 * regression-implied financing rate (reported in `diagnostics.impliedRate`); it does not bias `F`.
 */
export function impliedForward(input: ImpliedForwardInput): ParityResult {
  requireArgumentObject('impliedForward', 'input', input);
  ensureKnownKeys('impliedForward', 'input', input, IMPLIED_PARITY_REQUEST_KEYS);
  const { quotes: rows, expiry, options } = input;
  requireArgumentArray('impliedForward', 'rows', rows);
  requireArgumentObject('impliedForward', 'options', options);
  ensureKnownKeys('impliedForward', 'options', options, IMPLIED_FORWARD_KEYS);
  const functionName = 'parity.impliedForward';
  ensureFinite(options.riskFreeRate, 'riskFreeRate', functionName);
  if (
    options.source !== undefined &&
    !['bid', 'ask', 'mid', 'last', 'mark'].includes(options.source as string)
  ) {
    throw new InputError(
      `parity: source must be bid | ask | mid | last | mark when provided. Received ${options.source === null ? 'null' : JSON.stringify(options.source)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'source' } },
    );
  }
  const source = options.source ?? DEFAULT_SOURCE;
  if (
    options.outlierThreshold !== undefined &&
    (typeof options.outlierThreshold !== 'number' || !Number.isFinite(options.outlierThreshold))
  ) {
    throw new InputError(
      `parity: outlierThreshold must be a finite number when provided. Received ${options.outlierThreshold === null ? 'null' : typeof options.outlierThreshold}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'outlierThreshold' } },
    );
  }
  const k = options.outlierThreshold ?? DEFAULT_OUTLIER_THRESHOLD;
  const fit = parityRegression(rows, expiry, source, k, options.asOf, functionName);

  const warnings: QuantWarning[] = [];
  // An admissible fit needs BOTH a positive forward and a positive discount factor (slope < 0) —
  // `impliedBorrow` has always gated on the discount factor, and this function must agree. A crossed
  // chain regresses to a POSITIVE slope, and `F = −intercept/slope` off that slope is still finite
  // and positive: converging on it reported a confident forward computed from a discount factor of
  // e.g. −0.9 (defect-fix wave, finding 2).
  const admissibleDiscount = admissible(fit);
  const ok = admissibleDiscount && Number.isFinite(fit.forward) && fit.forward > 0;
  // An inadmissible discount factor is already reported: `fitParity` put parity.nonpositive_discount
  // on `fit.warnings`, which `parityDiagnostics` merges in — re-reporting it as a forward problem
  // would name the symptom instead of the cause.
  if (admissibleDiscount && !ok) {
    warnings.push(
      warning(
        ParityCode.NonPositiveForward,
        `implied forward ${fit.forward} is not positive.`,
        'error',
        {
          forward: fit.forward,
        },
      ),
    );
  } else if (
    ok &&
    Number.isFinite(fit.impliedRate) &&
    Math.abs(fit.impliedRate - options.riskFreeRate) > 0.02
  ) {
    warnings.push(
      warning(
        ParityCode.RateMismatch,
        `regression-implied rate ${fit.impliedRate.toFixed(
          4,
        )} differs from supplied rate ${options.riskFreeRate.toFixed(4)}.`,
        'info',
        { impliedRate: fit.impliedRate, suppliedRate: options.riskFreeRate },
      ),
    );
  }

  return {
    // Never a fabricated value: an inadmissible fit reports NaN with `converged: false` and the
    // reason on `diagnostics.warnings` (the module's failure grammar, shared with impliedBorrow).
    value: ok ? fit.forward : NaN,
    assumptions: parityAssumptions({
      fit,
      riskFreeRate: options.riskFreeRate,
      source,
      outlierThreshold: k,
      asOf: options.asOf,
    }),
    diagnostics: parityDiagnostics(fit, ok, warnings),
  };
}

/**
 * Implied continuous dividend yield `q` from `F = S·e^((r−q)T)` ⇒ `q = r − ln(F/S)/T`, using the
 * regression forward and the supplied `spot`/`rate`.
 */
export function impliedDividendYield(input: ImpliedDividendYieldInput): ParityResult {
  requireArgumentObject('impliedDividendYield', 'input', input);
  ensureKnownKeys('impliedDividendYield', 'input', input, IMPLIED_PARITY_REQUEST_KEYS);
  const { quotes: rows, expiry, options } = input;
  requireArgumentArray('impliedDividendYield', 'rows', rows);
  requireArgumentObject('impliedDividendYield', 'options', options);
  ensureKnownKeys('impliedDividendYield', 'options', options, IMPLIED_CARRY_KEYS);
  const functionName = 'parity.impliedDividendYield';
  ensureFinite(options.riskFreeRate, 'riskFreeRate', functionName);
  ensurePositive(options.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  if (
    options.source !== undefined &&
    !['bid', 'ask', 'mid', 'last', 'mark'].includes(options.source as string)
  ) {
    throw new InputError(
      `parity: source must be bid | ask | mid | last | mark when provided. Received ${options.source === null ? 'null' : JSON.stringify(options.source)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'source' } },
    );
  }
  const source = options.source ?? DEFAULT_SOURCE;
  if (
    options.outlierThreshold !== undefined &&
    (typeof options.outlierThreshold !== 'number' || !Number.isFinite(options.outlierThreshold))
  ) {
    throw new InputError(
      `parity: outlierThreshold must be a finite number when provided. Received ${options.outlierThreshold === null ? 'null' : typeof options.outlierThreshold}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'outlierThreshold' } },
    );
  }
  const k = options.outlierThreshold ?? DEFAULT_OUTLIER_THRESHOLD;
  const fit = parityRegression(rows, expiry, source, k, options.asOf, functionName);

  const warnings: QuantWarning[] = [];
  // Same admissibility gate as `impliedForward`: a crossed chain's positive slope makes the forward
  // (and therefore `q = r − ln(F/S)/T`) a number computed from an impossible discount factor.
  const admissibleDiscount = admissible(fit);
  const ok = admissibleDiscount && Number.isFinite(fit.forward) && fit.forward > 0;
  let q = NaN;
  if (ok) {
    q = options.riskFreeRate - Math.log(fit.forward / options.spot) / fit.timeToExpiryYears;
  } else if (admissibleDiscount) {
    warnings.push(
      warning(
        ParityCode.NonPositiveForward,
        `implied forward ${fit.forward} is not positive; cannot back out a dividend yield.`,
        'error',
        { forward: fit.forward },
      ),
    );
  }
  // (When the discount factor itself is inadmissible, `fitParity` already recorded
  // parity.nonpositive_discount on `fit.warnings`, which `parityDiagnostics` merges in.)

  return {
    value: q,
    assumptions: parityAssumptions({
      fit,
      riskFreeRate: options.riskFreeRate,
      source,
      outlierThreshold: k,
      asOf: options.asOf,
      spot: options.spot,
    }),
    diagnostics: parityDiagnostics(fit, ok, warnings),
  };
}

/**
 * Implied borrow / financing spread: the regression-implied financing rate `r*` (from the parity
 * slope) minus the supplied `rate`. Zero when the chain was priced at exactly `rate`.
 */
export function impliedBorrow(input: ImpliedBorrowInput): ParityResult {
  requireArgumentObject('impliedBorrow', 'input', input);
  ensureKnownKeys('impliedBorrow', 'input', input, IMPLIED_PARITY_REQUEST_KEYS);
  const { quotes: rows, expiry, options } = input;
  requireArgumentArray('impliedBorrow', 'rows', rows);
  requireArgumentObject('impliedBorrow', 'options', options);
  ensureKnownKeys('impliedBorrow', 'options', options, IMPLIED_CARRY_KEYS);
  const functionName = 'parity.impliedBorrow';
  ensureFinite(options.riskFreeRate, 'riskFreeRate', functionName);
  ensurePositive(options.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  if (
    options.source !== undefined &&
    !['bid', 'ask', 'mid', 'last', 'mark'].includes(options.source as string)
  ) {
    throw new InputError(
      `parity: source must be bid | ask | mid | last | mark when provided. Received ${options.source === null ? 'null' : JSON.stringify(options.source)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'source' } },
    );
  }
  const source = options.source ?? DEFAULT_SOURCE;
  if (
    options.outlierThreshold !== undefined &&
    (typeof options.outlierThreshold !== 'number' || !Number.isFinite(options.outlierThreshold))
  ) {
    throw new InputError(
      `parity: outlierThreshold must be a finite number when provided. Received ${options.outlierThreshold === null ? 'null' : typeof options.outlierThreshold}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'outlierThreshold' } },
    );
  }
  const k = options.outlierThreshold ?? DEFAULT_OUTLIER_THRESHOLD;
  const fit = parityRegression(rows, expiry, source, k, options.asOf, functionName);

  const warnings: QuantWarning[] = [];
  const ok = Number.isFinite(fit.impliedRate);
  let spread = NaN;
  if (ok) {
    spread = fit.impliedRate - options.riskFreeRate;
  } else {
    warnings.push(
      warning(
        ParityCode.NonPositiveDiscount,
        `no positive discount factor implied by the chain; cannot infer a financing spread.`,
        'error',
        { discountFactor: fit.discountFactor },
      ),
    );
  }

  return {
    value: spread,
    assumptions: parityAssumptions({
      fit,
      riskFreeRate: options.riskFreeRate,
      source,
      outlierThreshold: k,
      asOf: options.asOf,
      spot: options.spot,
    }),
    diagnostics: parityDiagnostics(fit, ok, warnings),
  };
}

/**
 * Implied financing rate from the box spread between strikes `k1 < k2`.
 *
 * A box (bull call spread `+` bear put spread) locks in `(k2 − k1)` at expiry for a net debit
 * `box = (C(k1) − C(k2)) + (P(k2) − P(k1))`, so `box = (k2 − k1)·e^(−rT)` and
 * `rate = −ln(box / (k2 − k1)) / T`. Throws `parity.strike_unavailable` when a needed leg is missing.
 */
export function boxSpreadRate(input: BoxSpreadRateInput): BoxSpreadResult {
  requireArgumentObject('boxSpreadRate', 'input', input);
  ensureKnownKeys('boxSpreadRate', 'input', input, BOX_SPREAD_REQUEST_KEYS);
  const { quotes: rows, expiry, lowerStrike: k1, upperStrike: k2, options } = input;
  requireArgumentArray('boxSpreadRate', 'rows', rows);
  requireArgumentObject('boxSpreadRate', 'options', options);
  ensureKnownKeys('boxSpreadRate', 'options', options, BOX_SPREAD_KEYS);
  const functionName = 'parity.boxSpreadRate';
  ensurePositive(k1, 'k1', functionName, ErrorCode.InputNegativeStrike);
  ensurePositive(k2, 'k2', functionName, ErrorCode.InputNegativeStrike);
  if (!(k1 < k2)) {
    throw new InputError(`${functionName}: require k1 < k2, got k1=${k1}, k2=${k2}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { k1, k2, function: functionName },
    });
  }
  if (
    options.source !== undefined &&
    !['bid', 'ask', 'mid', 'last', 'mark'].includes(options.source as string)
  ) {
    throw new InputError(
      `parity: source must be bid | ask | mid | last | mark when provided. Received ${options.source === null ? 'null' : JSON.stringify(options.source)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'source' } },
    );
  }
  const source = options.source ?? DEFAULT_SOURCE;
  const asOfMs = resolveValuationAsOf(options.asOf, functionName);
  const t = timeToExpiryYears(asOfMs, expiry, functionName);
  ensurePositive(t, 'timeToExpiryYears', functionName, ErrorCode.InputNegativeTime);

  const callLow = requireLegPrice(rows, expiry, k1, 'call', source, functionName);
  const putLow = requireLegPrice(rows, expiry, k1, 'put', source, functionName);
  const callHigh = requireLegPrice(rows, expiry, k2, 'call', source, functionName);
  const putHigh = requireLegPrice(rows, expiry, k2, 'put', source, functionName);

  const width = k2 - k1;
  const debit = callLow - callHigh + (putHigh - putLow);
  const discountFactor = debit / width;

  const warnings: QuantWarning[] = [];
  let rate = NaN;
  const ok = discountFactor > 0;
  if (ok) {
    rate = -Math.log(discountFactor) / t;
  } else {
    warnings.push(
      warning(
        ParityCode.DegenerateBox,
        `box debit ${debit} over width ${width} is not a positive discount factor; no real financing rate exists.`,
        'error',
        { debit, width, discountFactor },
      ),
    );
  }

  const assumptions: BoxSpreadAssumptions = {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    asOf: asOfMs,
    timeToExpiryYears: t,
    model: MODEL,
    engine: MODEL,
    priceSource: source,
    lowerStrike: k1,
    upperStrike: k2,
  };

  return {
    value: rate,
    assumptions,
    diagnostics: {
      engine: MODEL,
      method: 'box-spread',
      converged: ok,
      warnings,
      debit,
      width,
      discountFactor,
    },
  };
}
