/**
 * Named single-expiry option strategies (spec §12, product parity with the app's option profit
 * calculator). Each builder composes explicit legs into a {@link Position}; premiums/strikes are
 * inputs (data-agnostic and pure — no chain selection). Leg compositions mirror the InsiderFinance
 * OPC so the two stay 1:1. Multi-expiry structures (calendars/diagonals/double diagonals) live in
 * `./calendars.ts`.
 *
 * Every slot guard names its BUILDER (`strategy.bullCallLadder: lower must be …`), never the bare
 * `strategy` namespace — with 50+ builders, the error must say which one was called.
 */

import { ErrorCode, InputError } from '@totalfinance/core';
import { condorRoles, type IronCondorInput } from './builders.js';
import { legs } from './legs.js';
import { Position } from './position.js';
import type { LegInput, PositionConfig } from './types.js';
import { type Role, ensureAscendingRoles, roleLeg, validateSlots } from './validate.js';

/**
 * A strike + optional entry premium for one option leg. Omit `premium` and build the position with
 * `{ premiums: 'model', market }` to have it priced from the market (§3.4) — the profit-calculator
 * user with strikes but no fills still gets breakevens / max P&L / PoP. Everywhere a builder takes
 * a {@link Role} slot, a bare strike number is shorthand for `{ strike }` (R3).
 */
export interface StrikeLeg {
  strike: number;
  premium?: number;
}

/** Unit count + position-level expiry (R4) shared by every builder. */
export interface UnitInput {
  /** Number of structures (default 1). Every leg scales by this. */
  quantity?: number;
  /** Expiry applied to every leg of this structure (`YYYY-MM-DD` → 16:00 ET, or a datetime). */
  expiry?: string;
}

const units = (o: UnitInput): number => o.quantity ?? 1;
const build = (ls: LegInput[], config?: PositionConfig, expiry?: string): Position =>
  new Position(ls, expiry === undefined ? config : { ...config, expiry });

/**
 * Build, then enforce the builder's DOCUMENTED strike ordering before the Position exists.
 *
 * Every ordering below is a precondition the builder's own doc comment states (`lower < middle <
 * upper`, `k1 < k2 < k3 < k4`, "long ITM call (lower strike)", …). They used to be honour-system:
 * violating one produced a structurally DIFFERENT position still stamped with the requested name.
 */
const ordered = (
  functionName: string,
  roles: readonly { slot: string; strike: number }[],
  ls: LegInput[],
  config?: PositionConfig,
  expiry?: string,
): Position => {
  ensureAscendingRoles(functionName, roles, ls);
  return build(ls, config, expiry);
};

/** The three ascending `LadderInput` roles (ladders, broken wings, single-type butterflies). */
const ladderRoles = (
  lower: { strike: number },
  middle: { strike: number },
  upper: { strike: number },
): { slot: string; strike: number }[] => [
  { slot: 'lower', strike: lower.strike },
  { slot: 'middle', strike: middle.strike },
  { slot: 'upper', strike: upper.strike },
];

/** The two ascending `TwoStrikeInput` roles (combos, guts). */
const twoStrikeRoles = (
  lower: { strike: number },
  upper: { strike: number },
): { slot: string; strike: number }[] => [
  { slot: 'lower', strike: lower.strike },
  { slot: 'upper', strike: upper.strike },
];

/** The four ascending `CondorInput` roles (single-type condors). */
const gridRoles = (
  k1: { strike: number },
  k2: { strike: number },
  k3: { strike: number },
  k4: { strike: number },
): { slot: string; strike: number }[] => [
  { slot: 'k1', strike: k1.strike },
  { slot: 'k2', strike: k2.strike },
  { slot: 'k3', strike: k3.strike },
  { slot: 'k4', strike: k4.strike },
];

/** The two ascending strangle roles: an OTM put below an OTM call. */
const strangleRoles = (
  put: { strike: number },
  call: { strike: number },
): { slot: string; strike: number }[] => [
  { slot: 'put', strike: put.strike },
  { slot: 'call', strike: call.strike },
];

// ───────────────────────── single legs ─────────────────────────

export interface SingleLegInput extends StrikeLeg, UnitInput {}

export const longCall = (i: SingleLegInput, c?: PositionConfig): Position =>
  build([legs.call({ strike: i.strike, premium: i.premium, quantity: units(i) })], c, i.expiry);
export const shortCall = (i: SingleLegInput, c?: PositionConfig): Position =>
  build([legs.call({ strike: i.strike, premium: i.premium, quantity: -units(i) })], c, i.expiry);
export const longPut = (i: SingleLegInput, c?: PositionConfig): Position =>
  build([legs.put({ strike: i.strike, premium: i.premium, quantity: units(i) })], c, i.expiry);
export const shortPut = (i: SingleLegInput, c?: PositionConfig): Position =>
  build([legs.put({ strike: i.strike, premium: i.premium, quantity: -units(i) })], c, i.expiry);
/** Cash-secured put — identical payoff to a short put; the "secured" is a margin/BP distinction. */
export const cashSecuredPut = (i: SingleLegInput, c?: PositionConfig): Position => shortPut(i, c);

// ───────────────────────── ladders (3 strikes, one type) ─────────────────────────

/** Three ascending same-type strikes: `lower < middle < upper`. */
export interface LadderInput extends UnitInput {
  lower: Role;
  middle: Role;
  upper: Role;
}

/** Bull call ladder: long lower call, short middle + short upper calls (extends a bull call spread). */
export const bullCallLadder = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.bullCallLadder';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.call({ ...lower, quantity: n }),
      legs.call({ ...middle, quantity: -n }),
      legs.call({ ...upper, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

/** Bear call ladder: short lower call, long middle + long upper calls. */
export const bearCallLadder = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.bearCallLadder';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.call({ ...lower, quantity: -n }),
      legs.call({ ...middle, quantity: n }),
      legs.call({ ...upper, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

/** Bull put ladder: short upper put, long middle + long lower puts. */
export const bullPutLadder = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.bullPutLadder';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.put({ ...upper, quantity: -n }),
      legs.put({ ...middle, quantity: n }),
      legs.put({ ...lower, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

/** Bear put ladder: long upper put, short middle + short lower puts. */
export const bearPutLadder = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.bearPutLadder';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.put({ ...upper, quantity: n }),
      legs.put({ ...middle, quantity: -n }),
      legs.put({ ...lower, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

// ───────────────────────── broken-wing butterflies (skip-strike) ─────────────────────────

/** Broken-wing butterfly: long/short/long with asymmetric wing widths (a directional butterfly). */
export const callBrokenWing = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.callBrokenWing';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.call({ ...lower, quantity: n }),
      legs.call({ ...middle, quantity: -(2 * n) }),
      legs.call({ ...upper, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

export const putBrokenWing = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.putBrokenWing';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.put({ ...lower, quantity: n }),
      legs.put({ ...middle, quantity: -(2 * n) }),
      legs.put({ ...upper, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

/** Inverse broken-wing butterfly: short/long/short. */
export const inverseCallBrokenWing = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.inverseCallBrokenWing';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.call({ ...lower, quantity: -n }),
      legs.call({ ...middle, quantity: 2 * n }),
      legs.call({ ...upper, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

export const inversePutBrokenWing = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.inversePutBrokenWing';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.put({ ...lower, quantity: -n }),
      legs.put({ ...middle, quantity: 2 * n }),
      legs.put({ ...upper, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

// ───────────────────────── jade lizard / reverse ─────────────────────────

/** Jade lizard: short put + short call + long higher call (a short put with a short call spread). */
export interface JadeLizardInput extends UnitInput {
  put: Role;
  shortCall: Role;
  longCall: Role;
}

export const jadeLizard = (i: JadeLizardInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.jadeLizard';
  const n = units(i);
  const put = roleLeg(i.put, functionName, 'put');
  const shortCall = roleLeg(i.shortCall, functionName, 'shortCall');
  const longCall = roleLeg(i.longCall, functionName, 'longCall');
  // Only the call spread's ordering is documented ("long HIGHER call"); the put's placement is a
  // convention, not a promise, so it is left free.
  return ordered(
    functionName,
    [
      { slot: 'shortCall', strike: shortCall.strike },
      { slot: 'longCall', strike: longCall.strike },
    ],
    [
      legs.put({ ...put, quantity: -n }),
      legs.call({ ...shortCall, quantity: -n }),
      legs.call({ ...longCall, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

/** Reverse jade lizard: short call + short put + long lower put (a short call with a short put spread). */
export interface ReverseJadeLizardInput extends UnitInput {
  call: Role;
  shortPut: Role;
  longPut: Role;
}

export const reverseJadeLizard = (i: ReverseJadeLizardInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.reverseJadeLizard';
  const n = units(i);
  const call = roleLeg(i.call, functionName, 'call');
  const shortPut = roleLeg(i.shortPut, functionName, 'shortPut');
  const longPut = roleLeg(i.longPut, functionName, 'longPut');
  // Mirror of the jade lizard: only the put spread's ordering is documented ("long LOWER put").
  return ordered(
    functionName,
    [
      { slot: 'longPut', strike: longPut.strike },
      { slot: 'shortPut', strike: shortPut.strike },
    ],
    [
      legs.call({ ...call, quantity: -n }),
      legs.put({ ...shortPut, quantity: -n }),
      legs.put({ ...longPut, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

// ───────────────────────── combos / synthetics / guts ─────────────────────────

/** Two ascending strikes `lower < upper`. */
export interface TwoStrikeInput extends UnitInput {
  lower: Role;
  upper: Role;
}

/** Long combo: long upper call + short lower put (a synthetic long at different strikes). */
export const longCombo = (i: TwoStrikeInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.longCombo';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    twoStrikeRoles(lower, upper),
    [legs.call({ ...upper, quantity: n }), legs.put({ ...lower, quantity: -n })],
    c,
    i.expiry,
  );
};

/** Short combo: short upper call + long lower put (a synthetic short at different strikes). */
export const shortCombo = (i: TwoStrikeInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.shortCombo';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    twoStrikeRoles(lower, upper),
    [legs.call({ ...upper, quantity: -n }), legs.put({ ...lower, quantity: n })],
    c,
    i.expiry,
  );
};

/** Long guts: long ITM call (lower strike) + long ITM put (upper strike). */
export const guts = (i: TwoStrikeInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.guts';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    twoStrikeRoles(lower, upper),
    [legs.call({ ...lower, quantity: n }), legs.put({ ...upper, quantity: n })],
    c,
    i.expiry,
  );
};

/** Short guts: short ITM call (lower) + short ITM put (upper). */
export const shortGuts = (i: TwoStrikeInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.shortGuts';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    twoStrikeRoles(lower, upper),
    [legs.call({ ...lower, quantity: -n }), legs.put({ ...upper, quantity: -n })],
    c,
    i.expiry,
  );
};

/** A single strike with a call and a put premium (synthetics / same-strike structures). */
export interface SyntheticInput extends UnitInput {
  strike: number;
  callPremium?: number;
  putPremium?: number;
}

/** Long synthetic future (synthetic long stock): long call + short put at the same strike. */
export const longSyntheticFuture = (i: SyntheticInput, c?: PositionConfig): Position => {
  const n = units(i);
  return build(
    [
      legs.call({ strike: i.strike, premium: i.callPremium, quantity: n }),
      legs.put({ strike: i.strike, premium: i.putPremium, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

/** Short synthetic future (synthetic short stock): short call + long put at the same strike. */
export const shortSyntheticFuture = (i: SyntheticInput, c?: PositionConfig): Position => {
  const n = units(i);
  return build(
    [
      legs.call({ strike: i.strike, premium: i.callPremium, quantity: -n }),
      legs.put({ strike: i.strike, premium: i.putPremium, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

/** Synthetic put (synthetic long put): short stock + long call. */
export interface SyntheticPutInput extends SingleLegInput {
  /** Entry price of the short stock leg. */
  stockPrice: number;
}

export const syntheticPut = (i: SyntheticPutInput, c?: PositionConfig): Position => {
  const n = units(i);
  return build(
    [
      legs.stock({ price: i.stockPrice, quantity: -(100 * n) }),
      legs.call({ strike: i.strike, premium: i.premium, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

// ───────────────────────── ratio spreads / backspreads ─────────────────────────

/** Long one option and short `ratio` of a further option (default 1×2). */
export interface RatioInput extends UnitInput {
  long: Role;
  short: Role;
  /** Number of short legs per long (default 2). */
  ratio?: number;
}

/** The two ratio roles, ascending — `further` is the leg the doc places away from the money. */
const ratioRoles = (
  near: { slot: string; strike: number },
  further: { slot: string; strike: number },
  /** `'call'` puts the further leg ABOVE the near one; `'put'` puts it BELOW. */
  right: 'call' | 'put',
): { slot: string; strike: number }[] => (right === 'call' ? [near, further] : [further, near]);

export const callRatioSpread = (i: RatioInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.callRatioSpread';
  const n = units(i);
  const r = i.ratio ?? 2;
  const long = roleLeg(i.long, functionName, 'long');
  const short = roleLeg(i.short, functionName, 'short');
  return ordered(
    functionName,
    // "Long one option and short `ratio` of a FURTHER option": further calls sit above the long.
    ratioRoles(
      { slot: 'long', strike: long.strike },
      { slot: 'short', strike: short.strike },
      'call',
    ),
    [legs.call({ ...long, quantity: n }), legs.call({ ...short, quantity: -(r * n) })],
    c,
    i.expiry,
  );
};

export const putRatioSpread = (i: RatioInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.putRatioSpread';
  const n = units(i);
  const r = i.ratio ?? 2;
  const long = roleLeg(i.long, functionName, 'long');
  const short = roleLeg(i.short, functionName, 'short');
  return ordered(
    functionName,
    ratioRoles(
      { slot: 'long', strike: long.strike },
      { slot: 'short', strike: short.strike },
      'put',
    ),
    [legs.put({ ...long, quantity: n }), legs.put({ ...short, quantity: -(r * n) })],
    c,
    i.expiry,
  );
};

/** Short one near option and long `ratio` of a further option (default 1×2) — a backspread. */
export const callRatioBackspread = (i: RatioInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.callRatioBackspread';
  const n = units(i);
  const r = i.ratio ?? 2;
  const short = roleLeg(i.short, functionName, 'short');
  const long = roleLeg(i.long, functionName, 'long');
  return ordered(
    functionName,
    // "Short one NEAR option and long `ratio` of a FURTHER option": the long calls sit above.
    ratioRoles(
      { slot: 'short', strike: short.strike },
      { slot: 'long', strike: long.strike },
      'call',
    ),
    [legs.call({ ...short, quantity: -n }), legs.call({ ...long, quantity: r * n })],
    c,
    i.expiry,
  );
};

export const putRatioBackspread = (i: RatioInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.putRatioBackspread';
  const n = units(i);
  const r = i.ratio ?? 2;
  const short = roleLeg(i.short, functionName, 'short');
  const long = roleLeg(i.long, functionName, 'long');
  return ordered(
    functionName,
    ratioRoles(
      { slot: 'short', strike: short.strike },
      { slot: 'long', strike: long.strike },
      'put',
    ),
    [legs.put({ ...short, quantity: -n }), legs.put({ ...long, quantity: r * n })],
    c,
    i.expiry,
  );
};

// ───────────────────────── butterflies (symmetric, one type) ─────────────────────────

export const longCallButterfly = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.longCallButterfly';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.call({ ...lower, quantity: n }),
      legs.call({ ...middle, quantity: -(2 * n) }),
      legs.call({ ...upper, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

export const longPutButterfly = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.longPutButterfly';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.put({ ...lower, quantity: n }),
      legs.put({ ...middle, quantity: -(2 * n) }),
      legs.put({ ...upper, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

export const shortCallButterfly = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.shortCallButterfly';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.call({ ...lower, quantity: -n }),
      legs.call({ ...middle, quantity: 2 * n }),
      legs.call({ ...upper, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

export const shortPutButterfly = (i: LadderInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.shortPutButterfly';
  const n = units(i);
  const lower = roleLeg(i.lower, functionName, 'lower');
  const middle = roleLeg(i.middle, functionName, 'middle');
  const upper = roleLeg(i.upper, functionName, 'upper');
  return ordered(
    functionName,
    ladderRoles(lower, middle, upper),
    [
      legs.put({ ...lower, quantity: -n }),
      legs.put({ ...middle, quantity: 2 * n }),
      legs.put({ ...upper, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

// ───────────────────────── condors (4 strikes, one type) ─────────────────────────

/** Four ascending same-type strikes `k1 < k2 < k3 < k4`. */
export interface CondorInput extends UnitInput {
  k1: Role;
  k2: Role;
  k3: Role;
  k4: Role;
}

export const longCallCondor = (i: CondorInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.longCallCondor';
  const n = units(i);
  const k1 = roleLeg(i.k1, functionName, 'k1');
  const k2 = roleLeg(i.k2, functionName, 'k2');
  const k3 = roleLeg(i.k3, functionName, 'k3');
  const k4 = roleLeg(i.k4, functionName, 'k4');
  return ordered(
    functionName,
    gridRoles(k1, k2, k3, k4),
    [
      legs.call({ ...k1, quantity: n }),
      legs.call({ ...k2, quantity: -n }),
      legs.call({ ...k3, quantity: -n }),
      legs.call({ ...k4, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

export const longPutCondor = (i: CondorInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.longPutCondor';
  const n = units(i);
  const k1 = roleLeg(i.k1, functionName, 'k1');
  const k2 = roleLeg(i.k2, functionName, 'k2');
  const k3 = roleLeg(i.k3, functionName, 'k3');
  const k4 = roleLeg(i.k4, functionName, 'k4');
  return ordered(
    functionName,
    gridRoles(k1, k2, k3, k4),
    [
      legs.put({ ...k1, quantity: n }),
      legs.put({ ...k2, quantity: -n }),
      legs.put({ ...k3, quantity: -n }),
      legs.put({ ...k4, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

export const shortCallCondor = (i: CondorInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.shortCallCondor';
  const n = units(i);
  const k1 = roleLeg(i.k1, functionName, 'k1');
  const k2 = roleLeg(i.k2, functionName, 'k2');
  const k3 = roleLeg(i.k3, functionName, 'k3');
  const k4 = roleLeg(i.k4, functionName, 'k4');
  return ordered(
    functionName,
    gridRoles(k1, k2, k3, k4),
    [
      legs.call({ ...k1, quantity: -n }),
      legs.call({ ...k2, quantity: n }),
      legs.call({ ...k3, quantity: n }),
      legs.call({ ...k4, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

export const shortPutCondor = (i: CondorInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.shortPutCondor';
  const n = units(i);
  const k1 = roleLeg(i.k1, functionName, 'k1');
  const k2 = roleLeg(i.k2, functionName, 'k2');
  const k3 = roleLeg(i.k3, functionName, 'k3');
  const k4 = roleLeg(i.k4, functionName, 'k4');
  return ordered(
    functionName,
    gridRoles(k1, k2, k3, k4),
    [
      legs.put({ ...k1, quantity: -n }),
      legs.put({ ...k2, quantity: n }),
      legs.put({ ...k3, quantity: n }),
      legs.put({ ...k4, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

// ───────────────────────── iron butterfly / condor variants ─────────────────────────

/** Iron butterfly: short ATM call + short ATM put + long OTM wings (a short straddle + long strangle). */
export interface IronButterflyInput extends UnitInput {
  /**
   * ATM body (shared-strike rule): the strike sold twice, with per-type premiums. A bare strike
   * number is shorthand for `{ strike }` (R3).
   */
  body: number | { strike: number; callPremium?: number; putPremium?: number };
  /** Long put wing below the body. */
  putWing: Role;
  /** Long call wing above the body. */
  callWing: Role;
}

const IRON_BUTTERFLY_SLOTS = ['body', 'putWing', 'callWing'] as const;
const IRON_BUTTERFLY_SHAPE =
  '{ body: strike | { strike, callPremium?, putPremium? }, putWing: strike | { strike, premium? }, ' +
  'callWing: strike | { strike, premium? }, quantity?, expiry? }';

/** Normalize the shared-strike body slot, teaching the shape on garbage (mirrors `roleLeg`). */
function bodySlot(
  body: IronButterflyInput['body'],
  functionName: string,
): { strike: number; callPremium?: number; putPremium?: number } {
  if (typeof body === 'number') return { strike: body };
  if (
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { strike?: unknown }).strike === 'number'
  ) {
    return body;
  }
  throw new InputError(
    `${functionName}: body must be a strike number or { strike, callPremium?, putPremium? }, got ${JSON.stringify(body)}.`,
    { code: ErrorCode.InputWrongType, context: { slot: 'body', received: body } },
  );
}

/** The three ascending iron-butterfly roles: the put wing below the body, the call wing above it. */
const wingRoles = (
  putWing: { strike: number },
  body: { strike: number },
  callWing: { strike: number },
): { slot: string; strike: number }[] => [
  { slot: 'putWing', strike: putWing.strike },
  { slot: 'body', strike: body.strike },
  { slot: 'callWing', strike: callWing.strike },
];

export const ironButterfly = (i: IronButterflyInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.ironButterfly';
  validateSlots(i, IRON_BUTTERFLY_SLOTS, functionName, IRON_BUTTERFLY_SHAPE);
  const body = bodySlot(i.body, functionName);
  const n = units(i);
  const putWing = roleLeg(i.putWing, functionName, 'putWing');
  const callWing = roleLeg(i.callWing, functionName, 'callWing');
  return ordered(
    functionName,
    wingRoles(putWing, body, callWing),
    [
      legs.put({ ...putWing, quantity: n }),
      legs.put({ strike: body.strike, premium: body.putPremium, quantity: -n }),
      legs.call({ strike: body.strike, premium: body.callPremium, quantity: -n }),
      legs.call({ ...callWing, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

/** Inverse (reverse) iron butterfly: long ATM straddle + short OTM wings. */
export const inverseIronButterfly = (i: IronButterflyInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.inverseIronButterfly';
  validateSlots(i, IRON_BUTTERFLY_SLOTS, functionName, IRON_BUTTERFLY_SHAPE);
  const body = bodySlot(i.body, functionName);
  const n = units(i);
  const putWing = roleLeg(i.putWing, functionName, 'putWing');
  const callWing = roleLeg(i.callWing, functionName, 'callWing');
  return ordered(
    functionName,
    wingRoles(putWing, body, callWing),
    [
      legs.put({ ...putWing, quantity: -n }),
      legs.put({ strike: body.strike, premium: body.putPremium, quantity: n }),
      legs.call({ strike: body.strike, premium: body.callPremium, quantity: n }),
      legs.call({ ...callWing, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

/** Inverse (reverse) iron condor: long inner strangle + short outer wings. Same input as `ironCondor`. */
export const inverseIronCondor = (i: IronCondorInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.inverseIronCondor';
  const n = units(i);
  const putLong = roleLeg(i.putLong, functionName, 'putLong');
  const putShort = roleLeg(i.putShort, functionName, 'putShort');
  const callShort = roleLeg(i.callShort, functionName, 'callShort');
  const callLong = roleLeg(i.callLong, functionName, 'callLong');
  // One grammar with `ironCondor` (same input value): the slot NAMES keep their iron-condor
  // meaning, so the ascending precondition is identical even though the signs are mirrored.
  return ordered(
    functionName,
    condorRoles(putLong, putShort, callShort, callLong),
    [
      legs.put({ ...putLong, quantity: -n }),
      legs.put({ ...putShort, quantity: n }),
      legs.call({ ...callShort, quantity: n }),
      legs.call({ ...callLong, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

// ───────────────────────── short straddle / strangle, strips / straps ─────────────────────────

export interface ShortStraddleInput extends UnitInput {
  strike: number;
  callPremium?: number;
  putPremium?: number;
}

export const shortStraddle = (i: ShortStraddleInput, c?: PositionConfig): Position => {
  const n = units(i);
  return build(
    [
      legs.call({ strike: i.strike, premium: i.callPremium, quantity: -n }),
      legs.put({ strike: i.strike, premium: i.putPremium, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

export interface ShortStrangleInput extends UnitInput {
  /** The sold call: a strike, or `{ strike, premium? }`. */
  call: Role;
  /** The sold put: a strike, or `{ strike, premium? }`. */
  put: Role;
}

export const shortStrangle = (i: ShortStrangleInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.shortStrangle';
  const n = units(i);
  const call = roleLeg(i.call, functionName, 'call');
  const put = roleLeg(i.put, functionName, 'put');
  return ordered(
    functionName,
    strangleRoles(put, call),
    [legs.call({ ...call, quantity: -n }), legs.put({ ...put, quantity: -n })],
    c,
    i.expiry,
  );
};

/** Strip: long 1 call + long 2 puts at one strike (bearish-biased volatility play). */
export const strip = (i: SyntheticInput, c?: PositionConfig): Position => {
  const n = units(i);
  return build(
    [
      legs.call({ strike: i.strike, premium: i.callPremium, quantity: n }),
      legs.put({ strike: i.strike, premium: i.putPremium, quantity: 2 * n }),
    ],
    c,
    i.expiry,
  );
};

/** Strap: long 2 calls + long 1 put at one strike (bullish-biased volatility play). */
export const strap = (i: SyntheticInput, c?: PositionConfig): Position => {
  const n = units(i);
  return build(
    [
      legs.call({ strike: i.strike, premium: i.callPremium, quantity: 2 * n }),
      legs.put({ strike: i.strike, premium: i.putPremium, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

// ───────────────────────── stock + option combinations ─────────────────────────

/** Shared: an underlying stock entry price plus a per-contract unit count (100 shares per contract). */
export interface StockOptionInput extends UnitInput {
  /** Entry price per share of the stock leg. */
  stockPrice: number;
}

/** Covered call: long 100·q shares + short q calls. */
export const coveredCall = (i: StockOptionInput & StrikeLeg, c?: PositionConfig): Position => {
  const n = units(i);
  return build(
    [
      legs.stock({ price: i.stockPrice, quantity: 100 * n }),
      legs.call({ strike: i.strike, premium: i.premium, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

/** Protective put: long 100·q shares + long q puts. */
export const protectivePut = (i: StockOptionInput & StrikeLeg, c?: PositionConfig): Position => {
  const n = units(i);
  return build(
    [
      legs.stock({ price: i.stockPrice, quantity: 100 * n }),
      legs.put({ strike: i.strike, premium: i.premium, quantity: n }),
    ],
    c,
    i.expiry,
  );
};

/** Collar: long 100·q shares + long q protective puts + short q covered calls. */
export interface CollarInput extends StockOptionInput {
  put: Role;
  call: Role;
}

export const collar = (i: CollarInput, c?: PositionConfig): Position => {
  const functionName = 'strategy.collar';
  const n = units(i);
  const put = roleLeg(i.put, functionName, 'put');
  const call = roleLeg(i.call, functionName, 'call');
  // A collar is a PROTECTIVE put under a COVERED call — inverted, the two legs cross and the
  // "bounded both ways" payoff the name promises is not what gets built.
  return ordered(
    functionName,
    strangleRoles(put, call),
    [
      legs.stock({ price: i.stockPrice, quantity: 100 * n }),
      legs.put({ ...put, quantity: n }),
      legs.call({ ...call, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

/** Covered short straddle: long 100·q shares + short q calls + short q puts at one strike. */
export const coveredShortStraddle = (
  i: StockOptionInput & ShortStraddleInput,
  c?: PositionConfig,
): Position => {
  const n = units(i);
  return build(
    [
      legs.stock({ price: i.stockPrice, quantity: 100 * n }),
      legs.call({ strike: i.strike, premium: i.callPremium, quantity: -n }),
      legs.put({ strike: i.strike, premium: i.putPremium, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};

/** Covered short strangle: long 100·q shares + short q calls + short q puts at separate strikes. */
export const coveredShortStrangle = (
  i: StockOptionInput & ShortStrangleInput,
  c?: PositionConfig,
): Position => {
  const functionName = 'strategy.coveredShortStrangle';
  const n = units(i);
  const call = roleLeg(i.call, functionName, 'call');
  const put = roleLeg(i.put, functionName, 'put');
  return ordered(
    functionName,
    strangleRoles(put, call),
    [
      legs.stock({ price: i.stockPrice, quantity: 100 * n }),
      legs.call({ ...call, quantity: -n }),
      legs.put({ ...put, quantity: -n }),
    ],
    c,
    i.expiry,
  );
};
