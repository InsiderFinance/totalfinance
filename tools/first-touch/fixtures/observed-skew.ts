/**
 * Disjoint observed-skew fixture shard. Main registers OBSERVED_SKEW_FIXTURES in fixtures.ts:
 * import from './fixtures/observed-skew.js', then include it in the fixture-map merge list.
 * No model prices or computed deltas: fresh canonical records on every probe.
 */
import { resolvedExpiry } from '@totalfinance/core';
import type { ObservedSkewInput } from '@totalfinance/volatility';
import type { FixtureThunk } from '../inputs.js';

export const OBSERVED_SKEW_FIXTURES: Record<string, FixtureThunk> = {
  'volatility.observedSkew': () => {
    const expiry = '2026-07-17';
    const asOf = Date.parse('2026-06-01T20:00:00Z');
    const input: ObservedSkewInput = {
      quotes: [90, 95, 100, 105, 110].flatMap((strike, i) =>
        (['call', 'put'] as const).map((type) => ({
          contract: {
            underlying: 'X',
            type,
            style: 'american',
            strike,
            expiry,
            ...resolvedExpiry(expiry),
          },
          timestampMs: asOf,
          impliedVolatility: 0.3 + (type === 'put' ? 0.02 : 0),
          greeks: {
            delta:
              type === 'call'
                ? [0.9, 0.75, 0.5, 0.25, 0.1][i]!
                : [-0.1, -0.25, -0.5, -0.75, -0.9][i]!,
          },
          openInterest: 100,
        })),
      ),
      market: { spot: 100, asOf },
      config: {
        expiry,
        riskReversalConvention: 'callMinusPut',
        minimumContracts: 6,
        deltaTolerance: 0.12,
        tailDeltaTolerance: 0.05,
        slopeWindow: 0.1,
      },
    };
    return [input];
  },
  // Real umbrella namespace alias: semantic-group pooling uses this valid ISO branch alongside
  // the primary numeric branch instead of synthesizing an inconsistent canonical quote contract.
  'totalfinance.volatility.observedSkew': () => {
    const args = OBSERVED_SKEW_FIXTURES['volatility.observedSkew']!();
    const input = args[0] as ObservedSkewInput;
    input.market.asOf = '2026-06-01T20:00:00Z';
    return args;
  },
};
