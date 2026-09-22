/**
 * The preview-surface audit (Stage 5A, Decision 4): FC9's launch checks, rehearsed over the current
 * surface on every push rather than discovered at release time.
 *
 * Each `describe` names the FC9 row it rehearses. Where an existing gate already proves a row
 * (transport parity, the packed consumer, the readme snippets, the generated-docs inventory), this
 * audit asserts that gate is present and wired into the suite instead of running it twice — the
 * audit is a table of contents over the evidence, not a second copy of it. What it proves directly
 * is what no other gate reads: the published metadata of the two distribution packages
 * (Decision 3), the stability statement that ships inside each of them (Decision 2), the community
 * and security files (Decision 5), and that the built artifacts carry the maps that make `src`
 * worth shipping.
 *
 * Public distributions come from the shared release helper; private source packages are audited
 * separately and must never become accidental npm products.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPackageDirectories } from './first-touch/sweep-roster.js';
import {
  PUBLIC_PACKAGE_NAME,
  MCP_PACKAGE_NAME,
  publicPackageDirectories,
  toPublicSpecifier,
} from './public-packages.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_ROOT = join(ROOT, 'packages');

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  keywords?: string[];
  license?: string;
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: string | { url?: string };
  type?: string;
  sideEffects?: boolean;
  main?: string;
  module?: string;
  types?: string;
  exports?: Record<string, unknown>;
  files?: string[];
  engines?: { node?: string };
  publishConfig?: { access?: string; provenance?: boolean };
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface Member {
  dir: string;
  path: string;
  manifest: Manifest;
}

/** The public repository selected by the maintainer for the standalone library. */
const PUBLIC_REPOSITORY = 'https://github.com/InsiderFinance/totalfinance';
/** The transports and the registry: the `preview` tier; everything else is `stable-by-law`. */
const PREVIEW_TIER = new Set([
  '@totalfinance/workflows',
  '@totalfinance/cli',
  '@totalfinance/http',
  '@totalfinance/mcp',
]);
const TRANSPORTS_WITH_BIN = new Set([PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME]);
const UMBRELLA = PUBLIC_PACKAGE_NAME;
// Exact, reviewed public guide additions; never a wildcard that could ship internal planning.
const PUBLIC_GUIDES: Readonly<Record<string, readonly string[]>> = {
  [PUBLIC_PACKAGE_NAME]: ['modules/structure/OPTION-FLOW-DRIFT.md'],
};
const NODE_FLOOR = '>=22.13.0';

const sourceMembers: Member[] = readPackageDirectories().map(({ dir }) => {
  const path = join(PKG_ROOT, dir);
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Manifest;
  return { dir, path, manifest };
});
const members: Member[] = publicPackageDirectories(ROOT).map(({ dir, path }) => ({
  dir,
  path,
  manifest: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Manifest,
}));
const byName = new Map(members.map((m) => [m.manifest.name, m]));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('public-surface audit — two distributions, private source workspaces', () => {
  it('finds exactly the two public artifacts and no publishable source workspace', () => {
    expect([...byName.keys()]).toEqual([PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME]);
    expect(sourceMembers.length).toBeGreaterThan(0);
    for (const source of sourceMembers)
      expect(source.manifest.private, source.manifest.name).toBe(true);
  });

  it('every member is publishable (not private) and shares one version', () => {
    const versions = new Set(members.map((m) => m.manifest.version));
    expect([...versions]).toHaveLength(1);
    expect([...versions]).toEqual(['0.1.0']);
    for (const m of members) expect(m.manifest.private ?? false, m.manifest.name).toBe(false);
  });
});

describe('FC9 row 6 — metadata (Decision 3), enumerated per package, fails on the first miss', () => {
  it.each(members.map((m) => [m.manifest.name, m] as const))('%s', (_name, m) => {
    const p = m.manifest;
    expect(p.description?.trim().length ?? 0).toBeGreaterThan(0);
    expect(p.keywords ?? []).toContain('finance');
    expect(p.keywords ?? []).toContain(m.dir === 'mcp' ? 'mcp' : 'options');
    expect(p.license).toBe('Apache-2.0');
    expect(existsSync(join(m.path, 'LICENSE'))).toBe(true);
    expect(p.repository?.type).toBe('git');
    expect(p.repository?.url).toBe(`git+${PUBLIC_REPOSITORY}.git`);
    expect(p.repository?.directory).toBe(`distribution/${m.dir}`);
    expect(p.homepage?.startsWith(PUBLIC_REPOSITORY)).toBe(true);
    const bugs = typeof p.bugs === 'string' ? p.bugs : p.bugs?.url;
    expect(bugs?.startsWith(PUBLIC_REPOSITORY)).toBe(true);
    expect(p.type).toBe('module');
    expect(p.sideEffects).toBe(false);
    const root = m.dir === 'mcp' ? './dist' : './modules/totalfinance/dist';
    expect(p.main).toBe(`${root}/index.js`);
    expect(p.module).toBe(`${root}/index.js`);
    expect(p.types).toBe(`${root}/index.d.ts`);
    expect(p.files).toEqual(
      m.dir === 'mcp'
        ? ['dist', 'src', 'etc', 'LICENSE', 'STABILITY.md']
        : ['modules', 'LICENSE', 'STABILITY.md'],
    );
    expect(p.engines?.node).toBe(NODE_FLOOR);
    expect(p.publishConfig).toEqual({ access: 'public', provenance: true });
    if (m.dir === 'totalfinance') expect(p.dependencies ?? {}).toEqual({});
    else {
      expect(Object.keys(p.dependencies ?? {}).sort()).toEqual(
        [PUBLIC_PACKAGE_NAME, '@modelcontextprotocol/sdk'].sort(),
      );
      expect(p.dependencies?.[PUBLIC_PACKAGE_NAME]).toBe('0.1.0');
    }
    // Public metadata may contain neither private aliases nor workspace protocols.
    for (const [dep, range] of Object.entries(p.dependencies ?? {})) {
      expect(/^[\^~]?\d/.test(range), `${dep}: ${range}`).toBe(true);
      expect(dep).not.toMatch(/^@totalfinance\/|^totalfinance$/);
      expect(
        p.devDependencies ?? {},
        `${dep} is both a dependency and a devDependency`,
      ).not.toHaveProperty(dep);
    }
  });

  it('each explicitly shipped public guide exists without internal-planning links', () => {
    for (const [name, guides] of Object.entries(PUBLIC_GUIDES)) {
      const member = byName.get(name);
      expect(member, `${name}: reviewed guide owner disappeared`).toBeDefined();
      for (const guide of guides) {
        const path = join(member!.path, guide);
        expect(existsSync(path), `${name}: ${guide} is missing`).toBe(true);
        const content = readFileSync(path, 'utf8');
        expect(content.trim().length).toBeGreaterThan(100);
        expect(content).not.toMatch(/docs\/(?:reviews|specs)\/|implementation-order\.md/);
      }
    }
  });

  it('every exports subpath puts types first, exports ./package.json, and resolves to a built file', () => {
    for (const m of members) {
      const exportsMap = m.manifest.exports ?? {};
      expect(exportsMap['./package.json'], m.manifest.name).toBe('./package.json');
      for (const [subpath, target] of Object.entries(exportsMap)) {
        if (subpath === './package.json') continue;
        expect(typeof target, `${m.manifest.name} ${subpath}`).toBe('object');
        const conditions = Object.keys(target as Record<string, string>);
        expect(conditions[0], `${m.manifest.name} ${subpath}: types must come first`).toBe('types');
        for (const file of Object.values(target as Record<string, string>)) {
          expect(
            existsSync(join(m.path, file)),
            `${m.manifest.name} ${subpath} -> ${file} (run pnpm build)`,
          ).toBe(true);
        }
      }
    }
  });

  it('the transports expose executable bin entries with the shebang line and a dist target', () => {
    for (const name of TRANSPORTS_WITH_BIN) {
      const m = byName.get(name)!;
      const bin = m.manifest.bin ?? {};
      expect(Object.keys(bin).length, name).toBeGreaterThan(0);
      for (const [command, target] of Object.entries(bin)) {
        expect(target).toMatch(/^\.\/(?:modules\/(?:cli|http)\/)?dist\//);
        const built = join(m.path, target);
        expect(existsSync(built), `${name} ${command}: ${target} (run pnpm build)`).toBe(true);
        expect(
          readFileSync(built, 'utf8').startsWith('#!/usr/bin/env node'),
          `${name} ${command}: shebang`,
        ).toBe(true);
      }
    }
    for (const m of members) {
      if (!TRANSPORTS_WITH_BIN.has(m.manifest.name))
        expect(m.manifest.bin, m.manifest.name).toBeUndefined();
    }
  });

  it('every built .js has a .js.map and every .d.ts a .d.ts.map, and src ships so they resolve', () => {
    for (const m of members) {
      const dist = join(m.path, m.dir === 'mcp' ? 'dist' : 'modules');
      expect(existsSync(dist), `${m.manifest.name}: dist missing (run pnpm build)`).toBe(true);
      const files = walk(dist);
      const set = new Set(files);
      const missing: string[] = [];
      for (const f of files) {
        if (f.endsWith('.js') && !set.has(`${f}.map`)) missing.push(f);
        if (f.endsWith('.d.ts') && !set.has(f.replace(/\.d\.ts$/, '.d.ts.map'))) missing.push(f);
      }
      expect(missing, m.manifest.name).toEqual([]);
      if (m.dir === 'mcp') expect(existsSync(join(m.path, 'src'))).toBe(true);
      else
        for (const source of sourceMembers.filter((source) => source.dir !== 'mcp'))
          expect(existsSync(join(m.path, 'modules', source.dir, 'src')), source.dir).toBe(true);
    }
  });
});

describe('FC9 row 6 — the stability statement (Decision 2)', () => {
  const rootStability = readFileSync(join(ROOT, 'STABILITY.md'), 'utf8');

  it('STABILITY.md exists at the root, names the three tiers, and states the series', () => {
    for (const tier of ['stable-by-law', 'preview', 'experimental'])
      expect(rootStability).toContain(`**${tier}**`);
    expect(rootStability).toContain('0.1.0');
    expect(rootStability).not.toContain('0.1.0-preview.N');
  });

  it('its package count is the fixed group, and it names every member', () => {
    expect(rootStability).toMatch(/\b(?:two|2)\b/i);
    for (const m of members) {
      const spelled = `\`${m.manifest.name}\``;
      const short = `\`${m.dir}\``;
      expect(
        rootStability.includes(spelled) || rootStability.includes(short),
        m.manifest.name,
      ).toBe(true);
    }
  });

  it('every package ships the identical STABILITY.md and lists it in files', () => {
    for (const m of members) {
      const copy = join(m.path, 'STABILITY.md');
      expect(existsSync(copy), m.manifest.name).toBe(true);
      expect(
        readFileSync(copy, 'utf8'),
        `${m.manifest.name}: STABILITY.md drifted from the root copy`,
      ).toBe(rootStability);
      expect(m.manifest.files).toContain('STABILITY.md');
    }
  });

  it('the tier the statement assigns matches the package (transports and the registry are preview)', () => {
    const tiers = readFileSync(join(ROOT, 'docs', 'stability.md'), 'utf8');
    for (const m of sourceMembers.filter((source) => source.dir !== 'totalfinance')) {
      const expected = PREVIEW_TIER.has(m.manifest.name) ? 'preview' : 'stable-by-law';
      const label = `\`${toPublicSpecifier(m.manifest.name)}\``;
      const row = tiers.split('\n').find((line) => line.startsWith(`| ${label}`));
      expect(row, `${m.manifest.name}: no row in docs/stability.md`).toBeDefined();
      expect(
        row!.includes(`| ${expected}`),
        `${m.manifest.name}: expected tier ${expected} in "${row}"`,
      ).toBe(true);
    }
  });

  it('changesets targets the public pair without preview pre-mode', () => {
    expect(existsSync(join(ROOT, '.changeset', 'pre.json'))).toBe(false);
    const config = JSON.parse(readFileSync(join(ROOT, '.changeset', 'config.json'), 'utf8')) as {
      fixed: string[][];
      baseBranch: string;
      access: string;
    };
    expect(config.fixed).toEqual([[PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME]]);
    expect(config.baseBranch).toBe('main');
    expect(config.access).toBe('public');
  });
});

describe('FC9 row 1 — discovery', () => {
  it('the umbrella exposes every domain package as a namespace and hoists no wildcard root', () => {
    const source = readFileSync(join(PKG_ROOT, 'totalfinance', 'src', 'index.ts'), 'utf8');
    expect(source).not.toMatch(/^export \* from/m);
    const namespaced = new Set(
      [...source.matchAll(/^export \* as \w+ from '(@totalfinance\/[a-z-]+)';/gm)].map(
        (m) => m[1]!,
      ),
    );
    const domain = sourceMembers
      .map((m) => m.manifest.name)
      .filter((name) => name !== 'totalfinance' && !PREVIEW_TIER.has(name));
    expect([...namespaced].sort()).toEqual(domain.sort());
    expect(domain.length).toBe(sourceMembers.length - 1 - PREVIEW_TIER.size);
  });

  it('every domain namespace is also an umbrella subpath, and every package has a README with a fenced example', () => {
    const umbrella = byName.get(UMBRELLA)!.manifest.exports ?? {};
    for (const m of sourceMembers) {
      if (m.dir === 'totalfinance' || m.dir === 'mcp') continue;
      expect(umbrella, `totalfinance/${m.dir}`).toHaveProperty(`./${m.dir}`);
    }
    for (const m of members) {
      const readme = join(m.path, 'README.md');
      expect(existsSync(readme), m.manifest.name).toBe(true);
      expect(readFileSync(readme, 'utf8')).toMatch(/```ts\n/);
    }
  });
});

describe('FC9 rows 2–5 — the gates that carry the cold-user, parity, generated-evidence, and packed-consumer rows', () => {
  const rehearsals = [
    ['cold user — the five-minute journey', 'docs/examples/five-minute-journey.test.ts'],
    [
      'cold user — one executable snippet per package README',
      'docs/examples/readme-snippets.test.ts',
    ],
    ['semantic parity — SDK / CLI / HTTP / MCP', 'tools/transport-parity.test.ts'],
    ['generated evidence — the docs and reports inventory', 'tools/generated-docs.test.ts'],
    [
      'generated evidence — the manifest contract conformance',
      'tools/manifest/contract-conformance.test.ts',
    ],
    ['packed consumer — clean installs from pnpm pack tarballs', 'tools/packed-consumer.test.ts'],
  ] as const;

  it.each(rehearsals)('%s is present and runs in the suite', (_row, file) => {
    expect(existsSync(join(ROOT, file)), file).toBe(true);
    const vitestConfig = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(vitestConfig, `${file} must not be excluded from the suite`).not.toContain(file);
  });

  it('the ci script runs format, lint, typecheck, build, coverage, and the api check in that order', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts['ci']).toBe(
      'pnpm format:check && pnpm lint && pnpm typecheck && pnpm site:typecheck && pnpm build && pnpm site:build && pnpm site:test && pnpm test:coverage && pnpm api:check',
    );
  });
});

describe('FC9 row 6 — community and security files (Decision 5) and rollback ownership (Decision 7)', () => {
  it.each(['SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md'])(
    '%s exists at the root and is not empty',
    (file) => {
      const path = join(ROOT, file);
      expect(existsSync(path), file).toBe(true);
      expect(readFileSync(path, 'utf8').trim().length).toBeGreaterThan(400);
    },
  );

  it('SECURITY.md names the supported release and says how to report privately', () => {
    const text = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
    expect(text).toContain('0.1.0');
    expect(text).not.toContain('0.1.0-preview.N');
    expect(text).toContain('security/advisories/new');
  });

  it('the rollback runbook exists, names its owner, and carries the dist-tag command', () => {
    const text = readFileSync(join(ROOT, 'docs', 'runbooks', 'release-rollback.md'), 'utf8');
    expect(text).toMatch(/\*\*Owner:\*\*/);
    expect(text).toContain('npm dist-tag add');
    expect(text).toContain('npm deprecate');
    expect(text).toContain('72');
  });
});

describe('FC9 row 6 — release plumbing (Decisions 6 and 9): the every-public-publish gate exists before the first publish', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('the dry-run, local publish, and registry smoke scripts exist and point at tools/release', () => {
    expect(root.scripts['release:dry-run']).toBe('tsx tools/release/dry-run.ts');
    expect(root.scripts['release:publish']).toBe('tsx tools/release/publish-tarballs.ts');
    expect(root.scripts['release:smoke']).toBe('tsx tools/release/registry-smoke.ts');
    for (const file of [
      'dry-run.ts',
      'publish-tarballs.ts',
      'registry-smoke.ts',
      'changelog-excerpt.ts',
      'verdaccio.yaml',
    ]) {
      expect(existsSync(join(ROOT, 'tools', 'release', file)), file).toBe(true);
    }
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n')).toContain('/release/');
  });

  it('the release workflow is dispatch-only, gated by the npm-publish environment, attests provenance, tags, and releases', () => {
    const candidates = [join(ROOT, '.github', 'workflows', 'totalfinance-release.yml')];
    const path = candidates.find((candidate) => existsSync(candidate));
    expect(
      path,
      'totalfinance-release.yml must exist in the standalone repository root',
    ).toBeDefined();
    const workflow = readFileSync(path!, 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^on:\n\s+push:/m);
    expect(workflow).toContain('name: npm-publish');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('pnpm release:publish --dir release/approved --tag candidate');
    expect(workflow).toContain('TOTALFINANCE_RELEASE_ENABLED');
    expect(workflow).not.toContain('pnpm -r');
    expect(workflow).toContain('--expect-version "$RELEASE_VERSION"');
    expect(workflow).toContain('tools/release/finalize-github-release.ts');
    expect(workflow).toContain('--expect-version "$RELEASE_VERSION" --finalize');
    expect(workflow).toContain('pnpm release:smoke --version "$RELEASE_VERSION"');
  });

  it('the CI workflow rehearses the publish against a local registry on every push', () => {
    const candidates = [join(ROOT, '.github', 'workflows', 'totalfinance-ci.yml')];
    const path = candidates.find((candidate) => existsSync(candidate));
    expect(path).toBeDefined();
    const workflow = readFileSync(path!, 'utf8');
    expect(workflow).toContain('release-rehearsal:');
    expect(workflow).toContain('verdaccio@6 --config tools/release/verdaccio.yaml');
    expect(workflow).toContain('pnpm release:publish --registry http://localhost:4873');
    expect(workflow).toContain('--registry http://localhost:4873');
    expect(workflow).toContain('pnpm release:smoke --version');
  });

  it('the smoke expectations are committed and describe the whole fixed group', () => {
    const expected = JSON.parse(
      readFileSync(join(ROOT, 'tools', 'release', 'smoke-expected.json'), 'utf8'),
    ) as {
      packages: number;
      operations: number;
      openapi: { version: string; paths: number };
      mcp: { tools: number };
    };
    expect(expected.packages).toBe(members.length);
    expect(expected.operations).toBeGreaterThan(0);
    expect(expected.openapi.version).toBe('3.1.0');
    expect(expected.openapi.paths).toBeGreaterThanOrEqual(expected.operations);
    expect(expected.mcp.tools).toBeGreaterThan(0);
  });

  it('the local-registry config serves the public scope from the rehearsal only (no uplink), and the release runbooks exist', () => {
    const config = readFileSync(join(ROOT, 'tools', 'release', 'verdaccio.yaml'), 'utf8');
    const scope = config.slice(config.indexOf("'@insiderfinance/*':"), config.indexOf("'**':"));
    expect(scope).not.toContain('proxy:');
    expect(scope).toContain("'@insiderfinance/*':");
    expect(existsSync(join(ROOT, 'docs', 'runbooks', 'release.md'))).toBe(true);
  });
});
