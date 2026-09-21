/**
 * Credit (spec §14.4): hazard-rate / survival curves, CDS pricing (premium and protection legs with
 * accrual-on-default), bootstrapping a survival curve from CDS par spreads, par-spread term structures,
 * recovery, and the CDS-bond basis.
 *
 * A {@link SurvivalCurve} stores a piecewise-constant forward hazard `λ(t)` (so the survival probability
 * `Q(t) = exp(−∫₀ᵗ λ)` is log-linear between pillars), mirroring the discount curve's structure. CDS
 * cash flows are valued against an independent {@link YieldCurve} for discounting and the survival curve
 * for default timing. Inputs are validated and bad data throws (no silent degradation).
 */

import {
  type Computed,
  seriesFacade,
  ConvergenceError,
  ErrorCode,
  InputError,
  ensureFinite,
  ensureKnownKeys,
  isQuantError,
  missingFieldError,
  parseIsoDate,
  requireFiniteFields,
  isoDateToEpochMs,
  requireArgumentArray,
  requireArgumentObject,
  CONVENTIONS_VERSION,
  type QuantWarning,
} from '@totalfinance/core';
import {
  ensureBooleanWhenPresent,
  ensureDayCountWhenPresent,
  ensureFiniteFieldsWhenPresent,
  ensureFrequencyWhenPresent,
} from './validate.js';
import { brent } from '@totalfinance/math';
import {
  type FixedIncomeDayCount,
  type Frequency,
  compareDates,
  generateSchedule,
  yearFraction,
} from './conventions.js';
import type { YieldCurve } from './curves.js';

const DAY_MS = 86_400_000;

/** One CDS coupon period never needs more than this many protection-leg quadrature slices. */
const MAX_CDS_PROTECTION_STEPS_PER_PERIOD = 10_000;
/** Bound the complete protection-leg integration, not just either factor in isolation. */
const MAX_CDS_INTEGRATION_STEPS = 1_000_000;

/**
 * Curve fields take a curve INSTANCE, not a raw pillar list. A `{ }` (or a survival curve where a
 * discount curve belongs) would die on the first `discount()`/`survival()` call deep inside the leg
 * integration — teach the fix at the boundary instead (the same pattern as the rates guards).
 */
function requireCurveField(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is YieldCurve {
  const c = value as { discount?: unknown } | null | undefined;
  if (c === null || c === undefined || typeof c !== 'object' || typeof c.discount !== 'function') {
    throw new InputError(
      `${functionName}: ${field} must be a yield curve built by curves.fromZeroRates(...) / curves.flat(...) / ` +
        `curves.bootstrap(...) (an object with discount()); got ` +
        `${
          c === null ? 'null' : c === undefined ? 'undefined' : typeof c
        }. Build the curve first, then pass it here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
}

/** Survival-curve fields take a {@link SurvivalCurve} instance (from `credit.flatHazard(...)`, …). */
function requireSurvivalField(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is SurvivalCurve {
  const s = value as { survival?: unknown } | null | undefined;
  if (s === null || s === undefined || typeof s !== 'object' || typeof s.survival !== 'function') {
    throw new InputError(
      `${functionName}: ${field} must be a survival curve built by credit.flatHazard(...) / ` +
        `credit.survivalFromHazards(...) / credit.bootstrapHazardFromCds(...) (an object with survival()); got ` +
        `${
          s === null ? 'null' : s === undefined ? 'undefined' : typeof s
        }. Build the curve first, then pass it here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
}

/** Validate a {@link CdsCurves} bundle: both the discount and the survival curve are required. */
function requireCdsCurves(functionName: string, curves: CdsCurves): void {
  requireArgumentObject(functionName, 'curves', curves);
  ensureKnownKeys(functionName, 'curves', curves, CDS_CURVES_KEYS);
  requireCurveField(functionName, 'curves.discountCurve', curves.discountCurve);
  requireSurvivalField(functionName, 'curves.survivalCurve', curves.survivalCurve);
}

// ---------------------------------------------------------------------------------------------------
// Survival / hazard curve
// ---------------------------------------------------------------------------------------------------

export interface SurvivalPillar {
  date: string;
  tenorYears: number;
  /** Cumulative hazard H(t) = ∫₀ᵗ λ. */
  cumulativeHazard: number;
  /** Survival probability Q(t) = exp(−H(t)). */
  survival: number;
  /** Piecewise-constant forward hazard on the segment ending at this pillar. */
  hazard: number;
}

export interface SurvivalCurveOptions {
  /** Reference date (t = 0, where Q = 1). Default: the first pillar date. */
  referenceDate?: string;
  /** Day count mapping dates → year fractions. Default `ACT/365F`. */
  dayCount?: FixedIncomeDayCount;
}

export interface SurvivalCurve {
  readonly referenceDate: string;
  readonly dayCount: FixedIncomeDayCount;
  readonly pillars: readonly SurvivalPillar[];
  timeTo(at: string | number): number;
  /** Survival probability Q to a date or year fraction. */
  survival(at: string | number): number;
  /** Instantaneous (piecewise-constant) hazard rate at a date or year fraction. */
  hazard(at: string | number): number;
  /** Unconditional default probability in the window `[from, to]`: Q(from) − Q(to). */
  defaultProbability(from: string | number, to: string | number): number;
  /** Conditional default probability over `[from, to]` given survival to `from`: 1 − Q(to)/Q(from). */
  conditionalDefaultProbability(from: string | number, to: string | number): number;
}

interface SurvivalState {
  referenceDate: string;
  dayCount: FixedIncomeDayCount;
  ts: number[]; // strictly increasing, excludes the t=0 anchor
  hazards: number[]; // forward hazard on (t_{i-1}, t_i]
}

function buildSurvival(state: SurvivalState): SurvivalCurve {
  const { ts, hazards, dayCount, referenceDate } = state;
  const n = ts.length;
  // Cumulative hazard at each pillar.
  const H: number[] = [];
  let acc = 0;
  let prevT = 0;
  for (let i = 0; i < n; i++) {
    acc += hazards[i]! * (ts[i]! - prevT);
    H.push(acc);
    prevT = ts[i]!;
  }

  const timeTo = (at: string | number): number =>
    typeof at === 'number' ? at : yearFraction(referenceDate, at, dayCount);

  const cumHazard = (t: number): number => {
    if (t <= 0) return 0;
    if (t >= ts[n - 1]!) return H[n - 1]! + hazards[n - 1]! * (t - ts[n - 1]!); // flat extrapolation
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid]! <= t) lo = mid;
      else hi = mid;
    }
    // Segment containing t: (ts[lo], ts[lo+1]] unless t ≤ ts[0].
    if (t <= ts[0]!) return hazards[0]! * t;
    return H[lo]! + hazards[lo + 1]! * (t - ts[lo]!);
  };

  const hazardAt = (t: number): number => {
    if (t <= ts[0]!) return hazards[0]!;
    if (t >= ts[n - 1]!) return hazards[n - 1]!;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid]! < t) lo = mid;
      else hi = mid;
    }
    return hazards[lo + 1]!;
  };

  const survivalAt = (t: number): number => Math.exp(-cumHazard(t));

  const pillars: SurvivalPillar[] = ts.map((t, i) => ({
    date: addYears(referenceDate, t),
    tenorYears: t,
    cumulativeHazard: H[i]!,
    survival: Math.exp(-H[i]!),
    hazard: hazards[i]!,
  }));

  return {
    referenceDate,
    dayCount,
    pillars,
    timeTo,
    survival: (at) => survivalAt(timeTo(at)),
    hazard: (at) => hazardAt(timeTo(at)),
    defaultProbability: (from, to) => survivalAt(timeTo(from)) - survivalAt(timeTo(to)),
    conditionalDefaultProbability: (from, to) =>
      1 - survivalAt(timeTo(to)) / survivalAt(timeTo(from)),
  };
}

function addYears(referenceDate: string, t: number): string {
  const ms = isoDateToEpochMs(referenceDate) + Math.round(t * 365 * DAY_MS);
  const d = new Date(ms);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function resolveTimes(
  points: ReadonlyArray<readonly [string, number]>,
  referenceDate: string,
  dayCount: FixedIncomeDayCount,
  label: string,
): { ts: number[]; values: number[] } {
  if (points.length === 0) {
    throw new InputError(`resolveTimes: A ${label} curve needs at least one pillar.`, {
      code: ErrorCode.InputOutOfRange,
      context: { label },
    });
  }
  const rows = points.map(([date, value]) => ({
    t: yearFraction(referenceDate, date, dayCount),
    date,
    value,
  }));
  rows.sort((a, b) => a.t - b.t);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.t <= 0) {
      throw new InputError(
        `resolveTimes: Pillar ${rows[i]!.date} must be after the reference date.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { date: rows[i]!.date, referenceDate },
        },
      );
    }
    if (i > 0 && rows[i]!.t === rows[i - 1]!.t) {
      throw new InputError(`resolveTimes: Duplicate pillar at ${rows[i]!.date}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { date: rows[i]!.date },
      });
    }
  }
  return { ts: rows.map((r) => r.t), values: rows.map((r) => r.value) };
}

/** Build a survival curve from `(date, forwardHazard)` pillars (hazard constant up to each date). */

/**
 * A defaulted options parameter only defaults on `undefined` — an explicit `null` walks straight
 * into property access as a raw TypeError (2026-08-23, fourth review deep-sweep). Teach instead.
 */
function requireOptionsObjectWhenPresent(functionName: string, options: unknown): void {
  if (options === undefined) return;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new InputError(
      `${functionName}: options must be an object when provided. Received ${options === null ? 'null' : Array.isArray(options) ? 'array' : typeof options}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'options' } },
    );
  }
}

function survivalFromHazards(
  points: ReadonlyArray<readonly [string, number]>,
  options: SurvivalCurveOptions = {},
): SurvivalCurve {
  requireArgumentArray('credit.survivalFromHazards', 'points', points);
  requireOptionsObjectWhenPresent('credit.survivalFromHazards', options);
  ensureKnownKeys('credit.survivalFromHazards', 'options', options, ['referenceDate', 'dayCount']);
  if (points.length > 0 && !Array.isArray(points[0])) {
    throw new InputError(
      "credit.survivalFromHazards: points are [date, forwardHazardRate] tuples, e.g. [['2027-01-15', 0.02]].",
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  const referenceDate = options.referenceDate ?? points[0]?.[0] ?? '';
  ensureDayCountWhenPresent(options.dayCount, 'credit.survivalFromHazards');
  const dayCount = options.dayCount ?? ('ACT/365F' as FixedIncomeDayCount);
  const { ts, values } = resolveTimes(points, referenceDate, dayCount, 'hazard');
  for (const h of values) {
    if (!(h >= 0) || !Number.isFinite(h)) {
      throw new InputError(
        `survivalFromHazards: Hazard rate must be non-negative and finite (got ${h}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { hazard: h },
        },
      );
    }
  }
  return buildSurvival({ referenceDate, dayCount, ts, hazards: values });
}

/** Build a survival curve from `(date, survivalProbability)` pillars (monotone decreasing in (0,1]). */
function survivalFromProbabilities(
  points: ReadonlyArray<readonly [string, number]>,
  options: SurvivalCurveOptions = {},
): SurvivalCurve {
  requireArgumentArray('credit.survivalFromProbabilities', 'points', points);
  requireOptionsObjectWhenPresent('credit.survivalFromProbabilities', options);
  ensureKnownKeys('credit.survivalFromProbabilities', 'options', options, [
    'referenceDate',
    'dayCount',
  ]);
  if (points.length > 0 && !Array.isArray(points[0])) {
    throw new InputError(
      // A SURVIVAL PROBABILITY, not a hazard rate: `0.045` means a 95.5% chance of default by that
      // date, and the shape check is the first thing a confused caller reads.
      "credit.survivalFromProbabilities: points are [date, survivalProbability] tuples, e.g. [['2027-01-15', 0.9802]].",
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  const referenceDate = options.referenceDate ?? points[0]?.[0] ?? '';
  ensureDayCountWhenPresent(options.dayCount, 'credit.survivalFromProbabilities');
  const dayCount = options.dayCount ?? ('ACT/365F' as FixedIncomeDayCount);
  const { ts, values } = resolveTimes(points, referenceDate, dayCount, 'survival');
  const hazards: number[] = [];
  let prevQ = 1;
  let prevT = 0;
  for (let i = 0; i < ts.length; i++) {
    const q = values[i]!;
    if (!(q > 0) || q > 1 || q > prevQ) {
      throw new InputError(
        `survivalFromProbabilities: Survival probabilities must satisfy 0 < Q ≤ 1 and be non-increasing.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { date: addYears(referenceDate, ts[i]!), q, previous: prevQ },
        },
      );
    }
    hazards.push(-Math.log(q / prevQ) / (ts[i]! - prevT));
    prevQ = q;
    prevT = ts[i]!;
  }
  return buildSurvival({ referenceDate, dayCount, ts, hazards });
}

/** A flat-hazard survival curve (constant default intensity). */
export interface FlatHazardInput {
  hazardRate: number;
  referenceDate: string;
  options?: Omit<SurvivalCurveOptions, 'referenceDate'>;
}

function flatHazard(input: FlatHazardInput): SurvivalCurve {
  requireArgumentObject('credit.flatHazard', 'input', input);
  ensureKnownKeys('credit.flatHazard', 'input', input, ['hazardRate', 'referenceDate', 'options']);
  const { hazardRate, referenceDate, options: options = {} } = input;
  requireArgumentObject('credit.flatHazard', 'options', options);
  if (!(hazardRate >= 0) || !Number.isFinite(hazardRate)) {
    throw new InputError(`flatHazard: Hazard rate must be non-negative (got ${hazardRate}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { hazardRate },
    });
  }
  ensureDayCountWhenPresent(options.dayCount, 'credit.flatHazard');
  const dayCount = options.dayCount ?? ('ACT/365F' as FixedIncomeDayCount);
  return buildSurvival({ referenceDate, dayCount, ts: [1], hazards: [hazardRate] });
}

// ---------------------------------------------------------------------------------------------------
// CDS pricing
// ---------------------------------------------------------------------------------------------------

export interface CdsSpecification {
  effectiveDate: string;
  maturityDate: string;
  /** Running premium (coupon) rate, e.g. 0.01 = 100 bp. */
  spread: number;
  /** Recovery rate on default. Default 0.4. */
  recovery?: number;
  notional?: number;
  /** Premium payment frequency. Default quarterly. */
  frequency?: Frequency;
  /** Premium accrual day count. Default `ACT/360`. */
  dayCount?: FixedIncomeDayCount;
  /** Pay premium accrued since the last coupon on default. Default true. */
  accrualOnDefault?: boolean;
  /** Subdivisions per premium period for the protection-leg integral. Default 4. */
  protectionSteps?: number;
}

/** {@link CdsSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const CDS_SPEC_KEYS = [
  'effectiveDate',
  'maturityDate',
  'spread',
  'recovery',
  'notional',
  'frequency',
  'dayCount',
  'accrualOnDefault',
  'protectionSteps',
] as const;

export interface CdsCurves {
  discountCurve: YieldCurve;
  survivalCurve: SurvivalCurve;
}

/** {@link CdsCurves} keys (Law 12 — mirrors the interface above; keep in sync). */
const CDS_CURVES_KEYS = ['discountCurve', 'survivalCurve'] as const;

export interface CdsValuation {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** PV to the protection buyer (pays premium, receives default protection). */
  value: number;
  protectionLeg: number;
  premiumLeg: number;
  /** Risky annuity / PV01 basis: Σ τᵢ·DF·Q (+ accrual-on-default), per unit spread × notional. */
  riskyAnnuity: number;
  parSpread: number;
  /** Upfront value as a fraction of notional (protection-buyer sign). */
  upfront: number;
}

function midDate(a: string, b: string): string {
  const ms = (isoDateToEpochMs(a) + isoDateToEpochMs(b)) / 2;
  const d = new Date(ms);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function lerpDate(a: string, b: string, w: number): string {
  const ms = isoDateToEpochMs(a) + (isoDateToEpochMs(b) - isoDateToEpochMs(a)) * w;
  const d = new Date(ms);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

interface CdsLegs {
  protectionLeg: number;
  riskyAnnuity: number;
}

/**
 * `protectionSteps` is a synchronous loop bound. `Number.isInteger(1e308)` is true and, above
 * 2^53, `counter++` can stop changing entirely, so finite-only validation is not a safety guard.
 */
function requireProtectionStepsWhenPresent(functionName: string, value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CDS_PROTECTION_STEPS_PER_PERIOD
  ) {
    throw new InputError(
      `${functionName}: protectionSteps must be a positive safe integer ≤ ${MAX_CDS_PROTECTION_STEPS_PER_PERIOD.toLocaleString('en-US')} (each step evaluates discount and survival curves for every premium period); got ${String(value)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          protectionSteps: value,
          max: MAX_CDS_PROTECTION_STEPS_PER_PERIOD,
        },
      },
    );
  }
}

/** Compute the protection leg and risky annuity (per unit notional) for a CDS. */
function cdsLegs(
  functionName: string,
  specification: CdsSpecification,
  curves: CdsCurves,
): CdsLegs {
  const discount = curves.discountCurve;
  const survival = curves.survivalCurve;
  const recovery = specification.recovery ?? 0.4;
  const dayCount = specification.dayCount ?? 'ACT/360';
  const accrualOnDefault = specification.accrualOnDefault ?? true;
  const subSteps = specification.protectionSteps ?? 4;
  const schedule = generateSchedule({
    effectiveDate: specification.effectiveDate,
    maturityDate: specification.maturityDate,
    frequency: specification.frequency ?? 'quarterly',
  });
  const integrationSteps = schedule.length * subSteps;
  if (integrationSteps > MAX_CDS_INTEGRATION_STEPS) {
    throw new InputError(
      `${functionName}: premium periods × protectionSteps must not exceed ${MAX_CDS_INTEGRATION_STEPS.toLocaleString('en-US')} protection-leg evaluations; got ${schedule.length.toLocaleString('en-US')} × ${subSteps.toLocaleString('en-US')} = ${integrationSteps.toLocaleString('en-US')}. Shorten the maturity, use a coarser payment frequency, or reduce protectionSteps.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          premiumPeriods: schedule.length,
          protectionSteps: subSteps,
          integrationSteps,
          maxIntegrationSteps: MAX_CDS_INTEGRATION_STEPS,
        },
      },
    );
  }

  let protectionLeg = 0;
  let riskyAnnuity = 0;
  for (const p of schedule) {
    const tau = yearFraction(p.accrualStart, p.accrualEnd, dayCount);
    const dfPay = discount.discount(p.paymentDate);
    const qEnd = survival.survival(p.accrualEnd);
    // Premium paid only if the name survives to the coupon date.
    riskyAnnuity += tau * dfPay * qEnd;

    // Protection + accrual-on-default integrated over fine sub-intervals of the period.
    for (let s = 0; s < subSteps; s++) {
      const wA = s / subSteps;
      const wB = (s + 1) / subSteps;
      const uA = lerpDate(p.accrualStart, p.accrualEnd, wA);
      const uB = lerpDate(p.accrualStart, p.accrualEnd, wB);
      const qA = survival.survival(uA);
      const qB = survival.survival(uB);
      const dQ = qA - qB; // probability of default in (uA, uB]
      const dfMid = discount.discount(midDate(uA, uB));
      protectionLeg += (1 - recovery) * dfMid * dQ;
      if (accrualOnDefault) {
        // Average accrued premium fraction over the sub-interval ≈ half the elapsed accrual.
        const accruedFrac = yearFraction(p.accrualStart, midDate(uA, uB), dayCount);
        riskyAnnuity += accruedFrac * dfMid * dQ;
      }
    }
  }
  return { protectionLeg, riskyAnnuity };
}

/**
 * Optional CDS conventions run their ladders once per external call (the 350c2796 ruling): a null
 * dayCount used to coalesce into ACT/360 and silently change the accrual math, and a truthy
 * string accrualOnDefault silently kept the default integration.
 */
function requireCdsConventions(functionName: string, s: CdsSpecification): void {
  // The REQUIRED premium: an omitted spread used to flow into the legs as NaN and return it.
  requireFiniteFields(functionName, s, ['spread'], {
    exampleCall: `${functionName}({ effectiveDate: '2026-01-15', maturityDate: '2031-01-15', spread: 0.01 }, { discountCurve, survivalCurve })`,
  });
  ensureDayCountWhenPresent(s.dayCount, functionName);
  ensureFrequencyWhenPresent(s.frequency, functionName);
  ensureBooleanWhenPresent(s.accrualOnDefault, functionName, 'accrualOnDefault');
  ensureFiniteFieldsWhenPresent(functionName, s as unknown as Record<string, unknown>, [
    'recovery',
    'notional',
  ]);
  requireProtectionStepsWhenPresent(functionName, s.protectionSteps);
}

/** Value a CDS off discount and survival curves (PV to the protection buyer). */
export function cdsValue(specification: CdsSpecification, curves: CdsCurves): CdsValuation {
  requireCdsCurves('cdsValue', curves);
  requireArgumentObject('cdsValue', 'specification', specification);
  ensureKnownKeys('cdsValue', 'specification', specification, CDS_SPEC_KEYS);
  requireCdsConventions('cdsValue', specification);
  const notional = specification.notional ?? 1;
  const { protectionLeg, riskyAnnuity } = cdsLegs('cdsValue', specification, curves);
  if (riskyAnnuity === 0) {
    // Law 7: a zero risky annuity means no premium periods survive — malformed spec/curve, typed.
    throw new InputError(
      'cdsValue: the premium leg has no surviving accrual periods (zero risky annuity) — check the schedule and survival curve.',
      {
        code: ErrorCode.InputWrongShape,
        context: { maturity: specification.maturityDate },
      },
    );
  }
  const premiumLeg = specification.spread * riskyAnnuity;
  const parSpread = protectionLeg / riskyAnnuity;
  const value = notional * (protectionLeg - premiumLeg);
  return {
    value,
    protectionLeg: notional * protectionLeg,
    premiumLeg: notional * premiumLeg,
    riskyAnnuity,
    parSpread,
    upfront: protectionLeg - premiumLeg,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      notional,
      recovery: specification.recovery ?? 0.4,
    },
    diagnostics: { warnings: [] },
  };
}

/** Par CDS spread (the running coupon that makes the CDS value zero). */
/**
 * A par-spread request: a {@link CdsSpecification} WITHOUT `spread` (H02) — the par spread is the
 * ANSWER, so requiring a current spread demanded an input the calculation never reads. Passing one
 * anyway teaches (Law 12: accepted-but-ignored implies it mattered).
 */
export type ParCdsSpecification = Omit<CdsSpecification, 'spread'>;

/** {@link ParCdsSpecification} keys (Law 12 — `CDS_SPEC_KEYS` minus the irrelevant `spread`). */
const PAR_CDS_SPEC_KEYS = CDS_SPEC_KEYS.filter((k) => k !== 'spread');

/** The conventions ladder for a par request — everything but the (absent) spread. */
function requireParCdsConventions(functionName: string, s: ParCdsSpecification): void {
  ensureDayCountWhenPresent(s.dayCount, functionName);
  ensureFrequencyWhenPresent(s.frequency, functionName);
  ensureBooleanWhenPresent(s.accrualOnDefault, functionName, 'accrualOnDefault');
  ensureFiniteFieldsWhenPresent(functionName, s as unknown as Record<string, unknown>, [
    'recovery',
    'notional',
  ]);
  requireProtectionStepsWhenPresent(functionName, s.protectionSteps);
}

function cdsParSpreadLegs(
  functionName: string,
  specification: ParCdsSpecification,
  curves: CdsCurves,
): CdsLegs {
  requireCdsCurves(functionName, curves);
  requireArgumentObject(functionName, 'specification', specification);
  ensureKnownKeys(functionName, 'specification', specification, PAR_CDS_SPEC_KEYS);
  requireParCdsConventions(functionName, specification);
  const legs = cdsLegs(functionName, { ...specification, spread: 0 }, curves);
  if (legs.riskyAnnuity === 0) {
    throw new InputError(
      `${functionName}: the premium leg has no surviving accrual periods (zero risky annuity) — check the schedule and survival curve.`,
      {
        code: ErrorCode.InputWrongShape,
        context: { maturity: specification.maturityDate },
      },
    );
  }
  return legs;
}

/**
 * The par (breakeven) CDS spread: protection leg / risky annuity. Facade (H02): the plain call
 * returns the scalar; `.explain()` discloses the leg decomposition and every applied convention.
 */
/** The conventions `cdsParSpread.explain` echoes (FI day-count vocabulary — wider than core's
 *  `Assumptions` enum, so the facade construction below carries the same type-level-only cast as
 *  `bondFacade`; the runtime shape is exactly the core envelope). */
export interface CdsParSpreadAssumptions {
  conventionsVersion: string;
  effectiveDate: string;
  maturityDate: string;
  recovery: number;
  notional: number;
  frequency: Frequency;
  dayCount: FixedIncomeDayCount;
  accrualOnDefault: boolean;
  protectionSteps: number;
}

export type CdsParSpreadFacade = ((
  specification: ParCdsSpecification,
  curves: CdsCurves,
) => number) & {
  explain: (
    specification: ParCdsSpecification,
    curves: CdsCurves,
  ) => Omit<Computed<number>, 'assumptions'> & { assumptions: CdsParSpreadAssumptions };
};

export const cdsParSpread = seriesFacade(
  'cdsParSpread',
  (specification: ParCdsSpecification, curves: CdsCurves): number => {
    const { protectionLeg, riskyAnnuity } = cdsParSpreadLegs('cdsParSpread', specification, curves);
    return protectionLeg / riskyAnnuity;
  },
  ((specification: ParCdsSpecification, curves: CdsCurves) => {
    const { protectionLeg, riskyAnnuity } = cdsParSpreadLegs(
      'cdsParSpread.explain',
      specification,
      curves,
    );
    return {
      value: protectionLeg / riskyAnnuity,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        effectiveDate: specification.effectiveDate,
        maturityDate: specification.maturityDate,
        recovery: specification.recovery ?? 0.4,
        notional: specification.notional ?? 1,
        frequency: specification.frequency ?? 'quarterly',
        dayCount: specification.dayCount ?? 'ACT/360',
        accrualOnDefault: specification.accrualOnDefault ?? true,
        protectionSteps: specification.protectionSteps ?? 4,
      },
      diagnostics: {
        method: 'closed-form',
        // The arithmetic the ratio came from (per unit notional): parSpread = protection / annuity.
        decomposition: { protectionLeg, riskyAnnuity },
        warnings: [],
      },
    };
    /* The FI day-count vocabulary is wider than core's Assumptions enum — type-level only. */
  }) as unknown as (specification: ParCdsSpecification, curves: CdsCurves) => Computed<number>,
) as unknown as CdsParSpreadFacade;

// ---------------------------------------------------------------------------------------------------
// Hazard bootstrap from CDS spreads + spread-curve / basis helpers
// ---------------------------------------------------------------------------------------------------

export interface CdsQuote {
  maturity: string;
  /** Par spread quote (e.g. 0.012 = 120 bp). */
  spread: number;
}

export interface HazardBootstrapOptions {
  referenceDate: string;
  discountCurve: YieldCurve;
  recovery?: number;
  frequency?: Frequency;
  dayCount?: FixedIncomeDayCount;
  accrualOnDefault?: boolean;
  protectionSteps?: number;
}

/** {@link HazardBootstrapOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const HAZARD_BOOTSTRAP_OPTIONS_KEYS = [
  'referenceDate',
  'discountCurve',
  'recovery',
  'frequency',
  'dayCount',
  'accrualOnDefault',
  'protectionSteps',
] as const;

/** `HazardBootstrapOptions & { survivalCurve }` — the options shape `creditSpreadCurve` accepts. */
const SPREAD_CURVE_OPTIONS_KEYS = [...HAZARD_BOOTSTRAP_OPTIONS_KEYS, 'survivalCurve'] as const;

/** Validate the required valuation anchor before an empty input can bypass all date arithmetic. */
function requireHazardReferenceDate(
  functionName: string,
  value: unknown,
  exampleCall: string,
): asserts value is string {
  if (value === undefined || value === null) {
    throw missingFieldError(
      functionName,
      'options.referenceDate',
      exampleCall,
      'ISO calendar date (YYYY-MM-DD)',
    );
  }
  if (typeof value !== 'string') {
    throw new InputError(
      `${functionName}: options.referenceDate must be an ISO calendar date string (YYYY-MM-DD). Received ${typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'options.referenceDate', received: typeof value },
      },
    );
  }
  try {
    parseIsoDate(value);
  } catch (cause) {
    throw new InputError(
      `${functionName}: options.referenceDate must be a real ISO calendar date (YYYY-MM-DD). Received ${JSON.stringify(value)}.`,
      {
        code: isQuantError(cause) ? cause.code : ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'options.referenceDate', received: value },
        cause,
      },
    );
  }
}

/**
 * Bootstrap a survival curve from a CDS par-spread term structure. Hazard is piecewise-constant
 * between quote maturities; each segment is solved so the CDS to that tenor prices to par.
 */
export function bootstrapHazardFromCds(
  quotes: CdsQuote[],
  options: HazardBootstrapOptions,
): SurvivalCurve {
  requireArgumentArray('credit.bootstrapHazardFromCds', 'quotes', quotes);
  requireArgumentObject('credit.bootstrapHazardFromCds', 'options', options);
  ensureKnownKeys(
    'credit.bootstrapHazardFromCds',
    'options',
    options,
    HAZARD_BOOTSTRAP_OPTIONS_KEYS,
  );
  requireHazardReferenceDate(
    'credit.bootstrapHazardFromCds',
    options.referenceDate,
    "credit.bootstrapHazardFromCds(quotes, { referenceDate: '2026-01-02', discountCurve })",
  );
  requireCurveField(
    'credit.bootstrapHazardFromCds',
    'options.discountCurve',
    options.discountCurve,
  );
  ensureDayCountWhenPresent(options.dayCount, 'credit.bootstrapHazardFromCds');
  ensureFrequencyWhenPresent(options.frequency, 'credit.bootstrapHazardFromCds');
  ensureBooleanWhenPresent(
    options.accrualOnDefault,
    'credit.bootstrapHazardFromCds',
    'accrualOnDefault',
  );
  ensureFiniteFieldsWhenPresent(
    'credit.bootstrapHazardFromCds',
    options as unknown as Record<string, unknown>,
    ['recovery'],
  );
  requireProtectionStepsWhenPresent('credit.bootstrapHazardFromCds', options.protectionSteps);
  if (quotes.length === 0) {
    throw new InputError('bootstrapHazardFromCds: Hazard bootstrap needs at least one CDS quote.', {
      code: ErrorCode.InputOutOfRange,
      context: { quotes: 0 },
    });
  }
  const sorted = [...quotes].sort((a, b) => compareDates(a.maturity, b.maturity));
  const referenceDate = options.referenceDate;
  const dayCount = options.dayCount ?? ('ACT/365F' as FixedIncomeDayCount);
  const hazardPoints: [string, number][] = [];

  for (const quote of sorted) {
    const residual = (lambda: number): number => {
      const trial = survivalFromHazards([...hazardPoints, [quote.maturity, lambda]], {
        referenceDate,
        dayCount,
      });
      const specification: CdsSpecification = {
        effectiveDate: referenceDate,
        maturityDate: quote.maturity,
        spread: quote.spread,
        ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
        ...(options.frequency !== undefined ? { frequency: options.frequency } : {}),
        ...(options.dayCount !== undefined ? { dayCount: options.dayCount } : {}),
        ...(options.accrualOnDefault !== undefined
          ? { accrualOnDefault: options.accrualOnDefault }
          : {}),
        ...(options.protectionSteps !== undefined
          ? { protectionSteps: options.protectionSteps }
          : {}),
      };
      return cdsValue(specification, { discountCurve: options.discountCurve, survivalCurve: trial })
        .value;
    };
    const res = brent(residual, 1e-8, 5, { stepTolerance: 1e-12, maximumIterations: 200 });
    if (!res.converged) {
      throw new ConvergenceError(`Hazard bootstrap failed at the CDS maturing ${quote.maturity}.`, {
        code: ErrorCode.SolverNoConvergence,
        context: { maturity: quote.maturity, spread: quote.spread, reason: res.reason },
      });
    }
    hazardPoints.push([quote.maturity, res.value]);
  }
  return survivalFromHazards(hazardPoints, { referenceDate, dayCount });
}

/** Par CDS spread term structure implied by a survival + discount curve, one entry per tenor. */
/** One tenor of a {@link creditSpreadCurve}: the maturity and its par (breakeven) CDS spread. */
export interface CreditSpreadPoint {
  maturity: string;
  parSpread: number;
}

function creditSpreadCurveValue(
  functionName: string,
  tenors: string[],
  options: HazardBootstrapOptions & { survivalCurve: SurvivalCurve },
): CreditSpreadPoint[] {
  requireArgumentArray(functionName, 'tenors', tenors);
  // Validated ONCE, before the map — inside it the guard would never run for an empty tenor list.
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, SPREAD_CURVE_OPTIONS_KEYS);
  requireHazardReferenceDate(
    functionName,
    options.referenceDate,
    `${functionName}(tenors, { referenceDate: '2026-01-02', discountCurve, survivalCurve })`,
  );
  requireCurveField(functionName, 'options.discountCurve', options.discountCurve);
  requireSurvivalField(functionName, 'options.survivalCurve', options.survivalCurve);
  ensureDayCountWhenPresent(options.dayCount, functionName);
  ensureFrequencyWhenPresent(options.frequency, functionName);
  ensureBooleanWhenPresent(options.accrualOnDefault, functionName, 'accrualOnDefault');
  ensureFiniteFieldsWhenPresent(functionName, options as unknown as Record<string, unknown>, [
    'recovery',
  ]);
  requireProtectionStepsWhenPresent(functionName, options.protectionSteps);
  return tenors.map((maturity) => {
    // EVERY convention the caller supplied is forwarded to the per-tenor CDS. `accrualOnDefault`
    // and `protectionSteps` used to be accepted here and then silently dropped, so a curve built
    // with the same non-default options the hazard bootstrap consumed came back on DIFFERENT
    // conventions than it was calibrated on — a bootstrap→spread-curve round trip missed its own
    // quotes by ~0.24bp with no diagnostic (decision-ledger H03).
    const specification: ParCdsSpecification = {
      effectiveDate: options.referenceDate,
      maturityDate: maturity,
      ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
      ...(options.frequency !== undefined ? { frequency: options.frequency } : {}),
      ...(options.dayCount !== undefined ? { dayCount: options.dayCount } : {}),
      ...(options.accrualOnDefault !== undefined
        ? { accrualOnDefault: options.accrualOnDefault }
        : {}),
      ...(options.protectionSteps !== undefined
        ? { protectionSteps: options.protectionSteps }
        : {}),
    };
    return {
      maturity,
      parSpread: cdsParSpread(specification, {
        discountCurve: options.discountCurve,
        survivalCurve: options.survivalCurve,
      }),
    };
  });
}

/** The conventions `creditSpreadCurve.explain` echoes (H03) — every knob the per-tenor CDS runs on. */
export interface CreditSpreadCurveAssumptions {
  conventionsVersion: string;
  referenceDate: string;
  recovery: number;
  frequency: Frequency;
  dayCount: FixedIncomeDayCount;
  accrualOnDefault: boolean;
  /** Subdivisions per premium period in the protection-leg integral. */
  protectionSteps: number;
}

export type CreditSpreadCurveFacade = ((
  tenors: string[],
  options: HazardBootstrapOptions & { survivalCurve: SurvivalCurve },
) => CreditSpreadPoint[]) & {
  explain: (
    tenors: string[],
    options: HazardBootstrapOptions & { survivalCurve: SurvivalCurve },
  ) => Omit<Computed<CreditSpreadPoint[]>, 'assumptions'> & {
    assumptions: CreditSpreadCurveAssumptions;
  };
};

/**
 * Par CDS spreads at each tenor off the survival/discount curves. Facade (H03): the plain call
 * returns the points; `.explain()` echoes every convention the per-tenor CDS actually ran on —
 * the wave that landed the propagation fix proved `accrualOnDefault`/`protectionSteps` are
 * MATERIAL (the round trip missed its own quotes by ~0.24bp when they were dropped).
 */
export const creditSpreadCurve = seriesFacade(
  'creditSpreadCurve',
  (
    tenors: string[],
    options: HazardBootstrapOptions & { survivalCurve: SurvivalCurve },
  ): CreditSpreadPoint[] => creditSpreadCurveValue('creditSpreadCurve', tenors, options),
  ((tenors: string[], options: HazardBootstrapOptions & { survivalCurve: SurvivalCurve }) => {
    const points = creditSpreadCurveValue('creditSpreadCurve.explain', tenors, options);
    return {
      value: points,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        referenceDate: options.referenceDate,
        recovery: options.recovery ?? 0.4,
        frequency: options.frequency ?? 'quarterly',
        dayCount: options.dayCount ?? 'ACT/360',
        accrualOnDefault: options.accrualOnDefault ?? true,
        protectionSteps: options.protectionSteps ?? 4,
      },
      diagnostics: { method: 'closed-form', warnings: [] },
    };
    /* The FI day-count vocabulary is wider than core's Assumptions enum — type-level only. */
  }) as unknown as (
    tenors: string[],
    options: HazardBootstrapOptions & { survivalCurve: SurvivalCurve },
  ) => Computed<CreditSpreadPoint[]>,
) as unknown as CreditSpreadCurveFacade;

/** The credit-triangle envelope: the implied hazard plus the recovery it assumed (Law 2). */
export interface CreditTriangleHazardResult {
  /** Implied flat hazard rate λ (per year). */
  value: number;
  /** Applied conventions, echoed (Law 2 envelope grammar). */
  assumptions: {
    conventionsVersion: string;
    recovery: number;
    approximation: 'continuous-premium credit triangle';
  };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * The credit-triangle approximation of the hazard rate implied by a flat par spread:
 * `λ ≈ spread / (1 − recovery)`. Exact only in the continuous-premium, flat-curve limit. Returns a
 * Law-2 envelope: the hazard in `value` plus the recovery assumption and a warnings channel.
 */
export interface CreditTriangleHazardInput {
  spread: number;
  recovery?: number;
}

export function creditTriangleHazard(input: CreditTriangleHazardInput): CreditTriangleHazardResult {
  const functionName = 'creditTriangleHazard';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['spread', 'recovery']);
  const { spread, recovery = 0.4 } = input;
  ensureFinite(spread, 'spread', functionName);
  ensureFinite(recovery, 'recovery', functionName);
  if (recovery >= 1 || recovery < 0) {
    throw new InputError(`${functionName}: Recovery must be in [0, 1).`, {
      code: ErrorCode.InputOutOfRange,
      context: { recovery },
    });
  }
  return {
    value: spread / (1 - recovery),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      recovery,
      approximation: 'continuous-premium credit triangle',
    },
    diagnostics: { warnings: [] },
  };
}

/** CDS-bond basis: the CDS par spread minus the bond-implied credit spread (positive = CDS rich). */
export interface CdsBasisInput {
  cdsParSpread: number;
  bondImpliedSpread: number;
}

/**
 * CDS–bond basis: `cdsParSpread − bondImpliedSpread`, both DECIMAL annualized spreads (H01,
 * ratified plain). **Positive = the CDS is rich relative to the bond** (protection costs more
 * than the bond's credit spread pays); negative = the bond is cheap to the CDS.
 */
export function cdsBasis(input: CdsBasisInput): number {
  requireArgumentObject('credit.cdsBasis', 'input', input);
  ensureKnownKeys('credit.cdsBasis', 'input', input, ['cdsParSpread', 'bondImpliedSpread']);
  // Both legs are required: omitting either returned NaN, and a NaN basis reads as "no view" rather
  // than as the missing input it is.
  requireFiniteFields('credit.cdsBasis', input, ['cdsParSpread', 'bondImpliedSpread'], {
    exampleCall: 'credit.cdsBasis({ cdsParSpread: 0.012, bondImpliedSpread: 0.009 })',
    hints: {
      cdsParSpread: 'decimal, not basis points — 0.012 is 120 bp',
      bondImpliedSpread: 'decimal, not basis points — 0.009 is 90 bp',
    },
  });
  const { cdsParSpread, bondImpliedSpread } = input;
  return cdsParSpread - bondImpliedSpread;
}

/** Survival-curve constructors and credit analytics (spec §14.4). */
export const credit = {
  survivalFromHazards,
  survivalFromProbabilities,
  flatHazard,
  bootstrapHazardFromCds,
  creditSpreadCurve,
  creditTriangleHazard,
  cdsBasis,
};
