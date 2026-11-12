import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import endpoint from '../../api/mcp.js';

const URL = 'https://www.totalfinance.io/docs/totalfinance/mcp';

afterEach(() => vi.unstubAllGlobals());

describe('the deployed documentation MCP entrypoint', () => {
  it('boots from emitted Node ESM without the frontend bundler resolving missing extensions', () => {
    const out = mkdtempSync(join(tmpdir(), 'totalfinance-docs-host-'));
    const root = fileURLToPath(new URL('../..', import.meta.url));
    try {
      writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }));
      for (const file of [
        'api/mcp.ts',
        'site/api/mcp.ts',
        'site/mcp/docs-mcp.ts',
        'site/src/routes.ts',
        'site/src/search.ts',
      ]) {
        const target = join(out, file.replace(/\.ts$/, '.js'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
          }).outputText,
        );
      }
      const result = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const endpoint = await import(process.argv[1]); console.log(typeof endpoint.default.fetch);',
          pathToFileURL(join(out, 'api/mcp.js')).href,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
      expect(result.trim()).toBe('function');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('accepts a Web Request and initializes the read-only docs server', async () => {
    const fetchAsset = vi.fn(async () => Response.json({ version: '0.0.0-host-test' }));
    vi.stubGlobal('fetch', fetchAsset);
    const response = await endpoint.fetch(
      new Request(URL, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26' },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'totalfinance-docs', version: '0.0.0-host-test' } },
    });
    expect(fetchAsset).toHaveBeenCalledWith(
      'https://www.totalfinance.io/docs/totalfinance/version.json',
    );
  });

  it('rejects unsupported methods and malformed JSON through the public entrypoint', async () => {
    const get = await endpoint.fetch(new Request(URL));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const invalid = await endpoint.fetch(new Request(URL, { method: 'POST', body: '{' }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: -32700 } });
  });

  it('refuses oversized requests before parsing', async () => {
    const response = await endpoint.fetch(
      new Request(URL, {
        method: 'POST',
        headers: { 'content-length': '1000001' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(413);
  });
});
