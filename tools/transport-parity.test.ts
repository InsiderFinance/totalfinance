/**
 * Stage 7A Decision 9 — parity is generated, then proven: one canonical fixture per flagship
 * operation runs through the direct SDK composition (where it is a single call), `registry.run`,
 * the CLI (spawned against the workspace build), the HTTP server (in process), and the MCP server
 * (in-memory client), and the canonical JSON of `structured`, `assumptions` (seed included),
 * `diagnostics.warnings`, the identity, and the derived annotations must agree; a malformed fixture
 * must produce the same error code and message across all five.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { createLocalHttpServer } from '@totalfinance/http';
import {
  backtestPack,
  createTotalFinanceMcpServer,
  defaultPacks,
  journeyPacks,
  toolNameFor,
} from '@totalfinance/mcp';
import {
  KNOWN_CAPABILITIES,
  createMemoryArtifactStore,
  createMemoryAuthorizationStore,
  createMemoryExecutionJournalStore,
  describeOperation,
  jsonSafe,
  toOperationError,
  tradePack,
  type OperationResult,
} from '@totalfinance/workflows';
import { registryForProfile } from '@totalfinance/workflows/local';
import {
  PARITY_FIXTURES,
  PARITY_LARGE_INPUT_IDS,
  PARITY_MALFORMED,
  PARITY_PREREQUISITES,
} from './transport-parity/fixtures.js';

const CLI = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
const registry = registryForProfile({ profile: 'full' });
const ids = registry.list().map((description) => description.id);
// Stage 7B.2: the trade pack's writes are capability-gated and need the lifecycle's stores; every
// transport here holds every capability and its own stores, so a write parity case is a real write.
const CAPABILITIES = [...KNOWN_CAPABILITIES];
const stores = () => ({
  authorization: createMemoryAuthorizationStore(),
  journal: createMemoryExecutionJournalStore(),
});
const CREATED_AT = Date.parse('2026-09-06T12:00:00Z');
// Fixed local test credential: meets the HTTP mutation boundary's 32-byte minimum and Bearer grammar.
const AUTHENTICATION_TOKEN = 'totalfinance-transport-parity-write-token-2026';
const HTTP_HEADERS = {
  'content-type': 'application/json',
  connection: 'close',
  authorization: `Bearer ${AUTHENTICATION_TOKEN}`,
};
const runOptions = () => ({
  maxInputBytes: 16_777_216,
  capabilities: CAPABILITIES,
  stores: stores(),
  artifacts: createMemoryArtifactStore(),
  createdTimestampMs: CREATED_AT,
});

/** What parity compares — the parts a transport must never alter. */
function projection(result: OperationResult): string {
  return canonicalJsonOf(
    jsonSafe({
      operation: result.operation,
      structured: result.structured,
      assumptions: result.assumptions,
      warnings: result.diagnostics.warnings,
      inputsHash: result.identity.inputsHash,
    }) as never,
  );
}

// Every HTTP request here is one-shot (`connection: close`): between operations this file spawns a CLI
// process and drives an MCP client, long enough for the server's idle keep-alive socket to close while
// undici still holds it — a reset that is a fixture artefact, not a parity finding.
describe('transport parity (Stage 7A Decision 9)', () => {
  const store = mkdtempSync(join(tmpdir(), 'totalfinance-parity-'));
  const http = createLocalHttpServer({
    registry,
    port: 0,
    budgets: { maxInputBytes: 16_777_216 },
    capabilities: CAPABILITIES,
    authenticationToken: AUTHENTICATION_TOKEN,
    stores: stores(),
    artifacts: createMemoryArtifactStore(),
    clock: () => new Date(CREATED_AT).toISOString(),
  });
  let base = '';
  let mcp: Client;
  const cliRun = (id: string, input: Record<string, unknown>, largeBudget = true) =>
    spawnSync(
      process.execPath,
      [
        CLI,
        'run',
        id,
        '--input',
        '-',
        '--profile',
        'full',
        '--store',
        store,
        ...(largeBudget ? ['--max-input-bytes', '16777216'] : []),
        ...CAPABILITIES.flatMap((name) => ['--capability', name]),
      ],
      { encoding: 'utf8', input: JSON.stringify(input) },
    );
  beforeAll(async () => {
    base = (await http.start()).url;
    const server = createTotalFinanceMcpServer({
      packs: [...defaultPacks(), ...journeyPacks(), backtestPack(), tradePack()],
      maxInputBytes: 16_777_216,
      readOnly: false,
      capabilities: CAPABILITIES,
      stores: stores(),
      artifacts: createMemoryArtifactStore(),
      clock: () => new Date(CREATED_AT).toISOString(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    mcp = new Client({ name: 'parity', version: '0' });
    await mcp.connect(clientTransport);
  });
  afterAll(async () => {
    await http.stop();
  });

  it('every flagship operation has a canonical fixture and a malformed one', () => {
    expect(Object.keys(PARITY_FIXTURES).sort()).toEqual([...ids].sort());
    expect(Object.keys(PARITY_MALFORMED).sort()).toEqual([...ids].sort());
  });

  for (const id of ids) {
    it(`${id}: registry, CLI, HTTP, and MCP agree on the result`, async () => {
      const operation = registry.require(id);
      const input = PARITY_FIXTURES[id]!();
      const prerequisites = PARITY_PREREQUISITES[id]?.() ?? [];
      const options = runOptions();
      const prepared = prerequisites.map((step) => registry.run({ ...step, ...options }));
      const viaRegistry = registry.run({ id, input, ...options });
      const expected = projection(viaRegistry);

      // HTTP
      for (const [index, step] of prerequisites.entries()) {
        const setup = await fetch(`${base}/operations/${step.id}/run`, {
          method: 'POST',
          headers: HTTP_HEADERS,
          body: JSON.stringify(step.input),
        });
        expect(setup.status, `${id}: HTTP prerequisite ${step.id}`).toBe(200);
        expect(projection((await setup.json()) as OperationResult)).toBe(
          projection(prepared[index]!),
        );
      }
      const response = await fetch(`${base}/operations/${id}/run`, {
        method: 'POST',
        headers: HTTP_HEADERS,
        body: JSON.stringify(input),
      });
      expect(response.status, `${id} HTTP status`).toBe(200);
      expect(projection((await response.json()) as OperationResult)).toBe(expected);

      // MCP: the tool's structured content is the whole OperationResult envelope (B2) — the same
      // document the HTTP route returns — under the tool name the operation id maps to (B1).
      for (const [index, step] of prerequisites.entries()) {
        const setup = await mcp.callTool({ name: toolNameFor(step.id), arguments: step.input });
        expect(setup.isError, `${id}: MCP prerequisite ${step.id}`).toBeFalsy();
        expect(projection(setup.structuredContent as OperationResult)).toBe(
          projection(prepared[index]!),
        );
      }
      const tool = await mcp.callTool({ name: toolNameFor(id), arguments: input });
      expect(tool.isError, `${id} MCP isError`).toBeFalsy();
      expect(projection(tool.structuredContent as OperationResult)).toBe(expected);
      expect(tool.content).toHaveLength(1);
      const { tools } = await mcp.listTools();
      const listed = tools.find(
        (candidate: { name: string }) => candidate.name === toolNameFor(id),
      );
      const annotations = describeOperation(operation).annotations;
      expect(listed?.annotations).toMatchObject(annotations);

      // CLI (spawned against the build) — skipped for inputs above the CLI's wire default when the fixture is large.
      if (!PARITY_LARGE_INPUT_IDS.includes(id)) {
        for (const [index, step] of prerequisites.entries()) {
          const setup = cliRun(step.id, step.input);
          expect(setup.status, `${id}: CLI prerequisite ${step.id}: ${setup.stderr}`).toBe(0);
          expect(projection(JSON.parse(setup.stdout) as OperationResult)).toBe(
            projection(prepared[index]!),
          );
        }
        const cli = cliRun(id, input);
        expect(cli.status, `${id} CLI exit: ${cli.stderr}`).toBe(0);
        expect(projection(JSON.parse(cli.stdout) as OperationResult)).toBe(expected);
      }
    }, 60_000);

    it(`${id}: a malformed input is refused with the same code and message everywhere`, async () => {
      const operation = registry.require(id);
      const input = PARITY_MALFORMED[id]!();
      let expectedCode = '';
      let expectedMessage = '';
      try {
        registry.run({ id, input, ...runOptions() });
        throw new Error(`${id}: the malformed fixture was accepted`);
      } catch (error) {
        const mapped = toOperationError(error, operation);
        expectedCode = mapped.code;
        expectedMessage = mapped.message;
      }
      expect(expectedCode).toMatch(/^input\./);

      const response = await fetch(`${base}/operations/${id}/run`, {
        method: 'POST',
        headers: HTTP_HEADERS,
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
      const httpError = (await response.json()) as { code: string; message: string };
      expect(httpError.code).toBe(expectedCode);
      expect(httpError.message).toBe(expectedMessage);

      const tool = await mcp.callTool({ name: toolNameFor(id), arguments: input });
      expect(tool.isError).toBe(true);
      const mcpError = JSON.parse((tool.content as { text: string }[])[0]!.text) as {
        code: string;
        message: string;
      };
      expect(mcpError.code).toBe(expectedCode);
      expect(mcpError.message).toBe(expectedMessage);

      const cli = cliRun(id, input, false);
      expect(cli.status).toBe(3);
      const cliError = JSON.parse(cli.stdout) as { code: string; message: string };
      expect(cliError.code).toBe(expectedCode);
      expect(cliError.message).toBe(expectedMessage);
    }, 60_000);
  }
});
