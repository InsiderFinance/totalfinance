/**
 * Local preview of `site/dist`, served under the same base path as production
 * (default http://127.0.0.1:4173/docs/totalfinance). It mirrors the host contract in
 * site/README.md: clean URLs without trailing slashes, a real 404, Markdown negotiation and the
 * docs MCP endpoint.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleDocsMcp } from './mcp/handler.js';
import { markdownRoute } from './src/routes.js';

const ROOT = fileURLToPath(new URL('./dist', import.meta.url));
const BASE = process.env['TOTALFINANCE_DOCS_BASE_PATH'] ?? '/docs/totalfinance';
const PORT = Number(process.env['PORT'] ?? 4173);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * Resolve a request path inside the export, or null. Never escapes the output directory. A page
 * route `/learn/x` is `learn/x.html`; a directory (the export root, a version snapshot root) serves
 * its `index.html`.
 */
export function resolveFile(root: string, pathname: string): string | null {
  const path = resolve(root, `.${pathname}`);
  if (path !== root && !path.startsWith(root + sep)) return null;
  // `extname` alone cannot tell a page from a file: `/versions/0.1.2` is a snapshot directory.
  const candidates =
    path === root ? [join(root, 'index.html')] : [path, `${path}.html`, join(path, 'index.html')];
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

export function prefersMarkdown(accept: string | undefined): boolean {
  if (!accept) return false;
  const types = accept.split(',').map((part) => part.trim().split(';')[0]!.toLowerCase());
  const markdown = types.indexOf('text/markdown');
  const html = types.indexOf('text/html');
  return markdown !== -1 && (html === -1 || markdown < html);
}

function send(
  response: ServerResponse,
  status: number,
  path: string,
  extra: Record<string, string> = {},
) {
  response.writeHead(status, {
    'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store',
    Vary: 'Accept',
    ...extra,
  });
  response.end(readFileSync(path));
}

/** Runtime bundles load into the runner's opaque origin, so module fetches need CORS. */
function extraHeaders(pathname: string): Record<string, string> {
  return /(?:^|\/)runtime\/.+\.js$/.test(pathname) ? { 'Access-Control-Allow-Origin': '*' } : {};
}

export async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (BASE && url.pathname === '/') {
    send(response, 200, join(ROOT, 'index.html'));
    return;
  }
  if (BASE && url.pathname === BASE) {
    response.writeHead(307, { Location: `${BASE}/start` }).end();
    return;
  }
  // Clean URLs, like the host: no trailing slash and no `.html`.
  const clean = url.pathname
    .replace(/\/+$/, '')
    .replace(/\.html$/, '')
    .replace(/\/index$/, '');
  if (clean !== url.pathname && clean !== '') {
    response.writeHead(308, { Location: `${clean}${url.search}` }).end();
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (BASE) {
    if (
      pathname.startsWith('/assets/brand/') ||
      /^\/(?:favicon\.(?:svg|ico)|apple-touch-icon\.png|og\.png)$/.test(pathname)
    ) {
      const asset = resolveFile(ROOT, pathname);
      if (asset) return send(response, 200, asset);
    }
    if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) {
      response
        .writeHead(404, { 'Content-Type': 'text/plain' })
        .end('Not under the documentation base path.');
      return;
    }
    pathname = pathname.slice(BASE.length) || '/';
  }
  if (pathname === '/mcp') {
    await handleDocsMcp(request, response, { root: ROOT });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  if (!extname(pathname) && prefersMarkdown(request.headers.accept)) {
    const twin = resolveFile(ROOT, markdownRoute(pathname));
    if (twin) return send(response, 200, twin);
  }
  const file = resolveFile(ROOT, pathname);
  if (file) return send(response, 200, file, extraHeaders(pathname));
  const notFound = join(ROOT, '404.html');
  if (existsSync(notFound)) return send(response, 404, notFound);
  response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Page not found');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(ROOT)) throw new Error('site/dist is missing. Run `pnpm site:build` first.');
  createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response
        .writeHead(500, { 'Content-Type': 'text/plain' })
        .end(error instanceof Error ? error.message : 'Server error');
    });
  }).listen(PORT, '127.0.0.1', () =>
    console.log(`TotalFinance docs: http://127.0.0.1:${PORT}${BASE || '/'}`),
  );
}
