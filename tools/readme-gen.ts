/**
 * Generate each `packages/<pkg>/README.md` (spec DX4.2) from the LIVE sources — the package
 * manifest, its committed API report (`etc/<pkg>.api.md`), one CI-run example extracted from
 * `docs/examples/readme-snippets.test.ts`, the HTTP-owned authentication fragment, and (for
 * `@totalfinance/technical-analysis`) the alias/compatibility table.
 *
 * Deterministic (sorted, no clock), committed, and drift-checked (`tools/readme-gen.test.ts`). The
 * examples come from a test that runs in CI, so a README example can never rot. Regenerate with
 * `pnpm tsx tools/readme-gen.ts` after any public-API or example change.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALIAS_TABLE } from '../packages/technical-analysis/src/aliases.js';
import { REGISTRY_PROFILES } from '../packages/workflows/src/local/profiles.js';
import {
  MCP_PUBLISHED_ON_NPM,
  SOURCE_BINARY,
  clientSetup,
  computeServer,
  type ClientId,
} from '../site/src/agents.js';
import { configureMcpServer } from '../packages/mcp/src/server.js';
import { PUBLIC_PACKAGE_NAME, toPublicSpecifier } from './public-packages.js';
import { publicDocumentationText } from './public-reference.js';

const ROOT = new URL('../', import.meta.url);
const SNIPPETS_PATH = fileURLToPath(new URL('docs/examples/readme-snippets.test.ts', ROOT));

// Canonical standalone repository, selected by the maintainer; audited against every manifest.
const REPO_URL = 'https://github.com/InsiderFinance/totalfinance';

/** api-report export kinds that exist at runtime (everything else is type-only). */
const RUNTIME_KINDS = new Set(['const', 'function', 'class', 'enum', 'namespace', 'let', 'var']);

interface PkgInfo {
  /** Directory under `packages/` (also the api-report basename). */
  dir: string;
  name: string;
  version: string;
  description: string;
  entrypoints: string[];
  /** Total exports in the API report (runtime values + type-only exports). */
  exportCount: number;
  /** Exports that exist at runtime (const/function/class/enum/namespace). */
  runtimeExportCount: number;
}

/** Read every workspace package's manifest + its API-report export count. */
function gatherPackages(): PkgInfo[] {
  const dir = fileURLToPath(new URL('packages', ROOT));
  const out: PkgInfo[] = [];
  for (const pkg of readdirSync(dir).sort()) {
    let manifest: {
      name?: string;
      version?: string;
      description?: string;
      exports?: Record<string, unknown>;
    };
    try {
      manifest = JSON.parse(readFileSync(`${dir}/${pkg}/package.json`, 'utf8'));
    } catch {
      continue;
    }
    if (!manifest.name) continue;
    if (!manifest.version) throw new Error(`Missing package version: ${pkg}`);
    const entrypoints = Object.keys(manifest.exports ?? {})
      .filter((e) => e !== './package.json')
      .sort();
    let exportCount = 0;
    let runtimeExportCount = 0;
    try {
      const api = readFileSync(`${dir}/${pkg}/etc/${pkg}.api.md`, 'utf8');
      for (const line of api.split('\n')) {
        const kind = line.match(/^- `(\w+) /)?.[1];
        if (!kind) continue;
        exportCount += 1;
        if (RUNTIME_KINDS.has(kind)) runtimeExportCount += 1;
      }
    } catch {
      /* a package without an API report contributes a 0 count */
    }
    out.push({
      dir: pkg,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? '',
      entrypoints,
      exportCount,
      runtimeExportCount,
    });
  }
  return out;
}

/**
 * Extract the `readme:begin`/`readme:end` block from each `it('<pkg>', …)` in the snippets test,
 * dedented, with `// import …` lines un-commented so the README shows real imports.
 */
function extractSnippets(): Map<string, string> {
  const lines = readFileSync(SNIPPETS_PATH, 'utf8').split('\n');
  const map = new Map<string, string>();
  let current: string | null = null;
  let collecting = false;
  let buf: string[] = [];
  for (const line of lines) {
    const itMatch = line.match(/^\s*it\('([^']+)',/);
    if (itMatch) {
      current = itMatch[1] ?? null;
      continue;
    }
    if (/^\s*\/\/ readme:begin\s*$/.test(line)) {
      collecting = true;
      buf = [];
      continue;
    }
    if (/^\s*\/\/ readme:end\s*$/.test(line)) {
      if (current) map.set(toPublicSpecifier(current), dedentAndUncomment(buf));
      collecting = false;
      current = null;
      continue;
    }
    if (collecting) buf.push(line);
  }
  return map;
}

function dedentAndUncomment(lines: string[]): string {
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^\s*/)?.[0].length ?? 0);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l) => l.slice(min))
    .map((l) => l.replace(/^\/\/ (import .*)$/, '$1'))
    .join('\n')
    .trim();
}

/** A representative slice of the ta alias/compatibility table (deterministic: first rows w/ TA-Lib). */
function taAliasSection(): string {
  const rows = ALIAS_TABLE.filter((r) => r.talib && r.tradingview).slice(0, 10);
  const body = rows
    .map((r) => `| \`${r.totalfinance}\` | \`${r.talib}\` | ${r.tradingview} |`)
    .join('\n');
  return [
    '## Aliases & compatibility',
    '',
    'Indicators are addressable by their TotalFinance name and by common TA-Lib / TradingView aliases — ' +
      '`resolveIndicator(name)` normalizes any of them. A sample of the alias table:',
    '',
    '| TotalFinance | TA-Lib | TradingView |',
    '| --- | --- | --- |',
    body,
  ].join('\n');
}

/** Subpath examples: `it('<pkg>/<subpath>', …)` blocks render as their own sections after the root example. */
function subpathSnippetsOf(
  snippets: Map<string, string>,
  pkg: PkgInfo,
): { specifier: string; snippet: string }[] {
  // Root examples belong to their domain READMEs, not to the umbrella a second time.
  if (pkg.dir === 'totalfinance') return [];
  const prefix = `${toPublicSpecifier(pkg.name)}/`;
  return [...snippets.entries()]
    .filter(([name]) => name.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([specifier, snippet]) => ({ specifier, snippet }));
}

/** Tools a profile lists with default options, counted by the server's own configuration. */
function profileToolCount(profile: (typeof REGISTRY_PROFILES)[number]): number {
  return configureMcpServer({ profile }).capabilities.tools.length;
}

/** One client's setup steps from the site's generator, so the README and /agents never disagree. */
function clientSection(client: ClientId, version: string, published: boolean): string[] {
  const setup = clientSetup(client, computeServer({ published, version }));
  if (!setup) throw new Error(`No MCP setup for ${client}`);
  const lines = [`### ${setup.label}`, ''];
  for (const step of setup.steps) {
    if (step.kind === 'note') lines.push(step.text, '');
    else if (step.kind === 'command')
      lines.push(`${step.label}:`, '', '```sh', step.code, '```', '');
    else
      lines.push(
        `${step.label} (\`${step.path}\`):`,
        '',
        `\`\`\`${step.lang}`,
        step.code,
        '```',
        '',
      );
  }
  return lines;
}

/**
 * The MCP package's README is its npm page, so it describes using the server. While the package
 * is not on npm (`MCP_PUBLISHED_ON_NPM` in site/src/agents.ts) it says so and gives the source
 * build; flipping that flag switches this README, the site and llms.txt to `npx` together.
 */
function mcpReadme(pkg: PkgInfo, snippet: string | undefined, published: boolean): string {
  const run = published ? `npx -y ${pkg.name}@${pkg.version}` : `node ${SOURCE_BINARY}`;
  const lines: string[] = [
    `# ${pkg.name}`,
    '',
    `> ${pkg.description}`,
    '',
    `The [TotalFinance](${REPO_URL}#readme) calculations as tools for AI agents: option pricing and Greeks, ` +
      'strategies, volatility, technical indicators, portfolio P&L, risk, bonds and backtests. The server runs ' +
      'on your machine over stdio and is read-only by default. Your agent supplies the market inputs; every ' +
      'result carries its `assumptions` and `diagnostics`, and any warning (such as a volatility of 22 that ' +
      'was probably meant as 0.22) is repeated in the text the model reads.',
    '',
    '## Install',
    '',
    ...(published
      ? [
          'Requires Node 22.13 or later. There is nothing to install globally; check that it runs:',
          '',
          '```sh',
          `${run} doctor`,
          '```',
        ]
      : [
          `Version ${pkg.version} is not on npm yet. Build it from a source checkout (Node 22.13 or later):`,
          '',
          '```sh',
          `git clone ${REPO_URL}.git`,
          'cd totalfinance',
          'pnpm install --frozen-lockfile',
          'pnpm build',
          'node distribution/mcp/dist/bin.js doctor',
          '```',
          '',
          `In the client setups below, replace \`${SOURCE_BINARY}\` with the absolute path to`,
          '`distribution/mcp/dist/bin.js` in your checkout.',
        ]),
    '',
    '## Connect your agent',
    '',
    `The [agents page](https://www.totalfinance.io/docs/totalfinance/agents) has the same setups, plus one-click installs where a client supports them.`,
    '',
    ...(['claude-code', 'claude-desktop', 'cursor', 'vscode', 'codex'] as const).flatMap((client) =>
      clientSection(client, pkg.version, published),
    ),
    '## Choose the tools',
    '',
    `Without options the server lists the **${profileToolCount('default')} default tools**. A profile picks a ` +
      'focused set; profiles never grant permissions:',
    '',
    '| Profile | Tools |',
    '| ------- | ----: |',
    ...REGISTRY_PROFILES.map((profile) => `| \`${profile}\` | ${profileToolCount(profile)} |`),
    '',
    '```sh',
    `${run} --profile options`,
    `${run} doctor --profile full`,
    '```',
    '',
    'Some clients limit how many tools they load at once, so prefer a focused profile to `full`. `doctor` ' +
      'reports the Node version check, the tools a configuration exposes and why any are excluded, the attached ' +
      'store and the input budgets. Tool lists and resource lists are paged: follow `nextCursor`.',
    '',
    '## Saved reports, background jobs and paper trading',
    '',
    'These are off unless you turn them on:',
    '',
    '- `--store /absolute/path/to/folder` saves large results as reports the agent can read back as resources. ' +
      '`--store-read-only` only reads an existing folder.',
    '- `--jobs` (with a writable `--store`) runs long calculations such as backtests in a background worker. ' +
      'The agent starts one with `totalfinance_job_submit`, then checks `totalfinance_job_status`, reads ' +
      '`totalfinance_job_result` or stops it with `totalfinance_job_cancel`.',
    '- `--capability <name>` (repeatable) allows write tools. `--capability trade:paper` adds paper-trading ' +
      'tools, which simulate orders locally and never reach a broker. The capabilities you pass replace the ' +
      'defaults (`portfolio:read`, `analytics:run`, `trade:propose`), so list every one you need.',
    '',
    '```sh',
    `${run} --profile backtesting --store /absolute/path/to/folder --jobs`,
    `${run} --profile full --store /absolute/path/to/folder --capability portfolio:read --capability analytics:run --capability trade:propose --capability trade:paper`,
    '```',
    '',
    `The [MCP guide](${REPO_URL}/blob/main/docs/guides/mcp.md) is the full reference: every tool, resource ` +
      'and prompt, the result envelope, errors, budgets and the job lifecycle.',
    '',
  ];
  if (snippet) {
    lines.push(
      '## Use it as a library',
      '',
      'Embed the server or its tool definitions in your own host:',
      '',
      '```ts',
      snippet,
      '```',
      '',
      '_This example runs in CI (`docs/examples/readme-snippets.test.ts`) — it cannot rot._',
      '',
    );
  }
  lines.push(
    '## API',
    '',
    `\`${pkg.name}\` exposes **${pkg.runtimeExportCount}** runtime exports (**${pkg.exportCount}** including ` +
      'types). See the generated ' +
      `[\`etc/${pkg.dir}.api.md\`](${REPO_URL}/blob/main/packages/${pkg.dir}/etc/${pkg.dir}.api.md) ` +
      'for the full surface.',
    '',
    '## License',
    '',
    `Apache-2.0. Part of the [TotalFinance](${REPO_URL}#readme) monorepo. Analytics only — not ` +
      'investment advice.',
    '',
    '<!-- Generated by tools/readme-gen.ts from package.json + etc/*.api.md + site/src/agents.ts + ' +
      'docs/examples/readme-snippets.test.ts. Do not edit by hand; run `pnpm tsx tools/readme-gen.ts`. -->',
  );
  return `${publicDocumentationText(lines.join('\n'))}\n`;
}

function buildReadme(
  pkg: PkgInfo,
  snippet: string | undefined,
  aliasSection: string,
  subpathSnippets: { specifier: string; snippet: string }[] = [],
): string {
  if (pkg.dir === 'mcp') return mcpReadme(pkg, snippet, MCP_PUBLISHED_ON_NPM);
  const entry =
    pkg.entrypoints.length === 1
      ? '1 entrypoint'
      : `${pkg.entrypoints.length} entrypoints (${pkg.entrypoints.map((e) => `\`${e}\``).join(', ')})`;
  const lines: string[] = [
    `# ${pkg.name}`,
    '',
    `> ${pkg.description}`,
    '',
    // Absolute URLs: package READMEs render on npmjs.com, where relative repo links are dead.
    `Part of **[TotalFinance](${REPO_URL}#readme)** — a TypeScript quant toolkit with browser-safe calculation entry points. ` +
      'The main package has no runtime dependencies; optional MCP adds the MCP SDK. On the pro API every result carries its `assumptions` ' +
      'and `diagnostics` (model, conventions, seed, convergence) so nothing is hidden.',
    '',
    '## Install',
    '',
    `Source version ${pkg.version}: this command describes the planned published experience, not a verified npm installation. ` +
      `Until publication, use a [source checkout](${REPO_URL}#contributing).`,
    '',
    '```sh',
    `pnpm add ${PUBLIC_PACKAGE_NAME}@${pkg.version}`,
    '```',
    '',
  ];
  if (snippet) {
    lines.push(
      '## Example',
      '',
      '```ts',
      snippet,
      '```',
      '',
      '_This example runs in CI (`docs/examples/readme-snippets.test.ts`) — it cannot rot._',
      '',
    );
  }
  lines.push(
    '## Imports and bundles',
    '',
    'For portable browser tree shaking, use named imports from `@insiderfinance/totalfinance/<domain>` ' +
      'or supported feature subpaths such as `@insiderfinance/totalfinance/math/normal`. ' +
      'Use public exports, never private `dist` paths.',
    '',
    'Installation size is not final bundle size: one main package contains all domains; a bundler removes unused code. ' +
      'The main package has no runtime dependencies. MCP is a separate optional package. ' +
      'Plain Node ESM performs no automatic dead-code elimination. Facades include validation and `.explain()` services; ' +
      'indicators also carry streaming support, not just a bare formula. Type-only imports add no runtime code.',
    '',
  );
  if (pkg.name === 'totalfinance') {
    lines.push(
      'The root keeps every domain as a namespace and hoists only five option gestures: ' +
        '`blackScholes`, `option`, `market`, `engines`, `impliedVolatility`.',
      '',
      "`import { math } from 'totalfinance'` followed by `math.normalCdf(0)` retains the whole math namespace in esbuild " +
        '([issue #1420](https://github.com/evanw/esbuild/issues/1420)); Rollup shakes this static use. ' +
        "Direct `import * as math from 'totalfinance/math'` with static member use also shakes. " +
        'Dynamic namespace access, enumeration, and registries retain the implementations they can reach.',
      '',
    );
  }
  lines.push(
    `See [Imports and bundles](${REPO_URL}/blob/main/docs/guides/imports-and-bundles.md) ` +
      'for examples, namespace tradeoffs, and the generated measurement report.',
    '',
  );
  for (const subpath of subpathSnippets) {
    lines.push(
      `## Example — \`${subpath.specifier}\``,
      '',
      '```ts',
      subpath.snippet,
      '```',
      '',
      '_This example runs in CI (`docs/examples/readme-snippets.test.ts`) — it cannot rot._',
      '',
    );
  }
  if (aliasSection) lines.push(aliasSection, '');
  if (pkg.name === '@totalfinance/http') {
    lines.push(readFileSync(new URL('packages/http/README-auth.md', ROOT), 'utf8').trim(), '');
  }
  const typeOnlyCount = pkg.exportCount - pkg.runtimeExportCount;
  const surface =
    typeOnlyCount > 0
      ? `**${pkg.runtimeExportCount}** runtime exports (**${pkg.exportCount}** including types)`
      : `**${pkg.exportCount}** public exports`;
  lines.push(
    '## API',
    '',
    `\`${pkg.name}\` exposes ${surface} across ${entry}. See the generated ` +
      `[\`etc/${pkg.dir}.api.md\`](${REPO_URL}/blob/main/packages/${pkg.dir}/etc/${pkg.dir}.api.md) ` +
      'for the full surface.',
    '',
    '## License',
    '',
    `Apache-2.0. Part of the [TotalFinance](${REPO_URL}#readme) monorepo. Analytics only — not ` +
      'investment advice.',
    '',
    '<!-- Generated by tools/readme-gen.ts from package.json + etc/*.api.md + ' +
      'docs/examples/readme-snippets.test.ts. Do not edit by hand; run `pnpm tsx tools/readme-gen.ts`. -->',
  );
  return `${publicDocumentationText(lines.join('\n'))}\n`;
}

/** Build every package README from the live sources (pure — deterministic given repo state). */
export function buildReadmes(): { dir: string; content: string }[] {
  const snippets = extractSnippets();
  return gatherPackages().map((pkg) => ({
    dir: pkg.dir,
    content: buildReadme(
      pkg,
      snippets.get(toPublicSpecifier(pkg.name)),
      pkg.name === '@totalfinance/technical-analysis' ? taAliasSection() : '',
      subpathSnippetsOf(snippets, pkg),
    ),
  }));
}

/** The MCP README in either publication state, so tests cover the one not yet committed. */
export function buildMcpReadme(published: boolean): string {
  const pkg = gatherPackages().find((candidate) => candidate.dir === 'mcp')!;
  return mcpReadme(pkg, extractSnippets().get(toPublicSpecifier(pkg.name)), published);
}

// Direct-run entry: write each README. `import.meta.url` ends with this file when run via tsx.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = buildReadmes();
  for (const { dir, content } of built) {
    writeFileSync(fileURLToPath(new URL(`packages/${dir}/README.md`, ROOT)), content);
  }
  process.stdout.write(`readme-gen: wrote ${built.length} package READMEs\n`);
}
