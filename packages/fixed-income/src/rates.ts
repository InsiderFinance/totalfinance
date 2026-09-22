/**
 * Rates derivatives (spec §14.3): FRAs, interest-rate swaps and OIS, European swaptions, and caps /
 * floors, priced off {@link YieldCurve}s with the Black (lognormal-forward) and Bachelier
 * (normal-forward) models.
 *
 * The library is multi-curve aware: a `discountCurve` discounts every cash flow while an optional
 * `forecastCurve` projects floating coupons (defaulting to the discount curve for the single-curve
 * case). Volatility-model inputs are validated and unknown selectors throw (no silent degradation).
 */

import {
  seriesFacade,
  type Computed,
  ErrorCode,
  InputError,
  ensureFinite,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  requireArgumentObject,
  requireFiniteFields,
  CONVENTIONS_VERSION,
  type QuantWarning,
} from '@totalfinance/core';
import {
  requireSpecification,
  ensureDayCountWhenPresent,
  ensureFrequencyWhenPresent,
} from './validate.js';
import { ensureFiniteWhenPresent } from '@totalfinance/core';
import { normalCdf, normalPdf } from '@totalfinance/math';
import {
  type FixedIncomeDayCount,
  type Frequency,
  addMonths,
  generateSchedule,
  paymentsPerYear,
  yearFraction,
} from './conventions.js';
import type { YieldCurve } from './curves.js';

export type RatesVolatilityModel = 'black' | 'bachelier';
export type OptionRight = 'call' | 'put';

/**
 * Curve fields take a curve INSTANCE (from `curves.fromZeroRates(...)` / `curves.flat(...)` /
 * `curves.bootstrap(...)`), not a raw pillar list. A `{}` or a curve-shaped guess would die on the
 * first `discount()` call deep inside a leg loop — teach the fix at the boundary instead
 * (the same pattern as `requireCurveInstance` in bonds).
 */
function requireCurveField(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is YieldCurve {
  const c = value as { discount?: unknown; forwardRate?: unknown } | null | undefined;
  if (
    c === null ||
    c === undefined ||
    typeof c !== 'object' ||
    typeof c.discount !== 'function' ||
    typeof c.forwardRate !== 'function'
  ) {
    throw new InputError(
      `${functionName}: ${field} must be a yield curve built by curves.fromZeroRates(...) / curves.flat(...) / ` +
        `curves.bootstrap(...) (an object with discount()/forwardRate()); got ` +
        `${
          c === null ? 'null' : c === undefined ? 'undefined' : typeof c
        }. Build the curve first, then pass it here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
}

/** Validate a {@link SwapCurves} bundle: `discountCurve` required, `forecastCurve` optional. */
function requireSwapCurves(functionName: string, curves: SwapCurves): void {
  requireArgumentObject(functionName, 'curves', curves);
  ensureKnownKeys(functionName, 'curves', curves, SWAP_CURVES_KEYS);
  requireCurveField(functionName, 'curves.discountCurve', curves.discountCurve);
  if (curves.forecastCurve !== undefined) {
    requireCurveField(functionName, 'curves.forecastCurve', curves.forecastCurve);
  }
}

// ---------------------------------------------------------------------------------------------------
// Forward-option model cores (undiscounted: the caller multiplies by the discount/annuity numeraire)
// ---------------------------------------------------------------------------------------------------

/**
 * Shared input guard for the forward-option cores: a bad `right`, a negative/NaN vol, or a
 * negative/NaN maturity must throw rather than silently returning intrinsic (negative vol) or leaking
 * NaN (negative `t`). Runtime JSON callers routinely hit these.
 */
function validateForwardOptionInputs(input: {
  functionName: string;
  volatility: number;
  timeToExpiryYears: number;
  right: OptionRight;
}): void {
  const { functionName, volatility, timeToExpiryYears, right } = input;
  if (right !== 'call' && right !== 'put') {
    throw new InputError(
      `${functionName}: right must be 'call' or 'put', got "${String(right)}".`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { right },
      },
    );
  }
  if (!Number.isFinite(volatility) || volatility < 0) {
    throw new InputError(`${functionName}: volatility must be finite and ≥ 0, got ${volatility}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { volatility },
    });
  }
  if (!Number.isFinite(timeToExpiryYears) || timeToExpiryYears < 0) {
    throw new InputError(
      `${functionName}: time-to-expiry must be finite and ≥ 0, got ${timeToExpiryYears}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { timeToExpiryYears },
      },
    );
  }
}

/**
 * Black-76 kernel: value of an option on a forward, undiscounted. Falls back to intrinsic
 * at T=0 or σ=0. Named `blackKernel` (not `black`) to avoid colliding with the options `black76` facade.
 */
export interface BlackKernelInput {
  forward: number;
  strike: number;
  volatility: number;
  timeToExpiryYears: number;
  right: OptionRight;
}

export function blackKernel(input: BlackKernelInput): number {
  requireArgumentObject('blackKernel', 'input', input);
  ensureKnownKeys('blackKernel', 'input', input, [
    'forward',
    'strike',
    'volatility',
    'timeToExpiryYears',
    'right',
  ]);
  const { forward, strike, volatility, timeToExpiryYears, right } = input;
  validateForwardOptionInputs({
    functionName: 'blackKernel',
    volatility,
    timeToExpiryYears,
    right,
  });
  if (!(forward > 0) || !(strike > 0)) {
    throw new InputError(
      'blackKernel: Black model requires positive forward and strike (use Bachelier for ≤0).',
      {
        code: ErrorCode.InputOutOfRange,
        context: { forward, strike },
      },
    );
  }
  const intrinsic =
    right === 'call' ? Math.max(forward - strike, 0) : Math.max(strike - forward, 0);
  const sd = volatility * Math.sqrt(timeToExpiryYears);
  if (sd <= 0) return intrinsic;
  const d1 = (Math.log(forward / strike) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  return right === 'call'
    ? forward * normalCdf(d1) - strike * normalCdf(d2)
    : strike * normalCdf(-d2) - forward * normalCdf(-d1);
}

/**
 * Bachelier (normal) kernel: value of an option on a forward, undiscounted. Handles ≤0
 * forwards/strikes. Named `bachelierKernel` to avoid colliding with the options `bachelier` facade.
 */
export interface BachelierKernelInput {
  forward: number;
  strike: number;
  /** Normal volatility in absolute rate units. */
  normalVolatility: number;
  timeToExpiryYears: number;
  right: OptionRight;
}

export function bachelierKernel(input: BachelierKernelInput): number {
  requireArgumentObject('bachelierKernel', 'input', input);
  ensureKnownKeys('bachelierKernel', 'input', input, [
    'forward',
    'strike',
    'normalVolatility',
    'timeToExpiryYears',
    'right',
  ]);
  // `validateForwardOptionInputs` covers volatility/expiry/right; the two PRICE legs were unchecked,
  // so `bachelierKernel({ normalVolatility, timeToExpiryYears, right })` returned NaN as a premium.
  requireFiniteFields('bachelierKernel', input, ['forward', 'strike'], {
    exampleCall:
      'bachelierKernel({ forward: 0.03, strike: 0.032, normalVolatility: 0.01, ' +
      "timeToExpiryYears: 1, right: 'call' })",
    hints: {
      forward: 'a forward RATE in decimal (0.03 = 3%), not a price',
      strike: 'decimal, same units as the forward rate',
    },
  });
  const { forward, strike, normalVolatility: vol, timeToExpiryYears, right } = input;
  validateForwardOptionInputs({
    functionName: 'bachelierKernel',
    volatility: vol,
    timeToExpiryYears,
    right,
  });
  const intrinsic =
    right === 'call' ? Math.max(forward - strike, 0) : Math.max(strike - forward, 0);
  const sd = vol * Math.sqrt(timeToExpiryYears);
  if (sd <= 0) return intrinsic;
  const d = (forward - strike) / sd;
  const sign = right === 'call' ? 1 : -1;
  return sign * (forward - strike) * normalCdf(sign * d) + sd * normalPdf(d);
}

function priceForward(input: {
  model: RatesVolatilityModel;
  forward: number;
  strike: number;
  volatility: number;
  timeToExpiryYears: number;
  right: OptionRight;
}): number {
  const { model, forward, strike, volatility, timeToExpiryYears, right } = input;
  if (model === 'black')
    return blackKernel({
      forward,
      strike,
      volatility,
      timeToExpiryYears,
      right,
    });
  if (model === 'bachelier') {
    return bachelierKernel({
      forward,
      strike,
      normalVolatility: volatility,
      timeToExpiryYears,
      right,
    });
  }
  throw new InputError(`priceForward: Unknown rates vol model "${String(model)}".`, {
    code: ErrorCode.InputInvalidEnum,
    context: { field: 'model', value: model },
  });
}

// ---------------------------------------------------------------------------------------------------
// FRA
// ---------------------------------------------------------------------------------------------------

export interface FraSpecification {
  start: string;
  end: string;
  /** Contract (fixed) rate the buyer pays. */
  fixedRate: number;
  notional?: number;
  /** Default `ACT/360`. */
  dayCount?: FixedIncomeDayCount;
}

/** {@link FraSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const FRA_SPEC_KEYS = ['start', 'end', 'fixedRate', 'notional', 'dayCount'] as const;

/** The options shape `fraValue` accepts (Law 12 — mirrors the parameter type; keep in sync). */
const FRA_VALUE_OPTIONS_KEYS = ['curve'] as const;

/** Law 2 report grammar (D5): every rates answer carries its conventions and a warnings channel. */
function ratesReport(assumptions: Record<string, unknown>, warnings: QuantWarning[] = []) {
  return {
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, ...assumptions },
    diagnostics: { warnings },
  };
}

export interface FraResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** PV to the fixed-rate payer (receives floating). */
  value: number;
  forwardRate: number;
  discountFactor: number;
  accrual: number;
}

/** Value a forward rate agreement off a curve: `N·τ·(F − K)·DF(end)`. */
/**
 * Optional swap/rates conventions run their ladders once per external call (the 350c2796 ruling):
 * a null dayCount/frequency used to coalesce into the industry default and silently change the
 * accrual math; `model: null` silently priced Black.
 */
/** The swap family's required fixed leg: an omitted fixedRate used to value the swap as NaN. */
function requireFixedRate(functionName: string, s: Record<string, unknown>): void {
  requireFiniteFields(functionName, s, ['fixedRate'], {
    exampleCall: `${functionName}({ effectiveDate: '2026-01-15', maturityDate: '2031-01-15', fixedRate: 0.04 }, { discountCurve })`,
  });
}

function requireRatesConventions(
  functionName: string,
  s: Record<string, unknown>,
  fields: readonly string[],
): void {
  // Self-guarding: heads call this early, so a null/undefined specification must teach here
  // rather than crash on the first field read (the deep-sweep law).
  requireArgumentObject(functionName, 'specification', s);
  for (const field of fields) {
    const value = s[field];
    if (field.toLowerCase().includes('daycount')) {
      if (value !== undefined && value === null) {
        // ensureDayCountWhenPresent rejects null with the domain — route through it.
      }
      ensureDayCountWhenPresentNamed(value, functionName, field);
    } else if (field.toLowerCase().includes('frequency')) {
      ensureFrequencyWhenPresent(value, functionName);
    } else if (field === 'model') {
      if (value !== undefined && value !== 'black' && value !== 'bachelier') {
        throw new InputError(
          `${functionName}: model must be 'black' | 'bachelier' when provided. Received ${value === null ? 'null' : JSON.stringify(value)}.`,
          {
            code: ErrorCode.InputInvalidEnum,
            context: { function: functionName, field: 'model', received: value },
          },
        );
      }
    } else {
      ensureFiniteWhenPresent(value, field, functionName);
    }
  }
}

/** `ensureDayCountWhenPresent`, reporting the caller's field name (fixedDayCount, floatDayCount…). */
function ensureDayCountWhenPresentNamed(value: unknown, functionName: string, field: string): void {
  try {
    ensureDayCountWhenPresent(value, functionName);
  } catch (error) {
    if (error instanceof InputError && field !== 'dayCount') {
      throw new InputError(error.message.replace('dayCount', field), {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field, received: value },
      });
    }
    throw error;
  }
}

export function fraValue(
  specification: FraSpecification,
  options: { curve: YieldCurve },
): FraResult {
  requireArgumentObject('fraValue', 'options', options);
  ensureKnownKeys('fraValue', 'options', options, FRA_VALUE_OPTIONS_KEYS);
  requireArgumentObject('fraValue', 'specification', specification);
  ensureKnownKeys('fraValue', 'specification', specification, FRA_SPEC_KEYS);
  requireCurveField('fraValue', 'options.curve', options.curve);
  requireRatesConventions('fraValue', specification as unknown as Record<string, unknown>, [
    'dayCount',
    'notional',
  ]);
  requireSpecification('fraValue', specification, ['start', 'end', 'fixedRate']);
  for (const dateField of ['start', 'end'] as const) {
    const value = (specification as unknown as Record<string, unknown>)[dateField];
    if (typeof value !== 'string' || value.length === 0) {
      throw new InputError(
        `fraValue: ${dateField} must be an ISO date string. Received ${value === null ? 'null' : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: dateField } },
      );
    }
  }
  requireFiniteFields('fraValue', specification, ['fixedRate'], {
    exampleCall:
      "fraValue({ start: '2026-04-15', end: '2026-07-15', fixedRate: 0.045 }, { curve })",
  });
  const dayCount = specification.dayCount ?? 'ACT/360';
  const notional = specification.notional ?? 1;
  const accrual = yearFraction(specification.start, specification.end, dayCount);
  const forwardRate = options.curve.forwardRate(specification.start, specification.end, dayCount);
  const discountFactor = options.curve.discount(specification.end); // DF from the curve reference date to the payment
  const value = notional * accrual * (forwardRate - specification.fixedRate) * discountFactor;
  return {
    value,
    forwardRate,
    discountFactor,
    accrual,
    ...ratesReport({ dayCount, notional }),
  };
}

// ---------------------------------------------------------------------------------------------------
// Swaps & OIS
// ---------------------------------------------------------------------------------------------------

export interface SwapSpecification {
  startDate: string;
  maturityDate: string;
  /** Fixed-leg rate. */
  fixedRate: number;
  notional?: number;
  /** Fixed-leg frequency (default semiannual). */
  fixedFrequency?: Frequency;
  /** Fixed-leg day count (default `30/360`). */
  fixedDayCount?: FixedIncomeDayCount;
  /** Floating-leg frequency (default quarterly). */
  floatFrequency?: Frequency;
  /** Floating-leg day count (default `ACT/360`). */
  floatDayCount?: FixedIncomeDayCount;
  /** Spread over the projected index on the floating leg (default 0). */
  floatSpread?: number;
}

/** {@link SwapSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const SWAP_SPEC_KEYS = [
  'startDate',
  'maturityDate',
  'fixedRate',
  'notional',
  'fixedFrequency',
  'fixedDayCount',
  'floatFrequency',
  'floatDayCount',
  'floatSpread',
] as const;

export interface SwapCurves {
  discountCurve: YieldCurve;
  /** Projection curve for floating coupons; defaults to the discount curve (single-curve). */
  forecastCurve?: YieldCurve;
}

/** {@link SwapCurves} keys (Law 12 — mirrors the interface above; keep in sync). */
const SWAP_CURVES_KEYS = ['discountCurve', 'forecastCurve'] as const;

export interface SwapValuation {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** PV to the payer (pays fixed, receives floating). Receiver PV is the negative. */
  value: number;
  parRate: number;
  /** Σ τᵢ·DF(tᵢ) over the fixed leg (the level / PV of a unit annuity). */
  annuity: number;
  fixedLegPresentValue: number;
  floatLegPresentValue: number;
  /** PV of a 1bp change in the fixed rate (per notional). */
  pv01: number;
}

/** Fixed-leg annuity Σ τᵢ·DF(payDateᵢ) for a swap, per unit notional. */
function fixedAnnuity(specification: SwapSpecification, discount: YieldCurve): number {
  const schedule = generateSchedule({
    effectiveDate: specification.startDate,
    maturityDate: specification.maturityDate,
    frequency: specification.fixedFrequency ?? 'semiannual',
  });
  const dc = specification.fixedDayCount ?? '30/360';
  let a = 0;
  for (const p of schedule)
    a += yearFraction(p.accrualStart, p.accrualEnd, dc) * discount.discount(p.paymentDate);
  return a;
}

/** Floating-leg PV Σ (Fᵢ + spread)·τᵢ·DF(payDateᵢ), per unit notional. */
function floatLegPresentValue(
  specification: SwapSpecification,
  discount: YieldCurve,
  forecast: YieldCurve,
): number {
  const schedule = generateSchedule({
    effectiveDate: specification.startDate,
    maturityDate: specification.maturityDate,
    frequency: specification.floatFrequency ?? 'quarterly',
  });
  const dc = specification.floatDayCount ?? 'ACT/360';
  const spread = specification.floatSpread ?? 0;
  let pv = 0;
  for (const p of schedule) {
    const accrual = yearFraction(p.accrualStart, p.accrualEnd, dc);
    const fwd = forecast.forwardRate(p.accrualStart, p.accrualEnd, dc);
    pv += (fwd + spread) * accrual * discount.discount(p.paymentDate);
  }
  return pv;
}

/** Value an interest-rate swap (or OIS) off discount/forecast curves. */
export function swapValue(specification: SwapSpecification, curves: SwapCurves): SwapValuation {
  requireSwapCurves('swapValue', curves);
  requireFixedRate('swapValue', specification as unknown as Record<string, unknown>);
  requireRatesConventions('swapValue', specification as unknown as Record<string, unknown>, [
    'fixedFrequency',
    'fixedDayCount',
    'floatFrequency',
    'floatDayCount',
    'floatSpread',
    'notional',
  ]);
  requireArgumentObject('swapValue', 'specification', specification);
  ensureKnownKeys('swapValue', 'specification', specification, SWAP_SPEC_KEYS);
  const notional = specification.notional ?? 1;
  const discount = curves.discountCurve;
  const forecast = curves.forecastCurve ?? discount;
  const annuity = fixedAnnuity(specification, discount);
  if (annuity === 0) {
    // Law 7: a zero fixed-leg annuity means the schedule produced no accrual periods — a
    // malformed spec, rejected typed rather than a NaN parRate flowing downstream.
    throw new InputError(
      'swapValue: the fixed leg has no accrual periods (zero annuity) — check startDate/maturityDate/frequency.',
      {
        code: ErrorCode.InputWrongShape,
        context: { start: specification.startDate, maturity: specification.maturityDate },
      },
    );
  }
  const floatPv = floatLegPresentValue(specification, discount, forecast);
  const fixedPv = specification.fixedRate * annuity;
  const parRate = floatPv / annuity;
  const value = notional * (floatPv - fixedPv);
  return {
    value,
    parRate,
    annuity,
    fixedLegPresentValue: notional * fixedPv,
    floatLegPresentValue: notional * floatPv,
    pv01: notional * annuity * 1e-4,
    ...ratesReport({
      notional,
      fixedFrequency: specification.fixedFrequency ?? 'semiannual',
      fixedDayCount: specification.fixedDayCount ?? '30/360',
      floatDayCount: specification.floatDayCount ?? 'ACT/360',
    }),
  };
}

/**
 * A par-rate request: a {@link SwapSpecification} WITHOUT `fixedRate` (H04) — the par rate is the
 * ANSWER, so requiring a fixed coupon demanded an input the calculation never reads. Passing one
 * anyway teaches (Law 12: accepted-but-ignored implies it mattered). Structurally the same shape
 * as {@link ForwardSwapSpecification}; each name states which question is being asked.
 */
export type ParSwapSpecification = Omit<SwapSpecification, 'fixedRate'>;

/** {@link ParSwapSpecification} keys (Law 12 — `SWAP_SPEC_KEYS` minus the irrelevant `fixedRate`). */
const PAR_SWAP_SPEC_KEYS = SWAP_SPEC_KEYS.filter((k) => k !== 'fixedRate');

function swapRateValuation(
  functionName: string,
  specification: ParSwapSpecification,
  curves: SwapCurves,
): SwapValuation {
  requireSwapCurves(functionName, curves);
  requireRatesConventions(functionName, specification as unknown as Record<string, unknown>, [
    'fixedFrequency',
    'fixedDayCount',
    'floatFrequency',
    'floatDayCount',
    'floatSpread',
    'notional',
  ]);
  requireArgumentObject(functionName, 'specification', specification);
  ensureKnownKeys(functionName, 'specification', specification, PAR_SWAP_SPEC_KEYS);
  // `fixedRate` does not affect the par rate or annuity; 0 is a harmless placeholder for the reuse.
  return swapValue({ ...specification, fixedRate: 0 }, curves);
}

/** The conventions `swapRate.explain` echoes (FI day-count vocabulary — wider than core's
 *  `Assumptions` enum, so the facade construction below carries the same type-level-only cast as
 *  `bondFacade`; the runtime shape is exactly the core envelope). */
export interface SwapRateAssumptions {
  conventionsVersion: string;
  startDate: string;
  maturityDate: string;
  notional: number;
  fixedFrequency: Frequency;
  fixedDayCount: FixedIncomeDayCount;
  floatFrequency: Frequency;
  floatDayCount: FixedIncomeDayCount;
  floatSpread: number;
}

export type SwapRateFacade = ((
  specification: ParSwapSpecification,
  curves: SwapCurves,
) => number) & {
  explain: (
    specification: ParSwapSpecification,
    curves: SwapCurves,
  ) => Omit<Computed<number>, 'assumptions'> & { assumptions: SwapRateAssumptions };
};

/**
 * Par swap rate that makes the swap value zero: `floatLegPv / annuity`. Facade (H04): the plain
 * call returns the scalar; `.explain()` discloses the leg decomposition and every applied
 * convention.
 */
export const swapRate = seriesFacade(
  'swapRate',
  (specification: ParSwapSpecification, curves: SwapCurves): number =>
    swapRateValuation('swapRate', specification, curves).parRate,
  ((specification: ParSwapSpecification, curves: SwapCurves) => {
    const valuation = swapRateValuation('swapRate.explain', specification, curves);
    return {
      value: valuation.parRate,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        startDate: specification.startDate,
        maturityDate: specification.maturityDate,
        notional: specification.notional ?? 1,
        fixedFrequency: specification.fixedFrequency ?? 'semiannual',
        fixedDayCount: specification.fixedDayCount ?? '30/360',
        floatFrequency: specification.floatFrequency ?? 'quarterly',
        floatDayCount: specification.floatDayCount ?? 'ACT/360',
        floatSpread: specification.floatSpread ?? 0,
      },
      diagnostics: {
        method: 'closed-form',
        // The arithmetic the rate came from: parRate = floatLegPresentValue / annuity (both per
        // unit notional, exactly as the ratio consumes them).
        decomposition: {
          floatLegPresentValue: valuation.floatLegPresentValue / (specification.notional ?? 1),
          annuity: valuation.annuity,
        },
        warnings: [],
      },
    };
    /* The FI day-count vocabulary is wider than core's Assumptions enum — type-level only. */
  }) as unknown as (specification: ParSwapSpecification, curves: SwapCurves) => Computed<number>,
) as unknown as SwapRateFacade;

/** A forward-starting swap; the fixed rate is the OUTPUT (the par forward rate), so it is omitted. */
export type ForwardSwapSpecification = Omit<SwapSpecification, 'fixedRate'>;

/** {@link ForwardSwapSpecification} keys (Law 12 — the {@link SwapSpecification} keys minus `fixedRate`). */
const FORWARD_SWAP_SPEC_KEYS = SWAP_SPEC_KEYS.filter((k) => k !== 'fixedRate');

export interface ForwardSwapResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** Par (forward) swap rate `S = floatLegPv / annuity` — a swaption's natural forward under the annuity measure. */
  forwardSwapRate: number;
  /** Fixed-leg annuity `Σ τ·DF(payDate)` (the level / PV of a unit annuity). */
  annuity: number;
  /** PV of a 1bp fixed-rate change (`notional · annuity · 1e-4`). */
  pv01: number;
}

/**
 * The curve-driven forward swap rate and annuity of a (possibly forward-starting) swap — the two curve
 * inputs a swaption needs, in one call. For a swaption struck at `K` expiring at `startDate`, the price
 * is `annuity · Black(forwardSwapRate, K, σ, T)` (Bachelier for normal σ). Pair this with a vol from
 * `@insiderfinance/totalfinance/volatility`'s swaption cube (`swaptionCubeVolatility`) for a fully curve-consistent swaption price, so
 * the forward and annuity come from the live (OIS/projection) curves rather than stale market nodes.
 */
export function forwardSwap(
  specification: ForwardSwapSpecification,
  curves: SwapCurves,
): ForwardSwapResult {
  requireSwapCurves('forwardSwap', curves);
  requireRatesConventions('forwardSwap', specification as unknown as Record<string, unknown>, [
    'fixedFrequency',
    'fixedDayCount',
    'floatFrequency',
    'floatDayCount',
    'floatSpread',
    'notional',
  ]);
  requireArgumentObject('forwardSwap', 'specification', specification);
  ensureKnownKeys('forwardSwap', 'specification', specification, FORWARD_SWAP_SPEC_KEYS);
  // `fixedRate` doesn't affect the par rate or annuity; 0 is a harmless placeholder for the reuse.
  const v = swapValue({ ...specification, fixedRate: 0 }, curves);
  return {
    forwardSwapRate: v.parRate,
    annuity: v.annuity,
    pv01: v.pv01,
    assumptions: v.assumptions,
    diagnostics: v.diagnostics,
  };
}

// ---------------------------------------------------------------------------------------------------
// Swaptions
// ---------------------------------------------------------------------------------------------------

export interface SwaptionSpecification extends SwapSpecification {
  /** Option expiry (typically the swap start). */
  expiry: string;
  /** Volatility — lognormal for `black`, normal (absolute) for `bachelier`. */
  volatility: number;
  /** `payer` = option to pay fixed (call on the swap rate); `receiver` = option to receive fixed. */
  optionType: 'payer' | 'receiver';
  model?: RatesVolatilityModel;
}

/** {@link SwaptionSpecification} keys (Law 12 — the {@link SwapSpecification} keys plus the option fields above). */
const SWAPTION_SPEC_KEYS = [
  ...SWAP_SPEC_KEYS,
  'expiry',
  'volatility',
  'optionType',
  'model',
] as const;

export interface SwaptionResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  price: number;
  forwardSwapRate: number;
  annuity: number;
}

/**
 * Price a European swaption. The forward swap rate `S` is the natural martingale under the annuity
 * measure, so the price is `annuity · ForwardOption(S, K, σ, T)` — Black for lognormal vol, Bachelier
 * for normal vol.
 */
export function swaptionPrice(
  specification: SwaptionSpecification,
  curves: SwapCurves,
): SwaptionResult {
  requireSwapCurves('swaptionPrice', curves);
  requireRatesConventions('swaptionPrice', specification as unknown as Record<string, unknown>, [
    'fixedFrequency',
    'fixedDayCount',
    'floatFrequency',
    'floatDayCount',
    'floatSpread',
    'model',
    'notional',
  ]);
  requireArgumentObject('swaptionPrice', 'specification', specification);
  ensureKnownKeys('swaptionPrice', 'specification', specification, SWAPTION_SPEC_KEYS);
  if (specification.optionType !== 'payer' && specification.optionType !== 'receiver') {
    throw new InputError(
      `swaptionPrice: optionType must be 'payer' or 'receiver', got "${String(specification.optionType)}".`,
      { code: ErrorCode.InputInvalidEnum, context: { optionType: specification.optionType } },
    );
  }
  const discount = curves.discountCurve;
  const forecast = curves.forecastCurve ?? discount;
  const annuity = fixedAnnuity(specification, discount);
  if (annuity === 0) {
    throw new InputError(
      'swaptionPrice: the underlying fixed leg has no accrual periods (zero annuity) — check startDate/maturityDate/frequency.',
      {
        code: ErrorCode.InputWrongShape,
        context: { start: specification.startDate, maturity: specification.maturityDate },
      },
    );
  }
  const floatPv = floatLegPresentValue(specification, discount, forecast);
  const forwardSwapRate = floatPv / annuity;
  const t = yearFraction(discount.referenceDate, specification.expiry, 'ACT/365F');
  if (t < 0) {
    throw new InputError('swaptionPrice: Swaption expiry is before the curve reference date.', {
      code: ErrorCode.InputOutOfRange,
      context: { expiry: specification.expiry, referenceDate: discount.referenceDate },
    });
  }
  const right: OptionRight = specification.optionType === 'payer' ? 'call' : 'put';
  const model = specification.model ?? 'black';
  const fwdOption = priceForward({
    model,
    forward: forwardSwapRate,
    strike: specification.fixedRate,
    volatility: specification.volatility,
    timeToExpiryYears: t,
    right,
  });
  const notional = specification.notional ?? 1;
  return {
    price: notional * annuity * fwdOption,
    forwardSwapRate,
    annuity,
    ...ratesReport({ model, notional, optionType: specification.optionType, expiryYears: t }),
  };
}

// ---------------------------------------------------------------------------------------------------
// Caps & floors
// ---------------------------------------------------------------------------------------------------

export interface CapFloorSpecification {
  startDate: string;
  maturityDate: string;
  strike: number;
  /** Flat volatility applied to every caplet/floorlet (lognormal for `black`, normal for `bachelier`). */
  volatility: number;
  type: 'cap' | 'floor';
  notional?: number;
  /** Reset/payment frequency (default quarterly). */
  frequency?: Frequency;
  /** Day count for accrual and forward projection (default `ACT/360`). */
  dayCount?: FixedIncomeDayCount;
  model?: RatesVolatilityModel;
}

/** {@link CapFloorSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const CAP_FLOOR_SPEC_KEYS = [
  'startDate',
  'maturityDate',
  'strike',
  'volatility',
  'type',
  'notional',
  'frequency',
  'dayCount',
  'model',
] as const;

export interface CapletResult {
  start: string;
  end: string;
  expiry: number;
  forwardRate: number;
  /** PV of this caplet/floorlet (per notional × accrual already applied). */
  value: number;
}

export interface CapFloorResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  price: number;
  caplets: CapletResult[];
}

/** Price a cap or floor as a strip of Black/Bachelier caplets/floorlets off discount/forecast curves. */
export function capFloorPrice(
  specification: CapFloorSpecification,
  curves: SwapCurves,
): CapFloorResult {
  requireSwapCurves('capFloorPrice', curves);
  requireRatesConventions('capFloorPrice', specification as unknown as Record<string, unknown>, [
    'dayCount',
    'frequency',
    'model',
    'notional',
  ]);
  requireArgumentObject('capFloorPrice', 'specification', specification);
  ensureKnownKeys('capFloorPrice', 'specification', specification, CAP_FLOOR_SPEC_KEYS);
  if (specification.type !== 'cap' && specification.type !== 'floor') {
    throw new InputError(
      `capFloorPrice: type must be 'cap' or 'floor', got "${String(specification.type)}".`,
      { code: ErrorCode.InputInvalidEnum, context: { type: specification.type } },
    );
  }
  const discount = curves.discountCurve;
  const forecast = curves.forecastCurve ?? discount;
  const dc = specification.dayCount ?? 'ACT/360';
  const notional = specification.notional ?? 1;
  const model = specification.model ?? 'black';
  const right: OptionRight = specification.type === 'cap' ? 'call' : 'put';
  const schedule = generateSchedule({
    effectiveDate: specification.startDate,
    maturityDate: specification.maturityDate,
    frequency: specification.frequency ?? 'quarterly',
  });
  const caplets: CapletResult[] = [];
  let price = 0;
  // EVERY scheduled period becomes a caplet, including the one that has already fixed. The market
  // convention for a spot-starting cap is to DROP that first caplet (its rate is known, so it is
  // not optional); here it is kept and priced at zero time value, i.e. intrinsic. That is a
  // defensible choice and a material one — it is the difference between two quotes of the same cap
  // — so it is stated in `assumptions.firstCaplet` rather than left for the caller to rediscover.
  for (const p of schedule) {
    const accrual = yearFraction(p.accrualStart, p.accrualEnd, dc);
    const forwardRate = forecast.forwardRate(p.accrualStart, p.accrualEnd, dc);
    const expiry = Math.max(0, yearFraction(discount.referenceDate, p.accrualStart, 'ACT/365F'));
    const fwdOption = priceForward({
      model,
      forward: forwardRate,
      strike: specification.strike,
      volatility: specification.volatility,
      timeToExpiryYears: expiry,
      right,
    });
    const value = notional * accrual * discount.discount(p.paymentDate) * fwdOption;
    caplets.push({ start: p.accrualStart, end: p.accrualEnd, expiry, forwardRate, value });
    price += value;
  }
  return {
    price,
    caplets,
    ...ratesReport({
      model,
      notional,
      dayCount: dc,
      type: specification.type,
      /** The already-fixed first period is priced, at intrinsic — not dropped as the market does. */
      firstCaplet: 'included-at-intrinsic',
    }),
  };
}

// ---------------------------------------------------------------------------------------------------
// CMS (constant-maturity swap rate, convexity-adjusted)
// ---------------------------------------------------------------------------------------------------

export interface CmsSpecification {
  /** When the CMS rate is observed (the underlying swap's start). */
  resetDate: string;
  /** Underlying swap tenor in whole years (e.g. 10 for a 10y CMS). */
  swapTenorYears: number;
  /** Lognormal volatility of the underlying swap rate. */
  volatility: number;
  /** Underlying swap fixed-leg frequency (drives the convexity G(y); default semiannual). */
  fixedFrequency?: Frequency;
  fixedDayCount?: FixedIncomeDayCount;
  floatFrequency?: Frequency;
  floatDayCount?: FixedIncomeDayCount;
}

/** {@link CmsSpecification} keys (Law 12 — mirrors the interface above; keep in sync). */
const CMS_SPEC_KEYS = [
  'resetDate',
  'swapTenorYears',
  'volatility',
  'fixedFrequency',
  'fixedDayCount',
  'floatFrequency',
  'floatDayCount',
] as const;

export interface CmsResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** Plain forward swap rate of the underlying CMS swap. */
  forwardSwapRate: number;
  /** Convexity adjustment added because the swap rate is not a martingale under its payment measure. */
  convexityAdjustment: number;
  /** Convexity-adjusted expected CMS rate `forwardSwapRate + convexityAdjustment`. */
  cmsRate: number;
}

export interface CmsConvexityInput {
  /** Plain forward swap rate `y₀` of the underlying swap. */
  forwardSwapRate: number;
  /** Underlying swap tenor in whole years. */
  swapTenorYears: number;
  /** Fixed-leg payments per year `m` (drives the bond function G(y)). */
  paymentsPerYear: number;
  /** Lognormal volatility of the underlying swap rate. */
  volatility: number;
  /** Time to the CMS observation, in years. */
  expiry: number;
}

/** {@link CmsConvexityInput} keys (Law 12 — mirrors the interface above; keep in sync). */
const CMS_CONVEXITY_INPUT_KEYS = [
  'forwardSwapRate',
  'swapTenorYears',
  'paymentsPerYear',
  'volatility',
  'expiry',
] as const;

/** The convexity-adjustment envelope: the adjustment plus what produced it (Law 2). */
export interface CmsConvexityResult {
  /** The additive adjustment Δ (rate units): expected CMS rate minus the plain forward swap rate. */
  value: number;
  /** Applied conventions, echoed (Law 2 envelope grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** The raw Hull adjustment, shared by the public envelope and {@link forwardCmsRate}. */
function cmsConvexityKernel(input: CmsConvexityInput): number {
  const { forwardSwapRate: y, paymentsPerYear: m, swapTenorYears, volatility, expiry } = input;
  const n = Math.round(swapTenorYears * m);
  const base = 1 + y / m;
  let gPrime = 0; // dG/dy
  let gDouble = 0; // d²G/dy²
  for (let i = 1; i <= n; i++) {
    const coupon = y / m + (i === n ? 1 : 0); // par-bond cash flow at period i
    gPrime += coupon * (-i / m) * Math.pow(base, -i - 1);
    gDouble += coupon * ((i * (i + 1)) / (m * m)) * Math.pow(base, -i - 2);
  }
  if (gPrime === 0) return 0;
  return -0.5 * y * y * volatility * volatility * expiry * (gDouble / gPrime);
}

/**
 * The standard CMS convexity adjustment (Hull): valuing the swap-rate payoff with the bond function
 * `G(y) = Σ cᵢ·(1 + y/m)^(−i)` of a par bond paying the swap's fixed cash flows gives
 * `Δ = −½·y₀²·σ²·T·G''(y₀)/G'(y₀)` (positive, since `G' < 0` and `G'' > 0`). Returns a Law-2
 * envelope: the adjustment in `value` plus the applied conventions and a warnings channel.
 */
export function cmsConvexityAdjustment(specification: CmsConvexityInput): CmsConvexityResult {
  const functionName = 'cmsConvexityAdjustment';
  requireArgumentObject(functionName, 'specification', specification);
  ensureKnownKeys(functionName, 'specification', specification, CMS_CONVEXITY_INPUT_KEYS);
  ensureFinite(specification.forwardSwapRate, 'forwardSwapRate', functionName);
  ensurePositive(specification.swapTenorYears, 'swapTenorYears', functionName);
  ensurePositive(specification.paymentsPerYear, 'paymentsPerYear', functionName);
  ensureNonNegative(specification.volatility, 'volatility', functionName);
  ensureNonNegative(specification.expiry, 'expiry', functionName);
  const value = cmsConvexityKernel(specification);
  return {
    value,
    ...ratesReport({
      swapTenorYears: specification.swapTenorYears,
      paymentsPerYear: specification.paymentsPerYear,
      expiryYears: specification.expiry,
      bondFunction: 'par-bond G(y)',
    }),
  };
}

/**
 * Forward CMS rate off a curve: the forward swap rate of the underlying constant-maturity swap plus the
 * convexity adjustment. Discount the resulting rate on the relevant payment date to value a CMS leg.
 */
export function forwardCmsRate(specification: CmsSpecification, curves: SwapCurves): CmsResult {
  requireSwapCurves('forwardCmsRate', curves);
  requireRatesConventions('forwardCmsRate', specification as unknown as Record<string, unknown>, [
    'fixedFrequency',
    'fixedDayCount',
    'floatFrequency',
    'floatDayCount',
    'notional',
  ]);
  requireFiniteFields('forwardCmsRate', specification, ['volatility'], {
    exampleCall:
      "forwardCmsRate({ effectiveDate: '2026-01-15', maturityDate: '2031-01-15', volatility: 0.2 }, { discountCurve })",
  });
  requireArgumentObject('forwardCmsRate', 'specification', specification);
  ensureKnownKeys('forwardCmsRate', 'specification', specification, CMS_SPEC_KEYS);
  const discount = curves.discountCurve;
  const maturity = addMonths(specification.resetDate, 12 * specification.swapTenorYears);
  const underlying: ParSwapSpecification = {
    startDate: specification.resetDate,
    maturityDate: maturity,
    ...(specification.fixedFrequency !== undefined
      ? { fixedFrequency: specification.fixedFrequency }
      : {}),
    ...(specification.fixedDayCount !== undefined
      ? { fixedDayCount: specification.fixedDayCount }
      : {}),
    ...(specification.floatFrequency !== undefined
      ? { floatFrequency: specification.floatFrequency }
      : {}),
    ...(specification.floatDayCount !== undefined
      ? { floatDayCount: specification.floatDayCount }
      : {}),
  };
  const forwardSwapRate = swapRate(underlying, curves);
  const expiry = Math.max(
    0,
    yearFraction(discount.referenceDate, specification.resetDate, 'ACT/365F'),
  );
  const m = paymentsPerYear(specification.fixedFrequency ?? 'semiannual');
  const convexityAdjustment = cmsConvexityKernel({
    forwardSwapRate,
    paymentsPerYear: m,
    swapTenorYears: specification.swapTenorYears,
    volatility: specification.volatility,
    expiry,
  });
  return {
    forwardSwapRate,
    convexityAdjustment,
    cmsRate: forwardSwapRate + convexityAdjustment,
    ...ratesReport({
      swapTenorYears: specification.swapTenorYears,
      paymentsPerYear: m,
      expiryYears: expiry,
    }),
  };
}
