/**
 * Public-callable signature inventory (alignment Law 14 / Phase 3A).
 *
 * Runtime manifests classify exported values. This companion reads the built TypeScript
 * declarations named by every package export map and records the callable surface that reflection
 * cannot see: parameter names/types/optionality, namespace functions, constructors, facade
 * companions, public interface/class methods, and callable methods on returned artifacts.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { packageEntrypoints } from './inventory.js';
import { readManifest } from './generate.js';
import {
  armNodes,
  type BranchNode,
  type CallableSignatureNode,
  type FieldNode,
  callableSignatures,
  constrainedType,
  elementTypeOf,
  fieldTreeForType,
  literalDomain,
  semanticArms,
  tupleElementTypes,
  walkField,
  type LiteralValue,
} from './contract-fields.js';
import { SIGNATURE_POLICIES } from './signature-policy.js';
import type { Role } from './schema.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = resolve(ROOT, 'packages');
export const SIGNATURE_MANIFEST_PATH = fileURLToPath(
  new URL('./public-signatures.json', import.meta.url),
);

export type CallGrammar =
  | 'none'
  | 'object'
  | 'series-options'
  | 'subject-options'
  | 'single-subject'
  | 'natural-positional'
  | 'columnar';

export interface SignatureParameter {
  name: string;
  type: string;
  /**
   * `<source file>#<Name>` for the parameter's declared type — its DECLARATION identity (R10).
   *
   * The rendered `type` above is a name, and a name is not an identity where ten modules in one
   * package declare a `PeriodParameters` that disagree about requiredness.
   */
  typeDeclaration?: string;
  /**
   * The field tree, when this parameter's type has no single declaration to look one up by.
   *
   * An INTERSECTION is the case: `contract-inventory.ts` resolves trees by declaration identity, and
   * `A & { … }` has none, so it borrowed `A`'s and dropped every member declared inline —
   * `barrier.monteCarloPrice` recorded 7 of its 9 keys. A partial record is worse than a missing one
   * because it looks complete: a Law 12 allowed-key list generated from it would reject `type` and
   * `barrierType`, refusing valid calls in the name of fixing permissiveness.
   */
  fieldTree?: FieldNode[];
  /**
   * EVERY ARM AS A COMPLETE NODE — the representation that replaces the two arrays above.
   *
   * They can describe an arm only insofar as it resembles an object (`branchFields`), with its
   * rendered text alongside (`branchTypes`). An arm's own kind, element contract, positions,
   * literals, call signature and nested arms had nowhere to live, so any union whose arms are not
   * objects was recorded as a type name and nothing else.
   *
   * Declared here because it was not: the emitting object literal is built by spread, and TypeScript
   * does not flag an excess property that arrives that way. The field reached the artifact and every
   * reader of it was typed against a shape that did not admit it — the same gap the parameter-level
   * `branchTuples` cast covered on the synthesis side.
   */
  branches?: BranchNode[];
  /**
   * A SEQUENCE'S ELEMENT as a complete node, and a TUPLE'S POSITIONS as complete nodes.
   *
   * `elementFieldTree` / `tupleFieldTrees` (added downstream, in `contract-inventory.ts`) describe the
   * same places as flat MEMBER LISTS, and a member list can express an object and nothing else. When
   * the element is a union those lists are resolved by type name and collapse to the members every arm
   * shares: `Array<BootstrapInstrument>` published exactly one, `type`. These carry the arms.
   */
  element?: FieldNode;
  tuple?: FieldNode[];
  /**
   * The parameter's members read straight off its exact instantiated type.
   *
   * Kept separate from `fieldTree` so the two provenances stay distinguishable: `fieldTree` is
   * attached because the lookup would be WRONG (an intersection borrows a constituent's tree), this is
   * attached because the lookup may be ABSENT (a request type the package does not export). Merging
   * them would erase the provenance difference that lets downstream readers prefer the exact public
   * instantiation over a generic declaration template.
   */
  checkerFieldTree?: FieldNode[];
  /**
   * The admissible values, when the type resolves to a CLOSED set of string literals.
   *
   * Present regardless of whether the declaration wrote the union inline or behind an alias — the
   * point of recording it is that `Field` and `'open' | 'high' | 'low' | 'close'` are the same
   * contract and only one of them says so.
   */
  literals?: LiteralValue[];
  /** For `callback`: the resolved arity and return type — what a stub needs, past any alias. */
  callSignature?: { parameters: number; returns: string };
  /** Every overload and its complete parameter/return contract. */
  callSignatures?: CallableSignatureNode[];
  /** The first overload's return value as a walkable contract, when one exists. */
  returns?: FieldNode;
  /** True when the apparent type name is an inferred generic binder, not a type users must import. */
  inferredGeneric?: true;
  /** Prefer the exact tree when generic arguments specialize the declaration template. */
  instantiatedGeneric?: true;
  optional: boolean;
  rest: boolean;
  kind: 'numeric' | 'primitive' | 'series' | 'object' | 'callback' | 'other';
}

export interface PublicCallable {
  id: string;
  package: string;
  path: string;
  owner: 'export' | 'constructor' | 'interface-method' | 'class-method' | 'artifact-method';
  entrypoints: string[];
  role?: Role;
  implementation: string;
  grammar: CallGrammar;
  rationale?: string;
  signatures: Array<{
    parameters: SignatureParameter[];
    returns: string;
  }>;
}

export interface PublicSignatureManifest {
  version: 1;
  /**
   * The TypeScript version that produced this artifact.
   *
   * Every `type` string here is `checker.typeToString(...)` output, so the file's bytes are a function
   * of the compiler that wrote them — a different patch renders a generic or a union differently and
   * the committed baseline "drifts" with nothing in the library having changed.
   *
   * That happened. `typescript` was declared `^5.7.3`, a caret range, so two checkouts installed on
   * different days resolved different patches and disagreed about a file neither had edited. It cost a
   * reviewer a failing drift gate I could not reproduce on three Node versions, because Node was never
   * the variable.
   *
   * Recording it turns a mystifying failure into a legible one: the gate can now say "this artifact
   * was generated with 5.9.3 and you are running 5.10.0" instead of printing a diff of type strings.
   * The dependency is pinned exactly as well — belt and braces, since the pin prevents the drift and
   * this explains it if the pin is ever loosened.
   */
  typescriptVersion: string;
  callables: PublicCallable[];
}

interface PackageSource {
  package: string;
  domain: string;
  entries: Map<string, string>;
}

const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.WriteArrayAsGenericType |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

function firstTypeTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record['types'] === 'string') return record['types'];
  for (const nested of Object.values(record)) {
    const found = firstTypeTarget(nested);
    if (found) return found;
  }
  return null;
}

function declarationFor(packageDir: string, exportValue: unknown): string | null {
  const target = firstTypeTarget(exportValue);
  if (!target) return null;
  const declaration = target.endsWith('.d.ts') ? target : target.replace(/\.js$/, '.d.ts');
  const absolute = resolve(packageDir, declaration);
  return existsSync(absolute) ? absolute : null;
}

/**
 * Every package whose declarations this inventory reads — the scoped packages AND the umbrella.
 *
 * `packageEntrypoints()` filters on `MANIFEST_TIERS`, which deliberately omits `totalfinance` because the
 * umbrella is "checked structurally, not re-classified" — a correct decision for the ROLE manifest,
 * where classifying 2,000 re-exports would be curation noise. But it silently propagated to every
 * consumer, so the signature and contract inventories had zero umbrella records while the spec's scope
 * model asks for "every import/namespace/member path a user can call," and `totalfinance.blackScholes.price`
 * is such a path.
 *
 * Including it costs nothing in WORK, which is the point of separating identity #1 from #2: the
 * umbrella re-exports the same objects (proved by `packages/totalfinance/test`), so every umbrella path
 * collapses onto an existing implementation identity. Omitting it understated path coverage; including
 * it shows the fan-out for what it is.
 */
function inventoriedPackages(): { package: string; dir: string }[] {
  const scoped = packageEntrypoints().map((pkg) => ({ package: pkg.package, dir: pkg.dir }));
  return [...scoped, { package: 'totalfinance', dir: 'totalfinance' }];
}

function packageSources(): { packages: PackageSource[]; paths: Record<string, string[]> } {
  const packages: PackageSource[] = [];
  const paths: Record<string, string[]> = {};
  for (const pkg of inventoriedPackages()) {
    const packageDir = resolve(PACKAGES, pkg.dir);
    const json = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as {
      name: string;
      exports: Record<string, unknown>;
    };
    const entries = new Map<string, string>();
    for (const [entrypoint, value] of Object.entries(json.exports)) {
      if (entrypoint === './package.json') continue;
      const declaration = declarationFor(packageDir, value);
      if (!declaration) {
        throw new Error(
          `signature-inventory: ${json.name} ${entrypoint} has no built declaration; run pnpm build and ensure its export map has a types target`,
        );
      }
      entries.set(entrypoint, declaration);
    }
    packages.push({ package: pkg.package, domain: pkg.dir, entries });
    paths[pkg.package] = [resolve(packageDir, 'dist/index.d.ts')];
    paths[`${pkg.package}/*`] = [resolve(packageDir, 'dist/*')];
  }
  return { packages, paths };
}

/**
 * Is this an object worth descending into as a NAMESPACE (`totalfinance.volatility`, `blackScholes`)?
 *
 * Deliberately narrow: an object with callable members and no call signature of its own. A class or a
 * schema instance would otherwise pull its whole prototype surface into the umbrella's path list.
 */
function isNamespaceLikeType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return false;
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0) return false;
  /**
   * Must be an OBJECT type.
   *
   * The first version tested only "has callable members," which every PRIMITIVE satisfies: a string
   * constant's type carries the whole of `String.prototype`. So `export const CONVENTIONS_VERSION =
   * '0.0.1'` was descended into and 318 standard-library methods — 294 `String`, 24 `Number` — were
   * recorded as public TotalFinance paths, including `BENCHMARK_FIXTURE_VERSION.localeCompare`.
   *
   * It also made the generator NONDETERMINISTIC. Symbol-named members render with TypeScript's
   * internal symbol id (`__@iterator@14`), and that counter advances with everything else compiled in
   * the process — so the same input produced `__@iterator@14` on one run and `__@iterator@17000` on the
   * next, and whether CI passed depended on how much had been compiled first. Flaky, which is worse
   * than red.
   */
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  // An ARRAY is not a namespace either. `ALIAS_TABLE` is an array, and descending into it recorded
  // `totalfinance:ALIAS_TABLE.toLocaleString` — an `Array.prototype` member — as public API.
  if (checker.isArrayLikeType(type)) return false;
  const properties = namespaceMembers(checker, type);
  if (properties.length === 0) return false;
  return properties.some((property) => {
    const propertyType = typeOfSymbol(checker, property);
    return propertyType
      ? checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call).length > 0
      : false;
  });
}

/**
 * The members of a namespace worth recording: string-named, and declared on the object itself.
 *
 * Symbol-named members are excluded because they can never be a public dotted path AND because their
 * rendered names embed an unstable compiler id. Inherited members are excluded because a prototype
 * method is not part of this library's surface.
 */
function namespaceMembers(checker: ts.TypeChecker, type: ts.Type): ts.Symbol[] {
  return checker.getPropertiesOfType(type).filter((property) => {
    if (property.name.startsWith('__@')) return false;
    const declaration = declarationOf(property);
    if (!declaration) return false;
    // Declared in this repo, not in a lib.*.d.ts.
    return !declaration.getSourceFile().fileName.includes('/typescript/lib/');
  });
}

function originalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function declarationOf(symbol: ts.Symbol): ts.Declaration | undefined {
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function typeOfSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | null {
  const original = originalSymbol(checker, symbol);
  const declaration = declarationOf(original);
  return declaration ? checker.getTypeOfSymbolAtLocation(original, declaration) : null;
}

function normalizeType(type: string): string {
  return canonicalizeMembers(
    type
      .replace(/import\("[^"]*"\)\./g, '')
      .replace(/import\("[^"]*"\)/g, '')
      .split(ROOT)
      .join(''),
  );
}

/**
 * Sort the members of every ANONYMOUS OBJECT TYPE in a rendered type string.
 *
 * Property order in a structural type carries no meaning — `{ a: X; b: Y }` and `{ b: Y; a: X }` are
 * the same type and accept the same values — but `typeToString` emits them in the order the checker
 * happens to have resolved, and that order depends on build state. A clean `tsc -b` and an incremental
 * one produce different orders for the same source.
 *
 * The committed artifact was generated from an incremental build and CI builds clean, so every hosted
 * job failed with `public-signatures.json has drifted` on diffs like
 *
 *     … strike: number; underlying: string; style: …; adjusted?: …; currency?: … }
 *     … strike: number; style: …; underlying: string; currency?: …; adjusted?: … }
 *
 * — the same members, reordered. Pinning TypeScript did not touch this, because the compiler was never
 * the variable either; the BUILD was.
 *
 * Canonicalizing is better than mandating clean builds, which only works until someone runs an
 * incremental one. Sorting a set that has no order cannot lose information, and it makes the artifact
 * report a real API change instead of an emitter accident.
 */
function canonicalizeMembers(type: string): string {
  const open = type.indexOf('{');
  if (open === -1) return type;

  // The matching close brace, tracking nesting.
  let depth = 0;
  let close = -1;
  for (let index = open; index < type.length; index++) {
    const character = type[index];
    if (character === '{') depth++;
    else if (character === '}') {
      depth--;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) return type;

  const inner = type.slice(open + 1, close);
  // Split on `;` at depth zero — nested braces, parens and generic brackets all hold their contents
  // together, so a member's own punctuation never splits it.
  const members: string[] = [];
  let current = '';
  let nesting = 0;
  for (const character of inner) {
    if ('{(<['.includes(character)) nesting++;
    else if ('})>]'.includes(character)) nesting--;
    if (character === ';' && nesting === 0) {
      members.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') members.push(current);

  const sorted = members
    .map((member) => canonicalizeMembers(member.trim()))
    .filter((member) => member !== '')
    .sort();
  const body = sorted.length > 0 ? ` ${sorted.join('; ')}; ` : '';
  return type.slice(0, open) + '{' + body + '}' + canonicalizeMembers(type.slice(close + 1));
}

function typeText(checker: ts.TypeChecker, type: ts.Type, declaration?: ts.Node): string {
  return normalizeType(checker.typeToString(type, declaration, TYPE_FORMAT_FLAGS));
}

function withoutNullish(type: ts.Type): ts.Type[] {
  const parts = type.isUnion() ? type.types : [type];
  return parts.filter(
    (part) =>
      !(part.flags & ts.TypeFlags.Undefined) &&
      !(part.flags & ts.TypeFlags.Null) &&
      !(part.flags & ts.TypeFlags.Void),
  );
}

function everyPart(type: ts.Type, predicate: (part: ts.Type) => boolean): boolean {
  const parts = withoutNullish(type);
  return parts.length > 0 && parts.every(predicate);
}

function isNumeric(type: ts.Type, rendered: string): boolean {
  if (
    everyPart(type, (part) =>
      Boolean(part.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Enum)),
    )
  ) {
    return true;
  }
  /**
   * The NAME fallback answers for a branded numeric alias rendered by its name. It must never read
   * a MEMBER list: `{ now: EpochMs }` mentions `EpochMs` and is an object, and the rendered text
   * cannot tell the two apart. Three receiver-method inputs (`PaperBroker#resume`,
   * `InstrumentAdapter#accrued`, `AuthorizationStore#put`) were classified `numeric` this way and
   * silently fell out of enforcement candidacy — a boundary with no verdict, not a refused one. An
   * arm that is an object (or a callable) cannot be a number, so the fallback is confined to the
   * arms that could be one.
   */
  if (
    withoutNullish(type).some(
      (part) => Boolean(part.flags & ts.TypeFlags.Object) || part.isIntersection(),
    ) &&
    !/^(readonly\s+)?(EpochMs|UnixSeconds|Positive|NonNegative|Probability|Rate|Volatility)\b/.test(
      rendered.trim(),
    )
  ) {
    return false;
  }
  return /(^|\W)(EpochMs|UnixSeconds|Positive|NonNegative|Probability|Rate|Volatility)(\W|$)/.test(
    rendered,
  );
}

function isPrimitive(type: ts.Type, rendered: string): boolean {
  if (isNumeric(type, rendered)) return true;
  return everyPart(type, (part) =>
    Boolean(
      part.flags &
      (ts.TypeFlags.String |
        ts.TypeFlags.StringLiteral |
        ts.TypeFlags.Boolean |
        ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.BigInt |
        ts.TypeFlags.BigIntLiteral |
        ts.TypeFlags.ESSymbol |
        ts.TypeFlags.UniqueESSymbol |
        ts.TypeFlags.Enum),
    ),
  );
}

/**
 * A union of scalars that is not homogeneous — `string | number`, `'a' | 'b' | number`.
 *
 * Reported as `primitive` rather than as its own kind because that is what synthesis needs to hear:
 * a scalar of some sort will be accepted. `synthesizeValue`'s primitive branch then reads the
 * rendered text and answers with a literal, a number, a boolean or a string, in that order.
 */
function isMixedScalar(type: ts.Type): boolean {
  const parts = withoutNullish(type);
  if (parts.length === 0) return false;
  const scalar =
    ts.TypeFlags.String |
    ts.TypeFlags.StringLiteral |
    ts.TypeFlags.Number |
    ts.TypeFlags.NumberLiteral |
    ts.TypeFlags.Boolean |
    ts.TypeFlags.BooleanLiteral |
    ts.TypeFlags.BigInt |
    ts.TypeFlags.BigIntLiteral |
    ts.TypeFlags.Enum;
  return parts.every((part) => Boolean(part.flags & scalar));
}

/**
 * An INTERSECTION is an object. `everyPart` splits unions only, so `BarrierInput & { type }` arrives
 * whole and carries `TypeFlags.Intersection`, never `Object` — so this returned false and the
 * parameter was filed `other`, the bucket the comment below calls "nothing downstream can build".
 *
 * `getPropertiesOfType` merges intersection members correctly, so the contract COULD always have
 * recorded all of them; only this flag test stood in the way. The partial record is the dangerous
 * part: `barrier.monteCarloPrice` kept the seven fields it inherits and silently dropped the two
 * declared inline, so a key list derived from it would reject `type` and `barrierType` — refusing
 * valid calls in the name of fixing permissiveness.
 */
function isObject(type: ts.Type): boolean {
  // A branded scalar (`number & { __brand }`) is an intersection but is passed as a number.
  if (isBrandedScalar(type)) return false;
  return everyPart(type, (part) =>
    Boolean(part.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)),
  );
}

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
export function isBrandedScalar(type: ts.Type): boolean {
  return everyPart(type, (part) => {
    if (!(part.flags & ts.TypeFlags.Intersection)) return false;
    const members = (part as ts.IntersectionType).types ?? [];
    return members.some((member) =>
      Boolean(
        member.flags &
        (ts.TypeFlags.Number |
          ts.TypeFlags.NumberLiteral |
          ts.TypeFlags.String |
          ts.TypeFlags.StringLiteral |
          ts.TypeFlags.Boolean),
      ),
    );
  });
}

/** A rendered type that IS a series, anchored — not one that merely mentions a series inside itself. */
const SERIES_FORM =
  /^(readonly\s+)?(Array|ReadonlyArray|ArrayLike|Float\d+Array|Int\d+Array|Uint\d+Array)</;

/**
 * A series parameter — structurally first, and textually only as a whole-type fallback.
 *
 * RV12 — the textual test was a SUBSTRING match, so a type that merely mentioned a series anywhere
 * inside itself was classified as one. `deflatedSharpeRatio(statistics, trials)` declares
 *
 *     trials: { trialSharpes: ArrayLike<number> } | { trialCount: number; varianceSharpe: number }
 *
 * which is a two-branch union of objects. It rendered with `ArrayLike<` in it, was filed `series`,
 * and a `series` carries no field tree — so BOTH branches of a public contract went unrecorded, and
 * nothing downstream could enforce either one. The gate did not catch it because the gate only
 * admitted intersections, so the parameter was outside the population as well as outside the
 * contract: two independent reasons for the same silence.
 *
 * ANCHORING is what fixes it; `some` over the branches is what preserves everything else.
 * `checker.isArrayLikeType` is false for the `ArrayLike<T>` INTERFACE — it answers for arrays and
 * tuples — so the textual test carries real load and cannot simply be deleted. And a union that
 * mixes a scalar with a series (`second: number | ArrayLike<number>`, how the four `*Series` signal
 * helpers declare their comparand) is series-accepting: requiring every branch to be a series
 * demoted all four to `other`, the bucket nothing downstream can build. One branch being a series is
 * the question; a series mentioned INSIDE an object branch is not.
 */
function isSeries(checker: ts.TypeChecker, type: ts.Type, rendered: string): boolean {
  if (withoutNullish(type).some((part) => checker.isArrayLikeType(part))) return true;
  return rendered
    .split('|')
    .map((branch) => branch.trim())
    .some((branch) => SERIES_FORM.test(branch));
}

/**
 * The DECLARATION identity of a type — `<source file>#<Name>` — or null when it has none.
 *
 * R10. Contract identity was `<package>:<rendered type name>`, and a rendered name is not an
 * identity: `@totalfinance/technical-analysis` declares `PeriodParameters` in TEN modules, and `bars.ts`
 * (which ATR uses) makes `period` optional while the other nine make it required. Keying on the name
 * meant one of the ten won arbitrarily, and the SAME `atr` function earned opposite verdicts through
 * different import paths. The interim fix — drop any name that means two things anywhere — was safe
 * and expensive: it discarded the shape of every homonym in the workspace.
 *
 * A declaration is unambiguous by construction. Two types with one name have two declarations, so
 * they get two identities and each parameter joins to the one it actually names.
 */
function typeDeclarationId(checker: ts.TypeChecker, type: ts.Type): string | null {
  /**
   * A declaration identity, or null. NEVER a synthetic one, and never a constituent standing in for
   * the alias that owns it.
   *
   * RV12 — two defects, both of which made this field quietly wrong rather than absent:
   *
   *   THE ROOT ALIAS WAS NEVER ASKED. `parts` split the union on the first line, so a named union
   *   alias resolved to whichever branch came first — or, for `FromChainOptions`, to nothing at all.
   *   A named alias OWNS its root contract; it is not a synonym for its first constituent.
   *
   *   `__type` WAS ACCEPTED AS A NAME. TypeScript names an anonymous object literal type `__type`,
   *   so 553 parameters carried a "declaration identity" that collapsed 179 distinct occurrences
   *   into 48 keys. Reported coverage was 94%; real named coverage was 84%. An identity that
   *   several unrelated boundaries share is worse than no identity, because a join on it silently
   *   merges them.
   *
   * An anonymous inline intersection or union legitimately has NO declaration. It stays
   * self-describing through `fieldTree` and `branchFields`, and its identity as a boundary is its
   * occurrence — see the identity model in the manifest identity helper — not a name invented here.
   */
  const named = (symbol: ts.Symbol | undefined): string | null => {
    const declaration = symbol?.declarations?.[0];
    if (!symbol || !declaration) return null;
    // `__type`, `__object`, … — TypeScript's synthetic names for things that have no name.
    if (symbol.name.startsWith('__')) return null;
    const file = declaration.getSourceFile().fileName;
    /**
     * Only declarations inside this repository get an identity.
     *
     * The first version returned the raw filename for anything, which put
     * `/Users/<me>/…/node_modules/.pnpm/typescript@5.9.3/…/lib.es5.d.ts#Array` into a committed
     * artifact — an identity that differs per machine, per checkout and per TypeScript patch version.
     * That is ledger C02 (never use an unstable locator as an identity) arriving by a new route, and
     * it would have broken the drift gate for anyone but me. A lib type has no contract of ours to
     * join to anyway.
     */
    if (!file.includes('/packages/')) return null;
    return `packages/${file.split('/packages/')[1]}#${symbol.name}`;
  };

  // The ROOT first: a named alias owns its contract, union or not.
  const rootAlias = named(type.aliasSymbol);
  if (rootAlias) return rootAlias;
  if (!type.isUnion()) return named(type.getSymbol());

  /**
   * NULLISH IS A PROPERTY OF THE SLOT, NOT OF THE SHAPE — the same lesson this file already records
   * for intersection trees. `Foo | undefined` is an optional parameter of a NAMED type, not an
   * anonymous union, and it must keep `Foo`'s declaration identity. Stripping the union to its
   * meaningful parts before deciding is what separates the two cases; skipping this step dropped
   * named coverage from 84% to 42% on the first attempt, by treating every optional parameter as
   * anonymous.
   */
  const meaningful = type.types.filter(
    (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
  );
  if (meaningful.length === 1) {
    const only = meaningful[0] as ts.Type;
    return named(only.aliasSymbol) ?? named(only.getSymbol());
  }

  /**
   * A genuinely anonymous union of several shapes — `A | B` written inline, with no alias naming the
   * whole. No single declaration owns it, so it has none: returning one constituent's identity would
   * claim the contract of a shape the caller may never send, which is the defect that let a union
   * alias resolve to its first branch. `branchFields` carries the real answer.
   */
  return null;
}

/**
 * The admissible values, when a parameter's type RESOLVES to a closed set of string literals.
 *
 * The rendered type text is the name the declaration used, and a name is not a set: `field: Field` says
 * nothing a consumer — or a synthesizer — can act on, while the alias it points at says
 * `'open' | 'high' | 'low' | 'close'`. Twelve `FeaturePipeline` boundaries were unmeasurable for
 * exactly that reason, and the library spelled out what it wanted every time: "field must be one of
 * open | high | low | close. Received "testField"." The checker resolves the alias; only the artifact
 * had forgotten to write down the answer.
 *
 * Closed sets ONLY. A union carrying `string` admits anything, so its literals are examples rather than
 * a contract, and recording them as if they were a contract is how a synthesizer starts believing a
 * suggestion is a rule. `undefined`/`null` members are skipped because optionality is recorded
 * separately.
 */
/**
 * A PARAMETER'S closed domain — the same rule the FIELD level uses, because it is the same question.
 *
 * This was a second, string-only implementation: it returned `undefined` on the first part that was
 * not a `StringLiteral`, so a parameter declared `weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6` or
 * `explain: true` published no domain while the identical type one level down published one. RV27
 * widened the field-level recorder and left this untouched — the exact shape of defect that round was
 * about, surviving in the sibling nobody looked at. It surfaced the moment a gate derived domains
 * independently and compared them, which is what a real parity check buys over a count.
 *
 * Delegating rather than re-deriving: two implementations of "what values does this type admit" is
 * how one declaration gets two answers depending on where it is asked.
 */
function literalMembers(type: ts.Type): LiteralValue[] | undefined {
  return literalDomain(type) ?? undefined;
}

/**
 * Does this tree carry a RECEIVER anywhere beneath it — an object that is nothing but methods?
 *
 * Recursive because the protocol object is rarely the parameter itself. `defineTool`'s definition
 * holds a Standard Schema, whose own members are a mix, but whose `~standard` member is a pure method
 * bag; a one-level test missed it and left 116 built-versus-named mismatches on that one boundary.
 */
/**
 * Parameters whose structure is DELIBERATELY not described, by name and with the reason.
 *
 * A curated judgment, held the way this repository holds curated judgments: named, reasoned, and
 * small enough to read. The structural tests above catch class receivers and pure method bags; this
 * holds the one case they cannot see.
 *
 * `defineTool` accepts a Standard Schema in `definition.schema`. The protocol's own members are split
 * between data and methods, and its method bag lives under `~standard`, which `members()` filters out
 * as non-public — so nothing structural distinguishes it from a request object. Describing it made
 * the harness try to author `safeParse`, `toJSONSchema` and `~standard.validate` and answer "nothing"
 * for each: 116 built-versus-named mismatches on one boundary, replacing an honest "no structure"
 * with a false description. A tool definition is assembled by the caller from a schema they already
 * hold; it is not a request anyone writes field by field.
 */
const UNDESCRIBABLE_PARAMETERS: ReadonlyMap<string, string> = new Map([
  [
    'packages/mcp/dist/tool-kit.d.ts#defineTool|definition',
    'carries a Standard Schema — an external protocol object, obtained rather than authored',
  ],
]);

function carriesReceiver(nodes: readonly FieldNode[] | undefined): boolean {
  for (const node of nodes ?? []) {
    const fields = node.fields;
    if (fields && fields.length > 0 && fields.every((field) => field.kind === 'function')) {
      return true;
    }
    if (carriesReceiver(fields)) return true;
  }
  return false;
}

function parameterInfo(checker: ts.TypeChecker, parameter: ts.Symbol): SignatureParameter {
  const declaration = declarationOf(parameter);
  const type = declaration
    ? checker.getTypeOfSymbolAtLocation(parameter, declaration)
    : checker.getTypeOfSymbol(parameter);
  const shapeType = constrainedType(checker, type);
  const rendered = typeText(checker, type, declaration);
  const parameterDeclaration = declaration && ts.isParameter(declaration) ? declaration : undefined;
  const intersected = withoutNullish(shapeType);
  const declaredParts = withoutNullish(type);
  const inferredGeneric =
    declaredParts.length === 1 && Boolean(declaredParts[0]!.flags & ts.TypeFlags.TypeParameter);
  const instantiatedGeneric =
    !inferredGeneric &&
    intersected.some((part) => {
      if (!(part.flags & ts.TypeFlags.Object)) return false;
      const object = part as ts.ObjectType;
      if (!(object.objectFlags & ts.ObjectFlags.Reference)) return false;
      return checker.getTypeArguments(part as ts.TypeReference).length > 0;
    });
  /**
   * Ask every meaningful arm, not only the union wrapper, whether the slot admits a callback.
   *
   * TypeScript exposes no call signatures on `Callback | undefined`, so checking the wrapper made
   * optional callbacks (`ShortRateTree.rollback(atNode?)`) look like objects and discarded the very
   * signature a caller must implement. The shared descriptor strips nullish arms and retains every
   * overload; use its answer for classification as well as emission so the two cannot disagree.
   */
  const resolvedCallSignatures = callableSignatures(checker, shapeType);
  const kind = isNumeric(shapeType, rendered)
    ? 'numeric'
    : isPrimitive(shapeType, rendered)
      ? 'primitive'
      : isSeries(checker, shapeType, rendered)
        ? 'series'
        : resolvedCallSignatures.length > 0
          ? 'callback'
          : isObject(shapeType)
            ? 'object'
            : /**
               * A union MIXING scalars is still a scalar, and nothing downstream can build an `other`.
               *
               * Every test above is an `every`, so `from: string | number` — how `calendarSkew` and
               * `forwardVolatility` declare a tenor that may be named or numeric — matched none of
               * them and fell through. `contract-fields.ts` already applies this rule one level down
               * for object FIELDS; a parameter deserves the same reading, and the two disagreeing is
               * how the same declaration gets two answers depending on where it appears.
               */
              isMixedScalar(shapeType)
              ? 'primitive'
              : 'other';
  const typeDeclaration = typeDeclarationId(checker, type);
  /**
   * Only for intersections: everything else is looked up by declaration and must keep coming from
   * the one indexed source, or the same type gets two answers.
   *
   * NULLISH IS STRIPPED FIRST. An OPTIONAL intersection is declared `(A & B) | undefined`, so the
   * top-level type is a UNION and the `Intersection` flag is false — six parameters
   * (`makeLinearInterpolator`, `extremeValueTailRisk` and their aliases) kept an empty tree on the
   * first pass for exactly that reason. "Optional" is a property of the slot, not of the shape the
   * caller passes.
   */
  const intersectionTree =
    kind === 'object' && intersected.some((part) => Boolean(part.flags & ts.TypeFlags.Intersection))
      ? fieldTreeForType(
          checker,
          intersected.length === 1 ? (intersected[0] as ts.Type) : shapeType,
        )
      : undefined;
  /**
   * EVERY ARM AS AN ARM — the parameter level's half of the generalized branch node, and the fix for
   * the class of union this file could not see at all.
   *
   * `branchFields` above is `fieldTreeForType` per arm, which answers ONE question: what named
   * members does this arm declare? For `ArrayLike<number>` the answer is none — `members()` drops
   * declarations from `lib.*.d.ts`, deliberately and correctly, because `length` is not part of
   * anyone's contract. The arm then read as `null`, and the `.some(tree => tree !== null)` gate that
   * followed threw away the WHOLE union when no arm survived: `number | ArrayLike<number>` recorded
   * no `branchFields`, no `branchTypes`, nothing. One grammar stood in for two, silently, on 78
   * occurrences across 33 implementations of the current public surface.
   *
   * `armNodes` is the same walk `contract-fields.ts` uses one level down, so an arm is described the
   * way any other node is — kind, element, tuple, literals, call signature, nested arms — and an arm
   * with no named members is still an arm. That the two levels now share one walker is the point:
   * a parameter union and a field union disagreeing about the same declared type is what produced
   * two verdicts for one callable.
   */
  /**
   * THE SAME SEMANTIC RULE THE FIELD LEVEL USES — `semanticArms`, not "more than one part".
   *
   * The two levels disagreeing about what counts as a union is how one declaration gets two answers
   * depending on where it appears. `withoutNullish(type).length > 1` admitted `boolean` (which the
   * checker models as `true | false`) and admitted a closed LITERAL domain, which is already fully
   * recorded as `literals`.
   *
   * The literal exclusion is a measured decision, not a preference. There are 2,494 literal-domain
   * nodes on the surface and a single record carries 81 admitted values; enumerating each as its own
   * grammar alternative would push several boundaries past `VARIANT_LIMIT`, and a truncated sweep is
   * forbidden precisely because it reads as exhaustive. Enum values stay measurable through the
   * literal machinery, where describing them costs one field instead of N alternatives.
   */
  const arms = semanticArms(shapeType);
  const branches: BranchNode[] | undefined = arms
    ? armNodes(checker, arms, 0, new Set([type, shapeType]))
    : undefined;
  const literals = literalMembers(shapeType);
  const callSignatures = kind === 'callback' ? resolvedCallSignatures : undefined;
  const callSignature = callSignatures?.[0]
    ? {
        parameters: callSignatures[0].parameters.length,
        returns: callSignatures[0].returns,
      }
    : undefined;
  /**
   * A top-level callback deserves the same return contract as a callback field.
   *
   * `makeIndicator(make)` returns an `IndicatorStream`; recording only its rendered name left the
   * stream's `next`/`toJSON` callable surface unreachable even though `walkField` described identical
   * callbacks nested in objects. Walk the first overload's value under the shared depth budget—the
   * first overload is also the one synthesis implements, while `callSignatures` retains all of them.
   */
  let callbackReturn: FieldNode | undefined;
  if (kind === 'callback') {
    for (const part of withoutNullish(shapeType)) {
      const signature = checker.getSignaturesOfType(part, ts.SignatureKind.Call)[0];
      if (!signature) continue;
      callbackReturn = walkField(
        checker,
        '()',
        signature.getReturnType(),
        false,
        1,
        new Set([shapeType]),
      );
      break;
    }
  }

  /**
   * A SEQUENCE'S ELEMENT AND A TUPLE'S POSITIONS AS COMPLETE NODES.
   *
   * `elementFieldTree` and `tupleFieldTrees` describe them as flat member lists, which is the same
   * shape — and the same limitation — as the `branchFields` arrays this migration retired: a list of
   * members can express an object and nothing else. Where the element is itself a UNION, its members
   * are looked up by type NAME and resolve to the merged view, so the arms vanish.
   *
   * `bootstrap(instruments: Array<BootstrapInstrument>)` is the measured case. `BootstrapInstrument`
   * has four arms — deposit, future, FRA, swap — and the published element contract was a single
   * member, `type`, being the only one all four share. A caller building a swap was handed a contract
   * that described none of its fields, and the two nested unions under it (`fixedFrequency`,
   * `floatFrequency`, six arms each) were not described at all. `analyze(callArguments)` is the tuple
   * form of the same hole: member lists per position, no position nodes, so position 0's union had
   * nowhere to live.
   *
   * `walkField` is the one node builder — the same one `armNodes` uses — so an element is described
   * exactly as any other node is, arms included. The flat lists stay for now because consumers still
   * read them; they are a projection of these nodes rather than the only record of them.
   */
  /**
   * A CHECKER-BUILT TREE FOR EVERY OBJECT PARAMETER, at its EXACT public instantiation.
   *
   * `contract-inventory.ts` resolves a parameter's members by looking its declaration up in an index
   * built from EXPORTED types. A request type that is not exported has an exact `typeDeclaration` and
   * no entry, so the lookup misses and the parameter reaches the harness with no structure at all —
   * `priceOption(input)`, `americanExercise(input)`, `americanImpliedVolatility(input)`,
   * `compareEngines(input)`, `buildStrategy(request)` and the Kalman family among them. Three of those
   * publish `enforced`, which is a verdict about a contract nothing had read.
   *
   * A numeric ceiling let 30 of these through under the description "a shape the harness cannot reason
   * about at all". Only 7 were that. The rest are ordinary request objects, and the checker can read
   * every one of them — the same walk that already serves intersections and arms.
   *
   * A generic declaration and one of its instantiations are not the same contract. Looking up
   * `Schema<Item>` by the declaration `Schema<Output>` replaced every nested return of `Item` with an
   * unrelated binder name; looking up `Indicator<BarInput, Out>` as `Indicator<In, Out>` did the same
   * to callback parameters. The exact parameter type is compiler-owned and must win. The declaration
   * index remains a fallback for shapes this per-parameter walk deliberately declines (receivers).
   */
  const walkedTree =
    (kind === 'object' || kind === 'callback') && !(intersectionTree && intersectionTree.length > 0)
      ? fieldTreeForType(
          checker,
          intersected.length === 1 ? (intersected[0] as ts.Type) : shapeType,
        )
      : undefined;
  /**
   * A RECEIVER IS OBTAINED, NOT DESCRIBED — so it is not described here either.
   *
   * `atmTermStructure(surface: VolatilitySurface)` takes a class that is entirely methods. Synthesis
   * handles it by getting a real instance; describing its members produces a contract whose every
   * field is a function, and the builder answers "nothing" for each. Attaching a tree for these
   * turned one honest "no structure" into 186 built-versus-named mismatches across five volatility
   * facades and the MCP tool definition — a worse record than the gap it replaced, and a false one.
   *
   * A CLASS INSTANCE is the test, not "every member happens to be a method". `VolatilitySurface`
   * carries a data property alongside its methods, so an all-callable rule let it through and the
   * mismatches stayed. What makes it a receiver is that it is a class: a request contract is never
   * one, and an instance is something synthesis gets hold of rather than something a caller writes.
   *
   * `defineTool`'s definition is the remaining case and it is not a class — an inline literal carrying
   * a Standard Schema, an external protocol whose members are themselves receivers (`safeParse`,
   * `toJSONSchema`, `~standard.validate`). It stays on `UNDESCRIBED_ALLOWLIST` in
   * `union-checker-parity.test.ts`, named with that reason, which is the category the retired ceiling
   * was written for and now the only member of it.
   */
  const receiverType = intersected.length === 1 ? (intersected[0] as ts.Type) : shapeType;
  const allCallable = (nodes: readonly FieldNode[] | undefined): boolean =>
    nodes !== undefined && nodes.length > 0 && nodes.every((node) => node.kind === 'function');
  const isReceiver =
    kind === 'object' &&
    (Boolean((receiverType.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) ||
      allCallable(walkedTree) ||
      /**
       * A parameter that CARRIES a receiver is one too, for the purpose of describing it.
       *
       * `defineTool({ name, schema, handler })` is the case: `schema` is a Standard Schema, an external
       * protocol made entirely of methods (`safeParse`, `toJSONSchema`, `~standard.validate`). Describing
       * the definition means describing that, and the builder answers "nothing" for every one — 116
       * built-versus-named mismatches on a single boundary. The protocol object is obtained from the
       * caller, never authored field by field, so the honest record is that this parameter has no
       * describable structure.
       */
      carriesReceiver(walkedTree));
  /** `<declaration file>#<owner>|<parameter>` — the key `UNDESCRIBABLE_PARAMETERS` is written in. */
  const owner = parameterDeclaration?.parent;
  const ownerName =
    owner && ts.isFunctionLike(owner) && owner.name && ts.isIdentifier(owner.name)
      ? owner.name.text
      : '';
  const policyKey = declaration
    ? `${relative(ROOT, declaration.getSourceFile().fileName)}#${ownerName}|${parameter.name}`
    : '';
  /**
   * A callback FIELD is authored data; an object made entirely of methods is a receiver.
   *
   * Required callbacks such as `{ shouldClose: CloseRule }` were formerly dropped alongside
   * `engine?: OptionPricingEngine`. Those are different contracts: the first is a function the caller
   * supplies and callable metadata can synthesize; the second is an obtained protocol object whose
   * methods should not be authored one by one. Retain function nodes, continue omitting pure method
   * bags, and refuse the whole description if such a receiver is required.
   */
  const receiverMember = (node: FieldNode): boolean =>
    node.kind === 'object' &&
    (node.fields?.length ?? 0) > 0 &&
    node.fields!.every((field) => field.kind === 'function');
  const describable =
    walkedTree && !walkedTree.some((node) => receiverMember(node) && node.optional !== true)
      ? walkedTree.filter((node) => !receiverMember(node))
      : undefined;
  const checkerFieldTree =
    describable && !isReceiver && !UNDESCRIBABLE_PARAMETERS.has(policyKey)
      ? describable
      : undefined;

  const tupleTypes = kind === 'series' ? tupleElementTypes(checker, shapeType) : null;
  /**
   * A TUPLE HAS POSITIONS, NOT AN ELEMENT.
   *
   * `elementTypeOf` answers for a tuple too — it is array-like, so it returns the union of the
   * positions. That is a fact about how the checker models the type, not a contract anyone declares:
   * `analyze(callArguments: [input: AnalyzeInput, options?: AnalyzeOptions])` published a 2-arm union
   * at `[]` that no caller can pass, because there is no "element" to pass. Positions win where both
   * would answer.
   */
  const elementType = kind === 'series' && !tupleTypes ? elementTypeOf(checker, shapeType) : null;
  // `[]` is the name an element node carries everywhere else in the artifact; the slot is the
  // sequence's, so the element is never optional in its own right.
  const element = elementType
    ? walkField(checker, '[]', elementType, false, 1, new Set([type, shapeType]))
    : undefined;
  const tuple = tupleTypes?.map((slot, index) =>
    walkField(checker, String(index), slot.type, slot.optional, 1, new Set([type, shapeType])),
  );

  return {
    name: parameter.name,
    type: rendered,
    ...(typeDeclaration ? { typeDeclaration } : {}),
    ...(intersectionTree && intersectionTree.length > 0 ? { fieldTree: intersectionTree } : {}),
    ...(branches ? { branches } : {}),
    ...(checkerFieldTree && checkerFieldTree.length > 0 ? { checkerFieldTree } : {}),
    ...(element ? { element } : {}),
    ...(tuple && tuple.length > 0 ? { tuple } : {}),
    ...(literals ? { literals } : {}),
    ...(callSignature ? { callSignature } : {}),
    ...(callSignatures && callSignatures.length > 0 ? { callSignatures } : {}),
    ...(callbackReturn ? { returns: callbackReturn } : {}),
    ...(inferredGeneric ? { inferredGeneric: true as const } : {}),
    ...(instantiatedGeneric ? { instantiatedGeneric: true as const } : {}),
    optional: Boolean(
      parameterDeclaration?.questionToken ||
      parameterDeclaration?.initializer ||
      parameter.flags & ts.SymbolFlags.Optional,
    ),
    rest: Boolean(parameterDeclaration?.dotDotDotToken),
    kind,
  };
}

function inferGrammar(path: string, parameters: SignatureParameter[]): CallGrammar {
  if (parameters.length === 0) return 'none';
  if (parameters.some((parameter) => /Columns(?:<.*>)?$/.test(parameter.type))) {
    return 'columnar';
  }
  if (parameters.length === 1) {
    return parameters[0]!.kind === 'object' ? 'object' : 'single-subject';
  }
  if (parameters.length === 2 && parameters[1]!.optional && parameters[1]!.kind === 'object') {
    return parameters[0]!.kind === 'series' ? 'series-options' : 'subject-options';
  }
  return 'natural-positional';
}

/**
 * The declaration's NAME CHAIN — `Outer.inner` for a nested member, walking up through every
 * enclosing named declaration.
 *
 * This is the stable half of the implementation identity. The name chain is what a reader can look
 * up, and it does not move when unrelated code above it changes.
 */
function declarationNameChain(declaration: ts.Declaration): string {
  const parts: string[] = [];
  for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
    if (ts.isSourceFile(node)) break;
    const named = node as ts.NamedDeclaration;
    if (named.name !== undefined && ts.isIdentifier(named.name)) parts.unshift(named.name.text);
    else if (named.name !== undefined && ts.isStringLiteral(named.name))
      parts.unshift(named.name.text);
  }
  return parts.length > 0 ? parts.join('.') : '(anonymous)';
}

/**
 * Stable identity for the DECLARATION a public path resolves to (spec 3B.0: "Freeze stable IDs").
 *
 * Previously `<file>:<characterOffset>`. A character offset into a generated `.d.ts` changes whenever
 * anything above it is edited, so every unrelated declaration churned this field and it could not be
 * frozen or diffed — the failure decision-ledger C02 records: never use a declaration's position as
 * its identity. Two public paths that resolve to ONE declaration now share one implementation
 * identity, which is what lets alias fan-out be counted separately from real work.
 */
function implementationId(symbol: ts.Symbol): string {
  const declaration = declarationOf(symbol);
  if (!declaration) return 'unknown';
  const file = relative(ROOT, declaration.getSourceFile().fileName);
  return `${file}#${declarationNameChain(declaration)}`;
}

function signatureDetails(
  checker: ts.TypeChecker,
  signatures: readonly ts.Signature[],
): PublicCallable['signatures'] {
  return signatures.map((signature) => ({
    parameters: signature.getParameters().map((parameter) => parameterInfo(checker, parameter)),
    returns: typeText(checker, checker.getReturnTypeOfSignature(signature), signature.declaration),
  }));
}

function callableOwner(owner: PublicCallable['owner'], path: string): PublicCallable['owner'] {
  if (owner !== 'export') return owner;
  return path.endsWith('.constructor') ? 'constructor' : owner;
}

/**
 * Bare identities vacated by a collision.
 *
 * Once a bare identity is split, every later arrival must take a qualified one too, or a third
 * colliding entrypoint would silently reclaim the bare name — `covariance` arrives from `./math`,
 * `./risk` and `./technical-analysis`.
 *
 * A set rather than a scan: the scan it replaces was O(records) per insert, so O(n^2) over 6,580
 * callables. It was fast enough today and would not have stayed that way.
 */
const vacatedIdentities = new WeakMap<Map<string, PublicCallable>, Set<string>>();

/**
 * The vacated set for THIS generation, keyed on its records map.
 *
 * Per-run rather than module-global on purpose: the conformance suite generates the manifest twice in
 * one process to prove determinism, and a set that survived between runs would make the second run
 * start from the first one's conclusions. State that leaks across generations is precisely what a
 * determinism gate is supposed to catch, and the fix belongs here rather than in a reset someone has
 * to remember to call.
 */
function vacatedIn(records: Map<string, PublicCallable>): Set<string> {
  const existing = vacatedIdentities.get(records);
  if (existing) return existing;
  const fresh = new Set<string>();
  vacatedIdentities.set(records, fresh);
  return fresh;
}

function upsertCallable(
  records: Map<string, PublicCallable>,
  checker: ts.TypeChecker,
  base: Omit<PublicCallable, 'grammar' | 'rationale' | 'signatures'>,
  symbol: ts.Symbol,
  signatures: readonly ts.Signature[],
): void {
  if (signatures.length === 0) return;
  const implementation = implementationId(originalSymbol(checker, symbol));

  /**
   * The same NAME from two entrypoints is not necessarily the same callable.
   *
   * This merged on `${package}:${path}` alone and appended the entrypoint, which assumed it was. For
   * 17 umbrella exposures it is not: `totalfinance/technical-analysis` exports a two-argument series
   * `skew` and `totalfinance/volatility` exports a one-argument object-request `skew`. Merging recorded
   * ONE identity that named the volatility declaration, and enforcement then measured whichever
   * function module resolution happened to reach first — so the record claimed one implementation
   * while carrying the other's probe evidence. That is identity corruption, not thin coverage, and
   * `covariance` collapsed three ways.
   *
   * Detected statically: different declarations mean different callables. On collision BOTH sides are
   * re-keyed by their entrypoint (`totalfinance/volatility:skew`), including the one already inserted, so
   * the surviving identity never depends on visit order.
   */
  const qualify = (entrypoint: string): string =>
    entrypoint === '.' ? base.id : `${base.package}${entrypoint.slice(1)}:${base.path}`;

  const existing = records.get(base.id);
  if (existing) {
    if (existing.implementation === implementation) {
      for (const entrypoint of base.entrypoints) {
        if (!existing.entrypoints.includes(entrypoint)) existing.entrypoints.push(entrypoint);
      }
      return;
    }
    // A genuine collision. Move the incumbent to its own qualified identity, then fall through so
    // this callable is inserted under its own.
    records.delete(base.id);
    const incumbentId = qualify(existing.entrypoints[0] ?? '.');
    records.set(incumbentId, { ...existing, id: incumbentId });
    // Only mark the bare name vacated if the incumbent did not keep it. An incumbent exported from
    // the ROOT entrypoint legitimately retains the unqualified identity, and the subpath exports
    // qualify around it.
    if (incumbentId !== base.id) vacatedIn(records).add(base.id);
  }

  const id =
    records.has(base.id) || vacatedIn(records).has(base.id)
      ? qualify(base.entrypoints[0] ?? '.')
      : base.id;
  const details = signatureDetails(checker, signatures);
  const inferred = inferGrammar(base.path, details[0]?.parameters ?? []);
  const policy = SIGNATURE_POLICIES[base.id];
  records.set(id, {
    ...base,
    id,
    owner: callableOwner(base.owner, base.path),
    implementation,
    grammar: policy?.grammar ?? inferred,
    ...(policy?.rationale ? { rationale: policy.rationale } : {}),
    signatures: details,
  });
}

function memberIsPublic(member: ts.Symbol): boolean {
  const declaration = declarationOf(member);
  if (!declaration) return false;
  const source = declaration.getSourceFile().fileName;
  if (!source.startsWith(PACKAGES)) return false;
  const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
  return !modifiers?.some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
      modifier.kind === ts.SyntaxKind.StaticKeyword,
  );
}

function namedType(type: ts.Type): { name: string; type: ts.Type } | null {
  if (type.isUnion()) {
    const candidates = type.types.map(namedType).filter((value) => value !== null);
    return candidates.length === 1 ? candidates[0]! : null;
  }
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol || symbol.name === '__type' || symbol.name === '__object') return null;
  return { name: symbol.name, type };
}

function addTypeMethods(
  records: Map<string, PublicCallable>,
  checker: ts.TypeChecker,
  pkg: PackageSource,
  typeName: string,
  type: ts.Type,
  entrypoint: string,
  owner: 'interface-method' | 'class-method' | 'artifact-method',
): void {
  for (const member of checker.getPropertiesOfType(type)) {
    if (!memberIsPublic(member)) continue;
    const memberType = typeOfSymbol(checker, member);
    if (!memberType) continue;
    const signatures = checker.getSignaturesOfType(memberType, ts.SignatureKind.Call);
    if (signatures.length === 0) continue;
    const path = `${typeName}#${member.name}`;
    const id = `${pkg.package}:${path}`;
    upsertCallable(
      records,
      checker,
      {
        id,
        package: pkg.package,
        path,
        owner,
        entrypoints: [entrypoint],
        implementation: '',
      },
      member,
      signatures,
    );
  }
}

function resolveDottedSymbol(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  dottedPath: string,
): { symbol: ts.Symbol; type: ts.Type } | null {
  const [head, ...tail] = dottedPath.split('.');
  let symbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((candidate) => candidate.name === head);
  if (!symbol) return null;
  let type = typeOfSymbol(checker, symbol);
  if (!type) return null;
  for (const part of tail) {
    const property = checker.getPropertyOfType(type, part);
    if (!property) {
      // Runtime namespaces can be declaration-backed index maps (for example the generated
      // `candlesticks.<pattern>` catalog). The runtime manifest gives us the concrete member name;
      // the declaration's string-index value gives us that member's callable type.
      const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String);
      if (!indexed) return null;
      type = indexed;
      continue;
    }
    symbol = property;
    type = typeOfSymbol(checker, property);
    if (!type) return null;
  }
  return { symbol, type };
}

function addReturnArtifact(
  records: Map<string, PublicCallable>,
  checker: ts.TypeChecker,
  pkg: PackageSource,
  signature: ts.Signature,
  entrypoint: string,
): void {
  const returnType = checker.getReturnTypeOfSignature(signature);
  const named = namedType(returnType);
  if (!named) return;
  addTypeMethods(records, checker, pkg, named.name, named.type, entrypoint, 'artifact-method');
}

export function generatePublicSignatureManifest(): PublicSignatureManifest {
  const sources = packageSources();
  const rootNames = [...new Set(sources.packages.flatMap((pkg) => [...pkg.entries.values()]))];
  const program = ts.createProgram(rootNames, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    baseUrl: ROOT,
    paths: sources.paths,
    types: [],
  });
  const checker = program.getTypeChecker();
  const records = new Map<string, PublicCallable>();

  /**
   * The umbrella, enumerated from its DECLARATION FILE rather than from a runtime manifest.
   *
   * The manifest-driven loop below skips any package without `tools/manifest/packages/<dir>.json`, and
   * the umbrella deliberately has none — classifying 2,000 re-exports would be curation noise, and
   * `MANIFEST_TIERS` says as much. But the declaration file is the real authority for "what can a user
   * import," and it needs no role classification precisely because an umbrella member's role belongs
   * to the scoped package it comes from. Every path recorded here collapses onto an existing
   * implementation identity, which is what identity #1 vs #2 exists to show.
   */
  for (const pkg of sources.packages.filter((source) => source.package === 'totalfinance')) {
    for (const [entrypoint, declaration] of pkg.entries) {
      const source = program.getSourceFile(declaration);
      const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
      if (!moduleSymbol) continue;
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const exportedType = typeOfSymbol(checker, exported);
        if (!exportedType) continue;
        const callSignatures = checker.getSignaturesOfType(exportedType, ts.SignatureKind.Call);
        if (callSignatures.length > 0) {
          upsertCallable(
            records,
            checker,
            {
              id: `${pkg.package}:${exported.name}`,
              package: pkg.package,
              path: exported.name,
              owner: 'export',
              entrypoints: [entrypoint],
              implementation: '',
            },
            exported,
            callSignatures,
          );
          continue;
        }
        /**
         * A domain namespace (`totalfinance.volatility`, `totalfinance.options`) — record its members
         * RECURSIVELY, because the real paths are nested: `totalfinance.options.blackScholes.price` is what
         * a user writes, and a one-level walk recorded `options.blackScholes` (an object, not callable)
         * and then stopped, missing the function entirely.
         *
         * Depth 3 covers every shape this library has (`domain.namespace.member`, plus a `.explain`
         * companion) without wandering into returned artifacts, which the scoped inventory already
         * covers under their own package.
         */
        if (!isNamespaceLikeType(checker, exportedType)) continue;
        const walkNamespace = (type: ts.Type, path: string, depth: number): void => {
          if (depth > 3) return;
          for (const member of namespaceMembers(checker, type)) {
            const memberType = typeOfSymbol(checker, member);
            if (!memberType) continue;
            const memberPath = `${path}.${member.name}`;
            const memberSignatures = checker.getSignaturesOfType(memberType, ts.SignatureKind.Call);
            if (memberSignatures.length > 0) {
              upsertCallable(
                records,
                checker,
                {
                  id: `${pkg.package}:${memberPath}`,
                  package: pkg.package,
                  path: memberPath,
                  owner: 'export',
                  entrypoints: [entrypoint],
                  implementation: '',
                },
                member,
                memberSignatures,
              );
            }
            // A callable can ALSO carry members (`rsi.explain`, `blackScholes.price`), so descend
            // either way when the member is namespace-shaped.
            if (isNamespaceLikeType(checker, memberType) || memberSignatures.length > 0) {
              walkNamespace(memberType, memberPath, depth + 1);
            }
          }
        };
        walkNamespace(exportedType, exported.name, 1);
      }
    }
  }

  for (const pkg of sources.packages) {
    const runtimeManifest = readManifest(pkg.domain);
    if (!runtimeManifest) continue;

    for (const [path, runtime] of Object.entries(runtimeManifest.exports)) {
      if (runtime.kind !== 'function' && runtime.kind !== 'class') continue;
      const entrypoint = runtime.entrypoints[0];
      if (!entrypoint) continue;
      const sourcePath = pkg.entries.get(entrypoint);
      const source = sourcePath ? program.getSourceFile(sourcePath) : undefined;
      const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
      if (!moduleSymbol) continue;
      const resolved = resolveDottedSymbol(checker, moduleSymbol, path);
      if (!resolved) continue;

      const callSignatures = checker.getSignaturesOfType(resolved.type, ts.SignatureKind.Call);
      upsertCallable(
        records,
        checker,
        {
          id: `${pkg.package}:${path}`,
          package: pkg.package,
          path,
          owner: 'export',
          entrypoints: [...runtime.entrypoints],
          role: runtime.role,
          implementation: '',
        },
        resolved.symbol,
        callSignatures,
      );
      for (const signature of callSignatures)
        addReturnArtifact(records, checker, pkg, signature, entrypoint);

      if (runtime.hasExplain || runtime.hasStream) {
        for (const companion of ['explain', 'stream', 'fromJSON']) {
          const member = checker.getPropertyOfType(resolved.type, companion);
          if (!member) continue;
          const memberType = typeOfSymbol(checker, member);
          if (!memberType) continue;
          upsertCallable(
            records,
            checker,
            {
              id: `${pkg.package}:${path}.${companion}`,
              package: pkg.package,
              path: `${path}.${companion}`,
              owner: 'export',
              entrypoints: [...runtime.entrypoints],
              role: runtime.role,
              implementation: '',
            },
            member,
            checker.getSignaturesOfType(memberType, ts.SignatureKind.Call),
          );
        }
      }

      if (runtime.kind === 'class') {
        const constructSignatures = checker.getSignaturesOfType(
          resolved.type,
          ts.SignatureKind.Construct,
        );
        upsertCallable(
          records,
          checker,
          {
            id: `${pkg.package}:${path}.constructor`,
            package: pkg.package,
            path: `${path}.constructor`,
            owner: 'constructor',
            entrypoints: [...runtime.entrypoints],
            role: runtime.role,
            implementation: '',
          },
          resolved.symbol,
          constructSignatures,
        );
        const instance = constructSignatures[0]
          ? checker.getReturnTypeOfSignature(constructSignatures[0])
          : checker.getDeclaredTypeOfSymbol(originalSymbol(checker, resolved.symbol));
        addTypeMethods(records, checker, pkg, path, instance, entrypoint, 'class-method');
      }
    }

    // Extension interfaces and exported artifact types can contain public methods that have no
    // runtime value of their own (pricing engines, curves, streams, provider contracts, etc.).
    for (const [entrypoint, sourcePath] of pkg.entries) {
      const source = program.getSourceFile(sourcePath);
      const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
      if (!moduleSymbol) continue;
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const original = originalSymbol(checker, exported);
        if (!(original.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) continue;
        const declared = checker.getDeclaredTypeOfSymbol(original);
        addTypeMethods(
          records,
          checker,
          pkg,
          exported.name,
          declared,
          entrypoint,
          'interface-method',
        );
      }
    }
  }

  const callables = [...records.values()]
    .map((record) => ({ ...record, entrypoints: [...record.entrypoints].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { version: 1, typescriptVersion: ts.version, callables };
}

export function readPublicSignatureManifest(): PublicSignatureManifest | null {
  try {
    return JSON.parse(readFileSync(SIGNATURE_MANIFEST_PATH, 'utf8')) as PublicSignatureManifest;
  } catch {
    return null;
  }
}

export function writePublicSignatureManifest(): PublicSignatureManifest {
  const manifest = generatePublicSignatureManifest();
  writeFileSync(SIGNATURE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const manifest = writePublicSignatureManifest();
  console.log(`signature-manifest: wrote ${manifest.callables.length} public callables`);
}
