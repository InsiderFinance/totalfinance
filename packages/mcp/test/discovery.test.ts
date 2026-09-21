import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  createTotalFinanceMcpServer,
  defaultTools,
  type McpServerOptions,
} from '@totalfinance/mcp';
import {
  createMemoryArtifactStore,
  DEFAULT_CAPABILITIES,
  operationResultSchema,
  tradePack,
} from '@totalfinance/workflows';
import { REGISTRY_PROFILES, packsForProfile } from '@totalfinance/workflows/local';

const clients: Client[] = [];
async function connect(options: McpServerOptions = {}) {
  const server = createTotalFinanceMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'discovery', version: '0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
async function resource(client: Client, uri: string) {
  const response = await client.readResource({ uri });
  return JSON.parse((response.contents[0] as { text: string }).text);
}

describe('effective MCP discovery', () => {
  it('keeps the default23 and reports actual implicit packs, held defaults and stores', async () => {
    const client = await connect();
    const caps = await resource(client, 'totalfinance://capabilities');
    expect(caps.tools).toEqual((await client.listTools()).tools.map((tool) => tool.name));
    expect(caps.tools).toHaveLength(23);
    expect(caps.packs).toEqual(packsForProfile('default').map((pack) => pack.name));
    expect(caps.grants.held).toEqual([...DEFAULT_CAPABILITIES].sort());
    expect(caps.stores.artifacts).toEqual({ read: false, write: false });
    expect(caps.jobs.enabled).toBe(false);
    const store = createMemoryArtifactStore();
    expect(
      (await resource(await connect({ artifacts: store }), 'totalfinance://capabilities')).stores
        .artifacts,
    ).toEqual({ read: true, write: true });
    expect(
      (
        await resource(
          await connect({ artifacts: { get: store.get, list: store.list } }),
          'totalfinance://capabilities',
        )
      ).stores.artifacts,
    ).toEqual({ read: true, write: false });
  });
  it('uses exact explicit tools/packs, including empty selections, even with a profile', async () => {
    expect((await (await connect({ profile: 'full', packs: [] })).listTools()).tools).toEqual([]);
    expect((await (await connect({ profile: 'full', tools: [] })).listTools()).tools).toEqual([]);
    const client = await connect({ profile: 'full', packs: [packsForProfile('options')[0]!] });
    expect((await client.listTools()).tools).toHaveLength(3);
    expect((await resource(client, 'totalfinance://capabilities')).selection).toBe('explicit');
  });
  it('derives metadata and readable complete descriptions from the same operation', async () => {
    const client = await connect({ profile: 'valuation' });
    const operation = packsForProfile('valuation')[0]!.operations[0]!;
    const tool = (await client.listTools()).tools[0]!;
    expect(tool.inputSchema).toEqual(operation.inputSchema.toJSONSchema());
    expect(tool.outputSchema).toEqual(
      operationResultSchema({ structured: operation.outputSchema ?? undefined }),
    );
    expect(tool._meta?.['totalfinance/operation']).toMatchObject({
      id: operation.id,
      costClass: operation.costClass,
      requiredCapabilities: operation.requiredCapabilities,
      handleFields: operation.handleFields,
    });
    expect(await resource(client, `totalfinance://operations/${operation.id}`)).toMatchObject({
      inputSchema: tool.inputSchema,
      outputSchema: operation.outputSchema,
    });
    const profiles = await resource(client, 'totalfinance://profiles');
    expect(profiles.map((profile: { name: string }) => profile.name)).toEqual(REGISTRY_PROFILES);
    expect(
      profiles.every((profile: { description: string }) => profile.description.length > 0),
    ).toBe(true);
    expect(
      (await client.listResources()).resources.every((entry) => Boolean(entry.description)),
    ).toBe(true);
  });
  it('filters approval as a write despite sideEffect none, and never raises missing grants', async () => {
    const held = ['trade:approve'];
    const readonly = await connect({ packs: [tradePack()], capabilities: held });
    expect((await readonly.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'totalfinance_trade_authorize',
    );
    const client = await connect({ packs: [tradePack()], capabilities: held, readOnly: false });
    held.push('trade:paper'); // Caller mutation after construction must not escalate the ceiling.
    const caps = await resource(client, 'totalfinance://capabilities');
    expect(caps.grants.held).toEqual(['trade:approve']);
    expect(caps.tools).toContain('totalfinance_trade_authorize');
    expect(
      caps.filters.some((filter: { missingCapabilities: string[] }) =>
        filter.missingCapabilities.includes('trade:paper'),
      ),
    ).toBe(true);
    for (const filter of caps.filters as { tool: string; missingCapabilities: string[] }[]) {
      // B2: a filtered tool is not "unknown" — the call is refused with the reason and the
      // capabilities resource, and the arguments never enlarge the ceiling.
      const refused = await client.callTool({
        name: filter.tool,
        arguments: { capabilities: ['trade:paper'] },
      });
      expect(refused.isError).toBe(true);
      const document = JSON.parse((refused.content as { text: string }[])[0]!.text) as {
        code: string;
        message: string;
        context: { capabilitiesUri: string; missingCapabilities: string[] };
      };
      expect(document.code).toBe('operation.capability_missing');
      expect(document.context.capabilitiesUri).toBe('totalfinance://capabilities');
      expect(document.context.missingCapabilities).toEqual(filter.missingCapabilities);
      expect(document.message).toContain('totalfinance://capabilities');
      await expect(
        client.readResource({ uri: `totalfinance://schema/tool/${filter.tool}/input` }),
      ).rejects.toBeInstanceOf(McpError);
    }
  });
  it.each(REGISTRY_PROFILES)(
    'grounds every %s prompt in available tools and validates its arguments',
    async (profile) => {
      const client = await connect({ profile });
      const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
      const prompts = (await client.listPrompts()).prompts;
      for (const prompt of prompts) {
        const args = Object.fromEntries(
          prompt.arguments!.map((argument) => [argument.name, 'supplied data']),
        );
        const response = await client.getPrompt({ name: prompt.name, arguments: args });
        const text = (response.messages[0]!.content as { text: string }).text;
        for (const name of text.match(/totalfinance_[a-z_]+/g) ?? [])
          expect(names.has(name), name).toBe(true);
        expect(text).toContain('diagnostics.warnings');
        await expect(client.getPrompt({ name: prompt.name })).rejects.toBeInstanceOf(McpError);
        await expect(
          client.getPrompt({ name: prompt.name, arguments: { ...args, injected: 'x' } }),
        ).rejects.toBeInstanceOf(McpError);
        await expect(
          client.getPrompt({
            name: prompt.name,
            arguments: Object.fromEntries(Object.keys(args).map((name) => [name, ' '])),
          }),
        ).rejects.toBeInstanceOf(McpError);
      }
    },
  );
  it('omits unavailable prompts and does not mention optional IV when filtered out', async () => {
    const empty = await connect({ tools: [] });
    expect((await empty.listPrompts()).prompts).toEqual([]);
    await expect(empty.getPrompt({ name: 'analyze-option-trade' })).rejects.toBeInstanceOf(
      McpError,
    );
    const client = await connect({
      tools: defaultTools().filter((tool) =>
        ['totalfinance_option_price', 'totalfinance_option_greeks'].includes(tool.name),
      ),
    });
    const response = await client.getPrompt({
      name: 'analyze-option-trade',
      arguments: { underlying: 'XYZ', details: 'supplied data' },
    });
    expect(JSON.stringify(response)).not.toContain('totalfinance_option_implied_volatility');
  });
});

describe('bounded catalog pagination', () => {
  it('walks tools/resources exactly once, retaining complete schemas', async () => {
    const client = await connect({ profile: 'full', pageSize: 3 });
    const tools = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor === undefined ? {} : { cursor });
      expect(result.tools.length).toBeLessThanOrEqual(3);
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(tools.map((tool) => tool.name)).toEqual(
      (await resource(client, 'totalfinance://capabilities')).tools,
    );
    const resources = [];
    do {
      const result = await client.listResources(cursor === undefined ? {} : { cursor });
      expect(result.resources.length).toBeLessThanOrEqual(3);
      resources.push(...result.resources);
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    expect(new Set(resources.map((entry) => entry.uri)).size).toBe(resources.length);
    for (const tool of tools)
      expect(await resource(client, `totalfinance://schema/tool/${tool.name}/input`)).toEqual(
        tool.inputSchema,
      );
  });
  it.each(['', '1', '-1', '1.5', 'NaN', 'Infinity', 'eyJvZmZzZXQiOjF9', 'a.b', 'x'.repeat(513)])(
    'rejects malformed cursor %j',
    async (cursor) => {
      const client = await connect({ pageSize: 2 });
      await expect(client.listTools({ cursor })).rejects.toBeInstanceOf(McpError);
      await expect(client.listResources({ cursor })).rejects.toBeInstanceOf(McpError);
    },
  );
  it('rejects cross-server, cross-catalog, tampered and stale cursors', async () => {
    const store = createMemoryArtifactStore();
    const client = await connect({ artifacts: store, pageSize: 2 });
    const cursor = (await client.listTools()).nextCursor!;
    await expect(client.listResources({ cursor })).rejects.toBeInstanceOf(McpError);
    await expect((await connect({ pageSize: 2 })).listTools({ cursor })).rejects.toBeInstanceOf(
      McpError,
    );
    await expect(client.listTools({ cursor: `${cursor}x` })).rejects.toBeInstanceOf(McpError);
    const resourcesCursor = (await client.listResources()).nextCursor!;
    store.put({
      value: { value: 1 },
      kind: 'report',
      createdTimestampMs: Date.parse('2026-09-07T00:00:00Z'),
    });
    await expect(client.listResources({ cursor: resourcesCursor })).rejects.toBeInstanceOf(
      McpError,
    );
  });
  it.each([0, -1, 1.5, 101, NaN, Infinity, null, '2'])(
    'rejects invalid page caps %j at construction',
    (pageSize) => {
      expect(() => createTotalFinanceMcpServer({ pageSize } as never)).toThrow();
    },
  );
  it.each([
    { maxInputBytes: 16 * 1024 * 1024 + 1 },
    { maxInputBytes: 1.5 },
    { capabilities: null },
    { stores: { extra: true } },
    { stores: { authorization: {} } },
    { profile: '__proto__' },
    { jobs: {} },
  ])('closes configuration door %j', (options) => {
    expect(() => createTotalFinanceMcpServer(options as never)).toThrow();
  });
});
