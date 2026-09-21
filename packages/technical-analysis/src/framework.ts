/**
 * TA series + streaming framework (spec §13.1, §13.4).
 *
 * Two laws enforced here:
 *   - Aligned output: batch output length equals input length, with `NaN` (or a NaN-filled record)
 *     during warmup, and the result exposes `warmup` (the index of the first real value).
 *   - Streaming parity: batch is DERIVED from the stream (`collect`), so batch and stream outputs are
 *     identical by construction. Streaming state is serializable via `toJSON()` / `fromJSON()`.
 *
 * Snapshots produced via `indicator.stream(...).toJSON()` are {@link TechnicalAnalysisSnapshot}
 * envelopes: a public `kind` + `schemaVersion` around an opaque `state`. `snapshotOf` stamps the
 * version centrally, so individual streams never manage it, and {@link readSnapshot} is the single
 * door back in: it validates the envelope — closed key set, version, and the INDICATOR IDENTITY —
 * before any state is read, and hands back a {@link SnapshotState} whose accessors check each field
 * rather than casting it. A snapshot from a newer schema, from a pre-envelope (v1, flat) build, or
 * from a different indicator is rejected with a typed error instead of restoring a stream seeded
 * with someone else's numbers.
 */

import {
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  isQuantError,
  requireArgumentArray,
  ensureKnownKeys,
} from '@totalfinance/core';
import { MAX_TECHNICAL_ANALYSIS_LOOKBACK } from './limits.js';
import {
  SNAPSHOT_ENVELOPE_KEYS,
  SNAPSHOT_SCHEMA_VERSION,
  checkTechnicalAnalysisSnapshotVersion,
  validateSnapshotEnvelope,
} from './snapshot-envelope.js';

/** OHLCV-style input row for bar indicators. */
export interface BarInput {
  open?: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** The input class an indicator consumes (mirrored by the registry's `IndicatorInputs`). */
export type IndicatorInputKind = 'series' | 'bars' | 'pair';

/**
 * Serialized streaming-state snapshot (3B.N7).
 *
 * The ENVELOPE is explicit and public: `kind` says which indicator wrote it, `schemaVersion` says
 * which shape it is in. `state` is deliberately OPAQUE — a consumer may persist it and hand it back
 * to `fromJSON`, but may not branch on indicator-private keys, which is why those keys are allowed
 * to stay compact where size matters.
 *
 * This replaced a flat shape that put an abbreviated `v` and arbitrary stream state at the SAME
 * level, so nothing distinguished the contract from the payload.
 */
export interface TechnicalAnalysisSnapshot {
  kind: string;
  /** Schema version, stamped at the serialization boundary by {@link snapshotOf}. */
  schemaVersion: number;
  /** Indicator-private stream state. Round-trip it; never read into it. */
  state: Record<string, unknown>;
}

/**
 * Current snapshot schema version. Bump when a stored snapshot's shape changes incompatibly.
 *
 * 2 — the flat `{ kind, v?, ...state }` shape became the explicit `{ kind, schemaVersion, state }`
 * envelope.
 * 3 — non-finite numbers inside `state` are ENCODED (see {@link encodeNonFinite}). Before this,
 * `JSON.stringify` turned every one of them into `null`, so a snapshot could not round-trip through
 * the very format it exists for.
 *
 * No legacy parser is retained at either step: pre-1.0 corrections are clean (law N9), and an older
 * snapshot is rejected by {@link checkSnapshotVersion} with a teaching error rather than misread.
 */
export const SCHEMA_VERSION = SNAPSHOT_SCHEMA_VERSION;

/**
 * How a non-finite number is carried through JSON.
 *
 * `JSON.stringify(NaN)` is `null`. That is not an edge case here — it is the common case: a zero
 * price series makes every log-return NaN, so `realizedVolatility`'s window buffer is NaN-filled from
 * VALID input, and `acos` outside [-1, 1] caches NaN as its last output. Persisting either one and
 * restoring it silently replaced the NaNs with `null`, and `null` in a numeric slot then read as `0`
 * in the next arithmetic. Measured across all 335 indicators against seven degenerate datasets, 38
 * distinct state paths hit this.
 *
 * The wrapper is an OBJECT rather than the string `"NaN"` so it cannot collide with a state field
 * that legitimately holds text.
 */
interface NonFiniteNumber {
  nonFinite: 'NaN' | 'Infinity' | '-Infinity';
}

function isNonFiniteNumber(value: unknown): value is NonFiniteNumber {
  if (value === null || typeof value !== 'object') return false;
  const wrapped = (value as NonFiniteNumber).nonFinite;
  return wrapped === 'NaN' || wrapped === 'Infinity' || wrapped === '-Infinity';
}

function decodeNonFinite(value: NonFiniteNumber): number {
  return value.nonFinite === 'NaN'
    ? Number.NaN
    : value.nonFinite === 'Infinity'
      ? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;
}

/**
 * Replace every non-finite number in a state tree with its wrapper, structurally.
 *
 * Returns the SAME reference when nothing needed encoding, so the overwhelmingly common case — a
 * snapshot with no non-finite value anywhere — allocates nothing and `toJSON` stays as cheap as it
 * was. It is also idempotent: a wrapper is a plain object whose only member is a string, so walking
 * an already-encoded tree (a composed indicator's child snapshot) leaves it untouched.
 */
function encodeNonFinite(value: unknown): unknown {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : ({ nonFinite: String(value) } as NonFiniteNumber);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((element) => {
      const encoded = encodeNonFinite(element);
      if (encoded !== element) changed = true;
      return encoded;
    });
    return changed ? out : value;
  }
  if (value === null || typeof value !== 'object') return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const encoded = encodeNonFinite(member);
    if (encoded !== member) changed = true;
    out[key] = encoded;
  }
  return changed ? out : value;
}

/**
 * Is this a nested snapshot envelope — one that will be decoded by its OWN `readSnapshot` — rather
 * than plain state this walk is responsible for?
 *
 * The test is EXACT, and the first version was not. It asked only for a string `kind` and a numeric
 * `schemaVersion`, which is a shape an ordinary state record can wear by coincidence: give a
 * persisted bar `{ kind: 'engulfing', schemaVersion: 2, high: NaN }` and the walk skipped it, so the
 * raw NaN sailed through the one check that was supposed to make "a raw non-finite means damage"
 * true everywhere. A review caught it; the claim was wrong, not merely imprecise.
 *
 * Requiring the COMPLETE three-key envelope — and nothing besides — closes it, because that is
 * exactly what {@link snapshotOf} writes. A record that carries `kind` and `schemaVersion` plus any
 * other member is state, gets walked, and is convicted.
 */
function isEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<TechnicalAnalysisSnapshot>;
  if (typeof candidate.kind !== 'string' || typeof candidate.schemaVersion !== 'number')
    return false;
  const { state } = candidate;
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;
  return Object.keys(candidate).length === SNAPSHOT_ENVELOPE_KEYS.length;
}

/**
 * Undo {@link encodeNonFinite} across a state tree, once, at the door.
 *
 * `onRaw` fires for a raw non-finite number anywhere in the tree. `snapshotOf` cannot write one, so
 * its presence means damage.
 *
 * Doing this in `readSnapshot` rather than inside each accessor is what makes the rule GLOBAL. Per
 * accessor, only the fields a restorer happens to read were ever checked — and the enforcement
 * harness convicted `readSnapshot` for exactly that: handed a state whose `period` was `NaN`, it
 * returned a reader without complaint, because nothing had asked for `period` yet.
 *
 * A NESTED ENVELOPE is left alone. Its own `readSnapshot` will walk it with its own kind on the
 * error message, and descending here would walk a composed indicator's children once per level.
 */
function decodeTree(
  value: unknown,
  onRaw: (path: string, value: number) => never,
  path = '',
): unknown {
  if (isNonFiniteNumber(value)) return decodeNonFinite(value);
  if (typeof value === 'number' && !Number.isFinite(value)) onRaw(path, value);
  if (isEnvelope(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_TECHNICAL_ANALYSIS_LOOKBACK * 4) {
      throw new InputError(
        `readSnapshot: state array "${path}" exceeds the decode safety ceiling. Re-serialize a bounded stream state.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: path, length: value.length },
        },
      );
    }
    let changed = false;
    const out = value.map((element, i) => {
      const decoded = decodeTree(element, onRaw, `${path}[${i}]`);
      if (decoded !== element) changed = true;
      return decoded;
    });
    return changed ? out : value;
  }
  if (value === null || typeof value !== 'object') return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const decoded = decodeTree(member, onRaw, path === '' ? key : `${path}.${key}`);
    if (decoded !== member) changed = true;
    out[key] = decoded;
  }
  return changed ? out : value;
}

/**
 * Stamp indicator state into the public envelope. Every `toJSON` goes through here.
 *
 * This is also where the state becomes JSON-SAFE: after `snapshotOf`, no number in the tree is
 * non-finite, so `JSON.stringify` is lossless and any raw `NaN` a reader later encounters can only
 * have come from damage — which is what lets {@link SnapshotState} refuse it.
 *
 * `kind` is guarded because the natural wrong call is `snapshotOf(stream)` — reaching for the
 * serializer as if it took the thing to serialize. That produced an envelope whose `kind` was a live
 * stream object and whose `state` was `undefined`: it survives `JSON.stringify` (as `{}`) and only
 * fails much later, at a `fromJSON` that cannot say why.
 */
export function snapshotOf(
  kind: string,
  state: Record<string, unknown>,
): TechnicalAnalysisSnapshot {
  if (typeof kind !== 'string' || kind.length === 0) {
    const streamLike =
      kind !== null &&
      typeof kind === 'object' &&
      typeof (kind as { next?: unknown }).next === 'function';
    throw new InputError(
      `snapshotOf: kind must be the indicator's non-empty name string, got ${kind === null ? 'null' : typeof kind}.` +
        (streamLike
          ? ' To serialize a stream, call `stream.toJSON()` — `snapshotOf` is the envelope stamp a stream uses INSIDE its own `toJSON`.'
          : ''),
      {
        code: ErrorCode.InputWrongType,
        context: { received: kind === null ? 'null' : typeof kind },
      },
    );
  }
  return {
    kind,
    schemaVersion: SCHEMA_VERSION,
    state: encodeNonFinite(state) as Record<string, unknown>,
  };
}

/**
 * Validate a snapshot's schema version before restoring. A newer version is rejected — this build
 * can't know what changed, so restoring would silently corrupt state, which design law #4 forbids.
 * An OLDER version is rejected too: the v1 flat shape has no `state`, so "accepting" it would
 * restore an indicator with every field undefined.
 */
export function checkSnapshotVersion(snapshot: TechnicalAnalysisSnapshot): void {
  checkTechnicalAnalysisSnapshotVersion(snapshot);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The snapshot READER (3B.1): the one door every `fromJSON` / `restore` goes through.
//
// ## What was wrong
//
// Every restorer in this package looked like this:
//
//     const state = snapshotState(snapshot);
//     const x = new AtrStream(state['period'] as number);
//     x.previousClose = state['previousClose'] as number | null;
//
// `as number` is a claim to the COMPILER, not a check at runtime. `snapshotState` validated the
// envelope's version and that `state` was an object, and then every field was read on trust. Measured
// across the package, all 134 public restorers accepted:
//
//   - an envelope carrying a key nothing declares (`{ kind, schemaVersion, state, whatever }`);
//   - an envelope with NO `kind` at all, or a `kind` of the wrong type;
//   - an envelope whose `kind` names a DIFFERENT indicator — the restorer rebuilt its own kind
//     regardless, so an EMA snapshot handed to `AtrStream.fromJSON` produced an ATR stream seeded
//     with EMA numbers;
//   - `NaN` in any state field, which then propagates through every subsequent `next()` forever.
//
// The identity guard existed only on the FACADE (`makeIndicator` below). The static class restorers
// are public too — they are what chart-types, microstructure and every composed indicator call — and
// they had none of it.
//
// ## Three deliberate boundaries
//
// THE ENVELOPE IS CLOSED, `state` IS NOT. `{ kind, schemaVersion, state }` is the public contract: a
// caller who writes `schemaversion` must hear about it, not silently restore. The keys INSIDE
// `state` are indicator-private — this module's own header calls them opaque and says they may stay
// compact because no consumer reads them. A key this build does not know is dead weight there, not a
// caller error, so `state` stays open.
//
// NON-FINITE IS ENCODED, SO A RAW ONE IS ALWAYS DAMAGE. The first version of this reader simply
// refused NaN, on the reasoning that a NaN period never heals. Measuring it said otherwise: fed a
// zero price series, `realizedVolatility` fills its window buffer with NaN log-returns from PERFECTLY
// VALID input, and 38 distinct state paths across the 335 indicators do something similar. Refusing
// NaN would have refused to restore correct streams.
//
// The way out is not to tolerate it — a tolerated NaN is an unenforceable contract, since a NaN that
// came from arithmetic and a NaN that came from a damaged file are the same value. `snapshotOf`
// ENCODES non-finite numbers (see {@link SCHEMA_VERSION} 3), so after serialization `state` contains
// none. That makes the rule uniform and checkable: an encoded non-finite decodes and is accepted; a
// RAW one cannot have come from this library, and is refused wherever it appears.
//
// NAMING A STATE KEY IN AN ERROR IS NAMING A LOCATOR, NOT TEACHING A NAME (spec N8). These messages
// interpolate the key — trSum, hist, buf — because "which field is damaged" IS the diagnosis. That
// does not make the key a public name: a caller cannot hand-write a snapshot, they round-trip one,
// and this module already exempts state keys from expansion for exactly that reason. The corrective
// action a message gives is always "re-serialize with this build", never "rename".
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `typeof`, plus the distinctions `typeof` refuses to make, phrased to read inside a sentence. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `the string "${value}"`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/**
 * Checked access to one snapshot's opaque state.
 *
 * Every accessor takes the state key and returns the value the restorer needs, or throws a typed
 * `InputError` naming the indicator and the key. There is no accessor that returns `unknown`: a
 * restorer that cannot express what it needs is a restorer that is not checking.
 */
class SnapshotState<Kind extends string = string> {
  constructor(
    /**
     * The indicator kind this state belongs to — the prefix on every message, and, for a FAMILY
     * restorer, the narrowed member the guard just proved. `readSnapshot(s, MOMENT_KINDS)` hands back
     * a state whose `kind` is `'standardDeviation' | 'variance'`, so the restorer feeds it straight
     * into its constructor instead of re-asserting `snapshot.kind as string` — which is the cast the
     * guard exists to make unnecessary.
     */
    readonly kind: Kind,
    private readonly state: Record<string, unknown>,
  ) {}

  /** The raw state object. For a restorer that must hand a whole sub-object to a helper. */
  get raw(): Record<string, unknown> {
    return this.state;
  }

  /** Does the state carry this key at all? For a field a newer build may legitimately omit. */
  has(field: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.state, field);
  }

  private fail(field: string, requirement: string, value: unknown, code: string): never {
    throw new InputError(
      `${this.kind}: snapshot state "${field}" ${requirement}, got ${describe(value)}. ` +
        `The snapshot is damaged or was not produced by this indicator — re-serialize it from a live stream.`,
      { code, context: { kind: this.kind, field, received: describe(value) } },
    );
  }

  private present(field: string): unknown {
    if (!this.has(field)) this.fail(field, 'is required', undefined, ErrorCode.InputMissingField);
    return this.state[field];
  }

  /**
   * A number: sums, running averages, thresholds, multipliers.
   *
   * Non-finite is permitted HERE and refused at the door. `readSnapshot` has already walked the whole
   * state: an encoded non-finite has been decoded (the indicator computed it — a zero price series
   * makes every log-return NaN), and a raw one has been rejected as damage. By the time an accessor
   * runs, `NaN` can only mean the first.
   */
  number(field: string): number {
    return this.readNumber(field, this.present(field));
  }

  private readNumber(field: string, value: unknown): number {
    if (typeof value !== 'number')
      this.fail(field, 'must be a number', value, ErrorCode.InputWrongType);
    return value;
  }

  /** A number or `null` — a running value that has not been established yet. */
  numberOrNull(field: string): number | null {
    const value = this.present(field);
    if (value === null) return null;
    return this.readNumber(field, value);
  }

  /** A number the state may omit entirely (an optional parameter a stream carries). */
  optionalNumber(field: string): number | undefined {
    if (!this.has(field) || this.state[field] === undefined) return undefined;
    return this.number(field);
  }

  /**
   * A whole number ≥ 0 — a count, an index, a bar offset. A fractional count restores a stream whose
   * window boundaries never line up again, which shows up as an off-by-a-fraction output rather than
   * as an error.
   */
  integer(field: string): number {
    const value = this.number(field);
    if (!Number.isInteger(value))
      this.fail(field, 'must be a whole number', value, ErrorCode.InputWrongType);
    // Safe integer (2026-08-23 review, P0): restored counts are INCREMENTED by the stream they feed,
    // and above 2^53 `++` stops advancing — a snapshot carrying such a "count" would restore a stream
    // whose clock is frozen, so it is corrupt state, not a big number.
    if (!Number.isSafeInteger(value))
      this.fail(
        field,
        'must be an exactly-representable count (at most 2^53 − 1) — a stream cannot advance a counter past that',
        value,
        ErrorCode.InputOutOfRange,
      );
    if (value < 0) this.fail(field, 'must not be negative', value, ErrorCode.InputOutOfRange);
    return value;
  }

  /**
   * A lookback: an integer ≥ 1.
   *
   * This is the asymmetry the reader exists to close. `ta.rsi.stream({ period: -3 })` throws from
   * `requirePeriod`; `RsiStream.fromJSON` read the same number straight out of state and built a
   * stream with a negative window, which produces `undefined` buffer reads and silent NaN.
   */
  lookback(field: string): number {
    const value = this.number(field);
    if (!Number.isInteger(value) || value < 1)
      this.fail(field, 'must be a lookback of 1 or more', value, ErrorCode.InputOutOfRange);
    // The same bound as direct construction: restore is another public allocation door, not a
    // trusted shortcut around the resource contract.
    if (!Number.isSafeInteger(value) || value > MAX_TECHNICAL_ANALYSIS_LOOKBACK)
      this.fail(
        field,
        `must be an exactly-representable lookback at most ${MAX_TECHNICAL_ANALYSIS_LOOKBACK.toLocaleString('en-US')} — restored streams may allocate one or two arrays of this length, so a larger "window" is corrupt snapshot state, not a buffer size`,
        value,
        ErrorCode.InputOutOfRange,
      );
    return value;
  }

  /** A boolean flag. */
  boolean(field: string): boolean {
    const value = this.present(field);
    if (typeof value !== 'boolean')
      this.fail(field, 'must be a boolean', value, ErrorCode.InputWrongType);
    return value;
  }

  /** A string. */
  text(field: string): string {
    const value = this.present(field);
    if (typeof value !== 'string')
      this.fail(field, 'must be a string', value, ErrorCode.InputWrongType);
    return value;
  }

  /**
   * A value drawn from a closed set — a mode, a method, a moving-average family, a trade direction.
   *
   * Numbers as well as strings: `TradeDirection` is `-1 | 0 | 1`, and reading it as a plain number
   * would accept `7` as a trade direction.
   */
  literal<T extends string | number>(field: string, allowed: readonly T[]): T {
    const value = this.present(field);
    if (typeof value !== 'string' && typeof value !== 'number')
      this.fail(field, 'must be a string or a number', value, ErrorCode.InputWrongType);
    if (!(allowed as readonly unknown[]).includes(value))
      throw new InputError(
        `${this.kind}: snapshot state "${field}" must be one of ${allowed.join(' | ')}, got ${describe(value)}. ` +
          `The snapshot is damaged or was not produced by this indicator — re-serialize it from a live stream.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { kind: this.kind, field, received: value, allowed },
        },
      );
    return value as T;
  }

  /**
   * A FRESH array of finite numbers.
   *
   * Fresh matters: the previous `state['buf'] as number[]` aliased the caller's snapshot, so two
   * streams restored from one snapshot object shared a buffer and corrupted each other. Restorers
   * used to spell that defence themselves (`[...(state['buf'] as number[])]`) and could forget to.
   */
  numbers(field: string): number[] {
    const value = this.present(field);
    return this.readNumbers(field, value);
  }

  /** A fresh array of finite numbers, or `null`. */
  numbersOrNull(field: string): number[] | null {
    const value = this.present(field);
    if (value === null) return null;
    return this.readNumbers(field, value);
  }

  /** A fresh array of finite numbers the state may omit. */
  optionalNumbers(field: string): number[] | undefined {
    if (!this.has(field) || this.state[field] === undefined) return undefined;
    return this.readNumbers(field, this.state[field]);
  }

  private readNumbers(field: string, value: unknown): number[] {
    if (!Array.isArray(value))
      this.fail(field, 'must be an array of numbers', value, ErrorCode.InputWrongType);
    const out = new Array<number>(value.length);
    for (let i = 0; i < value.length; i++)
      out[i] = this.readNumber(`${field}[${i}]`, value[i] as unknown);
    return out;
  }

  /** A fresh array of fresh number arrays — a matrix of windows. */
  numberRows(field: string): number[][] {
    const value = this.present(field);
    if (!Array.isArray(value))
      this.fail(field, 'must be an array', value, ErrorCode.InputWrongType);
    return value.map((row, i) => this.readNumbers(`${field}[${i}]`, row));
  }

  /**
   * A nested snapshot envelope — a composed indicator's child (`macd` carries three EMAs).
   *
   * Only the SHAPE is checked here. The child's own `fromJSON` calls `readSnapshot` with the kind it
   * expects, so a child from the wrong indicator is convicted there, with that indicator's name on
   * the message rather than the parent's.
   */
  child(field: string): TechnicalAnalysisSnapshot {
    const value = this.present(field);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      this.fail(field, 'must be a nested snapshot', value, ErrorCode.SnapshotWrongShape);
    return value as TechnicalAnalysisSnapshot;
  }

  /** A fresh array of nested snapshot envelopes. */
  children(field: string): TechnicalAnalysisSnapshot[] {
    const value = this.present(field);
    if (!Array.isArray(value))
      this.fail(field, 'must be an array of nested snapshots', value, ErrorCode.SnapshotWrongShape);
    return value.map((element, i) => {
      if (element === null || typeof element !== 'object' || Array.isArray(element))
        this.fail(
          `${field}[${i}]`,
          'must be a nested snapshot',
          element,
          ErrorCode.SnapshotWrongShape,
        );
      return element as TechnicalAnalysisSnapshot;
    });
  }

  /**
   * The LAST EMITTED OUTPUT, cached so a restored stream's `.value` is not blank until the next bar.
   *
   * Deliberately the loosest accessor, and the only one that tolerates non-finite: `NaN` is a real
   * output. `acos` outside [-1, 1] is NaN; a `fairValueGaps` point reads `{ top: NaN, bottom: NaN }`
   * until a gap forms. Rejecting those would refuse to restore a correct stream.
   *
   * What it still refuses is a value of a kind no indicator ever outputs — a string, a boolean, a
   * function — which is what a foreign or hand-edited snapshot looks like.
   *
   * A missing key reads as `null` rather than throwing: the cache is an optimisation, and a snapshot
   * that predates an indicator caching its value must restore to "no value yet", not fail.
   */
  cached<T>(field: string): T | null {
    if (!this.has(field)) return null;
    const value = this.state[field];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' && typeof value !== 'object')
      this.fail(field, 'must be a cached output value or null', value, ErrorCode.InputWrongType);
    return value as T;
  }

  /**
   * A structured record the indicator persists whole — a bar, a candle, an accumulator.
   *
   * Members are not walked: their shape is the indicator's own business and varies per record type.
   * The check is that it IS a record, which is what separates a usable snapshot from `"acc"` or `7`.
   */
  record<T>(field: string): T {
    const value = this.present(field);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      this.fail(field, 'must be an object', value, ErrorCode.InputWrongType);
    return value as T;
  }

  /** A structured record, or `null` when the indicator has not established one. */
  recordOrNull<T>(field: string): T | null {
    const value = this.present(field);
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value))
      this.fail(field, 'must be an object or null', value, ErrorCode.InputWrongType);
    return value as T;
  }

  /** A fresh array of structured records — persisted bars, candles, levels. */
  records<T>(field: string): T[] {
    const value = this.present(field);
    if (!Array.isArray(value))
      this.fail(field, 'must be an array', value, ErrorCode.InputWrongType);
    return value.map((element, i) => {
      if (element === null || typeof element !== 'object' || Array.isArray(element))
        this.fail(`${field}[${i}]`, 'must be an object', element, ErrorCode.InputWrongType);
      return element as T;
    });
  }

  /** A fresh array of values drawn from a closed set. */
  literals<T extends string | number>(field: string, allowed: readonly T[]): T[] {
    const value = this.present(field);
    if (!Array.isArray(value))
      this.fail(field, 'must be an array', value, ErrorCode.InputWrongType);
    return value.map((element, i) => {
      if (!(allowed as readonly unknown[]).includes(element))
        this.fail(
          `${field}[${i}]`,
          `must be one of ${allowed.join(' | ')}`,
          element,
          ErrorCode.InputInvalidEnum,
        );
      return element as T;
    });
  }
}

/**
 * The reader's type is public; its CONSTRUCTOR is not.
 *
 * A caller needs to name `SnapshotState` — it is what a custom indicator's restorer receives. A
 * caller never builds one: `readSnapshot` does, after it has checked the envelope. Exporting the
 * class as a value would publish `new SnapshotState(kind, state)`, a door straight past the guard,
 * which is the shape of the defect this whole boundary exists to remove.
 */
export type { SnapshotState };

/**
 * Validate a snapshot envelope and open its state for checked reading.
 *
 * `expected` is the kind the CALLING restorer produces. Passing it is what turns a restorer from
 * "rebuilds itself out of whatever numbers are in front of it" into one that knows whose snapshot it
 * is holding — and it costs the call site four characters.
 *
 * A LIST is accepted for the handful of restorers that serve a FAMILY: one `MomentStream` class backs
 * both `standardDeviation` and `variance`, and reads which one it is off the snapshot. Those are the
 * restorers that genuinely may not pin a single kind — and a list still pins the family, which is the
 * whole guarantee. A restorer that pins nothing is the defect this parameter exists to remove, so
 * there is no form of this call that omits it.
 *
 * Order matters, and each step is the precondition of the next: an envelope that is not an object has
 * no version; a version this build cannot read makes every field meaningless; a snapshot from another
 * indicator has the wrong fields entirely, so reporting a missing field would send the reader looking
 * in the wrong place.
 */
export function readSnapshot<Kind extends string>(
  snapshot: TechnicalAnalysisSnapshot,
  expected: Kind | readonly Kind[],
): SnapshotState<Kind> {
  const { kind, state } = validateSnapshotEnvelope(snapshot, expected);
  const decoded = decodeTree(state, (path, raw) => {
    throw new InputError(
      `${kind}: snapshot state "${path}" is a raw ${String(raw)}. This build encodes non-finite ` +
        `numbers, so a raw one means the stored snapshot was damaged or hand-built — re-serialize it ` +
        `from a live stream.`,
      { code: ErrorCode.InputNotFinite, context: { kind, field: path, received: String(raw) } },
    );
  }) as Record<string, unknown>;

  return new SnapshotState(kind, decoded);
}

/** A stateful streaming indicator. `next` returns `null` during warmup. */
export interface IndicatorStream<In, Out> {
  next(input: In): Out | null;
  readonly value: Out | null;
  toJSON(): TechnicalAnalysisSnapshot;
}

/**
 * A live streaming indicator (spec §13.4, WS6.1) — an {@link IndicatorStream} plus `peek`, the
 * forming-bar affordance. This is the public shape returned by `indicator.stream(...)` /
 * `indicator.fromJSON(...)`; concrete indicator streams only need to implement {@link IndicatorStream}
 * (the wrapper supplies `peek` for all of them).
 *
 * Named `peek` — not `update` — because it NEVER commits (alignment spec P3.5a): `update` is the
 * feed-the-next-value verb in every other streaming TA library, and under that reading a stream
 * fed exclusively through it would silently stay empty forever. `peek` says exactly what happens.
 */
export interface LiveStream<In, Out> extends IndicatorStream<In, Out> {
  /**
   * The value that WOULD result from `next(input)` applied to the committed state, WITHOUT committing
   * it. Call it repeatedly with the forming bar's evolving value; call `next(input)` once at bar close
   * to commit. Between commits the committed state is untouched, so a live chart never repaints its
   * closed bars. The default cost is O(snapshot) per call (clone-and-apply); indicators may override
   * with an O(1) form later.
   */
  peek(input: In): Out | null;
}

// NOTE: the batch shape `{ value, warmup }` returned by `collect`/`collectAsync` is deliberately an
// inline structural type, NOT a named public type — R1 deleted `SeriesResult`. The public
// `.explain()` envelope is `TechnicalAnalysisExplain` (one envelope law, dx §2.2): `value` + `assumptions` +
// `diagnostics`, with the warmup count under `diagnostics.warmup`.

/**
 * A JSON-safe record of the CHOICES an indicator made that its parameters do not reveal.
 *
 * Parameters say what you asked for; conventions say what the library decided on your behalf — and
 * those decisions are where two implementations of "the same" indicator disagree. RSI is the
 * canonical case: TotalFinance smooths with Wilder's method (not a plain EMA) and returns 100 on a
 * perfectly flat series, where TA-Lib returns 0 and pandas-ta returns NaN. All three are defensible;
 * none is discoverable from the number alone.
 *
 * Values are scalars so the block survives `JSON.stringify` intact and reads the same over MCP as it
 * does in a REPL. Keys are per indicator, but recurring ones are spelled consistently: `smoothing`,
 * `seeding`, `flatSeries`, `scale`, `reference`, `divergence`.
 */
export type IndicatorConventions = Readonly<Record<string, string | number | boolean>>;

/** Domain extras every TA explain envelope discloses. */
export interface TechnicalAnalysisAssumptionExtras extends Record<string, unknown> {
  /** The indicator's registry/snapshot kind, e.g. `'rsi'`. */
  indicator: string;
  /** The parameters the computation ran with: declared defaults merged with the caller's parameters. */
  parameters: Record<string, unknown>;
  /**
   * The indicator's declared conventions, when it has any that a caller could otherwise only learn
   * from prose. Absent — not an empty object — for indicators whose behaviour holds no such choice,
   * so its presence always means something.
   */
  conventions?: IndicatorConventions;
}

/** The TA explain envelope: core `Computed` whose diagnostics ALWAYS carry the warmup count. */
export type TechnicalAnalysisExplain<Out> = Omit<
  Computed<Out[], TechnicalAnalysisAssumptionExtras>,
  'diagnostics'
> & {
  diagnostics: Computed<Out[], TechnicalAnalysisAssumptionExtras>['diagnostics'] & {
    warmup: number;
  };
};

/**
 * Boundary guard shared by `collect` / `collectAsync` / `streamAsync` (the first-touch law): a
 * "stream" without a callable `next` — `{}`, a snapshot object, a batch result — would otherwise
 * surface as a raw `TypeError` mid-drain. `requireArgumentObject` alone cannot catch that class.
 */
function requireIndicatorStream(functionName: string, stream: unknown): void {
  if (
    stream === null ||
    typeof stream !== 'object' ||
    typeof (stream as { next?: unknown }).next !== 'function'
  ) {
    throw new InputError(
      `${functionName}: stream must be an IndicatorStream (an object with next()). Received ${stream === null ? 'null' : typeof stream}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName } },
    );
  }
}

/**
 * Run a stream over a series, producing aligned output with a NaN sentinel during warmup. `warmup`
 * is the index of the first non-warmup value (equal to the input length if it never emits).
 */
export function collect<In, Out>(
  stream: IndicatorStream<In, Out>,
  input: ArrayLike<In>,
  nan: Out,
): { value: Out[]; warmup: number } {
  // Publicly reachable via the /framework subpath — guard like any facade boundary.
  requireIndicatorStream('collect', stream);
  requireArgumentArray('collect', 'input', input);
  const value = new Array<Out>(input.length);
  let warmup = input.length;
  for (let i = 0; i < input.length; i++) {
    const r = stream.next(input[i]!);
    if (r === null) {
      value[i] = nan;
    } else {
      value[i] = r;
      if (warmup === input.length) warmup = i;
    }
  }
  return { value, warmup };
}

/**
 * Feed a stream from an **async iterable** source (spec §13.2 streaming adapters), yielding each
 * non-`null` (post-warmup) output as it is produced. Lets indicators consume live feeds — websockets,
 * async DB cursors, generators — without buffering the whole series. Pure: it reads only what the
 * source yields and never touches the clock.
 */
export async function* streamAsync<In, Out>(
  stream: IndicatorStream<In, Out>,
  source: AsyncIterable<In>,
): AsyncGenerator<Out> {
  requireIndicatorStream('streamAsync', stream);
  if (
    source === null ||
    source === undefined ||
    typeof (source as AsyncIterable<In>)[Symbol.asyncIterator] !== 'function'
  ) {
    throw new InputError(
      `streamAsync: source must be an async iterable (for await…of), got ${source === null ? 'null' : typeof source}.`,
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  for await (const input of source) {
    const r = stream.next(input);
    if (r !== null) yield r;
  }
}

/** Drain an async iterable through a stream into an aligned series (NaN sentinel during warmup). */
export async function collectAsync<In, Out>(
  stream: IndicatorStream<In, Out>,
  source: AsyncIterable<In>,
  nan: Out,
): Promise<{ value: Out[]; warmup: number }> {
  requireIndicatorStream('collectAsync', stream);
  if (
    source === null ||
    source === undefined ||
    typeof (source as AsyncIterable<In>)[Symbol.asyncIterator] !== 'function'
  ) {
    throw new InputError(
      `collectAsync: source must be an async iterable (for await…of), got ${source === null ? 'null' : typeof source}.`,
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  const value: Out[] = [];
  let warmup = -1;
  for await (const input of source) {
    const r = stream.next(input);
    if (r === null) {
      value.push(nan);
    } else {
      if (warmup === -1) warmup = value.length;
      value.push(r);
    }
  }
  return { value, warmup: warmup === -1 ? value.length : warmup };
}

/**
 * A facade indicator: callable (batch) with `.explain`, `.stream`, and `.fromJSON`.
 *
 * `parameters` is OPTIONAL on every call form (the first-touch law): a parameters object is never required
 * just to *reach* the facade. When it is omitted, indicators with industry-standard defaults (RSI 14,
 * MACD 12/26/9, BBands 20/2, …) resolve them; indicators whose parameters have no universal default throw
 * a typed teaching `InputError` naming the field — never a raw `TypeError` from a property access.
 */
export interface Indicator<Params, In, Out> {
  (input: ArrayLike<In>, parameters?: Params): Out[];
  explain(input: ArrayLike<In>, parameters?: Params): TechnicalAnalysisExplain<Out>;
  stream(parameters?: Params): LiveStream<In, Out>;
  fromJSON(snapshot: TechnicalAnalysisSnapshot): LiveStream<In, Out>;
}

/** Deep-clone a JSON-safe snapshot so a restored clone shares no state with its source. */
function cloneSnapshot(snapshot: TechnicalAnalysisSnapshot): TechnicalAnalysisSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TechnicalAnalysisSnapshot;
}

/**
 * Thin delegating wrapper that (a) stamps the schema version onto a stream's snapshot at the facade
 * boundary, so no individual indicator has to manage versioning, and (b) supplies the forming-bar
 * `update` affordance (WS6.1) for every indicator. The batch path (`collect`) uses the raw stream and
 * never pays for either.
 */
class VersionedStream<In, Out> implements LiveStream<In, Out> {
  /** Lazily-captured snapshot of the committed state; invalidated on each `next`. */
  private committed: TechnicalAnalysisSnapshot | null = null;

  constructor(
    private readonly inner: IndicatorStream<In, Out>,
    private readonly restore: (snapshot: TechnicalAnalysisSnapshot) => IndicatorStream<In, Out>,
  ) {}

  next(input: In): Out | null {
    // Committing advances the state, so any cached snapshot of the previous committed state is stale.
    this.committed = null;
    return this.inner.next(input);
  }

  get value(): Out | null {
    return this.inner.value;
  }

  peek(input: In): Out | null {
    // Capture the committed state once (cached until the next commit), then apply `input` to a fresh
    // deep clone so the committed stream is never mutated — the forming-bar value without a repaint.
    if (this.committed === null) this.committed = this.inner.toJSON();
    const clone = this.restore(cloneSnapshot(this.committed));
    return clone.next(input);
  }

  toJSON(): TechnicalAnalysisSnapshot {
    // Already a stamped envelope: `snapshotOf` sets `schemaVersion` at every stream's serialization
    // boundary. The old wrapper merged a `v` field into the flat snapshot and had to police streams
    // that serialized their own `v` — a collision the envelope makes structurally impossible, since
    // indicator state now lives under `state` and cannot reach the envelope's fields.
    return this.inner.toJSON();
  }
}

const OHLCV_KEYS = ['open', 'high', 'low', 'close', 'volume'] as const;

/**
 * First-element shape check by input kind (dx WS-1.2): the most natural wrong call for a bar
 * indicator is a plain number series (`atr(closes)`), and for a pair indicator a bare series — both
 * used to degrade silently into an all-NaN output. Element 0 only (container-level + first-element
 * checks per design law; interior malformed elements can still slip through — a documented,
 * deliberate hot-path trade-off).
 */
function validateFirstElement(
  first: unknown,
  kindOf: () => string,
  inputs: IndicatorInputKind,
): void {
  if (inputs === 'bars') {
    if (typeof first === 'number') {
      throw new InputError(
        `technicalAnalysis.${kindOf()}: expects OHLC bars ({ high, low, close, … } per element) — got a number ` +
          `series; build bars with ta.barsFromColumns({ high, low, close, … }) or pass bars.`,
        { code: ErrorCode.InputWrongType, context: { received: 'number' } },
      );
    }
    if (first === null || typeof first !== 'object') {
      throw new InputError(
        `technicalAnalysis.${kindOf()}: expects OHLC bars ({ high, low, close, … } per element) — bars[0] is ` +
          `${first === null ? 'null' : typeof first}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { received: first === null ? 'null' : typeof first },
        },
      );
    }
    for (const k of ['high', 'low', 'close'] as const) {
      const v = (first as Record<string, unknown>)[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new InputError(
          `technicalAnalysis.${kindOf()}: bars[0].${k} must be a finite number, got ${typeof v === 'number' ? v : v === undefined ? 'undefined' : typeof v}.`,
          { code: ErrorCode.InputWrongType, context: { field: k } },
        );
      }
    }
    return;
  }
  if (inputs === 'pair') {
    const p = first as Record<string, unknown> | null;
    if (
      p === null ||
      typeof p !== 'object' ||
      typeof p['x'] !== 'number' ||
      typeof p['y'] !== 'number'
    ) {
      throw new InputError(
        `technicalAnalysis.${kindOf()}: expects { x, y } pairs per element — build them with technicalAnalysis.pairs(xs, ys).`,
        { code: ErrorCode.InputWrongType, context: {} },
      );
    }
  }
}

/**
 * Validate a batch series at the facade choke point (dx §1.2): the container must be a real array
 * (or typed array); string elements (and, for number-series indicators, object elements) are
 * rejected by name; and the first element is shape-checked against the indicator's input kind.
 * Silence was the old failure mode — `rsi("hello")` returned `[null×5]`, `atr(closes)` returned
 * all-NaN — so garbage now throws a typed teaching error instead. Non-finite NUMERIC gaps inside a
 * valid array remain legal and flow through the indicator's own arithmetic as NaN. (Note: that
 * leniency is a TotalFinance choice, NOT TA-Lib parity — TA-Lib rejects interior NaNs outright.)
 */
function validateSeries<In>(
  input: ArrayLike<In>,
  kindOf: () => string,
  inputs?: IndicatorInputKind,
): void {
  if (Array.isArray(input) || ArrayBuffer.isView(input)) {
    // Reject string elements anywhere — they silently coerce through arithmetic into all-null
    // output. For number-series indicators, reject object elements in the same pass (bars handed
    // to a series indicator would otherwise degrade to all-NaN). A single typeof pass is
    // negligible next to the indicator's own arithmetic.
    for (let i = 0; i < input.length; i++) {
      const v = input[i];
      if (typeof v === 'string') {
        throw new InputError(
          `technicalAnalysis.${kindOf()}: series[${i}] is a string ("${String(v).slice(0, 20)}") — pass numbers (or bars).`,
          { code: ErrorCode.InputWrongType, context: { index: i } },
        );
      }
      if (inputs === 'series' && v !== null && typeof v === 'object') {
        throw new InputError(
          `technicalAnalysis.${kindOf()}: expects a number series — series[${i}] is an object. Map the field ` +
            `first (e.g. bars.map((b) => b.close)) or use a bar indicator.`,
          { code: ErrorCode.InputWrongType, context: { index: i } },
        );
      }
    }
    if (input.length > 0 && inputs !== undefined && inputs !== 'series') {
      validateFirstElement(input[0], kindOf, inputs);
    }
    return;
  }
  if (typeof input === 'string') {
    throw new InputError(
      `technicalAnalysis.${kindOf()}: series must be an array of values (got a string).`,
      {
        code: ErrorCode.InputWrongType,
        context: { received: 'string' },
      },
    );
  }
  if (input !== null && typeof input === 'object') {
    const obj = input as unknown as Record<string, unknown>;
    // The classic wrong shape: columnar arrays ({ high: [...], low: [...], close: [...] }) where
    // an array of bar rows is expected. Teach the converter instead of silently emitting garbage.
    if (OHLCV_KEYS.some((k) => Array.isArray(obj[k]))) {
      throw new InputError(
        `technicalAnalysis.${kindOf()}: expected an array of bars ({ high, low, close, … } per element); ` +
          `received columnar arrays — convert with ta.barsFromColumns({ high, low, close, … }).`,
        { code: ErrorCode.InputWrongType, context: { received: 'columnar' } },
      );
    }
  }
  throw new InputError(
    `technicalAnalysis.${kindOf()}: series must be an array of values (got ${input === null ? 'null' : typeof input}).`,
    {
      code: ErrorCode.InputWrongType,
      context: { received: input === null ? 'null' : typeof input },
    },
  );
}

/**
 * Metadata bound onto a facade (one slot per indicator, keyed by a symbol):
 * `defaults` are the indicator's declared parameter defaults, echoed through
 * `.explain().assumptions.parameters` merged under the caller's parameters — the disclosure law (R1): a
 * default that engages is a default that is disclosed. A default's value may be a resolver
 * `(resolved) => value` for the rare default computed from another parameter. `inputs` is the input
 * kind the batch facade uses for first-element shape checks (WS-1.2).
 */
interface RuntimeMetadata {
  defaults: Record<string, unknown>;
  inputs?: IndicatorInputKind;
  /** Declared parameter names — when bound, unknown param keys are rejected (Law 12). */
  parameters?: readonly string[];
  /** Declared conventions, echoed by `.explain()` (see {@link IndicatorConventions}). */
  conventions?: IndicatorConventions;
}

const META = Symbol.for('totalfinance.technicalAnalysis.indicatorMetadata');

function metaOf(indicator: unknown): RuntimeMetadata | undefined {
  return typeof indicator === 'function'
    ? (indicator as unknown as Record<symbol, RuntimeMetadata | undefined>)[META]
    : undefined;
}

/**
 * Bind registration metadata onto a facade built by {@link makeIndicator} — the single choke point
 * of the disclosure law: built-in leaves bind their shared private contracts at construction, and
 * custom registry entries bind their declarations at registration. Every `.explain()` call echoes
 * defaults merged under the caller's parameters. Also records the
 * input kind so the batch facade can shape-check the first element (number series vs OHLC bars vs
 * `{ x, y }` pairs). Later bindings merge over earlier ones, so an alias registration re-binding
 * identical data is a no-op.
 *
 * @internal — called by built-in construction and `registry.register`; not public API.
 */
export function bindIndicatorMetadata(
  indicator: unknown,
  metadata: {
    defaults?: Record<string, unknown>;
    inputs?: IndicatorInputKind;
    parameters?: readonly string[];
    conventions?: IndicatorConventions;
  },
): void {
  if (metadata === null || typeof metadata !== 'object') {
    throw new InputError(
      `bindIndicatorMetadata: metadata must be an object of { defaults?, inputs? }. Received ${metadata === null ? 'null' : typeof metadata}.`,
      { code: ErrorCode.InputWrongType, context: { function: 'bindIndicatorMetadata' } },
    );
  }
  const m = metaOf(indicator);
  if (m === undefined) {
    // Only makeIndicator facades carry the metadata slot. Declaring defaults for anything else would
    // silently break the disclosure law, so fail loudly; binding nothing is harmless.
    if (metadata.defaults && Object.keys(metadata.defaults).length > 0) {
      throw new InputError(
        'bindIndicatorMetadata: defaults can only be declared for indicators built by makeIndicator / defineIndicator.',
        { code: ErrorCode.InputWrongType, context: {} },
      );
    }
    return;
  }
  if (metadata.defaults) Object.assign(m.defaults, metadata.defaults);
  if (metadata.inputs) m.inputs = metadata.inputs;
  if (metadata.parameters) m.parameters = metadata.parameters;
  // Frozen so a caller who reads `.explain().assumptions.conventions` cannot edit the declaration
  // every LATER call will echo — the disclosure is shared state, and an echo that a consumer can
  // rewrite is worse than none.
  if (metadata.conventions) m.conventions = Object.freeze({ ...metadata.conventions });
}

/**
 * The disclosure-law echo: every declared default, resolved to the concrete value the computation
 * ran with, merged under the caller's (defined) parameters. Literal defaults resolve first; resolver
 * defaults (`(resolved) => value`) run second so they can read the other resolved parameters.
 */
function resolveEchoParams(
  defaults: Record<string, unknown>,
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  // Non-primitive defaults (arrays like kst's rocPeriods, objects like divergence's swing) are
  // cloned into the echo, so a caller mutating the returned parameters can never corrupt the declared
  // registry defaults shared by every later call.
  const cloneDefault = (d: unknown): unknown =>
    d !== null && typeof d === 'object' ? (JSON.parse(JSON.stringify(d)) as unknown) : d;
  const merged: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(defaults)) {
    if (typeof d !== 'function') merged[k] = cloneDefault(d);
  }
  Object.assign(merged, supplied);
  for (const [k, d] of Object.entries(defaults)) {
    if (merged[k] === undefined && typeof d === 'function') {
      merged[k] = cloneDefault((d as (resolved: Record<string, unknown>) => unknown)(merged));
    }
  }
  return merged;
}

/**
 * Build a facade indicator from a stream factory, a restorer, and a NaN-sentinel factory.
 * `defaults` (when declared) are the indicator's industry-standard parameters, echoed through
 * `.explain().assumptions.parameters` merged under the caller's parameters — the disclosure contract: a
 * default that engages is a default that is disclosed. Built-in construction and custom registration
 * bind the complete contract onto the same slot via {@link bindIndicatorMetadata}.
 */
export function makeIndicator<Params, In, Out>(
  make: (parameters: Params) => IndicatorStream<In, Out>,
  restore: (snapshot: TechnicalAnalysisSnapshot) => IndicatorStream<In, Out>,
  nan: (parameters: Params) => Out,
  defaults?: Record<string, unknown>,
): Indicator<Params, In, Out> {
  // Single choke point for the first-touch law: a missing parameters object becomes `{}`, so each
  // indicator's own `p.field ?? default` logic engages (industry defaults) or its validator throws a
  // typed `InputError`. A *positional* parameters argument (`rsi(series, 7)`, the TA-Lib/pandas-ta muscle
  // memory) would slip through `p.period ?? default` and SILENTLY compute the default period — the exact
  // silent-miscompute class first-touch exists to kill — so reject a defined non-plain-object here with a
  // typed teaching error naming the indicator and the correct object-parameters call.
  const resolve = (parameters?: Params): Params => {
    // Law 12: once construction or registration has bound the parameter names, an unknown key in the
    // parameters object is rejected with a did-you-mean — `{ perid: 7 }` must never silently compute
    // the default period.
    if (
      parameters != null &&
      typeof parameters === 'object' &&
      !Array.isArray(parameters) &&
      meta.parameters !== undefined
    ) {
      let kind = 'indicator';
      for (const key of Object.keys(parameters)) {
        if (!meta.parameters.includes(key)) {
          try {
            kind = String(make({} as Params).toJSON().kind);
          } catch {
            /* keep the generic name */
          }
          ensureKnownKeys(kind, 'parameters', parameters, meta.parameters);
        }
      }
    }
    if (parameters != null && typeof parameters === 'object' && !Array.isArray(parameters)) {
      /**
       * Null is not omission (the 350c2796 ruling, applied at this ONE choke point for all ~335
       * indicators): `{ period: null }` used to fall through each indicator's `p.period ?? default`
       * and SILENTLY compute the industry default — the exact silent-miscompute class this resolve
       * step exists to kill, arriving as null does in practice (`JSON.stringify(NaN)`, a LEFT
       * JOIN, a producer "clearing" a field). Every registry-declared parameter is non-nullable.
       */
      for (const key of Object.keys(parameters)) {
        // A parameter whose DECLARED DEFAULT is null is definitionally nullable — the no-param
        // call engages null and the disclosure law echoes it (`tosStdevAll.period: null` means
        // "all bars"). Everywhere else, null is a wrong-typed value.
        if (
          (parameters as Record<string, unknown>)[key] === null &&
          meta.defaults?.[key] !== null
        ) {
          let kind = 'indicator';
          try {
            kind = String(make({} as Params).toJSON().kind);
          } catch {
            /* keep the generic name */
          }
          throw new InputError(
            `${kind}: parameters.${key} must not be null — omit the field to use the declared default. Received null.`,
            {
              code: ErrorCode.InputWrongType,
              context: { function: kind, field: `parameters.${key}`, received: 'null' },
            },
          );
        }
      }
    }
    // A null PARAMETERS ARGUMENT is a wrong-typed value too, not a second spelling of "no
    // parameters" — undefined is the omission the signature declares.
    if (
      parameters !== undefined &&
      (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters))
    ) {
      let kind = 'indicator';
      try {
        kind = String(make({} as Params).toJSON().kind);
      } catch {
        // An indicator with no universal default (e.g. sma) can't build with `{}`; keep the generic name.
      }
      throw new InputError(
        `${kind}: parameters must be an object of named fields — call ${kind.toLowerCase()}(series, { period: 14 }), not positionally like ${kind.toLowerCase()}(series, 14). Received ${parameters === null ? 'null' : Array.isArray(parameters) ? 'an array' : typeof parameters}.`,
        { code: ErrorCode.InputWrongType, context: { parameters } },
      );
    }
    return parameters ?? ({} as Params);
  };
  const lazyKind = (stream: IndicatorStream<In, Out>) => (): string => {
    try {
      return String(stream.toJSON().kind);
    } catch {
      return 'indicator';
    }
  };
  const meta: RuntimeMetadata = { defaults: { ...defaults } };
  const fn = ((input: ArrayLike<In>, parameters?: Params): Out[] => {
    const stream = make(resolve(parameters));
    validateSeries(input, lazyKind(stream), meta.inputs);
    return collect(stream, input, nan(resolve(parameters))).value;
  }) as Indicator<Params, In, Out>;
  (fn as unknown as Record<symbol, RuntimeMetadata>)[META] = meta;
  fn.explain = (input, parameters) => {
    const stream = make(resolve(parameters));
    validateSeries(input, lazyKind(stream), meta.inputs);
    const kind = lazyKind(stream)();
    const { value, warmup } = collect(stream, input, nan(resolve(parameters)));
    const supplied: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolve(parameters) as Record<string, unknown>)) {
      if (v !== undefined) supplied[k] = v;
    }
    return {
      value,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        indicator: kind,
        parameters: resolveEchoParams(meta.defaults, supplied),
        // Omitted rather than empty when an indicator declares none, so `conventions` in a result
        // always means "this indicator made a choice worth knowing about".
        ...(meta.conventions ? { conventions: meta.conventions } : {}),
      },
      diagnostics: { warnings: [], warmup },
    };
  };
  fn.stream = (parameters) => new VersionedStream(make(resolve(parameters)), restore);
  fn.fromJSON = (snapshot) => {
    checkSnapshotVersion(snapshot);
    // Identity guard: `checkSnapshotVersion` only validates the schema version. A restorer always
    // rebuilds ITS OWN indicator, so a snapshot from a DIFFERENT indicator either makes the restorer
    // throw a raw error, or restores to a stream whose `kind` no longer matches the snapshot's. Both
    // must surface as a typed InputError, never a raw TypeError / silent NaN state (first-touch law).
    let stream: IndicatorStream<In, Out>;
    try {
      stream = restore(snapshot);
      const restoredKind = stream.toJSON().kind;
      if (restoredKind !== snapshot.kind) {
        throw new InputError(
          `fromJSON: snapshot kind "${String(snapshot.kind)}" does not match this indicator ("${String(restoredKind)}").`,
          {
            code: ErrorCode.SnapshotKindMismatch,
            context: { expected: restoredKind, got: snapshot.kind },
          },
        );
      }
    } catch (caught) {
      // A version problem is already settled: `checkSnapshotVersion` ran on this snapshot above, so
      // anything thrown from `restore` is about FIT, not about the schema. Keep the mismatch and the
      // version codes; convert everything else — raw TypeErrors AND typed errors raised deeper in
      // the graph — into the mismatch, because that is the diagnosis the caller can act on.
      //
      // Post-3B.N7 this also covers a NESTED failure: a composed indicator restores children out of
      // `state` (macd reads `state['fast']`), so a foreign snapshot makes the child's `snapshotState`
      // throw `input.wrong_type` about a missing object. That is a symptom of the wrong indicator,
      // and reporting it verbatim told the caller to inspect state instead of the kind.
      const code = isQuantError(caught) ? caught.code : undefined;
      // Every deliberate snapshot diagnosis keeps its own code — "unknown MA snapshot kind" is more
      // specific than "wrong indicator" and must not be flattened. Only a raw error, or the
      // wrong-shape signal a nested child raises when this snapshot has no such child, converts.
      if (code !== undefined && code !== ErrorCode.SnapshotWrongShape) throw caught;
      throw new InputError(
        `fromJSON: snapshot (kind "${String(snapshot.kind)}") could not be restored into this indicator — it is likely from a different indicator.`,
        {
          code: ErrorCode.SnapshotKindMismatch,
          context: {
            kind: snapshot.kind,
            ...(code !== undefined ? { cause: code } : {}),
          },
        },
      );
    }
    return new VersionedStream(stream, restore);
  };
  return fn;
}

/** Map a column of bars to their close prices. */
export function closes(bars: ArrayLike<BarInput>): number[] {
  requireArgumentArray('closes', 'bars', bars);
  const out = new Array<number>(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = bars[i]!.close;
  return out;
}
