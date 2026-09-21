/**
 * Risk reversal & butterfly (spec: `docs/specs/risk-reversal-butterfly.md`). The standard FX/crypto
 * smile-quoting decomposition: a smile ⇄ `(ATM, riskReversal, butterfly)`.
 *
 *   - `riskReversalButterfly` — from a smile function, find the δ-delta wing strikes and report the ATM
 *     vol, the risk reversal (`callVolatility − putVolatility`, the skew) and the butterfly (`avg − ATM`, the curvature).
 *   - `smileFromQuotes` — the exact inverse: from `(ATM, RR, BF)` recover the three `(strike, vol)` anchors.
 *
 * Forward delta (`Δ_call = N(d₁)`) throughout — spot/rate-free.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  ensureFinite,
  ensurePositive,
  validateClosedRequest,
} from '@totalfinance/core';
import { brent, normalCdf, normalInverseCdf } from '@totalfinance/math';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import.
 */
function riskReversalSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `risk-reversal: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const RISK_REVERSAL_BUTTERFLY_SPEC = riskReversalSpecOf('riskReversalButterfly#0');
const SMILE_FROM_QUOTES_SPEC = riskReversalSpecOf('smileFromQuotes#0');

const RISK_REVERSAL_BUTTERFLY_EXAMPLE = (): string =>
  'riskReversalButterfly({ forward: 100, timeToExpiryYears: 0.25, smile: (strike) => 0.2, delta: 0.25 })';
const SMILE_FROM_QUOTES_EXAMPLE = (): string =>
  'smileFromQuotes({ forward: 100, timeToExpiryYears: 0.25, atmVolatility: 0.2, ' +
  'riskReversal: -0.02, butterfly: 0.01 })';

const assumptionsFor = (
  delta: number,
): { conventionsVersion: string; deltaConvention: 'forward'; delta: number } => ({
  conventionsVersion: CONVENTIONS_VERSION,
  deltaConvention: 'forward',
  delta,
});

/** Forward-delta of a call at strike `K` with vol `σ`: `N(d₁)`. */
function forwardCallDelta(input: {
  forward: number;
  strike: number;
  volatility: number;
  sqrtTime: number;
}): number {
  const { forward: F, strike: K, volatility: sigma, sqrtTime: sqrtT } = input;
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * sqrtT * sqrtT) / (sigma * sqrtT);
  return normalCdf(d1);
}

/** Validate the `delta` level: a finite number in `(0, 0.5)`. */
function requireDelta(delta: number, functionName: string): void {
  ensureFinite(delta, 'delta', functionName);
  if (!(delta > 0 && delta < 0.5)) {
    throw new InputError(`${functionName}: delta must be in (0, 0.5); got ${delta}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { delta },
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Forward: smile → (ATM, RR, BF)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Input for {@link riskReversalButterfly}. */
export interface RiskReversalButterflyInput {
  /** Forward price of the underlying. */
  forward: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** The smile: strike → implied vol (from any fit — SVI, SSVI, volatilitySurface, …). */
  smile: (strike: number) => number;
  /** Delta level for the wings (0.25 = 25-delta). Default 0.25. Must be in `(0, 0.5)`. */
  delta?: number;
}

/** The risk-reversal / butterfly decomposition of a smile. */
export interface RiskReversalButterfly {
  /** ATM vol (at `K = forward`). */
  atmVolatility: number;
  /** The δ-delta call strike. */
  callStrike: number;
  /** The vol at the call strike. */
  callVolatility: number;
  /** The δ-delta put strike. */
  putStrike: number;
  /** The vol at the put strike. */
  putVolatility: number;
  /** `callVolatility − putVolatility` — the skew (< 0 ⇒ puts bid). */
  riskReversal: number;
  /** `(callVolatility + putVolatility)/2 − atmVolatility` — the curvature (> 0 ⇒ smile). */
  butterfly: number;
  delta: number;
  assumptions: { conventionsVersion: string; deltaConvention: 'forward'; delta: number };
  diagnostics: Diagnostics;
}

/** Root-find the strike where the forward call-delta equals `target`, on `[lo, hi]`. */
function solveDeltaStrike(request: {
  input: RiskReversalButterflyInput;
  target: number;
  lowerBound: number;
  upperBound: number;
  sqrtTime: number;
  label: string;
  functionName: string;
}): number {
  const {
    input,
    target,
    lowerBound: lo,
    upperBound: hi,
    sqrtTime: sqrtT,
    label,
    functionName,
  } = request;
  const F = input.forward;
  const res = brent(
    (K) => {
      const sigma = input.smile(K);
      if (!(sigma > 0) || !Number.isFinite(sigma)) return Number.NaN;
      return (
        forwardCallDelta({ forward: F, strike: K, volatility: sigma, sqrtTime: sqrtT }) - target
      );
    },
    lo,
    hi,
    { tolerance: 1e-12, maximumIterations: 200 },
  );
  if (!res.converged || !Number.isFinite(res.value)) {
    throw new InputError(
      `${functionName}: could not find a ${label} strike with forward call-delta ${target.toFixed(
        4,
      )} on the supplied smile — the smile is too extreme for this delta (try a larger delta, or check the smile).`,
      { code: ErrorCode.SolverNoConvergence, context: { target, bracket: [lo, hi] } },
    );
  }
  return res.value;
}

/**
 * Decompose a smile into the ATM vol, the δ-delta **risk reversal** (`callVolatility − putVolatility`, the skew) and
 * **butterfly** (`(callVolatility + putVolatility)/2 − ATM`, the curvature) — the standard FX/crypto quoting triple.
 * Forward delta throughout. See `docs/specs/risk-reversal-butterfly.md`.
 */
export function riskReversalButterfly(input: RiskReversalButterflyInput): RiskReversalButterfly {
  const functionName = 'riskReversalButterfly';
  validateClosedRequest(functionName, input, RISK_REVERSAL_BUTTERFLY_SPEC, {
    exampleCall: RISK_REVERSAL_BUTTERFLY_EXAMPLE,
  });
  ensurePositive(input.forward, 'forward', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  const delta = input.delta ?? 0.25;
  requireDelta(delta, functionName);

  const F = input.forward;
  const sqrtT = Math.sqrt(input.timeToExpiryYears);
  const atmVolatility = input.smile(F);
  ensurePositive(atmVolatility, 'smile(forward)', functionName);

  // Bracket the wings ±8 ATM-vol standard deviations from the forward.
  const span = Math.exp(8 * atmVolatility * sqrtT);
  const callStrike = solveDeltaStrike({
    input,
    target: delta,
    lowerBound: F,
    upperBound: F * span,
    sqrtTime: sqrtT,
    label: 'call',
    functionName,
  });
  // Put |Δ| = 1 − N(d₁) = δ ⇒ N(d₁) = 1 − δ (an OTM put below F).
  const putStrike = solveDeltaStrike({
    input,
    target: 1 - delta,
    lowerBound: F / span,
    upperBound: F,
    sqrtTime: sqrtT,
    label: 'put',
    functionName,
  });

  const callVolatility = input.smile(callStrike);
  const putVolatility = input.smile(putStrike);
  ensurePositive(callVolatility, 'smile(callStrike)', functionName);
  ensurePositive(putVolatility, 'smile(putStrike)', functionName);
  const riskReversal = callVolatility - putVolatility;
  const butterfly = (callVolatility + putVolatility) / 2 - atmVolatility;

  return {
    atmVolatility,
    callStrike,
    callVolatility,
    putStrike,
    putVolatility,
    riskReversal,
    butterfly,
    delta,
    assumptions: assumptionsFor(delta),
    diagnostics: {
      engine: 'risk-reversal-butterfly',
      method: 'forward-delta wings',
      converged: true,
      warnings: [],
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Inverse: (ATM, RR, BF) → smile anchors
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Input for {@link smileFromQuotes}. */
export interface SmileFromQuotesInput {
  forward: number;
  timeToExpiryYears: number;
  /** ATM vol. */
  atmVolatility: number;
  /** Risk reversal (`callVolatility − putVolatility`). */
  riskReversal: number;
  /** Butterfly (`(callVolatility + putVolatility)/2 − atmVolatility`). */
  butterfly: number;
  /** Delta level. Default 0.25. */
  delta?: number;
}

/** The three `(strike, vol)` smile anchors implied by the quotes. */
export interface SmileAnchors {
  putStrike: number;
  putVolatility: number;
  atmStrike: number;
  atmVolatility: number;
  callStrike: number;
  callVolatility: number;
  delta: number;
  assumptions: { conventionsVersion: string; deltaConvention: 'forward'; delta: number };
  diagnostics: Diagnostics;
}

/**
 * Recover the three smile anchors — the δ-delta put, the ATM, and the δ-delta call `(strike, vol)` — from
 * the `(ATM, riskReversal, butterfly)` quotes. Exact inverse of {@link riskReversalButterfly}: the wing
 * volatilities are `ATM + BF ± RR/2`, and each wing strike is closed form (`K = F·exp(½σ²T − Φ⁻¹(·)σ√T)`) since
 * the vol is now known. See `docs/specs/risk-reversal-butterfly.md`.
 */
export function smileFromQuotes(input: SmileFromQuotesInput): SmileAnchors {
  const functionName = 'smileFromQuotes';
  validateClosedRequest(functionName, input, SMILE_FROM_QUOTES_SPEC, {
    exampleCall: SMILE_FROM_QUOTES_EXAMPLE,
  });
  ensurePositive(input.forward, 'forward', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.atmVolatility, 'atmVolatility', functionName);
  const delta = input.delta ?? 0.25;
  requireDelta(delta, functionName);

  const F = input.forward;
  const sqrtT = Math.sqrt(input.timeToExpiryYears);
  const callVolatility = input.atmVolatility + input.butterfly + input.riskReversal / 2;
  const putVolatility = input.atmVolatility + input.butterfly - input.riskReversal / 2;
  if (!(callVolatility > 0) || !(putVolatility > 0)) {
    throw new InputError(
      `${functionName}: the quotes imply a non-positive wing vol (call ${callVolatility}, put ${putVolatility}); check ATM/RR/BF.`,
      { code: ErrorCode.InputOutOfRange, context: { callVolatility, putVolatility } },
    );
  }

  // K = F·exp(½σ²T − Φ⁻¹(N(d₁))·σ√T); N(d₁) = δ (call), 1 − δ (put).
  const callStrike =
    F *
    Math.exp(
      0.5 * callVolatility * callVolatility * sqrtT * sqrtT -
        normalInverseCdf(delta) * callVolatility * sqrtT,
    );
  const putStrike =
    F *
    Math.exp(
      0.5 * putVolatility * putVolatility * sqrtT * sqrtT -
        normalInverseCdf(1 - delta) * putVolatility * sqrtT,
    );

  return {
    putStrike,
    putVolatility,
    atmStrike: F,
    atmVolatility: input.atmVolatility,
    callStrike,
    callVolatility,
    delta,
    assumptions: assumptionsFor(delta),
    diagnostics: {
      engine: 'smile-from-quotes',
      method: 'closed-form anchors',
      converged: true,
      warnings: [],
    },
  };
}
