#!/usr/bin/env node
/**
 * Stdio entrypoint for the TotalFinance MCP server (Stage 7A Decision 8). `--help` and `doctor` write
 * to the terminal and exit; otherwise, once protocol mode starts, stdout is JSON-RPC only and every
 * log line goes to stderr.
 */

import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OPERATION_BUDGETS, WORKFLOWS_VERSION } from '@totalfinance/workflows';
import {
  REGISTRY_PROFILES,
  createFileArtifactStore,
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
  createLocalJobRunner,
  registryForProfile,
  packsForProfile,
  type RegistryProfile,
} from '@totalfinance/workflows/local';
import { configureMcpServer } from './server.js';

const NODE_FLOOR = '22.13.0';

const HELP = `totalfinance-mcp — TotalFinance MCP server over stdio (read-only by default)

Usage
  totalfinance-mcp [--profile ${REGISTRY_PROFILES.join('|')}] [--packs a,b]
               [--max-input-bytes <n>] [--seed <int>] [--deadline-ms <n>] [--store <dir>]
  totalfinance-mcp doctor          the Node floor, the tool set, the store, the budgets (then exit)
  totalfinance-mcp --help | --version

  --profile     the registry profile the tool set is built from (default: default — the ten domain packs)
  --packs a,b   narrow the profile to named packs — an exact selection
  --capability  a capability the caller holds (repeatable); a write capability lists the write tools
  --store <dir> attach an artifact store: handles resolve and reports are listed as resources
  --store-read-only attach only the store reader; cannot be combined with --jobs
  --jobs        attach the shared local worker runner (requires --store); adds typed job submit/status/result/cancel tools
  --page-size   maximum tools/resources per page (integer 1–100; default 100); follow nextCursor
  budgets       --max-input-bytes (default ${OPERATION_BUDGETS.maxInputBytes.transportDefault}) · --seed (default 0) · --deadline-ms
`;

function nodeMeetsFloor(version: string, floor: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number(part));
  const [a, b, c] = parse(version);
  const [x, y, z] = parse(floor);
  return a! > x! || (a === x && (b! > y! || (b === y && c! >= z!)));
}

function integerFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) {
    process.stderr.write(
      `totalfinance-mcp: --${name} must be an integer, received ${JSON.stringify(value)}\n`,
    );
    process.exit(2);
  }
  return Number(value);
}

let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  profile: { type: 'string' },
  packs: { type: 'string' },
  'max-input-bytes': { type: 'string' },
  seed: { type: 'string' },
  'deadline-ms': { type: 'string' },
  store: { type: 'string' },
  'store-read-only': { type: 'boolean' },
  jobs: { type: 'boolean' },
  'page-size': { type: 'string' },
  capability: { type: 'string', multiple: true },
} as const;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
} catch (error) {
  process.stderr.write(
    `totalfinance-mcp: ${error instanceof Error ? error.message : String(error)}\n${HELP}`,
  );
  process.exit(2);
}
const { values, positionals } = parsed;

if (values.help) {
  process.stderr.write(HELP);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(
    `${JSON.stringify({ 'totalfinance-mcp': WORKFLOWS_VERSION, node: process.version })}\n`,
  );
  process.exit(0);
}
if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== 'doctor')) {
  process.stderr.write(`totalfinance-mcp: unknown command ${JSON.stringify(positionals)}\n${HELP}`);
  process.exit(2);
}
if (
  ((values.jobs || values['store-read-only']) && values.store === undefined) ||
  (values.jobs && values['store-read-only'])
) {
  process.stderr.write(
    'totalfinance-mcp: --jobs requires a writable --store; --store-read-only requires --store and cannot be combined with --jobs.\n',
  );
  process.exit(2);
}
try {
  const profile = (values.profile ?? 'default') as RegistryProfile;
  if (!REGISTRY_PROFILES.includes(profile)) {
    process.stderr.write(
      `totalfinance-mcp: --profile must be one of ${REGISTRY_PROFILES.join(', ')}\n`,
    );
    process.exit(2);
  }
  const packNames =
    values.packs === undefined
      ? undefined
      : values.packs
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
  const available = packsForProfile(profile);
  const packs =
    packNames === undefined
      ? available
      : packNames.map((name) => {
          const pack = available.find((candidate) => candidate.name === name);
          if (!pack) {
            process.stderr.write(
              `totalfinance-mcp: pack '${name}' is not in the '${profile}' profile. Available: ${available.map((p) => p.name).join(', ')}\n`,
            );
            process.exit(2);
          }
          return pack;
        });
  const maxInputBytes = integerFlag('max-input-bytes', values['max-input-bytes']);
  const defaultSeed = integerFlag('seed', values.seed);
  const deadlineMs = integerFlag('deadline-ms', values['deadline-ms']);
  const pageSize = integerFlag('page-size', values['page-size']);
  const storeFlag = values.store;
  const directory =
    storeFlag === undefined ? undefined : isAbsolute(storeFlag) ? storeFlag : resolve(storeFlag);
  const writableStore =
    directory === undefined ? undefined : createFileArtifactStore({ directory });
  const artifacts =
    values['store-read-only'] && writableStore !== undefined
      ? { get: writableStore.get, list: writableStore.list }
      : writableStore;
  const stores =
    directory === undefined || values['store-read-only']
      ? undefined
      : {
          authorization: createFileAuthorizationStore({ directory }),
          journal: createFileExecutionJournalStore({ directory }),
        };
  const capabilities = values.capability === undefined ? undefined : [...values.capability];
  // A caller who grants a write capability wants the write tools listed: read-only lifts with it.
  const writeCapabilities = new Set(['trade:approve', 'trade:paper', 'portfolio:write']);
  const readOnly =
    capabilities === undefined
      ? undefined
      : !capabilities.some((name) => writeCapabilities.has(name));

  const options = {
    profile,
    ...(packNames !== undefined ? { packs } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(values.jobs
      ? {
          jobs: createLocalJobRunner({
            registry: registryForProfile({ profile, packs: packs.map((pack) => pack.name) }),
            directory: directory!,
            profile,
            packs: packs.map((pack) => pack.name),
            clock: () => new Date().toISOString(),
          }),
        }
      : {}),
    ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
    ...(defaultSeed !== undefined ? { defaultSeed } : {}),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(stores !== undefined ? { stores } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
  };
  // Validate through the very same constructor before doctor reports success.
  const configured = configureMcpServer(options);

  if (positionals[0] === 'doctor') {
    const report = {
      node: {
        version: process.version,
        floor: NODE_FLOOR,
        meetsFloor: nodeMeetsFloor(process.version, NODE_FLOOR),
      },
      server: {
        version: WORKFLOWS_VERSION,
        profile,
        packs: packs.map((pack) => pack.name),
        tools: configured.capabilities.tools.length,
      },
      store:
        directory === undefined
          ? null
          : {
              directory: join(directory),
              reports: artifacts?.list({ kind: 'report' }).length ?? 0,
            },
      budgets: configured.capabilities.budgets,
      capabilities: configured.capabilities,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    // A capability report exceeds a pipe buffer. Natural exit lets stdout drain on every
    // supported Node version; process.exit() can truncate otherwise-valid doctor JSON.
    process.exitCode = report.node.meetsFloor ? 0 : 2;
  } else {
    const transport = new StdioServerTransport();
    await configured.server.connect(transport);
  }
} catch (error) {
  process.stderr.write(
    `totalfinance-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
