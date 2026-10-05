import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as profiles from '../packages/workflows/src/local/profiles.js';
import { describeOperation } from '../packages/workflows/src/operation.js';
import {
  publicPackageDirectories,
  PUBLIC_PACKAGE_NAME,
  MCP_PACKAGE_NAME,
} from './public-packages.js';
import {
  buildPublicReference,
  buildReferenceEntries,
  buildReferenceOperations,
  buildTypeDocConfig,
  createReferenceProgram,
  discoverReferenceSources,
  type PublicReference,
  type ReferenceSource,
  publicDocumentationText,
} from './public-reference.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** The release this checkout carries; every pin below must agree with it. */
const RELEASE_VERSION = (
  JSON.parse(readFileSync(resolve(ROOT, 'distribution/totalfinance/package.json'), 'utf8')) as {
    version: string;
  }
).version;
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('dogfooding direct public consumer source compile smoke', () => {
  it('typechecks the exact packed consumer and saves all three direct report types without casts', () => {
    // Read, do not import, the packed suite: its all-package install hooks must not run here.
    const packedPath = resolve(ROOT, 'tools/packed-consumer.test.ts');
    const packedSource = ts.createSourceFile(
      packedPath,
      readFileSync(packedPath, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
    );
    const declarations = packedSource.statements.flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    );
    const declaration = declarations.find(
      (item) => ts.isIdentifier(item.name) && item.name.text === 'DOGFOODING_PUBLIC_CONSUMER_TS',
    );
    const initializer = declaration?.initializer;
    if (initializer === undefined || !ts.isNoSubstitutionTemplateLiteral(initializer)) {
      throw new Error(
        'The packed dogfooding consumer must remain one extractable literal shared with source compile smoke.',
      );
    }
    const config = ts.readConfigFile(resolve(ROOT, 'tsconfig.json'), ts.sys.readFile);
    if (config.error)
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
    expect(parsed.errors).toEqual([]);
    const path = resolve(ROOT, 'tools/dogfooding-public-consumer.fixture.mts');
    const host = ts.createCompilerHost(parsed.options);
    const original = host.getSourceFile;
    host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
      file === path
        ? ts.createSourceFile(file, initializer.text, languageVersion, true)
        : original(file, languageVersion, onError, shouldCreate);
    const program = ts.createProgram([path], parsed.options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    });
    expect(diagnostics, formatted).toEqual([]);
  }, 90000);
});

describe('complete public reference', () => {
  let reference: PublicReference;
  beforeAll(() => {
    reference = buildPublicReference();
  }, 90_000);

  it('covers every package export-map entrypoint, independently of any package allowlist', () => {
    const expected: string[] = [];
    for (const { path } of publicPackageDirectories(ROOT)) {
      const manifest = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        private?: boolean;
        exports?: Record<string, unknown>;
      };
      if (manifest.private || !manifest.exports) continue;
      const pkg = reference.packages.find((candidate) => candidate.name === manifest.name);
      expect(pkg, manifest.name).toBeDefined();
      expect(pkg!.version).toBe(manifest.version);
      for (const [key, value] of Object.entries(manifest.exports)) {
        if (key === './package.json' || value === null) continue;
        const entrypoint = key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`;
        expected.push(entrypoint);
        expect(
          reference.entries.some((entry) => entry.entrypoint === entrypoint),
          entrypoint,
        ).toBe(true);
      }
    }
    expect(reference.packages.flatMap((pkg) => pkg.entrypoints).sort()).toEqual(expected.sort());
    expect(reference.packages.map((pkg) => pkg.name).sort()).toEqual(
      [PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME].sort(),
    );
    expect(JSON.stringify(reference.packages)).not.toContain('@totalfinance/');
    expect(reference.packages.every((pkg) => pkg.version === RELEASE_VERSION)).toBe(true);
    expect(JSON.stringify(reference.entries)).not.toContain('@totalfinance/');
  });

  it('has exactly every checker export, including all type-only and subpath-only names', () => {
    const sources = discoverReferenceSources();
    const program = createReferenceProgram(sources);
    const checker = program.getTypeChecker();
    const expected: string[] = [];
    let types = 0;
    for (const source of sources)
      for (const [entrypoint, path] of Object.entries(source.entrypoints)) {
        const file = program.getSourceFile(resolve(ROOT, path))!;
        const module = checker.getSymbolAtLocation(file)!;
        for (const symbol of checker.getExportsOfModule(module)) {
          expected.push(`${entrypoint}#${symbol.name}`);
          const resolved =
            symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
          if (!(resolved.flags & ts.SymbolFlags.Value)) types++;
        }
      }
    expect(types).toBeGreaterThan(0);
    expect(reference.entries.map((entry) => entry.id).sort()).toEqual(expected.sort());
    expect(new Set(reference.entries.map((entry) => entry.id)).size).toBe(reference.entries.length);
  }, 90_000);

  it('retains meaningful type declarations, inherited fields, and namespace companions', () => {
    const input = reference.entries.find(
      (entry) => entry.id === '@insiderfinance/totalfinance/options#BlackScholesInput',
    )!;
    expect(input.signature).toContain('interface BlackScholesInput');
    expect(input.signature).toContain('timeToExpiryYears: number');
    expect(input.members.find((member) => member.name === 'riskFreeRate')!.description).toMatch(
      /decimal|continuous/i,
    );
    const typed = reference.entries.find(
      (entry) => entry.id === '@insiderfinance/totalfinance/options#BlackScholesTypedInput',
    )!;
    expect(typed.members.some((member) => member.name === 'spot')).toBe(true);
    const namespace = reference.entries.find(
      (entry) => entry.id === '@insiderfinance/totalfinance/options#blackScholes',
    )!;
    expect(namespace.members.some((member) => member.name === 'price.explain')).toBe(true);
    expect(
      namespace.members.some(
        (member) => member.name.includes('price') && member.name.endsWith('.riskFreeRate'),
      ),
    ).toBe(true);
    expect(namespace.examples.join('\n')).toContain('blackScholes.price');
    const position = reference.entries.find(
      (entry) => entry.id === '@insiderfinance/totalfinance/strategy#Position',
    )!;
    expect(position.signature).toContain('class Position {');
    expect(position.signature).toContain('constructor(');
    expect(position.signature).not.toContain('class Position Position');
  });

  it('preserves the MCP protocol metadata key in the live public reference', () => {
    const entry = reference.entries.find(
      (candidate) => candidate.id === `${MCP_PACKAGE_NAME}#toolNameFor`,
    )!;
    expect(entry.description).toContain("_meta['totalfinance/operation'].id");
    expect(entry.description).not.toContain('@insiderfinance/totalfinance/operation');
  });

  it('resolves every inline type import through a real public entrypoint and exported symbol', () => {
    const sources = discoverReferenceSources();
    const program = createReferenceProgram(sources);
    const checker = program.getTypeChecker();
    const modules = new Map(
      sources.flatMap((source) =>
        Object.entries(source.entrypoints).map(
          ([name, path]) =>
            [
              name,
              checker.getSymbolAtLocation(program.getSourceFile(resolve(ROOT, path))!)!,
            ] as const,
        ),
      ),
    );
    const imports = new Set<string>();
    for (const entry of reference.entries)
      for (const text of [entry.signature, ...entry.members.map((member) => member.type)])
        for (const match of text.matchAll(/\bimport\((["'])([^"']+)\1\)((?:\.[\w$]+)*)/g))
          imports.add(JSON.stringify([match[2], match[3]]));
    expect(imports.size).toBeGreaterThan(500);
    for (const imported of imports) {
      const [path, qualifier] = JSON.parse(imported) as [string, string];
      let symbol = modules.get(path);
      expect(symbol, `Nonpublic import: ${imported}`).toBeDefined();
      for (const name of qualifier.split('.').filter(Boolean)) {
        if (symbol!.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol!);
        symbol = checker.getExportsOfModule(symbol!).find((candidate) => candidate.name === name);
        expect(symbol, `Nonpublic qualifier: ${imported}`).toBeDefined();
      }
    }
    expect(imports.has(JSON.stringify([`${PUBLIC_PACKAGE_NAME}/core`, '.Diagnostics']))).toBe(true);
  }, 90_000);

  it('keeps preview transport tiers separate from calculation conformance', () => {
    for (const entrypoint of [
      `${PUBLIC_PACKAGE_NAME}/workflows`,
      `${PUBLIC_PACKAGE_NAME}/http`,
      `${PUBLIC_PACKAGE_NAME}/cli`,
      MCP_PACKAGE_NAME,
    ]) {
      const entries = reference.entries.filter((entry) => entry.entrypoint === entrypoint);
      expect(entries.length).toBeGreaterThan(0);
      expect(
        entries.every((entry) => /preview|experimental|beta|alpha/.test(entry.stability)),
      ).toBe(true);
    }
    expect(
      reference.entries.find((entry) => entry.id === `${PUBLIC_PACKAGE_NAME}/options#blackScholes`)!
        .stability,
    ).toContain('stable-by-law (pre-1.0');
  });

  it('derives every operation, pack, profile and security field from the full registry', () => {
    const full = profiles.packsForProfile('full');
    expect(reference.operations.map((operation) => operation.id).sort()).toEqual(
      full.flatMap((pack) => pack.operations.map((operation) => operation.id)).sort(),
    );
    expect(new Set(reference.operations.map((operation) => operation.pack))).toEqual(
      new Set(full.map((pack) => pack.name)),
    );
    for (const pack of full)
      for (const operation of pack.operations) {
        const actual = reference.operations.find((candidate) => candidate.id === operation.id)!;
        expect(actual).toMatchObject(describeOperation(operation));
        expect(actual.sdkOnly).toBe(false);
        const memberships = profiles.REGISTRY_PROFILES.filter((profile) =>
          profiles
            .packsForProfile(profile)
            .some((pack) => pack.operations.some((candidate) => candidate.id === operation.id)),
        );
        expect(actual.profiles).toEqual([...memberships].sort());
        expect(actual.defaultEnabled).toBe(memberships.includes('default'));
      }
    expect(
      reference.operations.some((operation) => operation.requiredCapabilities.length > 0),
    ).toBe(true);
    expect(reference.operations.some((operation) => !operation.defaultEnabled)).toBe(true);
  });

  it('picks up a newly registered full-profile pack without editing the generator', () => {
    const original = profiles.packsForProfile;
    const operation = { ...original('full')[0]!.operations[0]!, id: 'totalfinance.fixture.future' };
    const spy = vi
      .spyOn(profiles, 'packsForProfile')
      .mockImplementation((profile) => [
        ...original(profile),
        ...(profile === 'full' ? [{ name: 'future_pack', operations: [operation] }] : []),
      ]);
    try {
      expect(buildReferenceOperations().find((entry) => entry.id === operation.id)).toMatchObject({
        pack: 'future_pack',
        profiles: ['full'],
        defaultEnabled: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps pnpm run docs configured for all discovered sources, not seven hardcoded files', () => {
    const config = buildTypeDocConfig();
    expect(JSON.parse(readFileSync(resolve(ROOT, 'typedoc.json'), 'utf8'))).toEqual(config);
    const expected = [
      ...new Set(discoverReferenceSources().flatMap((source) => Object.values(source.entrypoints))),
    ].sort();
    expect(config['entryPoints']).toEqual(expected);
    expect(config['disableSources']).toBe(true);
    expect(config['entryPoints']).toHaveLength(
      reference.packages.flatMap((pkg) => pkg.entrypoints).length,
    );
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts: { docs: string };
    };
    expect(manifest.scripts.docs).toBe('typedoc --options typedoc.json');
  });

  it('is deterministic across fresh checker programs and contains no machine-specific absolute paths', () => {
    const serialized = JSON.stringify(reference);
    expect(serialized).not.toContain(ROOT);
    expect(serialized).not.toContain(homedir());
    expect(serialized).not.toMatch(/import\(["'](?:\/|[A-Z]:\\)/);
    expect(hash(buildPublicReference())).toBe(hash(reference));
  }, 90_000);
});

/** Compiler-host fixtures: no package files or sibling-agent sources are created/modified. */
function fixtureProject(text: string, dependencies: Record<string, string> = {}) {
  const directory = resolve(ROOT, 'packages/reference-fixture/src');
  const path = resolve(directory, 'index.ts');
  const files = new Map(
    Object.entries({ 'index.ts': text, ...dependencies }).map(([file, content]) => [
      resolve(directory, file),
      content,
    ]),
  );
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    baseUrl: ROOT,
    paths: { '@fixture/new-package/future': [path] },
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
    files.has(file)
      ? ts.createSourceFile(file, files.get(file)!, languageVersion, true)
      : original(file, languageVersion, onError, shouldCreate);
  const originalExists = host.fileExists;
  const originalDirectoryExists = host.directoryExists!;
  host.fileExists = (file) => files.has(file) || originalExists(file);
  host.directoryExists = (dir) =>
    [...files.keys()].some((file) => dirname(file) === dir) || originalDirectoryExists(dir);
  const program = ts.createProgram([path], options, host);
  const source: ReferenceSource = {
    package: {
      name: '@fixture/new-package',
      slug: 'reference-fixture',
      version: '0.2.0',
      description: '',
      stability: 'preview',
      entrypoints: ['@fixture/new-package/future'],
    },
    entrypoints: { '@fixture/new-package/future': 'packages/reference-fixture/src/index.ts' },
  };
  return { program, source, files };
}

function fixture(text: string, dependencies: Record<string, string> = {}) {
  const { program, source } = fixtureProject(text, dependencies);
  return buildReferenceEntries(program, [source]);
}

describe('declaration and JSDoc regression fixtures', () => {
  it('maps type aliases by symbol identity, including collisions and namespace-only exports', () => {
    const entries = fixture(
      `
      export type { Original as PublicAlias } from './internal.js';
      export type { Original as OtherAlias } from './other.js';
      export * as nested from './nested.js';
      export type Via = import('./internal.js').Original<string>;
      export type OtherVia = import('./other.js').Original;
      export type NestedVia = import('./nested.js').OnlyNested;
    `,
      {
        'internal.ts': 'export interface Original<T> { value: T; }',
        'other.ts': 'export interface Original { unrelated: boolean; }',
        'nested.ts': 'export interface OnlyNested { nested: number; }',
      },
    );
    expect(entries.find((entry) => entry.name === 'Via')!.signature).toContain(
      "import('@fixture/new-package/future').PublicAlias<string>",
    );
    expect(entries.find((entry) => entry.name === 'OtherVia')!.signature).toContain(
      "import('@fixture/new-package/future').OtherAlias",
    );
    expect(entries.find((entry) => entry.name === 'NestedVia')!.signature).toContain(
      "import('@fixture/new-package/future').nested.OnlyNested",
    );
    expect(JSON.stringify(entries)).not.toMatch(/import\(["'](?:\.\/|.*packages\/)/);
  });

  it('inlines unexported generic shapes without inventing a public import or losing literal arguments', () => {
    const dependencies = {
      'internal.ts': `
        import type { Public } from './public.js';
        interface Base<T> { base: T; }
        interface Detail { literal: 'declared'; count: 12; }
        export interface Hidden<T, U = T> extends Base<T> {
          readonly value?: T; defaulted: U; detail: Detail; public: Public;
          imported?: import('./public.js').Public;
        }
      `,
      'public.ts': 'export interface Public { published: boolean; }',
    };
    const entries = fixture(
      `
      export type { Public } from './public.js';
      export type Via = import('./internal.js').Hidden<'argument'>;
    `,
      dependencies,
    );
    const signature = entries.find((entry) => entry.name === 'Via')!.signature;
    expect(signature).toMatch(/readonly value\?: ['"]argument['"]/);
    expect(signature).toMatch(/base: ['"]argument['"]/);
    expect(signature).toMatch(/defaulted: ['"]argument['"]/);
    expect(signature).toMatch(/literal: ['"]declared['"]/);
    expect(signature).toContain('count: 12');
    expect(signature).toContain("import('@fixture/new-package/future').Public");
    expect(signature).not.toMatch(/Hidden|Detail|Base|packages\//);
    const { program } = fixtureProject(
      `
      export type { Public } from './public.js';
      ${signature}
      const value: Via = { base: 'argument', defaulted: 'argument', detail: { literal: 'declared', count: 12 }, public: { published: true } };
    `,
      dependencies,
    );
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    ).toEqual([]);
  });

  it('handles nested private generic arguments and refuses unrenderable private recursion', () => {
    const dependencies = { 'internal.ts': 'export interface Hidden<T> { value: T; }' };
    const entries = fixture(
      `export type Via = import('./internal.js').Hidden<import('./internal.js').Hidden<42>>;`,
      dependencies,
    );
    const signature = entries[0]!.signature;
    expect(signature).toContain('value: 42');
    const { program } = fixtureProject(
      `${signature}\nconst value: Via = { value: { value: 42 } };`,
      dependencies,
    );
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    ).toEqual([]);
    expect(() =>
      fixture(`export type Via = import('./internal.js').Hidden;`, {
        'internal.ts': 'export interface Hidden { next?: Hidden; }',
      }),
    ).toThrow('Non-public recursive documentation type: Hidden');
    expect(() =>
      fixture(`export type Via = import('./internal.js').Missing;`, dependencies),
    ).toThrow('Unexported documentation import');
  });

  it('recovers scoped package prose parsed by TypeScript as a JSDoc tag', () => {
    const entries = fixture(
      '/** Calculation is delegated to @totalfinance/risk, never duplicated. */ export const example = 1;',
    );
    expect(entries[0]!.description).toContain(
      '@insiderfinance/totalfinance/risk, never duplicated.',
    );
    expect(JSON.stringify(entries)).not.toContain('@totalfinance');
  });
  it('maps documentation imports but preserves transport protocol keys', () => {
    expect(
      publicDocumentationText(
        "import { x } from 'totalfinance/math'; import { y } from '@totalfinance/options/black-scholes';",
      ),
    ).toBe(
      "import { x } from '@insiderfinance/totalfinance/math'; import { y } from '@insiderfinance/totalfinance/options/black-scholes';",
    );
    const protocol =
      "`totalfinance/operation` _meta['totalfinance/execution'] totalfinance://capabilities";
    expect(publicDocumentationText(protocol)).toBe(protocol);
  });
  it('does not treat _meta operation keys as module imports alongside a legacy domain import', () => {
    const source = [
      "import { blackScholes } from 'totalfinance/options';",
      "const operation = _meta['totalfinance/operation'].id;",
    ].join('\n');
    const expected = source.replace(
      "from 'totalfinance/options'",
      "from '@insiderfinance/totalfinance/options'",
    );
    expect(publicDocumentationText(source)).toBe(expected);
    expect(publicDocumentationText(expected)).toBe(expected);
  });

  it('preserves the totalfinance executable and literal data while mapping explicit package contexts', () => {
    const command = [
      'behind the `totalfinance` command line',
      'Run `totalfinance list` or `pnpm exec totalfinance list`.',
      'The `totalfinance` field is the canonical indicator name.',
      "const executable = 'totalfinance'; const vendor = 'totalfinance';",
      "type Alias = { totalfinance: string }; type Field = 'totalfinance';",
      "_meta['totalfinance/operation'].id; totalfinance://capabilities",
    ].join('\n');
    expect(publicDocumentationText(command)).toBe(command);
    const source = [
      command,
      "import { math } from 'totalfinance';",
      "export { math } from 'totalfinance';",
      "const root = import( 'totalfinance' );",
      "import 'totalfinance';",
      "import { blackScholes } from 'totalfinance/options';",
      'npm install totalfinance@0.1.0',
      'pnpm add totalfinance',
      'yarn add totalfinance',
      'bun add totalfinance',
      'The `totalfinance` package; the package `totalfinance`.',
    ].join('\n');
    const expected = source
      .replaceAll("from 'totalfinance", "from '@insiderfinance/totalfinance")
      .replace("import( 'totalfinance'", "import( '@insiderfinance/totalfinance'")
      .replace("import 'totalfinance'", "import '@insiderfinance/totalfinance'")
      .replace('install totalfinance', 'install @insiderfinance/totalfinance')
      .replaceAll('add totalfinance', 'add @insiderfinance/totalfinance')
      .replace('`totalfinance` package', '`@insiderfinance/totalfinance` package')
      .replace('package `totalfinance`', 'package `@insiderfinance/totalfinance`');
    expect(publicDocumentationText(source)).toBe(expected);
    expect(publicDocumentationText(expected)).toBe(expected);
  });
  it('includes alias RHS, type-only reexports, mapped/union types and overloads', () => {
    const entries = fixture(`
      export type Choice = 'call' | 'put';
      export type Grid<T> = { readonly [K in keyof T]?: T[K] };
      interface Input { amount: number; }
      export type { Input as RenamedInput };
      export function transform(input: number): number;
      export function transform(input: string): string;
      export function transform(input: number | string) { return input; }
    `);
    expect(entries.map((entry) => entry.name)).toEqual([
      'Choice',
      'Grid',
      'RenamedInput',
      'transform',
    ]);
    expect(entries.find((entry) => entry.name === 'Choice')!.signature).toMatch(
      /type Choice = ['"]call['"] \| ['"]put['"]/,
    );
    expect(entries.find((entry) => entry.name === 'Grid')!.signature).toContain('[K in keyof T]');
    expect(entries.find((entry) => entry.name === 'RenamedInput')!.signature).toContain(
      'interface RenamedInput',
    );
    expect(entries.find((entry) => entry.name === 'RenamedInput')!.signature).toContain(
      'amount: number',
    );
    const overload = entries.find((entry) => entry.name === 'transform')!;
    expect(overload.signature).toContain('(input: number): number');
    expect(overload.signature).toContain('(input: string): string');
    expect(overload.signature).not.toContain('return input');
  });

  it('preserves units/defaults/examples/warnings, never infers an economic default from code', () => {
    const entries = fixture(`
      /** Caller-controlled input. @example { periods: 12, rate: 0.05 } */
      export interface Request {
        /** Number of periods.\n * @default 12\n * @unit months */
        periods?: number;
        /** Annual decimal rate.\n * @warning Supply your own assumption. */
        rate?: number;
      }
      export type { Request as Alias };
      /** @experimental */
      export function calculate({ periods = 12, rate = 0.05 }: Request) { return { periods, rate }; }
    `);
    const request = entries.find((entry) => entry.name === 'Request')!;
    expect(request.members.find((member) => member.name === 'periods')).toMatchObject({
      optional: true,
      defaultValue: '12',
    });
    expect(request.members.find((member) => member.name === 'periods')!.description).toContain(
      '@unit months',
    );
    expect(request.members.find((member) => member.name === 'rate')).toMatchObject({
      optional: true,
      defaultValue: null,
    });
    expect(request.members.find((member) => member.name === 'rate')!.description).toContain(
      '@warning',
    );
    expect(request.examples).toHaveLength(1);
    const alias = entries.find((entry) => entry.name === 'Alias')!;
    expect(alias.members).toEqual(request.members);
    expect(alias.examples).toEqual(request.examples);
    expect(alias.description).toEqual(request.description);
    expect(alias.signature).toContain('interface Alias');
    expect(entries.find((entry) => entry.name === 'calculate')!.stability).toBe('experimental');
  });

  it('retains nested callable namespace data and public generic class shape without private bodies', () => {
    const entries = fixture(`
      export namespace family { export namespace nested {
        /** A documented transform. */ export function run(input: { years: number }): number { return input.years; }
      } }
      export class Box<T> {
        private secret = 1;
        static readonly label = 'box';
        constructor(public value: T) {}
        get(): T { return this.value; }
        static create<T>(value: T): Box<T> { return new Box(value); }
      }
    `);
    const nested = entries.find((entry) => entry.name === 'family')!;
    expect(nested.members.find((member) => member.name === 'nested.run')!.description).toContain(
      'documented transform',
    );
    expect(nested.members.some((member) => member.name === 'nested.run(input).years')).toBe(true);
    const box = entries.find((entry) => entry.name === 'Box')!;
    expect(box.signature).toContain('class Box<T>');
    expect(box.signature).toContain('value: T');
    expect(box.signature).toContain('static create<T>');
    expect(box.signature).toContain('static readonly label');
    expect(box.signature).not.toMatch(/secret|return this/);
  });

  it('does not hide overload/union member shapes or invent a shared branch default', () => {
    const entries = fixture(`
      export type Input = {
        /** @default 12 */
        amount?: number;
      } | {
        /** @default 'all' */
        amount?: string;
      };
    `);
    const amount = entries[0]!.members.find((member) => member.name === 'amount')!;
    expect(amount.type).toContain('number');
    expect(amount.type).toContain('string');
    expect(amount.description).toContain('@default 12');
    expect(amount.description).toContain("@default 'all'");
    expect(amount.defaultValue).toBeNull();
  });

  it('renames aliases structurally, without changing source prose or mishandling dollar names', () => {
    const entries = fixture(`
      /** The interface Original explains annual units. */
      interface Original { amount: number; }
      export type { Original as Renamed };
      type $Input = { years: number };
      export type { $Input as DollarAlias };
    `);
    const renamed = entries.find((entry) => entry.name === 'Renamed')!;
    expect(renamed.signature).toContain('interface Renamed {');
    expect(renamed.description).toContain('interface Original');
    expect(entries.find((entry) => entry.name === 'DollarAlias')!.signature).toContain(
      'type DollarAlias =',
    );
  });

  it('expands private nested request shapes and does not cap large member lists', () => {
    const entries = fixture(`
      interface Detail {
        /** Duration in years. */
        years: number;
      }
      interface PrivateRequest { nested: Detail; }
      export function run(input: PrivateRequest): number { return input.nested.years; }
      export interface Wide { ${Array.from({ length: 400 }, (_, index) => `field${index}: number;`).join('\n')} }
    `);
    const run = entries.find((entry) => entry.name === 'run')!;
    expect(
      run.members.find((member) => member.name === '(input).nested.years')!.description,
    ).toContain('years');
    const wide = entries.find((entry) => entry.name === 'Wide')!;
    expect(wide.members).toHaveLength(400);
    expect(wide.signature).toContain('field399: number');
  });
});
