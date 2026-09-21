/** Check and execute the exact playground copy buttons in an isolated installed-package tree. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { playgrounds } from '../site/src/playgrounds/index.js';
import { firstCallCode } from '../site/src/examples.js';

export interface SiteExampleCase {
  id: string;
  /** Exact copied TypeScript, including its original console.log(result). */
  code: string;
  expected: unknown;
}

export interface SiteExamplesSmokeResult {
  version: string;
  cases: number;
  /** SHA-256 of canonical JSON of ordered { id, code, expected } cases; no transpiled code. */
  sha256: string;
  caseIds: string[];
  /** Only installed packages imported by the copied examples; no workspace version assumptions. */
  packages: Record<string, string>;
  typecheck: {
    typescriptVersion: string;
    modes: ['nodenext', 'bundler'];
    strict: true;
    skipLibCheck: false;
  };
}

export function siteExampleCases(): SiteExampleCase[] {
  const cases = playgrounds.flatMap((playground) => {
    const defaults = Object.fromEntries(
      playground.controls.map((control) => [control.name, control.value]),
    );
    const control = playground.controls[0];
    if (!control || !(control.step > 0) || control.value + control.step > control.max) {
      throw new Error(`${playground.id}: a valid edited-input example must be declared.`);
    }
    const changed = { ...defaults, [control.name]: control.value + control.step };
    return [defaults, changed].flatMap((input, index) => {
      const calculation = playground.run(input);
      const id = `${playground.id}-${index ? 'edited' : 'default'}`;
      return [
        { id, code: calculation.code, expected: calculation.result },
        {
          id: `${id}-first-call`,
          code: firstCallCode(calculation),
          expected: calculation.example.result,
        },
      ];
    });
  });
  if (!cases.length || new Set(cases.map((sample) => sample.id)).size !== cases.length) {
    throw new Error('Site examples must have a nonempty, unique case inventory.');
  }
  return cases;
}

/** Shared with release attestation readers; preserves the existing example digest convention. */
export function siteExamplesSha256(
  samples: readonly SiteExampleCase[] = siteExampleCases(),
): string {
  return createHash('sha256').update(canonicalJsonOf(samples)).digest('hex');
}

function within(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return (
    rel === '' ||
    (!isAbsolute(rel) &&
      rel !== '..' &&
      !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

/** AST inspection also sees side-effect, re-export, dynamic-literal and type-only imports. */
function importsOf(sample: SiteExampleCase): string[] {
  const source = ts.createSourceFile(`${sample.id}.mts`, sample.code, ts.ScriptTarget.ES2022, true);
  const imports = new Set<string>();
  function add(node: ts.Node | undefined): void {
    if (!node || !ts.isStringLiteralLike(node))
      throw new Error(`${sample.id}: imports must use literal installed package specifiers.`);
    imports.add(node.text);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      add(node.arguments[0]);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!imports.size) throw new Error(`${sample.id}: no installed package import was found.`);
  return [...imports].sort();
}

const RUNNER = `
import { pathToFileURL } from 'node:url';
// Capture the original copy button's console.log without modifying its source or calculation.
const logs = [];
const log = console.log;
console.log = (...args) => logs.push(args);
try { await import(pathToFileURL(process.argv[2]).href); } finally { console.log = log; }
if (logs.length !== 1 || logs[0].length !== 1) throw new Error('Expected exactly one displayed result.');
console.log(JSON.stringify(logs[0][0]));
`;

/**
 * No paths aliases, workspace tsconfig, transpile-only fallback, or source bundling. Every copied
 * .mts is byte-identical to the UI source, checked under both consumer resolution modes, then
 * emitted by the successful NodeNext program and executed in its own Node process.
 */
export function runSiteExamplesAgainstInstalled(
  consumer: string,
  version: string,
): SiteExamplesSmokeResult {
  consumer = realpathSync(consumer);
  const samples = siteExampleCases();
  const installed = realpathSync(join(consumer, 'node_modules'));
  if (!within(realpathSync(consumer), installed))
    throw new Error('Consumer node_modules must not point outside the installed consumer tree.');
  const directory = mkdtempSync(join(consumer, 'site-example-smoke-'));
  const packages: Record<string, string> = {};
  const files = samples.map((sample) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sample.id)) throw new Error(`Unsafe example id: ${sample.id}`);
    for (const entrypoint of importsOf(sample)) {
      if (!/^(?:@totalfinance\/[a-z0-9-]+|totalfinance)(?:\/[a-z0-9/-]+)?$/.test(entrypoint)) {
        throw new Error(
          `${sample.id}: ${entrypoint} is not an installed TotalFinance package entrypoint.`,
        );
      }
      const name = entrypoint.startsWith('@')
        ? entrypoint.split('/').slice(0, 2).join('/')
        : 'totalfinance';
      const path = realpathSync(join(installed, name));
      if (!within(installed, path))
        throw new Error(`${sample.id}: ${name} resolves outside the installed consumer tree.`);
      const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      };
      if (manifest.name !== name || manifest.version !== version) {
        throw new Error(`${sample.id}: ${name} is ${manifest.version}, expected ${version}.`);
      }
      packages[name] = manifest.version;
    }
    const path = join(directory, `${sample.id}.mts`);
    writeFileSync(path, sample.code);
    return path;
  });
  let emitted: ts.Program | undefined;
  for (const mode of ['nodenext', 'bundler'] as const) {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: mode === 'nodenext' ? ts.ModuleKind.NodeNext : ts.ModuleKind.ESNext,
      moduleResolution:
        mode === 'nodenext' ? ts.ModuleResolutionKind.NodeNext : ts.ModuleResolutionKind.Bundler,
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: false,
      types: [],
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      rootDir: directory,
      outDir: join(directory, 'compiled'),
      noEmitOnError: true,
      noEmit: mode === 'bundler',
    };
    const program = ts.createProgram(files, options);
    const compilerLib = realpathSync(dirname(ts.getDefaultLibFilePath(options)));
    for (const file of program.getSourceFiles()) {
      const path = realpathSync(file.fileName);
      if (!within(directory, path) && !within(installed, path) && !within(compilerLib, path)) {
        throw new Error(
          `Site example ${mode} resolution escaped the installed consumer: ${file.fileName}`,
        );
      }
    }
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) {
      throw new Error(
        `Copied site examples fail strict ${mode} typecheck:\n` +
          ts.formatDiagnostics(diagnostics, {
            getCanonicalFileName: (path) => relative(directory, path),
            getCurrentDirectory: () => directory,
            getNewLine: () => '\n',
          }),
      );
    }
    if (mode === 'nodenext') emitted = program;
  }
  if (!emitted || emitted.emit().emitSkipped)
    throw new Error('Checked site examples were not emitted.');
  const runner = join(directory, 'runner.mjs');
  writeFileSync(runner, RUNNER);
  for (const sample of samples) {
    const path = resolve(directory, 'compiled', `${sample.id}.mjs`);
    const output = execFileSync(process.execPath, [runner, path], {
      cwd: consumer,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    const observed: unknown = JSON.parse(output);
    const expected: unknown = JSON.parse(JSON.stringify(sample.expected));
    if (canonicalJsonOf(observed) !== canonicalJsonOf(expected)) {
      throw new Error(
        `${sample.id}: copied example differs from the displayed result at installed version ${version}.`,
      );
    }
  }
  return {
    version,
    cases: samples.length,
    sha256: siteExamplesSha256(samples),
    caseIds: samples.map((sample) => sample.id),
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
    typecheck: {
      typescriptVersion: ts.version,
      modes: ['nodenext', 'bundler'],
      strict: true,
      skipLibCheck: false,
    },
  };
}
