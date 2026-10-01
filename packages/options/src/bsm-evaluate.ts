/**
 * The ONE selective Black–Scholes–Merton evaluation kernel (selective Greeks and exposure spec,
 * decisions 1–3).
 *
 * A request names the outputs it needs; {@link resolveBlackScholesPlan} turns that into dependency
 * flags ONCE per invocation, and {@link evaluateBlackScholesRowsUnchecked} computes only the flagged
 * intermediates for each row. Gamma alone needs `d1`, the dividend discount and the normal DENSITY —
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
 * The columns the row loop reads. Callers validate them first (S, K, T, σ > 0 and finite; r, q and
 * type finite); `type > 0` is a call, anything else a put; an absent `dividendYield` is 0.
 */
export interface BlackScholesColumnsView {
  readonly spot: ArrayLike<number>;
  readonly strike: ArrayLike<number>;
  readonly timeToExpiryYears: ArrayLike<number>;
  readonly riskFreeRate: ArrayLike<number>;
  readonly volatility: ArrayLike<number>;
  readonly type: ArrayLike<number>;
  readonly dividendYield?: ArrayLike<number> | undefined;
}

/**
 * THE row loop: evaluate rows `[0, rows)` of validated `columns`, writing each requested output to
 * `targets[slot][i]` (`targets` is indexed by output slot; unrequested slots are ignored). Only the
 * plan's flagged intermediates are computed, nothing is allocated, and nothing past `rows` is
 * written. Row `i`'s inputs are all read before any of its outputs is written, so an output may
 * alias an input column exactly.
 *
 * The loop lives here, not in a per-row helper, because a per-row call with six numeric arguments
 * is too large for the engine to inline and would box every argument on every row. The scalar
 * methods run the same loop over a one-row view ({@link evaluateBlackScholesScalarUnchecked}).
 *
 * The cumulative normals keep the existing call/put argument signs — calls use `N(d1)`, `N(d2)`,
 * puts `N(−d1)`, `N(−d2)` — because `N(−x)` and `1 − N(x)` differ in floating point.
 */
export function evaluateBlackScholesRowsUnchecked(
  plan: BlackScholesPlan,
  columns: BlackScholesColumnsView,
  rows: number,
  targets: readonly (Float64Array | undefined)[],
): void {
  const { spot, strike, timeToExpiryYears, riskFreeRate, volatility, type, dividendYield } =
    columns;
  const { requested } = plan;
  const wantD2 = plan.d2;
  const wantRateDiscount = plan.rateDiscount;
  const wantDividendDiscount = plan.dividendDiscount;
  const wantDensity = plan.density;
  const wantNd1 = plan.cumulativeD1;
  const wantNd2 = plan.cumulativeD2;
  const wantGamma = plan.gamma;
  const wantRawVega = plan.rawVega;
  const wantTimeDerivative = plan.timeDerivative;
  const outPrice = requested[PRICE] ? targets[PRICE] : undefined;
  const outDelta = requested[DELTA] ? targets[DELTA] : undefined;
  const outGamma = requested[GAMMA] ? targets[GAMMA] : undefined;
  const outTheta = requested[THETA] ? targets[THETA] : undefined;
  const outVega = requested[VEGA] ? targets[VEGA] : undefined;
  const outRho = requested[RHO] ? targets[RHO] : undefined;
  const outVanna = requested[VANNA] ? targets[VANNA] : undefined;
  const outCharm = requested[CHARM] ? targets[CHARM] : undefined;
  const outVomma = requested[VOMMA] ? targets[VOMMA] : undefined;
  const outSpeed = requested[SPEED] ? targets[SPEED] : undefined;
  const outColor = requested[COLOR] ? targets[COLOR] : undefined;

  for (let i = 0; i < rows; i++) {
    const isCall = type[i]! > 0;
    const S = spot[i]!;
    const K = strike[i]!;
    const T = timeToExpiryYears[i]!;
    const r = riskFreeRate[i]!;
    const q = dividendYield === undefined ? 0 : dividendYield[i]!;
    const sigma = volatility[i]!;
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = wantD2 ? d1 - sigma * sqrtT : 0;
    const discountFactor = wantRateDiscount ? Math.exp(-r * T) : 0;
    const dq = wantDividendDiscount ? Math.exp(-q * T) : 0;
    const pdf = wantDensity ? normalPdf(d1) : 0;
    const nd1 = wantNd1 ? normalCdf(isCall ? d1 : -d1) : 0;
    const nd2 = wantNd2 ? normalCdf(isCall ? d2 : -d2) : 0;

    if (outPrice !== undefined) {
      outPrice[i] = isCall
        ? S * dq * nd1 - K * discountFactor * nd2
        : K * discountFactor * nd2 - S * dq * nd1;
    }
    if (outDelta !== undefined) outDelta[i] = isCall ? dq * nd1 : -dq * nd1;
    const gamma = wantGamma ? (dq * pdf) / (S * sigma * sqrtT) : 0;
    if (outGamma !== undefined) outGamma[i] = gamma;
    if (outTheta !== undefined) {
      const thetaPerYear = isCall
        ? -(S * dq * pdf * sigma) / (2 * sqrtT) - r * K * discountFactor * nd2 + q * S * dq * nd1
        : -(S * dq * pdf * sigma) / (2 * sqrtT) + r * K * discountFactor * nd2 - q * S * dq * nd1;
      outTheta[i] = thetaPerYear / DAYS_PER_YEAR;
    }
    const vegaRaw = wantRawVega ? S * dq * pdf * sqrtT : 0; // per 1.00 change in σ
    if (outVega !== undefined) outVega[i] = vegaRaw / 100;
    if (outRho !== undefined) {
      const rhoPerWhole = isCall ? K * T * discountFactor * nd2 : -K * T * discountFactor * nd2;
      outRho[i] = rhoPerWhole / 100;
    }
    if (outVanna !== undefined) outVanna[i] = (-dq * pdf * d2) / sigma;
    if (outVomma !== undefined) outVomma[i] = (vegaRaw * d1 * d2) / sigma;
    if (outSpeed !== undefined) outSpeed[i] = -(gamma / S) * (d1 / (sigma * sqrtT) + 1);
    if (wantTimeDerivative) {
      // ∂d1/∂T (shared by charm and color).
      const dd1dT = (2 * (r - q) * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT);
      if (outCharm !== undefined) {
        outCharm[i] = isCall ? -q * dq * nd1 + dq * pdf * dd1dT : q * dq * nd1 + dq * pdf * dd1dT;
      }
      if (outColor !== undefined) outColor[i] = gamma * (-q - d1 * dd1dT - 1 / (2 * T));
    }
  }
}

/** The reused one-row view and outputs the scalar methods evaluate through (created on first use). */
let scalarRow:
  | {
      columns: {
        spot: Float64Array;
        strike: Float64Array;
        timeToExpiryYears: Float64Array;
        riskFreeRate: Float64Array;
        volatility: Float64Array;
        type: Int8Array;
        dividendYield: Float64Array;
      };
      values: Float64Array;
      targets: Float64Array[];
    }
  | undefined;

/** One validated Black–Scholes row: the kernel input with the dividend yield resolved. */
export interface BlackScholesScalarRow {
  readonly type: 'call' | 'put';
  readonly spot: number;
  readonly strike: number;
  readonly timeToExpiryYears: number;
  readonly riskFreeRate: number;
  readonly dividendYield: number;
  readonly volatility: number;
}

/**
 * One validated row through {@link evaluateBlackScholesRowsUnchecked}: the inputs are written into a
 * reused one-row view and the requested outputs land in a reused 11-slot array, which is returned
 * and is valid until the next scalar evaluation (callers read it immediately). The view is created
 * on the first call and reused after.
 */
export function evaluateBlackScholesScalarUnchecked(
  plan: BlackScholesPlan,
  row: BlackScholesScalarRow,
): Float64Array {
  if (scalarRow === undefined) {
    const values = new Float64Array(BLACK_SCHOLES_OUTPUT_SLOTS);
    scalarRow = {
      columns: {
        spot: new Float64Array(1),
        strike: new Float64Array(1),
        timeToExpiryYears: new Float64Array(1),
        riskFreeRate: new Float64Array(1),
        volatility: new Float64Array(1),
        type: new Int8Array(1),
        dividendYield: new Float64Array(1),
      },
      values,
      targets: Array.from({ length: BLACK_SCHOLES_OUTPUT_SLOTS }, (_, slot) =>
        values.subarray(slot, slot + 1),
      ),
    };
  }
  const { columns, values, targets } = scalarRow;
  columns.spot[0] = row.spot;
  columns.strike[0] = row.strike;
  columns.timeToExpiryYears[0] = row.timeToExpiryYears;
  columns.riskFreeRate[0] = row.riskFreeRate;
  columns.volatility[0] = row.volatility;
  columns.type[0] = row.type === 'call' ? 1 : -1;
  columns.dividendYield[0] = row.dividendYield;
  evaluateBlackScholesRowsUnchecked(plan, columns, 1, targets);
  return values;
}
