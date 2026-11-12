/**
 * Agent entry points: `llms.txt` (the index), `llms/<domain>.txt` (bounded per-domain bundles) and
 * `llms-full.txt` (the complete generated reference from `docs/llms-full.txt`).
 */
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { markdownRoute } from '../src/routes';
import type { ReferenceEntryView } from '../src/site-data';
import type { GenerateResult } from './generate';
import { memberLookup, twinServers, type MarkdownPage, type MemberLookup } from './markdown';
import { summaryOf } from './reference';

/** Per-domain bundles must fit comfortably in an agent's context window. */
export const DOMAIN_BUNDLE_BUDGET_BYTES = 400_000;
/** Related guide text inlined per page before the bundle links to the rest. */
const RELATED_PAGE_CHARACTERS = 16_000;

const SUMMARY =
  'TotalFinance is an open-source TypeScript financial-computation toolkit by InsiderFinance: options, strategies, volatility, ' +
  'technical analysis, portfolio P&L, performance, risk, valuation, fixed income, FX, commodities, crypto and backtesting. ' +
  'It computes on caller-supplied data (it never fetches quotes), uses explicit units (decimals for rates and volatility, year ' +
  'fractions and epoch milliseconds for time), and returns assumptions and diagnostics with every explained answer.';

const mdUrl = (site: string, route: string) => `${site}${markdownRoute(route)}`;

export function llmsIndex(
  pages: readonly MarkdownPage[],
  generated: GenerateResult,
  site: string,
): string {
  const pick = (section: MarkdownPage['section']) =>
    pages.filter((page) => page.section === section && page.route !== '/');
  const line = (page: MarkdownPage) =>
    `- [${page.title}](${mdUrl(site, page.route)})${page.description ? `: ${page.description}` : ''}`;
  const domains = generated.reference.index.domains.filter((domain) => domain.slug !== 'index');
  return [
    '# TotalFinance',
    '',
    `> ${SUMMARY}`,
    '',
    `Docs: ${site} · Package: \`@insiderfinance/totalfinance\` (${generated.version.label}) · Source: https://github.com/InsiderFinance/totalfinance`,
    '',
    '## Use TotalFinance as tools (MCP)',
    '',
    ...twinServers(generated, site).map((server) =>
      server.transport.kind === 'http'
        ? `- ${server.title} (\`${server.name}\`, hosted, Streamable HTTP): ${server.transport.url}. ${server.summary}`
        : `- ${server.title} (\`${server.name}\`, local stdio): \`${[server.transport.command, ...server.transport.args].join(' ')}\`${server.installable ? '' : ' after building from source (not on npm yet)'}. ${server.summary}`,
    ),
    `- Exact setup for Claude Code, Claude Desktop, Cursor, VS Code, Codex, Windsurf, Gemini CLI and ChatGPT: [Connect an AI agent](${mdUrl(site, '/agents')}).`,
    '',
    'Every page below is Markdown. For one domain in a single file, use its bundle under "Domain bundles".',
    '',
    '## Start here',
    '',
    ...pick('start').map(line),
    '',
    '## Calculators (live in the browser; each page includes its exact TypeScript)',
    '',
    ...pick('learn').map(line),
    '',
    '## Domain bundles (overview + guides + compact reference, sized for a context window)',
    '',
    ...domains.map(
      (domain) => `- [${domain.title}](${site}/llms/${domain.slug}.txt): ${domain.summary}`,
    ),
    '',
    '## Domain overviews',
    '',
    ...pick('domains').map(line),
    '',
    '## Guides',
    '',
    ...pick('guides').map(line),
    '',
    '## Agents',
    '',
    ...pick('agents').map(line),
    ...pick('operations')
      .filter((page) => page.route === '/agents/operations')
      .map(line),
    '',
    '## Reference',
    '',
    `- [API reference index](${mdUrl(site, '/reference')}): every entry point with links to its page.`,
    `- [Reference coverage](${site}/reference-coverage.json): every export path and its URL.`,
    `- Entry-point JSON: ${site}/reference/totalfinance/<subpath>.json (for example ${site}/reference/totalfinance/options.json).`,
    '',
    '## Machine-readable',
    '',
    `- [Search index](${site}/search-index.json)`,
    `- [Operation catalog](${site}/operation-catalog.json): ${generated.operations.length} operations with schemas.`,
    `- [OpenAPI](${site}/openapi.json): the local HTTP server.`,
    `- Docs MCP endpoint (where the host supports functions): ${site}/mcp`,
    '',
    '## Optional',
    '',
    `- [Full reference for LLMs](${site}/llms-full.txt): every entry point, type and operation in one large file.`,
    '',
  ].join('\n');
}

/** One compact line per member of a callable's immediate inputs and outputs. */
function compactMembers(entry: ReferenceEntryView, lookup: MemberLookup): string[] {
  const members = lookup.get(entry.id) ?? entry.members ?? [];
  return members
    .filter((member) => member.name.split('.').length <= 2)
    .slice(0, 15)
    .map(
      (member) =>
        `  - \`${member.name}\`${member.optional ? '?' : ''}: \`${member.type.replace(/\s+/g, ' ').slice(0, 160)}\`${member.description ? ` — ${member.description.replace(/\s+/g, ' ').slice(0, 220)}` : ''}${member.unit !== 'unitless by name' ? ` [${member.unit}]` : ''}${member.defaultValue !== null ? ` (default ${member.defaultValue})` : ''}`,
    );
}

export function domainBundleText(
  slug: string,
  pages: readonly MarkdownPage[],
  generated: GenerateResult,
  site: string,
): string {
  const domain = generated.reference.index.domains.find((candidate) => candidate.slug === slug);
  if (!domain) throw new Error(`Unknown domain ${slug}`);
  const overview = pages.find((page) => page.route === `/domains/${slug}`);
  const guideRoutes = new Set(
    [...(overview?.markdown.matchAll(/\]\(([^)]+)\)/g) ?? [])]
      .map((match) => match[1]!.replace(site, ''))
      .filter((route) => route.startsWith('/guides') || route.startsWith('/learn')),
  );
  const related = pages.filter((page) => guideRoutes.has(page.route));
  const seen = new Set<string>();
  const reference: string[] = [];
  const lookup = memberLookup(generated);
  /** Identical parameter blocks (e.g. strategy presets) are written once and referenced after. */
  const memberBlocks = new Map<string, string>();
  for (const entrypoint of domain.entrypoints) {
    const chunks = [...generated.reference.pages.values()].filter(
      (page) => page.kind === 'entrypoint' && page.entrypoint === entrypoint.specifier,
    );
    const entries = chunks.flatMap((page) => (page.kind === 'entrypoint' ? page.entries : []));
    if (!entries.length) continue;
    reference.push(`## \`${entrypoint.specifier}\``, '');
    const repeated: string[] = [];
    const types: string[] = [];
    for (const entry of entries) {
      const key = `${entry.name}|${entry.signature}`;
      if (seen.has(key)) {
        repeated.push(entry.name);
        continue;
      }
      seen.add(key);
      // Types and classes are listed by name and summary; their full shapes are one get_reference
      // call away. (Technical analysis alone has ~180 streaming-state classes.)
      if (entry.kind === 'interface' || entry.kind === 'type' || entry.kind === 'class') {
        types.push(
          `- \`${entry.name}\` (${entry.kind})${entry.description ? `: ${summaryOf(entry.description)}` : ''}`,
        );
        continue;
      }
      const signature =
        entry.signature.length > 900 ? `${entry.signature.slice(0, 900)} …` : entry.signature;
      reference.push(
        `### ${entry.name} (${entry.kind})`,
        '',
        ...(entry.description ? [entry.description.replace(/\n{2,}/g, '\n'), ''] : []),
        '```ts',
        signature,
        '```',
        ...(() => {
          // Members expand declared functions; typed facades (`const rsi: Indicator<…>`) already name
          // their parameter type in the signature.
          if (!/^(?:export )?declare function /m.test(entry.signature)) return [];
          const lines = compactMembers(entry, lookup);
          const key = lines.join('\n');
          if (!lines.length) return [];
          const first = memberBlocks.get(key);
          if (first) return [`  - Members: same as \`${first}\`.`];
          memberBlocks.set(key, entry.name);
          return lines;
        })(),
        '',
      );
    }
    if (types.length) reference.push('#### Types and classes', '', ...types, '');
    if (repeated.length)
      reference.push(
        `Also exports (documented above): ${repeated.map((name) => `\`${name}\``).join(', ')}.`,
        '',
      );
  }
  const text = [
    `# TotalFinance · ${domain.title}`,
    '',
    `> ${domain.summary} Import from \`@insiderfinance/totalfinance/${slug}\`. Units are explicit; supply your own data. Callables are listed with signatures and their first parameters; types by name. Get any export's complete contract with the docs MCP \`get_reference\` tool or ${site}/reference/.`,
    '',
    `Full docs: ${site}/domains/${slug}/ · Index of all bundles: ${site}/llms.txt`,
    '',
    overview ? overview.markdown.replace(/^# .*\n/, '') : '',
    '',
    // Calculator pages contribute their explanation and first call; complete programs (with sample
    // data) stay on the page itself. Very long guides (registries, matrices) are linked, not inlined.
    ...related.map((page) => {
      const markdown = page.markdown.replace(/\n### Complete program[\s\S]*$/, '\n');
      return markdown.length <= RELATED_PAGE_CHARACTERS
        ? `\n---\n\n${markdown}`
        : `\n---\n\n${markdown.slice(0, RELATED_PAGE_CHARACTERS).replace(/\n[^\n]*$/, '')}\n\n[Continued: ${mdUrl(site, page.route)}]\n`;
    }),
    '',
    '---',
    '',
    '# Compact reference',
    '',
    ...reference,
  ].join('\n');
  return text;
}

/** A domain bundle must fit its budget as written; the build fails rather than silently truncating. */
export function domainBundle(
  slug: string,
  pages: readonly MarkdownPage[],
  generated: GenerateResult,
  site: string,
): string {
  const text = domainBundleText(slug, pages, generated, site);
  const bytes = Buffer.byteLength(text);
  if (bytes > DOMAIN_BUNDLE_BUDGET_BYTES)
    throw new Error(
      `llms/${slug}.txt is ${bytes} bytes, over its ${DOMAIN_BUNDLE_BUDGET_BYTES}-byte budget. Make the bundle more compact; do not truncate it.`,
    );
  return text;
}

/** The complete generated reference, with repository links rewritten to site pages. */
export function llmsFull(root: string, generated: GenerateResult, site: string): string {
  const routes = new Map(generated.guides.map((guide) => [guide.source, guide.route]));
  return readFileSync(join(root, 'docs/llms-full.txt'), 'utf8').replace(
    /\]\(([^)#\s]+\.md)(#[^)]*)?\)/g,
    (_match, file: string, fragment: string | undefined) => {
      const route = routes.get(posix.normalize(posix.join('docs', file)));
      return route ? `](${site}/${route}${fragment ?? ''})` : `](${site}/guides)`;
    },
  );
}
