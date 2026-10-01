/**
 * The ONE selective Black–Scholes–Merton evaluation kernel (selective Greeks and exposure spec,
 * decisions 1–3).
 *
 * A request names the outputs it needs; {@link resolveBlackScholesPlan} turns that into dependency
 * flags ONCE per invocation, and {@link evaluateBlackScholesUnchecked} computes only the flagged
 * intermediates for a row. Gamma alone needs `d1`, the dividend discount and the normal DENSITY —
 * no cumulative normal, no rate discount, no `d2` — so a gamma sweep stops paying for price, delta,
 * theta and rho.
 *
 * Every output uses the same expression, in the same operation order, as `blackScholesPrice`,
 * `blackScholesGreeks` and `blackScholesExtendedGreeks`, so a selected value is bit-identical to the
 * same value from those functions. The units are theirs: theta per calendar day, vega and rho per
 * 1%, vanna per 1.00 σ, charm and color per added year of time-to-expiry (∂/∂T), vomma per 1.00 σ²
 * (with vega per 1.00 σ), speed ∂Γ/∂S.
 *
 * @internal PACKAGE-private. The row kernel assumes validated inputs (S, K, T, σ > 0; r, q finite);
 * every caller validates at its public boundary first, exactly as for `blackScholesPriceUnchecked`.
 */

import { normalCdf, normalPdf } from '@totalfinance/math';

const DAYS_PER_YEAR = 365;

/** Every output the kernel can produce, in its canonical slot order. */
export const BLACK_SCHOLES_OUTPUTS = [
  'price',
  'delta',
  'gamma',
  'theta',
  'vega',
  'rho',
  'vanna',
  'charm',
  'vomma',
  'speed',
  'color',
] as const;

/**
 * A Black–Scholes output a selective call can request. First-order Greeks use the library's display
 * units (theta per calendar day, vega and rho per 1%); higher-order Greeks use the raw units
 * documented on `blackScholesExtendedGreeks`.
 */
export type BlackScholesOutput = (typeof BLACK_SCHOLES_OUTPUTS)[number];

/** A selection of outputs, as an array or (inferred from a literal) a tuple. */
export type BlackScholesOutputSelection = readonly BlackScholesOutput[];

const PRICE = 0;
const DELTA = 1;
const GAMMA = 2;
const THETA = 3;
const VEGA = 4;
const RHO = 5;
const VANNA = 6;
const CHARM = 7;
const VOMMA = 8;
const SPEED = 9;
const COLOR = 10;

/** Number of output slots a scratch row needs. */
export const BLACK_SCHOLES_OUTPUT_SLOTS = BLACK_SCHOLES_OUTPUTS.length;

/**
 * What one invocation computes, resolved ONCE from the requested outputs. `slots` lists the
 * requested outputs' slot indices in request order; the remaining flags are the intermediates
 * those outputs depend on.
 */
export interface BlackScholesPlan {
  readonly outputs: readonly BlackScholesOutput[];
  readonly slots: readonly number[];
  readonly requested: readonly boolean[];
  readonly dividendDiscount: boolean;
  readonly d2: boolean;
  readonly rateDiscount: boolean;
  readonly density: boolean;
  readonly cumulativeD1: boolean;
  readonly cumulativeD2: boolean;
  readonly gamma: boolean;
  readonly rawVega: boolean;
  readonly timeDerivative: boolean;
}

/** Slot index of an output name. */
export function blackScholesOutputSlot(output: BlackScholesOutput): number {
  return BLACK_SCHOLES_OUTPUTS.indexOf(output);
}

/**
 * Resolve the dependency plan for a (validated, duplicate-free) output list. Called once per
 * invocation — never inside a row loop.
 */
export function resolveBlackScholesPlan(outputs: readonly BlackScholesOutput[]): BlackScholesPlan {
  const requested: boolean[] = new Array<boolean>(BLACK_SCHOLES_OUTPUT_SLOTS).fill(false);
  const slots: number[] = [];
  for (const output of outputs) {
    const slot = blackScholesOutputSlot(output);
    requested[slot] = true;
    slots.push(slot);
  }
  const any = (...indices: number[]): boolean => indices.some((index) => requested[index]);
  return {
    outputs: [...outputs],
    slots,
    requested,
    // Rho is the one output that never touches the dividend discount e^{−qT}.
    dividendDiscount: any(PRICE, DELTA, GAMMA, THETA, VEGA, VANNA, CHARM, VOMMA, SPEED, COLOR),
    d2: any(PRICE, THETA, RHO, VANNA, VOMMA, CHARM, COLOR),
    rateDiscount: any(PRICE, THETA, RHO),
    density: any(GAMMA, VEGA, THETA, VANNA, VOMMA, SPEED, CHARM, COLOR),
    cumulativeD1: any(PRICE, DELTA, THETA, CHARM),
    cumulativeD2: any(PRICE, THETA, RHO),
    gamma: any(GAMMA, SPEED, COLOR),
    rawVega: any(VEGA, VOMMA),
    timeDerivative: any(CHARM, COLOR),
  };
}

/**
 * Evaluate one validated row into `scratch` (length ≥ {@link BLACK_SCHOLES_OUTPUT_SLOTS}). Only the
 * plan's requested slots are written; others keep whatever they held. No allocation.
 *
 * The cumulative normals keep the existing call/put argument signs — calls use `N(d1)`, `N(d2)`,
 * puts `N(−d1)`, `N(−d2)` — because `N(−x)` and `1 − N(x)` differ in floating point.
 */
export function evaluateBlackScholesUnchecked(
  plan: BlackScholesPlan,
  isCall: boolean,
  spot: number,
  strike: number,
  timeToExpiryYears: number,
  riskFreeRate: number,
  dividendYield: number,
  volatility: number,
  scratch: Float64Array,
): void {
  const S = spot;
  const K = strike;
  const T = timeToExpiryYears;
  const r = riskFreeRate;
  const q = dividendYield;
  const sigma = volatility;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = plan.d2 ? d1 - sigma * sqrtT : 0;
  const discountFactor = plan.rateDiscount ? Math.exp(-r * T) : 0;
  const dq = plan.dividendDiscount ? Math.exp(-q * T) : 0;
  const pdf = plan.density ? normalPdf(d1) : 0;
  const nd1 = plan.cumulativeD1 ? normalCdf(isCall ? d1 : -d1) : 0;
  const nd2 = plan.cumulativeD2 ? normalCdf(isCall ? d2 : -d2) : 0;
  const requested = plan.requested;

  if (requested[PRICE]) {
    scratch[PRICE] = isCall
      ? S * dq * nd1 - K * discountFactor * nd2
      : K * discountFactor * nd2 - S * dq * nd1;
  }
  if (requested[DELTA]) scratch[DELTA] = isCall ? dq * nd1 : -dq * nd1;
  const gamma = plan.gamma ? (dq * pdf) / (S * sigma * sqrtT) : 0;
  if (requested[GAMMA]) scratch[GAMMA] = gamma;
  if (requested[THETA]) {
    const thetaPerYear = isCall
      ? -(S * dq * pdf * sigma) / (2 * sqrtT) - r * K * discountFactor * nd2 + q * S * dq * nd1
      : -(S * dq * pdf * sigma) / (2 * sqrtT) + r * K * discountFactor * nd2 - q * S * dq * nd1;
    scratch[THETA] = thetaPerYear / DAYS_PER_YEAR;
  }
  const vegaRaw = plan.rawVega ? S * dq * pdf * sqrtT : 0; // per 1.00 change in σ
  if (requested[VEGA]) scratch[VEGA] = vegaRaw / 100;
  if (requested[RHO]) {
    const rhoPerWhole = isCall ? K * T * discountFactor * nd2 : -K * T * discountFactor * nd2;
    scratch[RHO] = rhoPerWhole / 100;
  }
  if (requested[VANNA]) scratch[VANNA] = (-dq * pdf * d2) / sigma;
  if (requested[VOMMA]) scratch[VOMMA] = (vegaRaw * d1 * d2) / sigma;
  if (requested[SPEED]) scratch[SPEED] = -(gamma / S) * (d1 / (sigma * sqrtT) + 1);
  if (plan.timeDerivative) {
    // ∂d1/∂T (shared by charm and color).
    const dd1dT = (2 * (r - q) * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT);
    if (requested[CHARM]) {
      scratch[CHARM] = isCall ? -q * dq * nd1 + dq * pdf * dd1dT : q * dq * nd1 + dq * pdf * dd1dT;
    }
    if (requested[COLOR]) scratch[COLOR] = gamma * (-q - d1 * dd1dT - 1 / (2 * T));
  }
}
