/**
 * An intersection is an object — UNLESS it is a branded scalar.
 *
 * "An intersection is an object" fixed a real hole: 66 public boundaries had no enforcement record
 * because `BarrierInput & { type; barrierType }` was filed `other`, the bucket nothing downstream can
 * build. But the rule is not universally true, and shipped one commit without a fixture saying so.
 *
 *     type USD = number & { readonly __brand: unique symbol };
 *
 * is a number wearing a nominal tag. Callers pass `42`. Classified as an object, synthesis would
 * build `{}` for it and every probe would mutate fields it does not have — so the boundary would be
 * measured against a value no caller could ever send, and whatever verdict came back would describe
 * nothing.
 *
 * No public TotalFinance contract is a branded scalar today. That is exactly why this file exists: the
 * rule would have been silently wrong the first time someone reached for the pattern, and "no current
 * instance" is a fact about today, not a property of the classifier.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  implementationParameterOccurrence,
  isUnresolvedImplementation,
  publicParameterOccurrence,
} from './identity.js';
import { isBrandedScalar } from './signature-inventory.js';

/**
 * What a compound parameter's contract looks like, independent of who is describing it.
 *
 * `common` is what every value of the parameter must carry; `branches` is the per-alternative
 * extension when the parameter is a union of intersections. Comparing only `common` was how a union
 * contract could lose an entire branch and still match — the union of a set says almost nothing
 * about its partition.
 */
interface Shape {
  common: string[];
  branches: string[][];
}

const shapeIsEmpty = (shape: Shape): boolean =>
  shape.common.length === 0 && shape.branches.every((branch) => branch.length === 0);

const shapeKey = (shape: Shape): string =>
  `${shape.common.join(',')}||${shape.branches.map((b) => b.join(',')).join(' | ')}`;

interface ContractParameter {
  name: string;
  type?: string;
  kind?: string;
  typeDeclaration?: string | null;
  fieldTree?: { name: string }[];
  branches?: { fields?: { name: string }[] }[];
}
interface ContractRecord {
  id: string;
  implementation?: string;
  signatures?: { parameters?: ContractParameter[] }[];
}

const FIXTURE = `
type USD = number & { readonly __brand: unique symbol };
type Ticker = string & { readonly __brand: unique symbol };
interface Market { spot: number; strike: number }
interface Extra { type: 'call' | 'put' }

declare function brandedNumber(a: USD): void;
declare function brandedString(a: Ticker): void;
declare function objectIntersection(a: Market & Extra): void;
declare function inlineObjectIntersection(a: Market & { barrierType: 'up-in' }): void;
declare function plainObject(a: Market): void;
declare function plainNumber(a: number): void;
`;

function classify(): Map<string, { branded: boolean; properties: string[] }> {
  const file = 'intersection-fixture.ts';
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === file
      ? ts.createSourceFile(name, FIXTURE, languageVersion as ts.ScriptTarget, true)
      : original(name, languageVersion, ...rest);
  const program = ts.createProgram([file], { strict: true, skipLibCheck: true }, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const out = new Map<string, { branded: boolean; properties: string[] }>();
  source?.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.parameters[0]) {
      const type = checker.getTypeAtLocation(node.parameters[0]);
      out.set(node.name.text, {
        branded: isBrandedScalar(type),
        /**
         * Members DECLARED IN THIS FIXTURE — the same intent as the real walker's "not a lib
         * declaration" rule, expressed exactly rather than by path substring. Matching on
         * `/typescript/lib/` let `String.prototype.at` through here, which is a reminder that a
         * filter written as a path guess is a filter that can miss.
         *
         * Without it a branded number reports `toFixed`/`toExponential`/…, and that IS the argument:
         * the only members it has belong to `Number`.
         */
        properties: checker
          .getPropertiesOfType(type)
          .filter((symbol) => {
            const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
            return declaration !== undefined && declaration.getSourceFile().fileName === file;
          })
          .map((symbol) => symbol.name)
          .filter((name) => !name.startsWith('__'))
          .sort(),
      });
    }
  });
  return out;
}

describe('intersection classification', () => {
  const classified = classify();

  it.each([
    ['brandedNumber', true],
    ['brandedString', true],
    ['objectIntersection', false],
    ['inlineObjectIntersection', false],
    ['plainObject', false],
    ['plainNumber', false],
  ])('%s is branded-scalar: %s', (name, expected) => {
    expect(classified.get(name)?.branded).toBe(expected);
  });

  /**
   * The other half of the rule: an OBJECT intersection must expose every member, from both
   * constituents. This is the property the 66-boundary fix depended on, and the one whose absence
   * would make a generated allowed-key list reject valid calls.
   */
  it('an object intersection exposes members from both sides', () => {
    expect(classified.get('objectIntersection')?.properties).toEqual(['spot', 'strike', 'type']);
    expect(classified.get('inlineObjectIntersection')?.properties).toEqual([
      'barrierType',
      'spot',
      'strike',
    ]);
  });

  it('a branded scalar contributes no contract members of its own', () => {
    // Its only properties are `Number`'s — `toFixed`, `toExponential`, … — which the walker drops as
    // lib declarations. So an object reading of it synthesizes `{}`: a value no caller could send,
    // and any verdict measured against it describes nothing.
    expect(classified.get('brandedNumber')?.properties).toEqual([]);
    expect(classified.get('brandedString')?.properties).toEqual([]);
  });
});

/**
 * THE GENERATED ARTIFACT, checked against the CHECKER — independently, not against itself.
 *
 * The first version of this block read `public-contracts.json` and asserted the intersection trees
 * were non-empty. That is a weaker claim than the commit message it shipped under said: non-empty is
 * not correct, so a non-sentinel intersection could quietly lose a field and still pass — and 3B.1 is
 * about to generate validation allowlists from exactly these trees.
 *
 * So this rediscovers every public intersection parameter through its own TypeScript `Program`, and
 * compares EXACT sorted field sets against the artifact. If the generator and the checker disagree
 * about any of them, the run fails and names the difference.
 */
describe('generated intersection field trees match the checker', () => {
  const packagesDir = fileURLToPath(new URL('../../packages', import.meta.url));

  /** Every public `.d.ts` entrypoint, the same surface the generator walks, WITH its package name. */
  function entrypointFiles(): { file: string; pkg: string }[] {
    const out: { file: string; pkg: string }[] = [];
    for (const dir of readdirSync(packagesDir).sort()) {
      let manifest: { name?: string; exports?: Record<string, unknown> };
      try {
        manifest = JSON.parse(
          readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'),
        ) as typeof manifest;
      } catch {
        continue;
      }
      const targets = new Set<string>(['./dist/index.d.ts']);
      for (const [key, value] of Object.entries(manifest.exports ?? {})) {
        if (key === './package.json') continue;
        const target =
          typeof value === 'string'
            ? value
            : ((value as Record<string, string>)['types'] ??
              (value as Record<string, string>)['import'] ??
              (value as Record<string, string>)['default']);
        if (target) targets.add(target.replace(/\.js$/, '.d.ts'));
      }
      const pkg = manifest.name;
      if (!pkg) continue;
      for (const target of targets) {
        const path = join(packagesDir, dir, target.replace(/^\.\//, ''));
        if (existsSync(path)) out.push({ file: path, pkg });
      }
    }
    return out;
  }

  /**
   * PUBLIC PARAMETER OCCURRENCE -> shape, discovered from the checker alone.
   *
   * RV12: keyed positionally (`|sigN|argM`), not by parameter name. The name was never an identity —
   * it is not unique across overloads and the two walkers can spell a destructured parameter
   * differently — so a name-keyed join silently compared slots that were not the same slot.
   */
  function discoverFromChecker(): {
    shapes: Map<string, Shape>;
    implementations: Map<string, string>;
  } {
    const entrypoints = entrypointFiles();
    const program = ts.createProgram(
      entrypoints.map((e) => e.file),
      {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        skipLibCheck: true,
        strict: true,
      },
    );
    const checker = program.getTypeChecker();
    const found = new Map<string, Shape>();
    /** Public parameter occurrence -> implementation parameter occurrence, derived from the AST. */
    const implementations = new Map<string, string>();

    /**
     * The declaration site a parameter belongs to, spelled the way the generator spells it:
     * `packages/<pkg>/dist/<file>.d.ts#<owner>` where `<owner>` is `Interface.method` for a member
     * and the bare name for a free function.
     *
     * This is what lets the coverage question be asked about the CONTRACT rather than about a path
     * spelling. `@totalfinance/strategy:strategy.coveredCall` and `@totalfinance/strategy:coveredCall` are
     * two spellings of one declaration; demanding both appear as labels reported a generator gap
     * where none existed.
     */
    const implementationOf = (parameterDeclaration: ts.Declaration): string | null => {
      const fileName = parameterDeclaration.getSourceFile().fileName;
      if (!fileName.includes('/packages/')) return null;
      /**
       * Climb to the nearest NAMED ancestors. A parameter's immediate parent is usually an unnamed
       * function-type node (`price: (input: X) => Y`), so reading only that parent resolved 28 of
       * 144 occurrences — and an identity that resolves for a fifth of its subjects silently turns
       * the other four fifths into "unrecorded".
       */
      const names: string[] = [];
      for (let node: ts.Node | undefined = parameterDeclaration.parent; node; node = node.parent) {
        if (ts.isSourceFile(node)) break;
        const name = (node as ts.NamedDeclaration).name;
        if (name && ts.isIdentifier(name)) names.unshift(name.text);
        if (names.length === 2) break; // `<Owner>.<member>` is as deep as the generator spells it
      }
      if (names.length === 0) return null;
      return `packages/${fileName.split('/packages/')[1]}#${names.join('.')}`;
    };

    const propertiesOf = (type: ts.Type): string[] =>
      checker
        .getPropertiesOfType(type)
        .filter((symbol) => {
          const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
          return (
            declaration !== undefined &&
            !declaration.getSourceFile().fileName.includes('/typescript/lib/')
          );
        })
        .map((symbol) => symbol.name)
        .filter((name) => !name.startsWith('__'))
        .sort();

    const record = (label: string, type: ts.Type): void => {
      const parts = type.isUnion() ? type.types : [type];
      const meaningful = parts.filter(
        (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
      );
      /**
       * COMPOUND = an intersection, OR a union with more than one surviving branch.
       *
       * Restricting this to the `Intersection` flag is why planting an emptied `branchFields` branch
       * did not fail this file: a union-of-objects contract never entered the population, so the
       * branch trees added for it were recorded and then compared against nothing. A field nothing
       * checks is the same as a field that is not there.
       */
      const isIntersection = meaningful.some((part) =>
        Boolean(part.flags & ts.TypeFlags.Intersection),
      );
      if (!isIntersection && meaningful.length < 2) return;
      const subject = meaningful.length === 1 ? (meaningful[0] as ts.Type) : type;
      const shape: Shape = {
        common: propertiesOf(subject),
        // A union's own properties are only the COMMON ones; each branch's extension is recorded
        // separately so a lost alternative cannot hide behind an intact intersection.
        branches: meaningful.length > 1 ? meaningful.map((part) => propertiesOf(part)) : [],
      };
      if (!shapeIsEmpty(shape)) found.set(label, shape);
    };

    const recordCallable = (owner: string, type: ts.Type): void => {
      const signatures = type.getCallSignatures();
      for (let signatureIndex = 0; signatureIndex < signatures.length; signatureIndex += 1) {
        const parameters = (signatures[signatureIndex] as ts.Signature).getParameters();
        for (let parameterIndex = 0; parameterIndex < parameters.length; parameterIndex += 1) {
          const parameter = parameters[parameterIndex] as ts.Symbol;
          const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
          if (!parameterDeclaration) continue;
          const key = publicParameterOccurrence(owner, signatureIndex, parameterIndex);
          record(key, checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration));
          const implementation = implementationOf(parameterDeclaration);
          if (found.has(key) && implementation)
            implementations.set(
              key,
              implementationParameterOccurrence(implementation, signatureIndex, parameterIndex),
            );
        }
      }
    };

    /**
     * RV10 — ONLY THE DECLARED ENTRYPOINTS, EACH ATTRIBUTED TO ITS PACKAGE.
     *
     * This used to walk `program.getSourceFiles()` filtered to any `.d.ts` under `/packages/`, which
     * is every transitively imported internal module, and it labelled findings by bare callable name.
     * The artifact labels by `<package>:<callable>`, so the two sets never spoke the same language:
     * 56 checker labels against 91 artifact labels, 50 compared, 41 artifact-only. A defect on an
     * umbrella-only path had nothing to compare against and passed.
     *
     * Walking the export map means the umbrella IS one of the entrypoints, so its re-export paths are
     * reached as `totalfinance:…` rather than collapsing into the defining package's name — which is what
     * lets the comparison below demand zero unmatched labels in BOTH directions instead of a floor.
     */
    /**
     * RV10 — walk the facade to the DEPTH the artifact records, and see classes from the instance
     * side.
     *
     * Two structural gaps kept 41 artifact records unverifiable. The umbrella exposes namespaces two
     * levels deep (`options.asian.geometricPrice`), and this walked exactly one
     * (`exported.name.member`), so every `totalfinance:options.<family>.<method>` record had nothing to
     * compare against. And a class symbol's TYPE is its constructor, so `getPropertiesOfType` returns
     * statics — `Position.monteCarloProbability` and `FeaturePipeline.applyBars` are instance
     * methods and were invisible. Both are exactly the umbrella/alias paths the previous version
     * excused with a floor.
     */
    const MAX_FACADE_DEPTH = 3;
    const walkMembers = (label: string, type: ts.Type, depth: number, seen: Set<ts.Type>): void => {
      if (depth > MAX_FACADE_DEPTH || seen.has(type)) return;
      seen.add(type);
      recordCallable(label, type);
      for (const member of checker.getPropertiesOfType(type)) {
        const memberDeclaration = member.valueDeclaration ?? member.declarations?.[0];
        if (!memberDeclaration) continue;
        if (memberDeclaration.getSourceFile().fileName.includes('/typescript/lib/')) continue;
        if (member.name.startsWith('__')) continue;
        /**
         * A FRESH `seen` PER BRANCH. Sharing one set across an export's whole walk is keyed on the
         * `ts.Type` object, so when two members of a namespace share a type — `readonly european:
         * typeof european` sitting alongside the re-exported `european` — only whichever label was
         * reached FIRST had its parameters recorded. `totalfinance:options.european|sig0|arg0` and
         * `totalfinance:fixedIncome.creditSpreadCurve|sig0|arg1` are real public boundaries with recorded
         * field trees that were never re-resolved, which is exactly what the comment above promises
         * cannot happen. Depth is bounded by MAX_FACADE_DEPTH, so per-branch is still terminating.
         */
        walkMembers(
          `${label}.${member.name}`,
          checker.getTypeOfSymbolAtLocation(member, memberDeclaration),
          depth + 1,
          new Set(seen),
        );
      }
    };

    for (const { file: fileName, pkg } of entrypoints) {
      const file = program.getSourceFile(fileName);
      if (!file) continue;
      const moduleSymbol = checker.getSymbolAtLocation(file);
      if (!moduleSymbol) continue;
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const alias =
          exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const declaration = alias.valueDeclaration ?? alias.declarations?.[0];
        if (!declaration) continue;
        const label = `${pkg}:${exported.name}`;
        walkMembers(
          label,
          checker.getTypeOfSymbolAtLocation(alias, declaration),
          1,
          new Set<ts.Type>(),
        );
        // A class symbol's type is its CONSTRUCTOR; its instance methods live on the declared type.
        if (alias.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
          walkMembers(label, checker.getDeclaredTypeOfSymbol(alias), 1, new Set<ts.Type>());
        }
      }
    }
    return { shapes: found, implementations };
  }

  const { shapes: fromChecker, implementations: checkerImplementations } = discoverFromChecker();

  const artifact = JSON.parse(
    readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
  ) as { contracts?: ContractRecord[]; inputContracts?: ContractRecord[] };

  /**
   * EVERY record under a label, not the last one.
   *
   * `@totalfinance/options:barrier.monteCarloPrice` and `totalfinance:barrier.monteCarloPrice` are separate
   * records of the same callable. Keyed by callable name alone, the umbrella twin overwrote the
   * package record — so deleting `barrierType` from one of them left the map holding the intact copy
   * and this gate passed. I found that by planting the defect it exists to catch, which is the only
   * way any of these have ever been trustworthy.
   */
  /**
   * RV10 — keyed by the FULL record id, so package and umbrella records stay distinct.
   *
   * This used to strip the package (`record.id.split(':').pop()`), which collapsed
   * `@totalfinance/options:barrier.monteCarloPrice` and `totalfinance:barrier.monteCarloPrice` onto one label
   * and forced an array-of-records workaround. With the checker now labelling by package too, the two
   * sides share one identity scheme and the comparison can be exact in both directions.
   */
  /**
   * PUBLIC PARAMETER OCCURRENCE -> recorded shape, for EVERY parameter — no text selection.
   *
   * RV12-4: this used to admit a parameter only when its rendered type string contained `&`. That
   * made a rendering detail load-bearing: a compound contract behind a type alias renders without an
   * `&` and was skipped, and nothing distinguished "skipped" from "agreed". The population under
   * comparison is now decided by the CHECKER, which knows the actual type, and the artifact is
   * merely looked up — so a parameter the checker calls compound can never be quietly passed over.
   */
  const fromArtifact = new Map<string, Shape>();
  /** Public parameter occurrence -> implementation parameter occurrence (identity 1 -> identity 2). */
  const publicToImplementation = new Map<string, string>();
  /** Identity 3 — the named type filling the slot, shared far more widely than either occurrence. */
  const declaredContract = new Map<string, string | null>();
  /** How the slot's type RENDERS, which is what separates two instantiations of one generic. */
  const renderedType = new Map<string, string>();
  const unresolvedImplementations: string[] = [];

  for (const record of artifact.contracts ?? artifact.inputContracts ?? []) {
    /**
     * The two walkers spell "member of" differently: the artifact writes a class member as
     * `Position#monteCarloProbability`, the checker walk as `Position.monteCarloProbability`. Only
     * the separator differs, so the owner is normalized to dots and the two identity schemes become
     * one. This is a spelling reconciliation, not a widening — an occurrence that differs by
     * anything other than the separator still fails the comparison below.
     */
    const owner = record.id.replace(/#/g, '.');
    const signatures = record.signatures ?? [];
    for (let signatureIndex = 0; signatureIndex < signatures.length; signatureIndex += 1) {
      const parameters =
        (signatures[signatureIndex] as { parameters?: ContractParameter[] }).parameters ?? [];
      for (let parameterIndex = 0; parameterIndex < parameters.length; parameterIndex += 1) {
        const parameter = parameters[parameterIndex] as ContractParameter;
        const publicOccurrence = publicParameterOccurrence(owner, signatureIndex, parameterIndex);
        declaredContract.set(publicOccurrence, parameter.typeDeclaration ?? null);
        renderedType.set(publicOccurrence, parameter.type ?? '');
        fromArtifact.set(publicOccurrence, {
          common: (parameter.fieldTree ?? []).map((f) => f.name).sort(),
          branches: (parameter.branches ?? []).map((arm) =>
            (arm.fields ?? []).map((f) => f.name).sort(),
          ),
        });
        if (isUnresolvedImplementation(record.implementation)) {
          unresolvedImplementations.push(publicOccurrence);
          continue;
        }
        publicToImplementation.set(
          publicOccurrence,
          implementationParameterOccurrence(
            record.implementation as string,
            signatureIndex,
            parameterIndex,
          ),
        );
      }
    }
  }

  /** Every implementation parameter occurrence the artifact records a contract for. */
  const recordedImplementations = new Set(publicToImplementation.values());

  /**
   * A checker finding is UNRECORDED only when its CONTRACT is absent — not when a path spelling is.
   *
   * Keyed by public label, this set held 13 entries and was described as a generator gap. Three were
   * the gate's own text selector skipping a compound contract that renders without an `&`
   * (`FromChainOptions`), and several more were one declaration reachable under two spellings
   * (`strategy.coveredCall` vs `coveredCall`). Only what survives BOTH corrections is a boundary
   * nothing enforces.
   */
  /**
   * The recorded shape reached by IMPLEMENTATION, so a public path the generator spells differently
   * still finds its own contract. The consistency tests below prove these entries do not conflict,
   * which is what makes "first one wins" safe rather than arbitrary.
   */
  const artifactByImplementation = new Map<string, Shape>();
  {
    /**
     * ONE SHAPE PER IMPLEMENTATION, OR NO FALLBACK AT ALL.
     *
     * "First one wins" was justified here by the consistency test below — but that test keys on
     * implementation AND instantiation, a strictly finer key, so it permits one implementation
     * occurrence to carry different contracts at different instantiations. `Facade.explain` is
     * exactly that: one declaration, fourteen contracts. Taking the first would hand a lookup the
     * wrong one and call it agreement. Where an implementation is ambiguous the fallback simply
     * declines, which costs nothing — the only callers are the ten public paths the artifact spells
     * differently, and every one of them is unambiguous.
     */
    const shapesFor = new Map<string, Set<string>>();
    for (const [publicOccurrence, implementation] of publicToImplementation) {
      const shape = fromArtifact.get(publicOccurrence);
      if (!shape || shapeIsEmpty(shape)) continue;
      const seenShapes = shapesFor.get(implementation) ?? new Set<string>();
      seenShapes.add(shapeKey(shape));
      shapesFor.set(implementation, seenShapes);
      if (!artifactByImplementation.has(implementation))
        artifactByImplementation.set(implementation, shape);
    }
    for (const [implementation, seenShapes] of shapesFor) {
      if (seenShapes.size > 1) artifactByImplementation.delete(implementation);
    }
  }

  /**
   * The artifact's record for a checker finding: by public path when that path IS recorded, and by
   * contract only when it is not recorded at all.
   *
   * The distinction is the whole point. Falling back whenever the direct entry was EMPTY masked a
   * per-path regression: emptying the branch trees on one of `deflatedSharpeRatio`'s three public
   * paths left the other two intact, the lookup silently answered with a sibling's shape, and the
   * planted defect passed. An empty record and an absent record are different facts — the first is a
   * contract the generator claims to have described and did not.
   */
  const recordedFor = (key: string): Shape | undefined => {
    if (fromArtifact.has(key)) return fromArtifact.get(key);
    const implementation = checkerImplementations.get(key);
    return implementation ? artifactByImplementation.get(implementation) : undefined;
  };

  const checkerOnly = [...fromChecker.keys()]
    .filter((key) => {
      if (fromArtifact.has(key)) return false;
      const implementation = checkerImplementations.get(key);
      return !implementation || !recordedImplementations.has(implementation);
    })
    .sort();
  const spellingOnly = [...fromChecker.keys()].filter(
    (key) => !fromArtifact.has(key) && !checkerOnly.includes(key),
  ).length;

  it('the checker independently finds intersection parameters', () => {
    // Measured, not guessed. A zero — or a quiet slide toward one — makes every comparison below
    // vacuous, which is the failure this file exists to prevent.
    if (process.env['PRINT_COVERAGE'])
      console.log({
        checkerOccurrences: fromChecker.size,
        artifactOccurrences: fromArtifact.size,
        implementationOccurrences: new Set(publicToImplementation.values()).size,
        unresolvedImplementations: unresolvedImplementations.length,
        checkerImplementationsResolved: checkerImplementations.size,
        reachedUnderAnotherSpelling: spellingOnly,
        checkerOnly: checkerOnly.length,
        checkerOnlyKeys: checkerOnly,
      });
    /**
     * A RATCHET, NOT A FLOOR OF ONE. `toBeGreaterThan(0)` sat under a comment promising to prevent
     * exactly "a quiet slide toward one", and did not: with the umbrella's `dist` absent the checker
     * re-resolves 56 of 154 and every test here still passes; narrowed to three packages it
     * re-resolves 4 of 154 and still passes. 97% of the subject could vanish silently while this file
     * published "154" as the closing measurement for the generator gap.
     */
    expect(
      fromChecker.size,
      'the checker re-resolves fewer compound occurrences than it did — the population this file ' +
        'verifies has shrunk, and every comparison below is correspondingly weaker',
    ).toBeGreaterThanOrEqual(156);
  });

  /**
   * EVERY PACKAGE IS WALKED — the one thing the population count cannot express.
   *
   * `entrypointFiles()` admits a target only `if (existsSync(path))`, and `dist/` is gitignored, so a
   * package that never gets built is skipped in silence. That is not hypothetical here: `pnpm build`
   * is `tsc -b tsconfig.build.json` whose `references` list is hand-maintained, and forgetting to wire
   * a new package into it is a known failure mode in this repo. The count above would never notice —
   * it can only fall, and an unbuilt package never contributed to it in the first place.
   */
  it('every workspace package contributes an entrypoint', () => {
    const declared = readdirSync(packagesDir)
      .sort()
      .filter((dir) => {
        try {
          return Boolean(
            (
              JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8')) as {
                name?: string;
              }
            ).name,
          );
        } catch {
          return false;
        }
      });
    const walked = new Set(
      entrypointFiles().map((entry) => entry.file.slice(packagesDir.length + 1).split('/')[0]),
    );
    const missing = declared.filter((dir) => !walked.has(dir));
    expect(
      missing,
      `these packages declare a name but contribute no entrypoint, so nothing in them is verified ` +
        `by this file — usually a missing tsconfig.build.json reference:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * COVERAGE, ONE DIRECTION, WITH THE RESIDUAL NAMED RATHER THAN BOUNDED BY A COUNT.
   *
   * Only one containment is an invariant. A public parameter the checker calls compound and the
   * generator never recorded is a boundary nothing enforces — a defect. The converse is NOT a
   * defect: the artifact records a field tree for every object parameter, compound or not, so
   * "in the artifact, not found by the intersection walk" is the ordinary case, not a divergence.
   * The previous version asserted both directions as if they were symmetric, which forced an
   * allowlist (`ARTIFACT_ONLY_KNOWN`) to excuse two labels that were never evidence of anything.
   * That list is retired here; correctness of the recorded trees is carried by the shape comparison
   * below, which is the claim that actually matters.
   *
   * What remains IS an allowlist, not a floor, and the difference matters: a floor lets a new
   * divergence hide inside the slack, while a named set fails the moment anything else appears.
   */
  it('the checker and the artifact agree on WHICH intersection occurrences exist', () => {
    /**
     * EMPTY — and the thirteen entries it used to hold were never generator gaps.
     *
     * This list was described as "13 public intersection boundaries the walker never records" and
     * filed as task #384. Asking the question by CONTRACT rather than by path spelling dissolves all
     * of them: three (`strategyFromChain` and friends) were skipped by this gate's own `&` text
     * selector because `FromChainOptions` renders without an `&`, and ten were one declaration
     * reachable under two public spellings — `@totalfinance/strategy:strategy.coveredCall` and
     * `@totalfinance/strategy:coveredCall` are the same contract, and it was recorded the whole time.
     *
     * The list stays, empty, because it is the thing that fails if a real gap ever appears.
     */
    const CHECKER_ONLY_KNOWN: string[] = [];
    const unexpectedCheckerOnly = checkerOnly.filter((k) => !CHECKER_ONLY_KNOWN.includes(k));
    expect(
      unexpectedCheckerOnly,
      `the checker finds public intersection parameters the generator never recorded:\n${unexpectedCheckerOnly.join('\n')}`,
    ).toEqual([]);
    // The residual may only shrink; a stale entry means the list stopped describing reality.
    expect(
      CHECKER_ONLY_KNOWN.filter((k) => !checkerOnly.includes(k)),
      'a recorded checker-only occurrence no longer occurs — remove it from CHECKER_ONLY_KNOWN',
    ).toEqual([]);
  });

  /**
   * EXACT SHAPE — and NO SILENT SKIP.
   *
   * The previous version did `if (!recorded || equal) continue`, so an occurrence the artifact never
   * recorded fell out of the comparison without a word. Absence is now a mismatch unless it is in the
   * named residual above, which is the only place an absence is allowed to be explained.
   */
  it('every intersection the checker finds is recorded with the SAME fields', () => {
    const mismatches: string[] = [];
    for (const [key, expectedShape] of fromChecker) {
      const recorded = recordedFor(key);
      if (!recorded || shapeIsEmpty(recorded)) {
        if (!checkerOnly.includes(key))
          mismatches.push(
            `${key}: the generator records ${recorded ? 'an EMPTY contract' : 'no contract'} for a compound parameter`,
          );
        continue;
      }
      if (shapeKey(recorded) === shapeKey(expectedShape)) continue;
      const missing = expectedShape.common.filter((f) => !recorded.common.includes(f));
      const extra = recorded.common.filter((f) => !expectedShape.common.includes(f));
      const detail = [
        missing.length > 0 ? `missing [${missing.join(', ')}]` : '',
        extra.length > 0 ? `carries unknown [${extra.join(', ')}]` : '',
        recorded.branches.length !== expectedShape.branches.length
          ? `records ${recorded.branches.length} branches, the type has ${expectedShape.branches.length}`
          : '',
      ]
        .filter(Boolean)
        .join(' and ');
      mismatches.push(`${key}: ${detail || 'branch contents differ'}`);
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  /**
   * ONE DECLARED CONTRACT, ONE SHAPE — the property the label comparison could not express.
   *
   * `totalfinance:options.barrier.monteCarloPrice` and `@totalfinance/options:barrier.monteCarloPrice` are
   * two PUBLIC occurrences of ONE implementation occurrence. Compared only as labels, the generator
   * could record a full tree under one path and a degraded tree under the other and both sides would
   * still "agree" — each label was only ever compared with itself. Grouping by implementation makes
   * that divergence a failure, and it is the direction the checker walk cannot see, because from a
   * `.d.ts` the two paths simply look like two callables.
   */
  /**
   * ONE CONTRACT, ONE RECORDED SHAPE — the property a label comparison cannot express.
   *
   * `totalfinance:options.barrier.monteCarloPrice` and `@totalfinance/options:barrier.monteCarloPrice` are
   * two PUBLIC occurrences of ONE contract. Compared only as labels, the generator could record a
   * full tree under one path and a degraded tree under the other and both sides would still
   * "agree", because each label was only ever compared with itself. This is the direction the
   * checker cannot see: from a `.d.ts` the two paths are simply two callables.
   *
   * Grouped by IMPLEMENTATION OCCURRENCE ALONE this is false, and measurably so: three declarations
   * (`Facade.explain`, `Indicator.explain`, `Indicator.stream`) are generic, so one slot legitimately
   * carries a different contract per instantiation. That is why the rendered type joins the key — not
   * to select a population, but to tell two instantiations of one generic apart. Every other grouping
   * below is already exact without it.
   */
  const consistency = (
    label: string,
    keyOf: (publicOccurrence: string) => string | null,
    minimumSharedGroups: number,
  ): void => {
    it(`one ${label} records one shape everywhere it appears`, () => {
      const byKey = new Map<string, Map<string, string[]>>();
      for (const [publicOccurrence, shape] of fromArtifact) {
        /**
         * AN EMPTY SHAPE IS A VARIANT, NOT A REASON TO LOOK AWAY.
         *
         * Skipping empties here reintroduced, one gate lower, exactly the conflation that
         * `recordedFor` was fixed to remove: an empty record and an absent record are different
         * facts. With the skip, one public path of a contract could lose its whole tree while its
         * siblings stayed intact and this reported agreement — the cross-path divergence case is the
         * only thing this gate exists to see, and it was the one case it could not.
         */
        const key = keyOf(publicOccurrence);
        if (key === null) continue;
        const variants = byKey.get(key) ?? new Map<string, string[]>();
        const seen = shapeKey(shape);
        variants.set(seen, [...(variants.get(seen) ?? []), publicOccurrence]);
        byKey.set(key, variants);
      }
      const divergent = [...byKey.entries()]
        .filter(([, variants]) => variants.size > 1)
        .map(
          ([key, variants]) =>
            `${key} is described ${variants.size} different ways:\n` +
            [...variants.entries()]
              .map(([shape, paths]) => `    [${shape}] via ${paths.join(', ')}`)
              .join('\n'),
        );
      expect(divergent, divergent.join('\n')).toEqual([]);

      // Bound on the number it guards: the check is only meaningful where a key IS shared by two
      // public occurrences, so a collapse toward per-occurrence keys must fail rather than pass.
      const shared = [...byKey.values()].filter(
        (variants) => [...variants.values()].flat().length > 1,
      ).length;
      expect(
        shared,
        `only ${shared} ${label}s are reached by more than one public path — this gate is losing its subject`,
      ).toBeGreaterThanOrEqual(minimumSharedGroups);
    });
  };

  consistency(
    'declared contract',
    (publicOccurrence) => declaredContract.get(publicOccurrence) ?? null,
    // Seated on the measured value. Counting empty shapes as variants (rather than skipping them)
    // widened the population from 407 shared groups to 450, and a bound left at the old number is
    // slack a regression can hide in — the precise defect this file's own history keeps repeating.
    450,
  );
  consistency(
    'implementation slot',
    (publicOccurrence) => {
      const implementation = publicToImplementation.get(publicOccurrence);
      return implementation
        ? `${implementation}|${renderedType.get(publicOccurrence) ?? ''}`
        : null;
    },
    2120,
  );

  it('every public occurrence resolves to an implementation', () => {
    expect(
      unresolvedImplementations.slice(0, 20),
      `${unresolvedImplementations.length} public occurrences have no resolvable implementation; ` +
        'each one silently merges every path that shares it',
    ).toEqual([]);
  });

  /** Sentinels: the object intersection that regressed, and the optional form that hid from it. */
  it('barrier records all nine keys, including the two declared inline', () => {
    /**
     * RV10 — this sentinel was passing VACUOUSLY. It looked up the unqualified label
     * `barrier.monteCarloPrice#input`, which stopped existing when labels became package-qualified,
     * and `?? []` turned the miss into an empty loop with nothing asserted. A sentinel that cannot
     * find its subject reports success — the same shape as every other dead gate in this phase.
     *
     * Both paths are named explicitly now, and each is asserted to EXIST before its fields are
     * compared, so a future relabelling fails loudly instead of silently checking nothing.
     */
    const NINE = [
      'barrier',
      'barrierType',
      'dividendYield',
      'riskFreeRate',
      'spot',
      'strike',
      'timeToExpiryYears',
      'type',
      'volatility',
    ];
    for (const owner of [
      '@totalfinance/options:barrier.monteCarloPrice',
      'totalfinance:options.barrier.monteCarloPrice',
    ]) {
      const key = publicParameterOccurrence(owner, 0, 0);
      const recorded = fromArtifact.get(key);
      expect(
        recorded,
        `${key} is not in the artifact — the sentinel has lost its subject`,
      ).toBeDefined();
      expect(recorded?.common, key).toEqual(NINE);
    }
  });

  it('an OPTIONAL intersection records a tree too', () => {
    // Only the occurrences the CHECKER calls compound — `arg0` of this callable is a plain series,
    // and matching it too would have asserted "no fields recorded" against a parameter that has none.
    const optional = [...fromChecker.keys()].filter((key) =>
      key.includes(':extremeValueTailRisk|'),
    );
    expect(
      optional.length,
      'the optional-intersection sentinel has lost its subject',
    ).toBeGreaterThan(0);
    for (const key of optional) {
      const shape = recordedFor(key);
      expect(shape, `${key} is not recorded at all`).toBeDefined();
      expect(shapeIsEmpty(shape as Shape), `${key} recorded no fields`).toBe(false);
    }
  });
});
