/**
 * The preview-surface audit (Stage 5A, Decision 4): FC9's launch checks, rehearsed over the current
 * surface on every push rather than discovered at release time.
 *
 * Each `describe` names the FC9 row it rehearses. Where an existing gate already proves a row
 * (transport parity, the packed consumer, the readme snippets, the generated-docs inventory), this
 * audit asserts that gate is present and wired into the suite instead of running it twice — the
 * audit is a table of contents over the evidence, not a second copy of it. What it proves directly
 * is what no other gate reads: the published metadata of every package in the fixed group
 * (Decision 3), the stability statement that ships inside each of them (Decision 2), the community
 * and security files (Decision 5), and that the built artifacts carry the maps that make `src`
 * worth shipping.
 *
 * Fail-closed by construction: the fixed group is READ from `packages/*` (not listed here), so a
 * new package is audited the moment its directory exists, and every rule below is checked against
 * every member.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPackageDirectories } from './first-touch/sweep-roster.js';

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
const TRANSPORTS_WITH_BIN = new Set([
  '@totalfinance/cli',
  '@totalfinance/http',
  '@totalfinance/mcp',
]);
const UMBRELLA = 'totalfinance';
const REQUIRED_FILES = ['dist', 'src', 'etc', 'LICENSE', 'STABILITY.md', '!dist/.tsbuildinfo'];
// Exact, reviewed public guide additions; never a wildcard that could ship internal planning.
const PUBLIC_GUIDES: Readonly<Record<string, readonly string[]>> = {
  '@totalfinance/structure': ['OPTION-FLOW-DRIFT.md'],
};
const NODE_FLOOR = '>=22.13.0';
const PRE_TAG = 'preview';

const members: Member[] = readPackageDirectories().map(({ dir }) => {
  const path = join(PKG_ROOT, dir);
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Manifest;
  return { dir, path, manifest };
});
const byName = new Map(members.map((m) => [m.manifest.name, m]));

/** Every member's short domain word: the directory name (`@totalfinance/foreign-exchange` → `foreign-exchange`). */
function domainWord(member: Member): string {
  return member.dir;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** The English number words `STABILITY.md` may use for the group size, so the count is a claim the file makes. */
const NUMBER_WORDS: Record<string, number> = {
  twenty: 20,
  'twenty-one': 21,
  'twenty-two': 22,
  'twenty-three': 23,
  'twenty-four': 24,
  'twenty-five': 25,
  'twenty-six': 26,
  'twenty-seven': 27,
  'twenty-eight': 28,
  'twenty-nine': 29,
  thirty: 30,
};

describe('preview-surface audit — the fixed group is read from the filesystem (not vacuous)', () => {
  it('finds the whole fixed group', () => {
    expect(members.length).toBeGreaterThanOrEqual(25);
    for (const name of ['@totalfinance/core', UMBRELLA, ...PREVIEW_TIER])
      expect(byName.has(name)).toBe(true);
  });

  it('every member is publishable (not private) and shares one version', () => {
    const versions = new Set(members.map((m) => m.manifest.version));
    expect([...versions]).toHaveLength(1);
    for (const m of members) expect(m.manifest.private ?? false, m.manifest.name).toBe(false);
  });
});

describe('FC9 row 6 — metadata (Decision 3), enumerated per package, fails on the first miss', () => {
  it.each(members.map((m) => [m.manifest.name, m] as const))('%s', (_name, m) => {
    const p = m.manifest;
    expect(p.description?.trim().length ?? 0).toBeGreaterThan(0);
    expect(p.keywords ?? []).toContain('totalfinance');
    expect(p.keywords ?? []).toContain(domainWord(m));
    expect(p.license).toBe('Apache-2.0');
    expect(existsSync(join(m.path, 'LICENSE'))).toBe(true);
    expect(p.repository?.type).toBe('git');
    expect(p.repository?.url).toBe(`git+${PUBLIC_REPOSITORY}.git`);
    expect(p.repository?.directory).toBe(`packages/${m.dir}`);
    expect(p.homepage?.startsWith(PUBLIC_REPOSITORY)).toBe(true);
    const bugs = typeof p.bugs === 'string' ? p.bugs : p.bugs?.url;
    expect(bugs?.startsWith(PUBLIC_REPOSITORY)).toBe(true);
    expect(p.type).toBe('module');
    expect(p.sideEffects).toBe(false);
    expect(p.main).toBe('./dist/index.js');
    expect(p.module).toBe('./dist/index.js');
    expect(p.types).toBe('./dist/index.d.ts');
    expect(p.files).toEqual([
      ...REQUIRED_FILES.slice(0, -1),
      ...(PUBLIC_GUIDES[p.name] ?? []),
      REQUIRED_FILES[REQUIRED_FILES.length - 1],
    ]);
    expect(p.engines?.node).toBe(NODE_FLOOR);
    expect(p.publishConfig).toEqual({ access: 'public', provenance: true });
    // dependencies: workspace protocol or a pinned third-party range; never a devDependency leaked in
    for (const [dep, range] of Object.entries(p.dependencies ?? {})) {
      expect(range === 'workspace:*' || /^[\^~]?\d/.test(range), `${dep}: ${range}`).toBe(true);
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
        expect(target.startsWith('./dist/'), `${name} ${command}`).toBe(true);
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
      const dist = join(m.path, 'dist');
      expect(existsSync(dist), `${m.manifest.name}: dist missing (run pnpm build)`).toBe(true);
      const files = walk(dist);
      const set = new Set(files);
      const missing: string[] = [];
      for (const f of files) {
        if (f.endsWith('.js') && !set.has(`${f}.map`)) missing.push(f);
        if (f.endsWith('.d.ts') && !set.has(f.replace(/\.d\.ts$/, '.d.ts.map'))) missing.push(f);
      }
      expect(missing, m.manifest.name).toEqual([]);
      expect(existsSync(join(m.path, 'src')), `${m.manifest.name}: src`).toBe(true);
    }
  });
});

describe('FC9 row 6 — the stability statement (Decision 2)', () => {
  const rootStability = readFileSync(join(ROOT, 'STABILITY.md'), 'utf8');

  it('STABILITY.md exists at the root, names the three tiers, and states the series', () => {
    for (const tier of ['stable-by-law', 'preview', 'experimental'])
      expect(rootStability).toContain(`**${tier}**`);
    expect(rootStability).toContain('0.1.0-preview.N');
  });

  it('its package count is the fixed group, and it names every member', () => {
    const match = /\b(twenty(?:-[a-z]+)?|thirty)\b packages move together/i.exec(rootStability);
    expect(match, 'STABILITY.md must state how many packages move together').not.toBeNull();
    expect(NUMBER_WORDS[match![1]!.toLowerCase()]).toBe(members.length);
    for (const m of members) {
      const spelled = m.manifest.name === UMBRELLA ? '`totalfinance`' : `\`${m.manifest.name}\``;
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
    for (const m of members) {
      const expected = PREVIEW_TIER.has(m.manifest.name) ? 'preview' : 'stable-by-law';
      const label =
        m.manifest.name === UMBRELLA ? '`totalfinance` (umbrella)' : `\`${m.manifest.name}\``;
      const row = tiers.split('\n').find((line) => line.startsWith(`| ${label}`));
      expect(row, `${m.manifest.name}: no row in docs/stability.md`).toBeDefined();
      expect(
        row!.includes(`| ${expected}`),
        `${m.manifest.name}: expected tier ${expected} in "${row}"`,
      ).toBe(true);
    }
  });

  it('changesets is in preview pre-mode over the whole fixed group', () => {
    const pre = JSON.parse(readFileSync(join(ROOT, '.changeset', 'pre.json'), 'utf8')) as {
      mode: string;
      tag: string;
      initialVersions: Record<string, string>;
    };
    expect(pre.mode).toBe('pre');
    expect(pre.tag).toBe(PRE_TAG);
    expect(Object.keys(pre.initialVersions).sort()).toEqual(
      members.map((m) => m.manifest.name).sort(),
    );
    const config = JSON.parse(readFileSync(join(ROOT, '.changeset', 'config.json'), 'utf8')) as {
      fixed: string[][];
      baseBranch: string;
      access: string;
    };
    expect(config.fixed).toEqual([['@totalfinance/*', 'totalfinance']]);
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
    const domain = members
      .map((m) => m.manifest.name)
      .filter((name) => name !== UMBRELLA && !PREVIEW_TIER.has(name));
    expect([...namespaced].sort()).toEqual(domain.sort());
    expect(domain.length).toBe(members.length - 1 - PREVIEW_TIER.size);
  });

  it('every domain namespace is also an umbrella subpath, and every package has a README with a fenced example', () => {
    const umbrella = byName.get(UMBRELLA)!.manifest.exports ?? {};
    for (const m of members) {
      if (m.manifest.name === UMBRELLA || PREVIEW_TIER.has(m.manifest.name)) continue;
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

  it('SECURITY.md supports the latest preview only and says how to report privately', () => {
    const text = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
    expect(text).toContain('0.1.0-preview.N');
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
    expect(workflow).toContain('pnpm release:publish --dir approved --tag preview');
    expect(workflow).not.toContain('pnpm -r');
    expect(workflow).toContain('--expect-version "$RELEASE_VERSION"');
    expect(workflow).toContain('git tag -a "totalfinance-v$RELEASE_VERSION"');
    expect(workflow).toContain('gh release create "totalfinance-v$RELEASE_VERSION"');
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

  it('the local-registry config serves the @totalfinance scope from the rehearsal only (no uplink), and the release runbooks exist', () => {
    const config = readFileSync(join(ROOT, 'tools', 'release', 'verdaccio.yaml'), 'utf8');
    const scope = config.slice(
      config.indexOf("'@totalfinance/*':"),
      config.indexOf("'totalfinance':"),
    );
    expect(scope).not.toContain('proxy:');
    expect(existsSync(join(ROOT, 'docs', 'runbooks', 'release.md'))).toBe(true);
  });
});
