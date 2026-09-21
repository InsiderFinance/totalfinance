#!/usr/bin/env node
/**
 * `totalfinance-http` — the loopback, read-only local HTTP server over the operation registry (Stage 7A
 * Decision 7). Machine-first: the bound address is printed as one JSON line on stdout; logs on stderr.
 */

import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OPERATION_BUDGETS } from '@totalfinance/workflows';
import {
  REGISTRY_PROFILES,
  createFileArtifactStore,
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
  createLocalJobRunner,
  registryForProfile,
  type RegistryProfile,
} from '@totalfinance/workflows/local';
import { createLocalHttpServer } from './server.js';

const HELP = `totalfinance-http — TotalFinance local HTTP server (loopback, read-only by default)

Usage
  totalfinance-http [--port 8787] [--host 127.0.0.1] [--openapi]
                [--profile default|options|research|full] [--packs a,b]
                [--store <dir>] [--max-input-bytes <n>] [--seed <int>] [--deadline-ms <n>]
                [--allow-non-loopback]
                [--capability <name>] [--token-file <path>]
  totalfinance-http --help | --version

  --openapi          print the OpenAPI 3.1 document to stdout and exit (no server)
  --store <dir>      the artifact/job store directory (default ~/.totalfinance/store); attaches handles, jobs, authorizations, and journals
  --capability <n>   enable a server capability (repeatable); writes require a bearer token
  --token-file <path>  read the bearer token from a protected file (overrides TOTALFINANCE_HTTP_TOKEN)
  TOTALFINANCE_HTTP_TOKEN  alternative environment variable; never put a secret in CLI arguments
  --allow-non-loopback  bind a non-loopback host; public reads remain; bring your own network/TLS boundary

Writes (including trade:approve) require a server-owned token of at least 32 random characters.
Generate one with node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
and store it in a file readable only by your user (mode 0600), or a protected environment.
Send Authorization: Bearer <token> for writes and POST /jobs or /jobs/{id}/cancel.
Without a token, job creation/cancellation are disabled; read-only inline analytics remain public.
JSON POST requests require Content-Type: application/json. Host and any Origin must name this
server and its bound port; null/foreign origins are refused. No credential appears in discovery or logs.

Routes: GET /openapi.json · GET /capabilities · GET /operations · GET /operations/{id} ·
POST /operations/{id}/run · POST /jobs · GET /jobs/{id} · POST /jobs/{id}/cancel · GET /jobs/{id}/result ·
GET /artifacts/{uri}
`;

function integerFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) {
    process.stderr.write(
      `totalfinance-http: --${name} must be an integer, received ${JSON.stringify(value)}\n`,
    );
    process.exit(2);
  }
  return Number(value);
}

async function main(): Promise<void> {
  let values: ReturnType<typeof parse>['values'];
  try {
    values = parse().values;
  } catch {
    // Unknown arguments may contain an accidentally supplied secret; never repeat argv.
    process.stderr.write(`totalfinance-http: invalid command-line options.\n${HELP}`);
    process.exit(2);
  }
  if (values.help) {
    process.stderr.write(HELP);
    return;
  }
  if (values.version) {
    const { WORKFLOWS_VERSION } = await import('@totalfinance/workflows');
    process.stdout.write(
      `${JSON.stringify({ 'totalfinance-http': WORKFLOWS_VERSION, node: process.version })}\n`,
    );
    return;
  }
  const profile = (values.profile ?? 'default') as RegistryProfile;
  if (!REGISTRY_PROFILES.includes(profile)) {
    process.stderr.write(
      `totalfinance-http: --profile must be one of ${REGISTRY_PROFILES.join(', ')}\n`,
    );
    process.exit(2);
  }
  const packs =
    values.packs === undefined
      ? undefined
      : values.packs
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
  const registry = registryForProfile({ profile, ...(packs ? { packs } : {}) });
  const storeFlag = values.store ?? join(homedir(), '.totalfinance', 'store');
  const directory = isAbsolute(storeFlag) ? storeFlag : resolve(storeFlag);
  const host = values.host ?? '127.0.0.1';
  const port = integerFlag('port', values.port) ?? 8787;
  const clock = () => new Date().toISOString();
  const maxInputBytes = integerFlag('max-input-bytes', values['max-input-bytes']);
  const defaultSeed = integerFlag('seed', values.seed);
  const deadlineMs = integerFlag('deadline-ms', values['deadline-ms']);
  const capabilities = values.capability === undefined ? undefined : [...values.capability];
  let authenticationToken = process.env['TOTALFINANCE_HTTP_TOKEN'];
  if (values['token-file'] !== undefined) {
    try {
      // A single trailing line ending is convenient for a protected text file; do not trim secrets.
      authenticationToken = readFileSync(values['token-file'], 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error('Unable to read --token-file; supply a readable protected token file.');
    }
  }
  const local = createLocalHttpServer({
    registry,
    artifacts: createFileArtifactStore({ directory }),
    stores: {
      authorization: createFileAuthorizationStore({ directory }),
      journal: createFileExecutionJournalStore({ directory }),
    },
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(authenticationToken !== undefined ? { authenticationToken } : {}),
    jobs: createLocalJobRunner({
      registry,
      directory,
      profile,
      ...(packs ? { packs } : {}),
      clock,
    }),
    host,
    port,
    ...(values['allow-non-loopback'] ? { allowNonLoopback: true } : {}),
    budgets: {
      maxInputBytes: maxInputBytes ?? OPERATION_BUDGETS.maxInputBytes.transportDefault,
      ...(defaultSeed !== undefined ? { defaultSeed } : {}),
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    },
    clock,
  });
  if (values.openapi) {
    process.stdout.write(`${JSON.stringify(local.document, null, 2)}\n`);
    return;
  }
  const bound = await local.start();
  process.stdout.write(
    `${JSON.stringify({ listening: bound.url, host: bound.host, port: bound.port, profile, store: directory, operations: registry.size })}\n`,
  );
  process.stderr.write(
    `totalfinance-http listening on ${bound.url} (profile ${profile}, ${registry.size} operations, store ${directory}); GET ${bound.url}/openapi.json\n`,
  );
  const shutdown = () => {
    void local.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function parse() {
  return parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      port: { type: 'string' },
      host: { type: 'string' },
      openapi: { type: 'boolean' },
      profile: { type: 'string' },
      packs: { type: 'string' },
      store: { type: 'string' },
      'max-input-bytes': { type: 'string' },
      seed: { type: 'string' },
      'deadline-ms': { type: 'string' },
      'allow-non-loopback': { type: 'boolean' },
      capability: { type: 'string', multiple: true },
      'token-file': { type: 'string' },
    },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `totalfinance-http: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(70);
});
