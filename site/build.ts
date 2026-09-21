import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, posix } from 'node:path';
import { build } from 'esbuild';
import MarkdownIt from 'markdown-it';
import { escapeHtml, renderPlayground } from './src/render.js';
import { options } from './src/playgrounds/options.js';
import { playgrounds } from './src/playgrounds/index.js';
import { buildPublicReference, type ReferenceEntry } from '../tools/public-reference.js';
import { readSiteVersion } from './version.js';
import { restoreReleaseArchives } from './archives.js';
import { REGISTRY_PROFILES, packsForProfile } from '../packages/workflows/src/local/profiles.js';
import { unitByName } from '../tools/fields-doc.js';
import type { SearchRecord } from './src/search.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'site/dist');
const release = readSiteVersion(ROOT);
export const tasks = [
  ['price-an-option', 'Price an option', 'Price, Greeks, and explicit model assumptions.'],
  [
    'analyze-a-strategy',
    'Analyze a strategy',
    'Expiration payoff, break-even, and scenario exploration.',
  ],
  [
    'track-portfolio-pnl',
    'Track portfolio P&L',
    'Economic events, cash flows, and reconciled profit.',
  ],
  ['value-a-company', 'Value a company', 'Discounted cash flows and sensitivity to assumptions.'],
  [
    'backtest-a-strategy',
    'Backtest a strategy',
    'Signals, transaction costs, equity, and drawdown.',
  ],
  [
    'connect-an-agent',
    'Connect an agent',
    'Choose tools, supply data, and understand permissions.',
  ],
] as const;

export function layout(title: string, body: string, active = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)} · TotalFinance</title><meta name="description" content="${escapeHtml(title)}: real finance calculations, explicit assumptions, and a complete TypeScript API reference. Learn TotalFinance with runnable examples."/><link rel="stylesheet" href="/assets/styles.css"/><script type="module" src="/assets/client.js"></script></head><body><a class="skip" href="#main">Skip to content</a><aside class="sidebar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">TF</span>TotalFinance</a><p class="version">${escapeHtml(release.label)}</p><nav aria-label="Documentation"><span class="nav-label">Start with a task</span>${tasks.map(([slug, label]) => `<a href="/learn/${slug}/"${slug === active ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`).join('')}<span class="nav-label">Go deeper</span><a href="/reference/">API reference</a><a href="/playgrounds/explore-scenarios/">Scenario playground</a><a href="/agents/">Agent handbook</a><a href="/guides/">Guides & conventions</a><a href="/versions/">Versions & stability</a></nav><p class="note">Local calculations.<br/>Explicit assumptions.<br/>Your data stays yours.</p></aside><div class="shell"><header class="topbar"><span class="eyebrow">The finance developer workbench</span><a class="button quiet" href="/search/">Search the reference <span aria-hidden="true">⌕</span></a><span class="version-badge">${escapeHtml(release.label)}</span></header><main id="main">${body}<footer><span>TotalFinance · Apache-2.0</span><a href="/versions/">Version & stability</a><a href="/agents/">For agents</a><span>Sample data is hypothetical. Analytics are not investment advice.</span></footer></main></div></body></html>`;
}

const pages = new Map<string, string>();
const memberPages = new Map<string, { url: string; first: string; last: string }[]>();
function page(path: string, title: string, body: string, active = ''): void {
  const directory = join(OUT, path);
  mkdirSync(directory, { recursive: true });
  const html = layout(title, body, active);
  writeFileSync(join(directory, 'index.html'), html);
  pages.set(path ? `/${path}/` : '/', html);
}

export const referencePath = (entry: Pick<ReferenceEntry, 'package' | 'entrypoint'>): string =>
  `reference/${entry.package.replace('@totalfinance/', '')}/${entry.entrypoint.slice(entry.package.length).replace(/^\//, '') || 'index'}`;

function memberTable(members: ReferenceEntry['members']): string {
  return `<div class="table-scroll"><table><thead><tr><th>Name / type</th><th>Meaning & unit</th><th>Optional / default</th></tr></thead><tbody>${members.map((member) => `<tr><td><code>${escapeHtml(member.name)}</code><br/><code>${escapeHtml(member.type)}</code></td><td>${escapeHtml(member.description)}<br/><small>${escapeHtml(unitByName(member.name.split('.').at(-1)!))}</small></td><td>${member.optional ? 'Optional' : 'Required / declared member'}<br/>${escapeHtml(member.defaultValue ?? 'No @default declared; consult the signature and description.')}</td></tr>`).join('')}</tbody></table></div>`;
}

function referenceEntry(entry: ReferenceEntry): string {
  const links = memberPages.get(entry.id);
  const members = entry.members.length
    ? `<details><summary>Fields, parameters & returned members (${entry.members.length})</summary>${links ? `<p>This large namespace is split into complete field pages. No fields are omitted.</p><ul>${links.map((link) => `<li><a href="${link.url}">${escapeHtml(link.first)} — ${escapeHtml(link.last)}</a></li>`).join('')}</ul>` : memberTable(entry.members)}</details>`
    : '';
  const examples = entry.examples
    .map(
      (example, index) =>
        `<div class="panel-heading"><h3>Source example ${index + 1}</h3><button class="button quiet" data-copy="${escapeHtml(entry.name)}-example-${index}">Copy</button></div><pre><code id="${escapeHtml(entry.name)}-example-${index}">${escapeHtml(example.replace(/^```(?:ts|typescript)?\s*\n?|\n?```$/g, ''))}</code></pre>`,
    )
    .join('');
  return `<article class="reference-entry" id="${escapeHtml(entry.name)}"><p class="eyebrow">${escapeHtml(entry.kind)}</p><h2>${escapeHtml(entry.name)}</h2><p>${escapeHtml(entry.description || 'Public declaration. Read the signature and parameter/member contracts below; no additional behavior is inferred.')}</p><pre><code>${escapeHtml(entry.signature)}</code></pre>${members}${examples}${entry.tags
    .filter((tag) => !['example', 'default', 'defaultValue'].includes(tag.name))
    .map((tag) => `<p><strong>${escapeHtml(tag.name)}</strong> ${escapeHtml(tag.text)}</p>`)
    .join(
      '',
    )}<details><summary>Stability, warnings & conventions</summary><pre>${escapeHtml(entry.stability)}</pre><p>Declared field units are shown above. “Unitless by name” means the name alone does not establish a unit, not that a financial quantity has none. Check source descriptions, <a href="/guides/assumptions/">conventions</a>, and the returned diagnostics. <a href="/guides/errors/">Errors and warnings</a> are part of the result contract.</p></details></article>`;
}

export async function buildSite(): Promise<void> {
  // Only remove this generator's disposable output, never source or a user-supplied directory.
  rmSync(OUT, { recursive: true, force: true });
  pages.clear();
  memberPages.clear();
  mkdirSync(join(OUT, 'assets'), { recursive: true });
  const archivedVersions = restoreReleaseArchives(
    process.env['TOTALFINANCE_DOCS_ARCHIVES'],
    OUT,
    release,
  );
  writeFileSync(join(OUT, 'assets/styles.css'), readFileSync(join(ROOT, 'site/src/styles.css')));
  await build({
    entryPoints: [join(ROOT, 'site/src/client.ts'), join(ROOT, 'site/src/calculation-worker.ts')],
    outdir: join(OUT, 'assets'),
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
  });
  page(
    '',
    'Start with a calculation',
    `<div class="page-intro"><p class="eyebrow">Learn by doing</p><h1>What do you want<br/>to calculate?</h1><p>Start with a question. Get a real result, inspect the assumptions, and take the TypeScript with you.</p></div><div class="task-grid">${tasks.map(([slug, title, description], index) => `<a class="task-card" href="/learn/${slug}/"><span class="number">0${index + 1} ↗</span><h2>${title}</h2><p>${description}</p></a>`).join('')}</div><h2>A small call. An explainable answer.</h2>${renderPlayground(options)}`,
  );
  const searchRecords: SearchRecord[] = [];
  for (const playground of playgrounds) {
    const path = `${playground.id === 'explore-scenarios' ? 'playgrounds' : 'learn'}/${playground.id}`;
    const related =
      playground.id === 'analyze-a-strategy'
        ? '<div class="callout">Before expiry, explore <a href="/playgrounds/explore-scenarios/">price and volatility scenarios</a>. An expiration payoff is a different question from a mark-to-market value.</div>'
        : '';
    page(
      path,
      playground.title,
      `<div class="page-intro"><p class="eyebrow">Learn / ${escapeHtml(playground.id.replaceAll('-', ' '))}</p><h1>${escapeHtml(playground.title)}</h1><p>${escapeHtml(playground.introduction)}</p></div>${renderPlayground(playground)}${related}<p>Continue with the <a href="/reference/">full API reference</a> or <a href="/guides/levels/">the API levels guide</a>.</p>`,
      playground.id,
    );
    searchRecords.push({
      title: playground.title,
      url: `/${path}/`,
      description: playground.introduction,
      category: 'Runnable task',
      keywords: playground.id,
      kind: 'task',
    });
  }

  const guideFiles = readdirSync(join(ROOT, 'docs/guides'))
    .filter((file) => file.endsWith('.md'))
    .sort();
  const documents = new Map<string, string>(
    guideFiles.map((file) => [`docs/guides/${file}`, `guides/${file.slice(0, -3)}`]),
  );
  documents.set('site/content/start.md', 'guides/start');
  documents.set('site/content/agents.md', 'agents');
  documents.set('docs/getting-started.md', 'guides/getting-started');
  documents.set('docs/stability.md', 'guides/stability');
  documents.set('docs/bundle-size.md', 'guides/bundle-size');
  documents.set('SECURITY.md', 'guides/security');
  const guideCards: string[] = [];
  for (const [source, path] of documents) {
    let contents = readFileSync(join(ROOT, source), 'utf8');
    const title = /^# (.+)$/m.exec(contents)?.[1] ?? path;
    if (source === 'site/content/agents.md') {
      const profiles = REGISTRY_PROFILES.map((profile) => ({
        profile,
        packs: packsForProfile(profile),
      }));
      contents +=
        '\n## Available profiles\n\n| Profile | Packs | Registered operations before permission filtering |\n| --- | --- | --- |\n' +
        profiles
          .map(
            ({ profile, packs }) =>
              `| ${profile} | ${packs.map((pack) => pack.name).join(', ')} | ${packs.reduce((count, pack) => count + pack.operations.length, 0)} |`,
          )
          .join('\n');
      contents +=
        '\n\nSee the [complete operation catalog](/agents/operations/) for input/output schemas, capabilities, handle fields, cost, and discovery profiles.\n';
    }
    const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
    const headings = new Map<string, number>();
    markdown.renderer.rules['heading_open'] = (tokens, index, options, _environment, renderer) => {
      const text = tokens[index + 1]?.content ?? '';
      const base = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-');
      const seen = headings.get(base) ?? 0;
      headings.set(base, seen + 1);
      tokens[index]!.attrSet('id', `${base}${seen ? `-${seen}` : ''}`);
      return renderer.renderToken(tokens, index, options);
    };
    markdown.renderer.rules['link_open'] = (tokens, index, options, _environment, renderer) => {
      const href = tokens[index]!.attrGet('href') ?? '';
      if (href && !/^(?:https?:|mailto:|#|\/)/.test(href)) {
        const [file, fragment] = href.split('#');
        const resolved = posix.normalize(posix.join(posix.dirname(source), file!));
        const target = resolved === 'STABILITY.md' ? 'guides/stability' : documents.get(resolved);
        if (target) tokens[index]!.attrSet('href', `/${target}/${fragment ? `#${fragment}` : ''}`);
        else {
          // An internal test/spec reference is useful provenance, not a public navigation target.
          // Do not send readers to an unrelated reference page disguised as the original link.
          tokens[index]!.tag = 'span';
          tokens[index]!.attrs = [
            ['title', 'Source-checkout reference; not part of the public learning path.'],
          ];
          const closing = tokens.slice(index + 1).find((token) => token.type === 'link_close');
          if (closing) closing.tag = 'span';
        }
      }
      return renderer.renderToken(tokens, index, options);
    };
    page(
      path,
      title,
      `<div class="prose">${!release.published ? '<p class="callout">Unpublished source build: registry install examples below apply after publication. For now, build the checkout; see <a href="/versions/">versions and local setup</a>.</p>' : ''}${markdown.render(contents)}</div>`,
      path === 'agents' ? 'connect-an-agent' : '',
    );
    if (path === 'agents') {
      headings.clear();
      page(
        'learn/connect-an-agent',
        title,
        `<div class="prose">${markdown.render(contents)}</div>`,
        'connect-an-agent',
      );
    } else
      guideCards.push(
        `<a class="task-card" href="/${path}/"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(
          contents
            .split('\n')
            .find((line) => line.length > 60 && !line.startsWith('#'))
            ?.slice(0, 150) ?? 'Conventions and runnable examples.',
        )}</p></a>`,
      );
    searchRecords.push({
      title,
      url: `/${path}/`,
      description: contents
        .replace(/[#`*]/g, '')
        .split('\n')
        .filter(Boolean)
        .slice(1, 3)
        .join(' ')
        .slice(0, 240),
      category: 'Guide',
      keywords: contents.replace(/```[\s\S]*?```/g, '').slice(0, 20000),
      kind: 'guide',
    });
  }
  page(
    'guides',
    'Guides & conventions',
    `<div class="page-intro"><p class="eyebrow">Understand the answer</p><h1>Guides & conventions</h1><p>Start with <a href="/guides/start/">a small function</a>, then learn the assumptions that make a result useful.</p></div><div class="task-grid">${guideCards.join('')}</div>`,
  );

  console.log('Generating the complete public reference…');
  const reference = buildPublicReference();
  const grouped = new Map<string, ReferenceEntry[]>();
  for (const entry of reference.entries) {
    const path = referencePath(entry);
    const list = grouped.get(path) ?? [];
    list.push(entry);
    grouped.set(path, list);
  }
  const exportUrls = new Map<string, string>();
  const referenceSearch = new Map<string, SearchRecord>();
  for (const [path, entries] of grouped) {
    const first = entries[0]!;
    for (const entry of entries) {
      if (entry.members.length <= 150 && Buffer.byteLength(memberTable(entry.members)) <= 100000)
        continue;
      const fields: ReferenceEntry['members'][] = [];
      let chunk: ReferenceEntry['members'] = [];
      let bytes = 0;
      for (const member of entry.members) {
        const size = Buffer.byteLength(memberTable([member]));
        if (chunk.length && (chunk.length >= 150 || bytes + size > 100000)) {
          fields.push(chunk);
          chunk = [];
          bytes = 0;
        }
        chunk.push(member);
        bytes += size;
      }
      if (chunk.length) fields.push(chunk);
      const links = fields.map((members, index) => ({
        url: `/${path}/members/${encodeURIComponent(entry.name)}/${index + 1}/`,
        first: members[0]!.name,
        last: members.at(-1)!.name,
      }));
      memberPages.set(entry.id, links);
      fields.forEach((members, index) =>
        page(
          links[index]!.url.slice(1, -1),
          `${entry.name}: fields ${index + 1}`,
          `<div class="page-intro"><p class="eyebrow">${escapeHtml(entry.entrypoint)}</p><h1>${escapeHtml(entry.name)} · field contracts</h1><p>Page ${index + 1} of ${fields.length}. <a href="/${path}/">Back to the entry point</a> or <a href="/search/?q=${encodeURIComponent(entry.name)}">find this declaration</a>.</p><nav aria-label="Field pages">${links.map((link, n) => `<a class="button quiet" href="${link.url}"${index === n ? ' aria-current="page"' : ''}>${n + 1}</a>`).join(' ')}</nav></div>${memberTable(members)}`,
        ),
      );
    }
    // Bounded static pages: large umbrella/TA roots must not force an 8 MB HTML download just to
    // inspect one function. Every export retains a stable link and searchable complete contract.
    const chunks: ReferenceEntry[][] = [];
    let current: ReferenceEntry[] = [];
    let currentBytes = 0;
    for (const entry of entries) {
      const bytes = Buffer.byteLength(referenceEntry(entry));
      if (current.length && (current.length >= 25 || currentBytes + bytes > 180000)) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(entry);
      currentBytes += bytes;
    }
    if (current.length) chunks.push(current);
    chunks.forEach((chunk, index) => {
      for (const entry of chunk)
        exportUrls.set(
          entry.id,
          `/${index ? `${path}/page-${index + 1}` : path}/#${encodeURIComponent(entry.name)}`,
        );
    });
    chunks.forEach((chunk, index) => {
      const chunkPath = index ? `${path}/page-${index + 1}` : path;
      const pagination =
        chunks.length > 1
          ? `<nav aria-label="Reference pages">${chunks.map((_chunk, pageIndex) => `<a class="button quiet" href="/${pageIndex ? `${path}/page-${pageIndex + 1}` : path}/"${pageIndex === index ? ' aria-current="page"' : ''}>${pageIndex + 1}</a>`).join(' ')}</nav>`
          : '';
      page(
        chunkPath,
        first.entrypoint,
        `<div class="page-intro"><p class="eyebrow">Public API / ${escapeHtml(first.package)}</p><h1>${escapeHtml(first.entrypoint)}</h1><p class="entrypoint">import from '${escapeHtml(first.entrypoint)}'</p><p>Every public export in this entry point, including type-only declarations. <a href="/search/">Search by name or concept</a>.</p><details><summary>Jump to an export (${entries.length})</summary><p>${entries.map((entry) => `<a href="${escapeHtml(exportUrls.get(entry.id)!)}">${escapeHtml(entry.name)}</a>`).join(' · ')}</p></details>${pagination}</div><div class="prose">${chunk.map(referenceEntry).join('')}</div>${pagination}`,
      );
    });
    for (const entry of entries) {
      // Re-exports share a search hit only when name, package AND full signature agree. Every
      // import path stays indexed as a keyword and retains its independent full reference page.
      const key = JSON.stringify([entry.package, entry.name, entry.signature]);
      const previous = referenceSearch.get(key);
      if (previous) {
        if (!previous.keywords.includes(entry.entrypoint))
          previous.keywords += ` ${entry.entrypoint}`;
      } else
        referenceSearch.set(key, {
          title: entry.name,
          url: exportUrls.get(entry.id)!,
          description: entry.description.slice(0, 160) || `${entry.kind} from ${entry.entrypoint}`,
          category: entry.package,
          kind: entry.kind,
          keywords: `${entry.entrypoint} ${entry.kind} ${entry.tags
            .map((tag) => tag.text)
            .join(' ')
            .slice(0, 100)} ${entry.members
            .map((member) => member.name)
            .join(' ')
            .slice(0, 140)}`,
        });
    }
  }
  searchRecords.push(...referenceSearch.values());
  // Export maps, not a manually curated package menu, own complete entrypoint coverage.
  for (const pkg of reference.packages)
    for (const entrypoint of pkg.entrypoints) {
      const path = referencePath({ package: pkg.name, entrypoint });
      searchRecords.push({
        title: entrypoint,
        url: `/${path}/`,
        description: `Public import: ${entrypoint}. Browse its complete export contracts.`,
        category: pkg.name,
        keywords: entrypoint,
        kind: 'entrypoint',
      });
      if (!pages.has(`/${path}/`))
        page(
          path,
          entrypoint,
          `<h1>${escapeHtml(entrypoint)}</h1><p>This supported entry point has no named exports.</p><pre>${escapeHtml(pkg.stability)}</pre>`,
        );
    }
  page(
    'reference',
    'Complete API reference',
    `<div class="page-intro"><p class="eyebrow">Generated from the source</p><h1>The complete reference</h1><p>${reference.packages.length} packages. ${reference.packages.reduce((count, pkg) => count + pkg.entrypoints.length, 0)} supported entry points. ${reference.entries.length.toLocaleString('en-US')} export paths, including aliases and types.</p><form action="/search/" class="searchbox"><label for="reference-search" class="sr-only">Search the API</label><input id="reference-search" name="q" type="search" placeholder="Search Black–Scholes, DCF, portfolioPnl…"/></form></div><div class="reference-grid">${reference.packages.map((pkg) => `<section><h2>${escapeHtml(pkg.name)}</h2><p>${escapeHtml(pkg.description)}</p><p>${pkg.entrypoints.map((entrypoint) => `<a href="/${referencePath({ package: pkg.name, entrypoint })}/"><code>${escapeHtml(entrypoint)}</code></a>`).join(' · ')}</p></section>`).join('')}</div>`,
  );

  const operationRows = reference.operations
    .map((operation) => {
      const url = `/agents/operations/${operation.id}/`;
      searchRecords.push({
        title: operation.id,
        url,
        description: operation.description,
        category: 'MCP / CLI / HTTP operation',
        keywords: `${operation.title} ${operation.pack} ${operation.profiles.join(' ')}`,
        kind: 'operation',
      });
      const metadata = `<table><tbody><tr><th>Pack / profiles</th><td>${escapeHtml(operation.pack)} / ${escapeHtml(operation.profiles.join(', '))}</td></tr><tr><th>Default discovery</th><td>${operation.defaultEnabled ? 'Included' : 'Opt-in'}</td></tr><tr><th>Required capabilities</th><td>${escapeHtml(operation.requiredCapabilities.join(', ') || 'None')}</td></tr><tr><th>Effects / authorization</th><td>${escapeHtml(operation.sideEffect)} / ${escapeHtml(operation.authorization)}</td></tr><tr><th>Cost / cancellation</th><td>${escapeHtml(operation.costClass)} / ${operation.supportsCancellation ? 'Supported by configured worker execution' : 'Do not assume inline interruption'}</td></tr><tr><th>Handle-eligible inputs</th><td>${escapeHtml(operation.handleFields.join(', ') || 'None')}</td></tr><tr><th>Idempotency</th><td>${escapeHtml(operation.idempotency)}</td></tr></tbody></table>`;
      page(
        url.slice(1, -1),
        operation.title,
        `<div class="prose"><p class="eyebrow">${escapeHtml(operation.pack)} / wire operation</p><h1>${escapeHtml(operation.title)}</h1><p><code>${operation.id}</code></p><p>${escapeHtml(operation.description)}</p>${metadata}<details open><summary>Input schema</summary><pre>${escapeHtml(JSON.stringify(operation.inputSchema, null, 2))}</pre></details><details><summary>Output schema</summary><pre>${escapeHtml(JSON.stringify(operation.outputSchema, null, 2))}</pre></details><p><a href="/agents/operations/">All operations</a> · <a href="/agents/">Setup, handles, jobs & permissions</a></p></div>`,
      );
      return `<article class="reference-entry" id="${operation.id}"><h2><a href="${url}">${escapeHtml(operation.title)}</a></h2><p><code>${operation.id}</code></p><p>${escapeHtml(operation.description)}</p><p>${escapeHtml(operation.pack)} · ${operation.defaultEnabled ? 'Default' : 'Opt-in'} · <a href="${url}">Full schemas and capability contract</a></p></article>`;
    })
    .join('');
  page(
    'agents/operations',
    'Operation coverage',
    `<div class="page-intro"><p class="eyebrow">One registry, several front doors</p><h1>Operation coverage</h1><p>${reference.operations.length} registered operations. The default profile exposes ${reference.operations.filter((operation) => operation.defaultEnabled).length}; selected packs and permissions determine effective availability. This is not the full SDK export surface.</p><p>Basic option pricing is European Black–Scholes–Merton. Additional engines, custom callbacks, and specialist APIs remain <a href="/reference/">SDK-only</a>. No live brokerage or data fetching is implied.</p></div><div class="prose">${operationRows}</div>`,
  );
  page(
    'search',
    'Search TotalFinance',
    '<div class="page-intro"><p class="eyebrow">Find the right call</p><h1>Search TotalFinance</h1><form data-search-form class="searchbox"><label for="search-query" class="sr-only">Search tasks, functions, types and operations</label><input id="search-query" type="search" name="q" placeholder="Try blackScholesPrice, discounted cash flow, or portfolio…"/><button class="button primary" type="submit">Search</button></form><p data-search-status role="status">Search functions, types, tasks, or financial concepts.</p></div><div data-search-results class="search-results"></div><noscript><p>Search needs JavaScript. Browse the <a href="/reference/">complete reference</a> without it.</p></noscript>',
  );
  page(
    'versions',
    'Versions & stability',
    `<div class="prose">
    <p class="eyebrow">Know what you are running</p><h1>Versions & stability</h1>
    <p class="version-badge">${escapeHtml(release.label)}</p>
    <p>These pages and playgrounds are generated from the same fixed package group. A development build is not a published preview or stable release.</p>
    ${release.published ? `<h2>Install this exact release</h2><pre>pnpm add totalfinance@${release.version}</pre><pre>npx -y @totalfinance/mcp@${release.version}</pre>` : '<h2>Use this source build</h2><p>This checkout is not verified as matching a public release. In the TotalFinance directory, run:</p><pre>pnpm install --frozen-lockfile\npnpm build\npnpm site:build\npnpm site:dev</pre><p>Import from the workspace or test its packed tarballs. Registry install examples elsewhere are release instructions, not evidence that this source is published.</p>'}
    <h2>Preview versus stable</h2><p>Preview releases are explicitly pre-1.0 and may include deliberate breaking changes. Stable status requires a verified stable registry release, its own smoke tests, and maintainer authorization. ${release.channel === 'stable' ? 'This build matches the recorded stable release.' : 'No stable release is advertised by this build.'}</p>
    <p><a href="/versions/${release.version}/">Browse this version-pinned documentation snapshot</a>.</p>
    ${archivedVersions.length ? `<h2>Earlier releases</h2><ul>${archivedVersions.map((version) => `<li><a href="/versions/${version}/">${escapeHtml(version)}</a> — preserved pages, search, examples, and assets</li>`).join('')}</ul>` : ''}
    <h2>Package stability</h2><p>Read <a href="/guides/stability/">the stability policy</a> and the package-level contracts in the reference. A model or platform subpath can have a different maturity from the package as a whole.</p>
    <h2>Verified public release evidence</h2>${release.releases.length ? `<pre>${escapeHtml(JSON.stringify(release.releases, null, 2))}</pre>` : '<p>No public registry release has been recorded. Local tests and packed rehearsals do not substitute for publication evidence.</p>'}
    <h2>Package versions in this build</h2><table><tbody>${Object.entries(release.packageVersions)
      .map(
        ([name, version]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(version)}</td></tr>`,
      )
      .join('')}</tbody></table>
    </div>`,
  );

  writeFileSync(join(OUT, 'search-index.json'), JSON.stringify(searchRecords));
  writeFileSync(join(OUT, 'version.json'), JSON.stringify(release, null, 2));
  writeFileSync(join(OUT, 'operation-catalog.json'), JSON.stringify(reference.operations));
  cpSync(join(ROOT, 'packages/http/etc/openapi.json'), join(OUT, 'openapi.json'));
  const entrypointInventory = reference.packages.map((pkg) => ({
    package: pkg.name,
    entrypoints: pkg.entrypoints,
  }));
  writeFileSync(
    join(OUT, 'reference-coverage.json'),
    JSON.stringify({
      packages: entrypointInventory,
      exportPaths: reference.entries.map((entry) => ({
        id: entry.id,
        url: exportUrls.get(entry.id)!,
      })),
    }),
  );
  for (const name of ['llms.txt', 'llms-full.txt'])
    if (existsSync(join(ROOT, 'docs', name))) {
      const text = readFileSync(join(ROOT, 'docs', name), 'utf8').replace(
        /\]\(([^)#]+\.md)(#[^)]*)?\)/g,
        (_match, file: string, fragment: string | undefined) => {
          const path = documents.get(posix.normalize(posix.join('docs', file)));
          return path ? `](/${path}/${fragment ?? ''})` : `](/guides/)`;
        },
      );
      writeFileSync(join(OUT, name), text);
    }
  // A complete self-contained version snapshot, not a selector that silently serves today's API.
  const versionBase = `/versions/${release.version}`;
  for (const [url, html] of pages) {
    const target = join(OUT, versionBase, url);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'index.html'),
      html
        .replace('<html lang="en">', `<html lang="en" data-base="${versionBase}">`)
        .replace(/(href|src|action)="\/(?!versions\/)/g, `$1="${versionBase}/`),
    );
  }
  cpSync(join(OUT, 'assets'), join(OUT, versionBase, 'assets'), { recursive: true });
  for (const name of ['version.json', 'operation-catalog.json', 'openapi.json'])
    if (existsSync(join(OUT, name))) cpSync(join(OUT, name), join(OUT, versionBase, name));
  for (const name of ['llms.txt', 'llms-full.txt'])
    if (existsSync(join(OUT, name)))
      writeFileSync(
        join(OUT, versionBase, name),
        readFileSync(join(OUT, name), 'utf8').replace(/\]\(\/(?!versions\/)/g, `](${versionBase}/`),
      );
  writeFileSync(
    join(OUT, versionBase, 'reference-coverage.json'),
    JSON.stringify({
      packages: entrypointInventory,
      exportPaths: reference.entries.map((entry) => ({
        id: entry.id,
        url: `${versionBase}${exportUrls.get(entry.id)!}`,
      })),
    }),
  );
  writeFileSync(
    join(OUT, versionBase, 'search-index.json'),
    JSON.stringify(
      searchRecords.map((record) => ({ ...record, url: `${versionBase}${record.url}` })),
    ),
  );
  writeFileSync(
    join(OUT, 'available-versions.json'),
    JSON.stringify({ current: release.version, archived: archivedVersions }),
  );
  writeFileSync(join(OUT, 'routes.json'), JSON.stringify([...pages.keys()]));
  writeFileSync(join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  writeFileSync(
    join(OUT, '404.html'),
    layout(
      'Page not found',
      '<h1>That page is not here.</h1><p>Try <a href="/search/">search</a>, the <a href="/reference/">API reference</a>, or <a href="/">start with a task</a>.</p>',
    ),
  );
  console.log(
    `TotalFinance site built: ${pages.size} routes, ${reference.entries.length} export paths, ${reference.operations.length} operations. Output: ${OUT}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildSite();
