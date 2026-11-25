/**
 * Post-export steps over a Next.js static export:
 *
 * 1. Markdown twins for every page, `llms.txt`, per-domain bundles and `llms-full.txt`.
 * 2. A per-page Content-Security-Policy `<meta>` with hashes for inline scripts and Google
 *    Analytics sources on the marketing homepage.
 * 3. Sitemap and robots policy, route inventory and calculator catalogue.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { playgrounds } from '../src/playgrounds/index';
import { inputSchema } from '../src/playgrounds/inputs';
import { markdownRoute, routeOfHtmlFile } from '../src/routes';
import type { GenerateResult } from './generate';
import { DOMAIN_BUNDLE_BUDGET_BYTES, domainBundle, llmsFull, llmsIndex } from './llms';
import { buildMarkdownPages, type MarkdownPage } from './markdown';

export interface PostExportOptions {
  out: string;
  basePath: string;
  generated: GenerateResult;
  /** Absolute origin for links in agent files and the sitemap. */
  origin?: string;
}

const GA_MEASUREMENT_ID = 'G-CEW2R2KTZQ';
const GOOGLE_TAG_ORIGIN = 'https://www.googletagmanager.com';
const GA_REQUEST_SOURCES = `${GOOGLE_TAG_ORIGIN} https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com`;

const GA_TAG = `<script id="totalfinance-google-analytics">
(() => {
  const { origin, pathname } = window.location;
  if (pathname !== '/' || (origin !== 'https://www.totalfinance.io' && origin !== 'https://totalfinance.io')) return;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag('set', {
    page_location: origin + pathname,
    page_referrer: document.referrer.split(/[?#]/, 1)[0],
    allow_google_signals: false,
    allow_ad_personalization_signals: false
  });
  gtag('js', new Date());
  gtag('config', '${GA_MEASUREMENT_ID}');

  const tag = document.createElement('script');
  tag.async = true;
  tag.src = '${GOOGLE_TAG_ORIGIN}/gtag/js?id=${GA_MEASUREMENT_ID}';
  document.head.appendChild(tag);
})();
</script>`;

function walk(directory: string, files: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64');

/** Inline script bodies exactly as the browser will hash them. */
export function inlineScripts(html: string): string[] {
  const scripts: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attributes = match[1] ?? '';
    if (/type="application\/(?:ld\+)?json"/.test(attributes)) continue;
    scripts.push(match[2] ?? '');
  }
  return scripts;
}

export function contentSecurityPolicy(html: string, analytics = false): string {
  const hashes = [...new Set(inlineScripts(html).map((script) => `'sha256-${sha256(script)}'`))];
  const scriptSources = analytics ? [GOOGLE_TAG_ORIGIN, ...hashes] : hashes;
  const measurementSources = analytics ? ` ${GA_REQUEST_SOURCES}` : '';
  return [
    [`script-src 'self'`, ...scriptSources].join(' '),
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${measurementSources}`,
    "font-src 'self'",
    `connect-src 'self'${measurementSources}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    // Only the docs' own sandboxed example runner (`runtime/runner`) may be framed.
    "frame-src 'self'",
    "manifest-src 'self'",
  ].join('; ');
}

export function withSecurityMeta(html: string, analytics = false): string {
  if (html.includes('http-equiv="Content-Security-Policy"')) return html;
  const page = analytics ? html.replace('<head>', `<head>${GA_TAG}`) : html;
  const policy = contentSecurityPolicy(page, analytics);
  return page.replace(
    /<head>/,
    `<head><meta http-equiv="Content-Security-Policy" content="${policy}"/>`,
  );
}

const twinPath = (out: string, route: string) => join(out, markdownRoute(route).slice(1));

export async function postExport(
  options: PostExportOptions,
): Promise<{ routes: number; markdown: number }> {
  const { out, basePath, generated } = options;
  const origin = (
    options.origin ??
    process.env['TOTALFINANCE_DOCS_ORIGIN'] ??
    'https://www.totalfinance.io'
  ).replace(/\/$/, '');
  const site = `${origin}${basePath}`;
  const root = join(out, '../..');

  // 1. Agent files.
  const pages: MarkdownPage[] = buildMarkdownPages(generated, site);
  for (const page of pages) {
    const path = twinPath(out, page.route);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, page.markdown);
  }
  writeFileSync(join(out, 'llms.txt'), llmsIndex(pages, generated, site));
  mkdirSync(join(out, 'llms'), { recursive: true });
  const bundleSizes: Record<string, number> = {};
  for (const domain of generated.reference.index.domains) {
    if (domain.slug === 'index') continue;
    const text = domainBundle(domain.slug, pages, generated, site);
    bundleSizes[domain.slug] = Buffer.byteLength(text);
    writeFileSync(join(out, 'llms', `${domain.slug}.txt`), text);
  }
  writeFileSync(join(out, 'llms-full.txt'), llmsFull(root, generated, site));
  writeFileSync(
    join(out, 'calculators.json'),
    JSON.stringify(
      playgrounds.map((playground) => ({
        id: playground.id,
        title: playground.title,
        introduction: playground.introduction,
        url: `/learn/${playground.id}`,
        markdown: `/learn/${playground.id}.md`,
        inputSchema: inputSchema(playground),
      })),
    ),
  );

  // Next writes each page's full RSC payload twice (`index.txt` and `__next._full.txt`). The client
  // router requests `index.txt` and per-segment files, never `_full`, so the copy is dropped.
  for (const file of walk(out)) if (file.endsWith('/__next._full.txt')) rmSync(file);
  // Production source maps are not published (a dependency may still emit one).
  for (const file of walk(out))
    if (file.endsWith('.map')) rmSync(file);
    else if (file.endsWith('.js')) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('sourceMappingURL='))
        writeFileSync(file, text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n'));
    }

  // 2. Security headers in each page, and the route inventory.
  const indexable = (process.env['TOTALFINANCE_DOCS_INDEXING'] ?? 'index') === 'index';
  const routes: string[] = [];
  for (const file of walk(out)) {
    if (!file.endsWith('.html')) continue;
    const html = readFileSync(file, 'utf8');
    const path = relative(out, file).replaceAll('\\', '/');
    writeFileSync(file, withSecurityMeta(html, path === 'index.html'));
    if (
      path === '404.html' ||
      path.startsWith('_not-found') ||
      path.startsWith('404/') ||
      path.startsWith('runtime/')
    )
      continue;
    const route = routeOfHtmlFile(path);
    if (route) routes.push(route);
  }
  routes.sort();
  writeFileSync(join(out, 'routes.json'), JSON.stringify(routes));

  // 3. Indexing policy. Under a multi-zone host the main domain's /robots.txt governs crawling;
  // these files matter when the docs are served from their own origin, and pages carry meta robots.
  writeFileSync(
    join(out, 'robots.txt'),
    indexable
      ? `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n',
  );
  if (indexable)
    writeFileSync(
      join(out, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes
        .map((route) => `  <url><loc>${site}${route}</loc></url>`)
        .join('\n')}\n</urlset>\n`,
    );
  writeFileSync(
    join(out, 'llms-bundle-sizes.json'),
    JSON.stringify({ budgetBytes: DOMAIN_BUNDLE_BUDGET_BYTES, bundles: bundleSizes }, null, 2),
  );
  return { routes: routes.length, markdown: pages.length };
}
