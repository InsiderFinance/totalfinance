/**
 * Yield curves (spec §14.2): discount, zero, and forward curves built from pillar quotes, with
 * pluggable interpolation/extrapolation, parallel and key-rate shocks for curve risk, and a
 * multi-curve-ready design (discount vs. forecast curves are just two `YieldCurve`s the rates layer
 * combines — see `rates.ts`).
 *
 * The canonical internal state is **continuously-compounded zero rates at pillar times** measured
 * from the curve's reference date under its day count; discount factors, forward rates, and any other
 * quoting convention are derived from those. All inputs are validated and bad data throws (design law:
 * no silent degradation).
 */

import {
  type InterestCompounding,
  ConvergenceError,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isoDateToEpochMs,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import { ensureDayCountWhenPresent } from './validate.js';
import { recordCurveState, registerCurveBuilder, type YieldCurveState } from './curve-state.js';
import { brent, makeNaturalCubicSpline, makePchipInterpolator } from '@totalfinance/math';
import {
  type FixedIncomeDayCount,
  type Frequency,
  compareDates,
  generateSchedule,
  yearFraction,
} from './conventions.js';

/** How zero rates are quoted/converted at the API boundary (internal storage is always continuous). */
// FC0: the curve grammar is core's ONE InterestCompounding — the local union (and its bare-number
// periodic form, which never said it meant periods-per-year) is removed with no aliases (pre-1.0).

/** Interpolation policy across pillars. */
export type CurveInterpolation =
  | 'logLinearDiscount' // linear in ln(discount) ⇒ piecewise-constant instantaneous forwards (market default)
  | 'linearZero' // linear in the continuous zero rate
  | 'linearDiscount' // linear in the discount factor
  | 'cubicZero' // natural cubic spline on zero rates (smooth forwards)
  | 'pchipZero'; // shape-preserving monotone cubic on zero rates

/** What to do outside the pillar range. */
export type CurveExtrapolation = 'flatForward' | 'flatZero' | 'throw';

/** A resolved pillar: its date, year fraction from the reference date, continuous zero, and discount. */
export interface CurvePillar {
  date: string;
  tenorYears: number;
  zero: number; // continuously compounded
  discount: number;
}

export interface CurveOptions {
  /** Valuation/reference date (t = 0). Defaults to the first pillar date. */
  referenceDate?: string;
  /** Day count mapping dates → year fractions. Default `ACT/365F`. */
  dayCount?: FixedIncomeDayCount;
  interpolation?: CurveInterpolation;
  extrapolation?: CurveExtrapolation;
  /** Compounding the *input* zero rates are quoted in (zero-rate builder only). Default continuous. */
  compounding?: InterestCompounding;
}

/** {@link CurveOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const CURVE_OPTIONS_KEYS = [
  'referenceDate',
  'dayCount',
  'interpolation',
  'extrapolation',
  'compounding',
] as const;

const DAY_MS = 86_400_000;

/** A discount/zero/forward curve. Immutable; shocks return new curves. */
export interface YieldCurve {
  readonly referenceDate: string;
  readonly dayCount: FixedIncomeDayCount;
  readonly interpolation: CurveInterpolation;
  readonly extrapolation: CurveExtrapolation;
  readonly pillars: readonly CurvePillar[];
  /** Year fraction from the reference date to a date (or pass a number through unchanged). */
  timeTo(at: string | number): number;
  /** Discount factor to a date or year fraction. */
  discount(at: string | number): number;
  /** Zero rate to a date or year fraction, in the requested compounding (default continuous). */
  zeroRate(at: string | number, compounding?: InterestCompounding): number;
  /** Simple (money-market) forward rate between two times/dates under `dayCount`. */
  forwardRate(from: string | number, to: string | number, dayCount?: FixedIncomeDayCount): number;
  /** Instantaneous (continuously-compounded) forward rate at a time/date. */
  instantaneousForward(at: string | number): number;
  /** Parallel shift of every pillar's continuous zero by `delta` (e.g. +0.0001 = +1bp). */
  shift(delta: number): YieldCurve;
  /** Bump a single pillar's continuous zero by `delta` (key-rate risk). */
  bumpPillar(index: number, delta: number): YieldCurve;
  /**
   * Combine with a term-structure spread curve: the continuous zeros ADD at each tenor (equivalently
   * discount factors multiply, `D(t)·D_spread(t)`). Unions both curves' pillar tenors so the spread's
   * shape — not just a level — is preserved. Used to discount over `benchmark + spread` (e.g. OIS + a
   * sector/rating spread) while keeping curve construction out of leaf entrypoints.
   */
  addSpread(spread: YieldCurve): YieldCurve;
}

// ---------------------------------------------------------------------------------------------------
// Compounding conversions (continuous zero ⇄ discount factor)
// ---------------------------------------------------------------------------------------------------

function compoundingFrequency(c: InterestCompounding): number | 'continuous' | 'simple' {
  if (typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'periodic') {
    const m = (c as { periodsPerYear: number }).periodsPerYear;
    if (!Number.isFinite(m) || m <= 0) {
      throw new InputError(
        `compounding.periodsPerYear must be a finite number > 0. Received ${m}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: 'compounding', value: m },
        },
      );
    }
    return m;
  }
  // FC0 migration teaching: the retired bare-number periodic form names its replacement.
  if (typeof c === 'number') {
    throw new InputError(
      `compounding: the bare-number periodic form is retired — pass { type: 'periodic', periodsPerYear: ${String(c)} }.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'compounding', value: c } },
    );
  }
  switch (c) {
    case 'continuous':
      return 'continuous';
    case 'simple':
      return 'simple';
    case 'annual':
      return 1;
    case 'semiannual':
      return 2;
    case 'quarterly':
      return 4;
    case 'monthly':
      return 12;
    default:
      throw new InputError(`compoundingFrequency: Unknown compounding "${String(c)}".`, {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'compounding', value: c },
      });
  }
}

/** Discount factor implied by a zero rate quoted in `compounding` over time `t`. */
function discountFromZero(zero: number, years: number, compounding: InterestCompounding): number {
  if (years === 0) return 1;
  const m = compoundingFrequency(compounding);
  if (m === 'continuous') return Math.exp(-zero * years);
  if (m === 'simple') return 1 / (1 + zero * years);
  return Math.pow(1 + zero / m, -m * years);
}

/** Zero rate (in `compounding`) implied by a discount factor over time `t`. */
function zeroFromDiscount(
  discountFactor: number,
  years: number,
  compounding: InterestCompounding,
): number {
  const m = compoundingFrequency(compounding);
  if (m === 'continuous') return -Math.log(discountFactor) / years;
  if (m === 'simple') return (1 / discountFactor - 1) / years;
  return m * (Math.pow(discountFactor, -1 / (m * years)) - 1);
}

// ---------------------------------------------------------------------------------------------------
// Curve construction
// ---------------------------------------------------------------------------------------------------

type BuiltState = YieldCurveState;

function buildCurve(state: BuiltState): YieldCurve {
  const { ts, zeros, interpolation, extrapolation, dayCount, referenceDate } = state;
  const n = ts.length;
  const tFirst = ts[0]!;
  const tLast = ts[n - 1]!;

  // Pre-build the interpolator the chosen policy needs over the *interior* [tFirst, tLast].
  const lnDf = ts.map((t, i) => -zeros[i]! * t); // ln(discount) at each pillar
  const dfs = ts.map((t, i) => Math.exp(-zeros[i]! * t));

  let cubicZeroFn: ((t: number) => number) | undefined;
  let pchipZeroFn: ((t: number) => number) | undefined;
  if (interpolation === 'cubicZero') cubicZeroFn = makeNaturalCubicSpline(ts, zeros);
  if (interpolation === 'pchipZero') pchipZeroFn = makePchipInterpolator(ts, zeros);

  /** Locate the bracketing segment [i, i+1] for an interior t (tFirst ≤ t ≤ tLast). */
  const bracket = (t: number): number => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid]! <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  /** Discount factor on the interior range via the active interpolation policy. */
  const interiorDiscount = (t: number): number => {
    if (t <= tFirst) return Math.exp(-zeros[0]! * t); // flat zero shoulder to t=0
    if (t >= tLast) return dfs[n - 1]!;
    const i = bracket(t);
    const t0 = ts[i]!;
    const t1 = ts[i + 1]!;
    const w = (t - t0) / (t1 - t0);
    switch (interpolation) {
      case 'logLinearDiscount': {
        const ln = lnDf[i]! + w * (lnDf[i + 1]! - lnDf[i]!);
        return Math.exp(ln);
      }
      case 'linearDiscount':
        return dfs[i]! + w * (dfs[i + 1]! - dfs[i]!);
      case 'linearZero': {
        const z = zeros[i]! + w * (zeros[i + 1]! - zeros[i]!);
        return Math.exp(-z * t);
      }
      case 'cubicZero':
        return Math.exp(-cubicZeroFn!(t) * t);
      case 'pchipZero':
        return Math.exp(-pchipZeroFn!(t) * t);
    }
  };

  /**
   * The zero rate AT the reference date: the caller's own t = 0 quote when the curve was built from
   * zero rates, otherwise the t→0⁺ limit taken on the FIRST SEGMENT under the active interpolation.
   *
   * A BOOTSTRAPPED curve's origin pillar is the `DF = 1` anchor, whose stored zero is the
   * placeholder 0 that `fromDiscountFactors` writes for the indeterminate `−ln(1)/0`. Returning it
   * made `zeroRate(referenceDate)` report a 0% overnight rate on a 5% curve — not a limit of
   * anything, and a number that reads as data. The genuine limit comes from the segment leaving the
   * origin, and it is policy-dependent: log-linear discount (piecewise-constant forwards) gives the
   * first real pillar's zero, linear discount gives `(1 − D₁)/t₁`, and the zero-space policies give
   * their own interpolant evaluated at 0.
   *
   * With no t = 0 pillar the shoulder `exp(−z₀·t)` already extends the first pillar's zero back to
   * the origin, so the limit is `z₀` — unchanged.
   */
  const zeroAtOrigin = (): number => {
    if (n < 2 || tFirst !== 0 || state.originZeroKnown === true) return zeros[0]!;
    const t1 = ts[1]!;
    switch (interpolation) {
      case 'logLinearDiscount':
        // ln D is linear from ln D(0) = 0 to −z₁·t₁ ⇒ ln D(t) = −z₁·t ⇒ the limit is z₁ exactly.
        return zeros[1]!;
      case 'linearDiscount':
        // D(t) = 1 + (t/t₁)(D₁ − 1) ⇒ −ln D(t)/t → (1 − D₁)/t₁.
        return (1 - dfs[1]!) / t1;
      case 'linearZero':
        // The zero itself is interpolated, so its value AT the origin is the limit.
        return zeros[0]!;
      case 'cubicZero':
        return cubicZeroFn!(0);
      case 'pchipZero':
        return pchipZeroFn!(0);
    }
  };

  /** Instantaneous forward at the last pillar, from its terminating segment (for flat-forward extrap). */
  const fwdAtLast = (): number => {
    if (n < 2) return zeros[0]!; // single pillar ⇒ flat
    const i = n - 2;
    return (zeros[n - 1]! * ts[n - 1]! - zeros[i]! * ts[i]!) / (ts[n - 1]! - ts[i]!);
  };

  const discountAt = (t: number): number => {
    if (t < 0) {
      throw new InputError(`discountAt: Curve query before reference date (t=${t}).`, {
        code: ErrorCode.InputOutOfRange,
        context: { timeYears: t },
      });
    }
    if (t === 0) return 1;
    if (t <= tLast) return interiorDiscount(t);
    // Beyond the last pillar.
    switch (extrapolation) {
      case 'flatZero':
        return Math.exp(-zeros[n - 1]! * t);
      case 'flatForward':
        return dfs[n - 1]! * Math.exp(-fwdAtLast() * (t - tLast));
      case 'throw':
        throw new InputError(`discountAt: Curve query beyond last pillar (t=${t} > ${tLast}).`, {
          code: ErrorCode.InputOutOfRange,
          context: { timeYears: t, lastPillarYears: tLast },
        });
    }
  };

  const timeTo = (at: string | number): number =>
    typeof at === 'number' ? at : yearFraction(referenceDate, at, dayCount);

  const pillars: CurvePillar[] = ts.map((t, i) => ({
    // Prefer the caller's original date string; reconstruct (day-count-aware) only when the
    // pillar never had one.
    date: state.dates?.[i] ?? addYearFractionDate(referenceDate, t, dayCount),
    tenorYears: t,
    zero: zeros[i]!,
    discount: dfs[i]!,
  }));

  const self: YieldCurve = {
    referenceDate,
    dayCount,
    interpolation,
    extrapolation,
    pillars,
    timeTo,
    discount: (at) => discountAt(timeTo(at)),
    zeroRate: (at, compounding = 'continuous') => {
      const t = timeTo(at);
      if (t === 0) {
        // The limit is taken in CONTINUOUS space, then converted: as t→0 a rate compounded m×/year
        // tends to m·(e^{z/m} − 1), not to z. (`simple` compounding tends to z itself.)
        const zc = zeroAtOrigin();
        const m = compoundingFrequency(compounding);
        return m === 'continuous' || m === 'simple' ? zc : m * (Math.exp(zc / m) - 1);
      }
      return zeroFromDiscount(discountAt(t), t, compounding);
    },
    forwardRate: (from, to, fwdDayCount = dayCount) => {
      const t1 = timeTo(from);
      const t2 = timeTo(to);
      if (t2 <= t1) {
        throw new InputError('forwardRate: requires from < to.', {
          code: ErrorCode.InputOutOfRange,
          context: { from, to },
        });
      }
      const accrual =
        typeof from === 'string' && typeof to === 'string'
          ? yearFraction(from, to, fwdDayCount)
          : t2 - t1;
      return (discountAt(t1) / discountAt(t2) - 1) / accrual;
    },
    instantaneousForward: (at) => {
      const t = timeTo(at);
      const h = Math.max(1e-5, t * 1e-5);
      const tl = Math.max(0, t - h);
      const th = t + h;
      // f = −d ln(df)/dt via central difference on the (possibly one-sided near 0) stencil.
      return -(Math.log(discountAt(th)) - Math.log(discountAt(tl))) / (th - tl);
    },
    shift: (delta) => buildCurve({ ...state, zeros: zeros.map((z) => z + delta) }),
    bumpPillar: (index, delta) => {
      // Safe integer (2026-08-23 review, P0): the `>= n` bound already rejects unsafe magnitudes;
      // the safe gate keeps the pillar index exact regardless of n.
      if (!Number.isSafeInteger(index) || index < 0 || index >= n) {
        throw new InputError(`bumpPillar: index ${index} out of range [0, ${n - 1}].`, {
          code: ErrorCode.InputOutOfRange,
          context: { index, pillars: n },
        });
      }
      const next = zeros.slice();
      next[index] = next[index]! + delta;
      return buildCurve({ ...state, zeros: next });
    },
    addSpread: (spread) => {
      // Union both curves' pillar tenors (t > 0), add continuous zeros, rebuild. Building via zeros
      // (not discount factors) avoids the degenerate −ln(1)/0 at the reference pillar that would
      // corrupt the first-period interpolation — and hence any `.shift()` on the combined curve.
      const tenors = Array.from(
        new Set([...state.ts, ...spread.pillars.map((p) => p.tenorYears)].filter((t) => t > 0)),
      ).sort((a, b) => a - b);
      const combinedZeros = tenors.map((t) => -Math.log(discountAt(t)) / t + spread.zeroRate(t));
      return buildCurve({
        referenceDate,
        dayCount,
        interpolation,
        extrapolation,
        ts: tenors,
        zeros: combinedZeros,
      });
    },
  };
  recordCurveState(self, state);
  return self;
}
registerCurveBuilder(buildCurve);

/** ISO date `days` whole days after `referenceMs` (UTC). */
function isoDaysAfter(referenceMs: number, days: number): string {
  const d = new Date(referenceMs + days * DAY_MS);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Reconstruct an ISO date `t` years after `referenceDate` UNDER THE CURVE'S DAY COUNT — pillar
 * labelling only, used when a pillar has no original input date (e.g. `curves.flat`). Inverts the
 * non-decreasing `yearFraction(referenceDate, date, dayCount)` by binary search on whole days, so
 * an ACT/360 `t = 1` labels the pillar 360 actual days out, not 365.
 */
function addYearFractionDate(
  referenceDate: string,
  t: number,
  dayCount: FixedIncomeDayCount,
): string {
  const refMs = isoDateToEpochMs(referenceDate);
  // Bracket: every supported convention's year is at most ~366 actual days.
  let lo = 0;
  let hi = Math.max(1, Math.ceil(t * 367) + 2);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (yearFraction(referenceDate, isoDaysAfter(refMs, mid), dayCount) < t) lo = mid;
    else hi = mid;
  }
  // Pick whichever bracketing day lands closer to the target year fraction.
  const fLo = yearFraction(referenceDate, isoDaysAfter(refMs, lo), dayCount);
  const fHi = yearFraction(referenceDate, isoDaysAfter(refMs, hi), dayCount);
  return Math.abs(fLo - t) <= Math.abs(fHi - t) ? isoDaysAfter(refMs, lo) : isoDaysAfter(refMs, hi);
}

/** Validate and resolve pillar dates/times against a reference date; returns sorted, aligned arrays. */
function resolvePillars(
  points: ReadonlyArray<readonly [string, number]>,
  referenceDate: string,
  dayCount: FixedIncomeDayCount,
  label: string,
): { ts: number[]; values: number[]; dates: string[] } {
  if (points.length === 0) {
    throw new InputError(`resolvePillars: A ${label} curve needs at least one pillar.`, {
      code: ErrorCode.InputOutOfRange,
      context: { label },
    });
  }
  const rows = points.map(([date, value]) => {
    if (!Number.isFinite(value)) {
      throw new InputError(`resolvePillars: Non-finite ${label} value at ${date}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { date, value },
      });
    }
    return { t: yearFraction(referenceDate, date, dayCount), date, value };
  });
  rows.sort((a, b) => a.t - b.t);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.t < 0) {
      throw new InputError(
        `resolvePillars: Pillar ${rows[i]!.date} is before the reference date ${referenceDate}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { date: rows[i]!.date, referenceDate },
        },
      );
    }
    if (i > 0 && rows[i]!.t === rows[i - 1]!.t) {
      throw new InputError(`resolvePillars: Duplicate pillar time at ${rows[i]!.date}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { date: rows[i]!.date },
      });
    }
  }
  return {
    ts: rows.map((r) => r.t),
    values: rows.map((r) => r.value),
    dates: rows.map((r) => r.date),
  };
}

const CURVE_INTERPOLATIONS = [
  'logLinearDiscount',
  'linearZero',
  'linearDiscount',
  'cubicZero',
  'pchipZero',
] as const satisfies readonly CurveInterpolation[];
const CURVE_EXTRAPOLATIONS = [
  'flatForward',
  'flatZero',
  'throw',
] as const satisfies readonly CurveExtrapolation[];
const NAMED_COMPOUNDINGS = [
  'continuous',
  'simple',
  'annual',
  'semiannual',
  'quarterly',
  'monthly',
] as const;

/**
 * Optional curve-construction conventions run their ladders (the 350c2796 ruling): a null
 * interpolation used to coalesce into logLinearDiscount and silently change every forward the
 * curve reports.
 */
function requireCurveConventions(
  functionName: string,
  options: {
    dayCount?: unknown;
    interpolation?: unknown;
    extrapolation?: unknown;
    compounding?: unknown;
  },
): void {
  ensureDayCountWhenPresent(options.dayCount, functionName);
  const reference = (options as { referenceDate?: unknown }).referenceDate;
  if (reference !== undefined && (typeof reference !== 'string' || reference.length === 0)) {
    throw new InputError(
      `${functionName}: referenceDate must be an ISO date string when provided. Received ${reference === null ? 'null' : typeof reference}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'referenceDate' },
      },
    );
  }
  const enumWhen = (value: unknown, field: string, domain: readonly string[]): void => {
    if (value === undefined) return;
    if (typeof value === 'string' && domain.includes(value)) return;
    if (field === 'compounding') {
      // FC0: the ONE InterestCompounding grammar — the object form validates here; the retired
      // bare-number form teaches its replacement instead of silently passing to a lazy read.
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'periodic'
      ) {
        const m = (value as { periodsPerYear?: unknown }).periodsPerYear;
        if (typeof m === 'number' && Number.isFinite(m) && m > 0) return;
        throw new InputError(
          `${functionName}: compounding.periodsPerYear must be a finite number > 0. Received ${String(m)}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: 'compounding' },
          },
        );
      }
      if (typeof value === 'number') {
        throw new InputError(
          `${functionName}: the bare-number periodic compounding form is retired — pass { type: 'periodic', periodsPerYear: ${String(value)} }.`,
          {
            code: ErrorCode.InputInvalidEnum,
            context: { function: functionName, field: 'compounding' },
          },
        );
      }
    }
    throw new InputError(
      `${functionName}: ${field} must be one of ${domain.join(' | ')}${field === 'compounding' ? " or { type: 'periodic', periodsPerYear }" : ''} when provided. Received ${value === null ? 'null' : typeof value === 'string' ? `"${value}"` : typeof value}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field, received: value },
      },
    );
  };
  enumWhen(options.interpolation, 'interpolation', CURVE_INTERPOLATIONS);
  enumWhen(options.extrapolation, 'extrapolation', CURVE_EXTRAPOLATIONS);
  enumWhen(options.compounding, 'compounding', NAMED_COMPOUNDINGS);
}

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

function commonOptions(options: CurveOptions, firstDate: string) {
  requireCurveConventions('curves.fromZeroRates', options);
  return {
    referenceDate: options.referenceDate ?? firstDate,
    dayCount: options.dayCount ?? ('ACT/365F' as FixedIncomeDayCount),
    interpolation: options.interpolation ?? ('logLinearDiscount' as CurveInterpolation),
    extrapolation: options.extrapolation ?? ('flatForward' as CurveExtrapolation),
  };
}

/** Build a curve from `(date, zeroRate)` pillars quoted in `options.compounding` (default continuous). */
function fromZeroRates(
  points: ReadonlyArray<readonly [string, number]>,
  options: CurveOptions = {},
): YieldCurve {
  requireArgumentArray('curves.fromZeroRates', 'points', points);
  requireOptionsObjectWhenPresent('curves.fromZeroRates', options);
  ensureKnownKeys('curves.fromZeroRates', 'options', options, CURVE_OPTIONS_KEYS);
  if (points.length > 0 && !Array.isArray(points[0])) {
    throw new InputError(
      "curves.fromZeroRates: points are [date, value] tuples, e.g. [['2027-01-15', 0.045]].",
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  const firstDate = points[0]?.[0] ?? '';
  const { referenceDate, dayCount, interpolation, extrapolation } = commonOptions(
    options,
    firstDate,
  );
  const { ts, values, dates } = resolvePillars(points, referenceDate, dayCount, 'zero-rate');
  const compounding = options.compounding ?? 'continuous';
  const m = compoundingFrequency(compounding);
  // Convert each quoted zero to a continuous zero via its discount factor.
  const zeros = ts.map((t, i) => {
    const quoted = values[i]!;
    if (t > 0) return zeroFromDiscount(discountFromZero(quoted, t, compounding), t, 'continuous');
    // A pillar ON the reference date used to be passed through UNCONVERTED, so a 5% semiannual
    // quote entered the curve as a 5% CONTINUOUS zero while every other pillar was converted —
    // the one pillar quoted in the caller's convention that silently ignored it. The round trip
    // through the discount factor is 0/0 at t = 0, so take its limit: m·ln(1 + z/m), which is
    // exactly what `zeroFromDiscount(discountFromZero(...))` tends to (and z itself for
    // continuous/simple quoting).
    if (m === 'continuous' || m === 'simple') return quoted;
    if (!(1 + quoted / m > 0)) {
      throw new InputError(
        `fromZeroRates: A zero rate of ${quoted} quoted ${String(compounding)} is below −${m} (its compounding ` +
          'frequency), so no discount factor exists for it.',
        { code: ErrorCode.InputOutOfRange, context: { zeroRate: quoted, compounding } },
      );
    }
    return m * Math.log(1 + quoted / m);
  });
  return buildCurve({
    referenceDate,
    dayCount,
    interpolation,
    extrapolation,
    ts,
    zeros,
    dates,
    // A t = 0 pillar here is a rate the caller actually quoted, so `zeroRate(referenceDate)` echoes
    // it rather than substituting the first segment's limit.
    originZeroKnown: true,
  });
}

/** Build a curve from `(date, discountFactor)` pillars. */
function fromDiscountFactors(
  points: ReadonlyArray<readonly [string, number]>,
  options: CurveOptions = {},
): YieldCurve {
  requireArgumentArray('curves.fromDiscountFactors', 'points', points);
  requireOptionsObjectWhenPresent('curves.fromDiscountFactors', options);
  ensureKnownKeys('curves.fromDiscountFactors', 'options', options, CURVE_OPTIONS_KEYS);
  if (points.length > 0 && !Array.isArray(points[0])) {
    throw new InputError(
      // The example must be a DISCOUNT FACTOR, not a rate: `0.045` here is a 95.5%-off discount
      // factor (a ~310% zero at one year), and a copied example teaches the wrong units.
      "curves.fromDiscountFactors: points are [date, discountFactor] tuples, e.g. [['2027-01-15', 0.9560]].",
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  const firstDate = points[0]?.[0] ?? '';
  const { referenceDate, dayCount, interpolation, extrapolation } = commonOptions(
    options,
    firstDate,
  );
  const { ts, values, dates } = resolvePillars(points, referenceDate, dayCount, 'discount-factor');
  const zeros = ts.map((t, i) => {
    const df = values[i]!;
    if (df <= 0) {
      throw new InputError(`fromDiscountFactors: Discount factor must be positive (got ${df}).`, {
        code: ErrorCode.InputOutOfRange,
        context: { discountFactor: df },
      });
    }
    return t === 0 ? 0 : -Math.log(df) / t;
  });
  return buildCurve({ referenceDate, dayCount, interpolation, extrapolation, ts, zeros, dates });
}

/** `Omit<CurveOptions, 'referenceDate'>` — the options shape `curves.flat` accepts. */
const FLAT_CURVE_OPTIONS_KEYS = CURVE_OPTIONS_KEYS.filter((k) => k !== 'referenceDate');

/** One cohesive request for a flat continuously compounded zero curve. */
export interface FlatCurveInput {
  rate: number;
  referenceDate: string;
  options?: Omit<CurveOptions, 'referenceDate'>;
}

/** Build a flat curve at a single continuous zero rate (handy as a default/forecast stand-in). */
function flat(input: FlatCurveInput): YieldCurve {
  requireArgumentObject('curves.flat', 'input', input);
  ensureKnownKeys('curves.flat', 'input', input, ['rate', 'referenceDate', 'options']);
  const { rate, referenceDate, options: options = {} } = input;
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('curves.flat', 'options', options);
  ensureKnownKeys('curves.flat', 'options', options, FLAT_CURVE_OPTIONS_KEYS);
  requireCurveConventions('curves.flat', options);
  if (!Number.isFinite(rate)) {
    throw new InputError(`flat: Flat curve rate must be finite (got ${rate}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { flatRate: rate },
    });
  }
  const dayCount = options.dayCount ?? ('ACT/365F' as FixedIncomeDayCount);
  return buildCurve({
    referenceDate,
    dayCount,
    interpolation: options.interpolation ?? 'linearZero',
    extrapolation: options.extrapolation ?? 'flatZero',
    ts: [0, 1],
    zeros: [rate, rate],
  });
}

// ---------------------------------------------------------------------------------------------------
// Bootstrapping (spec §14.2): deposits, FRAs, futures, OIS, and swaps → a single discount curve
// ---------------------------------------------------------------------------------------------------

/** A money-market deposit: simple rate accruing to `maturity`. */
export interface DepositInstrument {
  type: 'deposit';
  maturity: string;
  rate: number;
  /** Default `ACT/360`. */
  dayCount?: FixedIncomeDayCount;
}

/** A forward rate agreement fixing `rate` over `[start, end]`. */
export interface FraInstrument {
  type: 'fra';
  start: string;
  end: string;
  rate: number;
  /** Default `ACT/360`. */
  dayCount?: FixedIncomeDayCount;
}

/** A rate future quoted as `price = 100·(1 − impliedRate)` over `[start, end]`. */
export interface FutureInstrument {
  type: 'future';
  start: string;
  end: string;
  price: number;
  /** Forward = (100 − price)/100 − convexityAdjustment. Supplied by the caller; default 0 (none). */
  convexityAdjustment?: number;
  /** Default `ACT/360`. */
  dayCount?: FixedIncomeDayCount;
}

/** A par swap or OIS: the fixed leg pays `rate` at `fixedFrequency`; single-curve par condition. */
export interface SwapInstrument {
  type: 'swap' | 'ois';
  maturity: string;
  rate: number;
  /** Fixed-leg frequency. Default annual for `ois`, semiannual for `swap`. */
  fixedFrequency?: Frequency;
  /** Fixed-leg accrual day count. Default `30/360`. */
  fixedDayCount?: FixedIncomeDayCount;
  /**
   * Floating-leg frequency. Used by BOTH bootstraps: each now sums the floating leg explicitly, so
   * that a bootstrapped curve reprices its input swaps under `swapValue` (the single-curve
   * bootstrap used to telescope the leg to `1 − DF(T)` and ignore this field, which is exact only
   * while no payment date rolls to a business day). Default `quarterly`.
   */
  floatFrequency?: Frequency;
  /** Floating-leg day count. Default `ACT/360`. */
  floatDayCount?: FixedIncomeDayCount;
}

export type BootstrapInstrument =
  | DepositInstrument
  | FraInstrument
  | FutureInstrument
  | SwapInstrument;

export interface BootstrapOptions {
  /** Curve reference/settlement date (t = 0). */
  referenceDate: string;
  /** Curve day count (default `ACT/365F`). */
  dayCount?: FixedIncomeDayCount;
  interpolation?: CurveInterpolation;
  extrapolation?: CurveExtrapolation;
}

/** {@link BootstrapOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const BOOTSTRAP_OPTIONS_KEYS = [
  'referenceDate',
  'dayCount',
  'interpolation',
  'extrapolation',
] as const;

/** Options for {@link bootstrapProjection}: {@link BootstrapOptions} plus the OIS discount curve. */
export interface ProjectionBootstrapOptions extends BootstrapOptions {
  /**
   * The (OIS) discount curve. Each par swap discounts its legs on THIS curve while its floating
   * forwards project off the curve being built — the post-2008 dual-curve convention. Build it first
   * with {@link bootstrap} (self-discounting OIS), then pass it here.
   */
  discountCurve: YieldCurve;
}

/** {@link ProjectionBootstrapOptions} keys (Law 12 — keep in sync). */
const PROJECTION_BOOTSTRAP_OPTIONS_KEYS = [...BOOTSTRAP_OPTIONS_KEYS, 'discountCurve'] as const;

/** Options for {@link bootstrapMultiCurve}: the OIS + projection instrument sets share one build config. */
export interface MultiCurveBootstrapOptions extends BootstrapOptions {
  /** Instruments defining the OIS discount curve (self-discounting). */
  ois: BootstrapInstrument[];
  /** Instruments defining the index projection curve (discounted on the OIS curve). */
  projection: BootstrapInstrument[];
}

/** {@link MultiCurveBootstrapOptions} keys (Law 12 — keep in sync). */
const MULTI_CURVE_OPTIONS_KEYS = [...BOOTSTRAP_OPTIONS_KEYS, 'ois', 'projection'] as const;

/**
 * A dual-curve set (spec §14.2): an OIS `discountCurve` and an index `forecastCurve`. Its shape is
 * exactly the `SwapCurves` every swap analytic (`swapValue`, `swaptionPrice`, `capFloorPrice`,
 * `cmsConvexityAdjustment`) already consumes, so a bootstrapped set drops straight in.
 */
export interface MultiCurve {
  discountCurve: YieldCurve;
  forecastCurve: YieldCurve;
}

/** Guard that a value is a built curve instance (has the query methods), not a raw pillar object. */
function requireCurveInstance(
  curve: unknown,
  functionName: string,
  field: string,
): asserts curve is YieldCurve {
  if (
    curve === null ||
    typeof curve !== 'object' ||
    typeof (curve as { discount?: unknown }).discount !== 'function'
  ) {
    throw new InputError(
      `${functionName}: ${field} must be a curve built by curves.bootstrap(...) / curves.fromZeroRates(...) ` +
        `(a curve instance with discount()/zeroRate()), not a raw object. Build the discount curve first.`,
      { code: ErrorCode.InputWrongType, context: { field } },
    );
  }
}

function instrumentMaturity(inst: BootstrapInstrument): string {
  return inst.type === 'fra' || inst.type === 'future' ? inst.end : inst.maturity;
}

/**
 * Bootstrap a single discount curve from market instruments (spec §14.2). Instruments are processed in
 * ascending maturity; each one pins a new discount-factor pillar that, given the curve built so far,
 * reprices it to par. Deposits/FRAs/futures are closed-form; OIS and par swaps use the single-curve
 * identity `rate · Σ τᵢ·DF(tᵢ) = 1 − DF(T)` and are solved for the terminal discount factor (with
 * intermediate coupon discount factors interpolated through the trial pillar).
 */
/** Resolved curve-construction options threaded through the bootstrap loop. */
interface CurveBuildOpts {
  dayCount: FixedIncomeDayCount;
  interpolation: CurveInterpolation;
  extrapolation: CurveExtrapolation;
}

/**
 * How a par swap/OIS pins its terminal discount-factor pillar. Single-curve bootstrapping and the
 * dual-curve (OIS-discounted) projection bootstrap share the whole loop and differ only in this step.
 */
type SwapPillar = (
  inst: SwapInstrument,
  referenceDate: string,
  points: ReadonlyArray<readonly [string, number]>,
  curveOpts: CurveBuildOpts,
) => [string, number];

/** Resolve the shared curve-build defaults from raw {@link BootstrapOptions}. */
function resolveCurveOpts(options: BootstrapOptions): CurveBuildOpts {
  requireCurveConventions('curves.bootstrap', options);
  return {
    dayCount: options.dayCount ?? ('ACT/365F' as FixedIncomeDayCount),
    interpolation: options.interpolation ?? ('logLinearDiscount' as CurveInterpolation),
    extrapolation: options.extrapolation ?? ('flatForward' as CurveExtrapolation),
  };
}

/**
 * The shared bootstrap loop: process instruments in ascending maturity, pinning one discount-factor
 * pillar each. Deposits/FRAs/futures are closed-form and identical whether the curve is a discount or
 * a projection curve (they define forwards, not discounting); the swap/OIS pillar is pluggable so the
 * single-curve and dual-curve bootstraps share everything but that one step.
 */
function accumulatePillars(
  instruments: BootstrapInstrument[],
  referenceDate: string,
  curveOpts: CurveBuildOpts,
  swapPillar: SwapPillar,
): [string, number][] {
  const sorted = [...instruments].sort((a, b) =>
    compareDates(instrumentMaturity(a), instrumentMaturity(b)),
  );
  // Accumulated discount-factor pillars, anchored at the reference date (DF = 1 at t = 0).
  const points: [string, number][] = [[referenceDate, 1]];
  const partialCurve = (): YieldCurve =>
    fromDiscountFactors(points, { referenceDate, ...curveOpts });

  for (const inst of sorted) {
    const maturity = instrumentMaturity(inst);
    if (compareDates(maturity, referenceDate) <= 0) {
      throw new InputError(
        `accumulatePillars: Instrument maturity ${maturity} is not after the reference date.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { maturity, referenceDate },
        },
      );
    }
    if (inst.type === 'deposit') {
      const tau = yearFraction(referenceDate, inst.maturity, inst.dayCount ?? 'ACT/360');
      points.push([inst.maturity, 1 / (1 + inst.rate * tau)]);
    } else if (inst.type === 'fra' || inst.type === 'future') {
      const dc = inst.dayCount ?? 'ACT/360';
      const tau = yearFraction(inst.start, inst.end, dc);
      const fwd =
        inst.type === 'fra'
          ? inst.rate
          : (100 - inst.price) / 100 - (inst.convexityAdjustment ?? 0);
      const dfStart = partialCurve().discount(inst.start);
      points.push([inst.end, dfStart / (1 + fwd * tau)]);
    } else {
      points.push(swapPillar(inst, referenceDate, points, curveOpts));
    }
  }
  return points;
}

function bootstrap(instruments: BootstrapInstrument[], options: BootstrapOptions): YieldCurve {
  requireArgumentArray('curves.bootstrap', 'instruments', instruments);
  requireArgumentObject('curves.bootstrap', 'options', options);
  ensureKnownKeys('curves.bootstrap', 'options', options, BOOTSTRAP_OPTIONS_KEYS);
  if (instruments.length === 0) {
    throw new InputError('bootstrap: Bootstrap needs at least one instrument.', {
      code: ErrorCode.InputOutOfRange,
      context: { instruments: 0 },
    });
  }
  const curveOpts = resolveCurveOpts(options);
  const points = accumulatePillars(
    instruments,
    options.referenceDate,
    curveOpts,
    bootstrapSwapPillar,
  );
  return fromDiscountFactors(points, { referenceDate: options.referenceDate, ...curveOpts });
}

/**
 * Bootstrap an index PROJECTION (forward) curve under multi-curve, OIS-discounted conventions (spec
 * §14.2 — the post-2008 dual-curve framework). Deposits/FRAs/futures pin the projection curve exactly
 * as in {@link bootstrap} (they define forwards, independent of discounting), but each par swap/OIS is
 * discounted on the supplied `discountCurve` rather than self-discounting: the fixed leg is
 * `rate · Σ τᵢ·D(tᵢ)` and the floating leg `Σ (Fⱼ)·τⱼ·D(tⱼ)` with forwards `Fⱼ` read off the curve
 * being built and discount factors `D` from the OIS curve — solved for the terminal projection
 * discount factor. The result plugs into `swapValue`/`swaptionPrice`/`capFloorPrice` as the
 * `forecastCurve` alongside the OIS `discountCurve`.
 */
function bootstrapProjection(
  instruments: BootstrapInstrument[],
  options: ProjectionBootstrapOptions,
): YieldCurve {
  requireArgumentArray('curves.bootstrapProjection', 'instruments', instruments);
  requireArgumentObject('curves.bootstrapProjection', 'options', options);
  ensureKnownKeys(
    'curves.bootstrapProjection',
    'options',
    options,
    PROJECTION_BOOTSTRAP_OPTIONS_KEYS,
  );
  requireCurveInstance(
    options.discountCurve,
    'curves.bootstrapProjection',
    'options.discountCurve',
  );
  if (instruments.length === 0) {
    throw new InputError('bootstrapProjection: Bootstrap needs at least one instrument.', {
      code: ErrorCode.InputOutOfRange,
      context: { instruments: 0 },
    });
  }
  const curveOpts = resolveCurveOpts(options);
  const points = accumulatePillars(
    instruments,
    options.referenceDate,
    curveOpts,
    makeProjectionPillar(options.discountCurve),
  );
  return fromDiscountFactors(points, { referenceDate: options.referenceDate, ...curveOpts });
}

/**
 * Build a complete multi-curve (dual-curve) set in one call (spec §14.2): bootstrap the OIS discount
 * curve from `ois` instruments (self-discounting), then the index projection curve from `projection`
 * instruments discounted on it. Returns a `{ discountCurve, forecastCurve }` ready for every swap
 * analytic — no manual two-step wiring.
 */
function bootstrapMultiCurve(options: MultiCurveBootstrapOptions): MultiCurve {
  requireArgumentObject('curves.bootstrapMultiCurve', 'options', options);
  ensureKnownKeys('curves.bootstrapMultiCurve', 'options', options, MULTI_CURVE_OPTIONS_KEYS);
  requireArgumentArray('curves.bootstrapMultiCurve', 'options.ois', options.ois);
  requireArgumentArray('curves.bootstrapMultiCurve', 'options.projection', options.projection);
  const shared: BootstrapOptions = {
    referenceDate: options.referenceDate,
    ...(options.dayCount !== undefined ? { dayCount: options.dayCount } : {}),
    ...(options.interpolation !== undefined ? { interpolation: options.interpolation } : {}),
    ...(options.extrapolation !== undefined ? { extrapolation: options.extrapolation } : {}),
  };
  const discountCurve = bootstrap(options.ois, shared);
  const forecastCurve = bootstrapProjection(options.projection, { ...shared, discountCurve });
  return { discountCurve, forecastCurve };
}

/**
 * Solve the terminal discount factor that prices a par swap/OIS to par on the partial curve.
 *
 * Both legs are built EXACTLY as `swapValue` builds them — fixed annuity `Σ τ·D(paymentDate)`,
 * floating leg `Σ F·τ·D(paymentDate)` with `F` a simple forward off the same (self-discounting)
 * trial curve — which is the whole point of a calibration: the curve must reprice its own inputs
 * under the pricer that will consume it.
 *
 * It used to discount the fixed annuity at the UNADJUSTED `accrualEnd` and shortcut the floating
 * leg to its telescoped form `1 − DF(T)`. Both shortcuts are exact only when no payment date rolls;
 * as soon as one does, the bootstrap and `swapValue` are solving different equations, and the curve
 * came back not repricing the very swaps that defined it (a documented ~1e-6 "known gap" in the
 * multi-curve tests). Mirrors {@link makeProjectionPillar}, which already did it this way.
 */
function bootstrapSwapPillar(
  inst: SwapInstrument,
  referenceDate: string,
  points: ReadonlyArray<readonly [string, number]>,
  curveOpts: {
    dayCount: FixedIncomeDayCount;
    interpolation: CurveInterpolation;
    extrapolation: CurveExtrapolation;
  },
): [string, number] {
  const fixedFrequency = inst.fixedFrequency ?? (inst.type === 'ois' ? 'annual' : 'semiannual');
  const fixedDayCount = inst.fixedDayCount ?? '30/360';
  const floatFrequency = inst.floatFrequency ?? 'quarterly';
  const floatDayCount = inst.floatDayCount ?? 'ACT/360';
  const fixedSchedule = generateSchedule({
    effectiveDate: referenceDate,
    maturityDate: inst.maturity,
    frequency: fixedFrequency,
  });
  const floatSchedule = generateSchedule({
    effectiveDate: referenceDate,
    maturityDate: inst.maturity,
    frequency: floatFrequency,
  });

  const residual = (dfTrial: number): number => {
    const trial = fromDiscountFactors([...points, [inst.maturity, dfTrial]], {
      referenceDate,
      ...curveOpts,
    });
    let annuity = 0;
    for (const p of fixedSchedule) {
      annuity +=
        yearFraction(p.accrualStart, p.accrualEnd, fixedDayCount) * trial.discount(p.paymentDate);
    }
    // Self-discounting floating leg, summed explicitly rather than telescoped: the shortcut
    // `1 − DF(T)` is exact only while every payment date equals its accrual end.
    let floatPv = 0;
    for (const p of floatSchedule) {
      const accrual = yearFraction(p.accrualStart, p.accrualEnd, floatDayCount);
      floatPv +=
        trial.forwardRate(p.accrualStart, p.accrualEnd, floatDayCount) *
        accrual *
        trial.discount(p.paymentDate);
    }
    return inst.rate * annuity - floatPv;
  };

  const res = brent(residual, 1e-8, 2, { stepTolerance: 1e-14, maximumIterations: 200 });
  if (!res.converged) {
    throw new ConvergenceError(
      `Bootstrap did not converge for the ${inst.type} maturing ${inst.maturity}.`,
      {
        code: ErrorCode.SolverNoConvergence,
        context: { maturity: inst.maturity, quotedRate: inst.rate, reason: res.reason },
      },
    );
  }
  return [inst.maturity, res.value];
}

/**
 * The dual-curve swap pillar for {@link bootstrapProjection}: solve the terminal PROJECTION discount
 * factor that reprices a par swap/OIS to zero when its legs are discounted on the OIS `discountCurve`.
 * Mirrors `swapValue`'s conventions exactly — fixed annuity `Σ τ·D(payDate)`, floating leg
 * `Σ F·τ·D(payDate)` with `F` a simple forward off the projection curve — so a curve bootstrapped here
 * reprices its inputs to par under the same pricer (asserted in tests).
 */
function makeProjectionPillar(discountCurve: YieldCurve): SwapPillar {
  return (inst, referenceDate, points, curveOpts) => {
    const fixedFrequency = inst.fixedFrequency ?? (inst.type === 'ois' ? 'annual' : 'semiannual');
    const fixedDayCount = inst.fixedDayCount ?? '30/360';
    const floatFrequency = inst.floatFrequency ?? 'quarterly';
    const floatDayCount = inst.floatDayCount ?? 'ACT/360';
    const fixedSchedule = generateSchedule({
      effectiveDate: referenceDate,
      maturityDate: inst.maturity,
      frequency: fixedFrequency,
    });
    const floatSchedule = generateSchedule({
      effectiveDate: referenceDate,
      maturityDate: inst.maturity,
      frequency: floatFrequency,
    });
    // Fixed-leg annuity on the OIS curve — independent of the trial pillar, so compute it once.
    let annuity = 0;
    for (const p of fixedSchedule) {
      annuity +=
        yearFraction(p.accrualStart, p.accrualEnd, fixedDayCount) *
        discountCurve.discount(p.paymentDate);
    }

    const residual = (dfTrial: number): number => {
      const proj = fromDiscountFactors([...points, [inst.maturity, dfTrial]], {
        referenceDate,
        ...curveOpts,
      });
      // Floating leg: forwards from the trial projection curve, discounted on the OIS curve.
      let floatPv = 0;
      for (const p of floatSchedule) {
        const accrual = yearFraction(p.accrualStart, p.accrualEnd, floatDayCount);
        const fwd = proj.forwardRate(p.accrualStart, p.accrualEnd, floatDayCount);
        floatPv += fwd * accrual * discountCurve.discount(p.paymentDate);
      }
      return inst.rate * annuity - floatPv;
    };

    const res = brent(residual, 1e-8, 2, { stepTolerance: 1e-14, maximumIterations: 200 });
    if (!res.converged) {
      throw new ConvergenceError(
        `Projection bootstrap did not converge for the ${inst.type} maturing ${inst.maturity}.`,
        {
          code: ErrorCode.SolverNoConvergence,
          context: { maturity: inst.maturity, quotedRate: inst.rate, reason: res.reason },
        },
      );
    }
    return [inst.maturity, res.value];
  };
}

/**
 * Curve constructors (spec §14.2). Every builder returns an immutable {@link YieldCurve} whose
 * discount factors, zero rates, and forwards are mutually consistent.
 */
export const curves = {
  fromZeroRates,
  fromDiscountFactors,
  flat,
  bootstrap,
  /** Dual-curve (OIS-discounted) projection-curve bootstrap. */
  bootstrapProjection,
  /** One-call dual-curve set: OIS discount + index projection → `{ discountCurve, forecastCurve }`. */
  bootstrapMultiCurve,
  /** Build a curve from discount-factor pillars. */
  discountFactor: fromDiscountFactors,
};

export { discountFromZero, zeroFromDiscount };
