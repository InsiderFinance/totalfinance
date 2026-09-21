/**
 * Lattice-priced instruments (spec §14.1, §14.3): callable/putable bonds and Bermudan swaptions,
 * priced by backward induction on the calibrated Hull-White / Black-Karasinski short-rate trinomial
 * tree from {@link ./models}. These are the items the Phase-6 tree unblocks — embedded-option pricing
 * the analytic (European) engines can't express.
 *
 * Callable/putable bonds roll the bond's cash flows back through the tree and cap (call) or floor
 * (put) the continuation value at the option strike on each option date; the option-adjusted spread
 * (OAS) is the parallel curve shift that reprices the model to a market price. Bermudan swaptions take
 * `max(continuation, swap value)` on each exercise date, with the node-level swap value from the
 * Hull-White analytic bond reconstruction.
 */

import {
  ensureFiniteWhenPresent,
  ConvergenceError,
  ErrorCode,
  InputError,
  ensureEnum,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentArray,
  requireArgumentObject,
  CONVENTIONS_VERSION,
  type Diagnostics,
} from '@totalfinance/core';
import {
  ensureDayCountWhenPresent,
  ensureFrequencyWhenPresent,
  ensureStepsPerYearWhenPresent,
} from './validate.js';
import { brent } from '@totalfinance/math';
import type { Bond } from './bonds.js';
import {
  type FixedIncomeDayCount,
  type Frequency,
  generateSchedule,
  yearFraction,
} from './conventions.js';
import type { YieldCurve } from './curves.js';
import { type TreeModel, hullWhite, shortRateTree } from './models.js';

/**
 * Ceiling on the expanding spread bracket: ±5000bp. A spread past this is not a spread — the market
 * price and the model disagree structurally (wrong bond, wrong curve, or a price in the wrong
 * units), and a five-digit basis-point answer would dress that disagreement up as a measurement.
 */
const MAXIMUM_SPREAD_BRACKET = 0.5;

/**
 * Bracket and solve a spread (OAS / Z-spread) root, EXPANDING the bracket until the objective
 * changes sign, capped at {@link MAXIMUM_SPREAD_BRACKET}.
 *
 * The bracket was hard-coded to ±500bp. Any high-yield or stressed callable sits outside it, and
 * Brent then reported no sign change — which surfaced as "OAS solve did not converge", a diagnosis
 * of the solver for what was actually a window that never contained the answer. Beyond the cap the
 * error names the interval that was searched, so the reader can tell "no root here" from
 * "root-finding failed" (the same posture as the yield bracket in `bonds.ts`).
 */
function solveSpreadBracketed(
  objective: (spread: number) => number,
  functionName: string,
  which: string,
  context: Record<string, unknown>,
): { value: number; iterations: number } {
  let lo = -0.05;
  let hi = 0.05;
  let fLo = objective(lo);
  let fHi = objective(hi);
  let expansions = 0;
  while (
    Number.isFinite(fLo) &&
    Number.isFinite(fHi) &&
    fLo * fHi > 0 &&
    hi < MAXIMUM_SPREAD_BRACKET
  ) {
    lo = Math.max(lo * 2, -MAXIMUM_SPREAD_BRACKET);
    hi = Math.min(hi * 2, MAXIMUM_SPREAD_BRACKET);
    fLo = objective(lo);
    fHi = objective(hi);
    expansions++;
  }
  const res = brent(objective, lo, hi, { stepTolerance: 1e-10, maximumIterations: 100 });
  if (!res.converged) {
    const bp = (s: number): string => `${(s * 1e4).toFixed(0)}bp`;
    throw new ConvergenceError(
      `${functionName}: no ${which} in the bracket searched — [${bp(lo)}, ${bp(hi)}] (expanded ` +
        `outward from ±500bp to at most ±${bp(MAXIMUM_SPREAD_BRACKET)}) — reprices the model to the ` +
        'market price. A gap that large usually means the market price and the model disagree ' +
        'structurally: check the price is a DIRTY price on the same face value, and that the curve ' +
        "shares the bond's currency and reference date.",
      {
        code: ErrorCode.SolverNoConvergence,
        context: {
          ...context,
          bracketSearched: [lo, hi],
          bracketExpansions: expansions,
          iterations: res.iterations,
          reason: res.reason,
        },
      },
    );
  }
  return { value: res.value, iterations: res.iterations + expansions };
}

// ───────────────────────── callable / putable bonds ─────────────────────────

export interface BondOption {
  /** Option date (issuer call / holder put opportunity). */
  date: string;
  /** Strike (clean redemption price per the bond's face value, e.g. 102). */
  price: number;
}

export interface CallableBondSpecification {
  bond: Bond;
  /** Calibration/discount curve (its reference date is the valuation date). */
  curve: YieldCurve;
  /** Mean reversion and short-rate volatility for the tree model. */
  meanReversion: number;
  sigma: number;
  /** Tree model (default `hull-white`). */
  model?: TreeModel;
  /** Issuer call schedule (caps the bond's value at each strike). */
  calls?: BondOption[];
  /** Holder put schedule (floors the bond's value at each strike). */
  puts?: BondOption[];
  /** Tree steps per year (default 24, hard outer maximum 1,000,000; total-tree cap may be lower). */
  stepsPerYear?: number;
  /** Market dirty price; when given, the result includes the option-adjusted spread. */
  marketPrice?: number;
}

/** {@link CallableBondSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const CALLABLE_BOND_SPEC_KEYS = [
  'bond',
  'curve',
  'meanReversion',
  'sigma',
  'model',
  'calls',
  'puts',
  'stepsPerYear',
  'marketPrice',
] as const;

/**
 * The lattice facades take a Bond INSTANCE (from `bonds.fixedRate(...)` et al.) — a raw spec object
 * would crash on the first `cashflows()` call inside the rollback, so teach the fix at the boundary
 * (the same pattern as `requireBondInstance` in bonds).
 */
function requireBondField(functionName: string, value: unknown): asserts value is Bond {
  const b = value as { cashflows?: unknown; maturityDate?: unknown } | null | undefined;
  if (b === null || b === undefined || typeof b !== 'object' || typeof b.cashflows !== 'function') {
    throw new InputError(
      `${functionName}: bond must be a bond built by bonds.fixedRate(...) / bonds.zeroCoupon(...) (a Bond ` +
        `instance with cash-flow methods); got ` +
        `${value === null ? 'null' : value === undefined ? 'undefined' : typeof value}. ` +
        `Build the bond first, then pass it here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'bond' } },
    );
  }
}

/**
 * Curve fields take a curve INSTANCE (from `curves.fromZeroRates(...)` / `curves.flat(...)` /
 * `curves.bootstrap(...)`), not a raw pillar list — a `{}` would die on `referenceDate`/`shift()`
 * before the tree's own guard could run (the same pattern as `requireCurveField` in rates).
 */
function requireCurveField(functionName: string, value: unknown): asserts value is YieldCurve {
  const c = value as { discount?: unknown; shift?: unknown } | null | undefined;
  if (
    c === null ||
    c === undefined ||
    typeof c !== 'object' ||
    typeof c.discount !== 'function' ||
    typeof c.shift !== 'function'
  ) {
    throw new InputError(
      `${functionName}: curve must be a yield curve built by curves.fromZeroRates(...) / curves.flat(...) / ` +
        `curves.bootstrap(...) (an object with discount()/shift()); got ` +
        `${value === null ? 'null' : value === undefined ? 'undefined' : typeof value}. ` +
        `Build the curve first, then pass it here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'curve' } },
    );
  }
}

export interface CallableBondResult {
  /** Model dirty price including the embedded option(s). */
  price: number;
  /** Model dirty price of the otherwise-identical straight bond (no embedded options). */
  straightPrice: number;
  /** Value of the embedded option(s): `straightPrice − price` (positive for a callable). */
  optionValue: number;
  /** Effective duration from a ±1bp parallel curve shock (re-trees each side). */
  effectiveDuration: number;
  /** Option-adjusted spread (parallel curve shift repricing the model to `marketPrice`); present only when `marketPrice` is supplied. */
  oas?: number;
  /** Applied conventions and model knobs, echoed (R2). */
  assumptions: {
    conventionsVersion: string;
    dayCount: 'ACT/365F';
    settlementDate: string;
    model: TreeModel;
    stepsPerYear: number;
    meanReversion: number;
    sigma: number;
  };
  /** Honest computation report: the lattice method, and the OAS root-find when one ran (R2). */
  diagnostics: Diagnostics;
}

interface CallablePrices {
  callable: number;
  straight: number;
}

function priceCallableOnCurve(
  specification: CallableBondSpecification,
  curve: YieldCurve,
): CallablePrices {
  const { bond } = specification;
  const settlement = curve.referenceDate;
  const maturityYf = yearFraction(settlement, bond.maturityDate, 'ACT/365F');
  if (maturityYf <= 0) {
    throw new InputError('callableBond: the bond matures on or before the valuation date.', {
      code: ErrorCode.InputOutOfRange,
      context: { maturity: bond.maturityDate, settlement },
    });
  }
  ensureFiniteWhenPresent(specification.stepsPerYear, 'stepsPerYear', 'lattice');
  const stepsPerYear = specification.stepsPerYear ?? 24;
  const steps = Math.max(2, Math.ceil(stepsPerYear * maturityYf));
  const tree = shortRateTree(curve, {
    meanReversion: specification.meanReversion,
    sigma: specification.sigma,
    model: specification.model ?? 'hull-white',
    horizonYears: maturityYf,
    steps,
  });
  const timeStepYears = tree.timeStepYears;
  const snap = (t: number): number => Math.min(steps, Math.max(0, Math.round(t / timeStepYears)));

  // Coupon injected at each step; principal redemption seeds the terminal nodes.
  const couponAt = new Array<number>(steps + 1).fill(0);
  let redemption = 0;
  for (const cf of bond.cashflows()) {
    const step = snap(yearFraction(settlement, cf.date, 'ACT/365F'));
    couponAt[step]! += cf.interest;
    if (step === steps) redemption += cf.principal;
    else couponAt[step]! += cf.principal; // amortizing principal before maturity
  }
  const callAt = new Map<number, number>();
  for (const c of specification.calls ?? [])
    callAt.set(snap(yearFraction(settlement, c.date, 'ACT/365F')), c.price);
  const putAt = new Map<number, number>();
  for (const p of specification.puts ?? [])
    putAt.set(snap(yearFraction(settlement, p.date, 'ACT/365F')), p.price);

  const terminal = redemption + couponAt[steps]!;
  const roll = (withOptions: boolean): number =>
    tree.rollback(
      steps,
      () => terminal,
      (i, _j, cont) => {
        let v = cont;
        if (withOptions) {
          const call = callAt.get(i);
          if (call !== undefined) v = Math.min(v, call);
          const put = putAt.get(i);
          if (put !== undefined) v = Math.max(v, put);
        }
        return v + couponAt[i]!;
      },
    );
  return { callable: roll(true), straight: roll(false) };
}

/** Price a callable and/or putable bond on a short-rate tree, with option value, effective duration, and OAS. */
export function callableBond(specification: CallableBondSpecification): CallableBondResult {
  requireArgumentObject('callableBond', 'specification', specification);
  ensureKnownKeys('callableBond', 'specification', specification, CALLABLE_BOND_SPEC_KEYS);
  requireBondField('callableBond', specification.bond);
  requireCurveField('callableBond', specification.curve);
  ensureStepsPerYearWhenPresent(specification.stepsPerYear, 'callableBond');
  for (const optionField of ['calls', 'puts'] as const) {
    const value = (specification as unknown as Record<string, unknown>)[optionField];
    if (value !== undefined && !Array.isArray(value)) {
      throw new InputError(
        `callableBond: ${optionField} must be an array of { date, price } options when provided. Received ${value === null ? 'null' : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: optionField, received: value } },
      );
    }
  }
  if (
    specification.model !== undefined &&
    specification.model !== null &&
    typeof specification.model !== 'object'
  ) {
    throw new InputError(
      `callableBond: model must be a short-rate model configuration object when provided. Received ${typeof specification.model}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'model' } },
    );
  }
  if (specification.model === null) {
    throw new InputError(
      'callableBond: model must not be null — omit the field to use the default short-rate model. Received null.',
      { code: ErrorCode.InputWrongType, context: { field: 'model' } },
    );
  }
  if (!(specification.calls?.length || specification.puts?.length)) {
    throw new InputError('callableBond: provide at least one call or put option.', {
      code: ErrorCode.InputMissingField,
      context: {},
    });
  }
  const base = priceCallableOnCurve(specification, specification.curve);
  const bump = 1e-4;
  const up = priceCallableOnCurve(specification, specification.curve.shift(bump)).callable;
  const dn = priceCallableOnCurve(specification, specification.curve.shift(-bump)).callable;
  const effectiveDuration = base.callable === 0 ? 0 : (dn - up) / (2 * base.callable * bump);

  const result: CallableBondResult = {
    price: base.callable,
    straightPrice: base.straight,
    optionValue: base.straight - base.callable,
    effectiveDuration,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      dayCount: 'ACT/365F',
      settlementDate: specification.curve.referenceDate,
      model: specification.model ?? 'hull-white',
      stepsPerYear: specification.stepsPerYear ?? 24,
      meanReversion: specification.meanReversion,
      sigma: specification.sigma,
    },
    diagnostics: { method: 'short-rate-lattice', converged: true, warnings: [] },
  };

  if (specification.marketPrice !== undefined) {
    const objective = (s: number): number =>
      priceCallableOnCurve(specification, specification.curve.shift(s)).callable -
      specification.marketPrice!;
    const res = solveSpreadBracketed(objective, 'callableBond', 'OAS', {
      marketPrice: specification.marketPrice,
    });
    result.diagnostics = {
      method: 'short-rate-lattice + brent(oas)',
      converged: true,
      iterations: res.iterations,
      warnings: [],
    };
    result.oas = res.value;
  }
  return result;
}

// ───────────────────────── OAS analytics ─────────────────────────

export interface OasAnalyticsSpecification extends Omit<CallableBondSpecification, 'marketPrice'> {
  /** Market dirty price the OAS and Z-spread are solved to. */
  marketPrice: number;
  /** Curve shock for the effective duration/convexity, in decimal. Default 1e-4 (1 bp). */
  durationShock?: number;
  /**
   * Optional term-structure spread curve added to `curve` before the spreads are solved. The effective
   * benchmark becomes `curve` + `spreadCurve` (continuous zeros add ⇔ discount factors multiply), so the
   * reported OAS and Z-spread are measured OVER a NON-FLAT benchmark — e.g. an OIS discount curve plus a
   * sector/rating spread curve — rather than the plain `curve`. Its zero rates ARE the spreads (build one
   * with `curves.fromZeroRates(spreadPillars)`); it must share `curve`'s reference date.
   */
  spreadCurve?: YieldCurve;
}

/** {@link OasAnalyticsSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const OAS_ANALYTICS_SPEC_KEYS = [
  ...CALLABLE_BOND_SPEC_KEYS,
  'durationShock',
  'spreadCurve',
] as const;

export interface OasAnalyticsResult {
  /** Parallel curve shift repricing the callable model to `marketPrice` (decimal; ×1e4 = bps). */
  oas: number;
  /** Zero-volatility spread on the same lattice's straight leg (decimal). */
  zSpread: number;
  /** `zSpread − oas` (decimal) — the embedded-option cost. Positive callable / negative putable. */
  optionCost: number;
  /** OAS-consistent effective duration (curve shocked ±`durationShock` at constant OAS). */
  effectiveDuration: number;
  /** OAS-consistent effective convexity. */
  effectiveConvexity: number;
  /** The no-spread lattice model price (the gap `marketPrice − modelPrice` is what the OAS explains). */
  modelPrice: number;
  marketPrice: number;
  assumptions: CallableBondResult['assumptions'];
  diagnostics: Diagnostics;
}

/**
 * Market-calibrated option-adjusted-spread analytics for a callable/putable bond: the OAS, the Z-spread,
 * their difference (the embedded-**option cost**), and the **OAS-consistent** effective duration and
 * convexity (the curve shocked with the spread held fixed). Composes the same short-rate lattice as
 * {@link callableBond}. See `docs/specs/oas-analytics.md`.
 */
export function oasAnalytics(specification: OasAnalyticsSpecification): OasAnalyticsResult {
  requireArgumentObject('oasAnalytics', 'specification', specification);
  for (const optionField of ['calls', 'puts'] as const) {
    const value = (specification as unknown as Record<string, unknown>)[optionField];
    if (value !== undefined && !Array.isArray(value)) {
      throw new InputError(
        `oasAnalytics: ${optionField} must be an array of { date, price } options when provided. Received ${value === null ? 'null' : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: optionField } },
      );
    }
  }
  const modelValue = (specification as unknown as Record<string, unknown>)['model'];
  if (modelValue !== undefined && (modelValue === null || typeof modelValue !== 'object')) {
    throw new InputError(
      `oasAnalytics: model must be a short-rate model configuration object when provided. Received ${modelValue === null ? 'null' : typeof modelValue}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'model' } },
    );
  }
  ensureKnownKeys('oasAnalytics', 'specification', specification, OAS_ANALYTICS_SPEC_KEYS);
  requireBondField('oasAnalytics', specification.bond);
  requireCurveField('oasAnalytics', specification.curve);
  ensureStepsPerYearWhenPresent(specification.stepsPerYear, 'oasAnalytics');
  if (specification.spreadCurve !== undefined) {
    requireCurveField('oasAnalytics', specification.spreadCurve);
    if (specification.spreadCurve.referenceDate !== specification.curve.referenceDate) {
      throw new InputError(
        `oasAnalytics: spreadCurve.referenceDate (${specification.spreadCurve.referenceDate}) must match ` +
          `curve.referenceDate (${specification.curve.referenceDate}).`,
        { code: ErrorCode.InputWrongShape, context: { field: 'spreadCurve' } },
      );
    }
  }
  if (specification.durationShock !== undefined) {
    ensurePositive(specification.durationShock, 'durationShock', 'oasAnalytics');
  }
  if (specification.marketPrice === undefined) {
    throw new InputError('oasAnalytics: marketPrice is required.', {
      code: ErrorCode.InputMissingField,
      context: {},
    });
  }
  ensurePositive(specification.marketPrice, 'marketPrice', 'oasAnalytics');
  if (!(specification.calls?.length || specification.puts?.length)) {
    throw new InputError('oasAnalytics: provide at least one call or put option.', {
      code: ErrorCode.InputMissingField,
      context: {},
    });
  }
  const market = specification.marketPrice;
  // The benchmark the spreads are measured over: the plain curve, or curve + a non-flat spread curve.
  const benchmark = specification.spreadCurve
    ? specification.curve.addSpread(specification.spreadCurve)
    : specification.curve;
  const callableAt = (s: number): number =>
    priceCallableOnCurve(specification, benchmark.shift(s)).callable;
  const straightAt = (s: number): number =>
    priceCallableOnCurve(specification, benchmark.shift(s)).straight;

  const solveSpread = (price: (s: number) => number, which: string): number =>
    solveSpreadBracketed((s) => price(s) - market, 'oasAnalytics', which, { marketPrice: market })
      .value;

  const oas = solveSpread(callableAt, 'OAS');
  const zSpread = solveSpread(straightAt, 'Z-spread');

  // OAS-consistent risk: shock the curve at CONSTANT OAS. P₀ = callableAt(oas) recovers the market price
  // (> 0, validated), so the division is always safe.
  const shock = specification.durationShock ?? 1e-4;
  const p0 = callableAt(oas);
  const pUp = callableAt(oas + shock);
  const pDn = callableAt(oas - shock);
  const effectiveDuration = (pDn - pUp) / (2 * p0 * shock);
  const effectiveConvexity = (pUp + pDn - 2 * p0) / (p0 * shock * shock);

  return {
    oas,
    zSpread,
    optionCost: zSpread - oas,
    effectiveDuration,
    effectiveConvexity,
    modelPrice: callableAt(0),
    marketPrice: market,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      dayCount: 'ACT/365F',
      settlementDate: specification.curve.referenceDate,
      model: specification.model ?? 'hull-white',
      stepsPerYear: specification.stepsPerYear ?? 24,
      meanReversion: specification.meanReversion,
      sigma: specification.sigma,
    },
    diagnostics: {
      method:
        'short-rate-lattice + brent(oas) + brent(z-spread)' +
        (specification.spreadCurve ? ' over benchmark+spreadCurve' : ''),
      converged: true,
      warnings: [],
    },
  };
}

// ───────────────────────── Bermudan swaptions ─────────────────────────

export interface BermudanSwaptionSpecification {
  /** Discount/forecast curve (single-curve); its reference date is the valuation date. */
  curve: YieldCurve;
  /** Underlying swap maturity. */
  maturityDate: string;
  /** Fixed rate of the underlying swap. */
  fixedRate: number;
  /** `payer` = option to pay fixed; `receiver` = option to receive fixed. */
  optionType: 'payer' | 'receiver';
  /** Dates on which the holder may exercise into the swap (each is a swap start). */
  exerciseDates: string[];
  /** Fixed-leg frequency (default semiannual). */
  fixedFrequency?: Frequency;
  /** Fixed-leg day count (default `30/360`). */
  fixedDayCount?: FixedIncomeDayCount;
  /** Mean reversion and short-rate vol. */
  meanReversion: number;
  sigma: number;
  notional?: number;
  /** Tree steps per year (default 24, hard outer maximum 1,000,000; total-tree cap may be lower). */
  stepsPerYear?: number;
}

/** {@link BermudanSwaptionSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const BERMUDAN_SWAPTION_SPEC_KEYS = [
  'curve',
  'maturityDate',
  'fixedRate',
  'optionType',
  'exerciseDates',
  'fixedFrequency',
  'fixedDayCount',
  'meanReversion',
  'sigma',
  'notional',
  'stepsPerYear',
] as const;

export interface BermudanSwaptionResult {
  /** Option value, scaled by `notional`. */
  price: number;
  /** The exercise schedule actually used, sorted ascending from the valuation date. */
  exerciseDates: string[];
  /** Applied conventions and model knobs, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    model: 'hull-white';
    dayCount: 'ACT/365F';
    settlementDate: string;
    stepsPerYear: number;
    meanReversion: number;
    sigma: number;
    fixedFrequency: Frequency;
    fixedDayCount: FixedIncomeDayCount;
    notional: number;
  };
  /** Honest computation report: the lattice method behind the price (Law 2 report grammar). */
  diagnostics: Diagnostics;
}

/**
 * Price a Bermudan swaption on the Hull-White tree. At each exercise date the holder takes
 * `max(continuation, swapValue)`, where the node-level forward swap value uses the Hull-White analytic
 * bond reconstruction `P(tᵢ, T; r_node)`. (Hull-White only — the lognormal Black-Karasinski tree has
 * no analytic node bond.)
 */
export function bermudanSwaption(
  specification: BermudanSwaptionSpecification,
): BermudanSwaptionResult {
  const functionName = 'bermudanSwaption';
  requireArgumentObject(functionName, 'specification', specification);
  ensureKnownKeys(functionName, 'specification', specification, BERMUDAN_SWAPTION_SPEC_KEYS);
  requireCurveField(functionName, specification.curve);
  requireArgumentArray(functionName, 'spec.exerciseDates', specification.exerciseDates);
  ensureFinite(specification.fixedRate, 'fixedRate', functionName);
  ensureEnum(specification.optionType, ['payer', 'receiver'] as const, 'optionType', functionName);
  ensureDayCountWhenPresent(specification.fixedDayCount, functionName);
  ensureFrequencyWhenPresent(specification.fixedFrequency, functionName);
  ensureFiniteWhenPresent(specification.notional, 'notional', functionName);
  ensureFiniteWhenPresent(specification.stepsPerYear, 'stepsPerYear', functionName);
  ensureStepsPerYearWhenPresent(specification.stepsPerYear, functionName);
  const curve = specification.curve;
  const settlement = curve.referenceDate;
  const notional = specification.notional ?? 1;
  const exDates = [...specification.exerciseDates].sort(
    (x, y) => yearFraction(settlement, x, 'ACT/365F') - yearFraction(settlement, y, 'ACT/365F'),
  );
  if (exDates.length === 0) {
    throw new InputError('bermudanSwaption: at least one exercise date is required.', {
      code: ErrorCode.InputOutOfRange,
      context: {},
    });
  }
  const maturityYf = yearFraction(settlement, specification.maturityDate, 'ACT/365F');
  ensureFiniteWhenPresent(specification.stepsPerYear, 'stepsPerYear', 'lattice');
  const stepsPerYear = specification.stepsPerYear ?? 24;
  const steps = Math.max(2, Math.ceil(stepsPerYear * maturityYf));
  const tree = shortRateTree(curve, {
    meanReversion: specification.meanReversion,
    sigma: specification.sigma,
    model: 'hull-white',
    horizonYears: maturityYf,
    steps,
  });
  const timeStepYears = tree.timeStepYears;
  const snap = (t: number): number => Math.min(steps, Math.max(0, Math.round(t / timeStepYears)));
  const hw = hullWhite(curve, { a: specification.meanReversion, sigma: specification.sigma });

  // Fixed-leg schedule of the underlying swap (full life from settlement to maturity).
  const fixedSchedule = generateSchedule({
    effectiveDate: settlement,
    maturityDate: specification.maturityDate,
    frequency: specification.fixedFrequency ?? 'semiannual',
  });
  const fixedDc = specification.fixedDayCount ?? '30/360';
  const payTimes = fixedSchedule.map((p) => ({
    end: yearFraction(settlement, p.accrualEnd, 'ACT/365F'),
    tau: yearFraction(p.accrualStart, p.accrualEnd, fixedDc),
  }));
  const swapEnd = maturityYf;

  // Map each exercise date to a tree step, deduped.
  const exerciseSteps = new Set(exDates.map((d) => snap(yearFraction(settlement, d, 'ACT/365F'))));
  const lastStep = Math.max(...exerciseSteps);

  /** Forward payer-swap value per unit notional at node (stepIndex i, level j), from the node rate. */
  const swapValue = (i: number, j: number): number => {
    const ti = i * timeStepYears;
    const r = tree.shortRate(i, j);
    let annuity = 0;
    for (const p of payTimes) {
      if (p.end <= ti + 1e-9) continue; // only future fixed coupons
      annuity +=
        p.tau * hw.discountBond({ valuationTime: ti, timeToMaturity: p.end - ti, shortRate: r });
    }
    const floatPv =
      1 - hw.discountBond({ valuationTime: ti, timeToMaturity: swapEnd - ti, shortRate: r }); // single-curve telescoping from tᵢ
    const payer = floatPv - specification.fixedRate * annuity;
    return specification.optionType === 'payer' ? payer : -payer;
  };

  const price = tree.rollback(
    lastStep,
    (j) => Math.max(swapValue(lastStep, j), 0),
    (i, j, cont) => (exerciseSteps.has(i) ? Math.max(cont, swapValue(i, j)) : cont),
  );
  return {
    price: notional * price,
    exerciseDates: exDates,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      model: 'hull-white',
      dayCount: 'ACT/365F',
      settlementDate: settlement,
      stepsPerYear,
      meanReversion: specification.meanReversion,
      sigma: specification.sigma,
      fixedFrequency: specification.fixedFrequency ?? 'semiannual',
      fixedDayCount: fixedDc,
      notional,
    },
    diagnostics: { method: 'short-rate-lattice', converged: true, warnings: [] },
  };
}
