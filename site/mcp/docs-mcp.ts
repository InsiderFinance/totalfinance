/**
 * The docs MCP server: a stateless Model Context Protocol endpoint (Streamable HTTP, JSON
 * responses) over the static documentation build. It searches, reads and looks up; it never
 * computes finance (the local @insiderfinance/totalfinance-mcp server does that) and never writes.
 *
 * Host-agnostic: adapters supply `readAsset(path)` for files of the static export (relative to the
 * docs base path), so the same core runs in the local preview and in a hosted function.
 */
import { markdownRoute } from '../src/routes.js';
import { search, type SearchRecord } from '../src/search.js';

export const DOCS_MCP_NAME = 'totalfinance-docs';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const MAX_PAGE_CHARACTERS = 200_000;

export interface DocsMcpOptions {
  /** Read a file of the static export, e.g. `/search-index.json`; null when absent. */
  readAsset(path: string): Promise<string | null>;
  /** Absolute docs URL (origin + base path) used in links returned to the agent. */
  siteUrl: string;
  version?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

const TOOLS = [
  {
    name: 'search_docs',
    title: 'Search TotalFinance docs',
    description:
      'Search the TotalFinance documentation: calculators, guides, functions, types, entry points and operations. Returns ranked results with page and Markdown URLs. Use it before writing code to find the right API.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Function name, concept or task, e.g. "black scholes", "value at risk", "backtest".',
        },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'read_page',
    title: 'Read a docs page as Markdown',
    description:
      'Read one TotalFinance docs page as Markdown (the same text as its .md twin). Accepts a docs path such as "/learn/price-an-option" or a full docs URL from search_docs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 500 } },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_reference',
    title: 'Get an export’s complete contract',
    description:
      'Get the generated contract of a TotalFinance export: its import path, signature, description, every member with type, unit and declared default, examples and stability. Pass the export name; add the entry point when a name is exported from several.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Exact export name, e.g. "valueAtRiskReport".',
        },
        entrypoint: {
          type: 'string',
          description: 'Import path, e.g. "@insiderfinance/totalfinance/risk".',
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_calculators',
    title: 'List the live calculators',
    description:
      'List the TotalFinance docs calculators with their pages and input schemas. Each calculator page shows the exact TypeScript that reproduces its result.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
] as const;

class ToolError extends Error {}

function text(value: string) {
  return { content: [{ type: 'text', text: value }] };
}

function structured(value: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

const stringArgument = (
  args: Record<string, unknown>,
  name: string,
  required = true,
): string | undefined => {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim())
    throw new ToolError(`"${name}" must be a non-empty string.`);
  return value.trim();
};

export function createDocsMcp(options: DocsMcpOptions) {
  const site = options.siteUrl.replace(/\/$/, '');
  let index: Promise<SearchRecord[]> | undefined;
  let coverage: Promise<Map<string, string>> | undefined;

  const json = async <T>(path: string): Promise<T> => {
    const body = await options.readAsset(path);
    if (body === null) throw new ToolError(`The docs build is missing ${path}.`);
    return JSON.parse(body) as T;
  };
  const searchIndex = () => {
    index ??= json<SearchRecord[]>('/search-index.json').catch((error: unknown) => {
      index = undefined;
      throw error;
    });
    return index;
  };
  /** Export id -> page URL (with anchor) from the coverage manifest. */
  const exportUrls = () => {
    coverage ??= json<{ exportPaths: { id: string; url: string }[] }>('/reference-coverage.json')
      .then((data) => new Map(data.exportPaths.map((entry) => [entry.id, entry.url])))
      .catch((error: unknown) => {
        coverage = undefined;
        throw error;
      });
    return coverage;
  };

  const markdownPath = (path: string) => {
    let route = path.trim();
    if (route.startsWith('http://') || route.startsWith('https://')) {
      const url = new URL(route);
      const siteUrl = new URL(site);
      const base = siteUrl.pathname.replace(/\/$/, '');
      if (
        url.origin !== siteUrl.origin ||
        (url.pathname !== base && !url.pathname.startsWith(`${base}/`))
      )
        throw new ToolError(`Only TotalFinance docs URLs under ${site} can be read.`);
      route = url.pathname.slice(base.length) || '/';
    }
    route = route.split('#')[0]!.split('?')[0]!;
    if (!route.startsWith('/')) route = `/${route}`;
    if (route.includes('..')) throw new ToolError('Paths may not contain "..".');
    if (route.endsWith('.md')) return route;
    return markdownRoute(route);
  };

  const tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    async search_docs(args) {
      const query = stringArgument(args, 'query')!;
      const limit = args['limit'] === undefined ? 10 : Number(args['limit']);
      if (!Number.isInteger(limit) || limit < 1 || limit > 30)
        throw new ToolError('"limit" must be an integer from 1 to 30.');
      const results = search(await searchIndex(), query, limit).map((record) => ({
        title: record.title,
        kind: record.kind ?? 'page',
        category: record.category,
        description: record.description,
        url: `${site}${record.url}`,
        markdown: `${site}${markdownPath(record.url.split('#')[0]!)}`,
      }));
      return structured({ query, results });
    },
    async read_page(args) {
      const path = markdownPath(stringArgument(args, 'path')!);
      const body = await options.readAsset(path);
      if (body === null)
        throw new ToolError(
          `No docs page at ${path.replace(/\.md$/, '')}. Use search_docs to find the right path.`,
        );
      return text(
        body.length > MAX_PAGE_CHARACTERS
          ? `${body.slice(0, MAX_PAGE_CHARACTERS)}\n\n[Truncated at ${MAX_PAGE_CHARACTERS.toLocaleString('en-US')} characters. Narrow the request with get_reference.]`
          : body,
      );
    },
    async get_reference(args) {
      const name = stringArgument(args, 'name')!;
      const entrypoint = stringArgument(args, 'entrypoint', false);
      const urls = await exportUrls();
      const candidates = [...urls.entries()].filter(
        ([id]) => id.endsWith(`#${name}`) && (!entrypoint || id === `${entrypoint}#${name}`),
      );
      if (!candidates.length) {
        // Typos rarely survive whole-term matching, so retry with progressively shorter prefixes.
        const records = await searchIndex();
        let suggestions: string[] = [];
        for (let length = name.length; length >= 3 && !suggestions.length; length -= 2)
          suggestions = search(records, name.slice(0, length), 5).map((record) => record.title);
        throw new ToolError(
          `No export named "${name}"${entrypoint ? ` in ${entrypoint}` : ''}. Closest matches: ${suggestions.join(', ') || 'none'}.`,
        );
      }
      // Prefer a domain import over the umbrella namespace, then the shortest (domain root) path.
      const umbrella = (id: string) => (/^@insiderfinance\/totalfinance#/.test(id) ? 1 : 0);
      candidates.sort(([a], [b]) => umbrella(a) - umbrella(b) || a.length - b.length);
      const [id, url] = candidates[0]!;
      const contractPath = `${url.split('#')[0]!.replace(/\/page-\d+$/, '')}.json`;
      const contract = await json<{ entrypoint: string; exports: { id: string }[] }>(contractPath);
      const entry = contract.exports.find((candidate) => candidate.id === id);
      if (!entry) throw new ToolError(`The contract for ${id} is missing from ${contractPath}.`);
      return structured({
        ...entry,
        entrypoint: contract.entrypoint,
        url: `${site}${url}`,
        alsoExportedFrom: candidates.slice(1).map(([other]) => other.split('#')[0]),
      });
    },
    async list_calculators() {
      const calculators =
        await json<{ id: string; url: string; markdown: string }[]>('/calculators.json');
      return structured({
        calculators: calculators.map((calculator) => ({
          ...calculator,
          url: `${site}${calculator.url}`,
          markdown: `${site}${calculator.markdown}`,
        })),
      });
    },
  };

  async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    const request = message as JsonRpcRequest;
    if (
      !request ||
      typeof request !== 'object' ||
      request.jsonrpc !== '2.0' ||
      typeof request.method !== 'string'
    )
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC request.' },
      };
    const id = request.id ?? null;
    const notification = request.id === undefined;
    try {
      switch (request.method) {
        case 'initialize': {
          const requested = String(request.params?.['protocolVersion'] ?? '');
          const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
            requested,
          )
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: {
                name: DOCS_MCP_NAME,
                title: 'TotalFinance docs',
                version: options.version ?? '0.0.0',
              },
              instructions:
                'Read-only access to the TotalFinance documentation. Use search_docs to find APIs, get_reference for exact contracts (units, defaults, members) and read_page for guides. Write code only against exports these tools confirm. For calculations, use the local @insiderfinance/totalfinance-mcp server or the library itself.',
            },
          };
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        case 'tools/call': {
          const name = String(request.params?.['name'] ?? '');
          const tool = tools[name];
          if (!tool)
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Unknown tool "${name}". Call tools/list.` },
            };
          const args = request.params?.['arguments'];
          if (
            args !== undefined &&
            (args === null || typeof args !== 'object' || Array.isArray(args))
          )
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Tool arguments must be an object.' },
            };
          try {
            return {
              jsonrpc: '2.0',
              id,
              result: await tool((args ?? {}) as Record<string, unknown>),
            };
          } catch (error) {
            if (error instanceof ToolError)
              return { jsonrpc: '2.0', id, result: { ...text(error.message), isError: true } };
            throw error;
          }
        }
        default:
          if (notification) return null;
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error.',
        },
      };
    }
  }

  /** Handle a POSTed JSON-RPC body (single message or batch). Null means "202 Accepted, no body". */
  async function handleBody(body: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(handle))).filter(
        (response): response is JsonRpcResponse => response !== null,
      );
      return responses.length ? responses : null;
    }
    return handle(body);
  }

  return { handle, handleBody, tools: TOOLS };
}
