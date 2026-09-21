/** Disjoint shard; main registers STRUCTURE_OPTION_FLOW_DRIFT_FIXTURES in the fixture registry. */
import { resolvedExpiry } from '@totalfinance/core';
import type { FixtureThunk } from '../inputs.js';

export const STRUCTURE_OPTION_FLOW_DRIFT_FIXTURES: Record<string, FixtureThunk> = {
  'structure.optionFlowDrift': () => [
    {
      trades: [
        {
          id: 'example-1',
          contract: {
            underlying: 'SPY',
            type: 'call',
            style: 'american',
            strike: 600,
            expiry: '2026-06-19',
            ...resolvedExpiry('2026-06-19'),
            multiplier: 100,
          },
          timestampMs: Date.parse('2026-06-04T13:30:00Z'),
          price: 2,
          size: 10,
          bid: 1.9,
          ask: 2,
          aggressorSide: 'buy',
          underlyingPrice: 600,
        },
      ],
      session: { date: '2026-06-04' },
      config: {
        symbol: 'SPY',
        asOf: Date.parse('2026-06-04T13:35:00Z'),
        bucketMinutes: 5,
        classificationSource: 'provided-first',
        multiplier: 100,
        minimumClassificationCoverage: 0.6,
      },
    },
  ],
};
