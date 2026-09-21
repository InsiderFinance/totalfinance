/**
 * FC3 — the research ⇄ risk composition, proven structurally. The dependency graph deliberately
 * gives `@totalfinance/research` no edge to `@totalfinance/risk` (workflows compose the two), so the
 * bridge is a SHAPE contract: the factor spread returns research produces feed
 * `risk.factorAttribution`'s `FactorSeries` directly, with no adapter in between. This example is
 * that proof — if either side drifts, this file stops compiling or the reconstruction stops
 * holding.
 */

import { describe, expect, it } from 'vitest';
import { factorSpreadReturn } from '@totalfinance/research';
import type { FactorEntry } from '@totalfinance/research';
import { factorAttribution } from '@totalfinance/risk';

const INSTRUMENTS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'] as const;

/** A deterministic factor cross-section for period `t`: rotates leadership so spreads vary. */
function factorAt(period: number): FactorEntry[] {
  return INSTRUMENTS.map((instrumentId, index) => ({
    instrumentId,
    value: Math.sin(index + period / 3) * 2 + index * 0.1,
  }));
}

/** Deterministic forward returns loosely aligned with the factor (signal + idiosyncratic term). */
function forwardAt(period: number): FactorEntry[] {
  const factor = factorAt(period);
  return factor.map((entry, index) => ({
    instrumentId: entry.instrumentId,
    value: 0.002 + 0.01 * (entry.value as number) + 0.003 * Math.cos(period + index),
  }));
}

describe('research factor spreads feed risk attribution structurally', () => {
  it('a periodic spread-return series is a FactorSeries, and the attribution reconstructs', () => {
    const PERIOD_COUNT = 12;
    const spreadReturns: number[] = [];
    for (let period = 0; period < PERIOD_COUNT; period++) {
      const spread = factorSpreadReturn({
        entries: factorAt(period),
        forwardReturns: forwardAt(period),
        quantileCount: 3,
        direction: 'descending',
      });
      expect(spread.spreadReturn).not.toBeNull();
      spreadReturns.push(spread.spreadReturn as number);
    }

    // A portfolio whose returns are half the factor spread plus a constant drift.
    const portfolioReturns = spreadReturns.map((spread) => 0.001 + 0.5 * spread);

    // The research output IS the risk input — no adapter, no re-keying.
    const attribution = factorAttribution({
      returns: portfolioReturns,
      factors: [{ name: 'research value spread', returns: spreadReturns }],
    });
    const factor = attribution.factors[0]!;
    expect(Math.abs(factor.beta - 0.5)).toBeLessThanOrEqual(1e-9);
    // The decomposition reconstructs the total return exactly (risk's own law).
    const reconstructed =
      attribution.factors.reduce((sum, row) => sum + row.contribution, 0) +
      attribution.specificReturn;
    expect(Math.abs(attribution.totalReturn - reconstructed)).toBeLessThanOrEqual(1e-9);
  });
});
