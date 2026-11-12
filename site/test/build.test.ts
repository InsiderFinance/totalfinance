import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readSiteVersion } from '../version.js';
import { search, type SearchRecord } from '../src/search.js';
import { playgrounds } from '../src/playgrounds/index.js';
import { inlineScripts } from '../scripts/postexport.js';
import { DOMAIN_BUNDLE_BUDGET_BYTES } from '../scripts/llms.js';
import { markdownRoute, routeHtmlFile } from '../src/routes.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'site/dist');
const BASE = '/docs/totalfinance';
const version = readSiteVersion(ROOT);
const SNAPSHOT = join(OUT, 'versions', version.version);

/** Budgets: every page stays light enough to read on a phone. */
const HTML_BUDGET_BYTES = 600_000;
const JS_BUDGET_GZIP_BYTES = 240_000;
const SEARCH_INDEX_BUDGET_GZIP_BYTES = 600_000;

const routes = JSON.parse(readFileSync(join(OUT, 'routes.json'), 'utf8')) as string[];
const html = (route: string, out = OUT) => readFileSync(join(out, routeHtmlFile(route)), 'utf8');
const records = JSON.parse(readFileSync(join(OUT, 'search-index.json'), 'utf8')) as SearchRecord[];

function walk(directory: string, files: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

/** A base-path URL resolves to a file of the export: a page (`x.html`), a file, or a snapshot root. */
function resolves(out: string, base: string, href: string): boolean {
  const path = decodeURIComponent(href.slice(base.length).split(/[?#]/)[0]!) || '/';
  const target = resolve(out, `.${path}`);
  if (!target.startsWith(out)) return false;
  if (existsSync(target) && statSync(target).isFile()) return true;
  return existsSync(`${target}.html`) || existsSync(join(target, 'index.html'));
}

describe('built public documentation', () => {
  it('serves the recovered marketing homepage with the supplied brand and no development banner', () => {
    const home = html('/');
    expect(home).toContain('The complete finance library for TypeScript and');
    expect(home).toContain('AI agents.');
    expect(home).toContain('Give your agent a calculator it can trust.');
    expect(home).toContain('Finance code fails quietly. TotalFinance makes it speak up.');
    expect(home).toContain('Drag a slider. Watch the library answer.');
    expect(home).toContain('The finance library, tree-shakeable.');
    expect(home).not.toContain('What do you want');
    expect(home).not.toContain('Discord bot');
    const libraryNav = html('/start');
    expect(libraryNav).toContain('<p class="tf-nav-group">Library</p>');
    expect(libraryNav).toContain(`href="${BASE}/domains/fixed-income"`);
    expect(libraryNav).toContain(`href="${BASE}/domains/valuation"`);
    expect(home).not.toContain('Development ·');
    expect(home).not.toContain('Using the source build until publication');
    expect(home).toContain('href="https://www.totalfinance.io/"');
    expect(home).toContain('src="/docs/totalfinance/assets/brand/favicon.svg"');
    expect(home).toContain('https://www.totalfinance.io/assets/brand/og.png');
    for (const out of [OUT, SNAPSHOT]) {
      for (const name of [
        'favicon.svg',
        'logo.svg',
        'favicon.ico',
        'og.png',
        'apple-touch-icon.png',
      ])
        expect(readFileSync(join(out, 'assets/brand', name))).toEqual(
          readFileSync(join(ROOT, 'site/brand/assets', name)),
        );
    }
    const png = readFileSync(join(OUT, 'assets/brand/og.png'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(readFileSync(join(OUT, 'assets/brand/favicon.ico')).readUInt16LE(2)).toBe(1);
  });

  it('keeps natural task/function searches useful against the complete generated index', () => {
    expect(records.every((record) => Boolean(record.kind))).toBe(true);
    const blackScholes = search(records, 'black scholes');
    expect(blackScholes[0]!.title).toBe('blackScholes');
    expect(blackScholes.slice(0, 5).some((record) => record.title === 'blackScholesPrice')).toBe(
      true,
    );
    for (const name of [
      'blackScholesPrice',
      'BlackScholesTypedInput',
      'optionChainHealth',
      'exposureFromGreeks',
      'compareCalculationArtifacts',
    ])
      expect(search(records, name)[0]!.title, name).toBe(name);
    expect(search(records, 'portfolio P&L')[0]!.title).toBe('portfolioPnl');
    expect(search(records, 'DCF')[0]!.title).toBe('discountedCashFlow');
    for (const playground of playgrounds)
      expect(search(records, playground.id.replaceAll('-', ' '))[0]!.url, playground.id).toBe(
        `/learn/${playground.id}`,
      );
    expect(search(records, 'connect an agent')[0]!.url).toBe('/agents');
    // #336 is integrated: missing sector exports must fail, not silently skip this gate.
    expect(search(records, 'sector performance')[0]!.title).toBe('sectorPerformance');
    const pinned = JSON.parse(
      readFileSync(join(SNAPSHOT, 'search-index.json'), 'utf8'),
    ) as SearchRecord[];
    expect(search(pinned, 'black scholes').map((record) => record.url)).toEqual(
      blackScholes.map((record) => record.url),
    );
  });

  it('finds every explicit package import before an incidental keyword match', () => {
    const coverage = JSON.parse(readFileSync(join(OUT, 'reference-coverage.json'), 'utf8')) as {
      packages: { entrypoints: string[] }[];
    };
    for (const entrypoint of coverage.packages.flatMap((pkg) => pkg.entrypoints)) {
      const result = search(records, entrypoint)[0]!;
      expect(result.title, entrypoint).toBe(entrypoint);
      expect(result.kind, entrypoint).toBe('entrypoint');
    }
  });

  it('has every calculator page, with package metadata and without release-status banners, with no internal tracker in public pages', () => {
    for (const playground of playgrounds) {
      const page = html(`learn/${playground.id}`);
      expect(page).toContain('Skip to content');
      expect(page).toContain('Run it');
      expect(page).toContain(`data-tf-version="${version.version}"`);
      const header = /<header[\s\S]*?<\/header>/.exec(page)?.[0] ?? '';
      expect(header).not.toContain(version.label);
      expect(page).not.toContain('TODO');
    }
    expect(html('learn/backtest-a-strategy')).toContain('Price, signals, equity and drawdown');
    for (const route of routes) expect(html(route), route).not.toContain('implementation-order.md');
  });

  it('every route and local link resolves without a redirect, pages stay within budget, and every export path has its anchor', () => {
    const missing = new Set<string>();
    const slashed = new Set<string>();
    for (const route of routes) {
      const page = html(route);
      expect(Buffer.byteLength(page), `${route}: split or lazy-load large content`).toBeLessThan(
        HTML_BUDGET_BYTES,
      );
      for (const match of page.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
        const href = match[1]!.replaceAll('&amp;', '&');
        if (href !== BASE && !href.startsWith(`${BASE}/`)) continue;
        if (!resolves(OUT, BASE, href)) missing.add(`${route} → ${href}`);
        // The hosting app redirects `/x/` to `/x`; a slashed link costs every reader a redirect.
        if (/\/(?:[?#]|$)/.test(href)) slashed.add(`${route} → ${href}`);
      }
    }
    expect([...missing]).toEqual([]);
    expect([...slashed]).toEqual([]);
    // Clean-URL hosts redirect `/x/index` to `/x`, so no page may live at such a route.
    expect(routes.filter((route) => /\/index$/.test(route))).toEqual([]);
    const coverage = JSON.parse(readFileSync(join(OUT, 'reference-coverage.json'), 'utf8')) as {
      packages: { package: string }[];
      exportPaths: { id: string; url: string }[];
    };
    expect(coverage.packages.map((pkg) => pkg.package).sort()).toEqual([
      '@insiderfinance/totalfinance',
      '@insiderfinance/totalfinance-mcp',
    ]);
    const cache = new Map<string, string>();
    for (const exported of coverage.exportPaths) {
      const [url, anchor] = exported.url.split('#');
      let text = cache.get(url!);
      if (!text) {
        text = readFileSync(join(OUT, routeHtmlFile(url!)), 'utf8');
        cache.set(url!, text);
      }
      expect(text.includes(`id="${decodeURIComponent(anchor!)}"`), exported.id).toBe(true);
    }
  });

  it('loads a bounded amount of JavaScript and never the calculators outside calculator pages', () => {
    for (const route of routes) {
      const page = html(route);
      const scripts = [
        ...new Set(
          [...page.matchAll(/<script src="([^"]+\.js)" async=""/g)].map((match) => match[1]!),
        ),
      ];
      const gzip = scripts.reduce(
        (total, src) => total + gzipSync(readFileSync(join(OUT, src.slice(BASE.length)))).length,
        0,
      );
      expect(gzip, route).toBeLessThan(JS_BUDGET_GZIP_BYTES);
    }
    expect(gzipSync(readFileSync(join(OUT, 'search-index.json'))).length).toBeLessThan(
      SEARCH_INDEX_BUDGET_GZIP_BYTES,
    );
  });

  it('every page has a Markdown twin with no unrendered MDX components', () => {
    for (const route of routes) {
      const twin = join(OUT, markdownRoute(route));
      // The search page is an interactive tool, not content; agents use search-index.json or the MCP.
      if (route === '/search') continue;
      expect(existsSync(twin), route).toBe(true);
      const markdown = readFileSync(twin, 'utf8');
      expect(markdown, route).toMatch(/^# /);
      expect(markdown, route).not.toMatch(
        /<(?:Cards|Card|DomainGrid|KeyExports|EntrypointList|PlaygroundGallery|GuideIndex|AgentProfiles|OperationCount|Callout)\b/,
      );
    }
    const calculator = readFileSync(join(OUT, 'learn/price-an-option.md'), 'utf8');
    expect(calculator).toContain('## Calculator: Price a European option');
    expect(calculator).toContain('blackScholes.price(input)');
  });

  it('agent files: llms.txt links resolve, domain bundles fit their budget, the full reference is present', () => {
    const llms = readFileSync(join(OUT, 'llms.txt'), 'utf8');
    expect(llms).toMatch(/^# TotalFinance\n\n> /);
    const links = [...llms.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map(
      (match) => new URL(match[1]!).pathname,
    );
    expect(links.length).toBeGreaterThan(50);
    for (const path of links) expect(resolves(OUT, BASE, path), path).toBe(true);
    const bundles = readdirSync(join(OUT, 'llms'));
    expect(bundles.length).toBeGreaterThanOrEqual(20);
    for (const bundle of bundles) {
      const size = statSync(join(OUT, 'llms', bundle)).size;
      expect(size, bundle).toBeLessThanOrEqual(DOMAIN_BUNDLE_BUDGET_BYTES);
      expect(readFileSync(join(OUT, 'llms', bundle), 'utf8')).not.toContain('reached its');
    }
    expect(statSync(join(OUT, 'llms-full.txt')).size).toBeGreaterThan(1_000_000);
  });

  it('every page carries a script-hash CSP: no inline script runs unless its exact hash is listed', () => {
    for (const route of routes) {
      const page = html(route);
      const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(page)?.[1];
      expect(policy, route).toBeTruthy();
      expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(policy).toContain("object-src 'none'");
      for (const script of inlineScripts(page))
        expect(policy, route).toContain(
          `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`,
        );
      expect(page.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
        page.indexOf('<script'),
      );
    }
  });

  it('follows the explicit indexing policy', () => {
    const robots = readFileSync(join(OUT, 'robots.txt'), 'utf8');
    if (version.published) {
      expect(robots).toContain('Allow: /');
      expect(existsSync(join(OUT, 'sitemap.xml'))).toBe(true);
    } else {
      expect(robots).toContain('Disallow: /');
      expect(existsSync(join(OUT, 'sitemap.xml'))).toBe(false);
      expect(html('learn/price-an-option')).toMatch(/<meta name="robots" content="noindex/);
    }
    expect(html('learn/price-an-option')).toContain(
      'rel="canonical" href="https://www.totalfinance.io/docs/totalfinance/learn/price-an-option"',
    );
  });

  it('ships a self-contained version-pinned snapshot that is never indexed and points canonicals at the current docs', () => {
    const snapshotBase = `${BASE}/versions/${version.version}`;
    const pinned = html('learn/price-an-option', SNAPSHOT);
    expect(pinned).toContain(`data-tf-base="${snapshotBase}"`);
    expect(pinned).toMatch(/<meta name="robots" content="noindex/);
    expect(pinned).toContain(
      'rel="canonical" href="https://www.totalfinance.io/docs/totalfinance/learn/price-an-option"',
    );
    for (const match of pinned.matchAll(/(?:href|src)="(\/docs\/totalfinance[^"]*)"/g)) {
      const href = match[1]!;
      if (href.startsWith(`${BASE}/versions/`) || href === BASE) continue;
      throw new Error(`Snapshot links outside itself: ${href}`);
    }
    expect(readFileSync(join(SNAPSHOT, 'llms.txt'), 'utf8')).toContain(
      `${snapshotBase}/learn/price-an-option.md`,
    );
    expect(existsSync(join(SNAPSHOT, 'learn/price-an-option.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(OUT, 'available-versions.json'), 'utf8'))).toMatchObject({
      current: version.version,
    });
  });

  it('puts AI agents up front: the home page, /agents, every calculator, twins and llms.txt', () => {
    const home = html('/');
    expect(home).toContain('Give your agent a calculator it can trust.');
    expect(home).toContain('Connect your AI agent');
    const agents = html('/agents');
    for (const client of [
      'Claude Code',
      'Claude Desktop',
      'Cursor',
      'VS Code',
      'Codex',
      'Windsurf',
      'Gemini CLI',
    ])
      expect(agents, client).toContain(`>${client}<`);
    expect(agents).toContain('https://www.totalfinance.io/docs/totalfinance/mcp');
    expect(html('/agents/handbook')).toContain('Agent handbook');
    const twin = readFileSync(join(OUT, 'agents.md'), 'utf8');
    for (const client of [
      'Claude Code',
      'Claude Desktop',
      'Cursor',
      'VS Code',
      'Codex',
      'Windsurf',
      'Gemini CLI',
      'ChatGPT',
    ])
      expect(twin, client).toContain(`#### ${client}`);
    for (const playground of playgrounds) {
      expect(html(`/learn/${playground.id}`), playground.id).toContain('Ask your AI agent');
      expect(readFileSync(join(OUT, `learn/${playground.id}.md`), 'utf8')).toContain(
        '### Ask your AI agent',
      );
    }
    expect(readFileSync(join(OUT, 'llms.txt'), 'utf8')).toContain(
      '## Use TotalFinance as tools (MCP)',
    );
    // Agents follow Markdown links verbatim; a slashed one costs a redirect on every fetch.
    const slashed = new Set<string>();
    const site = 'https://www.totalfinance.io/docs/totalfinance';
    for (const file of walk(OUT)) {
      if (!/\.(md|txt)$/.test(file) || file.includes(`${join(OUT, 'versions')}`)) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/\]\((https:\/\/[^)\s]+)\)/g))
        if (match[1]!.startsWith(site) && /\/(?:#[^)]*)?$/.test(match[1]!))
          slashed.add(`${file.slice(OUT.length)} → ${match[1]}`);
    }
    expect([...slashed].slice(0, 10)).toEqual([]);
  });

  it('ships the example runner: every browser-safe entry point, a no-network sandbox page, no route', () => {
    const manifest = JSON.parse(readFileSync(join(OUT, 'runtime/manifest.json'), 'utf8')) as {
      version: string;
      imports: Record<string, string>;
      transpiler: string;
      worker: string;
      nodeOnly: string[];
    };
    const exportsMap = JSON.parse(
      readFileSync(join(ROOT, 'distribution/totalfinance/package.json'), 'utf8'),
    ) as { version: string; exports: Record<string, unknown> };
    const publicEntries = Object.keys(exportsMap.exports).filter((key) => !key.endsWith('.json'));
    expect(manifest.version).toBe(exportsMap.version);
    expect(manifest.nodeOnly.sort()).toEqual([
      '@insiderfinance/totalfinance/cli',
      '@insiderfinance/totalfinance/http',
      '@insiderfinance/totalfinance/workflows/local',
    ]);
    expect(Object.keys(manifest.imports).length + manifest.nodeOnly.length).toBe(
      publicEntries.length,
    );
    for (const file of [...Object.values(manifest.imports), manifest.transpiler, manifest.worker])
      expect(existsSync(join(OUT, 'runtime', file)), file).toBe(true);
    const runner = readFileSync(join(OUT, 'runtime/runner.html'), 'utf8');
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(runner)![1]!;
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("default-src 'none'");
    expect(inlineScripts(runner)).toEqual([]);
    expect(runner).toContain('<meta name="robots" content="noindex">');
    expect(routes.some((route) => route.startsWith('/runtime'))).toBe(false);
    expect(existsSync(join(SNAPSHOT, 'runtime/runner.html'))).toBe(true);
    // Pages may frame only their own origin (the runner), nothing else.
    expect(html('learn/price-an-option')).toContain("frame-src 'self'");
  });

  it('publishes machine-readable catalogs and no private or duplicate artifacts', () => {
    expect(
      JSON.parse(readFileSync(join(OUT, 'operation-catalog.json'), 'utf8')).length,
    ).toBeGreaterThanOrEqual(46);
    expect(readFileSync(join(OUT, 'openapi.json'))).toEqual(
      readFileSync(join(ROOT, 'packages/http/etc/openapi.json')),
    );
    expect(JSON.parse(readFileSync(join(OUT, 'version.json'), 'utf8'))).toEqual(version);
    expect(JSON.parse(readFileSync(join(OUT, 'calculators.json'), 'utf8'))).toHaveLength(
      playgrounds.length,
    );
    const files = walk(OUT);
    expect(files.filter((file) => file.endsWith('__next._full.txt'))).toEqual([]);
    expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
    expect(files.filter((file) => /implementation-order|\.git\//.test(file))).toEqual([]);
    expect(resolve(OUT)).toBe(join(ROOT, 'site/dist'));
  });
});
