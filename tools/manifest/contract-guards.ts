/**
 * GUARD REACHABILITY — a static hint about where a guard can be reached, NOT a claim of enforcement.
 *
 * This file used to be called enforcement, and that name was a lie the artifact then told:
 * `blackScholesPrice` calls `requireArgumentObject`, so it read `direct`ly enforced, while the same
 * commit recorded that it returns `NaN` for a missing field. `requireArgumentObject` proves the
 * argument IS AN OBJECT and nothing more. Enforcement is now MEASURED by executing mutations
 * (`contract-enforcement.ts`); this remains useful as a hint and as a cross-check, under its real name.
 *
 * The naive version of this asked "does this function's own body call a guard?" and reported 1,862 of
 * 2,364 object inputs as unguarded. That number was wrong, and wrong in the dangerous direction: it
 * would have sent 3B.1 to add validation to paths that already validate. Most public callables do not
 * guard inline. They are produced by a validating BUILDER (`facade()` calls `requireFirstArg` before
 * the inner function ever runs) or they DELEGATE to an inner boundary. The spec names exactly these:
 * "the schema, builder, explicit guard, or boundary function that enforces that contract."
 *
 * So enforcement is resolved by walking the call graph from each public declaration:
 *
 *   direct     — a guard call in the declaration's own body.
 *   delegated  — no guard here, but a function it calls (or the builder that produced it) guards.
 *                The `via` chain records HOW it was reached, so the claim is auditable.
 *   ambiguous  — a callee name resolves to more than one declaration and they disagree about
 *                guarding. Reported separately and NEVER counted as enforced: an over-approximation
 *                here would hide exactly the defect this phase exists to find.
 *   none       — nothing reachable guards. This is 3B.1/3B.2's work list.
 *
 * Resolution prefers the nearest declaration (same file → same package → core), which is what an
 * import in that file would actually bind to.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isGuardName, isPostconditionName } from './contract-policy.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = resolve(ROOT, 'packages');

/** How deep to follow delegation. Three hops covers export → builder → inner → guard. */
const MAX_DEPTH = 4;

export type GuardReachability =
  | 'direct'
  | 'delegated'
  | 'ambiguous'
  /**
   * There is no implementation BODY in this repo to enforce anything — an interface method signature
   * (`CostModel.commission`, which the library CALLS on a user's object) or an abstract declaration.
   * Distinct from `none`, because you cannot add a guard to a type declaration: conflating the two put
   * user-implemented callback contracts on the 3B.1 work list, where no fix is even possible.
   */
  | 'no-implementation'
  | 'none';

export interface GuardReachabilityResult {
  guardReachability: GuardReachability;
  /** Guard functions reachable from this declaration, sorted. */
  validators: string[];
  /** The call chain that reached them, for audit. Empty when `direct`. */
  via: string[];
}

/** One function-like declaration in the source tree. */
interface FunctionEntry {
  /** `<relativeSourcePath>#<nameChain>`. */
  key: string;
  file: string;
  package: string;
  nameChain: string;
  /** Guard calls in this body (not following calls). */
  directGuards: string[];
  /** Law 7 result postconditions in this body — result discipline, not input enforcement. */
  postconditions: string[];
  /** Bare callee names invoked in this body, including the builder that produced it. */
  callees: string[];
}

/** The name chain of a declaration, walking up through enclosing named declarations. */
function nameChainOf(node: ts.Node): string {
  const parts: string[] = [];
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isSourceFile(current)) break;
    // A constructor has no `name`, but the signature inventory addresses it as `<Class>.constructor`,
    // so the chain has to say so or the two can never be joined.
    if (ts.isConstructorDeclaration(current)) {
      parts.unshift('constructor');
      continue;
    }
    const named = current as ts.NamedDeclaration;
    if (named.name && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name))) {
      parts.unshift(named.name.text);
    }
  }
  return parts.join('.');
}

/** Every `.ts` file under a directory, recursively, excluding tests and declarations. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = resolve(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.includes('.test.')) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Is this node a function-like body carrier we should record?
 *
 * `ConstructorDeclaration` was missing from the first version, and the consequence was severe rather
 * than cosmetic: 156 of 166 public constructors got no index entry, so the resolver found no
 * implementation, so they were classified `callback-contract` — "a signature the caller implements,
 * nothing to guard" — and every one dropped off the must-enforce list. That is how
 * `new BollingerStream({ period: 20, k: 2 })` came to return null bands with no error while the
 * inventory reported nothing to fix.
 */
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyAssignment(node)
  );
}

/** The callee's bare name for an identifier or property-access call. */
function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/**
 * Index every function-like declaration in every package source.
 *
 * A declaration's guards and callees are collected from its body but NOT from nested function-like
 * declarations that have their own entry — except for inline arrows passed as arguments, which are
 * part of how the enclosing export is built (`facade('x', (input) => …, explain)`), so their guards
 * count toward it.
 */
export function indexFunctions(): Map<string, FunctionEntry[]> {
  const byName = new Map<string, FunctionEntry[]>();
  for (const dir of readdirSync(PACKAGES).sort()) {
    const src = resolve(PACKAGES, dir, 'src');
    if (!existsSync(src)) continue;
    for (const path of sourceFilesUnder(src)) {
      const sourceFile = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.ESNext,
        true,
      );
      const relativePath = relative(ROOT, path);
      const walk = (node: ts.Node): void => {
        if (isFunctionLike(node)) {
          const nameChain = nameChainOf(node);
          if (nameChain !== '') {
            const guards = new Set<string>();
            const postconditions = new Set<string>();
            const callees = new Set<string>();
            const scan = (inner: ts.Node): void => {
              if (ts.isCallExpression(inner)) {
                const name = calleeName(inner.expression);
                if (name !== undefined) {
                  if (isGuardName(name)) guards.add(name);
                  else if (isPostconditionName(name)) postconditions.add(name);
                  else callees.add(name);
                }
              }
              // Do not descend into a nested NAMED function — it has its own entry. Inline arrows and
              // function expressions ARE part of this declaration's construction, so keep going.
              if (
                inner !== node &&
                (ts.isFunctionDeclaration(inner) || ts.isMethodDeclaration(inner)) &&
                nameChainOf(inner) !== nameChain
              ) {
                return;
              }
              ts.forEachChild(inner, scan);
            };
            ts.forEachChild(node, scan);
            const entry: FunctionEntry = {
              key: `${relativePath}#${nameChain}`,
              file: relativePath,
              package: dir,
              nameChain,
              directGuards: [...guards].sort(),
              postconditions: [...postconditions].sort(),
              callees: [...callees].sort(),
            };
            const bare = nameChain.split('.').pop()!;
            if (!byName.has(bare)) byName.set(bare, []);
            const bucket = byName.get(bare)!;
            // MERGE by key, never push a second entry for one declaration. A `const x = () => …`
            // produces BOTH a VariableDeclaration and an ArrowFunction with the same name chain;
            // indexing both made one declaration look like two that disagreed about guarding, and
            // `resolveCallee` correctly reported that as ambiguous — of a contradiction that did not
            // exist. It cost `probabilityInTheMoney` its real `delegated` verdict.
            const existing = bucket.find((candidate) => candidate.key === entry.key);
            if (existing) {
              const union = (a: string[], b: string[]): string[] =>
                [...new Set([...a, ...b])].sort();
              existing.directGuards = union(existing.directGuards, entry.directGuards);
              existing.postconditions = union(existing.postconditions, entry.postconditions);
              existing.callees = union(existing.callees, entry.callees);
            } else {
              bucket.push(entry);
            }
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(sourceFile);
    }
  }
  return byName;
}

/** Pick the declaration a call in `fromFile`/`fromPackage` would most plausibly bind to. */
function resolveCallee(
  candidates: FunctionEntry[],
  fromFile: string,
  fromPackage: string,
): { entry: FunctionEntry | null; ambiguous: boolean } {
  if (candidates.length === 0) return { entry: null, ambiguous: false };
  if (candidates.length === 1) return { entry: candidates[0]!, ambiguous: false };
  const sameFile = candidates.filter((candidate) => candidate.file === fromFile);
  if (sameFile.length === 1) return { entry: sameFile[0]!, ambiguous: false };
  const samePackage = candidates.filter((candidate) => candidate.package === fromPackage);
  if (samePackage.length === 1) return { entry: samePackage[0]!, ambiguous: false };
  const core = candidates.filter((candidate) => candidate.package === 'core');
  if (core.length === 1) return { entry: core[0]!, ambiguous: false };
  // Genuinely ambiguous. Only report it when the candidates DISAGREE about guarding — if every
  // candidate guards, the conclusion is the same whichever one binds.
  const anyGuards = candidates.some((candidate) => candidate.directGuards.length > 0);
  const allGuard = candidates.every((candidate) => candidate.directGuards.length > 0);
  if (allGuard) return { entry: candidates[0]!, ambiguous: false };
  return { entry: null, ambiguous: anyGuards };
}

/**
 * Resolve enforcement for one public declaration, following delegation.
 *
 * `index` is the output of {@link indexFunctions}; `implementation` is the signature inventory's
 * `<dist/*.d.ts>#<nameChain>` identity, whose source file is derived by the usual dist→src mapping.
 */
export function resolveGuardReachability(
  index: Map<string, FunctionEntry[]>,
  implementation: string,
  memo = new Map<string, GuardReachabilityResult>(),
  publicPath?: string,
): GuardReachabilityResult {
  const [distFile, nameChain = ''] = implementation.split('#');
  const sourceFile = distFile!.replace('/dist/', '/src/').replace(/\.d\.ts$/, '.ts');

  /**
   * Chains to try, in order of specificity.
   *
   * The two inventories address some members differently and the join fails silently when they do.
   * A constructor's SYMBOL is the class, so the signature inventory records `…#BollingerStream`
   * while the source declaration's chain is `BollingerStream.constructor`. A facade companion is
   * addressed `probabilityInTheMoney.explain` but its declaration collapses to the generic
   * `Facade.explain` in core — so the owning export's own chain is tried too, which is what actually
   * carries the guards.
   */
  const chains: string[] = [nameChain];
  if (publicPath !== undefined) {
    const member = /[#.]([A-Za-z0-9_$]+)$/.exec(publicPath)?.[1];
    if (member === 'constructor') chains.push(`${nameChain}.constructor`);
    // A `.explain` / `.call` companion belongs to the export that owns it.
    if (member === 'explain' || member === 'call') {
      const owner = publicPath
        .replace(/[#.][A-Za-z0-9_$]+$/, '')
        .split(/[#.]/)
        .pop();
      if (owner) chains.push(owner);
    }
  }

  let start: FunctionEntry | null = null;
  for (const chain of chains) {
    const bare = chain.split('.').pop()!;
    const candidates = index.get(bare) ?? [];
    start =
      candidates.find((candidate) => candidate.key === `${sourceFile}#${chain}`) ??
      candidates.find((candidate) => candidate.nameChain === chain) ??
      candidates.find((candidate) => candidate.file === sourceFile) ??
      null;
    if (start) break;
  }
  if (!start) return { guardReachability: 'no-implementation', validators: [], via: [] };

  const cached = memo.get(start.key);
  if (cached) return cached;
  // Seed the memo so a cycle resolves to "nothing new here" rather than recursing forever.
  memo.set(start.key, { guardReachability: 'none', validators: [], via: [] });

  if (start.directGuards.length > 0) {
    const result: GuardReachabilityResult = {
      guardReachability: 'direct',
      validators: start.directGuards,
      via: [],
    };
    memo.set(start.key, result);
    return result;
  }

  // Breadth-first through callees, so `via` records the SHORTEST path to enforcement.
  interface Step {
    entry: FunctionEntry;
    via: string[];
    depth: number;
  }
  const queue: Step[] = [{ entry: start, via: [], depth: 0 }];
  const visited = new Set<string>([start.key]);
  let sawAmbiguity = false;

  while (queue.length > 0) {
    const step = queue.shift()!;
    if (step.depth >= MAX_DEPTH) continue;
    for (const callee of step.entry.callees) {
      const { entry, ambiguous } = resolveCallee(
        index.get(callee) ?? [],
        step.entry.file,
        step.entry.package,
      );
      if (ambiguous) sawAmbiguity = true;
      if (!entry || visited.has(entry.key)) continue;
      visited.add(entry.key);
      const via = [...step.via, callee];
      if (entry.directGuards.length > 0) {
        const result: GuardReachabilityResult = {
          guardReachability: 'delegated',
          validators: entry.directGuards,
          via,
        };
        memo.set(start.key, result);
        return result;
      }
      queue.push({ entry, via, depth: step.depth + 1 });
    }
  }

  const result: GuardReachabilityResult = {
    guardReachability: sawAmbiguity ? 'ambiguous' : 'none',
    validators: [],
    via: [],
  };
  memo.set(start.key, result);
  return result;
}
