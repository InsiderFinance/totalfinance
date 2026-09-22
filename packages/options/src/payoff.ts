/**
 * `@insiderfinance/totalfinance/options/payoff` — expiration payoff primitives.
 *
 * One deliberately small module (platform roadmap, "One small primitive gap is worth closing"): the
 * standalone vanilla intrinsic value. Its semantics are closed and not overloaded —
 *
 * - it returns the **gross intrinsic value per unit**, not P&L;
 * - it accepts no premium, quantity, multiplier, probability, volatility, or time — an unknown key
 *   teaches (Law 12) instead of being silently ignored;
 * - single-contract and multi-leg P&L stay where they live today: `Position.pnlAtExpiry` and
 *   `Position.payoff` in `@insiderfinance/totalfinance/strategy`.
 */

import {
  ErrorCode,
  ensureEnum,
  ensureKnownKeys,
  ensureNonNegative,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import { vanillaIntrinsicUnchecked, type VanillaIntrinsicInput } from './payoff-kernel.js';

const OPTION_TYPES = ['call', 'put'] as const;

const VANILLA_INTRINSIC_FIELDS = ['underlyingPrice', 'strike'] as const;

/** Law 12 allowlist: the two price legs plus the `type` discriminant — the field set is CLOSED. */
const VANILLA_INTRINSIC_KEYS = ['type', ...VANILLA_INTRINSIC_FIELDS] as const;

const VANILLA_INTRINSIC_EXAMPLE_CALL =
  "vanillaIntrinsic({ type: 'call', underlyingPrice: 112, strike: 100 })";

const VANILLA_INTRINSIC_HINTS: Record<string, string> = {
  underlyingPrice: 'the underlying price per unit, in the same currency unit as strike',
  strike: 'the strike price per unit, in the same currency unit as underlyingPrice',
};

/**
 * Gross vanilla intrinsic value per unit: `max(underlyingPrice − strike, 0)` for a call,
 * `max(strike − underlyingPrice, 0)` for a put.
 *
 * A plain number out, and nothing else in: no premium (this is not P&L), no quantity or multiplier
 * (per unit), no volatility or time (intrinsic is model-free). `underlyingPrice` and `strike` must be
 * finite and `>= 0` — zero is legal on either leg (a worthless underlying or a zero strike still has
 * a well-defined intrinsic value).
 *
 * @example
 * ```ts
 * import { vanillaIntrinsic } from '@insiderfinance/totalfinance/options/payoff';
 *
 * vanillaIntrinsic({ type: 'call', underlyingPrice: 112, strike: 100 }); // 12
 * vanillaIntrinsic({ type: 'put', underlyingPrice: 88, strike: 100 }); // 12
 * vanillaIntrinsic({ type: 'put', underlyingPrice: 112, strike: 100 }); // 0
 * ```
 */
export function vanillaIntrinsic(input: VanillaIntrinsicInput): number {
  requireArgumentObject('vanillaIntrinsic', 'input', input);
  // Law 12: a `premium`, `quantity`, or `strkie` key must teach, never be silently ignored.
  ensureKnownKeys('vanillaIntrinsic', 'input', input, VANILLA_INTRINSIC_KEYS);
  // A meaning-changing field is never coerced (design law #4): `type: 'Call'` must teach, not
  // silently value the other leg.
  ensureEnum(input.type, OPTION_TYPES, 'type', 'vanillaIntrinsic');
  // PRESENCE before DOMAIN (the facade/kernel parity convention): a missing leg is named as missing,
  // not reported as "not finite".
  requireFiniteFields('vanillaIntrinsic', input, VANILLA_INTRINSIC_FIELDS, {
    exampleCall: VANILLA_INTRINSIC_EXAMPLE_CALL,
    hints: VANILLA_INTRINSIC_HINTS,
  });
  // `>= 0`, not `> 0`: unlike the pricing facades, a zero underlying or strike is a legal input here.
  ensureNonNegative(
    input.underlyingPrice,
    'underlyingPrice',
    'vanillaIntrinsic',
    ErrorCode.InputNegativeSpot,
  );
  ensureNonNegative(input.strike, 'strike', 'vanillaIntrinsic', ErrorCode.InputNegativeStrike);
  return vanillaIntrinsicUnchecked(input);
}

export type { VanillaIntrinsicInput } from './payoff-kernel.js';
