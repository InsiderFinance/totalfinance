/**
 * Stage 7A slice 3 — the worker-terminated job runner: a job-class operation completes with a
 * report handle; a cancelled job ACTUALLY stops (the worker is terminated, no result appears); an
 * external cancel through the shared store stops it too; a non-job operation runs inline.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  QuantError,
  resolvedExpiry,
  usEquitySessionInstant,
  optionExpiryToMs,
} from '@totalfinance/core';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  cancelJob,
  createFileArtifactStore,
  createFileJobStore,
  packsForProfile,
  registryForProfile,
  submitJob,
  createLocalJobRunner,
} from '@totalfinance/cli';

const codeOf = (thunk: () => unknown): string | undefined => {
  try {
    thunk();
    return undefined;
  } catch (error) {
    return error instanceof QuantError ? error.code : `not-a-QuantError: ${String(error)}`;
  }
};
const clock = () => new Date().toISOString();
const fresh = () => mkdtempSync(join(tmpdir(), 'totalfinance-jobs-'));

const T0 = Date.UTC(2026, 0, 5);
const DAY_MS = 86_400_000;
const isoDay = (offsetDays: number): string =>
  new Date(T0 + offsetDays * DAY_MS).toISOString().slice(0, 10);
function chainSnapshot(dayOffset: number, spot: number, expiries: readonly string[]) {
  const date = isoDay(dayOffset);
  // An end-of-day chain is observed at the close (a valuation instant, never a bare date).
  const ts = usEquitySessionInstant(date, 'close');
  const quotes = [];
  for (const expiry of expiries) {
    const t = (optionExpiryToMs(expiry) - ts) / (DAY_MS * 365);
    for (let strike = 80; strike <= 120; strike += 5) {
      for (const type of ['call', 'put'] as const) {
        const pricing = {
          type,
          spot,
          strike,
          timeToExpiryYears: t,
          riskFreeRate: 0.04,
          dividendYield: 0,
          volatility: 0.2,
        };
        quotes.push({
          contract: {
            underlying: 'XYZ',
            type,
            style: 'european',
            strike,
            expiry,
            ...resolvedExpiry(expiry),
            multiplier: 100,
          },
          timestampMs: ts,
          mid: blackScholesPrice(pricing),
          impliedVolatility: 0.2,
          greeks: { delta: blackScholesGreeks(pricing).delta },
          underlyingPrice: spot,
        });
      }
    }
  }
  return { asOf: ts, underlyingPrice: spot, quotes };
}
/**
 * `weeks` weekly snapshots over a fixed expiry ladder (every 8 weeks): each snapshot lists the
 * ladder expiries 1–70 days out, so an entered contract stays quoted until it is closed or expires.
 */
const backtestInput = (weeks: number) => {
  const ladder = Array.from({ length: Math.ceil(weeks / 8) + 2 }, (_, index) => (index + 1) * 56);
  return {
    riskFreeRate: 0.04,
    chains: Array.from({ length: weeks }, (_, index) => {
      const day = index * 7;
      const listed = ladder.filter((e) => e > day && e <= day + 70).map(isoDay);
      return chainSnapshot(day, 100 + (index % 5), listed);
    }),
    entry: {
      daysToExpiry: { target: 45, min: 30, max: 60 },
      structure: 'bullPutSpread',
      select: { shortDelta: 0.3, width: 5 },
    },
    exit: { profitTarget: 0.5, daysToExpiry: 21 },
  };
};

const setup = () => {
  const directory = fresh();
  return {
    directory,
    registry: registryForProfile({ profile: 'full' }),
    jobs: createFileJobStore({ directory }),
    artifacts: createFileArtifactStore({ directory }),
  };
};

describe('profiles', () => {
  it('select exact pack sets; full is everything; unknown profiles and packs are refused', () => {
    expect(packsForProfile('default').map((p) => p.name)).toHaveLength(10);
    expect(packsForProfile('options').map((p) => p.name)).toEqual(['options', 'volatility']);
    expect(packsForProfile('research').map((p) => p.name)).toEqual(['research']);
    // 16 → 17 (Stage 7B.2 slice 4, 2026-09-06): the trade pack joins the full profile.
    expect(packsForProfile('full').map((p) => p.name)).toHaveLength(17);
    // 40 → 46 (Stage 7B.2 slice 4, 2026-09-06): the six trade-lifecycle operations join the full profile.
    expect(registryForProfile({ profile: 'full' }).size).toBe(46);
    expect(registryForProfile({ profile: 'full', packs: ['options', 'artifact'] }).size).toBe(5);
    expect(codeOf(() => packsForProfile('nope' as never))).toBe(ErrorCode.InputInvalidEnum);
    expect(codeOf(() => registryForProfile({ profile: 'default', packs: ['artifact'] }))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(codeOf(() => registryForProfile({ profile: 'default', extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
  });
});

describe('createLocalJobRunner closes its door', () => {
  it('refuses unknown keys, a relative directory, a bad profile, a missing clock, and a bad poll interval', () => {
    const { directory, registry } = setup();
    const clockFn = () => new Date().toISOString();
    expect(
      codeOf(() =>
        createLocalJobRunner({
          registry,
          directory,
          profile: 'full',
          clock: clockFn,
          extra: 1,
        } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() =>
        createLocalJobRunner({ registry, directory: 'relative', profile: 'full', clock: clockFn }),
      ),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() =>
        createLocalJobRunner({ registry, directory, profile: 'nope', clock: clockFn } as never),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() => createLocalJobRunner({ registry, directory, profile: 'full' } as never)),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        createLocalJobRunner({ registry, directory, profile: 'full', clock: clockFn, pollMs: 0 }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        createLocalJobRunner({
          registry: { ...registry, size: -1 },
          directory,
          profile: 'full',
          clock: clockFn,
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    const runner = createLocalJobRunner({ registry, directory, profile: 'full', clock: clockFn });
    expect(runner.list()).toEqual([]);
    expect(runner.get('missing')).toBeNull();
  });
});

describe('the job runner', () => {
  it('runs a job-class operation in a worker and completes with a report handle another process can read', async () => {
    const { directory, registry, jobs, artifacts } = setup();
    const run = submitJob({
      registry,
      jobs,
      artifacts,
      directory,
      id: 'totalfinance.backtest.options_run',
      input: backtestInput(8),
      profile: 'full',
      clock,
    });
    expect(run.record.state).toBe('running');
    const done = await run.completion;
    expect(done.state).toBe('completed');
    expect(done.result?.kind).toBe('report');
    expect(done.usage.elapsedMs).toBeGreaterThan(0);
    const other = createFileArtifactStore({ directory });
    const stored = other.get(done.result!.uri)!.value as {
      operation: { id: string };
      structured: { trades: unknown[] };
    };
    expect(stored.operation.id).toBe('totalfinance.backtest.options_run');
    expect(stored.structured.trades.length).toBeGreaterThan(0);
    expect(createFileJobStore({ directory }).get(done.id)?.state).toBe('completed');
  }, 60_000);

  it('cancel terminates the worker: the record is cancelled, no result ever appears', async () => {
    const { directory, registry, jobs, artifacts } = setup();
    const run = submitJob({
      registry,
      jobs,
      artifacts,
      directory,
      id: 'totalfinance.backtest.options_run',
      input: backtestInput(2_000),
      profile: 'full',
      clock,
      jobId: 'long-1',
    });
    const cancelled = await run.cancel();
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.result).toBeNull();
    expect((await run.completion).state).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(artifacts.list({ kind: 'report' })).toEqual([]);
    expect(jobs.get('long-1')?.state).toBe('cancelled');
    expect(await run.cancel()).toEqual(jobs.get('long-1')); // idempotent
  }, 60_000);

  it('an external cancel through the shared store stops the running job', async () => {
    const { directory, registry, jobs, artifacts } = setup();
    const run = submitJob({
      registry,
      jobs,
      artifacts,
      directory,
      id: 'totalfinance.backtest.options_run',
      input: backtestInput(2_000),
      profile: 'full',
      clock,
      jobId: 'long-2',
      pollMs: 25,
    });
    const elsewhere = createFileJobStore({ directory });
    const marked = cancelJob({ jobs: elsewhere, id: 'long-2', clock });
    expect(marked.state).toBe('cancelled');
    const done = await run.completion;
    expect(done.state).toBe('cancelled');
    expect(done.result).toBeNull();
    expect(cancelJob({ jobs: elsewhere, id: 'long-2', clock }).state).toBe('cancelled');
    expect(codeOf(() => cancelJob({ jobs: elsewhere, id: 'missing', clock }))).toBe(
      ErrorCode.OperationHandleUnknown,
    );
  }, 60_000);

  it('a non-job operation runs inline and is terminal on return; a refused input is a failed record', () => {
    const { directory, registry, jobs, artifacts } = setup();
    const price = {
      type: 'call',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    };
    const run = submitJob({
      registry,
      jobs,
      artifacts,
      directory,
      id: 'totalfinance.option.price',
      input: price,
      profile: 'full',
      clock,
    });
    expect(run.record.state).toBe('completed');
    expect(
      (artifacts.get(run.record.result!.uri)!.value as { structured: { value: number } }).structured
        .value,
    ).toBeGreaterThan(0);
    const failed = submitJob({
      registry,
      jobs,
      artifacts,
      directory,
      id: 'totalfinance.option.price',
      input: { ...price, spot: -1 },
      profile: 'full',
      clock,
    });
    expect(failed.record.state).toBe('failed');
    expect(failed.record.error?.code).toMatch(/^input\./);
    expect(
      codeOf(() =>
        submitJob({
          registry,
          jobs,
          artifacts,
          directory,
          id: 'totalfinance.nope.x',
          input: {},
          profile: 'full',
          clock,
        }),
      ),
    ).toBe(ErrorCode.OperationUnknown);
    expect(
      codeOf(() =>
        submitJob({
          registry,
          jobs,
          artifacts,
          directory,
          id: 'totalfinance.option.price',
          input: price,
          profile: 'full',
          clock,
          extra: 1,
        } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() =>
        submitJob({
          registry,
          jobs,
          artifacts,
          directory,
          id: 'totalfinance.option.price',
          input: price,
          profile: 'full',
          clock,
          pollMs: 0,
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        submitJob({
          registry,
          jobs,
          artifacts,
          directory,
          id: 'totalfinance.option.price',
          input: null,
          profile: 'full',
          clock,
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        submitJob({
          registry,
          jobs,
          artifacts,
          directory,
          id: 'totalfinance.option.price',
          profile: 'full',
          clock,
        } as never),
      ),
    ).toBe(ErrorCode.InputMissingField);
    expect(
      codeOf(() =>
        submitJob({
          registry,
          jobs,
          artifacts,
          directory,
          id: 'totalfinance.option.price',
          input: price,
          profile: 'nope',
          clock,
        } as never),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        submitJob({
          registry,
          jobs: { ...jobs, list: null },
          artifacts,
          directory,
          id: 'totalfinance.option.price',
          input: price,
          profile: 'full',
          clock,
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        submitJob({
          registry: { ...registry, describe: undefined },
          jobs,
          artifacts,
          directory,
          id: 'totalfinance.option.price',
          input: price,
          profile: 'full',
          clock,
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        submitJob({
          registry: { ...registry, size: -1 },
          jobs,
          artifacts,
          directory,
          id: 'totalfinance.option.price',
          input: price,
          profile: 'full',
          clock,
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
  });
});
