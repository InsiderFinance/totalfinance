/**
 * The vanilla-intrinsic kernel — the ONE source of truth for `max(S − K, 0)` / `max(K − S, 0)`
 * (platform roadmap, "One small primitive gap is worth closing").
 *
 * The same tiny formula used to be written inline in the option engines, the exercise analytics, and
 * the American IV boundary. Each copy was correct, and each copy was a place the next edit could make
 * them disagree. They now all route here.
 */

import type { OptionType } from '@totalfinance/core';

/** Input for {@link vanillaIntrinsicUnchecked} and the public `vanillaIntrinsic`. */
export interface VanillaIntrinsicInput {
  /** Which leg — `'call'` or `'put'`. */
  type: OptionType;
  /** The underlying's price per unit, in the same currency unit as `strike`. */
  underlyingPrice: number;
  /** The option's strike price per unit. */
  strike: number;
}

/**
 * The unchecked kernel: pure arithmetic, no validation.
 *
 * It exists so validation can live at the boundary WITHOUT being paid per node: the lattice engines
 * evaluate this at every terminal (and, for American exercise, interior) node, and the FDM engine at
 * every grid point — loops whose inputs were validated once at their own boundary. It also preserves
 * those interior sites' exact semantics: a non-finite node value (an overflowed `u^n`) propagates as
 * arithmetic, never as a thrown validation error the site did not have before.
 *
 * @internal PACKAGE-private, mirroring `blackScholesPriceUnchecked`: this module is deliberately not
 * a package subpath and the index does not re-export it, so it never reaches the public surface or
 * the API report. Every caller must have validated (or arithmetically produced) its inputs already.
 */
export function vanillaIntrinsicUnchecked(input: VanillaIntrinsicInput): number {
  return input.type === 'call'
    ? Math.max(input.underlyingPrice - input.strike, 0)
    : Math.max(input.strike - input.underlyingPrice, 0);
}
