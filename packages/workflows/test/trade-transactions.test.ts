/** R06/R07/R08 integration: independently booted registry callers sharing actual file stores.
 * All approvals go through trade.authorize in the parent; workers have trade:paper only.
 * An IPC readiness barrier releases competing processes together, without timing sleeps or
 * substituting a fake transact implementation. Every successful economic event is folded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  portfolioSnapshot,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';
import {
  applyJournalEvents,
  type AuthorizationGrant,
  type ExecutionPlan,
  type PreflightReport,
  type TradeIntentOrder,
} from '@totalfinance/portfolio/trade';
import { createOperationRegistry, tradePack } from '@totalfinance/workflows';
import {
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
} from '@totalfinance/workflows/local';
import type {
  TradeSubmission,
  TradeWorkerMessage,
  TradeWorkerOutcome,
} from './fixtures/trade-operation-worker.js';

const NOW = Date.UTC(2026, 8, 7, 14);
const DAY = 86_400_000;
const INITIAL_CASH = 10_000;
const SOURCE = 'paper:process-integration';
const JOURNAL = `${SOURCE}:journal`;
const CREATED = Date.parse('2026-09-07T14:00:00Z');
const directories: string[] = [];
const children = new Set<ChildProcess>();
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fresh = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'totalfinance-trade-operations-'));
  directories.push(directory);
  return directory;
};
const deposit: PortfolioEventEnvelope = {
  eventId: 'opening-cash',
  schemaVersion: 1,
  eventType: 'cash.deposit',
  sourceId: 'fixture-funding',
  accountId: 'main',
  effectiveTimestampMs: NOW - 1_000,
  recordedTimestampMs: NOW - 1_000,
  event: { eventType: 'cash.deposit', amount: INITIAL_CASH, currency: 'USD' },
  provenance: {},
};
const openingLedger = () => createPortfolioLedger({ baseCurrency: 'USD', events: [deposit] });
const market = (price = 100, asOf = NOW) =>
  createMarketSnapshot({ asOf, observations: { spots: { AAA: { price, currency: 'USD' } } } });
const observations = (
  price: number,
  timestampMs: number,
): NonNullable<TradeSubmission['observations']> => ({
  AAA: {
    kind: 'bar',
    bar: {
      symbol: 'AAA',
      timestampMs,
      open: price,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 10_000,
    },
  },
});
let workerPath: string;

beforeAll(async () => {
  workerPath = join(fresh(), 'trade-operation-worker.mjs');
  // Bundle workspace SOURCE once; workers cannot accidentally exercise stale dist artifacts.
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/trade-operation-worker.ts', import.meta.url))],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    logLevel: 'silent',
  });
}, 30_000);

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }),
  );
  children.clear();
});
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function startWorker(directory: string) {
  const child = spawn(process.execPath, [workerPath, directory], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.add(child);
  let stderr = '';
  let outcome: TradeWorkerOutcome | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveFinished!: (result: TradeWorkerOutcome) => void;
  let rejectFinished!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finished = new Promise<TradeWorkerOutcome>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // Startup failure rejects both phases; the final phase is awaited after the readiness barrier.
  void finished.catch(() => {});
  const fail = (error: Error): void => {
    clearTimeout(timer);
    rejectReady(error);
    rejectFinished(error);
  };
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    fail(new Error(`trade worker timed out: ${stderr}`));
  }, 30_000);
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('message', (message: TradeWorkerMessage) => {
    if (message.kind === 'ready') resolveReady();
    else outcome = message;
  });
  child.once('error', fail);
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    children.delete(child);
    if (code !== 0 || outcome === undefined) {
      fail(new Error(`trade worker exited (${String(code)}, ${String(signal)}): ${stderr}`));
    } else resolveFinished(outcome);
  });
  return { child, ready, finished, fail };
}

async function runProcesses(
  directory: string,
  inputs: TradeSubmission[],
): Promise<TradeWorkerOutcome[]> {
  const workers = inputs.map(() => startWorker(directory));
  await Promise.all(workers.map(({ ready }) => ready));
  workers.forEach(({ child, fail }, index) => {
    child.send(wire(inputs[index]!), (error) => {
      if (error) fail(error);
    });
  });
  const results = await Promise.all(workers.map(({ finished }) => finished));
  expect(new Set(results.map(({ pid }) => pid)).size).toBe(inputs.length);
  expect(results.every(({ pid }) => pid !== process.pid)).toBe(true);
  return results;
}

type Completed = Extract<TradeWorkerOutcome, { kind: 'completed' }>;
function completed(outcome: TradeWorkerOutcome): Completed {
  if (outcome.kind !== 'completed')
    throw new Error(`unexpected refusal: ${outcome.error.code}: ${outcome.error.message}`);
  return outcome;
}

/** The only authority creation in this test: the parent's approve-capable registry operation. */
function approve(
  directory: string,
  quantity: number,
  key: string,
  type: 'market' | 'limit' = 'market',
): TradeSubmission {
  const registry = createOperationRegistry({ packs: [tradePack()] });
  const authorization = createFileAuthorizationStore({ directory });
  const order: TradeIntentOrder = {
    instrumentId: 'AAA',
    side: 'buy',
    quantity,
    type,
    timeInForce: 'gtc',
    ...(type === 'limit' ? { limitPrice: 90 } : {}),
  };
  const preflight = registry.run({
    id: 'totalfinance.trade.preflight',
    input: {
      intent: {
        kind: 'totalfinance.trade-intent',
        schemaVersion: 1,
        accountId: 'main',
        asOf: NOW,
        orders: [order],
      },
      portfolio: wire(openingLedger().toJSON()),
      market: wire(market()),
      asOf: NOW,
      policy: { mode: 'paper', marketMaximumAgeMs: DAY },
    },
  }).structured as unknown as PreflightReport & { plan: ExecutionPlan };
  expect(preflight.decision.verdict).toBe('allow');
  const { plan, ...report } = preflight;
  const grant = registry.run({
    id: 'totalfinance.trade.authorize',
    input: {
      plan,
      preflight: report,
      approvedBy: 'trade-transactions-parent',
      now: NOW,
      expiresAt: NOW + DAY,
      marketMaximumAgeMs: DAY,
      variance: { maximumQuantityRatio: 0, maximumNotionalRatio: 0, maximumSlippageBps: 2_000 },
      idempotencyKeys: [key],
      createdTimestampMs: CREATED,
    },
    stores: { authorization },
    capabilities: ['trade:approve'],
  }).structured['grant'] as AuthorizationGrant;
  expect(createFileAuthorizationStore({ directory }).get(grant.contentHash)?.grant).toEqual(grant);
  return {
    plan,
    grantHash: grant.contentHash,
    idempotencyKey: key,
    now: NOW + 1_000,
    portfolioHash: report.portfolioHash,
    marketHash: report.marketHash,
    marketAsOf: report.marketAsOf,
    sourceId: SOURCE,
    accountId: 'main',
    baseCurrency: 'USD',
    instruments: { AAA: { currency: 'USD' } },
    observations: observations(100, NOW + 60_000),
    asOf: NOW + 60_000,
  };
}

/** Independent economics plus bidirectional linkage between replies, durable facts and the ledger. */
function assertEconomicFacts(
  directory: string,
  replies: Completed[],
  quantity: number,
  price: number,
) {
  const events = replies.flatMap(({ result }) => result.events);
  const fills = replies.flatMap(({ result }) => result.fills);
  const journal = createFileExecutionJournalStore({ directory }).read(JOURNAL);
  const filled = journal.filter((event) => event.eventType === 'filled');
  expect(new Set(journal.map((event) => event.eventId)).size).toBe(journal.length);
  expect(new Set(fills.map((fill) => fill.fillId)).size).toBe(fills.length);
  expect(new Set(events.map((event) => `${event.sourceId}:${event.eventId}`)).size).toBe(
    events.length,
  );
  expect(journal.every((event) => event.journalId === JOURNAL && event.sourceId === SOURCE)).toBe(
    true,
  );
  expect(
    filled.map((event) => event.detail.fill).sort((a, b) => a!.fillId.localeCompare(b!.fillId)),
  ).toEqual([...fills].sort((a, b) => a.fillId.localeCompare(b.fillId)));
  expect(events.map((event) => event.eventId).sort()).toEqual(
    fills.map((fill) => fill.fillId).sort(),
  );
  expect(
    events.every((event) => event.eventType === 'trade.fill' && event.sourceId === SOURCE),
  ).toBe(true);
  expect(fills.reduce((sum, fill) => sum + fill.quantity, 0)).toBe(quantity);
  for (const { result, committed } of replies) {
    expect(result.receipt.sourceId).toBe(SOURCE);
    expect(result.receipt.accountId).toBe('main');
    expect(
      result.receipt.journalEventIds.every((id) => committed.some((event) => event.eventId === id)),
    ).toBe(true);
    for (const fill of result.fills) {
      expect(fill.pricePerUnit).toBe(price);
      expect(committed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'filled',
            detail: expect.objectContaining({ fillId: fill.fillId, fill }),
          }),
        ]),
      );
    }
  }
  for (const event of journal.filter((event) => event.eventType === 'submitted')) {
    expect(event.detail.order?.orderId).toBe(event.orderId);
    expect(event.detail.order?.quantity).toBe(event.detail.quantity);
    expect(event.detail.accountId).toBe('main');
    expect(event.detail.baseCurrency).toBe('USD');
    expect(event.detail.instrument).toMatchObject({ currency: 'USD' });
    expect(event.detail.executionPolicyHash).toMatch(/^sha256:/);
  }
  const states = Object.values(applyJournalEvents({ events: journal }).state.orders);
  expect(
    states.every(
      (order) => order.state === 'filled' && order.terminal && order.remainingQuantity === 0,
    ),
  ).toBe(true);
  expect(states.reduce((sum, order) => sum + order.filledQuantity, 0)).toBe(quantity);

  // Expected figures come from fixture economics, not the broker's reported cash or event count.
  const state = applyPortfolioEvents({ previousState: openingLedger().state, events });
  const account = state.accounts['main']!;
  expect(account.cashBalances['USD']!.totalAmount).toBe(INITIAL_CASH - quantity * price);
  expect(account.positions['AAA']!.quantity).toBe(quantity);
  expect(
    account.positions['AAA']!.lots.reduce(
      (sum, lot) => sum + lot.quantity * lot.costBasisPerUnit,
      0,
    ),
  ).toBe(quantity * price);
  const asOf = NOW + 180_000;
  expect(
    portfolioSnapshot({ portfolio: state, market: market(price, asOf), asOf }).netAssetValue,
  ).toBe(INITIAL_CASH);
  // Re-open from disk; no success can live only in a worker's in-memory broker/store instance.
  expect(createFileExecutionJournalStore({ directory }).read(JOURNAL)).toEqual(journal);
  return journal;
}

describe('real multi-process trade journal transactions', () => {
  it('a grant racing across different source journals commits exactly one economic submission', async () => {
    const directory = fresh();
    const input = approve(directory, 10, 'single-authority');
    const outcomes = await runProcesses(directory, [
      input,
      { ...input, sourceId: 'paper:other-source' },
    ]);
    expect(outcomes.filter((outcome) => outcome.kind === 'completed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'refused')).toMatchObject([
      { error: { code: ErrorCode.TradeGrantConsumed } },
    ]);
    const store = createFileExecutionJournalStore({ directory });
    expect(store.list()).toHaveLength(1);
    expect(
      store.read(store.list()[0]!).filter((event) => event.eventType === 'filled'),
    ).toHaveLength(1);
  });

  it('concurrent distinct plans on one source allocate unique fill/event identities and book every buy', async () => {
    const directory = fresh();
    const requests = [2, 3, 4, 5].map((quantity, index) =>
      approve(directory, quantity, `distinct:${index}`),
    );
    expect(new Set(requests.map((input) => input.plan.contentHash)).size).toBe(4);
    const replies = (await runProcesses(directory, requests)).map(completed);
    expect(
      replies.every(
        ({ result }) => !result.retried && result.fills.length === 1 && result.open.length === 0,
      ),
    ).toBe(true);
    expect(new Set(replies.map(({ result }) => result.receipt.receiptId)).size).toBe(4);
    const journal = assertEconomicFacts(directory, replies, 14, 100);
    expect(journal).toHaveLength(12);
    expect(
      journal
        .filter((event) => event.eventType === 'submitted')
        .map((event) => event.planHash)
        .sort(),
    ).toEqual(requests.map((input) => input.plan.contentHash).sort());
    expect(createFileAuthorizationStore({ directory }).list()).toHaveLength(4);
  });

  it('concurrent identical retries produce one receipt and one economic fill, including a later process restart', async () => {
    const directory = fresh();
    const request = approve(directory, 7, 'same-key');
    const replies = (await runProcesses(directory, [request, request, request, request])).map(
      completed,
    );
    expect(replies.filter(({ result }) => !result.retried)).toHaveLength(1);
    expect(new Set(replies.map(({ result }) => result.receipt.contentHash)).size).toBe(1);
    expect(replies.map(({ result }) => result.journal.appended).sort()).toEqual([0, 0, 0, 3]);
    const restart = completed((await runProcesses(directory, [request]))[0]!);
    expect(restart.result).toMatchObject({
      retried: true,
      fills: [],
      events: [],
      open: [],
      journal: { appended: 0, total: 3 },
    });
    expect(assertEconomicFacts(directory, [...replies, restart], 7, 100)).toHaveLength(3);
  });

  it('racing different approved plans with the same key refuses the loser without any losing economic/journal facts', async () => {
    const directory = fresh();
    const requests = [approve(directory, 2, 'conflict'), approve(directory, 5, 'conflict')];
    const replies = await runProcesses(directory, requests);
    const winners = replies.filter((reply): reply is Completed => reply.kind === 'completed');
    const refusals = replies.filter((reply) => reply.kind === 'refused');
    expect(winners).toHaveLength(1);
    expect(refusals).toMatchObject([{ error: { code: ErrorCode.TradeIdempotencyConflict } }]);
    const winner = winners[0]!;
    const winnerInput = requests.find(
      (input) => input.plan.contentHash === winner.result.receipt.planHash,
    )!;
    const loserInput = requests.find(
      (input) => input.plan.contentHash !== winner.result.receipt.planHash,
    )!;
    const afterRestart = await runProcesses(directory, [winnerInput, loserInput]);
    expect(completed(afterRestart[0]!).result).toMatchObject({
      retried: true,
      fills: [],
      events: [],
    });
    expect(afterRestart[1]).toMatchObject({
      kind: 'refused',
      error: { code: ErrorCode.TradeIdempotencyConflict },
    });
    const journal = assertEconomicFacts(
      directory,
      [winner, completed(afterRestart[0]!)],
      winnerInput.plan.orders[0]!.quantity,
      100,
    );
    expect(journal).toHaveLength(3);
    expect(journal.every((event) => event.planHash === winnerInput.plan.contentHash)).toBe(true);
    expect(journal.some((event) => event.orderId === loserInput.plan.orders[0]!.orderId)).toBe(
      false,
    );
  });

  it('rehydrates an open limit without inline history, then concurrent later observations fill it exactly once', async () => {
    const directory = fresh();
    const request = approve(directory, 6, 'limit-restart', 'limit');
    const { observations: _observations, asOf: _asOf, ...withoutObservation } = request;
    const initial = completed((await runProcesses(directory, [withoutObservation]))[0]!);
    const orderId = request.plan.orders[0]!.orderId;
    expect(initial.result).toMatchObject({
      retried: false,
      fills: [],
      events: [],
      open: [orderId],
      journal: { appended: 2, total: 2 },
    });
    const unmatched = completed((await runProcesses(directory, [request]))[0]!);
    expect(unmatched.result).toMatchObject({
      retried: true,
      fills: [],
      events: [],
      open: [orderId],
      journal: { appended: 0, total: 2 },
    });
    const prior = createFileExecutionJournalStore({ directory }).read(JOURNAL);
    expect(prior.map((event) => event.eventType)).toEqual(['submitted', 'acknowledged']);
    expect(prior[0]!.detail.order).toMatchObject({
      type: 'limit',
      limitPrice: 90,
      quantity: 6,
      timeInForce: 'gtc',
    });
    expect(applyJournalEvents({ events: prior }).state.orders[orderId]).toMatchObject({
      state: 'acknowledged',
      remainingQuantity: 6,
      terminal: false,
    });

    const later = {
      ...request,
      now: NOW + 120_000,
      asOf: NOW + 120_000,
      observations: observations(90, NOW + 120_000),
    };
    const filled = (await runProcesses(directory, [later, later, later, later])).map(completed);
    expect(filled.every(({ result }) => result.retried && result.open.length === 0)).toBe(true);
    expect(filled.filter(({ result }) => result.fills.length === 1)).toHaveLength(1);
    expect(filled.map(({ result }) => result.journal.appended).sort()).toEqual([0, 0, 0, 1]);
    expect(
      filled.every(
        ({ result }) => result.receipt.contentHash === initial.result.receipt.contentHash,
      ),
    ).toBe(true);
    const replay = completed((await runProcesses(directory, [later]))[0]!);
    expect(replay.result).toMatchObject({
      fills: [],
      events: [],
      open: [],
      journal: { appended: 0, total: 3 },
    });
    const journal = assertEconomicFacts(directory, [initial, unmatched, ...filled, replay], 6, 90);
    expect(journal).toHaveLength(3);
    expect(journal[2]!.detail).toMatchObject({
      quantity: 6,
      pricePerUnit: 90,
      observationTimestampMs: NOW + 120_000,
    });
  });
});
