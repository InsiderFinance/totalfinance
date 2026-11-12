import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prefersMarkdown } from '../serve.js';
import { runnerPolicy, runnerScriptOrigins } from '../scripts/runtime.js';
import { markdownRoute, routeHtmlFile, routeOfHtmlFile, sitePath } from '../src/routes.js';

const vercel = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../vercel.json', import.meta.url)), 'utf8'),
) as {
  outputDirectory: string;
  cleanUrls: boolean;
  trailingSlash: boolean;
  redirects: { source: string; destination: string; permanent: boolean }[];
  rewrites: { source: string; destination: string; has?: unknown[] }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
};

describe('host configuration (vercel.json)', () => {
  it('serves the static export under the base path, the MCP function, and Markdown on request', () => {
    expect(vercel.outputDirectory).toBe('site/dist');
    // The InsiderFinance app (Next.js, trailingSlash: false) redirects `/x/` to `/x` before its
    // zone rewrite runs, so the zone must use the same clean URLs or it redirects forever.
    expect(vercel.trailingSlash).toBe(false);
    expect(vercel.redirects).toEqual([
      { source: '/docs/totalfinance', destination: '/docs/totalfinance/start', permanent: false },
    ]);
    expect(vercel.cleanUrls).toBe(true);
    expect(vercel.rewrites[0]).toEqual({
      source: '/docs/totalfinance/mcp',
      destination: '/api/mcp',
    });
    expect(vercel.rewrites.filter((rule) => rule.has).map((rule) => rule.destination)).toEqual([
      '/index.md',
      '/:route.md',
    ]);
    expect(vercel.rewrites.at(-1)).toEqual({
      source: '/docs/totalfinance/:path*',
      destination: '/:path*',
    });
  });

  it('sends the security headers the per-page CSP cannot carry, and never indexes archives', () => {
    const global = vercel.headers.find((rule) => rule.source.startsWith('/((?!'))!;
    const all = global.headers;
    const csp = all.find((header) => header.key === 'Content-Security-Policy')!.value;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('script-src');
    expect(all.find((header) => header.key === 'Vary')?.value).toBe('Accept');
    expect(
      vercel.headers.find((rule) => rule.source === '/docs/totalfinance/versions/(.*)')?.headers,
    ).toContainEqual({ key: 'X-Robots-Tag', value: 'noindex' });
    for (const rule of vercel.headers)
      expect(rule === global || rule.source.startsWith('/docs/totalfinance/'), rule.source).toBe(
        true,
      );
  });

  it('lets only the docs frame their example runner, and serves its bundles to the sandbox', () => {
    const global = vercel.headers.find((rule) => rule.source.startsWith('/((?!'))!;
    // The global rule's own pattern, as the host evaluates it against a path without its slash.
    const pattern = new RegExp(`^${/^\/\((.*)\)$/.exec(global.source)![1]}$`);
    for (const path of [
      'docs/totalfinance/learn/price-an-option',
      'docs/totalfinance',
      'x/runtime/runner',
    ])
      expect(pattern.test(path), path).toBe(true);
    for (const path of [
      'docs/totalfinance/runtime/runner',
      'docs/totalfinance/versions/0.1.2/runtime/runner',
    ])
      expect(pattern.test(path), path).toBe(false);
    const runner = vercel.headers.find((rule) => rule.source.endsWith('runtime/runner'))!;
    const csp = runner.headers.find((header) => header.key === 'Content-Security-Policy')!.value;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(runner.headers.map((header) => header.key).sort()).toEqual(
      global.headers.map((header) => header.key).sort(),
    );
    const bundles = vercel.headers.find((rule) => rule.source.endsWith('runtime/(.*)\\.js'))!;
    expect(bundles.headers).toContainEqual({ key: 'Access-Control-Allow-Origin', value: '*' });
    expect(bundles.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'public, max-age=31536000, immutable',
    });
  });

  it('gives the runner a no-network policy that names the hosts serving it', () => {
    expect(runnerScriptOrigins({})).toEqual([
      'https://www.totalfinance.io',
      'http://127.0.0.1:*',
      'http://localhost:*',
    ]);
    expect(
      runnerScriptOrigins({
        VERCEL: '1',
        TOTALFINANCE_DOCS_ORIGIN: 'https://www.insiderfinance.io/',
        VERCEL_PROJECT_PRODUCTION_URL: 'totalfinance-docs.vercel.app',
        VERCEL_URL: 'totalfinance-docs-abc123.vercel.app',
      }),
    ).toEqual([
      'https://www.insiderfinance.io',
      'https://totalfinance-docs.vercel.app',
      'https://totalfinance-docs-abc123.vercel.app',
    ]);
    expect(
      runnerScriptOrigins({
        TOTALFINANCE_DOCS_PREVIEW_ORIGINS: ' https://docs-preview.example.run/ , ',
      }).at(-1),
    ).toBe('https://docs-preview.example.run');
    const policy = runnerPolicy(['https://www.insiderfinance.io']);
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self' https://www.insiderfinance.io blob:");
    expect(policy).not.toMatch(/unsafe-(?:inline|eval)/);
  });

  it('negotiates Markdown like the local preview', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, text/html;q=0.9')).toBe(true);
    expect(prefersMarkdown('text/html, text/markdown')).toBe(false);
    expect(prefersMarkdown('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(false);
    expect(prefersMarkdown(undefined)).toBe(false);
  });

  it('negotiates only page routes, never assets or twins', () => {
    const rule = vercel.rewrites.find((candidate) => candidate.destination === '/:route.md')!;
    const pattern = /^\/docs\/totalfinance\/:route\((.+)\)$/.exec(rule.source)![1]!;
    const page = new RegExp(`^${pattern}$`);
    for (const route of ['learn/price-an-option', 'reference/options/page-2', 'agents'])
      expect(page.test(route), route).toBe(true);
    for (const asset of ['llms.txt', 'learn/price-an-option.md', '_next/static/chunks/a.js', ''])
      expect(page.test(asset), asset).toBe(false);
  });
});

describe('routes', () => {
  it('never end in a slash, and map to their exported files', () => {
    expect(sitePath('learn', 'price-an-option')).toBe('/learn/price-an-option');
    expect(sitePath('/learn/price-an-option/')).toBe('/learn/price-an-option');
    expect(sitePath('')).toBe('/');
    expect(sitePath()).toBe('/');
    expect(routeHtmlFile('/')).toBe('index.html');
    expect(routeHtmlFile('/learn/price-an-option')).toBe('learn/price-an-option.html');
    expect(markdownRoute('/')).toBe('/index.md');
    expect(markdownRoute('/learn/price-an-option/')).toBe('/learn/price-an-option.md');
    expect(routeOfHtmlFile('index.html')).toBe('/');
    expect(routeOfHtmlFile('learn/price-an-option.html')).toBe('/learn/price-an-option');
    expect(routeOfHtmlFile('learn/price-an-option.txt')).toBeNull();
  });
});
