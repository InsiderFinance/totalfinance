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
import { REGISTRY_PROFILES, packsForProfile } from '../packages/workflows/src/local/profiles.js';
import { MCP_PACKAGE_NAME, PUBLIC_PACKAGE_NAME, toPublicSpecifier } from './public-packages.js';
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

/** Public MCP setup belongs to this source template, never to a hand-edited generated README. */
function mcpSetupSection(): string {
  const profileNames = REGISTRY_PROFILES.map((name) => `\`${name}\``).join(', ');
  const defaultCount = packsForProfile('default').reduce(
    (count, pack) => count + pack.operations.length,
    0,
  );
  return [
    '## Local discovery and jobs',
    '',
    `The default server still exposes exactly **${defaultCount} compute tools**. Profiles select operations, not`,
    `permissions: ${profileNames}. Names and descriptions are discoverable at \`totalfinance://profiles\`, derived`,
    'from the shared workflows registry. Explicit `tools`/`packs` replace implicit profile selection;',
    '`packs: []` is empty. Binary `--packs` narrows the selected profile exactly.',
    '',
    '`totalfinance://capabilities` and `totalfinance-mcp doctor` report the effective tool set, excluded tools and',
    'filter reasons, held/required capabilities, actual read/write stores, budgets, and job attachment.',
    '`readOnly` filters financial writes, including approval; an attached writable artifact store may',
    'still store reports. Neither a profile nor a store mints authorization grants. A capability option',
    'is a server-owned ceiling, never a tool argument. Paper trading is not live order routing.',
    '',
    'Tools include operation-derived effect, cost, handle, cancellation, and schema metadata. Read',
    '`totalfinance://operations/<operation-id>` for the full operation description. Both tools and resources',
    'lists return at most `pageSize` entries (default/max 100; minimum 1). Follow `nextCursor` until absent.',
    'Cursors are opaque and specific to this server, catalog, and snapshot. Malformed, modified,',
    'cross-catalog, cross-server, and stale cursors return JSON-RPC `InvalidParams`; restart without a',
    'cursor. Prompts are listed and callable only when their required tools exist; they ask for missing',
    'inputs, never invent live data, and report only supported results.',
    '',
    '```sh',
    'totalfinance-mcp --profile backtesting --store /absolute/path/to/totalfinance-store --jobs',
    'totalfinance-mcp doctor --profile full --page-size 25',
    'totalfinance-mcp --profile portfolio --store /absolute/path/to/totalfinance-store --store-read-only',
    '```',
    '',
    '`--jobs` is explicit and requires a writable `--store`; `--store` alone does not enable jobs.',
    '`--store-read-only` attaches only a reader and cannot be combined with `--jobs`. Embedders pass',
    '`jobs: createLocalJobRunner({ registry, directory, profile, packs?, clock })` from',
    "`@totalfinance/workflows/local` plus the same directory's `artifacts` reader to",
    '`createTotalFinanceMcpServer`. The runner must reconstruct the same registered operations and versions.',
    'There is no process-wide job runner and no experimental MCP task dependency.',
    '',
    'With jobs attached, existing **job-class** tools await worker completion asynchronously and retain',
    'their original input/output financial schemas. Other cost classes remain inline (including the',
    'currently inline `vectorized_run`); their deadlines remain post-hoc. For fetch-later work, use:',
    '',
    '1. `totalfinance.job.submit` with `{ id, input }`. Its discriminated schema enumerates only enabled,',
    "   unprivileged job-class operations and embeds each operation's input schema. No arbitrary code,",
    '   capability, store, or per-call budget override is accepted.',
    '2. `totalfinance.job.status` with `{ jobId }`, or read the returned `statusUri`. Progress is the actual',
    '   runner stage when provided, otherwise lifecycle state with an unknown fraction—not invented',
    '   calculation percentages. Awaited heavy calls also send standard MCP progress notifications.',
    '3. `totalfinance.job.result` with `{ jobId }` returns `{ result: OperationResult }`; `resultUri` reads the',
    '   unchanged result directly. Assumptions, diagnostics, identity, and report handles are preserved.',
    '4. `totalfinance.job.cancel` with `{ jobId }` cancels unfinished work through the existing worker runner.',
    '   Terminal cancellation is idempotent. Failed jobs return their original `OperationError`;',
    '   early result reads return `input.wrong_shape` with the actual state; only cancelled work returns `operation.cancelled`.',
    '   Cancellation stops outstanding work; it is not rollback or deletion of reports already persisted.',
    '   Those reports retain their normal ownership/profile visibility, but are not a successful job result.',
    '',
    'Job controls are absent without attachment. Reads/cancellation and job result resources are limited',
    'to the effective eligible operation set even if the supplied runner has a broader registry. The',
    'current runner submission contract has no grants context, so privileged job operations are excluded,',
    'not silently run inline. Use a dedicated store directory when results must be isolated between hosts.',
    'With jobs attached, report resources require attribution to an enabled operation/allowed job or',
    'their transitive `OperationResult.artifacts` report descendants. A handle’s `provenance.requestId`',
    'matches its owner’s job id even before the outer result exists (unfinished/failed/cancelled too).',
    'Disallowed ownership/ancestry wins; unattributed spills with missing parents stay hidden.',
    'Input datasets/URI strings are not',
    'ownership edges. Explicit input readers remain usable; profiles are not multi-tenant ACLs.',
    'Only listed operations are wire-supported; callback APIs and unlisted model families remain SDK-only.',
  ].join('\n');
}

function buildReadme(
  pkg: PkgInfo,
  snippet: string | undefined,
  aliasSection: string,
  subpathSnippets: { specifier: string; snippet: string }[] = [],
): string {
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
      `Until publication, use a [source checkout](${REPO_URL}#develop).`,
    '',
    '```sh',
    `pnpm add ${pkg.dir === 'mcp' ? MCP_PACKAGE_NAME : PUBLIC_PACKAGE_NAME}@${pkg.version}`,
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
  if (pkg.name === '@totalfinance/mcp') lines.push(mcpSetupSection(), '');
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

// Direct-run entry: write each README. `import.meta.url` ends with this file when run via tsx.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = buildReadmes();
  for (const { dir, content } of built) {
    writeFileSync(fileURLToPath(new URL(`packages/${dir}/README.md`, ROOT)), content);
  }
  process.stdout.write(`readme-gen: wrote ${built.length} package READMEs\n`);
}
