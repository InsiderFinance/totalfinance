/**
 * EVERY missing-field example is checked, on the AST, against the FULL receiver path.
 *
 * This file has now been wrong twice in the same direction, and both failures are worth keeping.
 *
 * RV5's version compared the pairs it exercised against the length of its own registry — the same
 * number counted twice — and matched "aliases" by substring, so `sviG` was allowed to recommend
 * `sviTotalVariance`. RV6 replaced it with a regex scan of the source, which was better and still
 * unsound in two ways: the `missingFieldError` pattern only matched a LITERAL second argument, so
 * every shared emitter reached with a variable field was skipped; and the callee comparison was
 * reduced to the final member, so `g2pp.discountBond` recommending `hullWhite(…).discountBond` would
 * have passed — the exact regression this file exists to prevent, readmitted by the comparison.
 *
 * The skipped emitter was not hypothetical. `packages/fixed-income/src/validate.ts` answered a
 * missing field with `e.g. issueDate: '2026-01-15'` — a fragment, the shape RV2 retired everywhere it
 * could see — for as long as this gate has existed.
 *
 * So: parse, do not match text. Every call to either emitter is found by walking the TypeScript AST,
 * the example is resolved through the file's constants and template literals, and the comparison is
 * on the normalized FULL receiver path (`g2pp.discountBond` ≠ `hullWhite.discountBond`), never on a
 * final segment and never on substring membership.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url));

/** The two helpers that promise a caller a worked example. Both are in scope, always. */
const EMITTERS = ['requireFiniteFields', 'missingFieldError'] as const;
type Emitter = (typeof EMITTERS)[number];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const SOURCES = readdirSync(PACKAGES_DIR)
  .map((pkg) => join(PACKAGES_DIR, pkg, 'src'))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap(sourceFiles);

interface Site {
  readonly file: string;
  readonly emitter: Emitter;
  /** The name the error reports, when it is statically knowable. */
  readonly reported: string | null;
  /** The example string, when it resolves statically. */
  readonly example: string | null;
  /** True when the example is COMPUTED from the reported name — the only sound shared-validator form. */
  readonly derived: boolean;
  /**
   * Whether an example was supplied at all. RV9 made `exampleCall` REQUIRED in the API, so the
   * compiler now answers this for every callsite — but the field stays, because this scanner reads
   * SOURCE and must still report a call it could not parse rather than silently scoring it absent.
   */
  readonly hasExample: boolean;
}

/**
 * Resolve an expression to a string when it is statically knowable: literals, `+` concatenation,
 * file-scope `const` bindings, and template literals whose interpolations are themselves resolvable.
 * Anything else is null, and the shared-validator rule then requires it to be derived.
 */
/**
 * Parse source, or FAIL — never return a tree built from input TypeScript could not read.
 *
 * RV12 — `ts.createSourceFile` is permissive: malformed input yields a tree plus diagnostics rather
 * than an exception. Both production scans below walked that tree anyway, found no emitter calls in
 * it, and reported a clean sweep. A file that stopped parsing therefore read exactly like a file with
 * nothing to check — silence as success, the defect this whole phase is about.
 *
 * My first attempt at this "fail closed" claim asserted that TypeScript PRODUCES diagnostics for
 * malformed source, which is a fact about TypeScript and not about this scanner: neither loop
 * consulted them. One shared entry point, used by both scans and exercised directly by the test
 * below, is what makes the claim true rather than adjacent to true.
 */
export function parseSourceOrThrow(fileName: string, text: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true);
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    const first = ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, ' ');
    throw new Error(
      `example-call scanner: ${fileName} did not parse (${diagnostics.length} diagnostic(s)); ` +
        `refusing to report "no findings" for a file that could not be read. First: ${first}`,
    );
  }
  return sourceFile;
}

function resolveString(
  node: ts.Expression,
  constants: ReadonlyMap<string, ts.Expression>,
  depth = 0,
): string | null {
  if (depth > 6) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const bound = constants.get(node.text);
    return bound ? resolveString(bound, constants, depth + 1) : null;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveString(node.left, constants, depth + 1);
    const right = resolveString(node.right, constants, depth + 1);
    return left !== null && right !== null ? left + right : null;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = resolveString(span.expression, constants, depth + 1);
      if (value === null) return null;
      out += value + span.literal.text;
    }
    return out;
  }
  if (ts.isParenthesizedExpression(node))
    return resolveString(node.expression, constants, depth + 1);
  return null;
}

/**
 * Is this example SOUND for a shared validator — i.e. does it vary with the caller?
 *
 * Two forms qualify, and the first version of this check saw neither, flagging both as fixed:
 *
 *   COMPUTED   `const example = \`${functionName}(${arg}, { ${field}: 14 })\`` — the reference is one
 *              binding away, so the walk has to follow local `const`s, not just look at the argument.
 *   SUPPLIED   `function requireNumericField(…, example: string)` — the example is a PARAMETER, so
 *              every caller passes its own. That is the same shape as `requirePhi`'s fix and is
 *              sound; the per-call-site literal check covers whether those examples are right.
 *
 * Only a genuinely fixed string reaching many reported names is a defect.
 */
function variesWithCaller(
  node: ts.Expression,
  nameIdentifiers: ReadonlySet<string>,
  bindings: ReadonlyMap<string, ts.Expression>,
  parameters: ReadonlySet<string>,
  depth = 0,
): boolean {
  if (depth > 6) return false;
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n)) {
      if (nameIdentifiers.has(n.text) || parameters.has(n.text)) {
        found = true;
        return;
      }
      const bound = bindings.get(n.text);
      if (bound && variesWithCaller(bound, nameIdentifiers, bindings, parameters, depth + 1)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

const SITES: Site[] = [];
for (const file of SOURCES) {
  const text = readFileSync(file, 'utf8');
  /**
   * NO TEXT PRE-FILTER. This skipped a file unless its raw source contained the exact spelling
   * `emitter(`, so a call written with any whitespace between the callee and its parenthesis — a
   * line break after a long name, which is exactly what the formatter produces — was invisible to
   * every gate below. Proven by planting one: with the pre-filter in place the independent walk
   * found 35 emitter calls while the inventory held 34, and the readability gate went GREEN because
   * the callsite had vanished from the set it judges.
   *
   * A scanner that decides what to parse by string matching is not an AST walk with a fast path; it
   * is a string match that sometimes parses. The cost of dropping it is parsing every production
   * source file, which buys a population that formatting cannot hide.
   */
  const sf = parseSourceOrThrow(file, text);

  const constants = new Map<string, ts.Expression>();
  const singleValued = new Map<string, string>();
  const assignedTwice = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer);
      if (ts.isStringLiteral(node.initializer)) {
        if (singleValued.has(node.name.text)) assignedTwice.add(node.name.text);
        else singleValued.set(node.name.text, node.initializer.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  for (const dup of assignedTwice) singleValued.delete(dup);

  // Parameter names of every function in the file — an example bound to one is caller-supplied.
  const parameterNames = new Set<string>();
  const collectParameters = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) parameterNames.add(parameter.name.text);
      }
    }
    ts.forEachChild(node, collectParameters);
  };
  collectParameters(sf);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const called = node.expression.text;
      const emitter = EMITTERS.find((e) => e === called);
      if (emitter) {
        const nameArg = node.arguments[0];
        let exampleArg: ts.Expression | undefined;
        if (emitter === 'requireFiniteFields') {
          const options = node.arguments[3];
          if (options && ts.isObjectLiteralExpression(options)) {
            for (const property of options.properties) {
              // `{ exampleCall: expr }` AND `{ exampleCall }` — the shorthand is a different node
              // kind, so matching only the first form skipped `ssvi-kernel.ts`, where the example
              // arrives as a parameter and is forwarded by shorthand.
              if (ts.isPropertyAssignment(property) && property.name.getText() === 'exampleCall') {
                exampleArg = property.initializer;
              } else if (
                ts.isShorthandPropertyAssignment(property) &&
                property.name.text === 'exampleCall'
              ) {
                exampleArg = property.name;
              }
            }
          }
        } else {
          exampleArg = node.arguments[2];
        }
        // Record the site even when no example was passed. Requiring `exampleArg` to exist made a
        // boundary VANISH from the inventory precisely when it had nothing to check — the failure
        // mode was invisible because the evidence of it was the thing being skipped.
        if (nameArg && ts.isExpression(nameArg)) {
          const literal = ts.isStringLiteral(nameArg) ? nameArg.text : null;
          // A local bound exactly once to a string literal is as knowable as an inline literal.
          const bound =
            literal === null && ts.isIdentifier(nameArg)
              ? (singleValued.get(nameArg.text) ?? null)
              : null;
          const nameIdentifiers = new Set<string>(ts.isIdentifier(nameArg) ? [nameArg.text] : []);
          SITES.push({
            file: file.slice(PACKAGES_DIR.length + 1),
            emitter,
            reported: literal ?? bound,
            example: exampleArg ? resolveString(exampleArg, constants) : null,
            derived: exampleArg
              ? variesWithCaller(exampleArg, nameIdentifiers, constants, parameterNames)
              : false,
            hasExample: exampleArg !== undefined,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * The FULL receiver path an example invokes — `hullWhite(curve, {…}).discountBond({…})` yields
 * `hullWhite.discountBond`, and `g2pp(curve, {}).discountBond({})` yields `g2pp.discountBond`.
 *
 * Parsed, so a builder chain resolves to the receiver it was actually built from. Comparing only the
 * final member (`discountBond === discountBond`) is what readmitted the g2pp regression.
 */
export function calleePath(example: string): string | null {
  const sf = ts.createSourceFile('x.ts', `(${example})`, ts.ScriptTarget.ESNext, true);
  /**
   * A MALFORMED example is not a runnable one. The parser recovers from syntax errors, so
   * `blackScholesPrice({ spot: })` still yields the expected callee and passed every check here
   * while being unpasteable — the promise is "a working example call", and a recovered parse tree is
   * not evidence that it works.
   */
  if ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) return null;
  let outermost: ts.CallExpression | null = null;
  const find = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && outermost === null) outermost = n;
    ts.forEachChild(n, find);
  };
  find(sf);
  if (outermost === null) return null;
  const render = (expression: ts.Expression): string => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression))
      return `${render(expression.expression)}.${expression.name.text}`;
    // The receiver of a chain is whatever was CALLED to produce it.
    if (ts.isCallExpression(expression)) return render(expression.expression);
    if (ts.isParenthesizedExpression(expression)) return render(expression.expression);
    return expression.getText();
  };
  return render((outermost as ts.CallExpression).expression);
}

describe('missing-field examples, inventoried from the AST', () => {
  it('sees both emitters', () => {
    // A scan that matches nothing looks exactly like a codebase with nothing to check. Asserted per
    // emitter, because a pattern that breaks for one is invisible in a combined total.
    for (const emitter of EMITTERS) {
      const found = SITES.filter((s) => s.emitter === emitter).length;
      expect(found, `${emitter} scan matched nothing`).toBeGreaterThan(2);
    }
  });

  it('every statically-known boundary has an example that invokes IT', () => {
    const offenders: string[] = [];
    for (const site of SITES) {
      if (site.reported === null || site.example === null) continue;
      const callee = calleePath(site.example);
      if (callee === null) {
        offenders.push(`${site.file}: ${site.reported} — example is not a call: ${site.example}`);
        continue;
      }
      if (callee !== site.reported) {
        offenders.push(
          `${site.file}: ${site.reported} recommends ${callee} — a different API.\n    ${site.example}`,
        );
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every example is a runnable call, never a field fragment', () => {
    const offenders = SITES.filter((s) => s.example !== null && calleePath(s.example) === null).map(
      (s) => `${s.file}: ${s.example}`,
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every boundary supplies an example at all', () => {
    // RV9 made `exampleCall` required in `RequireFiniteFieldsOptions`, so the type system now asks
    // every boundary for one. What the type system cannot judge is whether the example is TRUE —
    // a boundary can still promise a worked
    // example and pass none — and the previous inventory dropped exactly those sites, which made the
    // gap unobservable by the gate built to observe it.
    const silent = SITES.filter((s) => !s.hasExample).map(
      (s) => `${s.file} (${s.emitter}): ${s.reported ?? '<variable>'} passes no exampleCall`,
    );
    expect(silent, silent.join('\n')).toEqual([]);
  });

  it('a shared validator computes its example from the reported name', () => {
    const offenders = SITES.filter((s) => s.reported === null && !s.derived).map(
      (s) =>
        `${s.file} (${s.emitter}): reports a variable but passes a fixed example — every caller of ` +
        `this validator receives the same recommendation, so all but one are wrong.`,
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('calleePath — the parser the gate depends on', () => {
  it.each([
    ['sviG({ a: 1 }, 0)', 'sviG'],
    ['blackScholes.price({ spot: 1 })', 'blackScholes.price'],
    ['hullWhite(curve, { a: 0.03 }).discountBond({ valuationTime: 0 })', 'hullWhite.discountBond'],
    ['g2pp(curve, {}).discountBond({ valuationTime: 0 })', 'g2pp.discountBond'],
    ['slippage.bps(1).fill({ referencePrice: 42 })', 'slippage.bps.fill'],
    ['bonds.fixedRate({ issueDate: 1 })', 'bonds.fixedRate'],
  ])('%s -> %s', (example, expected) => {
    expect(calleePath(example)).toBe(expected);
  });

  it('distinguishes two builders that share a method name', () => {
    // The precise regression a final-segment comparison readmits.
    expect(calleePath('hullWhite(curve, {}).discountBond({})')).not.toBe(
      calleePath('g2pp(curve, {}).discountBond({})'),
    );
  });

  it('reports a bare field fragment as not-a-call', () => {
    expect(calleePath("issueDate: '2026-01-15'")).toBeNull();
  });
});
/**
 * THE SCANNER'S BLIND SPOT, CLOSED FROM THE OTHER SIDE.
 *
 * RV10 — the walk above recognizes a direct identifier callee with an inline object literal for the
 * options argument. An aliased helper (`const rff = requireFiniteFields`) or an options object held
 * in a variable would slip past it, and a boundary that evades the scanner is a boundary whose
 * example is never checked for truth.
 *
 * MEASURED before deciding what to do about it: across `packages/`, 29 `requireFiniteFields`
 * callsites, 0 with a non-identifier callee, and exactly 1 with non-literal options — a test helper
 * that forwards its own parameter, not a boundary. So widening the parser today would be speculative
 * work against a form nothing uses.
 *
 * Instead this asserts the shape the scanner can read, in production source only. Adopting an
 * evading form is now a failure that names the file, rather than a silent loss of coverage — which
 * is the same trade this phase has made everywhere else: make the gap impossible rather than guess
 * at how it might arrive.
 */
describe('RV10 — no production callsite can evade the example-call scanner', () => {
  /**
   * THE POPULATION, COUNTED INDEPENDENTLY OF THE INVENTORY THAT DESCRIBES IT.
   *
   * Every gate in this file reasons over `SITES`. If a call never became a site, all of them agree
   * about a set that does not contain it — population and description came from one walk, so neither
   * can contradict the other. This walks the sources again, from scratch, counting emitter CALL
   * EXPRESSIONS by callee name, and requires the inventory to account for every one. It is the
   * assertion that actually caught the text pre-filter: 35 calls, 34 sites.
   */
  it('the inventory accounts for every emitter call in production source', () => {
    let counted = 0;
    for (const file of SOURCES) {
      const sf = parseSourceOrThrow(file, readFileSync(file, 'utf8'));
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : null;
          if (callee !== null && (EMITTERS as readonly string[]).includes(callee)) counted += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    // Seated on the measured population. A zero would make every other assertion here vacuous, and a
    // FALL means the scan is losing its subject rather than the library losing callsites.
    // Re-seated 34 → 31 (2026-08-15): the library did lose call sites, legitimately — the bonds
    // builders and the solver family retired their direct missingFieldError emitters when the
    // shared validateClosedRequest/requireSolverInputs heads took over; the teaching those sites
    // carried now flows through the shared validators' derived examples, which this file's other
    // assertions cover.
    expect(
      counted,
      'the scan is losing its subject — fewer emitter calls than the population it was seated on',
    ).toBeGreaterThanOrEqual(31);
    expect(
      SITES.length,
      `the independent walk found ${counted} emitter calls but the inventory holds ${SITES.length}. ` +
        'Every call must be recorded or explicitly explained; absorbing the difference is how a ' +
        'callsite goes unverified.',
    ).toBe(counted);
  });

  it('every emitter callsite in production source carries an example the scanner could read', () => {
    /**
     * The end-to-end form of the anti-evasion rule. The callee/alias test above keeps calls FINDABLE;
     * this one keeps them READABLE, and it asks the scanner rather than re-implementing its
     * resolver — the two cannot disagree because there is only one of them.
     */
    /**
     * RESOLVED, not merely PRESENT. This filtered on `hasExample`, which is
     * `exampleArg !== undefined` — the existence of an argument, never whether the scanner could
     * read it. A site passing an expression the resolver returns `null` for therefore satisfied a
     * test named "carries an example the scanner could read" while carrying nothing readable.
     * `example` is the resolved string; `derived` is the caller-varying escape; one must hold.
     */
    const unreadable = SITES.filter(
      (site) => site.file.includes('/src/') && site.example === null && !site.derived,
    ).map((site) => `${site.file.slice(site.file.indexOf('/packages/') + 1)}: ${site.emitter}`);
    expect(
      unreadable,
      `these emitter callsites supplied no example the scanner could read, so their examples go\nunverified:\n${unreadable.join('\n')}`,
    ).toEqual([]);
  });

  it('every emitter call uses a direct callee and an inline options literal', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(PACKAGES_DIR)) {
      if (!file.includes('/src/')) continue;
      const sf = parseSourceOrThrow(file, readFileSync(file, 'utf8'));
      const visit = (node: ts.Node): void => {
        /**
         * RV11 — ALIASING IS THE EVASION THIS GATE COULD NOT SEE.
         *
         * The call check matches the callee TEXT, so `const rff = requireFiniteFields; rff(...)`
         * slips past it twice over: `rff` is an identifier, and it does not end with an emitter
         * name, so the call is never even recognized as one. Text matching cannot resolve that;
         * symbol resolution would need a full `Program`, which this scanner deliberately does not
         * build. So the binding is forbidden at its source instead — cheap, exact, and it makes the
         * form unreachable rather than merely unrecognized.
         */
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer !== undefined &&
          ts.isIdentifier(node.initializer) &&
          (EMITTERS as readonly string[]).includes(node.initializer.text)
        ) {
          offenders.push(
            `${file.slice(file.indexOf('/packages/') + 1)}: aliases \`${node.initializer.text}\` to \`${node.name.getText(sf)}\` — the scanner matches the callee by name, so an alias would go unread`,
          );
        }
        if (ts.isImportSpecifier(node) && node.propertyName !== undefined) {
          const original = node.propertyName.text;
          if ((EMITTERS as readonly string[]).includes(original)) {
            offenders.push(
              `${file.slice(file.indexOf('/packages/') + 1)}: imports \`${original}\` as \`${node.name.text}\` — rename the import back, or the scanner cannot find its calls`,
            );
          }
        }
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText(sf);
          /**
           * RV11 — BOTH emitters, but each judged by ITS OWN shape.
           *
           * Guarding only `requireFiniteFields` left `missingFieldError` free to adopt a form the
           * scanner cannot read. Widening it naively then flagged three innocent callsites, because
           * the two signatures differ: `requireFiniteFields(fn, input, fields, OPTIONS)` takes an
           * options object at index 3, while `missingFieldError(fn, field, EXAMPLE, hint?)` takes an
           * optional hint STRING there. Asserting one emitter's argument shape against the other is
           * a gate that fails for a reason unconnected to what it names — the defect this phase keeps
           * finding, produced here by my own first attempt at the fix.
           *
           * The callee rule is universal; the argument rule is per-emitter, matching exactly what the
           * scanner above reads for each.
           */
          const emitter = EMITTERS.find((candidate) => callee.endsWith(candidate));
          if (emitter) {
            const where = `${file.slice(file.indexOf('/packages/') + 1)}`;
            if (!ts.isIdentifier(node.expression)) {
              offenders.push(
                `${where}: ${emitter} callee is \`${callee}\`, not a direct identifier`,
              );
            }
            if (emitter === 'requireFiniteFields') {
              const options = node.arguments[3];
              if (options && !ts.isObjectLiteralExpression(options)) {
                offenders.push(
                  `${where}: requireFiniteFields options argument is \`${options.getText(sf).slice(0, 40)}\`, not an inline object literal`,
                );
              }
            } else {
              /**
               * RV12 — READABILITY IS ASKED OF THE SCANNER, NOT RE-DERIVED HERE.
               *
               * This listed node kinds by hand, and the list was wider than `resolveString`:
               * property-access and call expressions were admitted while the resolver returns null
               * for both, so such a callsite would be judged fine here and then silently skipped
               * downstream. My first correction swung the other way — calling `resolveString` with an
               * EMPTY constants map — and flagged four healthy sites, because the production scan
               * builds a per-file constant map and I had not given the resolver its context. A
               * stricter copy of a rule is still a second copy, and it disagreed with the original
               * immediately.
               *
               * So the judgement is delegated to the scan that already made it: every emitter call in
               * production source must appear in `SITES` carrying an example, whether resolved
               * statically or derived from the reported name. There is one rule and one place it
               * lives.
               */
              void node;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(
      offenders,
      `these callsites are in a form the example-call scanner cannot read, so their examples would go\nunverified — either keep the direct form or widen the scanner in the same commit:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * PARSE DIAGNOSTICS FAIL CLOSED.
 *
 * RV11 — the scanner reads source with `ts.createSourceFile`, which is permissive: malformed input
 * produces a tree with diagnostics rather than an exception. A scanner that walks that tree anyway
 * finds no emitter calls and reports a clean sweep, so a file that stopped parsing would read as a
 * file with nothing to check. This fixture proves the rejection is real rather than assumed.
 */
describe('RV12 — the SCANNER fails closed on a file it cannot parse', () => {
  /**
   * The previous version of this test asserted that TypeScript produces parse diagnostics for
   * malformed source. True, and beside the point: neither production scan consulted them, so the
   * scanner did not fail closed and the test proved a property of the compiler rather than of the
   * code under test. It exercises `parseSourceOrThrow` — the one entry point both scans now use.
   */
  it('throws rather than returning a tree built from unreadable source', () => {
    expect(() =>
      parseSourceOrThrow(
        'broken.ts',
        'export function f( { requireFiniteFields("a", x, ["b"], { exampleCall: "f({ b: 1 })" }',
      ),
    ).toThrow(/did not parse/);
  });

  it('accepts well-formed source, so the check above is discriminating', () => {
    const sourceFile = parseSourceOrThrow(
      'fine.ts',
      'requireFiniteFields("a", x, ["b"], { exampleCall: "f({ b: 1 })" });',
    );
    expect(sourceFile.statements.length).toBeGreaterThan(0);
  });

  it('the shared parser is the only way in — both scans call it', () => {
    /**
     * Asserted by construction rather than by grepping this file for `ts.createSourceFile`: that
     * regex matched the legitimate call INSIDE `parseSourceOrThrow` and failed, which is a fair
     * reminder that a test reading its own source is usually measuring the wrong thing.
     *
     * `SITES` is built by the first scan and the anti-evasion test drives the second; both now go
     * through `parseSourceOrThrow`, so a file that stopped parsing throws in either. The two tests
     * above prove the parser's behaviour; this one proves the scan actually produced findings, so a
     * silently empty run cannot masquerade as a clean one.
     */
    expect(
      SITES.length,
      'the scan found no emitter callsites at all — that is not a clean sweep',
    ).toBeGreaterThan(20);
  });
});
