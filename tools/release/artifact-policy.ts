/** Fail-closed policy shared by packing, approved-artifact publication and registry verification. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import ts from 'typescript';
import { MCP_PACKAGE_NAME, PUBLIC_PACKAGE_NAME } from '../public-packages.js';

export const PUBLIC_ROSTER = [PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME] as const;
export const NPMJS = 'https://registry.npmjs.org';

export interface ReleaseArtifact {
  package: string;
  version: string;
  tarball: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseManifest {
  version: string;
  commit: string;
  /** Mandatory for public publication; legacy/local consumer fixtures may omit this marker. */
  sourceDirty?: boolean;
  /** Dependency order: the main package, then optional MCP. */
  packages: ReleaseArtifact[];
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function releaseVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value))
    throw new Error('Release version must be an exact non-prerelease semantic version');
}

export function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** Do not trust a cast of downloaded JSON, or allow omitted/duplicated/extra/reordered artifacts. */
export function validateManifest(value: unknown): ReleaseManifest {
  const manifest = object(value, 'release manifest');
  releaseVersion(manifest['version']);
  if (
    typeof manifest['commit'] !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest['commit'])
  )
    throw new Error('Invalid release commit');
  if (manifest['sourceDirty'] !== undefined && typeof manifest['sourceDirty'] !== 'boolean')
    throw new Error('Invalid sourceDirty marker');
  if (!Array.isArray(manifest['packages']) || manifest['packages'].length !== PUBLIC_ROSTER.length)
    throw new Error('Manifest must contain exactly the two public artifacts');
  for (const [index, entry] of manifest['packages'].entries()) {
    const artifact = object(entry, 'release artifact');
    const name = PUBLIC_ROSTER[index]!;
    if (artifact['package'] !== name || artifact['version'] !== manifest['version'])
      throw new Error('Manifest must name main then MCP, once each, at the same version');
    if (artifact['tarball'] !== tarballName(name, manifest['version']))
      throw new Error(`Unsafe or unexpected tarball path for ${name}`);
    if (typeof artifact['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(artifact['sha256']))
      throw new Error(`Invalid sha256 for ${name}`);
    if (!Number.isSafeInteger(artifact['bytes']) || (artifact['bytes'] as number) <= 0)
      throw new Error(`Invalid byte length for ${name}`);
  }
  return manifest as unknown as ReleaseManifest;
}

/** Validate packed metadata independently of the hash manifest and the workspace manifests. */
export function validatePackageMetadata(value: unknown, name: string, version: string): void {
  const pkg = object(value, name);
  if (!PUBLIC_ROSTER.includes(name as (typeof PUBLIC_ROSTER)[number]))
    throw new Error(`Not a public artifact: ${name}`);
  if (
    pkg['name'] !== name ||
    pkg['version'] !== version ||
    (pkg['private'] !== undefined && pkg['private'] !== false)
  )
    throw new Error(`Wrong package identity/version/private flag: ${name}`);
  if (pkg['type'] !== 'module' || pkg['license'] !== 'Apache-2.0' || pkg['sideEffects'] !== false)
    throw new Error(`Invalid module/license/sideEffects metadata: ${name}`);
  if (object(pkg['engines'], 'engines')['node'] !== '>=22.13.0')
    throw new Error(`Wrong consumer Node floor: ${name}`);
  const repository = object(pkg['repository'], 'repository');
  if (
    repository['type'] !== 'git' ||
    repository['url'] !== 'git+https://github.com/InsiderFinance/totalfinance.git' ||
    repository['directory'] !==
      (name === PUBLIC_PACKAGE_NAME ? 'distribution/totalfinance' : 'distribution/mcp')
  )
    throw new Error(`Invalid canonical repository metadata: ${name}`);
  const publish = object(pkg['publishConfig'], 'publishConfig');
  if (
    Object.keys(publish).some((key) => !['access', 'provenance', 'registry'].includes(key)) ||
    publish['access'] !== 'public' ||
    publish['provenance'] !== true ||
    (publish['registry'] !== undefined &&
      publish['registry'] !== NPMJS &&
      publish['registry'] !== `${NPMJS}/`)
  )
    throw new Error(`Invalid publish configuration: ${name}`);
  for (const field of [
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
    'peerDependenciesMeta',
    'overrides',
    'resolutions',
  ]) {
    if (pkg[field] !== undefined && Object.keys(object(pkg[field], field)).length)
      throw new Error(`Unexpected ${field}: ${name}`);
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    if (pkg[field] !== undefined && (!Array.isArray(pkg[field]) || pkg[field].length))
      throw new Error(`Unexpected ${field}: ${name}`);
  }
  const dependencies =
    pkg['dependencies'] === undefined ? {} : object(pkg['dependencies'], 'dependencies');
  if (name === PUBLIC_PACKAGE_NAME) {
    if (Object.keys(dependencies).length)
      throw new Error('Main must have zero runtime dependencies');
  } else if (
    Object.keys(dependencies).sort().join(',') !==
      [PUBLIC_PACKAGE_NAME, '@modelcontextprotocol/sdk'].sort().join(',') ||
    dependencies[PUBLIC_PACKAGE_NAME] !== version ||
    typeof dependencies['@modelcontextprotocol/sdk'] !== 'string' ||
    !/^[~^]?\d+\.\d+\.\d+$/.test(dependencies['@modelcontextprotocol/sdk'])
  ) {
    throw new Error('MCP must depend only on the exact main version and the MCP SDK');
  }
  if (
    pkg['scripts'] &&
    Object.keys(object(pkg['scripts'], 'scripts')).some((key) =>
      /^(?:pre|post)?(?:install|publish|pack|prepare)$/.test(key),
    )
  )
    throw new Error(`Lifecycle scripts are not allowed in an approved artifact: ${name}`);
  const exports = object(pkg['exports'], 'exports');
  if (
    !exports['.'] ||
    exports['./package.json'] !== './package.json' ||
    Object.keys(exports).some(
      (key) => key.includes('*') || key === './mcp' || key.startsWith('./mcp/'),
    )
  )
    throw new Error(`Invalid explicit public export map: ${name}`);
  if (
    name === PUBLIC_PACKAGE_NAME &&
    ['./workflows', './cli', './http', './options/black-scholes'].some((key) => !exports[key])
  )
    throw new Error('Main is missing required domain/transport entry points');
  const bin = object(pkg['bin'], 'bin');
  const expectedBins =
    name === PUBLIC_PACKAGE_NAME
      ? {
          totalfinance: './modules/cli/dist/bin.js',
          'totalfinance-http': './modules/http/dist/bin.js',
        }
      : { 'totalfinance-mcp': './dist/bin.js' };
  if (
    Object.keys(bin).sort().join(',') !== Object.keys(expectedBins).sort().join(',') ||
    Object.entries(expectedBins).some(([key, path]) => bin[key] !== path)
  )
    throw new Error(`Invalid executable paths: ${name}`);
}

function tar(args: string[]): string {
  return execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Validate archive names/types before extraction; no symlinks, hardlinks or path escapes. */
export function inspectTarball(path: string, artifact: ReleaseArtifact): void {
  const names = tar(['-tzf', path]).trim().split('\n');
  const members = new Set<string>();
  for (const name of names) {
    const normalized = name.replace(/\/$/, '');
    if (
      !/^package(?:\/[a-zA-Z0-9._@+/-]+)?$/.test(normalized) ||
      normalized.split('/').some((part) => part === '.' || part === '..' || part === '') ||
      members.has(normalized)
    )
      throw new Error(`Unsafe/duplicate archive member: ${name}`);
    members.add(normalized);
  }
  if (
    tar(['-tvzf', path])
      .trim()
      .split('\n')
      .some((line) => !/^[-d]/.test(line))
  )
    throw new Error('Archive contains links or special files');
  const pkg: unknown = JSON.parse(tar(['-xOzf', path, 'package/package.json']));
  validatePackageMetadata(pkg, artifact['package'], artifact['version']);
  const metadata = object(pkg, 'package');
  for (const file of ['package.json', 'LICENSE', 'STABILITY.md', 'README.md']) {
    if (!members.has(`package/${file}`)) throw new Error(`Missing packed ${file}`);
  }
  const targets = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    return Object.values(object(value, 'export target')).flatMap(targets);
  };
  for (const target of [
    metadata['main'],
    metadata['module'],
    metadata['types'],
    ...targets(metadata['exports']),
    ...targets(metadata['bin']),
  ]) {
    if (
      typeof target !== 'string' ||
      !target.startsWith('./') ||
      !members.has(`package/${target.slice(2)}`)
    )
      throw new Error(`Missing or unsafe packed entry point: ${String(target)}`);
  }
  const temp = mkdtempSync(join(tmpdir(), 'totalfinance-inspect-'));
  try {
    tar(['-xzf', path, '-C', temp]);
    for (const name of members) {
      if (!/\.(?:js|d\.ts)$/.test(name)) continue;
      const text = readFileSync(join(temp, name), 'utf8');
      const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
      const checkSpecifier = (node: ts.Node | undefined): void => {
        if (
          node &&
          ts.isStringLiteralLike(node) &&
          (node.text.startsWith('@totalfinance/') ||
            node.text === 'totalfinance' ||
            node.text.startsWith('totalfinance/'))
        )
          throw new Error(`Private module specifier in ${name}`);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          checkSpecifier(node.moduleSpecifier);
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
          checkSpecifier(node.argument.literal);
        else if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        )
          checkSpecifier(node.arguments[0]);
        else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference)
        )
          checkSpecifier(node.moduleReference.expression);
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (
        name.endsWith('.js') &&
        (!members.has(`${name}.map`) || !members.has(name.replace(/\.js$/, '.d.ts')))
      )
        throw new Error(`Missing packed declaration/source map for ${name}`);
      if (name.endsWith('.js')) {
        const map = object(
          JSON.parse(readFileSync(join(temp, `${name}.map`), 'utf8')),
          'source map',
        );
        if (
          map['version'] !== 3 ||
          !Array.isArray(map['sources']) ||
          !map['sources'].length ||
          (map['sourceRoot'] !== undefined && map['sourceRoot'] !== '') ||
          map['sources'].some(
            (source: unknown) =>
              typeof source !== 'string' ||
              !members.has(posix.join(posix.dirname(name), source)) ||
              !source.endsWith('.ts'),
          )
        )
          throw new Error(`Missing or unsafe original source map target: ${name}`);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function verifyApproved(dir: string): ReleaseManifest {
  dir = resolve(dir);
  if (!lstatSync(join(dir, 'RELEASE_HASHES.json')).isFile())
    throw new Error('Manifest must be a regular file');
  const manifest = validateManifest(
    JSON.parse(readFileSync(join(dir, 'RELEASE_HASHES.json'), 'utf8')),
  );
  const expected = manifest['packages'].map((artifact) => artifact['tarball']).sort();
  if (
    JSON.stringify(
      readdirSync(dir)
        .filter((name) => name.endsWith('.tgz'))
        .sort(),
    ) !== JSON.stringify(expected)
  )
    throw new Error('Artifact directory must contain exactly the approved tarballs');
  for (const artifact of manifest['packages']) {
    const path = join(dir, artifact['tarball']);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== artifact['bytes'] || sha256Of(path) !== artifact['sha256'])
      throw new Error(`Tarball hash/length/type mismatch: ${artifact['package']}`);
    inspectTarball(path, artifact);
  }
  return manifest;
}
