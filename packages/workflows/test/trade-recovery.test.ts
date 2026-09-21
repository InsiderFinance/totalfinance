/** R06/R08: journal-derived accounting recovery after a committed submit loses its response. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { createPaperBroker } from '@totalfinance/backtest/paper';
import {
  createPortfolioLedger,
  readPortfolioLedgerSnapshot,
  type NormalizedFill,
  type PortfolioEventEnvelope,
  type PortfolioLedgerSnapshot,
} from '@totalfinance/portfolio';
import type {
  AuthorizationGrant,
  ExecutionPlan,
  PreflightReport,
} from '@totalfinance/portfolio/trade';
import {
  createMemoryExecutionJournalStore,
  createOperationRegistry,
  tradePack,
  type ExecutionJournalStore,
  type ResourceHandle,
} from '../src/index.js';
import {
  createFileArtifactStore,
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
} from '../src/local/index.js';
import type { TradeSubmitOutput } from '../src/trade-wire-schemas.js';
import type { TradeSubmission } from './fixtures/trade-operation-worker.js';

const NOW = Date.UTC(2026, 8, 7, 14);
const DAY = 86_400_000;
const CREATED = Date.parse('2026-09-07T14:00:00Z');
const SOURCE = 'paper:recovery';
const JOURNAL = `${SOURCE}:journal`;
const directories: string[] = [];
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const openingLedger = () =>
  createPortfolioLedger({
    baseCurrency: 'USD',
    events: [
      {
        eventId: 'deposit',
        schemaVersion: 1,
        sourceId: 'funding',
        accountId: 'main',
        effectiveTimestampMs: NOW - DAY,
        recordedTimestampMs: NOW - DAY,
        eventType: 'cash.deposit',
        event: { eventType: 'cash.deposit', amount: 10_000, currency: 'USD' },
        provenance: {},
      },
    ],
  });
const observation = (timestampMs = NOW + 60_000): NonNullable<TradeSubmission['observations']> => ({
  AAA: {
    kind: 'bar',
    bar: {
      symbol: 'AAA',
      timestampMs,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10_000,
    },
  },
});
const withoutObservation = ({
  observations: _observations,
  asOf: _asOf,
  ...input
}: TradeSubmission) => input;

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'totalfinance-trade-recovery-'));
  directories.push(directory);
  // Every call opens new stores and a new registry: no broker or response cache survives a call.
  const stores = () => ({
    authorization: createFileAuthorizationStore({ directory }),
    journal: createFileExecutionJournalStore({ directory }),
  });
  const artifacts = () => createFileArtifactStore({ directory });
  const registry = () => createOperationRegistry({ packs: [tradePack()] });
  const approve = (quantity = 10, key = 'recover:1'): TradeSubmission => {
    const { plan, ...preflight } = registry().run({
      id: 'totalfinance.trade.preflight',
      input: {
        intent: {
          kind: 'totalfinance.trade-intent',
          schemaVersion: 1,
          accountId: 'main',
          asOf: NOW,
          orders: [
            { instrumentId: 'AAA', side: 'buy', quantity, type: 'market', timeInForce: 'gtc' },
          ],
        },
        portfolio: wire(openingLedger().toJSON()),
        market: wire(
          createMarketSnapshot({
            asOf: NOW,
            observations: { spots: { AAA: { price: 100, currency: 'USD' } } },
          }),
        ),
        asOf: NOW,
        policy: { mode: 'paper', marketMaximumAgeMs: DAY },
      },
    }).structured as unknown as PreflightReport & { plan: ExecutionPlan };
    const grant = registry().run({
      id: 'totalfinance.trade.authorize',
      input: {
        plan,
        preflight,
        now: NOW,
        expiresAt: NOW + DAY,
        approvedBy: 'recovery-approver',
        marketMaximumAgeMs: DAY,
        variance: { maximumQuantityRatio: 0, maximumNotionalRatio: 0, maximumSlippageBps: 1000 },
        idempotencyKeys: [key],
        createdTimestampMs: CREATED,
      },
      stores: stores(),
      capabilities: ['trade:approve'],
    }).structured['grant'] as AuthorizationGrant;
    return {
      plan,
      grantHash: grant.contentHash,
      idempotencyKey: key,
      now: NOW + 1000,
      portfolioHash: preflight.portfolioHash,
      marketHash: preflight.marketHash,
      marketAsOf: preflight.marketAsOf,
      sourceId: SOURCE,
      accountId: 'main',
      baseCurrency: 'USD',
      instruments: { AAA: { currency: 'USD', settlementLag: 2 } },
      observations: observation(),
      asOf: NOW + 60_000,
    };
  };
  const submit = (input: TradeSubmission, journal?: ExecutionJournalStore) =>
    registry().run({
      id: 'totalfinance.trade.submit',
      input: wire(input),
      stores: { ...stores(), ...(journal === undefined ? {} : { journal }) },
      capabilities: ['trade:paper'],
    }).structured as unknown as TradeSubmitOutput;
  const record = (portfolio: PortfolioLedgerSnapshot | string, events: PortfolioEventEnvelope[]) =>
    registry().run({
      id: 'totalfinance.portfolio.record_events',
      input: wire({ portfolio, events, createdTimestampMs: CREATED }),
      artifacts: artifacts(),
      createdTimestampMs: CREATED,
      capabilities: ['portfolio:write'],
    }).structured['handle'] as ResourceHandle;
  const recordedState = (handle: ResourceHandle) =>
    readPortfolioLedgerSnapshot({
      snapshot: artifacts().get(handle.uri)!.value as unknown as PortfolioLedgerSnapshot,
    }).ledger.state;
  return { approve, submit, record, recordedState, stores, registry };
}

describe('trade.submit receipt-scoped recovery', () => {
  it('recovers a committed lost response and records the recovered events repeatedly without duplicate economics', () => {
    const { approve, submit, record, recordedState, stores } = setup();
    const input = approve();
    const journal = stores().journal;
    let lostResponse: unknown;
    const failedResponse: ExecutionJournalStore = {
      ...journal,
      transact(request) {
        lostResponse = journal.transact(request);
        throw new Error('simulated crash after commit, before response');
      },
    };
    expect(() => submit(input, failedResponse)).toThrow(
      'simulated crash after commit, before response',
    );
    expect(stores().journal.read(JOURNAL)).toHaveLength(3);
    const first = (lostResponse as { structured: TradeSubmitOutput }).structured;
    const retry = submit(input);
    expect(retry).toMatchObject({
      retried: true,
      fills: [],
      events: [],
      journal: { appended: 0, total: 3 },
    });
    expect(retry.receipt).toEqual(first.receipt);
    expect(retry.receipt.fills).toEqual([]);
    expect(retry.recovery).toEqual(first.recovery);
    expect(retry.recovery).toEqual({ fills: first.fills, events: first.events });
    expect(retry.recovery.fills).toMatchObject([
      { quantity: 10, pricePerUnit: 100, accountId: 'main' },
    ]);
    const recorded = record(openingLedger().toJSON(), retry.recovery.events);
    const repeated = record(recorded.uri, retry.recovery.events);
    expect(repeated.uri).toBe(recorded.uri);
    const doubledBatch = record(openingLedger().toJSON(), [
      ...retry.recovery.events,
      ...retry.recovery.events,
    ]);
    expect(doubledBatch.uri).toBe(recorded.uri);
    const account = recordedState(repeated).accounts['main']!;
    expect(account.positions['AAA']!.quantity).toBe(10);
    expect(account.cashBalances['USD']!.totalAmount).toBe(9000);
  });

  it('includes new fills on first success and publishes required, closed recovery output grammar', () => {
    const { approve, submit, registry } = setup();
    const input = approve();
    const result = submit(input);
    expect(result.retried).toBe(false);
    expect(result.recovery).toEqual({ fills: result.fills, events: result.events });
    const validate = new AjvJsonSchemaValidator().getValidator(
      registry().require('totalfinance.trade.submit').outputSchema!,
    );
    expect(validate(wire(result)).valid).toBe(true);
    const { recovery, ...missing } = result;
    expect(validate(wire(missing)).valid).toBe(false);
    expect(validate(wire({ ...result, recovery: { ...recovery, untrusted: true } })).valid).toBe(
      false,
    );
    expect(validate(wire({ ...result, recovery: { ...recovery, fills: [{}] } })).valid).toBe(false);
    const retry = submit({ ...withoutObservation(input), now: NOW + DAY * 2 });
    expect(retry.receipt).toEqual(result.receipt);
    expect(retry.recovery).toEqual(result.recovery);
    expect(retry.fills).toEqual([]);
    expect(retry.events).toEqual([]);
  });

  it('excludes other plans even when this submit also advances their open orders; sources remain isolated', () => {
    const { approve, submit } = setup();
    const a = approve(10, 'plan:a');
    const b = approve(3, 'plan:b');
    const initial = submit(withoutObservation(a));
    expect(initial.recovery).toEqual({ fills: [], events: [] });
    const second = submit(b);
    expect(second.fills).toHaveLength(2); // Delta semantics still include every order stepped this call.
    expect(second.recovery.fills).toMatchObject([
      { orderId: b.plan.orders[0]!.orderId, quantity: 3 },
    ]);
    expect(
      second.recovery.events.every((event) => event.correlationId === b.plan.orders[0]!.orderId),
    ).toBe(true);
    const retry = submit(withoutObservation(a));
    expect(retry.fills).toEqual([]);
    expect(retry.recovery.fills).toMatchObject([
      { orderId: a.plan.orders[0]!.orderId, quantity: 10 },
    ]);
    expect(retry.receipt).toEqual(initial.receipt);
    // B6: a consumed grant licenses nothing but its own retry — another source needs its own grant.
    const c = approve(10, 'plan:c');
    const otherSource = submit({ ...c, sourceId: 'paper:independent' });
    expect(otherSource.retried).toBe(false);
    expect(otherSource.recovery.fills).toHaveLength(1);
    expect(
      otherSource.recovery.events.every((event) => event.sourceId === 'paper:independent'),
    ).toBe(true);
    expect(submit(a).recovery).toEqual(retry.recovery);
  });

  it('retains exact delivered partial-fill costs and settlement facts, then grows recovery when a later observation fills the remainder', () => {
    const { approve, submit, stores, record, recordedState } = setup();
    const input = approve();
    const initial = submit(withoutObservation(input));
    const prior = stores().journal.read(JOURNAL);
    // The wire uses full-fill simplified bars. Seed a real delivered partial via the supported
    // broker path, not a different execution policy or incomplete handwritten submission history.
    const broker = createPaperBroker({
      sourceId: SOURCE,
      accountId: 'main',
      baseCurrency: 'USD',
      instruments: input.instruments!,
      journal: prior,
    });
    const fill: NormalizedFill = {
      fillId: 'venue:partial:1',
      orderId: input.plan.orders[0]!.orderId,
      accountId: 'main',
      instrumentId: 'AAA',
      side: 'buy',
      quantity: 4,
      pricePerUnit: 95,
      currency: 'USD',
      filledTimestampMs: NOW + 60_000,
      settleTimestampMs: NOW + 60_000 + 2 * DAY,
      costs: { commission: 1.25, exchangeFees: 0.5 },
      venue: 'paper-venue',
      liquidity: 'maker',
    };
    const delivered = broker.deliver({
      event: {
        eventId: 'venue:event:1',
        journalId: JOURNAL,
        sourceId: SOURCE,
        orderId: fill.orderId!,
        planHash: input.plan.contentHash,
        timestampMs: fill.filledTimestampMs,
        eventType: 'partially-filled',
        detail: {
          fillId: fill.fillId,
          quantity: fill.quantity,
          pricePerUnit: fill.pricePerUnit,
          fill,
        },
        provenance: {},
      },
    });
    stores().journal.append({ events: broker.journal().slice(prior.length) });
    const partial = submit(withoutObservation(input));
    expect(partial).toMatchObject({ retried: true, fills: [], events: [] });
    expect(partial.recovery).toEqual({ fills: [fill], events: delivered.events });
    expect(partial.recovery.events).toHaveLength(3); // One fill, two actual cost charges.
    const recorded = record(openingLedger().toJSON(), partial.recovery.events);
    const completionInput = {
      ...input,
      now: NOW + 120_000,
      observations: observation(NOW + 120_000),
      asOf: NOW + 180_000,
    };
    const completed = submit(completionInput);
    expect(completed.fills).toMatchObject([{ quantity: 6, filledTimestampMs: NOW + 180_000 }]);
    expect(completed.recovery).toEqual({
      fills: [fill, ...completed.fills],
      events: [...delivered.events, ...completed.events],
    });
    expect(completed.receipt).toEqual(initial.receipt);
    expect(submit(completionInput)).toMatchObject({
      fills: [],
      events: [],
      recovery: completed.recovery,
      journal: { appended: 0 },
    });
    expect(submit({ ...withoutObservation(input), now: NOW + 240_000 }).recovery).toEqual(
      completed.recovery,
    );
    const account = recordedState(record(recorded.uri, completed.recovery.events)).accounts[
      'main'
    ]!;
    expect(account.positions['AAA']!.quantity).toBe(10);
    expect(account.cashBalances['USD']!.totalAmount).toBe(9018.25); // 10000 - 4*95 - 6*100 - 1.75.
  });

  it('refuses missing persisted normalized fills rather than reconstructing legacy accounting facts', () => {
    const { approve, submit, stores } = setup();
    const input = approve();
    submit(input);
    const incomplete = stores()
      .journal.read(JOURNAL)
      .map((event) => {
        const { fill: _fill, ...detail } = event.detail;
        return { ...event, detail };
      });
    const legacy = createMemoryExecutionJournalStore();
    legacy.append({ events: incomplete });
    expect(() => submit(input, legacy)).toThrowError(
      expect.objectContaining({ code: ErrorCode.TradeGrantConsumed }),
    );
    // Corruption in the original storage identity conflicts with the exact write-ahead facts.
    expect(() => submit(input, { ...legacy, storeId: stores().journal.storeId })).toThrowError(
      expect.objectContaining({ code: ErrorCode.TradeIdempotencyConflict }),
    );
    expect(legacy.read(JOURNAL)).toEqual(incomplete);
  });
});
