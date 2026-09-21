/**
 * Crypto carry curve / futures term structure (spec: `docs/specs/carry-curve.md`).
 *
 * `futuresBasis` reads the carry off one dated future; `carryCurve` builds the whole term structure from a
 * spot + a set of futures: each expiry's implied carry (composing `futuresBasis` verbatim), the **forward
 * carry** the market prices between consecutive expiries, the curve **shape**, and the carry at any
 * interpolated tenor (log-linear in `ln F`, flat-forward beyond the ends). Deterministic; `@totalfinance/core`-only.
 */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  finalizeResult,
  type QuantWarning,
  requireArgumentArray,
  requireArgumentObject,
  type Computed,
} from '@totalfinance/core';
import { type BasisStructure, futuresBasis } from './carry.js';

/** A single dated future on the underlying. */
export interface CarryCurveFuture {
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** Future price. */
  price: number;
}

/** Input for {@link carryCurve}. */
export interface CarryCurveInput {
  /** Spot / index price (`t = 0`). */
  spot: number;
  /** Dated futures on the same underlying (≥ 1; distinct expiries). */
  futures: CarryCurveFuture[];
  /** Quote financing rate — enables per-point cash-and-carry richness. */
  financingRate?: number;
  /** Coin (base) yield. Default 0. */
  coinYield?: number;
  /** Tenors (years) to interpolate the carry at. */
  queryTenors?: number[];
  /** |forward-carry| range below which the shape is `flat`. Default 5e-4 (5 bp). */
  flatTolerance?: number;
}

/** A carry-curve point (one expiry). */
export interface CarryCurvePoint {
  timeToExpiryYears: number;
  price: number;
  /** `ln(price/spot)/t` — the continuously-compounded implied carry. */
  annualizedCarry: number;
  structure: BasisStructure;
  /** `price − spot·e^{(r−q)t}` — present only when `financingRate` is supplied. */
  richness?: number;
}

/** The market's marginal carry over a window between two expiries (the first is `spot → F₁`). */
export interface CarryForward {
  fromTenorYears: number;
  toTenorYears: number;
  forwardCarry: number;
}

/** An interpolated carry point. */
export interface CarryInterp {
  timeToExpiryYears: number;
  impliedForward: number;
  annualizedCarry: number;
}

/** The overall term-structure shape (from the forward-carry sequence). */
export type CarryCurveShape = 'upward' | 'downward' | 'humped' | 'flat' | 'mixed';

/** The futures carry term structure. */
export interface CarryCurve {
  spot: number;
  /** One point per future, sorted by expiry. */
  points: CarryCurvePoint[];
  /** Forward carries: `spot → F₁`, `F₁ → F₂`, … (one per future). */
  forwards: CarryForward[];
  shape: CarryCurveShape;
  /** Interpolated carries — present only when `queryTenors` is supplied. */
  interpolated?: CarryInterp[];
}

/** Classify the term-structure shape from the forward-carry sequence. */
function classifyShape(carries: number[], tolerance: number): CarryCurveShape {
  if (carries.length < 2) return 'flat';
  const min = Math.min(...carries);
  const max = Math.max(...carries);
  if (max - min < tolerance) return 'flat';
  const diffs: number[] = [];
  for (let i = 1; i < carries.length; i++) diffs.push(carries[i]! - carries[i - 1]!);
  if (diffs.every((d) => d >= -tolerance)) return 'upward';
  if (diffs.every((d) => d <= tolerance)) return 'downward';
  // Humped: rises to an interior peak, then falls.
  const peak = carries.indexOf(max);
  if (peak > 0 && peak < carries.length - 1) {
    const leftUp = carries
      .slice(0, peak + 1)
      .every((v, i, a) => i === 0 || v >= a[i - 1]! - tolerance);
    const rightDown = carries.slice(peak).every((v, i, a) => i === 0 || v <= a[i - 1]! + tolerance);
    if (leftUp && rightDown) return 'humped';
  }
  return 'mixed';
}

/** Log-linear interpolation of `ln F(t)` (flat-forward extrapolation beyond the last expiry). */
function interpLnForward(xs: number[], ys: number[], timeToExpiryYears: number): number {
  const n = xs.length - 1; // last index
  for (let i = 1; i <= n; i++) {
    if (timeToExpiryYears <= xs[i]!) {
      const w = (timeToExpiryYears - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
      return ys[i - 1]! + w * (ys[i]! - ys[i - 1]!);
    }
  }
  // Beyond the last expiry: extend at the last window's slope (constant forward carry).
  const slope = (ys[n]! - ys[n - 1]!) / (xs[n]! - xs[n - 1]!);
  return ys[n]! + slope * (timeToExpiryYears - xs[n]!);
}

function assumptions(): Assumptions {
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    model: 'carry',
    engine: 'carry-curve',
  };
}

/**
 * Build the futures carry term structure: per-expiry implied carry (composing {@link futuresBasis}), the
 * forward carry between consecutive expiries, the curve shape, and the carry at any requested interpolated
 * tenor. See `docs/specs/carry-curve.md`.
 */
/** EXACT {@link CarryCurveInput} fields (Law 12) — unknown keys are rejected, never ignored. */
const CARRY_CURVE_KEYS = [
  'spot',
  'futures',
  'financingRate',
  'coinYield',
  'queryTenors',
  'flatTolerance',
] as const;

export function carryCurve(input: CarryCurveInput): Computed<CarryCurve> {
  const functionName = 'carryCurve';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, CARRY_CURVE_KEYS);
  ensurePositive(input.spot, 'spot', functionName);
  requireArgumentArray(functionName, 'futures', (input as { futures?: unknown }).futures);
  if (input.futures.length === 0) {
    throw new InputError(`${functionName}: futures must be a non-empty array.`, {
      code: ErrorCode.InputOutOfRange,
      context: { futures: 0 },
    });
  }
  input.futures.forEach((f, i) => {
    requireArgumentObject(functionName, `futures[${i}]`, f);
    ensurePositive(f.timeToExpiryYears, `futures[${i}].timeToExpiryYears`, functionName);
    ensurePositive(f.price, `futures[${i}].price`, functionName);
  });
  if (
    input.flatTolerance !== undefined &&
    (typeof input.flatTolerance !== 'number' || !Number.isFinite(input.flatTolerance))
  ) {
    throw new InputError(
      `carryCurve: flatTolerance must be a finite number when provided. Received ${input.flatTolerance === null ? 'null' : typeof input.flatTolerance}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'flatTolerance' } },
    );
  }
  const flatTolerance = input.flatTolerance ?? 5e-4;
  ensureNonNegative(flatTolerance, 'flatTolerance', functionName);

  // Sort by expiry and reject non-increasing (a zero-width forward window).
  const sorted = [...input.futures].sort((a, b) => a.timeToExpiryYears - b.timeToExpiryYears);
  for (let i = 1; i < sorted.length; i++) {
    if (!(sorted[i]!.timeToExpiryYears > sorted[i - 1]!.timeToExpiryYears)) {
      throw new InputError(
        `${functionName}: futures must have distinct expiries; found duplicate timeToExpiryYears = ${sorted[i]!.timeToExpiryYears}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { timeToExpiryYears: sorted[i]!.timeToExpiryYears },
        },
      );
    }
  }

  // Per-expiry carry, reusing futuresBasis verbatim (identical to the single-expiry tool) —
  // INCLUDING its diagnostics: a per-point `crypto.carry_arbitrage` (or an implausible financing
  // rate) is the curve's finding too, and dropping it made the composed tool quieter than the tool
  // it composes.
  const curveWarnings: QuantWarning[] = [];
  const points: CarryCurvePoint[] = sorted.map((f) => {
    const b = futuresBasis({
      spot: input.spot,
      future: f.price,
      timeToExpiryYears: f.timeToExpiryYears,
      ...(input.financingRate !== undefined ? { financingRate: input.financingRate } : {}),
      ...(input.coinYield !== undefined ? { coinYield: input.coinYield } : {}),
    });
    for (const w of b.diagnostics.warnings) {
      curveWarnings.push({
        ...w,
        context: { ...(w.context ?? {}), timeToExpiryYears: f.timeToExpiryYears },
      });
    }
    const pt: CarryCurvePoint = {
      timeToExpiryYears: f.timeToExpiryYears,
      price: f.price,
      annualizedCarry: b.value.annualizedLog,
      structure: b.value.structure,
    };
    if (b.value.richness !== undefined) pt.richness = b.value.richness;
    return pt;
  });

  // Forward carries: spot(t=0, F=spot) → F₁ → F₂ → …
  const forwards: CarryForward[] = [];
  let prevT = 0;
  let prevF = input.spot;
  for (const f of sorted) {
    forwards.push({
      fromTenorYears: prevT,
      toTenorYears: f.timeToExpiryYears,
      forwardCarry: Math.log(f.price / prevF) / (f.timeToExpiryYears - prevT),
    });
    prevT = f.timeToExpiryYears;
    prevF = f.price;
  }

  const shape = classifyShape(
    forwards.map((w) => w.forwardCarry),
    flatTolerance,
  );

  const payload: CarryCurve = {
    spot: input.spot,
    points,
    forwards,
    shape,
  };

  if (input.queryTenors !== undefined) {
    requireArgumentArray(functionName, 'queryTenors', input.queryTenors as unknown);
    const xs = [0, ...sorted.map((f) => f.timeToExpiryYears)];
    const ys = [Math.log(input.spot), ...sorted.map((f) => Math.log(f.price))];
    payload.interpolated = input.queryTenors.map((tenor, i) => {
      ensurePositive(tenor, `queryTenors[${i}]`, functionName);
      const impliedForward = Math.exp(interpLnForward(xs, ys, tenor));
      return {
        timeToExpiryYears: tenor,
        impliedForward,
        annualizedCarry: Math.log(impliedForward / input.spot) / tenor,
      };
    });
  }

  return finalizeResult(functionName, {
    value: payload,
    assumptions: assumptions(),
    diagnostics: {
      engine: 'carry-curve',
      method: 'closed-form',
      converged: true,
      warnings: curveWarnings,
    },
  });
}
