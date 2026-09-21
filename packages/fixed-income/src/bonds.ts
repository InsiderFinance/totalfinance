/**
 * Bonds (spec §14.1): fixed-rate, zero-coupon, floating-rate notes, amortizing, and inflation-linked
 * instruments, with the full analytics suite — clean/dirty price, accrued interest, yield to maturity
 * and to call, Macaulay / modified / effective / key-rate duration, convexity, and DV01/PV01.
 *
 * Yield-based metrics use the actuarial ("true yield") convention: a cash flow at year fraction τ from
 * settlement (under the bond's day count) is discounted by `(1 + y/f)^(−f·τ)`, where `f` is the bond's
 * coupon frequency. This is unambiguous, handles stub periods and zero-coupons uniformly, and yields
 * clean closed-form duration/convexity. Curve-based metrics (effective/key-rate duration) reprice
 * against a {@link YieldCurve} and its shocks. Floating and inflation coupons are *projected* from the
 * supplied curve/index, then valued — bad or missing projection inputs throw (no silent degradation).
 */

import {
  requireFiniteFields,
  type Assumptions,
  CONVENTIONS_VERSION,
  type Computed,
  ConvergenceError,
  type Diagnostics,
  ErrorCode,
  InputError,
  type ClosedRequestSpecification,
  type QuantWarning,
  ensureKnownKeys,
  requireArgumentObject,
  seriesFacade,
  validateClosedRequest,
  warning,
} from '@totalfinance/core';
import { brent } from '@totalfinance/math';
import { FIELD_HINTS, specificationExampleCall } from './validate.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';
import {
  type BusinessDayConvention,
  type FixedIncomeDayCount,
  type Frequency,
  type SchedulePeriod,
  compareDates,
  generateSchedule,
  paymentsPerYear,
  yearFraction,
} from './conventions.js';
import type { YieldCurve } from './curves.js';

// ---------------------------------------------------------------------------------------------------
// Cash flows
// ---------------------------------------------------------------------------------------------------

export interface CashFlow {
  /** Regular (unadjusted) schedule date — used for accrual, time-to-cashflow, and yield discounting. */
  date: string;
  /** Business-day-adjusted payment date — used for curve discounting. */
  paymentDate: string;
  /** Total payment (interest + principal). */
  amount: number;
  /** Coupon/interest portion. */
  interest: number;
  /** Principal (redemption/amortization) portion. */
  principal: number;
  /** Outstanding notional accruing over the period that produced this flow. */
  notional: number;
}

/** Projection inputs for instruments whose coupons are not fixed at issuance. */
export interface ProjectionContext {
  /** Forecast curve for projecting floating-rate coupons. */
  forecastCurve?: YieldCurve;
  /** Price-index level at a date, for inflation-linked indexation. */
  referenceIndex?: (date: string) => number;
  /**
   * The index fixing (decimal, e.g. `0.0532` for 5.32%) that ALREADY SET the coupon currently
   * accruing on a floating-rate note — the one whose accrual period began before the forecast
   * curve's reference date.
   *
   * A settled-mid-period FRN has one coupon that is no longer a projection: it was fixed in the
   * past, on a date the curve does not reach. Asking the curve for it is a query before its
   * reference date, which throws. Supply the observed fixing (SOFR/EURIBOR print for that reset)
   * and it is used verbatim for that one coupon; every later coupon still projects off the curve.
   * The note's quoted `spread` is added on top, exactly as for a projected coupon.
   *
   * Only the in-progress coupon is substituted. Coupons that both began AND ended before the
   * curve's reference date are settled history, not projections — one fixing cannot honestly stand
   * in for a whole strip of past resets, so those are rejected rather than fabricated.
   */
  knownFixingRate?: number;
}

export type BondKind = 'fixed' | 'zero' | 'frn' | 'amortizing' | 'inflation';

/** Amortization style for an amortizing bond. */
export type Amortization =
  | { type: 'straight' } // equal principal each period
  | { type: 'annuity' } // level total payment (principal + interest)
  | { principalByPeriod: readonly number[] }; // explicit principal repayments, one per coupon period

/** The fields every bond specification shares — the base the per-kind specifications extend. */
export interface BaseSpecification {
  /** Dated date / first accrual date. */
  issueDate: string;
  maturityDate: string;
  /** Annualized coupon rate (decimal). */
  couponRate: number;
  frequency: Frequency;
  /** Redemption / par value. Default 100. */
  faceValue?: number;
  /** Accrual day count. Default `30/360`. */
  dayCount?: FixedIncomeDayCount;
  convention?: BusinessDayConvention;
  endOfMonth?: boolean;
}

/** A constructed bond: schedule, cash flows, and settlement-relative helpers. */
export interface Bond {
  readonly kind: BondKind;
  readonly faceValue: number;
  readonly issueDate: string;
  readonly maturityDate: string;
  readonly couponRate: number;
  readonly frequency: number;
  readonly dayCount: FixedIncomeDayCount;
  /** Business-day convention applied when the payment schedule was generated. */
  readonly businessDayConvention: BusinessDayConvention;
  readonly schedule: readonly SchedulePeriod[];
  /** Every life cash flow (projected via `context` for FRN/inflation). */
  cashflows(context?: ProjectionContext): CashFlow[];
  /** Cash flows strictly after `settlementDate` — what a buyer settling then receives. */
  futureCashflows(settlementDate: string, context?: ProjectionContext): CashFlow[];
  /** Accrued interest at `settlementDate` (per the bond's face value). */
  accrued(settlementDate: string, context?: ProjectionContext): number;
}

function faceOf(specification: { faceValue?: number }): number {
  const f = specification.faceValue ?? 100;
  if (!Number.isFinite(f) || f <= 0) {
    throw new InputError(`faceOf: faceValue must be a positive number (got ${f}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'faceValue', value: f },
    });
  }
  return f;
}

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations —
 * including the `Amortization` union, whose branch resolution is the shared validator's
 * discriminant-first path. Resolved at module load so a stale key fails at import.
 */
function specOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `bonds: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const FIXED_RATE_SPEC = specOf('bonds.fixedRate#0');
const ZERO_COUPON_SPEC = specOf('bonds.zeroCoupon#0');
const FRN_SPEC = specOf('bonds.floatingRateNote#0');
const AMORTIZING_SPEC = specOf('bonds.amortizing#0');
const INFLATION_LINKED_SPEC = specOf('bonds.inflationLinked#0');
const BOND_CONTEXT_SPEC = specOf('Bond#cashflows#0');
const PRICE_MULTI_CURVE_BOND_SPEC = specOf('priceMultiCurve#0');
const PRICE_MULTI_CURVE_OPTIONS_SPEC = specOf('priceMultiCurve#1');
const YIELD_TO_CALL_BOND_SPEC = specOf('yieldToCall#0');
const YIELD_TO_CALL_CALL_SPEC = specOf('yieldToCall#1');
const YIELD_TO_CALL_OPTIONS_SPEC = specOf('yieldToCall#2');

const ANALYTICS_EXAMPLE = (): string =>
  "yieldToCall(bond, { callDate: '2028-01-15', callPrice: 102 }, { price: 98.5, settlementDate: '2026-06-15' })";

/** The bespoke bond teaching, unchanged from `requireSpecification`: derived example + unit hints. */
function specificationTeaching(functionName: string, required: readonly string[]) {
  return {
    argumentName: 'specification',
    subject: true,
    exampleCall: () => specificationExampleCall(functionName, required),
    hints: FIELD_HINTS,
  } as const;
}

const CONTEXT_TEACHING = {
  argumentName: 'context',
  exampleCall: "bond.futureCashflows('2026-06-15', { forecastCurve, knownFixingRate: 0.0532 })",
} as const;

function buildSchedule(specification: BaseSpecification): SchedulePeriod[] {
  return generateSchedule({
    effectiveDate: specification.issueDate,
    maturityDate: specification.maturityDate,
    frequency: specification.frequency,
    ...(specification.convention !== undefined ? { convention: specification.convention } : {}),
    ...(specification.endOfMonth !== undefined ? { endOfMonth: specification.endOfMonth } : {}),
  });
}

/** Assemble the shared `Bond` shell from a precomputed cash-flow generator. */
function makeBond(
  kind: BondKind,
  specification: BaseSpecification,
  schedule: SchedulePeriod[],
  flowsFor: (context: ProjectionContext) => CashFlow[],
): Bond {
  const face = faceOf(specification);
  const dayCount = specification.dayCount ?? '30/360';
  const frequency = paymentsPerYear(specification.frequency);

  const accrued = (settlementDate: string, context: ProjectionContext = {}): number => {
    validateClosedRequest('bond.accrued', context, BOND_CONTEXT_SPEC, CONTEXT_TEACHING);
    const period = schedule.find(
      (p) =>
        compareDates(p.accrualStart, settlementDate) <= 0 &&
        compareDates(settlementDate, p.accrualEnd) < 0,
    );
    if (!period) return 0; // before issue or on/after maturity
    const full = yearFraction(period.accrualStart, period.accrualEnd, dayCount);
    const partial = yearFraction(period.accrualStart, settlementDate, dayCount);
    const frac = full === 0 ? 0 : partial / full;
    // The interest the *current* period will pay, scaled by the elapsed fraction.
    const flow = flowsFor(context).find((f) => f.date === period.accrualEnd);
    return flow ? flow.interest * frac : 0;
  };

  return {
    kind,
    faceValue: face,
    issueDate: specification.issueDate,
    maturityDate: specification.maturityDate,
    couponRate: specification.couponRate,
    frequency,
    dayCount,
    // Mirrors the default in `generateSchedule` (buildSchedule omits it when spec.convention is unset).
    businessDayConvention: specification.convention ?? 'modifiedFollowing',
    schedule,
    cashflows: (context = {}) => {
      validateClosedRequest('bond.cashflows', context, BOND_CONTEXT_SPEC, CONTEXT_TEACHING);
      return flowsFor(context);
    },
    futureCashflows: (settlementDate, context = {}) => {
      validateClosedRequest('bond.futureCashflows', context, BOND_CONTEXT_SPEC, CONTEXT_TEACHING);
      return flowsFor(context).filter((f) => compareDates(f.date, settlementDate) > 0);
    },
    accrued,
  };
}

// ---------------------------------------------------------------------------------------------------
// Bond constructors
// ---------------------------------------------------------------------------------------------------

export type FixedRateBondSpecification = BaseSpecification;

function fixedRate(specification: FixedRateBondSpecification): Bond {
  validateClosedRequest(
    'bonds.fixedRate',
    specification,
    FIXED_RATE_SPEC,
    specificationTeaching('bonds.fixedRate', [
      'issueDate',
      'maturityDate',
      'couponRate',
      'frequency',
    ]),
  );
  const face = faceOf(specification);
  const dayCount = specification.dayCount ?? '30/360';
  const schedule = buildSchedule(specification);
  const last = schedule.length - 1;
  const flowsFor = (): CashFlow[] =>
    schedule.map((p, i) => {
      const interest =
        specification.couponRate * face * yearFraction(p.accrualStart, p.accrualEnd, dayCount);
      const principal = i === last ? face : 0;
      return {
        date: p.accrualEnd,
        paymentDate: p.paymentDate,
        interest,
        principal,
        amount: interest + principal,
        notional: face,
      };
    });
  return makeBond('fixed', specification, schedule, flowsFor);
}

export interface ZeroCouponBondSpecification {
  issueDate: string;
  maturityDate: string;
  faceValue?: number;
  dayCount?: FixedIncomeDayCount;
  /** Yield compounding frequency for analytics. Default 1 (annual). */
  frequency?: Frequency;
}

function zeroCoupon(specification: ZeroCouponBondSpecification): Bond {
  validateClosedRequest(
    'bonds.zeroCoupon',
    specification,
    ZERO_COUPON_SPEC,
    specificationTeaching('bonds.zeroCoupon', ['issueDate', 'maturityDate']),
  );
  const face = faceOf(specification);
  const base: BaseSpecification = {
    issueDate: specification.issueDate,
    maturityDate: specification.maturityDate,
    couponRate: 0,
    frequency: specification.frequency ?? 'annual',
    ...(specification.faceValue !== undefined ? { faceValue: specification.faceValue } : {}),
    ...(specification.dayCount !== undefined ? { dayCount: specification.dayCount } : {}),
  };
  // A single redemption flow at maturity — no coupon schedule.
  const schedule: SchedulePeriod[] = [
    {
      accrualStart: specification.issueDate,
      accrualEnd: specification.maturityDate,
      paymentDate: specification.maturityDate,
      isStub: false,
    },
  ];
  const flowsFor = (): CashFlow[] => [
    {
      date: specification.maturityDate,
      paymentDate: specification.maturityDate,
      interest: 0,
      principal: face,
      amount: face,
      notional: face,
    },
  ];
  return makeBond('zero', base, schedule, flowsFor);
}

export interface FloatingRateNoteSpecification extends BaseSpecification {
  /** Quoted margin over the projected index (decimal), e.g. 0.0025 = 25bp. Default 0. */
  spread?: number;
}

/**
 * Resolve the index rate for ONE floating coupon: the curve's forward when the reset is still in
 * the future, the caller's observed fixing when the reset already happened.
 *
 * A forecast curve begins at its reference date, so `curve.forwardRate` over a period that STARTED
 * before it is a query before t = 0 and throws `Curve query before reference date (t=−0.08)`. That
 * is the correct refusal from the curve and a useless message from the FRN: settling any FRN
 * between two coupon dates hits it, and nothing in the error names the missing input. The in-progress
 * coupon is not a projection at all — it was fixed on a past reset date — so the caller supplies it
 * via {@link ProjectionContext.knownFixingRate}.
 */
function projectFrnRate(
  period: SchedulePeriod,
  curve: YieldCurve,
  dayCount: FixedIncomeDayCount,
  context: ProjectionContext,
): number {
  if (compareDates(period.accrualStart, curve.referenceDate) >= 0) {
    return curve.forwardRate(period.accrualStart, period.accrualEnd, dayCount);
  }
  // The reset predates the curve. Only a coupon still ACCRUING at the reference date is a single,
  // nameable fixing; a coupon that also ENDED before it is settled history.
  if (compareDates(period.accrualEnd, curve.referenceDate) <= 0) {
    throw new InputError(
      `projectFrnRate: A floating-rate note coupon accruing ${period.accrualStart} → ${period.accrualEnd} ended before ` +
        `the forecast curve's reference date (${curve.referenceDate}): it was set by a historical ` +
        'index print, which a forward curve cannot supply, and one fixing cannot stand in for a strip ' +
        'of past resets. Build the note from the coupon period in progress (issueDate = the last ' +
        'reset date) and pass that reset via context.knownFixingRate, or use a forecast curve whose ' +
        "referenceDate is on or before the note's issueDate.",
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          kind: 'frn',
          accrualStart: period.accrualStart,
          accrualEnd: period.accrualEnd,
          curveReferenceDate: curve.referenceDate,
        },
      },
    );
  }
  const fixing = context.knownFixingRate;
  if (fixing === undefined) {
    throw new InputError(
      `projectFrnRate: A floating-rate note settling mid-period needs context.knownFixingRate: the coupon accruing ` +
        `${period.accrualStart} → ${period.accrualEnd} was FIXED on ${period.accrualStart}, before the ` +
        `forecast curve's reference date (${curve.referenceDate}), so the curve cannot project it. ` +
        'Pass the observed index fixing for that reset (a decimal, e.g. 0.0532 for 5.32%).\n' +
        '  e.g. priceMultiCurve(frn, { settlementDate, discountCurve, forecastCurve }) with\n' +
        '       frn.cashflows({ forecastCurve, knownFixingRate: 0.0532 })',
      {
        code: ErrorCode.InputMissingField,
        context: {
          kind: 'frn',
          field: 'knownFixingRate',
          accrualStart: period.accrualStart,
          accrualEnd: period.accrualEnd,
          curveReferenceDate: curve.referenceDate,
        },
      },
    );
  }
  if (!Number.isFinite(fixing)) {
    throw new InputError(`context.knownFixingRate must be a finite decimal rate (got ${fixing}).`, {
      code: ErrorCode.InputNotFinite,
      context: { field: 'knownFixingRate', value: fixing },
    });
  }
  return fixing;
}

function floatingRateNote(specification: FloatingRateNoteSpecification): Bond {
  validateClosedRequest(
    'bonds.floatingRateNote',
    specification,
    FRN_SPEC,
    specificationTeaching('bonds.floatingRateNote', ['issueDate', 'maturityDate', 'frequency']),
  );
  const face = faceOf(specification);
  const dayCount = specification.dayCount ?? 'ACT/360';
  const spread = specification.spread ?? 0;
  const baseSpecification: BaseSpecification = { ...specification, dayCount };
  const schedule = buildSchedule(baseSpecification);
  const last = schedule.length - 1;
  const flowsFor = (context: ProjectionContext): CashFlow[] => {
    const curve = context.forecastCurve;
    if (!curve) {
      throw new InputError(
        'flowsFor: A floating-rate note needs context.forecastCurve to project its coupons.',
        {
          code: ErrorCode.InputMissingField,
          context: { kind: 'frn' },
        },
      );
    }
    return schedule.map((p, i) => {
      const accrual = yearFraction(p.accrualStart, p.accrualEnd, dayCount);
      const forward = projectFrnRate(p, curve, dayCount, context);
      const interest = (forward + spread) * face * accrual;
      const principal = i === last ? face : 0;
      return {
        date: p.accrualEnd,
        paymentDate: p.paymentDate,
        interest,
        principal,
        amount: interest + principal,
        notional: face,
      };
    });
  };
  return makeBond('frn', baseSpecification, schedule, flowsFor);
}

export interface AmortizingBondSpecification extends BaseSpecification {
  amortization: Amortization;
}

function amortizing(specification: AmortizingBondSpecification): Bond {
  validateClosedRequest(
    'bonds.amortizing',
    specification,
    AMORTIZING_SPEC,
    specificationTeaching('bonds.amortizing', [
      'issueDate',
      'maturityDate',
      'couponRate',
      'frequency',
    ]),
  );
  const face = faceOf(specification);
  const dayCount = specification.dayCount ?? '30/360';
  const baseSpecification: BaseSpecification = { ...specification, dayCount };
  const schedule = buildSchedule(baseSpecification);
  const n = schedule.length;

  const principalSchedule = (): number[] => {
    const amort = specification.amortization;
    if ('principalByPeriod' in amort) {
      if (amort.principalByPeriod.length !== n) {
        throw new InputError(
          `principalSchedule: principalByPeriod has ${amort.principalByPeriod.length} entries but the schedule has ${n} periods.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { expected: n, got: amort.principalByPeriod.length },
          },
        );
      }
      const total = amort.principalByPeriod.reduce((s, x) => s + x, 0);
      if (Math.abs(total - face) > 1e-6 * face) {
        throw new InputError(
          `principalSchedule: principalByPeriod sums to ${total}, expected the face value ${face}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { total, face },
          },
        );
      }
      return [...amort.principalByPeriod];
    }
    if (amort.type === 'straight') {
      return schedule.map(() => face / n);
    }
    // annuity: solve a level total payment A using each period's actual rate.
    const rates = schedule.map(
      (p) => specification.couponRate * yearFraction(p.accrualStart, p.accrualEnd, dayCount),
    );
    // For equal periods these are all c = couponRate/f; A = face·c/(1−(1+c)^−n). Use period 0's rate.
    const c = rates[0]!;
    let outstanding = face;
    const principals: number[] = [];
    if (c === 0) {
      // No interest ⇒ equal principal.
      return schedule.map(() => face / n);
    }
    const A = (face * c) / (1 - Math.pow(1 + c, -n));
    for (let i = 0; i < n; i++) {
      const interest = outstanding * rates[i]!;
      let principal = A - interest;
      if (i === n - 1) principal = outstanding; // clean up rounding on the final period
      principals.push(principal);
      outstanding -= principal;
    }
    return principals;
  };

  const flowsFor = (): CashFlow[] => {
    const principals = principalSchedule();
    let outstanding = face;
    return schedule.map((p, i) => {
      const accrual = yearFraction(p.accrualStart, p.accrualEnd, dayCount);
      const interest = specification.couponRate * outstanding * accrual;
      const principal = principals[i]!;
      const notional = outstanding;
      outstanding -= principal;
      return {
        date: p.accrualEnd,
        paymentDate: p.paymentDate,
        interest,
        principal,
        amount: interest + principal,
        notional,
      };
    });
  };
  return makeBond('amortizing', baseSpecification, schedule, flowsFor);
}

export interface InflationLinkedBondSpecification extends BaseSpecification {
  /** Reference index level at issuance (the indexation base). */
  baseIndex: number;
  /** Floor the redeemed principal at par against deflation (TIPS-style). Default false. */
  deflationFloor?: boolean;
}

function inflationLinked(specification: InflationLinkedBondSpecification): Bond {
  validateClosedRequest(
    'bonds.inflationLinked',
    specification,
    INFLATION_LINKED_SPEC,
    specificationTeaching('bonds.inflationLinked', [
      'issueDate',
      'maturityDate',
      'couponRate',
      'frequency',
    ]),
  );
  const face = faceOf(specification);
  const dayCount = specification.dayCount ?? 'ACT/ACT';
  const baseSpecification: BaseSpecification = { ...specification, dayCount };
  const schedule = buildSchedule(baseSpecification);
  const last = schedule.length - 1;
  if (!Number.isFinite(specification.baseIndex) || specification.baseIndex <= 0) {
    throw new InputError(
      `inflationLinked: baseIndex must be positive (got ${specification.baseIndex}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'baseIndex', value: specification.baseIndex },
      },
    );
  }
  const flowsFor = (context: ProjectionContext): CashFlow[] => {
    const index = context.referenceIndex;
    if (!index) {
      throw new InputError(
        'flowsFor: An inflation-linked bond needs context.referenceIndex to index its cash flows.',
        {
          code: ErrorCode.InputMissingField,
          context: { kind: 'inflation' },
        },
      );
    }
    return schedule.map((p, i) => {
      const ratio = index(p.accrualEnd) / specification.baseIndex;
      if (!Number.isFinite(ratio) || ratio <= 0) {
        throw new InputError(
          `flowsFor: referenceIndex(${p.accrualEnd}) produced a non-positive index ratio.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { date: p.accrualEnd, ratio },
          },
        );
      }
      const interest =
        specification.couponRate *
        face *
        yearFraction(p.accrualStart, p.accrualEnd, dayCount) *
        ratio;
      let principal = 0;
      if (i === last) {
        const uplifted = face * ratio;
        principal = specification.deflationFloor ? Math.max(uplifted, face) : uplifted;
      }
      return {
        date: p.accrualEnd,
        paymentDate: p.paymentDate,
        interest,
        principal,
        amount: interest + principal,
        notional: face * ratio,
      };
    });
  };
  return makeBond('inflation', baseSpecification, schedule, flowsFor);
}

/** Bond constructors (spec §14.1). */
export const bonds = {
  fixedRate,
  zeroCoupon,
  floatingRateNote,
  amortizing,
  inflationLinked,
};

// ---------------------------------------------------------------------------------------------------
// Pricing & metrics
// ---------------------------------------------------------------------------------------------------

/**
 * Guard the actuarial discount base `1 + y/f`. A yield at or below `−f` (e.g. `y = −2` at annual
 * frequency) drives the base non-positive, which makes `base^(−f·τ)` return NaN or a sign-flipped
 * price (a one-year zero would report `−100`). Reject it rather than emit a bogus number.
 */
function actuarialBase(y: number, f: number, functionName: string): number {
  if (!Number.isFinite(y)) {
    throw new InputError(`${functionName}: yield must be finite, got ${y}.`, {
      code: ErrorCode.InputNotFinite,
      context: { yield: y },
    });
  }
  const base = 1 + y / f;
  if (!(base > 0)) {
    throw new InputError(
      `${functionName}: yield ${y} implies a non-positive actuarial base (1 + y/${f} = ${base}); price is undefined. Yields must satisfy y > −${f}.`,
      { code: ErrorCode.InputOutOfRange, context: { yield: y, frequency: f, base } },
    );
  }
  return base;
}

/**
 * Ceiling on the expanding yield bracket: 1000%. Past this a "yield" is no longer a yield — the
 * price is almost certainly wrong (a typo, the wrong settlement date, or a defaulted bond quoted in
 * points upfront), and reporting a four-digit percentage would dress that up as an answer.
 */
const MAXIMUM_YIELD_BRACKET = 10;

/**
 * Bracket and solve a yield root, EXPANDING the upper bound until the objective changes sign
 * (doubling from 100%, capped at {@link MAXIMUM_YIELD_BRACKET}).
 *
 * The bracket used to be the hard-coded `[−0.99·f, 1]`. Any distressed bond — a 1-year zero at 40
 * yields 150% — has its root outside it, so Brent found no sign change and the caller was told the
 * solve "did not converge": a true statement that named the wrong cause and suggested a numerical
 * flaw rather than a bracket that never contained the answer. Beyond the cap the error now names
 * the interval actually searched.
 */
function solveYieldBracketed(
  objective: (y: number) => number,
  frequency: number,
  functionName: string,
  context: Record<string, unknown>,
): { value: number; iterations: number } {
  // Yield must exceed −f (so 1 + y/f > 0); bracket just above that singularity.
  const lo = -frequency * 0.99;
  let hi = 1.0;
  const fLo = objective(lo);
  let fHi = objective(hi);
  let expansions = 0;
  while (
    Number.isFinite(fLo) &&
    Number.isFinite(fHi) &&
    fLo * fHi > 0 &&
    hi < MAXIMUM_YIELD_BRACKET
  ) {
    hi = Math.min(hi * 2, MAXIMUM_YIELD_BRACKET);
    fHi = objective(hi);
    expansions++;
  }
  const res = brent(objective, lo, hi, { stepTolerance: 1e-12, maximumIterations: 200 });
  if (!res.converged) {
    const asPercent = (y: number): string => `${(y * 100).toFixed(1)}%`;
    throw new ConvergenceError(
      `${functionName}: no yield in the bracket searched — [${asPercent(lo)}, ${asPercent(hi)}] ` +
        `(expanded upward from 100% to at most ${asPercent(MAXIMUM_YIELD_BRACKET)}) — reprices the ` +
        'bond to the target price. A price outside that range is usually a mis-entered price, the ' +
        'wrong settlement date, or a defaulted bond quoted in points upfront rather than on yield.',
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

/** Discount a future cash-flow set at yield `y` (actuarial convention) → dirty price. */
function dirtyFromYield(
  flows: CashFlow[],
  settlementDate: string,
  y: number,
  f: number,
  dayCount: FixedIncomeDayCount,
): number {
  const base = actuarialBase(y, f, 'priceFromYield');
  let pv = 0;
  for (const cf of flows) {
    const tau = yearFraction(settlementDate, cf.date, dayCount);
    pv += cf.amount * Math.pow(base, -f * tau);
  }
  return pv;
}

/**
 * Conventions echoed on every bond pricing/metrics result (spec §7.4 / WS2.2). Bonds discount either
 * actuarially (`(1 + y/f)^(−f·τ)`) or off a curve, so `compounding` and `dayCount` are widened past
 * the core enums; the rest matches the shared `Assumptions` shape.
 */
export type BondAssumptions = Omit<Assumptions, 'dayCount' | 'compounding'> & {
  dayCount: FixedIncomeDayCount;
  /** `actuarial` for yield-based results; `curve` when discounted off a {@link YieldCurve}. */
  compounding: 'actuarial' | 'curve';
  /** Coupon payments per year actually used in discounting. */
  frequency: number;
  /** Settlement date the result was computed as of. */
  settlementDate: string;
  /** Business-day convention baked into the payment schedule. */
  businessDayConvention: BusinessDayConvention;
};

/**
 * The fixed-income twin of core's `plausibilityWarnings`: a coupon rate is a DECIMAL (`0.05` = 5%),
 * so `couponRate: 5` is a 500% coupon. It prices, it solves, and every duration and DV01 downstream
 * is nonsense — with nothing in the output to say so. Informational, never thrown: a 150% coupon is
 * legal in distressed/EM paper, so the threshold is 100% and the verdict is the caller's.
 */
function couponRateWarnings(bond: Bond): QuantWarning[] {
  const couponRate = bond.couponRate;
  if (!Number.isFinite(couponRate) || Math.abs(couponRate) <= 1) return [];
  return [
    warning(
      ErrorCode.InputSuspiciousCouponRate,
      `couponRate=${couponRate} implies a ${(couponRate * 100).toFixed(0)}% coupon — couponRate is a ` +
        `decimal; did you mean ${(couponRate / 100).toFixed(4)}?`,
      'info',
      { couponRate },
    ),
  ];
}

/** Build the conventions echo for a bond result. */
function bondAssumptions(
  bond: Bond,
  settlementDate: string,
  compounding: 'actuarial' | 'curve',
): BondAssumptions {
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: bond.dayCount,
    compounding,
    frequency: bond.frequency,
    settlementDate,
    businessDayConvention: bond.businessDayConvention,
  };
}

/**
 * The {@link Computed} envelope specialised to bond results (dx §2.7): `assumptions` is the widened
 * {@link BondAssumptions} — fixed income needs the `ACT/ACT`/`30E/360` day counts and the
 * `actuarial`/`curve` compounding modes that the core enums do not carry. Structurally this IS the
 * core envelope (`value` + `assumptions.conventionsVersion` + `diagnostics.warnings`), so it
 * satisfies `isComputed` and the WS-7.2 conformance sweep.
 */
export interface BondComputed<T> {
  value: T;
  assumptions: BondAssumptions;
  diagnostics: Diagnostics;
}

/** A bond facade: the plain call plus an `.explain()` companion returning {@link BondComputed}. */
export type BondFacade<Args extends unknown[], Out, EOut = Out> = ((
  ...callArguments: Args
) => Out) & {
  explain: (...callArguments: Args) => BondComputed<EOut>;
};

/**
 * Build a bond facade on core `seriesFacade` (label first, shared first-argument guard). The only
 * departure from the stock helper is the envelope's assumptions type: {@link BondAssumptions}
 * widens `dayCount`/`compounding` past the core enums, which `Computed<T, Extra>` cannot express as
 * an `Extra` intersection — the runtime shape is exactly the core envelope, so the casts below are
 * type-level only.
 */
/**
 * The bond analytics facades take a Bond INSTANCE (from `bonds.fixedRate(...)` et al.), not a raw
 * spec object — a plain `{ couponRate, … }` would crash on the first method call, so it teaches.
 */
function requireBondInstance(bond: unknown, functionName: string): void {
  const b = bond as { futureCashflows?: unknown; accrued?: unknown };
  if (typeof b.futureCashflows !== 'function' || typeof b.accrued !== 'function') {
    throw new InputError(
      `${functionName}: expected a bond built by bonds.fixedRate(...) / bonds.zeroCoupon(...) (a Bond instance with cash-flow methods), not a raw specification object. Build the bond first, then pass it here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'bond' } },
    );
  }
  // Bonds are structurally typed artifacts. Validate the methods we consume while allowing
  // provenance, identifiers, and downstream risk metadata to decorate the object.
}

/**
 * Curve parameters take a curve INSTANCE (from `curves.fromZeroRates(...)`, `curves.bootstrap(...)`),
 * not a raw pillar list — teach the fix instead of crashing on the first method call.
 */
function requireCurveInstance(curve: unknown, functionName: string): void {
  const c = curve as { discount?: unknown; shift?: unknown; pillars?: unknown };
  if (
    typeof c.discount !== 'function' ||
    typeof c.shift !== 'function' ||
    !Array.isArray(c.pillars)
  ) {
    throw new InputError(
      `${functionName}: expected a curve built by curves.fromZeroRates(...) / curves.bootstrap(...) (a Curve instance with discount()/shift()), not a raw object. Build the curve first, then pass it here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'curve' } },
    );
  }
}

function bondFacade<Args extends unknown[], Out>(
  label: string,
  call: (...callArguments: Args) => Out,
  explain: (...callArguments: Args) => BondComputed<Out>,
): BondFacade<Args, Out> {
  return seriesFacade(
    label,
    call,
    explain as unknown as (...callArguments: Args) => Computed<Out>,
  ) as unknown as BondFacade<Args, Out>;
}

export interface PriceFromYieldOptions {
  settlementDate: string;
  /** Annualized yield (decimal). */
  yield: number;
  context?: ProjectionContext;
}

/** {@link PriceFromYieldOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const PRICE_FROM_YIELD_OPTIONS_KEYS = ['settlementDate', 'yield', 'context'] as const;

export interface BondPrice {
  dirtyPrice: number;
  cleanPrice: number;
  accruedInterest: number;
  assumptions: BondAssumptions;
  diagnostics: Diagnostics;
}

function priceFromYieldValue(bond: Bond, options: PriceFromYieldOptions): BondPrice {
  requireArgumentObject('priceFromYield', 'options', options);
  ensureKnownKeys('priceFromYield', 'options', options, PRICE_FROM_YIELD_OPTIONS_KEYS);
  requireAnalyticsOptionLadders('priceFromYield', options as unknown as Record<string, unknown>);
  requireArgumentObject('priceFromYield', 'bond', bond);
  requireBondInstance(bond, 'priceFromYield');
  const flows = bond.futureCashflows(options.settlementDate, options.context);
  const dirty = dirtyFromYield(
    flows,
    options.settlementDate,
    options.yield,
    bond.frequency,
    bond.dayCount,
  );
  const accruedInterest = bond.accrued(options.settlementDate, options.context);
  return {
    dirtyPrice: dirty,
    cleanPrice: dirty - accruedInterest,
    accruedInterest,
    assumptions: bondAssumptions(bond, options.settlementDate, 'actuarial'),
    diagnostics: { method: 'closed-form', warnings: couponRateWarnings(bond) },
  };
}

/**
 * Dirty/clean price and accrued interest for a bond at a given yield. Facade (dx §2.7): the plain
 * call returns the rich {@link BondPrice}; `.explain()` wraps the same result in the core envelope
 * with the conventions echoed at the top level.
 */
export const priceFromYield = bondFacade(
  'priceFromYield',
  priceFromYieldValue,
  (bond: Bond, options: PriceFromYieldOptions): BondComputed<BondPrice> => {
    const price = priceFromYieldValue(bond, options);
    return { value: price, assumptions: price.assumptions, diagnostics: price.diagnostics };
  },
);

export interface YieldFromPriceOptions {
  settlementDate: string;
  /** Either a clean price (default) or a dirty price — set `priceType`. */
  price: number;
  priceType?: 'clean' | 'dirty';
  context?: ProjectionContext;
}

/** {@link YieldFromPriceOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const YIELD_FROM_PRICE_OPTIONS_KEYS = ['settlementDate', 'price', 'priceType', 'context'] as const;

/**
 * Shared analytics-option ladders: `context: null` used to reach `bond.cashflows(null)` and the
 * settlementDate string flowed unchecked into date arithmetic.
 */
function requireAnalyticsOptionLadders(
  functionName: string,
  options: Record<string, unknown>,
): void {
  const context = options['context'];
  if (context !== undefined && (context === null || typeof context !== 'object')) {
    throw new InputError(
      `${functionName}: context must be a projection-context object when provided. Received ${context === null ? 'null' : typeof context}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'context' } },
    );
  }
  const settlementDate = options['settlementDate'];
  if (
    settlementDate !== undefined &&
    (typeof settlementDate !== 'string' || settlementDate.length === 0)
  ) {
    throw new InputError(
      `${functionName}: settlementDate must be an ISO date string when provided. Received ${settlementDate === null ? 'null' : typeof settlementDate}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'settlementDate' } },
    );
  }
  // The context MEMBERS the projection consumes (C05: validate consumed fields, teach each type).
  if (context !== undefined) {
    const projection = context as Record<string, unknown>;
    const forecastCurve = projection['forecastCurve'];
    if (
      forecastCurve !== undefined &&
      (forecastCurve === null || typeof forecastCurve !== 'object')
    ) {
      throw new InputError(
        `${functionName}: context.forecastCurve must be a yield-curve object when provided. Received ${forecastCurve === null ? 'null' : typeof forecastCurve}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'context.forecastCurve' } },
      );
    }
    const referenceIndex = projection['referenceIndex'];
    if (referenceIndex !== undefined && typeof referenceIndex !== 'function') {
      throw new InputError(
        `${functionName}: context.referenceIndex must be a function (date => index level) when provided. Received ${referenceIndex === null ? 'null' : typeof referenceIndex}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'context.referenceIndex' } },
      );
    }
    const knownFixingRate = projection['knownFixingRate'];
    if (
      knownFixingRate !== undefined &&
      (typeof knownFixingRate !== 'number' || !Number.isFinite(knownFixingRate))
    ) {
      throw new InputError(
        `${functionName}: context.knownFixingRate must be a finite decimal rate when provided. Received ${knownFixingRate === null ? 'null' : typeof knownFixingRate}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'context.knownFixingRate' } },
      );
    }
  }
}

/** Pre-coalesce enum ladder: `priceType: null` must never silently quote clean. */
function resolvePriceType(value: unknown): 'clean' | 'dirty' {
  if (value === undefined) return 'clean';
  if (value !== 'clean' && value !== 'dirty') {
    throw new InputError(
      `resolvePriceType: priceType must be 'clean' | 'dirty' when provided — omit the field for a clean quote. Received ${value === null ? 'null' : JSON.stringify(value)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'priceType', received: value } },
    );
  }
  return value;
}

/** Root-find the YTM; returns the solver facts so the explain path can disclose them honestly. */
function solveYieldToMaturity(
  bond: Bond,
  options: YieldFromPriceOptions,
): { value: number; iterations: number } {
  requireArgumentObject('yieldToMaturity', 'options', options);
  ensureKnownKeys('yieldToMaturity', 'options', options, YIELD_FROM_PRICE_OPTIONS_KEYS);
  requireAnalyticsOptionLadders('yieldToMaturity', options as unknown as Record<string, unknown>);
  // `price` is declared REQUIRED: a null price used to root-find against NaN and report
  // non-convergence instead of teaching the missing field.
  requireFiniteFields('yieldToMaturity', options as unknown as Record<string, unknown>, ['price'], {
    exampleCall: "yieldToMaturity(bond, { price: 98.5, settlementDate: '2026-06-15' })",
  });
  requireArgumentObject('yieldToMaturity', 'bond', bond);
  requireBondInstance(bond, 'yieldToMaturity');
  const flows = bond.futureCashflows(options.settlementDate, options.context);
  if (flows.length === 0) {
    throw new InputError(
      'solveYieldToMaturity: No cash flows after the settlement date — cannot solve a yield.',
      {
        code: ErrorCode.InputOutOfRange,
        context: { settlementDate: options.settlementDate },
      },
    );
  }
  const accruedInterest = bond.accrued(options.settlementDate, options.context);
  const targetDirty =
    resolvePriceType(options.priceType) === 'dirty'
      ? options.price
      : options.price + accruedInterest;
  const f = bond.frequency;
  const objective = (y: number): number =>
    dirtyFromYield(flows, options.settlementDate, y, f, bond.dayCount) - targetDirty;
  return solveYieldBracketed(objective, f, 'yieldToMaturity', {
    targetPrice: options.price,
    settlementDate: options.settlementDate,
  });
}

/**
 * Solve the yield to maturity that reprices a bond to the observed price (Brent on [−0.99·f, 1]).
 * Facade (dx §2.7): the plain call returns the bare yield; `.explain()` returns the core envelope
 * echoing the bond's conventions plus honest solver diagnostics (this is a root-find, so
 * `converged`/`iterations` are disclosed — a non-converged solve throws rather than returning).
 */
export const yieldToMaturity = bondFacade(
  'yieldToMaturity',
  (bond: Bond, options: YieldFromPriceOptions): number => solveYieldToMaturity(bond, options).value,
  (bond: Bond, options: YieldFromPriceOptions): BondComputed<number> => {
    const res = solveYieldToMaturity(bond, options);
    return {
      value: res.value,
      assumptions: bondAssumptions(bond, options.settlementDate, 'actuarial'),
      diagnostics: {
        method: 'brent',
        converged: true,
        iterations: res.iterations,
        warnings: couponRateWarnings(bond),
      },
    };
  },
);

export interface YieldMetrics {
  yield: number;
  dirtyPrice: number;
  cleanPrice: number;
  accruedInterest: number;
  macaulayDuration: number;
  modifiedDuration: number;
  convexity: number;
  /** Dollar value of a 1bp yield increase (per the bond's face value). */
  dv01: number;
  /** Price value of a 1bp move (synonym for DV01 here, per face). */
  pv01: number;
  assumptions: BondAssumptions;
  diagnostics: Diagnostics;
}

/** Input for {@link yieldMetrics}. */
export interface YieldMetricsOptions {
  settlementDate: string;
  yield: number;
  context?: ProjectionContext;
}

/** {@link YieldMetricsOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const YIELD_METRICS_OPTIONS_KEYS = ['settlementDate', 'yield', 'context'] as const;

function yieldMetricsValue(bond: Bond, options: YieldMetricsOptions): YieldMetrics {
  requireArgumentObject('yieldMetrics', 'options', options);
  ensureKnownKeys('yieldMetrics', 'options', options, YIELD_METRICS_OPTIONS_KEYS);
  requireAnalyticsOptionLadders('yieldMetrics', options as unknown as Record<string, unknown>);
  requireArgumentObject('yieldMetrics', 'bond', bond);
  requireBondInstance(bond, 'yieldMetrics');
  const flows = bond.futureCashflows(options.settlementDate, options.context);
  const f = bond.frequency;
  const y = options.yield;
  const base = actuarialBase(y, f, 'yieldMetrics');
  let pv = 0;
  let dur = 0; // Σ τ·PV
  let cvx = 0; // Σ τ(τ+1/f)·PV
  for (const cf of flows) {
    const tau = yearFraction(options.settlementDate, cf.date, bond.dayCount);
    const pvk = cf.amount * Math.pow(base, -f * tau);
    pv += pvk;
    dur += tau * pvk;
    cvx += tau * (tau + 1 / f) * pvk;
  }
  const macaulay = pv === 0 ? 0 : dur / pv;
  const modified = macaulay / base;
  const convexity = pv === 0 ? 0 : cvx / (pv * base * base);
  const accruedInterest = bond.accrued(options.settlementDate, options.context);
  const dv01 = modified * pv * 1e-4;
  return {
    yield: y,
    dirtyPrice: pv,
    cleanPrice: pv - accruedInterest,
    accruedInterest,
    macaulayDuration: macaulay,
    modifiedDuration: modified,
    convexity,
    dv01,
    pv01: dv01,
    assumptions: bondAssumptions(bond, options.settlementDate, 'actuarial'),
    diagnostics: { method: 'closed-form', warnings: couponRateWarnings(bond) },
  };
}

/**
 * Full set of yield-based risk metrics at a given yield (actuarial convention). Duration and
 * convexity are the closed-form analytic sensitivities of the dirty price to a parallel yield move.
 * Facade (dx §2.7): the plain call returns the rich {@link YieldMetrics}; `.explain()` wraps the
 * same result in the core envelope with the conventions echoed at the top level.
 */
export const yieldMetrics = bondFacade(
  'yieldMetrics',
  yieldMetricsValue,
  (bond: Bond, options: YieldMetricsOptions): BondComputed<YieldMetrics> => {
    const metrics = yieldMetricsValue(bond, options);
    return { value: metrics, assumptions: metrics.assumptions, diagnostics: metrics.diagnostics };
  },
);

// ---- curve-based pricing & effective/key-rate risk ----

/** Dirty price discounting each cash flow on `curve` from the settlement date (single-curve). */
function dirtyFromCurve(
  bond: Bond,
  curve: YieldCurve,
  settlementDate: string,
  context: ProjectionContext,
): number {
  // Single-curve effective risk: floating coupons project off the (possibly shocked) curve itself, so
  // a curve bump moves coupons and discounting together — that is what gives an FRN ~zero duration.
  const projectionCtx: ProjectionContext =
    bond.kind === 'frn' ? { ...context, forecastCurve: curve } : context;
  const flows = bond.futureCashflows(settlementDate, projectionCtx);
  const dfSettle = curve.discount(settlementDate);
  let pv = 0;
  for (const cf of flows) {
    pv += cf.amount * (curve.discount(cf.paymentDate) / dfSettle);
  }
  return pv;
}

export interface CurvePricingOptions {
  settlementDate: string;
  context?: ProjectionContext;
  /** Yield bump for the finite-difference effective measures (default 1bp). */
  bump?: number;
}

/** {@link CurvePricingOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const CURVE_PRICING_OPTIONS_KEYS = ['settlementDate', 'context', 'bump'] as const;

export interface CurveMetrics {
  dirtyPrice: number;
  cleanPrice: number;
  accruedInterest: number;
  /** Effective duration from a parallel curve shock. */
  effectiveDuration: number;
  /** Effective convexity from a parallel curve shock. */
  effectiveConvexity: number;
  /** Dollar value of a 1bp parallel curve shift (per face). */
  dv01: number;
  /** Per-pillar key-rate durations, aligned to the curve's pillars. */
  keyRateDurations: { tenorYears: number; date: string; duration: number }[];
  assumptions: BondAssumptions;
  diagnostics: Diagnostics;
}

function curveMetricsValue(
  bond: Bond,
  curve: YieldCurve,
  options: CurvePricingOptions,
): CurveMetrics {
  requireArgumentObject('curveMetrics', 'curve', curve);
  requireCurveInstance(curve, 'curveMetrics');
  requireArgumentObject('curveMetrics', 'options', options);
  ensureKnownKeys('curveMetrics', 'options', options, CURVE_PRICING_OPTIONS_KEYS);
  requireAnalyticsOptionLadders('curveMetrics', options as unknown as Record<string, unknown>);
  requireArgumentObject('curveMetrics', 'bond', bond);
  requireBondInstance(bond, 'curveMetrics');
  if (
    options.context !== undefined &&
    (options.context === null || typeof options.context !== 'object')
  ) {
    throw new InputError(
      `curveMetrics: context must be a projection-context object when provided. Received ${options.context === null ? 'null' : typeof options.context}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'context' } },
    );
  }
  if (
    options.bump !== undefined &&
    (typeof options.bump !== 'number' || !Number.isFinite(options.bump))
  ) {
    throw new InputError(
      `curveMetrics: bump must be a finite rate shift when provided (1e-4 = one basis point). Received ${options.bump === null ? 'null' : typeof options.bump}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'bump' } },
    );
  }
  const context = options.context ?? {};
  const bump = options.bump ?? 1e-4;
  const settle = options.settlementDate;
  const p0 = dirtyFromCurve(bond, curve, settle, context);
  const pUp = dirtyFromCurve(bond, curve.shift(bump), settle, context);
  const pDn = dirtyFromCurve(bond, curve.shift(-bump), settle, context);
  const effectiveDuration = p0 === 0 ? 0 : (pDn - pUp) / (2 * p0 * bump);
  const effectiveConvexity = p0 === 0 ? 0 : (pUp + pDn - 2 * p0) / (p0 * bump * bump);
  const dv01 = effectiveDuration * p0 * 1e-4;
  const keyRateDurations = curve.pillars.map((pillar, i) => {
    const up = dirtyFromCurve(bond, curve.bumpPillar(i, bump), settle, context);
    const dn = dirtyFromCurve(bond, curve.bumpPillar(i, -bump), settle, context);
    return {
      tenorYears: pillar.tenorYears,
      date: pillar.date,
      duration: p0 === 0 ? 0 : (dn - up) / (2 * p0 * bump),
    };
  });
  const accruedInterest = bond.accrued(settle, context);
  return {
    dirtyPrice: p0,
    cleanPrice: p0 - accruedInterest,
    accruedInterest,
    effectiveDuration,
    effectiveConvexity,
    dv01,
    keyRateDurations,
    assumptions: bondAssumptions(bond, settle, 'curve'),
    diagnostics: { method: 'finite-difference', warnings: couponRateWarnings(bond) },
  };
}

/**
 * Price a bond against a discount curve and report effective/key-rate risk from curve shocks.
 * Facade (dx §2.7): the plain call returns the rich {@link CurveMetrics}; `.explain()` wraps the
 * same result in the core envelope with the conventions echoed at the top level.
 */
export const curveMetrics = bondFacade(
  'curveMetrics',
  curveMetricsValue,
  (bond: Bond, curve: YieldCurve, options: CurvePricingOptions): BondComputed<CurveMetrics> => {
    const metrics = curveMetricsValue(bond, curve, options);
    return { value: metrics, assumptions: metrics.assumptions, diagnostics: metrics.diagnostics };
  },
);

/** The options shape `priceMultiCurve` accepts (Law 12 — mirrors the parameter type; keep in sync). */
const MULTI_CURVE_PRICING_OPTIONS_KEYS = [
  'settlementDate',
  'discountCurve',
  'forecastCurve',
  'knownFixingRate',
] as const;

/**
 * Price a bond with separate discount and forecast curves (multi-curve framework, no shock).
 *
 * `knownFixingRate` is the FRN in-progress coupon's observed reset — see
 * {@link ProjectionContext.knownFixingRate}. It is surfaced here because this is the multi-curve
 * pricing front door: without it, an FRN settled between two coupon dates could not be priced
 * through the function most callers reach for.
 */
export function priceMultiCurve(
  bond: Bond,
  options: {
    settlementDate: string;
    discountCurve: YieldCurve;
    forecastCurve?: YieldCurve;
    knownFixingRate?: number;
  },
): BondPrice {
  // The bond is an OPEN structural artifact (manifest policy, C05): consumed fields run their
  // ladders, decoration is preserved. The options request stays closed.
  validateClosedRequest('priceMultiCurve', bond, PRICE_MULTI_CURVE_BOND_SPEC, {
    argumentName: 'bond',
    open: true,
    exampleCall: ANALYTICS_EXAMPLE,
  });
  validateClosedRequest('priceMultiCurve', options, PRICE_MULTI_CURVE_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: ANALYTICS_EXAMPLE,
  });
  requireArgumentObject('priceMultiCurve', 'options', options);
  ensureKnownKeys('priceMultiCurve', 'options', options, MULTI_CURVE_PRICING_OPTIONS_KEYS);
  requireArgumentObject('priceMultiCurve', 'bond', bond);
  requireBondInstance(bond, 'priceMultiCurve');
  // A missing/raw discountCurve would die on the first discount() call — teach at the boundary.
  requireArgumentObject('priceMultiCurve', 'options.discountCurve', options.discountCurve);
  requireCurveInstance(options.discountCurve, 'priceMultiCurve');
  if (options.forecastCurve !== undefined) {
    requireCurveInstance(options.forecastCurve, 'priceMultiCurve');
  }
  const context: ProjectionContext = {
    ...(options.forecastCurve ? { forecastCurve: options.forecastCurve } : {}),
    ...(options.knownFixingRate !== undefined ? { knownFixingRate: options.knownFixingRate } : {}),
  };
  const flows = bond.futureCashflows(options.settlementDate, context);
  const dfSettle = options.discountCurve.discount(options.settlementDate);
  let pv = 0;
  for (const cf of flows) {
    pv += cf.amount * (options.discountCurve.discount(cf.paymentDate) / dfSettle);
  }
  const accruedInterest = bond.accrued(options.settlementDate, context);
  return {
    dirtyPrice: pv,
    cleanPrice: pv - accruedInterest,
    accruedInterest,
    assumptions: bondAssumptions(bond, options.settlementDate, 'curve'),
    diagnostics: { method: 'closed-form', warnings: couponRateWarnings(bond) },
  };
}

// ---- yield to call ----

export interface CallFeature {
  /** First/earliest call date. */
  callDate: string;
  /**
   * Call (redemption) price. Default: the OUTSTANDING notional at the call date, derived from the
   * bond's cash-flow schedule — the face value for a bullet bond, the un-amortized balance for an
   * amortizing bond. Pass explicitly for premium calls (e.g. 102) or when the outstanding balance
   * is not derivable from the schedule.
   */
  callPrice?: number;
}

/**
 * Yield to call: the yield that reprices the bond to the observed price assuming it is redeemed at the
 * call date for the call price. Builds a synthetic bond truncated at the call date: scheduled coupons
 * AND amortization payments before the call date are received as contracted; at the call date the
 * issuer repays the call price in place of any scheduled principal.
 */
interface YieldToCallSolved {
  value: number;
  iterations: number;
  /** The redemption actually used at the call date (explicit `callPrice`, or the outstanding notional). */
  resolvedCallPrice: number;
  accruedInterest: number;
  priceType: 'clean' | 'dirty';
}

function solveYieldToCall(
  functionName: string,
  bond: Bond,
  call: CallFeature,
  options: YieldFromPriceOptions,
): YieldToCallSolved {
  validateClosedRequest(functionName, bond, YIELD_TO_CALL_BOND_SPEC, {
    argumentName: 'bond',
    open: true,
    exampleCall: ANALYTICS_EXAMPLE,
  });
  validateClosedRequest(functionName, call, YIELD_TO_CALL_CALL_SPEC, {
    argumentName: 'call',
    exampleCall: ANALYTICS_EXAMPLE,
  });
  validateClosedRequest(functionName, options, YIELD_TO_CALL_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: ANALYTICS_EXAMPLE,
  });
  requireBondInstance(bond, functionName);
  const context = options.context ?? {};
  const future = bond.futureCashflows(options.settlementDate, context);
  // Every scheduled flow up to (and including) the call date is received as-is — zeroing pre-call
  // principal would silently misprice amortizing callables (their principal comes back early).
  const flows = future
    .filter((cf) => compareDates(cf.date, call.callDate) <= 0)
    .map((cf) => ({ ...cf }));
  let resolvedCallPrice: number;
  const callFlow = flows.find((cf) => cf.date === call.callDate);
  if (callFlow) {
    // Redemption replaces the scheduled principal at the call date: the issuer repays the WHOLE
    // balance outstanding over that period (`notional`) — the face value for a bullet bond.
    const callPrice = call.callPrice ?? callFlow.notional;
    resolvedCallPrice = callPrice;
    callFlow.principal = callPrice;
    callFlow.amount = callFlow.interest + callPrice;
  } else {
    // Call between coupon dates: the outstanding balance is the notional accruing over the period
    // containing the call date — the next scheduled flow's notional.
    const next = future.find((cf) => compareDates(cf.date, call.callDate) > 0);
    const callPrice = call.callPrice ?? next?.notional;
    if (callPrice === undefined) {
      throw new InputError(
        `${functionName}: cannot derive the outstanding notional at the call date ${call.callDate} ` +
          '(no scheduled cash flow on or after it) — pass an explicit call.callPrice.\n' +
          "  e.g. yieldToCall(bond, { callDate: '2031-01-01', callPrice: 100 }, options)",
        { code: ErrorCode.InputMissingField, context: { callDate: call.callDate } },
      );
    }
    // A mid-period call still pays the coupon ACCRUED since the last coupon date — the issuer
    // cannot redeem and keep the interest the holder has already earned. Omitting it silently
    // understated every mid-period YTC (a 6% par bond called a month after a coupon solved to 0%:
    // pay 100, receive 100, earn nothing). `bond.accrued` is the same partial-period computation
    // the settlement accrued uses, so the day count and the projected coupon match by construction.
    resolvedCallPrice = callPrice;
    const accruedAtCall = bond.accrued(call.callDate, context);
    flows.push({
      date: call.callDate,
      paymentDate: call.callDate,
      interest: accruedAtCall,
      principal: callPrice,
      amount: callPrice + accruedAtCall,
      notional: next?.notional ?? callPrice,
    });
  }
  if (flows.length === 0) {
    throw new InputError(
      `${functionName}: No cash flows up to the call date — cannot solve yield to call.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { callDate: call.callDate },
      },
    );
  }
  const accruedInterest = bond.accrued(options.settlementDate, context);
  const targetDirty =
    resolvePriceType(options.priceType) === 'dirty'
      ? options.price
      : options.price + accruedInterest;
  const f = bond.frequency;
  const objective = (y: number): number =>
    dirtyFromYield(flows, options.settlementDate, y, f, bond.dayCount) - targetDirty;
  const solved = solveYieldBracketed(objective, f, functionName, {
    targetPrice: options.price,
    callDate: call.callDate,
    settlementDate: options.settlementDate,
  });
  return {
    value: solved.value,
    iterations: solved.iterations,
    resolvedCallPrice,
    accruedInterest,
    priceType: resolvePriceType(options.priceType),
  };
}

/** {@link yieldToCall}.explain assumptions: the bond conventions plus the call/price basis echo. */
export type YieldToCallAssumptions = BondAssumptions & {
  callDate: string;
  /** Whether `options.price` was read as a clean or dirty price. */
  priceType: 'clean' | 'dirty';
};

export type YieldToCallFacade = ((
  bond: Bond,
  call: CallFeature,
  options: YieldFromPriceOptions,
) => number) & {
  explain: (
    bond: Bond,
    call: CallFeature,
    options: YieldFromPriceOptions,
  ) => Omit<Computed<number>, 'assumptions'> & { assumptions: YieldToCallAssumptions };
};

/**
 * Yield to a call date (H05): the plain call returns the scalar; `.explain()` mirrors
 * `yieldToMaturity.explain()` — solver facts in diagnostics, the resolved call price and
 * settlement accrued in the decomposition, and the call/price basis echoed in assumptions.
 */
export const yieldToCall = bondFacade(
  'yieldToCall',
  (bond: Bond, call: CallFeature, options: YieldFromPriceOptions): number =>
    solveYieldToCall('yieldToCall', bond, call, options).value,
  ((bond: Bond, call: CallFeature, options: YieldFromPriceOptions) => {
    const solved = solveYieldToCall('yieldToCall.explain', bond, call, options);
    return {
      value: solved.value,
      assumptions: {
        ...bondAssumptions(bond, options.settlementDate, 'actuarial'),
        callDate: call.callDate,
        priceType: solved.priceType,
      },
      diagnostics: {
        method: 'brent',
        converged: true,
        iterations: solved.iterations,
        decomposition: {
          resolvedCallPrice: solved.resolvedCallPrice,
          accruedInterest: solved.accruedInterest,
        },
        warnings: couponRateWarnings(bond),
      },
    };
  }) as unknown as (
    bond: Bond,
    call: CallFeature,
    options: YieldFromPriceOptions,
  ) => BondComputed<number>,
) as unknown as YieldToCallFacade;
