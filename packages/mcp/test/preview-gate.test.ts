/**
 * Stage 7A slice 6 — the MCP preview gate, item by item (Decision 8): annotations, instructions,
 * protocol errors, conformant error results, the capabilities and report resources, the prompt
 * removal, and the binary's flags.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createMemoryArtifactStore } from '@totalfinance/workflows';
import { createFileArtifactStore } from '@totalfinance/workflows/local';
import {
  backtestPack,
  createTotalFinanceMcpServer,
  defaultPacks,
  defineTool,
} from '@totalfinance/mcp';
import { schema } from '@totalfinance/core/schema';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

async function connect(options: Parameters<typeof createTotalFinanceMcpServer>[0] = {}) {
  const server = createTotalFinanceMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'preview-gate', version: '0' });
  await client.connect(clientTransport);
  return client;
}

const PRICE = {
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
};

describe('the MCP preview gate (Decision 8)', () => {
  it('every tool advertises DERIVED annotations, and the server sends instructions once', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(23);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        title: tool.title,
      });
    }
    const instructions = client.getInstructions();
    expect(instructions).toContain('decimals');
    expect(instructions).toContain('assumptions');
    expect(instructions).toContain('seed');
    expect(instructions).toContain('OperationError');
    expect(instructions).toContain('totalfinance://');
  });

  it('a custom tool derives its annotations from `mutates`', async () => {
    const custom = defineTool({
      name: 'custom.echo',
      title: 'Echo',
      description: 'Returns its input.',
      schema: schema.object({ value: schema.number() }),
      mutates: true,
      run: (input) => ({ summary: 'echo', structured: { value: input.value } }),
    });
    const client = await connect({ tools: [custom], readOnly: false });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'custom.echo');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('unknown tool, resource, and prompt are PROTOCOL errors (McpError), not error results', async () => {
    const client = await connect();
    await expect(
      client.callTool({ name: 'totalfinance_nope_x', arguments: {} }),
    ).rejects.toBeInstanceOf(McpError);
    await expect(client.readResource({ uri: 'totalfinance://nowhere' })).rejects.toBeInstanceOf(
      McpError,
    );
    await expect(client.getPrompt({ name: 'nope' })).rejects.toBeInstanceOf(McpError);
  });

  it('an error result carries the OperationError JSON as text and NO structuredContent (policy B); a success has both', async () => {
    const client = await connect();
    const refused = await client.callTool({
      name: 'totalfinance_option_price',
      arguments: { ...PRICE, spot: -1 },
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    const text = (refused.content as { type: string; text: string }[])[0]!.text;
    const document = JSON.parse(text) as {
      code: string;
      message: string;
      context: unknown;
      operation: { id: string };
    };
    expect(document.code).toMatch(/^input\./);
    expect(document.operation.id).toBe('totalfinance.option.price');
    const ok = await client.callTool({ name: 'totalfinance_option_price', arguments: PRICE });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({
      operation: { id: 'totalfinance.option.price' },
      structured: { value: expect.any(Number) },
    });
    // The custom-tool path speaks the same document.
    const custom = defineTool({
      name: 'custom.echo',
      title: 'Echo',
      description: 'Returns its input.',
      schema: schema.object({ value: schema.number() }),
      run: (input) => ({ summary: 'echo', structured: { value: input.value } }),
    });
    const withCustom = await connect({ tools: [custom] });
    const bad = await withCustom.callTool({ name: 'custom.echo', arguments: { value: 'x' } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toBeUndefined();
    expect(JSON.parse((bad.content as { text: string }[])[0]!.text)).toMatchObject({
      code: expect.stringMatching(/^input\./),
      operation: null,
    });
  });

  it('publishes totalfinance://capabilities, and lists stored reports as resources when a store is attached', async () => {
    const store = createMemoryArtifactStore();
    const handle = store.put({
      value: { value: 1, assumptions: {}, diagnostics: { warnings: [] } },
      kind: 'report',
      createdTimestampMs: Date.parse('2026-09-03T14:00:00Z'),
    });
    const client = await connect({ artifacts: store, maxInputBytes: 4096 });
    const { resources } = await client.listResources();
    const uris = resources.map((resource) => resource.uri);
    expect(uris).toContain('totalfinance://capabilities');
    expect(uris).toContain('totalfinance://policy/seed');
    expect(uris).toContain(handle.uri);
    const capabilities = await client.readResource({ uri: 'totalfinance://capabilities' });
    const parsed = JSON.parse((capabilities.contents[0] as { text: string }).text) as {
      budgets: { maxInputBytes: number };
      tools: string[];
      artifacts: string;
    };
    expect(parsed.budgets.maxInputBytes).toBe(4096);
    expect(parsed.tools).toContain('totalfinance_option_price');
    expect(parsed.artifacts).toBe('read-write store attached');
    const report = await client.readResource({ uri: handle.uri });
    expect(JSON.parse((report.contents[0] as { text: string }).text)).toMatchObject({ value: 1 });
    // A handle in a tool input resolves through the same store.
    const bare = await connect();
    const { resources: bareResources } = await bare.listResources();
    expect(bareResources.map((resource) => resource.uri)).not.toContain(handle.uri);
  });

  it('the screen-options-chain prompt is gone; analyze-option-trade names only tools and fields that exist', async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual([
      'analyze-option-trade',
      'analyze-strategy',
    ]);
    const prompt = await client.getPrompt({
      name: 'analyze-option-trade',
      arguments: { underlying: 'AAPL', details: '100 strike' },
    });
    const text = (prompt.messages[0]!.content as { text: string }).text;
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const id of text.match(/totalfinance\.[a-z_]+\.[a-z_]+/g) ?? [])
      expect(names.has(id), id).toBe(true);
    expect(text).toContain('assumptions');
  });

  it('the binary: --help and --version to the terminal, doctor reports the floor and the tool set, protocol mode otherwise', () => {
    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toBe('');
    expect(help.stderr).toContain('--profile');
    const version = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({ node: process.version });
    const store = mkdtempSync(join(tmpdir(), 'totalfinance-mcp-'));
    createFileArtifactStore({ directory: store }).put({
      value: { value: 1 },
      kind: 'report',
      createdTimestampMs: Date.parse('2026-09-03T14:00:00Z'),
    });
    const doctor = spawnSync(
      process.execPath,
      [
        BIN,
        'doctor',
        '--profile',
        'full',
        '--packs',
        'options,artifact',
        '--store',
        store,
        '--max-input-bytes',
        '1024',
      ],
      { encoding: 'utf8' },
    );
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      node: { meetsFloor: true },
      server: { profile: 'full', packs: ['options', 'artifact'], tools: 5 },
      store: { reports: 1 },
      budgets: { maxInputBytes: 1024 },
    });
    expect(
      spawnSync(process.execPath, [BIN, '--profile', 'nope'], { encoding: 'utf8' }).status,
    ).toBe(2);
    expect(spawnSync(process.execPath, [BIN, '--bogus'], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(process.execPath, [BIN, 'frobnicate'], { encoding: 'utf8' }).status).toBe(2);
  });

  it('packs accept operation packs and tool packs alike; the backtest pack stays opt-in', async () => {
    const client = await connect({ packs: [...defaultPacks(), backtestPack()] });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('totalfinance_backtest_options_run');
    expect(tools.map((tool) => tool.name)).toContain('totalfinance_backtest_cross_sectional_run');
    expect(tools.length).toBe(28);
  });
});
