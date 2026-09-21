/**
 * Minimum-variance (smile-adjusted) delta (spec §10.x, roadmap Tier 2). The hedge ratio that accounts
 * for the systematic co-movement of implied vol with spot:
 *
 *   Δ_MV = ∂V/∂S + ∂V/∂σ · (∂σ/∂S) = Δ_BS + Vega · β,   β ≡ ∂σ/∂S
 *
 * `β` is the vol–spot sensitivity in decimal vol per $1 of spot. The **honest** β is empirical — the
 * regression of realized IV changes on spot changes (the leverage effect; negative for equities) — and
 * is the primary input. Deriving β from the current smile needs a **regime** (sticky-strike ⇒ 0;
 * sticky-moneyness ⇒ −skewSlope/spot), offered as a labeled convenience. See
 * `docs/specs/min-variance-delta.md`.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  type OptionType,
  ensurePositive,
  validateClosedRequest,
} from '@totalfinance/core';
import { blackScholesGreeks } from '@totalfinance/options/black-scholes';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request spec (spec 3B.1b): the allowlist projected from the declaration.
 * Resolved at module load so a stale key fails at import.
 */
function minVarianceDeltaSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `min-variance-delta: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const MINIMUM_VARIANCE_DELTA_SPEC = minVarianceDeltaSpecOf('minimumVarianceDelta#0');

const MINIMUM_VARIANCE_DELTA_EXAMPLE = (): string =>
  "minimumVarianceDelta({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, " +
  'riskFreeRate: 0.04, volatility: 0.2, volatilitySpotBeta: -0.001 })';

/** Inputs for {@link minimumVarianceDelta}. Provide exactly one of `volatilitySpotBeta` or `skewSlope`. */
export interface MinimumVarianceDeltaOptions {
  type: OptionType;
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  riskFreeRate: number;
  /** The option's implied vol (decimal). */
  volatility: number;
  /** Continuous dividend yield (decimal, default 0). */
  dividendYield?: number;
  /**
   * ∂σ/∂S directly (decimal vol **per $1 of spot**) — the empirical / minimum-variance β (preferred).
   * Take it from `estimateVolatilitySpotBeta(...).value.volatilitySpotBeta`, which is already in
   * these units. `stickyRegime`'s `volatilitySpotBetaPerLogSpot` is ∂σ/∂lnS — `S ×` larger — so
   * divide it by spot before passing it here, or the smile adjustment is scaled by the spot price.
   */
  volatilitySpotBeta?: number;
  /** ∂σ/∂ln(K) (`SkewMetrics.skewSlope`) — mapped to β via `regime`. */
  skewSlope?: number;
  /** How `skewSlope` maps to β. Default `'sticky-moneyness'`. */
  regime?: 'sticky-strike' | 'sticky-moneyness';
}

/** The minimum-variance delta read-out. */
export interface MinimumVarianceDeltaResult {
  /** `Δ_BS + Vega_raw · β` — the hedge ratio. */
  minimumVarianceDelta: number;
  /** The Black-Scholes spot delta `∂V/∂S`. */
  blackScholesDelta: number;
  /** Display vega (per 1% vol) at the option. */
  vega: number;
  /** The `β = ∂σ/∂S` actually used (decimal vol **per $1 of spot**, never per log-spot). */
  volatilitySpotBeta: number;
  /** `minimumVarianceDelta − blackScholesDelta` — the smile adjustment. */
  skewAdjustment: number;
}

const FN = 'minimumVarianceDelta';

/**
 * The minimum-variance (smile-adjusted) delta for one option. Composes `blackScholesGreeks` (for `Δ_BS` and
 * vega) with a vol–spot sensitivity `β`. See the spec — β should be empirical (leverage) for a true
 * minimum-variance hedge; the skew-derived regimes are smile models, not the leverage effect.
 */
export function minimumVarianceDelta(
  options: MinimumVarianceDeltaOptions,
): Computed<
  MinimumVarianceDeltaResult,
  { measure: 'real-world-hedge'; betaSource: string; regime?: string }
> {
  validateClosedRequest(FN, options, MINIMUM_VARIANCE_DELTA_SPEC, {
    argumentName: 'options',
    exampleCall: MINIMUM_VARIANCE_DELTA_EXAMPLE,
  });
  ensurePositive(options.spot, 'spot', FN);
  ensurePositive(options.strike, 'strike', FN);
  ensurePositive(options.timeToExpiryYears, 'timeToExpiryYears', FN);
  ensurePositive(options.volatility, 'volatility', FN);
  const q = options.dividendYield ?? 0;

  // Resolve β = ∂σ/∂S. A supplied β wins; else derive it from the skew slope under a regime; a missing
  // β is an error, not a silent 0 (which would masquerade the BSM delta as "minimum-variance").
  let beta: number;
  let betaSource: string;
  let regime: string | undefined;
  if (options.volatilitySpotBeta !== undefined) {
    beta = options.volatilitySpotBeta;
    betaSource = 'supplied';
  } else if (options.skewSlope !== undefined) {
    regime = options.regime ?? 'sticky-moneyness';
    if (regime === 'sticky-strike') {
      beta = 0;
      betaSource = 'skew-sticky-strike';
    } else if (regime === 'sticky-moneyness') {
      beta = -options.skewSlope / options.spot;
      betaSource = 'skew-sticky-moneyness';
    } else {
      throw new InputError(
        `${FN}: regime must be 'sticky-strike' | 'sticky-moneyness', got "${regime}".`,
        { code: ErrorCode.InputInvalidEnum, context: { regime } },
      );
    }
  } else {
    throw new InputError(
      `${FN}: a vol–spot sensitivity is required — pass volatilitySpotBeta (∂σ/∂S) or skewSlope (+ regime). A minimum-variance delta with no β is just the BSM delta.`,
      { code: ErrorCode.InputMissingField, context: { field: 'volatilitySpotBeta|skewSlope' } },
    );
  }

  const greeks = blackScholesGreeks({
    type: options.type,
    spot: options.spot,
    strike: options.strike,
    timeToExpiryYears: options.timeToExpiryYears,
    riskFreeRate: options.riskFreeRate,
    dividendYield: q,
    volatility: options.volatility,
  });
  const vegaRaw = greeks.vega * 100; // display (per 1%) → raw (per 1.00 vol), so vegaRaw·β is a delta
  const skewAdjustment = vegaRaw * beta;

  return {
    value: {
      minimumVarianceDelta: greeks.delta + skewAdjustment,
      blackScholesDelta: greeks.delta,
      vega: greeks.vega,
      volatilitySpotBeta: beta,
      skewAdjustment,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      timeToExpiryYears: options.timeToExpiryYears,
      measure: 'real-world-hedge',
      betaSource,
      ...(regime !== undefined ? { regime } : {}),
    },
    diagnostics: { warnings: [] },
  };
}
