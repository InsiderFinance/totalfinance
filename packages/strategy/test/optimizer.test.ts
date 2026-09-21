/**
 * Strategy optimizer (`optimizeStrategy`). Verifies that scoring under a thesis makes bullish structures
 * win a bullish view (and bearish a bearish view), that a tight thesis collapses thesisEv to the payoff
 * at the target, the expected-P&L-bounded-by-payoff invariant, multi-expiry search, the filters, that
 * the top candidate is materializable, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { isoDateToEpochMs, isQuantError } from '@totalfinance/core';
import {
  optimizeStrategy,
  strategy,
  type OptimizerExpiry,
  type ScanQuoteRow,
} from '@totalfinance/strategy';

const ASOF = isoDateToEpochMs('2026-05-01');
const E1 = '2026-06-20'; // ~50d
const E2 = '2026-07-18'; // ~78d
const RATE = 0.03;

/** Strikes only — the scanner prices each leg from the pricing `vol`. */
const chain = (): ScanQuoteRow[] =>
  [80, 85, 90, 95, 100, 105, 110, 115, 120].map((strike) => ({ strike }));
const expiry = (e: string): OptimizerExpiry => ({ expiry: e, chain: chain() });

const base = { spot: 100, asOf: ASOF, riskFreeRate: RATE, volatility: 0.25 } as const;

describe('optimizeStrategy — the thesis drives the ranking', () => {
  it('a bullish view ranks bull spreads above bear spreads (and vice versa)', () => {
    const bestOf = (target: number, structure: string) => {
      const r = optimizeStrategy({
        ...base,
        expiries: [expiry(E1)],
        thesis: { targetPrice: target, volatility: 0.2 },
        structures: ['bullCallSpread', 'bearCallSpread'],
        objective: 'thesisExpectedValue',
        top: 500,
      });
      return Math.max(
        ...r.candidates.filter((c) => c.structure === structure).map((c) => c.thesisExpectedValue),
      );
    };
    // Target 115 (bullish): the best bull call spread beats the best bear call spread on expected P&L.
    expect(bestOf(115, 'bullCallSpread')).toBeGreaterThan(bestOf(115, 'bearCallSpread'));
    // Target 85 (bearish): the ordering flips.
    expect(bestOf(85, 'bearCallSpread')).toBeGreaterThan(bestOf(85, 'bullCallSpread'));
  });

  it('a tight thesis collapses thesisExpectedValue to the payoff at the target', () => {
    const target = 108; // between strikes → a linear payoff region
    const r = optimizeStrategy({
      ...base,
      expiries: [expiry(E1)],
      thesis: { targetPrice: target, volatility: 0.005 }, // near a point mass at 108
      objective: 'thesisExpectedValue',
      top: 5,
    });
    const top = r.candidates[0]!;
    const payoffAtTarget = strategy(top.legs).pnlAtExpiry(target);
    expect(top.thesisExpectedValue).toBeCloseTo(payoffAtTarget, 1); // ~equal for a near-degenerate thesis
  });
});

describe('optimizeStrategy — invariants', () => {
  it('expected P&L is bounded by the payoff: maxLoss ≤ thesisExpectedValue ≤ maxProfit', () => {
    const r = optimizeStrategy({
      ...base,
      expiries: [expiry(E1)],
      thesis: { targetPrice: 103, volatility: 0.3 },
      top: 300,
    });
    for (const c of r.candidates) {
      expect(c.thesisExpectedValue).toBeGreaterThanOrEqual(c.maxLoss! - 1e-6);
      if (Number.isFinite(c.maxProfit))
        expect(c.thesisExpectedValue).toBeLessThanOrEqual(c.maxProfit! + 1e-6);
      expect(c.thesisProbabilityOfProfit).toBeGreaterThanOrEqual(0);
      expect(c.thesisProbabilityOfProfit).toBeLessThanOrEqual(1);
    }
  });
});

describe('optimizeStrategy — search space & filters', () => {
  it('searches across multiple expiries', () => {
    const r = optimizeStrategy({
      ...base,
      expiries: [expiry(E1), expiry(E2)],
      thesis: { targetPrice: 110, volatility: 0.2 },
      top: 1000,
    });
    expect(new Set(r.candidates.map((c) => c.expiry))).toEqual(new Set([E1, E2]));
    expect(r.assumptions.expiries).toBe(2);
  });

  it('respects maxRisk and minThesisProbabilityOfProfit filters', () => {
    const r = optimizeStrategy({
      ...base,
      expiries: [expiry(E1)],
      thesis: { targetPrice: 105, volatility: 0.2 },
      maxRisk: 300, // per contract
      minThesisProbabilityOfProfit: 0.5,
      top: 200,
    });
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(Math.abs(c.maxLoss!)).toBeLessThanOrEqual(300 + 1e-6);
      expect(c.thesisProbabilityOfProfit).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('the top candidate is materializable (strategy(legs) reproduces its max loss)', () => {
    const r = optimizeStrategy({
      ...base,
      expiries: [expiry(E1)],
      thesis: { targetPrice: 112, volatility: 0.2 },
      top: 1,
    });
    const top = r.candidates[0]!;
    expect(strategy(top.legs).metrics().maxLoss).toBeCloseTo(top.maxLoss!, 6);
  });
});

describe('optimizeStrategy — envelope & guards', () => {
  it('throws on garbage, empty expiries, a bad thesis, objective, and top', () => {
    expect(() => optimizeStrategy(undefined as never)).toThrowError();
    expect(() =>
      optimizeStrategy({ ...base, expiries: [], thesis: { volatility: 0.2 } }),
    ).toThrowError();
    try {
      optimizeStrategy({ ...base, expiries: [expiry(E1)], thesis: { volatility: -0.1 } });
      expect.unreachable('a non-positive thesis vol should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
    expect(() =>
      optimizeStrategy({
        ...base,
        expiries: [expiry(E1)],
        thesis: { volatility: 0.2 },
        objective: 'nope' as never,
      }),
    ).toThrowError();
    expect(() =>
      optimizeStrategy({ ...base, expiries: [expiry(E1)], thesis: { volatility: 0.2 }, top: 0 }),
    ).toThrowError();
  });
});

describe('optimizeStrategy — custom pdf integrates over its explicit range (review fix)', () => {
  const lognormPdf = (S: number, center: number, sigma: number): number =>
    S > 0 ? Math.exp(-(Math.log(S / center) ** 2) / (2 * sigma * sigma)) / (S * sigma) : 0;
  // A bimodal earnings view — 50% near 88, 50% near 132 (the canonical escape-hatch use).
  const bimodal = (S: number): number =>
    0.5 * lognormPdf(S, 88, 0.03) + 0.5 * lognormPdf(S, 132, 0.03);

  it('honors pdfRange — a bimodal high mode is not silently truncated', () => {
    const run = (from: number, to: number) =>
      optimizeStrategy({
        ...base,
        expiries: [expiry(E1)],
        thesis: { volatility: 0.1, pdf: bimodal, pdfRange: { from, to } },
        structures: ['bullCallSpread'],
        objective: 'thesisExpectedValue',
        top: 500,
      });
    const full = run(60, 200); // covers BOTH modes (88 and 132)
    const truncated = run(60, 110); // excludes the winning 132 mode
    const bestFull = Math.max(...full.candidates.map((c) => c.thesisExpectedValue));
    const bestTrunc = Math.max(...truncated.candidates.map((c) => c.thesisExpectedValue));
    expect(bestFull).toBeGreaterThan(bestTrunc); // including the high mode raises the bull-spread EV
    for (const c of full.candidates) {
      expect(c.thesisExpectedValue).toBeGreaterThanOrEqual(c.maxLoss! - 1e-6);
      expect(c.thesisExpectedValue).toBeLessThanOrEqual(c.maxProfit! + 1e-6);
    }
  });

  it('a custom pdf without pdfRange throws (no hidden σ-window)', () => {
    expect(() =>
      optimizeStrategy({
        ...base,
        expiries: [expiry(E1)],
        thesis: { volatility: 0.2, pdf: bimodal },
      }),
    ).toThrowError();
  });

  it('rejects a non-finite pdfRange bound (would otherwise silently zero every EV)', () => {
    const withRange = (range: { from: number; to: number }) =>
      optimizeStrategy({
        ...base,
        expiries: [expiry(E1)],
        thesis: { volatility: 0.2, pdf: bimodal, pdfRange: range },
      });
    expect(() => withRange({ from: 50, to: Infinity })).toThrowError(); // the confirmed gap
    expect(() => withRange({ from: Infinity, to: 200 })).toThrowError();
    expect(() => withRange({ from: 50, to: NaN })).toThrowError();
  });
});
