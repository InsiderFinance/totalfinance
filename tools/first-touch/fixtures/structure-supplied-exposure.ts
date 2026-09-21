/** Disjoint shard; main owns registration in fixtures.ts and manifest integration. */
import { resolvedExpiry } from '@totalfinance/core';
import type { SuppliedExposureInput } from '@totalfinance/structure';

/** Independent dogfooding snapshot: net GEX 1,000; net DEX 17,500; gross 2,000 / 42,500. */
export const STRUCTURE_SUPPLIED_EXPOSURE_FIXTURES = {
  'structure.exposureFromGreeks': (): [SuppliedExposureInput] => {
    const timestampMs = Date.parse('2026-09-01T15:00:00Z');
    const contract = {
      underlying: 'SPY',
      style: 'american' as const,
      strike: 100,
      expiry: '2026-09-18',
      ...resolvedExpiry('2026-09-18'),
      multiplier: 100,
    };
    return [
      {
        quotes: [
          {
            contract: { ...contract, type: 'call' },
            timestampMs,
            source: 'example-chain',
            openInterest: 5,
            greeks: {
              delta: 0.6,
              gamma: 0.03,
              provenance: { source: 'example-greek-feed', timestampMs },
            },
          },
          {
            contract: { ...contract, type: 'put', strike: 95, multiplier: 10 },
            timestampMs,
            source: 'example-chain',
            openInterest: 25,
            greeks: {
              delta: -0.5,
              gamma: 0.02,
              provenance: { source: 'example-greek-feed', timestampMs },
            },
          },
        ],
        market: {
          underlying: 'SPY',
          spot: 100,
          source: 'example-spot',
          timestampMs,
          asOf: timestampMs,
        },
        config: {
          gexConvention: { calls: 1, puts: -1 },
          dexConvention: { calls: 1, puts: 1 },
          gammaUnit: 'per1PercentMove',
          maximumObservationAgeMs: 60000,
        },
      },
    ];
  },
};
