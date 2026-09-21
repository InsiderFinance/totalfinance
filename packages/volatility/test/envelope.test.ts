import { describe, expect, it } from 'vitest';
import {
  expectedMoveFromImpliedVolatility,
  expectedMoveFromStraddle,
  impliedVolatilityPercentile,
  impliedVolatilityRank,
  impliedVolatilityStatistics,
  probabilityInTheMoney,
  probabilityOfTouch,
  varianceSwapRate,
} from '@totalfinance/volatility';

/**
 * DX1.2 — the scalar-tier vol estimates are unified on the standard `Computed<T>` envelope: warnings
 * live under `diagnostics.warnings` (never a hoisted top-level `warnings`), uniform with every other
 * rich result in the library so MCP/serialization consumers treat all results the same way.
 */

const hist = [0.15, 0.2, 0.22, 0.18, 0.25, 0.19];

describe('every vol scalar estimate is a Computed<T> envelope', () => {
  const results = [
    expectedMoveFromImpliedVolatility.explain({
      spot: 100,
      impliedVolatility: 0.2,
      timeToExpiryYears: 0.25,
    }),
    expectedMoveFromStraddle.explain({ spot: 100, straddlePrice: 5 }),
    probabilityInTheMoney.explain({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.03,
      volatility: 0.2,
    }),
    probabilityOfTouch.explain({
      spot: 100,
      barrier: 110,
      timeToExpiryYears: 1,
      riskFreeRate: 0.03,
      volatility: 0.2,
    }),
    impliedVolatilityRank.explain({ current: 0.2, history: hist }),
    impliedVolatilityPercentile.explain({ current: 0.2, history: hist }),
    impliedVolatilityStatistics.explain({ current: 0.2, history: hist }),
    varianceSwapRate({
      strikes: [90, 100, 110],
      otmPrices: [1, 4, 1],
      forward: 100,
      riskFreeRate: 0.02,
      timeToExpiryYears: 0.25,
    }),
  ];

  it('carries value + assumptions + diagnostics.warnings, and no hoisted top-level warnings', () => {
    for (const r of results) {
      expect(r).toHaveProperty('value');
      expect(r).toHaveProperty('assumptions');
      expect(Array.isArray(r.diagnostics.warnings)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(r, 'warnings')).toBe(false);
    }
  });
});
