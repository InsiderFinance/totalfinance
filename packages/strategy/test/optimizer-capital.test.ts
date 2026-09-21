/**
 * Strategy optimizer — capital normalization (Wave 6 §2B). Verifies that every candidate carries a
 * Reg-T capital requirement equal to a direct `optionsMargin(...)` call, that `thesisEvPerCapital`
 * divides thesis EV by that requirement (null, never Infinity, at zero capital), that the new
 * `thesisEvPerCapital` objective ranks deterministically, that `thesisEvPerRisk` still means
 * `thesisEv / |maxLoss|` (never margin), and that 2B adds NO Kelly field (that is 2C).
 *
 * Note: `scanStrategies` enumerates only DEFINED-RISK structures, for which the Reg-T requirement
 * equals `|maxLoss|`. The undefined-risk denominator (a naked short's finite Reg-T capital vs an
 * infinite max loss) is proven here at the `optionsMargin` contract the optimizer forwards.
 */

import { describe, expect, it } from 'vitest';
import { isoDateToEpochMs } from '@totalfinance/core';
import { optionsMargin } from '@totalfinance/risk/sizing';
import {
  optimizeStrategy,
  type Leg,
  type OptimizerExpiry,
  type ScanQuoteRow,
} from '@totalfinance/strategy';

const ASOF = isoDateToEpochMs('2026-05-01');
const E1 = '2026-06-20';
const chain = (): ScanQuoteRow[] =>
  [80, 85, 90, 95, 100, 105, 110, 115, 120].map((strike) => ({ strike }));
const expiry = (e: string): OptimizerExpiry => ({ expiry: e, chain: chain() });
const base = { spot: 100, asOf: ASOF, riskFreeRate: 0.03, volatility: 0.25 } as const;

function optionLegsOf(legs: readonly Leg[]) {
  return legs
    .filter((l): l is Extract<Leg, { kind: 'call' | 'put' }> => l.kind !== 'stock')
    .map((l) => ({ type: l.kind, quantity: l.quantity, strike: l.strike, premium: l.premium }));
}

describe('optimizeStrategy — capital denominator', () => {
  const r = optimizeStrategy({
    ...base,
    expiries: [expiry(E1)],
    thesis: { targetPrice: 105, volatility: 0.3 },
    top: 100,
  });

  it('every candidate carries capital equal to a direct optionsMargin call', () => {
    expect(r.candidates.length).toBeGreaterThan(5);
    for (const c of r.candidates) {
      const m = optionsMargin(optionLegsOf(c.legs), { spot: base.spot, multiplier: 100 });
      expect(c.capital.requirement).toBeCloseTo(m.buyingPowerReduction, 9);
      expect(c.capital.method).toBe(m.method);
      expect(c.capital.maxLoss).toBe(m.maxLoss);
      expect(['defined-risk-max-loss', 'long-premium', 'reg-t-naked']).toContain(c.capital.method);
    }
  });

  it('thesisExpectedValuePerCapital = thesisExpectedValue / capital.requirement (never Infinity)', () => {
    for (const c of r.candidates) {
      if (c.capital.requirement > 0) {
        expect(c.thesisExpectedValuePerCapital).toBeCloseTo(
          c.thesisExpectedValue / c.capital.requirement,
          9,
        );
      } else {
        expect(c.thesisExpectedValuePerCapital).toBeNull();
      }
      expect(c.thesisExpectedValuePerCapital).not.toBe(Infinity);
      expect(c.thesisExpectedValuePerCapital).not.toBe(-Infinity);
    }
  });

  it('thesisExpectedValuePerRisk still means thesisExpectedValue / |maxLoss| — never margin', () => {
    for (const c of r.candidates) {
      const risk = c.maxLoss === null ? null : Math.abs(c.maxLoss);
      const expected = risk !== null && risk > 0 ? c.thesisExpectedValue / risk : 0;
      expect(c.thesisExpectedValuePerRisk).toBeCloseTo(expected, 9);
    }
  });

  it('adds NO kelly field or implicit sizing (that is 2C)', () => {
    for (const c of r.candidates) expect('kelly' in c).toBe(false);
  });
});

describe('optimizeStrategy — thesisExpectedValuePerCapital objective', () => {
  it('ranks candidates by thesisExpectedValuePerCapital descending and echoes the objective', () => {
    const r = optimizeStrategy({
      ...base,
      expiries: [expiry(E1)],
      thesis: { targetPrice: 108, volatility: 0.28 },
      objective: 'thesisExpectedValuePerCapital',
      top: 50,
    });
    expect(r.assumptions.objective).toBe('thesisExpectedValuePerCapital');
    // Each candidate's score is its thesisEvPerCapital (null → sinks to the bottom), sorted descending.
    const rank = (v: number | null) => v ?? -Infinity;
    for (let i = 1; i < r.candidates.length; i++) {
      expect(rank(r.candidates[i - 1]!.thesisExpectedValuePerCapital)).toBeGreaterThanOrEqual(
        rank(r.candidates[i]!.thesisExpectedValuePerCapital) - 1e-12,
      );
    }
    // The winner has the best capital-efficiency of the set.
    const best = Math.max(...r.candidates.map((c) => rank(c.thesisExpectedValuePerCapital)));
    expect(rank(r.candidates[0]!.thesisExpectedValuePerCapital)).toBeCloseTo(best, 9);
  });
});

describe('optimizeStrategy — capital forwards optionsMargin for undefined risk', () => {
  it('a naked short call reports finite Reg-T capital with a null (unbounded) max loss', () => {
    // The optimizer forwards exactly this denominator; the scanner does not itself enumerate naked
    // shorts, so the undefined-risk contract is pinned here at the optionsMargin the optimizer uses.
    const m = optionsMargin([{ type: 'call', quantity: -1, strike: 105, premium: 3 }], {
      spot: 100,
      multiplier: 100,
    });
    expect(m.definedRisk).toBe(false);
    expect(m.method).toBe('reg-t-naked');
    expect(m.maxLoss).toBeNull(); // unbounded — thesisExpectedValuePerRisk would be 0...
    expect(Number.isFinite(m.buyingPowerReduction)).toBe(true); // ...but capital is finite and rankable
    expect(m.buyingPowerReduction).toBeGreaterThan(0);
  });
});
