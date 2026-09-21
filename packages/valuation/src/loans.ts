/**
 * FC1 — annuities, loans, and amortization schedules.
 *
 * Required semantics (spec, frozen): payment timing is EXPLICIT (`'end'` or `'beginning'` of
 * period); balloon/residual value is explicit; schedule rows expose opening balance, payment,
 * interest, principal, fees when supplied, and closing balance; the unrounded schedule reconciles
 * exactly within tolerance and any rounding policy is explicit; payment components are SIGNED.
 *
 * Sign convention (the 2026-08-23 review resolution): for a nonnegative periodic rate every
 * component is a positive magnitude, exactly as before. A NEGATIVE periodic rate is economically
 * real (the accepted domain is rate > −100%) and produces a NEGATIVE interest component — the
 * borrower is credited interest — with a principal component EXCEEDING the payment, so the
 * reconciliation identities (`payment = interest + principal`, `closing = opening − principal`)
 * hold with signs intact. The docs used to promise unconditional positivity while the code
 * returned signed components; the components are the honest quantity, so the docs now say signed.
 */

import {
  ConvergenceError,
  ErrorCode,
  InputError,
  assertFiniteValue,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
  requireRepresentableResult,
} from '@totalfinance/core';

/** When within each period the payment falls. REQUIRED — timing changes every number. */
export type PaymentTiming = 'end' | 'beginning';

/**
 * The most periods any loan head accepts (2026-08-23 review, P0 "unbounded work"): 100,000 is
 * monthly for 8,333 years — generous for any real loan — while the old `Number.isInteger` gate
 * admitted values like 1e308 (`Number.isInteger(1e308)` is `true`), and the schedule heads
 * materialize one row per period, so an absurd count is a request for effectively infinite
 * synchronous work (above 2^53, `period++` stops changing and the loop cannot even terminate).
 * The derived period coordinates (`period`, `fromPeriod`, `toPeriod`) are bounded by
 * `numberOfPeriods`, so this one cap bounds every loan loop. (Module-private: the teaching errors
 * state the bound, and a new runtime export would widen the public surface for a limit.)
 */
const MAX_LOAN_PERIODS = 100_000;

/** The shared loan coordinates every head below validates the same way. */
export interface LoanTermsInput {
  /** Amount borrowed (positive). */
  principal: number;
  /** Per-period interest rate (decimal) — callers convert annual rates explicitly. */
  periodicInterestRate: number;
  numberOfPeriods: number;
  /** REQUIRED: `'end'` (ordinary annuity) or `'beginning'` (annuity due). */
  paymentTiming: PaymentTiming;
  /** Residual balance due at the end (explicit; default 0 means fully amortizing). */
  balloon?: number;
}

const LOAN_KEYS = [
  'principal',
  'periodicInterestRate',
  'numberOfPeriods',
  'paymentTiming',
  'balloon',
] as const;

const LOAN_TERMS_EXAMPLE =
  "principal: 250_000, periodicInterestRate: 0.06 / 12, numberOfPeriods: 360, paymentTiming: 'end'";

/**
 * A WORKING example for whichever head reached the shared terms validator. The teaching names the
 * REPORTED function, so the example must be pasteable for that function — the period/range heads
 * require fields the bare terms example would omit.
 */
function loanExampleCall(functionName: string): string {
  switch (functionName) {
    case 'loanInterestPayment':
    case 'loanPrincipalPayment':
      return `${functionName}({ ${LOAN_TERMS_EXAMPLE}, period: 12 })`;
    case 'cumulativeLoanInterest':
    case 'cumulativeLoanPrincipal':
      return `${functionName}({ ${LOAN_TERMS_EXAMPLE}, fromPeriod: 1, toPeriod: 12 })`;
    default:
      return `${functionName}({ ${LOAN_TERMS_EXAMPLE} })`;
  }
}

function validateLoanTerms(functionName: string, input: LoanTermsInput): { balloon: number } {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, LOAN_KEYS);
  requireFiniteFields(
    functionName,
    input,
    ['principal', 'periodicInterestRate', 'numberOfPeriods'],
    { exampleCall: () => loanExampleCall(functionName) },
  );
  if (input.paymentTiming !== 'end' && input.paymentTiming !== 'beginning') {
    throw new InputError(
      `${functionName}: paymentTiming must be 'end' | 'beginning' — timing changes every number, so it is never guessed. Received ${input.paymentTiming === null ? 'null' : JSON.stringify(input.paymentTiming)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'paymentTiming' } },
    );
  }
  if (input.principal <= 0) {
    throw new InputError(
      `${functionName}: principal must be > 0 (the amount borrowed). Received ${input.principal}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'principal' } },
    );
  }
  // Safe integer AND a work cap (2026-08-23 review, P0): `Number.isInteger(1e308)` is `true`, so
  // the old check let a caller request one schedule row per "period" of an astronomically large
  // count — effectively infinite synchronous work, and literally non-terminating above 2^53.
  if (
    !Number.isSafeInteger(input.numberOfPeriods) ||
    input.numberOfPeriods < 1 ||
    input.numberOfPeriods > MAX_LOAN_PERIODS
  ) {
    throw new InputError(
      `${functionName}: numberOfPeriods must be an integer in [1, ${MAX_LOAN_PERIODS.toLocaleString('en-US')}] — the schedule materializes one row per period, and ${MAX_LOAN_PERIODS.toLocaleString('en-US')} periods is monthly for ${(MAX_LOAN_PERIODS / 12).toLocaleString('en-US', { maximumFractionDigits: 0 })} years, beyond any real loan. Received ${input.numberOfPeriods}.\n  e.g. ${loanExampleCall(functionName)}`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'numberOfPeriods' } },
    );
  }
  if (input.periodicInterestRate <= -1) {
    throw new InputError(
      `${functionName}: periodicInterestRate must exceed −100% per period. Received ${input.periodicInterestRate}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'periodicInterestRate' } },
    );
  }
  const balloon = input.balloon ?? 0;
  if (input.balloon !== undefined) {
    if (typeof input.balloon !== 'number' || !Number.isFinite(input.balloon)) {
      throw new InputError(
        `${functionName}: balloon must be a finite number when provided (the explicit residual balance). Received ${input.balloon === null ? 'null' : typeof input.balloon}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'balloon' } },
      );
    }
    if (input.balloon < 0 || input.balloon >= input.principal) {
      throw new InputError(
        `${functionName}: balloon must satisfy 0 ≤ balloon < principal. Received ${input.balloon}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'balloon' } },
      );
    }
  }
  return { balloon };
}

/** The timing factor: an annuity-due payment is worth one extra period of interest. */
function timingFactor(rate: number, timing: PaymentTiming): number {
  return timing === 'beginning' ? 1 + rate : 1;
}

/**
 * The RAW closed-form level payment, computed overflow-stably (2026-08-23 review, finding 1). The
 * naive form `(principal · growth − balloon) / (annuity · timingFactor)` overflows its NUMERATOR
 * at a principal near `Number.MAX_VALUE` even when the payment itself is representable, and turns
 * a huge candidate rate into Infinity / Infinity = NaN inside the rate solver. Three regimes, all
 * algebraically identical:
 *
 *   1. `growth` rounds to exactly 1 (a denormal-scale rate): the annuity quotient degenerates to
 *      0/rate = 0, so the rate-0 limit `(principal − balloon) / (periods · timingFactor)` is the
 *      stable value the closed form is approaching;
 *   2. the ordinary regime: divide the numerator THROUGH by the annuity factor first —
 *      `principal · (growth / annuityTiming) − balloon / annuityTiming` — so a near-MAX_VALUE
 *      principal only overflows when the true payment does;
 *   3. `annuityTiming` overflows (huge growth over a small rate, or growth itself infinite):
 *      divide the closed form through by `growth` — `1/growth` underflows to 0 exactly where the
 *      balloon term vanishes, and the payment tends to `principal · rate / timingFactor`.
 *
 * May return a NON-FINITE value (an honest signed limit, e.g. rate → −1 under 'beginning' timing
 * where the whole payment falls at a vanishing timing factor): the PUBLIC head refuses that with a
 * typed teaching via {@link requireRepresentableResult}; the rate solver's bracket expansion
 * consumes it as an ordinary objective value.
 */
function levelPaymentValue(
  principal: number,
  rate: number,
  periods: number,
  timing: PaymentTiming,
  balloon: number,
): number {
  if (rate === 0) {
    return (principal - balloon) / periods;
  }
  const growth = Math.pow(1 + rate, periods);
  if (growth === 1) {
    return (principal - balloon) / (periods * timingFactor(rate, timing));
  }
  const annuityTiming = ((growth - 1) / rate) * timingFactor(rate, timing);
  if (Number.isFinite(growth) && Number.isFinite(annuityTiming) && annuityTiming !== 0) {
    return principal * (growth / annuityTiming) - balloon / annuityTiming;
  }
  const inverseGrowth = Number.isFinite(growth) ? 1 / growth : 0;
  const ratePerTiming = rate / timingFactor(rate, timing);
  return ((principal - balloon * inverseGrowth) * ratePerTiming) / (1 - inverseGrowth);
}

/**
 * The level payment that amortizes `principal` down to `balloon` over `numberOfPeriods` at the
 * periodic rate, under the explicit payment timing. Positive for every nonnegative-rate loan;
 * SIGNED in general — a negative periodic rate can decay the principal below a balloon on its
 * own, making the level payment zero or negative (the lender pays the borrower to hold the
 * schedule to its residual). A payment the arithmetic cannot represent (IEEE-754 overflow at
 * extreme magnitudes) is a typed refusal, never Infinity/NaN (2026-08-23 review, finding 1).
 */
export function annuityPayment(input: LoanTermsInput): number {
  const { balloon } = validateLoanTerms('annuityPayment', input);
  return requireRepresentableResult(
    'annuityPayment',
    levelPaymentValue(
      input.principal,
      input.periodicInterestRate,
      input.numberOfPeriods,
      input.paymentTiming,
      balloon,
    ),
  );
}

/**
 * One row of an {@link amortizationSchedule}. Columns are SIGNED: every column is a positive
 * magnitude for a nonnegative periodic rate, while a negative rate credits interest to the
 * borrower (see the module sign convention above).
 */
export interface AmortizationRow {
  period: number;
  openingBalance: number;
  payment: number;
  /** Interest accrued this period — NEGATIVE when the periodic rate is negative. */
  interest: number;
  /**
   * Balance reduction this period (`payment − interest`) — EXCEEDS the payment when the interest
   * component is negative.
   */
  principal: number;
  /** Present only when the request supplied `periodicFee`. */
  fee?: number;
  closingBalance: number;
}

/** Input for {@link amortizationSchedule}. */
export interface AmortizationScheduleInput extends LoanTermsInput {
  /** A flat per-period fee, reported per row (never folded into interest). */
  periodicFee?: number;
}

const SCHEDULE_KEYS = [...LOAN_KEYS, 'periodicFee'] as const;

/** The schedule plus its reconciliation facts — the unrounded rows reconcile exactly. */
export interface AmortizationScheduleResult {
  rows: AmortizationRow[];
  payment: number;
  totalInterest: number;
  totalPrincipal: number;
  /** The explicit residual after the final payment (equals the requested balloon). */
  balloon: number;
  /** This schedule is UNROUNDED: display rounding is the caller's explicit policy. */
  rounding: 'none';
}

/**
 * The full amortization schedule. Unrounded by design — the rows reconcile exactly (each closing
 * balance = opening − principal; Σ principal = principal − balloon) and any display rounding is
 * the caller's explicit, documented policy applied afterwards.
 */
export function amortizationSchedule(input: AmortizationScheduleInput): AmortizationScheduleResult {
  requireArgumentObject('amortizationSchedule', 'input', input);
  ensureKnownKeys('amortizationSchedule', 'input', input, SCHEDULE_KEYS);
  const { periodicFee, ...terms } = input;
  const { balloon } = validateLoanTerms('amortizationSchedule', terms);
  if (
    periodicFee !== undefined &&
    (typeof periodicFee !== 'number' || !Number.isFinite(periodicFee) || periodicFee < 0)
  ) {
    throw new InputError(
      `amortizationSchedule: periodicFee must be a finite number ≥ 0 when provided. Received ${periodicFee === null ? 'null' : String(periodicFee)}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'periodicFee' } },
    );
  }
  const payment = annuityPayment(terms);
  const rate = input.periodicInterestRate;
  const rows: AmortizationRow[] = [];
  let balance = input.principal;
  let totalInterest = 0;
  for (let period = 1; period <= input.numberOfPeriods; period++) {
    // Beginning-timing payments reduce the balance BEFORE the period accrues interest.
    const interestBase = input.paymentTiming === 'beginning' ? balance - payment : balance;
    const interest = interestBase * rate;
    const closing = balance - (payment - interest);
    rows.push({
      period,
      openingBalance: balance,
      payment,
      interest,
      principal: payment - interest,
      ...(periodicFee !== undefined ? { fee: periodicFee } : {}),
      closingBalance: closing,
    });
    totalInterest += interest;
    balance = closing;
  }
  // 2026-08-23 review, finding 1: a schedule whose running balances or totals overflow IEEE-754
  // doubles is a typed refusal, never rows carrying Infinity/NaN.
  return requireRepresentableResult('amortizationSchedule', {
    rows,
    payment,
    totalInterest,
    totalPrincipal: input.principal - balloon,
    balloon,
    rounding: 'none',
  });
}

/** Input naming one period of an existing loan. */
export interface LoanPeriodInput extends LoanTermsInput {
  /** 1-based period the question is about. */
  period: number;
}

const PERIOD_KEYS = [...LOAN_KEYS, 'period'] as const;

function validatePeriod(functionName: string, input: LoanPeriodInput): void {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, PERIOD_KEYS);
  const { period, ...terms } = input;
  validateLoanTerms(functionName, terms);
  // Safe integer (2026-08-23 review, P0): above 2^53 an "integer" period can no longer be exact.
  // The upper work bound is inherited — period ≤ numberOfPeriods ≤ MAX_LOAN_PERIODS.
  if (!Number.isSafeInteger(period) || period < 1 || period > input.numberOfPeriods) {
    throw new InputError(
      `${functionName}: period must be an integer in [1, numberOfPeriods]. Received ${String(period)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'period' } },
    );
  }
}

/**
 * Interest portion of the payment in one period — SIGNED: positive for a nonnegative rate,
 * negative when the periodic rate is negative (the period credits interest to the borrower).
 */
export function loanInterestPayment(input: LoanPeriodInput): number {
  validatePeriod('loanInterestPayment', input);
  const { period, ...terms } = input;
  return requireRepresentableResult(
    'loanInterestPayment',
    amortizationSchedule(terms).rows[period - 1]!.interest,
  );
}

/**
 * Balance reduction in one period (`payment − interest`) — SIGNED: exceeds the payment when the
 * periodic rate (and so the interest component) is negative.
 */
export function loanPrincipalPayment(input: LoanPeriodInput): number {
  validatePeriod('loanPrincipalPayment', input);
  const { period, ...terms } = input;
  return requireRepresentableResult(
    'loanPrincipalPayment',
    amortizationSchedule(terms).rows[period - 1]!.principal,
  );
}

/** Input for the two cumulative heads: an inclusive period range. */
export interface LoanRangeInput extends LoanTermsInput {
  /** 1-based first period, inclusive. */
  fromPeriod: number;
  /** 1-based last period, inclusive. */
  toPeriod: number;
}

const RANGE_KEYS = [...LOAN_KEYS, 'fromPeriod', 'toPeriod'] as const;

function validateRange(functionName: string, input: LoanRangeInput): void {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, RANGE_KEYS);
  const { fromPeriod, toPeriod, ...terms } = input;
  validateLoanTerms(functionName, terms);
  // Safe integers (2026-08-23 review, P0): the range loop is bounded by these two, and above 2^53
  // an "integer" bound can no longer be exact. The work cap is inherited — toPeriod ≤
  // numberOfPeriods ≤ MAX_LOAN_PERIODS.
  if (
    !Number.isSafeInteger(fromPeriod) ||
    !Number.isSafeInteger(toPeriod) ||
    fromPeriod < 1 ||
    toPeriod < fromPeriod ||
    toPeriod > input.numberOfPeriods
  ) {
    throw new InputError(
      `${functionName}: 1 ≤ fromPeriod ≤ toPeriod ≤ numberOfPeriods must hold. Received fromPeriod=${String(fromPeriod)}, toPeriod=${String(toPeriod)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'fromPeriod' } },
    );
  }
}

/**
 * Total interest across an inclusive period range — SIGNED: positive for a nonnegative rate,
 * negative when the periodic rate is negative (interest credited to the borrower).
 */
export function cumulativeLoanInterest(input: LoanRangeInput): number {
  validateRange('cumulativeLoanInterest', input);
  const { fromPeriod, toPeriod, ...terms } = input;
  const { rows } = amortizationSchedule(terms);
  let total = 0;
  for (let period = fromPeriod; period <= toPeriod; period++) total += rows[period - 1]!.interest;
  // 2026-08-23 review, finding 1: finite rows can still SUM past Number.MAX_VALUE — refuse.
  return requireRepresentableResult('cumulativeLoanInterest', total);
}

/**
 * Total balance reduction across an inclusive period range — SIGNED: exceeds the payments made
 * when the periodic rate is negative (each period's principal component exceeds its payment).
 */
export function cumulativeLoanPrincipal(input: LoanRangeInput): number {
  validateRange('cumulativeLoanPrincipal', input);
  const { fromPeriod, toPeriod, ...terms } = input;
  const { rows } = amortizationSchedule(terms);
  let total = 0;
  for (let period = fromPeriod; period <= toPeriod; period++) total += rows[period - 1]!.principal;
  // 2026-08-23 review, finding 1: finite rows can still SUM past Number.MAX_VALUE — refuse.
  return requireRepresentableResult('cumulativeLoanPrincipal', total);
}

/** Input for {@link loanNumberOfPeriods}: how long a payment takes to retire a loan. */
export interface LoanNumberOfPeriodsInput {
  principal: number;
  periodicInterestRate: number;
  /** The level payment (positive magnitude). */
  payment: number;
  paymentTiming: PaymentTiming;
  balloon?: number;
}

const NUMBER_OF_PERIODS_EXAMPLE =
  "loanNumberOfPeriods({ principal: 250_000, periodicInterestRate: 0.06 / 12, payment: 1_498.88, paymentTiming: 'end' })";

/** Periods (possibly fractional) for `payment` to amortize `principal` down to `balloon`. */
export function loanNumberOfPeriods(input: LoanNumberOfPeriodsInput): number {
  requireArgumentObject('loanNumberOfPeriods', 'input', input);
  ensureKnownKeys('loanNumberOfPeriods', 'input', input, [
    'principal',
    'periodicInterestRate',
    'payment',
    'paymentTiming',
    'balloon',
  ]);
  requireFiniteFields(
    'loanNumberOfPeriods',
    input,
    ['principal', 'periodicInterestRate', 'payment'],
    { exampleCall: NUMBER_OF_PERIODS_EXAMPLE },
  );
  if (input.paymentTiming !== 'end' && input.paymentTiming !== 'beginning') {
    throw new InputError(
      `loanNumberOfPeriods: paymentTiming must be 'end' | 'beginning'. Received ${JSON.stringify(input.paymentTiming)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'paymentTiming' } },
    );
  }
  // The economic domain — the same laws validateLoanTerms states for every forward head. Outside
  // it, the closed form still produces a NUMBER (0 periods at rate −100%, negative periods for a
  // negative principal) — a plausible wrong answer, which is exactly what must never leave here.
  if (input.principal <= 0) {
    throw new InputError(
      `loanNumberOfPeriods: principal must be > 0 (the amount borrowed). Received ${input.principal}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'principal' } },
    );
  }
  if (input.periodicInterestRate <= -1) {
    throw new InputError(
      `loanNumberOfPeriods: periodicInterestRate must exceed −100% per period. Received ${input.periodicInterestRate}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'periodicInterestRate' } },
    );
  }
  // A nonpositive payment is a DOMAIN refusal, checked before any arithmetic (the 2026-08-23
  // review): the input contract documents the level payment as a positive magnitude, and letting
  // zero or a negative payment reach the closed form used to surface as the SOLVER's "no positive,
  // finite number of periods" refusal — a solver outcome for what was never a solvable question.
  if (input.payment <= 0) {
    throw new InputError(
      `loanNumberOfPeriods: payment must be > 0 (the level payment is a positive magnitude — a zero or negative payment can never amortize a positive principal). Received ${input.payment}.\n  e.g. ${NUMBER_OF_PERIODS_EXAMPLE}`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'payment' } },
    );
  }
  // Null is a wrong-typed value, not omission (the 350c2796 ruling): `?? 0` must never launder it.
  if (
    input.balloon !== undefined &&
    (typeof input.balloon !== 'number' || !Number.isFinite(input.balloon) || input.balloon < 0)
  ) {
    throw new InputError(
      `loanNumberOfPeriods: balloon must be a finite number ≥ 0 when provided. Received ${input.balloon === null ? 'null' : String(input.balloon)}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'balloon' } },
    );
  }
  if (input.balloon !== undefined && input.balloon >= input.principal) {
    throw new InputError(
      `loanNumberOfPeriods: balloon must satisfy 0 ≤ balloon < principal — a residual at or above the amount borrowed leaves nothing to amortize. Received balloon ${input.balloon} against principal ${input.principal}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'balloon' } },
    );
  }
  const balloon = input.balloon ?? 0;
  const rate = input.periodicInterestRate;
  const effectivePayment = input.payment * timingFactor(rate, input.paymentTiming);
  let periods: number;
  if (rate === 0) {
    periods = (input.principal - balloon) / input.payment;
  } else {
    const perPeriodInterest = input.principal * rate;
    if (effectivePayment <= perPeriodInterest) {
      throw new InputError(
        `loanNumberOfPeriods: the payment (${input.payment}) does not cover one period's interest (${perPeriodInterest.toFixed(2)}) — the balance never falls.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'payment' } },
      );
    }
    periods =
      Math.log((effectivePayment - balloon * rate) / (effectivePayment - input.principal * rate)) /
      Math.log(1 + rate);
  }
  // Verify before returning: the result must be a finite positive period count AND satisfy the
  // amortization identity `principal·(1+r)^n − effectivePayment·((1+r)^n − 1)/r = balloon`
  // (rate 0: `principal − n·payment = balloon`). A closed form fed degenerate-but-finite inputs
  // can emit a plausible wrong number — a solver refuses instead.
  let identityHolds = false;
  if (Number.isFinite(periods) && periods > 0) {
    if (rate === 0) {
      const residual = input.principal - input.payment * periods - balloon;
      identityHolds =
        Math.abs(residual) <= 1e-8 * Math.max(1, Math.abs(input.principal), Math.abs(balloon));
    } else {
      const growth = Math.pow(1 + rate, periods);
      const amortized = (effectivePayment * (growth - 1)) / rate;
      const projectedBalloon = input.principal * growth - amortized;
      const scale = Math.max(1, Math.abs(input.principal * growth), Math.abs(amortized));
      identityHolds =
        Number.isFinite(projectedBalloon) && Math.abs(projectedBalloon - balloon) <= 1e-8 * scale;
    }
  }
  if (!identityHolds) {
    throw new ConvergenceError(
      `loanNumberOfPeriods: no positive, finite number of periods satisfies the amortization identity for these terms (the closed form produced ${periods}) — the payment cannot amortize this principal down to the balloon at this rate. Check the payment against the principal, rate, and balloon.\n  e.g. loanNumberOfPeriods({ principal: 250_000, periodicInterestRate: 0.06 / 12, payment: 1_498.88, paymentTiming: 'end' })`,
      {
        code: ErrorCode.SolverNoConvergence,
        context: { field: 'payment', computedPeriods: periods },
      },
    );
  }
  // Law 7: a finite-input overflow must never leave here as a successful non-finite value.
  assertFiniteValue('loanNumberOfPeriods', periods);
  return periods;
}

/** Input for {@link loanPeriodicInterestRate}: the rate implied by a known payment. */
export interface LoanPeriodicInterestRateInput {
  principal: number;
  numberOfPeriods: number;
  /** The level payment (positive magnitude). */
  payment: number;
  paymentTiming: PaymentTiming;
  balloon?: number;
}

/**
 * The largest upper probe the bracket expansion may reach before refusing: essentially the whole
 * representable positive range. Stopping AT a cap is only ever a refusal with a teaching error —
 * never a returned number — so the cap can be generous without risking a plausible wrong answer.
 */
const RATE_BRACKET_CEILING = 1e308;

/** The closest the lower probe's growth factor `1 + rate` may get to 0 before refusing. */
const RATE_BRACKET_GROWTH_FLOOR = 1e-12;

const PERIODIC_RATE_EXAMPLE =
  "loanPeriodicInterestRate({ principal: 250_000, numberOfPeriods: 360, payment: 1_498.88, paymentTiming: 'end' })";

/**
 * The per-period rate that makes `payment` amortize `principal` — a PROVEN bracket on the monotone
 * payment-in-rate map (geometric expansion until the sign changes, over the full economic domain
 * `rate > −1`), then bisection, then a residual check that the found rate actually reproduces the
 * payment. The closed form for one period shows the rate can be astronomically large
 * (`payment / principal − 1`), so the expansion never stops at an arbitrary cap and returns —
 * failing to bracket is a refusal with a teaching error, never a number.
 *
 * One shape is refused BEFORE the solver: a one-period `'beginning'` loan with no balloon pays its
 * single installment at time zero, so the rate never touches a cash flow — the rate is
 * unidentifiable when `payment === principal` (every rate satisfies the identity) and no rate
 * solves it otherwise. See the inline teaching errors for both sub-cases.
 */
export function loanPeriodicInterestRate(input: LoanPeriodicInterestRateInput): number {
  requireArgumentObject('loanPeriodicInterestRate', 'input', input);
  ensureKnownKeys('loanPeriodicInterestRate', 'input', input, [
    'principal',
    'numberOfPeriods',
    'payment',
    'paymentTiming',
    'balloon',
  ]);
  requireFiniteFields(
    'loanPeriodicInterestRate',
    input,
    ['principal', 'numberOfPeriods', 'payment'],
    { exampleCall: PERIODIC_RATE_EXAMPLE },
  );
  if (input.paymentTiming !== 'end' && input.paymentTiming !== 'beginning') {
    throw new InputError(
      `loanPeriodicInterestRate: paymentTiming must be 'end' | 'beginning'. Received ${JSON.stringify(input.paymentTiming)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'paymentTiming' } },
    );
  }
  // The economic domain — the same laws validateLoanTerms states for every forward head, checked
  // HERE so the teaching error names the function the caller typed, not an internal helper.
  if (input.principal <= 0) {
    throw new InputError(
      `loanPeriodicInterestRate: principal must be > 0 (the amount borrowed). Received ${input.principal}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'principal' } },
    );
  }
  // ONE law for every loan head (2026-08-23 review, P0): the solver feeds this count to the same
  // level-payment algebra the forward heads validate, so it takes the same safe-integer + work cap
  // — `Number.isInteger(1e308)` is `true`, and an uncapped count is a request for unbounded work.
  if (
    !Number.isSafeInteger(input.numberOfPeriods) ||
    input.numberOfPeriods < 1 ||
    input.numberOfPeriods > MAX_LOAN_PERIODS
  ) {
    throw new InputError(
      `loanPeriodicInterestRate: numberOfPeriods must be an integer in [1, ${MAX_LOAN_PERIODS.toLocaleString('en-US')}] — ${MAX_LOAN_PERIODS.toLocaleString('en-US')} periods is monthly for ${(MAX_LOAN_PERIODS / 12).toLocaleString('en-US', { maximumFractionDigits: 0 })} years, beyond any real loan. Received ${input.numberOfPeriods}.\n  e.g. ${PERIODIC_RATE_EXAMPLE}`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'numberOfPeriods' } },
    );
  }
  // A nonpositive payment is a DOMAIN refusal, checked before any arithmetic (the 2026-08-23
  // review): the input contract documents the level payment as a positive magnitude, so it must
  // never read as a solver outcome.
  if (input.payment <= 0) {
    throw new InputError(
      `loanPeriodicInterestRate: payment must be > 0 (the level payment is a positive magnitude). Received ${input.payment}.\n  e.g. ${PERIODIC_RATE_EXAMPLE}`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'payment' } },
    );
  }
  if (
    input.balloon !== undefined &&
    (typeof input.balloon !== 'number' ||
      !Number.isFinite(input.balloon) ||
      input.balloon < 0 ||
      input.balloon >= input.principal)
  ) {
    throw new InputError(
      `loanPeriodicInterestRate: balloon must be a finite number satisfying 0 ≤ balloon < principal when provided. Received ${input.balloon === null ? 'null' : String(input.balloon)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'balloon' } },
    );
  }

  // The unidentifiable shape, refused BEFORE the solver (the 2026-08-23 review): a one-period
  // 'beginning' (annuity-due) loan with no balloon pays its single installment at time ZERO,
  // before any interest can accrue, so the amortization identity reads payment = principal at
  // EVERY rate > −100% — the rate never touches a cash flow. Two sub-cases, neither solvable:
  //  - payment === principal: every rate satisfies the identity, so no unique rate exists (the
  //    bisection used to return 0 here as if zero were THE implied rate);
  //  - payment !== principal: NO rate satisfies it — the identity is rate-free and already false.
  // The bracket solver must not run at all: it would either canonize an arbitrary rate or grind a
  // full bracket expansion to refuse what the algebra already knows. (A balloon restores
  // identifiability — the residual is discounted through `balloon / (1 + rate)` — so this gate is
  // strictly the no-balloon shape.)
  if (
    input.numberOfPeriods === 1 &&
    input.paymentTiming === 'beginning' &&
    (input.balloon ?? 0) === 0
  ) {
    if (input.payment === input.principal) {
      throw new InputError(
        `loanPeriodicInterestRate: the rate is UNIDENTIFIABLE for a one-period 'beginning' (annuity-due) loan with no balloon — the single payment falls at time zero, before any interest accrues, so payment = principal holds at EVERY rate > −100% and no unique rate exists. Identify the rate from terms the rate can touch: use 'end' timing, more than one period, or a balloon.\n  e.g. ${PERIODIC_RATE_EXAMPLE}`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: 'paymentTiming', reason: 'rate_unidentifiable' },
        },
      );
    }
    throw new InputError(
      `loanPeriodicInterestRate: NO rate solves a one-period 'beginning' (annuity-due) loan with no balloon unless payment equals principal exactly — the single payment falls at time zero, before any interest accrues, so the identity reads payment = principal at every rate and the rate cannot reconcile the difference. Received payment ${input.payment} against principal ${input.principal}.\n  e.g. ${PERIODIC_RATE_EXAMPLE}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'payment', reason: 'no_rate_exists' },
      },
    );
  }

  /**
   * The level payment at a candidate rate — the same {@link levelPaymentValue} closed form the
   * public {@link annuityPayment} head returns, WITHOUT the head's representability refusal
   * (2026-08-23 review, finding 1: the head now refuses a non-finite payment with a typed
   * teaching, but the bracket expansion legitimately probes rates whose payment overflows — for
   * 'end' timing the payment tends to `principal · rate / timingFactor`, unbounded in the probe —
   * and a ±Infinity objective value is exactly how the expansion learns it has overshot). A
   * non-finite value on the SMALL-growth side (rate → −1 with a vanishing timing factor) is
   * likewise an honest signed limit the bisection consumes directly.
   */
  const paymentAtRate = (rate: number): number =>
    levelPaymentValue(
      input.principal,
      rate,
      input.numberOfPeriods,
      input.paymentTiming,
      input.balloon ?? 0,
    );
  // Monotone increasing in rate: a higher rate needs a higher level payment for the same terms.
  const objective = (rate: number): number => paymentAtRate(rate) - input.payment;

  const atZeroRate = objective(0);
  let low: number;
  let high: number;
  if (atZeroRate === 0) {
    low = 0;
    high = 0;
  } else if (atZeroRate < 0) {
    // The payment exceeds the zero-rate level payment → the implied rate is positive. Expand the
    // upper probe geometrically until the payment function changes sign.
    low = 0;
    high = 1;
    while (objective(high) < 0) {
      low = high;
      high *= 2;
      if (high > RATE_BRACKET_CEILING) {
        throw new ConvergenceError(
          `loanPeriodicInterestRate: no per-period rate reproduces the payment ${input.payment} — the level payment stays below the target across the entire searched domain (0, ${RATE_BRACKET_CEILING}] within the economically meaningful range rate > −1. For 'beginning' timing the level payment is bounded above by the principal (the first payment falls before any interest accrues), so a payment at or above the principal has no implied rate.`,
          {
            code: ErrorCode.SolverNoConvergence,
            context: { field: 'payment', searchedDomain: `(0, ${RATE_BRACKET_CEILING}]` },
          },
        );
      }
    }
  } else {
    // The payment is below the zero-rate level payment → the implied rate is negative. Probe
    // toward −100% by halving the growth factor 1 + rate until the sign changes; the arithmetic
    // itself ends at −100%, so reaching the floor without a sign change is a refusal.
    high = 0;
    let growthFactor = 0.5;
    low = growthFactor - 1;
    while (objective(low) > 0) {
      high = low;
      growthFactor /= 2;
      low = growthFactor - 1;
      if (growthFactor < RATE_BRACKET_GROWTH_FLOOR) {
        throw new ConvergenceError(
          `loanPeriodicInterestRate: no per-period rate reproduces the payment ${input.payment} — the level payment stays above the target across the entire searched domain (−1 + ${RATE_BRACKET_GROWTH_FLOOR}, 0] within the economically meaningful range rate > −1.`,
          {
            code: ErrorCode.SolverNoConvergence,
            context: { field: 'payment', searchedDomain: `(−1 + ${RATE_BRACKET_GROWTH_FLOOR}, 0]` },
          },
        );
      }
    }
  }

  for (let iteration = 0; iteration < 200 && low < high; iteration++) {
    const mid = low + (high - low) / 2;
    if (mid === low || mid === high) break; // the interval is at floating-point resolution
    const value = objective(mid);
    if (value === 0) {
      low = mid;
      high = mid;
      break;
    }
    if (value < 0) low = mid;
    else high = mid;
  }
  const impliedRate = low + (high - low) / 2;

  // Verify the root before returning it: the found rate must actually reproduce the payment.
  const reproducedPayment = paymentAtRate(impliedRate);
  const relativeResidual =
    Math.abs(reproducedPayment - input.payment) / Math.max(1, Math.abs(input.payment));
  if (!Number.isFinite(impliedRate) || !(relativeResidual <= 1e-6)) {
    throw new ConvergenceError(
      `loanPeriodicInterestRate: the bracketed root did not reproduce the payment — loanPayment(rate ${impliedRate}) = ${reproducedPayment} against the requested ${input.payment} (relative residual ${relativeResidual}, tolerance 1e-6). This is a refusal rather than a plausible wrong number; please report it with your inputs.`,
      {
        code: ErrorCode.SolverNoConvergence,
        context: { field: 'payment', impliedRate, relativeResidual },
      },
    );
  }
  // Law 7: a finite-input overflow must never leave here as a successful non-finite value.
  assertFiniteValue('loanPeriodicInterestRate', impliedRate);
  return impliedRate;
}
