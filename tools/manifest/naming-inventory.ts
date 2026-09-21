/**
 * Public naming inventory (Phase 3B.N0 — `docs/specs/phase-3b-public-naming-normalization.md`).
 *
 * Declaration-backed, like the Phase 3A signature inventory: it reads the BUILT `.d.ts` named by
 * every package export map and walks the public type graph, so it sees what reflection cannot —
 * recursive request/result fields, method and parameter labels, enum members, and the stable string
 * literals behind serialized codes. A small source scan adds the MCP tool identities that live in
 * object literals rather than exported types.
 *
 * Deliberate design decisions:
 *
 * - **No source locations in the committed baseline.** Ledger C02 forbids declaration line numbers
 *   as stable identity; they also churn the artifact on every unrelated edit. Identity is
 *   `package|kind|path`. Locations are diagnostics only, printed by the CLI.
 * - **Token matching, never substring matching.** `volatility` tokenizes to `['volatility']` and is
 *   never caught by the forbidden `vol`; `atmVol` tokenizes to `['atm','vol']` and is. Note the
 *   consequence, which is a DESIGN CHOICE and not a gap to be patched: an abbreviation embedded in
 *   a full word is out of scope. `atmVolatility` tokenizes to `['atm','volatility']` — no `vol`
 *   token — so it is correctly NOT flagged. The forbidden-token rule governs names that USE the
 *   abbreviation, not names that merely contain its letters.
 * - **The generator discovers; the policy decides.** Every non-`explicit` disposition traces to a
 *   source-controlled rationale in `naming-policy.ts` (law N7).
 *
 * `unresolved` is the migration queue for 3B.N1–N8 and must reach zero at N9.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { packageEntrypoints } from './inventory.js';
import {
  BARE_ONLY_TOKENS,
  CANONICAL_NAMES,
  CANONICAL_NAME_TOKENS,
  CANONICAL_TOKENS,
  FORBIDDEN_TOKENS,
  OPAQUE_STATE_ENVELOPES,
  ORDINARY_TOKENS,
  SCOPED_SYMBOLS,
} from './naming-policy.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = resolve(ROOT, 'packages');
export const NAMING_MANIFEST_PATH = fileURLToPath(new URL('./public-naming.json', import.meta.url));

/** How deep the recursive field walk descends before treating a branch as covered. */
const MAX_FIELD_DEPTH = 6;

export type NamingKind =
  | 'package'
  | 'subpath'
  | 'export'
  | 'field'
  | 'method'
  | 'parameter'
  | 'enum-member'
  | 'code-string'
  | 'literal-value'
  | 'mcp-tool'
  | 'mcp-field';

export type NamingPosition =
  | 'module'
  | 'request'
  | 'result'
  | 'artifact'
  | 'signature'
  | 'serialized';

export type Disposition =
  | 'explicit'
  | 'canonical-term'
  | 'scoped-symbol'
  | 'opaque-state'
  | 'unresolved';

export interface NamingIdentity {
  /** Stable identity: `package|kind|path`. Never a source location (ledger C02). */
  id: string;
  /** The identifier that was classified — the migration queue must be readable without decoding ids. */
  name: string;
  kind: NamingKind;
  position: NamingPosition;
  disposition: Disposition;
  /** Source-controlled rationale for every non-`explicit`, non-`unresolved` disposition. */
  policy?: string;
  /**
   * Forbidden tokens that flagged an `unresolved` identity. The canonical replacement for each is
   * `summary.directions[token]` — held once rather than repeated on thousands of records, so a
   * migration commit produces a reviewable diff instead of megabytes of duplicated prose.
   */
  forbidden?: string[];
  /**
   * Every export-map entrypoint that re-exports this name (`export` identities only). A rename must
   * update all of them, so the fan-out is part of the contract, not an implementation detail.
   */
  entrypoints?: string[];
}

export interface NamingSummary {
  identities: number;
  unresolved: number;
  byDisposition: Record<string, number>;
  byKind: Record<string, number>;
  byPackage: Record<string, number>;
  /** Forbidden token → how many public identities it still flags. */
  byForbiddenToken: Record<string, number>;
  /** Forbidden token → its canonical replacement direction. */
  directions: Record<string, string>;
}

export interface PublicNamingManifest {
  version: 1;
  summary: NamingSummary;
  identities: NamingIdentity[];
}

/**
 * Split an identifier into lowercase tokens across camelCase, PascalCase, acronym runs, digits, and
 * `_ - . / # :` separators.
 *
 * `atmVol` → `['atm','vol']`; `atmVolatility` → `['atm','volatility']` (an abbreviation spelled out
 * in full is a different token, by design); `timeToExpiryYears` → `['time','to','expiry','years']`;
 * `RSIValue` → `['rsi','value']`; `toJSON` → `['to','json']`; `volatility.surface_extrapolated` →
 * `['volatility','surface','extrapolated']`.
 *
 * Trailing digits stay attached to their letter run so that names whose identity INCLUDES a number
 * survive as one token: `T3Parameters` → `['t3','parameters']` (the TA-Lib T3 indicator, not a bare `t`),
 * `PV01` → `['pv01']`, `ci95` → `['ci95']`, Heston `v0` → `['v0']`.
 */
export function tokenize(name: string): string[] {
  const tokens: string[] = [];
  for (const chunk of name.split(/[_\-./#:@]+/)) {
    const matches = chunk.match(/[A-Z]+\d*(?![a-z])|[A-Z]?[a-z]+\d*|\d+/g);
    if (matches) tokens.push(...matches.map((token) => token.toLowerCase()));
  }
  return tokens;
}

const ORDINARY = new Set(ORDINARY_TOKENS);
const BARE_ONLY = new Set(BARE_ONLY_TOKENS);

/** Direction for a bare single-letter public name that no forbidden-family entry covers. */
const SINGLE_LETTER_DIRECTION =
  'a role name stating the concept — a single letter is public only as an approved scoped mathematical symbol';

/**
 * The forbidden tokens a name carries, ignoring scope. Exported so the conformance gates can test
 * the SAME predicate the generator applies — a second copy of this rule drifts the moment the
 * policy gains a nuance like {@link BARE_ONLY_TOKENS}, and then the gate reports violations the
 * generator does not (which is exactly what happened).
 */
/**
 * The letter run in front of a numeric suffix — `vol1` → `vol`, `iv10` → `iv`, `avg5` → `avg`.
 *
 * The tokenizer keeps trailing digits attached so that names whose IDENTITY includes a number
 * survive whole (`t3`, `pv01`, `ci95`, `v0`). That is right, and it also meant a forbidden token
 * wearing a digit was invisible to the denylist: `SpreadInput.vol1`, `SkewMetrics.iv10Put` and
 * `CandleView.rangeAverage5` all read as `explicit` while the source still carried the retired rule
 * "flat inputs use `vol`". The number never made the name self-describing — it only hid it.
 *
 * So the prefix is tested SEPARATELY, and the real names are protected by exact allowlisting
 * (`CANONICAL_TOKENS` already carries `t3`, `pv01`, `dv01`, `ci95`), never by a blanket rule that a
 * digit ends scrutiny.
 */
function numericSuffixPrefix(token: string): string | null {
  const match = /^([a-z]+)\d+$/.exec(token);
  return match ? (match[1] as string) : null;
}

export function flaggedTokens(name: string): string[] {
  const tokens = tokenize(name);
  // A single-letter public name is never self-describing (laws N1/N4); it survives only as an
  // approved scoped mathematical symbol, which `classify` resolves before calling this.
  const singleLetter = /^[A-Za-z]$/.test(name) ? [name.toLowerCase()] : [];
  /**
   * A one-letter token INSIDE a compound is as unreadable as one standing alone. The retired
   * `v` + `ShortUpper` tokenized to `['v','short','upper']`, and only the whole-name check looked at
   * `v` — so the abbreviation survived by being embedded. (Spelled by concatenation because a rename
   * sweep rewrote this very sentence into the replacement name, inverting what it says.) `x`/`y` style coordinates stay available through
   * `SCOPED_SYMBOLS`, which `classify` resolves before this runs.
   */
  const embeddedSingleLetters =
    tokens.length > 1
      ? tokens.filter(
          (token) => /^[a-z]$/.test(token) && !(token in CANONICAL_TOKENS) && !ORDINARY.has(token),
        )
      : [];

  /**
   * A forbidden token does not stop being forbidden by carrying a digit — UNLESS the digit-bearing
   * token is itself an allowlisted identity. `pv01` is canonical; testing its `pv` prefix flagged the
   * very name the allowlist exists to protect. The exact allowlist wins over the prefix rule, which
   * is the reviewer's point about protecting `T3`/`PV01` by exact entry rather than blanket
   * exemption: the entry has to be consulted BEFORE the broader rule, not instead of it.
   */
  const behindDigits = tokens
    .filter((token) => !(token in CANONICAL_TOKENS) && !ORDINARY.has(token))
    .map(numericSuffixPrefix)
    .filter((prefix): prefix is string => prefix !== null)
    .filter(
      (prefix) =>
        prefix in FORBIDDEN_TOKENS && !(prefix in CANONICAL_TOKENS) && !ORDINARY.has(prefix),
    );

  return [
    ...new Set([
      ...singleLetter,
      ...embeddedSingleLetters,
      ...behindDigits,
      ...tokens.filter(
        (token) =>
          token in FORBIDDEN_TOKENS &&
          !(token in CANONICAL_TOKENS) &&
          !ORDINARY.has(token) &&
          // A bare-only token is a real WORD, not a truncation: it fails alone (`rate`), but a
          // role-qualified compound that contains it (`riskFreeRate`, `hazardRate`) IS the
          // canonical fix and must not flag itself.
          !(BARE_ONLY.has(token) && tokens.length > 1),
      ),
    ]),
  ].sort();
}

/** Resolve one public name against the policy. The generator never invents a disposition. */
function classify(
  name: string,
  scopes: readonly string[],
): Pick<NamingIdentity, 'disposition' | 'policy' | 'forbidden'> {
  /**
   * An allowlisted NAME excuses the tokens its rationale is about — not every token in the name.
   *
   * This returned immediately, so one entry pardoned the whole identifier: the retired
   * `adj` + `RSquared` was allowlisted for `R²` and carried `adj` through with it, while
   * `adjustedRSquared` already existed as the canonical spelling. An exemption is a claim about a specific abbreviation; letting it
   * cover whatever else happens to share the identifier is how "reviewed" degrades back into "not
   * looked at".
   *
   * So the tokens are still inspected, and the entry excuses only those that belong to the published
   * identity — declared, not inferred. Anything left over still flags.
   */
  const canonicalName = CANONICAL_NAMES[name];
  if (canonicalName) {
    /**
     * RV9 — the excuse list is DECLARED or there is no excuse. This read
     * `CANONICAL_NAME_TOKENS[name] ?? tokenize(name)`, which fell back to excusing every token in
     * the name whenever the companion entry was missing. That fallback restored, by omission,
     * exactly the whole-identifier pardon the block above exists to prevent: adding a
     * `CANONICAL_NAMES` entry and forgetting its token list did not fail — it silently pardoned
     * more than the rationale claimed, and the more tokens a name had the more it pardoned.
     *
     * An absent entry now excuses NOTHING, so a name whose rationale was never written out flags
     * its own tokens and lands in the queue. `naming-conformance.test.ts` additionally holds the
     * two key sets in exact correspondence and checks that every declared token really occurs in
     * its name, so this cannot be satisfied by an empty or invented list either.
     */
    const excused = new Set(CANONICAL_NAME_TOKENS[name] ?? []);
    const leftover = flaggedTokens(name).filter((token) => !excused.has(token));
    if (leftover.length === 0) return { disposition: 'canonical-term', policy: canonicalName };
    return { disposition: 'unresolved', forbidden: leftover };
  }

  for (const scope of scopes) {
    const opaque = OPAQUE_STATE_ENVELOPES[scope];
    if (opaque) return { disposition: 'opaque-state', policy: opaque };
    const scoped = SCOPED_SYMBOLS[scope];
    if (scoped?.symbols.includes(name)) {
      return { disposition: 'scoped-symbol', policy: scoped.rationale };
    }
  }

  const tokens = tokenize(name);
  const flagged = flaggedTokens(name);

  if (flagged.length === 0) {
    const canonicalToken = tokens.find((token) => token in CANONICAL_TOKENS);
    if (canonicalToken) {
      return { disposition: 'canonical-term', policy: CANONICAL_TOKENS[canonicalToken]! };
    }
    return { disposition: 'explicit' };
  }

  return { disposition: 'unresolved', forbidden: flagged };
}

/** The canonical replacement for one flagged token (see {@link NamingSummary.directions}). */
export function directionFor(token: string): string {
  return FORBIDDEN_TOKENS[token]?.direction ?? SINGLE_LETTER_DIRECTION;
}

interface PackageSource {
  package: string;
  dir: string;
  entries: Map<string, string>;
  /**
   * The umbrella re-exports the other packages, so walking its type graph would record every field
   * twice under a second path and inflate the migration queue. Its OWN naming surface is its
   * package name, its subpaths, and its namespace names; the interiors belong to the owning
   * package (the spec's "aliases fan out evidence from one contract identity").
   */
  identityOnly: boolean;
}

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

/**
 * Locate each entrypoint's built declaration. Intentionally local rather than shared with
 * `signature-inventory.ts`: that module owns the frozen Phase 3A gate, and this phase must not be
 * able to perturb its committed output.
 */
function packageSources(): { packages: PackageSource[]; paths: Record<string, string[]> } {
  const packages: PackageSource[] = [];
  const paths: Record<string, string[]> = {};
  // The umbrella is not manifest-classified (it re-exports rather than owning exports), but its
  // package name, namespaces, and subpaths ARE public names: `totalfinance/volatility` and `totalfinance/technical-analysis` are
  // explicit 3B.N1 rename targets, so a naming inventory that skipped it would be blind to them.
  const dirs = [...packageEntrypoints().map((pkg) => pkg.dir), 'totalfinance'];
  for (const dir of dirs) {
    const packageDir = resolve(PACKAGES, dir);
    const json = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as {
      name: string;
      exports: Record<string, unknown>;
    };
    const entries = new Map<string, string>();
    for (const [entrypoint, value] of Object.entries(json.exports)) {
      if (entrypoint === './package.json') continue;
      const target = firstTypeTarget(value);
      if (!target) continue;
      const declaration = target.endsWith('.d.ts') ? target : target.replace(/\.js$/, '.d.ts');
      const absolute = resolve(packageDir, declaration);
      if (!existsSync(absolute)) {
        throw new Error(
          `naming-inventory: ${json.name} ${entrypoint} has no built declaration; run pnpm build`,
        );
      }
      entries.set(entrypoint, absolute);
    }
    packages.push({ package: json.name, dir, entries, identityOnly: dir === 'totalfinance' });
    paths[json.name] = [resolve(packageDir, 'dist/index.d.ts')];
    paths[`${json.name}/*`] = [resolve(packageDir, 'dist/*')];
  }
  return { packages, paths };
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

function memberIsPublic(member: ts.Symbol): boolean {
  // A unique-symbol brand is not a caller-spelled field. TypeScript renders its private key with a
  // process-local counter (`__@brand@14644`), so recording it both invents a public name and makes
  // otherwise identical manifest generations nondeterministic.
  if (member.name.startsWith('__@')) return false;
  const declaration = declarationOf(member);
  if (!declaration) return false;
  if (!declaration.getSourceFile().fileName.startsWith(PACKAGES)) return false;
  const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
  return !modifiers?.some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

/**
 * The declared name of a type, when it is a TotalFinance-owned name worth using as a field-walk scope.
 *
 * Structural wrappers declared outside `packages/` (`Readonly`, `Partial`, `Record`, `Promise`, …)
 * are rejected: naming a field `Readonly.vol` would make the migration queue point at a TypeScript
 * utility instead of the contract the user actually reads.
 */
function typeName(type: ts.Type): string | null {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) return null;
  const name = symbol.name;
  if (name === '__type' || name === '__object') return null;
  const declaration = declarationOf(symbol);
  if (!declaration?.getSourceFile().fileName.startsWith(PACKAGES)) return null;
  return name;
}

class NamingCollector {
  private readonly records = new Map<string, NamingIdentity>();

  add(
    pkg: string,
    kind: NamingKind,
    path: string,
    name: string,
    position: NamingPosition,
    scopes: readonly string[],
    entrypoint?: string,
  ): void {
    const id = `${pkg}|${kind}|${path}`;
    const existing = this.records.get(id);
    if (existing) {
      // One declaration reachable from several export-map entries is one NAME with several public
      // paths. Record the fan-out rather than a second identity: renaming it must update every
      // entrypoint that re-exports it.
      if (entrypoint && existing.entrypoints && !existing.entrypoints.includes(entrypoint)) {
        existing.entrypoints = [...existing.entrypoints, entrypoint].sort();
      }
      return;
    }
    this.records.set(id, {
      id,
      name,
      kind,
      position,
      ...(entrypoint ? { entrypoints: [entrypoint] } : {}),
      ...classify(name, scopes),
    });
  }

  has(pkg: string, kind: NamingKind, path: string): boolean {
    return this.records.has(`${pkg}|${kind}|${path}`);
  }

  all(): NamingIdentity[] {
    return [...this.records.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

/**
 * Walk one type's public members, emitting a field/method identity per property and descending into
 * nested object types. `seen` guards recursive contracts; `MAX_FIELD_DEPTH` bounds breadth-first
 * cost on deeply generic curve/surface types.
 */
function walkType(
  collector: NamingCollector,
  checker: ts.TypeChecker,
  pkg: string,
  scopeName: string,
  type: ts.Type,
  position: NamingPosition,
  depth: number,
  seen: Set<ts.Type>,
): void {
  /**
   * RV10 — A STRING-LITERAL UNION MEMBER IS A PUBLIC NAME.
   *
   * `ScanObjective = '` + `pop' | '` + `ev'` and `ShockKind = '` + `pct' | '` + `abs'` were spellings
   * a caller had to TYPE, exactly like a field name, and until now the inventory walked straight past
   * them: a literal type has no properties, so `getPropertiesOfType` returned nothing and the walk
   * ended in silence. The naming queue could reach zero while `rank(groups, { by: 'volume` + `OiRatio' })`
   * sat in the public surface unreviewed.
   *
   * (Those retired spellings are split for a reason: a sweep of this very rename rewrote them into
   * their replacements the first time, leaving a comment that called the CANONICAL names the
   * problem. Third occurrence this phase — see trap 2 in the RV9 record.) `RankByKey` was caught
   * during the `oi` rename only because `rank` sorts with `b[by]`, which forced the compiler to
   * object — a union whose members are not keys of some walked type had nothing to catch it.
   *
   * Recorded BEFORE the `seen` guard on purpose. Literal types are interned by the checker, so the
   * single `'call'` type object is shared by every union that contains it; letting `seen` swallow it
   * would record the first scope and silently drop the rest. A literal is a leaf, so there is no
   * recursion to protect against.
   */
  if (type.isStringLiteral()) {
    collector.add(pkg, 'literal-value', `${scopeName}:${type.value}`, type.value, 'serialized', [
      scopeName,
    ]);
    return;
  }
  if (depth > MAX_FIELD_DEPTH || seen.has(type)) return;
  seen.add(type);

  for (const part of type.isUnion() || type.isIntersection() ? type.types : [type]) {
    if (part !== type) {
      walkType(collector, checker, pkg, scopeName, part, position, depth, seen);
      continue;
    }
    const numberIndex = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
    if (numberIndex) {
      // An array OF a named type is that type's scope: `Pair[]` reached through `add(input)` still
      // owns `Pair.x`. Without this the element fields inherit the caller's anonymous scope name, so
      // one ruling about `Pair` would have to be re-stated for every function that accepts `Pair[]`.
      const elementName = typeName(numberIndex);
      walkType(
        collector,
        checker,
        pkg,
        elementName ?? scopeName,
        numberIndex,
        position,
        depth + 1,
        seen,
      );
    }
    for (const member of checker.getPropertiesOfType(part)) {
      if (!memberIsPublic(member)) continue;
      const memberType = typeOfSymbol(checker, member);
      if (!memberType) continue;
      const path = `${scopeName}.${member.name}`;
      const isMethod = checker.getSignaturesOfType(memberType, ts.SignatureKind.Call).length > 0;
      collector.add(pkg, isMethod ? 'method' : 'field', path, member.name, position, [scopeName]);
      if (isMethod) {
        for (const signature of checker.getSignaturesOfType(memberType, ts.SignatureKind.Call)) {
          for (const parameter of signature.getParameters()) {
            collector.add(
              pkg,
              'parameter',
              `${path}(${parameter.name})`,
              parameter.name,
              'signature',
              [`${pkg}:${path}`, scopeName],
            );
            // A method's parameter OBJECT is as public as a function's. Walking only the label
            // stopped the inventory at `surface.iv(query)` and never saw `query.ts` — which is how
            // retired names survived inside method request types while the queue read zero.
            const parameterType = typeOfSymbol(checker, parameter);
            if (parameterType) {
              walkType(
                collector,
                checker,
                pkg,
                typeName(parameterType) ?? `${path}(${parameter.name})`,
                parameterType,
                'request',
                depth + 1,
                seen,
              );
            }
          }
          // …and so is what it hands back.
          const methodReturn = checker.getReturnTypeOfSignature(signature);
          walkType(
            collector,
            checker,
            pkg,
            typeName(methodReturn) ?? `${path}()`,
            methodReturn,
            'result',
            depth + 1,
            seen,
          );
        }
        continue;
      }
      const named = typeName(memberType);
      walkType(collector, checker, pkg, named ?? path, memberType, position, depth + 1, seen);
    }
  }
}

/** Stable code strings (`ErrorCode`/`WarningCode`) are string-literal types the checker can read. */
function collectCodeStrings(
  collector: NamingCollector,
  checker: ts.TypeChecker,
  pkg: string,
  exportName: string,
  type: ts.Type,
): void {
  for (const member of checker.getPropertiesOfType(type)) {
    collector.add(
      pkg,
      'enum-member',
      `${exportName}.${member.name}`,
      member.name,
      'serialized',
      [],
    );
    const memberType = typeOfSymbol(checker, member);
    if (!memberType?.isStringLiteral()) continue;
    const literal = memberType.value;
    collector.add(pkg, 'code-string', literal, literal, 'serialized', []);
  }
}

/**
 * MCP tool and pack identities live in object literals, so they need a source scan.
 *
 * The FIELD names matter as much as the tool ids: an MCP schema is a wire contract an agent reads,
 * and it is assembled at runtime from `schema.object({ … })` literals, so the declaration walk over
 * built `.d.ts` never sees it. Scanning only the `totalfinance.*` ids is how `ts` survived in two
 * MCP inputs while the migration queue reported zero.
 */
function collectMcpIdentities(collector: NamingCollector): void {
  // Stage 7A (2026-09-03): the operation definitions — ids, input schemas, output schemas — moved
  // from `@totalfinance/mcp` to `@totalfinance/workflows`; MCP keeps only adapters. Both trees are walked
  // and each identity is attributed to the package whose source declares it, so the wire contract
  // an agent reads stays measured wherever it is authored (a gate that stops seeing its subject
  // passes silently — this one must not).
  for (const [directory, pkg] of [
    ['workflows', '@totalfinance/workflows'],
    ['mcp', '@totalfinance/mcp'],
  ] as const) {
    collectWireContractIdentities(collector, resolve(PACKAGES, `${directory}/src`), pkg);
  }
}

function collectWireContractIdentities(
  collector: NamingCollector,
  dir: string,
  pkg: '@totalfinance/mcp' | '@totalfinance/workflows',
): void {
  if (!existsSync(dir)) return;
  const ids = new Set<string>();
  const files = readdirSync(dir)
    .sort()
    .filter((file) => file.endsWith('.ts'));

  for (const file of files) {
    const source = readFileSync(resolve(dir, file), 'utf8');
    for (const match of source.matchAll(/['"`](totalfinance\.[a-zA-Z0-9_.]+)['"`]/g)) {
      ids.add(match[1]!);
    }
  }
  for (const id of [...ids].sort()) {
    collector.add(pkg, 'mcp-tool', id, id, 'serialized', []);
  }

  // `schema.object({ … })` property names, found on the AST so nested schemas and multi-line
  // builder chains are covered exactly rather than by regex approximation. Identity is
  // `<owning schema const>.<field>` — never a line number (ledger C02), so the artifact does not
  // churn when unrelated code shifts above it.
  const fields = new Map<string, string>(); // `<owner>.<field>` → the bare field name
  for (const file of files) {
    const path = resolve(dir, file);
    const sourceFile = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.ESNext,
      true,
    );
    /**
     * JSONSchema STRUCTURE keys, never an owner. A raw output schema is
     * `outputSchema: { type: 'object', properties: { … } }`, so the nearest property assignment above
     * a field is the literal `properties` — which collapsed 72 of 248 MCP field identities into
     * `mcp-field|properties.<field>`, merging unrelated tools under one owner and losing exactly the
     * ownership this inventory exists to record. Keep walking past these to the real owner.
     */
    const SCHEMA_STRUCTURE_KEYS = new Set([
      'properties',
      'items',
      'inputSchema',
      'outputSchema',
      'schema',
      'additionalProperties',
      'definitions',
      'patternProperties',
      'oneOf',
      'anyOf',
      'allOf',
    ]);

    /** Nearest enclosing `const X = …` / `x: …`, so a nested schema still names its owner. */
    const ownerOf = (node: ts.Node): string => {
      for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
          return current.name.text;
        }
        if (
          ts.isPropertyAssignment(current) &&
          ts.isIdentifier(current.name) &&
          !SCHEMA_STRUCTURE_KEYS.has(current.name.text)
        ) {
          // A tool literal names itself with a string `name:` — prefer that identity over a
          // surrounding `const`, so two tools declared in one array stay distinguishable.
          return current.name.text;
        }
        if (ts.isObjectLiteralExpression(current)) {
          // An operation literal names itself with `id:` (a tool with `name:`).
          const named = current.properties.find(
            (property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              (property.name.text === 'id' || property.name.text === 'name') &&
              ts.isStringLiteral(property.initializer),
          );
          if (named && ts.isStringLiteral(named.initializer)) return named.initializer.text;
        }
      }
      return file.replace(/\.ts$/, '');
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'object' &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0]!)
      ) {
        const owner = ownerOf(node);
        for (const property of node.arguments[0]!.properties) {
          if (!property.name) continue;
          const name = ts.isIdentifier(property.name)
            ? property.name.text
            : ts.isStringLiteral(property.name)
              ? property.name.text
              : undefined;
          if (!name) continue;
          fields.set(`${owner}.${name}`, name);
        }
      }
      // `properties: { … }` inside a raw JSONSchema literal — the tool OUTPUT contract. These are
      // plain objects, not builder calls, so the `schema.object` rule above never sees them; that
      // is exactly where an agent-facing `oneSigmaPercent` survived this migration.
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'properties' &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const owner = ownerOf(node);
        for (const property of node.initializer.properties) {
          if (!property.name) continue;
          const name = ts.isIdentifier(property.name)
            ? property.name.text
            : ts.isStringLiteral(property.name)
              ? property.name.text
              : undefined;
          if (!name) continue;
          fields.set(`${owner}.${name}`, name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  for (const [path, name] of [...fields].sort(([a], [b]) => a.localeCompare(b))) {
    // The owning schema is the SCOPE, so a ruling like `TaCalculateInputSchema` carrying the
    // bivariate `x`/`y` can be recorded once, exactly as a type-owned scope is.
    const owner = path.slice(0, path.length - name.length - 1);
    collector.add(pkg, 'mcp-field', path, name, 'serialized', [owner]);
  }
}

export function generatePublicNamingManifest(): PublicNamingManifest {
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
  const collector = new NamingCollector();

  for (const pkg of sources.packages) {
    // Package and subpath identities: `@totalfinance/volatility` and `./local-volatility` are public names too.
    collector.add(pkg.package, 'package', pkg.package, pkg.package.split('/').pop()!, 'module', []);
    for (const entrypoint of [...pkg.entries.keys()].sort()) {
      if (entrypoint === '.') continue;
      const leaf = entrypoint.replace(/^\.\//, '');
      collector.add(pkg.package, 'subpath', entrypoint, leaf, 'module', []);
    }

    for (const [entrypoint, sourcePath] of [...pkg.entries].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const source = program.getSourceFile(sourcePath);
      const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
      if (!moduleSymbol) continue;

      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const name = exported.name;
        // Record the entrypoint fan-out even when the declaration was already walked from another
        // export-map entry — the second path is a real public path, not a duplicate.
        const alreadyWalked = collector.has(pkg.package, 'export', name);
        collector.add(pkg.package, 'export', name, name, 'module', [], entrypoint);
        if (alreadyWalked || pkg.identityOnly) continue;

        const original = originalSymbol(checker, exported);
        const seen = new Set<ts.Type>();

        // Types and interfaces: walk the declared shape as an artifact contract.
        if (original.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
          walkType(
            collector,
            checker,
            pkg.package,
            name,
            checker.getDeclaredTypeOfSymbol(original),
            'artifact',
            0,
            seen,
          );
        }

        const valueType = typeOfSymbol(checker, exported);
        if (!valueType) continue;

        if (/Code$/.test(name))
          collectCodeStrings(collector, checker, pkg.package, name, valueType);

        // Callables: parameter labels are public (law N6); requests and results are contracts.
        for (const signature of checker.getSignaturesOfType(valueType, ts.SignatureKind.Call)) {
          for (const parameter of signature.getParameters()) {
            collector.add(
              pkg.package,
              'parameter',
              `${name}(${parameter.name})`,
              parameter.name,
              'signature',
              [`${pkg.package}:${name}`],
            );
            const parameterType = typeOfSymbol(checker, parameter);
            const named = parameterType ? typeName(parameterType) : null;
            if (parameterType) {
              walkType(
                collector,
                checker,
                pkg.package,
                named ?? `${name}(${parameter.name})`,
                parameterType,
                'request',
                1,
                seen,
              );
            }
          }
          const returnType = checker.getReturnTypeOfSignature(signature);
          walkType(
            collector,
            checker,
            pkg.package,
            typeName(returnType) ?? `${name}()`,
            returnType,
            'result',
            1,
            seen,
          );
        }

        for (const signature of checker.getSignaturesOfType(
          valueType,
          ts.SignatureKind.Construct,
        )) {
          for (const parameter of signature.getParameters()) {
            collector.add(
              pkg.package,
              'parameter',
              `${name}.constructor(${parameter.name})`,
              parameter.name,
              'signature',
              [`${pkg.package}:${name}`],
            );
            // …and walk what the parameter IS, not only what it is called. Recording the label alone
            // left a constructor's config type unwalked unless it happened to be exported
            // independently: `new SimulatedBroker(config)` reached `config` but never `BrokerConfig`'s
            // fields through this path. Every other callable walks its parameter types; this one did
            // not, and a class whose options type is intentionally unexported was invisible.
            const parameterType = typeOfSymbol(checker, parameter);
            if (parameterType) {
              walkType(
                collector,
                checker,
                pkg.package,
                typeName(parameterType) ?? `${name}.constructor`,
                parameterType,
                'request',
                1,
                seen,
              );
            }
          }
          walkType(
            collector,
            checker,
            pkg.package,
            name,
            checker.getReturnTypeOfSignature(signature),
            'artifact',
            1,
            seen,
          );
        }

        // Namespace objects (`bs`, `curves`, `priceAction`, …) expose members as public paths.
        if (
          !(original.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) &&
          checker.getSignaturesOfType(valueType, ts.SignatureKind.Call).length === 0 &&
          !/Code$/.test(name)
        ) {
          walkType(collector, checker, pkg.package, name, valueType, 'module', 0, seen);
        }
      }
    }
  }

  collectMcpIdentities(collector);

  const identities = collector.all();
  const byDisposition: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const byPackage: Record<string, number> = {};
  const byForbiddenToken: Record<string, number> = {};
  for (const identity of identities) {
    byDisposition[identity.disposition] = (byDisposition[identity.disposition] ?? 0) + 1;
    byKind[identity.kind] = (byKind[identity.kind] ?? 0) + 1;
    const pkg = identity.id.split('|')[0]!;
    byPackage[pkg] = (byPackage[pkg] ?? 0) + 1;
    for (const token of identity.forbidden ?? []) {
      byForbiddenToken[token] = (byForbiddenToken[token] ?? 0) + 1;
    }
  }
  const sortRecord = (record: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

  return {
    version: 1,
    summary: {
      identities: identities.length,
      unresolved: byDisposition['unresolved'] ?? 0,
      byDisposition: sortRecord(byDisposition),
      byKind: sortRecord(byKind),
      byPackage: sortRecord(byPackage),
      byForbiddenToken: sortRecord(byForbiddenToken),
      directions: Object.fromEntries(
        Object.keys(byForbiddenToken)
          .sort()
          .map((token) => [token, directionFor(token)]),
      ),
    },
    identities,
  };
}

export function readPublicNamingManifest(): PublicNamingManifest | null {
  try {
    return JSON.parse(readFileSync(NAMING_MANIFEST_PATH, 'utf8')) as PublicNamingManifest;
  } catch {
    return null;
  }
}

export function writePublicNamingManifest(): PublicNamingManifest {
  const manifest = generatePublicNamingManifest();
  writeFileSync(NAMING_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const manifest = writePublicNamingManifest();
  const { summary } = manifest;
  console.log(
    `naming-manifest: ${summary.identities} public identities, ${summary.unresolved} unresolved`,
  );
  const top = Object.entries(summary.byForbiddenToken)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15);
  for (const [token, count] of top) {
    console.log(`  ${token.padEnd(10)} ${String(count).padStart(5)}  → ${directionFor(token)}`);
  }
}
