import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDocsMcp, SUPPORTED_PROTOCOL_VERSIONS } from '../mcp/docs-mcp.js';
import { handle } from '../serve.js';
import { readSiteVersion } from '../version.js';

const BASE = '/docs/totalfinance';
const { version } = readSiteVersion(fileURLToPath(new URL('../..', import.meta.url)));

describe('docs MCP core (fake assets)', () => {
  const assets: Record<string, string> = {
    '/search-index.json': JSON.stringify([
      {
        title: 'valueAtRisk',
        url: '/reference/totalfinance/risk#valueAtRisk',
        description: 'VaR',
        category: '@insiderfinance/totalfinance/risk',
        keywords: '',
        kind: 'function',
      },
    ]),
    '/reference-coverage.json': JSON.stringify({
      exportPaths: [
        {
          id: '@insiderfinance/totalfinance/risk#valueAtRisk',
          url: '/reference/totalfinance/risk/page-2#valueAtRisk',
        },
        {
          id: '@insiderfinance/totalfinance#valueAtRisk',
          url: '/reference/totalfinance/page-9#valueAtRisk',
        },
      ],
    }),
    '/reference/totalfinance/risk.json': JSON.stringify({
      entrypoint: '@insiderfinance/totalfinance/risk',
      exports: [
        { id: '@insiderfinance/totalfinance/risk#valueAtRisk', name: 'valueAtRisk', members: [] },
      ],
    }),
    '/learn/x.md': '# X',
    '/index.md': '# TotalFinance',
  };
  const server = createDocsMcp({
    siteUrl: 'https://docs.example/docs/totalfinance',
    readAsset: async (path) => assets[path] ?? null,
  });
  const call = (name: string, args: unknown) =>
    server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });

  it('negotiates a supported protocol version and declares read-only tools', async () => {
    const init = await server.handle({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01' },
    });
    expect(init).toMatchObject({
      result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: { tools: {} } },
    });
    const listed = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      'search_docs',
      'read_page',
      'get_reference',
      'list_calculators',
    ]);
    expect(listed.result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('prefers the domain import, lists re-exports, and refuses unknown names helpfully', async () => {
    const found = (await call('get_reference', { name: 'valueAtRisk' })) as {
      result: {
        structuredContent: { entrypoint: string; url: string; alsoExportedFrom: string[] };
      };
    };
    expect(found.result.structuredContent).toMatchObject({
      entrypoint: '@insiderfinance/totalfinance/risk',
      url: 'https://docs.example/docs/totalfinance/reference/totalfinance/risk/page-2#valueAtRisk',
      alsoExportedFrom: ['@insiderfinance/totalfinance'],
    });
    const missing = (await call('get_reference', { name: 'valueAtRsk' })) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0]!.text).toMatch(/Closest matches: valueAtRisk/);
  });

  it('reads only pages of these docs, never paths outside them', async () => {
    for (const path of [
      'https://docs.example/docs/totalfinance/learn/x',
      'https://docs.example/docs/totalfinance/learn/x/',
      '/learn/x',
      'learn/x/',
      '/learn/x.md',
    ])
      expect(await call('read_page', { path }), path).toMatchObject({
        result: { content: [{ text: '# X' }] },
      });
    for (const path of ['https://docs.example/docs/totalfinance', '/'])
      expect(await call('read_page', { path }), path).toMatchObject({
        result: { content: [{ text: '# TotalFinance' }] },
      });
    for (const path of [
      'https://evil.example/docs/totalfinance/learn/x',
      'https://docs.example/docs/totalfinance-evil/learn/x',
      '/learn/../../etc/passwd',
    ])
      expect(await call('read_page', { path })).toMatchObject({ result: { isError: true } });
  });

  it('returns JSON-RPC errors for malformed requests, unknown methods and bad arguments', async () => {
    expect(await server.handle({ id: 1 })).toMatchObject({ error: { code: -32600 } });
    expect(await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).toMatchObject({
      error: { code: -32601 },
    });
    expect(await call('nope', {})).toMatchObject({ error: { code: -32602 } });
    expect(await call('search_docs', [])).toMatchObject({ error: { code: -32602 } });
    expect(await call('search_docs', { query: 'risk', limit: 99 })).toMatchObject({
      result: { isError: true },
    });
    expect(
      await server.handleBody([{ jsonrpc: '2.0', method: 'notifications/initialized' }]),
    ).toBeNull();
  });
});

describe('the built site through the preview server', () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((request, response) => void handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('serves the docs MCP endpoint to the official MCP client', async () => {
    const client = new Client({ name: 'site-test', version: '1.0.0' });
    // The SDK declares `sessionId` as a plain optional, which exactOptionalPropertyTypes rejects.
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}${BASE}/mcp`));
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    try {
      const search = await client.callTool({
        name: 'search_docs',
        arguments: { query: 'black scholes', limit: 5 },
      });
      const results = (
        search.structuredContent as { results: { title: string; markdown: string }[] }
      ).results;
      expect(results[0]!.title).toBe('blackScholes');
      const page = await client.callTool({
        name: 'read_page',
        arguments: { path: results[0]!.markdown },
      });
      expect((page.content as { text: string }[])[0]!.text).toContain('blackScholes');
      const reference = await client.callTool({
        name: 'get_reference',
        arguments: { name: 'valueAtRiskReport' },
      });
      const contract = reference.structuredContent as {
        entrypoint: string;
        members: unknown[];
        signature: string;
      };
      expect(contract.entrypoint).toBe('@insiderfinance/totalfinance/risk');
      expect(contract.members.length).toBeGreaterThan(0);
      expect(contract.signature).toContain('valueAtRiskReport');
      const calculators = await client.callTool({ name: 'list_calculators', arguments: {} });
      expect(
        (calculators.structuredContent as { calculators: unknown[] }).calculators,
      ).toHaveLength(10);
    } finally {
      await client.close();
    }
  });

  it('behaves like the static host: marketing root, clean URLs, real 404s, Markdown negotiation, no traversal', async () => {
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${origin}${path}`, { redirect: 'manual', headers });
    const homepage = await get('/');
    expect(homepage.status).toBe(200);
    expect(homepage.headers.get('location')).toBeNull();
    expect(await homepage.text()).toContain('The complete finance library for TypeScript and');
    const docsEntry = await get(BASE);
    expect(docsEntry.status).toBe(307);
    expect(docsEntry.headers.get('location')).toBe(`${BASE}/start`);
    expect((await get(`${BASE}/start`)).status).toBe(200);
    for (const [from, to] of [
      [`${BASE}/`, BASE],
      [`${BASE}/learn/price-an-option/?s=1`, `${BASE}/learn/price-an-option?s=1`],
      [`${BASE}/learn/price-an-option.html`, `${BASE}/learn/price-an-option`],
    ] as const) {
      const redirect = await get(from);
      expect(redirect.status, from).toBe(308);
      expect(redirect.headers.get('location'), from).toBe(to);
    }
    const page = await get(`${BASE}/learn/price-an-option`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect((await get(`${BASE}/versions/${version}`)).status).toBe(200);
    const markdown = await get(`${BASE}/learn/price-an-option`, { Accept: 'text/markdown' });
    expect(markdown.headers.get('content-type')).toContain('text/markdown');
    expect(markdown.headers.get('vary')).toContain('Accept');
    expect(await markdown.text()).toMatch(/^# Price an option/);
    expect((await get(`${BASE}/no-such-page`)).status).toBe(404);
    expect((await get(`${BASE}/../../package.json`)).status).not.toBe(200);
    expect((await get(`${BASE}/mcp`)).status).toBe(405);
    const crossOrigin = await fetch(`${origin}${BASE}/mcp`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(crossOrigin.status).toBe(403);
  });
});
