/**
 * Phase 3B.0 — can a consumer NAME the types they are required to construct?
 *
 * The contract inventory records what every public parameter's type is. It never asked whether that
 * type is reachable from outside the library, and the answer is not always yes:
 *
 *     export function compareEngines(input: CompareEnginesInput): EngineComparison
 *
 * `compareEngines` is exported from `@totalfinance/options`. `CompareEnginesInput` is not — the index
 * re-exports nine sibling types from the same module and omits that one. A TypeScript consumer can
 * call the function and cannot write down the type of the thing they must pass it. They can build the
 * object literal inline, but they cannot store it in a typed variable, accept it in their own
 * signature, or narrow it. Two of these types (`BaseSpecification`, `Rule`) are not even declared with
 * `export` in their own module, so no re-export could reach them.
 *
 * This is the same failure mode as an error message naming a field that does not exist: the library
 * describes something the caller cannot address. It is worth separating into two classes, because the
 * fixes differ and conflating them overstates the defect:
 *
 *   unreachable    exported by NO package. The consumer cannot name it at all.
 *   foreign        exported by some OTHER package. Nameable, but not from the package whose function
 *                  demands it — `@totalfinance/options` takes an `OptionQuote` that only `@totalfinance/core`
 *                  exports, so the import is possible but undiscoverable from the call site.
 *
 * Detection lives here; the repair is 3B.2, which migrates packages in dependency order and re-packs a
 * tarball per commit. Recording it as data is 3B.0's job — the inventory finds, the migration fixes.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = resolve(ROOT, 'packages');

/** Structural type constructors, which are language vocabulary rather than library contracts. */
const BUILT_IN = new Set([
  'Record',
  'Partial',
  'Pick',
  'Omit',
  'Readonly',
  'Required',
  'Array',
  'ReadonlyArray',
  'Map',
  'Set',
  'Promise',
  'Date',
  'Iterable',
  'Iterator',
]);

export interface NameabilityFinding {
  /** `<package>:<TypeName>` — the contract identity as the parameter declares it. */
  contract: string;
  /** The package whose function demands this type. */
  package: string;
  type: string;
  /** `unreachable` — no package exports it. `foreign` — another package does. */
  kind: 'unreachable' | 'foreign';
  /** For `foreign`: the package that does export it. */
  exportedBy?: string;
  /** Public paths that require it, sorted. */
  usedBy: string[];
}

/** Every type name each package publicly exports, from every declared entrypoint. */
function exportsByPackage(): Map<string, Set<string>> {
  const entries: [string, string][] = [];
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
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      if (key === './package.json') continue;
      const target =
        typeof value === 'string'
          ? value
          : ((value as Record<string, string>)['types'] ??
            (value as Record<string, string>)['import'] ??
            (value as Record<string, string>)['default']);
      if (!target) continue;
      const path = resolve(PACKAGES, dir, target.replace(/^\.\//, '').replace(/\.js$/, '.d.ts'));
      if (existsSync(path)) entries.push([packageName, path]);
    }
  }

  const program = ts.createProgram(
    entries.map(([, path]) => path),
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      strict: true,
    },
  );
  const checker = program.getTypeChecker();
  const out = new Map<string, Set<string>>();
  for (const [packageName, path] of entries) {
    const source = program.getSourceFile(path);
    const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
    if (!moduleSymbol) continue;
    if (!out.has(packageName)) out.set(packageName, new Set());
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      out.get(packageName)!.add(exported.name);
    }
  }
  return out;
}

export interface NameabilityInput {
  id: string;
  package: string;
  signatures: {
    parameters: { kind: string; contract?: string | null; inferredGeneric?: true }[];
  }[];
}

/** Object-parameter contracts a consumer cannot name from the package that demands them. */
export function nameabilityFindings(contracts: readonly NameabilityInput[]): NameabilityFinding[] {
  const byPackage = exportsByPackage();
  const everywhere = new Map<string, string>();
  for (const [packageName, names] of byPackage) {
    for (const name of names) if (!everywhere.has(name)) everywhere.set(name, packageName);
  }

  const found = new Map<string, NameabilityFinding>();
  for (const contract of contracts) {
    for (const signature of contract.signatures) {
      for (const parameter of signature.parameters) {
        if (parameter.kind !== 'object' || !parameter.contract || parameter.inferredGeneric)
          continue;
        const match = /^(.+?):([A-Za-z_$][\w$]*)$/.exec(parameter.contract);
        if (!match) continue;
        const [, owner, type] = match;
        if (BUILT_IN.has(type!)) continue;
        if (byPackage.get(owner!)?.has(type!)) continue;
        const elsewhere = everywhere.get(type!);
        const key = `${owner}:${type}`;
        if (!found.has(key)) {
          found.set(key, {
            contract: key,
            package: owner!,
            type: type!,
            kind: elsewhere ? 'foreign' : 'unreachable',
            ...(elsewhere ? { exportedBy: elsewhere } : {}),
            usedBy: [],
          });
        }
        const finding = found.get(key)!;
        if (!finding.usedBy.includes(contract.id)) finding.usedBy.push(contract.id);
      }
    }
  }

  for (const finding of found.values()) finding.usedBy.sort();
  return [...found.values()].sort((a, b) =>
    a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : 0,
  );
}
