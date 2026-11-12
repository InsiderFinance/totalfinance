/**
 * How to connect an AI agent to TotalFinance: the MCP servers a reader can add and the exact setup
 * for each client. Framework-free, so pages, `llms.txt` and tests share one source of truth.
 *
 * - **compute**: `@insiderfinance/totalfinance-mcp`, the library's own MCP server. It runs on the
 *   reader's machine over stdio. Until a release is verified (`published`), it is not on npm, so
 *   setup points at a source build and offers no one-click install.
 * - **docs**: the stateless docs MCP these docs host at `<site>/mcp` (search, read, reference).
 * - **hosted**: a hosted calculations endpoint, shown only when the build names one
 *   (`TOTALFINANCE_DOCS_HOSTED_MCP_URL`). Nothing here promises that it exists.
 */

export const MCP_PACKAGE = '@insiderfinance/totalfinance-mcp';
/** Where a reader's source checkout puts the built server (placeholder path). */
export const SOURCE_BINARY = '/absolute/path/to/totalfinance/distribution/mcp/dist/bin.js';

export type Transport =
  | { kind: 'stdio'; command: string; args: string[] }
  | { kind: 'http'; url: string; headers?: Record<string, string> };

export interface McpServerSpec {
  id: 'compute' | 'docs' | 'hosted';
  /** Configuration key / server name in the client. */
  name: string;
  title: string;
  summary: string;
  transport: Transport;
  /** False while the command only works from a source build: no one-click install links. */
  installable: boolean;
}

export function computeServer({
  published,
  version,
}: {
  published: boolean;
  version: string;
}): McpServerSpec {
  return {
    id: 'compute',
    name: 'totalfinance',
    title: 'Calculations',
    summary:
      'The TotalFinance MCP server runs the library on your machine: pricing, Greeks, strategies, volatility, technical analysis, risk, bonds and more, read-only by default.',
    transport: published
      ? { kind: 'stdio', command: 'npx', args: ['-y', `${MCP_PACKAGE}@${version}`] }
      : { kind: 'stdio', command: 'node', args: [SOURCE_BINARY] },
    installable: published,
  };
}

export function docsServer(siteUrl: string): McpServerSpec {
  return {
    id: 'docs',
    name: 'totalfinance-docs',
    title: 'Docs',
    summary:
      'These docs as a hosted MCP server: search them, read any page and fetch the full contract of any export, so your agent writes code against the real API. Nothing to install.',
    transport: { kind: 'http', url: `${siteUrl.replace(/\/$/, '')}/mcp` },
    installable: true,
  };
}

/** A hosted calculations endpoint, only when the build names one. */
export function hostedServer({
  url,
  keyUrl,
}: {
  url?: string | undefined;
  keyUrl?: string | undefined;
}): McpServerSpec | null {
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:')
    throw new Error('TOTALFINANCE_DOCS_HOSTED_MCP_URL must be an https URL.');
  return {
    id: 'hosted',
    name: 'totalfinance-hosted',
    title: 'Hosted calculations',
    summary: keyUrl
      ? 'TotalFinance calculations on a hosted server: nothing to install. Requests carry your API key.'
      : 'TotalFinance calculations on a hosted server: nothing to install.',
    transport: {
      kind: 'http',
      url: parsed.href,
      ...(keyUrl ? { headers: { Authorization: 'Bearer YOUR_API_KEY' } } : {}),
    },
    installable: true,
  };
}

export type ClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'cursor'
  | 'vscode'
  | 'codex'
  | 'windsurf'
  | 'gemini'
  | 'chatgpt';

export const CLIENTS: { id: ClientId; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'chatgpt', label: 'ChatGPT' },
];

export type SetupStep =
  | { kind: 'command'; label: string; code: string }
  | { kind: 'file'; label: string; path: string; lang: 'json' | 'toml'; code: string }
  | { kind: 'note'; text: string };

export interface ClientSetup {
  client: ClientId;
  label: string;
  steps: SetupStep[];
  /** One-click install link (Cursor, VS Code), only for installable servers. */
  install?: { label: string; href: string };
}

const json = (value: unknown) => JSON.stringify(value, null, 2);
const quote = (value: string) =>
  /^[\w@./:=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const shell = (parts: string[]) => parts.map(quote).join(' ');
const toml = (value: string) => JSON.stringify(value);

/** The transport as most clients' `mcpServers` entry. */
function standardEntry(transport: Transport, urlKey = 'url'): Record<string, unknown> {
  return transport.kind === 'stdio'
    ? { command: transport.command, args: transport.args }
    : { [urlKey]: transport.url, ...(transport.headers ? { headers: transport.headers } : {}) };
}

const headerFlags = (transport: Transport) =>
  transport.kind === 'http' && transport.headers
    ? Object.entries(transport.headers).flatMap(([key, value]) => ['--header', `${key}: ${value}`])
    : [];

/** Exact setup for one client and one server; null when the client cannot use that transport. */
export function clientSetup(client: ClientId, server: McpServerSpec): ClientSetup | null {
  const { transport, name } = server;
  const label = CLIENTS.find((candidate) => candidate.id === client)!.label;
  const stdio = transport.kind === 'stdio';
  switch (client) {
    case 'claude-code':
      return {
        client,
        label,
        steps: [
          {
            kind: 'command',
            label: 'Run in your terminal',
            code: stdio
              ? shell(['claude', 'mcp', 'add', name, '--', transport.command, ...transport.args])
              : shell([
                  'claude',
                  'mcp',
                  'add',
                  '--transport',
                  'http',
                  ...headerFlags(transport),
                  name,
                  transport.url,
                ]),
          },
        ],
      };
    case 'claude-desktop':
      return {
        client,
        label,
        steps: stdio
          ? [
              {
                kind: 'file',
                label: 'Add to Settings → Developer → Edit Config',
                path: 'claude_desktop_config.json',
                lang: 'json',
                code: json({ mcpServers: { [name]: standardEntry(transport) } }),
              },
              { kind: 'note', text: 'Restart Claude Desktop to load the server.' },
            ]
          : [
              {
                kind: 'note',
                text: `Open Settings → Connectors → Add custom connector, name it ${name} and use this URL:`,
              },
              { kind: 'command', label: 'Connector URL', code: transport.url },
            ],
      };
    case 'cursor': {
      const entry = standardEntry(transport);
      return {
        client,
        label,
        steps: [
          {
            kind: 'file',
            label: 'Add to your Cursor MCP settings',
            path: '~/.cursor/mcp.json',
            lang: 'json',
            code: json({ mcpServers: { [name]: entry } }),
          },
        ],
        ...(server.installable
          ? {
              install: {
                label: 'Add to Cursor',
                href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(btoa(JSON.stringify(entry)))}`,
              },
            }
          : {}),
      };
    }
    case 'vscode': {
      const entry = stdio
        ? { type: 'stdio', command: transport.command, args: transport.args }
        : {
            type: 'http',
            url: transport.url,
            ...(transport.headers ? { headers: transport.headers } : {}),
          };
      return {
        client,
        label,
        steps: [
          {
            kind: 'file',
            label: 'Add to your workspace',
            path: '.vscode/mcp.json',
            lang: 'json',
            code: json({ servers: { [name]: entry } }),
          },
          {
            kind: 'command',
            label: 'Or add it to your user profile',
            code: shell(['code', '--add-mcp', JSON.stringify({ name, ...entry })]),
          },
        ],
        ...(server.installable
          ? {
              install: {
                label: 'Add to VS Code',
                href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, ...entry }))}`,
              },
            }
          : {}),
      };
    }
    case 'codex': {
      const table = stdio
        ? [
            `[mcp_servers.${name}]`,
            `command = ${toml(transport.command)}`,
            `args = [${transport.args.map(toml).join(', ')}]`,
          ]
        : [
            `[mcp_servers.${name}]`,
            `url = ${toml(transport.url)}`,
            ...(transport.headers ? ['bearer_token_env_var = "TOTALFINANCE_API_KEY"'] : []),
          ];
      return {
        client,
        label,
        steps: [
          ...(stdio
            ? [
                {
                  kind: 'command' as const,
                  label: 'Run in your terminal',
                  code: shell([
                    'codex',
                    'mcp',
                    'add',
                    name,
                    '--',
                    transport.command,
                    ...transport.args,
                  ]),
                },
              ]
            : []),
          {
            kind: 'file',
            label: stdio ? 'Or add to your Codex config' : 'Add to your Codex config',
            path: '~/.codex/config.toml',
            lang: 'toml',
            code: table.join('\n'),
          },
          ...(transport.kind === 'http' && transport.headers
            ? [
                {
                  kind: 'note' as const,
                  text: 'Put your API key in the TOTALFINANCE_API_KEY environment variable.',
                },
              ]
            : []),
        ],
      };
    }
    case 'windsurf':
      return {
        client,
        label,
        steps: [
          {
            kind: 'file',
            label: 'Add to your Windsurf MCP config, then refresh MCP servers',
            path: '~/.codeium/windsurf/mcp_config.json',
            lang: 'json',
            code: json({ mcpServers: { [name]: standardEntry(transport, 'serverUrl') } }),
          },
        ],
      };
    case 'gemini':
      return {
        client,
        label,
        steps: [
          {
            kind: 'file',
            label: 'Add to your Gemini CLI settings',
            path: '~/.gemini/settings.json',
            lang: 'json',
            code: json({ mcpServers: { [name]: standardEntry(transport, 'httpUrl') } }),
          },
        ],
      };
    case 'chatgpt':
      // ChatGPT connects to remote MCP servers only.
      if (stdio) return null;
      return {
        client,
        label,
        steps: [
          {
            kind: 'note',
            text: `In ChatGPT, enable developer mode and add a custom connector named ${name} with this URL:`,
          },
          { kind: 'command', label: 'Connector URL', code: transport.url },
        ],
      };
  }
}

/** Every client that can use the server, in display order. */
export function setupsFor(server: McpServerSpec): ClientSetup[] {
  return CLIENTS.map((client) => clientSetup(client.id, server)).filter(
    (setup): setup is ClientSetup => setup !== null,
  );
}

/** Steps to build the server from a source checkout (until it is on npm). */
export const SOURCE_BUILD = [
  'git clone https://github.com/InsiderFinance/totalfinance.git',
  'cd totalfinance',
  'pnpm install --frozen-lockfile',
  'pnpm build',
  'node distribution/mcp/dist/bin.js doctor',
].join('\n');

/** The same setup as Markdown, for page twins: every client under each server. */
export function setupMarkdown(servers: readonly McpServerSpec[]): string {
  const fence = (code: string, lang: string) => `\`\`\`${lang}\n${code}\n\`\`\``;
  return servers
    .map((server) => {
      const where =
        server.transport.kind === 'stdio' ? 'runs on your machine' : 'hosted, nothing to install';
      const parts = [`### ${server.title} (\`${server.name}\`, ${where})`, '', server.summary];
      if (server.id === 'compute' && !server.installable)
        parts.push(
          '',
          `Not on npm yet: build it once from a source checkout, then point your client at \`distribution/mcp/dist/bin.js\` (the path below is a placeholder).`,
          '',
          fence(SOURCE_BUILD, 'sh'),
        );
      for (const setup of setupsFor(server)) {
        parts.push('', `#### ${setup.label}`);
        if (setup.install) parts.push('', `[${setup.install.label}](${setup.install.href})`);
        for (const step of setup.steps)
          parts.push(
            '',
            step.kind === 'note'
              ? step.text
              : step.kind === 'file'
                ? `${step.label} (\`${step.path}\`):\n\n${fence(step.code, step.lang)}`
                : `${step.label}:\n\n${fence(step.code, 'sh')}`,
          );
      }
      return parts.join('\n');
    })
    .join('\n\n');
}
