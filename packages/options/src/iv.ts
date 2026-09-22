/**
 * Implied-volatility method suite (spec §9.5).
 *
 * Multiple solver methods over the Black–Scholes–Merton model, all returning rich diagnostics:
 *   - `brent` — the bracketed reference path (always converges when a solution exists);
 *   - `newton` / `halley` / `householder` — derivative methods (1st/2nd/3rd σ-derivatives), seeded
 *     by the Manaster–Koller starting point for monotone convergence;
 *   - `auto` — Householder with a Brent fallback; reports the method actually used.
 *
 * Per spec §9.5, `'rational'` is reserved for a faithful Jäckel-style rational/asymptotic inversion
 * and is intentionally NOT exposed until that exact algorithm lands — we never alias it to another
 * method.
 *
 * Failures (below-intrinsic, above-max, non-convergence, vanishing vega) are reported honestly,
 * never fabricated (design law #4).
 */

import {
  InputError,
  ensureFiniteWhenPresent,
  CONVENTIONS_VERSION,
  type Assumptions,
  type Computed,
  DEFAULT_GREEK_UNITS,
  ErrorCode,
  type OptionType,
  type QuantWarning,
  ensureEnum,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  isQuantError,
  plausibilityWarnings,
  requireArgumentArray,
  requireArgumentObject,
  WarningCode,
} from '@totalfinance/core';
import { type Derivatives, halley, householder, newton, normalPdf } from '@totalfinance/math';
import { requireOptionalArgObject } from './facade-util.js';
import {
  blackScholesImpliedVolatility,
  blackScholesPriceBounds,
  blackScholesPriceUnchecked,
  priceBoundSlack,
  type ImpliedVolatilityReason,
} from './bsm.js';
import type { BlackScholesImpliedVolatilityInput } from './types.js';

const MODEL = 'black-scholes-merton';

export type ImpliedVolatilityMethod = 'auto' | 'brent' | 'newton' | 'halley' | 'householder';

export interface ImpliedVolatilityOptions {
  method?: ImpliedVolatilityMethod;
  /** Fall back to Brent when a derivative method fails (default `true`). */
  fallback?: boolean;
  /** In batch mode, throw on the first bad row instead of recording it (default `false`). */
  failFast?: boolean;
}

/** {@link BlackScholesImpliedVolatilityInput} keys (Law 12 — mirrors the interface in types.ts; keep in sync). */
const IMPLIED_VOL_INPUT_KEYS = [
  'price',
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'type',
  'dividendYield',
] as const;

/**
 * {@link ImpliedVolatilityOptions} keys (Law 12 — mirrors the interface above; keep in sync). These
 * heads invert closed-form Black–Scholes; an `engine` is not on the list because they could never
 * honour one — `option.impliedVolatility({ contract, market, engine })` is the engine-inverting door.
 */
const IMPLIED_VOL_OPTIONS_KEYS = ['method', 'fallback', 'failFast'] as const;

/** When-present ladders for the SHARED solver options — method/fallback/failFast live on the
 *  OPTIONS argument (an earlier guard laddered them on the input object, where key closure already
 *  rejects them — the options-side coalesces were the live defect). */
function requireIvOptionLadders(functionName: string, options: Record<string, unknown>): void {
  const methodValue = options['method'];
  if (
    methodValue !== undefined &&
    methodValue !== 'auto' &&
    methodValue !== 'brent' &&
    methodValue !== 'newton' &&
    methodValue !== 'halley' &&
    methodValue !== 'householder'
  ) {
    throw new InputError(
      `${functionName}: method must be 'auto' | 'brent' | 'newton' | 'halley' | 'householder' when provided. Received ${methodValue === null ? 'null' : JSON.stringify(methodValue)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'method' } },
    );
  }
  for (const flag of ['fallback', 'failFast'] as const) {
    const flagValue = options[flag];
    if (flagValue !== undefined && typeof flagValue !== 'boolean') {
      throw new InputError(
        `${functionName}: ${flag} must be a boolean when provided. Received ${flagValue === null ? 'null' : typeof flagValue}.`,
        { code: ErrorCode.InputWrongType, context: { field: flag } },
      );
    }
  }
}

export interface ImpliedVolatilityDiagnostics {
  engine: string;
  /** The method actually used (may differ from the requested method after a fallback). */
  method: string;
  converged: boolean;
  iterations: number;
  /** Whether a fallback path was taken. */
  fallback: boolean;
  warnings: QuantWarning[];
}

/** `value` is `null` when the solve failed (no-arbitrage violation / no convergence) — the
 * reason rides `diagnostics` (`converged: false` + a warning). Never NaN (Law 7 / E3). */
export type ImpliedVolatilitySolveResult = Computed<number | null> & {
  diagnostics: ImpliedVolatilityDiagnostics;
};

/** σ-derivatives of the BSM price residual at a trial volatility. */
function impliedVolatilityDerivatives(input: {
  type: OptionType;
  targetPrice: number;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}): Derivatives {
  const {
    type,
    targetPrice: target,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const vega = S * Math.exp(-q * T) * normalPdf(d1) * sqrtT;
  const vomma = (vega * d1 * d2) / sigma;
  const d3 = (vega * ((d1 * d2) ** 2 - (d1 * d1 + d2 * d2) - d1 * d2)) / (sigma * sigma);
  return {
    // Unchecked: `impliedVolatility` validated type, price, spot, strike, time, rate and yield at
    // its boundary, and this runs once per Newton/Halley/Householder iteration. Routing it through
    // the guarded facade re-checked six fields per iteration for no added safety.
    f:
      blackScholesPriceUnchecked({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
      }) - target,
    df: vega,
    d2f: vomma,
    d3f: d3,
  };
}

function manasterKollerSeed(input: {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
}): number {
  const { spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q } = input;
  const F = S * Math.exp((r - q) * T);
  const guess = Math.sqrt(Math.abs(2 * Math.log(F / K)) / T);
  return Number.isFinite(guess) && guess > 1e-3 ? guess : 0.2;
}

function assumptions(t: number, q: number): Assumptions {
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    timeToExpiryYears: t,
    dividendModel: q === 0 ? 'none' : 'continuousYield',
    units: DEFAULT_GREEK_UNITS,
    model: MODEL,
    engine: MODEL,
  };
}

function fail(
  t: number,
  q: number,
  code: string,
  message: string,
  extra: QuantWarning[] = [],
): ImpliedVolatilitySolveResult {
  return {
    value: null,
    assumptions: assumptions(t, q),
    diagnostics: {
      engine: MODEL,
      method: 'none',
      converged: false,
      iterations: 0,
      fallback: false,
      // Suspicious-input warnings ride even the no-arbitrage failures: a `t` given in days is the
      // most likely reason a "price below intrinsic" rejection is spurious.
      warnings: [{ code, message, severity: 'error' }, ...extra],
    },
  };
}

/**
 * Solve BSM implied volatility with the chosen method, reporting rich diagnostics — quantitative
 * failure (price outside no-arbitrage bounds, no convergence) reports `converged: false` with the
 * reason, never a fabricated vol.
 *
 * @example
 * ```ts
 * import { impliedVolatility } from '@insiderfinance/totalfinance/options';
 *
 * const solved = impliedVolatility({
 *   price: 2.31, spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, type: 'call',
 * });
 * solved.value;                 // 0.2199… (annualized volatility)
 * solved.diagnostics.converged; // true — ALWAYS check before trusting the value
 * solved.diagnostics.method;    // which solver actually ran ('brent', 'newton', …)
 * ```
 */
export function impliedVolatility(
  input: BlackScholesImpliedVolatilityInput,
  options: ImpliedVolatilityOptions = {},
): ImpliedVolatilitySolveResult {
  requireArgumentObject('impliedVolatility', 'input', input);
  for (const flag of ['failFast', 'extendedGreeks', 'greeks'] as const) {
    const flagValue = (input as unknown as Record<string, unknown>)[flag];
    if (flagValue !== undefined && typeof flagValue !== 'boolean') {
      throw new InputError(
        `impliedVolatility: ${flag} must be a boolean when provided. Received ${flagValue === null ? 'null' : typeof flagValue}.`,
        { code: ErrorCode.InputWrongType, context: { field: flag } },
      );
    }
  }

  // Law 12: a misspelled field must teach, never silently solve against a default.
  ensureKnownKeys('impliedVolatility', 'input', input, IMPLIED_VOL_INPUT_KEYS);
  // `null` (or a primitive) slips past `options = {}` — teach, never TypeError on `options.method`.
  requireOptionalArgObject('impliedVolatility', 'options', options);
  ensureKnownKeys('impliedVolatility', 'options', options, IMPLIED_VOL_OPTIONS_KEYS);
  requireIvOptionLadders('impliedVolatility', options as unknown as Record<string, unknown>);
  // `type: 'Call'` must teach, not silently invert the other leg (design law #4).
  ensureEnum(input.type, ['call', 'put'] as const, 'type', 'impliedVolatility');
  ensurePositive(input.price, 'price', 'impliedVolatility');
  ensurePositive(input.spot, 'spot', 'impliedVolatility', ErrorCode.InputNegativeSpot);
  ensurePositive(input.strike, 'strike', 'impliedVolatility', ErrorCode.InputNegativeStrike);
  ensurePositive(
    input.timeToExpiryYears,
    'timeToExpiryYears',
    'impliedVolatility',
    ErrorCode.InputNegativeTime,
  );
  ensureFinite(input.riskFreeRate, 'riskFreeRate', 'impliedVolatility');
  // Null is a wrong-typed value, not omission (the 350c2796 ruling): it used to coalesce
  // to 0 BEFORE the finite check and silently price a dividend-free underlying.
  ensureFiniteWhenPresent(input.dividendYield, 'dividendYield', 'impliedVolatility');
  const q = input.dividendYield ?? 0;

  // Same suspicious-input teaching as the pricing path: a `t` like 30 (days, not a 30-year horizon)
  // silently solves the wrong IV, so flag it. `vol` is the unknown being solved, so only `t` applies.
  // Computed up front so it rides the no-arbitrage failure paths too, not just a converged solve.
  const suspicious = plausibilityWarnings({
    timeToExpiryYears: input.timeToExpiryYears,
    riskFreeRate: input.riskFreeRate,
  });

  const { type, price, spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r } = input;
  const { lower, upper } = blackScholesPriceBounds({
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
  });
  if (price < lower - priceBoundSlack(lower)) {
    return fail(
      T,
      q,
      ErrorCode.ImpliedVolatilityBelowIntrinsic,
      'price is below intrinsic value',
      suspicious,
    );
  }
  // Same bound rule as the kernel: the upper bound is the σ→∞ supremum, so a price AT it has no
  // volatility (every large σ reproduces it) — all methods must reject it identically.
  if (price >= upper - priceBoundSlack(upper)) {
    return fail(
      T,
      q,
      ErrorCode.ImpliedVolatilityAboveMax,
      'price is at or above the no-arbitrage upper bound',
      suspicious,
    );
  }

  const method = options.method ?? 'auto';
  const fallbackEnabled = options.fallback ?? true;
  const warnings: QuantWarning[] = [...suspicious];

  const derivFn = (sigma: number): Derivatives =>
    impliedVolatilityDerivatives({
      type,
      targetPrice: price,
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
    });
  const seed = manasterKollerSeed({
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
  });
  const tolOpts = {
    stepTolerance: 1e-12,
    // RELATIVE to the target (like the kernel's endpoint tolerance): `1e-12·max(1, price)` is an
    // ABSOLUTE 1e-12 for every sub-dollar premium, which declares victory at the first trial σ for a
    // 1e-16 target — any σ "matches" it. Floored only at the IEEE-754 limit.
    residualTolerance: Math.max(1e-12 * price, Number.MIN_VALUE),
    maximumIterations: 60,
  };

  const runBrent = (): {
    value: number;
    converged: boolean;
    iterations: number;
    reason?: ImpliedVolatilityReason;
  } => {
    const res = blackScholesImpliedVolatility({
      type,
      price,
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
    });
    return {
      value: res.value,
      converged: res.converged,
      iterations: res.iterations,
      ...(res.reason !== undefined ? { reason: res.reason } : {}),
    };
  };

  /**
   * The module's failure grammar (Law 2): a non-converged solve ALWAYS carries an error-severity
   * warning naming why. The Brent kernel knows the reason — pass it through instead of flattening
   * every bracketed failure into a bare non-convergence.
   */
  const brentFailure = (reason: ImpliedVolatilityReason | undefined): QuantWarning => {
    switch (reason) {
      case 'below_intrinsic':
        return {
          code: ErrorCode.ImpliedVolatilityBelowIntrinsic,
          message: 'brent: price is below intrinsic value',
          severity: 'error',
        };
      case 'above_max_bound':
        return {
          code: ErrorCode.ImpliedVolatilityAboveMax,
          message: 'brent: price is at or above the no-arbitrage upper bound',
          severity: 'error',
        };
      case 'price_below_resolvable':
        return {
          code: ErrorCode.ImpliedVolatilityPriceBelowResolvable,
          message:
            'brent: price is below the smallest premium this model can resolve to a volatility',
          severity: 'error',
        };
      default:
        return {
          code: ErrorCode.ImpliedVolatilityNoConvergence,
          message: `brent did not converge${reason === undefined ? '' : ` (${reason})`}`,
          severity: 'error',
        };
    }
  };

  let value = NaN;
  let converged = false;
  let iterations = 0;
  let usedMethod: string = method;
  let fellBack = false;

  const acceptable = (v: number): boolean =>
    Number.isFinite(v) &&
    v > 0 &&
    Math.abs(
      // Unchecked for the same reason: acceptance runs per candidate root, behind that same boundary.
      blackScholesPriceUnchecked({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
        volatility: v,
      }) - price,
    ) <=
      // Relative to the target for the same reason as `residualTolerance` above: an absolute floor
      // accepts any σ once the price is small enough.
      Math.max(1e-7 * price, Number.MIN_VALUE);

  if (method === 'brent') {
    const res = runBrent();
    value = res.value;
    converged = res.converged && acceptable(res.value);
    iterations = res.iterations;
    usedMethod = 'brent';
    // Law 2: the brent path owes the same error-severity warning every other path pushes — without
    // it a failed solve returned `value: null` with an EMPTY warning list and no reason at all.
    if (!converged) warnings.push(brentFailure(res.reason));
  } else {
    const res =
      method === 'newton'
        ? newton(derivFn, seed, tolOpts)
        : method === 'halley'
          ? halley(derivFn, seed, tolOpts)
          : householder(derivFn, seed, tolOpts);
    usedMethod = method === 'auto' ? 'householder' : method;
    if (res.converged && acceptable(res.value)) {
      value = res.value;
      converged = true;
      iterations = res.iterations;
    } else if (fallbackEnabled) {
      const fb = runBrent();
      value = fb.value;
      converged = fb.converged && acceptable(fb.value);
      iterations = res.iterations + fb.iterations;
      usedMethod = 'brent';
      fellBack = true;
      warnings.push({
        code: ErrorCode.ImpliedVolatilityNoConvergence,
        message: `${method} did not converge; fell back to brent`,
        severity: 'info',
      });
      // When the fallback ALSO fails, the info warning above is not a failure report — say why.
      if (!converged) warnings.push(brentFailure(fb.reason));
    } else {
      value = NaN;
      converged = false;
      iterations = res.iterations;
      warnings.push({
        code: ErrorCode.ImpliedVolatilityNoConvergence,
        message: `${method} did not converge and fallback is disabled`,
        severity: 'error',
      });
    }
  }

  if (converged) {
    const deriv = derivFn(value);
    // Vega is per 1.00 of σ. For a normally-conditioned option it is O(0.1·S)…; a value this small
    // means a tiny price change implies a large IV change (ill-conditioned inverse).
    if ((deriv.df ?? 0) < 1e-4 * S) {
      warnings.push({
        code: WarningCode.ImpliedVolatilityLowVega,
        message: 'vega is near zero; the implied volatility is ill-conditioned',
        severity: 'warn',
        context: { vega: deriv.df },
      });
    }
  }

  return {
    // Law 7 / E3: a failed solve is `null` (the reason rides diagnostics), never a NaN "value".
    value: converged ? value : null,
    assumptions: assumptions(T, q),
    diagnostics: {
      engine: MODEL,
      method: usedMethod,
      converged,
      iterations,
      fallback: fellBack,
      warnings,
    },
  };
}

/**
 * The batch IV report (Law 2 report grammar): one solve envelope per input row, plus batch-level
 * `assumptions` (shared conventions, row count) and `diagnostics` (a summary warning when any row
 * failed — the per-row reason stays on `results[i].diagnostics`).
 */
export interface ImpliedVolatilityBatchResult {
  /** One solve envelope per input row, in input order. */
  results: ImpliedVolatilitySolveResult[];
  /** Applied conventions, echoed (per-row `timeToExpiryYears` rides each row's own assumptions). */
  assumptions: Assumptions<{ rows: number }>;
  /** Batch diagnostics: `converged` is true iff EVERY row converged. */
  diagnostics: {
    engine: string;
    method: string;
    converged: boolean;
    warnings: QuantWarning[];
  };
}

/**
 * Batch implied volatility with per-row diagnostics on `results`. A bad row yields a non-converged
 * row result rather than aborting the chain — unless `failFast` is set.
 */
export function impliedVolatilityMany(
  rows: BlackScholesImpliedVolatilityInput[],
  options: ImpliedVolatilityOptions = {},
): ImpliedVolatilityBatchResult {
  requireArgumentArray('impliedVolatilityMany', 'rows', rows);
  // Validate the SHARED options at the batch entry (Law 12): a bogus key must reject here — inside
  // the per-row try/catch it would be swallowed into "every row failed" instead of teaching.
  requireOptionalArgObject('impliedVolatilityMany', 'options', options);
  ensureKnownKeys('impliedVolatilityMany', 'options', options, IMPLIED_VOL_OPTIONS_KEYS);
  requireIvOptionLadders('impliedVolatilityMany', options as unknown as Record<string, unknown>);
  for (const flag of ['failFast', 'extendedGreeks', 'greeks'] as const) {
    const flagValue = (options as unknown as Record<string, unknown>)[flag];
    if (flagValue !== undefined && typeof flagValue !== 'boolean') {
      throw new InputError(
        `impliedVolatilityMany: ${flag} must be a boolean when provided. Received ${flagValue === null ? 'null' : typeof flagValue}.`,
        { code: ErrorCode.InputWrongType, context: { field: flag } },
      );
    }
  }

  const results = rows.map((row) => {
    try {
      return impliedVolatility(row, options);
    } catch (error) {
      if (options.failFast) throw error;
      // The recovery path must survive ANY bad row — `null`/garbage included — so it never touches
      // `row` without a shape check (the doc's promise: a bad row yields a non-converged result, it
      // does not abort the chain). The original typed code is preserved so callers can still branch
      // on WHY the row failed (e.g. `input.negative_spot`) instead of a flattened out-of-range.
      const shaped = row !== null && typeof row === 'object';
      const t = shaped && typeof row.timeToExpiryYears === 'number' ? row.timeToExpiryYears : NaN;
      const q = shaped && typeof row.dividendYield === 'number' ? row.dividendYield : 0;
      const code = isQuantError(error) ? error.code : ErrorCode.InputOutOfRange;
      const message = error instanceof Error ? error.message : 'invalid row';
      return fail(t, q, code, message);
    }
  });
  const failed = results.filter((r) => !r.diagnostics.converged).length;
  return {
    results,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      model: MODEL,
      engine: MODEL,
      rows: rows.length,
    },
    diagnostics: {
      engine: MODEL,
      method: 'per-row',
      converged: failed === 0,
      warnings:
        failed === 0
          ? []
          : [
              {
                code: ErrorCode.ImpliedVolatilityNoConvergence,
                message: `${failed} of ${rows.length} rows did not converge — see results[i].diagnostics for the per-row reason`,
                severity: 'warn',
              },
            ],
    },
  };
}
