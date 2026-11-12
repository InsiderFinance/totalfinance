import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readSiteVersion } from '../version.js';
import { search, type SearchRecord } from '../src/search.js';
import { DOCS_BASE, docsUrl } from '../paths.js';
import { options } from '../src/playgrounds/options.js';
import { escapeHtml, formatNumber, renderChart } from '../src/render.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE_OUT = join(ROOT, 'site/dist');
const OUT = join(SITE_OUT, DOCS_BASE);
const version = readSiteVersion(ROOT);
const versionBase = docsUrl(`/versions/${version.version}`);

describe('built public documentation', () => {
  it('ships vector branding, real favicon/social files, and sharing metadata through every docs mount', () => {
    const homepage = readFileSync(join(SITE_OUT, 'index.html'), 'utf8');
    expect(homepage).toContain('href="https://totalfinance.io/"');
    expect(homepage).toContain('property="og:url" content="https://totalfinance.io/"');
    expect(homepage).toContain('name="twitter:card" content="summary_large_image"');
    expect(homepage).toContain(
      'property="og:image" content="https://totalfinance.io/assets/brand/og.png"',
    );
    const logo = readFileSync(join(SITE_OUT, 'assets/brand/logo.svg'), 'utf8');
    expect(logo).toContain('<path');
    expect(logo).not.toMatch(/<image|data:image|<script/);
    const png = readFileSync(join(SITE_OUT, 'assets/brand/og.png'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    const touch = readFileSync(join(SITE_OUT, 'apple-touch-icon.png'));
    expect([touch.readUInt32BE(16), touch.readUInt32BE(20)]).toEqual([180, 180]);
    const ico = readFileSync(join(SITE_OUT, 'favicon.ico'));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    for (const base of [DOCS_BASE, versionBase]) {
      const html = readFileSync(join(SITE_OUT, base, 'learn/price-an-option/index.html'), 'utf8');
      expect(html).toContain(`href="${base}/assets/brand/favicon.svg"`);
      expect(html).toContain(`src="${base}/assets/brand/favicon.svg"`);
      expect(html).toContain('property="og:title" content="Price a European call · TotalFinance"');
      expect(readFileSync(join(SITE_OUT, base, 'assets/brand/og.png'))).toEqual(png);
      expect(readFileSync(join(SITE_OUT, base, 'assets/brand/logo.svg'), 'utf8')).toBe(logo);
    }
  });

  it('separates the homepage from the workbench and reuses the installed-consumer-proven example', () => {
    const homepage = readFileSync(join(SITE_OUT, 'index.html'), 'utf8');
    const workbench = readFileSync(join(OUT, 'index.html'), 'utf8');
    const calculation = options.run(
      Object.fromEntries(options.controls.map((control) => [control.name, control.value])),
    );
    expect(homepage).toContain('Finance,<br/>in your <span>code.</span>');
    expect(homepage).not.toContain('class="sidebar"');
    expect(homepage).toContain(`href="${docsUrl('/guides/start/')}"`);
    expect(homepage).toContain(`href="${docsUrl('/reference/')}"`);
    expect(homepage).toContain(
      `id="homepage-example">${escapeHtml(calculation.example.code)}</code>`,
    );
    expect(homepage).toContain(
      `${formatNumber(calculation.example.result as number)}<small> USD / share`,
    );
    expect(homepage).toContain(renderChart(calculation.chart));
    expect(homepage).toContain('Hypothetical inputs');
    expect(homepage).toContain('Pre-1.0 software');
    expect(workbench).toContain('What do you want<br/>to calculate?');
    expect(workbench).toContain(`data-base="${DOCS_BASE}"`);
    expect(existsSync(join(SITE_OUT, 'reference'))).toBe(false);
    expect(existsSync(join(SITE_OUT, 'learn'))).toBe(false);
  });

  it('keeps natural task/function searches useful against the complete generated index', () => {
    const records = JSON.parse(
      readFileSync(join(OUT, 'search-index.json'), 'utf8'),
    ) as SearchRecord[];
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
    for (const [query, url] of [
      ['price an option', '/learn/price-an-option/'],
      ['analyze a strategy', '/learn/analyze-a-strategy/'],
      ['track portfolio P&L', '/learn/track-portfolio-pnl/'],
      ['value a company', '/learn/value-a-company/'],
      ['backtest a strategy', '/learn/backtest-a-strategy/'],
      ['connect an agent', '/agents/'],
    ])
      expect(search(records, query!)[0]!.url, query).toBe(docsUrl(url!));
    // #336 is integrated: missing sector exports must fail, not silently skip this gate.
    expect(search(records, 'sector performance')[0]!.title).toBe('sectorPerformance');

    const pinned = JSON.parse(
      readFileSync(join(OUT, 'versions', version.version, 'search-index.json'), 'utf8'),
    ) as SearchRecord[];
    expect(search(pinned, 'black scholes').map((record) => record.url)).toEqual(
      blackScholes.map((record) => `${versionBase}${record.url.slice(DOCS_BASE.length)}`),
    );
  });

  it('finds every explicit package import before an incidental keyword match', () => {
    const records = JSON.parse(
      readFileSync(join(OUT, 'search-index.json'), 'utf8'),
    ) as SearchRecord[];
    const coverage = JSON.parse(readFileSync(join(OUT, 'reference-coverage.json'), 'utf8')) as {
      packages: { entrypoints: string[] }[];
    };
    for (const entrypoint of coverage.packages.flatMap((pkg) => pkg.entrypoints)) {
      const result = search(records, entrypoint)[0]!;
      expect(result.title, entrypoint).toBe(entrypoint);
      expect(result.kind, entrypoint).toBe('entrypoint');
    }
  });

  it('has all six complete task pages and no internal tracker in the public navigation', () => {
    for (const slug of [
      'price-an-option',
      'analyze-a-strategy',
      'track-portfolio-pnl',
      'value-a-company',
      'backtest-a-strategy',
      'connect-an-agent',
    ]) {
      const page = readFileSync(join(OUT, 'learn', slug, 'index.html'), 'utf8');
      expect(page).toContain('Skip to content');
      expect(page).not.toContain('implementation-order.md');
      expect(page).toContain(version.label);
      expect(page).not.toContain('TODO');
    }
    expect(readFileSync(join(OUT, 'learn/backtest-a-strategy/index.html'), 'utf8')).toContain(
      'Drawdown from the running equity peak',
    );
  });

  it('every generated route and local hyperlink resolves, with reference anchor coverage', () => {
    const routes = JSON.parse(readFileSync(join(OUT, 'routes.json'), 'utf8')) as string[];
    const missing = new Set<string>();
    for (const route of routes) {
      const html = readFileSync(join(SITE_OUT, route, 'index.html'), 'utf8');
      expect(
        Buffer.byteLength(html),
        `${route}: split large contracts into bounded pages`,
      ).toBeLessThan(350_000);
      for (const match of html.matchAll(/(?:href|src|action)="(\/[^"#?]*)(?:[?#][^"]*)?"/g)) {
        const path = join(SITE_OUT, decodeURIComponent(match[1]!));
        if (
          !existsSync(path) ||
          (statSync(path).isDirectory() && !existsSync(join(path, 'index.html')))
        )
          missing.add(match[1]!);
      }
    }
    expect([...missing]).toEqual([]);
    expect(gzipSync(readFileSync(join(OUT, 'search-index.json'))).length).toBeLessThan(600_000);
    expect(statSync(join(OUT, 'assets/client.js')).size).toBeLessThan(40_000);
    const coverage = JSON.parse(readFileSync(join(OUT, 'reference-coverage.json'), 'utf8')) as {
      packages: { package: string; entrypoints: string[] }[];
      exportPaths: { id: string; url: string }[];
    };
    expect(coverage.packages.map((pkg) => pkg.package).sort()).toEqual(
      ['@insiderfinance/totalfinance', '@insiderfinance/totalfinance-mcp'].sort(),
    );
    expect(
      coverage.exportPaths.every((entry) => entry.id.startsWith('@insiderfinance/totalfinance')),
    ).toBe(true);
    const publishedPackage = JSON.parse(
      readFileSync(join(ROOT, 'distribution/totalfinance/package.json'), 'utf8'),
    ) as { version: string };
    expect(version.version).toBe(publishedPackage.version);
    const cache = new Map<string, string>();
    for (const exported of coverage.exportPaths) {
      const [url, anchor] = exported.url.split('#');
      let text = cache.get(url!);
      if (!text) {
        text = readFileSync(join(SITE_OUT, url!, 'index.html'), 'utf8');
        cache.set(url!, text);
      }
      expect(text.includes(`id="${decodeURIComponent(anchor!)}"`), exported.id).toBe(true);
    }
  });

  it('ships a self-contained pinned version, machine-readable catalogs, and no private source artifacts', () => {
    const pinned = readFileSync(
      join(OUT, 'versions', version.version, 'learn/price-an-option/index.html'),
      'utf8',
    );
    expect(pinned).toContain(`data-base="${versionBase}"`);
    expect(pinned).toContain(`href="${versionBase}/reference/"`);
    expect(pinned).toContain(`src="${versionBase}/assets/client.js"`);
    expect(
      readFileSync(join(OUT, 'versions', version.version, 'reference/index.html'), 'utf8'),
    ).toContain(`action="${versionBase}/search/"`);
    expect(readFileSync(join(OUT, 'versions', version.version, 'llms.txt'), 'utf8')).toContain(
      `](${versionBase}/guides/assumptions/)`,
    );
    expect(readFileSync(join(OUT, 'versions', version.version, 'assets/client.js'))).toEqual(
      readFileSync(join(OUT, 'assets/client.js')),
    );
    expect(
      JSON.parse(readFileSync(join(OUT, 'operation-catalog.json'), 'utf8')).length,
    ).toBeGreaterThanOrEqual(46);
    expect(readFileSync(join(OUT, 'openapi.json'))).toEqual(
      readFileSync(join(ROOT, 'packages/http/etc/openapi.json')),
    );
    expect(readFileSync(join(OUT, 'versions', version.version, 'openapi.json'))).toEqual(
      readFileSync(join(OUT, 'openapi.json')),
    );
    expect(JSON.parse(readFileSync(join(OUT, 'version.json'), 'utf8'))).toEqual(version);
    expect(existsSync(join(OUT, '.git'))).toBe(false);
    expect(existsSync(join(OUT, 'implementation-order.md'))).toBe(false);
    expect(resolve(SITE_OUT)).toBe(join(ROOT, 'site/dist'));
  });
});
