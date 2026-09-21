/**
 * Phase 3B.0 — enforcement MEASURED by execution, not inferred from the source.
 *
 * ## Why this exists
 *
 * The first version of the contract inventory inferred enforcement statically: if a guard call was
 * reachable from a public declaration, the contract was "enforced." That produced a claim the same
 * commit contradicted. `blackScholesPrice` was recorded `direct`ly enforced because it calls
 * `requireArgumentObject` and `ensureEnum` — while `SEED_FIXTURES`, two files away, recorded that it
 * returns `NaN` for a missing `volatility` and silently ignores an unknown key. Both were true.
 * `requireArgumentObject` proves the argument IS AN OBJECT. It proves nothing about required fields
 * or unknown keys.
 *
 * No refinement of the static pass closes that gap, because "a guard is reachable" and "the contract
 * is enforced" are different propositions. The static signal is still useful — it is now named
 * `guardReachability`, which is what it measures — but the authority has to be observation.
 *
 * So: take a VALID argument list, break it in one specific way, call the function, and record what
 * happened. That is the contract, tested. It cannot disagree with reality because it IS reality.
 *
 * ## What a verdict means
 *
 *   rejected  — threw a typed `QuantError`. The contract held, with a code a caller can branch on.
 *   untyped   — threw, but not a `QuantError`. Better than silence, still a defect: the spec requires
 *               "exact `QuantError` code, field path, and useful correction—not merely 'some
 *               exception'."
 *   accepted  — RETURNED. The mutation passed through. This is the seed-defect class, and whether the
 *               result was `NaN`, `null`, or a plausible number, the caller was not told.
 *
 * `accepted` is recorded with the returned value's shape so the failure is legible: a `"$NaN"` string
 * and a silent `{ upper: null }` are both accepted-mutations, and both mislead differently.
 */

import { isQuantError } from '@totalfinance/core';
import type { LiteralValue } from './contract-fields.js';

/** The ways a valid input is broken. Each maps to a spec-required 3B.1 mutation. */
/** How deep to walk a nested object contract. Matches the depth `contract-fields.ts` records. */
const MAX_PROBE_DEPTH = 3;

/** Sentinel meaning "delete this key" rather than "set it to undefined". */
const DELETE_MARKER = Symbol('delete');

export type MutationKind =
  /** Add a key nothing declares — the misspelling case, and the one Law 12 is about. */
  | 'unknown-key'
  /** Delete one required field — the missing-`volatility` case. */
  | 'omit-required'
  /** Replace a number with a string — wrong primitive. */
  | 'wrong-type'
  /**
   * A value OUTSIDE a declared literal domain — `'qzxBogus'` where `'bid' | 'ask' | …` is declared.
   *
   * Distinct from `wrong-type` on purpose. `wrong-type` substitutes a NUMBER for a string, so a
   * boundary that merely checks `typeof x === 'string'` rejects it and reads as "enforces the enum"
   * while accepting any string at all. Only an invalid LITERAL of the right primitive type can tell
   * "rejects a wrong primitive" apart from "enforces the declared domain".
   */
  | 'invalid-literal'
  /** Put `NaN` where a finite number is required. */
  | 'non-finite'
  // ---- container mutations (445 series/container boundaries had NO measurement at all) ----
  /** An empty series where the contract needs data. */
  | 'empty-series'
  /** A string where a numeric element belongs. */
  | 'wrong-element-type'
  /** `NaN` inside an otherwise valid series. */
  | 'non-finite-element'
  /** Ragged rows in a matrix the contract requires rectangular. */
  | 'ragged-matrix'
  /**
   * Supply a declared OPTIONAL field with a value its type forbids.
   *
   * Optional fields were never probed at all: omitting one proves nothing, so the loop skipped it and
   * moved on. But "you may leave this out" is not "anything goes when you put it in" — roughly 1,600
   * optional fields across the measured surface had never been supplied, let alone type-checked. A
   * contract that silently accepts `period: 'abc'` is unenforced whether or not `period` was required.
   */
  | 'optional-wrong-type'
  /**
   * Supply `null` to a declared field whose type does not admit it.
   *
   * C06 makes an optional field's `undefined` mean omission; it does NOT make `null` a second
   * spelling of omission — `null` is reserved for declarations that spell it, and almost none do.
   * A guard that early-returns on null (`if (v == null) return`) silently accepts a value the
   * declaration already refused, and no other mutation can see it: `wrong-type` supplies a string,
   * which the same guard correctly rejects, so the boundary reads as enforced on exactly the
   * dimension it is not. The baseline validator has enforced this direction since R11
   * (`nodeGap`: "is not declared nullable, got null"); this probe asks the same question of the
   * BOUNDARY instead of the fixture.
   */
  | 'null-when-nonnullable';

export type Verdict = 'rejected' | 'untyped' | 'accepted';

export interface ProbeResult {
  mutation: MutationKind;
  /**
   * Which ARGUMENT was mutated.
   *
   * Without it a result cannot be interpreted: the manifest declares per-argument `closed`/`open`/
   * `passthrough` policies, and an `open` structural artifact is SUPPOSED to accept decoration. Nine
   * paths were convicted for behaviour their contract permits because the index was not recorded.
   */
  argumentIndex: number;
  /** The field the mutation targeted, when it targets one. */
  field?: string;
  /**
   * The mutation was decided against the field's DECLARED contract (type and requiredness), not guessed
   * from the sample value. Only a declared result may convict on `omit-required` / `wrong-type`.
   */
  declared?: boolean;
  verdict: Verdict;
  /** The typed error code, when the verdict is `rejected`. */
  code?: string;
  /** For `accepted`: a short rendering of what came back instead of an error. */
  returned?: string;
}

/**
 * The part of a contract field this probe needs. Structurally mirrors `FieldNode` from
 * `contract-fields.ts`, kept local so the probe does not depend on the generator that produces it.
 */
export interface FieldNodeLike {
  name: string;
  kind: string;
  optional: boolean;
  /** The declared union admits `null` — set by `walkField`, required by `null-when-nonnullable`. */
  nullable?: boolean;
  literals?: LiteralValue[];
  /** Nested object contract, so a probe can reach past the top level (R11). */
  fields?: readonly FieldNodeLike[];
  /**
   * Every arm of a union. A UNION-TYPED FIELD'S MEMBERS LIVE HERE, not on `fields`.
   *
   * Absent from this interface until now, which is why the recursion below descended into a nested
   * union with no declared contract at all — see `declaredMembersOf`.
   */
  branches?: readonly { kind?: string; fields?: readonly FieldNodeLike[] }[];
}

/** A key no contract declares. Deliberately unmistakable in a failure message. */
const BOGUS_KEY = 'qzxBogusKey';

/** A member no declared literal domain contains. Same reasoning as `BOGUS_KEY`. */
const BOGUS_LITERAL = 'qzxBogusLiteral';

/**
 * THE DECLARED MEMBERS OF A NESTED VALUE — resolving a union to the arm the value satisfies.
 *
 * The recursion descended with `node.fields`, and a union-typed field has no `fields`: its members
 * live on its ARMS. So every nested union was walked with NO declared contract — the probe still
 * recursed, but it could not say a field was declared, could not know its type, and could not know it
 * had a literal domain to violate. `exposure(config.convention)` is the case that made this visible:
 * its `{ calls: 1 | -1; puts: 1 | -1 }` arm is two closed domains, and `config.convention.calls`
 * appears nowhere in either artifact because nothing ever reached it.
 *
 * The arm is chosen the way the validator chooses one — by DISCRIMINATOR first. An arm whose declared
 * domain contradicts a value present on the object cannot be the arm, and among those left the one
 * declaring the most members the value actually carries is the closest match. Choosing wrongly costs
 * what today costs unconditionally (a nested object walked as undeclared), so this is strictly more
 * information, never less.
 */
function declaredMembersOf(
  node: FieldNodeLike | undefined,
  value: Record<string, unknown>,
): readonly FieldNodeLike[] | undefined {
  if (!node) return undefined;
  const arms = node.branches;
  if (!arms || arms.length <= 1) return node.fields;
  let best: readonly FieldNodeLike[] | undefined;
  let bestScore = -1;
  for (const arm of arms) {
    const fields = arm.fields;
    if (!fields || fields.length === 0) continue;
    const contradicted = fields.some(
      (field) =>
        (field.literals?.length ?? 0) > 0 &&
        value[field.name] !== undefined &&
        !(field.literals ?? []).some((literal) => literal === value[field.name]),
    );
    if (contradicted) continue;
    const score = fields.filter((field) => value[field.name] !== undefined).length;
    if (score > bestScore) {
      bestScore = score;
      best = fields;
    }
  }
  if (best === undefined) return node.fields;
  /**
   * A field required by THIS arm but not by EVERY arm probes as OPTIONAL: deleting it may
   * legitimately re-narrow the value to another arm. `rawGreeksFromDisplay(greeks: Greeks |
   * ExtendedGreeks)` is the case that made this visible — synthesis built the wider arm, the probe
   * omitted `charm`, and the runtime correctly accepted a complete Greeks. Ten convictions
   * described the union working. Omission convicts only where every arm agrees the field must
   * exist; the wrong-type/non-finite probes still run at full strength either way.
   */
  const objectArms = arms.filter((arm) => (arm.fields?.length ?? 0) > 0);
  if (objectArms.length > 1) {
    const requiredEverywhere = new Set(
      (objectArms[0]?.fields ?? [])
        .filter((field) => field.optional !== true)
        .map((field) => field.name)
        .filter((name) =>
          objectArms.every((arm) =>
            (arm.fields ?? []).some((field) => field.name === name && field.optional !== true),
          ),
        ),
    );
    return best.map((field) =>
      field.optional === true || requiredEverywhere.has(field.name)
        ? field
        : { ...field, optional: true },
    );
  }
  return best;
}

/**
 * A value OUTSIDE a declared domain, in the domain's OWN primitive.
 *
 * `BOGUS_LITERAL` is a string, so against `order?: 1 | 2` it tested whether the boundary rejects a
 * STRING — which any `typeof` check answers — and never whether it rejects the number 3. That is a
 * different question, and the one a numeric domain exists to raise: `{ calls: 0 }` and `{ calls: 7 }`
 * are the failures that matter, not `{ calls: 'qzxBogusLiteral' }`.
 *
 * A SINGLETON BOOLEAN domain gets `false` against `true`, and `true` against `false`.
 *
 * This declined to probe one, reasoning that "`flag: true` has only `false`, and sending it tests a
 * boolean's ordinary handling rather than a domain violation". That was wrong, and backwards:
 * `false` IS a same-typed value outside the declared domain, and whether the boundary rejects it is
 * the ONLY thing separating `enabled: true` from `enabled: boolean`. A boundary that checks
 * `typeof enabled === 'boolean'` and stops satisfies the second and violates the first — and with no
 * probe emitted it published `enforced` on the strength of `omit-required` and `wrong-type` alone.
 *
 * `boolean` itself is still not a domain, because the EMITTER never records one for it: the checker
 * models it as `true | false` and a caller passes one type. That exclusion belongs where the domain
 * is decided. Declining to probe a domain that was recorded is a different act, and it was a hole.
 */
function outsideDomain(literals: readonly LiteralValue[] | undefined): unknown | undefined {
  const values = literals ?? [];
  if (values.length === 0) return undefined;
  if (values.every((value) => typeof value === 'string')) return BOGUS_LITERAL;
  if (values.every((value) => typeof value === 'number')) {
    const numbers = values as readonly number[];
    // A value the domain cannot contain, chosen from the domain so it stays same-typed and finite.
    return Math.max(...numbers) + 7;
  }
  if (values.every((value) => typeof value === 'boolean')) {
    // A domain holding both booleans has no outside; a singleton's outside is the other one.
    return values.includes(true) && values.includes(false) ? undefined : !values[0];
  }
  return undefined;
}

/**
 * One ARGUMENT's declared contract — not one PARAMETER's.
 *
 * The distinction is the whole point of this type. A labelled rest-tuple is one parameter carrying
 * several arguments, and an optional non-object parameter carries none, so indexing the parameter
 * array against the argument array silently describes the wrong slot. `synthesizeCall` and
 * `expandedCoordinates` produce these in argument order.
 */
export interface ProbeCoordinate {
  /** `numeric` | `primitive` | `series` | `object` | `callback` | `other`, as the inventory files it. */
  kind?: string;
  /** The rendered declared type, because the PARAMETER kinds are a coarser vocabulary than the FIELD kinds. */
  type?: string;
  optional?: boolean;
  /** The declared closed set, when the argument resolves to one. */
  literals?: readonly LiteralValue[];
  /** The declared field tree for an object argument — already narrowed to the satisfied branch. */
  fields?: readonly FieldNodeLike[];
}

/** Render a returned value compactly enough for a failure message, and revealingly. */
function renderReturn(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value).slice(0, 120);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Call `run` and classify what happened. */
function observe(run: () => unknown): { verdict: Verdict; code?: string; returned?: string } {
  let value: unknown;
  try {
    value = run();
  } catch (caught) {
    if (isQuantError(caught)) return { verdict: 'rejected', code: caught.code };
    return { verdict: 'untyped' };
  }
  return { verdict: 'accepted', returned: renderReturn(value) };
}

/** Is this a plain object we may mutate (not an array, class instance, or typed array)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Deep-ish clone sufficient for one-level argument mutation. */
function cloneArguments(args: unknown[]): unknown[] {
  return args.map((argument) => (isPlainObject(argument) ? { ...argument } : argument));
}

/**
 * Mutations of a SERIES or MATRIX argument.
 *
 * 445 required boundaries had no measurement whatsoever, because enforcement targeted only the first
 * plain-object argument and an array API has none. `attribution(trades)`, `cholesky(matrix)` and most
 * of technical analysis were simply absent from the record — and a series contract fails in ways an
 * object contract cannot: an empty input, a `NaN` buried mid-series, a ragged matrix.
 */
function probeSeries(
  invoke: (args: unknown[]) => unknown,
  freshArguments: () => unknown[],
  index: number,
  sample: unknown[],
): ProbeResult[] {
  const results: ProbeResult[] = [];
  const withArgument = (replacement: unknown): unknown[] => {
    const args = freshArguments();
    args[index] = replacement;
    return args;
  };

  results.push({
    mutation: 'empty-series',
    argumentIndex: index,
    ...observe(() => invoke(withArgument([]))),
  });

  const first = sample[0];
  if (typeof first === 'number') {
    results.push({
      mutation: 'wrong-element-type',
      argumentIndex: index,
      ...observe(() => invoke(withArgument(['not-a-number', ...sample.slice(1)]))),
    });
    results.push({
      mutation: 'non-finite-element',
      argumentIndex: index,
      // MID-series, not at the head: a guard that only checks the first element is a common shortcut,
      // and burying it is what distinguishes a real check from a spot check.
      ...observe(() => {
        const copy = [...sample];
        copy[Math.floor(copy.length / 2)] = Number.NaN;
        return invoke(withArgument(copy));
      }),
    });
  } else if (isPlainObject(first)) {
    // A series of records (bars, trades, quotes): break a numeric field of ONE element.
    const numeric = Object.keys(first).find((key) => typeof first[key] === 'number');
    if (numeric !== undefined) {
      results.push({
        mutation: 'non-finite-element',
        argumentIndex: index,
        field: numeric,
        ...observe(() => {
          const copy = sample.map((element) =>
            isPlainObject(element) ? { ...element } : element,
          ) as Record<string, unknown>[];
          const middle = copy[Math.floor(copy.length / 2)];
          if (middle) middle[numeric] = Number.NaN;
          return invoke(withArgument(copy));
        }),
      });
    }
  } else if (Array.isArray(first)) {
    // A matrix: make it ragged.
    results.push({
      mutation: 'ragged-matrix',
      argumentIndex: index,
      ...observe(() => {
        const copy = sample.map((row) => (Array.isArray(row) ? [...row] : row));
        const last = copy[copy.length - 1];
        if (Array.isArray(last)) last.pop();
        return invoke(withArgument(copy));
      }),
    });
  }
  return results;
}

/**
 * Probe one callable against every applicable mutation of its object arguments.
 *
 * `freshArguments` must return a NEW valid argument list each call — probes mutate what they are
 * given, and a shared object would let one probe corrupt the next.
 */
export function probeContract(
  target: (...args: unknown[]) => unknown,
  freshArguments: () => unknown[],
  options: {
    maxFieldsPerMutation?: number;
    construct?: boolean;
    /**
     * The recursive contract of each argument, by index (R7).
     *
     * With it, `omit-required` fires only on fields the contract declares REQUIRED and `wrong-type`
     * substitutes a value the declared type actually forbids — so both become authoritative instead of
     * advisory. Without it the probe cannot distinguish a defect from correct optional-field behaviour,
     * which is why it previously had to record them as advisory and could not convict.
     */
    coordinates?: (ProbeCoordinate | undefined)[];
    /** A field required in one union arm may be omitted by switching to another valid arm. */
    acceptsOmittedArguments?: (args: unknown[]) => boolean;
  } = {},
): ProbeResult[] {
  const limit = options.maxFieldsPerMutation ?? 6;
  const results: ProbeResult[] = [];
  const sample = freshArguments();

  /**
   * How the contract is entered.
   *
   * A CLASS must be reached with `new`. Calling one as a function throws a bare `TypeError`, which the
   * harness read as a failed baseline — so all 75 public constructor boundaries were recorded
   * `unmeasured`, including `BollingerStream`, whose defect had already been demonstrated by hand.
   */
  const invoke = (args: unknown[]): unknown =>
    options.construct === true
      ? new (target as unknown as new (...a: unknown[]) => unknown)(...args)
      : target(...args);

  for (let index = 0; index < sample.length; index++) {
    const argument = sample[index];
    if (Array.isArray(argument)) {
      results.push(...probeSeries(invoke, freshArguments, index, argument));
      continue;
    }
    if (!isPlainObject(argument)) {
      /**
       * A SCALAR COORDINATE IS A CONTRACT TOO, and it was skipped entirely.
       *
       * `selectQuotePrice(quote, source)` recorded 41 probe results, every one of them on argument 0,
       * and NOTHING on `source` — whose five allowed literals the inventory had recorded all along.
       * 181 measured public paths across 78 implementations pair an object or series with a scalar
       * coordinate (`nextExpiry(…, kind)`, the pipeline field selectors, the pivot methods), and for
       * every one of them half the call was unexamined while the verdict spoke for the whole.
       */
      const coordinate = options.coordinates?.[index];
      if (coordinate) {
        results.push(...probeScalar(invoke, freshArguments, index, coordinate));
      }
      continue;
    }

    // ---- unknown key ----
    results.push({
      mutation: 'unknown-key',
      argumentIndex: index,
      ...observe(() => {
        const args = cloneArguments(freshArguments());
        args[index] = { ...(args[index] as Record<string, unknown>), [BOGUS_KEY]: 1 };
        return invoke(args);
      }),
    });

    // ---- per-field mutations, to the depth the contract declares ----
    results.push(
      ...probeObject(
        invoke,
        freshArguments,
        index,
        argument,
        options.coordinates?.[index]?.fields,
        limit,
        [],
        0,
        options.acceptsOmittedArguments,
      ),
    );
  }
  return results;
}

/**
 * Mutate a positional SCALAR argument: omit it, mistype it, and step outside its literal domain.
 *
 * "Omit" is `undefined` rather than a deletion, because a positional argument cannot be deleted —
 * `f(a, undefined)` is exactly what a caller who forgot the second argument produces, which is the
 * case worth asking about.
 */
function probeScalar(
  invoke: (args: unknown[]) => unknown,
  freshArguments: () => unknown[],
  index: number,
  coordinate: ProbeCoordinate,
): ProbeResult[] {
  const results: ProbeResult[] = [];
  const declared = coordinate.kind !== undefined ? { declared: true } : {};
  const substitute = (value: unknown): unknown[] => {
    const args = cloneArguments(freshArguments());
    args[index] = value;
    return args;
  };

  if (coordinate.optional !== true) {
    results.push({
      mutation: 'omit-required',
      argumentIndex: index,
      ...declared,
      ...observe(() => invoke(substitute(undefined))),
    });
  }

  const wrong = wrongScalarFor(coordinate);
  if (wrong !== undefined) {
    results.push({
      mutation: 'wrong-type',
      argumentIndex: index,
      ...declared,
      ...observe(() => invoke(substitute(wrong))),
    });
  }

  /**
   * NaN WHERE A FINITE NUMBER IS DECLARED. `non-finite` was probed on object FIELDS from the start
   * and never on a positional numeric coordinate, so 136 measured paths pairing an object or series
   * with a numeric scalar had that whole dimension unexamined. `wrong-type` does not cover it: NaN
   * IS a number, so a `typeof x === 'number'` guard admits it and the arithmetic silently produces
   * NaN — the exact silent-miscompute class 3B.1b-1 exists to close.
   */
  if (coordinate.kind === 'numeric' || /\bnumber\b/.test(coordinate.type ?? '')) {
    results.push({
      mutation: 'non-finite',
      argumentIndex: index,
      ...declared,
      ...observe(() => invoke(substitute(Number.NaN))),
    });
  }

  // Only meaningful against a DECLARED domain, and only a same-typed non-member proves anything.
  const outside = outsideDomain(coordinate.literals);
  if (outside !== undefined) {
    results.push({
      mutation: 'invalid-literal',
      argumentIndex: index,
      declared: true,
      ...observe(() => invoke(substitute(outside))),
    });
  }
  return results;
}

/**
 * A value a SCALAR ARGUMENT's declared type forbids.
 *
 * `wrongTypeFor` speaks the FIELD vocabulary (`numeric`, `string`, `boolean`); a parameter's kind is
 * the coarser `primitive`, which that switch has no case for — so every string and boolean argument
 * in the library silently produced no `wrong-type` probe at all. Two vocabularies for one idea is the
 * same defect this whole pass is about, so the coarse case falls back to reading the rendered type.
 */
/**
 * A wrong value OUTSIDE EVERY ARM of a union — or `undefined` when no honest one exists.
 *
 * A union's wrong-type probe must never inject a member of ANOTHER branch. `kind` classifies a
 * union as ONE of its arms, so `forwardVolatility(from: string | number)` was probed with a
 * number — a legitimate year fraction, a probe that cannot fail — and three term-structure heads
 * plus `explainPosition(market.asOf: EpochMs | string)` were convicted for accepting values their
 * declarations admit.
 */
function wrongTypeOutsideArms(kinds: ReadonlySet<string>): unknown {
  if (!kinds.has('string') && !kinds.has('enum')) return 'not-a-member';
  if (!kinds.has('numeric')) return 12_345;
  if (!kinds.has('boolean')) return true;
  return undefined;
}

function wrongScalarFor(coordinate: ProbeCoordinate): unknown {
  const rendered = coordinate.type ?? '';
  // Union awareness comes FIRST: `kind` names one arm, and answering by one arm injects a member
  // of the other (see wrongTypeOutsideArms).
  const scalarArms = new Set<string>();
  if (/\bstring\b/.test(rendered)) scalarArms.add('string');
  if (/\bnumber\b/.test(rendered)) scalarArms.add('numeric');
  if (/\bboolean\b/.test(rendered)) scalarArms.add('boolean');
  if (scalarArms.size > 1) return wrongTypeOutsideArms(scalarArms);
  const byKind = wrongTypeFor(coordinate.kind);
  if (byKind !== undefined) return byKind;
  const declared = rendered;
  /**
   * A wrong TYPE for a domain is decided by what the domain holds, not by assuming it holds strings.
   *
   * This returned `1` for every declared domain on the reasoning that "a declared literal domain is
   * a string domain". Once numbers are recorded that is false, and it made the `wrong-type` probe
   * send a VALID member against `order?: 1 | 2` — a probe that cannot fail, reported as one that ran.
   */
  const domain = coordinate.literals ?? [];
  if (domain.length > 0) return domain.every((value) => typeof value === 'number') ? 'x' : 1;
  if (/\bstring\b/.test(declared)) return 1;
  if (/\bnumber\b/.test(declared)) return 'x';
  if (/\bboolean\b/.test(declared)) return 1;
  return undefined;
}

/** A value the declared kind forbids, so `wrong-type` can convict on more than numbers. */
function wrongTypeFor(kind: string | undefined): unknown {
  switch (kind) {
    case 'numeric':
      return 'not-a-number';
    case 'string':
    case 'enum':
      return 12_345;
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return 'not-an-array';
    case 'object':
      return 'not-an-object';
    default:
      return undefined;
  }
}

/**
 * Probe one object argument, recursively.
 *
 * Three limits are lifted here, and each was hiding real contracts:
 *
 *   DEPTH     only the top level was probed, so 299 paths reading `enforced` had nested contracts
 *             nothing had touched. Nested fields are addressed by dotted path (`market.spot`), which
 *             keeps the mutation vocabulary and every existing gate unchanged.
 *   THE CAP   the first six keys of the SAMPLE were probed. Two problems: 18 contracts declare more
 *             than six required fields, and iterating the sample means a declared field the synthesis
 *             happened to skip was never seen at all. Declared fields are now probed exhaustively —
 *             they are the only ones that can convict — and the cap applies solely to undeclared
 *             extras.
 *   OPTIONAL  never supplied. See `optional-wrong-type`.
 */
function probeObject(
  invoke: (args: unknown[]) => unknown,
  freshArguments: () => unknown[],
  index: number,
  sampleObject: Record<string, unknown>,
  tree: readonly FieldNodeLike[] | undefined,
  limit: number,
  prefix: readonly string[] = [],
  depth = 0,
  acceptsOmittedArguments?: (args: unknown[]) => boolean,
): ProbeResult[] {
  const results: ProbeResult[] = [];
  const declared = new Map((tree ?? []).map((node) => [node.name, node]));
  const label = (name: string): string => [...prefix, name].join('.');

  /** Replace the value at a dotted path on a fresh argument list. */
  const withFieldValue = (path: readonly string[], value: unknown): unknown[] => {
    const args = cloneArguments(freshArguments());
    const root = { ...(args[index] as Record<string, unknown>) };
    let cursor = root;
    for (const key of path.slice(0, -1)) {
      const next = cursor[key];
      if (!isPlainObject(next)) return args;
      cursor[key] = { ...next };
      cursor = cursor[key] as Record<string, unknown>;
    }
    const last = path[path.length - 1]!;
    if (value === DELETE_MARKER) delete cursor[last];
    else cursor[last] = value;
    args[index] = root;
    return args;
  };

  // Declared fields exhaustively; undeclared sample keys up to the cap.
  const declaredNames = [...declared.keys()];
  /**
   * NEVER MUTATE AN UNDECLARED SAMPLE KEY. It is not a coordinate of the contract, so no verdict
   * about it describes the contract.
   *
   * Probing sample "extras" is where the false evidence came from: `options.dk` has no reader
   * anywhere in `packages/options/src` and is undeclared, yet its mutations were recorded as
   * authoritative Dupire failures; `market.expiry` did the same for Monte-Carlo. A stale fixture key
   * became a measurement, and the record showed a boundary convicted on a field it does not have.
   *
   * Unknown-key behaviour is NOT lost by dropping this: it is tested independently and correctly by
   * INJECTING `qzxBogusKey` into an otherwise valid request, which asks the question this path was
   * only pretending to ask. What an undeclared key in a BASELINE indicates is a fixture defect, and
   * that belongs to baseline validation, not to the mutation vocabulary.
   */
  for (const name of declaredNames) {
    const node = declared.get(name);
    const path = [...prefix, name];
    const present = Object.prototype.hasOwnProperty.call(sampleObject, name);

    /**
     * `null` in a field the declaration does not admit it in — required or optional, present or
     * absent. Runs BEFORE the absent-optional early-continue so an omitted optional still gets the
     * question "and what if a JSON producer wrote null here instead?", which is exactly how nulls
     * arrive in practice (`JSON.stringify(NaN)` is null; a database LEFT JOIN is null).
     */
    if (node !== undefined && node.nullable !== true) {
      results.push({
        mutation: 'null-when-nonnullable',
        argumentIndex: index,
        field: label(name),
        declared: true,
        ...observe(() => invoke(withFieldValue(path, null))),
      });
    }

    if (node?.optional === true) {
      /**
       * An optional field that is ABSENT gets supplied with a value its type forbids. Omitting it
       * proves nothing — that is what optional means — but accepting a wrong-typed one does.
       */
      const wrong = wrongTypeFor(node.kind);
      if (!present && wrong !== undefined) {
        results.push({
          mutation: 'optional-wrong-type',
          argumentIndex: index,
          field: label(name),
          declared: true,
          ...observe(() => invoke(withFieldValue(path, wrong))),
        });
      }
      if (!present) continue;
    }

    /**
     * NEVER `omit-required` A DECLARED-OPTIONAL FIELD. Deleting one MUST succeed.
     *
     * The guard above returns early only when an optional field is ABSENT, so a PRESENT one fell
     * through to here and was probed for omission — tagged `declared: true`, which `isAuthoritative`
     * reads as "the contract decided this". The deletion is then accepted, because accepting it is
     * what `optional` MEANS, and the acceptance was recorded as a failure.
     *
     * It convicted 450 boundaries on nothing else — 27% of the `defective` headline describing
     * correct code. `blackScholes.price` was `defective` with exactly one failure,
     * `omit-required/dividendYield`, a field its own tree marks optional, while the call returns
     * 9.87.
     *
     * The intent was written down twice and never implemented: `AUTHORITATIVE_WHEN_DECLARED` says
     * "Deleting an optional field must succeed", and `summarize` below says the caller "filters by
     * declared optionality before asking for a summary" — no caller ever did. This is a restoration
     * rather than new policy: before 383c6fdb ("R11 depth") the guard read
     * `if (node?.optional === true) continue`, and that commit demoted the unconditional skip to
     * `if (!present) continue` when it added the `optional-wrong-type` probe for absent optionals.
     *
     * Emitting it UNDECLARED is not the fix. An accepted-but-undeclared result lands in `advisory`,
     * which forces the verdict to `partial` — a false "undecided" swapped for a false conviction.
     * The probe must not run at all. `wrong-type` below still runs on a present optional, and
     * legitimately: optional means "may be omitted", never "may be any type".
     */
    if (present && node?.optional !== true) {
      const omitted = withFieldValue(path, DELETE_MARKER);
      // Narrowing selects fields to visit, not the only legal future input. Deleting a branch
      // discriminator can produce another declared arm (e.g. model health -> quote-only health).
      // That is not a negative probe: do not call, credit, convict, or downgrade it to advisory.
      // The production caller supplies the same COMPLETE declaration walker used for baselines.
      if (acceptsOmittedArguments?.(omitted) !== true) {
        results.push({
          mutation: 'omit-required',
          argumentIndex: index,
          field: label(name),
          ...(node !== undefined ? { declared: true } : {}),
          ...observe(() => invoke(omitted)),
        });
      }
    }

    /**
     * A SAME-TYPED MEMBER OUTSIDE A DECLARED DOMAIN — the one mutation that can tell an enum apart
     * from a type check.
     *
     * Object fields declaring `literals` were probed only with a WRONG PRIMITIVE, so a boundary
     * doing nothing but `typeof x === 'string'` rejected it and read as "enforces the declared set"
     * while accepting any string at all. The scalar path gained this in RV13 P0-2; the field path
     * did not, which left the larger half of the surface untested on exactly the dimension the
     * literals were recorded for.
     */
    const outsideField = present ? outsideDomain(node?.literals) : undefined;
    if (outsideField !== undefined) {
      results.push({
        mutation: 'invalid-literal',
        argumentIndex: index,
        field: label(name),
        declared: true,
        ...observe(() => invoke(withFieldValue(path, outsideField))),
      });
    }

    const value = sampleObject[name];
    const armKinds = (node?.branches ?? [])
      .map((arm) => arm.kind)
      .filter((armKind): armKind is string => typeof armKind === 'string');
    const wrong =
      armKinds.length > 1
        ? wrongTypeOutsideArms(new Set(armKinds))
        : wrongTypeFor(node?.kind ?? (typeof value === 'number' ? 'numeric' : undefined));
    if (present && wrong !== undefined) {
      results.push({
        mutation: 'wrong-type',
        argumentIndex: index,
        field: label(name),
        ...(node !== undefined ? { declared: true } : {}),
        ...observe(() => invoke(withFieldValue(path, wrong))),
      });
    }
    if (present && typeof value === 'number') {
      results.push({
        mutation: 'non-finite',
        argumentIndex: index,
        field: label(name),
        ...observe(() => invoke(withFieldValue(path, Number.NaN))),
      });
    }

    // ---- recurse ----
    if (present && isPlainObject(value) && depth < MAX_PROBE_DEPTH) {
      results.push(
        ...probeObject(
          invoke,
          freshArguments,
          index,
          value,
          declaredMembersOf(node, value),
          limit,
          path,
          depth + 1,
          acceptsOmittedArguments,
        ),
      );
    }
  }
  return results;
}

/**
 * The measured verdict for a whole contract.
 *
 * A single accepted mutation makes the contract unenforced — enforcement is not a proportion. An
 * `omit-required` that is accepted on an OPTIONAL field is not a defect, so the caller filters by
 * declared optionality before asking for a summary.
 */
export function summarize(results: readonly ProbeResult[]): {
  enforced: boolean;
  accepted: ProbeResult[];
  untyped: ProbeResult[];
} {
  const accepted = results.filter((result) => result.verdict === 'accepted');
  const untyped = results.filter((result) => result.verdict === 'untyped');
  return { enforced: accepted.length === 0 && untyped.length === 0, accepted, untyped };
}
