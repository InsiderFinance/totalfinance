/**
 * Stage 7B.2 — the safe trade lifecycle as a cold user runs it: propose → preflight → authorize →
 * execute on paper → reconcile, directly and then through the registry with the stores and the
 * capabilities. Every number here is the guide's (`docs/guides/trade-lifecycle.md`).
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';
import {
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
  reconcileExecution,
} from '@totalfinance/portfolio/trade';
import { createPaperBroker } from '@totalfinance/backtest/paper';
import {
  createMemoryArtifactStore,
  createMemoryAuthorizationStore,
  createMemoryExecutionJournalStore,
  createOperationRegistry,
  defaultPacks,
  journeyPacks,
  tradePack,
} from '@totalfinance/workflows';

const T0 = Date.UTC(2026, 0, 5, 21);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 7, 21);
const envelope = (
  eventId: string,
  at: number,
  event: Record<string, unknown>,
): PortfolioEventEnvelope =>
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
  }) as unknown as PortfolioEventEnvelope;
const events = [
  envelope('dep', T0, { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' }),
  envelope('fill', T0 + DAY, {
    eventType: 'trade.fill',
    instrumentId: 'AAA',
    side: 'buy',
    quantity: 100,
    pricePerUnit: 100,
    currency: 'USD',
  }),
];
const intent = {
  kind: 'totalfinance.trade-intent' as const,
  schemaVersion: 1 as const,
  accountId: 'main',
  asOf: NOW,
  orders: [{ instrumentId: 'BBB', side: 'buy' as const, quantity: 200, type: 'market' as const }],
  rationale: 'rotate a fifth of AAA into BBB',
};
const policy = {
  mode: 'paper' as const,
  limits: { maximumPositionWeight: 0.5 },
  maximumOrderNotional: 50_000,
  marketMaximumAgeMs: DAY,
};
const variance = { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 };
const observation = {
  BBB: {
    kind: 'bar' as const,
    bar: {
      symbol: 'BBB',
      timestampMs: NOW + 60_000,
      open: 50,
      high: 51,
      low: 49,
      close: 50.5,
      volume: 10_000,
    },
  },
};

describe('the safe trade lifecycle', () => {
  it('runs a first paper trade directly: propose, preflight, authorize, execute, reconcile', () => {
    const ledger = createPortfolioLedger({ portfolioId: 'primary', baseCurrency: 'USD', events });
    const market = createMarketSnapshot({
      asOf: NOW,
      observations: {
        spots: { AAA: { price: 110, currency: 'USD' }, BBB: { price: 50, currency: 'USD' } },
      },
    });
    const plan = normalizeTradePlan({ intent, portfolio: ledger.state, market, asOf: NOW });
    expect(plan.orders).toHaveLength(1);
    const preflight = preflightTradePlan({
      plan,
      portfolio: ledger.state,
      market,
      asOf: NOW,
      policy,
      costs: { commissionBps: 5, slippageBps: 10 },
    });
    expect(preflight.decision.verdict).toBe('allow');
    const grant = createAuthorizationGrant({
      plan,
      preflight,
      marketMaximumAgeMs: DAY,
      mode: 'paper',
      variance,
      expiresAt: NOW + DAY,
      approvedBy: 'trey',
      idempotencyKeys: { prefix: 'run', count: 3 },
      now: NOW,
    });
    const broker = createPaperBroker({
      baseCurrency: 'USD',
      sourceId: 'paper:main',
      accountId: 'main',
    });
    const submission = {
      plan,
      grant,
      idempotencyKey: 'run:1',
      now: NOW + 1_000,
      portfolioHash: preflight.portfolioHash,
      marketHash: preflight.marketHash,
      marketAsOf: NOW,
    };
    const receipt = broker.submit(submission);
    expect(receipt.orders.map((o) => o.state)).toEqual(['acknowledged']);
    expect(broker.submit(submission)).toBe(receipt);
    const stepped = broker.step({ observations: observation, asOf: NOW + 60_000 });
    expect(stepped.fills.map((f) => [f.quantity, f.pricePerUnit])).toEqual([[200, 50]]);
    const after = applyPortfolioEvents({ previousState: ledger.state, events: stepped.events });
    expect(after.accounts['main']!.positions['BBB']!.quantity).toBe(200);
    const report = reconcileExecution({
      journal: broker.journal(),
      ledger: after,
      sourceId: 'paper:main',
      fills: stepped.fills,
      asOf: NOW + 120_000,
      tolerance: { quantity: 1e-9, cashAmount: 0.01 },
    });
    expect(report.reconciled).toBe(true);
    // the same key with another plan is a conflict
    const other = normalizeTradePlan({
      intent: {
        ...intent,
        orders: [{ instrumentId: 'BBB', side: 'buy', quantity: 10, type: 'market' }],
      },
      portfolio: ledger.state,
      market,
      asOf: NOW,
    });
    let code = '';
    try {
      broker.submit({ ...submission, plan: other });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe(ErrorCode.TradeIdempotencyConflict);
  });

  it('runs the same lifecycle through the registry with the stores and the capabilities', () => {
    const registry = createOperationRegistry({
      packs: [...defaultPacks(), ...journeyPacks(), tradePack()],
    });
    const artifacts = createMemoryArtifactStore();
    const options = {
      artifacts,
      stores: {
        authorization: createMemoryAuthorizationStore(),
        journal: createMemoryExecutionJournalStore(),
      },
      capabilities: [
        'portfolio:read',
        'analytics:run',
        'trade:propose',
        'trade:approve',
        'trade:paper',
        'portfolio:write',
      ],
      createdTimestampMs: Date.parse('2026-09-06T12:00:00Z'),
      maxInputBytes: 16_777_216,
    };
    const ledger = createPortfolioLedger({ portfolioId: 'primary', baseCurrency: 'USD', events });
    const market = JSON.parse(
      JSON.stringify(
        createMarketSnapshot({
          asOf: NOW,
          observations: {
            spots: { AAA: { price: 110, currency: 'USD' }, BBB: { price: 50, currency: 'USD' } },
          },
        }),
      ),
    ) as Record<string, unknown>;
    const ledgerHandle = artifacts.put({
      value: JSON.parse(JSON.stringify(ledger.toJSON())) as never,
      kind: 'portfolio',
      createdTimestampMs: options.createdTimestampMs,
    });
    const run = (id: string, input: unknown) =>
      registry.run({ id, input, ...options }).structured as Record<string, unknown>;
    // without the capability, a write refuses before parsing
    let refused = '';
    try {
      registry.run({
        id: 'totalfinance.trade.authorize',
        input: {},
        artifacts,
        stores: options.stores,
        createdTimestampMs: options.createdTimestampMs,
      });
    } catch (error) {
      refused = (error as { code: string }).code;
    }
    expect(refused).toBe(ErrorCode.OperationCapabilityMissing);
    const { plan, ...preflight } = run('totalfinance.trade.preflight', {
      intent,
      portfolio: ledgerHandle.uri,
      market,
      asOf: NOW,
      policy,
    }) as {
      plan: Record<string, unknown> & { contentHash: string };
      portfolioHash: string;
      marketHash: string;
      decision: { verdict: string };
    };
    expect(preflight.decision.verdict).toBe('allow');
    const { grant } = run('totalfinance.trade.authorize', {
      plan,
      preflight,
      approvedBy: 'trey',
      expiresAt: NOW + DAY,
      now: NOW,
      variance,
      marketMaximumAgeMs: DAY,
      idempotencyKeys: ['run:1'],
      createdTimestampMs: options.createdTimestampMs,
    }) as { grant: { contentHash: string } };
    const submitted = run('totalfinance.trade.submit', {
      plan,
      grantHash: grant.contentHash,
      idempotencyKey: 'run:1',
      now: NOW + 1_000,
      portfolioHash: preflight.portfolioHash,
      marketHash: preflight.marketHash,
      marketAsOf: NOW,
      sourceId: 'paper:main',
      accountId: 'main',
      baseCurrency: 'USD',
      observations: observation,
      asOf: NOW + 60_000,
    }) as { fills: { quantity: number }[]; events: unknown[]; journal: { journalId: string } };
    expect(submitted.fills.map((f) => f.quantity)).toEqual([200]);
    const recorded = run('totalfinance.portfolio.record_events', {
      portfolio: ledgerHandle.uri,
      events: submitted.events,
      createdTimestampMs: options.createdTimestampMs,
    }) as { handle: { uri: string } };
    expect(recorded.handle.uri).toMatch(/^totalfinance:\/\/portfolios\//);
    const reconciled = run('totalfinance.trade.reconcile', {
      journalId: submitted.journal.journalId,
      ledger: recorded.handle.uri,
      sourceId: 'paper:main',
      fills: submitted.fills,
      asOf: NOW + 120_000,
      tolerance: { quantity: 1e-9, cashAmount: 0.01 },
    }) as { reconciled: boolean };
    expect(reconciled.reconciled).toBe(true);
  });
});
