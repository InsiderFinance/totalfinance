/**
 * The bounded stored-data scanner (Stage 4.4b Decision 10, Barrier A — promoted to the spine in
 * Stage 4.5 Decision 9 so every artifact door shares ONE scanner and one cost law).
 *
 * Iteratively PROVES a value is behavior-free canonical stored data and MEASURES its canonical
 * work cost, without invoking getters, coercion hooks, `toJSON`, or any serialization behavior,
 * and without cloning or hashing the value first. It refuses cycles, nesting deeper than
 * `maximumDepth` containers, custom prototypes, Array subclasses, sparse arrays, non-index array
 * members, symbol keys (unless explicitly ignored), accessors, hidden members, functions, bigints,
 * enumerable `undefined`, and — when asked — non-finite numbers. The cost it returns is
 * deterministic:
 *
 * ```text
 * primitive (null | boolean | number) = 1
 * string                              = 1 + ceil(length / 64)
 * array                               = 1 + length + Σ element cost
 * object                              = 1 + keyCount · ceil(log2(keyCount + 1)) + Σ (key string cost + member cost)
 * ```
 *
 * `maximumWorkUnits` makes it a STOP-AT-LIMIT preflight: the scan throws as soon as the running
 * cost would exceed the budget, so an oversized input is refused before any door allocates a
 * canonical copy or a hash for it. Callers (the scenario runner, the artifact comparison, the
 * fitted-model and research-run adapters) size their budgets from this cost.
 */

import { ErrorCode, InputError } from '../errors.js';

/** The default nesting limit: deeper stored data is refused as a structural hazard. */
export const CANONICAL_DATA_MAX_DEPTH = 64;

export interface CanonicalDataScanOptions {
  /** The public function whose input is being scanned — every refusal names it. */
  readonly functionName: string;
  /** The root path label in refusals (`'input.market'`, `'artifact.result'`, …). */
  readonly label: string;
  /** Container nesting limit; default {@link CANONICAL_DATA_MAX_DEPTH}. */
  readonly maximumDepth?: number;
  /** Stop-at-limit budget in work units; omitted means unbounded (the caller has already bounded). */
  readonly maximumWorkUnits?: number;
  /** Symbol keys the caller owns and deliberately excludes from the data law (private bindings). */
  readonly ignoredSymbols?: ReadonlySet<symbol>;
  /** Refuse NaN / ±Infinity as data (successful envelopes) instead of admitting them as leaves. */
  readonly requireFiniteNumbers?: boolean;
}

interface ValueFrame {
  readonly kind: 'value';
  readonly value: unknown;
  readonly path: string;
  readonly depth: number;
}

interface ExitFrame {
  readonly kind: 'exit';
  readonly value: object;
}

type ScanFrame = ValueFrame | ExitFrame;

const SCAN_OPTION_KEYS = [
  'functionName',
  'label',
  'maximumDepth',
  'maximumWorkUnits',
  'ignoredSymbols',
  'requireFiniteNumbers',
] as const;

/** Describe an unknown value without invoking caller-controlled coercion hooks. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'symbol') return 'symbol';
  return typeof value;
}

function dataError(
  options: CanonicalDataScanOptions,
  path: string,
  message: string,
  code: string = ErrorCode.SerializationUnsupportedValue,
): never {
  throw new InputError(`${options.functionName}: ${path} ${message}`, {
    code,
    context: { function: options.functionName, field: path },
  });
}

/** The canonical work cost of one string: one unit plus one per 64 characters. */
export function canonicalStringWorkUnits(value: string): number {
  return 1 + Math.ceil(value.length / 64);
}

function checkedCostAdd(
  current: number,
  increment: number,
  options: CanonicalDataScanOptions,
): number {
  if (
    !Number.isSafeInteger(increment) ||
    increment < 0 ||
    current > Number.MAX_SAFE_INTEGER - increment
  ) {
    dataError(
      options,
      options.label,
      'is too large to measure safely — split the input into smaller pieces.',
      ErrorCode.InputOutOfRange,
    );
  }
  const next = current + increment;
  if (options.maximumWorkUnits !== undefined && next > options.maximumWorkUnits) {
    dataError(
      options,
      options.label,
      `exceeds the configured data-work limit of ${options.maximumWorkUnits} units (the bounded scan stopped at ${next}) — split the input or raise the limit within its hard maximum.`,
      ErrorCode.InputOutOfRange,
    );
  }
  return next;
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function requireScanOptions(options: unknown): CanonicalDataScanOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new InputError(
      `scanCanonicalData: options must be an object naming the scanning function and the value's label, e.g. { functionName: 'readReport', label: 'input.report' }. Received ${options === null ? 'null' : Array.isArray(options) ? 'array' : typeof options}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'options' } },
    );
  }
  const record = options as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(SCAN_OPTION_KEYS as readonly string[]).includes(key)) {
      throw new InputError(
        `scanCanonicalData: unknown field "${key}" in options. Allowed fields: ${SCAN_OPTION_KEYS.join(', ')}.`,
        { code: ErrorCode.InputUnknownField, context: { field: 'options', key } },
      );
    }
  }
  if (typeof record['functionName'] !== 'string' || record['functionName'].length === 0) {
    throw new InputError(
      `scanCanonicalData: options.functionName must be the non-empty name of the function whose input is scanned — every refusal is voiced in its name.`,
      { code: ErrorCode.InputWrongType, context: { field: 'options.functionName' } },
    );
  }
  if (typeof record['label'] !== 'string' || record['label'].length === 0) {
    throw new InputError(
      `scanCanonicalData: options.label must be the non-empty path label of the scanned value (e.g. 'input.market').`,
      { code: ErrorCode.InputWrongType, context: { field: 'options.label' } },
    );
  }
  // A zero budget is legitimate ("nothing left") — the scan then refuses at its first unit with
  // the data-work-limit teaching; the depth limit must admit at least the root container.
  for (const [field, floor] of [
    ['maximumDepth', 1],
    ['maximumWorkUnits', 0],
  ] as const) {
    const value = record[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < floor)) {
      throw new InputError(
        `scanCanonicalData: options.${field} must be a safe integer ≥ ${floor} when present. Received ${describeValue(value)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `options.${field}` } },
      );
    }
  }
  const ignored = record['ignoredSymbols'];
  if (ignored !== undefined && !(ignored instanceof Set)) {
    throw new InputError(
      `scanCanonicalData: options.ignoredSymbols must be a Set of the symbol keys to exclude when present.`,
      { code: ErrorCode.InputWrongType, context: { field: 'options.ignoredSymbols' } },
    );
  }
  const finite = record['requireFiniteNumbers'];
  if (finite !== undefined && typeof finite !== 'boolean') {
    throw new InputError(
      `scanCanonicalData: options.requireFiniteNumbers must be a boolean when present.`,
      { code: ErrorCode.InputWrongType, context: { field: 'options.requireFiniteNumbers' } },
    );
  }
  return options as CanonicalDataScanOptions;
}

/**
 * Prove and measure behavior-free canonical stored data (see the module header). Returns the
 * deterministic canonical work cost; throws the first structural refusal or the budget refusal.
 *
 * @example
 * ```ts
 * const cost = scanCanonicalData(input.report, {
 *   functionName: 'readReport',
 *   label: 'input.report',
 *   maximumWorkUnits: 200_000,
 *   requireFiniteNumbers: true,
 * });
 * ```
 */
export function scanCanonicalData(value: unknown, options: CanonicalDataScanOptions): number {
  const checked = requireScanOptions(options);
  const maximumDepth = checked.maximumDepth ?? CANONICAL_DATA_MAX_DEPTH;
  const ancestors = new WeakSet<object>();
  const stack: ScanFrame[] = [{ kind: 'value', value, path: checked.label, depth: 0 }];
  let cost = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }

    const { value: member, path, depth } = frame;
    if (member === null || typeof member === 'boolean') {
      cost = checkedCostAdd(cost, 1, checked);
      continue;
    }
    if (typeof member === 'number') {
      if (checked.requireFiniteNumbers === true && !Number.isFinite(member)) {
        dataError(
          checked,
          path,
          `must be a finite number in successful stored data. Received ${String(member)}.`,
          Number.isNaN(member) ? ErrorCode.InputNaN : ErrorCode.InputNotFinite,
        );
      }
      cost = checkedCostAdd(cost, 1, checked);
      continue;
    }
    if (typeof member === 'string') {
      cost = checkedCostAdd(cost, canonicalStringWorkUnits(member), checked);
      continue;
    }
    if (typeof member === 'undefined') {
      dataError(
        checked,
        path,
        'is enumerable undefined — omit the member or use null explicitly; canonical detachment must not erase a supplied field.',
      );
    }
    if (typeof member === 'function') {
      dataError(checked, path, 'is a function — stored data carries values, never behavior.');
    }
    if (typeof member === 'symbol') {
      dataError(checked, path, 'is a symbol — symbols cannot cross the stored-data boundary.');
    }
    if (typeof member === 'bigint') {
      dataError(checked, path, 'is a bigint — use a safe number or decimal string explicitly.');
    }

    const object = member as object;
    if (depth > maximumDepth) {
      dataError(
        checked,
        path,
        `is nested deeper than ${maximumDepth} containers — flatten the stored value first.`,
        ErrorCode.InputOutOfRange,
      );
    }
    if (ancestors.has(object)) {
      dataError(checked, path, 'contains a cycle — stored data must be an acyclic value tree.');
    }
    ancestors.add(object);
    stack.push({ kind: 'exit', value: object });

    if (Array.isArray(object)) {
      if (Object.getPrototypeOf(object) !== Array.prototype) {
        dataError(checked, path, 'must be a plain array, not an Array subclass.');
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(object, 'length');
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        dataError(checked, path, 'has an invalid array length descriptor.');
      }
      const length = lengthDescriptor.value as number;
      cost = checkedCostAdd(cost, 1 + length, checked);
      const keys = Reflect.ownKeys(object);
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
          dataError(checked, path, `has a non-index array member ${String(key)}.`);
        }
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
          dataError(checked, path, `has an array member outside its declared length: ${key}.`);
        }
      }
      for (let index = length - 1; index >= 0; index--) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          dataError(
            checked,
            `${path}[${index}]`,
            'must be a dense enumerable stored-data element, not a hole or accessor.',
          );
        }
        stack.push({
          kind: 'value',
          value: descriptor.value,
          path: `${path}[${index}]`,
          depth: depth + 1,
        });
      }
      continue;
    }

    if (!isPlainRecord(object)) {
      dataError(
        checked,
        path,
        `must be a plain stored-data object, not ${describeValue(object)} with a custom prototype.`,
      );
    }

    const entries: Array<{ key: string; value: unknown }> = [];
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key === 'symbol' && checked.ignoredSymbols?.has(key) === true) continue;
      if (typeof key !== 'string') {
        dataError(checked, path, `has an unrecognized symbol member ${String(key)}.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        dataError(
          checked,
          `${path}.${key}`,
          'must be an enumerable own data property — accessors and hidden members are not stored data.',
        );
      }
      entries.push({ key, value: descriptor.value });
    }
    const keyCount = entries.length;
    const keyOrderingCost = keyCount === 0 ? 0 : keyCount * Math.ceil(Math.log2(keyCount + 1));
    cost = checkedCostAdd(cost, 1 + keyOrderingCost, checked);
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      cost = checkedCostAdd(cost, canonicalStringWorkUnits(entry.key), checked);
      stack.push({
        kind: 'value',
        value: entry.value,
        path: `${path}.${entry.key}`,
        depth: depth + 1,
      });
    }
  }

  return cost;
}
