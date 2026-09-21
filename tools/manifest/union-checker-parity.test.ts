/**
 * EVERY SEMANTIC UNION THE CHECKER CAN REACH MUST BE RECORDED AS ARMS — AT EVERY DEPTH, BY ROUTE.
 *
 * The defect this exists for is not "an arm was built wrong" — it is "an arm was never recorded", and
 * that failure is invisible from inside the union model. Both the enumeration and the gate that
 * checked it walked `declaredSites`, so a union the walker could not see was absent from both sides
 * and the gate agreed with the generator about a contract neither had read. 340 nested unions were
 * missing while a rendered-text gate over 88 root parameters stayed green.
 *
 * Two derivations of one declaration, compared by ROUTE:
 *
 *   - the checker side walks `ts.Type` objects with its own union rule, written below;
 *   - the artifact side walks published nodes through `walkManifest`.
 *
 * WHY ROUTE AND NOT RENDERED TEXT. The first version joined on the printed type. That cost three
 * rounds of notation fixes and 36 false accusations, because a printed type is a display form and the
 * two sides print differently:
 *
 *     9   the per-record id join missed scoped exports
 *     23  `x?: number | undefined` versus `x?: number` under exactOptionalPropertyTypes
 *     4   `Array<T>` versus `T[]`
 *
 * `ironButterfly`'s `number | { strike; callPremium?; putPremium? }` — cited in review as a missing
 * union — is recorded with two arms and was reported absent purely because of a `| undefined` suffix
 * on an optional member. Each normalization revealed the next spelling, which is what a display form
 * does. A route is a closed five-value vocabulary both sides already speak, and a disagreement names
 * a place rather than a string: `arg0.entry[1]|2` is somewhere you can go and look.
 *
 * WHAT INDEPENDENCE THIS DOES AND DOES NOT BUY. The two walks must correspond structurally for routes
 * to line up, so this cannot catch a blind spot they SHARE — if neither descends somewhere, neither
 * complains. It catches the asymmetric case, which is the one that has actually happened every time:
 * the checker reaches a union and the producer recorded nothing there. Text-keying had the same
 * shared blind spot with the notation noise on top, so this strictly dominates it.
 *
 * WHAT COUNTS AS A SEMANTIC UNION, stated because the answer decides what this gate demands:
 *   - `A | undefined` / `A | null` — NOT a union. Nullishness is a property of the slot.
 *   - `boolean` — NOT a union. The checker models it as `true | false`; a caller passes one type.
 *   - a closed set of LITERALS — recorded as `literals`; arms would describe one fact twice.
 *   - a union declared entirely in `lib.*.d.ts` — `ArrayBufferLike` is a platform detail, not an
 *     alternative anyone chooses between.
 *   - everything else with more than one constituent.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  type ManifestArtifact,
  type ManifestNode,
  type LiteralValue,
  type ManifestRecord,
  armsOfNode,
  childNodes,
} from './manifest-nodes.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = resolve(ROOT, 'packages');

/**
 * The same depth the generator records to.
 *
 * A union deeper than the artifact walks is a bound the generator states, not a defect, so the
 * checker side stops where the producer stops. Reading further would manufacture failures the
 * artifact never claimed to cover.
 *
 * Branch steps cost NO depth on either side — an arm is the union viewed one way, not a child of it.
 * That accounting is shared with `walkManifest` and with `armNodes` in the producer.
 */
const MAX_DEPTH = 4;

/**
 * Entry declarations, discovered from the workspace packages — and it FAILS if they are not built.
 *
 * `dist/` is gitignored and `pnpm test` is a bare `vitest run`, so on a clean checkout every lookup
 * here used to `continue` and the program was constructed over zero root files. The checker side of a
 * checker↔artifact parity gate then walked nothing, and the two assertions that would have caught it
 * were a `> 5` floor and a "some union was reached" floor — both of which read as ordinary red
 * assertions rather than as "this gate had no subject", which is a slower thing to diagnose.
 *
 * The worse case is the quiet one: a PARTIALLY built tree. With `packages/technical-analysis/dist`
 * missing the file passes green over 1,807 of 3,425 records, and nothing anywhere says so. So a
 * missing declaration is a hard error naming the package, the same wording `signature-inventory.ts`
 * and `naming-inventory.ts` already use for the same situation.
 *
 * Resolving from `src` instead was the alternative and it is wrong: the artifact side is derived from
 * `dist` declarations, so a source-resolved walk would report ordinary src↔dist skew as missing arms.
 */
function entryDeclarations(): { rootNames: string[]; paths: Record<string, string[]> } {
  const rootNames: string[] = [];
  const paths: Record<string, string[]> = {};
  for (const dir of ts.sys.getDirectories(PACKAGES)) {
    const packageJson = resolve(PACKAGES, dir, 'package.json');
    if (!ts.sys.fileExists(packageJson)) continue;
    const json = JSON.parse(readFileSync(packageJson, 'utf8')) as {
      name?: string;
      exports?: Record<string, unknown>;
    };
    if (!json.name || !json.exports) continue;
    for (const [entrypoint, value] of Object.entries(json.exports)) {
      if (entrypoint === './package.json') continue;
      const types =
        typeof value === 'object' && value !== null
          ? ((value as Record<string, unknown>)['types'] as string | undefined)
          : undefined;
      if (!types) {
        throw new Error(
          `union-checker-parity: ${json.name} ${entrypoint} declares no \`types\` target; ` +
            `this gate reads built declarations and cannot resolve the entrypoint without one.`,
        );
      }
      const declaration = resolve(PACKAGES, dir, types);
      if (!ts.sys.fileExists(declaration)) {
        throw new Error(
          `union-checker-parity: ${json.name} ${entrypoint} has no built declaration at ${types}; ` +
            `run \`pnpm build\` first (this gate compares the checker against \`dist\` declarations, ` +
            `and skipping an unbuilt package would silently shrink the population it audits).`,
        );
      }
      rootNames.push(declaration);
      const specifier = entrypoint === '.' ? json.name : `${json.name}/${entrypoint.slice(2)}`;
      paths[specifier] = [declaration.replace(/\.d\.ts$/, '')];
    }
  }
  return { rootNames, paths };
}

/**
 * The union rule, written here rather than imported.
 *
 * Importing the producer's `semanticArms` would make this gate agree with the thing it audits by
 * construction, which is the failure the whole review chain is about.
 */
function semanticUnionParts(type: ts.Type): ts.Type[] | null {
  if (!type.isUnion()) return null;
  const parts = type.types.filter(
    (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)),
  );
  if (parts.length <= 1) return null;
  if (parts.every((part) => Boolean(part.flags & ts.TypeFlags.BooleanLike))) return null;
  /**
   * A closed LITERAL domain is recorded as `literals`, not as arms — for every primitive now.
   *
   * This clause used to be a shared blind spot rather than a shared rule: the producer skipped a
   * literal-only union here on the grounds the values were recorded as a domain, and its domain
   * recorder handled strings only, so a numeric one was skipped by both and recorded by neither.
   * The domain is now recorded whatever primitive it holds, which is what makes this exclusion true
   * rather than merely agreed.
   */
  if (parts.every((part) => Boolean(part.flags & ts.TypeFlags.Literal))) return null;
  /**
   * Do not discard a union merely because every OUTER symbol comes from TypeScript's standard
   * library. Instantiated containers can carry different user declarations —
   * `ReadonlyArray<A> | ReadonlyArray<B>` is a semantic union even though both outer symbols are
   * `ReadonlyArray`. The complete arm fingerprints below decide whether those contracts differ.
   *
   * This is intentionally the same caller-visible rule as the independently implemented clauses
   * above: after nullish, boolean and closed-literal exclusions, every remaining constituent is an
   * arm. Looking only at symbol ownership threw away the type arguments and made this checker blind
   * to exactly the declaration it exists to audit.
   */
  return parts;
}

/** Members of a type that belong to THIS library — the same exclusion the producer applies. */
function declaredMembers(checker: ts.TypeChecker, type: ts.Type): ts.Symbol[] {
  return checker
    .getPropertiesOfType(type)
    .filter((property) => !property.name.startsWith('__@'))
    .filter((property) => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      return (
        declaration !== undefined &&
        !declaration.getSourceFile().fileName.includes('/typescript/lib/')
      );
    });
}

/** Is this a fixed-arity tuple, whose members are POSITIONS rather than one element shape? */
function tupleArity(checker: ts.TypeChecker, type: ts.Type): number | null {
  const reference = type as ts.TypeReference;
  const target = reference.target as (ts.TupleType & { hasRestElement?: boolean }) | undefined;
  if (!target || !(target.objectFlags & ts.ObjectFlags.Tuple)) return null;
  // A rest or variadic element makes the arity open, and the producer records no positions for one.
  if (target.hasRestElement) return null;
  return checker.getTypeArguments(reference).length;
}

/** Sequence interfaces that TypeScript's `isArrayLikeType` does not consistently recognize. */
const SEQUENCE_NAMES: ReadonlySet<string> = new Set([
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

function checkerSequence(checker: ts.TypeChecker, type: ts.Type): boolean {
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
  const name = (type.aliasSymbol ?? type.getSymbol())?.name ?? '';
  return SEQUENCE_NAMES.has(name);
}

/** The sequence element, including typed arrays whose first generic is their BUFFER. */
function checkerElement(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  const parts = type.isUnion()
    ? type.types.filter(
        (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
      )
    : [type];
  if (
    parts.every((part) =>
      Boolean(
        part.flags &
        (ts.TypeFlags.StringLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.BooleanLike),
      ),
    )
  ) {
    return null;
  }
  for (const part of parts) {
    if (!checkerSequence(checker, part)) continue;
    const name = (part.aliasSymbol ?? part.getSymbol())?.name ?? '';
    if (name.endsWith('Array') && name !== 'Array' && name !== 'ReadonlyArray') {
      const indexed = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
      if (indexed) return indexed;
    }
    const arguments_ = checker.getTypeArguments(part as ts.TypeReference);
    if (arguments_.length > 0) return arguments_[0]!;
    const indexed = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
    if (indexed) return indexed;
  }
  return null;
}

/** Does the producer have expandable object/sequence children at this node? */
function checkerContainer(checker: ts.TypeChecker, type: ts.Type): boolean {
  const parts = type.isUnion()
    ? type.types.filter(
        (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
      )
    : [type];
  if (
    parts.every((part) =>
      Boolean(
        part.flags &
        (ts.TypeFlags.StringLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.BooleanLike),
      ),
    )
  ) {
    return false;
  }
  if (parts.some((part) => checkerSequence(checker, part))) return true;
  if (
    parts.some((part) => checker.getSignaturesOfType(part, ts.SignatureKind.Call).some(() => true))
  ) {
    return false;
  }
  // A branded scalar is passed as its primitive, despite carrying an intersection brand.
  if (
    parts.some((part) => Boolean(part.flags & ts.TypeFlags.Intersection)) &&
    parts.some((part) =>
      ((part as ts.IntersectionType).types ?? []).some((member) =>
        Boolean(
          member.flags &
          (ts.TypeFlags.Number |
            ts.TypeFlags.NumberLiteral |
            ts.TypeFlags.String |
            ts.TypeFlags.StringLiteral),
        ),
      ),
    )
  ) {
    return false;
  }
  return parts.every((part) =>
    Boolean(part.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)),
  );
}

/**
 * Every semantic union the checker reaches under one parameter, keyed by ROUTE.
 *
 * The traversal mirrors `childNodes` step for step, because that correspondence is what makes the two
 * sides comparable at all: members are `{ property }`, a sequence's element is `{ element }`, a
 * tuple's slots are `{ position }`, a callable's result is `{ returns }`, and an arm is `{ branch }`.
 */
interface CheckerReach {
  unions: Map<string, { arms: number; route: CmpStep[]; armKeys: string[] }>;
  domains: Map<string, { values: LiteralValue[]; route: CmpStep[] }>;
  callables: Map<string, { surface: string; route: CmpStep[] }>;
  /**
   * Every route this walk actually STOOD ON.
   *
   * A domain disagreement is only meaningful where both sides describe the same node. Without this,
   * the comparison fired wherever the two walks reach differently — the checker flattens
   * `BarField | ((bar) => In)` into six constituents and stands on each, and the producer reaches
   * `SafeParseResult`'s arms where this walk has spent its depth — and reported "no closed domain"
   * for nodes the other side never visited. That is a difference in REACH, which the union
   * comparison and `UNREACHED_BY_THIS_WALK` already account for; restating it as a domain defect
   * would be the notation-versus-fact confusion this gate exists to avoid.
   */
  visited: Set<string>;
  /**
   * The DEPTH this walk stood at, per route, and where it stopped for a cycle.
   *
   * Truncation used to be whatever the artifact said it was: any node carrying `truncated: true`
   * became a suppression boundary AND an exemption from identity comparison, so marking a SHALLOW
   * union truncated and then corrupting it produced no findings at all. A bound the measured thing
   * declares about itself is not a bound. These let the gate ask whether a truncation claim is
   * consistent with the walk's own budget: legitimate at or past the cap, or at a cycle; a lie
   * anywhere else.
   */
  depths: Map<string, number>;
  cycles: Set<string>;
  /** Exact checker-derived depth/cycle boundaries — the only places truncation may be claimed. */
  frontiers: Set<string>;
}

function checkerUnionRoutes(checker: ts.TypeChecker, root: ts.Type): CheckerReach {
  const found = new Map<string, { arms: number; route: CmpStep[]; armKeys: string[] }>();
  const domains = new Map<string, { values: LiteralValue[]; route: CmpStep[] }>();
  const callables = new Map<string, { surface: string; route: CmpStep[] }>();
  const visited = new Set<string>();
  const depths = new Map<string, number>();
  const cycles = new Set<string>();
  const frontiers = new Set<string>();
  const visit = (
    type: ts.Type,
    route: CmpStep[],
    depth: number,
    /**
     * The types on the PATH TO HERE, which is the producer's cycle rule and not a global visited set.
     *
     * Keyed by (route, type) instead, this walk re-entered `JSONSchema.additionalProperties` at every
     * new route and reported four "missing" unions per recursive schema — routes the producer stops
     * at deliberately, because its `seen` set holds ancestors. A gate that descends further than the
     * thing it audits reports the difference as a defect in the artifact.
     */
    ancestors: ReadonlySet<ts.Type>,
  ): void => {
    const key = renderCmp(route);
    const recursiveShape =
      checkerContainer(checker, type) ||
      semanticUnionParts(type) !== null ||
      checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0;
    if (ancestors.has(type) && recursiveShape) {
      cycles.add(key);
      frontiers.add(key);
      return;
    }
    if (depth > MAX_DEPTH) return;
    if (!depths.has(key)) depths.set(key, depth);
    const below = new Set([...ancestors, type]);

    /**
     * NULLISH IS STRIPPED BEFORE ANYTHING ELSE, because it is a property of the SLOT.
     *
     * An optional member is declared `MarketInputs | undefined`, and `getPropertiesOfType` on a union
     * returns only what every constituent has — which for anything unioned with `undefined` is
     * nothing. So this walk descended into no optional object member anywhere, and the 239 records
     * publishing `market.asOf` (`string | number`) looked like the artifact inventing a union. It was
     * the gate failing to arrive.
     *
     * `withoutNullish` is the same rule the producer applies at the parameter level, for the same
     * reason. Costs no depth and no route step: the slot is the same slot.
     */
    const meaningful = type.isUnion()
      ? type.types.filter((part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)))
      : [type];
    if (meaningful.length === 1 && meaningful[0] !== type) {
      visit(meaningful[0]!, route, depth, ancestors);
      return;
    }

    /**
     * A constrained type parameter is walked through its constraint.
     *
     * Public generic facades expose shapes such as `Members extends readonly Schema<unknown>[]` and
     * `Args extends [bond: Bond, curve: YieldCurve, options: CurvePricingOptions]`. The producer asks
     * the checker for those constraints and records their element/positions; stopping on the bare
     * type parameter left 141 real depth frontiers "unvisited" and then trusted whatever truncation
     * the artifact claimed there. Resolving the checker-owned constraint gives this audit an
     * independent route and budget for those nodes.
     */
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      if (constraint && constraint !== type) {
        visit(constraint, route, depth, ancestors);
        return;
      }
    }

    /**
     * A DOMAIN is recorded before the union rule declines the node, because the decline is what
     * defers to it. Both are keyed by the same route, so the two facts about one node stay together.
     */
    visited.add(key);
    const domain = checkerDomain(type);
    if (domain) domains.set(key, { values: domain, route: [...route] });
    const callableSurface = checkerCallableSurface(checker, type);
    if (callableSurface.length > 0) {
      callables.set(key, {
        surface: JSON.stringify({
          legacy: {
            parameters: callableSurface[0]!.parameters.length,
            returns: callableSurface[0]!.returns,
          },
          signatures: callableSurface,
        }),
        route: [...route],
      });
    }

    const parts = semanticUnionParts(type);
    if (parts) {
      if (depth >= MAX_DEPTH && checkerContainer(checker, type)) frontiers.add(key);
      // A branch costs no depth — the arm is this node seen one way, addressed by its RANK.
      // An arm is the union viewed one way, so the union type is already on its ancestor path. The
      // producer uses the same cycle rule; omitting it here expanded recursive IndicatorOutputValue
      // one generation farther and made an exact cycle stop look like missing structure.
      const prints = parts.map((part) => checkerFingerprint(checker, part, 0, new Set([type])));
      const ranks = armRanks(prints);
      found.set(key, { arms: parts.length, route: [...route], armKeys: [...prints].sort() });
      parts.forEach((part, index) => visit(part, [...route, { arm: ranks[index]! }], depth, below));
      return;
    }

    if (depth >= MAX_DEPTH) {
      if (checkerContainer(checker, type)) frontiers.add(key);
      // Local domains, unions and callable signatures were recorded above. Children—including a
      // callable's return contract—cost another level and are outside the producer's same budget.
      return;
    }

    const arity = tupleArity(checker, type);
    if (arity !== null) {
      checker
        .getTypeArguments(type as ts.TypeReference)
        .slice(0, arity)
        .forEach((slot, index) => visit(slot, [...route, { position: index }], depth + 1, below));
      return;
    }

    // A sequence holds ONE declared shape however many values, so its element is one child.
    const element = checkerElement(checker, type);
    if (element) {
      visit(element, [...route, { element: true }], depth + 1, below);
      return;
    }

    for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
      visit(signature.getReturnType(), [...route, { returns: true }], depth + 1, below);
    }

    for (const property of declaredMembers(checker, type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) continue;
      visit(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        [...route, { property: property.name }],
        depth + 1,
        below,
      );
    }
  };
  visit(root, [], 0, new Set());
  return { unions: found, domains, callables, visited, depths, cycles, frontiers };
}

const artifact = JSON.parse(
  readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
) as ManifestArtifact;

/** Does the artifact record any structure at all for this parameter — members, element, arms, positions? */
function structureOf(parameter: ManifestNode): boolean {
  return Boolean(
    (parameter.fieldTree?.length ?? 0) > 0 ||
    (parameter.fields?.length ?? 0) > 0 ||
    (parameter.elementFieldTree?.length ?? 0) > 0 ||
    parameter.element ||
    (parameter.tuple?.length ?? 0) > 0 ||
    // A tuple whose positions are described only by their member lists is described.
    (parameter.tupleFieldTrees ?? []).some((members) => (members?.length ?? 0) > 0) ||
    /**
     * A CLOSED DOMAIN IS A DESCRIPTION. `source: 'bid' | 'ask' | 'mid'` has no members, no element
     * and no arms, and the artifact describes it completely — those three values ARE the contract.
     * Counting only container shapes reported every enum parameter as undescribed the moment domains
     * began to be compared.
     */
    (parameter.literals?.length ?? 0) > 0 ||
    /**
     * A CALLBACK IS DESCRIBED BY ITS SIGNATURE. `facade(explain: (input) => Computed<V, E>)` asks the
     * caller to IMPLEMENT something, and its arity and return are that contract; the artifact
     * deliberately records them instead of walking the return's innards, because what a stub needs is
     * the shape of the function, not a description of a value the library will produce.
     */
    Boolean(parameter.callSignature) ||
    (parameter.callSignatures?.length ?? 0) > 0 ||
    (parameter.branches?.length ?? 0) > 0,
  );
}

/**
 * THE DECLARATION A RECORD IS ABOUT, resolved through the checker from the record's own identity.
 *
 * The gate used to walk the checker's exports and then look for artifact records whose id ENDED IN
 * the same name — `id.endsWith(':name') || id.endsWith('.name')` — pooling every match into one bag
 * of facts. Four plants passed against that scheme, and each failure is a different consequence of
 * the same mistake, which is that a name is not an identity:
 *
 *   1. an arm count changed 3 -> 2 and nothing compared counts, only route presence;
 *   2. arms were stripped from ONE alias of `ironButterfly` and the other alias's facts covered for
 *      it, because a pooled bag cannot tell which spelling contributed what;
 *   3. a union was removed from `VolatilitySurface`'s CONSTRUCTOR and only call signatures were
 *      walked, so nothing looked;
 *   4. a union was removed from a later OVERLOAD and only `signatures[0]` was walked.
 *
 * So the join is inverted: iterate the ARTIFACT, and resolve each record's declaration from its OWN
 * `implementation` identity — `<dist declaration>#<Symbol>` or `#<Type>.<member>`, present on all
 * 6,618 records with no second separator and no path outside a package's `dist`. Every record is then
 * compared against only its own facts, at every signature of the right KIND, at every argument index,
 * by route AND by arm count, in both directions.
 *
 * `implementation` is not quite a complete identity, and this gate is where that shows up. For 249
 * records it names the CONTAINER rather than the callable: every `candlesticks.*` pattern is filed as
 * `…/candlesticks.d.ts#candlesticks`, the namespace object, and every constructor as the class. So the
 * remaining segment is taken from the record id, which is the only place it is written down. That is
 * a hint about WHICH callable to look at, never about what its unions are — the union rule and the
 * walk stay local, which is the part that must not agree with the producer by construction.
 *
 * Aliases stop being a hazard by construction: 4,499 records share 2,119 declarations, and each is
 * compared separately, so stripping one spelling's arms fails on that spelling.
 *
 * Independence is preserved where it matters. The UNION RULE and the walk are still written here
 * rather than imported — that is the part which must not agree with the producer by construction.
 * Only the enumeration is taken from the artifact, and taking it there is what makes the coverage
 * claim checkable: a record that cannot be resolved is a named failure, not a silent `continue`.
 */
interface ResolvedCallable {
  signatures: readonly ts.Signature[];
  kind: 'call' | 'construct';
}

function resolveRecordCallable(
  program: ts.Program,
  checker: ts.TypeChecker,
  record: ManifestRecord,
): ResolvedCallable | { failure: string } {
  const implementation = record.implementation ?? '';
  const separator = implementation.indexOf('#');
  if (separator < 0) return { failure: 'identity has no `#`' };
  const relativePath = implementation.slice(0, separator);
  const declared = implementation.slice(separator + 1);

  /**
   * The segments the record id adds beyond what `implementation` names.
   *
   * `@totalfinance/technical-analysis:candlesticks.abandonedBaby` over `…#candlesticks` contributes
   * `abandonedBaby`; `@totalfinance/backtest:SimulatedBroker.constructor` over `…#SimulatedBroker`
   * contributes `constructor`, which is a marker rather than a member and is handled as one.
   */
  const idTail = record.id.slice(record.id.indexOf(':') + 1).replace('#', '.');
  const extra =
    idTail === declared
      ? []
      : idTail.startsWith(`${declared}.`)
        ? idTail.slice(declared.length + 1).split('.')
        : [];
  const wantsConstructor = extra[extra.length - 1] === 'constructor';
  const symbolPath = [...declared.split('.'), ...(wantsConstructor ? extra.slice(0, -1) : extra)];
  const source = program.getSourceFile(resolve(ROOT, relativePath));
  if (!source) return { failure: `declaration file not in the program: ${relativePath}` };
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return { failure: `not a module: ${relativePath}` };

  const [head, ...rest] = symbolPath as [string, ...string[]];
  /**
   * Exports first, then FILE-LOCAL declarations.
   *
   * An inherited member is filed under the class that declares it, and that class need not be
   * exported: 156 records name `BaseSchema.parse` and friends, where `BaseSchema` is an internal
   * base whose methods reach the public surface only through `ArraySchema`, `EnumSchema` and the
   * rest. Resolving exports alone would have left every one of them uncompared — which, before this
   * rewrite, is exactly what a name-suffix join did silently.
   */
  const exportedSymbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((candidate) => candidate.name === head);
  const localSymbol =
    exportedSymbol ??
    source.statements
      .filter(
        (statement): statement is ts.ClassDeclaration | ts.InterfaceDeclaration =>
          (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
          statement.name?.text === head,
      )
      .map((statement) => checker.getSymbolAtLocation(statement.name!))
      .find((candidate): candidate is ts.Symbol => candidate !== undefined);
  if (!localSymbol) return { failure: `no declaration of \`${head}\` in ${relativePath}` };
  let symbol: ts.Symbol =
    localSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(localSymbol) : localSymbol;

  /**
   * A member is looked up on the INSTANCE side first and the STATIC side second.
   *
   * `AdxStream.fromJSON` is a static restorer and `SimulatedBroker.cancel` is an instance method;
   * the identity spells them the same way because the identity is about the declaration, not about
   * where the checker files it.
   */
  for (const member of rest) {
    const container = symbol;
    const declaration = container.valueDeclaration ?? container.declarations?.[0];
    const instanceType = checker.getDeclaredTypeOfSymbol(container);
    const staticType = declaration
      ? checker.getTypeOfSymbolAtLocation(container, declaration)
      : undefined;
    const found =
      instanceType.getProperty(member) ?? (staticType ? staticType.getProperty(member) : undefined);
    if (found) {
      symbol = found;
      continue;
    }
    /**
     * A MEMBER OF AN INDEX SIGNATURE has no declared symbol, and its contract is the value type.
     *
     * `candlesticks` is published as `Record<string, ReturnType<typeof candlePattern>>`, so its 61
     * pattern records name members the checker cannot see individually — they exist at runtime and
     * the declared type gives every one of them the same signature. Reading that signature is the
     * honest resolution: it is exactly the contract a caller is handed.
     */
    const holder = staticType ?? instanceType;
    const indexed =
      checker.getIndexInfoOfType(holder, ts.IndexKind.String)?.type ??
      checker.getIndexInfoOfType(holder, ts.IndexKind.Number)?.type;
    const indexedSignatures = indexed
      ? checker.getSignaturesOfType(indexed, ts.SignatureKind.Call)
      : [];
    if (indexedSignatures.length === 0) {
      /**
       * The id's namespace segment can REPEAT the callable's own name.
       *
       * `totalfinance:strategy.strategy` is the umbrella's `strategy` namespace and its `strategy`
       * member, over an identity that already names the function; taking the id's extra segment
       * literally looks for `strategy.strategy`. When the container is itself the callable, it is
       * the answer.
       */
      const own = checker.getSignaturesOfType(holder, ts.SignatureKind.Call);
      if (own.length > 0) return { signatures: own, kind: 'call' };
      return { failure: `no member \`${member}\` on \`${container.name}\`` };
    }
    return { signatures: indexedSignatures, kind: 'call' };
  }

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return { failure: `\`${implementation}\` has no declaration` };

  /**
   * A CONSTRUCTOR RECORD IS COMPARED AGAINST CONSTRUCT SIGNATURES.
   *
   * Only call signatures were traversed before, so removing a union from a constructor parameter
   * changed nothing anywhere. Both `constructor` and `error` boundary kinds are constructed.
   *
   * The ID decides when the two disagree. `@totalfinance/technical-analysis:DrawdownStream.constructor`
   * is filed `boundaryKind: 'callback-contract'` — a producer misclassification, harmless in itself
   * because that constructor takes no parameters, but it would have made this record unresolvable
   * and therefore uncompared. What the record claims to be about is written in its id.
   */
  const wantsConstruct =
    wantsConstructor || record.boundaryKind === 'constructor' || record.boundaryKind === 'error';
  if (wantsConstruct) {
    const classType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const signatures = checker.getSignaturesOfType(classType, ts.SignatureKind.Construct);
    if (signatures.length === 0)
      return { failure: `no construct signature on \`${symbolPath.join('.')}\`` };
    return { signatures, kind: 'construct' };
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (signatures.length === 0)
    return { failure: `no call signature on \`${symbolPath.join('.')}\`` };
  return { signatures, kind: 'call' };
}

/**
 * PARAMETERS THE ARTIFACT DESCRIBES NO STRUCTURE FOR — every one named, with why.
 *
 * `<record id>|<parameter name>` to the reason. This replaced `UNDESCRIBED_CEILING = 30`, a number
 * that permitted thirty of these under the description "a shape the harness cannot reason about at
 * all" while only seven were that; the rest were ordinary request objects with an exact
 * `typeDeclaration` and no field tree, and three of them published `enforced` — a verdict about a
 * contract nothing had read. Those are now described, by reading the type instead of looking the
 * declaration up in an index of exported ones.
 *
 * What remains is the category the ceiling was written for and nothing else: two class instances and
 * one external protocol. A caller does not author these — synthesis gets hold of one — so "no
 * structure" is the true record rather than a gap. Checked in BOTH directions below: an unlisted
 * parameter fails as an undescribed contract, and a listed one that stops occurring fails as a stale
 * entry, so this cannot outlive its subject the way a ceiling silently does.
 */
const UNDESCRIBED_ALLOWLIST: readonly (readonly [string, string])[] = [
  [
    '@totalfinance/volatility:readFittedModel|input',
    'Stage 4.5 restore boundary: `migrations` is a function-membered registry (the Gate B read-door class); the artifact itself is validated at runtime through readAnalysisArtifact',
  ],
  [
    '@totalfinance/volatility:replayFittedModel|input',
    'Stage 4.5 replay boundary: `migrations` is a function-membered registry (the Gate B read-door class); the artifact and the referenced rows are validated at runtime',
  ],
  [
    '@totalfinance/fixed-income:readFittedModel|input',
    'Stage 4.5 restore boundary (fixed-income): `migrations` is a function-membered registry (the Gate B read-door class); the artifact itself is validated at runtime through readAnalysisArtifact',
  ],
  [
    '@totalfinance/fixed-income:replayFittedModel|input',
    'Stage 4.5 replay boundary (fixed-income): `migrations` is a function-membered registry (the Gate B read-door class); the artifact is validated at runtime',
  ],
  [
    '@totalfinance/research:readResearchRun|input',
    'Stage 4.5 restore boundary (research): `migrations` is a function-membered registry (the Gate B read-door class); the artifact itself is validated at runtime through readAnalysisArtifact',
  ],
  [
    '@totalfinance/research:replayResearchRun|input',
    'Stage 4.5 replay boundary (research): `migrations` is a function-membered registry (the Gate B read-door class); the artifact and the referenced rows are validated at runtime',
  ],
  [
    '@totalfinance/backtest:readBacktestRun|input',
    'Stage 4.6 slice 3 restore boundary (backtest runs): `migrations` is a function-membered registry (the Gate B read-door class); the artifact and any supplied referenced rows are validated at runtime',
  ],
  [
    '@totalfinance/backtest:replayBacktestRun|input',
    'Stage 4.6 slice 3 replay boundary (backtest runs): `migrations` is a function-membered registry and `models` carries live execution/cost models (function-membered objects verified against their recorded descriptions); the artifact and the referenced rows are validated at runtime',
  ],
  [
    '@totalfinance/core:applyReportMigrations|input',
    'Stage 4.5 kit: `migrations` is a function-membered registry and `report` is the open stored record the registry rewrites; both are validated at runtime (closed request keys, typed strings and versions, a structural registry check)',
  ],
  [
    '@totalfinance/core:readAnalysisArtifact|input',
    'Gate B restore boundary: `artifact` is `unknown` BY CONTRACT (the TA readSnapshot law — restore validates at runtime, never trusts a declaration) and `migrations` is a function-membered registry; neither is describable structure',
  ],
  [
    '@totalfinance/core:readMarketSnapshot|input',
    'Gate B restore boundary: `snapshot` is `unknown` BY CONTRACT (restore validates at runtime) and `migrations` is a function-membered registry',
  ],
  [
    '@totalfinance/core:readScenarioSet|input',
    'Gate B restore boundary: `scenarioSet` is `unknown` BY CONTRACT (restore validates at runtime) and `migrations` is a function-membered registry',
  ],
  [
    '@totalfinance/volatility:calendarSkew.explain|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods (H22 explain twin)',
  ],
  [
    '@totalfinance/volatility:CalendarSkewFacade#explain|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods (H22 explain twin)',
  ],
  [
    '@totalfinance/volatility:forwardSkew.explain|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods (H23 explain twin)',
  ],
  [
    '@totalfinance/volatility:ForwardSkewFacade#explain|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods (H23 explain twin)',
  ],
  [
    '@totalfinance/volatility:forwardVolatility.explain|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods (H21 explain twin)',
  ],
  [
    '@totalfinance/volatility:ForwardVolatilityFacade#explain|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods (H21 explain twin)',
  ],
  [
    'totalfinance:volatility.calendarSkew.explain|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods (H22 explain twin, umbrella spelling)',
  ],
  [
    'totalfinance:volatility.forwardSkew.explain|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods (H23 explain twin, umbrella spelling)',
  ],
  [
    'totalfinance:volatility.forwardVolatility.explain|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods (H21 explain twin, umbrella spelling)',
  ],
  [
    '@totalfinance/technical-analysis:Term#condition|context',
    'a Condition receives the SignalContext — a live evaluation cursor the builder constructs, obtained rather than authored (public since the 3B.2 Rule/Term export)',
  ],
  [
    '@totalfinance/workflows:cancelJob|input',
    "the request carries the caller's clock — a function — beside the job store it acts on: host objects, obtained rather than authored (Stage 7A slice 5: the runtime moved to @totalfinance/workflows/local)",
  ],
  [
    '@totalfinance/cli:cancelJob|input',
    "the request carries the caller's clock — a function — beside the job store it acts on: host objects, obtained rather than authored (Stage 7A slice 3)",
  ],
  [
    '@totalfinance/mcp:defineTool|definition',
    'an MCP tool definition carries a Standard Schema — an external protocol object, obtained rather than authored',
  ],
  [
    '@totalfinance/strategy:explainPosition|position',
    'Position is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    '@totalfinance/strategy:payoffSvg|position',
    'Position is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    '@totalfinance/volatility:atmTermStructure|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    '@totalfinance/volatility:calendarSkew|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    '@totalfinance/volatility:forwardSkew|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    '@totalfinance/volatility:forwardVolatility|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    '@totalfinance/volatility:surfaceArbitrageReport|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:atmTermStructure|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:calendarSkew|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:explainPosition|position',
    'Position is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:forwardSkew|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:forwardVolatility|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:payoffSvg|position',
    'Position is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:strategy.explainPosition|position',
    'Position is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:strategy.payoffSvg|position',
    'Position is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:surfaceArbitrageReport|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:volatility.atmTermStructure|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:volatility.calendarSkew|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:volatility.forwardSkew|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:volatility.forwardVolatility|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
  [
    'totalfinance:volatility.surfaceArbitrageReport|surface',
    'VolatilitySurface is a class instance: synthesis obtains one rather than describing its methods',
  ],
];

/**
 * THE ARTIFACT WALK, IN THE ROUTE VOCABULARY THE CHECKER ALSO SPEAKS.
 *
 * `walkManifest` is exhaustive on purpose and must stay that way — forgetting a relationship is the
 * defect it exists to prevent. But a union node in the artifact carries TWO descriptions of the same
 * fact: its arms, and a merged `fieldTree` / `element` / `tuple` view flattened across those arms.
 * The checker has only the first. `RandomNumberGeneratorState` is the clearest case: the artifact
 * publishes `.state` — the merged `[number] | [number, number, number, number]` — while the checker,
 * which must pick an arm before it can have members at all, offers `|0.state` and `|1.state`.
 *
 * Comparing the merged routes against a walk that cannot produce them accused 14 correctly-recorded
 * unions of being unreachable. That is the same failure mode route-keying replaced text-keying to
 * remove: a difference in NOTATION reported as a difference in fact. So where a node has arms, its
 * arms are its structure here, and the merged view is passed over as the second description it is.
 *
 * This does not weaken the gate. A union recorded ONLY in a merged view still fails, because the arm
 * route the checker reaches has nothing recorded at it.
 */
function armAwareWalk(
  root: ManifestNode,
  visit: (node: ManifestNode, route: CmpStep[], recursive: boolean) => void,
): void {
  const stack: {
    node: ManifestNode;
    route: CmpStep[];
    depth: number;
    ancestors: ReadonlySet<string>;
  }[] = [{ node: root, route: [], depth: 0, ancestors: new Set() }];
  const seen = new Set<ManifestNode>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.node)) continue;
    seen.add(current.node);
    /**
     * A RECURSIVE RE-EXPANSION is flagged, not hidden.
     *
     * `IndicatorOutputValue` contains itself: its `array` arm declares `items: IndicatorOutputValue`.
     * The producer expands that once more; the checker walk here stops at the first repeat, because
     * its cycle rule is the ancestor set. Neither is wrong, and the gate is not the place to settle
     * it — but a node the checker deliberately stopped short of must not be reported as one the
     * artifact invented. Only the artifact-to-checker direction consults this; a union the checker
     * DOES reach is still demanded, recursive or not.
     */
    const recursive = current.node.type !== undefined && current.ancestors.has(current.node.type);
    visit(current.node, current.route, recursive);
    if (current.depth >= 24) continue;
    const ancestors =
      current.node.type === undefined
        ? current.ancestors
        : new Set([...current.ancestors, current.node.type]);
    const arms = armsOfNode(current.node);
    // Arm identities are computed once per union so collisions disambiguate consistently.
    const armPrints = arms ? arms.map((arm) => nodeFingerprint(arm)) : [];
    const armKeys = armRanks(armPrints);
    for (const child of childNodes(current.node)) {
      const branchStep = child.steps.find((step) => 'branch' in step);
      const isArm = branchStep !== undefined;
      if (arms && !isArm) continue;
      /**
       * Prefer the canonical complete node over its legacy flat projection.
       *
       * `element` and `tuple` replaced `elementFieldTree` and `tupleFieldTrees`, but the artifact
       * still publishes both while downstream readers migrate. Walking both gives one declaration
       * two depth budgets: the canonical node stops at four while the older projection was built in
       * a fresh tree and can run farther. That manufactured 124 unverified truncation claims at the
       * same semantic routes. The complete node is authoritative whenever present; the projections
       * remain audited on records that have no replacement yet.
       */
      if (
        current.node.element &&
        child.steps.some((step) => 'element' in step) &&
        child.node !== current.node.element
      ) {
        continue;
      }
      const positionStep = child.steps.find((step) => 'position' in step) as
        | { position: number }
        | undefined;
      if (
        current.node.tuple &&
        positionStep &&
        child.node !== current.node.tuple[positionStep.position]
      ) {
        continue;
      }
      const steps: CmpStep[] = isArm
        ? [
            { arm: armKeys[(branchStep as { branch: number }).branch]! },
            ...child.steps
              .filter((step) => !('branch' in step))
              .map((step) => step as unknown as CmpStep),
          ]
        : child.steps.map((step) => step as unknown as CmpStep);
      stack.push({
        node: child.node,
        route: [...current.route, ...steps],
        // An arm is the union viewed one way, not a child of it.
        depth: current.depth + (isArm ? 0 : 1),
        ancestors,
      });
    }
  }
}

/**
 * THE CLOSED DOMAIN A TYPE ADMITS, derived here rather than imported.
 *
 * The union rule above declines a literal-only union on the grounds that its values are recorded as
 * a DOMAIN instead of as arms. Nothing checked that they were. The review removed the real `2 | 1`
 * Vanna-Volga `order` domain from the producer, regenerated every artifact, watched numeric-domain
 * nodes fall 33 -> 31, and the whole suite stayed green — because the only test over them asserted
 * "more than 20 numeric domains exist", which is a floor, not parity. A floor cannot see a deletion.
 *
 * So the exclusion now costs what it claims: every domain the checker derives is compared, by exact
 * TYPED value, at the same route, in both directions. Written independently for the same reason the
 * union rule is — importing the producer's `literalDomain` would make this agree by construction,
 * which is the failure the whole chain is about.
 *
 * `boolean` is not a domain (the checker models it as `true | false`); a SINGLETON boolean is.
 */
function checkerDomain(type: ts.Type): LiteralValue[] | null {
  const parts = type.isUnion() ? type.types : [type];
  const meaningful = parts.filter(
    (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
  );
  if (meaningful.length === 0) return null;
  if (
    meaningful.length > 1 &&
    meaningful.every((part) => Boolean(part.flags & ts.TypeFlags.BooleanLike))
  ) {
    return null;
  }
  const values: LiteralValue[] = [];
  for (const part of meaningful) {
    if (part.isStringLiteral() || part.isNumberLiteral()) values.push(part.value);
    else if (part.flags & ts.TypeFlags.BooleanLiteral) {
      values.push((part as ts.Type & { intrinsicName?: string }).intrinsicName === 'true');
    } else return null;
  }
  return values.length > 0 ? values : null;
}

/** Compare two domains as SETS of typed values — `1` and `'1'` are different admissions. */
function sameDomain(left: readonly LiteralValue[], right: readonly LiteralValue[]): boolean {
  const key = (values: readonly LiteralValue[]): string =>
    [...values]
      .map((value) => JSON.stringify(value))
      .sort()
      .join('|');
  return key(left) === key(right);
}

const showDomain = (values: readonly LiteralValue[]): string =>
  `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;

const CALLABLE_TYPE_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.WriteArrayAsGenericType |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

const checkerTypeText = (checker: ts.TypeChecker, type: ts.Type): string =>
  checker
    .typeToString(type, undefined, CALLABLE_TYPE_FLAGS)
    .replace(/import\("[^"]*"\)\./g, '')
    .split(ROOT)
    .join('');

/** A callable surface independently derived from the declaration checker. */
function checkerCallableSurface(
  checker: ts.TypeChecker,
  type: ts.Type,
): NonNullable<ManifestNode['callSignatures']> {
  let resolved = type;
  const constraints = new Set<ts.Type>();
  while (resolved.flags & ts.TypeFlags.TypeParameter) {
    if (constraints.has(resolved)) break;
    constraints.add(resolved);
    const constraint = checker.getBaseConstraintOfType(resolved);
    if (!constraint || constraint === resolved) break;
    resolved = constraint;
  }
  const parts = resolved.isUnion()
    ? resolved.types.filter(
        (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
      )
    : [resolved];
  const surfaces: NonNullable<ManifestNode['callSignatures']> = [];
  const seen = new Set<string>();
  for (const part of parts) {
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
          type: checkerTypeText(checker, parameterType),
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
          name: parameter.symbol?.name ?? checkerTypeText(checker, parameter),
          ...(constraint ? { constraint: checkerTypeText(checker, constraint) } : {}),
          ...(defaultType ? { default: checkerTypeText(checker, defaultType) } : {}),
        };
      });
      const thisParameter = signature.thisParameter;
      const thisDeclaration = thisParameter?.valueDeclaration ?? thisParameter?.declarations?.[0];
      const thisType = thisParameter
        ? checkerTypeText(
            checker,
            thisDeclaration
              ? checker.getTypeOfSymbolAtLocation(thisParameter, thisDeclaration)
              : checker.getTypeOfSymbol(thisParameter),
          )
        : undefined;
      const surface = {
        parameters,
        returns: checkerTypeText(checker, signature.getReturnType()),
        ...(typeParameters && typeParameters.length > 0 ? { typeParameters } : {}),
        ...(thisType ? { thisType } : {}),
      };
      const key = JSON.stringify(surface);
      if (seen.has(key)) continue;
      seen.add(key);
      surfaces.push(surface);
    }
  }
  return surfaces;
}

/**
 * AN ARM'S SEMANTIC IDENTITY — a COMPLETE, canonical, recursive fingerprint of its shape.
 *
 * Routes address arms by name rather than index because the two walks order a union's constituents
 * differently. The first version of that name was too coarse: a singleton literal, member names,
 * callability, arity. It could not tell `number` from `string`, so changing
 * `number | ArrayLike<number>` to `string | ArrayLike<number>` left the arm count at two and the
 * gate silent. And it could not tell the `'straight'` and `'annuity'` arms of `bonds.amortizing`
 * apart — same members, different discriminator — so they COLLIDED, took occurrence suffixes in
 * traversal order, and merely reordering them invented two domain errors. An identity that collides
 * on things which differ is not an identity; it is a hash with a comment claiming otherwise.
 *
 * So the fingerprint carries everything a caller could observe: primitive kind, closed domain,
 * nullability, each member with its name, requiredness and its own fingerprint, element shape, tuple
 * positions, callable arity and return, and nested arms — recursively, canonicalised by sorting the
 * parts whose order is not contractual.
 *
 * Derived separately on each side, from the source each side reads. They must AGREE for identical
 * shapes, which is the price of comparing at all; what stays independent is what each side derives it
 * FROM. A residual disagreement shows up as an arm-identity finding rather than as silence.
 *
 * Occurrence suffixes remain, and are now safe in the way the previous comment merely asserted: two
 * arms share a suffix only when their COMPLETE fingerprints are identical, and arms indistinguishable
 * to this depth are interchangeable — reordering them cannot move a domain, because they hold the
 * same domains.
 */
const FINGERPRINT_DEPTH = 4;

/**
 * A marker that cannot be confused with ordinary finance/type vocabulary.
 *
 * The previous marker was the bare word `trunc`, and the matcher searched for that substring. A
 * property such as `truncationMethod` therefore became a wildcard by accident. Keep the marker
 * explicit and recognize only the complete token.
 */
const TRUNCATION_WILDCARD = '«totalfinance:truncation-frontier»';

/**
 * THE CHECKER'S FINGERPRINT IS INDEPENDENT OF THE ARTIFACT.
 *
 * An earlier version accepted a `paired` artifact node and stopped wherever that node claimed it had
 * stopped. No caller actually supplied one, so the argument was dead while its comment promised a
 * safety property that did not exist. More importantly, letting the measured artifact choose the
 * checker's extent would recreate self-authorising truncation through a second door.
 *
 * This side therefore walks only the declaration, under its own fixed fingerprint bound. The
 * comparison below treats `trunc` as a wildcard only at the exact subtree where the artifact says it
 * stopped; every sibling and ancestor remains literal. Whether that stop is legitimate is established
 * separately from checker-derived route frontiers before any suppression is honoured.
 */
function checkerFingerprint(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth = 0,
  seen: ReadonlySet<ts.Type> = new Set(),
): string {
  if (depth > FINGERPRINT_DEPTH) return '…';
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint && constraint !== type) {
      return checkerFingerprint(checker, constraint, depth, seen);
    }
  }
  if (seen.has(type)) {
    if (checkerSequence(checker, type)) return `A[${TRUNCATION_WILDCARD}]`;
    if (checkerContainer(checker, type)) return `O{${TRUNCATION_WILDCARD}}`;
    return '↺';
  }
  const below = new Set([...seen, type]);
  const parts = type.isUnion() ? type.types : [type];
  const nullable = parts.some((part) => Boolean(part.flags & ts.TypeFlags.Null));
  const meaningful = parts.filter(
    (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
  );
  const suffix = nullable ? '?null' : '';

  const domain = checkerDomain(type);
  if (domain) {
    return `D[${[...domain]
      .map((value) => JSON.stringify(value))
      .sort()
      .join(',')}]${suffix}`;
  }
  const arms = semanticUnionParts(type);
  if (arms) {
    const inner = arms
      .map((arm) => checkerFingerprint(checker, arm, depth + 1, below))
      .sort()
      .join('|');
    return `U[${inner}]${suffix}`;
  }
  const one = meaningful.length === 1 ? meaningful[0]! : type;
  if (one.flags & ts.TypeFlags.BooleanLike) return `bool${suffix}`;
  if (one.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) return `num${suffix}`;
  if (one.flags & ts.TypeFlags.StringLike) return `str${suffix}`;

  const arity = tupleArity(checker, one);
  if (arity !== null) {
    const slots = checker
      .getTypeArguments(one as ts.TypeReference)
      .slice(0, arity)
      .map((slot) => checkerFingerprint(checker, slot, depth + 1, below));
    return `T[${slots.join(',')}]${suffix}`;
  }
  /** A callable's complete overload surface is part of its identity, not merely its arity. */
  const calls = checkerCallableSurface(checker, one);
  if (calls.length > 0) return `F/${JSON.stringify(calls)}${suffix}`;
  /**
   * A SEQUENCE, and only a sequence.
   *
   * "Any type argument is an element" is the rule the ROUTE walk uses, and borrowing it here was
   * wrong: `Promise<Result>` has a type argument and is not an array, so `~standard.validate()`'s
   * result arm fingerprinted as `A[…]` on one side and `O{…}` on the other. The route walk can afford
   * the loose rule because a wrong route simply fails to pair; an identity that miscategorises is
   * worse, because it asserts two things are different when they are not.
   */
  /**
   * `isArrayLikeType` alone is not the rule: it answers FALSE for `ArrayLike<number>`, the very type
   * `number | ArrayLike<number>` is built from. The producer recognises a sequence by that predicate
   * OR by name, and the name half is what covers the declared interfaces; restated here rather than
   * imported, and deliberately NOT widened to "has a type argument", which called `Promise<T>` an
   * array.
   */
  if (checkerSequence(checker, one)) {
    const element = checkerElement(checker, one);
    // No element to name means nothing is known about the contents — the same `oth` the artifact
    // emits for an array whose element it never recorded. Both sides must say the same nothing.
    if (!element) return `oth${suffix}`;
    return `A[${checkerFingerprint(checker, element, depth + 1, below)}]${suffix}`;
  }
  const members = declaredMembers(checker, one);
  if (members.length > 0) {
    const inner = members
      .map((symbol) => {
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        const optional = symbol.flags & ts.SymbolFlags.Optional ? '?' : '';
        const shape = declaration
          ? checkerFingerprint(
              checker,
              checker.getTypeOfSymbolAtLocation(symbol, declaration),
              depth + 1,
              below,
            )
          : '?';
        return `${symbol.name}${optional}:${shape}`;
      })
      .sort()
      .join(',');
    return `O{${inner}}${suffix}`;
  }
  // Index-signature records and opaque class instances can be objects without named repo members.
  if (checkerContainer(checker, one)) return `O{}${suffix}`;
  return `oth${suffix}`;
}

function nodeFingerprint(node: ManifestNode, depth = 0): string {
  if (depth > FINGERPRINT_DEPTH) return '…';
  const suffix = node.nullable ? '?null' : '';
  if (node.literals && node.literals.length > 0) {
    return `D[${[...node.literals]
      .map((value) => JSON.stringify(value))
      .sort()
      .join(',')}]${suffix}`;
  }
  if ((node.branches?.length ?? 0) > 1) {
    const inner = node
      .branches!.map((arm) => nodeFingerprint(arm, depth + 1))
      .sort()
      .join('|');
    return `U[${inner}]${suffix}`;
  }
  /**
   * A TRUNCATED node stops here, and says so.
   *
   * Its shape was not walked, so pretending to fingerprint it would compare a description against a
   * bound. The marker is part of the identity: a truncated arm is not the same arm as one that was
   * read to the end, and treating them alike is what let an empty `s:||` match anything.
   */
  if (node.truncated) {
    if (node.kind === 'array') return `A[${TRUNCATION_WILDCARD}]${suffix}`;
    if (node.kind === 'object') return `O{${TRUNCATION_WILDCARD}}${suffix}`;
    if (node.kind === 'function') return `F/${TRUNCATION_WILDCARD}${suffix}`;
    return `${TRUNCATION_WILDCARD}${suffix}`;
  }
  if (node.kind === 'boolean') return `bool${suffix}`;
  if (node.kind === 'numeric') return `num${suffix}`;
  if (node.kind === 'string' || node.kind === 'enum') return `str${suffix}`;
  if (node.tuple && node.tuple.length > 0) {
    return `T[${node.tuple.map((slot) => nodeFingerprint(slot, depth + 1)).join(',')}]${suffix}`;
  }
  if (node.callSignatures && node.callSignatures.length > 0) {
    return `F/${JSON.stringify(node.callSignatures)}${suffix}`;
  }
  if (node.callSignature) {
    return `F/${node.callSignature.parameters}->${node.callSignature.returns}${suffix}`;
  }
  if (node.element) return `A[${nodeFingerprint(node.element, depth + 1)}]${suffix}`;
  /**
   * AN ARRAY WHOSE ELEMENT WAS NEVER RECORDED says nothing. `assertSingleExpiry` and its siblings are
   * filed `kind: 'array'` with no element, and `A[?]` asserted a shape the producer had not
   * established — disagreeing with the checker's `oth` over a difference neither side actually knows.
   */
  if (node.kind === 'array') return `oth${suffix}`;
  const members = node.fields ?? node.fieldTree ?? [];
  if (members.length > 0) {
    const inner = members
      .map(
        (field) =>
          `${field.name ?? ''}${field.optional ? '?' : ''}:${nodeFingerprint(field, depth + 1)}`,
      )
      .sort()
      .join(',');
    return `O{${inner}}${suffix}`;
  }
  if (node.kind === 'object') return `O{}${suffix}`;
  return `oth${suffix}`;
}

/**
 * THE TOP-LEVEL SHAPE of a fingerprint — the identity that survives truncation.
 *
 * Where the producer stopped expanding, the two sides cannot agree on a COMPLETE fingerprint: the
 * artifact says `trunc` and the checker reports what it found. That is the depth cap, not a defect,
 * and comparing full strings there reported 18 disagreements which were all exactly that.
 *
 * So a union containing truncation is compared on what both sides do know: each arm's outermost
 * constructor and its own closed domain. That still separates the cases identity exists to separate —
 * `num` from `str`, one discriminator from another — while declining to assert anything about
 * subtrees one side never walked.
 */
function reduceFingerprint(fingerprint: string): string {
  if (fingerprint.startsWith('D[')) return fingerprint;
  const constructor = /^[A-Za-z…↺]+|^[UOAT]\[|^[OT]\{/.exec(fingerprint);
  return constructor ? constructor[0].replace(/[[{]$/, '') : fingerprint;
}

/**
 * DO TWO ARM SETS CORRESPOND — allowing for arms the producer stopped expanding?
 *
 * With no truncation this is multiset equality of COMPLETE fingerprints, which is what catches a
 * discriminator that is renamed or replaced rather than removed.
 *
 * Where the artifact truncated a SUBTREE, only that substring is unknown. The rest of the arm stays
 * contractual. Treating an entire arm as a wildcard merely because one descendant contains `trunc`
 * let a mutation in a known sibling disappear — for example, changing `.length.parameter` beside a
 * recursive `.items` field. Patterns are matched as a multiset, with `trunc` wildcarding exactly its
 * own fingerprint substring and no ancestor or sibling.
 */
function armsCorrespond(artifact: readonly string[], checker: readonly string[]): boolean {
  if (artifact.length !== checker.length) return false;

  /**
   * Candidate endpoints for ONE wildcard without crossing the fingerprint node that contains it.
   *
   * A regex `.*?` is not structural. From inside `O{child:O{*},known:num}`, it can consume the
   * child's closing brace and the `known` sibling before finding a later brace that lets the suffix
   * match. Track balanced delimiters and stop before a closing delimiter owned by the parent, so a
   * wildcard can describe exactly one unknown subtree and never escape into its siblings.
   */
  const wildcardEnds = (candidate: string, start: number): number[] => {
    const ends = [start];
    const stack: string[] = [];
    let quote: '"' | "'" | null = null;
    let escaped = false;
    const matching: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
    for (let index = start; index < candidate.length; index += 1) {
      const character = candidate[index]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '(' || character === '[' || character === '{') {
        stack.push(character);
      } else if (character === ')' || character === ']' || character === '}') {
        if (stack.length === 0) break;
        if (stack[stack.length - 1] !== matching[character]) break;
        stack.pop();
      }
      if (!quote && stack.length === 0) ends.push(index + 1);
    }
    return ends;
  };

  const matches = (pattern: string, candidate: string): boolean => {
    if (!pattern.includes(TRUNCATION_WILDCARD)) return pattern === candidate;
    const memo = new Map<string, boolean>();
    const visit = (patternIndex: number, candidateIndex: number): boolean => {
      const key = `${patternIndex}:${candidateIndex}`;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      let result: boolean;
      if (patternIndex === pattern.length) {
        result = candidateIndex === candidate.length;
      } else if (pattern.startsWith(TRUNCATION_WILDCARD, patternIndex)) {
        result = wildcardEnds(candidate, candidateIndex).some((end) =>
          visit(patternIndex + TRUNCATION_WILDCARD.length, end),
        );
      } else {
        result =
          candidateIndex < candidate.length &&
          pattern[patternIndex] === candidate[candidateIndex] &&
          visit(patternIndex + 1, candidateIndex + 1);
      }
      memo.set(key, result);
      return result;
    };
    return visit(0, 0);
  };

  /**
   * Maximum bipartite matching, not greedy consumption. Two wildcard-bearing arms can overlap in
   * what they match, and choosing the first candidate can manufacture a failure even when a complete
   * correspondence exists. Exact/most-specific patterns are attempted first only to make the result
   * deterministic; the augmenting search supplies the correctness.
   */
  const order = artifact
    .map((pattern, index) => ({ pattern, index }))
    .sort((left, right) => {
      const leftWildcards = left.pattern.split(TRUNCATION_WILDCARD).length - 1;
      const rightWildcards = right.pattern.split(TRUNCATION_WILDCARD).length - 1;
      return leftWildcards - rightWildcards || right.pattern.length - left.pattern.length;
    });
  const owner = new Array<number>(checker.length).fill(-1);
  const assign = (artifactIndex: number, attempted: Set<number>): boolean => {
    for (let checkerIndex = 0; checkerIndex < checker.length; checkerIndex += 1) {
      if (attempted.has(checkerIndex)) continue;
      if (!matches(artifact[artifactIndex]!, checker[checkerIndex]!)) continue;
      attempted.add(checkerIndex);
      if (owner[checkerIndex] === -1 || assign(owner[checkerIndex]!, attempted)) {
        owner[checkerIndex] = artifactIndex;
        return true;
      }
    }
    return false;
  };
  return order.every(({ index }) => assign(index, new Set()));
}

/**
 * THE ROUTE COMPONENT for an arm: its RANK among its siblings, ordered by fingerprint.
 *
 * Identity and addressing are two jobs and this separates them. Embedding the whole fingerprint in
 * the route made routes hundreds of characters long and, worse, brittle: any difference anywhere in
 * an arm's subtree changed the route, so nested routes stopped lining up and `market.asOf` and
 * `.length` were reported missing when nothing was missing. A rank is short, and it is
 * ORDER-INDEPENDENT — which is the property that matters, because the two walks enumerate a union's
 * constituents in different orders.
 *
 * Ordered by the REDUCED fingerprint first, then the complete one. The reduced part is what both
 * sides agree on even where the producer truncated, so arms still rank identically there; the
 * complete part breaks ties among arms that genuinely differ. Arms that tie on both are
 * indistinguishable to this gate, so any order among them is the same order.
 *
 * Identity is still compared, separately and completely, as a multiset of the full fingerprints — a
 * rank cannot detect a renamed discriminator, and is not asked to.
 */
function armRanks(fingerprints: readonly string[]): string[] {
  const order = fingerprints
    .map((fingerprint, index) => ({ fingerprint, index }))
    .sort((left, right) => {
      const reduced = reduceFingerprint(left.fingerprint).localeCompare(
        reduceFingerprint(right.fingerprint),
      );
      if (reduced !== 0) return reduced;
      const complete = left.fingerprint.localeCompare(right.fingerprint);
      return complete !== 0 ? complete : left.index - right.index;
    });
  const ranks: string[] = new Array<string>(fingerprints.length);
  order.forEach((entry, rank) => {
    ranks[entry.index] = String(rank);
  });
  return ranks;
}

/**
 * The step vocabulary this GATE compares with — `NodeStep`, except an arm is named by identity.
 *
 * `NodeStep.branch` is an index because that is what the artifact's own shape is addressed by. For
 * comparison across two walks that order arms differently, an index is not a name. See
 * `checkerArmKey`.
 */
type CmpStep =
  | { property: string }
  | { element: true }
  | { position: number }
  | { arm: string }
  | { returns: true };

const renderCmp = (route: readonly CmpStep[]): string =>
  route
    .map((step) =>
      'property' in step
        ? `.${step.property}`
        : 'element' in step
          ? '[]'
          : 'position' in step
            ? `[${step.position}]`
            : 'arm' in step
              ? `|${step.arm}`
              : '()',
    )
    .join('');

/**
 * IS `route` STRICTLY BENEATH `stop` — compared STEP BY STEP, never as text.
 *
 * Truncation suppression used `route.startsWith(stop)` over rendered strings, and that was wrong
 * twice over. It suppressed the truncated NODE ITSELF, not merely what lies under it — so a union
 * recorded at a truncated node could be deleted and nothing compared it. And `.conventions` is a
 * string prefix of `.conventionsVersion`, so a truncated node masked an unrelated SIBLING: a union
 * invented at `.conventionsVersion` passed 10 of 10.
 *
 * A route is a sequence of steps, and "beneath" means "extends this sequence". Rendering it first
 * throws that structure away and then guesses it back from punctuation — the same mistake as keying
 * this gate on printed type text, which is what the route vocabulary replaced.
 */
function sameStep(left: CmpStep, right: CmpStep): boolean {
  if ('property' in left) return 'property' in right && left.property === right.property;
  if ('element' in left) return 'element' in right;
  if ('position' in left) return 'position' in right && left.position === right.position;
  if ('arm' in left) return 'arm' in right && left.arm === right.arm;
  return 'returns' in right;
}

function strictlyBeneath(route: readonly CmpStep[], stop: readonly CmpStep[]): boolean {
  // STRICT: the node at `stop` is itself compared. Only what hangs below it is unknown.
  if (route.length <= stop.length) return false;
  return stop.every((step, index) => sameStep(step, route[index]!));
}

/**
 * ROUTES THE ARTIFACT DESCRIBES AND THIS WALK CANNOT REACH — every one named, with why.
 *
 * These are NOT over-recording. In each case the artifact is the more complete of the two and this
 * gate's traversal stops earlier for a structural reason:
 *
 *   - `analyze.explain` / `performance.analyze.explain` take `...args: Parameters<typeof analyze>`.
 *     The producer resolves that to the two labelled positions; `tupleArity` here refuses a VARIADIC
 *     tuple, deliberately, because for every other shape a variadic means arity is not the contract.
 *
 * Constrained type parameters are now resolved through the checker, which retired the former
 * `schema.union` and schema-protocol entries. The two remaining routes are the facade's variadic
 * `Parameters<typeof analyze>` projection, whose resolved signature still exposes no declaration
 * path back to its concrete tuple.
 *
 * An exact list rather than a tolerance, checked in BOTH directions below: an unlisted route fails as
 * a finding, and a listed route that stops occurring fails as a stale entry. A count here would let
 * a genuine over-recording take a retiring one's place, which is the substitution a ceiling always
 * permits and never reports.
 */
const UNREACHED_BY_THIS_WALK: readonly string[] = [
  '@totalfinance/performance:analyze.explain#0(callArguments)[0]',
  'totalfinance:performance.analyze.explain#0(callArguments)[0]',
];

/**
 * Exact truncation routes whose checker symbol is an UNINSTANTIATED generic facade parameter.
 *
 * `BondFacade<Args, …>.explain` resolves here as the declaration template `Args extends unknown[]`,
 * while the generated record is attached to a concrete facade value and correctly carries its
 * `Bond` / `YieldCurve` / options tuple. There is no checker-owned route from that synthetic
 * parameter symbol back to the value's instantiation. These seven exceptions are keyed by
 * declaration identity, exact route, kind and rendered type; each carries the same narrow reason and
 * is checked for staleness. This is the explicit identity+route+reason escape hatch, not
 * `depth === undefined => true`.
 */
const TRUNCATION_FRONTIER_EXCEPTIONS: ReadonlyMap<string, string> = new Map(
  [
    '[0].cashflows()[]|object:CashFlow',
    '[0].futureCashflows()[]|object:CashFlow',
    '[1].addSpread()|object:YieldCurve',
    '[1].bumpPillar()|object:YieldCurve',
    '[1].shift()|object:YieldCurve',
    '[1].context.forecastCurve.pillars|array:ReadonlyArray<CurvePillar>',
    '[2].context.forecastCurve.pillars|array:ReadonlyArray<CurvePillar>',
  ].map((route) => [
    `packages/fixed-income/dist/bonds.d.ts#BondFacade.explain|${route}`,
    'the checker exposes the generic `Args extends unknown[]` declaration template, while the public facade value supplies the concrete tuple',
  ]),
);

/**
 * Route PREFIXES whose checker symbol is an UNINSTANTIATED generic protocol parameter — the
 * BondFacade class of exception, met again by Gate C (2026-08-20).
 *
 * `definePricer#0(pricer)` / `validatePricer#0(pricer)` are `Pricer<TInstrument, TValuation>`
 * declaration templates: the checker resolves `TValuation` to its constraint `Computed<number>` and
 * walks the full assumptions shape (compounding's seven arms, its depth frontiers), while the
 * artifact — attached to the erased declaration — records no structure beneath the generic method
 * returns. `requireObservationValue#0(requirement)` / `optionalObservationValue#0(requirement)` are
 * `RequirementOfKind<K>`: the checker distributes K to each literal arm (`kind:oth`) while the
 * artifact widens the template's discriminant to `string`. Same reason, four spellings; prefixes
 * are exact head+parameter identities so nothing else can shelter here, usage is tracked, and a
 * prefix that stops matching fails as stale.
 */
const UNINSTANTIATED_GENERIC_PARAMETER_ROUTES: readonly string[] = [
  // Gate C (2026-08-20): `Pricer<TInstrument, TValuation>` and `RequirementOfKind<K>` declaration
  // templates — the checker walks the constraint / distributes K, the artifact records the erased
  // template (the paragraph above); four spellings of one reason.
  '@totalfinance/core:definePricer#0(pricer).price()',
  '@totalfinance/core:validatePricer#0(pricer).price()',
  '@totalfinance/core:validatePricer#0(probes)',
  '@totalfinance/core:optionalObservationValue#0(requirement)',
  '@totalfinance/core:requireObservationValue#0(requirement)',
  // The MarketObservation distributive mapped type rides every `observations` parameter; when the
  // review wave made the discountCurve value a plain RateCurve (serializable — correct), its
  // `compounding` arms and `points` frontier joined the same template-walk blindness on each
  // spelling that carries the union (2026-08-20).
  '@totalfinance/core:Pricer#price#0(input).observations[]',
  '@totalfinance/core:Pricer#priceBatch#0(input).observations[]',
  '@totalfinance/core:missingRequirements#0(input).observations[]',
  '@totalfinance/core:observationFor#0(observations)[]',
  '@totalfinance/core:optionalObservationValue#0(observations)[]',
  '@totalfinance/core:requireObservationValue#0(observations)[]',
  '@totalfinance/options:Pricer#price#0(input)',
  '@totalfinance/options:Pricer#priceBatch#0(input)',
  // The fixed-income adapter instantiates the same generic protocol with the behavior-bearing Bond
  // type. Its public artifact can therefore describe the concrete bond methods and schedule while
  // the checker route rooted at `Pricer` sees only the uninstantiated TInstrument template.
  '@totalfinance/fixed-income:Pricer#price#0(input)',
  '@totalfinance/fixed-income:Pricer#priceBatch#0(input)',
  // Stage 4.5 (2026-09-02): `VolatilityFittedModelReport<F>` / `FitOf<F>` / `EvaluationOf<F>` are
  // declaration templates over the twelve-family union. The checker distributes F to every family's
  // verbatim fit (twelve `assumptions` arms, the surface's seven `compounding` arms, its depth
  // frontiers) while the artifact records the erased declaration — the same template blindness,
  // at the parameters that carry a report or a fit.
  '@totalfinance/volatility:fittedModelArtifact#0(input).fit',
  '@totalfinance/volatility:evaluateFittedModel#0(input).model',
  '@totalfinance/volatility:compareFittedModels#0(input).baseline',
  '@totalfinance/volatility:compareFittedModels#0(input).candidate',
  '@totalfinance/volatility:warmStartFrom#0(input).model',
  // Stage 4.5 slice 4 (2026-09-03): the fixed-income templates `CurveFittedModelReport<F>` /
  // `CalibrationOf<F>` distribute F over the four curve families (the bootstrap option shapes,
  // their instrument unions, and the live discount curve's callable surface inside a calibration)
  // while the artifact records the erased declaration — the same template blindness.
  '@totalfinance/fixed-income:fittedModelArtifact#0(input).calibration',
  '@totalfinance/fixed-income:fittedModelHoldout#0(input).calibration',
  '@totalfinance/fixed-income:evaluateFittedModel#0(input).model',
  '@totalfinance/fixed-income:compareFittedModels#0(input).baseline',
  '@totalfinance/fixed-income:compareFittedModels#0(input).candidate',
  // Stage 4.5 slice 5 (2026-09-03): `RunOf<Kind>` / `ResearchRunReport<Kind>` distribute Kind over the
  // eleven-kind union (eleven assumption shapes, ten diagnostics shapes, their depth frontiers) while
  // the artifact records the erased declaration — the same template blindness at the run.
  '@totalfinance/research:researchRunArtifact#0(input).run',
  '@totalfinance/research:compareResearchRuns#0(input).baseline',
  '@totalfinance/research:compareResearchRuns#0(input).candidate',
  // Stage 4.6 slice 3 (2026-09-04): `RunOf<Kind>` distributes the backtest run-kind union over the
  // cross-sectional result and the grid result (the request's signal / side-selection arms, the
  // execution description's frontiers) while the artifact records the erased declaration — the
  // same template blindness at the parameter that carries the run.
  '@totalfinance/backtest:backtestRunArtifact#0(input).run',
];
const genericTemplateRoutesUsed = new Set<string>();
const underGenericTemplate = (full: string): boolean => {
  const hit = UNINSTANTIATED_GENERIC_PARAMETER_ROUTES.find((prefix) => full.startsWith(prefix));
  if (hit === undefined) return false;
  genericTemplateRoutesUsed.add(hit);
  return true;
};

describe('the checker and the artifact agree about every union, by route', () => {
  const { rootNames, paths } = entryDeclarations();
  const program = ts.createProgram(rootNames, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    baseUrl: ROOT,
    paths,
    types: [],
  });
  const checker = program.getTypeChecker();

  /**
   * Parameters the artifact gives a contract identity and NO structure.
   *
   * An exact allowlist of `id | parameter | reason`, not a ceiling. A numeric ceiling permitted 30
   * of these, and the review established that only 7 matched its stated justification — "a shape the
   * harness cannot reason about at all". The rest were ordinary request objects with an exact
   * `typeDeclaration` and no field tree, and three of them PUBLISH `enforced`. A bound that admits a
   * population it was not written for is the dead-gate pattern this repository keeps finding, so the
   * exclusion now names every instance and its reason, and an entry that stops being needed fails.
   */
  const UNDESCRIBED: ReadonlyMap<string, string> = new Map(UNDESCRIBED_ALLOWLIST);

  interface Comparison {
    missing: string[];
    extra: string[];
    miscounted: string[];
    unresolved: string[];
    domainGaps: string[];
    callableGaps: string[];
    truncationGaps: string[];
    truncationExceptions: Set<string>;
    domainsCompared: number;
    undescribed: Set<string>;
    parametersCompared: number;
    unionsReached: number;
    recordsCompared: number;
    constructorsCompared: number;
    overloadsCompared: number;
  }

  /**
   * The checker walk is memoised on the DECLARATION, not on the record.
   *
   * 6,618 records resolve to 2,119 declarations, so without this the same parameter type is walked
   * an average of three times. The key includes the signature kind and both indices because those
   * select a different parameter, not a different view of one.
   */
  const walkCache = new Map<string, CheckerReach>();
  const routesFor = (
    implementation: string,
    kind: string,
    signatureIndex: number,
    argumentIndex: number,
    parameter: ts.Symbol,
  ): CheckerReach => {
    const key = `${implementation}|${kind}|${signatureIndex}|${argumentIndex}`;
    const cached = walkCache.get(key);
    if (cached) return cached;
    const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
    /**
     * Synthetic symbols still have types.
     *
     * Generic facade companions such as `BondFacade.explain(...callArguments: Args)` expose a
     * checker-created parameter symbol with no declaration node. Returning an empty walk for it made
     * every route beneath the constraint unverifiable and produced 54 self-authorised truncation
     * claims. `getTypeOfSymbol` is the checker-owned fallback for exactly this case.
     */
    const parameterType = declaration
      ? checker.getTypeOfSymbolAtLocation(parameter, declaration)
      : checker.getTypeOfSymbol(parameter);
    const reached = checkerUnionRoutes(checker, parameterType);
    walkCache.set(key, reached);
    return reached;
  };

  /**
   * The whole comparison as a FUNCTION OF AN ARTIFACT.
   *
   * Written this way so the plants below are the same code path as the real run. A plant checked by
   * a bespoke re-implementation proves the re-implementation works; this proves the gate does.
   */
  const compare = (subject: ManifestArtifact): Comparison => {
    const missing: string[] = [];
    const extra: string[] = [];
    const miscounted: string[] = [];
    const unresolved: string[] = [];
    const domainGaps: string[] = [];
    const callableGaps: string[] = [];
    const truncationGaps: string[] = [];
    const truncationExceptions = new Set<string>();
    let domainsCompared = 0;
    const undescribed = new Set<string>();
    let parametersCompared = 0;
    let unionsReached = 0;
    let recordsCompared = 0;
    let constructorsCompared = 0;
    let overloadsCompared = 0;

    for (const record of subject.contracts ?? []) {
      const resolved = resolveRecordCallable(program, checker, record);
      if ('failure' in resolved) {
        unresolved.push(`${record.id} (${record.implementation}) — ${resolved.failure}`);
        continue;
      }
      recordsCompared += 1;
      if (resolved.kind === 'construct') constructorsCompared += 1;
      if (resolved.signatures.length > 1) overloadsCompared += resolved.signatures.length - 1;

      /**
       * EVERY SIGNATURE, matched positionally against the record's own.
       *
       * The artifact records one entry per overload, so a disagreement in the COUNT is itself a
       * finding: it means one side is describing a callable the other cannot see.
       */
      const recorded = record.signatures ?? [];
      if (recorded.length !== resolved.signatures.length) {
        miscounted.push(
          `${record.id} — artifact records ${recorded.length} signature(s), ` +
            `the checker resolves ${resolved.signatures.length} ${resolved.kind} signature(s)`,
        );
      }

      resolved.signatures.forEach((signature, signatureIndex) => {
        const recordedSignature = recorded[signatureIndex];
        if (!recordedSignature) return;
        signature.getParameters().forEach((parameter, argumentIndex) => {
          const published = recordedSignature.parameters?.[argumentIndex];
          if (!published) return;

          const reached = routesFor(
            record.implementation ?? '',
            resolved.kind,
            signatureIndex,
            argumentIndex,
            parameter,
          );
          const label = `${record.id}#${signatureIndex}(${parameter.name})`;
          /**
           * A parameter the checker finds NO union in is still examined.
           *
           * Returning early here was a hole a plant walked through: an invented union on a `string`
           * parameter of a SECOND OVERLOAD went unnoticed, because "the checker reached nothing" was
           * being read as "there is nothing to say". What the artifact claims about a place is
           * precisely this gate's subject, and it is most suspect where the declaration offers no
           * union at all. The undescribed question is still only asked where there was something to
           * describe.
           */
          if (
            reached.unions.size === 0 &&
            reached.domains.size === 0 &&
            reached.callables.size === 0 &&
            !structureOf(published)
          ) {
            return;
          }
          if (!structureOf(published)) {
            const allowed = UNDESCRIBED.get(`${record.id}|${parameter.name}`);
            undescribed.add(`${record.id}|${parameter.name}`);
            if (!allowed) {
              missing.push(`${label} — the artifact describes no structure for this parameter`);
            }
            return;
          }

          const armsHere = new Map<string, { arms: number; route: CmpStep[]; armKeys: string[] }>();
          const truncationClaims: { key: string; route: CmpStep[]; node: ManifestNode }[] = [];
          const domainsHere = new Map<string, { values: LiteralValue[]; route: CmpStep[] }>();
          const callablesHere = new Map<string, { surface: string; route: CmpStep[] }>();
          const visitedHere = new Set<string>();
          const reexpanded = new Set<string>();
          armAwareWalk(published, (node, route, recursive) => {
            const key = renderCmp(route);
            if ((node.branches?.length ?? 0) > 1) {
              armsHere.set(key, {
                arms: node.branches!.length,
                route: [...route],
                armKeys: node.branches!.map((arm) => nodeFingerprint(arm)).sort(),
              });
            }
            if (node.truncated) truncationClaims.push({ key, route: [...route], node });
            if (recursive) reexpanded.add(key);
            visitedHere.add(key);
            if (node.literals && node.literals.length > 0) {
              domainsHere.set(key, { values: [...node.literals], route: [...route] });
            }
            if (node.callSignature || (node.callSignatures?.length ?? 0) > 0) {
              callablesHere.set(key, {
                surface: JSON.stringify({
                  legacy: node.callSignature ?? null,
                  signatures: node.callSignatures ?? [],
                }),
                route: [...route],
              });
            }
          });
          /**
           * A TRUNCATION CLAIM IS CHECKED BEFORE IT IS HONOURED.
           *
           * Truncation is the producer saying "I ran out of budget here". That is a fact about the
           * walk, not a property the artifact may assert at will, and this gate can derive it: a
           * claim is legitimate where THIS walk also ran out — at or past the depth cap — or where it
           * stopped for a cycle. Anywhere shallower, the artifact is authorising its own blind spot,
           * which is exactly what the review demonstrated by marking `bonds.amortizing`'s shallow
           * `amortization` union truncated and then corrupting a discriminator inside it.
           *
           * The checker records the exact route where its own cycle/depth rule stopped. A numeric
           * threshold is insufficient: a primitive at depth four is complete, while an object at
           * the same depth is not; and an unvisited artifact-only route is no evidence at all.
           */
          const legitimate = (claim: {
            key: string;
            route: CmpStep[];
            node: ManifestNode;
          }): boolean => {
            // The producer only truncates expandable containers. A changed primitive kind must not
            // turn the marker into a naked wildcard that can match any checker fingerprint.
            if (claim.node.kind !== 'object' && claim.node.kind !== 'array') return false;
            if (reached.frontiers.has(claim.key)) return true;
            const exception = `${record.implementation}|${claim.key}|${claim.node.kind ?? ''}:${claim.node.type ?? ''}`;
            if (!TRUNCATION_FRONTIER_EXCEPTIONS.has(exception)) return false;
            truncationExceptions.add(exception);
            return true;
          };
          for (const claim of truncationClaims) {
            if (legitimate(claim)) continue;
            if (underGenericTemplate(`${label}${claim.key}`)) continue;
            truncationGaps.push(
              `${label}${claim.key} — claims truncation at depth ` +
                `${String(reached.depths.get(claim.key))}, where the walk still had budget`,
            );
          }
          const claimedRoutes = new Set(truncationClaims.map((claim) => claim.key));
          for (const frontier of reached.frontiers) {
            if (claimedRoutes.has(frontier)) continue;
            if (underGenericTemplate(`${label}${frontier}`)) continue;
            truncationGaps.push(
              `${label}${frontier} — checker reaches an exact depth/cycle frontier, ` +
                (visitedHere.has(frontier)
                  ? 'artifact does not mark it truncated'
                  : 'artifact does not record the frontier node'),
            );
          }
          const honoured = truncationClaims.filter(legitimate);
          /**
           * Only STRICT DESCENDANTS of a legitimately truncated node are unknown; the node itself is
           * compared. Suppressing the node too let three real `SafeParseResult` unions be deleted at
           * truncated nodes with nothing to notice.
           */
          const stopped = (route: readonly CmpStep[]): boolean =>
            honoured.some((stop) => strictlyBeneath(route, stop.route));
          parametersCompared += 1;

          // CHECKER -> ARTIFACT: a union reached and not recorded, or recorded with a different arity.
          for (const [route, reach] of reached.unions) {
            unionsReached += 1;
            if (stopped(reach.route)) continue;
            if (underGenericTemplate(`${label}${route}`)) continue;
            const published2 = armsHere.get(route);
            if (published2 === undefined) {
              missing.push(
                `${label}${route} — checker reaches ${reach.arms} arms, artifact records none`,
              );
            } else if (published2.arms !== reach.arms) {
              miscounted.push(
                `${label}${route} — checker reaches ${reach.arms} arms, ` +
                  `artifact records ${published2.arms}`,
              );
            } else if (!armsCorrespond(published2.armKeys, reach.armKeys)) {
              /**
               * WHERE TRUNCATION REACHES, the arm LIST is complete and the arm SHAPES are not.
               *
               * Two cases, both the producer's stated bound rather than a defect: the union node
               * itself is truncated, or one of its ARMS is — `additionalProperties` is
               * `false | true | JSONSchema`, and the third arm is cut off with no members while the
               * checker sees all thirty. Demanding identity there reported 37 disagreements that
               * were the depth cap talking. Count is still compared, because the count IS a fact the
               * artifact asserts. The structural wildcard compares every arm's known outer shape
               * and every known sibling while declining only the exact subtree the producer did
               * not walk.
               */
              /**
               * SAME COUNT, DIFFERENT ARMS.
               *
               * Cardinality is not correspondence. A union of five string literals keeps its count
               * when one of them is renamed or deleted-and-replaced, and the arms ARE the contract
               * there — an arm whose whole identity is `'deposit'` cannot be checked by counting to
               * five. The identities are derived separately on each side and compared as sets, so
               * order remains irrelevant and membership does not.
               */
              miscounted.push(
                `${label}${route} — checker reaches arms ${reach.armKeys.join(', ')}, ` +
                  `artifact records ${published2.armKeys.join(', ')}`,
              );
            }
          }

          /**
           * ARTIFACT -> CHECKER, the direction that was never checked at all.
           *
           * Recording arms the declaration does not offer is the same class of defect as omitting the
           * ones it does: it means the published contract describes a grammar callers cannot use.
           */
          for (const [route, here] of armsHere) {
            if (stopped(here.route) || reached.unions.has(route) || reexpanded.has(route)) continue;
            extra.push(
              `${label}${route} — artifact records ${here.arms} arms, checker reaches no union`,
            );
          }

          /**
           * LITERAL DOMAINS, EXACTLY — same route, same typed values, both directions.
           *
           * This is what makes the union rule's literal exclusion honest. Every check that touched
           * domains before was a floor over a count, and a floor is blind to a deletion: removing a
           * real domain moved the total from 33 to 31 and nothing failed.
           */
          /**
           * EVERY domain is compared, including the ones inside arms.
           *
           * They were excluded while arms were addressed by INDEX, because the two walks enumerate a
           * union's constituents in different orders and an index named different arms on each side.
           * That exclusion left 1,216 literal-bearing nodes across 151 records unchecked — the
           * `'deposit'` discriminator among them. Arms are addressed by RANK over their fingerprints
           * now, which is order-independent, so an arm step is an ordinary step and a domain beneath
           * one is an ordinary domain.
           */
          for (const [route, reach] of reached.domains) {
            domainsCompared += 1;
            if (stopped(reach.route)) continue;
            if (!visitedHere.has(route)) continue;
            const here = domainsHere.get(route);
            if (!here) {
              domainGaps.push(
                `${label}${route} — checker admits ${showDomain(reach.values)}, artifact records no domain`,
              );
            } else if (!sameDomain(here.values, reach.values)) {
              domainGaps.push(
                `${label}${route} — checker admits ${showDomain(reach.values)}, ` +
                  `artifact records ${showDomain(here.values)}`,
              );
            }
          }
          for (const [route, here] of domainsHere) {
            if (stopped(here.route) || reached.domains.has(route) || reexpanded.has(route))
              continue;
            // Only where this walk actually STOOD. Elsewhere the difference is reach, not fact.
            if (!reached.visited.has(route)) continue;
            domainGaps.push(
              `${label}${route} — artifact records ${showDomain(here.values)}, checker admits no closed domain`,
            );
          }

          /** Complete callable parity: all overloads, parameter types/optionality/rest, and returns. */
          for (const [route, reachedCallable] of reached.callables) {
            // The same template blindness as the union walk: under an uninstantiated-generic route
            // the artifact records the erased declaration, so a distributed arm's callables (a live
            // curve's methods inside one family's calibration) are not a parity finding.
            if (stopped(reachedCallable.route) || underGenericTemplate(`${label}${route}`))
              continue;
            const publishedCallable = callablesHere.get(route);
            if (!publishedCallable) {
              callableGaps.push(
                `${label}${route} — checker reaches a callable, artifact records no callable surface`,
              );
            } else if (publishedCallable.surface !== reachedCallable.surface) {
              callableGaps.push(
                `${label}${route} — checker callable ${reachedCallable.surface}, ` +
                  `artifact records ${publishedCallable.surface}`,
              );
            }
          }
          for (const [route, publishedCallable] of callablesHere) {
            if (
              stopped(publishedCallable.route) ||
              underGenericTemplate(`${label}${route}`) ||
              reached.callables.has(route) ||
              reexpanded.has(route) ||
              !reached.visited.has(route)
            ) {
              continue;
            }
            callableGaps.push(
              `${label}${route} — artifact records a callable surface, checker reaches none`,
            );
          }
        });
      });
    }

    return {
      missing,
      extra,
      miscounted,
      unresolved,
      domainGaps,
      callableGaps,
      truncationGaps,
      truncationExceptions,
      domainsCompared,
      undescribed,
      parametersCompared,
      unionsReached,
      recordsCompared,
      constructorsCompared,
      overloadsCompared,
    };
  };

  const {
    missing,
    extra,
    miscounted,
    unresolved,
    domainGaps,
    callableGaps,
    truncationGaps,
    truncationExceptions,
    domainsCompared,
    undescribed,
    parametersCompared,
    unionsReached,
    recordsCompared,
    constructorsCompared,
    overloadsCompared,
  } = compare(artifact);

  it('compares a real population — a gate over nothing proves nothing', () => {
    /**
     * COVERAGE IS STATED EXACTLY, not as a floor.
     *
     * "More than N records matched" is the shape of bound that let a name-suffix join compare 3,425
     * of 6,618 records and read as healthy. Every published record must resolve to a declaration and
     * be compared against its own facts; anything less is a record nobody checked, and the equality
     * says so without needing a number to be maintained.
     */
    expect(recordsCompared, 'a published record went uncompared').toBe(
      (artifact.contracts ?? []).length,
    );

    /**
     * The rest are floors on MEASURED numbers, each guarding a way this gate could quietly stop
     * looking at something. Measured at the commit that introduced them: 158 entry declarations,
     * 602 parameters carrying at least one union, 1,069 unions reached, 166 constructors, 3 overloads
     * beyond a first signature. Set below those with room for the surface to shrink honestly.
     */
    expect(rootNames.length, 'no package entry declarations resolved').toBeGreaterThan(140);
    expect(parametersCompared, 'no parameters with unions were compared').toBeGreaterThan(500);
    expect(
      unionsReached,
      'the checker walk found no unions — it is not descending',
    ).toBeGreaterThan(900);
    /**
     * The two signature KINDS and the overload population, asserted separately.
     *
     * Each is a hole a plant walked through: constructors because only call signatures were
     * traversed, overloads because only `signatures[0]` was read. Folded into a total, either could
     * fall to zero without moving it.
     */
    expect(constructorsCompared, 'no constructor was compared').toBeGreaterThan(150);
    expect(overloadsCompared, 'no overload beyond the first was compared').toBeGreaterThanOrEqual(
      3,
    );
  });

  it('resolves every published record to a declaration', () => {
    const unique = [...new Set(unresolved)].sort();
    expect(
      unique.slice(0, 20),
      `${unique.length} records could not be resolved through the checker — ` +
        `an unresolvable record is an uncompared record`,
    ).toEqual([]);
  });

  it('names every undescribed parameter with its reason, rather than counting them', () => {
    /**
     * A SEPARATE, HONEST GAP — now enumerated.
     *
     * These are parameters the artifact gives a contract identity and no structure at all. This gate
     * cannot speak about a union inside a shape the artifact never described, and folding them in
     * reported one undescribed contract as many missing arms. The allowlist is exact in BOTH
     * directions: an unlisted one fails as a missing description, and a listed one that no longer
     * occurs fails as a stale entry, so the exclusion cannot outlive its subject.
     */
    const listed = new Set(UNDESCRIBED.keys());
    const unlisted = [...undescribed].filter((entry) => !listed.has(entry)).sort();
    const stale = [...listed].filter((entry) => !undescribed.has(entry)).sort();
    expect(unlisted, `${unlisted.length} undescribed parameters are not on the allowlist`).toEqual(
      [],
    );
    expect(stale, `${stale.length} allowlist entries no longer occur — delete them`).toEqual([]);
  });

  it('records a union at every route the checker reaches one', () => {
    const unique = [...new Set(missing)].sort();
    expect(
      unique.slice(0, 25),
      `${unique.length} unions the checker reaches are absent from the artifact ` +
        `(of ${unionsReached} reached across ${parametersCompared} parameters)`,
    ).toEqual([]);
  });

  it('records the same NUMBER of arms the checker reaches', () => {
    const unique = [...new Set(miscounted)].sort();
    expect(
      unique.slice(0, 25),
      `${unique.length} unions disagree on arm count or signature count`,
    ).toEqual([]);
  });

  it('publishes the same LITERAL DOMAIN the checker admits, value for value', () => {
    /**
     * The union rule declines a literal-only union because its values belong in a domain. This is
     * the check that makes the deferral honest — exact typed values, same route, both directions.
     * Its predecessor asserted "more than 20 numeric domains exist", and a floor cannot see a
     * deletion: the review removed a real `2 | 1` domain, watched the total fall 33 -> 31, and the
     * suite stayed green.
     */
    expect(
      domainsCompared,
      'no literal domain was compared — this gate has stopped selecting its subject',
    ).toBeGreaterThan(2000);
    const unique = [...new Set(domainGaps)].sort();
    expect(unique.slice(0, 25), `${unique.length} literal domains disagree`).toEqual([]);
  });

  it('publishes every callable surface completely, overload for overload', () => {
    /**
     * Arity alone makes `() => string` indistinguishable from `() => number`, and makes optional,
     * rest, overloaded and generic callbacks lossy in different ways. The artifact is consumed by
     * synthesis and enforcement, so each callable node must retain exactly what the checker exposes:
     * ordered overloads, parameter names/types/optionality/rest, generic constraints/defaults,
     * explicit `this`, and return type. Compared in both directions at the same route.
     */
    const unique = [...new Set(callableGaps)].sort();
    expect(unique.slice(0, 25), `${unique.length} callable surfaces disagree`).toEqual([]);
  });

  it('accepts a truncation claim only where the walk also ran out of budget', () => {
    /**
     * Truncation was self-authorising: any node carrying the flag became a suppression boundary and
     * an exemption from identity comparison, so the review marked a SHALLOW union truncated,
     * corrupted a discriminator inside it, and the gate reported nothing.
     */
    const unique = [...new Set(truncationGaps)].sort();
    expect(
      unique.slice(0, 200),
      `${unique.length} truncation claims sit where this walk still had depth to spend:\n${unique.join('\n')}`,
    ).toEqual([]);
    const stale = [...TRUNCATION_FRONTIER_EXCEPTIONS.keys()]
      .filter((entry) => !truncationExceptions.has(entry))
      .sort();
    expect(
      stale,
      `${stale.length} truncation-frontier exceptions no longer occur — delete them`,
    ).toEqual([]);
    const staleGeneric = UNINSTANTIATED_GENERIC_PARAMETER_ROUTES.filter(
      (prefix) => !genericTemplateRoutesUsed.has(prefix),
    ).sort();
    expect(
      staleGeneric,
      `${staleGeneric.length} uninstantiated-generic route prefixes no longer occur — delete them`,
    ).toEqual([]);
  });

  it('records no union the checker cannot reach', () => {
    const listed = new Set(UNREACHED_BY_THIS_WALK);
    const unique = [...new Set(extra)].sort();
    const unlisted = unique.filter((entry) => !listed.has(entry.slice(0, entry.indexOf(' — '))));
    expect(
      unlisted.slice(0, 25),
      `${unlisted.length} unions are published at routes the checker reaches no union`,
    ).toEqual([]);
    const seen = new Set(unique.map((entry) => entry.slice(0, entry.indexOf(' — '))));
    const stale = [...listed].filter((entry) => !seen.has(entry)).sort();
    expect(stale, `${stale.length} entries no longer occur — delete them`).toEqual([]);
  });
  /**
   * THE PLANTS — defects this gate previously passed, each now a test.
   *
   * Every one is a consequence of the same mistake: the gate matched artifact records to declarations
   * by NAME SUFFIX and pooled their facts into one bag, then asserted only that a route was present
   * somewhere in that bag. They are kept because "the gate would catch this" is a claim, and a claim
   * about a gate is worth exactly as much as the experiment that tried to break it.
   *
   * They run the SAME `compare` the real assertions run, over an artifact with one record replaced by
   * a mutated copy. Nothing else is shared with them, and nothing about them is bespoke.
   */
  const plant = (id: string, mutate: (record: ManifestRecord) => void): ManifestArtifact => {
    const records = artifact.contracts ?? [];
    const index = records.findIndex((record) => record.id === id);
    expect(index, `the plant target ${id} is not in the artifact`).toBeGreaterThanOrEqual(0);
    const copy = JSON.parse(JSON.stringify(records[index])) as ManifestRecord;
    mutate(copy);
    return { contracts: [...records.slice(0, index), copy, ...records.slice(index + 1)] };
  };

  /** The union with the MOST arms under a record — so dropping one still leaves a union. */
  const widestUnion = (record: ManifestRecord): ManifestNode => {
    let widest: ManifestNode | undefined;
    for (const signature of record.signatures ?? []) {
      for (const parameter of signature.parameters ?? []) {
        armAwareWalk(parameter, (node) => {
          const arms = node.branches?.length ?? 0;
          if (arms > 1 && arms > (widest?.branches?.length ?? 0)) widest = node;
        });
      }
    }
    if (!widest) throw new Error(`no union under ${record.id}`);
    return widest;
  };

  /** The first union node under a record, wherever it is — plants act on the same place either way. */
  const firstUnion = (record: ManifestRecord): ManifestNode => {
    for (const signature of record.signatures ?? []) {
      for (const parameter of signature.parameters ?? []) {
        let found: ManifestNode | undefined;
        armAwareWalk(parameter, (node) => {
          if (!found && (node.branches?.length ?? 0) > 1) found = node;
        });
        if (found) return found;
      }
    }
    throw new Error(`no union under ${record.id}`);
  };

  /** Find one exact published node without relying on JSON line positions or traversal order. */
  const findNode = (
    record: ManifestRecord,
    predicate: (node: ManifestNode, route: CmpStep[]) => boolean,
  ): ManifestNode => {
    for (const signature of record.signatures ?? []) {
      for (const parameter of signature.parameters ?? []) {
        let found: ManifestNode | undefined;
        armAwareWalk(parameter, (node, route) => {
          if (!found && predicate(node, route)) found = node;
        });
        if (found) return found;
      }
    }
    throw new Error(`no matching node under ${record.id}`);
  };

  it('PLANT: catches an arm being dropped from a union', () => {
    /**
     * A union with more than two arms, deliberately: dropping one still leaves a union, so the gate
     * has to compare the COUNT rather than notice the route disappearing. `crossOverSeries` was the
     * first attempt and its union has exactly two arms — removing one left a single arm, which is not
     * a union at all, and the miss surfaced as an absence. That would have proved the weaker property.
     */
    const subject = plant('@totalfinance/backtest:vectorized', (record) => {
      const union = widestUnion(record);
      union.branches = union.branches!.slice(0, -1);
    });
    const result = compare(subject);
    expect(
      result.miscounted.filter((entry) => entry.includes('vectorized')),
      'dropping an arm changed nothing — the gate compares presence, not count',
    ).not.toEqual([]);
  });

  it('PLANT: catches arms stripped from ONE ALIAS of a shared implementation', () => {
    /**
     * `crossOverSeries` is published three ways over one declaration. Facts pooled across aliases let
     * any one spelling lose its arms silently, because a sibling still recorded them — which is how
     * `ironButterfly` survived the same experiment.
     */
    const subject = plant('totalfinance:crossOverSeries', (record) => {
      const union = firstUnion(record);
      delete union.branches;
    });
    const result = compare(subject);
    expect(
      result.missing.filter((entry) => entry.startsWith('totalfinance:crossOverSeries')),
      'one alias lost its arms and its siblings covered for it',
    ).not.toEqual([]);
  });

  it('PLANT: catches a union removed from a CONSTRUCTOR parameter', () => {
    /**
     * Only call signatures were traversed, so a class was reached through `getExportsOfModule`, found
     * to have no call signature, and skipped entirely. 166 constructors were never compared.
     */
    const subject = plant('@totalfinance/volatility:VolatilitySurface.constructor', (record) => {
      const union = firstUnion(record);
      delete union.branches;
    });
    const result = compare(subject);
    expect(
      result.missing.filter((entry) => entry.includes('VolatilitySurface.constructor')),
      'a constructor parameter is not being compared',
    ).not.toEqual([]);
  });

  it('PLANT: inspects EVERY overload, not only the first', () => {
    /**
     * Inverted deliberately. `cdlPattern` is the only multi-signature shape on the surface and neither
     * of its signatures carries a union, so there is nothing to remove from the second one. Adding a
     * union the declaration does not have proves the same property: if signature 1 were not traversed,
     * an invented union there would go unnoticed.
     */
    const subject = plant('@totalfinance/technical-analysis:cdlPattern', (record) => {
      const parameter = record.signatures![1]!.parameters![1]!;
      parameter.branches = [
        { type: 'string', kind: 'primitive' },
        { type: 'number', kind: 'numeric' },
      ];
    });
    const result = compare(subject);
    expect(
      result.extra.filter((entry) => entry.includes('cdlPattern#1')),
      'the second overload is not being inspected',
    ).not.toEqual([]);
  });
  /**
   * DOMAIN PLANTS — the five mutations RV28 required, each run through the same `compare`.
   *
   * The predecessor to this gate asserted "more than 20 numeric domains exist". The review deleted a
   * real `2 | 1` domain, watched the count fall 33 -> 31, and the suite stayed green. A floor cannot
   * see a deletion, and these are what make the difference legible: every one of them changes a value
   * rather than a count, and every one must be caught.
   */
  const domainNode = (record: ManifestRecord): ManifestNode => {
    let found: ManifestNode | undefined;
    for (const signature of record.signatures ?? []) {
      for (const parameter of signature.parameters ?? []) {
        armAwareWalk(parameter, (node, route) => {
          if (found || route.length === 0 || route.some((step) => 'branch' in step)) return;
          if (node.literals && node.literals.length > 1) found = node;
        });
      }
    }
    if (!found) throw new Error(`no non-arm domain under ${record.id}`);
    return found;
  };

  const DOMAIN_TARGET = '@totalfinance/core:createRuleCalendar';

  it('PLANT: catches a literal domain being REMOVED', () => {
    const subject = plant(DOMAIN_TARGET, (record) => {
      delete domainNode(record).literals;
    });
    expect(
      compare(subject).domainGaps.filter((gap) => gap.includes('createRuleCalendar')),
      'a deleted domain changed nothing — this gate is counting, not comparing',
    ).not.toEqual([]);
  });

  it('PLANT: catches ONE VALUE being removed from a domain', () => {
    const subject = plant(DOMAIN_TARGET, (record) => {
      const node = domainNode(record);
      node.literals = node.literals!.slice(0, -1);
    });
    expect(
      compare(subject).domainGaps.filter((gap) => gap.includes('createRuleCalendar')),
    ).not.toEqual([]);
  });

  it('PLANT: catches a value being ADDED to a domain', () => {
    const subject = plant(DOMAIN_TARGET, (record) => {
      const node = domainNode(record);
      node.literals = [...node.literals!, 99];
    });
    expect(
      compare(subject).domainGaps.filter((gap) => gap.includes('createRuleCalendar')),
    ).not.toEqual([]);
  });

  it('PLANT: catches `1` being retyped as `"1"`', () => {
    /**
     * The one a text comparison cannot see. `1` and `'1'` are different admissions, and a domain
     * serialised to text made a numeric contract and a stringly one identical to the membership
     * test, the fingerprint, and the value the probe chooses to violate it with.
     */
    const subject = plant(DOMAIN_TARGET, (record) => {
      const node = domainNode(record);
      node.literals = node.literals!.map((value) =>
        typeof value === 'number' ? String(value) : value,
      );
    });
    expect(
      compare(subject).domainGaps.filter((gap) => gap.includes('createRuleCalendar')),
      'a numeric domain retyped as strings was accepted as the same domain',
    ).not.toEqual([]);
  });

  it('distinguishes `true` from `false`, and a number from its decimal spelling', () => {
    /**
     * The typed comparison itself, proven directly.
     *
     * The `true`/`false` mutation cannot be planted against the live surface through this gate, and
     * the reason is a measured fact rather than a convenience: EVERY singleton boolean domain on the
     * public surface today sits at an ARM route (`.safeParse()|0.success`,
     * `.toJSONSchema().additionalProperties|1`), and domain comparison excludes arm routes because an
     * arm index is only meaningful once both sides agree on the enumeration. Rather than invent a
     * fixture that resembles the surface, the comparison that WOULD catch it is asserted here, and
     * the probe side — where a singleton boolean must actually be violated — is covered by its own
     * tests in `contract-probe`.
     */
    expect(sameDomain([true], [false])).toBe(false);
    expect(sameDomain([true], [true])).toBe(true);
    expect(sameDomain([1], ['1'])).toBe(false);
    expect(sameDomain([1, 2], [2, 1])).toBe(true);
    expect(sameDomain([1, 2], [1])).toBe(false);
    expect(sameDomain([1], [1, 2])).toBe(false);
  });

  /**
   * CALLABLE PLANTS — equal arity is not equal contract.
   */
  it('PLANT: catches a callback return changing with arity held constant', () => {
    const subject = plant('@totalfinance/core:requireFiniteFields', (record) => {
      const callback = findNode(
        record,
        (node) => node.name === 'exampleCall' && (node.callSignatures?.length ?? 0) > 0,
      );
      expect(callback.callSignatures![0]!.returns).toBe('string');
      // Leave the legacy arity/return pair untouched: only the complete semantic record is corrupted.
      callback.callSignatures![0]!.returns = 'number';
    });
    expect(
      compare(subject).callableGaps.filter((gap) => gap.includes('exampleCall')),
      '`() => string` and `() => number` still fingerprint as the same callback',
    ).not.toEqual([]);
  });

  it('PLANT: catches callback parameter type, optionality and rest semantics', () => {
    const subject = plant('@totalfinance/technical-analysis:makeIndicator', (record) => {
      const callback = record.signatures![0]!.parameters!.find(
        (parameter) => parameter.name === 'make',
      )!;
      const parameter = callback.callSignatures![0]!.parameters[0]!;
      parameter.type = 'number';
      parameter.optional = true;
      parameter.rest = true;
    });
    expect(
      compare(subject).callableGaps.filter((gap) => gap.includes('makeIndicator#0(make)')),
      'same-arity callbacks with different argument contracts still compare equal',
    ).not.toEqual([]);
  });

  it('IDENTITY: same-arity callable arms retain their complete contract before the surface needs it', () => {
    /**
     * No public union currently offers two callable arms. That makes complete callable detail live
     * in the general callable-parity gate but not load-bearing in ARM identity: reducing both arm
     * fingerprints to legacy arity would leave every live union test green. Keep a synthetic pair so
     * the first such public union inherits a proved identity rule instead of discovering the hole.
     */
    const callableArm = (returns: string, optional = false): ManifestNode => ({
      type: `(value${optional ? '?' : ''}: number) => ${returns}`,
      kind: 'function',
      callSignature: { parameters: 1, returns },
      callSignatures: [
        {
          parameters: [{ name: 'value', type: 'number', optional, rest: false }],
          returns,
        },
      ],
    });
    const stringArm = nodeFingerprint(callableArm('string'));
    const numberArm = nodeFingerprint(callableArm('number'));
    const optionalStringArm = nodeFingerprint(callableArm('string', true));

    expect(stringArm).not.toBe(numberArm);
    expect(stringArm).not.toBe(optionalStringArm);
    expect(armsCorrespond([stringArm, numberArm], [numberArm, stringArm])).toBe(true);
    expect(armsCorrespond([stringArm, numberArm], [stringArm, optionalStringArm])).toBe(false);
  });

  /**
   * TRUNCATION PLANTS — suppression must cover strict descendants and nothing else.
   */
  it('PLANT: ordinary text containing `trunc` is never a wildcard', () => {
    expect(armsCorrespond(['O{truncationMethod:str}'], ['O{differentMethod:str}'])).toBe(false);
  });

  it('PLANT: a truncation wildcard cannot cross its closing delimiter into siblings', () => {
    const pattern = [`O{child:O{${TRUNCATION_WILDCARD}},known:num}`];
    expect(armsCorrespond(pattern, ['O{child:O{value:num},known:num}'])).toBe(true);
    expect(armsCorrespond(pattern, ['O{child:O{value:num},known:str}'])).toBe(false);
    expect(armsCorrespond(pattern, ['O{child:O{value:num},hidden:str,known:num}'])).toBe(false);
  });

  it('PLANT: catches a union removed AT a truncated node', () => {
    /**
     * The node itself was suppressed along with everything under it, so three real `SafeParseResult`
     * unions were deleted at truncated nodes without moving a test.
     */
    const target = '@totalfinance/core:schema.array';
    const subject = plant(target, (record) => {
      let stripped = false;
      for (const signature of record.signatures ?? []) {
        for (const parameter of signature.parameters ?? []) {
          armAwareWalk(parameter, (node) => {
            if (node.truncated && (node.branches?.length ?? 0) > 1) {
              delete node.branches;
              stripped = true;
            }
          });
        }
      }
      expect(stripped, 'no truncated union-bearing node to strip').toBe(true);
    });
    expect(
      compare(subject).missing.filter((gap) => gap.includes('schema.array')),
      'a union at a truncated node is not being compared',
    ).not.toEqual([]);
  });

  it('PLANT: catches an arm changing outer kind AT a legitimate truncation frontier', () => {
    const target = '@totalfinance/core:schema.array';
    const subject = plant(target, (record) => {
      let changed = false;
      for (const signature of record.signatures ?? []) {
        for (const parameter of signature.parameters ?? []) {
          armAwareWalk(parameter, (node) => {
            if (!changed && node.truncated && (node.branches?.length ?? 0) > 1) {
              const arm = node.branches![0]!;
              arm.kind = 'numeric';
              arm.truncated = true;
              changed = true;
            }
          });
        }
      }
      expect(changed, 'no truncated union-bearing node to corrupt').toBe(true);
    });
    const result = compare(subject);
    expect(
      [...result.miscounted, ...result.truncationGaps].filter((gap) => gap.includes(target)),
      'a truncation marker erased the known outer kind of an arm',
    ).not.toEqual([]);
  });

  it('PLANT: a truncated node does not mask a SIBLING whose name extends it', () => {
    /**
     * A REAL sibling pair. Twice now this plant renamed the TRUNCATED NODE ITSELF and put a union on
     * it, which tests something else entirely — and twice the review proved it by restoring the
     * rendered-string `startsWith` rule and watching every parity test pass. The second time it was
     * written correctly and then deleted by my own de-duplication of a botched splice, and the spec
     * kept claiming it existed. Verified here by regression, not by inspection.
     *
     * `FeaturePipeline#applyBars`'s `explain().assumptions` genuinely declares both `conventions`
     * (truncated) and `conventionsVersion`. `conventions` is left EXACTLY as it is; the union is
     * invented on the sibling. Under text matching `.conventions` is a prefix of `.conventionsVersion`
     * and swallows it whole.
     */
    const subject = plant(
      '@totalfinance/technical-analysis:FeaturePipeline#applyBars',
      (record) => {
        let planted = false;
        const visit = (node: ManifestNode): void => {
          for (const members of [node.fields, node.fieldTree]) {
            const list = members ?? [];
            const truncated = list.find((m) => m.name === 'conventions' && m.truncated);
            const sibling = list.find((m) => m.name === 'conventionsVersion');
            if (truncated && sibling && !planted) {
              sibling.branches = [
                { type: 'string', kind: 'string' },
                { type: 'number', kind: 'numeric' },
              ];
              planted = true;
            }
            for (const member of list) visit(member);
          }
          for (const arm of node.branches ?? []) visit(arm);
          if (node.element) visit(node.element);
          if (node.returns) visit(node.returns);
          for (const position of node.tuple ?? []) visit(position);
        };
        for (const signature of record.signatures ?? []) {
          for (const parameter of signature.parameters ?? []) visit(parameter);
        }
        expect(
          planted,
          'the truncated `conventions` / sibling `conventionsVersion` pair was not found',
        ).toBe(true);
      },
    );
    expect(
      compare(subject).extra.filter((gap) => gap.includes('conventionsVersion')),
      'a truncated node is masking a sibling whose name merely extends it',
    ).not.toEqual([]);
  });

  it('PLANT: an artifact-only ghost cannot authorise itself with `truncated: true`', () => {
    const subject = plant('@totalfinance/core:requireFiniteFields', (record) => {
      const options = record.signatures![0]!.parameters![0]!;
      options.fieldTree = [
        ...(options.fieldTree ?? []),
        {
          name: 'inventedGhost',
          type: 'InventedGhost',
          kind: 'object',
          optional: true,
          nullable: false,
          truncated: true,
          branches: [
            { type: "{ kind: 'one' }", kind: 'object' },
            { type: "{ kind: 'two' }", kind: 'object' },
          ],
        },
      ];
    });
    expect(
      compare(subject).truncationGaps.filter((gap) => gap.includes('inventedGhost')),
      'an unvisited artifact-only route used truncation as evidence for itself',
    ).not.toEqual([]);
  });

  it('PLANT: catches a legitimate checker frontier losing its truncation marker', () => {
    const subject = plant('@totalfinance/core:schema.array', (record) => {
      const frontier = findNode(record, (node) => node.truncated === true);
      delete frontier.truncated;
    });
    expect(
      compare(subject).truncationGaps.filter((gap) => gap.includes('schema.array')),
      'the inverse check does not require a marker at checker-derived frontiers',
    ).not.toEqual([]);
  });

  it('PLANT: catches a legitimate checker frontier node disappearing entirely', () => {
    const target = '@totalfinance/core:schema.array';
    const subject = plant(target, (record) => {
      const remove = (node: ManifestNode): number => {
        let removed = 0;
        for (const key of ['fields', 'fieldTree', 'branches', 'tuple'] as const) {
          const children = node[key];
          if (!children) continue;
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index]!;
            if (child.truncated) {
              children.splice(index, 1);
              removed += 1;
            } else {
              removed += remove(child);
            }
          }
        }
        if (node.element?.truncated) {
          delete node.element;
          removed += 1;
        } else if (node.element) removed += remove(node.element);
        if (node.returns?.truncated) {
          delete node.returns;
          removed += 1;
        } else if (node.returns) removed += remove(node.returns);
        return removed;
      };
      const removed = (record.signatures ?? []).reduce(
        (total, signature) =>
          total +
          (signature.parameters ?? []).reduce((sum, parameter) => sum + remove(parameter), 0),
        0,
      );
      expect(removed, 'no removable checker frontier exists').toBeGreaterThan(0);
    });
    expect(
      compare(subject).truncationGaps.filter(
        (gap) => gap.includes(target) && gap.includes('does not record the frontier node'),
      ),
      'a missing frontier node was treated as though the artifact had reached it',
    ).not.toEqual([]);
  });

  /**
   * IN-ARM DOMAIN PLANTS (RV29) — the 1,216 literal-bearing nodes that lived inside union arms.
   *
   * Domain comparison used to skip every route containing a branch step, because the two walks order
   * arms differently and an INDEX is not a name. That exclusion left 1,216 nodes across 151 records
   * unchecked: the review deleted the caller-authored `'deposit'` discriminator from
   * `curves.bootstrap` and its siblings, regenerated everything, and all 7,900 tests passed. Arms are
   * addressed by SEMANTIC IDENTITY now, so these routes are compared like any other.
   *
   * The same deletion was re-run at the PRODUCER, with a full regeneration, after this change: the
   * gate reports twelve disagreeing domains. These in-memory plants are the standing protection; that
   * run is the evidence the whole pipeline carries the change through.
   */
  /**
   * A NAMED FIELD carrying a domain, sitting beneath an arm.
   *
   * A field rather than the arm itself, deliberately. An arm that IS a literal has that literal as
   * its identity, so mutating it is caught as an arm-identity change; a field INSIDE an arm is the
   * case the exclusion actually hid — `bootstrap(instruments)` has four object arms and each declares
   * its own `type` discriminator, which is precisely the `'deposit'` the review deleted.
   */
  const inArmFieldDomain = (
    record: ManifestRecord,
    pick: (values: readonly LiteralValue[]) => boolean,
  ): ManifestNode => {
    let found: ManifestNode | undefined;
    for (const signature of record.signatures ?? []) {
      for (const parameter of signature.parameters ?? []) {
        armAwareWalk(parameter, (node, route) => {
          if (found || !route.some((step) => 'arm' in step)) return;
          const last = route[route.length - 1];
          if (!last || !('property' in last)) return;
          if (node.literals && node.literals.length > 0 && pick(node.literals)) found = node;
        });
      }
    }
    if (!found) throw new Error(`no matching in-arm field domain under ${record.id}`);
    return found;
  };

  it("PLANT: catches the `'deposit'` discriminator removed from inside an arm", () => {
    /**
     * The review's own experiment. It deleted this domain at the producer, regenerated everything,
     * and all 7,900 tests passed. Re-run at the producer after this change, the gate reports twelve
     * disagreeing domains; here it is the standing in-memory guard.
     */
    const subject = plant('@totalfinance/fixed-income:curves.bootstrap', (record) => {
      /**
       * The EXACT domain, asserted before it is touched. Selecting "the first all-string domain
       * under an arm" picked `['ois','swap']` by traversal order, so the test proved that SOME in-arm
       * domain is compared while advertising the review's `'deposit'` reproduction.
       */
      const node = inArmFieldDomain(
        record,
        (values) => values.length === 1 && values[0] === 'deposit',
      );
      expect(node.name, 'the deposit discriminator is not on a `type` field').toBe('type');
      expect(node.literals).toEqual(['deposit']);
      delete node.literals;
    });
    expect(
      compare(subject).domainGaps.filter((gap) => gap.includes('curves.bootstrap')),
      'a domain on a field inside a union arm is not being compared',
    ).not.toEqual([]);
  });

  it('PLANT: catches a NUMERIC domain changed inside an arm', () => {
    const subject = plant('@totalfinance/structure:ExposureProfile.constructor', (record) => {
      const node = inArmFieldDomain(record, (values) => values.some((v) => typeof v === 'number'));
      node.literals = node.literals!.map((value) => (value === 1 ? 2 : value));
    });
    expect(
      compare(subject).domainGaps.filter((gap) => gap.includes('ExposureProfile')),
    ).not.toEqual([]);
  });

  it('PLANT: catches a BOOLEAN domain flipped inside an arm', () => {
    /**
     * The mutation RV28 asserted on the comparison function because "every singleton boolean domain
     * sits at an arm route". Both halves were wrong: 32 sit inside arms and 7 outside, and the
     * exclusion the claim leaned on was itself the defect — being inside an arm stopped meaning
     * "uncomparable" the moment arms acquired identities.
     */
    const subject = plant('@totalfinance/core:schema.array', (record) => {
      const node = inArmFieldDomain(record, (values) => values.some((v) => typeof v === 'boolean'));
      node.literals = node.literals!.map((value) => (typeof value === 'boolean' ? !value : value));
    });
    expect(compare(subject).domainGaps.filter((gap) => gap.includes('schema.array'))).not.toEqual(
      [],
    );
  });

  it('PLANT: one arm cannot cover for another — a MOVED domain is caught at both ends', () => {
    /**
     * The reason the route keeps the arm's identity instead of dropping the index and comparing a
     * pooled multiset. A multiset is preserved by moving a domain from one arm to another; a route
     * keyed by the arm is not, and the move is reported twice — absent where it belonged, unexpected
     * where it landed.
     */
    const subject = plant('@totalfinance/fixed-income:curves.bootstrap', (record) => {
      const parameter = record.signatures![0]!.parameters![0]!;
      const arms = parameter.element?.branches ?? [];
      const discriminators = arms
        .map((arm) => (arm.fields ?? []).find((field) => field.name === 'type'))
        .filter((field): field is ManifestNode => field?.literals !== undefined);
      expect(discriminators.length, 'need two discriminated arms to swap').toBeGreaterThan(1);
      const [first, second] = discriminators as [ManifestNode, ManifestNode];
      const held = [...first.literals!];
      first.literals = [...second.literals!];
      second.literals = held;
    });
    const gaps = compare(subject).domainGaps.filter((gap) => gap.includes('curves.bootstrap'));
    expect(gaps.length, 'a domain moved between arms went unnoticed').toBeGreaterThan(1);
  });
  /**
   * FINGERPRINT PLANTS (RV30) — the two the review named, and the truncation lie.
   */
  it('PLANT: catches an arm changing primitive — `number` becomes `string`', () => {
    /**
     * The identity used to be a singleton literal, member names, callability and arity. It could not
     * tell `number` from `string`, so `number | ArrayLike<number>` becoming
     * `string | ArrayLike<number>` left the arm count at two and the gate silent.
     */
    const subject = plant('@totalfinance/backtest:crossOverSeries', (record) => {
      let flipped = false;
      for (const signature of record.signatures ?? []) {
        for (const parameter of signature.parameters ?? []) {
          for (const arm of parameter.branches ?? []) {
            if (!flipped && arm.kind === 'numeric') {
              arm.kind = 'string';
              arm.type = 'string';
              flipped = true;
            }
          }
        }
      }
      expect(flipped, 'no numeric arm to retype').toBe(true);
    });
    expect(
      compare(subject).miscounted.filter((gap) => gap.includes('crossOverSeries')),
      'an arm changed primitive and the identity could not tell',
    ).not.toEqual([]);
  });

  it('PLANT: checks a known arm even when a different arm contains truncation', () => {
    const subject = plant('@totalfinance/technical-analysis:defineIndicator', (record) => {
      const value = findNode(
        record,
        (node) => node.name === 'value' && (node.branches?.length ?? 0) === 5,
      );
      expect(
        value.branches!.some((arm) =>
          (arm.fields ?? []).some((field) => field.name === 'items' && field.truncated),
        ),
        'the sibling recursive arm is no longer truncated, so this plant lost its subject',
      ).toBe(true);
      const numberArm = value.branches!.find((arm) =>
        (arm.fields ?? []).some((field) => field.literals?.includes('number')),
      )!;
      const unit = numberArm.fields!.find((field) => field.name === 'unit')!;
      unit.kind = 'numeric';
      unit.type = 'number | undefined';
    });
    expect(
      compare(subject).miscounted.filter((gap) => gap.includes('defineIndicator')),
      'one truncated arm turned every fully known sibling arm into a wildcard',
    ).not.toEqual([]);
  });

  it('PLANT: truncation wildcards only their exact subtree, not known siblings in the same arm', () => {
    const subject = plant('@totalfinance/technical-analysis:defineIndicator', (record) => {
      const value = findNode(
        record,
        (node) => node.name === 'value' && (node.branches?.length ?? 0) === 5,
      );
      const arrayArm = value.branches!.find((arm) =>
        (arm.fields ?? []).some((field) => field.literals?.includes('array')),
      )!;
      expect(
        arrayArm.fields!.some((field) => field.name === 'items' && field.truncated),
        'the recursive `items` subtree is no longer truncated, so this plant lost its subject',
      ).toBe(true);
      const length = arrayArm.fields!.find((field) => field.name === 'length')!;
      const parameterArm = length.branches!.find((arm) =>
        (arm.fields ?? []).some((field) => field.name === 'parameter'),
      )!;
      const parameter = parameterArm.fields!.find((field) => field.name === 'parameter')!;
      parameter.kind = 'numeric';
      parameter.type = 'number';
    });
    expect(
      compare(subject).miscounted.filter((gap) => gap.includes('defineIndicator')),
      'a recursive child wildcarded a separate, fully described sibling subtree',
    ).not.toEqual([]);
  });

  it('PLANT: REORDERING two unchanged arms stays green', () => {
    /**
     * The other half, and the one an over-eager identity gets wrong. Collision suffixes were assigned
     * in traversal order, so swapping the `'straight'` and `'annuity'` arms of `bonds.amortizing` —
     * which changes nothing a caller can observe — invented two domain errors. A union is unordered;
     * a gate that says otherwise manufactures drift.
     */
    const subject = plant('@totalfinance/fixed-income:bonds.amortizing', (record) => {
      let swapped = false;
      for (const signature of record.signatures ?? []) {
        for (const parameter of signature.parameters ?? []) {
          const visit = (node: ManifestNode): void => {
            if (!swapped && (node.branches?.length ?? 0) > 1) {
              node.branches = [...node.branches!].reverse();
              swapped = true;
              return;
            }
            for (const member of [...(node.fields ?? []), ...(node.fieldTree ?? [])]) visit(member);
            if (node.element) visit(node.element);
          };
          visit(parameter);
        }
      }
      expect(swapped, 'no union to reorder').toBe(true);
    });
    const result = compare(subject);
    const noise = [...result.domainGaps, ...result.miscounted, ...result.missing, ...result.extra]
      .filter((gap) => gap.includes('amortizing'))
      .slice(0, 5);
    expect(noise, 'reordering unchanged arms invented findings').toEqual([]);
  });

  it('PLANT: catches an artifact authorising its own truncation', () => {
    /**
     * Truncation was whatever the artifact said it was, so marking a SHALLOW union truncated turned
     * it into a suppression boundary AND an exemption from identity comparison — the review then
     * corrupted a discriminator inside it and the gate reported nothing. A bound the measured thing
     * declares about itself is not a bound.
     */
    const subject = plant('@totalfinance/fixed-income:bonds.amortizing', (record) => {
      let marked = false;
      let corrupted = false;
      for (const signature of record.signatures ?? []) {
        for (const parameter of signature.parameters ?? []) {
          const visit = (node: ManifestNode, depth: number): void => {
            if (!marked && depth <= 2 && (node.branches?.length ?? 0) > 1) {
              node.truncated = true;
              const discriminator = node
                .branches!.flatMap((arm) => arm.fields ?? [])
                .find((field) => field.name === 'type' && field.literals?.includes('straight'));
              expect(
                discriminator,
                'the shallow amortization discriminator was not found',
              ).toBeDefined();
              discriminator!.literals = ['not-straight'];
              discriminator!.type = "'not-straight'";
              corrupted = true;
              marked = true;
              return;
            }
            for (const member of [...(node.fields ?? []), ...(node.fieldTree ?? [])]) {
              visit(member, depth + 1);
            }
            if (node.element) visit(node.element, depth + 1);
          };
          visit(parameter, 0);
        }
      }
      expect(marked, 'no shallow union to mark truncated').toBe(true);
      expect(corrupted, 'the advertised discriminator was not actually corrupted').toBe(true);
    });
    const result = compare(subject);
    expect(
      result.truncationGaps.filter((gap) => gap.includes('amortizing')),
      'the artifact authorised its own truncation and the gate believed it',
    ).not.toEqual([]);
    expect(
      [...result.domainGaps, ...result.miscounted].filter((gap) => gap.includes('amortizing')),
      'the false truncation claim also hid the discriminator corruption',
    ).not.toEqual([]);
  });
});
