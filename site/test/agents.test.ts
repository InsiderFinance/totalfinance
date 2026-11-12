import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENTS,
  MCP_PACKAGE,
  SOURCE_BINARY,
  clientSetup,
  computeServer,
  docsServer,
  hostedServer,
  setupMarkdown,
  setupsFor,
  type McpServerSpec,
} from '../src/agents';
import { CALCULATOR_AGENTS } from '../src/playgrounds/agent';
import { playgrounds } from '../src/playgrounds/index';
import { defaultInput } from '../src/playgrounds/inputs';
import { MAX_BODY_BYTES, POST } from '../api/mcp';

const GENERATED = fileURLToPath(new URL('../.generated/', import.meta.url));
const operations = JSON.parse(readFileSync(`${GENERATED}operations.json`, 'utf8')) as {
  id: string;
  mcpToolName: string;
  defaultEnabled: boolean;
  profiles: string[];
}[];
const profiles = JSON.parse(readFileSync(`${GENERATED}agent-profiles.json`, 'utf8')) as {
  profile: string;
}[];

const published = computeServer({ published: true, version: '0.1.2' });
const unpublished = computeServer({ published: false, version: '0.1.2' });
const docs = docsServer('https://www.insiderfinance.io/docs/totalfinance/');
const hosted = hostedServer({
  url: 'https://mcp.example.com/totalfinance',
  keyUrl: 'https://example.com/keys',
})!;

/** Every code block a reader copies parses as what its label says. */
function checkSteps(server: McpServerSpec) {
  for (const setup of setupsFor(server))
    for (const step of setup.steps)
      if (step.kind === 'file' && step.lang === 'json') JSON.parse(step.code);
      else if (step.kind === 'file')
        expect(step.code).toMatch(new RegExp(`^\\[mcp_servers\\.${server.name}\\]\\n`));
}

describe('agent setup', () => {
  it('pins the published package, and points at a source build until then', () => {
    expect(published.transport).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', `${MCP_PACKAGE}@0.1.2`],
    });
    expect(published.installable).toBe(true);
    expect(unpublished.transport).toEqual({
      kind: 'stdio',
      command: 'node',
      args: [SOURCE_BINARY],
    });
    expect(unpublished.installable).toBe(false);
    // No one-click install for a placeholder path.
    expect(setupsFor(unpublished).some((setup) => setup.install)).toBe(false);
  });

  it('serves the docs MCP from the docs and offers hosted calculations only when named', () => {
    expect(docs.transport).toEqual({
      kind: 'http',
      url: 'https://www.insiderfinance.io/docs/totalfinance/mcp',
    });
    expect(hostedServer({})).toBeNull();
    expect(hostedServer({ url: '' })).toBeNull();
    expect(() => hostedServer({ url: 'http://mcp.example.com' })).toThrow(/https/);
    expect(hosted.transport).toMatchObject({ headers: { Authorization: 'Bearer YOUR_API_KEY' } });
    expect(hostedServer({ url: 'https://mcp.example.com/x' })!.transport).not.toHaveProperty(
      'headers',
    );
  });

  it('gives every client valid setup, and ChatGPT only remote servers', () => {
    for (const server of [published, unpublished, docs, hosted]) checkSteps(server);
    expect(setupsFor(published).map((setup) => setup.client)).toEqual(
      CLIENTS.map((client) => client.id).filter((id) => id !== 'chatgpt'),
    );
    expect(setupsFor(docs).map((setup) => setup.client)).toEqual(
      CLIENTS.map((client) => client.id),
    );
  });

  it('writes the exact commands each client documents', () => {
    const steps = (client: Parameters<typeof clientSetup>[0], server: McpServerSpec) =>
      clientSetup(client, server)!.steps;
    expect(steps('claude-code', published)[0]).toMatchObject({
      code: `claude mcp add totalfinance -- npx -y ${MCP_PACKAGE}@0.1.2`,
    });
    expect(steps('claude-code', docs)[0]).toMatchObject({
      code: 'claude mcp add --transport http totalfinance-docs https://www.insiderfinance.io/docs/totalfinance/mcp',
    });
    expect(steps('claude-code', hosted)[0]).toMatchObject({
      code: "claude mcp add --transport http --header 'Authorization: Bearer YOUR_API_KEY' totalfinance-hosted https://mcp.example.com/totalfinance",
    });
    expect(steps('codex', published)[0]).toMatchObject({
      code: `codex mcp add totalfinance -- npx -y ${MCP_PACKAGE}@0.1.2`,
    });
    expect(steps('codex', docs)[0]).toMatchObject({
      code: '[mcp_servers.totalfinance-docs]\nurl = "https://www.insiderfinance.io/docs/totalfinance/mcp"',
    });
    expect(JSON.parse((steps('windsurf', docs)[0] as { code: string }).code)).toEqual({
      mcpServers: {
        'totalfinance-docs': { serverUrl: 'https://www.insiderfinance.io/docs/totalfinance/mcp' },
      },
    });
    expect(JSON.parse((steps('gemini', docs)[0] as { code: string }).code)).toEqual({
      mcpServers: {
        'totalfinance-docs': { httpUrl: 'https://www.insiderfinance.io/docs/totalfinance/mcp' },
      },
    });
    expect(JSON.parse((steps('vscode', published)[0] as { code: string }).code)).toEqual({
      servers: {
        totalfinance: { type: 'stdio', command: 'npx', args: ['-y', `${MCP_PACKAGE}@0.1.2`] },
      },
    });
  });

  it('builds install links that decode to the same server', () => {
    const cursor = new URL(clientSetup('cursor', published)!.install!.href);
    expect(cursor.protocol).toBe('cursor:');
    expect(cursor.searchParams.get('name')).toBe('totalfinance');
    expect(JSON.parse(atob(cursor.searchParams.get('config')!))).toEqual({
      command: 'npx',
      args: ['-y', `${MCP_PACKAGE}@0.1.2`],
    });
    const vscode = clientSetup('vscode', docs)!.install!.href;
    expect(vscode.startsWith('vscode:mcp/install?')).toBe(true);
    expect(JSON.parse(decodeURIComponent(vscode.slice('vscode:mcp/install?'.length)))).toEqual({
      name: 'totalfinance-docs',
      type: 'http',
      url: 'https://www.insiderfinance.io/docs/totalfinance/mcp',
    });
  });

  it('renders the same setup as Markdown for agents', () => {
    const markdown = setupMarkdown([unpublished, docs]);
    for (const client of CLIENTS) expect(markdown).toContain(`#### ${client.label}`);
    expect(markdown).toContain('Not on npm yet');
    expect(markdown).toContain('pnpm install --frozen-lockfile');
    expect(markdown).not.toContain('undefined');
  });
});

describe('every calculator has an agent prompt and a real tool', () => {
  it.each(playgrounds.map((playground) => [playground.id, playground] as const))(
    '%s',
    (id, playground) => {
      const agent = CALCULATOR_AGENTS[id]!;
      expect(agent, id).toBeTruthy();
      const prompt = agent.prompt(defaultInput(playground));
      expect(prompt).not.toMatch(/undefined|NaN|\[object Object\]/);
      if (agent.operation === null) {
        expect(prompt).toMatch(/docs MCP/);
        return;
      }
      const operation = operations.find((candidate) => candidate.id === agent.operation);
      expect(operation, agent.operation).toBeTruthy();
      expect(prompt).toContain(operation!.mcpToolName);
      if (agent.profile === null) expect(operation!.defaultEnabled, id).toBe(true);
      else {
        expect(operation!.defaultEnabled).toBe(false);
        expect(operation!.profiles).toContain(agent.profile);
        expect(profiles.map((row) => row.profile)).toContain(agent.profile);
      }
    },
  );
});

describe('hosted docs MCP function', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses an oversized body before parsing it', async () => {
    const response = await POST(
      new Request('https://docs.example/api/mcp', {
        method: 'POST',
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      }),
    );
    expect(response.status).toBe(413);
  });

  it('reports the package version the docs describe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/version.json')
          ? new Response(JSON.stringify({ version: '9.9.9' }))
          : new Response('missing', { status: 404 }),
      ),
    );
    const response = await POST(
      new Request('https://docs.example/api/mcp', {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18' },
        }),
      }),
    );
    expect(
      ((await response.json()) as { result: { serverInfo: { version: string } } }).result.serverInfo
        .version,
    ).toBe('9.9.9');
  });
});
