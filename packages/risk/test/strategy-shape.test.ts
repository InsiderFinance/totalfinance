/**
 * Wave 6 §2A decoupling proof.
 *
 * `@totalfinance/risk` no longer imports `@totalfinance/strategy` (the layering points strategy → risk). This
 * test proves the two ends still meet: a *real* strategy `Position` is structurally assignable to
 * risk's own `StrategyPosition` protocol with no cast, so `analyzeBook` keeps accepting real
 * positions; and the additive `@totalfinance/risk/sizing` subpath re-exports the very same `kellyBet` /
 * `optionsMargin` implementations as the package root.
 */

import { describe, expect, it } from 'vitest';
import { legs, strategy } from '@totalfinance/strategy';
import {
  analyzeBook,
  kellyBet as kellyBetRoot,
  optionsMargin as optionsMarginRoot,
  type StrategyPosition,
} from '@totalfinance/risk';
import { kellyBet, optionsMargin } from '@totalfinance/risk/sizing';

const EXPIRY = '2026-06-19';
const MKT = {
  spot: 100,
  volatility: 0.2,
  riskFreeRate: 0.04,
  asOf: '2026-05-01T00:00:00Z',
} as const;

function bullPutSpread(): ReturnType<typeof strategy> {
  return strategy(
    [
      legs.put({ strike: 95, premium: 2.0, quantity: -1 }),
      legs.put({ strike: 90, premium: 1.0, quantity: 1 }),
    ],
    { multiplier: 100, expiry: EXPIRY },
  );
}

describe('2A — strategy Position is structurally assignable to risk (no package edge)', () => {
  it('a real Position satisfies StrategyPosition with no cast', () => {
    // Compile-time proof: if the structural protocol drifted from strategy's Position, this assignment
    // would fail to typecheck and break CI.
    const pos: StrategyPosition = bullPutSpread();
    expect(typeof pos.value).toBe('function');
    expect(typeof pos.metrics).toBe('function');
    expect(Array.isArray(pos.legs)).toBe(true);
    // Runtime proof: the structural value()/greeks contract still marks correctly.
    const marked = pos.value(MKT);
    expect(Number.isFinite(marked.value)).toBe(true);
    expect(Number.isFinite(marked.greeks.delta)).toBe(true);
    expect(marked.perLeg).toHaveLength(2);
  });

  it('analyzeBook still accepts real positions end-to-end', () => {
    const r = analyzeBook([{ position: bullPutSpread(), market: MKT, underlying: 'XYZ' }]);
    expect(r.byPosition).toHaveLength(1);
    expect(Number.isFinite(r.greeks.delta)).toBe(true);
    expect(Number.isFinite(r.value)).toBe(true);
  });
});

describe('2A — @totalfinance/risk/sizing re-exports the root sizing implementations', () => {
  it('kellyBet and optionsMargin are the very same functions as the package root', () => {
    // Implementation identity: the subpath is a re-export, not a second copy — a consumer that imports
    // either path gets the same behavior.
    expect(kellyBet).toBe(kellyBetRoot);
    expect(optionsMargin).toBe(optionsMarginRoot);
  });

  it('the re-exported functions are callable through the subpath', () => {
    const sizing = kellyBet({
      edge: { binary: { winProbability: 0.55, winAmount: 1, lossAmount: 1 } },
    });
    expect(Number.isFinite(sizing.recommendedFraction)).toBe(true);
    const margin = optionsMargin([{ type: 'put', quantity: -1, strike: 95, premium: 2 }], {
      spot: 100,
    });
    expect(Number.isFinite(margin.buyingPowerReduction)).toBe(true);
  });
});
