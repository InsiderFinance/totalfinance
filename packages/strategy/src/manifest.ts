/**
 * The strategy manifest (dx §4.5 / §5.2) — the single registry of every named builder.
 *
 * Each entry wraps its raw builder so the returned Position carries `constructedAs` (provenance:
 * how it was built — a fact that can never go stale because Positions are immutable). The entry's
 * `example` is a canonical, buildable input used three ways: `listStrategies()` (agents self-serve
 * each builder's input shape), the classifier's derived structural signatures (`classify.ts`), and
 * the round-trip law in CI (every builder's output must classify back to its own name).
 *
 * Identity after edits is NOT this file's job — a tweaked leg list may be no named strategy at
 * all. Use `classifyStrategy(legs)` for "what is this now?"; `constructedAs` only answers "how did
 * it start?".
 */

import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  ensureFiniteWhenPresent,
  ensurePositive,
  requireArgumentObject,
  wrongShapeError,
} from '@totalfinance/core';

/**
 * Reject a `null` anywhere in a builder's input/config tree with the field's dotted path. Plain
 * objects and arrays recurse; class instances (a `Position`, a Date) do not — a builder input is
 * data, and the only object-valued members it declares are plain (`market`, `legs` rows).
 */
/**
 * The example IS the type witness: every builder registers a canonical, buildable input, so the
 * wrapper can hold each REQUIRED field to the example's own primitive shape without a schema —
 * `coveredCall({ stockPrice: 'x' })` used to reach the stock leg constructor and build a NaN position as
 * if it had succeeded, and an omitted stockPrice did the same. Optional fields (premiums are
 * deliberately absent from examples) are covered by the name-convention ladder in the null walk.
 */
function requireExampleShape(
  functionName: string,
  path: string,
  example: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  for (const [key, sample] of Object.entries(example)) {
    const memberPath = path === 'input' ? key : `${path}.${key}`;
    const value = input[key];
    // Missing slots are NOT judged here: a wholly-wrong shape gets the builder's curated
    // wrong_shape teaching (F15 — received-keys echo beats naming one missing field), and the
    // wrapper convicts a missing slot only when the builder SILENTLY accepts it (below).
    if (value === undefined) continue;
    if (typeof sample === 'number') {
      // The example shows the bare-strike SHORTHAND; several slots also accept the object leg
      // form ({ strike, premium }) the example cannot witness — a plain object passes here and
      // the null/premium walk covers its members. Primitives other than a finite number teach.
      const isLegObject = value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!isLegObject && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new InputError(
          `${functionName}: ${memberPath} must be a finite number (e.g. ${String(sample)}); role slots also accept a leg object \`{ strike, premium? }\`. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
          {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: memberPath, received: value },
          },
        );
      }
    } else if (typeof sample === 'string') {
      if (typeof value !== 'string') {
        throw new InputError(
          `${functionName}: ${memberPath} must be a string (e.g. ${JSON.stringify(sample)}). Received ${value === null ? 'null' : typeof value}.`,
          {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: memberPath, received: value },
          },
        );
      }
    } else if (
      sample !== null &&
      typeof sample === 'object' &&
      !Array.isArray(sample) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      requireExampleShape(
        functionName,
        memberPath,
        sample as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    }
  }
}

/** Optional premium fields share one vocabulary package-wide: a present premium is a finite number. */
function isPremiumKey(key: string): boolean {
  return key === 'premium' || key.endsWith('Premium');
}

function rejectNullFields(functionName: string, path: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      rejectNullFields(functionName, `${path}[${String(index)}]`, element);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Object.getPrototypeOf(value) !== Object.prototype) return;
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const memberPath = path === 'input' ? key : `${path}.${key}`;
    if (member === null) {
      throw new InputError(
        `${functionName}: ${memberPath} must not be null — omit the field instead. Received null.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: memberPath, received: 'null' },
        },
      );
    }
    if (isPremiumKey(key) && (typeof member !== 'number' || !Number.isFinite(member))) {
      throw new InputError(
        `${functionName}: ${memberPath} must be a finite number when provided — the premium per share in currency units. Received ${typeof member === 'number' ? String(member) : typeof member}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: memberPath, received: member },
        },
      );
    }
    rejectNullFields(functionName, memberPath, member);
  }
}
import * as b from './builders.js';
import * as cal from './calendars.js';
import { type Position, withProvenance } from './position.js';
import * as s from './strategies.js';
import { POSITION_CONFIG_KEYS, type PositionConfig } from './types.js';

/** A manifest entry, as served by {@link listStrategies}. */
export interface StrategyDescriptor {
  name: string;
  description: string;
  /** True for calendars/diagonals — structures whose legs span multiple expiries. */
  multiExpiry: boolean;
  /**
   * A canonical, buildable input for this builder (premiums omitted — build with
   * `{ premiums: 'model', market }`). Doubles as executable documentation of the input shape.
   */
  example: Record<string, unknown>;
}

interface RegistryEntry extends StrategyDescriptor {
  builder: (input: never, config?: PositionConfig) => Position;
}

const REGISTRY: RegistryEntry[] = [];

/**
 * Wrap a raw builder: register it, guard its input container centrally (the first-touch law — one
 * guard here covers every named builder), and stamp `constructedAs` on every Position it returns.
 */
/**
 * EXACT per-builder input fields (Law 12, D4) — extracted from each builder's input INTERFACE
 * (extends-resolved), so `longCall` does not silently accept `putPremium` and a typo of any
 * field gets a did-you-mean against exactly the fields that builder reads. Regenerate by
 * re-running the interface extraction if a builder's input type changes; the unknown-key sweep
 * fails if a builder accepts a key that is not in its list.
 */
const BUILDER_FIELDS: Record<string, readonly string[]> = {
  bearCallLadder: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  bearCallSpread: ['expiry', 'long', 'quantity', 'short'],
  bearPutLadder: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  bearPutSpread: ['expiry', 'long', 'quantity', 'short'],
  bullCallLadder: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  bullCallSpread: ['expiry', 'long', 'quantity', 'short'],
  bullPutLadder: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  bullPutSpread: ['expiry', 'long', 'quantity', 'short'],
  calendarCallSpread: [
    'farExpiry',
    'longPremium',
    'nearExpiry',
    'quantity',
    'shortPremium',
    'strike',
  ],
  calendarPutSpread: [
    'farExpiry',
    'longPremium',
    'nearExpiry',
    'quantity',
    'shortPremium',
    'strike',
  ],
  callBrokenWing: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  callRatioBackspread: ['expiry', 'long', 'quantity', 'ratio', 'short'],
  callRatioSpread: ['expiry', 'long', 'quantity', 'ratio', 'short'],
  cashSecuredPut: ['expiry', 'premium', 'quantity', 'strike'],
  collar: ['call', 'expiry', 'put', 'quantity', 'stockPrice'],
  coveredCall: ['expiry', 'premium', 'quantity', 'stockPrice', 'strike'],
  coveredShortStraddle: ['callPremium', 'expiry', 'putPremium', 'quantity', 'stockPrice', 'strike'],
  coveredShortStrangle: ['call', 'expiry', 'put', 'quantity', 'stockPrice'],
  diagonalCallSpread: [
    'farExpiry',
    'longPremium',
    'longStrike',
    'nearExpiry',
    'quantity',
    'shortPremium',
    'shortStrike',
  ],
  diagonalPutSpread: [
    'farExpiry',
    'longPremium',
    'longStrike',
    'nearExpiry',
    'quantity',
    'shortPremium',
    'shortStrike',
  ],
  doubleDiagonal: ['call', 'farExpiry', 'nearExpiry', 'put', 'quantity'],
  guts: ['expiry', 'lower', 'quantity', 'upper'],
  inverseCallBrokenWing: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  inverseIronButterfly: ['body', 'callWing', 'expiry', 'putWing', 'quantity'],
  inverseIronCondor: ['callLong', 'callShort', 'expiry', 'putLong', 'putShort', 'quantity'],
  inversePutBrokenWing: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  ironButterfly: ['body', 'callWing', 'expiry', 'putWing', 'quantity'],
  ironCondor: ['callLong', 'callShort', 'expiry', 'putLong', 'putShort', 'quantity'],
  jadeLizard: ['expiry', 'longCall', 'put', 'quantity', 'shortCall'],
  longCall: ['expiry', 'premium', 'quantity', 'strike'],
  longCallButterfly: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  longCallCondor: ['expiry', 'k1', 'k2', 'k3', 'k4', 'quantity'],
  longCombo: ['expiry', 'lower', 'quantity', 'upper'],
  longPut: ['expiry', 'premium', 'quantity', 'strike'],
  longPutButterfly: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  longPutCondor: ['expiry', 'k1', 'k2', 'k3', 'k4', 'quantity'],
  longSyntheticFuture: ['callPremium', 'expiry', 'putPremium', 'quantity', 'strike'],
  protectivePut: ['expiry', 'premium', 'quantity', 'stockPrice', 'strike'],
  putBrokenWing: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  putRatioBackspread: ['expiry', 'long', 'quantity', 'ratio', 'short'],
  putRatioSpread: ['expiry', 'long', 'quantity', 'ratio', 'short'],
  reverseJadeLizard: ['call', 'expiry', 'longPut', 'quantity', 'shortPut'],
  shortCall: ['expiry', 'premium', 'quantity', 'strike'],
  shortCallButterfly: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  shortCallCondor: ['expiry', 'k1', 'k2', 'k3', 'k4', 'quantity'],
  shortCombo: ['expiry', 'lower', 'quantity', 'upper'],
  shortGuts: ['expiry', 'lower', 'quantity', 'upper'],
  shortPut: ['expiry', 'premium', 'quantity', 'strike'],
  shortPutButterfly: ['expiry', 'lower', 'middle', 'quantity', 'upper'],
  shortPutCondor: ['expiry', 'k1', 'k2', 'k3', 'k4', 'quantity'],
  shortStraddle: ['callPremium', 'expiry', 'putPremium', 'quantity', 'strike'],
  shortStrangle: ['call', 'expiry', 'put', 'quantity'],
  shortSyntheticFuture: ['callPremium', 'expiry', 'putPremium', 'quantity', 'strike'],
  straddle: ['callPremium', 'expiry', 'putPremium', 'quantity', 'strike'],
  strangle: ['call', 'expiry', 'put', 'quantity'],
  strap: ['callPremium', 'expiry', 'putPremium', 'quantity', 'strike'],
  strip: ['callPremium', 'expiry', 'putPremium', 'quantity', 'strike'],
  syntheticPut: ['expiry', 'premium', 'quantity', 'stockPrice', 'strike'],
};

function named<I>(
  name: string,
  description: string,
  build: (input: I, config?: PositionConfig) => Position,
  example: I & Record<string, unknown>,
  multiExpiry = false,
): (input: I, config?: PositionConfig) => Position {
  const allowed =
    BUILDER_FIELDS[name] ??
    ([...new Set([...Object.keys(example), 'quantity', 'expiry'])] as readonly string[]);
  const wrapped = (input: I, config?: PositionConfig): Position => {
    if (input === null || typeof input !== 'object') {
      throw wrongShapeError(
        `strategy.${name}`,
        `${JSON.stringify(example)} (see listStrategies() for every builder's example input)`,
        input,
      );
    }
    // Law 12, ordered for the best teaching: when unknown keys accompany MISSING structural
    // slots the caller has the wrong shape entirely — defer to the builder's own curated
    // validateSlots/rejectRetiredKey errors (received-keys echo, retired-key replacements).
    // Unknown keys alongside a complete shape are a typo — did-you-mean here.
    const keys = Object.keys(input);
    const missingStructural = Object.keys(example).some((k) => !keys.includes(k));
    // Retired keys (the nested `premiums` object) and a bare `expiry` on the per-side expiry
    // families (calendars/diagonals teach nearExpiry/farExpiry, R4) have CURATED replacement
    // teaching in the builders — let that fire rather than a generic unknown-field error.
    const hasRetired =
      keys.includes('premiums') || (keys.includes('expiry') && !allowed.includes('expiry'));
    if (!missingStructural && !hasRetired) {
      ensureKnownKeys(`strategy.${name}`, 'input', input, allowed);
    }
    // The CONFIG argument obeys Law 12 too (D4): `{ premums: 'model' }` must teach, never
    // silently price with user premiums.
    if (config !== null && typeof config === 'object') {
      ensureKnownKeys(`strategy.${name}`, 'config', config, POSITION_CONFIG_KEYS);
    }
    // Null is not omission (the 350c2796 ruling, applied at this ONE gate for every builder):
    // `{ expiry: null }` fell through each builder's `?? default` and silently built an
    // expiry-less position — the silent-default class, arriving as null does in practice
    // (`JSON.stringify(NaN)`, a LEFT JOIN, a producer "clearing" a field). No builder input or
    // config field declares `| null`, so the walk is unconditional; it recurses through plain
    // objects and arrays (`market.dividendYield: null`, a leg's `premium: null`) because a nested
    // null defaults just as silently as a top-level one.
    rejectNullFields(`strategy.${name}`, 'input', input);
    if (config !== null && typeof config === 'object') {
      rejectNullFields(`strategy.${name}`, 'config', config);
    }
    // The example-shape walk LAST, so the curated teaching above (retired keys, did-you-mean,
    // null-is-not-omission) keeps firing for its own classes first.
    requireExampleShape(
      `strategy.${name}`,
      'input',
      example as Record<string, unknown>,
      input as unknown as Record<string, unknown>,
    );
    // Provenance rides the config THROUGH the constructor: positions freeze at construction
    // (dx §4.4), so a post-construction defineProperty would throw on the frozen instance.
    const missingKeys = Object.keys(example).filter(
      (key) => (input as Record<string, unknown>)[key] === undefined,
    );
    // Presets name their direction. A negative structure count must not invert that name now
    // that the instrument-first leg constructors intentionally accept signed quantities.
    const quantity = (input as Record<string, unknown>)['quantity'];
    ensureFiniteWhenPresent(quantity, 'quantity', `strategy.${name}`);
    if (quantity !== undefined) ensurePositive(quantity as number, 'quantity', `strategy.${name}`);
    const built = build(input, withProvenance(name, config));
    // A builder that RETURNED with a required slot absent built a NaN position and called it
    // success — the covered family did exactly this with stockPrice. Builders with curated slot
    // validation threw above (their teaching wins); silence is what gets convicted here.
    if (missingKeys.length > 0) {
      throw new InputError(
        `strategy.${name}: ${missingKeys[0]!} is required. A complete call: ${name}(${JSON.stringify(example)}).`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: `strategy.${name}`, field: missingKeys[0] },
        },
      );
    }
    return built;
  };
  REGISTRY.push({ name, description, multiExpiry, example, builder: wrapped as never });
  return wrapped;
}

// ── single legs ────────────────────────────────────────────────────────────────────────────────
export const longCall = named('longCall', 'Long a single call.', s.longCall, { strike: 105 });
export const shortCall = named('shortCall', 'Short a single call.', s.shortCall, { strike: 110 });
export const longPut = named('longPut', 'Long a single put.', s.longPut, { strike: 100 });
export const shortPut = named('shortPut', 'Short a single put.', s.shortPut, { strike: 95 });
export const cashSecuredPut = named(
  'cashSecuredPut',
  'Short put (cash-secured — identical payoff; the "secured" is a margin distinction).',
  s.cashSecuredPut,
  { strike: 95 },
);

// ── verticals ──────────────────────────────────────────────────────────────────────────────────
export const bullCallSpread = named(
  'bullCallSpread',
  'Long lower call, short higher call (debit, bullish, defined risk).',
  b.bullCallSpread,
  { long: 100, short: 110 },
);
export const bearCallSpread = named(
  'bearCallSpread',
  'Short lower call, long higher call (credit, bearish, defined risk).',
  b.bearCallSpread,
  { long: 110, short: 100 },
);
export const bullPutSpread = named(
  'bullPutSpread',
  'Short higher put, long lower put (credit, bullish, defined risk).',
  b.bullPutSpread,
  { long: 95, short: 105 },
);
export const bearPutSpread = named(
  'bearPutSpread',
  'Long higher put, short lower put (debit, bearish, defined risk).',
  b.bearPutSpread,
  { long: 105, short: 95 },
);

// ── straddles / strangles ──────────────────────────────────────────────────────────────────────
export const straddle = named(
  'straddle',
  'Long call + long put at one strike (long volatility).',
  b.straddle,
  { strike: 105 },
);
export const strangle = named(
  'strangle',
  'Long OTM call + long OTM put (long volatility, wider breakevens).',
  b.strangle,
  { call: 115, put: 95 },
);
export const shortStraddle = named(
  'shortStraddle',
  'Short call + short put at one strike (short volatility, undefined risk).',
  s.shortStraddle,
  { strike: 105 },
);
export const shortStrangle = named(
  'shortStrangle',
  'Short OTM call + short OTM put (short volatility, undefined risk).',
  s.shortStrangle,
  { call: 115, put: 95 },
);
export const strip = named(
  'strip',
  'Long 1 call + 2 puts at one strike (volatility, bearish bias).',
  s.strip,
  { strike: 105 },
);
export const strap = named(
  'strap',
  'Long 2 calls + 1 put at one strike (volatility, bullish bias).',
  s.strap,
  { strike: 105 },
);

// ── guts / combos / synthetics ─────────────────────────────────────────────────────────────────
export const guts = named('guts', 'Long ITM call (lower) + long ITM put (upper).', s.guts, {
  lower: 95,
  upper: 115,
});
export const shortGuts = named(
  'shortGuts',
  'Short ITM call (lower) + short ITM put (upper).',
  s.shortGuts,
  { lower: 95, upper: 115 },
);
export const longCombo = named(
  'longCombo',
  'Long upper call + short lower put (synthetic long at split strikes).',
  s.longCombo,
  { lower: 95, upper: 115 },
);
export const shortCombo = named(
  'shortCombo',
  'Short upper call + long lower put (synthetic short at split strikes).',
  s.shortCombo,
  { lower: 95, upper: 115 },
);
export const longSyntheticFuture = named(
  'longSyntheticFuture',
  'Long call + short put at one strike (synthetic long stock).',
  s.longSyntheticFuture,
  { strike: 105 },
);
export const shortSyntheticFuture = named(
  'shortSyntheticFuture',
  'Short call + long put at one strike (synthetic short stock).',
  s.shortSyntheticFuture,
  { strike: 105 },
);
export const syntheticPut = named(
  'syntheticPut',
  'Short stock + long call (synthetic long put).',
  s.syntheticPut,
  { strike: 105, stockPrice: 105 },
);

// ── ladders / broken wings ─────────────────────────────────────────────────────────────────────
export const bullCallLadder = named(
  'bullCallLadder',
  'Long lower call, short middle + upper calls.',
  s.bullCallLadder,
  { lower: 100, middle: 110, upper: 120 },
);
export const bearCallLadder = named(
  'bearCallLadder',
  'Short lower call, long middle + upper calls.',
  s.bearCallLadder,
  { lower: 100, middle: 110, upper: 120 },
);
export const bullPutLadder = named(
  'bullPutLadder',
  'Short upper put, long middle + lower puts.',
  s.bullPutLadder,
  { lower: 90, middle: 100, upper: 110 },
);
export const bearPutLadder = named(
  'bearPutLadder',
  'Long upper put, short middle + lower puts.',
  s.bearPutLadder,
  { lower: 90, middle: 100, upper: 110 },
);
export const callBrokenWing = named(
  'callBrokenWing',
  'Call butterfly with asymmetric wings (skip-strike, directional).',
  s.callBrokenWing,
  { lower: 100, middle: 110, upper: 125 },
);
export const putBrokenWing = named(
  'putBrokenWing',
  'Put butterfly with asymmetric wings (skip-strike, directional).',
  s.putBrokenWing,
  { lower: 85, middle: 100, upper: 110 },
);
export const inverseCallBrokenWing = named(
  'inverseCallBrokenWing',
  'Inverse call broken-wing: short/long·2/short with asymmetric wings.',
  s.inverseCallBrokenWing,
  { lower: 100, middle: 110, upper: 125 },
);
export const inversePutBrokenWing = named(
  'inversePutBrokenWing',
  'Inverse put broken-wing: short/long·2/short with asymmetric wings.',
  s.inversePutBrokenWing,
  { lower: 85, middle: 100, upper: 110 },
);

// ── jade lizards ───────────────────────────────────────────────────────────────────────────────
export const jadeLizard = named(
  'jadeLizard',
  'Short put + short call spread (credit > call-spread width ⇒ no upside risk).',
  s.jadeLizard,
  { put: 95, shortCall: 110, longCall: 115 },
);
export const reverseJadeLizard = named(
  'reverseJadeLizard',
  'Short call + short put spread (mirror jade lizard).',
  s.reverseJadeLizard,
  { call: 115, shortPut: 100, longPut: 95 },
);

// ── ratio spreads / backspreads ────────────────────────────────────────────────────────────────
export const callRatioSpread = named(
  'callRatioSpread',
  'Long 1 call, short N further calls (default 1×2).',
  s.callRatioSpread,
  { long: 105, short: 115 },
);
export const putRatioSpread = named(
  'putRatioSpread',
  'Long 1 put, short N further puts (default 1×2).',
  s.putRatioSpread,
  { long: 105, short: 95 },
);
export const callRatioBackspread = named(
  'callRatioBackspread',
  'Short 1 near call, long N further calls (default 1×2).',
  s.callRatioBackspread,
  { long: 115, short: 105 },
);
export const putRatioBackspread = named(
  'putRatioBackspread',
  'Short 1 near put, long N further puts (default 1×2).',
  s.putRatioBackspread,
  { long: 95, short: 105 },
);

// ── butterflies / condors (single-type) ────────────────────────────────────────────────────────
export const longCallButterfly = named(
  'longCallButterfly',
  'Long/short·2/long calls, symmetric wings (pin risk play).',
  s.longCallButterfly,
  { lower: 95, middle: 105, upper: 115 },
);
export const longPutButterfly = named(
  'longPutButterfly',
  'Long/short·2/long puts, symmetric wings.',
  s.longPutButterfly,
  { lower: 95, middle: 105, upper: 115 },
);
export const shortCallButterfly = named(
  'shortCallButterfly',
  'Short/long·2/short calls, symmetric wings.',
  s.shortCallButterfly,
  { lower: 95, middle: 105, upper: 115 },
);
export const shortPutButterfly = named(
  'shortPutButterfly',
  'Short/long·2/short puts, symmetric wings.',
  s.shortPutButterfly,
  { lower: 95, middle: 105, upper: 115 },
);
export const longCallCondor = named(
  'longCallCondor',
  'Long k1/short k2/short k3/long k4 calls (all-call condor).',
  s.longCallCondor,
  { k1: 90, k2: 100, k3: 110, k4: 120 },
);
export const longPutCondor = named(
  'longPutCondor',
  'Long k1/short k2/short k3/long k4 puts (all-put condor).',
  s.longPutCondor,
  { k1: 90, k2: 100, k3: 110, k4: 120 },
);
export const shortCallCondor = named(
  'shortCallCondor',
  'Short k1/long k2/long k3/short k4 calls.',
  s.shortCallCondor,
  { k1: 90, k2: 100, k3: 110, k4: 120 },
);
export const shortPutCondor = named(
  'shortPutCondor',
  'Short k1/long k2/long k3/short k4 puts.',
  s.shortPutCondor,
  { k1: 90, k2: 100, k3: 110, k4: 120 },
);

// ── iron structures ────────────────────────────────────────────────────────────────────────────
export const ironCondor = named(
  'ironCondor',
  'Short put spread + short call spread (credit, range-bound, defined risk).',
  b.ironCondor,
  { putLong: 90, putShort: 95, callShort: 110, callLong: 115 },
);
export const inverseIronCondor = named(
  'inverseIronCondor',
  'Long inner strangle + short outer wings (reverse iron condor).',
  s.inverseIronCondor,
  { putLong: 90, putShort: 95, callShort: 110, callLong: 115 },
);
export const ironButterfly = named(
  'ironButterfly',
  'Short ATM straddle + long OTM wings (credit, pin play, defined risk).',
  s.ironButterfly,
  { body: { strike: 105 }, putWing: 95, callWing: 115 },
);
export const inverseIronButterfly = named(
  'inverseIronButterfly',
  'Long ATM straddle + short OTM wings (reverse iron butterfly).',
  s.inverseIronButterfly,
  { body: { strike: 105 }, putWing: 95, callWing: 115 },
);

// ── stock + option combinations ────────────────────────────────────────────────────────────────
export const coveredCall = named(
  'coveredCall',
  'Long 100·q shares + short q calls.',
  s.coveredCall,
  { stockPrice: 105, strike: 115 },
);
export const protectivePut = named(
  'protectivePut',
  'Long 100·q shares + long q puts.',
  s.protectivePut,
  { stockPrice: 105, strike: 95 },
);
export const collar = named(
  'collar',
  'Long 100·q shares + long put + short call (bounded both ways).',
  s.collar,
  { stockPrice: 105, put: 95, call: 115 },
);
export const coveredShortStraddle = named(
  'coveredShortStraddle',
  'Long 100·q shares + short straddle at one strike.',
  s.coveredShortStraddle,
  { stockPrice: 105, strike: 105 },
);
export const coveredShortStrangle = named(
  'coveredShortStrangle',
  'Long 100·q shares + short strangle at split strikes.',
  s.coveredShortStrangle,
  { stockPrice: 105, call: 115, put: 95 },
);

// ── multi-expiry (calendars / diagonals) ───────────────────────────────────────────────────────
const NEAR = '2026-06-19';
const FAR = '2026-09-18';
export const calendarCallSpread = named(
  'calendarCallSpread',
  'Short near call + long far call at one strike (horizontal).',
  cal.calendarCallSpread,
  { strike: 105, nearExpiry: NEAR, farExpiry: FAR },
  true,
);
export const calendarPutSpread = named(
  'calendarPutSpread',
  'Short near put + long far put at one strike (horizontal).',
  cal.calendarPutSpread,
  { strike: 105, nearExpiry: NEAR, farExpiry: FAR },
  true,
);
export const diagonalCallSpread = named(
  'diagonalCallSpread',
  'Short near call + long far call at different strikes.',
  cal.diagonalCallSpread,
  { shortStrike: 110, nearExpiry: NEAR, longStrike: 100, farExpiry: FAR },
  true,
);
export const diagonalPutSpread = named(
  'diagonalPutSpread',
  'Short near put + long far put at different strikes.',
  cal.diagonalPutSpread,
  { shortStrike: 100, nearExpiry: NEAR, longStrike: 110, farExpiry: FAR },
  true,
);
export const doubleDiagonal = named(
  'doubleDiagonal',
  'Short near strangle financing a long far strangle.',
  cal.doubleDiagonal,
  {
    nearExpiry: NEAR,
    farExpiry: FAR,
    call: { shortStrike: 110, longStrike: 115 },
    put: { shortStrike: 100, longStrike: 95 },
  },
  true,
);

/** Every named builder: name, description, multi-expiry flag, and a canonical example input. */
export function listStrategies(): StrategyDescriptor[] {
  return REGISTRY.map(({ builder: _builder, ...descriptor }) => ({ ...descriptor }));
}

/**
 * Build a named strategy chosen at runtime: `buildStrategy({ name: 'ironCondor', input })` is exactly
 * `ironCondor(input)` with the name as data — for agents, UIs, and config-driven callers.
 * Unknown names throw a typed `input.invalid_enum` error carrying the full catalog (with a
 * did-you-mean hint when only the casing is off); `listStrategies()` documents every input shape.
 */
export interface BuildStrategyInput {
  /** The exact strategy name returned by {@link listStrategies}. */
  name: string;
  /** Builder-specific strategy fields; inspect the matching descriptor's `exampleInput`. */
  input: Record<string, unknown>;
  /** Optional position construction and model-premium configuration. */
  config?: PositionConfig;
}

export function buildStrategy(request: BuildStrategyInput): Position {
  requireArgumentObject('buildStrategy', 'request', request);
  ensureKnownKeys('buildStrategy', 'request', request, ['name', 'input', 'config']);
  const { name, input, config } = request;
  if (typeof name !== 'string') {
    throw new InputError(
      `buildStrategy: name must be a strategy name string (e.g. 'ironCondor' — see listStrategies()), got ${
        name === null ? 'null' : typeof name
      }.`,
      { code: ErrorCode.InputWrongType, context: { name } },
    );
  }
  const entry = REGISTRY.find((e) => e.name === name);
  if (entry === undefined) {
    const near = REGISTRY.find((e) => e.name.toLowerCase() === name.toLowerCase());
    throw new InputError(
      `buildStrategy: unknown strategy '${name}'.${
        near ? ` Did you mean '${near.name}'?` : ''
      } listStrategies() returns the full catalog with example inputs.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { name, known: REGISTRY.map((e) => e.name) },
      },
    );
  }
  return entry.builder(input as never, config);
}

/**
 * INTERNAL — the registry with live builders, for the classifier and the round-trip law in CI.
 * Not part of the public surface: apps and agents use `listStrategies()` (the catalog) and
 * `buildStrategy({ name, input })` (dynamic dispatch) instead. Import path: `./manifest.js` only.
 */
export function strategyRegistry(): readonly RegistryEntry[] {
  return REGISTRY;
}
