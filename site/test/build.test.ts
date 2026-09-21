import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readSiteVersion } from '../version.js';
import { search, type SearchRecord } from '../src/search.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'site/dist');
const version = readSiteVersion(ROOT);

describe('built public documentation', () => {
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
      expect(search(records, query!)[0]!.url, query).toBe(url);
    // #336 is integrated: missing sector exports must fail, not silently skip this gate.
    expect(search(records, 'sector performance')[0]!.title).toBe('sectorPerformance');

    const pinned = JSON.parse(
      readFileSync(join(OUT, 'versions', version.version, 'search-index.json'), 'utf8'),
    ) as SearchRecord[];
    expect(search(pinned, 'black scholes').map((record) => record.url)).toEqual(
      blackScholes.map((record) => `/versions/${version.version}${record.url}`),
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
      const html = readFileSync(join(OUT, route, 'index.html'), 'utf8');
      expect(
        Buffer.byteLength(html),
        `${route}: split large contracts into bounded pages`,
      ).toBeLessThan(350_000);
      for (const match of html.matchAll(/(?:href|src)="(\/[^"#?]*)(?:[?#][^"]*)?"/g)) {
        const path = join(OUT, decodeURIComponent(match[1]!));
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
    expect(coverage.packages).toHaveLength(readdirSync(join(ROOT, 'packages')).length);
    const cache = new Map<string, string>();
    for (const exported of coverage.exportPaths) {
      const [url, anchor] = exported.url.split('#');
      let text = cache.get(url!);
      if (!text) {
        text = readFileSync(join(OUT, url!, 'index.html'), 'utf8');
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
    expect(pinned).toContain(`data-base="/versions/${version.version}"`);
    expect(pinned).toContain(`href="/versions/${version.version}/reference/"`);
    expect(pinned).toContain(`src="/versions/${version.version}/assets/client.js"`);
    expect(
      readFileSync(join(OUT, 'versions', version.version, 'reference/index.html'), 'utf8'),
    ).toContain(`action="/versions/${version.version}/search/"`);
    expect(readFileSync(join(OUT, 'versions', version.version, 'llms.txt'), 'utf8')).toContain(
      `](/versions/${version.version}/guides/assumptions/)`,
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
    expect(resolve(OUT)).toBe(join(ROOT, 'site/dist'));
  });
});
