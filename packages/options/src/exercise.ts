/**
 * American exercise analytics (spec: `docs/specs/american-exercise.md`, roadmap Tier 2). Two questions
 * every American-option holder faces — "how much of this is the right to exercise early?" and "at what
 * price should I exercise?" — answered in one call: the early-exercise **premium** (American value minus
 * the European value it would have without early exercise), the exercise **boundary** `S*(τ)` recovered
 * over the option's remaining life, and a plain **exercise-now** verdict.
 *
 * Composition, not a new model: the American value is `bawPrice` (Barone–Adesi–Whaley), chosen because
 * it returns *exactly* the intrinsic value inside the exercise region — so the premium is `0` iff the
 * option should be exercised now iff the spot is past the recovered boundary, all consistent.
 */

import {
  ensureFiniteWhenPresent,
  CONVENTIONS_VERSION,
  type Diagnostics,
  type DividendModel,
  ErrorCode,
  InputError,
  type OptionContract,
  type QuantWarning,
  UnsupportedError,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentObject,
  resolveValuationAsOf,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { blackScholesPrice } from './bsm.js';
import { hasDiscreteDividends } from './dividends.js';
import { bawPrice } from './engines/american-approx.js';
import { requireOptionalArgObject } from './facade-util.js';
import { vanillaIntrinsicUnchecked } from './payoff-kernel.js';
import { contractTimeToExpiryYears } from './time.js';
import type { OptionMarket } from './types.js';

/** Options for {@link americanExercise}. */
export interface AmericanExerciseOptions {
  /** Number of maturities in the boundary curve (from τ down to τ/N); default 24. `0` skips the curve. */
  boundaryPoints?: number;
}

/** Law 12 allowlist for {@link AmericanExerciseOptions}. */
const AMERICAN_EXERCISE_KEYS = ['boundaryPoints'] as const;
const AMERICAN_EXERCISE_REQUEST_KEYS = ['contract', 'market', 'options'] as const;

/** One point on the exercise-boundary curve. */
export interface BoundaryPoint {
  /** Time to expiry (years) at this point. */
  yearsToExpiry: number;
  /** The critical spot `S*` at that maturity. */
  criticalSpot: number;
}

/** The American exercise analysis. */
export interface AmericanExerciseResult {
  /**
   * Which leg was analysed — `'call'` or `'put'`.
   *
   * Named `optionType` because that is what it holds: in TotalFinance `style` is the EXERCISE style
   * (`'european' | 'american'`) everywhere else, and every one of these results is American by
   * construction, so a field called `style` reading `'put'` was a straight collision of two
   * vocabularies (pre-1.0 clean break, defect-fix wave, review-1).
   */
  optionType: 'call' | 'put';
  spot: number;
  /** American value (Barone–Adesi–Whaley). */
  american: number;
  /** European value (BSM) — the value stripped of the early-exercise right. */
  european: number;
  /** `american − european ≥ 0` — the dollars the early-exercise right adds. */
  earlyExercisePremium: number;
  /** `premium / american`. */
  premiumFractionOfValue: number;
  intrinsic: number;
  /** `american − intrinsic ≥ 0`. */
  timeValue: number;
  /** `false` for a non-dividend call (early exercise never optimal). */
  earlyExerciseCanBeOptimal: boolean;
  /** `S*(τ)` at the current maturity; `null` when early exercise is never optimal. */
  criticalSpot: number | null;
  /** The American value has collapsed to intrinsic — no time value left to give up. */
  shouldExerciseNow: boolean;
  /** Signed fraction of spot to the boundary (put: `(S−S*)/S`, call: `(S*−S)/S`); `null` if no boundary. */
  spotToBoundary: number | null;
  /** The `S*(τ)` curve over the remaining life (empty when never optimal). */
  boundary: BoundaryPoint[];
  /** Prose an agent relays. */
  rationale: string;
  assumptions: {
    conventionsVersion: string;
    valueEngine: 'barone-adesi-whaley';
    dividendModel: DividendModel;
    timeToExpiryYears: number;
  };
  diagnostics: Diagnostics;
}

/** One cohesive request for American exercise analysis. */
export interface AmericanExerciseInput {
  contract: OptionContract;
  market: OptionMarket;
  options?: AmericanExerciseOptions;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const money = (x: number): string => x.toFixed(2);

/**
 * Recover the American exercise boundary `S*(τ)` from `bawPrice` by bisecting the edge of the region
 * where the American value equals intrinsic. Returns `null` when early exercise is never optimal (a
 * non-dividend call, or no bracketable boundary). Put: exercise region is low spot; call: high spot.
 */
function criticalSpot(input: {
  type: 'call' | 'put';
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}): number | null {
  const {
    type,
    strike: K,
    timeToExpiryYears: tau,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  if (type === 'call' && r - q >= r) return null; // q ≤ 0 — a call is never exercised early
  const tolerance = 1e-9 * K;
  const intrinsic = (S: number): number =>
    vanillaIntrinsicUnchecked({ type, underlyingPrice: S, strike: K });
  const inExercise = (S: number): boolean =>
    bawPrice({
      type,
      spot: S,
      strike: K,
      timeToExpiryYears: tau,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
    }) -
      intrinsic(S) <=
    tolerance;

  let lo: number; // in the CONTINUATION region
  let hi: number; // in the EXERCISE region
  if (type === 'put') {
    // Exercise region is low spot: deep-ITM exercises, at-the-strike continues.
    if (!inExercise(1e-8 * K)) return null; // never optimal (e.g. r ≤ 0)
    lo = K;
    hi = 1e-8 * K;
    if (inExercise(lo)) return lo; // boundary at/above the strike (τ→0) — clamp to K
  } else {
    // Exercise region is high spot: find an upper bracket that exercises.
    lo = K;
    hi = K * 4;
    let expansions = 0;
    while (!inExercise(hi) && expansions < 40) {
      hi *= 2;
      expansions++;
    }
    if (!inExercise(hi)) return null; // no bracketable boundary
  }

  // Bisect between the continuation endpoint `lo` and the exercise endpoint `hi`.
  for (let it = 0; it < 100; it++) {
    const mid = 0.5 * (lo + hi);
    if (inExercise(mid)) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Decompose an American option into its European value plus early-exercise premium, recover the exercise
 * boundary `S*(τ)`, and say whether to exercise now. See `docs/specs/american-exercise.md`.
 */
export function americanExercise(input: AmericanExerciseInput): AmericanExerciseResult {
  requireArgumentObject('americanExercise', 'input', input);
  ensureKnownKeys('americanExercise', 'input', input, AMERICAN_EXERCISE_REQUEST_KEYS);
  const { contract, market, options: options = {} } = input;
  const functionName = 'americanExercise';
  requireArgumentObject(functionName, 'contract', contract);
  requireArgumentObject(functionName, 'market', market);
  requireOptionalArgObject(functionName, 'options', options);
  // Contract/market artifacts may carry provenance metadata; the closed options object remains strict.
  ensureKnownKeys(functionName, 'options', options, AMERICAN_EXERCISE_KEYS);
  const boundaryPoints = (options as Record<string, unknown>)['boundaryPoints'];
  if (
    boundaryPoints !== undefined &&
    (typeof boundaryPoints !== 'number' || !Number.isFinite(boundaryPoints))
  ) {
    throw new InputError(
      `${functionName}: boundaryPoints must be a finite number when provided. Received ${boundaryPoints === null ? 'null' : typeof boundaryPoints}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'boundaryPoints' } },
    );
  }

  if (typeof market.spot !== 'number') {
    throw new InputError(`${functionName}: market.spot is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'spot' },
    });
  }
  ensurePositive(market.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  ensurePositive(contract.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  if (typeof market.riskFreeRate !== 'number') {
    throw new InputError(`${functionName}: market.riskFreeRate (a number) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'riskFreeRate' },
    });
  }
  ensureFinite(market.riskFreeRate, 'riskFreeRate', functionName);
  if (typeof market.volatility !== 'number') {
    throw new InputError(`${functionName}: market.volatility is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'volatility' },
    });
  }
  ensurePositive(market.volatility, 'volatility', functionName);
  // Null is a wrong-typed value, not omission (the 350c2796 ruling): it used to coalesce
  // to 0 BEFORE the finite check and silently price a dividend-free underlying.
  ensureFiniteWhenPresent(market.dividendYield, 'dividendYield', functionName);
  const q = market.dividendYield ?? 0;

  const asOfMs = resolveValuationAsOf(market.asOf, functionName);
  ensureFinite(asOfMs, 'asOf', functionName);
  const tau = contractTimeToExpiryYears(asOfMs, contract, functionName);
  if (tau <= 0) {
    throw new UnsupportedError(
      `${functionName}: contract expiry ${contract.expiry} is not after asOf.`,
      {
        code: ErrorCode.InputNegativeTime,
        context: { asOf: market.asOf, expiry: contract.expiry, tau },
      },
    );
  }

  const type = contract.type;
  const S = market.spot;
  const K = contract.strike;
  const r = market.riskFreeRate;
  const sigma = market.volatility;

  const american = bawPrice({
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: tau,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  });
  const european = blackScholesPrice({
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: tau,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  });
  const intrinsic = vanillaIntrinsicUnchecked({ type, underlyingPrice: S, strike: K });
  const earlyExercisePremium = Math.max(0, american - european);
  const premiumFractionOfValue = american > 0 ? earlyExercisePremium / american : 0;
  const timeValue = Math.max(0, american - intrinsic);
  const shouldExerciseNow = intrinsic > 0 && american - intrinsic <= 1e-8 * Math.max(1, S);

  const critical = criticalSpot({
    type,
    strike: K,
    timeToExpiryYears: tau,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  });
  const earlyExerciseCanBeOptimal = critical !== null;
  const spotToBoundary =
    critical === null ? null : type === 'put' ? (S - critical) / S : (critical - S) / S;

  // Boundary curve over the remaining life (from τ down to τ/N), skipping unbracketable maturities.
  const boundary: BoundaryPoint[] = [];
  const nPoints = options.boundaryPoints ?? 24;
  // Safe integer AND a work cap (2026-08-23 review, P0 "unbounded work"): `Number.isInteger(1e308)`
  // is `true`, so the old check admitted a boundary resolution the loop below could never finish —
  // every point is a full criticalSpot root-solve (bisection over Black–Scholes prices, ~tens of µs),
  // so 10,000 points is already a fraction of a second to seconds, and no plotted exercise boundary
  // resolves more than a few hundred.
  if (!(Number.isSafeInteger(nPoints) && nPoints >= 0 && nPoints <= 10_000)) {
    throw new InputError(
      `${functionName}: boundaryPoints must be an integer in [0, 10,000] — each point runs a criticalSpot root-solve (~tens of µs), so the cap is already seconds of boundary work, and a plotted boundary needs only a few hundred points. Received ${nPoints}.\n  e.g. { boundaryPoints: 48 }`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { boundaryPoints: nPoints, max: 10_000 },
      },
    );
  }
  if (earlyExerciseCanBeOptimal && nPoints > 0) {
    for (let i = 0; i < nPoints; i++) {
      const t = (tau * (nPoints - i)) / nPoints; // τ, τ·(N−1)/N, … , τ/N
      const cs = criticalSpot({
        type,
        strike: K,
        timeToExpiryYears: t,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
      });
      if (cs !== null) boundary.push({ yearsToExpiry: t, criticalSpot: cs });
    }
  }

  const warnings: QuantWarning[] = [];
  let dividendModel: DividendModel;
  if (hasDiscreteDividends(market)) {
    dividendModel = 'discreteSchedule';
    warnings.push(
      warning(
        WarningCode.OptionsExerciseDiscreteDividends,
        `${functionName}: the contract has discrete dividends, but the exercise analysis uses the continuous-yield closed form. Call early-exercise is driven by discrete dividends (right before an ex-date) — use a binomial lattice for the exact boundary there.`,
        'warn',
      ),
    );
  } else {
    dividendModel = q === 0 ? 'none' : 'continuousYield';
  }

  const rationale = composeRationale({
    type,
    S,
    K,
    american,
    european,
    premium: earlyExercisePremium,
    premiumFractionOfValue,
    intrinsic,
    critical,
    shouldExerciseNow,
    earlyExerciseCanBeOptimal,
    spotToBoundary,
  });

  return {
    optionType: type,
    spot: S,
    american,
    european,
    earlyExercisePremium,
    premiumFractionOfValue,
    intrinsic,
    timeValue,
    earlyExerciseCanBeOptimal,
    criticalSpot: critical,
    shouldExerciseNow,
    spotToBoundary,
    boundary,
    rationale,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      valueEngine: 'barone-adesi-whaley',
      dividendModel,
      timeToExpiryYears: tau,
    },
    diagnostics: {
      engine: 'american-exercise',
      method: 'baw + boundary-bisection',
      converged: true,
      warnings,
    },
  };
}

interface RationaleParts {
  type: 'call' | 'put';
  S: number;
  K: number;
  american: number;
  european: number;
  premium: number;
  premiumFractionOfValue: number;
  intrinsic: number;
  critical: number | null;
  shouldExerciseNow: boolean;
  earlyExerciseCanBeOptimal: boolean;
  spotToBoundary: number | null;
}

/** Compose the prose rationale from the exercise analysis. */
function composeRationale(p: RationaleParts): string {
  const name = `American ${p.type}`;
  if (!p.earlyExerciseCanBeOptimal) {
    return `Never exercise early: with no dividend an ${name} equals its European value (${money(
      p.american,
    )}), so the early-exercise right is worthless — always sell rather than exercise.`;
  }
  if (p.shouldExerciseNow) {
    return `Exercise now: the ${name} is worth exactly its intrinsic value (${money(
      p.intrinsic,
    )}) — the spot is past the exercise boundary (${money(
      p.critical!,
    )}), so there is no time value left to give up by exercising.`;
  }
  const move =
    p.type === 'put'
      ? `if the stock falls to ${money(p.critical!)} (currently ${money(p.S)}, ${pct(
          p.spotToBoundary!,
        )} above)`
      : `if the stock rises to ${money(p.critical!)} (currently ${money(p.S)}, ${pct(
          p.spotToBoundary!,
        )} below)`;
  return `Hold, don't exercise: the ${name} (${money(
    p.american,
  )}) exceeds its European value (${money(p.european)}) by ${money(
    p.premium,
  )} — the early-exercise right is ${pct(
    p.premiumFractionOfValue,
  )} of the value and would be thrown away by exercising now. Exercise ${move}.`;
}
