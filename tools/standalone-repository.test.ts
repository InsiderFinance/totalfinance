import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultTools } from '../packages/mcp/src/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const historical = 'docs/evidence/release-dry-run-0.0.1-rehearsal.json';
// Split deliberately so the removal gate cannot rewrite its own target in a future migration.
const retiredBrand = new RegExp(['quant', 'kit'].join(''), 'i');
const retiredFlag = new RegExp(['Q', 'K_'].join(''));

describe('the standalone TotalFinance repository', () => {
  it('is the Git root, without a parent application or nested library checkout', () => {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    expect(top).toBe(ROOT);
    for (const path of ['packages', 'tools', 'site', 'docs', '.github/workflows'])
      expect(existsSync(resolve(ROOT, path)), path).toBe(true);
    for (const path of [
      'src/pages',
      'src/screens',
      'functions',
      'totalfinance/packages',
      'next.config.js',
    ])
      expect(existsSync(resolve(ROOT, path)), path).toBe(false);
  });

  it('has one current brand across tracked and newly added source, docs, paths and artifacts', () => {
    const files = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    )
      .split('\0')
      .filter(Boolean);
    // `--cached` includes tracked removals until commit. Audit the actual worktree, while still
    // including all untracked additions; deleting retired Changesets files is a valid change.
    const deleted = new Set(
      execFileSync('git', ['ls-files', '-z', '--deleted'], { cwd: ROOT, encoding: 'utf8' }).split(
        '\0',
      ),
    );
    expect(files.length).toBeGreaterThan(1500);
    const violations = [...new Set(files)].filter((path) => {
      if (deleted.has(path)) return false;
      if (path === historical) return false;
      if (retiredBrand.test(path) || /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key)$/.test(path)) return true;
      const bytes = readFileSync(resolve(ROOT, path));
      if (bytes.includes(0)) return false;
      const source = bytes.toString('utf8');
      return retiredBrand.test(source) || retiredFlag.test(source);
    });
    expect(violations).toEqual([]);
  });

  it('preserves the historical rehearsal as historical bytes, not renamed release evidence', () => {
    expect(createHash('sha256').update(read(historical)).digest('hex')).toBe(
      '490d1d15ad693fc9d10fc81948fc0214c49f389089d6a4441fddc719634a1187',
    );
    expect(read('docs/evidence/README.md')).toContain('not approval');
  });

  it('keeps source identities private and names the exact two public distribution workspaces', () => {
    for (const directory of readdirSync(resolve(ROOT, 'packages'))) {
      const pkg = JSON.parse(read(`packages/${directory}/package.json`));
      expect(pkg.private).toBe(true);
      expect(pkg.name).toBe(
        directory === 'totalfinance' ? 'totalfinance' : `@totalfinance/${directory}`,
      );
      expect(pkg.repository.url).toBe('git+https://github.com/InsiderFinance/totalfinance.git');
      expect(pkg.repository.directory).toBe(`packages/${directory}`);
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
      expect(read(`packages/${directory}/etc/${directory}.api.md`).split('\n')[0]).toBe(
        `# ${pkg.name} — public API`,
      );
    }
    for (const [directory, name] of [
      ['totalfinance', '@insiderfinance/totalfinance'],
      ['mcp', '@insiderfinance/totalfinance-mcp'],
    ]) {
      const pkg = JSON.parse(read(`distribution/${directory}/package.json`));
      expect(pkg.name).toBe(name);
      expect(pkg.private).not.toBe(true);
      expect(pkg.repository.url).toBe('git+https://github.com/InsiderFinance/totalfinance.git');
      expect(pkg.repository.directory).toBe(`distribution/${directory}`);
      expect(pkg.version).toBe(JSON.parse(read('distribution/totalfinance/package.json')).version);
    }
    expect(JSON.parse(read('.changeset/config.json')).baseBranch).toBe('main');
    expect(JSON.parse(read('.changeset/config.json')).fixed).toEqual([
      ['@insiderfinance/totalfinance', '@insiderfinance/totalfinance-mcp'],
    ]);
    expect(JSON.parse(read('.changeset/config.json')).privatePackages).toEqual({
      version: false,
      tag: false,
    });
    expect(existsSync(resolve(ROOT, '.changeset/pre.json'))).toBe(false);
  });

  it('recomputes the release-smoke MCP identity from the renamed tool names', () => {
    const names = defaultTools()
      .map((tool) => tool.name)
      .sort();
    const expected = JSON.parse(read('tools/release/smoke-expected.json'));
    expect(expected.mcp).toEqual({
      tools: names.length,
      namesSha256: createHash('sha256').update(names.join('\n')).digest('hex'),
    });
    expect(names.every((name) => name.startsWith('totalfinance_'))).toBe(true);
  });

  it('runs CI from the root on main and PRs, with supported Nodes and a pinned regeneration runtime', () => {
    const ci = read('.github/workflows/totalfinance-ci.yml');
    expect(ci).toContain('branches: [main]');
    expect(ci).toContain('pull_request:');
    expect(ci).not.toContain('paths:');
    expect(ci).not.toContain('working-directory:');
    expect(ci).toContain("node: ['22.13.0', '24.x', '26.x']");
    expect(ci).toContain('node-version-file: .nvmrc');
    expect(read('.nvmrc').trim()).toMatch(/^22\.\d+\.\d+$/);
    expect(ci).toContain('cache-dependency-path: pnpm-lock.yaml');
    expect(ci).toContain('pnpm regen:check');
    expect(ci).toContain('git diff --no-ext-diff -- tools/manifest/public-enforcement.json');
  });

  it('keeps npm publication disabled until separately enabled and approved', () => {
    const release = read('.github/workflows/totalfinance-release.yml');
    expect(release).toContain('workflow_dispatch:');
    expect(release).toContain('vars.TOTALFINANCE_RELEASE_ENABLED');
    expect(release).toContain('refs/heads/main');
    expect(release).toContain('name: npm-publish');
    expect(release).not.toContain('steps.where');
    expect(release).not.toContain('working-directory:');
    expect(release).toContain('package_json_file: package.json');
    expect(release).toContain('pnpm release:publish --dir release/approved --tag candidate');
    expect(release).toContain('distribution/${dir}/package.json');
    expect(release).toContain("node-version: '24.21.0'");
    expect(release).toContain('id-token: write');
    expect(release).toContain('--expect-version "$RELEASE_VERSION" --resume');
    expect(release).toContain('--registry https://registry.npmjs.org --approved release/approved');
    expect(release).toContain('NPM_BOOTSTRAP_TOKEN');
    expect(release).toContain('default: false');
    expect(release).not.toContain('--tag latest');
    expect(release).not.toContain('npm dist-tag add');
    expect(read('.github/workflows/totalfinance-ci.yml')).toContain(
      "require('./distribution/totalfinance/package.json').version",
    );
  });
});
