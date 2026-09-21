/**
 * The reusable closed-request validator (spec 3B.1b, first checkbox): ONE contract for required
 * object, exact closed keys, primitive/container type, finite numeric input, nested consumed
 * fields, and discriminated-union branch validation.
 *
 * The SPEC DATA is generated from the checker-derived contract inventory
 * (`pnpm validation:update` → `packages/<pkg>/src/generated/validation-specs.ts`), never
 * hand-authored: a hand-written key list and the declaration it mirrors are two artifacts that
 * drift, and the drift is exactly a silently-accepted field or a rejected valid call. What stays
 * hand-authored is the TEACHING — the worked example call and per-field unit hints — because a
 * generator may not invent financial semantics (C03).
 *
 * Codes are the library's standing taxonomy (C11), one per distinct mistake:
 *
 *     unknown key            input.unknown_field   did-you-mean + the allowed list
 *     missing required       input.missing_field   the worked example call
 *     null (non-nullable)    input.invalid_enum    on an enum field (null is not a member)
 *                            input.wrong_type      everywhere else (null is not omission)
 *     wrong primitive        input.wrong_type
 *     outside enum domain    input.invalid_enum
 *     NaN                    input.nan
 *     ±Infinity              input.not_finite
 *     no union branch fits   input.wrong_shape     every declared alternative, rendered
 *
 * Union resolution is DISCRIMINANT-FIRST (the `phi: {}` lesson: a missing discriminant must never
 * fall through to whichever branch a key-set match happens to pick): when a discriminant key is
 * present its value is checked against the union of every branch's literals before any branch is
 * entered. Branches without a literal discriminant — `Amortization`'s `{ principalByPeriod }` arm —
 * are selected structurally by their required keys.
 *
 * HOT PATHS: validate ONCE at the public boundary, then call unchecked internals. The walk is
 * O(declared fields) over static generated data; per-spec derived lookups (allowed-key arrays)
 * are cached in a module WeakMap so repeated calls allocate nothing.
 */

import { ErrorCode, InputError, missingFieldError } from './errors.js';
import { requireArgumentArray, requireArgumentObject } from './invariants.js';

/** What the validator checks for a field, projected from the inventory's richer kind vocabulary. */
export type ValidationFieldKind =
  | 'numeric'
  | 'enum'
  | 'boolean'
  | 'string'
  | 'array'
  | 'object'
  | 'callback'
  | 'unchecked';

export interface ValidationFieldSpecification {
  readonly name: string;
  readonly kind: ValidationFieldKind;
  readonly optional?: boolean;
  /** The declared union admits `null`; anywhere else a `null` is a wrong-typed value, not omission. */
  readonly nullable?: boolean;
  /**
   * A documented IEEE BOUND field: ±Infinity is the spelled "unbounded" (`localCap: Infinity`,
   * `globalFloor: -Infinity`). CURATED per contract in the validation roster, never inferred —
   * the checker sees `number` either way, and which numbers mean "no bound" is financial
   * semantics (C03). `NaN` stays rejected: no bound is ever spelled NaN.
   */
  readonly allowsInfinity?: boolean;
  /**
   * This numeric field is a synchronous resource count and must be a positive safe integer no
   * larger than this operation-level ceiling. Generated only where the declaration-derived resource
   * inventory owns the semantic classification; ordinary numeric magnitudes never receive it.
   */
  readonly safeIntegerMaximum?: number;
  /** The array's elements are resource counts governed by the same positive-safe-integer ladder. */
  readonly safeIntegerElementsMaximum?: number;
  /** The closed literal domain of an `enum` field. */
  readonly literals?: readonly (string | number | boolean)[];
  /**
   * OPEN primitive alternatives beside the literal domain — a MIXED union such as
   * `Frequency = 'annual' | 'semiannual' | … | number`, where a value is valid when it is a listed
   * literal OR any value of an open kind (numeric runs the finite ladder). Projected from the
   * declaration's arms; without it the collapsed kind rejected the named spellings.
   */
  readonly openKinds?: readonly ValidationFieldKind[];
  /** Nested closed object contract. */
  readonly fields?: readonly ValidationFieldSpecification[];
  /** Declared union alternatives. A field has `branches` OR `fields`, never both. */
  readonly branches?: readonly ValidationBranchSpecification[];
}

export interface ValidationBranchSpecification {
  readonly fields: readonly ValidationFieldSpecification[];
}

export interface ClosedRequestSpecification {
  /** The stable contract identity this spec was generated from — drift gates compare through it. */
  readonly contract: string;
  readonly fields: readonly ValidationFieldSpecification[];
  /**
   * ROOT union alternatives — the whole argument is a discriminated union (`phiValue`'s `SSVIPhi`).
   * When present, `fields` holds the arms' COMMON members (the discriminant) and resolution runs
   * discriminant-first over these arms exactly as a union FIELD's branches do.
   */
  readonly branches?: readonly ValidationBranchSpecification[];
}

export interface ClosedRequestTeaching {
  /** The argument's own label in container errors — defaults to `input`. */
  readonly argumentName?: string;
  /**
   * This argument IS the request — field paths stay bare (`volatility`, `issueDate`) even under a
   * domain-specific argument name like `specification`. Secondary arguments (an options bag beside
   * a subject) omit it and get prefixed paths so a two-object call says which object to fix.
   */
  readonly subject?: boolean;
  /**
   * ONE complete, runnable call for this boundary, or a thunk so the string is only built on the
   * failing path. Hand-authored at the call site: the generator knows the keys, never the values.
   */
  readonly exampleCall: string | (() => string);
  /** Per-field unit-trap notes, keyed by BARE field name (`volatility: 'annualized decimal'`). */
  readonly hints?: Readonly<Record<string, string>>;
  /**
   * The argument is an OPEN structural artifact per its manifest policy (Law 12): every consumed
   * field runs its ladder, but unknown keys are PRESERVED decoration, never rejected — a fit
   * result or market snapshot a user hands back may legitimately carry their own annotations.
   * Curated from the manifest's per-argument `inputPolicies`; closed remains the default.
   */
  readonly open?: boolean;
}

/** Derived per-fields lookups, cached so generated spec data stays plain and calls allocate nothing. */
interface FieldsIndex {
  readonly allowed: readonly string[];
  readonly byName: ReadonlyMap<string, ValidationFieldSpecification>;
}

const FIELDS_INDEX = new WeakMap<readonly ValidationFieldSpecification[], FieldsIndex>();

function indexOf(fields: readonly ValidationFieldSpecification[]): FieldsIndex {
  let index = FIELDS_INDEX.get(fields);
  if (index === undefined) {
    index = {
      allowed: fields.map((field) => field.name),
      byName: new Map(fields.map((field) => [field.name, field])),
    };
    FIELDS_INDEX.set(fields, index);
  }
  return index;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}" (string)`;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // This is an ERROR path over untrusted JavaScript input. Inspecting an object for a prettier
  // rendering can execute its `toJSON`, `toString`, or `Symbol.toPrimitive` hook and replace the
  // intended typed InputError with arbitrary user code. The type is the honest, side-effect-free
  // description available at this boundary; callers can inspect their own value separately.
  return typeof value;
}

/** Keep error context JSON-safe without retaining a caller-controlled object or function. */
function contextValue(value: unknown): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : describeValue(value);
  if (typeof value === 'bigint') return `${value}n`;
  return typeof value;
}

/** Damerau–Levenshtein ≤ 2 nearest match — the same did-you-mean `ensureKnownKeys` uses. */
function nearestName(key: string, allowed: readonly string[]): string | undefined {
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
  for (const candidate of allowed) {
    const d = dist(lower, candidate.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = candidate;
    }
  }
  return best;
}

function rejectUnknownKeys(
  functionName: string,
  containerPath: string,
  value: object,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const suggestion = nearestName(key, allowed);
    throw new InputError(
      `${functionName}: unknown field "${key}" in ${containerPath}${
        suggestion !== undefined ? ` — did you mean "${suggestion}"?` : ''
      } Allowed fields: ${allowed.join(', ')}.`,
      {
        code: ErrorCode.InputUnknownField,
        context: {
          function: functionName,
          field: containerPath,
          key,
          ...(suggestion !== undefined ? { suggestion } : {}),
        },
      },
    );
  }
}

function wrongType(
  functionName: string,
  path: string,
  expected: string,
  value: unknown,
): InputError {
  return new InputError(
    `${functionName}: ${path} must be ${expected}. Received ${describeValue(value)}.`,
    {
      code: ErrorCode.InputWrongType,
      context: {
        function: functionName,
        field: path,
        received: value === null ? 'null' : typeof value,
      },
    },
  );
}

function rejectOutsideDomain(
  functionName: string,
  path: string,
  value: unknown,
  literals: readonly (string | number | boolean)[],
): void {
  if ((literals as readonly unknown[]).includes(value)) return;
  const rendered = literals.map((literal) =>
    typeof literal === 'string' ? literal : String(literal),
  );
  throw new InputError(
    `${functionName}: ${path} must be one of ${rendered.join(', ')}; got ${describeValue(value)}.`,
    {
      code: ErrorCode.InputInvalidEnum,
      context: { function: functionName, field: path, value: contextValue(value) },
    },
  );
}

/** A compact rendering of one union alternative, for the no-branch-matched teaching error. */
function renderBranch(branch: ValidationBranchSpecification): string {
  const parts = branch.fields
    .filter((field) => field.optional !== true)
    .map((field) =>
      field.literals?.length === 1 ? `${field.name}: '${String(field.literals[0])}'` : field.name,
    );
  return `{ ${parts.join(', ')} }`;
}

/**
 * Discriminant-first branch selection. Returns the branch to validate against, or throws the
 * teaching error that names every declared alternative.
 */
function selectBranch(
  functionName: string,
  path: string,
  value: Record<string, unknown>,
  branches: readonly ValidationBranchSpecification[],
): ValidationBranchSpecification {
  // Discriminant candidates: names carrying a literal domain in at least one branch.
  const discriminants = new Map<string, (string | number | boolean)[]>();
  for (const branch of branches) {
    for (const field of branch.fields) {
      // An OPTIONAL literal field is never a discriminant: a discriminant DECIDES the arm, and a
      // field the caller may omit decides nothing. EntryRule made this concrete — every arm
      // carries `price?: 'ask' | 'bid' | …`, and treating it as a discriminant refused every
      // legal call that omitted it.
      if (field.optional === true) continue;
      if (field.literals !== undefined && field.literals.length > 0) {
        const pool = discriminants.get(field.name) ?? [];
        for (const literal of field.literals) if (!pool.includes(literal)) pool.push(literal);
        discriminants.set(field.name, pool);
      }
    }
  }
  /**
   * A PURE discriminated union (every arm carries the same literal discriminant — `SSVIPhi`)
   * refuses a MISSING discriminant on the discriminant itself, with the whole domain: that is the
   * library's standing `ensureEnum` convention for meaning-changing fields, and the curated
   * `requirePhi` behavior this generalizes. A union with structural arms (`Amortization`) falls
   * through to structural selection and the every-alternative teaching instead — `{}` there could
   * be a malformed structural arm, not a forgotten discriminant.
   */
  for (const [name, pool] of discriminants) {
    const inEveryArm = branches.every((branch) =>
      branch.fields.some(
        (field) => field.name === name && field.literals !== undefined && field.optional !== true,
      ),
    );
    if (inEveryArm && !Object.prototype.hasOwnProperty.call(value, name)) {
      rejectOutsideDomain(
        functionName,
        path === 'input' ? name : `${path}.${name}`,
        undefined,
        pool,
      );
    }
  }
  for (const [name, pool] of discriminants) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    const provided = value[name];
    // Validate the discriminant against the WHOLE declared domain first — a wrong or missing
    // discriminant must teach, never fall through to an arbitrary branch (the `phi: {}` class).
    rejectOutsideDomain(functionName, `${path}.${name}`, provided, pool);
    const matches = branches.filter((branch) =>
      branch.fields.some(
        (field) => field.name === name && field.literals?.includes(provided as never),
      ),
    );
    if (matches.length === 1) return matches[0]!;
  }
  // Structural selection: branches whose required fields are all present. On a tie, prefer the
  // branch whose allowed keys COVER the most of the value's keys — validating an ambiguous value
  // against an arbitrary arm would reject keys that belong to the other one, and over-closure is
  // the worse defect (it refuses valid calls in the name of strictness).
  const structural = branches.filter((branch) =>
    branch.fields.every(
      (field) => field.optional === true || Object.prototype.hasOwnProperty.call(value, field.name),
    ),
  );
  if (structural.length === 1) return structural[0]!;
  if (structural.length > 1) {
    const keys = Object.keys(value);
    let best = structural[0]!;
    let bestCovered = -1;
    for (const branch of structural) {
      const allowed = indexOf(branch.fields).allowed;
      const covered = keys.filter((key) => allowed.includes(key)).length;
      if (covered > bestCovered) {
        bestCovered = covered;
        best = branch;
      }
    }
    return best;
  }
  throw new InputError(
    `${functionName}: ${path} does not match any declared alternative. Expected one of: ${branches
      .map(renderBranch)
      .join(' | ')}.`,
    {
      code: ErrorCode.InputWrongShape,
      context: { function: functionName, field: path, received: Object.keys(value) },
    },
  );
}

function validateFields(
  functionName: string,
  containerPath: string,
  value: Record<string, unknown>,
  fields: readonly ValidationFieldSpecification[],
  teaching: ClosedRequestTeaching,
  fieldPrefix: string,
  openArtifact = false,
): void {
  const index = indexOf(fields);
  if (!openArtifact) rejectUnknownKeys(functionName, containerPath, value, index.allowed);
  for (const field of fields) {
    const path = fieldPrefix === '' ? field.name : `${fieldPrefix}.${field.name}`;
    const provided: unknown = value[field.name];
    if (provided === undefined) {
      if (field.optional === true) continue;
      const example = teaching.exampleCall;
      throw missingFieldError(
        functionName,
        path,
        typeof example === 'function' ? example() : example,
        teaching.hints?.[field.name],
      );
    }
    if (provided === null) {
      if (field.nullable === true) continue;
      // Null is not omission. An enum field teaches invalid_enum (null is not a member); every
      // other kind teaches wrong_type — the ruling the whole ladder now shares.
      if (field.kind === 'enum' && field.literals !== undefined) {
        rejectOutsideDomain(functionName, path, provided, field.literals);
      }
      throw wrongType(functionName, path, expectedOf(field), provided);
    }
    switch (field.kind) {
      case 'numeric': {
        if (typeof provided !== 'number') throw wrongType(functionName, path, 'a number', provided);
        if (!Number.isFinite(provided)) {
          // A curated bound field accepts ±Infinity as its documented "unbounded"; NaN never means
          // anything and is rejected even there.
          if (field.allowsInfinity === true && !Number.isNaN(provided)) break;
          throw new InputError(
            `${functionName}: ${path} must be a finite number. Received ${describeValue(provided)}.`,
            {
              code: Number.isNaN(provided) ? ErrorCode.InputNaN : ErrorCode.InputNotFinite,
              context: { function: functionName, field: path, value: provided },
            },
          );
        }
        if (
          field.safeIntegerMaximum !== undefined &&
          (!Number.isSafeInteger(provided) || provided < 1 || provided > field.safeIntegerMaximum)
        ) {
          throw new InputError(
            `${functionName}: ${path} must be a positive safe integer ≤ ${field.safeIntegerMaximum.toLocaleString('en-US')} (it controls synchronous work or allocation). Received ${String(provided)}.`,
            {
              code: ErrorCode.InputOutOfRange,
              context: {
                function: functionName,
                field: path,
                received: provided,
                max: field.safeIntegerMaximum,
              },
            },
          );
        }
        break;
      }
      case 'enum': {
        if (field.literals !== undefined) {
          if ((field.literals as readonly unknown[]).includes(provided)) break;
          // A mixed union admits an open primitive beside the named members: `frequency: 4` is as
          // legal as `'quarterly'`. A number still runs the finite ladder — `frequency: NaN` is
          // not a frequency under any spelling.
          if (field.openKinds?.includes('numeric') === true && typeof provided === 'number') {
            if (!Number.isFinite(provided)) {
              throw new InputError(
                `${functionName}: ${path} must be a finite number or one of ${field.literals.join(', ')}. Received ${describeValue(provided)}.`,
                {
                  code: Number.isNaN(provided) ? ErrorCode.InputNaN : ErrorCode.InputNotFinite,
                  context: { function: functionName, field: path, value: provided },
                },
              );
            }
            break;
          }
          if (field.openKinds?.includes('string') === true && typeof provided === 'string') break;
          if (field.openKinds?.includes('boolean') === true && typeof provided === 'boolean') break;
          const rendered = field.literals.map((literal) => String(literal));
          const open = field.openKinds?.length ? `, or any ${field.openKinds.join('/')} value` : '';
          throw new InputError(
            `${functionName}: ${path} must be one of ${rendered.join(', ')}${open}; got ${describeValue(provided)}.`,
            {
              code: ErrorCode.InputInvalidEnum,
              context: {
                function: functionName,
                field: path,
                value: contextValue(provided),
              },
            },
          );
        }
        break;
      }
      case 'boolean': {
        if (typeof provided !== 'boolean')
          throw wrongType(functionName, path, 'a boolean', provided);
        break;
      }
      case 'string': {
        if (typeof provided !== 'string') throw wrongType(functionName, path, 'a string', provided);
        break;
      }
      case 'array': {
        requireArgumentArray(functionName, path, provided);
        if (field.safeIntegerElementsMaximum !== undefined) {
          const elements = provided as ArrayLike<unknown>;
          for (let index = 0; index < elements.length; index++) {
            const element = elements[index];
            const elementPath = `${path}[${index}]`;
            if (typeof element !== 'number') {
              throw wrongType(functionName, elementPath, 'a number', element);
            }
            if (!Number.isFinite(element)) {
              throw new InputError(
                `${functionName}: ${elementPath} must be a finite number. Received ${describeValue(element)}.`,
                {
                  code: Number.isNaN(element) ? ErrorCode.InputNaN : ErrorCode.InputNotFinite,
                  context: { function: functionName, field: elementPath, value: element },
                },
              );
            }
            if (
              !Number.isSafeInteger(element) ||
              element < 1 ||
              element > field.safeIntegerElementsMaximum
            ) {
              throw new InputError(
                `${functionName}: ${elementPath} must be a positive safe integer ≤ ${field.safeIntegerElementsMaximum.toLocaleString('en-US')} (it controls synchronous work or allocation). Received ${String(element)}.`,
                {
                  code: ErrorCode.InputOutOfRange,
                  context: {
                    function: functionName,
                    field: elementPath,
                    received: element,
                    max: field.safeIntegerElementsMaximum,
                  },
                },
              );
            }
          }
        }
        break;
      }
      case 'callback': {
        if (typeof provided !== 'function')
          throw wrongType(functionName, path, 'a function', provided);
        break;
      }
      case 'object': {
        requireArgumentObject(functionName, path, provided);
        const record = provided as Record<string, unknown>;
        if (field.branches !== undefined) {
          const branch = selectBranch(functionName, path, record, field.branches);
          validateFields(functionName, path, record, branch.fields, teaching, path);
        } else if (field.fields !== undefined) {
          validateFields(functionName, path, record, field.fields, teaching, path);
        }
        break;
      }
      case 'unchecked':
        break;
    }
  }
}

function expectedOf(field: ValidationFieldSpecification): string {
  switch (field.kind) {
    case 'numeric':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'string':
      return 'a string';
    case 'array':
      return 'an array';
    case 'callback':
      return 'a function';
    case 'object':
      return 'an object';
    default:
      return 'a value of its declared type';
  }
}

/**
 * Validate one public closed request against its GENERATED contract spec. Call ONCE at the public
 * boundary; internals stay unchecked. Domain semantics (positivity, coordinate relationships,
 * plausibility) remain the boundary's own code — this enforces shape, presence, type, finiteness,
 * domain literals, and closedness, with the exact code each mistake owns.
 */
export function validateClosedRequest(
  functionName: string,
  value: unknown,
  specification: ClosedRequestSpecification,
  teaching: ClosedRequestTeaching,
): void {
  const argumentName = teaching.argumentName ?? 'input';
  requireArgumentObject(functionName, argumentName, value);
  // Top-level fields of the SUBJECT request keep their bare names (`volatility`, the seed-fixture
  // convention); fields of a secondary argument are prefixed (`options.steps`) so a two-object
  // call says which object to fix. Nested fields are always dotted from wherever they hang.
  const fieldPrefix = teaching.subject === true || argumentName === 'input' ? '' : argumentName;
  if (specification.branches !== undefined) {
    const record = value as Record<string, unknown>;
    const branch = selectBranch(functionName, argumentName, record, specification.branches);
    validateFields(
      functionName,
      argumentName,
      record,
      branch.fields,
      teaching,
      fieldPrefix,
      teaching.open === true,
    );
    return;
  }
  validateFields(
    functionName,
    argumentName,
    value as Record<string, unknown>,
    specification.fields,
    teaching,
    fieldPrefix,

    teaching.open === true,
  );
}
