/**
 * Markdown twins: every HTML page has a `<route>.md` an agent can read without a browser. Twins
 * are rendered from the same sources as the pages (authored MDX, generated guides, reference and
 * operation data, playground definitions), never scraped from HTML.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatValue } from '../src/format';
import { displayValue } from '../src/display';
import { computeServer, docsServer, hostedServer, setupMarkdown } from '../src/agents';
import { firstCallCode } from '../src/examples';
import { CALCULATOR_AGENTS } from '../src/playgrounds/agent';
import { defaultInput } from '../src/playgrounds/inputs';
import { playgrounds } from '../src/playgrounds/index';
import { isNumberControl, type Control } from '../src/types';
import type { EntrypointPageData, MemberView, ReferenceEntryView } from '../src/site-data';
import { readFrontmatter, type AuthoredPage, type GenerateResult } from './generate';
import { memberView, summaryOf } from './reference';

const SITE = fileURLToPath(new URL('..', import.meta.url));

export interface MarkdownPage {
  /** Site route with slashes, e.g. `/learn/price-an-option`. */
  route: string;
  title: string;
  description: string;
  section:
    | 'start'
    | 'learn'
    | 'domains'
    | 'guides'
    | 'agents'
    | 'reference'
    | 'operations'
    | 'project';
  markdown: string;
}

const fence = (code: string, lang = 'ts') => {
  const ticks = code.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${code.replace(/\n+$/, '')}\n${ticks}`;
};
const cell = (text: string) =>
  text
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

/** Absolute site links: agents read twins out of context, so `/x` becomes `<base>/x`. */
function absolutize(markdown: string, base: string): string {
  return markdown.replace(
    /\]\((\/(?!\/)[^)\s]*)\)/g,
    (_match, path: string) => `](${base}${path})`,
  );
}

function controlLine(control: Control): string {
  if (isNumberControl(control))
    return `- **${control.label}** (\`${control.name}\`): ${control.value} — ${control.unit}; allowed ${control.min} to ${control.max}.`;
  switch (control.kind) {
    case 'select':
      return `- **${control.label}** (\`${control.name}\`): \`${control.value}\` — one of ${control.options.map((option) => `\`${option.value}\``).join(', ')}.`;
    case 'table':
      return `- **${control.label}** (\`${control.name}\`): a table of ${control.minRows}–${control.maxRows} rows with columns ${control.columns
        .map((column) => `\`${column.name}\`${column.unit ? ` (${column.unit})` : ''}`)
        .join(
          ', ',
        )}.${control.presets ? ` Presets: ${control.presets.map((preset) => preset.label).join(', ')}.` : ''}`;
    case 'data':
      return `- **${control.label}** (\`${control.name}\`): ${control.format === 'ohlcv' ? 'daily OHLC(V) bars' : 'a numeric series'} (${control.minRows}–${control.maxRows} rows), supplied by the reader. Default: ${control.value.label}.`;
  }
}

export function playgroundMarkdown(id: string): string {
  const playground = playgrounds.find((candidate) => candidate.id === id);
  if (!playground) throw new Error(`Unknown playground ${id}`);
  const calculation = playground.run(defaultInput(playground));
  return [
    `## Calculator: ${playground.title}`,
    '',
    playground.introduction,
    '',
    'The page runs this calculation live in the browser. Inputs (defaults are hypothetical samples, not recommendations):',
    '',
    ...playground.controls.map(controlLine),
    '',
    '### Results at the default inputs',
    '',
    ...calculation.metrics.map(
      (metric) =>
        `- ${metric.label}: ${formatValue(metric.value, metric.format)}${metric.unit ? ` (${metric.unit})` : ''}`,
    ),
    '',
    '### First call',
    '',
    calculation.example.description,
    '',
    fence(firstCallCode(calculation)),
    '',
    'Output:',
    '',
    fence(displayValue(calculation.example.result), 'json'),
    '',
    '### Complete program (reproduces every chart point)',
    '',
    fence(calculation.code),
    ...agentSection(id, defaultInput(playground)),
  ].join('\n');
}

/** "Ask your AI agent": the MCP tool for this calculation and the prompt at the default inputs. */
function agentSection(id: string, input: ReturnType<typeof defaultInput>): string[] {
  const agent = CALCULATOR_AGENTS[id];
  if (!agent) return [];
  const tool = agent.operation?.replaceAll('.', '_');
  return [
    '',
    '### Ask your AI agent',
    '',
    tool
      ? `With the TotalFinance MCP server connected ([setup](/agents)), an agent runs this calculation with the \`${tool}\` tool${agent.profile ? ` (start the server with \`--profile ${agent.profile}\`)` : ' (on by default)'}. Prompt at the default inputs:`
      : 'With the TotalFinance docs MCP connected ([setup](/agents)), an agent looks up the exact API and writes the code. Prompt at the default inputs:',
    '',
    `> ${agent.prompt(input).replaceAll('\n', '\n> ')}`,
  ];
}

/** Servers the twins describe, matching `lib/agents.ts`; the docs MCP is always the current docs'. */
export function twinServers(generated: GenerateResult, base: string) {
  const hosted = hostedServer({
    url: process.env['TOTALFINANCE_DOCS_HOSTED_MCP_URL'] || undefined,
    keyUrl: process.env['TOTALFINANCE_DOCS_HOSTED_MCP_KEY_URL'] || undefined,
  });
  return [
    ...(hosted ? [hosted] : []),
    computeServer({ published: generated.version.published, version: generated.version.version }),
    docsServer(base.replace(/\/versions\/[^/]+$/, '')),
  ];
}

/** Replace the MDX components used in authored pages with Markdown equivalents. */
function mdxToMarkdown(body: string, generated: GenerateResult, base: string): string {
  const index = generated.reference.index;
  const domainList = () =>
    index.domains
      .filter((domain) => domain.slug !== 'index')
      .map((domain) => `- [${domain.title}](/domains/${domain.slug}): ${domain.summary}`)
      .join('\n');
  const exportsOf = (path: string) => {
    const page = generated.reference.pages.get(path);
    return page?.kind === 'entrypoint' ? page.exports : [];
  };
  return body
    .replace(/^import .*$/gm, '')
    .replace(/<Cards>\s*([\s\S]*?)<\/Cards>/g, (_match, cards: string) =>
      [...cards.matchAll(/<Card\s+title="([^"]+)"\s+href="([^"]+)"\s+description="([^"]+)"\s*\/>/g)]
        .map(([, title, href, description]) => `- [${title}](${href}): ${description}`)
        .join('\n'),
    )
    .replace(/<DomainGrid[^>]*\/>/g, domainList)
    .replace(/<PlaygroundGallery[^>]*\/>/g, () =>
      playgrounds
        .map(
          (playground) =>
            `- [${playground.title}](/learn/${playground.id}): ${playground.introduction}`,
        )
        .join('\n'),
    )
    .replace(/<GuideIndex\s*\/>/g, () =>
      generated.guides
        .filter((guide) => guide.group === 'guides')
        .map((guide) => `- [${guide.title}](/${guide.route}): ${guide.description}`)
        .join('\n'),
    )
    .replace(
      /<KeyExports\s+domain="([^"]+)"(?:\s+entrypoint="([^"]+)")?\s+names=\{(\[[^\]]*\])\}\s*\/>/g,
      (_match, domain: string, entrypoint: string | undefined, names: string) => {
        const exports = exportsOf(entrypoint ?? `reference/totalfinance/${domain}`);
        // Formatting may use either quote style and trailing commas; read the string literals.
        return [...names.matchAll(/'([^']+)'|"([^"]+)"/g)]
          .map((match) => match[1] ?? match[2]!)
          .map((name) => {
            const entry = exports.find((candidate) => candidate.name === name);
            return entry
              ? `- [\`${name}\`](${entry.url}) (${entry.kind}): ${entry.summary}`
              : `- \`${name}\``;
          })
          .join('\n');
      },
    )
    .replace(/<EntrypointList\s+domain="([^"]+)"\s*\/>/g, (_match, slug: string) =>
      (index.domains.find((domain) => domain.slug === slug)?.entrypoints ?? [])
        .map(
          (entrypoint) =>
            `- [\`${entrypoint.specifier}\`](/${entrypoint.path}): ${entrypoint.exportCount} exports`,
        )
        .join('\n'),
    )
    .replace(/<AgentProfiles\s*\/>/g, () => {
      const profiles = JSON.parse(
        readFileSync(join(SITE, '.generated/agent-profiles.json'), 'utf8'),
      ) as {
        profile: string;
        packs: string[];
        operations: number;
      }[];
      return [
        '| Profile | Packs | Registered operations |',
        '| --- | --- | --- |',
        ...profiles.map(
          (row) => `| ${row.profile} | ${row.packs.join(', ')} | ${row.operations} |`,
        ),
      ].join('\n');
    })
    .replace(/<ConnectAgent(?:\s+only="(\w+)")?\s*\/>/g, (_match, only: string | undefined) =>
      setupMarkdown(twinServers(generated, base).filter((server) => !only || server.id === only)),
    )
    .replace(/<OperationCount(?:\s+which="default")?\s*\/>/g, (match) =>
      String(
        match.includes('default')
          ? generated.operations.filter((operation) => operation.defaultEnabled).length
          : generated.operations.length,
      ),
    )
    .replace(
      /<Callout[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/Callout>/g,
      (_match, title: string, text: string) => `> **${title}** ${text.trim()}`,
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function memberRows(members: MemberView[]): string {
  return [
    '| Member | Type | Meaning | Unit | Required | Default |',
    '| --- | --- | --- | --- | --- | --- |',
    ...members.map(
      (member) =>
        `| \`${cell(member.name)}\` | \`${cell(member.type)}\` | ${cell(member.description) || '—'} | ${cell(member.unit)} | ${member.optional ? 'optional' : 'required'} | ${member.defaultValue === null ? 'not declared' : `\`${cell(member.defaultValue)}\``} |`,
    ),
  ].join('\n');
}

/** Complete members of every export, by id (pages inline only small contracts). */
export type MemberLookup = ReadonlyMap<string, MemberView[]>;

export function memberLookup(generated: GenerateResult): MemberLookup {
  return new Map(
    generated.publicReference.entries.map((entry) => [entry.id, entry.members.map(memberView)]),
  );
}

function entryMarkdown(
  entry: ReferenceEntryView,
  entrypoint: string,
  members: MemberLookup,
): string {
  const parts = [
    `### ${entry.name}`,
    '',
    `${entry.kind} · \`import ${entry.kind === 'interface' || entry.kind === 'type' ? 'type ' : ''}{ ${entry.name} } from '${entrypoint}'\``,
    '',
    entry.description || 'Public declaration; no additional behaviour is inferred.',
    '',
    fence(entry.signature),
  ];
  const all = members.get(entry.id) ?? entry.members ?? [];
  if (all.length) parts.push('', memberRows(all));
  for (const example of entry.examples) parts.push('', fence(example));
  for (const tag of entry.tags) parts.push('', `@${tag.name} ${tag.text}`);
  parts.push('', `Stability: ${entry.stability}.`);
  return parts.join('\n');
}

export function referenceMarkdown(
  page: EntrypointPageData,
  members: MemberLookup,
): { title: string; description: string; markdown: string } {
  const title = `${page.entrypoint}${page.chunk ? ` (page ${page.chunk + 1})` : ''}`;
  const overview =
    page.chunk === 0 && page.exports.length
      ? `## Exports\n\n${page.exports.map((entry) => `- [\`${entry.name}\`](${entry.url}) (${entry.kind})${entry.summary ? `: ${entry.summary}` : ''}`).join('\n')}\n\n`
      : '';
  return {
    title,
    description: `API reference for ${page.entrypoint}.`,
    markdown: `# ${title}\n\nStability: ${page.stability}.${page.empty ? ' This supported entry point has no named exports.' : ''}\n\n${overview}${page.entries.length ? `## Declarations\n\n${page.entries.map((entry) => entryMarkdown(entry, page.entrypoint, members)).join('\n\n')}` : ''}`,
  };
}

function authoredSection(route: string): MarkdownPage['section'] {
  const first = route.split('/')[0];
  if (
    first === 'learn' ||
    first === 'domains' ||
    first === 'agents' ||
    first === 'start' ||
    first === 'guides'
  )
    return first;
  return 'project';
}

export function buildMarkdownPages(generated: GenerateResult, base: string): MarkdownPage[] {
  const pages: MarkdownPage[] = [];
  const add = (page: MarkdownPage) =>
    pages.push({ ...page, markdown: absolutize(page.markdown, base) });

  for (const page of generated.authored) {
    const source = readFileSync(join(SITE, '..', page.file), 'utf8');
    const { body } = readFrontmatter(source);
    const calculator = page.playground ? `\n\n${playgroundMarkdown(page.playground)}` : '';
    add({
      route: page.route ? `/${page.route}` : '/start',
      title: page.title,
      description: page.description,
      section: authoredSection(page.route),
      markdown: `# ${page.title}\n\n${page.description ? `${page.description}\n\n` : ''}${mdxToMarkdown(body, generated, base)}${calculator}\n`,
    });
  }
  for (const guide of generated.guides)
    add({
      route: `/${guide.route}`,
      title: guide.title,
      description: guide.description,
      section: guide.group === 'start' ? 'start' : guide.group === 'agents' ? 'agents' : 'guides',
      markdown: `# ${guide.title}\n\n${guide.body.trim()}\n`,
    });
  const members = memberLookup(generated);
  for (const page of generated.reference.pages.values()) {
    const rendered = referenceMarkdown(page, members);
    add({
      route: `/${page.path}`,
      title: rendered.title,
      description: rendered.description,
      section: 'reference',
      markdown: `${rendered.markdown}\n`,
    });
  }
  add({
    route: '/reference',
    title: 'API reference',
    description: 'Every public entry point of TotalFinance.',
    section: 'reference',
    markdown: `# API reference\n\n${generated.reference.index.totals.entrypoints} entry points, ${generated.reference.index.totals.exportPaths} export paths.\n\n${generated.reference.index.domains
      .map(
        (domain) =>
          `## ${domain.title}\n\n${domain.summary}\n\n${domain.entrypoints.map((entrypoint) => `- [\`${entrypoint.specifier}\`](/${entrypoint.path}): ${entrypoint.exportCount} exports`).join('\n')}`,
      )
      .join('\n\n')}\n`,
  });
  for (const operation of generated.operations)
    add({
      route: `/agents/operations/${operation.id}`,
      title: operation.title,
      description: operation.description,
      section: 'operations',
      markdown: [
        `# ${operation.title}`,
        '',
        operation.description,
        '',
        `- Operation id: \`${operation.id}\``,
        `- MCP tool name: \`${operation.mcpToolName}\``,
        `- Pack / profiles: ${operation.pack} / ${operation.profiles.join(', ')}`,
        `- Default discovery: ${operation.defaultEnabled ? 'included' : 'opt-in'}`,
        `- Required capabilities: ${operation.requiredCapabilities.join(', ') || 'none'}`,
        `- Effects / authorization: ${operation.sideEffect} / ${operation.authorization}`,
        `- Cost: ${operation.costClass}; cancellation ${operation.supportsCancellation ? 'supported by worker execution' : 'not assumed'}`,
        `- Handle-eligible inputs: ${operation.handleFields.join(', ') || 'none'}`,
        `- Idempotency: ${operation.idempotency}`,
        '',
        '## Input schema',
        '',
        fence(JSON.stringify(operation.inputSchema, null, 2), 'json'),
        '',
        '## Output schema',
        '',
        fence(JSON.stringify(operation.outputSchema, null, 2), 'json'),
        '',
      ].join('\n'),
    });
  add({
    route: '/agents/operations',
    title: 'Operation catalog',
    description: 'Every registered operation.',
    section: 'operations',
    markdown: `# Operation catalog\n\n${generated.operations.length} registered operations; ${generated.operations.filter((operation) => operation.defaultEnabled).length} in the default profile.\n\n${generated.operations
      .map(
        (operation) =>
          `- [${operation.title}](/agents/operations/${operation.id}) (\`${operation.mcpToolName}\`, ${operation.pack}, ${operation.defaultEnabled ? 'default' : 'opt-in'}): ${operation.description}`,
      )
      .join('\n')}\n`,
  });
  add({
    route: '/versions',
    title: 'Versions & stability',
    description: 'Release status of this documentation build.',
    section: 'project',
    markdown: `# Versions & stability\n\nThis build: **${generated.version.label}**.\n\n${generated.version.published ? `Install: \`pnpm add @insiderfinance/totalfinance@${generated.version.version}\`` : 'This build is not verified as matching a public npm release. Build the source checkout; registry install commands describe the planned published experience.'}\n\nTotalFinance is pre-1.0; breaking changes may occur.\n\n${Object.entries(
      generated.version.packageVersions,
    )
      .map(([name, version]) => `- ${name}: ${version}`)
      .join('\n')}\n`,
  });
  const start = pages.find((page) => page.route === '/start');
  if (start) pages.push({ ...start, route: '/' });
  return pages;
}

export { summaryOf };
export type { AuthoredPage };
