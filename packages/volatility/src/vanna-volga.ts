/**
 * Vanna–volga smile construction (spec: `docs/specs/vanna-volga.md`). The FX/crypto market standard for
 * building a full smile from three quotes — ATM vol + the δ-delta risk reversal and butterfly. Prices
 * any strike as the flat-ATM Black–Scholes value plus the cost of a portfolio of the three market
 * instruments that hedges the option's vega, vanna, and volga, so the smile **reprices the three market
 * pillars exactly** and interpolates smoothly. Composes `smileFromQuotes` (pillars) and round-trips
 * through `riskReversalButterfly` (quotes). Forward (undiscounted) terms throughout — discount-invariant.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentArray,
  requireArgumentObject,
  validateClosedRequest,
  warning,
} from '@totalfinance/core';
import { luDecompose, luSolve, makePchipInterpolator, normalPdf } from '@totalfinance/math';
import {
  blackScholesImpliedVolatility,
  blackScholesPrice,
} from '@totalfinance/options/black-scholes';
import { riskNeutralDistribution } from './analytics.js';
import { smileFromQuotes } from './risk-reversal.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import. `vannaVolgaApproximation` and
 * `vannaVolgaDensity` carry no generated keys and keep their curated Law 12 allowlists.
 */
function vannaVolgaSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `vanna-volga: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

/**
 * Hard cap on the Breeden-Litzenberger density grid (2026-08-23 review, P0): `gridPoints` sizes
 * the strike/density/cdf arrays and each point costs several smile + Black-Scholes evaluations,
 * so an "integer" of 1e308 was an absurd allocation. 100,001 (odd, keeping ATM on the centre
 * node) is 125× the 801-point default and still well under a second of synchronous work.
 */
const MAX_DENSITY_GRID_POINTS = 100_001;

const CALIBRATE_VANNA_VOLGA_SPEC = vannaVolgaSpecOf('calibrateVannaVolga#0');
const CALIBRATE_VANNA_VOLGA_5_SPEC = vannaVolgaSpecOf('calibrateVannaVolga5#0');
const VANNA_VOLGA_5_DENSITY_SPEC = vannaVolgaSpecOf('vannaVolga5Density#0');

const CALIBRATE_VANNA_VOLGA_EXAMPLE = (): string =>
  'calibrateVannaVolga({ forward: 100, timeToExpiryYears: 0.25, atmVolatility: 0.2, ' +
  'riskReversal: -0.02, butterfly: 0.01, strikes: [90, 100, 110] })';
const CALIBRATE_VANNA_VOLGA_5_EXAMPLE = (): string =>
  'calibrateVannaVolga5({ forward: 100, timeToExpiryYears: 0.25, atmVolatility: 0.2, ' +
  'riskReversal25: -0.02, butterfly25: 0.01, riskReversal10: -0.035, butterfly10: 0.025, ' +
  'strikes: [80, 100, 120] })';
const VANNA_VOLGA_5_DENSITY_EXAMPLE = (): string =>
  'vannaVolga5Density({ forward: 100, timeToExpiryYears: 0.25, atmVolatility: 0.2, ' +
  'riskReversal25: -0.02, butterfly25: 0.01, riskReversal10: -0.035, butterfly10: 0.025 })';

/** Below this vol (0.1%) a VV inversion is treated as a far-extrapolation breakdown, not a real quote. */
const MIN_VOL = 1e-3;

/** Input for {@link calibrateVannaVolga}. */
export interface VannaVolgaInput {
  /** Forward price of the underlying. */
  forward: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** ATM vol. */
  atmVolatility: number;
  /** δ-delta risk reversal (`callVolatility − putVolatility`). */
  riskReversal: number;
  /** δ-delta butterfly (`(callVolatility + putVolatility)/2 − atmVolatility`). */
  butterfly: number;
  /** Delta level for the pillars. Default 0.25. */
  delta?: number;
  /** Strikes to evaluate the constructed smile at. */
  strikes: number[];
}

/** The vanna–volga-constructed smile and the pillars it reprices. */
export interface VannaVolgaSmile {
  /** Requested strikes. */
  strikes: number[];
  /** The constructed vol at each strike (aligned to `strikes`). */
  volatilities: number[];
  /** The three market pillars the smile reprices exactly. */
  pillars: {
    putStrike: number;
    putVolatility: number;
    atmStrike: number;
    atmVolatility: number;
    callStrike: number;
    callVolatility: number;
  };
  delta: number;
  assumptions: {
    conventionsVersion: string;
    method: 'vanna-volga';
    deltaConvention: 'forward';
    delta: number;
  };
  diagnostics: Diagnostics;
}

/**
 * Law 12 allowlists for the three entry points that had none. A typo'd knob here is silent and
 * expensive: `gridPoint: 2001` or `widthSd: 8` left the density on its 801-point / 6-sd DEFAULT grid
 * and the caller read the truncated moments as if their request had been honoured.
 */
const VANNA_VOLGA_APPROXIMATION_KEYS = [
  'forward',
  'timeToExpiryYears',
  'atmVolatility',
  'riskReversal',
  'butterfly',
  'delta',
  'strikes',
  'order',
] as const;

const VANNA_VOLGA_DENSITY_KEYS = [
  'forward',
  'timeToExpiryYears',
  'atmVolatility',
  'riskReversal',
  'butterfly',
  'delta',
  'order',
  'gridPoints',
  'widthStandardDeviations',
  'step',
] as const;

interface ForwardBlackInput {
  forward: number;
  strike: number;
  timeToExpiryYears: number;
  volatility: number;
}

/** Forward (undiscounted) Black call price. */
const fwdCall = ({ forward, strike, timeToExpiryYears, volatility }: ForwardBlackInput): number =>
  blackScholesPrice({
    type: 'call',
    spot: forward,
    strike,
    timeToExpiryYears,
    riskFreeRate: 0,
    dividendYield: 0,
    volatility,
  });

/** Raw forward `(vega, vanna, volga)` at strike `K`, vol `σ`. */
function fwdGreeks(input: ForwardBlackInput): [number, number, number] {
  const { forward: F, strike: K, timeToExpiryYears: T, volatility: sigma } = input;
  const sqrtT = Math.sqrt(T);
  const vol = sigma * sqrtT;
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / vol;
  const d2 = d1 - vol;
  const pdf = normalPdf(d1);
  const vega = F * pdf * sqrtT;
  const vanna = (-pdf * d2) / sigma;
  const volga = (vega * d1 * d2) / sigma;
  return [vega, vanna, volga];
}

/**
 * Construct a vanna–volga smile from the `(ATM, riskReversal, butterfly)` quotes and evaluate it at the
 * requested strikes. The three market pillars (from {@link smileFromQuotes}) reprice exactly; strikes so
 * far out of range that the VV price violates the no-arbitrage bounds cannot be inverted and are reported.
 * See `docs/specs/vanna-volga.md`.
 */
export function calibrateVannaVolga(input: VannaVolgaInput): VannaVolgaSmile {
  const functionName = 'calibrateVannaVolga';
  validateClosedRequest(functionName, input, CALIBRATE_VANNA_VOLGA_SPEC, {
    exampleCall: CALIBRATE_VANNA_VOLGA_EXAMPLE,
  });
  ensurePositive(input.forward, 'forward', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.atmVolatility, 'atmVolatility', functionName);
  if (input.strikes.length === 0) {
    throw new InputError(`${functionName}: strikes must be a non-empty array.`, {
      code: ErrorCode.InputOutOfRange,
      context: { strikes: 0 },
    });
  }
  input.strikes.forEach((K, i) => ensurePositive(K, `strikes[${i}]`, functionName));
  const delta = input.delta ?? 0.25;

  const F = input.forward;
  const T = input.timeToExpiryYears;
  const atm = input.atmVolatility;
  // The three pillars from the quotes (also validates delta ∈ (0, 0.5) and positive wing volatilities).
  const p = smileFromQuotes({
    forward: F,
    timeToExpiryYears: T,
    atmVolatility: atm,
    riskReversal: input.riskReversal,
    butterfly: input.butterfly,
    delta,
  });
  const pillarK = [p.putStrike, p.atmStrike, p.callStrike];
  const pillarSig = [p.putVolatility, p.atmVolatility, p.callVolatility];

  // The 3×3 pillar-greeks matrix (columns = each pillar's vega/vanna/volga at the ATM vol) is fixed
  // across all query strikes, so factor it once. `M[row][col]`.
  const g0 = fwdGreeks({ forward: F, strike: pillarK[0]!, timeToExpiryYears: T, volatility: atm });
  const g1 = fwdGreeks({ forward: F, strike: pillarK[1]!, timeToExpiryYears: T, volatility: atm });
  const g2 = fwdGreeks({ forward: F, strike: pillarK[2]!, timeToExpiryYears: T, volatility: atm });
  const M = [
    [g0[0], g1[0], g2[0]],
    [g0[1], g1[1], g2[1]],
    [g0[2], g1[2], g2[2]],
  ];
  let lu: ReturnType<typeof luDecompose>;
  try {
    lu = luDecompose(M);
  } catch {
    throw new InputError(
      `${functionName}: the pillar vega/vanna/volga matrix is singular — the three pillars are degenerate (check the delta and quotes).`,
      { code: ErrorCode.LinalgSingular, context: { pillarStrikes: pillarK } },
    );
  }

  // Market cost carried by each pillar (the vol correction the hedge pays for).
  const pillarCost = [0, 1, 2].map(
    (i) =>
      fwdCall({
        forward: F,
        strike: pillarK[i]!,
        timeToExpiryYears: T,
        volatility: pillarSig[i]!,
      }) - fwdCall({ forward: F, strike: pillarK[i]!, timeToExpiryYears: T, volatility: atm }),
  );

  const volatilities = new Array<number>(input.strikes.length);
  const unrepresentable: number[] = [];
  input.strikes.forEach((K, idx) => {
    const w = luSolve(
      lu,
      fwdGreeks({ forward: F, strike: K, timeToExpiryYears: T, volatility: atm }),
    );
    if (!w.every((x) => Number.isFinite(x))) {
      unrepresentable.push(K);
      return;
    }
    const price =
      fwdCall({ forward: F, strike: K, timeToExpiryYears: T, volatility: atm }) +
      w[0]! * pillarCost[0]! +
      w[1]! * pillarCost[1]! +
      w[2]! * pillarCost[2]!;
    const impliedVolatility = blackScholesImpliedVolatility({
      type: 'call',
      price,
      spot: F,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: 0,
      dividendYield: 0,
    });
    // Un-representable if the price is out of the no-arb bounds (no inversion) OR the VV price has
    // collapsed to intrinsic, giving a degenerate ≈ 0 vol — a far-extrapolation breakdown, not a real quote.
    if (!impliedVolatility.converged || !(impliedVolatility.value >= MIN_VOL)) {
      unrepresentable.push(K);
      return;
    }
    volatilities[idx] = impliedVolatility.value;
  });

  if (unrepresentable.length > 0) {
    throw new InputError(
      `${functionName}: the vanna–volga price is outside the no-arbitrage bounds at ${
        unrepresentable.length
      } strike(s) (${unrepresentable
        .map((k) => k.toFixed(2))
        .join(
          ', ',
        )}) — too far from the pillars to represent; query strikes nearer the ATM/wing range.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { strikes: unrepresentable, pillarStrikes: pillarK },
      },
    );
  }

  return {
    strikes: [...input.strikes],
    volatilities,
    pillars: {
      putStrike: p.putStrike,
      putVolatility: p.putVolatility,
      atmStrike: p.atmStrike,
      atmVolatility: p.atmVolatility,
      callStrike: p.callStrike,
      callVolatility: p.callVolatility,
    },
    delta,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: 'vanna-volga',
      deltaConvention: 'forward',
      delta,
    },
    diagnostics: {
      engine: 'vanna-volga',
      method: 'exact vega/vanna/volga replication',
      converged: true,
      warnings: [],
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Castagna–Mercurio (2007) closed-form approximation
// ────────────────────────────────────────────────────────────────────────────

/** Input for {@link vannaVolgaApproximation} — the vanna-volga input plus the CM order. */
export interface VannaVolgaApproximationInput extends VannaVolgaInput {
  /**
   * Castagna–Mercurio order: `1` (a quadratic interpolation of the three volatilities in log-strike) or `2`
   * (curvature-corrected; the accurate, market-standard form — default).
   */
  order?: 1 | 2;
}

/** The Castagna–Mercurio-approximated smile and the pillars it reprices. */
export interface VannaVolgaApproximationSmile {
  strikes: number[];
  volatilities: number[];
  pillars: {
    putStrike: number;
    putVolatility: number;
    atmStrike: number;
    atmVolatility: number;
    callStrike: number;
    callVolatility: number;
  };
  delta: number;
  order: 1 | 2;
  assumptions: {
    conventionsVersion: string;
    method: 'castagna-mercurio';
    deltaConvention: 'forward';
    delta: number;
    order: 1 | 2;
  };
  diagnostics: Diagnostics;
}

/**
 * Castagna–Mercurio closed-form vanna-volga implied vol at strike `K` from the three pillars. Both orders
 * reprice the pillars exactly; the 2nd order adds the curvature correction. Returns `NaN` on a
 * far-extrapolation breakdown (a negative `√` argument), which the caller reports.
 */
interface CastagnaMercurioInput {
  order: 1 | 2;
  forward: number;
  timeToExpiryYears: number;
  strike: number;
  putStrike: number;
  atmStrike: number;
  callStrike: number;
  putVolatility: number;
  atmVolatility: number;
  callVolatility: number;
}

function castagnaMercurio(input: CastagnaMercurioInput): number {
  const {
    order,
    forward: F,
    timeToExpiryYears: T,
    strike: K,
    putStrike: K1,
    atmStrike: K2,
    callStrike: K3,
    putVolatility: s1,
    atmVolatility: s2,
    callVolatility: s3,
  } = input;
  const ln = Math.log;
  const y1 = (ln(K2 / K) * ln(K3 / K)) / (ln(K2 / K1) * ln(K3 / K1));
  const y2 = (ln(K / K1) * ln(K3 / K)) / (ln(K2 / K1) * ln(K3 / K2));
  const y3 = (ln(K / K1) * ln(K / K2)) / (ln(K3 / K1) * ln(K3 / K2));
  const first = y1 * s1 + y2 * s2 + y3 * s3; // log-strike Lagrange interpolation
  if (order === 1) return first;

  // Forward Black d₁·d₂ at the ATM vol σ₂.
  const d1d2 = (k: number): number => {
    const v = s2 * Math.sqrt(T);
    const d1 = (ln(F / k) + 0.5 * s2 * s2 * T) / v;
    return d1 * (d1 - v);
  };
  const D1 = y1 * (s1 - s2) + y3 * (s3 - s2); // = first − σ₂
  const D2 = y1 * d1d2(K1) * (s1 - s2) ** 2 + y3 * d1d2(K3) * (s3 - s2) ** 2;
  const dd = d1d2(K);
  // At K = F·e^{±½σ₂²T} the denominator d₁d₂ → 0; the 2nd-order formula has the finite limit
  // σ₂ + D₁ + D₂/(2σ₂) (a first-order interpolation plus a small curvature correction).
  if (Math.abs(dd) < 1e-12) return s2 + D1 + D2 / (2 * s2);
  const arg = s2 * s2 + dd * (2 * s2 * D1 + D2);
  if (arg < 0) return Number.NaN; // far-extrapolation breakdown
  return s2 + (-s2 + Math.sqrt(arg)) / dd;
}

/**
 * Vanna-volga implied vol by the Castagna–Mercurio (2007) closed form — the fast, always-defined market
 * quote, complementing the exact replication in {@link calibrateVannaVolga}. Same three pillars (via
 * `smileFromQuotes`), which both orders reprice exactly; far-extrapolation breakdowns (a negative curvature
 * `√`, or a vol collapsed below `MIN_VOL`) are collected and reported rather than returned as garbage. See
 * `docs/specs/vanna-volga-approx.md`.
 */
export function vannaVolgaApproximation(
  input: VannaVolgaApproximationInput,
): VannaVolgaApproximationSmile {
  const functionName = 'vannaVolgaApproximation';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, VANNA_VOLGA_APPROXIMATION_KEYS);
  ensurePositive(input.forward, 'forward', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.atmVolatility, 'atmVolatility', functionName);
  ensureFinite(input.riskReversal, 'riskReversal', functionName);
  ensureFinite(input.butterfly, 'butterfly', functionName);
  requireArgumentArray(functionName, 'strikes', (input as { strikes?: unknown }).strikes);
  if (input.strikes.length === 0) {
    throw new InputError(`${functionName}: strikes must be a non-empty array.`, {
      code: ErrorCode.InputOutOfRange,
      context: { strikes: 0 },
    });
  }
  input.strikes.forEach((K, i) => ensurePositive(K, `strikes[${i}]`, functionName));
  const delta = input.delta ?? 0.25;
  const order = input.order ?? 2;
  if (order !== 1 && order !== 2) {
    throw new InputError(`${functionName}: order must be 1 or 2; got ${String(order)}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { order },
    });
  }

  const F = input.forward;
  const T = input.timeToExpiryYears;
  const p = smileFromQuotes({
    forward: F,
    timeToExpiryYears: T,
    atmVolatility: input.atmVolatility,
    riskReversal: input.riskReversal,
    butterfly: input.butterfly,
    delta,
  });
  const [K1, K2, K3] = [p.putStrike, p.atmStrike, p.callStrike];
  const [s1, s2, s3] = [p.putVolatility, p.atmVolatility, p.callVolatility];

  const volatilities = new Array<number>(input.strikes.length);
  const unrepresentable: number[] = [];
  input.strikes.forEach((K, idx) => {
    const v = castagnaMercurio({
      order,
      forward: F,
      timeToExpiryYears: T,
      strike: K,
      putStrike: K1,
      atmStrike: K2,
      callStrike: K3,
      putVolatility: s1,
      atmVolatility: s2,
      callVolatility: s3,
    });
    if (!Number.isFinite(v) || !(v >= MIN_VOL)) {
      unrepresentable.push(K);
      return;
    }
    volatilities[idx] = v;
  });
  if (unrepresentable.length > 0) {
    throw new InputError(
      `${functionName}: the Castagna–Mercurio approximation broke down at ${
        unrepresentable.length
      } strike(s) (${unrepresentable
        .map((k) => k.toFixed(2))
        .join(
          ', ',
        )}) — too far from the pillars to represent; query strikes nearer the ATM/wing range.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { strikes: unrepresentable, pillarStrikes: [K1, K2, K3] },
      },
    );
  }

  return {
    strikes: [...input.strikes],
    volatilities,
    pillars: {
      putStrike: p.putStrike,
      putVolatility: p.putVolatility,
      atmStrike: p.atmStrike,
      atmVolatility: p.atmVolatility,
      callStrike: p.callStrike,
      callVolatility: p.callVolatility,
    },
    delta,
    order,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: 'castagna-mercurio',
      deltaConvention: 'forward',
      delta,
      order,
    },
    diagnostics: {
      engine: 'vanna-volga',
      method: `castagna-mercurio order-${order}`,
      converged: true,
      warnings: [],
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Vanna–volga-implied risk-neutral density (Breeden–Litzenberger on the CM smile)
// ────────────────────────────────────────────────────────────────────────────

/** Input for {@link vannaVolgaDensity} — the vanna-volga quotes plus the density grid controls. */
export interface VannaVolgaDensityInput extends Omit<VannaVolgaInput, 'strikes'> {
  /** Castagna–Mercurio order for the underlying smile: `1` or `2` (default). */
  order?: 1 | 2;
  /** Grid points for the sampled density / moments; an odd integer ≥ 11 (default 801). */
  gridPoints?: number;
  /** Grid half-width in ATM standard deviations, `F·e^{±widthStandardDeviations·σ√T}` (default 6, capturing ≈ all mass). */
  widthStandardDeviations?: number;
  /** Central-difference step in strike for Breeden–Litzenberger (default `F·1e-3`). */
  step?: number;
}

/** The vanna-volga-implied risk-neutral terminal distribution and its moments. */
export interface VannaVolgaDensity {
  /** Risk-neutral (T-forward-measure) PDF at strike `K`, `∂²C/∂K²` (clamped ≥ 0). */
  density(strike: number): number;
  /** Risk-neutral CDF `P(S_T ≤ K) = 1 + ∂C/∂K` (clamped to [0, 1]). */
  cdf(strike: number): number;
  probabilityBelow(strike: number): number;
  probabilityAbove(strike: number): number;
  probabilityBetween(lowerStrike: number, upperStrike: number): number;
  /** Strike at CDF = `p` (inverse CDF via bisection); `p ∈ (0, 1)`. */
  quantile(probability: number): number;
  /** The sampled grid the moments and quantiles are integrated on. */
  grid: { strikes: number[]; density: number[]; cdf: number[] };
  moments: {
    /** `∫f dK` — total captured probability mass, ≈ 1. */
    totalMass: number;
    /** `∫K·f dK` — the risk-neutral mean, ≈ forward by the martingale property. */
    mean: number;
    variance: number;
    stdev: number;
    skewness: number;
    excessKurtosis: number;
  };
  pillars: {
    putStrike: number;
    putVolatility: number;
    atmStrike: number;
    atmVolatility: number;
    callStrike: number;
    callVolatility: number;
  };
  order: 1 | 2;
  assumptions: {
    conventionsVersion: string;
    method: 'breeden-litzenberger';
    smile: 'castagna-mercurio';
    measure: 'risk-neutral-forward';
    order: 1 | 2;
  };
  diagnostics: Diagnostics;
}

/** Validate the shared density grid controls; returns the resolved `(gridPoints, widthStandardDeviations, step)`. */
function densityGridControls(input: {
  functionName: string;
  forward: number;
  gridPoints: number | undefined;
  widthStandardDeviations: number | undefined;
  step: number | undefined;
}): { gridPoints: number; widthStandardDeviations: number; step: number } {
  const { functionName, forward: F, gridPoints, widthStandardDeviations, step } = input;
  ensureFiniteWhenPresent(gridPoints, 'gridPoints', functionName);
  ensureFiniteWhenPresent(widthStandardDeviations, 'widthStandardDeviations', functionName);
  ensureFiniteWhenPresent(step, 'step', functionName);
  const gp = gridPoints ?? 801;
  // Safe integer AND a work cap (2026-08-23 review, P0): gridPoints sizes the strike grid AND
  // every derived array (density, cdf), and each point costs several smile + Black-Scholes
  // evaluations for the Breeden-Litzenberger second difference — `Number.isInteger(1e308)` is
  // `true`, so the old gate licensed an absurd allocation. 100,001 points is 125× the 801-point
  // default (~a few hundred ms of grid evaluation) — a parametric Castagna-Mercurio density gains
  // nothing beyond that resolution.
  if (!Number.isSafeInteger(gp) || gp < 11 || gp > MAX_DENSITY_GRID_POINTS || gp % 2 === 0) {
    throw new InputError(
      `${functionName}: gridPoints must be an odd integer in [11, ${MAX_DENSITY_GRID_POINTS.toLocaleString('en-US')}] — each point is several smile/Black-Scholes evaluations materialized into the density and cdf arrays, so the cap keeps the largest grid well under a second (the default is 801); got ${String(gp)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { gridPoints: gp, max: MAX_DENSITY_GRID_POINTS },
      },
    );
  }
  const w = widthStandardDeviations ?? 6;
  ensurePositive(w, 'widthStandardDeviations', functionName);
  if (step !== undefined) ensurePositive(step, 'step', functionName);
  return { gridPoints: gp, widthStandardDeviations: w, step: step ?? F * 1e-3 };
}

/** The log-uniform strike grid `F·e^{±widthStandardDeviations·σ√T}` (an odd count puts the ATM forward on the centre node). */
function densityGrid(input: {
  forward: number;
  atmVolatility: number;
  timeToExpiryYears: number;
  gridPoints: number;
  widthStandardDeviations: number;
}): number[] {
  const {
    forward: F,
    atmVolatility,
    timeToExpiryYears: T,
    gridPoints,
    widthStandardDeviations,
  } = input;
  const halfLog = widthStandardDeviations * atmVolatility * Math.sqrt(T);
  const lnLo = Math.log(F) - halfLog;
  const lnHi = Math.log(F) + halfLog;
  const strikes = new Array<number>(gridPoints);
  for (let i = 0; i < gridPoints; i++) {
    strikes[i] = Math.exp(lnLo + ((lnHi - lnLo) * i) / (gridPoints - 1));
  }
  return strikes;
}

/** The Breeden–Litzenberger density core shared by the vanna-volga densities. */
interface ForwardDensityCore {
  density: (K: number) => number;
  cdf: (K: number) => number;
  probabilityBelow: (K: number) => number;
  probabilityAbove: (K: number) => number;
  probabilityBetween: (a: number, b: number) => number;
  quantile: (p: number) => number;
  grid: { strikes: number[]; density: number[]; cdf: number[] };
  moments: {
    totalMass: number;
    mean: number;
    variance: number;
    stdev: number;
    skewness: number;
    excessKurtosis: number;
  };
  warnings: QuantWarning[];
}

/**
 * Breeden–Litzenberger risk-neutral density in forward space from a `smile` that is finite and positive
 * across `strikes ± step`: the undiscounted forward Black call's strike derivatives are the density and CDF.
 * Samples the grid, integrates the moments (trapezoid), inverts the CDF (bisection), and raises
 * mass/mean/non-monotone-CDF warnings. Shared by {@link vannaVolgaDensity} and {@link vannaVolga5Density}.
 */
function forwardMeasureDensity(input: {
  functionName: string;
  smile: (strike: number) => number;
  forward: number;
  timeToExpiryYears: number;
  strikes: number[];
  step: number;
}): ForwardDensityCore {
  const { functionName, smile, forward: F, timeToExpiryYears: T, strikes, step } = input;
  const gridPoints = strikes.length;
  // Breeden–Litzenberger in forward space (spot = F, rate = 0, q = 0). Reuses the verified analytics.ts core.
  const bl = riskNeutralDistribution(smile, {
    spot: F,
    timeToExpiryYears: T,
    riskFreeRate: 0,
    step,
  });
  const densityArr = strikes.map((K) => bl.density(K));
  const cdfArr = strikes.map((K) => bl.cdf(K));

  // Non-uniform trapezoidal integration of g(K)·f(K) over the (geometric) grid.
  const integrate = (g: (K: number) => number): number => {
    let sum = 0;
    for (let i = 0; i < gridPoints - 1; i++) {
      const dK = strikes[i + 1]! - strikes[i]!;
      sum += (dK * (g(strikes[i]!) * densityArr[i]! + g(strikes[i + 1]!) * densityArr[i + 1]!)) / 2;
    }
    return sum;
  };
  const totalMass = integrate(() => 1);
  const mean = integrate((K) => K) / totalMass;
  const variance = integrate((K) => (K - mean) ** 2) / totalMass;
  const stdev = Math.sqrt(Math.max(0, variance));
  // stdev/variance are strictly positive for any real smile with T > 0, so divide directly.
  const skewness = integrate((K) => (K - mean) ** 3) / totalMass / stdev ** 3;
  const excessKurtosis = integrate((K) => (K - mean) ** 4) / totalMass / variance ** 2 - 3;

  // Inverse CDF by bisection over the grid span (the CDF is monotone for an arbitrage-free smile).
  const quantile = (pr: number): number => {
    if (!(pr > 0 && pr < 1)) {
      throw new InputError(`${functionName}: quantile p must be in (0, 1); got ${String(pr)}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { p: pr },
      });
    }
    let lo = strikes[0]!;
    let hi = strikes[gridPoints - 1]!;
    for (let it = 0; it < 80; it++) {
      const mid = 0.5 * (lo + hi);
      if (bl.cdf(mid) < pr) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  };

  // Diagnostics: grid-truncation (mass/mean drift) and residual butterfly arbitrage (non-monotone CDF).
  const warnings: QuantWarning[] = [];
  if (Math.abs(totalMass - 1) > 1e-2) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `risk-neutral mass ∫f dK = ${totalMass.toFixed(
          4,
        )} deviates from 1 by > 1% — widen the grid (widthStandardDeviations) or the smile is arbitrageable.`,
        'warn',
        { totalMass },
      ),
    );
  }
  if (Math.abs(mean - F) / F > 1e-2) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `risk-neutral mean ${mean.toFixed(
          2,
        )} deviates from the forward ${F} (the martingale property) by > 1% — the grid is too coarse/narrow or the smile is arbitrageable.`,
        'warn',
        { mean, forward: F },
      ),
    );
  }
  let nonMonotone = false;
  for (let i = 1; i < gridPoints; i++) {
    if (cdfArr[i]! < cdfArr[i - 1]! - 1e-9) {
      nonMonotone = true;
      break;
    }
  }
  if (nonMonotone) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `the implied CDF is non-monotone — the smile carries a butterfly arbitrage (a negative-density region); probabilities across it are clamped.`,
        'warn',
        {},
      ),
    );
  }

  return {
    density: bl.density,
    cdf: bl.cdf,
    probabilityBelow: bl.probabilityBelow,
    probabilityAbove: bl.probabilityAbove,
    probabilityBetween: bl.probabilityBetween,
    quantile,
    grid: { strikes, density: densityArr, cdf: cdfArr },
    moments: { totalMass, mean, variance, stdev, skewness, excessKurtosis },
    warnings,
  };
}

/**
 * The risk-neutral terminal distribution implied by the three vanna-volga quotes (ATM + δ-delta RR/BF).
 * Builds the **Castagna–Mercurio** smile (the always-defined closed form — the exact {@link calibrateVannaVolga}
 * breaks down across the wide strike grid a density needs) and applies **Breeden–Litzenberger** in forward
 * space: the undiscounted forward Black call's strike derivatives are the risk-neutral density and CDF
 * directly. Returns density/CDF/probability closures plus a sampled grid, the distribution's moments
 * (mass ≈ 1, mean ≈ forward, variance, skewness, excess kurtosis), and an inverse CDF. A non-convex
 * (butterfly ≤ 0) smile — where the CM curvature itself is undefined — is a typed error; a residual
 * butterfly arbitrage (non-monotone CDF) or a grid-truncation mass/mean drift is a disclosed warning.
 * See `docs/specs/vanna-volga-density.md`.
 */
export function vannaVolgaDensity(input: VannaVolgaDensityInput): VannaVolgaDensity {
  const functionName = 'vannaVolgaDensity';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, VANNA_VOLGA_DENSITY_KEYS);
  ensurePositive(input.forward, 'forward', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.atmVolatility, 'atmVolatility', functionName);
  ensureFinite(input.riskReversal, 'riskReversal', functionName);
  ensureFinite(input.butterfly, 'butterfly', functionName);
  ensureFiniteWhenPresent(input.delta, 'delta', functionName);
  ensureFiniteWhenPresent(input.order, 'order', functionName);
  const delta = input.delta ?? 0.25;
  const order = input.order ?? 2;
  if (order !== 1 && order !== 2) {
    throw new InputError(`${functionName}: order must be 1 or 2; got ${String(order)}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { order },
    });
  }
  const F = input.forward;
  const T = input.timeToExpiryYears;
  const { gridPoints, widthStandardDeviations, step } = densityGridControls({
    functionName,
    forward: F,
    gridPoints: input.gridPoints,
    widthStandardDeviations: input.widthStandardDeviations,
    step: input.step,
  });

  // Build the three pillars once; the per-strike vol comes from the private CM closed form.
  const p = smileFromQuotes({
    forward: F,
    timeToExpiryYears: T,
    atmVolatility: input.atmVolatility,
    riskReversal: input.riskReversal,
    butterfly: input.butterfly,
    delta,
  });
  const [K1, K2, K3] = [p.putStrike, p.atmStrike, p.callStrike];
  const [s1, s2, s3] = [p.putVolatility, p.atmVolatility, p.callVolatility];
  const smile = (K: number): number =>
    castagnaMercurio({
      order,
      forward: F,
      timeToExpiryYears: T,
      strike: K,
      putStrike: K1,
      atmStrike: K2,
      callStrike: K3,
      putVolatility: s1,
      atmVolatility: s2,
      callVolatility: s3,
    });

  const strikes = densityGrid({
    forward: F,
    atmVolatility: input.atmVolatility,
    timeToExpiryYears: T,
    gridPoints,
    widthStandardDeviations,
  });

  // Pre-scan the grid + the ±step stencil: a non-finite CM vol means the closed form's curvature √ turns
  // negative there and the smile can't be represented — a clear typed error beats a NaN leaking downstream.
  // A negative K−step (huge step) yields ln(F/negative) = NaN, so the finite check subsumes a K−step > 0 test.
  const breakdown: number[] = [];
  for (const K of strikes) {
    if (![K - step, K, K + step].every((k) => Number.isFinite(smile(k)))) {
      breakdown.push(K);
    }
  }
  if (breakdown.length > 0) {
    throw new InputError(
      `${functionName}: the Castagna–Mercurio smile is undefined at ${
        breakdown.length
      } grid strike(s) (e.g. ${breakdown
        .slice(0, 3)
        .map((k) => k.toFixed(2))
        .join(
          ', ',
        )}) — its curvature can't be represented across the ±${widthStandardDeviations}σ grid (the risk reversal is too steep for the butterfly, or the butterfly is ≤ 0). Narrow the grid via widthStandardDeviations, or check the quotes.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { strikes: breakdown, pillarStrikes: [K1, K2, K3] },
      },
    );
  }

  const core = forwardMeasureDensity({
    functionName,
    smile,
    forward: F,
    timeToExpiryYears: T,
    strikes,
    step,
  });

  return {
    density: core.density,
    cdf: core.cdf,
    probabilityBelow: core.probabilityBelow,
    probabilityAbove: core.probabilityAbove,
    probabilityBetween: core.probabilityBetween,
    quantile: core.quantile,
    grid: core.grid,
    moments: core.moments,
    pillars: {
      putStrike: p.putStrike,
      putVolatility: p.putVolatility,
      atmStrike: p.atmStrike,
      atmVolatility: p.atmVolatility,
      callStrike: p.callStrike,
      callVolatility: p.callVolatility,
    },
    order,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: 'breeden-litzenberger',
      smile: 'castagna-mercurio',
      measure: 'risk-neutral-forward',
      order,
    },
    diagnostics: {
      engine: 'vanna-volga',
      method: `breeden-litzenberger on castagna-mercurio order-${order}`,
      converged: core.warnings.length === 0,
      warnings: core.warnings,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5-pillar (10Δ) vanna-volga smile — exact-repricing PCHIP through 5 anchors
// ────────────────────────────────────────────────────────────────────────────

/** Input for {@link calibrateVannaVolga5}. */
export interface VannaVolga5Input {
  forward: number;
  timeToExpiryYears: number;
  atmVolatility: number;
  /** 25-delta risk reversal (`callVolatility − putVolatility`) and butterfly. */
  riskReversal25: number;
  butterfly25: number;
  /** 10-delta risk reversal and butterfly. */
  riskReversal10: number;
  butterfly10: number;
  /** Inner / outer wing deltas. Defaults 0.25 / 0.10. */
  innerDelta?: number;
  outerDelta?: number;
  /** Wing extrapolation beyond the 10Δ pillars, in total variance: `flat` (default) or `linear`. */
  wingExtrapolation?: 'flat' | 'linear';
  /** Strikes to evaluate the smile at. */
  strikes: number[];
}

/** One of the five market pillars a {@link VannaVolga5Smile} reprices exactly. */
export interface VannaVolga5Pillar {
  strike: number;
  volatility: number;
  delta: number;
  kind: 'put' | 'atm' | 'call';
}

/** The 5-pillar smile and the pillars it reprices. */
export interface VannaVolga5Smile {
  strikes: number[];
  volatilities: number[];
  /** The five market pillars the smile reprices exactly, low → high strike. */
  pillars: VannaVolga5Pillar[];
  innerDelta: number;
  outerDelta: number;
  assumptions: {
    conventionsVersion: string;
    method: 'vanna-volga-5';
    deltaConvention: 'forward';
    interpolation: 'pchip-total-variance';
    wingExtrapolation: 'flat' | 'linear';
  };
  diagnostics: Diagnostics;
}

/** The 5-pillar smile core shared by {@link calibrateVannaVolga5} and {@link vannaVolga5Density}. */
interface Vanna5SmileCore {
  pillars: VannaVolga5Pillar[];
  /** Total variance `w(k) = σ²T` at strike `K` (may be ≤ 0 far out on a down-sloping linear wing). */
  varAt: (K: number) => number;
  innerDelta: number;
  outerDelta: number;
  wingExtrapolation: 'flat' | 'linear';
}

/**
 * The 5-pillar anchors + PCHIP-of-total-variance smile from the five-quote set. Validates the shared quote
 * fields and delta ordering, builds the five `(strike, vol)` pillars via {@link smileFromQuotes} at each
 * delta, asserts strictly-increasing pillar strikes, and returns the total-variance interpolant. Shared by
 * {@link calibrateVannaVolga5} (strike evaluation + arbitrage scan) and {@link vannaVolga5Density} (density).
 */
function buildVanna5Smile(
  functionName: string,
  input: {
    forward: number;
    timeToExpiryYears: number;
    atmVolatility: number;
    riskReversal25: number;
    butterfly25: number;
    riskReversal10: number;
    butterfly10: number;
    innerDelta?: number;
    outerDelta?: number;
    wingExtrapolation?: 'flat' | 'linear';
  },
): Vanna5SmileCore {
  // The two public fronts validate their closed requests at the head (spec 3B.1b); what remains
  // here is the shared DOMAIN residue: positivity, and the wing-delta ordering.
  ensurePositive(input.forward, 'forward', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.atmVolatility, 'atmVolatility', functionName);
  const innerDelta = input.innerDelta ?? 0.25;
  const outerDelta = input.outerDelta ?? 0.1;
  // Outer (10Δ) must be a further-OTM wing than inner (25Δ): 0 < outer < inner < 0.5.
  if (!(outerDelta > 0 && outerDelta < innerDelta && innerDelta < 0.5)) {
    throw new InputError(
      `${functionName}: require 0 < outerDelta < innerDelta < 0.5 (got outer ${outerDelta}, inner ${innerDelta}).`,
      { code: ErrorCode.InputOutOfRange, context: { innerDelta, outerDelta } },
    );
  }
  const wingExtrapolation = input.wingExtrapolation ?? 'flat';

  const F = input.forward;
  const T = input.timeToExpiryYears;
  // Five anchors: two `smileFromQuotes` (inner 25Δ, outer 10Δ), sharing the ATM.
  const inner = smileFromQuotes({
    forward: F,
    timeToExpiryYears: T,
    atmVolatility: input.atmVolatility,
    riskReversal: input.riskReversal25,
    butterfly: input.butterfly25,
    delta: innerDelta,
  });
  const outer = smileFromQuotes({
    forward: F,
    timeToExpiryYears: T,
    atmVolatility: input.atmVolatility,
    riskReversal: input.riskReversal10,
    butterfly: input.butterfly10,
    delta: outerDelta,
  });
  const pillars: VannaVolga5Pillar[] = [
    { strike: outer.putStrike, volatility: outer.putVolatility, delta: outerDelta, kind: 'put' },
    { strike: inner.putStrike, volatility: inner.putVolatility, delta: innerDelta, kind: 'put' },
    { strike: F, volatility: input.atmVolatility, delta: 0.5, kind: 'atm' },
    { strike: inner.callStrike, volatility: inner.callVolatility, delta: innerDelta, kind: 'call' },
    { strike: outer.callStrike, volatility: outer.callVolatility, delta: outerDelta, kind: 'call' },
  ];
  // The anchors must be strictly increasing in strike for the interpolation to be well-posed.
  for (let i = 1; i < pillars.length; i++) {
    if (!(pillars[i]!.strike > pillars[i - 1]!.strike)) {
      throw new InputError(
        `${functionName}: the quotes imply non-monotone pillar strikes (${pillars
          .map((p) => p.strike.toFixed(2))
          .join(', ')}) — the 10Δ/25Δ wings cross; check the quotes.`,
        { code: ErrorCode.InputOutOfRange, context: { strikes: pillars.map((p) => p.strike) } },
      );
    }
  }

  // PCHIP of total variance w(k) = σ²T against log-moneyness k = ln(K/F): exact at the pillars, C¹, no
  // overshoot. Total-variance space gives the arbitrage-aware linear wing extrapolation.
  const ks = pillars.map((p) => Math.log(p.strike / F));
  const ws = pillars.map((p) => p.volatility * p.volatility * T);
  const wOf = makePchipInterpolator(ks, ws, { extrapolate: wingExtrapolation });
  const varAt = (K: number): number => wOf(Math.log(K / F));
  return { pillars, varAt, innerDelta, outerDelta, wingExtrapolation };
}

/**
 * Build the FX/crypto smile from the full five-quote set — ATM + the 25Δ and 10Δ risk reversal / butterfly —
 * so it **exactly reprices all five market pillars** (10Δ put, 25Δ put, ATM, 25Δ call, 10Δ call) and pins the
 * wings to real quotes instead of extrapolating them like the 3-pillar {@link calibrateVannaVolga} /
 * {@link vannaVolgaApproximation}. The anchors come from {@link smileFromQuotes} at each delta; the smile is a
 * shape-preserving PCHIP interpolation of total variance `σ²T` in log-moneyness (exact at the pillars, C¹
 * smooth, no overshoot). Exact repricing of arbitrary quotes can't guarantee no arbitrage, so the implied
 * Breeden–Litzenberger density is checked across the pillar span and a butterfly arbitrage is a disclosed
 * warning. See `docs/specs/vanna-volga-5.md`.
 */
export function calibrateVannaVolga5(input: VannaVolga5Input): VannaVolga5Smile {
  const functionName = 'calibrateVannaVolga5';
  validateClosedRequest(functionName, input, CALIBRATE_VANNA_VOLGA_5_SPEC, {
    exampleCall: CALIBRATE_VANNA_VOLGA_5_EXAMPLE,
  });
  if (input.strikes.length === 0) {
    throw new InputError(`${functionName}: strikes must be a non-empty array.`, {
      code: ErrorCode.InputOutOfRange,
      context: { strikes: 0 },
    });
  }
  input.strikes.forEach((K, i) => ensurePositive(K, `strikes[${i}]`, functionName));
  const { pillars, varAt, innerDelta, outerDelta, wingExtrapolation } = buildVanna5Smile(
    functionName,
    input,
  );

  const F = input.forward;
  const T = input.timeToExpiryYears;
  const volatilities = new Array<number>(input.strikes.length);
  const nonPositiveVar: number[] = [];
  input.strikes.forEach((K, i) => {
    const w = varAt(K);
    if (!(w > 0)) {
      nonPositiveVar.push(K);
      return;
    }
    volatilities[i] = Math.sqrt(w / T);
  });
  if (nonPositiveVar.length > 0) {
    throw new InputError(
      `${functionName}: the linear wing extrapolation drove total variance ≤ 0 at ${
        nonPositiveVar.length
      } strike(s) (${nonPositiveVar
        .map((k) => k.toFixed(2))
        .join(', ')}) — query strikes nearer the pillars or use wingExtrapolation: 'flat'.`,
      { code: ErrorCode.InputOutOfRange, context: { strikes: nonPositiveVar } },
    );
  }

  // Butterfly-arbitrage diagnostic: the implied Breeden–Litzenberger density must stay ≥ 0 where the quotes
  // determine the smile. Exact repricing of arbitrary quotes can't guarantee it — an over-convex butterfly
  // makes the call-price curve locally concave (negative density). Surface it rather than return a silently-
  // arbitrageable smile. The scan is the *interior* (loK+2h, hiK-2h): a stencil straddling an outer knot,
  // where the flat/linear wing extrapolation meets the curve, picks up that slope kink as a spurious density
  // spike, not a genuine arbitrage — and the constant-vol wings are individually arbitrage-free anyway.
  const warnings: QuantWarning[] = [];
  const volatilityOf = (K: number): number => Math.sqrt(Math.max(varAt(K), 1e-12) / T);
  const h = F * 1e-3;
  const callAt = (K: number): number =>
    blackScholesPrice({
      type: 'call',
      spot: F,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: 0,
      dividendYield: 0,
      volatility: volatilityOf(K),
    });
  const scanLo = pillars[0]!.strike + 2 * h;
  const scanHi = pillars[pillars.length - 1]!.strike - 2 * h;
  const steps = 200;
  let minDensity = Infinity;
  for (let i = 0; i <= steps; i++) {
    const K = scanLo + ((scanHi - scanLo) * i) / steps;
    const d = (callAt(K + h) - 2 * callAt(K) + callAt(K - h)) / (h * h);
    if (d < minDensity) minDensity = d;
  }
  if (minDensity < -1e-6) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `the quoted pillars imply a butterfly arbitrage — the implied risk-neutral density goes negative (min ${minDensity.toExponential(
          2,
        )}) between the pillars; the smile reprices the quotes but is not arbitrage-free. Use calibrateSsvi/ESSVI for a guaranteed arb-free surface.`,
        'warn',
        { minDensity },
      ),
    );
  }

  return {
    strikes: [...input.strikes],
    volatilities,
    pillars,
    innerDelta,
    outerDelta,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: 'vanna-volga-5',
      deltaConvention: 'forward',
      interpolation: 'pchip-total-variance',
      wingExtrapolation,
    },
    diagnostics: {
      engine: 'vanna-volga',
      method: 'pchip total-variance through 5 pillars',
      converged: warnings.length === 0,
      warnings,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5-pillar-implied risk-neutral density (Breeden–Litzenberger on the 5-pillar smile)
// ────────────────────────────────────────────────────────────────────────────

/** Input for {@link vannaVolga5Density} — the five vanna-volga quotes plus the density grid controls. */
export interface VannaVolga5DensityInput extends Omit<
  VannaVolga5Input,
  'strikes' | 'wingExtrapolation'
> {
  /** Grid points for the sampled density / moments; an odd integer ≥ 11 (default 801). */
  gridPoints?: number;
  /** Grid half-width in ATM standard deviations, `F·e^{±widthStandardDeviations·σ√T}` (default 6). */
  widthStandardDeviations?: number;
  /** Central-difference step in strike for Breeden–Litzenberger (default `F·1e-3`). */
  step?: number;
}

/** The 5-pillar-implied risk-neutral terminal distribution and its moments. */
export interface VannaVolga5Density {
  /** Risk-neutral (T-forward-measure) PDF at strike `K`, `∂²C/∂K²` (clamped ≥ 0). */
  density(strike: number): number;
  /** Risk-neutral CDF `P(S_T ≤ K) = 1 + ∂C/∂K` (clamped to [0, 1]). */
  cdf(strike: number): number;
  probabilityBelow(strike: number): number;
  probabilityAbove(strike: number): number;
  probabilityBetween(lowerStrike: number, upperStrike: number): number;
  /** Strike at CDF = `p` (inverse CDF via bisection); `p ∈ (0, 1)`. */
  quantile(probability: number): number;
  /** The sampled grid the moments and quantiles are integrated on. */
  grid: { strikes: number[]; density: number[]; cdf: number[] };
  moments: {
    /** `∫f dK` — total captured probability mass, ≈ 1. */
    totalMass: number;
    /** `∫K·f dK` — the risk-neutral mean, ≈ forward by the martingale property. */
    mean: number;
    variance: number;
    stdev: number;
    skewness: number;
    excessKurtosis: number;
  };
  /** The five market pillars the underlying smile reprices exactly, low → high strike. */
  pillars: VannaVolga5Pillar[];
  innerDelta: number;
  outerDelta: number;
  assumptions: {
    conventionsVersion: string;
    method: 'breeden-litzenberger';
    smile: 'vanna-volga-5';
    measure: 'risk-neutral-forward';
  };
  diagnostics: Diagnostics;
}

/**
 * The risk-neutral terminal distribution implied by the **five**-pillar vanna-volga smile (ATM + 25Δ + 10Δ
 * RR/BF) — the {@link vannaVolgaDensity} read-out (PDF / CDF / quantiles / probability-in-range / moments),
 * but with the core `[10Δ put, 10Δ call]` range (where most probability mass sits) pinned to real quotes
 * instead of extrapolated from three. Builds the {@link calibrateVannaVolga5} PCHIP smile and applies
 * **Breeden–Litzenberger** in forward space via the shared density core. The wing is extrapolated **linearly**
 * in total variance (C¹ at the 10Δ knots, so the density stays smooth — a `flat` wing would put a spurious
 * kink-spike in the density at the interior 10Δ knots); a down-sloping wing that drives total variance ≤ 0 on
 * the grid is a typed error. See `docs/specs/vanna-volga-5-density.md`.
 */
export function vannaVolga5Density(input: VannaVolga5DensityInput): VannaVolga5Density {
  const functionName = 'vannaVolga5Density';
  validateClosedRequest(functionName, input, VANNA_VOLGA_5_DENSITY_SPEC, {
    exampleCall: VANNA_VOLGA_5_DENSITY_EXAMPLE,
  });
  const F = input.forward;
  ensurePositive(F, 'forward', functionName);
  const T = input.timeToExpiryYears;
  const { gridPoints, widthStandardDeviations, step } = densityGridControls({
    functionName,
    forward: F,
    gridPoints: input.gridPoints,
    widthStandardDeviations: input.widthStandardDeviations,
    step: input.step,
  });

  // Build the 5-pillar smile once, with a linear (C¹) wing so the density stays smooth at the 10Δ knots.
  const { pillars, varAt, innerDelta, outerDelta } = buildVanna5Smile(functionName, {
    ...input,
    wingExtrapolation: 'linear',
  });
  const smile = (K: number): number => Math.sqrt(Math.max(varAt(K), 0) / T);

  const strikes = densityGrid({
    forward: F,
    atmVolatility: input.atmVolatility,
    timeToExpiryYears: T,
    gridPoints,
    widthStandardDeviations,
  });

  // Pre-scan the grid + stencil: a linear wing on a down-sloping smile can drive total variance ≤ 0 far out.
  const nonPositiveVar: number[] = [];
  for (const K of strikes) {
    if (![K - step, K, K + step].every((k) => varAt(k) > 0)) {
      nonPositiveVar.push(K);
    }
  }
  if (nonPositiveVar.length > 0) {
    throw new InputError(
      `${functionName}: the linear wing extrapolation drove total variance ≤ 0 at ${
        nonPositiveVar.length
      } grid strike(s) (e.g. ${nonPositiveVar
        .slice(0, 3)
        .map((k) => k.toFixed(2))
        .join(
          ', ',
        )}) — a wing too steep for the ±${widthStandardDeviations}σ grid. Narrow the grid via widthStandardDeviations, or check the quotes.`,
      { code: ErrorCode.InputOutOfRange, context: { strikes: nonPositiveVar } },
    );
  }

  const core = forwardMeasureDensity({
    functionName,
    smile,
    forward: F,
    timeToExpiryYears: T,
    strikes,
    step,
  });

  return {
    density: core.density,
    cdf: core.cdf,
    probabilityBelow: core.probabilityBelow,
    probabilityAbove: core.probabilityAbove,
    probabilityBetween: core.probabilityBetween,
    quantile: core.quantile,
    grid: core.grid,
    moments: core.moments,
    pillars,
    innerDelta,
    outerDelta,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: 'breeden-litzenberger',
      smile: 'vanna-volga-5',
      measure: 'risk-neutral-forward',
    },
    diagnostics: {
      engine: 'vanna-volga',
      method: 'breeden-litzenberger on vanna-volga-5',
      converged: core.warnings.length === 0,
      warnings: core.warnings,
    },
  };
}
