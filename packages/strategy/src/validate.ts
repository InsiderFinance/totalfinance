/**
 * Input-shape guards for the named strategy builders (design law #4 / the first-touch law).
 *
 * A builder dereferences named slots off its input object (`input.putLong.strike`, …). A wrong but
 * reasonable guess (`ironCondor({ putLongStrike: 540 })`) would otherwise crash with a raw
 * `TypeError: Cannot read properties of undefined` from deep in the build path. These guards run
 * FIRST and throw the teaching `wrongShapeError`, which echoes the expected slots and the keys the
 * caller actually passed — turning the error into documentation of the right shape.
 */

import {
  ErrorCode,
  InputError,
  isQuantError,
  optionExpiryToMs,
  wrongShapeError,
} from '@totalfinance/core';
import { classifyStrategy } from './classify.js';
import type { LegInput, PositionConfig } from './types.js';

/**
 * A distinct-strike builder slot (R3): a bare strike number, or `{ strike, premium? }`. A bare
 * number means "strike only" — the premium is supplied later or model-priced via
 * `{ premiums: 'model', market }`. Legs sharing one strike use `{ strike, callPremium?,
 * putPremium? }` instead (the shared-strike rule).
 */
export type Role = number | { strike: number; premium?: number };

/** Normalize a {@link Role} slot to `{ strike, premium? }`, teaching the shape on garbage. */
export function roleLeg(
  role: Role | undefined,
  functionName: string,
  slot: string,
): { strike: number; premium?: number } {
  if (typeof role === 'number') return { strike: role };
  if (
    role !== null &&
    typeof role === 'object' &&
    typeof (role as { strike?: unknown }).strike === 'number'
  ) {
    return role as { strike: number; premium?: number };
  }
  throw new InputError(
    `${functionName}: ${slot} must be a strike number or { strike, premium? }, got ${JSON.stringify(role)}.`,
    { code: ErrorCode.InputWrongType, context: { slot, received: role } },
  );
}

/**
 * Route a builder input's `expiry` to the position config (R4): every named builder accepts
 * `expiry` in its input object, and the Position materializes it onto legs that lack their own.
 * The input's expiry wins over a `config.expiry` (it is the more local statement).
 */
export function routeExpiry(
  expiry: string | undefined,
  config: PositionConfig | undefined,
): PositionConfig | undefined {
  return expiry === undefined ? config : { ...config, expiry };
}

/** Validate an optional market expiry even when the caller's selected branch will not consume it. */
export function ensureOptionalMarketExpiry(
  value: unknown,
  functionName: string,
  field = 'market.expiry',
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(
      `${functionName}: ${field} must be a YYYY-MM-DD date or zoned ISO datetime string when provided. Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {
          function: functionName,
          field,
          received: value === null ? 'null' : typeof value,
        },
      },
    );
  }
  try {
    optionExpiryToMs(value);
  } catch (cause) {
    throw new InputError(
      `${functionName}: ${field} must be a real YYYY-MM-DD date or zoned ISO datetime. Received ${JSON.stringify(value)}.`,
      {
        code: isQuantError(cause) ? cause.code : ErrorCode.InputOutOfRange,
        context: { function: functionName, field, received: value },
        cause,
      },
    );
  }
}

/**
 * Throw a teaching error unless `input` is an object carrying every `requiredSlots` key. `shape` is a
 * human-readable description of the full expected input, shown verbatim in the message.
 */
export function validateSlots(
  input: unknown,
  requiredSlots: readonly string[],
  functionName: string,
  shape: string,
): void {
  if (input === null || typeof input !== 'object') {
    throw wrongShapeError(functionName, shape, input);
  }
  const obj = input as Record<string, unknown>;
  if (requiredSlots.some((k) => obj[k] === undefined)) {
    throw wrongShapeError(functionName, shape, input);
  }
}

/** One role slot of a builder, paired with the strike the caller actually put in it. */
export interface OrderedRole {
  /** The input field name, e.g. `putShort`. */
  slot: string;
  strike: number;
}

/**
 * Re-entrancy guard for {@link ensureAscendingRoles}'s did-you-mean hint. The hint classifies the
 * as-passed legs, and the classifier builds EVERY catalog example on first use — which runs these
 * same builders. The catalog examples are all correctly ordered so they never violate, but the flag
 * makes the recursion structurally impossible rather than merely unlikely.
 */
let deriving = false;

/**
 * Name the builder whose shape the caller's legs ACTUALLY match, derived structurally (never
 * guessed): `ironCondor` with all four strikes mirrored is a textbook `inverseIronCondor`, and the
 * error should say so. Returns `''` when the legs match nothing else — a plain ordering mistake.
 */
function alternativeHint(functionName: string, asPassedLegs: readonly LegInput[]): string {
  if (deriving) return '';
  const self = functionName.slice(functionName.lastIndexOf('.') + 1);
  deriving = true;
  try {
    const other = classifyStrategy(asPassedLegs)
      .matches.map((m) => m.name)
      .filter((name) => name !== self);
    if (other.length === 0) return '';
    return ` Those legs ARE a valid ${other[0]} — did you want strategy.${other[0]}(…)?`;
  } catch {
    return ''; // a hint is a courtesy; never let it mask the ordering error
  } finally {
    deriving = false;
  }
}

/**
 * Enforce a builder's DOCUMENTED strike ordering (`putLong < putShort < callShort < callLong`,
 * `lower < middle < upper`, `k1 < k2 < k3 < k4`, …).
 *
 * These orderings were documented preconditions that nothing checked, so violating one built a
 * DIFFERENT structure under the requested name: `ironCondor` with the put strikes swapped silently
 * produced a debit inverse condor still stamped `constructedAs: 'ironCondor'`, and every downstream
 * number (net debit, max loss, margin, classification) described a position the caller never asked
 * for. `roles` is the builder's slot list in the order the docs promise; the error names the
 * violated pair, echoes what was passed, and — when the legs happen to match another catalog
 * builder — names that builder.
 */
export function ensureAscendingRoles(
  functionName: string,
  roles: readonly OrderedRole[],
  asPassedLegs: readonly LegInput[],
): void {
  for (let i = 1; i < roles.length; i++) {
    const lower = roles[i - 1]!;
    const upper = roles[i]!;
    if (lower.strike < upper.strike) continue;
    const expected = roles.map((r) => r.slot).join(' < ');
    const received = roles.map((r) => `${r.slot}: ${r.strike}`).join(', ');
    const relation = lower.strike === upper.strike ? 'equals' : 'is above';
    throw new InputError(
      `${functionName}: strikes must be ascending (${expected}), but ${lower.slot} (${lower.strike}) ` +
        `${relation} ${upper.slot} (${upper.strike}). Received ${received}.` +
        alternativeHint(functionName, asPassedLegs),
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          expected,
          violated: { lower: lower.slot, upper: upper.slot },
          received: Object.fromEntries(roles.map((r) => [r.slot, r.strike])),
        },
      },
    );
  }
}

/**
 * Reject a known-retired key with a message that teaches the replacement — silently ignoring it
 * (the input passes `validateSlots` on the new required keys) would be the worst failure mode.
 */
export function rejectRetiredKey(
  input: object,
  key: string,
  functionName: string,
  teach: string,
): void {
  if (key in input) {
    throw new InputError(`${functionName}: \`${key}\` is not an input — ${teach}`, {
      code: ErrorCode.InputWrongType,
      context: { key },
    });
  }
}
