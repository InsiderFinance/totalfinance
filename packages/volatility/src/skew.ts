/**
 * Volatility skew / smile metrics for a single expiry (spec §10.2).
 *
 * Builds the expiry's smile (via {@link VolatilitySurface}) and reports ATM IV, 10/25-delta put/call IVs,
 * risk reversals, butterflies, directional skews, and the ATM skew slope/curvature in log-moneyness.
 * Delta points are located in call-delta space: a 25-delta put is the strike whose call-delta equals
 * `e^{−qt}−0.25` (its put-delta is −0.25); a 25-delta call is call-delta `0.25`.
 */

import {
  type Assumptions,
  type ClosedRequestSpecification,
  type Computed,
  type Diagnostics,
  ErrorCode,
  InputError,
  type MarketInputs,
  type OptionQuote,
  type PriceSource,
  type QuantWarning,
  validateClosedRequest,
  WarningCode,
} from '@totalfinance/core';
import { type SurfaceModel, VolatilitySurface } from './surface.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request spec (spec 3B.1b): the allowlist projected from the declaration.
 * Resolved at module load so a stale key fails at import.
 */
function skewSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `skew: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const SKEW_SPEC = skewSpecOf('skew#0');

const SKEW_EXAMPLE = (): string =>
  "skew({ quotes, market: { riskFreeRate: 0.04, asOf: '2026-06-01T10:30:00-04:00' }, config: { expiry: '2026-06-19' } })";

export type RiskReversalConvention = 'callMinusPut' | 'putMinusCall';

/**
 * Market snapshot for `skew()` — the workspace-canonical {@link MarketInputs}, except `spot` is
 * optional (it falls back to each quote's `underlyingPrice` when omitted) (WS3.2).
 */
export type SkewMarket = Omit<MarketInputs, 'spot'> & {
  /** Spot price. Falls back to each quote's `underlyingPrice` when omitted. */
  spot?: number;
};

/** Non-market skew configuration: which expiry, the price source, model, and RR convention (WS3.2). */
export interface SkewConfig {
  /** The expiry to analyze (ISO label present in the chain). */
  expiry: string;
  priceSource?: PriceSource;
  model?: SurfaceModel;
  /** Risk-reversal sign convention (default `callMinusPut`). */
  riskReversalConvention?: RiskReversalConvention;
}

export interface SkewMetrics {
  expiry: string;
  timeToExpiryYears: number;
  forward: number;
  /** ATM-forward implied vol (the smile evaluated at `K = forward`). */
  atmImpliedVolatility: number;
  put10DeltaImpliedVolatility: number;
  put25DeltaImpliedVolatility: number;
  call25DeltaImpliedVolatility: number;
  call10DeltaImpliedVolatility: number;
  /** 25-/10-delta risk reversals (signed per `riskReversalConvention`). */
  riskReversal25Delta: number;
  riskReversal10Delta: number;
  /** 25-/10-delta butterflies: `(wingCall + wingPut)/2 − atmImpliedVolatility`. */
  butterfly25Delta: number;
  butterfly10Delta: number;
  /** Wing IV minus ATM: `put25DeltaImpliedVolatility − atmImpliedVolatility` and `call25DeltaImpliedVolatility − atmImpliedVolatility`. */
  putSkew: number;
  callSkew: number;
  /** `d(iv)/d(logMoneyness)` at the forward (negative for the usual equity put-skew). */
  skewSlope: number;
  /** `d²(iv)/d(logMoneyness)²` at the forward (smile convexity). */
  smileCurvature: number;
  /** Wing steepness: extra IV in the 10Δ wings over the 25Δ wings, `(iv10P − iv25P) + (iv10C − iv25C)`. */
  wingSteepness: number;
}

export type SkewResult = Computed<SkewMetrics>;

/** Build a linear delta→iv lookup over a slice (call-delta is monotone-decreasing in strike). */
function deltaInterpolator(
  deltas: number[],
  impliedVolatilities: number[],
): {
  at: (cd: number) => number;
  min: number;
  max: number;
} {
  const pairs = deltas
    .map((d, i) => [d, impliedVolatilities[i]!] as const)
    .sort((a, b) => a[0] - b[0]);
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const min = xs[0]!;
  const max = xs[xs.length - 1]!;
  const at = (cd: number): number => {
    if (cd <= min) return ys[0]!;
    if (cd >= max) return ys[ys.length - 1]!;
    let hi = 1;
    while (hi < xs.length && xs[hi]! < cd) hi++;
    const lo = hi - 1;
    const w = (cd - xs[lo]!) / (xs[hi]! - xs[lo]!);
    return ys[lo]! + w * (ys[hi]! - ys[lo]!);
  };
  return { at, min, max };
}

export interface SkewInput {
  quotes: OptionQuote[];
  market: SkewMarket;
  config: SkewConfig;
}

/** Compute skew/smile metrics for one expiry of an option chain. */
export function skew(input: SkewInput): SkewResult {
  // `config` is required (it names the expiry) — a missing field must teach, not die on a raw
  // `.riskReversalConvention` TypeError; the spec names it and its closed key set.
  validateClosedRequest('skew', input, SKEW_SPEC, {
    exampleCall: SKEW_EXAMPLE,
  });
  const { quotes, market, config } = input;
  const convention = config.riskReversalConvention ?? 'callMinusPut';
  const surface = new VolatilitySurface({
    quotes,
    market: {
      riskFreeRate: market.riskFreeRate,
      asOf: market.asOf,
      ...(market.spot !== undefined ? { spot: market.spot } : {}),
      ...(market.dividendYield !== undefined ? { dividendYield: market.dividendYield } : {}),
    },
    config: {
      ...(config.priceSource !== undefined ? { priceSource: config.priceSource } : {}),
      ...(config.model !== undefined ? { model: config.model } : {}),
    },
  });
  const slice = surface.slice(config.expiry);
  const warnings: QuantWarning[] = [...surface.diagnostics.warnings];
  if (!slice) {
    throw new InputError(`skew: expiry "${config.expiry}" is not present in the chain.`, {
      code: ErrorCode.VolatilityExpiryNotFound,
      context: { expiry: config.expiry },
    });
  }

  const q = market.dividendYield ?? 0;
  const dq = Math.exp(-q * slice.timeToExpiryYears);
  const { at, min, max } = deltaInterpolator(slice.deltas, slice.impliedVolatilities);

  // 25/10-delta points in call-delta space (put wings use call-delta dq − |putDelta|).
  const cd = {
    p10: dq - 0.1,
    p25: dq - 0.25,
    c25: 0.25,
    c10: 0.1,
  };
  for (const [label, target] of Object.entries(cd)) {
    if (target < min || target > max) {
      warnings.push({
        code: WarningCode.VolatilitySkewDeltaExtrapolated,
        message: `${label} delta point (call-delta ${target.toFixed(
          3,
        )}) is outside the fitted delta range [${min.toFixed(3)}, ${max.toFixed(3)}].`,
        severity: 'warn',
        context: { label, target, min, max },
      });
    }
  }

  const put10DeltaImpliedVolatility = at(cd.p10);
  const put25DeltaImpliedVolatility = at(cd.p25);
  const call25DeltaImpliedVolatility = at(cd.c25);
  const call10DeltaImpliedVolatility = at(cd.c10);
  const atmImpliedVolatility = surface.impliedVolatility(slice.forward, config.expiry);

  const rrSign = convention === 'callMinusPut' ? 1 : -1;
  const riskReversal25Delta = rrSign * (call25DeltaImpliedVolatility - put25DeltaImpliedVolatility);
  const riskReversal10Delta = rrSign * (call10DeltaImpliedVolatility - put10DeltaImpliedVolatility);
  const butterfly25Delta =
    (call25DeltaImpliedVolatility + put25DeltaImpliedVolatility) / 2 - atmImpliedVolatility;
  const butterfly10Delta =
    (call10DeltaImpliedVolatility + put10DeltaImpliedVolatility) / 2 - atmImpliedVolatility;

  // ATM slope/curvature in log-moneyness via central differences on the smile.
  const h = 0.05;
  const impliedVolatilityUp = surface.impliedVolatility(slice.forward * Math.exp(h), config.expiry);
  const impliedVolatilityDn = surface.impliedVolatility(
    slice.forward * Math.exp(-h),
    config.expiry,
  );
  const skewSlope = (impliedVolatilityUp - impliedVolatilityDn) / (2 * h);
  const smileCurvature =
    (impliedVolatilityUp - 2 * atmImpliedVolatility + impliedVolatilityDn) / (h * h);

  const metrics: SkewMetrics = {
    expiry: config.expiry,
    timeToExpiryYears: slice.timeToExpiryYears,
    forward: slice.forward,
    atmImpliedVolatility,
    put10DeltaImpliedVolatility,
    put25DeltaImpliedVolatility,
    call25DeltaImpliedVolatility,
    call10DeltaImpliedVolatility,
    riskReversal25Delta,
    riskReversal10Delta,
    butterfly25Delta,
    butterfly10Delta,
    putSkew: put25DeltaImpliedVolatility - atmImpliedVolatility,
    callSkew: call25DeltaImpliedVolatility - atmImpliedVolatility,
    skewSlope,
    smileCurvature,
    wingSteepness:
      put10DeltaImpliedVolatility -
      put25DeltaImpliedVolatility +
      (call10DeltaImpliedVolatility - call25DeltaImpliedVolatility),
  };

  const assumptions: Assumptions = {
    ...surface.assumptions,
    timeToExpiryYears: slice.timeToExpiryYears,
  };
  const diagnostics: Diagnostics = {
    engine: 'vol-skew',
    method: 'smile-delta-interpolation',
    converged: true,
    warnings,
  };
  return { value: metrics, assumptions, diagnostics };
}
