import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { createMarketSnapshot } from '@insiderfinance/totalfinance/core/artifacts';
import { createPortfolioLedger } from '@insiderfinance/totalfinance/portfolio';
import {
  normalizeTradePlan,
  preflightTradePlan,
  reconcileExecution,
} from '@insiderfinance/totalfinance/portfolio/trade';
import {
  createMemoryArtifactStore,
  createOperationRegistry,
  tradePack,
} from '@insiderfinance/totalfinance/workflows';

const now = Date.UTC(2026, 0, 7, 21);
const envelope = (eventId, event) => ({
  eventId,
  sourceId: 'synthetic',
  accountId: 'main',
  schemaVersion: 1,
  effectiveTimestampMs: now,
  recordedTimestampMs: now,
  eventType: event.eventType,
  event,
  provenance: {},
});
const cash = envelope('cash', { eventType: 'cash.deposit', currency: 'USD', amount: 1000 });
const fillEvent = (id, side) =>
  envelope(id, {
    eventType: 'trade.fill',
    instrumentId: 'ETF',
    currency: 'USD',
    side,
    quantity: 1,
    pricePerUnit: 100,
  });
const ledger = createPortfolioLedger({
  baseCurrency: 'USD',
  events: [cash, fillEvent('entry', 'buy'), fillEvent('exit', 'sell')],
});
const market = createMarketSnapshot({
  asOf: now,
  observations: { spots: { ETF: { price: 100, currency: 'USD' } } },
});
const journal = ['entry', 'exit'].flatMap((fillId, i) =>
  ['submitted', 'acknowledged', 'filled'].map((eventType, j) => ({
    eventId: `${fillId}:${eventType}`,
    journalId: 'synthetic:journal',
    timestampMs: now + i * 3 + j,
    sourceId: 'synthetic',
    orderId: `order:${fillId}`,
    planHash: `plan:${fillId}`,
    eventType,
    detail: eventType === 'filled' ? { fillId, quantity: 1, pricePerUnit: 100 } : { quantity: 1 },
    provenance: {},
  })),
);
const fills = ['entry', 'exit'].map((fillId) => ({
  fillId,
  accountId: 'main',
  orderId: `order:${fillId}`,
  instrumentId: 'ETF',
  side: fillId === 'entry' ? 'buy' : 'sell',
  quantity: 1,
  pricePerUnit: 100,
  currency: 'USD',
  filledTimestampMs: now,
}));
const wire = (value) => JSON.parse(JSON.stringify(value));

if (process.argv[2] === 'classification') {
  const held = createPortfolioLedger({
    baseCurrency: 'USD',
    events: [cash, fillEvent('entry', 'buy')],
  });
  const instruments = { ETF: { currency: 'USD', contractMultiplier: 1, assetClass: 'etf' } };
  const plan = normalizeTradePlan({
    intent: {
      kind: 'totalfinance.trade-intent',
      schemaVersion: 1,
      accountId: 'main',
      asOf: now,
      orders: [{ instrumentId: 'ETF', side: 'sell', quantity: 1, type: 'market' }],
    },
    portfolio: held.state,
    market,
    asOf: now,
    instruments,
  });
  const report = preflightTradePlan({
    plan,
    portfolio: held.state,
    market,
    asOf: now,
    instruments,
    policy: {
      mode: 'paper',
      allowedInstruments: ['ETF'],
      allowedAssetClasses: ['etf'],
      onUnverifiable: 'deny',
    },
  });
  assert.equal(
    report.checks.find((check) => check.name.endsWith('.allowed-asset-class')).value,
    'etf',
  );
  assert.equal(report.decision.verdict, 'allow');
} else if (process.argv[2] === 'reconciliation') {
  const input = {
    journal,
    ledger: ledger.state,
    sourceId: 'synthetic',
    fills,
    asOf: now + 10,
    tolerance: { quantity: 0, cashAmount: 0 },
  };
  assert.equal(reconcileExecution(input).reconciled, true);
  const scoped = reconcileExecution({ ...input, planHash: 'plan:exit', fills: fills.slice(1) });
  assert.deepEqual(scoped.ledgerNotJournaled, []);
  assert.equal(scoped.reconciled, true);
  const orphaned = ledger.apply([fillEvent('orphan', 'buy')]);
  assert.deepEqual(reconcileExecution({ ...input, ledger: orphaned.state }).ledgerNotJournaled, [
    'orphan',
  ]);
} else if (process.argv[2] === 'retries') {
  const artifacts = createMemoryArtifactStore();
  const registry = createOperationRegistry({ packs: [tradePack()] });
  const record = (portfolio, events) =>
    registry.run({
      id: 'totalfinance.portfolio.record_events',
      input: { portfolio, events, createdTimestampMs: now },
      artifacts,
      capabilities: ['portfolio:write'],
      createdTimestampMs: now,
    });
  const empty = createPortfolioLedger({ baseCurrency: 'USD', events: [] });
  const first = record(wire(empty.toJSON()), [cash]);
  const replay = record(first.structured.handle.uri, [cash]);
  assert.equal(replay.structured.handle.uri, first.structured.handle.uri);
  assert.equal(replay.structured.eventCount, 1);
  assert.equal(replay.structured.applied, 0);
  assert.match(replay.summary, /0 events applied/);
  const mixed = record(first.structured.handle.uri, [
    cash,
    fillEvent('entry', 'buy'),
    fillEvent('entry', 'buy'),
  ]);
  assert.equal(mixed.structured.applied, 1);
  assert.equal(mixed.structured.eventCount, 2);
} else {
  throw new Error('Select classification, reconciliation or retries');
}
console.log(`DOGFOOD_REPAIR_OK ${process.argv[2]}`);
