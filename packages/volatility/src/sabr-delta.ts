/**
 * SABR Bartlett (minimum-variance) greeks (roadmap Tier 2 — the `minimumVarianceDelta` SABR follow-up).
 *
 * When the smile is a SABR fit, the vol–spot sensitivity is not a free input — the model dictates it,
 * because the forward `F` and the vol level `α` are correlated (`⟨dW_F, dW_α⟩ = ρ dt`). Bartlett (2006)
 * derived the resulting minimum-variance hedges: the greeks that account for the vol move that, on average,
 * accompanies a forward move (and vice-versa).
 *
 *   Δ_Bartlett = ∂V/∂F + ∂V/∂α · (ρν / F^β)          V_Bartlett = ∂V/∂α + ∂V/∂F · (ρ F^β / ν)
 *
 * plus the second-order companion — the minimum-variance **gamma**, the price convexity `d²V/dF²` along the
 * correlated hedge path `α(F)` (≈ the naive gamma at the money, materially different in the wings).
 *
 * `∂V/∂F` (the total SABR delta), `∂V/∂α` (the SABR vega), and `∂²V/∂F²` (the SABR gamma) are exactly the
 * finite-difference greeks `sabrPrice(…, { greeks: true })` computes, so this composes that verified engine
 * and adds the coupling. See `docs/specs/sabr-bartlett-delta.md` and `docs/specs/sabr-bartlett-gamma.md`.
 * The SABR realization of {@link minimumVarianceDelta}.
 */

import {
  type Assumptions,
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  type OptionType,
  ensureFinite,
  ensurePositive,
  validateClosedRequest,
} from '@totalfinance/core';
import {
  type SabrInput,
  type SabrParameters,
  type SabrVolatilityType,
} from '@totalfinance/options';
import { sabrPrice, sabrVolatility } from '@totalfinance/options/sabr';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request spec (spec 3B.1b): the allowlist projected from the declaration.
 * Resolved at module load so a stale key fails at import.
 */
function sabrDeltaSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `sabr-delta: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const SABR_BARTLETT_GREEKS_SPEC = sabrDeltaSpecOf('sabrBartlettGreeks#0');

const SABR_BARTLETT_GREEKS_EXAMPLE = (): string =>
  "sabrBartlettGreeks({ type: 'call', input: { forward: 100, strike: 105, " +
  'timeToExpiryYears: 0.5 }, parameters: { alpha: 0.2, beta: 0.5, rho: -0.3, nu: 0.4 } })';

/** Knobs for {@link sabrBartlettGreeks}. */
export interface SabrBartlettOptions {
  /** Hagan expansion: `'lognormal'` (Black, default) or `'normal'` (Bachelier). */
  volatilityType?: SabrVolatilityType;
}

export interface SabrBartlettGreeksInput {
  type: OptionType;
  input: SabrInput;
  parameters: SabrParameters;
  options?: SabrBartlettOptions;
}

/** The Bartlett (minimum-variance) SABR greeks, alongside the naive SABR greeks they adjust. */
export interface SabrBartlettGreeks {
  /** Hagan implied vol at `(F, K, t)`. */
  impliedVolatility: number;
  /** `∂V/∂F` holding parameters fixed — the naive SABR (model) delta, per 1.00 of forward. */
  sabrDelta: number;
  /** The Bartlett minimum-variance delta, per 1.00 of forward. */
  bartlettDelta: number;
  /** `bartlettDelta − sabrDelta` — the correlation contribution to the delta. */
  deltaAdjustment: number;
  /** `∂V/∂α`, per 1% of `α` — the naive SABR vega. */
  sabrVega: number;
  /** The Bartlett minimum-variance vega, per 1% of `α`. */
  bartlettVega: number;
  /** `bartlettVega − sabrVega` — the correlation contribution to the vega. */
  vegaAdjustment: number;
  /** `∂²V/∂F²` holding parameters fixed — the naive SABR gamma, per 1.00 of forward. */
  sabrGamma: number;
  /** The Bartlett minimum-variance gamma — `d²V/dF²` along the correlated hedge path. */
  bartlettGamma: number;
  /** `bartlettGamma − sabrGamma` — the correlation contribution to the gamma (≈ 0 at the money). */
  gammaAdjustment: number;
}

const FN = 'sabrBartlettGreeks';

/** Resolve the SABR forward `F` and discount rate `r` from `input.forward`, or `input.spot` (+ rate, div). */
function resolveForward(input: SabrInput): { F: number; r: number } {
  const r = input.riskFreeRate ?? 0;
  ensureFinite(r, 'riskFreeRate', FN);
  if (typeof input.forward === 'number') {
    ensurePositive(input.forward, 'forward', FN);
    return { F: input.forward, r };
  }
  if (typeof input.spot === 'number') {
    ensurePositive(input.spot, 'spot', FN);
    const q = input.dividendYield ?? 0;
    ensureFinite(q, 'dividendYield', FN);
    return { F: input.spot * Math.exp((r - q) * input.timeToExpiryYears), r };
  }
  throw new InputError(`${FN}: provide either input.forward or input.spot.`, {
    code: ErrorCode.InputMissingField,
    context: { fields: ['forward', 'spot'] },
  });
}

/**
 * Bartlett (2006) minimum-variance delta, vega & gamma for a SABR-parametrised option — the model-consistent
 * hedges that account for the correlated forward/vol dynamics. Composes `sabrPrice` (naive delta/vega/gamma)
 * with the correlation coupling `ρν/F^β` (delta) and `ρF^β/ν` (vega); the Bartlett gamma is the price
 * convexity along the correlated hedge path. Greeks are w.r.t. the **forward**, as in `sabrPrice`. Each is
 * reported alongside its naive counterpart and the adjustment. See `docs/specs/sabr-bartlett-delta.md` and
 * `docs/specs/sabr-bartlett-gamma.md`.
 */
export function sabrBartlettGreeks(
  request: SabrBartlettGreeksInput,
): Computed<
  SabrBartlettGreeks,
  { measure: 'min-variance-hedge'; volatilityType: SabrVolatilityType }
> {
  validateClosedRequest(FN, request, SABR_BARTLETT_GREEKS_SPEC, {
    argumentName: 'request',
    subject: true,
    exampleCall: SABR_BARTLETT_GREEKS_EXAMPLE,
  });
  const { type, input, parameters, options: options = {} } = request;
  const volatilityType = options.volatilityType ?? 'lognormal';

  // The Bartlett vega coupling ρF^β/ν requires ν > 0. With no vol-of-vol the forward and vol are
  // uncorrelated in level moves and the SABR smile is degenerate, so reject ν ≤ 0 up front with a clear
  // message rather than dividing by zero. (`sabrPrice`/`sabrVolatility` also validate α/β/ρ/strike/t.)
  if (!(parameters.nu > 0)) {
    throw new InputError(
      `${FN}: nu must be > 0 for the Bartlett minimum-variance greeks — with no vol-of-vol the forward and vol level do not co-move; got ${String(
        parameters.nu,
      )}.`,
      { code: ErrorCode.InputOutOfRange, context: { nu: parameters.nu } },
    );
  }

  const { F, r } = resolveForward(input);
  const priced = sabrPrice({
    type,
    input,
    parameters,
    options: { volatilityType, greeks: true },
  });
  const greeks = priced.greeks!; // greeks: true ⇒ present
  const sabrDelta = greeks.delta; // ∂V/∂F (raw, per 1.00 forward)
  const sabrVegaDisplay = greeks.vega; // ∂V/∂α per 1%
  const sabrVegaRaw = sabrVegaDisplay * 100; // per 1.00 α
  const sabrGamma = greeks.gamma; // ∂²V/∂F² (raw), parameters fixed

  const impliedVolatility = sabrVolatility({
    input: { forward: F, strike: input.strike, timeToExpiryYears: input.timeToExpiryYears },
    parameters,
    options: { volatilityType },
  });

  const { beta, rho, nu } = parameters;
  const fBeta = Math.pow(F, beta);
  const alphaPerForward = (rho * nu) / fBeta; // E[δα | δF] per unit F
  const forwardPerAlpha = (rho * fBeta) / nu; // E[δF | δα] per unit α

  const bartlettDelta = sabrDelta + sabrVegaRaw * alphaPerForward;
  const bartlettVegaRaw = sabrVegaRaw + sabrDelta * forwardPerAlpha;
  const bartlettVega = bartlettVegaRaw / 100;

  // Bartlett gamma: the price convexity along the correlated hedge path α(F). Integrating dα/dF = ρν/F^β
  // gives α(F') = α + ρν·(F'^{1−β} − F^{1−β})/(1−β), with the β = 1 log limit. bartlettGamma is the central
  // second difference of the SABR price along that exact path — the P&L convexity a Bartlett-hedger sees.
  const priceAt = (f: number, a: number): number =>
    sabrPrice({
      type,
      input: {
        forward: f,
        strike: input.strike,
        timeToExpiryYears: input.timeToExpiryYears,
        riskFreeRate: r,
      },
      parameters: { ...parameters, alpha: a },
      options: {
        volatilityType,
        greeks: false,
      },
    }).value;
  const alphaOnPath = (fp: number): number =>
    Math.abs(1 - beta) < 1e-12
      ? parameters.alpha + rho * nu * Math.log(fp / F)
      : parameters.alpha +
        (rho * nu * (Math.pow(fp, 1 - beta) - Math.pow(F, 1 - beta))) / (1 - beta);
  const dF = F * 5e-4;
  const bartlettGamma =
    (priceAt(F + dF, alphaOnPath(F + dF)) -
      2 * priced.value +
      priceAt(F - dF, alphaOnPath(F - dF))) /
    (dF * dF);

  const assumptions: Assumptions<{
    measure: 'min-variance-hedge';
    volatilityType: SabrVolatilityType;
  }> = {
    conventionsVersion: CONVENTIONS_VERSION,
    timeToExpiryYears: input.timeToExpiryYears,
    model: 'sabr',
    measure: 'min-variance-hedge',
    volatilityType,
  };

  return {
    value: {
      impliedVolatility,
      sabrDelta,
      bartlettDelta,
      deltaAdjustment: bartlettDelta - sabrDelta,
      sabrVega: sabrVegaDisplay,
      bartlettVega,
      vegaAdjustment: bartlettVega - sabrVegaDisplay,
      sabrGamma,
      bartlettGamma,
      gammaAdjustment: bartlettGamma - sabrGamma,
    },
    assumptions,
    diagnostics: { warnings: [] },
  };
}
