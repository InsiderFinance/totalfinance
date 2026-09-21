import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createTotalFinanceMcpServer, toolNameFor, type McpServerOptions } from '@totalfinance/mcp';
import {
  createMemoryArtifactStore,
  createMemoryJobStore,
  runOperation,
  type JobRecord,
  type OperationResult,
  type ArtifactStoreReader,
  operationResultSchema,
} from '@totalfinance/workflows';
import {
  createLocalJobRunner,
  createFileArtifactStore,
  registryForProfile,
  type JobRun,
  type JobRunner,
} from '@totalfinance/workflows/local';
import { PARITY_FIXTURES } from '../../../tools/transport-parity/fixtures.js';

const clients: Client[] = [];
const directories: string[] = [];
const runs: JobRun[] = [];
const registry = registryForProfile({ profile: 'backtesting' });
const operation = registry.require('totalfinance.backtest.options_run');
function dataInput() {
  return PARITY_FIXTURES[operation.id]!();
}
async function connect(options: McpServerOptions) {
  const server = createTotalFinanceMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'job-client-without-experimental-tasks', version: '0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'totalfinance-mcp-jobs-'));
  directories.push(directory);
  const local = createLocalJobRunner({
    registry,
    profile: 'backtesting',
    directory,
    clock: () => new Date().toISOString(),
    pollMs: 5,
  });
  const submit = vi.fn((submission: Parameters<JobRunner['submit']>[0]) => {
    const run = local.submit(submission);
    runs.push(run);
    return run;
  });
  return { jobs: { ...local, submit }, artifacts: createFileArtifactStore({ directory }), submit };
}
function record(id: string, operationId = operation.id): JobRecord {
  return {
    id,
    operation: { id: operationId, version: operation.version },
    state: 'running',
    progress: null,
    inputsHash: `sha256:${'0'.repeat(64)}`,
    seed: 0,
    submittedAt: '2026-09-07T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    usage: { elapsedMs: null },
  };
}
async function read(client: Client, uri: string) {
  const response = await client.readResource({ uri });
  return JSON.parse((response.contents[0] as { text: string }).text);
}
function errorDocument(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}
afterEach(async () => {
  await Promise.all(
    runs.splice(0).map(async (run) => {
      await run.cancel();
      await run.completion;
    }),
  );
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('optional worker jobs over stable MCP tools and resources', () => {
  it('adds controls only with explicit attachment; submission alternatives retain each operation schema', async () => {
    const bare = await connect({ profile: 'backtesting' });
    expect(
      (await bare.listTools()).tools.some((tool) => tool.name.startsWith('totalfinance_job_')),
    ).toBe(false);
    await expect(
      bare.callTool({ name: 'totalfinance_job_submit', arguments: {} }),
    ).rejects.toBeInstanceOf(McpError);
    const { jobs, artifacts } = setup();
    const client = await connect({ profile: 'backtesting', jobs, artifacts });
    const tools = (await client.listTools()).tools;
    expect(
      tools.filter((tool) => tool.name.startsWith('totalfinance_job_')).map((tool) => tool.name),
    ).toEqual([
      'totalfinance_job_submit',
      'totalfinance_job_status',
      'totalfinance_job_result',
      'totalfinance_job_cancel',
    ]);
    const alternatives = tools.find((tool) => tool.name === 'totalfinance_job_submit')!.inputSchema[
      'oneOf'
    ] as { properties: { id: { const: string }; input: unknown }; additionalProperties: boolean }[];
    for (const alternative of alternatives) {
      expect(alternative.properties.input).toEqual(
        registry.require(alternative.properties.id.const).inputSchema.toJSONSchema(),
      );
      expect(alternative.additionalProperties).toBe(false);
    }
    expect(client.getServerCapabilities()).not.toHaveProperty('tasks');
    expect((await read(client, 'totalfinance://capabilities')).jobs).toMatchObject({
      enabled: true,
      experimentalTasksRequired: false,
    });
  });
  it('submits immediately, reads lifecycle progress and unchanged results via tools/resources, with direct parity', async () => {
    const { jobs, artifacts } = setup();
    const client = await connect({ profile: 'backtesting', jobs, artifacts });
    const response = await client.callTool({
      name: 'totalfinance_job_submit',
      arguments: { id: operation.id, input: dataInput() },
    });
    expect(response.isError).toBeFalsy();
    const submitted = response.structuredContent as {
      job: JobRecord;
      statusUri: string;
      resultUri: string;
      progress: { stage: string; fraction: number | null };
    };
    expect(submitted.job.state).toBe('running');
    expect(submitted.progress).toEqual({ stage: 'running', fraction: null });
    const done = await runs.at(-1)!.completion;
    expect(done.state).toBe('completed');
    const status = await client.callTool({
      name: 'totalfinance_job_status',
      arguments: { jobId: done.id },
    });
    expect(status.structuredContent).toMatchObject({
      job: { state: 'completed' },
      progress: { stage: 'completed', fraction: 1 },
    });
    expect((await read(client, submitted.statusUri)).job).toEqual(done);
    const fetched = await client.callTool({
      name: 'totalfinance_job_result',
      arguments: { jobId: done.id },
    });
    const result = (fetched.structuredContent as unknown as { result: OperationResult }).result;
    const direct = runOperation({ operation, input: dataInput() });
    for (const field of [
      'operation',
      'library',
      'structured',
      'assumptions',
      'diagnostics',
      'identity',
    ] as const)
      expect(result[field]).toEqual(direct[field]);
    expect(await read(client, submitted.resultUri)).toEqual(result);
    expect(await read(client, done.result!.uri)).toEqual(result);
    expect((await client.listResources()).resources.map((entry) => entry.uri)).toContain(
      submitted.statusUri,
    );
  });
  it('the existing typed heavy call awaits a worker without running inline, permits discovery concurrently and emits progress', async () => {
    const { jobs, artifacts } = setup();
    const inline = vi.fn(() => {
      throw new Error('Must never execute on the MCP event loop');
    });
    const client = await connect({
      packs: [{ name: 'one-worker', operations: [{ ...operation, run: inline }] }],
      jobs,
      artifacts,
    });
    const tool = (await client.listTools()).tools.find(
      (tool) => tool.name === toolNameFor(operation.id),
    )!;
    expect(tool.outputSchema).toEqual(
      operationResultSchema({ structured: operation.outputSchema ?? undefined }),
    );
    const progress: { message?: string | undefined }[] = [];
    let finished = false;
    const pending = client
      .callTool({ name: toolNameFor(operation.id), arguments: dataInput() }, undefined, {
        onprogress: (value) => progress.push(value),
      })
      .then((result) => {
        finished = true;
        return result;
      });
    const caps = await read(client, 'totalfinance://capabilities');
    expect(caps.jobs.enabled).toBe(true);
    expect(finished).toBe(false);
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as unknown as OperationResult).structured).toEqual(
      runOperation({ operation, input: dataInput() }).structured,
    );
    expect(inline).not.toHaveBeenCalled();
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]!.message).toContain('lifecycle');
  });
  it('standard MCP request cancellation stops an awaited worker call', async () => {
    const { jobs, artifacts } = setup();
    const client = await connect({ profile: 'backtesting', jobs, artifacts });
    const controller = new AbortController();
    const pending = client.callTool(
      { name: toolNameFor(operation.id), arguments: dataInput() },
      undefined,
      {
        signal: controller.signal,
        onprogress: () => controller.abort(),
      },
    );
    await expect(pending).rejects.toBeDefined();
    expect(runs).toHaveLength(1);
    expect((await runs[0]!.completion).state).toBe('cancelled');
    expect(artifacts.list()).toEqual([]);
  });

  it('cancels an actual worker before completion and never exposes a result', async () => {
    const { jobs, artifacts } = setup();
    const client = await connect({ profile: 'backtesting', jobs, artifacts });
    const submitted = await client.callTool({
      name: 'totalfinance_job_submit',
      arguments: { id: operation.id, input: dataInput() },
    });
    const job = (submitted.structuredContent as unknown as { job: JobRecord }).job;
    const cancel = await client.callTool({
      name: 'totalfinance_job_cancel',
      arguments: { jobId: job.id },
    });
    expect(cancel.structuredContent).toMatchObject({ job: { state: 'cancelled', result: null } });
    expect((await runs.at(-1)!.completion).state).toBe('cancelled');
    expect(
      errorDocument(
        await client.callTool({ name: 'totalfinance_job_result', arguments: { jobId: job.id } }),
      ).code,
    ).toBe('operation.cancelled');
    await expect(
      client.readResource({ uri: `totalfinance://jobs/${job.id}/result` }),
    ).rejects.toBeInstanceOf(McpError);
    expect(
      (await client.callTool({ name: 'totalfinance_job_cancel', arguments: { jobId: job.id } }))
        .structuredContent,
    ).toMatchObject({ job: { state: 'cancelled' } });
    expect(artifacts.list({ kind: 'report' })).toEqual([]);
  });
  it('reports worker schema/row-cap errors verbatim and propagates server budgets', async () => {
    const { jobs, artifacts, submit } = setup();
    const client = await connect({
      profile: 'backtesting',
      jobs,
      artifacts,
      defaultSeed: 7,
      maxInputBytes: 65536,
      deadlineMs: 5000,
    });
    const badInput = { ...dataInput(), leverage: 2 };
    const response = await client.callTool({
      name: toolNameFor(operation.id),
      arguments: badInput,
    });
    const document = errorDocument(response);
    expect(document.code).toMatch(/^input\./);
    expect(submit.mock.calls[0]![0]).toMatchObject({
      seed: 7,
      maxInputBytes: 65536,
      deadlineMs: 5000,
    });
    const record = await runs.at(-1)!.completion;
    expect(
      errorDocument(
        await client.callTool({ name: 'totalfinance_job_result', arguments: { jobId: record.id } }),
      ),
    ).toEqual(document);
    try {
      runOperation({ operation, input: badInput });
    } catch (error) {
      expect(document.message).toBe((error as Error).message);
    }
  });
  it('checks byte caps and rejects arbitrary execution/grant/store overrides before invoking the runner', async () => {
    const { jobs, artifacts, submit } = setup();
    const client = await connect({ profile: 'backtesting', jobs, artifacts, maxInputBytes: 128 });
    const oversized = await client.callTool({
      name: 'totalfinance_job_submit',
      arguments: { id: operation.id, input: { padding: '💰'.repeat(80) } },
    });
    expect(errorDocument(oversized).code).toBe('operation.input_too_large');
    for (const args of [
      { id: 'totalfinance.trade.submit', input: {} },
      { id: 'totalfinance.option.price', input: {} },
      { id: operation.id, input: {}, capabilities: [] },
      { id: operation.id, input: {}, stores: {} },
      { id: operation.id, input: {}, seed: 123 },
    ])
      expect(
        errorDocument(await client.callTool({ name: 'totalfinance_job_submit', arguments: args }))
          .code,
      ).toMatch(/^(input|operation)\./);
    expect(submit).not.toHaveBeenCalled();
  });
  it('filters shared-runner jobs and their report resources; read/cancel cannot bypass an effective profile', async () => {
    const store = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    const hidden = record('hidden', 'totalfinance_backtest_portfolio_run');
    const report = artifacts.put({
      value: { operation: hidden.operation, structured: { secret: true } },
      kind: 'report',
      createdTimestampMs: Date.parse(hidden.submittedAt),
    });
    store.create({ ...hidden, state: 'completed', result: report });
    const submit = vi.fn((): JobRun => {
      throw new Error('Not authorized');
    });
    const cancel = vi.fn((id: string) => store.update(id, { state: 'cancelled' }));
    const jobs: JobRunner = { submit, cancel, get: store.get, list: store.list };
    const client = await connect({
      packs: [{ name: 'one', operations: [operation] }],
      capabilities: [],
      jobs,
      artifacts,
    });
    for (const name of [
      'totalfinance_job_status',
      'totalfinance_job_result',
      'totalfinance_job_cancel',
    ]) {
      expect(
        errorDocument(await client.callTool({ name, arguments: { jobId: hidden.id } })).code,
      ).toBe('operation.handle_unknown');
      expect(
        errorDocument(
          await client.callTool({
            name,
            arguments: { jobId: hidden.id, capabilities: ['trade:paper'] },
          }),
        ).code,
      ).toMatch(/^input\./);
    }
    for (const uri of [
      `totalfinance://jobs/${hidden.id}`,
      `totalfinance://jobs/${hidden.id}/result`,
      report.uri,
      'totalfinance://jobs/%2e%2e/result',
    ])
      await expect(client.readResource({ uri })).rejects.toBeInstanceOf(McpError);
    const uris = (await client.listResources()).resources.map((entry) => entry.uri);
    expect(uris).not.toContain(report.uri);
    expect(uris).not.toContain(`totalfinance://jobs/${hidden.id}`);
    expect(cancel).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it('hides a disallowed job’s real spilled report as well as its outer result, without revoking explicit datasets', async () => {
    const store = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    const hidden = record('spilled');
    const result = runOperation({
      operation,
      input: dataInput(),
      artifacts,
      inlineResultBytes: 1,
      createdTimestampMs: Date.parse(hidden.submittedAt),
      defaultSeed: 0,
    });
    const inner = result.artifacts[0]!;
    expect(inner.kind).toBe('report');
    expect(artifacts.get(inner.uri)!.value).not.toHaveProperty('operation');
    expect(artifacts.get(inner.uri)!.value).toEqual(
      runOperation({ operation, input: dataInput(), defaultSeed: 0 }).structured,
    );
    const outer = artifacts.put({
      value: result as unknown as Record<string, unknown>,
      kind: 'report',
      createdTimestampMs: Date.parse(hidden.submittedAt),
    });
    store.create({ ...hidden, state: 'completed', result: outer });
    const jobs: JobRunner = {
      get: store.get,
      list: store.list,
      submit: () => {
        throw new Error('Not used');
      },
      cancel: (id) => store.update(id, { state: 'cancelled' }),
    };
    const unrelated = artifacts.put({
      value: { dataset: [1, 2, 3] },
      kind: 'report',
      createdTimestampMs: Date.parse(hidden.submittedAt),
    });
    const client = await connect({ profile: 'valuation', jobs, artifacts, pageSize: 2 });
    // Guessed URIs must be refused before the client has ever asked for discovery.
    for (const handle of [outer, inner])
      await expect(client.readResource({ uri: handle.uri })).rejects.toMatchObject({
        code: -32602,
      });
    const listed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listResources(cursor === undefined ? {} : { cursor });
      listed.push(...page.resources.map((resource) => resource.uri));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    for (const handle of [outer, inner]) {
      expect(listed).not.toContain(handle.uri);
      await expect(client.readResource({ uri: handle.uri })).rejects.toBeInstanceOf(McpError);
    }
    expect(listed).not.toContain(unrelated.uri);
    await expect(client.readResource({ uri: unrelated.uri })).rejects.toMatchObject({
      code: -32602,
    });
    // Attachment is explicit: without a runner there is no job restriction on the dataset reader.
    const reader = await connect({ profile: 'valuation', artifacts });
    expect(await read(reader, unrelated.uri)).toEqual({ dataset: [1, 2, 3] });
    expect(await read(reader, inner.uri)).toEqual(artifacts.get(inner.uri)!.value);
    const permitted = await connect({ profile: 'backtesting', jobs, artifacts });
    expect(await read(permitted, outer.uri)).toEqual(result);
    expect(await read(permitted, inner.uri)).toEqual(artifacts.get(inner.uri)!.value);
  });

  it('propagates report restrictions through nested transitive links and cycles, with denial winning shared ownership', async () => {
    const store = createMemoryJobStore();
    const seed = createMemoryArtifactStore().put({
      value: {},
      kind: 'report',
      createdTimestampMs: Date.parse(record('seed').submittedAt),
    });
    const handle = (id: string) => ({ ...seed, uri: `totalfinance://reports/${id}` });
    const root = handle('root');
    const child = handle('child');
    const grandchild = handle('grandchild');
    const unrelated = handle('unrelated');
    const allowedParent = handle('allowed-parent');
    const values = new Map<string, Record<string, unknown>>([
      [
        root.uri,
        {
          operation: record('root').operation,
          artifacts: [child, handle('missing'), { ...child, uri: 'totalfinance://reports/../bad' }],
          inputs: { dataset: unrelated },
        },
      ],
      [child.uri, { artifacts: [grandchild] }],
      [grandchild.uri, { artifacts: [root], ledger: { secret: true } }],
      [unrelated.uri, { operation: record('unrelated').operation, dataset: true }],
      [allowedParent.uri, { operation: record('allowed-parent').operation, artifacts: [child] }],
    ]);
    // A custom reader can contain reference/object cycles that a content-addressed store cannot mint.
    values.get(child.uri)!['self'] = values.get(child.uri)!;
    const get = vi.fn((uri: string) =>
      values.has(uri) ? { handle: handle(uri.split('/').at(-1)!), value: values.get(uri)! } : null,
    );
    const artifacts: ArtifactStoreReader = {
      get,
      // An intermediate report omitted from listing still carries restrictions to its descendants.
      list: () => [root, grandchild, unrelated, allowedParent],
    };
    // The allowed row comes first: no first-match shortcut may unhide a disallowed owner's data.
    store.create({ ...record('allowed'), state: 'completed', result: root });
    const jobs: JobRunner = {
      get: store.get,
      list: store.list,
      submit: () => {
        throw new Error('Not used');
      },
      cancel: (id) => store.update(id, { state: 'cancelled' }),
    };
    const client = await connect({ profile: 'backtesting', jobs, artifacts });
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toContain(
      root.uri,
    );
    // A later owner must invalidate visibility; do not cache permissions across requests.
    store.create({
      ...record('hidden'),
      operation: { id: operation.id, version: '2' },
      state: 'completed',
      result: root,
    });
    const listed = (await client.listResources()).resources.map((resource) => resource.uri);
    for (const report of [root, child, grandchild]) {
      expect(listed).not.toContain(report.uri);
      get.mockClear();
      await expect(client.readResource({ uri: report.uri })).rejects.toMatchObject({
        code: -32602,
      });
      expect(get.mock.calls.filter(([uri]) => uri === root.uri).length).toBeLessThanOrEqual(2);
    }
    expect(listed).toContain(unrelated.uri);
    expect(listed).toContain(allowedParent.uri);
    expect(await read(client, unrelated.uri)).toEqual(values.get(unrelated.uri));
  });

  it.each(['valuation', 'backtesting'] as const)(
    'hides orphan spills with a missing outer job report under %s',
    async (profile) => {
      const store = createMemoryJobStore();
      const artifacts = createMemoryArtifactStore();
      const hidden = record('missing-parent');
      const result = runOperation({
        operation,
        input: dataInput(),
        artifacts,
        inlineResultBytes: 1,
        createdTimestampMs: Date.parse(hidden.submittedAt),
      });
      const outer = artifacts.put({
        value: result as unknown as Record<string, unknown>,
        kind: 'report',
        createdTimestampMs: Date.parse(hidden.submittedAt),
      });
      store.create({ ...hidden, state: 'completed', result: outer });
      const reader: ArtifactStoreReader = {
        list: artifacts.list,
        get: (uri) => (uri === outer.uri ? null : artifacts.get(uri)),
      };
      const jobs: JobRunner = {
        get: store.get,
        list: store.list,
        submit: () => {
          throw new Error('Not used');
        },
        cancel: (id) => store.update(id, { state: 'cancelled' }),
      };
      const client = await connect({ profile, jobs, artifacts: reader });
      for (const handle of [outer, ...result.artifacts]) {
        await expect(client.readResource({ uri: handle.uri })).rejects.toMatchObject({
          code: -32602,
        });
        expect(
          (await client.listResources()).resources.map((resource) => resource.uri),
        ).not.toContain(handle.uri);
      }
    },
  );

  it.each(['accepted', 'queued', 'running', 'cancelled', 'failed'] as const)(
    'binds a persisted spill to its %s owner before any outer result exists',
    async (state) => {
      const store = createMemoryJobStore();
      const artifacts = createMemoryArtifactStore();
      const owner = { ...record('owner'), state };
      store.create(owner);
      const result = runOperation({
        operation,
        input: dataInput(),
        artifacts,
        inlineResultBytes: 1,
        requestId: owner.id,
        createdTimestampMs: Date.parse(owner.submittedAt),
      });
      const spill = result.artifacts[0]!;
      expect(spill.provenance['requestId']).toBe(owner.id);
      expect(store.get(owner.id)!.result).toBeNull();
      const jobs: JobRunner = {
        get: store.get,
        list: store.list,
        submit: () => {
          throw new Error('Not used');
        },
        cancel: (id) => store.update(id, { state: 'cancelled' }),
      };
      const client = await connect({ profile: 'valuation', jobs, artifacts });
      await expect(client.readResource({ uri: spill.uri })).rejects.toMatchObject({ code: -32602 });
      expect(
        (await client.listResources()).resources.map((resource) => resource.uri),
      ).not.toContain(spill.uri);
      const permitted = await connect({ profile: 'backtesting', jobs, artifacts });
      expect(await read(permitted, spill.uri)).toEqual(artifacts.get(spill.uri)!.value);
      // An allowed parent must not re-authorize a report whose provenance names a hidden owner.
      const enabled = registryForProfile({ profile: 'valuation' }).list()[0]!;
      const allowedParent = artifacts.put({
        value: { operation: { id: enabled.id, version: enabled.version }, artifacts: [spill] },
        kind: 'report',
        createdTimestampMs: Date.parse(owner.submittedAt),
      });
      expect((await client.listResources()).resources.map((resource) => resource.uri)).toContain(
        allowedParent.uri,
      );
      await expect(client.readResource({ uri: spill.uri })).rejects.toMatchObject({ code: -32602 });
      expect(
        (await client.listResources()).resources.map((resource) => resource.uri),
      ).not.toContain(spill.uri);
    },
  );

  it('keeps explicit report and non-report input datasets usable even when a hidden report references them', async () => {
    const store = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    const snapshotOperation = registryForProfile({ profile: 'portfolio' }).require(
      'totalfinance.portfolio.snapshot',
    );
    const input = PARITY_FIXTURES[snapshotOperation.id]!();
    const hidden = record('dataset-owner');
    const market = artifacts.put({
      value: input['market'] as Record<string, unknown>,
      kind: 'market',
      createdTimestampMs: Date.parse(hidden.submittedAt),
    });
    const portfolio = artifacts.put({
      value: input['portfolio'] as Record<string, unknown>,
      kind: 'report',
      createdTimestampMs: Date.parse(hidden.submittedAt),
    });
    const result = artifacts.put({
      value: { operation: hidden.operation, inputs: { market, portfolio } },
      kind: 'report',
      createdTimestampMs: Date.parse(hidden.submittedAt),
    });
    store.create({ ...hidden, state: 'completed', result });
    const jobs: JobRunner = {
      get: store.get,
      list: store.list,
      submit: () => {
        throw new Error('This dataset calculation is inline');
      },
      cancel: (id) => store.update(id, { state: 'cancelled' }),
    };
    const client = await connect({ profile: 'portfolio', jobs, artifacts });
    await expect(client.readResource({ uri: result.uri })).rejects.toMatchObject({ code: -32602 });
    await expect(client.readResource({ uri: portfolio.uri })).rejects.toMatchObject({
      code: -32602,
    });
    const response = await client.callTool({
      name: toolNameFor(snapshotOperation.id),
      arguments: { ...input, market, portfolio },
    });
    expect(response.isError).toBeFalsy();
    expect((response.structuredContent as unknown as OperationResult).structured).toEqual(
      runOperation({ operation: snapshotOperation, input }).structured,
    );
  });

  it('forwards measured runner progress, refuses unfinished results and validates report identity', async () => {
    const store = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    store.create({ ...record('measured'), progress: { stage: 'pricing', fraction: 0.25 } });
    const wrong = artifacts.put({
      value: {
        operation: { id: 'totalfinance.test.other', version: '1' },
        structured: { wrong: true },
      },
      kind: 'report',
      createdTimestampMs: Date.parse('2026-09-07T00:00:00Z'),
    });
    store.create({ ...record('mismatched'), state: 'completed', result: wrong });
    const jobs: JobRunner = {
      get: store.get,
      list: store.list,
      submit: () => {
        throw new Error('Not used');
      },
      cancel: (id) => store.update(id, { state: 'cancelled' }),
    };
    const client = await connect({ profile: 'backtesting', jobs, artifacts });
    expect(
      (await client.callTool({ name: 'totalfinance_job_status', arguments: { jobId: 'measured' } }))
        .structuredContent,
    ).toMatchObject({ progress: { stage: 'pricing', fraction: 0.25 } });
    expect(
      errorDocument(
        await client.callTool({
          name: 'totalfinance_job_result',
          arguments: { jobId: 'measured' },
        }),
      ).code,
    ).toBe('input.wrong_shape');
    expect(
      errorDocument(
        await client.callTool({
          name: 'totalfinance_job_result',
          arguments: { jobId: 'mismatched' },
        }),
      ).code,
    ).toBe('operation.handle_kind_mismatch');
    for (const jobId of ['', '../measured', 'x'.repeat(201), null, 1]) {
      expect(
        errorDocument(
          await client.callTool({ name: 'totalfinance_job_status', arguments: { jobId } }),
        ).code,
      ).toMatch(/^input\./);
    }
  });

  it.each(['accepted', 'queued', 'running', 'cancelled', 'failed'] as const)(
    'reports %s result reads truthfully through tools and resources',
    async (state) => {
      const store = createMemoryJobStore();
      const artifacts = createMemoryArtifactStore();
      const failure = {
        code: 'input.out_of_range',
        message: 'Original worker refusal',
        context: { field: 'chains' },
        operation: { id: operation.id, version: operation.version },
      };
      store.create({ ...record('polling'), state, error: state === 'failed' ? failure : null });
      const jobs: JobRunner = {
        get: store.get,
        list: store.list,
        submit: () => {
          throw new Error('Not used');
        },
        cancel: (id) => store.update(id, { state: 'cancelled' }),
      };
      const client = await connect({ profile: 'backtesting', jobs, artifacts });
      const expected =
        state === 'failed'
          ? failure
          : {
              code: state === 'cancelled' ? 'operation.cancelled' : 'input.wrong_shape',
              context: { jobId: 'polling', state },
            };
      expect(
        errorDocument(
          await client.callTool({
            name: 'totalfinance_job_result',
            arguments: { jobId: 'polling' },
          }),
        ),
      ).toMatchObject(expected);
      await expect(
        client.readResource({ uri: 'totalfinance://jobs/polling/result' }),
      ).rejects.toMatchObject({ code: -32602, data: expected });
      expect(store.get('polling')!.state).toBe(state);
    },
  );

  it('does not offload privileged job operations or silently fall back inline', async () => {
    const { jobs, artifacts, submit } = setup();
    const inline = vi.fn(() => {
      throw new Error('Not authorized on job path');
    });
    const privileged = {
      ...operation,
      id: 'totalfinance.test.privileged',
      requiredCapabilities: ['trade:paper'],
      run: inline,
    };
    const client = await connect({
      packs: [{ name: 'privileged', operations: [privileged] }],
      readOnly: false,
      capabilities: ['trade:paper'],
      jobs,
      artifacts,
    });
    // B2: the filtered privileged operation is refused with its reason, never run inline.
    const refused = await client.callTool({ name: toolNameFor(privileged.id), arguments: {} });
    expect(refused.isError).toBe(true);
    expect(errorDocument(refused).code).toBe('operation.tool_filtered');
    expect((await read(client, 'totalfinance://capabilities')).filters).toContainEqual(
      expect.objectContaining({ tool: toolNameFor(privileged.id), unsupportedJob: true }),
    );
    expect(
      errorDocument(
        await client.callTool({
          name: 'totalfinance_job_submit',
          arguments: { id: privileged.id, input: {} },
        }),
      ).code,
    ).toBe('operation.unknown');
    expect(inline).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
