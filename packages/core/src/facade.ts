/**
 * The facade pattern (design law #1 / §5.1): a plain callable paired with an `.explain()` companion.
 *
 * `f(input)` returns the bare value (and throws typed errors on failure); `f.explain(input)` returns
 * the full {@link Computed} envelope (value + assumptions + diagnostics). One gesture, everywhere —
 * lifted into core so every package builds its scalar facades the same way (DX1).
 *
 * Both constructors guard the FIRST argument centrally (the first-touch law, dx §7.1): a facade
 * called with `undefined`, a string, or a number throws a typed teaching `InputError` here, before
 * any property access inside the wrapped implementation can escape as a raw `TypeError`. The guard
 * only checks the container shape — field-level validation stays inside each facade, where the
 * domain knowledge lives.
 */

import type { Computed } from './computed.js';
import { ErrorCode, InputError, PostconditionError } from './errors.js';

/**
 * The central first-argument container guard shared by {@link facade} and {@link seriesFacade}.
 * `label` is the name the USER typed (`'sharpe'`, `'blackScholes.call'`) — facades receive it explicitly so
 * the most common error in the library always names the function, never an internal helper (and
 * survives minification, which `Function.prototype.name` inference cannot).
 */
function requireFirstArg(
  label: string,
  expected: string,
  value: unknown,
  allowArray: boolean,
): void {
  const isObject = value !== null && typeof value === 'object';
  const isArrayish = Array.isArray(value) || ArrayBuffer.isView(value);
  if (isObject && (allowArray || !isArrayish)) return;
  const received =
    value === null
      ? 'null'
      : isArrayish
        ? 'an array'
        : typeof value === 'object'
          ? 'object'
          : typeof value;
  throw new InputError(`${label}: expected ${expected} as the first argument, got ${received}.`, {
    code: ErrorCode.InputWrongType,
    context: { function: label, received },
  });
}

/**
 * `null` in a later position is never legal (a window is a number, options are an object, and
 * `undefined` is how you omit) — but it slips past `options = {}` default parameters, so the central
 * guard rejects it before a property read can escape as a raw TypeError.
 */
function requireLaterArgsNotNull(label: string, args: readonly unknown[]): void {
  for (let i = 1; i < args.length; i++) {
    if (args[i] === null) {
      throw new InputError(
        `${label}: argument ${i + 1} is null — omit it (or pass an options object) instead.`,
        { code: ErrorCode.InputWrongType, context: { function: label, position: i } },
      );
    }
  }
}

/**
 * Law 7 runtime postcondition (spec P2.1, tightened in E3): a SUCCESSFUL explained result is
 * JSON-safe — it NEVER carries a non-finite number (`JSON.stringify` would silently corrupt it to
 * `null`). **Warnings never license a non-finite value**: an undefined quantity is reported as
 * `null` and the warning explains the null. The only ratified exceptions are structural sentinels:
 *
 *   1. `diagnostics.warmup > 0` with an array value — EXACTLY the first `warmup` slots are the
 *      documented aligned-series "not yet formed" sentinel; every slot past the prefix is checked;
 *   2. discriminated "none" elements — zone-style points (`direction: 0`, shape-anchored on their
 *      zone fields) and divergence points (`code: 0`, shape-anchored on `priceSwings`) — whose
 *      documented NaN-when-none fields are exempt; every OTHER field of such an element is still
 *      checked, and an element that merely says `direction: 0` without the zone shape (e.g. an
 *      honest tdSequential point) is walked in full.
 *
 * Anything else non-finite throws {@link PostconditionError}: a library defect surfaced loudly at
 * the boundary rather than shipped silently into a serialization. The walk is exhaustive — full
 * depth (cycle-safe), value + assumptions + diagnostics + provenance — so nothing hides below a cap.
 */
export function assertFiniteResult(label: string, result: Computed<unknown>): void {
  const d = result.diagnostics as { warmup?: number } | undefined;
  const warmup = typeof d?.warmup === 'number' && d.warmup > 0 ? d.warmup : 0;
  const hits: string[] = [];
  collectNonFinitePaths(result.value, 'value', warmup, hits);
  collectNonFinitePaths((result as { assumptions?: unknown }).assumptions, 'assumptions', 0, hits);
  collectNonFinitePaths(result.diagnostics, 'diagnostics', 0, hits);
  collectNonFinitePaths((result as { provenance?: unknown }).provenance, 'provenance', 0, hits);
  if (hits.length === 0) return;
  throw new PostconditionError(
    `${label}: successful result carries a non-finite number at ${hits[0]} — this is a library ` +
      'defect (Law 7); undefined quantities are reported as null with a warning explaining the ' +
      'null. Please report it with your inputs.',
    { code: ErrorCode.PostconditionNonFinite, context: { function: label, paths: hits } },
  );
}

/**
 * Law 7 postcondition for a plain successful value or report. Scalar facades and object-valued
 * analyses do not have an envelope in which a non-finite number can hide, so they use the same
 * exhaustive walker as {@link assertFiniteResult}. Aligned arrays are checked by their explained
 * companion because only its declared `diagnostics.warmup` can distinguish a legitimate prefix
 * sentinel from a defect.
 */
/**
 * Law 7's INPUT-DRIVEN twin (2026-08-23 review wave): refuse a computed result that finite inputs
 * pushed past IEEE-754 double precision. `assertFiniteValue` reports a non-finite success as a
 * LIBRARY defect ("please report it"); this finalizer reports it as the caller's magnitudes
 * overflowing the arithmetic — a teaching refusal, not a bug report. Every public
 * facade/analysis/ratified-plain answer in the Stage 4 domain packages returns through one of the
 * two; the overflow mutant (`tools/first-touch/overflow-sweep.test.ts`) holds the law.
 */
export function requireRepresentableResult<T>(functionName: string, result: T): T {
  const hits: string[] = [];
  collectNonFinitePaths(result, 'result', 0, hits);
  if (hits.length === 0) return result;
  throw new InputError(
    `${functionName}: the computed ${hits[0]} is not representable in IEEE-754 double precision — the input magnitudes overflow the arithmetic. Reduce the magnitudes (or rescale the units) and recompute.`,
    { code: ErrorCode.InputOutOfRange, context: { function: functionName, paths: hits } },
  );
}

/** Exact integer value of `Number.MAX_VALUE` when every double is expressed in units of 2^-1074. */
const MAX_DOUBLE_UNITS = ((1n << 53n) - 1n) << 2045n;

/** Shared scratch storage for decoding a finite IEEE-754 double without allocating per addend. */
const DOUBLE_BITS = new DataView(new ArrayBuffer(8));

/** Add one finite double to an exact superaccumulator expressed in units of `Number.MIN_VALUE`. */
function addDoubleUnits(total: bigint, value: number): bigint {
  if (value === 0) return total;
  DOUBLE_BITS.setFloat64(0, value, false);
  const high = DOUBLE_BITS.getUint32(0, false);
  const low = DOUBLE_BITS.getUint32(4, false);
  const negative = (high & 0x8000_0000) !== 0;
  const exponent = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0x000f_ffff) << 32n) | BigInt(low);
  const significand = exponent === 0 ? fraction : (1n << 52n) | fraction;
  // Subnormals already use 2^-1074 units. A normal with biased exponent e uses e - 1 shifts.
  const units = exponent === 0 ? significand : significand << BigInt(exponent - 1);
  return negative ? total - units : total + units;
}

/** Round an exact superaccumulator to the nearest double, ties to even. */
function doubleFromUnits(units: bigint): number {
  if (units === 0n) return 0;
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  if (magnitude > MAX_DOUBLE_UNITS) return negative ? -Infinity : Infinity;

  const bitLength = magnitude.toString(2).length;
  let shift = Math.max(0, bitLength - 53);
  let significand = magnitude >> BigInt(shift);
  if (shift > 0) {
    const remainder = magnitude - (significand << BigInt(shift));
    const halfway = 1n << BigInt(shift - 1);
    if (remainder > halfway || (remainder === halfway && (significand & 1n) === 1n)) {
      significand += 1n;
      // Rounding 1.111… to 10.000… moves the exponent by one.
      if (significand === 1n << 53n) {
        significand >>= 1n;
        shift += 1;
      }
    }
  }

  const rounded = Number(significand) * 2 ** (shift - 1074);
  return negative ? -rounded : rounded;
}

/**
 * Sum signed finite addends without losing a representable answer to evaluation order.
 *
 * The ordinary path uses a non-overlapping floating-point expansion: low-order residuals survive
 * cancellation (`1e16 + 1 − 1e16 === 1`). If one partial addition itself overflows, the fallback
 * decodes each double into an exact BigInt superaccumulator and rounds the exact total once. That
 * fallback is what makes `1e308 + 1e308 + 1 − 1e308 − 1e308` return `1` in every permutation while
 * still returning Infinity when the mathematical sum of the supplied doubles exceeds
 * `Number.MAX_VALUE`. Non-finite addends retain ordinary IEEE-754 propagation semantics.
 */
export function stableSum(addends: readonly number[]): number {
  const partials: number[] = [];
  let needsExactFallback = false;

  addendsLoop: for (const addend of addends) {
    if (!Number.isFinite(addend)) {
      let ieeeTotal = 0;
      for (const value of addends) ieeeTotal += value;
      return ieeeTotal;
    }

    let next = addend;
    let write = 0;
    for (const existing of partials) {
      let larger = next;
      let smaller = existing;
      if (Math.abs(larger) < Math.abs(smaller)) [larger, smaller] = [smaller, larger];
      const high = larger + smaller;
      if (!Number.isFinite(high)) {
        needsExactFallback = true;
        break addendsLoop;
      }
      const low = smaller - (high - larger);
      if (low !== 0) partials[write++] = low;
      next = high;
    }
    partials.length = write;
    if (next !== 0) partials.push(next);
  }

  if (!needsExactFallback) {
    let total = 0;
    for (const partial of partials) total += partial;
    return total;
  }

  let exact = 0n;
  for (const addend of addends) exact = addDoubleUnits(exact, addend);
  return doubleFromUnits(exact);
}

export function assertFiniteValue(label: string, value: unknown): void {
  const hits: string[] = [];
  collectNonFinitePaths(value, 'value', 0, hits);
  if (hits.length === 0) return;
  throw new PostconditionError(
    `${label}: successful result carries a non-finite number at ${hits[0]} — this is a library ` +
      'defect (Law 7); undefined quantities are reported as null with a warning explaining the ' +
      'null. Please report it with your inputs.',
    { code: ErrorCode.PostconditionNonFinite, context: { function: label, paths: hits } },
  );
}

/** Validate and return a direct Computed result in one expression. */
export function finalizeResult<Result extends Computed<unknown>>(
  label: string,
  result: Result,
): Result {
  assertFiniteResult(label, result);
  return result;
}

function assertFinitePlainValue(label: string, value: unknown): void {
  // A plain aligned-series array carries its exact warmup only on `.explain()`. That path is checked
  // below by assertFiniteResult; scalar and object/report outputs can be checked immediately.
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return;
  assertFiniteValue(label, value);
}

/**
 * The documented NaN-when-none fields of the ratified "none" sentinels, as one delimited string
 * (a `|a|b|` membership test costs a fraction of the array literals it replaces on the hot path):
 *
 *   - zone points (`fairValueGaps`/`orderBlocks`): `{ direction: 0, top, bottom, mid }`;
 *   - liquidity sweeps: `{ direction: 0, level }`;
 *   - divergence points: `{ code: 0, index, priceSwings, indicatorSwings }`.
 *
 * Every sentinel is anchored on the element's STRUCTURAL shape — never on the discriminant value
 * alone — so an unrelated element that merely says `direction: 0` (tdSequential's honest
 * `{ setup, countdown, direction: 0 }`) keeps full finiteness checking. Fields OUTSIDE this set are
 * checked even on a sentinel-shaped element: the disclosure covers the documented slots, not
 * whatever else a producer decides to attach.
 */
const SENTINEL_NONE_FIELDS = '|top|bottom|mid|level|index|priceSwings|indicatorSwings|';

/**
 * Collect non-finite paths in a value tree, honoring the ratified sentinel contracts (warmup
 * prefix, shape-anchored "none" elements). Full-depth and cycle-safe; collection stops at 8 paths
 * purely to bound the error payload — the throw/no-throw outcome is decided by the FIRST hit, so
 * the cap can never hide a violation. Values JSON.stringify cannot represent faithfully are
 * violations too: BigInt (stringify THROWS) and DataView (stringifies as `{}`) are flagged, and
 * Map/Set contents — which stringify silently drops — are walked like any other container.
 */
function collectNonFinitePaths(
  value: unknown,
  root: string,
  skipLeading: number,
  out: string[],
): void {
  const seen = new Set<unknown>();
  const walk = (v: unknown, path: string, skip: number): void => {
    if (out.length >= 8) return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) out.push(path);
      return;
    }
    // JSON.stringify THROWS on a BigInt — a "successful" envelope carrying one is not serializable.
    // Checked before the cycle set, whose SameValueZero identity would dedupe equal bigints.
    if (typeof v === 'bigint') {
      out.push(path);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    // A DataView passes `ArrayBuffer.isView` but has no `.length`, so the array walk below would
    // silently skip it — and JSON.stringify corrupts it to `{}`. Opaque bytes in a numeric result
    // envelope are a defect, not data: report the path rather than guess at an interpretation.
    if (v instanceof DataView) {
      out.push(path);
      return;
    }
    // Map/Set contents vanish under JSON.stringify (`{}`), so an undisclosed NaN inside one would
    // never reach the serialization the postcondition is defending — walk both by their entries.
    if (v instanceof Map || v instanceof Set) {
      let i = 0;
      for (const entry of v) {
        const [k, val] = v instanceof Map ? (entry as [unknown, unknown]) : [i++, entry];
        walk(val, `${path}[${String(k)}]`, 0);
        if (out.length >= 8) return;
      }
      return;
    }
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      const arr = v as ArrayLike<unknown>;
      for (let i = skip; i < arr.length; i++) {
        walk(arr[i], `${path}[${i}]`, 0);
        if (out.length >= 8) return;
      }
      return;
    }
    // A discriminated "none" element exempts its DOCUMENTED NaN fields — anchored on the element's
    // shape (a zone/sweep carries `mid`/`level`, a divergence carries `priceSwings`), never on the
    // discriminant value alone, so an honest `{ setup, countdown, direction: 0 }` is still walked.
    const disc = v as { direction?: unknown; code?: unknown };
    const sentinel =
      (disc.direction === 0 && ('mid' in v || 'level' in v)) ||
      (disc.code === 0 && 'priceSwings' in v);
    for (const [k, val] of Object.entries(v)) {
      // Fields outside the documented set are checked even here: the disclosure covers the
      // documented slots, not whatever else a producer attaches.
      if (sentinel && SENTINEL_NONE_FIELDS.includes(`|${k}|`)) continue;
      walk(val, `${path}.${k}`, 0);
      if (out.length >= 8) return;
    }
  };
  walk(value, root, skipLeading);
}

/**
 * A callable `(input) => Output` with an `.explain(input) => Computed<Output, Extra>` companion. The
 * `Extra` type parameter carries the domain-specific assumptions the envelope discloses (it defaults
 * to none), so `f.explain(input).assumptions.<extraField>` type-checks.
 */
/**
 * `ExplainValue` defaults to `Output` and diverges only for solver facades (Law 7 / E3): the plain
 * call THROWS on failure so its output stays `number`, while the `.explain` envelope reports the
 * same failure softly as `value: null` + `converged: false`.
 */
export type Facade<
  Input,
  Output,
  Extra extends Record<string, unknown> = Record<never, never>,
  ExplainValue = Output,
> = ((input: Input) => Output) & {
  explain: (input: Input) => Computed<ExplainValue, Extra>;
};

/**
 * Pair a plain-value `call` with its envelope-returning `explain` into a single {@link Facade}.
 * `label` is the public name of the facade as the user calls it (e.g. `'blackScholes.call'`) — it opens every
 * guard message. S1 facades take an input OBJECT of named fields, so arrays are rejected here too.
 */
export function facade<
  Input,
  Output,
  Extra extends Record<string, unknown> = Record<never, never>,
  ExplainValue = Output,
>(
  label: string,
  call: (input: Input) => Output,
  explain: (input: Input) => Computed<ExplainValue, Extra>,
): Facade<Input, Output, Extra, ExplainValue> {
  const guardedCall = (input: Input): Output => {
    requireFirstArg(label, 'an input object of named fields', input, false);
    const value = call(input);
    assertFinitePlainValue(label, value);
    return value;
  };
  const guardedExplain = (input: Input): Computed<ExplainValue, Extra> => {
    requireFirstArg(`${label}.explain`, 'an input object of named fields', input, false);
    const result = explain(input);
    assertFiniteResult(label, result);
    return result;
  };
  return Object.assign(guardedCall, { explain: guardedExplain });
}

/**
 * A multi-argument (series-first) facade: the plain call takes `(data, parameters?, …)`, and `.explain()`
 * takes the SAME arguments and returns the {@link Computed} envelope. This is the S2 shape (`rsi(closes,
 * parameters?)`, `sharpe(returns, options?)`) — distinct from {@link Facade}, which is the single-object S1
 * shape (`blackScholes.call({ … })`).
 */
export type SeriesFacade<
  Args extends unknown[],
  Output,
  Extra extends Record<string, unknown> = Record<never, never>,
> = ((...callArguments: Args) => Output) & {
  explain: (...callArguments: Args) => Computed<Output, Extra>;
};

/**
 * Pair a series-first `call` with an `.explain()` that takes the same arguments (S2 facades).
 * `label` is the public name of the facade as the user calls it (e.g. `'sharpe'`).
 */
export function seriesFacade<
  Args extends unknown[],
  Output,
  Extra extends Record<string, unknown> = Record<never, never>,
>(
  label: string,
  call: (...callArguments: Args) => Output,
  explain: (...callArguments: Args) => Computed<Output, Extra>,
): SeriesFacade<Args, Output, Extra> {
  const guardedCall = (...callArguments: Args): Output => {
    requireFirstArg(label, 'a series (or an input object)', callArguments[0], true);
    requireLaterArgsNotNull(label, callArguments);
    const value = call(...callArguments);
    assertFinitePlainValue(label, value);
    return value;
  };
  const guardedExplain = (...callArguments: Args): Computed<Output, Extra> => {
    requireFirstArg(`${label}.explain`, 'a series (or an input object)', callArguments[0], true);
    requireLaterArgsNotNull(`${label}.explain`, callArguments);
    const result = explain(...callArguments);
    assertFiniteResult(label, result);
    return result;
  };
  return Object.assign(guardedCall, { explain: guardedExplain }) as SeriesFacade<
    Args,
    Output,
    Extra
  >;
}
