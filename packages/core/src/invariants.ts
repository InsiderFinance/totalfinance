/**
 * Tiny local invariant checks for hot compute paths (spec §6 hot-path rule).
 *
 * These are the ONLY validation a facade performs inline — just enough to avoid nonsensical math.
 * They throw `InputError` with stable codes and pull in no schema/validator library, so deep
 * compute entrypoints stay within bundle budget.
 */

import { InputError, missingFieldError } from './errors.js';
import * as ValidationCode from './validation-codes.js';

/** Throw unless `value` is a finite number. */
export function ensureFinite(value: number, field: string, functionName: string): void {
  if (!Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${field} must be a finite number. Received ${describe(value)}.`,
      {
        code: Number.isNaN(value) ? ValidationCode.InputNaN : ValidationCode.InputNotFinite,
        context: { field, value: contextValue(value), function: functionName },
      },
    );
  }
}

/** Throw unless `value` is a finite number `> 0`. */
export function ensurePositive(
  value: number,
  field: string,
  functionName: string,
  code: string = ValidationCode.InputOutOfRange,
): void {
  ensureFinite(value, field, functionName);
  if (value <= 0) {
    throw new InputError(`${functionName}: ${field} must be > 0. Received ${value}.`, {
      code,
      context: { field, value, function: functionName },
    });
  }
}

/** Throw unless `value` is a finite number `>= 0`. */
export function ensureNonNegative(
  value: number,
  field: string,
  functionName: string,
  code: string = ValidationCode.InputOutOfRange,
): void {
  ensureFinite(value, field, functionName);
  if (value < 0) {
    throw new InputError(`${functionName}: ${field} must be >= 0. Received ${value}.`, {
      code,
      context: { field, value, function: functionName },
    });
  }
}

function describe(value: unknown): string {
  // Runtime callers can pass non-numbers despite the type: name the actual type so
  // `Received "100" (string)` reads as the bug it is, not as a plausible number.
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `${JSON.stringify(value)} (string)`;
  if (typeof value === 'boolean') return `${value ? 'true' : 'false'} (boolean)`;
  if (typeof value === 'bigint') return `${value}n (bigint)`;
  if (typeof value !== 'number') return typeof value;
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return String(value);
}

/** Preserve useful primitive context without retaining caller-controlled behavior. */
function contextValue(value: unknown): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : describe(value);
  if (typeof value === 'bigint') return `${value}n`;
  return typeof value;
}

/**
 * Boundary container guards (the first-touch law, dx §7.1): one-line argument-shape checks for
 * facades whose implementations would otherwise dereference garbage into a raw `TypeError`.
 * Container-shape only — field-level validation stays in the facade.
 */
/**
 * Enum guard: `value` must be exactly one of `allowed` (design law #4 — a meaning-changing field is
 * never coerced; `type: 'Call'` must teach, not silently price the other leg). Accepts `unknown` so
 * boundary callers can validate untyped input without a cast.
 */
export function ensureEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  functionName: string,
): asserts value is T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    const got = typeof value === 'string' ? `"${value}"` : describe(value as never);
    throw new InputError(
      `${functionName}: ${field} must be one of ${allowed.join(', ')}; got ${got}.`,
      {
        code: ValidationCode.InputInvalidEnum,
        context: { field, value: contextValue(value), function: functionName },
      },
    );
  }
}

export function requireArgumentObject(functionName: string, field: string, value: unknown): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return;
  const received = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  throw new InputError(
    `${functionName}: ${field} must be an object of named fields, got ${received}.`,
    {
      code: ValidationCode.InputWrongType,
      context: { function: functionName, field, received },
    },
  );
}

/** Throw unless `value` is a real array (or typed array). */
export function requireArgumentArray(functionName: string, field: string, value: unknown): void {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return;
  const received = value === null ? 'null' : typeof value;
  throw new InputError(`${functionName}: ${field} must be an array, got ${received}.`, {
    code: ValidationCode.InputWrongType,
    context: { function: functionName, field, received },
  });
}

/**
 * Law 7 helper: a computed quantity that overflowed/underflowed to NaN/±Infinity is reported as
 * `null` (undefined-with-reason at the envelope tier), never as a non-finite "success" value.
 */
export function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * The shared enforcement path for a request object's NUMERIC fields (spec 3B.1b).
 *
 * One call answers the three questions a numeric contract actually makes, in the order a caller
 * makes mistakes: is the field there, is it a number, is that number usable. Each gets its own code
 * and its own sentence, because "volatility is required" and "volatility must be a finite number,
 * received NaN" are different bugs with different fixes and a single `input.not_finite` for both
 * teaches neither.
 *
 * Why this exists rather than a hand-rolled check per boundary: measurement found 31 public
 * boundaries where omitting a declared-required field reached the arithmetic and returned `NaN` —
 * `blackScholesPrice({ spot, strike, timeToExpiryYears, riskFreeRate, dividendYield })` with no
 * `volatility` priced the option as `NaN` and handed it back as a success. In a pricing library a
 * silently wrong number is the worst possible failure: it does not look like an error at any layer
 * that consumes it. The declaration already said the field was required; only the runtime disagreed.
 *
 * HOT PATHS: this validates ONE object, not one row. It belongs at a public facade, never inside an
 * iterative solver or a columnar loop whose columns were already checked — those call the unchecked
 * kernel behind the facade (spec 3B.1b: unchecked numeric routines stay private and reachable only
 * after validation). A `for` over a handful of declared names costs nothing next to `Math.log`; the
 * same loop run 100,000 times inside a batch path is a different thing entirely.
 */
export interface RequireFiniteFieldsOptions {
  /**
   * ONE complete, runnable call for this boundary — `blackScholesPrice({ type: 'call', spot: 100, … })`,
   * not a field fragment like `volatility: 0.2`.
   *
   * `missingFieldError` documents itself as showing "a WORKING example call", and the rest of the
   * library honours that: `walkForward({ data, trainSize: 30, … })`, `sma(closes, { period: 20 })`.
   * A fragment is helpful but not pasteable, and a caller who is already confused about the shape of
   * the request is exactly who cannot assemble one from a field snippet.
   */
  /**
   * A THUNK is accepted so a derived example costs nothing on the success path.
   *
   * Shared validators must build their example from the reported function name, and RV6 first wrote
   * that as `exampleCall: facadeExampleCall(functionName)` — evaluated on EVERY call, including the
   * millions that never fail. That put string construction inside `blackScholes.price`, a documented
   * hot path, to produce a message thrown away unused. The lazy form keeps the example correct and
   * the success path free; it is only invoked when a field is actually missing.
   */
  exampleCall: string | (() => string);
  /**
   * Optional per-field note appended on its own line — the unit trap or range the call shape cannot
   * carry (`annualized decimal, not 20`). Keyed by the BARE field name.
   */
  hints?: Readonly<Record<string, string>>;
  /**
   * Dotted prefix for a NESTED contract, so the error reads `parameters.kappa` rather than `kappa`.
   * The caller is holding an outer request; the bare name does not say which object to fix.
   */
  path?: string;
}

/** The container's own label in an error — the nested path when there is one, else `input`. */
function pathPrefixOf(options: RequireFiniteFieldsOptions): string | undefined {
  return options.path;
}

export function requireFiniteFields(
  functionName: string,
  input: unknown,
  fields: readonly string[],
  options: RequireFiniteFieldsOptions,
): void {
  /**
   * ONE code for one mistake. This used to throw `wrongShapeError` (`input.wrong_shape`) while
   * `requireArgumentObject` threw `input.wrong_type` for the SAME malformed container — two codes for
   * "you passed a number where the request object goes", depending only on which guard happened to
   * run first. `wrong_shape` still has a job (an object whose KEYS are wrong, where echoing the
   * received keys teaches), but a non-object is a type error and now says so everywhere.
   */
  requireArgumentObject(functionName, pathPrefixOf(options) ?? 'input', input);
  const exampleCallOption = options.exampleCall;
  const hints = options.hints;
  const pathPrefix = options.path;
  const object = input as Record<string, unknown>;
  for (const field of fields) {
    const value = object[field];
    // The name the CALLER sees.
    const path = pathPrefix === undefined ? field : `${pathPrefix}.${field}`;
    // Only true absence is missing. `null` used to be grouped here — "it is what JSON.parse yields
    // for a field a producer left empty" — but that taught one code for required null and a
    // different one for optional null, and the 350c2796 review settled it: a present non-nullable
    // `null` is a wrong-typed VALUE everywhere, so it falls through to the ladder below and reports
    // `input.wrong_type` (Received null) exactly as the optional sibling does. A producer that
    // omits a field writes nothing; one that writes null wrote a value the declaration refuses.
    if (value === undefined) {
      throw missingFieldError(
        functionName,
        path,
        typeof exampleCallOption === 'function' ? exampleCallOption() : exampleCallOption,
        hints?.[field],
      );
    }
    if (typeof value !== 'number') {
      throw new InputError(
        `${functionName}: ${path} must be a number. Received ${describe(value as never)}.`,
        {
          code: ValidationCode.InputWrongType,
          context: { function: functionName, field: path, received: typeof value },
        },
      );
    }
    // NaN and ±Infinity, with the codes those already own.
    ensureFinite(value, path, functionName);
  }
}

/**
 * A finite numeric value WHEN PRESENT — the optional-field sibling of {@link requireFiniteFields}.
 *
 * `undefined` is allowed (optional omission, C06); anything else runs the same ladder a required
 * field does, so a string in an optional numeric slot reports `input.wrong_type` exactly as it
 * would in a required one. Calling bare `ensureFinite` there reported `input.not_finite`, which
 * contradicted the library's own documented matrix — and a test had been written asserting the
 * contradiction, which is how it survived.
 *
 * `null` is NOT omission. This guard originally returned early on null, which silently accepted a
 * value every one of its call sites declares impossible (`lowerVolatilityBound?: number`, a bar's
 * `open?: number` — none say `| null`). C06 reserves `null` for declarations that explicitly carry
 * it; a field that wants nullable semantics declares them and takes a different guard. The
 * `null-when-nonnullable` enforcement mutation exists to keep this class measurable.
 */
export function ensureFiniteWhenPresent(value: unknown, field: string, functionName: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number') {
    throw new InputError(
      `${functionName}: ${field} must be a number. Received ${describe(value as never)}.`,
      {
        code: ValidationCode.InputWrongType,
        context: { function: functionName, field, received: typeof value },
      },
    );
  }
  ensureFinite(value, field, functionName);
}

/** Damerau–Levenshtein ≤ 2 nearest match — cheap did-you-mean for {@link ensureKnownKeys}. */
function nearestKey(key: string, allowed: readonly string[]): string | undefined {
  const dist = (a: string, b: string): number => {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + cost);
        }
      }
    }
    return d[a.length]![b.length]!;
  };
  let best: string | undefined;
  let bestD = 3;
  const lower = key.toLowerCase();
  for (const cand of allowed) {
    const d = dist(lower, cand.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return best;
}

/**
 * Law 12 — facade, analysis, and builder object inputs REJECT unknown keys (a misspelled option
 * must never be silently ignored: `greek: false` computing Greeks anyway is the bug class this
 * kills). Cheap by design: one key scan against a Set-able allowlist, no schema machinery, so it
 * is safe on hot facade paths. Direct kernels use named objects when financial values could be
 * confused; adapters that own foreign/superset schemas are declared `passthrough` in the manifest
 * and skip this guard.
 */
export function ensureKnownKeys(
  functionName: string,
  field: string,
  value: object,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const suggestion = nearestKey(key, allowed);
    throw new InputError(
      `${functionName}: unknown field "${key}" in ${field}${
        suggestion !== undefined ? ` — did you mean "${suggestion}"?` : ''
      } Allowed fields: ${allowed.join(', ')}.`,
      {
        code: ValidationCode.InputUnknownField,
        context: {
          function: functionName,
          field,
          key,
          ...(suggestion !== undefined ? { suggestion } : {}),
        },
      },
    );
  }
}

/**
 * The names a selection of type `S` is CERTAIN to contain — the names a result may promise as
 * required. Every other name in `S[number]` was only possibly selected, so a result types it as
 * optional.
 *
 * A name is guaranteed when every possible value of `S` holds it as a whole element:
 * - `readonly ['price', 'gamma']` guarantees `'price' | 'gamma'`;
 * - a union of selections guarantees only what all of them share:
 *   `readonly ['gamma'] | readonly ['delta']` (a conditional) guarantees nothing, and
 *   `readonly ['price', 'gamma'] | readonly ['price']` guarantees `'price'`;
 * - an element that is itself a union guarantees none of its members: `readonly ['gamma' | 'delta']`
 *   holds one of the two, and the type cannot say which;
 * - a list without a fixed length (`BlackScholesOutput[]`) guarantees nothing.
 *
 * `S extends unknown` distributes over the members of `S`, giving one verdict per possible
 * selection; a name is kept only when no member says `false`.
 */
export type GuaranteedSelection<S extends readonly string[]> = {
  [K in S[number]]: false extends (
    S extends unknown
      ? number extends S['length']
        ? false
        : K extends { [I in keyof S]: [S[I]] extends [K] ? K : never }[number]
          ? true
          : false
      : never
  )
    ? never
    : K;
}[S[number]];

/**
 * Validate an explicit SELECTION list — `outputs: ['price', 'gamma']`, `metrics: ['gex']` — and
 * return a dense copy in request order.
 *
 * A selection decides what is computed, so every malformed form teaches instead of being repaired:
 * not an array (`input.wrong_type`), empty (`input.out_of_range` — an empty request computes
 * nothing and would read as a successful empty answer), a sparse hole (`input.missing_field`), an
 * unknown or non-string name (`input.invalid_enum`, with a did-you-mean), and a repeated name
 * (`input.duplicate_entry`). A duplicate is never silently collapsed: it usually means the caller
 * meant a different name.
 *
 * `functionName` and `field` name the caller's boundary in every one of those errors, so they are
 * checked first: a missing label would otherwise surface as `undefined: undefined must be …`.
 */
export function requireSelection<T extends string>(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T[] {
  requireSelectionLabel('functionName', functionName);
  requireSelectionLabel('field', field);
  if (!Array.isArray(value)) {
    const received = value === null ? 'null' : typeof value;
    throw new InputError(
      `${functionName}: ${field} must be an array of names (one or more of ${allowed.join(', ')}); got ${received}.`,
      {
        code: ValidationCode.InputWrongType,
        context: { function: functionName, field, received },
      },
    );
  }
  if (value.length === 0) {
    throw new InputError(
      `${functionName}: ${field} must name at least one of ${allowed.join(', ')}; an empty selection computes nothing.`,
      { code: ValidationCode.InputOutOfRange, context: { function: functionName, field } },
    );
  }
  const selected: T[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new InputError(
        `${functionName}: ${field}[${index}] is missing; pass a dense array, not a sparse hole.`,
        {
          code: ValidationCode.InputMissingField,
          context: { function: functionName, field, index },
        },
      );
    }
    const name: unknown = value[index];
    if (typeof name !== 'string' || !(allowed as readonly string[]).includes(name)) {
      const suggestion = typeof name === 'string' ? nearestKey(name, allowed) : undefined;
      throw new InputError(
        `${functionName}: ${field}[${index}] must be one of ${allowed.join(', ')}; got ${
          typeof name === 'string' ? `"${name}"` : describe(name as never)
        }${suggestion !== undefined ? ` — did you mean "${suggestion}"?` : '.'}`,
        {
          code: ValidationCode.InputInvalidEnum,
          context: {
            function: functionName,
            field,
            index,
            value: contextValue(name),
            ...(suggestion !== undefined ? { suggestion } : {}),
          },
        },
      );
    }
    if ((selected as readonly string[]).includes(name)) {
      throw new InputError(
        `${functionName}: ${field} names "${name}" more than once; request each entry once.`,
        {
          code: ValidationCode.InputDuplicateEntry,
          context: { function: functionName, field, index, value: name },
        },
      );
    }
    selected.push(name as T);
  }
  return selected;
}

/** Throw unless a `requireSelection` label argument is a non-empty string. */
function requireSelectionLabel(name: string, label: unknown): void {
  if (typeof label !== 'string' || label.length === 0) {
    const received = label === null ? 'null' : label === '' ? "''" : typeof label;
    throw new InputError(
      `requireSelection: ${name} must be a non-empty string (it names the caller's boundary in every error); got ${received}.`,
      {
        code: ValidationCode.InputWrongType,
        context: { function: 'requireSelection', field: name, received },
      },
    );
  }
}
