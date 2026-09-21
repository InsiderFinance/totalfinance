import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import {
  createMemoryExecutionJournalStore,
  createOperationRegistry,
  tradePack,
  type ExecutionJournalStore,
} from '@totalfinance/workflows';
import {
  createFileArtifactStore,
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
  createFileJobStore,
} from '@totalfinance/workflows/local';
import { CREATED, JOURNAL, event, grant, job } from './fixtures/store-values.js';

const directories: string[] = [];
const children = new Set<ChildProcess>();
const fresh = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'totalfinance-transactions-'));
  directories.push(directory);
  return directory;
};
const hash = (id: string): string => createHash('sha256').update(id).digest('hex');
const journalPath = (directory: string, id = JOURNAL): string =>
  join(directory, 'journals', 'v2', `${hash(id)}.json`);
let workerPath: string;
beforeAll(async () => {
  workerPath = join(fresh(), 'worker.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/file-store-worker.ts', import.meta.url))],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    logLevel: 'silent',
  });
});
afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }),
  );
  children.clear();
});
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

interface WorkerResult {
  results?: { appended?: number; createdTimestampMs?: number }[];
  error?: { code: string; message: string };
}
async function start(action: string, directory: string, worker = 0, count = 1) {
  const child = spawn(
    process.execPath,
    [workerPath, action, directory, String(worker), String(count)],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  children.add(child);
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', (message) =>
      message === 'ready' ? resolve() : reject(new Error(String(message))),
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`worker exited before ready (${String(code)}): ${stderr}`)),
    );
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', (code, signal) =>
      code === 0 || signal === 'SIGKILL'
        ? resolve()
        : reject(new Error(`worker failed (${String(code)}): ${stderr}`)),
    );
  });
  await ready;
  return { child, exited };
}

async function runWorkers(action: string, directory: string, count = 1): Promise<WorkerResult[]> {
  const workers = await Promise.all(
    Array.from({ length: 4 }, (_, index) => start(action, directory, index, count)),
  );
  const replies = workers.map(({ child }) => once(child, 'message'));
  for (const { child } of workers) child.send('go');
  const results = await Promise.all(replies);
  await Promise.all(workers.map(({ exited }) => exited));
  return results.map(([result]) => result as WorkerResult);
}

describe.each(['memory', 'file'] as const)('%s journal transaction contract', (kind) => {
  const make = (): ExecutionJournalStore =>
    kind === 'memory'
      ? createMemoryExecutionJournalStore()
      : createFileExecutionJournalStore({ directory: fresh() });

  it('commits before returning, detaches snapshots/results, and supports read-only transactions', () => {
    const store = make();
    const appended = event('one');
    const result = store.transact({
      journalId: JOURNAL,
      execute: (prior) => {
        expect(prior).toEqual([]);
        expect(store.read(JOURNAL)).toEqual([]); // read under a transaction must not deadlock
        return { events: [appended], result: appended };
      },
    });
    expect(result).toBe(appended);
    result.detail.note = 'caller mutation';
    expect(store.read(JOURNAL)).toEqual([event('one')]);
    expect(
      store.transact({
        journalId: JOURNAL,
        execute: (prior) => {
          prior[0]!.detail.note = 'snapshot mutation';
          return { events: [], result: prior.length };
        },
      }),
    ).toBe(1);
    expect(store.read(JOURNAL)).toEqual([event('one')]);
    expect(store.list()).toEqual([JOURNAL]);
    store.transact({ journalId: 'unknown', execute: () => ({ events: [], result: undefined }) });
    expect(store.list()).toEqual([JOURNAL]);
  });

  it('skips identical retries but refuses conflicting same-ID bodies atomically, including within a batch', () => {
    const store = make();
    expect(store.append({ events: [event('one'), event('one')] })).toEqual({
      journalId: JOURNAL,
      appended: 1,
      skipped: 1,
      total: 1,
    });
    expect(store.append({ events: [event('one')] })).toMatchObject({
      appended: 0,
      skipped: 1,
      total: 1,
    });
    expect(() =>
      store.append({ events: [event('two'), { ...event('one'), detail: { note: 'conflict' } }] }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.TradeIdempotencyConflict }));
    expect(() =>
      store.transact({
        journalId: JOURNAL,
        execute: () => ({
          events: [event('two'), { ...event('two'), timestampMs: 2_000 }],
          result: true,
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.TradeIdempotencyConflict }));
    expect(store.read(JOURNAL)).toEqual([event('one')]);
  });

  it('writes nothing when callbacks throw, return promises/bad batches, or try a nested append', () => {
    const store = make();
    store.append({ events: [event('one')] });
    expect(() =>
      store.transact({
        journalId: JOURNAL,
        execute: (prior) => {
          prior[0]!.detail.note = 'not committed';
          throw new Error('callback failed');
        },
      }),
    ).toThrow('callback failed');
    expect(() =>
      store.transact({
        journalId: JOURNAL,
        execute: async () => ({ events: [event('two')], result: true }),
      } as never),
    ).toThrow();
    expect(() =>
      store.transact({
        journalId: JOURNAL,
        execute: () => ({ events: [event('two'), event('foreign', 'other')], result: true }),
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InputWrongShape }));
    expect(() =>
      store.transact({
        journalId: JOURNAL,
        execute: () => {
          store.append({ events: [event('nested')] });
          return { events: [], result: true };
        },
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InputWrongShape }));
    expect(() =>
      store.transact({
        journalId: JOURNAL,
        execute: () => ({
          events: [event('two')],
          get result(): never {
            throw new Error('result getter failed');
          },
        }),
      }),
    ).toThrow('result getter failed');
    expect(store.read(JOURNAL)).toEqual([event('one')]);
    expect(store.append({ events: [event('two')] }).total).toBe(2); // every failure releases the lock
  });

  it('validates transaction inputs and keeps slash/colon/underscore identities isolated', () => {
    const store = make();
    for (const input of [
      null,
      {},
      { journalId: '', execute: () => ({ events: [], result: null }) },
      { journalId: JOURNAL, execute: 1 },
      { journalId: JOURNAL, execute: () => ({ events: [], result: null }), extra: true },
    ])
      expect(() => store.transact(input as never)).toThrow();
    const ids = [
      'paper:main:journal',
      'paper_main:journal',
      'paper/main:journal',
      '../paper/main:journal',
      'paper_main_journal',
    ];
    for (const id of ids) store.append({ events: [event('same-event-id', id)] });
    expect(store.list()).toEqual([...ids].sort());
    for (const id of ids) expect(store.read(id)).toEqual([event('same-event-id', id)]);
  });
});

describe('file journal identity and migration', () => {
  it('requires the transactional method at the runtime boundary', () => {
    const store = createMemoryExecutionJournalStore();
    const registry = createOperationRegistry({ packs: [tradePack()] });
    expect(() =>
      registry.run({
        id: 'totalfinance.trade.reconcile',
        input: {},
        stores: { journal: { append: store.append, read: store.read, list: store.list } as never },
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InputWrongType }));
  });
  it('reads and migrates only an exact, uniform legacy identity; preserves originals in list()', () => {
    const directory = fresh();
    const store = createFileExecutionJournalStore({ directory });
    const original = 'paper:main:journal';
    const collision = 'paper_main:journal';
    const legacy = join(directory, 'journals', 'paper_main_journal.json');
    writeFileSync(legacy, JSON.stringify([event('legacy', original)]));
    expect(store.read(original)).toEqual([event('legacy', original)]);
    expect(store.read(collision)).toEqual([]);
    expect(store.list()).toEqual([original]);
    expect(() =>
      store.transact({
        journalId: original,
        execute: () => {
          throw new Error('abort migration');
        },
      }),
    ).toThrow();
    expect(readdirSync(join(directory, 'journals', 'v2'))).toEqual([]);
    store.append({ events: [event('foreign', collision)] });
    store.transact({ journalId: original, execute: () => ({ events: [], result: null }) });
    const restarted = createFileExecutionJournalStore({ directory });
    expect(restarted.read(original)).toEqual([event('legacy', original)]);
    expect(restarted.read(collision)).toEqual([event('foreign', collision)]);
    expect(restarted.list()).toEqual([original, collision].sort());
    expect(JSON.parse(readFileSync(journalPath(directory, original), 'utf8'))).toEqual({
      journalId: original,
      events: [event('legacy', original)],
    });
    expect(JSON.parse(readFileSync(legacy, 'utf8'))).toEqual([event('legacy', original)]);
  });

  it('preserves a valid empty legacy array without inventing its identity', () => {
    const directory = fresh();
    const store = createFileExecutionJournalStore({ directory });
    const legacy = join(directory, 'journals', 'empty.json');
    writeFileSync(legacy, '[]');
    expect(store.read('empty')).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(
      store.transact({
        journalId: 'empty',
        execute: (prior) => ({ events: [], result: prior.length }),
      }),
    ).toBe(0);
    expect(readdirSync(join(directory, 'journals', 'v2'))).toEqual([]);
    expect(store.append({ events: [event('first', 'empty')] })).toMatchObject({
      appended: 1,
      total: 1,
    });
    expect(store.read('empty')).toEqual([event('first', 'empty')]);
    expect(store.list()).toEqual(['empty']);
    expect(readFileSync(legacy, 'utf8')).toBe('[]');
  });

  it.each([
    ['null', 'null'],
    ['object', '{}'],
    ['wrong envelope shape', JSON.stringify({ events: [event('old', 'a:b')] })],
    ['primitive', '42'],
    ['truncated JSON', '[{"eventId":'],
    ['null event', '[null]'],
    ['primitive event', '[true]'],
    ['missing journal ID', JSON.stringify([{ ...event('old', 'a:b'), journalId: undefined }])],
    ['empty journal ID', JSON.stringify([{ ...event('old', 'a:b'), journalId: '' }])],
    ['invalid journal ID', JSON.stringify([event('old', 'bad id')])],
    [
      'partly missing IDs',
      JSON.stringify([event('old', 'a:b'), { ...event('next', 'a:b'), journalId: undefined }]),
    ],
    ['mixed IDs excluding requester', JSON.stringify([event('old', 'a:b'), event('next', 'a_b')])],
    ['foreign invalid body', JSON.stringify([{ ...event('old', 'a:b'), detail: null }])],
    ['foreign unknown field', JSON.stringify([{ ...event('old', 'a:b'), invented: true }])],
    ['foreign duplicate ID', JSON.stringify([event('old', 'a:b'), event('old', 'a:b')])],
    [
      'foreign conflicting ID',
      JSON.stringify([event('old', 'a:b'), { ...event('old', 'a:b'), timestampMs: 2_000 }]),
    ],
    ['foreign ID not matching filename', JSON.stringify([event('old', 'other')])],
  ])(
    'refuses legacy %s at every entrypoint without callbacks, migration, or rewriting',
    (_label, content) => {
      const directory = fresh();
      const store = createFileExecutionJournalStore({ directory });
      const legacy = join(directory, 'journals', 'a_b.json');
      // a/b collides with both a:b and a_b but does not occur in any of these fixtures.
      const requested = 'a/b';
      writeFileSync(legacy, content!);
      let called = false;
      const attempts = [
        () => store.read(requested),
        () => store.list(),
        () => store.append({ events: [event('new', requested)] }),
        () =>
          store.transact({
            journalId: requested,
            execute: () => {
              called = true;
              return { events: [event('new', requested)], result: true };
            },
          }),
      ];
      for (const attempt of attempts) {
        expect(attempt).toThrowError(InputError);
        expect(attempt).toThrowError(expect.objectContaining({ code: expect.any(String) }));
        expect(readFileSync(legacy, 'utf8')).toBe(content);
        expect(readdirSync(join(directory, 'journals', 'v2'))).toEqual([]);
      }
      expect(called).toBe(false);
      const restarted = createFileExecutionJournalStore({ directory });
      expect(() => restarted.read(requested)).toThrowError(InputError);
      expect(() => restarted.list()).toThrowError(InputError);
    },
  );

  it('validates legacy corruption in list even when a current journal already owns that ID', () => {
    const directory = fresh();
    const store = createFileExecutionJournalStore({ directory });
    store.append({ events: [event('current', 'a:b')] });
    const current = readFileSync(journalPath(directory, 'a:b'), 'utf8');
    const legacy = join(directory, 'journals', 'a_b.json');
    const corrupt = JSON.stringify([{ ...event('old', 'a:b'), detail: null }]);
    writeFileSync(legacy, corrupt);
    expect(() => store.list()).toThrowError(InputError);
    expect(readFileSync(legacy, 'utf8')).toBe(corrupt);
    expect(readFileSync(journalPath(directory, 'a:b'), 'utf8')).toBe(current);
    // Current-version identity-checked data remains authoritative for a direct read.
    expect(store.read('a:b')).toEqual([event('current', 'a:b')]);
  });

  it('refuses mixed legacy arrays and forged current identities', () => {
    const directory = fresh();
    const store = createFileExecutionJournalStore({ directory });
    writeFileSync(
      join(directory, 'journals', 'a_b.json'),
      JSON.stringify([event('a', 'a:b'), event('b', 'a_b')]),
    );
    writeFileSync(join(directory, 'journals', 'empty.json'), '[]');
    expect(() => store.read('a:b')).toThrowError(
      expect.objectContaining({ code: ErrorCode.InputWrongShape }),
    );
    expect(() => store.read('a_b')).toThrowError(
      expect.objectContaining({ code: ErrorCode.InputWrongShape }),
    );
    expect(() => store.append({ events: [event('new', 'a:b')] })).toThrow();
    expect(() => store.list()).toThrowError(
      expect.objectContaining({ code: ErrorCode.InputWrongShape }),
    );
    store.append({ events: [event('valid')] });
    writeFileSync(
      journalPath(directory),
      JSON.stringify({ journalId: 'foreign', events: [event('one', 'foreign')] }),
    );
    expect(() => store.read(JOURNAL)).toThrowError(
      expect.objectContaining({ code: ErrorCode.InputWrongShape }),
    );
    expect(() => store.list()).toThrowError(
      expect.objectContaining({ code: ErrorCode.InputWrongShape }),
    );
    expect(() => store.append({ events: [event('two')] })).toThrow();
    writeFileSync(
      journalPath(directory),
      JSON.stringify({ journalId: JOURNAL, events: [event('one', 'foreign')] }),
    );
    expect(() => store.read(JOURNAL)).toThrowError(
      expect.objectContaining({ code: ErrorCode.InputWrongShape }),
    );
  });
});

describe('independent-process persistence regressions', () => {
  it('flushes a large worker reply before disconnecting the IPC channel', async () => {
    const worker = await start('large-reply', fresh());
    const message = once(worker.child, 'message');
    worker.child.send('go');
    const [reply] = (await message) as [{ results: { payload: string }[] }];
    expect(reply.results).toHaveLength(1);
    const payload = reply.results[0]!.payload;
    expect(payload).toHaveLength(256 * 1024);
    expect(hash(payload)).toBe(hash('x'.repeat(256 * 1024)));
    await worker.exited;
  });

  it('recovers registers after a job worker is forcibly terminated while its host stays alive', async () => {
    const directory = fresh();
    const store = createFileArtifactStore({ directory });
    const worker = new Worker(workerPath, { argv: ['crash-artifact-index', directory, '0', '1'] });
    try {
      expect(await once(worker, 'message')).toEqual(['ready']);
      const held = once(worker, 'message');
      worker.postMessage('go');
      expect(await held).toEqual(['held']);
      await worker.terminate();
      const handle = store.put({
        kind: 'report',
        value: { id: 'after-worker-termination' },
        createdTimestampMs: CREATED,
      });
      expect(store.get(handle.uri)?.value).toEqual({ id: 'after-worker-termination' });
    } finally {
      await worker.terminate();
    }
  });

  it.each(['crash-artifact-index', 'crash-authorization-index'] as const)(
    'recovers %s between value and index commits without losing earlier handles',
    async (action) => {
      const directory = fresh();
      const artifacts = createFileArtifactStore({ directory });
      const authorizations = createFileAuthorizationStore({ directory });
      const before =
        action === 'crash-artifact-index'
          ? artifacts.put({ kind: 'report', value: { id: 'prior' }, createdTimestampMs: CREATED })
          : authorizations.put({ grant: grant('prior'), createdTimestampMs: CREATED });
      const writer = await start(action, directory);
      const message = once(writer.child, 'message');
      writer.child.send('go');
      await message;
      writer.child.kill('SIGKILL');
      await writer.exited;
      const store = action === 'crash-artifact-index' ? artifacts : authorizations;
      expect(store.list()).toEqual([before]);
      expect(store.get(before.uri)?.handle).toEqual(before);
      const recovered =
        action === 'crash-artifact-index'
          ? artifacts.put({ kind: 'report', value: { id: 'orphan' }, createdTimestampMs: CREATED })
          : authorizations.put({ grant: grant('orphan'), createdTimestampMs: CREATED });
      expect(store.list()).toHaveLength(2);
      expect(store.get(recovered.uri)?.handle).toEqual(recovered);
    },
  );

  it('refuses job re-keying while another process legitimately updates the same immutable ID', async () => {
    const directory = fresh();
    const store = createFileJobStore({ directory });
    store.create(job());
    const outcomes = await runWorkers('job-immutable', directory);
    expect(outcomes.filter((outcome) => !outcome.error)).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.error?.code === ErrorCode.InputUnknownField),
    ).toHaveLength(3);
    expect(store.list()).toEqual([{ ...job(), inputsHash: 'valid-update' }]);
    expect(store.get('job-1')?.id).toBe('job-1');
    for (const worker of [1, 2, 3]) expect(store.get(`renamed-${worker}`)).toBeNull();
  });

  it.each(['crash-before-rename', 'crash-after-rename'] as const)(
    'recovers an atomic batch after %s without exposing partial JSON',
    async (action) => {
      const directory = fresh();
      const store = createFileExecutionJournalStore({ directory });
      store.append({ events: [event('initial')] });
      const writer = await start(action, directory);
      const message = once(writer.child, 'message');
      writer.child.send('go');
      await message;
      writer.child.kill('SIGKILL');
      await writer.exited;
      const expected =
        action === 'crash-before-rename'
          ? [event('initial')]
          : [event('initial'), event('crash-batch-1'), event('crash-batch-2')];
      const restarted = createFileExecutionJournalStore({ directory });
      expect(restarted.read(JOURNAL)).toEqual(expected);
      expect(restarted.list()).toEqual([JOURNAL]);
      expect(restarted.append({ events: [event('recovered')] }).total).toBe(expected.length + 1);
      expect(restarted.read(JOURNAL)).toEqual([...expected, event('recovered')]);
    },
  );

  it('retains every acknowledged append through restart (four processes, 400 events)', async () => {
    const directory = fresh();
    const outcomes = await runWorkers('append', directory, 100);
    expect(outcomes.every((outcome) => !outcome.error && outcome.results?.length === 100)).toBe(
      true,
    );
    const events = createFileExecutionJournalStore({ directory }).read(JOURNAL);
    expect(events).toHaveLength(400);
    expect(new Set(events.map((entry) => entry.eventId))).toEqual(
      new Set(
        Array.from({ length: 4 }, (_, worker) =>
          Array.from({ length: 100 }, (_, index) => `${worker}:${index}`),
        ).flat(),
      ),
    );
  }, 30_000);

  it('serializes the entire read/allocation/commit and handles concurrent retries/conflicts', async () => {
    const directory = fresh();
    const allocated = await runWorkers('allocate', directory, 25);
    expect(allocated.every((outcome) => !outcome.error)).toBe(true);
    expect(
      createFileExecutionJournalStore({ directory })
        .read(JOURNAL)
        .map((entry) => entry.eventId),
    ).toEqual(Array.from({ length: 100 }, (_, index) => `allocated:${index}`));
    const retries = await runWorkers('duplicate', fresh());
    expect(retries.every((outcome) => !outcome.error)).toBe(true);
    expect(retries.reduce((sum, outcome) => sum + outcome.results![0]!.appended!, 0)).toBe(1);
    const conflictDirectory = fresh();
    const conflicts = await runWorkers('conflict', conflictDirectory);
    expect(
      conflicts.filter((outcome) => outcome.error?.code === ErrorCode.TradeIdempotencyConflict),
    ).toHaveLength(2);
    expect(conflicts.filter((outcome) => !outcome.error)).toHaveLength(2);
    expect(
      createFileExecutionJournalStore({ directory: conflictDirectory }).read(JOURNAL),
    ).toHaveLength(1);
  }, 30_000);

  it('recovers a killed owner without committing its callback and retains an acknowledged commit after death', async () => {
    const directory = fresh();
    const store = createFileExecutionJournalStore({ directory });
    store.append({ events: [event('initial')] });
    const held = await start('hold', directory);
    const message = once(held.child, 'message');
    held.child.send('go');
    expect(await message).toEqual(['held', undefined]);
    expect(store.read(JOURNAL)).toEqual([event('initial')]);
    held.child.kill('SIGKILL');
    await held.exited;
    // Race multiple recovering writers against the abandoned owner register.
    expect((await runWorkers('allocate', directory, 5)).every((outcome) => !outcome.error)).toBe(
      true,
    );
    const committed = await start('commit-and-die', directory);
    const acknowledged = once(committed.child, 'message');
    committed.child.send('go');
    await acknowledged;
    committed.child.kill('SIGKILL');
    await committed.exited;
    writeFileSync(`${journalPath(directory)}.orphan.tmp`, '{partial');
    const restarted = createFileExecutionJournalStore({ directory });
    expect(restarted.read(JOURNAL)).toHaveLength(22);
    expect(restarted.read(JOURNAL)[0]).toEqual(event('initial'));
    expect(restarted.read(JOURNAL).at(-1)).toEqual(event('acknowledged'));
    expect(restarted.list()).toEqual([JOURNAL]);
  }, 30_000);

  it('bounds a live-owner wait and never steals its lock, while other journals remain writable', async () => {
    const directory = fresh();
    const store = createFileExecutionJournalStore({ directory });
    store.append({ events: [event('initial')] });
    const held = await start('hold', directory);
    const message = once(held.child, 'message');
    held.child.send('go');
    await message;
    expect(store.append({ events: [event('independent', 'another:journal')] }).appended).toBe(1);
    const began = performance.now();
    expect(() => store.append({ events: [event('blocked')] })).toThrowError(
      expect.objectContaining({ code: ErrorCode.OperationDeadlineExceeded }),
    );
    expect(performance.now() - began).toBeLessThan(8_000);
    expect(store.read(JOURNAL)).toEqual([event('initial')]);
  }, 15_000);

  it('serializes both indexes, preserves every handle/value and first-put metadata', async () => {
    const directory = fresh();
    expect((await runWorkers('indexes', directory, 30)).every((outcome) => !outcome.error)).toBe(
      true,
    );
    const artifacts = createFileArtifactStore({ directory });
    const authorizations = createFileAuthorizationStore({ directory });
    expect(artifacts.list()).toHaveLength(120);
    expect(authorizations.list()).toHaveLength(120);
    for (let worker = 0; worker < 4; worker += 1)
      for (let index = 0; index < 30; index += 1) {
        const id = `${worker}:${index}`;
        const handle = artifacts.put({
          kind: 'report',
          value: { id },
          createdTimestampMs: CREATED,
        });
        expect(artifacts.get(handle.uri)?.value).toEqual({ id });
        expect(authorizations.get(grant(id).contentHash)?.grant).toEqual(grant(id));
      }
    const retries = await runWorkers('index-retry', directory);
    expect(retries.every((outcome) => !outcome.error)).toBe(true);
    expect(new Set(retries.map((outcome) => outcome.results![0]!.createdTimestampMs)).size).toBe(1);
    expect(new Set(retries.map((outcome) => outcome.results![1]!.createdTimestampMs)).size).toBe(1);
  }, 30_000);

  it('serializes job creation, disjoint patches, and competing terminal transitions', async () => {
    const directory = fresh();
    const created = await runWorkers('job-create', directory);
    expect(created.filter((outcome) => !outcome.error)).toHaveLength(1);
    expect(
      created.filter((outcome) => outcome.error?.code === ErrorCode.InputWrongShape),
    ).toHaveLength(3);
    expect((await runWorkers('job-update', directory, 40)).every((outcome) => !outcome.error)).toBe(
      true,
    );
    const store = createFileJobStore({ directory });
    expect(store.get('job-1')).toEqual({
      ...job(),
      seed: 39,
      progress: { stage: 'working', fraction: 39 / 40 },
      usage: { elapsedMs: 39 },
      inputsHash: 'input:39',
    });
    const terminal = await runWorkers('job-terminal', directory);
    expect(terminal.filter((outcome) => !outcome.error)).toHaveLength(1);
    expect(
      terminal.filter((outcome) => outcome.error?.code === ErrorCode.InputWrongShape),
    ).toHaveLength(3);
    expect(['completed', 'cancelled']).toContain(store.get('job-1')?.state);
  }, 30_000);
});
