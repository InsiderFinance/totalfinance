/**
 * Stage 7A slice 3 — the file-backed stores: two instances over one directory see the same data,
 * puts are idempotent by content, the index is a file, and the doors are closed.
 */

import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorCode, QuantError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { createFileArtifactStore, createFileJobStore } from '@totalfinance/cli';
import type { JobRecord } from '@totalfinance/workflows';

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
const fresh = () => mkdtempSync(join(tmpdir(), 'totalfinance-store-'));

describe('the file artifact store', () => {
  it('is shared by path, idempotent by content, indexed, and returns copies', () => {
    const directory = fresh();
    const writer = createFileArtifactStore({ directory });
    const reader = createFileArtifactStore({ directory });
    const handle = writer.put({ value: market(), kind: 'market', createdTimestampMs: T });
    expect(
      writer.put({
        value: market(),
        kind: 'market',
        createdTimestampMs: Date.parse('2027-01-01T00:00:00Z'),
      }),
    ).toEqual(handle);
    expect(existsSync(join(directory, 'artifacts', 'index.json'))).toBe(true);
    expect(
      readdirSync(join(directory, 'artifacts')).filter((n) => n !== 'index.json'),
    ).toHaveLength(1);
    const got = reader.get(handle.uri);
    expect(got?.handle).toEqual(handle);
    expect(got?.value).toEqual(market());
    expect(reader.list({ kind: 'market' })).toEqual([handle]);
    expect(reader.list({ kind: 'report' })).toEqual([]);
    expect(reader.get('totalfinance://reports/sha256:missing')).toBeNull();
    const report = writer.put({ value: { value: 1 }, kind: 'report', createdTimestampMs: T });
    expect(
      reader
        .list()
        .map((h) => h.kind)
        .sort(),
    ).toEqual(['market', 'report']);
    expect(reader.get(report.uri)?.value).toEqual({ value: 1 });
  });

  it('closes its doors: the directory is required, unknown keys refused, put/list validated like the memory store', () => {
    expect(codeOf(() => createFileArtifactStore({} as never))).toBe(ErrorCode.InputMissingField);
    expect(codeOf(() => createFileArtifactStore({ directory: fresh(), extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => createFileArtifactStore(null as never))).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => createFileArtifactStore({ directory: 'relative/store' }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => createFileJobStore({ directory: './store' }))).toBe(
      ErrorCode.InputWrongShape,
    );
    const store = createFileArtifactStore({ directory: fresh() });
    expect(
      codeOf(() => store.put({ value: market(), kind: 'scenario', createdTimestampMs: T })),
    ).toBe(ErrorCode.InputWrongShape);
    expect(codeOf(() => store.put({ value: {}, kind: 'report', createdTimestampMs: 1.5 }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => store.list({ kind: 'nope' } as never))).toBe(ErrorCode.InputInvalidEnum);
    expect(codeOf(() => store.get(1 as never))).toBe(ErrorCode.InputWrongType);
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

describe('the file job store', () => {
  it('is shared by path and walks the state machine across instances', () => {
    const directory = fresh();
    const a = createFileJobStore({ directory });
    const b = createFileJobStore({ directory });
    expect(a.create(job())).toEqual(job());
    expect(codeOf(() => b.create(job()))).toBe(ErrorCode.InputWrongShape);
    expect(b.update('job-1', { state: 'running', startedAt: T_ISO }).state).toBe('running');
    expect(a.get('job-1')?.state).toBe('running');
    expect(
      a.update('job-1', { state: 'cancelled', finishedAt: T_ISO, usage: { elapsedMs: 3 } }).state,
    ).toBe('cancelled');
    expect(codeOf(() => b.update('job-1', { state: 'running' }))).toBe(ErrorCode.InputWrongShape);
    expect(codeOf(() => b.update('missing', { state: 'running' }))).toBe(
      ErrorCode.OperationHandleUnknown,
    );
    expect(codeOf(() => b.get('../escape'))).toBe(ErrorCode.InputWrongShape);
    a.create(job({ id: 'job-0', submittedAt: '2026-09-03T13:00:00Z' }));
    expect(b.list().map((record) => record.id)).toEqual(['job-0', 'job-1']);
    expect(existsSync(join(directory, 'jobs', 'job-1.json'))).toBe(true);
  });
});
