/**
 * Model-free volatility analytics (spec §10): the risk-neutral probability distribution implied by an
 * option smile (Breeden–Litzenberger), a realized-volatility cone, and the VIX-style variance-swap
 * fair volatility. These turn a fitted smile or a price history into the "probability of landing in a
 * range" and "is vol cheap/rich" read-outs an options dashboard leads with.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Computed,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensureNonNegative,
  ensurePositive,
  finalizeResult,
  requireArgumentArray,
  validateClosedRequest,
  warning,
} from '@totalfinance/core';
import { quantile, standardDeviation } from '@totalfinance/math';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { RISK_NEUTRAL_ESTIMATE } from './estimate.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import. The `volatilitySmile` CALLBACK and the
 * `returns` ARRAY arguments carry no generated keys and keep their curated checks.
 */
function analyticsSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `analytics: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const RISK_NEUTRAL_OPTIONS_SPEC = analyticsSpecOf('riskNeutralDistribution#1');
const VOLATILITY_CONE_OPTIONS_SPEC = analyticsSpecOf('volatilityCone#1');
const VARIANCE_SWAP_RATE_SPEC = analyticsSpecOf('varianceSwapRate#0');

const RISK_NEUTRAL_EXAMPLE = (): string =>
  'riskNeutralDistribution((strike) => 0.2, { spot: 100, timeToExpiryYears: 0.25, riskFreeRate: 0.04 })';
const VOLATILITY_CONE_EXAMPLE = (): string =>
  'volatilityCone(returns, { windows: [21, 63], periodsPerYear: 252 })';
const VARIANCE_SWAP_RATE_EXAMPLE = (): string =>
  'varianceSwapRate({ strikes: [90, 100, 110], otmPrices: [2.1, 4.2, 1.8], forward: 100.5, ' +
  'riskFreeRate: 0.04, timeToExpiryYears: 0.083 })';

// ───────────────────────── Breeden–Litzenberger risk-neutral distribution ─────────────────────────

export interface RiskNeutralOptions {
  spot: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield?: number;
  /** Central-difference step in strike (default `spot · 0.001`). */
  step?: number;
}

export interface RiskNeutralDistribution {
  /** Risk-neutral PDF at strike `K`: `e^{rT}·∂²C/∂K²` (clamped ≥ 0 — see {@link diagnostics}). */
  density(strike: number): number;
  /** Risk-neutral CDF `P(S_T ≤ K) = 1 + e^{rT}·∂C/∂K`, clamped to [0, 1]. */
  cdf(strike: number): number;
  probabilityBelow(strike: number): number;
  probabilityAbove(strike: number): number;
  probabilityBetween(lowerStrike: number, upperStrike: number): number;
  /**
   * LIVE disclosure channel for the two places this object silently repairs itself — it accumulates
   * as the closures are called, so read it AFTER querying (it starts empty):
   *
   *  • `model.limitation` "negative density clamped" — `∂²C/∂K²` came out negative, which means the
   *    smile is butterfly-arbitrageable there. The clamp keeps `density()` a density; the warning
   *    stops a caller integrating a repaired curve and calling it the market's distribution.
   *  • `model.limitation` "one-sided difference" — a query within `step` of zero, where the centred
   *    difference would price a NEGATIVE strike (which returned `NaN`).
   */
  diagnostics: Diagnostics;
}

/**
 * Breeden–Litzenberger (1978): the risk-neutral terminal distribution implied by a call-price curve.
 * Given the smile `volatilitySmile(strike)`, prices calls via BSM and differentiates numerically:
 * `f(K) = e^{rT}·∂²C/∂K²` and `F(K) = 1 + e^{rT}·∂C/∂K`. Use it for probability cones / expected-range
 * bands. The smile must be arbitrage-free for the density to stay non-negative.
 *
 * Where it repairs itself, it SAYS SO on the returned `diagnostics`: a negative (arbitrageable)
 * density clamped to zero, and the one-sided difference used for strikes within `step` of zero (a
 * deep-downside probe like `density(0.05)` on a $100 name, which used to price a negative strike and
 * return `NaN`). `diagnostics.warnings` fills in as the closures are queried — read it after use.
 */
export function riskNeutralDistribution(
  volatilitySmile: (strike: number) => number,
  options: RiskNeutralOptions,
): RiskNeutralDistribution {
  const functionName = 'riskNeutralDistribution';
  if (typeof volatilitySmile !== 'function') {
    throw new InputError(
      `${functionName}: volatilitySmile must be a function mapping strike → implied vol (e.g. () => 0.2 for a flat smile), got ${
        volatilitySmile === null ? 'null' : typeof volatilitySmile
      }.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'volatilitySmile' },
      },
    );
  }
  validateClosedRequest(functionName, options, RISK_NEUTRAL_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: RISK_NEUTRAL_EXAMPLE,
  });
  ensurePositive(options.spot, 'spot', functionName);
  ensurePositive(options.timeToExpiryYears, 'timeToExpiryYears', functionName);
  const q = options.dividendYield ?? 0;
  // A zero/negative step collapses the finite-difference into a division blow-up — reject it.
  if (options.step !== undefined) ensurePositive(options.step, 'step', functionName);
  const h = options.step ?? Math.max(1e-4, options.spot * 0.001);
  const disc = Math.exp(options.riskFreeRate * options.timeToExpiryYears);
  const C = (K: number): number =>
    blackScholesPrice({
      type: 'call',
      spot: options.spot,
      strike: K,
      timeToExpiryYears: options.timeToExpiryYears,
      riskFreeRate: options.riskFreeRate,
      dividendYield: q,
      volatility: volatilitySmile(K),
    });
  const warnings: QuantWarning[] = [];
  let clampDisclosed = false;
  let oneSidedDisclosed = false;
  const discloseClamp = (K: number, raw: number): void => {
    if (clampDisclosed) return;
    clampDisclosed = true;
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `riskNeutralDistribution: the implied density went NEGATIVE (${raw.toExponential(3)} at strike ${K}) and was clamped to 0 — the smile is butterfly-arbitrageable there, so this is a repaired curve, not the market's distribution. Check the smile with checkButterfly / calibrateSvi before integrating it.`,
        'warn',
        { strike: K, rawDensity: raw },
      ),
    );
  };
  const discloseOneSided = (K: number): void => {
    if (oneSidedDisclosed) return;
    oneSidedDisclosed = true;
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `riskNeutralDistribution: strike ${K} is within one difference step (${h}) of zero, so the centred difference would price a NEGATIVE strike (which returns NaN). A ONE-SIDED difference on [K, K+h, K+2h] was used there instead; it is first-order accurate rather than second-order.`,
        'info',
        { strike: K, step: h },
      ),
    );
  };
  const cdf = (K: number): number => {
    if (!(K > 0)) return 0;
    // Below one step from zero, `C(K − h)` is a negative-strike Black-Scholes call — undefined, and
    // it came back NaN, so a perfectly legal deep-downside probe (`cdf(0.05)` on a $100 name)
    // returned NaN from a function whose whole contract is a probability in [0, 1].
    if (K <= h) {
      discloseOneSided(K);
      const dC = (C(K + h) - C(K)) / h; // forward difference
      return Math.min(1, Math.max(0, 1 + disc * dC));
    }
    const dC = (C(K + h) - C(K - h)) / (2 * h);
    return Math.min(1, Math.max(0, 1 + disc * dC));
  };
  const density = (K: number): number => {
    if (!(K > 0)) return 0;
    // Same guard, second derivative: the one-sided second difference uses K, K+h, K+2h.
    const raw =
      K <= h
        ? (discloseOneSided(K), (disc * (C(K + 2 * h) - 2 * C(K + h) + C(K))) / (h * h))
        : (disc * (C(K + h) - 2 * C(K) + C(K - h))) / (h * h);
    if (raw < 0) discloseClamp(K, raw);
    return Math.max(0, raw);
  };
  return {
    density,
    cdf,
    probabilityBelow: cdf,
    probabilityAbove: (K) => 1 - cdf(K),
    probabilityBetween: (a, b) => Math.max(0, cdf(b) - cdf(a)),
    // The SAME array the closures push into — a caller who holds this object sees the disclosures
    // its own queries produced (a fresh copy per read would hide them).
    diagnostics: { engine: 'risk-neutral-distribution', method: 'breeden-litzenberger', warnings },
  };
}

// ───────────────────────── realized-volatility cone ─────────────────────────

export interface VolatilityConeWindow {
  /** Lookback length (number of returns) for this row. */
  window: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  /** Annualized realized vol of the most recent `window` returns (the "current" reading). */
  current: number;
}

/** Everything `volatilityCone` computes on the way to the rows — the `.explain` disclosure set. */
interface VolatilityConeComputation {
  rows: VolatilityConeWindow[];
  periodsPerYear: number;
  observationCount: number;
  annualizationFactor: number;
}

function volatilityConeComputation(
  functionName: string,
  returns: ArrayLike<number>,
  options: { windows: number[]; periodsPerYear?: number },
): VolatilityConeComputation {
  requireArgumentArray(functionName, 'returns', returns);
  // `windows` names the cone's rows — a missing/scalar value would die on `.map`; the spec teaches.
  validateClosedRequest(functionName, options, VOLATILITY_CONE_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: VOLATILITY_CONE_EXAMPLE,
  });
  const ppy = options.periodsPerYear ?? 252;
  ensurePositive(ppy, 'periodsPerYear', functionName);
  const n = returns.length;
  const scale = Math.sqrt(ppy);
  // A single non-finite return would poison every rolling stddev that overlaps it — reject up front.
  const r = Array.from({ length: n }, (_, i) => {
    ensureFinite(returns[i]!, `returns[${i}]`, functionName);
    return returns[i]!;
  });
  const rows = options.windows.map((window) => {
    // Safe integer (2026-08-23 review, P0): the rolling loop runs `n − window + 1` times, so the
    // sample bounds the work — but a window above 2^53 is no longer an exact count, and the
    // window-vs-history check below must compare real integers.
    if (!Number.isSafeInteger(window) || window < 2) {
      throw new InputError(`${functionName}: each window must be an integer ≥ 2, got ${window}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { window },
      });
    }
    const rvs: number[] = [];
    for (let end = window; end <= n; end++) {
      rvs.push(standardDeviation(r.slice(end - window, end)) * scale);
    }
    if (rvs.length === 0) {
      // window > n: no complete rolling window exists. Emitting an all-NaN row would silently pass a
      // useless result downstream — fail loudly so the caller shortens the window or feeds more history.
      throw new InputError(
        `${functionName}: window ${window} exceeds the ${n}-observation return history — no complete rolling window exists.`,
        { code: ErrorCode.InputOutOfRange, context: { window, observations: n } },
      );
    }
    return {
      window,
      min: Math.min(...rvs),
      p25: quantile(rvs, 0.25),
      median: quantile(rvs, 0.5),
      p75: quantile(rvs, 0.75),
      max: Math.max(...rvs),
      current: rvs[rvs.length - 1]!,
    };
  });
  return { rows, periodsPerYear: ppy, observationCount: n, annualizationFactor: scale };
}

/** The conventions `volatilityCone.explain` echoes: the applied windows and annualization. */
export interface VolatilityConeAssumptions {
  conventionsVersion: string;
  /** The requested lookback windows, echoed in request order (one cone row each). */
  windows: number[];
  /** The applied annualization periods (`options.periodsPerYear`, default 252). */
  periodsPerYear: number;
  /** Realized vol is the rolling stddev of returns scaled by `√periodsPerYear`. */
  annualization: 'sqrt-periods-per-year';
}

export type VolatilityConeFacade = ((
  returns: ArrayLike<number>,
  options: { windows: number[]; periodsPerYear?: number },
) => VolatilityConeWindow[]) & {
  explain: (
    returns: ArrayLike<number>,
    options: { windows: number[]; periodsPerYear?: number },
  ) => Omit<Computed<VolatilityConeWindow[]>, 'assumptions'> & {
    assumptions: VolatilityConeAssumptions;
  };
};

/**
 * Realized-volatility cone: for each lookback `window`, the percentile spread of annualized realized
 * volatility across all rolling windows of the return series, plus the current reading. The classic
 * "is implied vol rich or cheap vs the underlying's own realized history" view.
 *
 * Facade (H27): the plain call returns the rows array; `.explain()` discloses the applied
 * `periodsPerYear`, windows, and annualization convention in `assumptions`, and the observation
 * count / annualization factor in `diagnostics.decomposition`. Hand-attached (not `seriesFacade`)
 * so the closed-request teaching errors for the options bag stay byte-identical.
 */
export const volatilityCone: VolatilityConeFacade = Object.assign(
  (
    returns: ArrayLike<number>,
    options: { windows: number[]; periodsPerYear?: number },
  ): VolatilityConeWindow[] => volatilityConeComputation('volatilityCone', returns, options).rows,
  {
    explain: (
      returns: ArrayLike<number>,
      options: { windows: number[]; periodsPerYear?: number },
    ): Omit<Computed<VolatilityConeWindow[]>, 'assumptions'> & {
      assumptions: VolatilityConeAssumptions;
    } => {
      const c = volatilityConeComputation('volatilityCone.explain', returns, options);
      return finalizeResult('volatilityCone', {
        value: c.rows,
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          windows: [...options.windows],
          periodsPerYear: c.periodsPerYear,
          annualization: 'sqrt-periods-per-year' as const,
        },
        diagnostics: {
          method: 'rolling-window-percentiles',
          // The scaling the rows came from: each realized vol is a rolling stddev multiplied by
          // annualizationFactor = √periodsPerYear, over observationCount return observations.
          decomposition: {
            observationCount: c.observationCount,
            annualizationFactor: c.annualizationFactor,
          },
          warnings: [],
        },
      });
    },
  },
);

// ───────────────────────── variance-swap / VIX-style fair vol ─────────────────────────

export interface VarianceSwapResult {
  /** Fair variance (annualized) from the model-free replication. */
  variance: number;
  /** Fair volatility `√variance` — the VIX-style model-free implied vol. */
  fairVolatility: number;
}

/**
 * Model-free implied volatility via the CBOE VIX replication (Demeterfi–Derman–Kamal–Zou): a strip of
 * out-of-the-money option mid-prices integrates to the fair variance
 * `σ² = (2/T)·Σ (ΔKᵢ/Kᵢ²)·e^{rT}·Q(Kᵢ) − (1/T)·(F/K₀ − 1)²`, where `K₀` is the highest strike below the
 * forward `F`. `otmPrices[i]` is the OTM option (put below `F`, call above) mid at `strikes[i]`.
 *
 * **At `K₀` the CBOE strip is the AVERAGE of the put and the call**, and the `−(1/T)(F/K₀ − 1)²`
 * correction subtracted here is derived for exactly that convention. Supply the `K₀` call as
 * `boundaryCallPrice` and pass the `K₀` PUT in `otmPrices` — the two are averaged for you. With a
 * put-only `K₀` price and no `boundaryCallPrice` the strip under-states variance by
 * `ΔK₀·(F − K₀)/(T·K₀²)` (by put–call parity the missing half-difference is `(C−P)/2 = e^{−rT}(F−K₀)/2`),
 * which on a typical 1-month index chain is ~1.7 vol points — so the disclosure rides the result.
 */
export function varianceSwapRate(options: {
  strikes: number[];
  otmPrices: number[];
  forward: number;
  riskFreeRate: number;
  timeToExpiryYears: number;
  /**
   * The CALL price at `K₀` (the highest strike ≤ `F`), with the `K₀` PUT passed in `otmPrices`.
   * Supplied ⇒ the `K₀` term becomes the CBOE put/call average; omitted ⇒ `otmPrices` is used as
   * given and the put-only bias is disclosed in `diagnostics`.
   */
  boundaryCallPrice?: number;
  /**
   * Set when `otmPrices` at `K₀` is ALREADY the CBOE put/call average (a chain extractor that
   * averaged there). Suppresses the put-only bias disclosure without touching the arithmetic. Cannot
   * be combined with `boundaryCallPrice` — that would average an average.
   */
  boundaryPriceAveraged?: boolean;
}): Computed<VarianceSwapResult, { measure: 'risk-neutral'; method: 'ddkz-replication' }> {
  validateClosedRequest('varianceSwapRate', options, VARIANCE_SWAP_RATE_SPEC, {
    argumentName: 'options',
    exampleCall: VARIANCE_SWAP_RATE_EXAMPLE,
  });
  if (options.boundaryCallPrice !== undefined && options.boundaryPriceAveraged === true) {
    throw new InputError(
      `varianceSwapRate: boundaryCallPrice and boundaryPriceAveraged are mutually exclusive — the first says "otmPrices at K₀ is the PUT, average it with this call", the second says "it is already the average". Pass one.`,
      { code: ErrorCode.InputOutOfRange, context: { function: 'varianceSwapRate' } },
    );
  }
  const functionName = 'varianceSwapRate';
  const { strikes, otmPrices, forward, riskFreeRate, timeToExpiryYears } = options;
  if (strikes.length < 3 || strikes.length !== otmPrices.length) {
    throw new InputError(`${functionName}: need ≥ 3 strikes and matching otmPrices.`, {
      code: ErrorCode.InputOutOfRange,
      context: { strikes: strikes.length, prices: otmPrices.length },
    });
  }
  ensurePositive(forward, 'forward', functionName);
  ensurePositive(timeToExpiryYears, 'timeToExpiryYears', functionName);
  for (let i = 0; i < strikes.length; i++) {
    ensurePositive(strikes[i]!, `strikes[${i}]`, functionName);
    ensureNonNegative(otmPrices[i]!, `otmPrices[${i}]`, functionName);
  }
  // strikes ascending
  const order = strikes.map((_, i) => i).sort((a, b) => strikes[a]! - strikes[b]!);
  const K = order.map((i) => strikes[i]!);
  const Q = order.map((i) => otmPrices[i]!);
  for (let i = 1; i < K.length; i++) {
    if (K[i]! === K[i - 1]!) {
      throw new InputError(`${functionName}: duplicate strike ${K[i]!}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { strike: K[i]! },
      });
    }
  }
  // K0 = highest strike ≤ forward; the replication is undefined if no strike straddles below F.
  if (K[0]! > forward) {
    throw new InputError(
      `${functionName}: need a strike at or below the forward ${forward} (lowest is ${K[0]!}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { forward, lowestStrike: K[0]! },
      },
    );
  }
  let k0 = 0;
  for (let i = 0; i < K.length; i++) if (K[i]! <= forward) k0 = i;

  const warnings: QuantWarning[] = [RISK_NEUTRAL_ESTIMATE];
  // CBOE: the K₀ term is (put + call)/2 — apply it when the caller supplies the K₀ call.
  const boundaryAveraged =
    options.boundaryCallPrice !== undefined || options.boundaryPriceAveraged === true;
  if (options.boundaryCallPrice !== undefined) {
    ensureNonNegative(options.boundaryCallPrice, 'boundaryCallPrice', functionName);
    Q[k0] = (Q[k0]! + options.boundaryCallPrice) / 2;
  }
  // The K₀ strike spacing, shared by the strip sum and the put-only bias estimate below.
  const dK0 =
    k0 === 0
      ? K[1]! - K[0]!
      : k0 === K.length - 1
        ? K[k0]! - K[k0 - 1]!
        : (K[k0 + 1]! - K[k0 - 1]!) / 2;

  const disc = Math.exp(riskFreeRate * timeToExpiryYears);
  let sum = 0;
  for (let i = 0; i < K.length; i++) {
    const dK =
      i === 0
        ? K[1]! - K[0]!
        : i === K.length - 1
          ? K[i]! - K[i - 1]!
          : (K[i + 1]! - K[i - 1]!) / 2;
    sum += (dK / (K[i]! * K[i]!)) * disc * Q[i]!;
  }
  const variance =
    (2 / timeToExpiryYears) * sum - (1 / timeToExpiryYears) * (forward / K[k0]! - 1) ** 2;
  if (!boundaryAveraged) {
    // Quantified, not hand-waved: the missing half of the K₀ put/call average is (C−P)/2, which by
    // parity is e^{−rT}(F−K₀)/2; carried through the strip that is ΔK₀·(F−K₀)/(T·K₀²) of variance.
    const varianceBias = (dK0 * (forward - K[k0]!)) / (timeToExpiryYears * K[k0]! * K[k0]!);
    const volatilityPoints =
      (Math.sqrt(Math.max(0, variance + varianceBias)) - Math.sqrt(Math.max(0, variance))) * 100;
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `varianceSwapRate: no boundaryCallPrice was supplied, so the K₀=${K[k0]!} term used the single price you passed. The CBOE replication averages the K₀ put AND call there, and the (F/K₀−1)² correction subtracted here is derived for that average: with a put-only K₀ the fair variance is understated by ≈ ${varianceBias.toExponential(3)} (${volatilityPoints.toFixed(2)} vol points on this strip). Pass boundaryCallPrice to remove it.`,
        'warn',
        {
          boundaryStrike: K[k0]!,
          forward,
          varianceBias,
          volatilityPointBias: volatilityPoints,
        },
      ),
    );
  }
  let fairVolatility: number;
  if (variance < 0) {
    // A negative fair variance means the OTM strip is internally inconsistent (arbitrageable prices
    // or a strip far too sparse around the forward). Silently returning { variance: -x, fairVolatility: 0 }
    // would hide that; the variance is reported as computed, fairVolatility has no real value (NaN), and the
    // caveat says so explicitly (design law #4 — NaN only alongside a disclosed reason).
    fairVolatility = NaN;
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `fair variance is negative (${variance}) — the OTM strip is arbitrageable or too sparse for the DDKZ replication; fairVolatility is NaN (no real √variance exists).`,
        'warn',
        { variance },
      ),
    );
  } else {
    fairVolatility = Math.sqrt(variance);
  }
  return {
    value: { variance, fairVolatility },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      timeToExpiryYears,
      measure: 'risk-neutral',
      method: 'ddkz-replication',
    },
    diagnostics: { warnings },
  };
}
