/**
 * Canonical JSON — the ONE serialized form the artifact spine hashes and stores (Gate B).
 *
 * Lives at the core root (not under `artifacts/`) because it is a GENERIC serialization utility
 * with two independent consumers: the artifact spine (hashing/storage) and the Gate C pricing
 * conformance kit (complete-result comparison). Moved out of `artifacts/` 2026-08-23 (second
 * external review): while it sat there, `pricing.ts` had to import from the artifacts directory
 * to compare canonical results, contradicting pricing's documented "never imports the artifacts
 * layer" rule. `@insiderfinance/totalfinance/core/artifacts` still re-exports everything here, so the public
 * surface did not move; the core root entrypoint deliberately does NOT re-export it (hot-path
 * bundles stay serialization-free).
 *
 * Two different key orders, or `-0` versus `0`, are the SAME logical value; a content hash that
 * distinguishes them is a dedup and replay bug. So hashing never runs on `JSON.stringify` output —
 * it runs on this canonical form, whose rules are few and exact:
 *
 * - object keys sort by UTF-16 code unit at every depth; `undefined` members are omitted;
 * - numbers print via `JSON.stringify` (the ES2020 shortest round-trip form — deterministic across
 *   engines), with `-0` folded to `0` because JSON cannot carry the sign bit;
 * - non-finite numbers use the library-wide wrapper grammar `{ nonFinite: 'NaN' | 'Infinity' |
 *   '-Infinity' }` — the SAME encoding `@insiderfinance/totalfinance/technical-analysis` stamps into stream snapshots,
 *   so a TA state nested inside a saved artifact round-trips losslessly (`JSON.stringify(NaN)` is
 *   `null`, and a `null` in a numeric slot reads as `0` downstream — the exact silent-wrong-number
 *   class this library exists to refuse);
 * - strings escape per well-formed `JSON.stringify` (ES2019: lone surrogates escaped) — spec-fixed,
 *   so the bytes are engine-independent;
 * - everything else is REFUSED with a teaching error. A `Date`, `Map`, `Set`, typed array, class
 *   instance, `bigint`, or function has no single honest JSON meaning, and guessing one here would
 *   bake the guess into every content hash forever. `toJSON` methods are deliberately NOT invoked:
 *   a hash that depends on hidden prototype behavior is not reproducible from the data.
 *
 * The wrapper object is RESERVED vocabulary: caller data may not itself contain a literal
 * `{ nonFinite: '…' }` member, and the serializer refuses one rather than letting it decode into a
 * number it never was. (TA cannot make this check — its state trees are opaque and arrive
 * pre-encoded — so it documents the reservation instead; at this boundary the input is caller data
 * and the refusal is enforceable.)
 *
 * `CANONICAL_JSON_VERSION` names these rules. Envelope schema versions govern SHAPES; this constant
 * governs the SERIALIZATION of any shape, and a future rule change (there is no planned one) would
 * bump it and re-key every hash — explicitly, never silently.
 */

import { ErrorCode, InputError } from './errors.js';

/** The canonicalization rules above, as a versioned public fact. */
export const CANONICAL_JSON_VERSION = 1;

/** How a non-finite number is carried through JSON — one grammar, library-wide. */
export interface NonFiniteNumber {
  nonFinite: 'NaN' | 'Infinity' | '-Infinity';
}

/** Exact wrapper test: a plain object whose ONLY member is a valid `nonFinite` tag. */
export function isNonFiniteNumber(value: unknown): value is NonFiniteNumber {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'nonFinite') return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'nonFinite');
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return false;
  const tag = descriptor.value as unknown;
  if (tag !== 'NaN' && tag !== 'Infinity' && tag !== '-Infinity') return false;
  return true;
}

function decodeNonFinite(tag: NonFiniteNumber['nonFinite']): number {
  return tag === 'NaN'
    ? Number.NaN
    : tag === 'Infinity'
      ? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;
}

/** Is this a data object this serializer owns — `{}`-prototype or `null`-prototype only? */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** One refusal voice for every unsupported value, with the path that locates it. */
function unsupportedValue(path: string, received: string, hint: string): InputError {
  return new InputError(
    `canonicalJsonOf: ${path === '' ? 'value' : path} is ${received}, which has no canonical JSON form — ${hint}`,
    {
      code: ErrorCode.SerializationUnsupportedValue,
      context: { path: path === '' ? '(root)' : path, received },
    },
  );
}

/** Describe a class without invoking a caller-provided `constructor`/`name` accessor. */
function storedConstructorName(value: object): string | undefined {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null) return undefined;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (
    constructor === undefined ||
    !('value' in constructor) ||
    typeof constructor.value !== 'function'
  ) {
    return undefined;
  }
  const name = Object.getOwnPropertyDescriptor(constructor.value, 'name');
  return name !== undefined &&
    'value' in name &&
    typeof name.value === 'string' &&
    name.value !== ''
    ? name.value
    : undefined;
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        return Number.isNaN(value)
          ? '{"nonFinite":"NaN"}'
          : value > 0
            ? '{"nonFinite":"Infinity"}'
            : '{"nonFinite":"-Infinity"}';
      }
      // JSON has no negative zero; folding it here keeps `0` and `-0` one hash.
      return JSON.stringify(value === 0 ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw unsupportedValue(path, 'a bigint', 'convert it to a number or a decimal string first.');
    case 'function':
      throw unsupportedValue(
        path,
        'a function',
        'artifacts carry data, never behavior — serialize its result instead.',
      );
    case 'symbol':
      throw unsupportedValue(path, 'a symbol', 'symbols cannot cross a serialization boundary.');
    case 'undefined':
      // Reachable only as an ARRAY element — object members are filtered before recursion.
      throw unsupportedValue(
        path,
        'undefined inside an array',
        'JSON.stringify would silently write null there; use null explicitly if you mean an absent slot.',
      );
    case 'object':
      break;
  }
  const object = value as object;
  if (Array.isArray(object)) {
    if (Object.getPrototypeOf(object) !== Array.prototype) {
      throw unsupportedValue(
        path,
        'an Array subclass or custom-prototype array',
        'pass a plain dense data array.',
      );
    }
    const parts: string[] = [];
    for (let i = 0; i < object.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, String(i));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw unsupportedValue(
          `${path}[${i}]`,
          'a missing or accessor-backed array element',
          'canonical arrays must be dense stored data; use an explicit value (including null) at every index.',
        );
      }
      parts.push(serialize(descriptor.value, `${path}[${i}]`));
    }
    for (const key of Reflect.ownKeys(object)) {
      if (key === 'length') continue;
      const index = typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= object.length) {
        throw unsupportedValue(
          path,
          `an array with non-index member ${String(key)}`,
          'canonical arrays contain only their dense indexed elements.',
        );
      }
    }
    return `[${parts.join(',')}]`;
  }
  if (!isPlainObject(object)) {
    const constructorName = storedConstructorName(object);
    const received =
      constructorName === undefined
        ? 'a custom-prototype object'
        : `an instance of ${constructorName}`;
    const hint =
      object instanceof Date
        ? 'pass epoch milliseconds (EpochMs) — TotalFinance dates are numbers, resolved once via resolveAsOf.'
        : object instanceof Map || object instanceof Set
          ? 'convert it to a plain object or array explicitly.'
          : ArrayBuffer.isView(object)
            ? 'convert it to a plain array; a lossless columnar (Arrow) mapping is reserved, not implemented (Gate B).'
            : 'serialize class instances through their own explicit contract, then pass the plain data.';
    throw unsupportedValue(path, received, hint);
  }
  if (isNonFiniteNumber(object)) {
    throw unsupportedValue(
      path,
      `a literal { nonFinite: '${(object as NonFiniteNumber).nonFinite}' } object`,
      'that shape is the RESERVED encoding of a non-finite number — pass the number itself (NaN/Infinity) and it will be encoded.',
    );
  }
  const members = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw unsupportedValue(
        path,
        'an object with an accessor, hidden member, or symbol key',
        'canonical objects contain enumerable string-keyed stored data only.',
      );
    }
    if (descriptor.value !== undefined) members.set(key, descriptor.value);
  }
  const keys = [...members.keys()].sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(
      `${JSON.stringify(key)}:${serialize(members.get(key), path === '' ? key : `${path}.${key}`)}`,
    );
  }
  return `{${parts.join(',')}}`;
}

/**
 * Serialize a JSON-safe value to its ONE canonical string. Deterministic: the same logical value —
 * whatever key order, whatever `-0`s — always yields the same bytes, which is what makes
 * `contentHash` an identity rather than a formatting accident.
 */
export function canonicalJsonOf(value: unknown): string {
  return serialize(value, '');
}

/**
 * Only receives the fresh tree owned by JSON.parse below, never a caller's object graph. Its members
 * are already enumerable, writable stored data and its arrays are dense. Decode in place instead of
 * allocating a second tree and re-checking descriptors on every node. The public wrapper predicate
 * and serializer still perform the full hostile-input checks; this is not a general object walker.
 */
function decodeParsedTree(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  // Parsed arrays have only indexed enumerable keys, so this exact key test excludes them too.
  if (keys.length === 1 && keys[0] === 'nonFinite') {
    const tag = object['nonFinite'];
    if (tag === 'NaN' || tag === 'Infinity' || tag === '-Infinity') {
      return decodeNonFinite(tag);
    }
  }
  for (const key of keys) {
    // Each key ALREADY exists as an own data property created by JSON.parse. Assignment therefore
    // updates it, including `__proto__`, without invoking an inherited setter or changing prototypes.
    object[key] = decodeParsedTree(object[key]);
  }
  return value;
}

/**
 * Parse a canonical (or any) JSON text back to the runtime value, decoding every non-finite wrapper
 * to its number. The inverse of {@link canonicalJsonOf}: `fromCanonicalJson(canonicalJsonOf(x))`
 * deep-equals `x` (with `-0` read back as `0` — the one disclosed loss), and
 * `canonicalJsonOf(fromCanonicalJson(text))` returns `text` unchanged for canonical `text`.
 */
export function fromCanonicalJson(text: string): unknown {
  if (typeof text !== 'string') {
    throw new InputError(
      `fromCanonicalJson: text must be a JSON string, got ${text === null ? 'null' : typeof text}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { received: text === null ? 'null' : typeof text },
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InputError(
      `fromCanonicalJson: text is not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
      { code: ErrorCode.SerializationUnsupportedValue, context: { textPrefix: text.slice(0, 80) } },
    );
  }
  return decodeParsedTree(parsed);
}
