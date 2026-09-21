/** Shared facade plumbing: a callable paired with its `.explain()` companion (design law #1, §5.1). */

import {
  ArbitrageError,
  CONVENTIONS_VERSION,
  type Assumptions,
  type Computed,
  ConvergenceError,
  DEFAULT_GREEK_UNITS,
  type DividendModel,
  ErrorCode,
  type Facade,
  type GreekUnits,
  facade,
  requireArgumentObject,
  type Diagnostics,
  WarningCode,
  warning,
} from '@totalfinance/core';

// `facade()` / `Facade` now live in @totalfinance/core (DX1.1) so every package builds scalar facades the
// same way. Re-exported here so the options modules' existing `./facade-util.js` imports are unchanged.
export { facade };
export type { Facade };

/**
 * Guard an OPTIONAL trailing options object (the first-touch law, dx §7.1): `undefined` means
 * "omitted" and the defaults apply, but anything else must be an object of named fields. `null`, a
 * string, or a number slips past an `options = {}` default parameter and would surface as a raw
 * `TypeError` on the first property read — it must teach instead.
 */
export function requireOptionalArgObject(
  functionName: string,
  field: string,
  value: unknown,
): void {
  if (value !== undefined) requireArgumentObject(functionName, field, value);
}

/**
 * Build the {@link Assumptions} disclosure shared by the closed-form analytic pricers
 * (Black–Scholes, Black-76, Bachelier). They all use `ACT/365F` day-count, continuous compounding,
 * and the same `conventionsVersion`; only the model name, Greek units, time-to-expiry, and dividend
 * model vary. `units` defaults to {@link DEFAULT_GREEK_UNITS} and `dividendModel` to `'none'`, and
 * `engine` mirrors `model` for these single-engine facades.
 */
export function analyticAssumptions(parameters: {
  model: string;
  timeToExpiryYears: number;
  units?: GreekUnits;
  dividendModel?: DividendModel;
}): Assumptions {
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    timeToExpiryYears: parameters.timeToExpiryYears,
    dividendModel: parameters.dividendModel ?? 'none',
    units: parameters.units ?? DEFAULT_GREEK_UNITS,
    model: parameters.model,
    engine: parameters.model,
  };
}

/**
 * Pair an implied-vol `explain` solver with its throwing facade form. When the solve converges the
 * value is returned; otherwise the mapped failure code is thrown as an {@link ArbitrageError} if it
 * is in `arbitrageCodes` (a no-arbitrage violation), else as a {@link ConvergenceError}.
 *
 * `arbitrageCodes` is explicit because it differs by model: log-normal models (Black–Scholes,
 * Black-76) treat both the intrinsic floor (`ImpliedVolatilityBelowIntrinsic`) and the upper price bound
 * (`ImpliedVolatilityAboveMax`) as arbitrage, whereas Bachelier (normal vol) has no analogous upper-bound arbitrage
 * and passes only `[ImpliedVolatilityBelowIntrinsic]`.
 */
export function impliedVolatilityFacadePair<Input>(
  label: string,
  explain: (input: Input) => Computed<number | null>,
  arbitrageCodes: readonly string[],
  fallbackMessage: string,
): Facade<Input, number, Record<never, never>, number | null> {
  const call = (input: Input): number => {
    const result = explain(input);
    if (result.diagnostics.converged && result.value !== null) return result.value;
    const reason = result.diagnostics.warnings[0];
    const code = reason?.code ?? ErrorCode.ImpliedVolatilityNoConvergence;
    const message = reason?.message ?? fallbackMessage;
    if (arbitrageCodes.includes(code)) {
      throw new ArbitrageError(message, { code, context: { input } });
    }
    throw new ConvergenceError(message, { code, context: { input } });
  };
  return facade(label, call, explain);
}

/**
 * Law 4 disclosure: a closed-form price that came back EXACTLY zero did not "cost nothing" — under
 * BSM/Black-76 a positive σ and T always give a strictly positive premium, so a 0 is the IEEE-754
 * floor swallowing it (deep OTM, `d2 ≈ −40`). The number is the best `double` available and the
 * envelope stays converged; the info warning is what stops it from being read as a quoted zero, and
 * it is also the reason the inverse (implied volatility) has nothing to solve at that price.
 */
export function withUnderflowDisclosure(diagnostics: Diagnostics, value: number): Diagnostics {
  if (value !== 0) return diagnostics;
  return {
    ...diagnostics,
    warnings: [
      ...diagnostics.warnings,
      warning(
        WarningCode.ModelLimitation,
        'the option price underflowed to exactly 0 — the true premium is positive but below the smallest representable double, so Greeks and any implied-volatility inversion here are not meaningful.',
        'info',
      ),
    ],
  };
}

/**
 * Law 7 disclosure: when the elasticity Λ = Δ·S/V is `null` (price underflowed to zero), the
 * explained envelope says so — an undefined quantity is never a silent hole.
 */
export function withLambdaDisclosure(
  diagnostics: Diagnostics,
  greeks: { lambda: number | null },
): Diagnostics {
  if (greeks.lambda !== null) return diagnostics;
  return {
    ...diagnostics,
    warnings: [
      ...diagnostics.warnings,
      warning(
        WarningCode.LambdaUndefined,
        'lambda (elasticity Δ·S/V) is undefined — the option price underflowed to zero; reported as null, never NaN/Infinity.',
        'info',
      ),
    ],
  };
}
