/**
 * Page routes, relative to the base path. Routes never end in a slash (`/learn/price-an-option`):
 * the InsiderFinance app that serves these docs as a zone redirects `/x/` to `/x` before any
 * rewrite runs (Next.js `trailingSlash: false`), so a trailing-slash zone would redirect forever.
 * Every page link, canonical URL, search record, sitemap entry and Markdown twin goes through here.
 */

/** Join route segments: `('learn', 'x')` → `/learn/x`; also normalizes `/x/` and `x` to `/x`. */
export function sitePath(...segments: string[]): string {
  const path = segments
    .join('/')
    .split('/')
    .filter((segment) => segment !== '')
    .join('/');
  return path ? `/${path}` : '/';
}

/** The exported HTML file for a route: `/` → `index.html`, `/learn/x` → `learn/x.html`. */
export function routeHtmlFile(route: string): string {
  const path = sitePath(route);
  return path === '/' ? 'index.html' : `${path.slice(1)}.html`;
}

/** The Markdown twin of a route: `/` → `/index.md`, `/learn/x` → `/learn/x.md`. */
export function markdownRoute(route: string): string {
  const path = sitePath(route);
  return path === '/' ? '/index.md' : `${path}.md`;
}

/** Inverse of `routeHtmlFile` for an export-relative HTML path; null for non-page files. */
export function routeOfHtmlFile(file: string): string | null {
  const path = file.replaceAll('\\', '/');
  if (!path.endsWith('.html')) return null;
  if (path === 'index.html') return '/';
  return sitePath(path.slice(0, -'.html'.length));
}
