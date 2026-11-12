/**
 * Hosted adapter for the docs MCP endpoint (Vercel Node function, Web-standard Request/Response).
 * It reads the deployment's own static files over HTTP, so it stays stateless and read-only.
 * Routing: `site/vercel.json` rewrites `<base>/mcp` here.
 */
import { createDocsMcp } from '../mcp/docs-mcp';

const BASE = process.env['TOTALFINANCE_DOCS_BASE_PATH'] ?? '/docs/totalfinance';
const PUBLIC_URL = (
  process.env['TOTALFINANCE_DOCS_ORIGIN'] ?? 'https://www.totalfinance.io'
).replace(/\/$/, '');
/** JSON-RPC requests to a read-only docs server are small; refuse anything larger before parsing. */
export const MAX_BODY_BYTES = 1_000_000;

let version: Promise<string | undefined> | undefined;

/** The request body, or null when it passes the limit (the rest is not read). */
async function readCapped(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function POST(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  const readAsset = async (path: string) => {
    const response = await fetch(`${origin}${BASE}${path}`);
    return response.ok ? response.text() : null;
  };
  const raw = await readCapped(request);
  if (raw === null)
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: `Request body over ${MAX_BODY_BYTES} bytes.` },
      },
      { status: 413 },
    );
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } },
      { status: 400 },
    );
  }
  // The package version the docs describe, for serverInfo; read once per instance.
  version ??= readAsset('/version.json')
    .then((text) => (text ? (JSON.parse(text) as { version?: string }).version : undefined))
    .catch(() => undefined);
  const known = await version;
  if (known === undefined) version = undefined; // retry on the next request
  const server = createDocsMcp({
    siteUrl: `${PUBLIC_URL}${BASE}`,
    readAsset,
    ...(known ? { version: known } : {}),
  });
  const result = await server.handleBody(body);
  return result === null
    ? new Response(null, { status: 202 })
    : Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}

export function GET(): Response {
  return new Response('The docs MCP endpoint accepts JSON-RPC over POST.', {
    status: 405,
    headers: { Allow: 'POST' },
  });
}
