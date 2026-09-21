/**
 * Phase 3B.0 — the public CONTRACT-identity graph.
 *
 * The signature inventory (`public-signatures.json`) answers "what public paths exist and what do
 * their declarations look like." This answers the question Phase 3B is actually about: for each of
 * those paths, WHICH CONTRACT does it accept, which does it return, and WHAT ENFORCES the accepted
 * one at runtime. A good declaration that masks a runtime no-op or a missing-field `NaN` is invisible
 * to a declaration inventory and visible here.
 *
 * The spec (`docs/specs/phase-3b-runtime-semantic-closeout.md`, "Scope model") requires four
 * identities kept separate, because collapsing them produces two different misleading numbers — 3,313
 * paths overstates the work, and a deduplicated count understates the surface:
 *
 *   1. PUBLIC PATH identity      — every import/namespace/member path a user can call.
 *   2. IMPLEMENTATION identity   — aliases that resolve to one callable (`<file>#<nameChain>`).
 *   3. CONTRACT identity         — the unique input or result type plus its runtime policy.
 *   4. VALIDATOR identity        — the guard/schema/boundary that enforces that contract.
 *
 * Generated artifacts discover STRUCTURE. Per the spec they "may not invent units, financial meaning,
 * safe defaults, or a rationale for an API decision" — so this file records which guards a body calls
 * and never asserts that they are sufficient. Whether a contract is adequately enforced is a curated
 * judgment; the C20 exception policy in `contract-policy.ts` holds those, with a rationale each.
 *
 * Regenerate with `pnpm contract:update`; `tools/manifest/contract-conformance.test.ts` fails on
 * drift and on non-determinism.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOUNDARY_INPUT_POLICIES,
  CONTRACT_EXCEPTIONS,
  POSITIONAL_MATH_PATHS,
  boundaryKindOf,
  type BoundaryKind,
} from './contract-policy.js';
import {
  indexFunctions,
  resolveGuardReachability,
  type GuardReachability,
} from './contract-guards.js';
import {
  contractFieldTrees,
  type BranchNode,
  type CallableSignatureNode,
  type FieldNode,
  type LiteralValue,
} from './contract-fields.js';
import { nameabilityFindings, type NameabilityFinding } from './contract-nameability.js';
import { readManifest } from './generate.js';
import { packageEntrypoints } from './inventory.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SIGNATURES = resolve(ROOT, 'tools/manifest/public-signatures.json');
const OUTPUT = resolve(ROOT, 'tools/manifest/public-contracts.json');

/** One parameter as the signature inventory recorded it. */
/**
 * The shape this module READS out of `public-signatures.json`.
 *
 * A structural echo of `signature-inventory.ts`'s `SignatureParameter`, not an import: this module
 * consumes the generated artifact rather than the generator. That means a producer-side field is
 * invisible here until it is added — which is how `fieldTree` below silently did nothing on its
 * first pass, typed away rather than read.
 */
interface SignatureParameter {
  name: string;
  type: string;
  /** `<source file>#<Name>` for the declared type — the exact join key (R10). */
  typeDeclaration?: string;
  /** Attached by the generator when the type has no single declaration to look a tree up by. */
  fieldTree?: FieldNode[];
  /**
   * One tree per union branch, attached by the generator for a root union of object shapes.
   *
   * This interface is a STRUCTURAL ECHO of `signature-inventory.ts`'s `SignatureParameter` rather
   * than an import, so a field added there must be added here too or the read below does not compile
   * — which is exactly what happened: `branchFields` was declared on the OUTPUT type
   * (`ContractParameter`) and read off the INPUT type, and the mistake reached a pushed commit
   * because I read a verification run that had printed "lint OK" and "api:check OK" and did not
   * notice that "typecheck OK" was absent. A missing line is harder to see than a wrong one.
   */
  /** Every arm as a complete node — see `SignatureParameter.branches`, which this echoes. */
  branches?: BranchNode[];
  /** The element / tuple positions as complete nodes — see the same names on the producer side. */
  element?: FieldNode;
  tuple?: FieldNode[];
  /** Members read from this exact parameter instantiation, before generic declaration fallback. */
  checkerFieldTree?: FieldNode[];
  /** The declared closed set, when the type resolves to a union of string literals. */
  literals?: LiteralValue[];
  /** For a callable parameter: the resolved arity and return type, past any alias. */
  callSignature?: { parameters: number; returns: string };
  /** Every callable overload and its parameter/return semantics. */
  callSignatures?: CallableSignatureNode[];
  /** The first callable overload's return value as a walkable contract. */
  returns?: FieldNode;
  /** An inferred generic binder, not a type consumers need to import. */
  inferredGeneric?: true;
  /** Its generic arguments specialize the declaration tree. */
  instantiatedGeneric?: true;
  optional: boolean;
  rest: boolean;
  kind: string;
}

interface PublicCallable {
  id: string;
  package: string;
  path: string;
  owner: string;
  entrypoints: string[];
  role?: string;
  implementation: string;
  grammar: string;
  signatures: { parameters: SignatureParameter[]; returns: string }[];
}

/** How the accepted input is shaped — which determines what enforcement even applies. */
export type InputShape =
  /** A named or inline object request: the closed/open key policy applies. */
  | 'object-request'
  /** A leading series/array plus an optional object of options. */
  | 'series-options'
  /** A leading subject plus an optional object of options. */
  | 'subject-options'
  /** Positional scalars only — conventional mathematics, no object contract to enforce. */
  | 'positional-scalars'
  /** Typed-array columns (the batch architecture); validated per-call, never per row. */
  | 'columnar'
  /** No parameters. */
  | 'nullary';

/** One parameter, with the contract identity of its own declared type. */
export interface ContractParameter {
  name: string;
  /** The declared type text, generic arguments intact. */
  type: string;
  /** Contract identity for this parameter's type, when it has one. */
  contract: string | null;
  /** The declared closed set of string literals, when the type resolves to one. */
  literals?: LiteralValue[];
  /** For a callable parameter: the resolved arity and return type, past any alias. */
  callSignature?: { parameters: number; returns: string };
  /** Every callable overload and its parameter/return semantics. */
  callSignatures?: CallableSignatureNode[];
  /** The first callable overload's return value as a walkable contract. */
  returns?: FieldNode;
  /** An inferred generic binder, not a type consumers need to import. */
  inferredGeneric?: true;
  /** Its generic arguments specialize the declaration tree. */
  instantiatedGeneric?: true;
  /** For a labelled TUPLE parameter: the contract identity of each element, in order. */
  tupleContracts?: (string | null)[];
  /** For a labelled TUPLE parameter: each element's declared field tree, in order. */
  tupleFieldTrees?: (FieldNode[] | null)[];
  optional: boolean;
  rest: boolean;
  /** The signature inventory's kind: numeric | primitive | series | object | callback | other. */
  kind: string;
  /**
   * The RECURSIVE contract of this parameter: every field with its type, requiredness, nullability,
   * enum members, array element and nesting (R7).
   *
   * This replaced a flat list of field NAMES. Names could not tell the probe whether omitting a field
   * should fail or what a wrong type would even be, so `omit-required` and `wrong-type` had to be
   * recorded advisory — half the mutation vocabulary unable to convict.
   */
  fieldTree?: FieldNode[];
  /**
   * One tree PER UNION BRANCH when the parameter's root type is a union of object shapes.
   *
   * RV11 — carried through from the signature inventory. `fieldTree` on a root union describes only
   * what every branch SHARES, so `FromChainOptions` recorded six common fields and dropped every
   * discriminated one. A validator generated from that would reject `shortDelta` on an ironCondor.
   * The branches travel with the parameter so 3B.1 can generate per-variant allowlists instead of
   * an intersection that admits none of them.
   */
  /**
   * Every arm as a complete node — kind, element, positions, literals, call signature, nested arms.
   *
   * The two arrays above describe an arm only insofar as it resembles an object, which is why a
   * union of two sequences (`number | ArrayLike<number>`) reached this artifact as a bare type name
   * with no alternatives at all. Carried per parameter, like the arrays, and for the same reason:
   * a branch list is a fact about the parameter's own type.
   */
  branches?: BranchNode[];
  /**
   * The recursive contract of this parameter's ELEMENT, when the parameter is a sequence of a named
   * type. `trades: ReadonlyArray<DirectionalFlowTrade>` has no contract of its own; each entry does.
   */
  elementFieldTree?: FieldNode[];
  /**
   * The element and the tuple positions as COMPLETE nodes, carried from the signature inventory.
   *
   * `elementFieldTree` and `tupleFieldTrees` are member lists resolved by type NAME, so a union
   * element resolves to the members its arms share — one member, `type`, for
   * `Array<BootstrapInstrument>` — and its four arms had nowhere to be recorded. These do not replace
   * those lists yet; they carry what a list cannot hold.
   */
  element?: FieldNode;
  tuple?: FieldNode[];
}

/** One overload: all of its parameters, and its result. */
export interface ContractSignature {
  parameters: ContractParameter[];
  returns: string;
  resultContract: string | null;
}

export interface ContractRecord {
  /** Public path identity (identity #1). */
  id: string;
  package: string;
  /** Implementation identity (#2) — aliases collapse here. */
  implementation: string;
  role: string;
  grammar: string;
  inputShape: InputShape;
  /** Which kind of boundary this is — decides whether missing enforcement is a defect. */
  boundaryKind: BoundaryKind;
  /**
   * EVERY parameter of EVERY overload, with its own contract identity.
   *
   * The first version recorded one `inputContract` taken from the first object parameter of the first
   * overload, and the losses were not marginal: `formatMoney(value, options?)` dropped `value`;
   * `selectQuotePrice(quote, source)` dropped `source` — the exact parameter whose invalid-enum defect
   * this phase had already filed as a seed fixture; `collectAsync(stream, source, nan)` dropped two.
   * An inventory that cannot see a parameter cannot generate a test for it.
   */
  signatures: ContractSignature[];
  /**
   * Contract identity (#3) for the PRIMARY accepted object, kept as a convenience index into
   * `signatures`. `null` when there is no object contract — a real answer, not a gap.
   */
  inputContract: string | null;
  /** Contract identity (#3) for the result, with generic arguments preserved. */
  resultContract: string | null;
  /**
   * Recursive field paths of every named contract this callable touches, joined from the committed
   * naming baseline (which already walks the type graph recursively, 1,288 nested identities deep).
   * Required by the spec's artifact table; omitted when the contract has no expanded fields.
   */
  fields?: string[];
  /**
   * Validator identity (#4): the guard calls found in the implementation body, sorted. EMPTY is the
   * signal Phase 3B exists to act on — an object-request path with no guard is where a misspelled key
   * or an omitted field reaches arithmetic.
   */
  validators: string[];
  /** How enforcement was reached: in this body, via delegation, ambiguous, or nowhere. */
  guardReachability: GuardReachability;
  /** The call chain that reached the guards, when delegated — so the claim is auditable. */
  via?: string[];
  /** The declared per-argument unknown-key policy from the package manifest, when curated. */
  inputPolicies?: Record<string, string>;
  /** A curated C20 exception, when this path is deliberately unenforced. */
  exception?: string;
}

/** Short, stable hash for an inline (anonymous) contract shape. */
function shapeHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** The bare type name, ignoring generic arguments — used to join against the naming baseline. */
function bareTypeName(type: string): string | null {
  const trimmed = type.trim();
  if (trimmed === '' || trimmed === 'void' || trimmed === 'unknown' || trimmed === 'any')
    return null;
  if (trimmed.startsWith('{')) return null;
  const base = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
  return base ? base[1]! : null;
}

/**
 * The ELEMENT type name of a sequence type text: `ReadonlyArray<Trade>` → `Trade`, `Trade[]` → `Trade`.
 *
 * A sequence-of-objects parameter carries its contract one level down, and `bareTypeName` answers with
 * the container — `ReadonlyArray`, which no package declares, so the join found nothing and synthesis
 * fell back to a series of NUMBERS. `deltaAdjustedPremium` was handed sixty floats where it wanted
 * trade prints and said so: "trades[0].type must be 'call' or 'put', got "undefined"."
 *
 * Nested generics are left alone: the inner text of `Array<Map<string, X>>` is not a contract name, and
 * the anchored pattern below simply does not match it.
 */
function elementTypeName(type: string): string | null {
  const trimmed = type.trim();
  const generic = /^(?:Readonly)?(?:Array|ArrayLike|Iterable)\s*<\s*([A-Za-z_$][\w$]*)\s*>$/.exec(
    trimmed,
  );
  if (generic) return generic[1]!;
  const suffix = /^([A-Za-z_$][\w$]*)\s*\[\]$/.exec(trimmed);
  return suffix ? suffix[1]! : null;
}

/**
 * The declared element TYPES of a labelled tuple, in order, or `null` when it is not one.
 *
 * Depth-aware splitting for the same reason `tupleElements` needs it: `Record<string, number>` and
 * `ArrayLike<number>` both contain commas, and a naive split produces nonsense names.
 */
function tupleElementTypes(type: string): string[] | null {
  const trimmed = type.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of trimmed.slice(1, -1)) {
    if ('<([{'.includes(character)) depth++;
    else if ('>)]}'.includes(character)) depth--;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') parts.push(current);
  if (parts.length === 0) return null;
  const types = parts.map((part) => {
    const match = /^\s*(?:\.\.\.)?[A-Za-z_$][\w$]*\??\s*:\s*([\s\S]+)$/.exec(part);
    return match ? match[1]!.trim() : null;
  });
  return types.every((entry) => entry !== null) ? (types as string[]) : null;
}

/** Per-element contract identities for a labelled tuple type. */
function tupleElementContracts(
  packageName: string,
  type: string,
): { tupleContracts: (string | null)[] } | undefined {
  const types = tupleElementTypes(type);
  if (!types) return undefined;
  return { tupleContracts: types.map((entry) => contractIdentity(packageName, entry)) };
}

/** Per-element field trees for a labelled tuple type, joined by bare name within the package. */
function tupleElementTrees(
  packageName: string,
  type: string,
  treesByContract: Map<string, FieldNode[]>,
): { tupleFieldTrees: (FieldNode[] | null)[] } | undefined {
  const types = tupleElementTypes(type);
  if (!types) return undefined;
  const trees = types.map((entry) => {
    const bare = bareTypeName(entry);
    return (bare ? treesByContract.get(`${packageName}:${bare}`) : undefined) ?? null;
  });
  return trees.some((tree) => tree !== null) ? { tupleFieldTrees: trees } : undefined;
}

/**
 * Contract identity for one declared type text within a package.
 *
 * Generic ARGUMENTS are part of the identity. The first version reduced every type to its outer name,
 * so `IndicatorStream<In, Out>` and `Promise<Out>` collapsed to `IndicatorStream` and `Promise` — which
 * merged genuinely different contracts under one identity and left the result of `collectAsync`
 * recorded as, simply, "a Promise". Whitespace is normalized so formatting alone never changes an
 * identity, but the arguments are kept.
 */
function contractIdentity(pkg: string, type: string): string | null {
  const trimmed = type.trim().replace(/\s+/g, ' ');
  if (trimmed === '' || trimmed === 'void' || trimmed === 'unknown' || trimmed === 'any')
    return null;
  // An inline object literal type is not nameable; hash its normalized shape instead.
  if (trimmed.startsWith('{')) return `${pkg}:{}#${shapeHash(trimmed)}`;
  if (!/^[A-Za-z_$]/.test(trimmed)) return null;
  // Long structural unions would make an unreadable identity; hash those too, keeping the head name.
  if (trimmed.length > 80) {
    return `${pkg}:${bareTypeName(trimmed) ?? 'type'}#${shapeHash(trimmed)}`;
  }
  return `${pkg}:${trimmed}`;
}

/**
 * Recursive field paths per named type, from the committed naming baseline.
 *
 * The baseline already walks the public type graph recursively (`AttributionReport.assumptions.
 * conventionsVersion` and 1,287 other nested identities), so joining is both cheaper and better
 * verified than re-walking here — and it keeps the two artifacts agreeing by construction.
 */
function recursiveFieldsByType(): Map<string, string[]> {
  const path = resolve(ROOT, 'tools/manifest/public-naming.json');
  const baseline = JSON.parse(readFileSync(path, 'utf8')) as {
    identities: { id: string; kind: string }[];
  };
  const out = new Map<string, string[]>();
  for (const identity of baseline.identities) {
    if (identity.kind !== 'field') continue;
    const [pkg, , tail] = identity.id.split('|');
    if (!pkg || !tail) continue;
    const owner = tail.split('.')[0]!;
    const key = `${pkg}:${owner}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(tail);
  }
  for (const fields of out.values()) fields.sort();
  return out;
}

/** Which input shape a callable presents, from its grammar and first-signature parameters. */
function inputShapeOf(callable: PublicCallable): InputShape {
  const parameters = callable.signatures[0]?.parameters ?? [];
  if (parameters.length === 0) return 'nullary';
  if (callable.grammar === 'columnar') return 'columnar';
  if (callable.grammar === 'series-options') return 'series-options';
  if (callable.grammar === 'subject-options') return 'subject-options';
  if (callable.grammar === 'object' || parameters[0]!.kind === 'object') return 'object-request';
  if (parameters.some((parameter) => parameter.kind === 'object')) return 'object-request';
  return 'positional-scalars';
}

/** The parameter carrying the object contract, if any. */
function objectParameter(callable: PublicCallable): SignatureParameter | null {
  const parameters = callable.signatures[0]?.parameters ?? [];
  return parameters.find((parameter) => parameter.kind === 'object') ?? null;
}

/**
 * The curated per-argument unknown-key policies, keyed by the signature inventory's callable id
 * (`@totalfinance/<dir>:<exportPath>`), so a record can state the policy it is enforced under alongside
 * the guards actually found. The manifest is the curated half; the AST scan is the discovered half.
 */
function helperAnswerMarkerSet(): ReadonlySet<string> {
  // The marker the package manifests already use for the H-series population, so the generated set and
  // the curated notes cannot disagree about who is in it.
  const MARKER = 'plain-value quant answer';
  const out = new Set<string>();
  for (const pkg of packageEntrypoints()) {
    const manifest = readManifest(pkg.dir);
    if (!manifest) continue;
    for (const [name, entry] of Object.entries(manifest.exports)) {
      const typed = entry as { role?: string; note?: string };
      if (typed.role === 'helper' && (typed.note ?? '').includes(MARKER)) {
        out.add(`${pkg.package}:${name}`);
      }
    }
  }
  return out;
}

function manifestPolicies(): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const pkg of packageEntrypoints()) {
    const manifest = readManifest(pkg.dir);
    if (!manifest) continue;
    for (const [name, entry] of Object.entries(manifest.exports)) {
      const policies = (entry as { inputPolicies?: Record<string, string> }).inputPolicies;
      if (policies) out.set(`${pkg.package}:${name}`, policies);
      // A class entry's method policies map onto the receiver-method callable ids the signature
      // inventory mints (`SqueezeCore#update`) — the exports map itself can only name live exports.
      const methodPolicies = (
        entry as { methodInputPolicies?: Record<string, Record<string, string>> }
      ).methodInputPolicies;
      for (const [method, policy] of Object.entries(methodPolicies ?? {})) {
        out.set(`${pkg.package}:${name}#${method}`, policy);
      }
    }
  }
  for (const [id, policy] of Object.entries(BOUNDARY_INPUT_POLICIES)) {
    out.set(id, policy);
  }
  return out;
}

/** The committed contract inventory: the artifact `public-contracts.json` holds. */
export interface ContractInventory {
  version: number;
  /**
   * The decision-ledger populations bound to generated identities (3B.0), so the H- and P-series work
   * is driven by the live surface rather than by the spec's handoff prose.
   */
  ledgers: {
    helperQuantAnswers: string[];
    highLevelPositionalPairs: string[];
  };
  /**
   * Object-parameter types a consumer cannot name from the package that demands them — the API can
   * describe an argument the caller has no way to declare. Found here, repaired in 3B.2.
   */
  nameability: NameabilityFinding[];
  /** Required member names per contract identity — what contract C obliges a value to provide. */
  contractMembers: Record<string, string[]>;
  summary: Record<string, unknown>;
  contracts: ContractRecord[];
}

export function buildContractInventory(): ContractInventory {
  const { callables } = JSON.parse(readFileSync(SIGNATURES, 'utf8')) as {
    callables: PublicCallable[];
  };
  const contracts: ContractRecord[] = [];
  const policies = manifestPolicies();
  const functionIndex = indexFunctions();
  const helperAnswerMarkers = helperAnswerMarkerSet();
  const fieldsByType = recursiveFieldsByType();
  const treesByContract = contractFieldTrees();
  const enforcementMemo = new Map<string, ReturnType<typeof resolveGuardReachability>>();

  for (const callable of callables) {
    const [implementationFile] = callable.implementation.split('#');
    const inputShape = inputShapeOf(callable);
    const objectArgument = objectParameter(callable);
    const returns = callable.signatures[0]?.returns ?? '';
    const reachability = resolveGuardReachability(
      functionIndex,
      callable.implementation,
      enforcementMemo,
      // The public PATH, so constructors and facade companions join to the declaration that actually
      // carries their guards — the two inventories address those members differently.
      callable.path,
    );
    // Every parameter of every overload, each with its own contract identity.
    const signatures: ContractSignature[] = callable.signatures.map((signature) => ({
      parameters: signature.parameters.map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
        contract: contractIdentity(callable.package, parameter.type),
        // Persisted so the join is auditable: a reader can see WHICH of ten same-named declarations
        // this parameter resolved to, rather than having to trust that it resolved to the right one.
        ...(parameter.typeDeclaration ? { typeDeclaration: parameter.typeDeclaration } : {}),
        // The declared closed set, when the type resolves to one. Copied explicitly because this
        // mapping is field-by-field: a property the signature inventory records and this one forgets
        // does not reach the harness at all, however faithfully it was measured upstream.
        ...(parameter.literals ? { literals: parameter.literals } : {}),
        /**
         * A labelled TUPLE parameter is several arguments, and each deserves its own contract
         * identity. The tuple's own is `null` — `[bond: Bond, curve: YieldCurve, …]` has no bare name
         * to key on — so without this the elements reach the harness as anonymous text and nothing
         * keyed by contract can find them. Derived HERE because this is where the package is known,
         * and identity #3 is this file's job.
         */
        ...(tupleElementContracts(callable.package, parameter.type) ?? {}),
        /**
         * And each element's declared SHAPE, for the same reason.
         *
         * A labelled tuple is several arguments, and splitting it on text alone discards everything
         * this file knows about them: `[bond: Bond, curve: YieldCurve, options: CurvePricingOptions]`
         * loses the field tree of `CurvePricingOptions`, which is an ordinary options object the
         * declaration describes completely. One unbuildable element makes the whole argument list
         * `null`, so losing the easy third element wasted the two hard ones as well.
         */
        ...(tupleElementTrees(callable.package, parameter.type, treesByContract) ?? {}),
        ...(parameter.callSignature ? { callSignature: parameter.callSignature } : {}),
        ...(parameter.callSignatures ? { callSignatures: parameter.callSignatures } : {}),
        ...(parameter.returns ? { returns: parameter.returns } : {}),
        ...(parameter.inferredGeneric ? { inferredGeneric: true as const } : {}),
        ...(parameter.instantiatedGeneric ? { instantiatedGeneric: true as const } : {}),
        optional: parameter.optional,
        rest: parameter.rest,
        kind: parameter.kind,
        /**
         * The DECLARATION identity first (R10), the bare name only as a fallback.
         *
         * `<package>:<BareName>` cannot tell ten `PeriodParameters` apart, so the ambiguity had to be
         * resolved by discarding all of them. A declaration identity is exact, so the shape comes back
         * — and comes back attached to the type the parameter actually names rather than to whichever
         * homonym happened to be indexed first.
         */
        /**
         * RV12 — THE BRANCHES ARE NOT PART OF THE COMMON-TREE RESOLUTION, so they are not resolved
         * with it.
         *
         * They used to be returned from inside the `parameter.fieldTree` arm of the chain below,
         * which meant they survived only when the common tree happened to be ATTACHED. Where the
         * common tree came from a declaration lookup — or where there was no common tree at all,
         * which is the normal case for a union whose branches share nothing — the branches were
         * dropped. Seven public paths across three implementations carried root-union branches in the
         * signature artifact; three, from a single implementation, reached the contract artifact.
         * `spectralRisk` (`{ riskAversion? } | { alpha }`) and `phiValue` (power-law vs Heston) lost
         * theirs entirely, which is precisely the pair 3B.1 would have generated a validator for.
         *
         * A branch list is a fact about the parameter's own type. It travels with the parameter,
         * unconditionally, and the common tree resolves however it resolves.
         */
        ...(parameter.branches ? { branches: parameter.branches } : {}),
        /**
         * The element and the tuple positions travel with the parameter for the same reason the
         * branch list does: they are facts about its own declared type, not results of a lookup.
         *
         * `elementFieldTree` / `tupleFieldTrees` below are resolved by type NAME, which is why a
         * union element arrived as the members its arms share and nothing else.
         */
        ...(parameter.element ? { element: parameter.element } : {}),
        ...(parameter.tuple ? { tuple: parameter.tuple } : {}),
        ...(() => {
          /**
           * A tree ATTACHED to the parameter wins. It exists only where the type has no single
           * declaration to look one up by — an intersection — and in that case the lookup below is
           * not merely unavailable but actively wrong: it resolves to the named constituent and
           * silently drops the members declared inline.
           */
          if (parameter.fieldTree && parameter.fieldTree.length > 0) {
            return { fieldTree: parameter.fieldTree };
          }
          /**
           * An exact generic instantiation wins over its declaration template.
           *
           * Ordinary named objects continue to use the one declaration-indexed tree; replacing every
           * one with a per-parameter walk changed field order and rendered optional syntax without
           * changing its contract. A specialization such as `Schema<Item>` is different:
           * `Schema<Output>` loses the caller-visible binding, so only those exact trees override.
           */
          if (
            parameter.instantiatedGeneric &&
            parameter.checkerFieldTree &&
            parameter.checkerFieldTree.length > 0
          ) {
            return { fieldTree: parameter.checkerFieldTree };
          }
          const declared = parameter.typeDeclaration
            ? treesByContract.get(parameter.typeDeclaration)
            : undefined;
          if (declared) return { fieldTree: declared };
          const bare = bareTypeName(parameter.type);
          const tree = bare ? treesByContract.get(`${callable.package}:${bare}`) : undefined;
          if (tree) return { fieldTree: tree };
          // A sequence parameter's contract lives one level down, on its element.
          const element = elementTypeName(parameter.type);
          const elementTree = element
            ? treesByContract.get(`${callable.package}:${element}`)
            : undefined;
          if (elementTree) return { elementFieldTree: elementTree };
          /**
           * LAST: the members the generator read off the type itself.
           *
           * Every lookup above is by NAME or by declaration id against an index built from EXPORTED
           * types, so an unexported request type resolves to nothing and the parameter publishes a
           * contract identity with no contract. Consulted last, so a curated indexed tree still wins
           * and one declared type keeps one answer.
           */
          return parameter.checkerFieldTree && parameter.checkerFieldTree.length > 0
            ? { fieldTree: parameter.checkerFieldTree }
            : {};
        })(),
      })),
      returns: signature.returns,
      resultContract: contractIdentity(callable.package, signature.returns),
    }));

    /**
     * Recursive fields for every named contract this callable touches — resolved by TYPE NAME, with
     * the callable's own package tried first.
     *
     * The key used to be `<package>:<TypeName>` and nothing else, which quietly impoverished every
     * umbrella record: `AmericanExerciseInput` is declared in `@totalfinance/options`, so
     * `totalfinance:AmericanExerciseInput` matched nothing and the umbrella path reached the harness with
     * no field names at all. Where a parameter also has no field TREE, that is the difference between
     * synthesizing a request and synthesizing nothing — 114 umbrella paths were measured only because
     * they had been probed independently, and became `no-input` the moment measurement was made
     * canonical per function.
     *
     * A re-export does not change what a type contains. The package-qualified key is still preferred,
     * so a genuine homonym resolves to its own package's type; the bare-name fallback applies only
     * when that misses and exactly one package declares the name.
     */
    const touched = new Set<string>();
    const addTouched = (bare: string | null): void => {
      if (!bare) return;
      const own = `${callable.package}:${bare}`;
      if (fieldsByType.has(own)) {
        touched.add(own);
        return;
      }
      const elsewhere = [...fieldsByType.keys()].filter((key) => key.endsWith(`:${bare}`));
      if (elsewhere.length === 1) touched.add(elsewhere[0]!);
    };
    for (const signature of signatures) {
      for (const parameter of signature.parameters) addTouched(bareTypeName(parameter.type));
      addTouched(bareTypeName(signature.returns));
    }
    const fields = [...touched]
      .flatMap((key) => fieldsByType.get(key) ?? [])
      .sort()
      .filter((value, index, all) => index === 0 || all[index - 1] !== value);

    const record: ContractRecord = {
      id: callable.id,
      package: callable.package,
      implementation: callable.implementation,
      role: callable.role ?? 'unclassified',
      grammar: callable.grammar,
      inputShape,
      boundaryKind: boundaryKindOf(
        callable.path,
        implementationFile!,
        reachability.guardReachability !== 'no-implementation',
      ),
      signatures,
      inputContract: objectArgument
        ? contractIdentity(callable.package, objectArgument.type)
        : null,
      resultContract: contractIdentity(callable.package, returns),
      validators: reachability.validators,
      guardReachability: reachability.guardReachability,
    };
    if (fields.length > 0) record.fields = fields;
    if (reachability.via.length > 0) record.via = reachability.via;
    const policy = policies.get(callable.id);
    if (policy) record.inputPolicies = policy;
    const exception = CONTRACT_EXCEPTIONS[callable.id];
    if (exception) record.exception = exception;
    contracts.push(record);
  }

  contracts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const distinct = (pick: (record: ContractRecord) => string | null): number =>
    new Set(contracts.map(pick).filter((value): value is string => value !== null)).size;

  /**
   * The honest 3B.1/3B.2 work list: an object contract that a caller reaches, where nothing reachable
   * enforces it.
   *
   * Boundary kinds are excluded for STRUCTURAL reasons, never by package or tier (C20): a stream's
   * per-tick `next` was validated at construction and the spec forbids re-validating it per row; the
   * schema machinery cannot validate its own input with itself; an `Error` constructor takes a message;
   * and a callback contract has no body to guard because the CALLER implements it.
   */
  const ENFORCEMENT_REQUIRED: ReadonlySet<BoundaryKind> = new Set<BoundaryKind>([
    'entry-point',
    'snapshot-restore',
    // Every constructor here is reachable from a published entrypoint — `BollingerStream` is exported
    // from `./bands` — so "reached through a validated factory" was an assumption, not a fact, and it
    // exempted all 166 of them. `new BollingerStream({ period: 20, k: 2 })` returns null bands today.
    'constructor',
  ]);
  const unguardedObjectInputs = contracts.filter(
    (record) =>
      record.inputContract !== null &&
      ENFORCEMENT_REQUIRED.has(record.boundaryKind) &&
      // `ambiguous` IS work — an over-approximation would hide the defect this phase exists to find.
      // `no-implementation` is not: there is nothing to attach a guard to.
      (record.guardReachability === 'none' || record.guardReachability === 'ambiguous') &&
      record.exception === undefined &&
      !POSITIONAL_MATH_PATHS.has(record.id),
  );

  /**
   * The decision-ledger populations, BOUND TO GENERATED IDENTITIES (3B.0).
   *
   * The spec gives handoff baselines of 36 helper paths and 33 pair paths but says "only the generated
   * Phase 3B.0 identities control execution" — so these are recomputed here and the ledger is asserted
   * against them, rather than the prose numbers being trusted.
   *
   * H-series comes out at exactly 36, which is how we know the definition matches the spec's. P-series
   * is 22, not 33: Phase 3A and 3B.N already migrated eleven of those pairs to named requests, so the
   * live set is smaller than the handoff. That is progress, and the generated number is the one that
   * governs.
   */
  const helperQuantAnswers = contracts
    .filter((record) => record.role === 'helper' && helperAnswerMarkers.has(record.id))
    .map((record) => record.id)
    .sort();
  const highLevelPositionalPairs = callables
    .filter(
      (callable) =>
        callable.grammar === 'natural-positional' &&
        (callable.signatures[0]?.parameters.length ?? 0) === 2 &&
        (callable.role === 'facade' || callable.role === 'analysis'),
    )
    .map((callable) => callable.id)
    .sort();

  /**
   * Object-parameter types a consumer cannot name from the package that demands them. Detection is
   * 3B.0's remit; the repair is 3B.2, which migrates packages in dependency order.
   */
  /**
   * PROPAGATE the per-argument key policy along IMPLEMENTATION identity, so the two artifacts cannot
   * disagree about the same path.
   *
   * Policies are declared in each scoped package's manifest, keyed `<package>:<exportName>`. The
   * umbrella has no manifest, so `totalfinance:crossOver` carried NO policy while `backtest:crossOver` —
   * the same function — declared both arguments `open`. `contract-enforcement.ts` was taught to copy
   * the policy when it inherits a verdict, which fixed the verdict side and left the two artifacts
   * disagreeing about 38 paths: `public-contracts.json` said `null`, `public-enforcement.json` said
   * `open`. Two files, one path, two contracts.
   *
   * A policy is a property of the FUNCTION, so the fix belongs here, where implementation identity
   * lives. Propagated only where there is no ambiguity — exactly one distinct declared policy among
   * the records sharing an implementation — because that identity deliberately over-links for template
   * declarations (`Indicator.explain` covers 625 paths), and spreading one indicator's curation across
   * 625 others would be a worse error than the one being fixed.
   */
  const policiesByImplementation = new Map<string, Set<string>>();
  for (const record of contracts) {
    if (!record.inputPolicies) continue;
    // A BOUNDARY-curated policy names ONE path, never a function identity: the explain-template
    // implementation is shared by hundreds of paths, and seeding propagation from a per-boundary
    // row re-creates the blanket explain-twin inheritance that manufactured 73 false convictions.
    if (BOUNDARY_INPUT_POLICIES[record.id] !== undefined) continue;
    const seen = policiesByImplementation.get(record.implementation) ?? new Set<string>();
    seen.add(JSON.stringify(record.inputPolicies));
    policiesByImplementation.set(record.implementation, seen);
  }
  for (const record of contracts) {
    if (record.inputPolicies) continue;
    const declared = policiesByImplementation.get(record.implementation);
    if (declared?.size !== 1) continue;
    record.inputPolicies = JSON.parse([...declared][0]!) as Record<string, string>;
  }

  const nameability = nameabilityFindings(contracts);

  /**
   * The REQUIRED member names of every named contract, sorted — the contract graph answering "what
   * does C oblige you to provide".
   *
   * Published because a consumer of this artifact needs it and cannot derive it: the per-parameter
   * `fieldTree` is attached to PARAMETERS, so a contract that only ever appears as a tuple element or
   * a factory result has its shape recorded nowhere addressable by identity. The enforcement harness
   * hit exactly that — it validates a factory-produced instance against the contract it claims to
   * produce, and `curves.discountFactor` is recorded as returning a `YieldCurve`, does not, and was
   * accepted because there was nothing to check it against.
   */
  const contractMembers: Record<string, string[]> = {};
  for (const [key, tree] of [...treesByContract].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // Declaration-identity keys (`packages/…#Name`) duplicate the `<package>:<Name>` ones; the
    // published index uses the public identity, which is what a consumer holds.
    if (!key.includes(':') || key.includes('#')) continue;
    const required = tree.filter((field) => !field.optional).map((field) => field.name);
    if (required.length > 0) contractMembers[key] = required;
  }

  return {
    version: 1,
    nameability,
    contractMembers,
    ledgers: {
      /** H-series: helper-role exports returning a plain-value quant answer. */
      helperQuantAnswers,
      /** P-series: retained high-level two-argument positional pairs. */
      highLevelPositionalPairs,
    },
    summary: {
      // Reported SEPARATELY, per the spec's scope model — one number alone always misleads.
      publicPaths: contracts.length,
      implementations: distinct((record) => record.implementation),
      /**
       * The largest number of public paths sharing ONE declaration identity — so `implementations`
       * cannot be read as a workload count (R10).
       *
       * `Indicator.explain`, `.stream` and `.fromJSON` are three declarations covering 1,875 paths
       * between them, because `Indicator` is a generic interface that all 625 indicators implement.
       * Those are 625 DISTINCT runtime closures behind one declaration, so "2,096 implementations"
       * overstates how many declarations there are to fix and understates how many functions there
       * are to measure. Both numbers are true of different questions; publishing only the first
       * invites the wrong one.
       *
       * The measurement is not affected — `contract-conformance.test.ts` holds the property that
       * matters, which is that these are measured per PATH rather than inherited from one another.
       */
      maxPathsPerImplementation: Math.max(
        ...[
          ...contracts
            .reduce<
              Map<string, number>
            >((counts, record) => counts.set(record.implementation, (counts.get(record.implementation) ?? 0) + 1), new Map())
            .values(),
        ],
      ),
      inputContracts: distinct((record) => record.inputContract),
      resultContracts: distinct((record) => record.resultContract),
      validatorIdentities: new Set(contracts.flatMap((record) => record.validators)).size,
      helperQuantAnswers: helperQuantAnswers.length,
      highLevelPositionalPairs: highLevelPositionalPairs.length,
      byInputShape: contracts.reduce<Record<string, number>>(
        (accumulator, record) => {
          accumulator[record.inputShape] = (accumulator[record.inputShape] ?? 0) + 1;
          return accumulator;
        },
        Object.create(null) as Record<string, number>,
      ),
      objectInputPaths: contracts.filter((record) => record.inputContract !== null).length,
      unguardedObjectInputs: unguardedObjectInputs.length,
      unnameableParameterContracts: nameability.length,
      unnameableUnreachable: nameability.filter((finding) => finding.kind === 'unreachable').length,
      unnameableForeign: nameability.filter((finding) => finding.kind === 'foreign').length,
      byGuardReachability: contracts.reduce<Record<string, number>>(
        (accumulator, record) => {
          accumulator[record.guardReachability] = (accumulator[record.guardReachability] ?? 0) + 1;
          return accumulator;
        },
        Object.create(null) as Record<string, number>,
      ),
      ambiguousReachability: contracts.filter((record) => record.guardReachability === 'ambiguous')
        .length,
      byBoundaryKind: contracts.reduce<Record<string, number>>(
        (accumulator, record) => {
          accumulator[record.boundaryKind] = (accumulator[record.boundaryKind] ?? 0) + 1;
          return accumulator;
        },
        Object.create(null) as Record<string, number>,
      ),
      // Deduplicated by implementation, so alias fan-out never inflates the work estimate.
      unguardedImplementations: new Set(
        unguardedObjectInputs.map((record) => record.implementation),
      ).size,
      curatedExceptions: contracts.filter((record) => record.exception !== undefined).length,
      conventionalPositionalMath: contracts.filter((record) => POSITIONAL_MATH_PATHS.has(record.id))
        .length,
    },
    contracts,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = buildContractInventory();
  writeFileSync(OUTPUT, `${JSON.stringify(inventory, null, 2)}\n`);
  const { summary } = inventory;
  process.stdout.write(
    `contracts: ${relative(ROOT, OUTPUT)}\n` +
      `  public paths            ${String(summary['publicPaths'])}\n` +
      `  implementations         ${String(summary['implementations'])}\n` +
      `  input contracts         ${String(summary['inputContracts'])}\n` +
      `  result contracts        ${String(summary['resultContracts'])}\n` +
      `  validator identities    ${String(summary['validatorIdentities'])}\n` +
      `  object-input paths      ${String(summary['objectInputPaths'])}\n` +
      `  UNGUARDED object inputs ${String(summary['unguardedObjectInputs'])}\n`,
  );
}
