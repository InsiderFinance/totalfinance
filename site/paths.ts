/** Public mount shared by the standalone build and InsiderFinance's future docs rewrite. */
export const DOCS_BASE = '/docs/totalfinance';

/** Mount a documentation-relative URL, including its query string or fragment. */
export const docsUrl = (path = '/', base = DOCS_BASE): string => `${base}${path}`;

/** Generator-owned root paths belong to this docs tree, including versioned snapshots. */
export function mountDocsHtml(html: string, base = DOCS_BASE): string {
  return html
    .replace('<html lang="en">', `<html lang="en" data-base="${base}">`)
    .replace(
      /(href|src|action)="(\/(?!\/)[^"]*)"/g,
      (_match, attribute, path: string) =>
        `${attribute}="${docsUrl(path, path.startsWith('/versions/') ? DOCS_BASE : base)}"`,
    );
}
