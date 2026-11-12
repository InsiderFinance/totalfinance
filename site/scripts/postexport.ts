/**
 * Post-export steps over a Next.js static export:
 *
 * 1. Markdown twins for every page, `llms.txt`, per-domain bundles and `llms-full.txt`.
 * 2. A per-page Content-Security-Policy `<meta>` whose script-src lists only `'self'` and the
 *    SHA-256 hashes of that page's own inline scripts (no `'unsafe-inline'` for scripts).
 * 3. Sitemap and robots policy, route inventory, calculator catalogue and version manifests.
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
  /** Pages of a version snapshot are never indexed. */
  snapshot?: boolean;
  root?: string;
}

export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  // Only the docs' own sandboxed example runner (`runtime/runner`) may be framed.
  "frame-src 'self'",
  "manifest-src 'self'",
];

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

export function contentSecurityPolicy(html: string): string {
  const hashes = [...new Set(inlineScripts(html).map((script) => `'sha256-${sha256(script)}'`))];
  return [`script-src 'self' ${hashes.join(' ')}`.trim(), ...CSP_DIRECTIVES].join('; ');
}

export function withSecurityMeta(html: string, robots: string | null): string {
  if (html.includes('http-equiv="Content-Security-Policy"')) return html;
  const policy = contentSecurityPolicy(html);
  const extra =
    robots && !html.includes('name="robots"') ? `<meta name="robots" content="${robots}"/>` : '';
  return html.replace(
    /<head>/,
    `<head><meta http-equiv="Content-Security-Policy" content="${policy}"/>${extra}`,
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
  const root = options.root ?? join(out, '../..');

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
  const indexable =
    !options.snapshot &&
    (process.env['TOTALFINANCE_DOCS_INDEXING'] ??
      (generated.version.published ? 'index' : 'noindex')) === 'index';
  const routes: string[] = [];
  for (const file of walk(out)) {
    if (!file.endsWith('.html')) continue;
    const html = readFileSync(file, 'utf8');
    writeFileSync(file, withSecurityMeta(html, options.snapshot ? 'noindex, follow' : null));
    const path = relative(out, file).replaceAll('\\', '/');
    if (
      path === '404.html' ||
      path.startsWith('_not-found') ||
      path.startsWith('404/') ||
      path.startsWith('versions/') ||
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
