/** Node adapter for the docs MCP endpoint (used by the local preview server and tests). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createDocsMcp } from './docs-mcp';

const MAX_BODY_BYTES = 1_000_000;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((accept, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => accept(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function fileReader(root: string) {
  return async (path: string): Promise<string | null> => {
    const file = resolve(root, `.${path}`);
    if (file !== root && !file.startsWith(root + sep)) return null;
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null;
  };
}

const servers = new Map<string, ReturnType<typeof createDocsMcp>>();

export async function handleDocsMcp(
  request: IncomingMessage,
  response: ServerResponse,
  options: { root: string; siteUrl?: string },
): Promise<void> {
  const host = request.headers.host ?? '127.0.0.1';
  const origin = request.headers.origin;
  // DNS-rebinding protection: browsers may only call this endpoint from its own origin.
  if (origin && new URL(origin).host !== host) {
    response
      .writeHead(403, { 'Content-Type': 'text/plain' })
      .end('Cross-origin requests are not allowed.');
    return;
  }
  if (request.method !== 'POST') {
    response
      .writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' })
      .end('The docs MCP endpoint accepts JSON-RPC over POST.');
    return;
  }
  const siteUrl =
    options.siteUrl ??
    `http://${host}${process.env['TOTALFINANCE_DOCS_BASE_PATH'] ?? '/docs/totalfinance'}`;
  let server = servers.get(`${options.root}|${siteUrl}`);
  if (!server) {
    const version = (() => {
      try {
        return (
          JSON.parse(readFileSync(resolve(options.root, 'version.json'), 'utf8')) as {
            version: string;
          }
        ).version;
      } catch {
        return undefined;
      }
    })();
    server = createDocsMcp({
      readAsset: fileReader(options.root),
      siteUrl,
      ...(version ? { version } : {}),
    });
    servers.set(`${options.root}|${siteUrl}`, server);
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error.' },
      }),
    );
    return;
  }
  const result = await server.handleBody(body);
  if (result === null) {
    response.writeHead(202).end();
    return;
  }
  response
    .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(result));
}
