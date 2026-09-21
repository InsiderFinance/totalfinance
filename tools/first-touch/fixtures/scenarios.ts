/** Stage 4.4b first-touch fixtures for every callable on the scenarios package root. */

import { createMarketSnapshot, createScenarioSet } from '@totalfinance/core/artifacts';
import { applyPortfolioEvents } from '@totalfinance/portfolio';
import { scenarioPortfolioBinding, scenarioTarget, spotAssetPricer } from '@totalfinance/scenarios';
import type { FixtureThunk } from '../inputs.js';

const AS_OF = Date.UTC(2026, 7, 30);

function portfolioState() {
  return applyPortfolioEvents({
    portfolio: { baseCurrency: 'USD' },
    events: [
      {
        eventId: 'scenario-first-touch-fill',
        schemaVersion: 1,
        eventType: 'trade.fill',
        sourceId: 'scenario-first-touch',
        accountId: 'primary',
        effectiveTimestampMs: AS_OF - 86_400_000,
        recordedTimestampMs: AS_OF - 86_400_000,
        event: {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 2,
          pricePerUnit: 100,
          currency: 'USD',
        },
        provenance: {},
      },
    ],
  });
}

function portfolioFullRevaluationBinding() {
  return scenarioPortfolioBinding.fullRevaluation({
    id: 'primary-aapl',
    accountId: 'primary',
    instrumentId: 'AAPL',
    instrument: { symbol: 'AAPL' },
    instrumentDescriptor: { kind: 'spot-asset', symbol: 'AAPL' },
    pricer: spotAssetPricer(),
    strategy: 'core-equity',
    book: 'household',
    tags: ['equity'],
  });
}

export const SCENARIOS_FIXTURES: Record<string, FixtureThunk> = {
  'scenarios.runScenarios': () => [
    {
      scenarioSet: createScenarioSet({
        name: 'first-touch',
        scenarios: [
          {
            name: 'spot up 10%',
            shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }],
          },
        ],
      }),
      market: createMarketSnapshot({
        asOf: AS_OF,
        observations: { spots: { AAPL: { price: 100, currency: 'USD' } } },
      }),
      targets: [
        scenarioTarget.spot({
          id: 'aapl-stock',
          symbol: 'AAPL',
          quantity: 2,
          currency: 'USD',
          account: 'primary',
          book: 'long-term',
          tags: ['equity'],
        }),
      ],
      reportingCurrency: 'USD',
      options: { failureMode: 'fail-fast', seed: 7 },
    },
  ],
  'scenarios.scenarioPortfolioBinding.fullRevaluation': () => [
    {
      id: 'primary-aapl',
      accountId: 'primary',
      instrumentId: 'AAPL',
      instrument: { symbol: 'AAPL' },
      instrumentDescriptor: { kind: 'spot-asset', symbol: 'AAPL' },
      pricer: spotAssetPricer(),
      strategy: 'core-equity',
      book: 'household',
      tags: ['equity'],
    },
  ],
  'scenarios.scenarioPortfolioBinding.taylor': () => [
    {
      id: 'primary-aapl-taylor',
      accountId: 'primary',
      instrumentId: 'AAPL',
      baseValuePerUnit: 100,
      greeks: { delta: 0.75, gamma: 0.01 },
      factors: { spot: { subject: 'AAPL', level: 100 } },
      strategy: 'core-equity',
      tags: ['equity'],
    },
  ],
  'scenarios.scenarioTarget.fullRevaluation': () => [
    {
      id: 'msft-stock',
      quantity: 3,
      contractMultiplier: 1,
      currency: 'USD',
      underlying: 'MSFT',
      instrument: { symbol: 'MSFT' },
      instrumentDescriptor: { kind: 'spot-asset', symbol: 'MSFT' },
      pricer: spotAssetPricer(),
    },
  ],
  'scenarios.scenarioTarget.taylor': () => [
    {
      id: 'aapl-taylor',
      quantity: 1,
      contractMultiplier: 100,
      currency: 'USD',
      underlying: 'AAPL',
      baseValuePerUnit: 12.5,
      greeks: { delta: 0.55, gamma: 0.018 },
      factors: { spot: { subject: 'AAPL', level: 195 } },
    },
  ],
  'scenarios.scenarioTarget.spot': () => [
    { id: 'aapl-stock', symbol: 'AAPL', quantity: 2, currency: 'USD' },
  ],
  'scenarios.spotAssetPricer': () => [],
  'scenarios.scenarioTargetsFromPortfolio': () => [
    { state: portfolioState(), bindings: [portfolioFullRevaluationBinding()] },
  ],
};
