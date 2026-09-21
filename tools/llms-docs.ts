/** Agent docs from export maps/checker/JSDoc and live registries. Run `pnpm tsx tools/llms-docs.ts`. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aliasesOf } from '../packages/technical-analysis/src/aliases.js';
import { indicatorWarmups } from '../packages/technical-analysis/src/warmup.js';
import { packsForProfile, REGISTRY_PROFILES } from '../packages/workflows/src/local/profiles.js';
import { OPERATION_BUDGETS } from '../packages/workflows/src/runtime.js';
import {
  buildPublicReference,
  type PublicReference,
  type ReferenceEntry,
  type ReferenceOperation,
} from './public-reference.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SUMMARY =
  'TotalFinance is a TypeScript financial-computation toolkit. The SDK covers options, strategies, ' +
  'technical analysis, portfolio P&L, valuation, risk, scenarios, and backtesting. The operation registry ' +
  'is a curated serializable subset, not universal SDK coverage. Compute uses caller-supplied data, ' +
  'not live quotes. Package versions below are workspace metadata, not evidence of npm publication.';

export const AGENT_JOURNEYS = [
  {
    slug: 'options',
    title: 'Price options and inspect Greeks',
    operation: 'totalfinance.option.price',
    guide: 'getting-started.md',
  },
  {
    slug: 'strategies',
    title: 'Build and analyze option strategies',
    operation: 'totalfinance.strategy.analyze',
    guide: 'guides/strategies.md',
  },
  {
    slug: 'portfolio-pnl',
    title: 'Explain portfolio P&L',
    operation: 'totalfinance.portfolio.explain_pnl',
    guide: 'guides/end-to-end.md#4-portfolio',
  },
  {
    slug: 'valuation',
    title: 'Value a company',
    operation: 'totalfinance.valuation.company',
    guide: 'guides/end-to-end.md#2-valuation',
  },
  {
    slug: 'backtesting',
    title: 'Run a reproducible backtest',
    operation: 'totalfinance.backtest.vectorized_run',
    guide: 'guides/backtesting.md',
  },
  { slug: 'connect-agent', title: 'Connect an agent', operation: null, guide: 'guides/mcp.md' },
] as const;

function list(values: readonly string[], absent = 'none'): string {
  return values.length ? values.map((value) => `\`${value}\``).join(', ') : absent;
}

/** Every SDK-only restriction explicitly declared by an operation or its schema. */
export function sdkOnlyNotes(operation: ReferenceOperation): string[] {
  const found = new Set<string>();
  function visit(value: unknown): void {
    if (typeof value === 'string' && /SDK.only/i.test(value)) found.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(operation.description);
  visit(operation.inputSchema);
  visit(operation.outputSchema);
  return [...found].sort();
}

/** Repository-relative navigation; does not depend on any site routing implementation. */
export function buildLlmsTxt(reference: PublicReference = buildPublicReference()): string {
  const lines = [
    '# TotalFinance',
    '',
    `> ${SUMMARY}`,
    '',
    '- [Full API and operation catalog](llms-full.txt) — every public entrypoint, type-only export, and registered operation.',
    '- [Operation catalog](llms-full.txt#operation-catalog) — full schemas, profiles, permissions, handles, costs, and SDK-only notes.',
    '',
    '## Imports and bundles',
    '',
    'For portable browser tree shaking, use named imports from `totalfinance/<domain>` or `@totalfinance/<domain>`, ' +
      'or supported feature subpaths. Root namespace re-exports are convenient but bundler-dependent. ' +
      'Installation size, final bundle size, and plain Node ESM loading are different; Node does no automatic dead-code elimination.',
    '',
    '- [Imports and bundles](guides/imports-and-bundles.md) — namespace tradeoffs, facade services, type-only imports, and measured budgets.',
    '',
    '## Six task journeys',
    '',
  ];
  for (const journey of AGENT_JOURNEYS)
    lines.push(`- [${journey.title}](llms-full.txt#journey-${journey.slug})`);
  lines.push(
    '',
    '## Scope and setup',
    '',
    `${reference.operations.filter((operation) => operation.defaultEnabled).length} default compute operations; ` +
      `${reference.operations.length} operations in the full registry. Read-only is the server default. ` +
      'Full/profile selection does not grant writes: required capabilities, writable stores, and explicit write configuration still apply.',
    'Explicit packs are an exact selection, not additions to defaults. Check doctor and totalfinance://capabilities for the effective server, not this full catalog.',
    '- [Agent setup, handles, errors, jobs, and safety](llms-full.txt#journey-connect-agent)',
    '- [Assumptions and conventions](guides/assumptions.md)',
    '- [Typed errors](guides/errors.md)',
    '- [Technical indicators](guides/ta-indicators.md)',
    '- [Warmup and lookahead](guides/ta-warmup.md)',
    '',
    '## Packages',
    '',
  );
  for (const p of reference.packages)
    lines.push(
      `- ${p.name} @ ${p.version} — ${p.stability}; ${p.entrypoints.length} entrypoints. ${p.description}`,
    );
  return lines.join('\n') + '\n';
}

function setup(reference: PublicReference): string[] {
  const mcp = reference.packages.find((p) => p.name === '@totalfinance/mcp');
  if (!mcp) throw new Error('Agent documentation requires the MCP package metadata');
  return [
    '## Journey connect-agent',
    '',
    'Use Node at the floor declared by the installed package. In a built checkout (`pnpm build`), launch the stdio server:',
    '```sh',
    'node packages/mcp/dist/bin.js --profile default',
    'node packages/mcp/dist/bin.js doctor',
    '```',
    '',
    `This checkout declares @totalfinance/mcp ${mcp.version} (${mcp.stability}). After independently confirming availability of that exact release, ` +
      `a client may use command \`npx\` with args \`["-y", "@totalfinance/mcp@${mcp.version}", "--profile", "default"]\`. ` +
      'Do not assume the workspace version has been published. Stdout in server mode is JSON-RPC only.',
    '',
    'Published-package smoke: pending release. This build-time reference does not claim execution against published packages.',
    '',
    '### Selection and permissions',
    '',
    'Omitted packs select the default compute packs. An explicit packs array is exact, including an empty array. ' +
      'The full profile selects all registered packs but grants no capabilities. Read-only is the server default. ' +
      'Embedded write use requires explicit readOnly: false, the per-operation requiredCapabilities, and the stores the operation requires. ' +
      'The CLI accepts repeatable --capability grants; a write grant enables write visibility but does not create missing stores or trusted authorizations. ' +
      'A sideEffect of none does not imply no permission requirement. Consult doctor, tools/list, and totalfinance://capabilities for effective availability.',
    '',
    'Catalog discovery is paged: follow nextCursor until absent for tools, resources and prompts. ' +
      'Treat cursors as opaque and server/catalog-scoped; restart without a cursor if it is rejected. ' +
      'totalfinance://profiles lists task selections; totalfinance://capabilities reports the active filters and grants. ' +
      'Use totalfinance://schema/tool/<name>/input and /output for an enabled tool’s schema, and invoke only prompts actually listed.',
    '',
    'Paper trading is local simulation, not a brokerage connection. Authorization, paper submission/cancellation, reconciliation, ' +
      'and portfolio-ledger application are distinct operations. Policy/human authorization, trusted authorization records and idempotency are not bypassed by selecting full. ' +
      'No live brokerage orders or live market-data fetching are supplied by this catalog.',
    '',
    '### Handles, results, and errors',
    '',
    'Attach an explicit artifact store (--store <directory> in the CLI) to resolve handles. A ResourceHandle is store-scoped, with uri, kind, schema, version, ' +
      'contentHash, createdTimestampMs, expiresTimestampMs and provenance. Only the handleFields declared by an operation accept handle substitution. ' +
      'Inline data and stored data must satisfy the same operation contract. Unknown, wrong-kind, stale or unavailable handles are errors, not invitations to invent data. ' +
      'Read stored reports through listed totalfinance://reports/<hash> resources or totalfinance.artifact.read when enabled.',
    '',
    'OperationResult carries operation identity/version, structured output, assumptions, diagnostics, artifacts and completion status. ' +
      'Inspect diagnostics and partial/incomplete status before treating a calculation as complete. QuantError failures are OperationError ' +
      '{ code, message, context, operation }; MCP returns isError with the error in text, not success-shaped structuredContent. ' +
      'Schema validation errors may additionally include issues. Unknown protocol tools/resources/prompts are JSON-RPC errors. Never replace non-convergence with a guessed number.',
    '',
    'SDK result grammar depends on role: facade calls return plain values and .explain() returns value/assumptions/diagnostics; ' +
      'analysis calls return rich reports; factories return artifacts; expert kernels have their declared numerical contracts. ' +
      'Use units and conventions from the exact field documentation, not generic economic defaults. ' +
      'A missing JSDoc default is shown as not declared; optional never implies zero. Schema defaults below are emitted only when the schema declares them.',
    '',
    '### Budgets, seeds, and heavy jobs',
    '',
    'Runtime budget metadata (bytes and milliseconds as named; not economic assumptions):',
    '```json',
    JSON.stringify(OPERATION_BUDGETS, null, 2),
    '```',
    '',
    'Stochastic metadata may be per-call: evaluate it on parsed inputs (including declared schema defaults). ' +
      'The transport seed policy is published at totalfinance://policy/seed; inspect the resolved seed in results. Deterministic calls do not acquire synthetic seeds.',
    '',
    'For job-class work, explicitly attach a local JobRunner and its artifact store to the embedded MCP server. ' +
      'Use the lifecycle tools only when listed by that server: totalfinance.job.submit returns a job id; totalfinance.job.status reports progress; ' +
      'totalfinance.job.result fetches the unchanged completed result later; totalfinance.job.cancel stops unfinished work. ' +
      'Follow the returned status/result resource URIs. Progress may be lifecycle-only, not a measured percentage. ' +
      'Profile selection alone does not attach a runner or grant job access. Job controls are transport lifecycle tools, not additional registry compute operations.',
    '',
    '### SDK-only boundaries',
    '',
    'The option-price/Greeks wire operations declare Black–Scholes–Merton; do not treat them as generic pricing-engine selectors. ' +
      'The SDK model families (including Heston, SABR, local-volatility and exotic pricing) and custom engines are not universally exposed by MCP. ' +
      'A registered operation may compose a specific model without exposing its whole SDK family. ' +
      'Caller callbacks, custom predicates, custom pricers, and custom policies cannot be serialized into JSON. ' +
      'Use the SDK for those contracts. Operation-specific SDK-only restrictions below are copied from live schema metadata.',
    '',
    '[MCP guide](guides/mcp.md) · [Trade lifecycle](guides/trade-lifecycle.md) · [Errors](guides/errors.md)',
    '',
  ];
}

function entryLines(entry: ReferenceEntry): string[] {
  const lines = [
    `### ${entry.id}`,
    '',
    `Kind: ${entry.kind}; stability: ${entry.stability}.`,
    '',
    ...(entry.description ? [entry.description, ''] : []),
    '```typescript',
    entry.signature,
    '```',
    '',
  ];
  for (const tag of entry.tags.filter((tag) => tag.name !== 'example'))
    lines.push(`@${tag.name}: ${tag.text}`, '');
  for (const example of entry.examples) lines.push('Example (source JSDoc):', example, '');
  if (entry.members.length) {
    lines.push(
      'Members/parameters (default = JSDoc only; not declared means no documented default):',
      '',
    );
    for (const member of entry.members)
      lines.push(
        `- ${member.name}${member.optional ? '?' : ''}: ${member.type}; ` +
          `default: ${member.defaultValue ?? 'not declared'}${member.description ? ` — ${member.description}` : ''}`,
      );
    lines.push('');
  }
  return lines;
}

/** Shared declarations are included once; every re-export retains an explicit catalog identity. */
export function buildLlmsFullTxt(reference: PublicReference = buildPublicReference()): string {
  const lines = [
    '# TotalFinance — full reference for LLMs',
    '',
    SUMMARY,
    '',
    'Generated from package export maps, TypeScript source/checker/JSDoc, public guides, stability files and live operation metadata. ' +
      'No root-only API reports, inferred financial defaults, or publication claims.',
    '',
    // Keep the detailed import advice identical to the public guide; rebase its headings and link
    // for docs/llms-full.txt without copying a second hand-maintained version of the guidance.
    readFileSync(resolve(ROOT, 'docs/guides/imports-and-bundles.md'), 'utf8')
      .trim()
      .replace(/^(#+) /gm, '$1# ')
      .replace('](../bundle-size.md)', '](bundle-size.md)'),
    '',
    '[Imports and bundles guide](guides/imports-and-bundles.md)',
    '',
  ];
  for (const journey of AGENT_JOURNEYS) {
    if (!journey.operation) continue;
    const operation = reference.operations.find((candidate) => candidate.id === journey.operation);
    if (!operation) throw new Error(`Journey operation missing: ${journey.operation}`);
    lines.push(
      `## Journey ${journey.slug}`,
      '',
      journey.title,
      '',
      `Start with \`${operation.id}\` (${operation.title}); pack \`${operation.pack}\`; ` +
        `${operation.defaultEnabled ? 'in the default profile' : 'opt-in'}; profiles ${list(operation.profiles)}.`,
      'Read its complete input schema and permissions in the operation catalog before calling. Supply your own data; no market inputs are fetched.',
      `[Runnable SDK guide](${journey.guide})`,
      '',
    );
  }
  lines.push(
    ...setup(reference),
    '## Profiles',
    '',
    'Profiles select packs, never permissions. Counts below are registry membership, not the effective tools/list after permissions, stores and job attachment.',
    '',
  );
  for (const profile of REGISTRY_PROFILES) {
    const packs = packsForProfile(profile);
    lines.push(
      `### Profile ${profile}`,
      '',
      `Packs: ${list(packs.map((pack) => pack.name))}. Operations: ${packs.reduce((count, pack) => count + pack.operations.length, 0)}.`,
      '',
      ...packs.map(
        (pack) =>
          `- ${pack.name}: ${pack.operations.map((operation) => operation.title).join('; ')}`,
      ),
      '',
    );
  }
  lines.push(
    '## Operation catalog',
    '',
    `${reference.operations.length} operations from packsForProfile('full'). All schemas below are complete, not abbreviated.`,
    '',
  );
  for (const operation of reference.operations) {
    lines.push(
      `### ${operation.id}`,
      '',
      operation.title,
      '',
      operation.description,
      '',
      `Version: ${operation.version}; pack: ${operation.pack}; profiles: ${list(operation.profiles)}; ` +
        `defaultEnabled: ${operation.defaultEnabled}; SDKonly: ${operation.sdkOnly}.`,
      '',
      `Required capabilities: ${list(operation.requiredCapabilities)}. Authorization: ${operation.authorization}. ` +
        `Side effect: ${operation.sideEffect}. Idempotency: ${operation.idempotency}.`,
      '',
      `Handle fields: ${list(operation.handleFields)}. Cost: ${operation.costClass}. Cancellation supported: ${operation.supportsCancellation}. ` +
        `Deterministic: ${operation.deterministic}. Stochastic: ${operation.stochastic}.`,
      '',
      `Annotations: ${JSON.stringify(operation.annotations)}`,
      '',
      ...sdkOnlyNotes(operation).map((note) => `SDK-only limitation: ${note}`),
      '',
      'Input JSON Schema:',
      '```json',
      JSON.stringify(operation.inputSchema, null, 2),
      '```',
      '',
      'Output JSON Schema:',
      '```json',
      JSON.stringify(operation.outputSchema, null, 2),
      '```',
      '',
    );
  }
  lines.push(
    '## Packages and public API',
    '',
    'Every import path has its own export identity. Repeated declarations refer to an identical documented declaration. ' +
      'Type-only declarations are not callable JavaScript values. Named member types refer to the corresponding declarations in this catalog. ' +
      'Member lists have no count cap. Namespaces and callable companions expand; requests and returned artifacts expose their fields and method signatures. ' +
      'Named exported contracts use their own declarations rather than recursively duplicating every method-return graph; non-exported data shapes expand until a recursive type reference.',
    '',
  );
  const seen = new Map<string, string>();
  for (const p of reference.packages) {
    lines.push(
      `## Package ${p.name}`,
      '',
      `Version: ${p.version}; stability: ${p.stability}.`,
      '',
      p.description,
      '',
      `Entrypoints: ${list(p.entrypoints)}`,
      '',
    );
    for (const entrypoint of p.entrypoints) {
      lines.push(`## Entrypoint ${entrypoint}`, '');
      for (const entry of reference.entries.filter((entry) => entry.entrypoint === entrypoint)) {
        const identity = JSON.stringify({
          name: entry.name,
          kind: entry.kind,
          signature: entry.signature,
          description: entry.description,
          tags: entry.tags,
          members: entry.members,
          stability: entry.stability,
        });
        const previous = seen.get(identity);
        if (previous)
          lines.push(
            `### ${entry.id}`,
            '',
            `Same declaration, documentation, members and stability as \`${previous}\`.`,
            '',
          );
        else {
          seen.set(identity, entry.id);
          lines.push(...entryLines(entry));
        }
      }
    }
  }
  lines.push(
    '## Technical indicators (full registry)',
    '',
    'Registry metadata: name · category · inputs · declared parameters/defaults · warmup · aliases. No defaults are inferred.',
    '',
  );
  for (const info of [...indicatorWarmups()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  )) {
    const alias = aliasesOf(info.name);
    const aliases = alias
      ? [alias.talib, alias.pandas, alias.tradingview]
          .flat()
          .filter((name) => typeof name === 'string')
      : [];
    const parameters = Object.keys(info.parameters)
      .sort()
      .map((key) => `${key}=${JSON.stringify(info.parameters[key])}`)
      .join(', ');
    lines.push(
      `- ${info.name} · ${info.category} · ${info.inputs} · ${parameters || 'not declared'} · ` +
        `warmup ${info.warmup ?? 'not declared'}${aliases.length ? ` · aka ${aliases.join(', ')}` : ''}`,
    );
  }
  return lines.join('\n') + '\n';
}

export function buildLlmsDocs(): { concise: string; full: string } {
  const reference = buildPublicReference();
  return { concise: buildLlmsTxt(reference), full: buildLlmsFullTxt(reference) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { concise, full } = buildLlmsDocs();
  writeFileSync(resolve(ROOT, 'docs/llms.txt'), `${concise}\n`);
  writeFileSync(resolve(ROOT, 'docs/llms-full.txt'), `${full}\n`);
}
