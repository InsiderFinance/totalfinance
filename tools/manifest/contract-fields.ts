/**
 * Phase 3B.0-R7 — recursive contract fields, with TYPES.
 *
 * The inventory previously recorded a contract's fields as a flat list of NAMES, joined from the naming
 * baseline. That was enough to say "this contract has a `spot`" and nothing else — not whether `spot` is
 * required, what type it holds, whether it may be `null`, what an array's elements look like, or which
 * members a union admits.
 *
 * The cost of that was not cosmetic. Two of the four object mutations depend on requiredness and type:
 *
 *   omit-required — deleting an OPTIONAL field should succeed, so without requiredness the probe cannot
 *                   tell a defect from correct behaviour, and the result had to be recorded advisory.
 *   wrong-type    — needs to know the declared type to substitute a wrong one meaningfully.
 *
 * So half the mutation vocabulary could not convict, which is why `formatMoney` reads `unmeasured`
 * despite its unknown-key acceptance having been demonstrated by hand. This module supplies what was
 * missing, by asking the TypeScript checker rather than joining names.
 *
 * Determinism is a first-class requirement here, not an afterthought: an earlier traversal leaked
 * TypeScript's internal symbol ids (`__@iterator@14`) into identities and made the whole manifest
 * order-dependent. Fields are sorted, symbol-named members are dropped, recursion is depth-capped, and
 * cycles are cut by type identity.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = resolve(ROOT, 'packages');

/** How deep to expand nested contracts. Four covers request → nested object → array element → field. */
const MAX_DEPTH = 4;

/** What a field's declared type is, reduced to what a probe can act on. */
export type FieldKind =
  | 'numeric'
  | 'string'
  | 'boolean'
  | 'enum'
  | 'object'
  | 'array'
  | 'function'
  | 'other';

/** One callable parameter, resolved through aliases without parsing rendered function text. */
export interface CallableParameterNode {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
}

/** One overload of a callable type. Overload and parameter order are contractual. */
export interface CallableSignatureNode {
  parameters: CallableParameterNode[];
  returns: string;
  /** Generic arity/constraints are caller-visible even when no value parameter mentions them. */
  typeParameters?: Array<{ name: string; constraint?: string; default?: string }>;
  /** An explicit `this` parameter participates in assignability but not ordinary arity. */
  thisType?: string;
}

/**
 * Everything a node says about a TYPE, independent of the slot it fills.
 *
 * Split out of `FieldNode` because AN ARM OF A UNION IS A NODE WITHOUT A SLOT — that is the whole of
 * the correction. Unions were modelled as three parallel arrays (`branchTypes` for text,
 * `branchFields` for object members, `branchTuples` for positions), which can only describe an arm
 * insofar as it resembles an object or a tuple. Everything else about an arm — its own kind, its
 * literals, its element contract, its call signature, its return — had nowhere to live, so
 * `number | ArrayLike<number>` recorded no arms at all and the harness built one grammar and called
 * the boundary measured.
 *
 * `BranchNode` is this type. A field is this type plus a name and requiredness. That is why the
 * validator, the branch matcher and the builder can take an arm directly instead of the fabricated
 * stand-in `branchNode()` used to hand them.
 */
export interface TypeNode {
  /** The rendered declared type, `import()` paths normalized away. */
  type: string;
  kind: FieldKind;
  /** The union admits `null`. */
  nullable?: boolean;
  /**
   * The admitted values, when the type is a CLOSED PRIMITIVE DOMAIN.
   *
   * Strings, numbers and a singleton boolean alike — `LiteralValue`, not `string[]`. It held strings
   * only, which is why `order?: 1 | 2` and `{ calls: 1 | -1 }` published no domain at all while
   * `semanticArms` skipped their arms on the grounds that the values were "already recorded here".
   * Strings stay sorted; numbers keep declaration order. See `literalDomain`.
   */
  literals?: LiteralValue[];
  /** For `function`: the resolved arity and return type — what a stub needs, past any alias. */
  callSignature?: { parameters: number; returns: string };
  /** Every callable overload, with parameter type/optionality/rest semantics and return type. */
  callSignatures?: CallableSignatureNode[];
  /**
   * For `function` returning an object or array: the RETURN contract, walked. A stub answering
   * `undefined` where a record is declared just moves the failure one call later.
   */
  returns?: FieldNode;
  /** For `array`: the element contract. */
  element?: FieldNode;
  /** For `object`: the nested fields, sorted by name. */
  fields?: FieldNode[];
  /** True when expansion stopped at the depth cap — so a reader knows the tree is truncated, not flat. */
  truncated?: boolean;
  /**
   * For a FIXED-ARITY TUPLE: one node per position, in declaration order.
   *
   * Recorded from the CHECKER, which is the point. Everything downstream used to re-derive tuple
   * structure by parsing the rendered type text, and text loses what the checker never lost: a
   * splitter had to be taught top-level commas, then arrows, then quoted literals, then template
   * literals, and each lesson arrived as a defect — legal calls rejected (`[string | number, boolean]`
   * read as three positions) and malformed ones accepted (`[[42, 'wrong'], true]` checked only for
   * being an array). Rendering a type and re-parsing it is throwing information away and then paying
   * to guess it back.
   *
   * Absent when the tuple has a REST or VARIADIC element, because then arity is not the contract and
   * a per-position reading would be a different kind of wrong. Optional positions are recorded on the
   * node itself, so a reader can compute the legal arity RANGE rather than a single number.
   */
  tuple?: FieldNode[];
  /**
   * For a UNION OF TUPLES: each arm's positions, aligned index-for-index with `branchTypes`.
   *
   * `null` where an arm is not a fixed tuple, so the pairing survives and a reader can tell "this arm
   * has no positional contract" from "this arm was not recorded".
   */
  /**
   * EVERY ARM OF A UNION, as a complete node — the representation that replaces the three arrays.
   *
   * Recorded in DECLARATION ORDER, which is an invariant rather than a convenience: `path#n` names an
   * alternative by index, and 27 allowlisted residuals plus every published alternative id depend on
   * that order not moving.
   *
   * Written alongside `branchTypes`/`branchFields`/`branchTuples` while readers migrate. The three
   * arrays are what this replaces; they are not removed in the same commit that introduces it,
   * because an artifact that changes at the same moment as its readers cannot tell a translation bug
   * from an intended correction.
   */
  branches?: BranchNode[];
}

/**
 * A node in a NAMED SLOT: a field, a tuple position, a parameter.
 *
 * `name` and `optional` are the only things a slot adds. Everything else a node can say is on
 * `TypeNode`, which is what lets an arm be passed to the validator and the branch matcher directly.
 */
export interface FieldNode extends TypeNode {
  name: string;
  /** Declared with `?`, or a union including `undefined`. Decides whether omitting it is a defect. */
  optional: boolean;
}

/**
 * ONE ARM of a union — the same information as a field, minus the slot.
 *
 * An alias rather than a separate interface on purpose: every consumer that takes "a node" already
 * has the shape it needs, so migrating them is deleting an adapter rather than adding one.
 */
export type BranchNode = TypeNode;

const TYPE_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.WriteArrayAsGenericType |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

function renderType(checker: ts.TypeChecker, type: ts.Type): string {
  return checker
    .typeToString(type, undefined, TYPE_FLAGS)
    .replace(/import\("[^"]*"\)\./g, '')
    .split(ROOT)
    .join('');
}

/**
 * Every callable overload as compiler-owned structure.
 *
 * The old `{ parameters, returns }` pair was enough to build a crude stub and not enough to identify
 * a callback contract: `() => string` and `() => number` both fingerprinted `F/0`; optional and rest
 * parameters collapsed into the same count; later overloads did not exist. This descriptor retains
 * the legacy pair for synthesis while giving parity and inheritance a complete callable surface.
 */
export function callableSignatures(
  checker: ts.TypeChecker,
  type: ts.Type,
): CallableSignatureNode[] {
  const described: CallableSignatureNode[] = [];
  const seen = new Set<string>();
  for (const part of meaningfulParts(constrainedType(checker, type))) {
    for (const signature of checker.getSignaturesOfType(part, ts.SignatureKind.Call)) {
      const parameters = signature.getParameters().map((parameter) => {
        const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
        const parameterDeclaration =
          declaration && ts.isParameter(declaration) ? declaration : undefined;
        const parameterType = declaration
          ? checker.getTypeOfSymbolAtLocation(parameter, declaration)
          : checker.getTypeOfSymbol(parameter);
        return {
          name: parameter.name,
          type: renderType(checker, parameterType),
          optional:
            Boolean(parameter.flags & ts.SymbolFlags.Optional) ||
            Boolean(parameterDeclaration?.questionToken || parameterDeclaration?.initializer),
          rest: Boolean(parameterDeclaration?.dotDotDotToken),
        };
      });
      const typeParameters = signature.getTypeParameters()?.map((parameter) => {
        const constraint = parameter.getConstraint();
        const defaultType = parameter.getDefault();
        return {
          name: parameter.symbol?.name ?? renderType(checker, parameter),
          ...(constraint ? { constraint: renderType(checker, constraint) } : {}),
          ...(defaultType ? { default: renderType(checker, defaultType) } : {}),
        };
      });
      const thisParameter = signature.thisParameter;
      const thisDeclaration = thisParameter?.valueDeclaration ?? thisParameter?.declarations?.[0];
      const thisType = thisParameter
        ? renderType(
            checker,
            thisDeclaration
              ? checker.getTypeOfSymbolAtLocation(thisParameter, thisDeclaration)
              : checker.getTypeOfSymbol(thisParameter),
          )
        : undefined;
      const node: CallableSignatureNode = {
        parameters,
        returns: renderType(checker, signature.getReturnType()),
        ...(typeParameters && typeParameters.length > 0 ? { typeParameters } : {}),
        ...(thisType ? { thisType } : {}),
      };
      const key = JSON.stringify(node);
      if (seen.has(key)) continue;
      seen.add(key);
      described.push(node);
    }
  }
  return described;
}

/** The union members that are not `null`/`undefined`/`void`. */
function meaningfulParts(type: ts.Type): ts.Type[] {
  const parts = type.isUnion() ? type.types : [type];
  return parts.filter(
    (part) =>
      !(part.flags & ts.TypeFlags.Undefined) &&
      !(part.flags & ts.TypeFlags.Null) &&
      !(part.flags & ts.TypeFlags.Void),
  );
}

/**
 * The concrete shape promised by a constrained generic parameter.
 *
 * `T extends JSONPrimitive` is not opaque to a caller: every admissible `T` is inside that closed
 * union. Likewise `Metric extends GreekMetric` still has the Greek-metric literal domain. The
 * rendered declaration remains `T`; traversal uses the checker-owned base constraint so generated
 * contracts do not discard information merely because the declaration gave it a name.
 */
export function constrainedType(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  let current = type;
  const seen = new Set<ts.Type>();
  while (current.flags & ts.TypeFlags.TypeParameter) {
    if (seen.has(current)) break;
    seen.add(current);
    const constraint = checker.getBaseConstraintOfType(current);
    if (!constraint || constraint === current) break;
    current = constraint;
  }
  return current;
}

/**
 * The arms of a SEMANTIC union, or `null` when the type is not one.
 *
 * "Semantic" is doing real work here, and each exclusion is a claim about what a caller sees:
 *
 *   - `A | undefined` / `A | null` / `A | void` — one type in an optional slot. Nullishness belongs
 *     to the slot, and `optional`/`nullable` already record it.
 *   - `boolean` — the checker models it as `true | false`, and a caller passes ONE type. Recording
 *     two arms invented alternatives that no declaration offers: `addMonths(endOfMonth?: boolean)`
 *     acquired a presence gate AND two arms, and six realization residuals came from variants naming
 *     a value where the gate only decides presence.
 *   - a closed set of LITERALS — already recorded as `literals`. Arms would describe the same fact
 *     twice, and two descriptions of one fact is the condition this whole migration removes.
 *
 * Everything else with more than one constituent is a union whose arms must be recorded, whatever
 * the outer `kind` came out as. That last clause is the fix: arms used to be attached only inside
 * the `array` and `object` cases, so a union classified `numeric`, `string`, `function` or `other`
 * was recorded as an opaque type name — 340 occurrences across 320 records, 120 of them on rows
 * reporting `enforced`.
 */
export function semanticArms(type: ts.Type): ts.Type[] | null {
  const parts = meaningfulParts(type);
  if (parts.length <= 1) return null;
  if (parts.every((part) => Boolean(part.flags & ts.TypeFlags.BooleanLike))) return null;
  if (parts.every((part) => Boolean(part.flags & ts.TypeFlags.Literal))) return null;
  return parts;
}

function hasFlag(type: ts.Type, flag: ts.TypeFlags): boolean {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) => Boolean(part.flags & flag));
}

/** Every string literal in a union, sorted — the admitted enum values. */
function stringLiterals(type: ts.Type): string[] | null {
  const parts = meaningfulParts(type);
  if (parts.length === 0) return null;
  const literals: string[] = [];
  for (const part of parts) {
    if (part.isStringLiteral()) literals.push(part.value);
    else return null; // a mixed union is not an enum
  }
  return literals.length > 0 ? [...new Set(literals)].sort() : null;
}

/**
 * A CLOSED PRIMITIVE DOMAIN — the admitted values, whatever primitive they are.
 *
 * `semanticArms` declines to record arms for a literal-only union on the grounds that the values are
 * "already recorded as `literals`". That was only ever true of STRINGS: `stringLiterals` returns
 * `null` on the first non-string, so `order?: 1 | 2` and `{ calls: 1 | -1 }` got neither arms nor a
 * domain and reached the harness as a bare `number`. Sixteen nodes across nine records fell in that
 * hole, and the probe that exists to send an inadmissible value could not know there was a domain to
 * violate.
 *
 * The values keep their own type. `1` and `'1'` are different admissions, and flattening both to the
 * string "1" would make a numeric domain indistinguishable from a stringly one — every downstream
 * membership test, fingerprint and digest here compares the recorded values, so the distinction has
 * to survive the artifact.
 *
 * NUMERIC ORDER IS DECLARATION ORDER, not sorted. Strings are sorted because that predates this and
 * the artifact's bytes are compared exactly; imposing a sort on numbers would be a second convention
 * for no reason, and `2 | 1` is how the compiler renders the type it came from.
 *
 * A SINGLETON boolean literal is a domain (`version: true` admits one value). `boolean` itself is
 * not, and is excluded upstream: the checker models it as `true | false` and a caller passes one
 * type, which is the same reason `semanticArms` refuses it.
 */
export type LiteralValue = string | number | boolean;

export function literalDomain(type: ts.Type): LiteralValue[] | null {
  const strings = stringLiterals(type);
  if (strings) return strings;
  const parts = meaningfulParts(type);
  if (parts.length === 0) return null;
  // `true | false` is `boolean`, not a two-value domain.
  if (parts.length > 1 && parts.every((part) => Boolean(part.flags & ts.TypeFlags.BooleanLike))) {
    return null;
  }
  /**
   * A MIXED-PRIMITIVE domain is still a closed domain. `'auto' | 1` admits exactly two values.
   *
   * This returned `null` on the first part that was not a number or a boolean, so a union of a
   * string literal and a numeric one was recorded as neither a domain nor arms — `semanticArms`
   * also declines it, because every part IS a literal. The value fell through both halves of the
   * rule and reached the harness as an opaque type. Nothing on the surface declares one today, which
   * is exactly why it is worth closing now: a latent hole is one nobody is watching, and this pair of
   * functions has already shipped that mistake once with numbers.
   */
  const values: LiteralValue[] = [];
  for (const part of parts) {
    if (part.isNumberLiteral()) values.push(part.value);
    else if (part.isStringLiteral()) values.push(part.value);
    else if (part.flags & ts.TypeFlags.BooleanLiteral) {
      values.push(checkerIntrinsicName(part) === 'true');
    } else return null; // a non-literal part means the type is open, not a closed domain
  }
  if (values.length === 0) return null;
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `true` / `false` are distinguished only by the checker's intrinsic name. */
function checkerIntrinsicName(type: ts.Type): string {
  return (type as ts.Type & { intrinsicName?: string }).intrinsicName ?? '';
}

function classifyKind(checker: ts.TypeChecker, type: ts.Type): FieldKind {
  const parts = meaningfulParts(type);
  if (parts.length === 0) return 'other';
  if (stringLiterals(type)) return 'enum';
  if (
    parts.every((part) => Boolean(part.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)))
  )
    return 'numeric';
  if (
    parts.every((part) => Boolean(part.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)))
  )
    return 'string';
  if (
    parts.every((part) =>
      Boolean(part.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)),
    )
  )
    return 'boolean';
  if (parts.some((part) => isSequence(checker, part))) return 'array';
  if (parts.some((part) => checker.getSignaturesOfType(part, ts.SignatureKind.Call).length > 0))
    return 'function';
  /**
   * A BRANDED SCALAR is not an object. `type USD = number & { readonly __brand: unique symbol }` is a
   * number wearing a nominal tag: it is passed as `42`, and treating it as an object would have
   * synthesis build `{}` for it and probes mutate fields it does not have.
   *
   * Checked before the intersection-is-an-object rule, because that rule is the one that would claim
   * it. No public TotalFinance contract is a branded scalar today, so this is hardening rather than a live
   * defect — but the rule it guards was introduced one commit ago and would have been silently wrong
   * the first time someone reached for the pattern.
   */
  if (
    parts.some((part) => Boolean(part.flags & ts.TypeFlags.Intersection)) &&
    parts.some((part) =>
      ((part as ts.IntersectionType).types ?? []).some((member) =>
        Boolean(member.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)),
      ),
    )
  )
    return 'numeric';
  if (
    parts.some((part) => Boolean(part.flags & ts.TypeFlags.Intersection)) &&
    parts.some((part) =>
      ((part as ts.IntersectionType).types ?? []).some((member) =>
        Boolean(member.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)),
      ),
    )
  )
    return 'string';
  /**
   * An INTERSECTION is an object too, and not saying so cost 115 contracts their fields.
   *
   * `meaningfulParts` splits unions only, so `BarrierInput & { type; barrierType }` arrives whole,
   * and an intersection carries `TypeFlags.Intersection` — never `Object`. Every test above is a
   * flag check, so it matched none of them and fell through to `other`. The damage was silent and
   * one-sided: `getPropertiesOfType` merges intersection members correctly, so the walk COULD see
   * all nine of barrier's fields, but the kind said "not an object" and the recorded contract kept
   * the seven it inherited from `BarrierInput` while dropping the two declared inline.
   *
   * That is worse than a missing contract, because the partial one looks complete. Anything deriving
   * an allowed-key list from the record — which is exactly what closing these boundaries under Law 12
   * requires — would have rejected `type` and `barrierType` as unknown keys, refusing valid calls to
   * fix a permissiveness defect.
   */
  if (
    parts.every((part) => Boolean(part.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)))
  )
    return 'object';
  /**
   * A union MIXING scalars still admits every scalar in it.
   *
   * The tests above are all `every`, so `'annual' | 'semiannual' | … | number` — which is exactly how
   * `Frequency` is declared — matched none of them and fell through to `other`. Nothing downstream can
   * build an `other`, so the field was dropped from the request and `bonds.fixedRate` answered
   * "frequency is required. e.g. frequency: 2 (coupons per year)".
   *
   * A union containing `number` accepts any number, and one containing `string` accepts any string, so
   * naming the widest member is both sound and enough. It is deliberately checked LAST: `enum` and the
   * homogeneous kinds carry more information, and a probe reads them to decide what an invalid value
   * would even be. This says only "a scalar of this sort will be accepted", which is all synthesis
   * needs and less than a probe may assume.
   */
  if (parts.some((part) => Boolean(part.flags & ts.TypeFlags.Number))) return 'numeric';
  if (parts.some((part) => Boolean(part.flags & ts.TypeFlags.String))) return 'string';
  return 'other';
}

/** Members worth recording: string-named, declared in this repo, not compiler internals. */
function members(checker: ts.TypeChecker, type: ts.Type): ts.Symbol[] {
  return checker
    .getPropertiesOfType(type)
    .filter((property) => !property.name.startsWith('__@'))
    .filter((property) => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      // A member with no declaration, or one from lib.*.d.ts, is not part of this contract.
      return (
        declaration !== undefined &&
        !declaration.getSourceFile().fileName.includes('/typescript/lib/')
      );
    });
}

/**
 * The sequence types `isArrayLikeType` does not answer for.
 *
 * It reports true for `T[]`, `ReadonlyArray<T>` and tuples, and false for `ArrayLike<T>` — which this
 * library uses throughout its numeric surface, precisely because it is the widest thing that accepts a
 * plain array and a typed array alike. Falling through left `history: ArrayLike<number>` classified as
 * an OBJECT whose only member (`length`) is a lib declaration and therefore dropped, so it synthesized
 * to `{}` and six boundaries reported the result verbatim: "history must be an array, got object."
 *
 * The typed arrays are here for the same reason and were the same defect one package over —
 * `cols.spot must be an array, got number`.
 */
const SEQUENCE_TYPES = new Set([
  'ArrayLike',
  'Iterable',
  'ReadonlyArray',
  'Array',
  'Float64Array',
  'Float32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Uint8ClampedArray',
  'BigInt64Array',
  'BigUint64Array',
]);

function isSequence(checker: ts.TypeChecker, type: ts.Type): boolean {
  /**
   * `isArrayLikeType` answers true for top/bottom and string-like types (`any`, `never`, `string`).
   * That is useful to assignability and wrong for a contract grammar: callers do not pass `never`
   * as an array, and an `any`-typed method is not evidence of an element contract. Without this guard
   * those nodes were published as `kind: 'array', truncated: true` at the depth cap.
   */
  if (
    type.flags &
    (ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.Never |
      ts.TypeFlags.Any |
      ts.TypeFlags.Unknown |
      ts.TypeFlags.Void |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Null)
  ) {
    return false;
  }
  if (checker.isArrayLikeType(type)) return true;
  const name = (type.aliasSymbol ?? type.getSymbol())?.name;
  return name !== undefined && SEQUENCE_TYPES.has(name);
}

/** The element type of an array-like type, if any. */
export function elementTypeOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  for (const part of meaningfulParts(constrainedType(checker, type))) {
    if (!isSequence(checker, part)) continue;
    /**
     * A typed array's first type argument is its BUFFER, not its element.
     *
     * `Float64Array<ArrayBufferLike>` reads like `Array<T>` and is not: taking `args[0]` yielded
     * `ArrayBufferLike`, so `spot` was built as sixty ArrayBuffer-shaped objects and the batch API
     * reported "spot at row 0 must be a positive finite number, got [object Object]" — a worse answer
     * than the scalar it replaced. The number index signature is the element for every typed array.
     */
    const name = (part.aliasSymbol ?? part.getSymbol())?.name;
    if (
      name !== undefined &&
      name !== 'Array' &&
      name.endsWith('Array') &&
      name !== 'ReadonlyArray'
    ) {
      const indexed = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
      if (indexed) return indexed;
    }
    const asReference = part as ts.TypeReference;
    const args = checker.getTypeArguments(asReference);
    if (args.length > 0) return args[0]!;
    const numberIndex = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
    if (numberIndex) return numberIndex;
  }
  return null;
}

/**
 * A fixed-arity tuple's element types, from the checker — or `null` for anything else.
 *
 * `null` covers "not a tuple" and "a tuple whose arity is not fixed" alike: both mean the same thing
 * to a reader, which is that position and count are not the contract here.
 */
export function tupleElementTypes(
  checker: ts.TypeChecker,
  type: ts.Type,
): { type: ts.Type; optional: boolean }[] | null {
  /**
   * Optionality belongs to the SLOT, not to the tuple shape.
   *
   * A field such as `bounds?: readonly [number, number]` arrives as
   * `readonly [number, number] | undefined`. Inspecting the union wrapper's object flags made a real
   * fixed tuple look like an ordinary array, so the manifest published one numeric element instead
   * of two required positions. Strip nullish members before asking the checker about tuple metadata.
   */
  const parts = meaningfulParts(constrainedType(checker, type));
  if (parts.length !== 1) return null;
  const tupleType = parts[0]!;
  if (!hasFlag(tupleType, ts.TypeFlags.Object)) return null;
  const object = tupleType as ts.ObjectType;
  if ((object.objectFlags & ts.ObjectFlags.Reference) === 0) return null;
  const target = (tupleType as ts.TypeReference).target as ts.TupleType;
  if ((target.objectFlags & ts.ObjectFlags.Tuple) === 0) return null;
  const flags = target.elementFlags ?? [];
  // A rest or variadic element makes the length open; arity stops being a fact about the contract.
  if (flags.some((flag) => (flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0)) {
    return null;
  }
  const args = checker.getTypeArguments(tupleType as ts.TypeReference);
  if (args.length === 0) return null;
  return args.map((argument, index) => ({
    type: argument,
    optional: ((flags[index] ?? 0) & ts.ElementFlags.Optional) !== 0,
  }));
}

/**
 * One arm of a union as a COMPLETE node — the slot-free walk `BranchNode` exists for.
 *
 * Built by walking the arm exactly as a field is walked and then dropping the slot, so an arm carries
 * its own kind, literals, fields, element, tuple positions, call signature and return contract rather
 * than only the facets the three parallel arrays could express.
 *
 * Emitted alongside those arrays, and under the SAME conditions they are emitted under. Widening
 * WHICH unions get recorded is a separate change with a real artifact diff; doing both at once would
 * make a translation bug and an intended correction indistinguishable in that diff.
 */
export function armNodes(
  checker: ts.TypeChecker,
  parts: readonly ts.Type[],
  depth: number,
  seen: ReadonlySet<ts.Type>,
): BranchNode[] {
  return parts.map((part) => {
    /**
     * AN ARM IS WALKED AT THE UNION'S OWN DEPTH, not one below it.
     *
     * `A | B` and its two arms are one node described three ways; the arms are not children of the
     * union, and charging them a level of the depth budget is charging for a step nobody took. It
     * cost exactly that: 80 arms of NAMED object types — `Greeks`, `ExtendedGreeks`,
     * `IndicatorNumberOutput`, `{ kind: 'power-law'; eta; gamma }` — came back `truncated` with no
     * fields at all, because the cap fired on the arm itself. Their members then walk at `depth + 1`,
     * which is the level they actually occupy.
     *
     * The visible symptom was 36 alternatives disappearing whenever the readers preferred `branches`
     * over the legacy arrays — read at first as the per-arm walk being inherently weaker than the old
     * whole-union expansion. It was not weaker. It was being stopped a level early.
     */
    const walked = walkField(checker, '', part, false, depth, seen);
    const { name: _name, optional: _optional, ...arm } = walked;
    return arm;
  });
}

/**
 * Walk an arbitrary type into a field tree, for a caller holding its OWN checker.
 *
 * `contractFieldTrees()` indexes trees by DECLARATION identity, which an anonymous intersection does
 * not have — `BarrierInput & { type; barrierType }` borrowed `BarrierInput`'s tree and silently lost
 * the members declared inline. The fix cannot be another walker: two implementations of "what fields
 * does this type have" is precisely how the same declaration gets two answers depending on where it
 * is asked, which `signature-inventory.ts` already warns about one level up. So the walk is exported
 * and shared; only the checker differs.
 */
export function fieldTreeForType(checker: ts.TypeChecker, type: ts.Type): FieldNode[] {
  return members(checker, type)
    .map((symbol) => {
      const declared = checker.getTypeOfSymbolAtLocation(
        symbol,
        symbol.valueDeclaration ?? (symbol.declarations?.[0] as ts.Node),
      );
      return walkField(
        checker,
        symbol.name,
        declared,
        Boolean(symbol.flags & ts.SymbolFlags.Optional),
        1,
        new Set([type]),
      );
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function walkField(
  checker: ts.TypeChecker,
  name: string,
  type: ts.Type,
  optional: boolean,
  depth: number,
  seen: ReadonlySet<ts.Type>,
): FieldNode {
  const declaredType = type;
  type = constrainedType(checker, type);
  const kind = classifyKind(checker, type);
  let callableReturn: ts.Type | undefined;
  const node: FieldNode = {
    name,
    type: renderType(checker, declaredType),
    kind,
    // A union including `undefined` is optional even without a `?`, which is how several request types
    // express "you may leave this out".
    optional: optional || hasFlag(declaredType, ts.TypeFlags.Undefined),
    nullable: hasFlag(declaredType, ts.TypeFlags.Null),
  };

  const literals = literalDomain(type);
  if (literals) node.literals = literals;

  /**
   * Stop an exact type cycle at the node where it re-enters the ancestor path.
   *
   * The object-only cycle check below compares the first meaningful arm, so a recursive UNION such
   * as `IndicatorOutputValue` was expanded again before any arm happened to notice. The artifact
   * then published four independently `truncated` descendants beneath a place where the checker had
   * already stopped. A cycle is a fact about the original type, not about whichever object arm is
   * expanded first.
   */
  if (seen.has(type) && (kind === 'object' || kind === 'array')) {
    node.truncated = true;
    return node;
  }

  /**
   * A callable FIELD records its resolved signature for the same reason a callable parameter does:
   * `RandomNumberGenerator.next` is declared as a method, and a stub builder reading the rendered
   * text has nothing to go on. Without it the object was built without `next` and the library said
   * so — "randomNumberGenerator.next is not a function".
   */
  if (kind === 'function') {
    const signatures = callableSignatures(checker, type);
    if (signatures.length > 0) {
      node.callSignatures = signatures;
      node.callSignature = {
        parameters: signatures[0]!.parameters.length,
        returns: signatures[0]!.returns,
      };
    }
    for (const part of meaningfulParts(type)) {
      const signature = checker.getSignaturesOfType(part, ts.SignatureKind.Call)[0];
      if (!signature) continue;
      const returnType = signature.getReturnType();
      const returnKind = classifyKind(checker, returnType);
      if (returnKind === 'object' || returnKind === 'array') {
        callableReturn = returnType;
      }
      break;
    }
  }

  /**
   * ARMS FIRST, and independent of `kind`.
   *
   * `kind` answers "what does a caller pass, and what can synthesis build?"; the arms answer "what
   * are this declaration's alternatives?". Attaching the second inside the answer to the first is
   * how a union that reads as a number, a string or a callback came to have no alternatives at all.
   */
  const arms = semanticArms(type);
  if (arms) node.branches = armNodes(checker, arms, depth, new Set([...seen, type]));

  if (depth >= MAX_DEPTH) {
    if (kind === 'object' || kind === 'array') node.truncated = true;
    return node;
  }

  /**
   * The RETURN CONTRACT, walked like any other CHILD and therefore subject to the same depth cap.
   *
   * This used to run before the cap above. A callback at depth four therefore expanded its return at
   * depth five, which could expand another callback at six, and the manifest published 190
   * `truncated` descendants that the independently bounded checker never visited. The artifact then
   * authorised those claims itself. Recording the signature is local and still happens above;
   * expanding the returned value costs one level and happens only while that level exists.
   */
  if (kind === 'function') {
    if (callableReturn) {
      node.returns = walkField(checker, '()', callableReturn, false, depth + 1, seen);
    }
    /**
     * Callable interfaces can also expose properties and methods.
     *
     * `Indicator` is both invokable and owns `stream`, `fromJSON`, `explain`, and metadata. Returning
     * immediately after recording its call signature erased that entire protocol, including nested
     * callback contracts. Expand the callable constituent's repo-declared members under the same
     * depth/cycle budget; an ordinary function has none and costs nothing.
     */
    const callablePart = meaningfulParts(type).find(
      (part) => checker.getSignaturesOfType(part, ts.SignatureKind.Call).length > 0,
    );
    if (callablePart && !seen.has(callablePart)) {
      const nested = members(checker, callablePart);
      if (nested.length > 0) {
        const next = new Set([...seen, callablePart]);
        node.fields = nested
          .map((property) => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            const propertyType = declaration
              ? checker.getTypeOfSymbolAtLocation(property, declaration)
              : checker.getTypeOfSymbol(property);
            return walkField(
              checker,
              property.name,
              propertyType,
              Boolean(property.flags & ts.SymbolFlags.Optional),
              depth + 1,
              next,
            );
          })
          .sort((left, right) => left.name.localeCompare(right.name));
      }
    }
    return node;
  }

  if (kind === 'array') {
    const element = elementTypeOf(checker, type);
    /**
     * `seen` passes through UNCHANGED. Adding the element here and then recursing into that same
     * element made the cycle guard fire on the very node it was meant to protect: the object branch
     * below asks `seen.has(target)`, found the type its own caller had just inserted, and marked it
     * truncated. 405 of 411 array-of-object elements in the workspace were recorded as having no
     * fields — not because the contract was empty but because nothing ever looked.
     *
     * Synthesis then read "no fields" as "empty contract", which is the reading that is right for a
     * genuinely keyless options bag and catastrophically wrong here: `microprice` got a book of sixty
     * empty levels and answered "book.bids[0].price is required."
     *
     * The object branch already does this correctly — it adds `target` to the set it passes to its
     * CHILDREN, not to itself. A self-referential element is still caught, one level down, by that.
     */
    /**
     * A TUPLE is recorded position by position, and an ARRAY by its element. Both, where both apply:
     * `element` keeps every existing reader working, `tuple` is what lets a reader that cares about
     * position stop parsing text to find one.
     */
    /**
     * The ARRAY adds ITSELF to the set it passes to its children — the same discipline the object
     * branch applies ("adds `target` to the set it passes to its CHILDREN, not to itself"), and the
     * same cycle rule the parity walk derives independently ("the types on the PATH TO HERE").
     *
     * Without this, a type recursive THROUGH an array — `ValidationFieldSpecification.fields?:
     * readonly ValidationFieldSpecification[]`, the library's first such public parameter — put
     * only the OBJECT on the path, so the recurring inner array expanded one generation past the
     * checker's frontier and truncated at its element instead. Six routes claimed truncation where
     * the independent walk still had budget, which is exactly the ghost-marker class RV31 closed.
     * The element itself is still NOT pre-inserted, preserving the 405-of-411 lesson above.
     */
    const throughArray = new Set([...seen, type]);
    const positions = tupleElementTypes(checker, type);
    if (positions) {
      node.tuple = positions.map((position, index) =>
        walkField(
          checker,
          String(index),
          position.type,
          position.optional,
          depth + 1,
          throughArray,
        ),
      );
    } else {
      /**
       * A UNION OF TUPLES is a union first — `[number] | [number, number, number, number]` is one
       * declaration with two legal arities. Recorded arm by arm, because the alternative is reading
       * the rendered text, and that text starts with `[` and ends with `]`: it was parsed as a SINGLE
       * four-position tuple, and the legal one-element call was rejected as having the wrong arity.
       */
      const parts = meaningfulParts(type);
      /**
       * Nothing to do here any more: a union of tuples is a union, and its arms are attached
       * generically at the top of this walk along with every other union's. The tuple-specific
       * expansion that stood here described an arm only insofar as it was a list of positions, which
       * is the partial representation this migration removed.
       */
      void parts;
    }
    if (element) {
      node.element = walkField(checker, '[]', element, false, depth + 1, throughArray);
    }
    return node;
  }

  if (kind === 'object') {
    const parts = meaningfulParts(type);
    /**
     * A DISCRIMINATED UNION is recorded as one branch, and now SAYS so.
     *
     * `meaningfulParts(type)[0]` has always taken the first branch and expanded only that. That is a
     * defensible thing to do and was an indefensible thing to leave unsaid: the artifact presented
     * `{ gaussian: … } | { returns: … }` as a single shape with one set of fields, so a reader — or
     * 3B.1 writing per-field policy off this artifact — could not tell a plain object from one branch
     * of an alternative. An incomplete contract that does not admit it is worse than a missing one.
     *
     * Deliberately a LABEL rather than a full expansion. Recording every branch would change what
     * `fields` means for every consumer, and nothing currently needs it: synthesis builds the first
     * branch, the first branch is a valid input, and no boundary in the measured set fails for want
     * of a second. If one ever does, the retry that walks `FIELD_ALTERNATIVES` is where branches
     * belong too.
     */

    /** Expand ONE branch of a union into its declared members. */
    const expand = (target: ts.Type): FieldNode[] | null => {
      if (seen.has(target)) return null;
      const nested = members(checker, target);
      if (nested.length === 0) return null;
      const next = new Set([...seen, target]);
      return (
        nested
          .map((property) => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            const propertyType = declaration
              ? checker.getTypeOfSymbolAtLocation(property, declaration)
              : checker.getTypeOfSymbol(property);
            return walkField(
              checker,
              property.name,
              propertyType,
              Boolean(property.flags & ts.SymbolFlags.Optional),
              depth + 1,
              next,
            );
          })
          // Sorted, so the artifact diffs cleanly and generation is order-independent.
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      );
    };

    const target = parts[0];
    if (!target || seen.has(target)) {
      node.truncated = true;
      return node;
    }
    const expanded = expand(target);
    if (expanded) node.fields = expanded;

    /**
     * EVERY branch, not merely a label saying there are several.
     *
     * `branches` recorded that a union existed and `fields` expanded the first one, which is a
     * reasonable default and an incomplete contract: `{ gaussian: … } | { returns: … }` has two ways
     * to be satisfied and the artifact described one. A boundary whose first branch the harness
     * cannot build was recorded as unmeasurable when the second branch might have been trivial.
     *
     * Recorded as a LIST so the retry mechanism can walk it: a union branch is exactly the same kind
     * of thing as a curated alternative in `FIELD_ALTERNATIVES` — another admissible input to try when
     * the contract refuses the first — and reusing `attempt` means it costs nothing on a healthy pass.
     */
    /**
     * The arms were recorded above by `armNodes`, which walks each one the way any node is walked.
     * A second, shallower expansion here (`parts.map(expand)`) is exactly the duplicate
     * representation this migration removes: two answers to "what are this union's arms", differing
     * only in how much of each arm they could describe.
     */
  }
  return node;
}

/**
 * Build the field tree for every named public contract, keyed `<package>:<TypeName>`.
 *
 * Keyed on the BARE type name, so a generic instantiation (`Columns<Bar>`) joins to the same tree as its
 * head — the probe cares about the fields, and the full instantiation is already recorded on the
 * parameter itself.
 */
/**
 * Trees indexed by `<package>:<TypeName>` — and the same key can name DIFFERENT types.
 *
 * `@totalfinance/technical-analysis` and the umbrella both publish a `PeriodParameters`, and they differ
 * in whether `period` is required. First-one-wins handed the umbrella paths a tree the leaf paths did
 * not get, and the SAME runtime function then earned opposite verdicts through different import
 * paths: `@totalfinance/technical-analysis:atr` enforced, `totalfinance:atr` defective on `omit-required`.
 * Ten type names collide this way.
 *
 * An arbitrary winner is the one outcome that must not happen, because it produces a confident wrong
 * verdict rather than a missing one. So a key with more than one distinct shape yields NO tree: the
 * paths that use it fall back to the weaker synthesis and stay honest. Coverage is the right thing to
 * spend here — the same trade the baseline-must-succeed rule makes.
 */
export function contractFieldTrees(): Map<string, FieldNode[]> {
  /**
   * EVERY entrypoint's declarations, not just the root index.
   *
   * Reading only `dist/index.d.ts` missed every contract published through a deep entrypoint —
   * `@totalfinance/options:CompareEnginesInput` among them — so the parameter that names it had no
   * declared shape and synthesis could not build it. The deep entrypoints are a design law here
   * (consumers are meant to import them), so their contracts are public contracts.
   */
  const entries: string[] = [];
  const packageOf = new Map<string, string>();
  for (const dir of readdirSync(PACKAGES).sort()) {
    const packageName = dir === 'totalfinance' ? 'totalfinance' : `@totalfinance/${dir}`;
    let manifest: { exports?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(resolve(PACKAGES, dir, 'package.json'), 'utf8')) as {
        exports?: Record<string, unknown>;
      };
    } catch {
      continue;
    }
    const targets = new Set<string>();
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      if (key === './package.json') continue;
      const target =
        typeof value === 'string'
          ? value
          : ((value as Record<string, string>)['types'] ??
            (value as Record<string, string>)['import'] ??
            (value as Record<string, string>)['default']);
      if (!target) continue;
      targets.add(target.replace(/\.js$/, '.d.ts'));
    }
    targets.add('./dist/index.d.ts');
    for (const target of [...targets].sort()) {
      const path = resolve(PACKAGES, dir, target.replace(/^\.\//, ''));
      if (!existsSync(path)) continue;
      entries.push(path);
      packageOf.set(path, packageName);
    }
  }
  const program = ts.createProgram(entries, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  });
  const checker = program.getTypeChecker();
  const out = new Map<string, FieldNode[]>();
  /** key -> every distinct shape seen for it, so collisions can be dropped rather than guessed. */
  const shapesByKey = new Map<string, Map<string, FieldNode[]>>();
  const recordDeclaration = (
    declarationId: string | null,
    key: string,
    nodes: FieldNode[],
  ): void => {
    // The DECLARATION index is exact: two same-named types have two declarations, so nothing collides.
    if (declarationId !== null && !byDeclaration.has(declarationId)) {
      byDeclaration.set(declarationId, nodes);
    }
    const shapes = shapesByKey.get(key) ?? new Map<string, FieldNode[]>();
    shapes.set(JSON.stringify(nodes), nodes);
    shapesByKey.set(key, shapes);
  };

  /** Declaration identity -> tree, the unambiguous index (R10). */
  const byDeclaration = new Map<string, FieldNode[]>();

  for (const entry of entries) {
    const pkg = packageOf.get(entry)!;
    const source = program.getSourceFile(entry);
    const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const key = `${pkg}:${exported.name}`;
      // Collect ALL shapes reachable under this key; ambiguity is resolved after the walk.
      // NOT skipped on first sight: every declaration under this key must be compared.
      const original =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      // Only TYPES carry a contract shape; a function export's shape is its parameters, recorded
      // separately by the signature inventory.
      if (!(original.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) continue;
      const declared = checker.getDeclaredTypeOfSymbol(original);
      const properties = members(checker, declared);
      if (properties.length === 0) continue;
      const seen = new Set<ts.Type>([declared]);
      const declarationFile = (original.declarations?.[0]?.getSourceFile().fileName ?? '').includes(
        '/packages/',
      )
        ? `packages/${(original.declarations?.[0]?.getSourceFile().fileName ?? '').split('/packages/')[1]}`
        : (original.declarations?.[0]?.getSourceFile().fileName ?? '');
      recordDeclaration(
        declarationFile === '' ? null : `${declarationFile}#${original.name}`,
        key,
        properties
          .map((property) => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            const propertyType = declaration
              ? checker.getTypeOfSymbolAtLocation(property, declaration)
              : checker.getTypeOfSymbol(property);
            return walkField(
              checker,
              property.name,
              propertyType,
              Boolean(property.flags & ts.SymbolFlags.Optional),
              1,
              seen,
            );
          })
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      );
    }
  }
  /**
   * Only unambiguous names survive — checked GLOBALLY, by bare type name, not per package.
   *
   * Per-package was not enough, and the reason is a real library defect rather than a tooling one:
   * `@totalfinance/technical-analysis` declares FIVE different `PeriodParameters` interfaces in five
   * modules, and they disagree about the contract — `bars.ts` (which ATR uses) makes `period`
   * OPTIONAL while `moving-averages.ts` and `momentum-ext.ts` make it REQUIRED. The umbrella
   * re-exports exactly one of them, so `totalfinance:PeriodParameters` looked unambiguous while naming a
   * different contract than the callable actually takes. The same `atr` function then measured
   * `enforced` through `@totalfinance/technical-analysis` and `defective` through `totalfinance`, on an
   * `omit-required` for a field its own declaration marks optional.
   *
   * Until contract identity is the resolved declaration symbol rather than package-plus-rendered-name
   * (the identity repair this inventory still owes), a name that means two things anywhere means
   * nothing here. Dropping it costs coverage; keeping it produced a confident wrong verdict.
   */
  /**
   * The name index still drops homonyms — but it is now the FALLBACK, not the join.
   *
   * A parameter that carries a declaration identity resolves exactly (R10) and never reaches this. A
   * parameter without one (an inline or structural type) still joins by name, and there the old
   * hazard is unchanged: a name meaning two things cannot say which was meant. So the drop stays,
   * and it now costs almost nothing.
   */
  const shapesByBareName = new Map<string, Set<string>>();
  for (const [key, shapes] of shapesByKey) {
    const bare = key.slice(key.indexOf(':') + 1);
    const set = shapesByBareName.get(bare) ?? new Set<string>();
    for (const shape of shapes.keys()) set.add(shape);
    shapesByBareName.set(bare, set);
  }
  for (const [key, shapes] of shapesByKey) {
    const bare = key.slice(key.indexOf(':') + 1);
    if (shapes.size === 1 && (shapesByBareName.get(bare)?.size ?? 0) === 1) {
      out.set(key, [...shapes.values()][0]!);
    }
  }
  // The declaration index is merged in LAST and never dropped for ambiguity: it cannot be ambiguous.
  for (const [declarationId, nodes] of byDeclaration) out.set(declarationId, nodes);
  return out;
}
