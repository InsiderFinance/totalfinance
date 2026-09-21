/**
 * Build-time public reference. Export maps own discovery; the TypeScript checker and source
 * JSDoc own declarations. No runtime imports of arbitrary package entrypoints, API-report
 * scraping, clock, network, or financial-default inference.
 *
 * Regenerate TypeDoc's entrypoint config with `pnpm tsx tools/public-reference.ts --typedoc`.
 * `pnpm run docs` continues to consume typedoc.json; the test gates config drift.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  describeOperation,
  type OperationDescription,
} from '../packages/workflows/src/operation.js';
import { packsForProfile, REGISTRY_PROFILES } from '../packages/workflows/src/local/profiles.js';

export interface ReferencePackage {
  name: string;
  slug: string;
  version: string;
  description: string;
  stability: string;
  /** Public import specifiers, not exports-map keys. */
  entrypoints: string[];
}

export interface ReferenceEntry {
  /** Stable identity: `${entrypoint}#${name}` (also for type-only exports). */
  id: string;
  package: string;
  entrypoint: string;
  name: string;
  kind: string;
  signature: string;
  description: string;
  examples: string[];
  tags: { name: string; text: string }[];
  /**
   * No count cap: dotted paths include nested namespaces/companions and immediate callable
   * parameters/returned-artifact members. Named exported contracts refer to their own catalog
   * declarations instead of infinitely copying object graphs. Non-exported data shapes expand
   * recursively; recursive cycles terminate at their declared type reference.
   */
  members: {
    name: string;
    type: string;
    description: string;
    optional: boolean;
    /** Only an explicit JSDoc @default / @defaultValue; null means not declared. */
    defaultValue: string | null;
  }[];
  stability: string;
}

/** Complete operation metadata, never a default-only MCP tool list. */
export interface ReferenceOperation extends OperationDescription {
  pack: string;
  profiles: string[];
  defaultEnabled: boolean;
  /** These are registered wire operations, not the unregistered SDK surface. */
  sdkOnly: false;
}

export interface PublicReference {
  packages: ReferencePackage[];
  entries: ReferenceEntry[];
  operations: ReferenceOperation[];
}

export interface ReferenceSource {
  package: ReferencePackage;
  /** Public specifier -> repository-relative TypeScript source path. */
  entrypoints: Record<string, string>;
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const posix = (path: string): string => path.replaceAll('\\', '/');
const TYPE_FLAGS =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

function configAt(path: string): ts.ParsedCommandLine {
  const config = ts.readConfigFile(path, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(path));
  if (parsed.errors.length)
    throw new Error(
      ts.formatDiagnostics(parsed.errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => '\n',
      }),
    );
  return parsed;
}

/** Prefer the declaration condition, including nested conditional exports. */
function exportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if ('types' in record) return exportTarget(record['types']);
  for (const nested of Object.values(record)) {
    const found = exportTarget(nested);
    if (found) return found;
  }
  return null;
}

function packageStability(directory: string, version: string): string {
  const path = resolve(directory, 'STABILITY.md');
  const policy = existsSync(path) ? readFileSync(path, 'utf8') : '';
  // The shared policy explicitly describes all packages as pre-1.0 preview. Do not turn
  // "stable-by-law" (contract conformance) into a fabricated stable release or publication.
  if (/pre-1\.0 preview/i.test(policy)) return 'pre-1.0 preview';
  return version.startsWith('0.') ? 'pre-1.0; stability not declared' : 'not declared';
}

/** Discover all publishable workspace packages, including the umbrella and future packages. */
export function discoverReferenceSources(root = ROOT): ReferenceSource[] {
  const sources: ReferenceSource[] = [];
  for (const dir of readdirSync(resolve(root, 'packages'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const directory = resolve(root, 'packages', dir.name);
    const manifestPath = resolve(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      version: string;
      description?: string;
      private?: boolean;
      exports?: unknown;
    };
    if (manifest.private || manifest.exports === undefined) continue;
    if (!manifest.name || !manifest.version)
      throw new Error(`Invalid package metadata: packages/${dir.name}`);
    const config = configAt(resolve(directory, 'tsconfig.build.json'));
    const { rootDir, outDir } = config.options;
    if (!rootDir || !outDir) throw new Error(`Missing rootDir/outDir: ${manifest.name}`);
    const map = manifest.exports;
    const exportsMap: Record<string, unknown> =
      map && typeof map === 'object' && Object.keys(map).some((key) => key.startsWith('.'))
        ? (map as Record<string, unknown>)
        : { '.': map };
    const entrypoints: Record<string, string> = {};
    for (const [key, value] of Object.entries(exportsMap).sort(([a], [b]) => compare(a, b))) {
      if (key === './package.json' || value === null) continue;
      const target = exportTarget(value);
      if (!target) throw new Error(`No TypeScript export target: ${manifest.name} ${key}`);
      if (key.includes('*') || target.includes('*')) {
        // Fail closed: a new pattern must never silently vanish from a generated catalog.
        throw new Error(`Expand wildcard export before documenting: ${manifest.name} ${key}`);
      }
      const output = resolve(directory, target);
      const source = /\.d\.[cm]?ts$|\.[cm]?js$/.test(output)
        ? resolve(rootDir, relative(outDir, output)).replace(/(?:\.d)?\.([cm]?)(?:ts|js)$/, '.$1ts')
        : output;
      const rel = posix(relative(root, source));
      if (rel.startsWith('../') || !existsSync(source)) {
        throw new Error(`Missing source for ${manifest.name} ${key}: ${rel}`);
      }
      const specifier = key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`;
      entrypoints[specifier] = rel;
    }
    sources.push({
      package: {
        name: manifest.name,
        slug: dir.name,
        version: manifest.version,
        description: manifest.description ?? '',
        stability: packageStability(directory, manifest.version),
        entrypoints: Object.keys(entrypoints).sort(compare),
      },
      entrypoints,
    });
  }
  return sources.sort((a, b) => compare(a.package.name, b.package.name));
}

/** Shared by the reference and its independent checker-coverage tests. */
export function createReferenceProgram(
  sources = discoverReferenceSources(),
  root = ROOT,
): ts.Program {
  const paths = Object.fromEntries(
    sources.flatMap((source) =>
      Object.entries(source.entrypoints).map(([name, path]) => [name, [resolve(root, path)]]),
    ),
  );
  const config = configAt(resolve(root, 'tsconfig.json'));
  return ts.createProgram({
    rootNames: Object.values(paths).flat(),
    options: {
      ...config.options,
      baseUrl: root,
      paths: { ...config.options.paths, ...paths },
      noEmit: true,
    },
  });
}

function resolvedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function jsdoc(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): { description: string; tags: ReferenceEntry['tags'] } {
  return {
    description: ts.displayPartsToString(symbol.getDocumentationComment(checker)),
    tags: symbol
      .getJsDocTags(checker)
      .map((tag) => ({ name: tag.name, text: ts.displayPartsToString(tag.text) })),
  };
}

function publicProperty(symbol: ts.Symbol): boolean {
  return !symbol.declarations?.some(
    (decl) =>
      (ts.getCombinedModifierFlags(decl) &
        (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
        0 ||
      ('name' in decl && decl.name && ts.isPrivateIdentifier(decl.name as ts.Node)),
  );
}

/** Strip machine-specific checker import paths, preserving a useful module identity. */
function portable(text: string, sources: ReferenceSource[], root: string): string {
  return text
    .replace(/import\(["']([^"']+)["']\)/g, (whole: string, path: string) => {
      if (!isAbsolute(path)) return whole;
      const rel = posix(relative(root, path));
      const entry = sources
        .flatMap((source) => Object.entries(source.entrypoints))
        .find(
          ([, file]) =>
            file.replace(/\.(?:d\.)?[cm]?ts$/, '') === rel.replace(/\.(?:d\.)?[cm]?ts$/, ''),
        );
      if (entry) return `import('${entry[0]}')`;
      const dependency = rel.split('/node_modules/').pop();
      return `import('${rel.includes('/node_modules/') ? dependency : rel}')`;
    })
    .replace(/(__@\w+)@\d+/g, '$1')
    .replace(/[\t ]+$/gm, '');
}

function entryForSymbol(
  checker: ts.TypeChecker,
  exported: ts.Symbol,
  source: ReferenceSource,
  entrypoint: string,
  sources: ReferenceSource[],
  root: string,
  publicTypes: Set<ts.Symbol>,
): ReferenceEntry {
  const symbol = resolvedSymbol(checker, exported);
  const location = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!location) throw new Error(`Unresolved export: ${entrypoint}#${exported.name}`);
  const declaration: ts.Declaration = location;
  const name = exported.name;
  const docs = jsdoc(checker, symbol);
  const typeOnly = !(symbol.flags & ts.SymbolFlags.Value);
  const type = typeOnly
    ? checker.getDeclaredTypeOfSymbol(symbol)
    : checker.getTypeOfSymbolAtLocation(symbol, declaration);
  const renderType = (type: ts.Type, at: ts.Node = declaration): string =>
    portable(checker.typeToString(type, at, TYPE_FLAGS), sources, root);
  const renderCall = (signature: ts.Signature): string =>
    portable(checker.signatureToString(signature, declaration, TYPE_FLAGS), sources, root);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  let kind = 'value';
  let signature: string;
  if (symbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum)) {
    kind =
      symbol.flags & ts.SymbolFlags.TypeAlias
        ? 'type'
        : symbol.flags & ts.SymbolFlags.Interface
          ? 'interface'
          : 'enum';
    // Print the actual declaration, not checker.typeToString(alias) which is only its name.
    signature = (symbol.declarations ?? [])
      .filter(
        (decl) =>
          ts.isTypeAliasDeclaration(decl) ||
          ts.isInterfaceDeclaration(decl) ||
          ts.isEnumDeclaration(decl),
      )
      .map((decl) => {
        // Rename only the declaration identifier, never matching prose or interpreting a '$'
        // in a legal export name as a regexp anchor. Source docs remain verbatim for aliases.
        const alias = ts.factory.createIdentifier(name === 'default' ? symbol.name : name);
        const renamed = ts.isTypeAliasDeclaration(decl)
          ? ts.factory.updateTypeAliasDeclaration(
              decl,
              decl.modifiers,
              alias,
              decl.typeParameters,
              decl.type,
            )
          : ts.isInterfaceDeclaration(decl)
            ? ts.factory.updateInterfaceDeclaration(
                decl,
                decl.modifiers,
                alias,
                decl.typeParameters,
                decl.heritageClauses,
                decl.members,
              )
            : ts.factory.updateEnumDeclaration(decl, decl.modifiers, alias, decl.members);
        const printed = printer.printNode(ts.EmitHint.Unspecified, renamed, decl.getSourceFile());
        return name === 'default' && symbol.name !== name
          ? `${printed}\nexport { ${symbol.name} as default };`
          : printed;
      })
      .join('\n');
  } else if (symbol.flags & ts.SymbolFlags.Class) {
    kind = 'class';
    const instance = checker.getDeclaredTypeOfSymbol(symbol);
    const classDeclaration = symbol.declarations?.find(ts.isClassDeclaration);
    const generics = classDeclaration?.typeParameters
      ?.map((parameter) => parameter.getText())
      .join(', ');
    const heritage = classDeclaration?.heritageClauses?.map((clause) => clause.getText()).join(' ');
    const body: string[] = [];
    for (const call of checker.getSignaturesOfType(type, ts.SignatureKind.Construct)) {
      const parameters = call.parameters.map((parameter) => {
        const decl = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? declaration;
        const parameterNode = ts.isParameter(decl) ? decl : undefined;
        const optional = parameterNode?.questionToken || parameterNode?.initializer;
        return (
          `${parameterNode?.dotDotDotToken ? '...' : ''}${parameter.name}${optional ? '?' : ''}: ` +
          renderType(checker.getTypeOfSymbolAtLocation(parameter, decl))
        );
      });
      body.push(`constructor(${parameters.join(', ')});`);
    }
    for (const [owner, prefix] of [
      [type, 'static '],
      [instance, ''],
    ] as const) {
      for (const member of checker.getPropertiesOfType(owner)) {
        if (member.name === 'prototype' || !publicProperty(member)) continue;
        const at = member.valueDeclaration ?? member.declarations?.[0] ?? declaration;
        const memberType = checker.getTypeOfSymbolAtLocation(member, at);
        const label = `${member.name}${member.flags & ts.SymbolFlags.Optional ? '?' : ''}`;
        const calls = checker.getSignaturesOfType(memberType, ts.SignatureKind.Call);
        if (calls.length && member.flags & ts.SymbolFlags.Method) {
          body.push(...calls.map((call) => `${prefix}${label}${renderCall(call)};`));
        } else {
          const readonly =
            ts.getCombinedModifierFlags(at) & ts.ModifierFlags.Readonly ? 'readonly ' : '';
          body.push(`${prefix}${readonly}${label}: ${renderType(memberType)};`);
        }
      }
    }
    signature =
      `export declare class ${name}${generics ? `<${generics}>` : ''}${heritage ? ` ${heritage}` : ''} {\n` +
      body.map((line) => `  ${line}`).join('\n') +
      '\n}';
  } else {
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    kind = calls.length ? 'function' : symbol.flags & ts.SymbolFlags.Module ? 'namespace' : 'value';
    signature =
      symbol.flags & ts.SymbolFlags.Function
        ? calls.map((call) => `export declare function ${name}${renderCall(call)};`).join('\n')
        : `export declare const ${name}: ${renderType(type)};`;
  }
  const members: ReferenceEntry['members'] = [];
  const recorded = new Map<string, ReferenceEntry['members'][number]>();
  const fieldTypes = new Map<string, Set<string>>();
  function record(member: ts.Symbol, path: string, memberType: ts.Type): void {
    const doc = jsdoc(checker, resolvedSymbol(checker, member));
    const field = {
      name: path,
      type: renderType(memberType),
      description: [
        doc.description,
        ...doc.tags
          .filter((tag) => tag.name !== 'example')
          .map((tag) => `@${tag.name}${tag.text ? ` ${tag.text}` : ''}`),
      ]
        .filter(Boolean)
        .join('\n'),
      optional:
        !!(member.flags & ts.SymbolFlags.Optional) ||
        !!member.declarations?.some(
          (decl) => ts.isParameter(decl) && (decl.questionToken || decl.initializer),
        ),
      defaultValue:
        doc.tags.find((tag) => tag.name === 'default' || tag.name === 'defaultValue')?.text ?? null,
    };
    const previous = recorded.get(path);
    if (previous) {
      // A field may differ across union arms or overloads. Retain every documented shape;
      // conflicting defaults are not a universal default and must not become one.
      const variants = fieldTypes.get(path)!;
      variants.add(field.type);
      previous.type =
        variants.size === 1
          ? field.type
          : [...variants]
              .sort(compare)
              .map((type) => `(${type})`)
              .join(' | ');
      if (field.description && !previous.description.includes(field.description)) {
        previous.description = [previous.description, field.description].filter(Boolean).join('\n');
      }
      previous.optional ||= field.optional;
      if (previous.defaultValue !== field.defaultValue) previous.defaultValue = null;
      return;
    }
    recorded.set(path, field);
    fieldTypes.set(path, new Set([field.type]));
    members.push(field);
  }
  function walk(
    current: ts.Type,
    prefix: string,
    ancestors: Set<ts.Type>,
    expandCalls = true,
  ): void {
    if (ancestors.has(current)) return;
    const next = new Set(ancestors).add(current);
    const arms = current.isUnionOrIntersection() ? current.types : [current];
    for (const arm of arms) {
      if (!(arm.flags & ts.TypeFlags.Object) || checker.isArrayLikeType(arm)) continue;
      for (const member of checker
        .getPropertiesOfType(arm)
        .sort((a, b) => compare(a.name, b.name))) {
        if (!publicProperty(member)) continue;
        const decl = member.valueDeclaration ?? member.declarations?.[0];
        if (
          !decl ||
          !posix(decl.getSourceFile().fileName).startsWith(posix(resolve(root, 'packages')) + '/')
        )
          continue;
        const memberType = checker.getTypeOfSymbolAtLocation(member, decl);
        const path = prefix ? `${prefix}.${member.name}` : member.name;
        record(member, path, memberType);
        // Named contracts have their own declarations in the catalog. Expand namespace and
        // companion callables, but do not recursively inline the entire object graph of every
        // returned Position/Schema under every builder (tens of thousands of duplicate fields).
        const namedContract = memberType.aliasSymbol ?? memberType.getSymbol();
        if (expandCalls || !namedContract || !publicTypes.has(namedContract)) {
          walk(memberType, path, next, expandCalls);
        }
      }
    }
    if (!expandCalls) return;
    for (const call of [
      ...checker.getSignaturesOfType(current, ts.SignatureKind.Call),
      ...checker.getSignaturesOfType(current, ts.SignatureKind.Construct),
    ]) {
      for (const parameter of call.parameters) {
        const decl = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? declaration;
        const parameterType = checker.getTypeOfSymbolAtLocation(parameter, decl);
        const path = prefix ? `${prefix}(${parameter.name})` : `(${parameter.name})`;
        record(parameter, path, parameterType);
        walk(parameterType, path, next, false);
      }
      walk(
        checker.getReturnTypeOfSignature(call),
        prefix ? `${prefix}().return` : 'return',
        next,
        false,
      );
    }
  }
  walk(type, '', new Set());
  if (symbol.flags & ts.SymbolFlags.Class)
    walk(checker.getDeclaredTypeOfSymbol(symbol), '', new Set());
  return {
    id: `${entrypoint}#${name}`,
    package: source.package.name,
    entrypoint,
    name,
    kind,
    signature: portable(signature, sources, root),
    description: docs.description,
    examples: docs.tags.filter((tag) => tag.name === 'example').map((tag) => tag.text),
    tags: docs.tags,
    members: members.sort((a, b) => compare(a.name, b.name)),
    stability:
      docs.tags.find((tag) => ['experimental', 'beta', 'alpha'].includes(tag.name))?.name ??
      source.package.stability,
  };
}

/** Always evaluates the live registry; new profiles and full-profile packs are discovered. */
export function buildReferenceOperations(): ReferenceOperation[] {
  const profiles = REGISTRY_PROFILES.map((name) => ({
    name,
    ids: new Set(
      packsForProfile(name).flatMap((pack) => pack.operations.map((operation) => operation.id)),
    ),
  }));
  const operations = packsForProfile('full').flatMap((pack) =>
    pack.operations.map((operation) => ({
      ...describeOperation(operation),
      pack: pack.name,
      profiles: profiles
        .filter((profile) => profile.ids.has(operation.id))
        .map((profile) => profile.name)
        .sort(compare),
      defaultEnabled: profiles.find((profile) => profile.name === 'default')!.ids.has(operation.id),
      sdkOnly: false as const,
    })),
  );
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
    throw new Error('Duplicate full-profile operation');
  for (const profile of profiles)
    for (const id of profile.ids) {
      if (!operations.some((operation) => operation.id === id))
        throw new Error(`Full profile omits ${profile.name}: ${id}`);
    }
  return operations.sort((a, b) => compare(a.id, b.id));
}

/** Build-time only; serializable output contains no compiler objects or local absolute paths. */
export function buildReferenceEntries(
  program: ts.Program,
  sources: ReferenceSource[],
  root = ROOT,
): ReferenceEntry[] {
  const checker = program.getTypeChecker();
  const entries: ReferenceEntry[] = [];
  const publicTypes = new Set<ts.Symbol>();
  for (const source of sources)
    for (const path of Object.values(source.entrypoints)) {
      const file = program.getSourceFile(resolve(root, path));
      const module = file && checker.getSymbolAtLocation(file);
      if (module)
        for (const symbol of checker.getExportsOfModule(module))
          publicTypes.add(resolvedSymbol(checker, symbol));
    }
  for (const source of sources)
    for (const [entrypoint, path] of Object.entries(source.entrypoints)) {
      const file = program.getSourceFile(resolve(root, path));
      const module = file && checker.getSymbolAtLocation(file);
      if (!module) throw new Error(`Unresolved public entrypoint: ${entrypoint}`);
      for (const symbol of checker.getExportsOfModule(module)) {
        entries.push(
          entryForSymbol(checker, symbol, source, entrypoint, sources, root, publicTypes),
        );
      }
    }
  return entries.sort((a, b) => compare(a.id, b.id));
}

/** Complete, fresh build from the current checkout (no stale process-global cache). */
export function buildPublicReference(): PublicReference {
  const sources = discoverReferenceSources();
  const entries = buildReferenceEntries(createReferenceProgram(sources), sources);
  return {
    packages: sources.map((source) => source.package),
    entries,
    operations: buildReferenceOperations(),
  };
}

export function buildTypeDocConfig(): Record<string, unknown> {
  return {
    $schema: 'https://typedoc.org/schema.json',
    entryPoints: [
      ...new Set(discoverReferenceSources().flatMap((source) => Object.values(source.entrypoints))),
    ].sort(compare),
    out: 'docs/api',
    cleanOutputDir: true,
    excludePrivate: true,
    excludeInternal: true,
    // No guessed public-repository URLs or machine-local source links. Re-enable source links
    // only with a maintainer-verified sourceLinkTemplate for the released artifact/version.
    disableSources: true,
    readme: 'README.md',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--typedoc')
    throw new Error('Usage: pnpm tsx tools/public-reference.ts --typedoc');
  writeFileSync(
    resolve(ROOT, 'typedoc.json'),
    `${JSON.stringify(buildTypeDocConfig(), null, 2)}\n`,
  );
}
