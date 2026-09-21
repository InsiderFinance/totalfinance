/**
 * First-touch fixtures for `@totalfinance/backtest/paper` and the shared fill helper (Stage 7B.2
 * slice 3). The broker is a stateful factory: its fixture builds one and the guards' fixtures use
 * the canonical construction input.
 */
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { createPortfolioLedger, type PortfolioEventEnvelope } from '@totalfinance/portfolio';
import { execution } from '@totalfinance/backtest/execution';
import type { FixtureThunk } from '../inputs.js';

const T0 = Date.UTC(2026, 0, 5, 21);
const DAY = 86_400_000;
const PAPER_AS_OF = T0 + 2 * DAY;

function envelope(
  eventId: string,
  at: number,
  event: Record<string, unknown>,
): PortfolioEventEnvelope {
  return {
    eventId,
    schemaVersion: 1,
    eventType: event['eventType'],
    sourceId: 'fixture',
    accountId: 'main',
    effectiveTimestampMs: at,
    recordedTimestampMs: at,
    event,
    provenance: {},
  } as unknown as PortfolioEventEnvelope;
}
function paperLedger() {
  return createPortfolioLedger({
    portfolioId: 'primary',
    baseCurrency: 'USD',
    events: [
      envelope('dep', T0, { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' }),
      envelope('fill', T0 + DAY, {
        eventType: 'trade.fill',
        instrumentId: 'AAA',
        side: 'buy',
        quantity: 100,
        pricePerUnit: 100,
        currency: 'USD',
      }),
    ],
  });
}
function paperMarket() {
  return createMarketSnapshot({
    asOf: PAPER_AS_OF,
    observations: {
      spots: { AAA: { price: 110, currency: 'USD' }, BBB: { price: 50, currency: 'USD' } },
    },
  });
}
export { paperLedger, paperMarket, PAPER_AS_OF };

function brokerInput(): Record<string, unknown> {
  return {
    baseCurrency: 'USD',
    sourceId: 'paper:main',
    accountId: 'main',
    instruments: { AAA: { currency: 'USD' }, BBB: { currency: 'USD' } },
  };
}
function marketOrder(): Record<string, unknown> {
  return {
    orderId: 'plan:1:BBB:buy',
    instrumentId: 'BBB',
    side: 'buy',
    quantity: 100,
    type: 'market',
    submittedTimestampMs: PAPER_AS_OF,
  };
}
function barObservation(): Record<string, unknown> {
  return {
    kind: 'bar',
    bar: {
      symbol: 'BBB',
      timestampMs: PAPER_AS_OF,
      open: 50,
      high: 51,
      low: 49,
      close: 50.5,
      volume: 10_000,
    },
  };
}

export const PAPER_FIXTURES: Record<string, FixtureThunk> = {
  'backtest.createPaperBroker': () => [brokerInput()],
  'backtest.requireCreatePaperBrokerInput': () => ['fixture', 'input', brokerInput()],
  'backtest.requirePaperInstrument': () => [
    'fixture',
    'instrument',
    { currency: 'USD', contractMultiplier: 100, settlementStyle: 'cash-on-trade' },
  ],
  'backtest.fillOrderWithPolicy': () => [
    {
      policy: execution.simplified(),
      order: marketOrder(),
      observation: barObservation(),
      asOf: PAPER_AS_OF,
      accountId: 'main',
      currency: 'USD',
      fillId: 'fixture:fill:1',
    },
  ],
};
