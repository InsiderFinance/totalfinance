/**
 * Strategy optimizer — Kelly integration + admissibility (Wave 6 §2C).
 *
 * End-to-end: Kelly is opt-in (omit `sizing` ⇒ no `kelly` field); when requested, every defined-risk
 * candidate the scanner produces is sized; `sizing.enabled` and unknown knobs are guarded.
 *
 * Unit (the not-admissible / unbounded path the defined-risk scanner cannot itself produce is exercised
 * on the module-internal resolver): a naked short CALL under a lognormal (0, ∞) support is
 * not-admissible (unbounded downside); a naked short PUT is admissible (bounded expiration loss); the
 * SAME unbounded payoff under a bounded custom support is admissible; a zero capital requirement is
 * not-admissible; and Kelly runs on DIMENSIONLESS returns (scaling P&L and capital by the same factor
 * leaves the sizing unchanged), matching a direct `kellyBet`.
 */

import { describe, expect, it } from 'vitest';
import { isoDateToEpochMs } from '@totalfinance/core';
import { kellyBet, optionsMargin, type OptionMarginLeg } from '@totalfinance/risk/sizing';
import {
  optimizeStrategy,
  type OptimizedStrategyCapital,
  type OptimizerExpiry,
  type ScanQuoteRow,
} from '@totalfinance/strategy';
import { isUnboundedDownsideUnderSupport, resolveCandidateKelly } from '../src/optimizer.js';
import type { ThesisOutcomeNode } from '../src/thesis-distribution.js';

const ASOF = isoDateToEpochMs('2026-05-01');
const E1 = '2026-06-20';
const chain = (): ScanQuoteRow[] =>
  [80, 85, 90, 95, 100, 105, 110, 115, 120].map((strike) => ({ strike }));
const expiry = (e: string): OptimizerExpiry => ({ expiry: e, chain: chain() });
const base = { spot: 100, asOf: ASOF, riskFreeRate: 0.03, volatility: 0.25 } as const;

/** The capital the optimizer would attach for a leg set (the exact optionsMargin the resolver reads). */
function capitalFor(legs: OptionMarginLeg[]): OptimizedStrategyCapital {
  const m = optionsMargin(legs, { spot: 100, multiplier: 100 });
  return {
    requirement: m.buyingPowerReduction,
    method: m.method,
    maxLoss: m.maxLoss,
    assumptions: m.assumptions,
    diagnostics: m.diagnostics,
  };
}

/** A 3-outcome thesis distribution with a real downside (so Kelly has a finite optimum). */
const NODES: ThesisOutcomeNode[] = [
  { terminalPrice: 90, probability: 0.3, pnl: -300 },
  { terminalPrice: 100, probability: 0.4, pnl: 0 },
  { terminalPrice: 115, probability: 0.3, pnl: 250 },
];

describe('optimizeStrategy — Kelly is opt-in', () => {
  it('omitting sizing performs no Kelly work and omits the field', () => {
    const r = optimizeStrategy({
      ...base,
      expiries: [expiry(E1)],
      thesis: { targetPrice: 105, volatility: 0.3 },
      top: 20,
    });
    for (const c of r.candidates) expect(c.kelly).toBeUndefined();
  });

  it('requesting sizing sizes every defined-risk candidate the scanner produces', () => {
    const r = optimizeStrategy({
      ...base,
      expiries: [expiry(E1)],
      thesis: { targetPrice: 105, volatility: 0.3 },
      top: 20,
      sizing: { enabled: true, maxFraction: 1 },
    });
    expect(r.candidates.length).toBeGreaterThan(3);
    for (const c of r.candidates) expect(c.kelly?.status).toBe('sized');
  });

  it('honors a requested cap (recommendedFraction ≤ maxFraction)', () => {
    const r = optimizeStrategy({
      ...base,
      expiries: [expiry(E1)],
      thesis: { targetPrice: 108, volatility: 0.28 },
      top: 20,
      sizing: { enabled: true, fraction: 0.5, maxFraction: 0.2 },
    });
    for (const c of r.candidates) {
      if (c.kelly?.status === 'sized') {
        const rec = c.kelly.sizing.recommendedFraction;
        if (rec !== null) expect(rec).toBeLessThanOrEqual(0.2 + 1e-9);
      }
    }
  });

  it('rejects sizing.enabled !== true and unknown sizing knobs', () => {
    expect(() =>
      optimizeStrategy({
        ...base,
        expiries: [expiry(E1)],
        thesis: { targetPrice: 105, volatility: 0.3 },
        sizing: { enabled: false } as never,
      }),
    ).toThrowError(/enabled must be true/);
    expect(() =>
      optimizeStrategy({
        ...base,
        expiries: [expiry(E1)],
        thesis: { targetPrice: 105, volatility: 0.3 },
        sizing: { enabled: true, notAKnob: 1 } as never,
      }),
    ).toThrowError();
  });
});

describe('optimizer Kelly admissibility (unbounded downside under support)', () => {
  const sizing = { enabled: true, maxFraction: 1 } as const;

  it('a naked short CALL under a lognormal thesis is not admissible (unbounded downside)', () => {
    const capital = capitalFor([{ type: 'call', quantity: -1, strike: 105, premium: 3 }]);
    expect(capital.maxLoss).toBeNull(); // optionsMargin: unbounded up-tail
    expect(
      resolveCandidateKelly({ nodes: NODES, capital, thesis: { volatility: 0.3 }, sizing }),
    ).toEqual({
      status: 'not-admissible',
      reason: 'unbounded-downside',
    });
  });

  it('a naked short PUT is admissible — its expiration loss is bounded', () => {
    const capital = capitalFor([{ type: 'put', quantity: -1, strike: 95, premium: 2 }]);
    expect(capital.maxLoss).not.toBeNull();
    expect(
      resolveCandidateKelly({ nodes: NODES, capital, thesis: { volatility: 0.3 }, sizing }).status,
    ).toBe('sized');
  });

  it('the SAME unbounded payoff under a bounded custom support is admissible', () => {
    const capital = capitalFor([{ type: 'call', quantity: -1, strike: 105, premium: 3 }]);
    const thesis = {
      volatility: 0.3,
      pdf: (p: number) => (p >= 80 && p <= 120 ? 1 / 40 : 0),
      pdfRange: { from: 80, to: 120 },
    };
    expect(isUnboundedDownsideUnderSupport(capital, thesis)).toBe(false);
    expect(resolveCandidateKelly({ nodes: NODES, capital, thesis, sizing }).status).toBe('sized');
  });

  it('a zero capital requirement is not admissible', () => {
    const capital: OptimizedStrategyCapital = {
      requirement: 0,
      method: 'long-premium',
      maxLoss: 0,
      assumptions: { conventionsVersion: 'x' },
      diagnostics: { warnings: [] },
    };
    expect(
      resolveCandidateKelly({ nodes: NODES, capital, thesis: { volatility: 0.3 }, sizing }),
    ).toEqual({
      status: 'not-admissible',
      reason: 'zero-capital',
    });
  });

  it('isUnboundedDownsideUnderSupport: only null-maxLoss under unbounded (lognormal) support', () => {
    const unbounded = capitalFor([{ type: 'call', quantity: -1, strike: 105, premium: 3 }]);
    const bounded = capitalFor([{ type: 'put', quantity: -1, strike: 95, premium: 2 }]);
    expect(isUnboundedDownsideUnderSupport(unbounded, { volatility: 0.3 })).toBe(true);
    expect(
      isUnboundedDownsideUnderSupport(unbounded, {
        volatility: 0.3,
        pdf: () => 1,
        pdfRange: { from: 80, to: 120 },
      }),
    ).toBe(false);
    expect(isUnboundedDownsideUnderSupport(bounded, { volatility: 0.3 })).toBe(false);
  });
});

describe('optimizer Kelly sizes on dimensionless returns', () => {
  it('scaling all P&L and the capital requirement by the same factor leaves Kelly unchanged', () => {
    const capital = capitalFor([{ type: 'put', quantity: -1, strike: 95, premium: 2 }]);
    const baseV = resolveCandidateKelly({
      nodes: NODES,
      capital,
      thesis: { volatility: 0.3 },
      sizing: { enabled: true },
    });
    const k = 7.3;
    const scaled = resolveCandidateKelly({
      nodes: NODES.map((n) => ({ ...n, pnl: n.pnl * k })),
      capital: { ...capital, requirement: capital.requirement * k },
      thesis: { volatility: 0.3 },
      sizing: { enabled: true },
    });
    if (baseV.status !== 'sized' || scaled.status !== 'sized') throw new Error('expected sized');
    expect(scaled.sizing.fullKelly).toBeCloseTo(baseV.sizing.fullKelly!, 9);
    expect(scaled.sizing.recommendedFraction).toBeCloseTo(baseV.sizing.recommendedFraction!, 9);
  });

  it('matches a direct kellyBet on the same dimensionless outcomes', () => {
    const capital = capitalFor([{ type: 'put', quantity: -1, strike: 95, premium: 2 }]);
    const v = resolveCandidateKelly({
      nodes: NODES,
      capital,
      thesis: { volatility: 0.3 },
      sizing: { enabled: true, fraction: 0.5 },
    });
    const direct = kellyBet({
      edge: {
        outcomes: NODES.map((n) => ({
          probability: n.probability,
          payoff: n.pnl / capital.requirement,
        })),
      },
      fraction: 0.5,
    });
    if (v.status !== 'sized') throw new Error('expected sized');
    expect(v.sizing.recommendedFraction).toEqual(direct.recommendedFraction);
    expect(v.sizing.fullKelly).toEqual(direct.fullKelly);
  });
});
