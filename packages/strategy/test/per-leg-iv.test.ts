import { describe, expect, it } from 'vitest';
import { type Leg, type MarkToMarketInput, strategyOf } from '@totalfinance/strategy';

const asOf = Date.UTC(2026, 0, 1, 21);
const base = { asOf, expiry: '2026-04-01', riskFreeRate: 0.04, dividendYield: 0 };
const spot = 100;
const mkt = (volatility: number): MarkToMarketInput => ({ spot, volatility, ...base });

// An iron condor with four DISTINCT per-leg IVs — the real-chain case that a single position vol
// cannot mark correctly.
const condor: Leg[] = [
  { kind: 'put', strike: 90, premium: 1.0, quantity: 1, impliedVolatility: 0.28 },
  { kind: 'put', strike: 95, premium: 2.2, quantity: -1, impliedVolatility: 0.26 },
  { kind: 'call', strike: 105, premium: 2.0, quantity: -1, impliedVolatility: 0.22 },
  { kind: 'call', strike: 110, premium: 0.9, quantity: 1, impliedVolatility: 0.2 },
];

describe('WS7.1 per-leg IV in mark-to-market', () => {
  it('a 4-leg position with distinct IVs equals the sum of four single-leg positions at their own IV', () => {
    const combined = strategyOf(condor).value(mkt(0.2));
    let pnl = 0;
    let delta = 0;
    let vega = 0;
    for (const leg of condor) {
      // Each leg carries its own iv, so the (deliberately absurd) position vol is ignored.
      const one = strategyOf([leg]).value(mkt(999));
      pnl += one.pnl;
      delta += one.greeks.delta;
      vega += one.greeks.vega;
    }
    expect(combined.pnl).toBeCloseTo(pnl, 9);
    expect(combined.greeks.delta).toBeCloseTo(delta, 9);
    expect(combined.greeks.vega).toBeCloseTo(vega, 9);
    expect(combined.assumptions.volatilitySource).toBe('perLeg');
  });

  it('a per-leg IV overrides the position vol (impliedVolatility 0.2 ≡ position vol 0.2, whatever the position vol)', () => {
    const withImpliedVolatility = strategyOf(
      condor.map((l) => (l.kind === 'stock' ? l : { ...l, impliedVolatility: 0.2 })),
    ).value(mkt(0.9));
    const noImpliedVolatility = strategyOf([
      { kind: 'put', strike: 90, premium: 1.0, quantity: 1 },
      { kind: 'put', strike: 95, premium: 2.2, quantity: -1 },
      { kind: 'call', strike: 105, premium: 2.0, quantity: -1 },
      { kind: 'call', strike: 110, premium: 0.9, quantity: 1 },
    ]).value(mkt(0.2));
    expect(withImpliedVolatility.pnl).toBeCloseTo(noImpliedVolatility.pnl, 12);
    expect(withImpliedVolatility.greeks.delta).toBeCloseTo(noImpliedVolatility.greeks.delta, 12);
    expect(withImpliedVolatility.greeks.vega).toBeCloseTo(noImpliedVolatility.greeks.vega, 12);
    expect(withImpliedVolatility.assumptions.volatilitySource).toBe('perLeg');
    expect(noImpliedVolatility.assumptions.volatilitySource).toBe('position');
  });

  it('reports volatilitySource "mixed" and prices the IV-less legs at the position vol', () => {
    const legWithImpliedVolatility: Leg = {
      kind: 'call',
      strike: 105,
      premium: 2.0,
      quantity: -1,
      impliedVolatility: 0.22,
    };
    const legNoImpliedVolatility: Leg = { kind: 'call', strike: 110, premium: 0.9, quantity: 1 };
    const r = strategyOf([legWithImpliedVolatility, legNoImpliedVolatility]).value(mkt(0.2));
    expect(r.assumptions.volatilitySource).toBe('mixed');
    const impliedVolatilityPart = strategyOf([legWithImpliedVolatility]).value(mkt(999));
    const noImpliedVolatilityPart = strategyOf([legNoImpliedVolatility]).value(mkt(0.2));
    expect(r.pnl).toBeCloseTo(impliedVolatilityPart.pnl + noImpliedVolatilityPart.pnl, 9);
  });

  it('does not require a position vol when every future option leg carries its own IV', () => {
    // `vol` is omitted at runtime (a JS caller path); with all-IV legs it is never consulted.
    const noVolatilityMarket = { spot, ...base } as unknown as MarkToMarketInput;
    const r = strategyOf(condor).value(noVolatilityMarket);
    expect(Number.isFinite(r.pnl)).toBe(true);
    expect(r.assumptions.volatilitySource).toBe('perLeg');
  });
});
