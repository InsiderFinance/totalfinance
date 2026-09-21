/**
 * Named strategy builders (spec §12.4), in the one builder grammar (R3):
 *
 * - a distinct-strike slot is a {@link Role} — a bare strike number or `{ strike, premium? }`
 *   (`ironCondor({ putLong: 540, ... })` and `ironCondor({ putLong: { strike: 540, premium: 3.4 },
 *   ... })` are the same call, one with premiums);
 * - legs sharing one strike take `{ strike, callPremium?, putPremium? }` (the shared-strike rule);
 * - every builder accepts `expiry` (R4), routed to the position so its legs remember when they
 *   expire; premiums may be omitted entirely with `{ premiums: 'model', market }`.
 */

import { legs } from './legs.js';
import { Position } from './position.js';
import type { PositionConfig } from './types.js';
import {
  type Role,
  ensureAscendingRoles,
  rejectRetiredKey,
  roleLeg,
  routeExpiry,
  validateSlots,
} from './validate.js';

const VERTICAL_SLOTS = ['long', 'short'] as const;
const VERTICAL_SHAPE =
  '{ long: strike | { strike, premium? }, short: strike | { strike, premium? }, quantity?, expiry? }';

export interface VerticalInput {
  /** The bought leg: a strike, or `{ strike, premium? }`. */
  long: Role;
  /** The sold leg: a strike, or `{ strike, premium? }`. */
  short: Role;
  quantity?: number;
  /** Expiry applied to both legs (R4). */
  expiry?: string;
}

export interface StraddleInput {
  /** The shared strike (shared-strike rule: premiums are named per option type). */
  strike: number;
  callPremium?: number;
  putPremium?: number;
  quantity?: number;
  expiry?: string;
}

export interface StrangleInput {
  /** The call leg: a strike, or `{ strike, premium? }`. */
  call: Role;
  /** The put leg: a strike, or `{ strike, premium? }`. */
  put: Role;
  quantity?: number;
  expiry?: string;
}

/** Four ascending roles: long put wing < short put < short call < long call wing. */
export interface IronCondorInput {
  putLong: Role;
  putShort: Role;
  callShort: Role;
  callLong: Role;
  quantity?: number;
  expiry?: string;
}

const CONDOR_SLOTS = ['putLong', 'putShort', 'callShort', 'callLong'] as const;
const CONDOR_SHAPE =
  '{ putLong: strike | { strike, premium? }, putShort: …, callShort: …, callLong: …, quantity?, expiry? }';

function vertical(
  functionName: string,
  input: VerticalInput,
  config: PositionConfig | undefined,
  /** The two slots in the ASCENDING order this vertical documents (R3 ordering precondition). */
  ascending: readonly ['long' | 'short', 'long' | 'short'],
  make: (
    long: { strike: number; premium?: number },
    short: { strike: number; premium?: number },
    q: number,
  ) => ReturnType<(typeof legs)['call']>[],
): Position {
  validateSlots(input, VERTICAL_SLOTS, functionName, VERTICAL_SHAPE);
  rejectRetiredKey(
    input,
    'longStrike',
    functionName,
    `pass long: ${JSON.stringify((input as unknown as Record<string, unknown>)['longStrike'])} (or long: { strike, premium }).`,
  );
  const q = input.quantity ?? 1;
  const long = roleLeg(input.long, functionName, 'long');
  const short = roleLeg(input.short, functionName, 'short');
  const built = make(long, short, q);
  ensureAscendingRoles(
    functionName,
    ascending.map((slot) => ({ slot, strike: slot === 'long' ? long.strike : short.strike })),
    built,
  );
  return new Position(built, routeExpiry(input.expiry, config));
}

/** Bull call spread: long lower-strike call, short higher-strike call (debit). */
export function bullCallSpread(input: VerticalInput, config?: PositionConfig): Position {
  return vertical('strategy.bullCallSpread', input, config, ['long', 'short'], (long, short, q) => [
    legs.call({ ...long, quantity: q }),
    legs.call({ ...short, quantity: -q }),
  ]);
}

/** Bear call spread: short lower-strike call, long higher-strike call (credit). */
export function bearCallSpread(input: VerticalInput, config?: PositionConfig): Position {
  return vertical('strategy.bearCallSpread', input, config, ['short', 'long'], (long, short, q) => [
    legs.call({ ...short, quantity: -q }),
    legs.call({ ...long, quantity: q }),
  ]);
}

/** Bull put spread: short higher-strike put, long lower-strike put (credit). */
export function bullPutSpread(input: VerticalInput, config?: PositionConfig): Position {
  return vertical('strategy.bullPutSpread', input, config, ['long', 'short'], (long, short, q) => [
    legs.put({ ...short, quantity: -q }),
    legs.put({ ...long, quantity: q }),
  ]);
}

/** Bear put spread: long higher-strike put, short lower-strike put (debit). */
export function bearPutSpread(input: VerticalInput, config?: PositionConfig): Position {
  return vertical('strategy.bearPutSpread', input, config, ['short', 'long'], (long, short, q) => [
    legs.put({ ...long, quantity: q }),
    legs.put({ ...short, quantity: -q }),
  ]);
}

/** Long straddle: long call + long put at the same strike. */
export function straddle(input: StraddleInput, config?: PositionConfig): Position {
  validateSlots(
    input,
    ['strike'],
    'strategy.straddle',
    '{ strike, callPremium?, putPremium?, quantity?, expiry? }',
  );
  const q = input.quantity ?? 1;
  return new Position(
    [
      legs.call({ strike: input.strike, premium: input.callPremium, quantity: q }),
      legs.put({ strike: input.strike, premium: input.putPremium, quantity: q }),
    ],
    routeExpiry(input.expiry, config),
  );
}

/** Long strangle: long OTM call + long OTM put. */
export function strangle(input: StrangleInput, config?: PositionConfig): Position {
  const functionName = 'strategy.strangle';
  validateSlots(
    input,
    ['call', 'put'],
    functionName,
    '{ call: strike | { strike, premium? }, put: strike | { strike, premium? }, quantity?, expiry? }',
  );
  rejectRetiredKey(
    input,
    'callStrike',
    functionName,
    `pass call: ${JSON.stringify((input as unknown as Record<string, unknown>)['callStrike'])} (or call: { strike, premium }).`,
  );
  const q = input.quantity ?? 1;
  const call = roleLeg(input.call, functionName, 'call');
  const put = roleLeg(input.put, functionName, 'put');
  const built = [legs.call({ ...call, quantity: q }), legs.put({ ...put, quantity: q })];
  // A strangle is OTM call + OTM put ⇒ put strike below call strike. Inverted, it is a `guts`
  // (both legs ITM) — a different structure with a different payoff, not a strangle.
  ensureAscendingRoles(
    functionName,
    [
      { slot: 'put', strike: put.strike },
      { slot: 'call', strike: call.strike },
    ],
    built,
  );
  return new Position(built, routeExpiry(input.expiry, config));
}

/** Iron condor: short put spread + short call spread. */
export function ironCondor(input: IronCondorInput, config?: PositionConfig): Position {
  const functionName = 'strategy.ironCondor';
  validateSlots(input, CONDOR_SLOTS, functionName, CONDOR_SHAPE);
  rejectRetiredKey(
    input,
    'premiums',
    functionName,
    "premiums live on each leg: putLong: { strike: 540, premium: 3.4 } — or omit them and pass { premiums: 'model', market } in the config.",
  );
  const q = input.quantity ?? 1;
  const putLong = roleLeg(input.putLong, functionName, 'putLong');
  const putShort = roleLeg(input.putShort, functionName, 'putShort');
  const callShort = roleLeg(input.callShort, functionName, 'callShort');
  const callLong = roleLeg(input.callLong, functionName, 'callLong');
  const built = [
    legs.put({ ...putLong, quantity: q }),
    legs.put({ ...putShort, quantity: -q }),
    legs.call({ ...callShort, quantity: -q }),
    legs.call({ ...callLong, quantity: q }),
  ];
  ensureAscendingRoles(functionName, condorRoles(putLong, putShort, callShort, callLong), built);
  return new Position(built, routeExpiry(input.expiry, config));
}

/** The four ascending condor roles, shared by `ironCondor` and `inverseIronCondor` (one grammar). */
export function condorRoles(
  putLong: { strike: number },
  putShort: { strike: number },
  callShort: { strike: number },
  callLong: { strike: number },
): { slot: string; strike: number }[] {
  return [
    { slot: 'putLong', strike: putLong.strike },
    { slot: 'putShort', strike: putShort.strike },
    { slot: 'callShort', strike: callShort.strike },
    { slot: 'callLong', strike: callLong.strike },
  ];
}
