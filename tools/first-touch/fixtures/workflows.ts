/**
 * Stage 7A slice 1 — first-touch fixtures for `@totalfinance/workflows`: the operation contract, the
 * registry, the runtime, and the moved kit helpers. Thunks build FRESH inputs per call.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '@totalfinance/core/schema';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { createPortfolioLedger } from '@totalfinance/portfolio';
import {
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
} from '@totalfinance/portfolio/trade';
import { defineOperation, optionsPack } from '@totalfinance/workflows';
import { type FixtureThunk } from '../inputs.js';

const fileStoreDirectory = () => mkdtempSync(join(tmpdir(), 'totalfinance-first-touch-'));

const echo = () =>
  defineOperation({
    id: 'totalfinance.fixture.echo',
    title: 'Echo',
    description: 'Returns its input (fixture).',
    inputSchema: schema.object({ value: schema.number() }),
    outputSchema: { type: 'object', properties: { value: { type: 'number' } } },
    run: (input) => ({ summary: `echo ${input.value}`, structured: { value: input.value } }),
  });

const priceInput = () => ({
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
});

const handle = () => ({
  uri: 'totalfinance://reports/sha256:fixture',
  kind: 'report',
  schema: 'totalfinance.operation-result',
  version: '1',
  contentHash: 'sha256:fixture',
  createdTimestampMs: Date.parse('2026-09-03T14:00:00Z'),
  expiresTimestampMs: null,
  provenance: {},
});
const putRequest = () => ({
  value: { value: 1, assumptions: {}, diagnostics: { warnings: [] } },
  kind: 'report',
  createdTimestampMs: Date.parse('2026-09-03T14:00:00Z'),
});
let jobSequence = 0;
/** A fresh id per call: a store mints an id once, and the probe repeats its valid call. */
const jobRecord = () => ({
  id: `job-fixture-${(jobSequence += 1)}`,
  operation: { id: 'totalfinance.option.price', version: '1' },
  state: 'accepted',
  progress: null,
  inputsHash: 'sha256:fixture',
  seed: null,
  submittedAt: '2026-09-03T14:00:00Z',
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
  usage: { elapsedMs: null },
});

const TRADE_T0 = Date.UTC(2026, 0, 5, 21);
const TRADE_DAY = 86_400_000;
const TRADE_NOW = TRADE_T0 + 2 * TRADE_DAY;
const tradeEnvelope = (eventId: string, at: number, event: Record<string, unknown>) =>
  ({
    eventId,
    schemaVersion: 1,
    eventType: event['eventType'],
    sourceId: 'fixture',
    accountId: 'main',
    effectiveTimestampMs: at,
    recordedTimestampMs: at,
    event,
    provenance: {},
  }) as never;
const tradeLedger = () =>
  createPortfolioLedger({
    portfolioId: 'primary',
    baseCurrency: 'USD',
    events: [
      tradeEnvelope('dep', TRADE_T0, {
        eventType: 'cash.deposit',
        amount: 100_000,
        currency: 'USD',
      }),
      tradeEnvelope('fill', TRADE_T0 + TRADE_DAY, {
        eventType: 'trade.fill',
        instrumentId: 'AAA',
        side: 'buy',
        quantity: 100,
        pricePerUnit: 100,
        currency: 'USD',
      }),
    ],
  });
const tradeMarket = () =>
  createMarketSnapshot({
    asOf: TRADE_NOW,
    observations: {
      spots: { AAA: { price: 110, currency: 'USD' }, BBB: { price: 50, currency: 'USD' } },
    },
  });
const tradePlan = () =>
  normalizeTradePlan({
    intent: {
      kind: 'totalfinance.trade-intent',
      schemaVersion: 1,
      accountId: 'main',
      asOf: TRADE_NOW,
      orders: [{ instrumentId: 'BBB', side: 'buy', quantity: 200, type: 'market' }],
      rationale: 'fixture',
    } as never,
    portfolio: tradeLedger().state,
    market: tradeMarket(),
    asOf: TRADE_NOW,
  });
const tradePreflight = () =>
  preflightTradePlan({
    plan: tradePlan(),
    portfolio: tradeLedger().state,
    market: tradeMarket(),
    asOf: TRADE_NOW,
    policy: {
      mode: 'paper',
      limits: { maximumPositionWeight: 0.5 },
      marketMaximumAgeMs: TRADE_DAY,
    } as never,
  });
const tradeGrant = () =>
  createAuthorizationGrant({
    plan: tradePlan(),
    preflight: tradePreflight(),
    marketMaximumAgeMs: TRADE_DAY,
    mode: 'paper',
    variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
    expiresAt: TRADE_NOW + TRADE_DAY,
    approvedBy: 'fixture',
    idempotencyKeys: ['fixture:1'],
    now: TRADE_NOW,
  });
const tradeJournalEvents = () => {
  const plan = tradePlan();
  const orderId = plan.orders[0]!.orderId;
  const event = (n: number, eventType: string, detail: Record<string, unknown>) => ({
    eventId: `paper:main:journal:${n}`,
    journalId: 'paper:main:journal',
    timestampMs: TRADE_NOW + 1_000,
    orderId,
    planHash: plan.contentHash,
    eventType,
    detail,
    sourceId: 'paper:main',
    provenance: {},
  });
  return [event(1, 'submitted', { quantity: 200 }), event(2, 'acknowledged', {})];
};

export const WORKFLOWS_FIXTURES: Record<string, FixtureThunk> = {
  'workflows.tradePack': () => [],
  'workflows.createFileAuthorizationStore': () => [{ directory: fileStoreDirectory() }],
  'workflows.createFileExecutionJournalStore': () => [{ directory: fileStoreDirectory() }],
  'workflows.requireCapabilities': () => [
    'fixture',
    'capabilities',
    ['trade:paper', 'portfolio:read'],
  ],
  'workflows.missingCapabilities': () => [['trade:paper'], ['portfolio:read']],
  'workflows.createMemoryAuthorizationStore': () => [],
  'workflows.createMemoryExecutionJournalStore': () => [],
  'workflows.requireAuthorizationPut': () => [
    'fixture',
    { grant: tradeGrant(), createdTimestampMs: Date.parse('2026-09-06T12:00:00Z') },
  ],
  'workflows.requireJournalAppend': () => ['fixture', { events: tradeJournalEvents() }],
  'workflows.requireJournalId': () => ['fixture', 'paper:main:journal'],
  'workflows.AuthorizationStore#put': () => [
    { grant: tradeGrant(), createdTimestampMs: Date.parse('2026-09-06T12:00:00Z') },
  ],
  'workflows.AuthorizationStore#get': () => [tradeGrant().contentHash],
  'workflows.AuthorizationStore#list': () => [],
  'workflows.ExecutionJournalStore#append': () => [{ events: tradeJournalEvents() }],
  'workflows.ExecutionJournalStore#read': () => ['paper:main:journal'],
  'workflows.ExecutionJournalStore#list': () => [],

  'workflows.defineOperation': () => [
    {
      id: 'totalfinance.fixture.echo',
      title: 'Echo',
      description: 'Returns its input (fixture).',
      inputSchema: schema.object({ value: schema.number() }),
      run: (input: { value: number }) => ({ summary: 'echo', structured: { value: input.value } }),
    },
  ],
  'workflows.describeOperation': () => [echo()],
  'workflows.operationAnnotations': () => [
    { sideEffect: 'none', idempotency: 'not-applicable', requiredCapabilities: [] },
  ],
  'workflows.runOperation': () => [
    { operation: optionsPack().operations[0], input: priceInput(), maxInputBytes: 65_536 },
  ],
  'workflows.toOperationError': () => [new Error('fixture'), echo()],
  'workflows.requireOperation': () => ['fixture', 'operation', echo()],
  'workflows.createOperationRegistry': () => [{ packs: [optionsPack()] }],
  'workflows.OperationRegistry#run': () => [
    { id: 'totalfinance.option.price', input: priceInput() },
  ],
  // Stage 7A slice 3 — handles and the memory stores.
  'workflows.handleUriOf': () => ['report', 'sha256:fixture'],
  'workflows.parseHandleUri': () => ['totalfinance://reports/sha256:fixture'],
  'workflows.requireResourceHandle': () => ['fixture', 'handle', handle()],
  'workflows.requireArtifactPut': () => ['fixture', putRequest()],
  'workflows.requireArtifactListFilter': () => ['fixture', { kind: 'report' }],
  'workflows.requireJobRecord': () => ['fixture', 'record', jobRecord()],
  'workflows.applyJobPatch': () => ['fixture', jobRecord(), { state: 'queued' }],
  'workflows.ArtifactStore#put': () => [putRequest()],
  'workflows.ArtifactStore#get': () => ['totalfinance://reports/sha256:fixture'],
  'workflows.ArtifactStore#list': () => [{ kind: 'report' }],
  'workflows.JobStore#create': () => [jobRecord()],
  'workflows.JobStore#update': () => ['job-fixture-1', { state: 'queued' }],
  'workflows.JobStore#get': () => ['job-fixture-1'],

  'workflows.jsonSafe': () => [{ value: Number.NaN, nested: [1, Number.POSITIVE_INFINITY] }],
  'workflows.capRows': () => [[1, 2, 3], 'rows', 'totalfinance.fixture.echo', 10],
  'workflows.extendObjectSchema': () => [
    schema.object({ spot: schema.number() }),
    schema.object({ method: schema.enum(['a', 'b']).optional() }),
  ],
};
