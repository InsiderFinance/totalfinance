/**
 * Convertible bonds (spec §14.1, previously "later"). A convertible couples three risk factors —
 * equity, rates, and credit — so it is priced by backward induction on an **equity binomial lattice**
 * (`@totalfinance/options`) with a **reduced-form hazard** credit model: at each node the bond may default
 * over the step (probability `1 − e^{−λ·dt}`, recovering `R·face`), and the holder optimally converts,
 * the issuer optimally calls, and the holder optionally puts.
 *
 * Credit comes from a {@link SurvivalCurve} (term-structured hazard) or a flat hazard rate. The result
 * decomposes the value into the **bond floor** (the same risky bond with conversion switched off) and
 * the embedded **equity option value** (`price − bondFloor`).
 */

import {
  ensureFiniteWhenPresent,
  ErrorCode,
  InputError,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentObject,
  CONVENTIONS_VERSION,
  type Diagnostics,
} from '@totalfinance/core';
import { ensureDayCountWhenPresent, ensureStepsPerYearWhenPresent } from './validate.js';
import { equityLattice } from '@totalfinance/options/lattice';
import {
  type FixedIncomeDayCount,
  type Frequency,
  generateSchedule,
  yearFraction,
} from './conventions.js';
import type { SurvivalCurve } from './credit.js';

export interface ConvertibleBondOption {
  date: string;
  /** Strike per the bond's face value (e.g. 102). */
  price: number;
}

export interface ConvertibleBondSpecification {
  issueDate: string;
  maturityDate: string;
  /** Annualized coupon rate (0 for a zero-coupon convertible). */
  couponRate: number;
  frequency: Frequency;
  faceValue?: number;
  /** Coupon accrual day count (default `30/360`). */
  dayCount?: FixedIncomeDayCount;
  /** Shares received per bond on conversion. */
  conversionRatio: number;
  /** Current share price. */
  spot: number;
  /** Equity volatility. */
  volatility: number;
  /** Continuous dividend yield on the share (default 0). */
  dividendYield?: number;
  /** Flat continuously-compounded risk-free rate used for lattice discounting. */
  riskFreeRate: number;
  /** Term-structured hazard (credit) — provide this or `hazardRate`. */
  survival?: SurvivalCurve;
  /** Flat hazard rate alternative to `survival`. */
  hazardRate?: number;
  /** Recovery on default, as a fraction of face (default 0.4). */
  recovery?: number;
  /** Issuer call schedule. */
  calls?: ConvertibleBondOption[];
  /** Holder put schedule. */
  puts?: ConvertibleBondOption[];
  /** Lattice steps per year (default 200, hard outer maximum 1,000,000; tree cap may be lower). */
  stepsPerYear?: number;
  /** Valuation date (default = issue date). */
  settlementDate?: string;
}

/** {@link ConvertibleBondSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const CONVERTIBLE_BOND_SPEC_KEYS = [
  'issueDate',
  'maturityDate',
  'couponRate',
  'frequency',
  'faceValue',
  'dayCount',
  'conversionRatio',
  'spot',
  'volatility',
  'dividendYield',
  'riskFreeRate',
  'survival',
  'hazardRate',
  'recovery',
  'calls',
  'puts',
  'stepsPerYear',
  'settlementDate',
] as const;

export interface ConvertibleBondResult {
  /** Convertible value. */
  price: number;
  /** Value of the otherwise-identical risky bond with conversion disabled (the bond floor). */
  bondFloor: number;
  /** Current conversion (parity) value `conversionRatio · spot`. */
  conversionValue: number;
  /** Embedded equity-option value: `price − bondFloor`. */
  optionValue: number;
  /** Applied conventions and model knobs, echoed (R2). */
  assumptions: {
    conventionsVersion: string;
    model: 'equity-lattice+reduced-form-credit';
    stepsPerYear: number;
    recovery: number;
    creditModel: 'survivalCurve' | 'flatHazard' | 'none';
  };
  /** Honest computation report (R2). */
  diagnostics: Diagnostics;
}

/** Price a convertible bond on an equity lattice with reduced-form credit (spec §14.1). */
export function convertibleBond(
  specification: ConvertibleBondSpecification,
): ConvertibleBondResult {
  requireArgumentObject('convertibleBond', 'specification', specification);
  ensureKnownKeys('convertibleBond', 'specification', specification, CONVERTIBLE_BOND_SPEC_KEYS);
  const functionName = 'convertibleBond';
  ensureFiniteWhenPresent(specification.faceValue, 'faceValue', functionName);
  ensureFiniteWhenPresent(specification.recovery, 'recovery', functionName);
  if (
    specification.settlementDate !== undefined &&
    (typeof specification.settlementDate !== 'string' || specification.settlementDate.length === 0)
  ) {
    throw new InputError(
      `${functionName}: settlementDate must be an ISO date string when provided. Received ${specification.settlementDate === null ? 'null' : typeof specification.settlementDate}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'settlementDate' } },
    );
  }
  ensureDayCountWhenPresent(specification.dayCount, functionName);
  for (const optionField of ['calls', 'puts'] as const) {
    const value = (specification as unknown as Record<string, unknown>)[optionField];
    if (value !== undefined && !Array.isArray(value)) {
      throw new InputError(
        `${functionName}: ${optionField} must be an array of { date, price } options when provided. Received ${value === null ? 'null' : typeof value}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: optionField, received: value },
        },
      );
    }
  }
  const face = specification.faceValue ?? 100;
  ensurePositive(face, 'faceValue', functionName);
  ensurePositive(specification.spot, 'spot', functionName);
  ensurePositive(specification.volatility, 'volatility', functionName);
  ensurePositive(specification.conversionRatio, 'conversionRatio', functionName);
  ensureFinite(specification.couponRate, 'couponRate', functionName);
  ensureFinite(specification.riskFreeRate, 'riskFreeRate', functionName);
  const recovery = specification.recovery ?? 0.4;
  if (recovery < 0 || recovery >= 1) {
    throw new InputError(`${functionName}: recovery must be in [0, 1), got ${recovery}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { recovery },
    });
  }
  if (specification.survival === undefined && specification.hazardRate === undefined) {
    throw new InputError(`${functionName}: provide a survival curve or a flat hazardRate.`, {
      code: ErrorCode.InputMissingField,
      context: {},
    });
  }
  if (specification.hazardRate !== undefined) {
    ensureFinite(specification.hazardRate, 'hazardRate', functionName);
    // A negative hazard makes `1 − e^{−λ·dt}` a negative "default probability", which inflates the
    // continuation value above the risk-free bond and returns a nonsensically high price. Reject it.
    if (specification.hazardRate < 0) {
      throw new InputError(
        `${functionName}: hazardRate must be ≥ 0, got ${specification.hazardRate}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { hazardRate: specification.hazardRate },
        },
      );
    }
  }

  const settlement = specification.settlementDate ?? specification.issueDate;
  const dayCount = specification.dayCount ?? '30/360';
  const T = yearFraction(settlement, specification.maturityDate, 'ACT/365F');
  if (T <= 0) {
    throw new InputError(`${functionName}: the bond matures on or before the valuation date.`, {
      code: ErrorCode.InputOutOfRange,
      context: { maturity: specification.maturityDate, settlement },
    });
  }
  ensureFiniteWhenPresent(specification.stepsPerYear, 'stepsPerYear', functionName);
  ensureStepsPerYearWhenPresent(specification.stepsPerYear, functionName);
  if (
    specification.survival !== undefined &&
    (specification.survival === null || typeof specification.survival !== 'object')
  ) {
    throw new InputError(
      `${functionName}: survival must be a survival-curve object when provided — build one with credit.flatHazard(...). Received ${specification.survival === null ? 'null' : typeof specification.survival}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'survival' } },
    );
  }
  const stepsPerYear = specification.stepsPerYear ?? 200;
  const steps = Math.max(2, Math.ceil(stepsPerYear * T));
  const lattice = equityLattice({
    spot: specification.spot,
    riskFreeRate: specification.riskFreeRate,
    volatility: specification.volatility,
    horizonYears: T,
    steps,
    ...(specification.dividendYield !== undefined
      ? { dividendYield: specification.dividendYield }
      : {}),
  });
  const timeStepYears = lattice.timeStepYears;
  const snap = (t: number): number => Math.min(steps, Math.max(0, Math.round(t / timeStepYears)));

  // Coupons by step (from the regular coupon schedule).
  const couponAt = new Array<number>(steps + 1).fill(0);
  const schedule = generateSchedule({
    effectiveDate: specification.issueDate,
    maturityDate: specification.maturityDate,
    frequency: specification.frequency,
  });
  for (const p of schedule) {
    const tEnd = yearFraction(settlement, p.accrualEnd, 'ACT/365F');
    if (tEnd <= 0) continue; // coupon already paid before settlement
    const coupon =
      specification.couponRate * face * yearFraction(p.accrualStart, p.accrualEnd, dayCount);
    couponAt[snap(tEnd)]! += coupon;
  }
  const callAt = new Map<number, number>();
  for (const c of specification.calls ?? []) {
    const t = yearFraction(settlement, c.date, 'ACT/365F');
    if (t > 0) callAt.set(snap(t), c.price);
  }
  const putAt = new Map<number, number>();
  for (const pu of specification.puts ?? []) {
    const t = yearFraction(settlement, pu.date, 'ACT/365F');
    if (t > 0) putAt.set(snap(t), pu.price);
  }

  const hazardAt = (t: number): number =>
    specification.survival?.hazard(t) ?? specification.hazardRate ?? 0;
  const recoveryValue = recovery * face;

  const value = (conversionRatio: number): number =>
    lattice.rollback(
      (sT) => Math.max(face, conversionRatio * sT) + couponAt[steps]!,
      (node) => {
        const qd = 1 - Math.exp(-hazardAt(node.timeToExpiryYears) * node.timeStepYears); // default probability over the step
        const survive = node.upProbability * node.up + (1 - node.upProbability) * node.down;
        const cont = node.discount * ((1 - qd) * survive + qd * recoveryValue);
        const convVal = conversionRatio * node.spot;
        let v = Math.max(cont, convVal); // holder converts when worthwhile
        const call = callAt.get(node.stepIndex);
        if (call !== undefined) v = Math.min(v, Math.max(call, convVal)); // issuer call (holder may convert)
        const put = putAt.get(node.stepIndex);
        if (put !== undefined) v = Math.max(v, put); // holder put
        return v + couponAt[node.stepIndex]!;
      },
    );

  const price = value(specification.conversionRatio);
  const bondFloor = value(0);
  const conversionValue = specification.conversionRatio * specification.spot;
  return {
    price,
    bondFloor,
    conversionValue,
    optionValue: price - bondFloor,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      model: 'equity-lattice+reduced-form-credit',
      stepsPerYear,
      recovery,
      creditModel: specification.survival
        ? 'survivalCurve'
        : specification.hazardRate !== undefined
          ? 'flatHazard'
          : 'none',
    },
    diagnostics: { method: 'equity-lattice', converged: true, warnings: [] },
  };
}
