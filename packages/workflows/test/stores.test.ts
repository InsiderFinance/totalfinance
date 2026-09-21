/**
 * Stage 7A slice 3 — handles and the memory stores: uri grammar, closed doors, idempotent puts,
 * copies on the way out, and the job state machine.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, QuantError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  HANDLE_KINDS,
  JOB_STATES,
  applyJobPatch,
  createMemoryArtifactStore,
  createMemoryJobStore,
  handleUriOf,
  parseHandleUri,
  requireArtifactListFilter,
  requireArtifactPut,
  requireJobRecord,
  requireResourceHandle,
  type JobRecord,
} from '@totalfinance/workflows';

const codeOf = (thunk: () => unknown): string | undefined => {
  try {
    thunk();
    return undefined;
  } catch (error) {
    return error instanceof QuantError ? error.code : `not-a-QuantError: ${String(error)}`;
  }
};
const T_ISO = '2026-09-03T14:00:00Z';
const T = Date.parse(T_ISO);
const market = () =>
  JSON.parse(
    JSON.stringify(
      createMarketSnapshot({
        asOf: '2026-09-03T00:00:00Z',
        observations: { spots: { AAPL: { price: 200, currency: 'USD' } } },
      }),
    ),
  ) as Record<string, unknown>;

describe('the handle grammar', () => {
  it('mints and parses totalfinance://<namespace>/<id> for every kind, and refuses anything else', () => {
    for (const kind of Object.keys(HANDLE_KINDS) as (keyof typeof HANDLE_KINDS)[]) {
      const uri = handleUriOf(kind, 'sha256:abc');
      expect(uri).toBe(`totalfinance://${HANDLE_KINDS[kind].namespace}/sha256:abc`);
      expect(parseHandleUri(uri)).toEqual({ kind, id: 'sha256:abc' });
    }
    expect(codeOf(() => parseHandleUri('totalfinance://nope/x'))).toBe(ErrorCode.InputWrongShape);
    expect(codeOf(() => parseHandleUri('https://example.com'))).toBe(ErrorCode.InputWrongShape);
    expect(codeOf(() => parseHandleUri(null as never))).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => handleUriOf('nope' as never, 'x'))).toBe(ErrorCode.InputInvalidEnum);
    expect(codeOf(() => handleUriOf('report', 'has space'))).toBe(ErrorCode.InputWrongShape);
  });

  it('requireResourceHandle is a closed door whose kind must agree with the uri', () => {
    const handle = {
      uri: 'totalfinance://reports/sha256:abc',
      kind: 'report',
      schema: 'totalfinance.operation-result',
      version: '1',
      contentHash: 'sha256:abc',
      createdTimestampMs: T,
      expiresTimestampMs: null,
      provenance: {},
    };
    expect(() => requireResourceHandle('t', 'handle', handle)).not.toThrow();
    expect(codeOf(() => requireResourceHandle('t', 'handle', { ...handle, extra: 1 }))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => requireResourceHandle('t', 'handle', { ...handle, kind: 'market' }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(
      codeOf(() => requireResourceHandle('t', 'handle', { ...handle, createdTimestampMs: 1.5 })),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() => requireResourceHandle('t', 'handle', { ...handle, provenance: null })),
    ).toBe(ErrorCode.InputWrongType);
  });
});

describe('the memory artifact store', () => {
  it('put is idempotent by content, get returns a fresh copy, list filters by kind', () => {
    const store = createMemoryArtifactStore();
    const first = store.put({ value: market(), kind: 'market', createdTimestampMs: T });
    const again = store.put({
      value: market(),
      kind: 'market',
      createdTimestampMs: Date.parse('2027-01-01T00:00:00Z'),
    });
    expect(again).toEqual(first); // the first mint stands — idempotent by content
    expect(first.uri).toBe(`totalfinance://markets/${first.contentHash}`);
    expect(first.schema).toBe('totalfinance.market-snapshot');
    expect(first.version).toBe('1');
    const got = store.get(first.uri);
    expect(got?.handle).toEqual(first);
    expect(got?.value).toEqual(market());
    (got!.value as Record<string, unknown>)['asOf'] = 0; // a copy, never the stored tree
    expect(store.get(first.uri)?.value).toEqual(market());
    const report = store.put({
      value: { value: 1, rows: [1, 2] },
      kind: 'report',
      createdTimestampMs: T,
    });
    expect(report.schema).toBe('totalfinance.operation-result');
    expect(
      store
        .list()
        .map((h) => h.kind)
        .sort(),
    ).toEqual(['market', 'report']);
    expect(store.list({ kind: 'report' })).toEqual([report]);
    expect(store.get('totalfinance://reports/sha256:missing')).toBeNull();
  });

  it('refuses a wrong envelope kind, a job kind, a non-integer or string instant, an expiry before creation, and unknown keys', () => {
    const store = createMemoryArtifactStore();
    expect(
      codeOf(() => store.put({ value: market(), kind: 'scenario', createdTimestampMs: T })),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() => store.put({ value: {}, kind: 'job' as never, createdTimestampMs: T })),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(codeOf(() => store.put({ value: {}, kind: 'report', createdTimestampMs: 1.5 }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(
      codeOf(() =>
        store.put({ value: {}, kind: 'report', createdTimestampMs: '2026-09-03' } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        store.put({
          value: {},
          kind: 'report',
          createdTimestampMs: T,
          expiresTimestampMs: T - 3_600_000,
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        store.put({ value: {}, kind: 'report', createdTimestampMs: T, extra: 1 } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() => store.put({ value: null, kind: 'report', createdTimestampMs: T } as never)),
    ).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => store.list({ kind: 'nope' } as never))).toBe(ErrorCode.InputInvalidEnum);
    expect(codeOf(() => store.list({ extra: 1 } as never))).toBe(ErrorCode.InputUnknownField);
    expect(codeOf(() => store.get('' as never))).toBe(ErrorCode.InputWrongType);
    expect(requireArtifactListFilter('t', undefined)).toEqual({});
    expect(
      requireArtifactPut('t', { value: market(), kind: 'market', createdTimestampMs: T }).handle
        .kind,
    ).toBe('market');
  });
});

const job = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: 'job-1',
  operation: { id: 'totalfinance.backtest.options_run', version: '1' },
  state: 'accepted',
  progress: null,
  inputsHash: 'sha256:in',
  seed: null,
  submittedAt: T_ISO,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
  usage: { elapsedMs: null },
  ...overrides,
});

describe('the memory job store', () => {
  it('creates once, copies on the way out, and walks the state machine', () => {
    const store = createMemoryJobStore();
    const created = store.create(job());
    expect(created).toEqual(job());
    expect(codeOf(() => store.create(job()))).toBe(ErrorCode.InputWrongShape); // ids mint once
    const running = store.update('job-1', { state: 'running', startedAt: T_ISO });
    expect(running.state).toBe('running');
    expect(store.get('job-1')?.state).toBe('running');
    running.state = 'failed'; // a copy — the store is untouched
    expect(store.get('job-1')?.state).toBe('running');
    const done = store.update('job-1', {
      state: 'completed',
      finishedAt: T_ISO,
      usage: { elapsedMs: 12 },
      result: {
        uri: 'totalfinance://reports/sha256:out',
        kind: 'report',
        schema: 'totalfinance.operation-result',
        version: '1',
        contentHash: 'sha256:out',
        createdTimestampMs: T,
        expiresTimestampMs: null,
        provenance: {},
      },
    });
    expect(done.state).toBe('completed');
    expect(codeOf(() => store.update('job-1', { state: 'running' }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => store.update('job-1', { progress: { stage: 'x', fraction: 0.5 } }))).toBe(
      ErrorCode.InputWrongShape,
    ); // terminal records never change
    expect(codeOf(() => store.update('missing', { state: 'running' }))).toBe(
      ErrorCode.OperationHandleUnknown,
    );
    expect(store.list().map((record) => record.id)).toEqual(['job-1']);
    expect(JOB_STATES).toEqual([
      'accepted',
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('requireJobRecord and applyJobPatch are closed doors', () => {
    expect(codeOf(() => requireJobRecord('t', 'record', { ...job(), extra: 1 }))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => requireJobRecord('t', 'record', job({ state: 'done' as never })))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(
      codeOf(() => requireJobRecord('t', 'record', job({ progress: { stage: 'x', fraction: 2 } }))),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(codeOf(() => requireJobRecord('t', 'record', job({ seed: 1.5 })))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => requireJobRecord('t', 'record', job({ usage: { elapsedMs: -1 } })))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      codeOf(() => requireJobRecord('t', 'record', job({ error: { message: 'x' } as never }))),
    ).toBe(ErrorCode.InputWrongShape);
    expect(codeOf(() => applyJobPatch('t', job(), { id: 'other' }))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => applyJobPatch('t', job(), { state: 'completed' }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(applyJobPatch('t', job(), { state: 'queued' }).state).toBe('queued');
    expect(
      codeOf(() => applyJobPatch('t', { ...job(), state: 'nope' } as never, { state: 'queued' })),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(codeOf(() => applyJobPatch('t', null as never, { state: 'queued' }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => applyJobPatch('' as never, job(), { state: 'queued' }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => requireJobRecord(undefined as never, 'record', job()))).toBe(
      ErrorCode.InputWrongType,
    );
  });
});
