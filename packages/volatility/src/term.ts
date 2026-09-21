/**
 * Cross-expiry volatility term-structure metrics (spec §10.2): the ATM term structure, forward
 * (forward-starting) ATM volatility, and how skew evolves with maturity (calendar & forward skew).
 *
 * All read a fitted {@link VolatilitySurface}; total variance `w = σ²·t` is the natural additive coordinate,
 * so a forward vol between two expiries is `√((w₂ − w₁)/(t₂ − t₁))`.
 */

import {
  ArbitrageError,
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Computed,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  finalizeResult,
  requireArgumentObject,
  requireArgumentArray,
  validateClosedRequest,
  warning,
} from '@totalfinance/core';
import type { VolatilitySurface } from './surface.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import. Only `forwardSkew`'s options bag carries
 * a generated key — the surface and expiry arguments stay curated checks.
 */
function termSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `term: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const FORWARD_SKEW_OPTIONS_SPEC = termSpecOf('forwardSkew#3');

const FORWARD_SKEW_EXAMPLE = (): string =>
  "forwardSkew(volatilitySurface({ quotes, market }), '2026-06-19', '2026-09-18', { step: 0.05 })";

export interface AtmTermPoint {
  expiry: string;
  timeToExpiryYears: number;
  atmImpliedVolatility: number;
  /** ATM total variance `σ_atm²·t` — the calendar-arbitrage axis (must be non-decreasing in `t`). */
  atmTotalVariance: number;
}

export interface AtmTermStructure {
  points: AtmTermPoint[];
  /** Whether ATM total variance is non-decreasing across maturities (calendar-arbitrage-free ATM). */
  calendarMonotone: boolean;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; coordinate: 'atm-total-variance' };
  /** Structured warnings; a non-monotone ATM structure discloses itself here. */
  diagnostics: Diagnostics;
}

/** ATM-forward implied vol of a slice. */
function atmImpliedVolatilityOf(surface: VolatilitySurface, expiry: string): number {
  const s = surface.slice(expiry)!;
  return surface.impliedVolatility(s.forward, expiry);
}

/** The ATM implied-vol term structure: ATM IV and total variance per expiry, with a monotonicity flag. */
export function atmTermStructure(surface: VolatilitySurface): AtmTermStructure {
  requireArgumentObject('atmTermStructure', 'surface', surface);
  requireArgumentArray(
    'atmTermStructure',
    'surface.slices',
    (surface as { slices?: unknown }).slices as never,
  );
  const points: AtmTermPoint[] = surface.slices
    .map((s) => {
      const atmImpliedVolatility = surface.impliedVolatility(s.forward, s.expiry);
      return {
        expiry: s.expiry,
        timeToExpiryYears: s.timeToExpiryYears,
        atmImpliedVolatility,
        atmTotalVariance: atmImpliedVolatility * atmImpliedVolatility * s.timeToExpiryYears,
      };
    })
    .sort((a, b) => a.timeToExpiryYears - b.timeToExpiryYears);
  let monotone = true;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.atmTotalVariance < points[i - 1]!.atmTotalVariance - 1e-9) monotone = false;
  }
  const warnings: QuantWarning[] = [];
  if (!monotone) {
    warnings.push(
      warning(
        ErrorCode.VolatilityCalendarArbitrage,
        'atmTermStructure: ATM total variance falls with maturity — a calendar arbitrage in the market data (forwardVolatility between the offending expiries will throw).',
        'warn',
      ),
    );
  }
  return {
    points,
    calendarMonotone: monotone,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, coordinate: 'atm-total-variance' },
    diagnostics: {
      engine: 'atm-term-structure',
      method: 'per-slice atm impliedVolatility',
      converged: true,
      warnings,
    },
  };
}

/** Resolve two expiries to ascending `(near, far)` slices, throwing if they don't straddle in time. */
function orderedPair(
  surface: VolatilitySurface,
  from: string | number,
  to: string | number,
  functionName: string,
): {
  near: { expiry: string; timeToExpiryYears: number; forward: number };
  far: { expiry: string; timeToExpiryYears: number; forward: number };
} {
  const a = surface.slice(from);
  const b = surface.slice(to);
  if (!a || !b) {
    throw new InputError(`${functionName}: both expiries must be present on the surface.`, {
      code: ErrorCode.InputOutOfRange,
      context: { from, to },
    });
  }
  const near = a.timeToExpiryYears <= b.timeToExpiryYears ? a : b;
  const far = a.timeToExpiryYears <= b.timeToExpiryYears ? b : a;
  if (!(far.timeToExpiryYears > near.timeToExpiryYears)) {
    throw new InputError(`${functionName}: the two expiries must have distinct maturities.`, {
      code: ErrorCode.InputOutOfRange,
      context: { nearT: near.timeToExpiryYears, farT: far.timeToExpiryYears },
    });
  }
  return {
    near: { expiry: near.expiry, timeToExpiryYears: near.timeToExpiryYears, forward: near.forward },
    far: { expiry: far.expiry, timeToExpiryYears: far.timeToExpiryYears, forward: far.forward },
  };
}

/**
 * The `from`/`to` first-touch check shared by the three cross-expiry heads. `functionName` is the
 * name the USER typed (`'forwardVolatility'`, `'calendarSkew.explain'`, …) so the teaching error
 * survives the facade split — the plain call and its `.explain` twin each report under their own name.
 */
function requireExpiryArguments(
  functionName: string,
  from: string | number,
  to: string | number,
): void {
  for (const [name, v] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (typeof v !== 'string' && (typeof v !== 'number' || !Number.isFinite(v))) {
      throw new InputError(
        `${functionName}: ${name} must be an expiry date string or a finite year fraction. Received ${v === null ? 'null' : v === undefined ? 'undefined' : typeof v}.`,
        { code: ErrorCode.InputWrongType, context: { field: name } },
      );
    }
  }
}

/** The surface duck-type check shared by the three cross-expiry heads (same naming rule as above). */
function requireSurfaceShape(functionName: string, surface: VolatilitySurface): void {
  if (typeof (surface as { slice?: unknown }).slice !== 'function') {
    throw new InputError(
      `${functionName}: surface must be a VolatilitySurface (build one with volatilitySurface(quotes, market)).`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName },
      },
    );
  }
}

/** Everything `forwardVolatility` computes on the way to the scalar — the `.explain` disclosure set. */
interface ForwardVolatilityComputation {
  near: { expiry: string; timeToExpiryYears: number; forward: number };
  far: { expiry: string; timeToExpiryYears: number; forward: number };
  nearTotalVariance: number;
  farTotalVariance: number;
  timeGapYears: number;
  forwardVariance: number;
  value: number;
}

function forwardVolatilityComputation(
  functionName: string,
  surface: VolatilitySurface,
  from: string | number,
  to: string | number,
): ForwardVolatilityComputation {
  requireArgumentObject(functionName, 'surface', surface);
  requireExpiryArguments(functionName, from, to);
  requireSurfaceShape(functionName, surface);
  const { near, far } = orderedPair(surface, from, to, functionName);
  const wn = atmImpliedVolatilityOf(surface, near.expiry) ** 2 * near.timeToExpiryYears;
  const wf = atmImpliedVolatilityOf(surface, far.expiry) ** 2 * far.timeToExpiryYears;
  const timeGapYears = far.timeToExpiryYears - near.timeToExpiryYears;
  const fwdVar = (wf - wn) / timeGapYears;
  if (fwdVar < 0) {
    // This is a no-arbitrage violation detected in the MARKET data, not a malformed argument — so it
    // is an ArbitrageError (like the IV facades' below-intrinsic case), not an InputError.
    throw new ArbitrageError(
      `${functionName}: implied forward variance is negative — ATM total variance falls from ${near.expiry} (w=${wn}) to ${far.expiry} (w=${wf}), a calendar arbitrage.`,
      {
        code: ErrorCode.VolatilityCalendarArbitrage,
        context: { wn, wf, nearExpiry: near.expiry, farExpiry: far.expiry },
      },
    );
  }
  return {
    near,
    far,
    nearTotalVariance: wn,
    farTotalVariance: wf,
    timeGapYears,
    forwardVariance: fwdVar,
    value: Math.sqrt(fwdVar),
  };
}

/** The conventions `forwardVolatility.explain` echoes: the resolved (time-ordered) expiry pair. */
export interface ForwardVolatilityAssumptions {
  conventionsVersion: string;
  /** The nearer of the two requested expiries after resolution (ascending in time). */
  nearExpiry: string;
  /** The farther of the two requested expiries after resolution. */
  farExpiry: string;
  nearTimeToExpiryYears: number;
  farTimeToExpiryYears: number;
}

export type ForwardVolatilityFacade = ((
  surface: VolatilitySurface,
  from: string | number,
  to: string | number,
) => number) & {
  explain: (
    surface: VolatilitySurface,
    from: string | number,
    to: string | number,
  ) => Omit<Computed<number>, 'assumptions'> & { assumptions: ForwardVolatilityAssumptions };
};

/**
 * Forward-starting ATM volatility between two expiries from ATM total variance:
 * `√((w_far − w_near)/(t_far − t_near))`. Throws an {@link ArbitrageError}
 * (`volatility.calendar_arbitrage`) if the implied forward variance is negative (an ATM
 * calendar-arbitrage breach).
 *
 * Facade (H21): the plain call returns the scalar; `.explain()` discloses the resolved near/far
 * expiries and year fractions in `assumptions`, and the ATM total variances / forward variance /
 * time gap the square root came from in `diagnostics.decomposition`. Hand-attached (not
 * `seriesFacade`) so the plain call's first-touch teaching errors stay byte-identical.
 */
export const forwardVolatility: ForwardVolatilityFacade = Object.assign(
  (surface: VolatilitySurface, from: string | number, to: string | number): number =>
    forwardVolatilityComputation('forwardVolatility', surface, from, to).value,
  {
    explain: (
      surface: VolatilitySurface,
      from: string | number,
      to: string | number,
    ): Omit<Computed<number>, 'assumptions'> & { assumptions: ForwardVolatilityAssumptions } => {
      const c = forwardVolatilityComputation('forwardVolatility.explain', surface, from, to);
      return finalizeResult('forwardVolatility', {
        value: c.value,
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          nearExpiry: c.near.expiry,
          farExpiry: c.far.expiry,
          nearTimeToExpiryYears: c.near.timeToExpiryYears,
          farTimeToExpiryYears: c.far.timeToExpiryYears,
        },
        diagnostics: {
          method: 'closed-form',
          // The arithmetic the scalar came from: forwardVariance = (farTotalVariance −
          // nearTotalVariance) / timeGapYears, and the value is √forwardVariance.
          decomposition: {
            nearTotalVariance: c.nearTotalVariance,
            farTotalVariance: c.farTotalVariance,
            timeGapYears: c.timeGapYears,
            forwardVariance: c.forwardVariance,
          },
          warnings: [],
        },
      });
    },
  },
);

/**
 * The canonical log-moneyness central-difference step for the ATM skew slope (ledger H22): fixed —
 * not a public knob — until a concrete consumer justifies one. `calendarSkew.explain` discloses it.
 */
const ATM_SKEW_SLOPE_STEP = 0.05;

/** ATM skew slope `d(iv)/d(logMoneyness)` of one expiry via a central difference around its forward. */
function skewSlopeAt(
  surface: VolatilitySurface,
  expiry: string,
  forward: number,
  h = ATM_SKEW_SLOPE_STEP,
): number {
  const up = surface.impliedVolatility(forward * Math.exp(h), expiry);
  const dn = surface.impliedVolatility(forward * Math.exp(-h), expiry);
  return (up - dn) / (2 * h);
}

/** Everything `calendarSkew` computes on the way to the scalar — the `.explain` disclosure set. */
interface CalendarSkewComputation {
  near: { expiry: string; timeToExpiryYears: number; forward: number };
  far: { expiry: string; timeToExpiryYears: number; forward: number };
  nearSkewSlope: number;
  farSkewSlope: number;
  value: number;
}

function calendarSkewComputation(
  functionName: string,
  surface: VolatilitySurface,
  from: string | number,
  to: string | number,
): CalendarSkewComputation {
  requireArgumentObject(functionName, 'surface', surface);
  requireExpiryArguments(functionName, from, to);
  requireSurfaceShape(functionName, surface);
  const { near, far } = orderedPair(surface, from, to, functionName);
  const nearSkewSlope = skewSlopeAt(surface, near.expiry, near.forward);
  const farSkewSlope = skewSlopeAt(surface, far.expiry, far.forward);
  return { near, far, nearSkewSlope, farSkewSlope, value: farSkewSlope - nearSkewSlope };
}

/** The conventions `calendarSkew.explain` echoes: the sorted expiry pair and the canonical step. */
export interface CalendarSkewAssumptions {
  conventionsVersion: string;
  /** The nearer of the two requested expiries after resolution (ascending in time). */
  nearExpiry: string;
  /** The farther of the two requested expiries after resolution. */
  farExpiry: string;
  nearTimeToExpiryYears: number;
  farTimeToExpiryYears: number;
  /** The canonical central-difference step in log-moneyness (fixed — ledger H22). */
  logMoneynessStep: number;
}

export type CalendarSkewFacade = ((
  surface: VolatilitySurface,
  from: string | number,
  to: string | number,
) => number) & {
  explain: (
    surface: VolatilitySurface,
    from: string | number,
    to: string | number,
  ) => Omit<Computed<number>, 'assumptions'> & { assumptions: CalendarSkewAssumptions };
};

/**
 * Calendar skew: how the ATM skew slope changes from the near to the far expiry (`slope_far −
 * slope_near`). Negative when the near-dated smile is steeper (the usual term-structure-of-skew shape).
 *
 * Facade (H22): the plain call returns the scalar; `.explain()` discloses the sorted near/far
 * expiries and the canonical `0.05` log-moneyness central-difference step in `assumptions`, and both
 * ATM skew slopes in `diagnostics.decomposition`. Hand-attached (not `seriesFacade`) so the plain
 * call's first-touch teaching errors stay byte-identical.
 */
export const calendarSkew: CalendarSkewFacade = Object.assign(
  (surface: VolatilitySurface, from: string | number, to: string | number): number =>
    calendarSkewComputation('calendarSkew', surface, from, to).value,
  {
    explain: (
      surface: VolatilitySurface,
      from: string | number,
      to: string | number,
    ): Omit<Computed<number>, 'assumptions'> & { assumptions: CalendarSkewAssumptions } => {
      const c = calendarSkewComputation('calendarSkew.explain', surface, from, to);
      return finalizeResult('calendarSkew', {
        value: c.value,
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          nearExpiry: c.near.expiry,
          farExpiry: c.far.expiry,
          nearTimeToExpiryYears: c.near.timeToExpiryYears,
          farTimeToExpiryYears: c.far.timeToExpiryYears,
          logMoneynessStep: ATM_SKEW_SLOPE_STEP,
        },
        diagnostics: {
          method: 'central-difference',
          // The arithmetic the scalar came from: value = farSkewSlope − nearSkewSlope.
          decomposition: { nearSkewSlope: c.nearSkewSlope, farSkewSlope: c.farSkewSlope },
          warnings: [],
        },
      });
    },
  },
);

/** One sampled leg of the forward-skew central difference — the H23 "total-variance calculation". */
interface ForwardSkewLeg {
  nearTotalVariance: number;
  farTotalVariance: number;
  forwardVariance: number;
  forwardVolatility: number;
}

/** Everything `forwardSkew` computes on the way to the scalar — the `.explain` disclosure set. */
interface ForwardSkewComputation {
  near: { expiry: string; timeToExpiryYears: number; forward: number };
  far: { expiry: string; timeToExpiryYears: number; forward: number };
  step: number;
  timeGapYears: number;
  up: ForwardSkewLeg;
  down: ForwardSkewLeg;
  value: number;
}

function forwardSkewComputation(
  functionName: string,
  surface: VolatilitySurface,
  from: string | number,
  to: string | number,
  options: { step?: number } = {},
): ForwardSkewComputation {
  requireArgumentObject(functionName, 'surface', surface);
  requireExpiryArguments(functionName, from, to);
  // `null` slips past the `= {}` default and would die on the option read — reject it typed.
  validateClosedRequest(functionName, options, FORWARD_SKEW_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: FORWARD_SKEW_EXAMPLE,
  });
  requireSurfaceShape(functionName, surface);
  const { near, far } = orderedPair(surface, from, to, functionName);
  const h = options.step ?? 0.05;
  // A zero/negative/non-finite step turns the central difference into a division blow-up (or reads
  // the smile backwards) — reject it rather than return the resulting garbage slope (ledger H23:
  // `step` must be finite and positive).
  if (!(h > 0) || !Number.isFinite(h)) {
    throw new InputError(`${functionName}: step must be a finite number > 0, got ${h}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { step: h },
    });
  }
  const timeStepYears = far.timeToExpiryYears - near.timeToExpiryYears;
  const legAt = (k: number): ForwardSkewLeg => {
    const wn =
      surface.impliedVolatility(near.forward * Math.exp(k), near.expiry) ** 2 *
      near.timeToExpiryYears;
    const wf =
      surface.impliedVolatility(far.forward * Math.exp(k), far.expiry) ** 2 * far.timeToExpiryYears;
    const forwardVariance = (wf - wn) / timeStepYears;
    if (forwardVariance < 0) {
      // Clamping this to 0 (the old behaviour) invented a real forward vol out of a calendar
      // arbitrage and returned a finite "skew" for a smile that has none — while the sibling
      // `forwardVolatility` threw on exactly the same condition. Same breach, same error.
      throw new ArbitrageError(
        `${functionName}: implied forward variance is negative at log-moneyness k=${k.toFixed(4)} — total variance falls from ${near.expiry} (w=${wn}) to ${far.expiry} (w=${wf}), a calendar arbitrage. The forward smile does not exist there.`,
        {
          code: ErrorCode.VolatilityCalendarArbitrage,
          context: {
            logMoneyness: k,
            nearTotalVariance: wn,
            farTotalVariance: wf,
            nearExpiry: near.expiry,
            farExpiry: far.expiry,
          },
        },
      );
    }
    return {
      nearTotalVariance: wn,
      farTotalVariance: wf,
      forwardVariance,
      forwardVolatility: Math.sqrt(forwardVariance),
    };
  };
  const up = legAt(h);
  const down = legAt(-h);
  return {
    near,
    far,
    step: h,
    timeGapYears: timeStepYears,
    up,
    down,
    value: (up.forwardVolatility - down.forwardVolatility) / (2 * h),
  };
}

/** The conventions `forwardSkew.explain` echoes: the sorted expiry pair and the applied step. */
export interface ForwardSkewAssumptions {
  conventionsVersion: string;
  /** The nearer of the two requested expiries after resolution (ascending in time). */
  nearExpiry: string;
  /** The farther of the two requested expiries after resolution. */
  farExpiry: string;
  nearTimeToExpiryYears: number;
  farTimeToExpiryYears: number;
  /** The applied central-difference step in forward log-moneyness (`options.step`, default 0.05). */
  step: number;
}

export type ForwardSkewFacade = ((
  surface: VolatilitySurface,
  from: string | number,
  to: string | number,
  options?: { step?: number },
) => number) & {
  explain: (
    surface: VolatilitySurface,
    from: string | number,
    to: string | number,
    options?: { step?: number },
  ) => Omit<Computed<number>, 'assumptions'> & { assumptions: ForwardSkewAssumptions };
};

/**
 * Forward skew: the skew slope of the *forward-starting* smile between two expiries, built from the
 * added forward variance at fixed forward-log-moneyness. `d(σ_fwd)/d(logMoneyness)` via a central
 * difference, where `σ_fwd(k) = √((w_far(k) − w_near(k))/(t_far − t_near))`.
 *
 * Throws the same {@link ArbitrageError} (`volatility.calendar_arbitrage`) as {@link forwardVolatility}
 * when the forward variance is negative at either sampled `k` — a forward smile that does not exist
 * is reported, never clamped to zero and differenced into a plausible-looking number.
 *
 * Facade (H23): the plain call returns the scalar; `.explain()` discloses the applied `step` in
 * `assumptions` and BOTH total-variance calculations (the `k = +step` and `k = −step` legs) in
 * `diagnostics.decomposition`. Hand-attached (not `seriesFacade`) so the closed-request teaching
 * error for a `null` options bag stays byte-identical.
 */
export const forwardSkew: ForwardSkewFacade = Object.assign(
  (
    surface: VolatilitySurface,
    from: string | number,
    to: string | number,
    options: { step?: number } = {},
  ): number => forwardSkewComputation('forwardSkew', surface, from, to, options).value,
  {
    explain: (
      surface: VolatilitySurface,
      from: string | number,
      to: string | number,
      options: { step?: number } = {},
    ): Omit<Computed<number>, 'assumptions'> & { assumptions: ForwardSkewAssumptions } => {
      const c = forwardSkewComputation('forwardSkew.explain', surface, from, to, options);
      return finalizeResult('forwardSkew', {
        value: c.value,
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          nearExpiry: c.near.expiry,
          farExpiry: c.far.expiry,
          nearTimeToExpiryYears: c.near.timeToExpiryYears,
          farTimeToExpiryYears: c.far.timeToExpiryYears,
          step: c.step,
        },
        diagnostics: {
          method: 'central-difference',
          // Both sampled legs: forwardVarianceUp = (farTotalVarianceUp − nearTotalVarianceUp) /
          // timeGapYears (same for Down), forwardVolatility = √forwardVariance, and the scalar is
          // (forwardVolatilityUp − forwardVolatilityDown) / (2·step).
          decomposition: {
            timeGapYears: c.timeGapYears,
            nearTotalVarianceUp: c.up.nearTotalVariance,
            farTotalVarianceUp: c.up.farTotalVariance,
            forwardVarianceUp: c.up.forwardVariance,
            forwardVolatilityUp: c.up.forwardVolatility,
            nearTotalVarianceDown: c.down.nearTotalVariance,
            farTotalVarianceDown: c.down.farTotalVariance,
            forwardVarianceDown: c.down.forwardVariance,
            forwardVolatilityDown: c.down.forwardVolatility,
          },
          warnings: [],
        },
      });
    },
  },
);
