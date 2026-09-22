/** Assemble self-contained ESM artifacts without bundling, duplicating core, or changing APIs. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { decode, encode } from '@jridgewell/sourcemap-codec';
import {
  MCP_PACKAGE_NAME,
  PUBLIC_PACKAGE_NAME,
  publicPackageDirectories,
  publicSourcePaths,
  sourcePackages,
  toPublicSpecifier,
  type SourcePackage,
} from './public-packages.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Manifest = Record<string, unknown> & { name: string; version: string };
type Edit = { start: number; end: number; text: string };

/** npm renders these documents outside their source folder; keep documentation links usable. */
export function distributionMarkdown(text: string, sourcePath: string): string {
  const base = `https://github.com/InsiderFinance/totalfinance/blob/main/${sourcePath}`;
  return text
    .replace(/@totalfinance\/[a-z][a-z0-9/-]*/g, toPublicSpecifier)
    .replace(/^# totalfinance —/m, `# ${PUBLIC_PACKAGE_NAME} —`)
    .replace(
      /(\]\()(\.\.?\/[^\s)]+)/g,
      (_match, prefix: string, target: string) => prefix + new URL(target, base).href,
    );
}

/** Only syntactic module specifiers are changed; arbitrary strings and comments are untouched. */
export function rewriteModuleSpecifiers(
  source: string,
  filename: string,
  rewrite: (specifier: string) => string,
): { text: string; edits: Edit[] } {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const edits: Edit[] = [];
  const change = (node: ts.Node | undefined) => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    const replacement = rewrite(node.text);
    if (replacement !== node.text)
      edits.push({ start: node.getStart(file) + 1, end: node.getEnd() - 1, text: replacement });
  };
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) change(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      change(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      change(node.arguments[0]);
    else if (ts.isExternalModuleReference(node)) change(node.expression);
    ts.forEachChild(node, visit);
  }
  visit(file);
  edits.sort((a, b) => a.start - b.start);
  let text = source;
  for (const edit of [...edits].reverse())
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { text, edits };
}

/** Preserve source/debug locations when rewritten import strings change generated columns. */
export function rewriteMap(mapText: string, source: string, edits: Edit[]): string {
  if (edits.length === 0) return mapText;
  const map = JSON.parse(mapText) as { mappings: string };
  const lines = decode(map.mappings);
  for (const edit of [...edits].reverse()) {
    const prefix = source.slice(0, edit.start);
    const line = prefix.split('\n').length - 1;
    const column = edit.start - (prefix.lastIndexOf('\n') + 1);
    const end = column + edit.end - edit.start;
    const delta = edit.text.length - (edit.end - edit.start);
    for (const segment of lines[line] ?? []) {
      if (segment[0] >= end) segment[0] += delta;
      else if (segment[0] > column)
        segment[0] = column + Math.min(segment[0] - column, edit.text.length);
    }
  }
  map.mappings = encode(lines);
  return JSON.stringify(map);
}

function json(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function expectedMetadata(root: string, pkg: Manifest, sources: SourcePackage[]): Manifest {
  const mcp = pkg.name === MCP_PACKAGE_NAME;
  const exports: Record<string, unknown> = {};
  const main = sources.find((p) => p.dir === (mcp ? 'mcp' : 'totalfinance'))!;
  for (const source of [main, ...sources.filter((p) => p !== main)]) {
    if (mcp && source !== main) continue;
    if (!mcp && source.dir === 'mcp') continue;
    for (const [key, target] of Object.entries(source.exports)) {
      if (typeof target === 'string' || (source.dir === 'totalfinance' && key !== '.')) continue;
      const publicKey = source === main ? key : `./${source.dir}${key === '.' ? '' : key.slice(1)}`;
      const prefix = mcp ? './' : `./modules/${source.dir}/`;
      exports[publicKey] = Object.fromEntries(
        Object.entries(target).map(([condition, path]) => [condition, prefix + path.slice(2)]),
      );
    }
  }
  exports['./package.json'] = './package.json';
  const entry = mcp ? './dist/index' : './modules/totalfinance/dist/index';
  const mainVersion = json(join(root, 'distribution/totalfinance/package.json')).version;
  return {
    ...pkg,
    version: mainVersion,
    main: `${entry}.js`,
    module: `${entry}.js`,
    types: `${entry}.d.ts`,
    exports,
    bin: mcp
      ? { 'totalfinance-mcp': './dist/bin.js' }
      : {
          totalfinance: './modules/cli/dist/bin.js',
          'totalfinance-http': './modules/http/dist/bin.js',
        },
    dependencies: mcp
      ? {
          [PUBLIC_PACKAGE_NAME]: mainVersion,
          '@modelcontextprotocol/sdk': sources.find((p) => p.dir === 'mcp')!.dependencies![
            '@modelcontextprotocol/sdk'
          ],
        }
      : {},
  };
}

export function updatePublicationMetadata(root = ROOT): void {
  const sources = sourcePackages(root);
  const version = json(join(root, 'distribution/totalfinance/package.json')).version;
  for (const source of sources) {
    const path = join(root, 'packages', source.dir, 'package.json');
    const manifest = json(path);
    manifest['private'] = true;
    manifest.version = version;
    delete manifest['publishConfig'];
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  writeFileSync(
    join(root, 'packages/workflows/src/version.ts'),
    `/** Generated by publication:update from the public distribution version; browser-safe. */\nexport const WORKFLOWS_VERSION = '${version}';\n`,
  );
  for (const pkg of publicPackageDirectories(root)) {
    const path = join(pkg.path, 'package.json');
    writeFileSync(
      path,
      `${JSON.stringify(expectedMetadata(root, json(path), sources), null, 2)}\n`,
    );
  }
  // Preserve the handwritten config's comments; replace only its paths object.
  const configPath = join(root, 'tsconfig.json');
  const configText = readFileSync(configPath, 'utf8');
  const config = ts.parseJsonText(configPath, configText);
  const aliases = publicSourcePaths(root);
  function updatePaths(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(config) === '"paths"') {
      const existing = JSON.parse(node.initializer.getText(config)) as Record<string, string[]>;
      for (const key of Object.keys(existing))
        if (key.startsWith(PUBLIC_PACKAGE_NAME)) delete existing[key];
      const text = JSON.stringify({ ...aliases, ...existing }, null, 2).replaceAll('\n', '\n    ');
      writeFileSync(
        configPath,
        configText.slice(0, node.initializer.getStart(config)) +
          text +
          configText.slice(node.initializer.getEnd()),
      );
      return;
    }
    ts.forEachChild(node, updatePaths);
  }
  updatePaths(config);
}

export function assembleDistribution(root = ROOT): void {
  const sources = sourcePackages(root);
  const byName = new Map(sources.map((p) => [p.name, p]));
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error('Cannot read publication type-checking aliases');
  const aliases = config.config.compilerOptions.paths as Record<string, string[]>;
  const expectedAliases = publicSourcePaths(root);
  if (
    Object.keys(aliases).filter((key) => key.startsWith(PUBLIC_PACKAGE_NAME)).length !==
      Object.keys(expectedAliases).length ||
    Object.entries(expectedAliases).some(
      ([key, value]) => JSON.stringify(aliases[key]) !== JSON.stringify(value),
    )
  )
    throw new Error('Public source aliases drifted; run pnpm publication:update');
  const version = json(join(root, 'distribution/totalfinance/package.json')).version;
  for (const source of sources) {
    if (!source.private || source.version !== version)
      throw new Error(
        `${source.name}: run pnpm publication:update (private workspace/version drift)`,
      );
  }
  const literal = readFileSync(join(root, 'packages/workflows/src/version.ts'), 'utf8');
  if (!literal.includes(`WORKFLOWS_VERSION = '${version}'`))
    throw new Error('Runtime version drift');
  for (const pkg of publicPackageDirectories(root)) {
    const manifest = json(join(pkg.path, 'package.json'));
    if (manifest.name !== pkg.name || manifest['private'] === true)
      throw new Error(`Invalid public distribution identity: ${pkg.path}`);
    if (JSON.stringify(manifest) !== JSON.stringify(expectedMetadata(root, manifest, sources)))
      throw new Error(`${pkg.name}: run pnpm publication:update (public metadata drift)`);
    const mcp = pkg.name === MCP_PACKAGE_NAME;
    for (const directory of mcp ? ['dist', 'src', 'etc'] : ['modules'])
      rmSync(join(pkg.path, directory), { recursive: true, force: true });
    for (const source of sources) {
      if (mcp !== (source.dir === 'mcp')) continue;
      const dest = mcp ? pkg.path : join(pkg.path, 'modules', source.dir);
      const original = join(root, 'packages', source.dir);
      mkdirSync(dest, { recursive: true });
      for (const dir of ['dist', 'src', 'etc']) {
        if (!existsSync(join(original, dir)))
          throw new Error(`Missing ${original}/${dir}; run build first`);
        cpSync(join(original, dir), join(dest, dir), {
          recursive: true,
          filter: (path) => !path.endsWith('.tsbuildinfo'),
        });
      }
      for (const path of readdirSync(join(dest, 'etc'), { recursive: true }) as string[]) {
        if (!path.endsWith('.md')) continue;
        const file = join(dest, 'etc', path);
        writeFileSync(
          file,
          distributionMarkdown(readFileSync(file, 'utf8'), `packages/${source.dir}/etc/${path}`),
        );
      }
      for (const path of source.files.filter(
        (path) => path.endsWith('.md') && path !== 'STABILITY.md' && !path.startsWith('!'),
      )) {
        const originalPath = `packages/${source.dir}/${path}`;
        mkdirSync(dirname(join(dest, path)), { recursive: true });
        writeFileSync(
          join(dest, path),
          distributionMarkdown(readFileSync(join(root, originalPath), 'utf8'), originalPath),
        );
      }
      for (const path of readdirSync(join(dest, 'dist'), { recursive: true }) as string[]) {
        if (!/\.(?:js|d\.ts)$/.test(path)) continue;
        const targetPath = join(dest, 'dist', path);
        const text = readFileSync(targetPath, 'utf8');
        const rewritten = rewriteModuleSpecifiers(text, path, (specifier) => {
          if (
            !specifier.startsWith('@totalfinance/') &&
            specifier !== 'totalfinance' &&
            !specifier.startsWith('totalfinance/')
          )
            return specifier;
          const parts = specifier.split('/');
          const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
          const tail = parts.slice(specifier.startsWith('@') ? 2 : 1).join('/');
          const dependency = byName.get(name);
          const entry = dependency?.exports[tail ? `./${tail}` : '.'];
          if (!dependency || !entry || typeof entry === 'string')
            throw new Error(`Unknown private import ${specifier} in ${targetPath}`);
          if (dependency.dir === 'mcp')
            throw new Error(`MCP must not be imported by the library: ${targetPath}`);
          if (mcp) return toPublicSpecifier(specifier);
          const file = path.endsWith('.d.ts') ? entry.types : entry.import;
          // Declarations import the JS filename; TS resolves its adjacent .d.ts normally.
          const relativeTarget = relative(
            dirname(targetPath),
            join(pkg.path, 'modules', dependency.dir, file.replace(/\.d\.ts$/, '.js')),
          ).replaceAll('\\', '/');
          return relativeTarget.startsWith('.') ? relativeTarget : `./${relativeTarget}`;
        });
        writeFileSync(targetPath, rewritten.text);
        const mapPath = `${targetPath}.map`;
        if (existsSync(mapPath))
          writeFileSync(mapPath, rewriteMap(readFileSync(mapPath, 'utf8'), text, rewritten.edits));
      }
    }
    cpSync(join(root, 'LICENSE'), join(pkg.path, 'LICENSE'));
    for (const sourcePath of ['STABILITY.md', mcp ? 'packages/mcp/README.md' : 'README.md']) {
      const target = sourcePath.endsWith('README.md') ? 'README.md' : 'STABILITY.md';
      writeFileSync(
        join(pkg.path, target),
        distributionMarkdown(readFileSync(join(root, sourcePath), 'utf8'), sourcePath),
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--update')) updatePublicationMetadata();
  else assembleDistribution();
}
