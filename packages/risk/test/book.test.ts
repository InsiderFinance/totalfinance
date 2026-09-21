/**
 * Portfolio book / risk aggregation (§12.2) — `analyzeBook` composes marking + greeks aggregation +
 * beta-weighted delta + margin + concentration + optional scenario P&L over a book of strategy
 * positions. Verifies the aggregation identities, grouping, beta-weighting, margin totals, the
 * scenario roll-up, and guards.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { legs, strategy } from '@totalfinance/strategy';
import { analyzeBook, scenario, shock, type BookPosition } from '@totalfinance/risk';

const EXPIRY = '2026-06-19';

/** A net-short (credit) put spread — positive delta, defined risk. */
function bullPutSpread(): ReturnType<typeof strategy> {
  return strategy(
    [
      legs.put({ strike: 95, premium: 2.0, quantity: -1 }),
      legs.put({ strike: 90, premium: 1.0, quantity: 1 }),
    ],
    { multiplier: 100, expiry: EXPIRY },
  );
}
function bearCallSpread(): ReturnType<typeof strategy> {
  return strategy(
    [
      legs.call({ strike: 105, premium: 2.0, quantity: -1 }),
      legs.call({ strike: 110, premium: 1.0, quantity: 1 }),
    ],
    { multiplier: 100, expiry: EXPIRY },
  );
}

const MKT = {
  spot: 100,
  volatility: 0.2,
  riskFreeRate: 0.04,
  asOf: '2026-05-01T00:00:00Z',
} as const;

describe('analyzeBook — aggregation identities', () => {
  const book: BookPosition[] = [
    { position: bullPutSpread(), market: MKT, id: 'xyz-puts', underlying: 'XYZ' },
    { position: bearCallSpread(), market: MKT, id: 'xyz-calls', underlying: 'XYZ' },
    { position: bullPutSpread(), market: { ...MKT, spot: 50 }, id: 'abc-puts', underlying: 'ABC' },
  ];

  it('net greeks and value are the sum of the per-position rows', () => {
    const r = analyzeBook(book);
    for (const k of ['delta', 'gamma', 'vega', 'theta', 'rho'] as const) {
      const sum = r.byPosition.reduce((a, p) => a + p.greeks[k], 0);
      expect(r.greeks[k]).toBeCloseTo(sum, 8);
    }
    expect(r.value).toBeCloseTo(
      r.byPosition.reduce((a, p) => a + p.value, 0),
      8,
    );
    expect(r.margin.total).toBeCloseTo(
      r.byPosition.reduce((a, p) => a + p.margin, 0),
      8,
    );
  });

  it('groups by underlying, summing greeks/value/margin per name', () => {
    const r = analyzeBook(book);
    expect(r.byUnderlying.map((u) => u.underlying).sort()).toEqual(['ABC', 'XYZ']);
    const xyz = r.byUnderlying.find((u) => u.underlying === 'XYZ')!;
    // XYZ has the two XYZ positions.
    const xyzPositions = r.byPosition.filter((p) => p.underlying === 'XYZ');
    expect(xyz.value).toBeCloseTo(
      xyzPositions.reduce((a, p) => a + p.value, 0),
      8,
    );
    expect(xyz.margin).toBeCloseTo(
      xyzPositions.reduce((a, p) => a + p.margin, 0),
      8,
    );
  });

  it('margin is positive for defined-risk credit spreads', () => {
    const r = analyzeBook(book);
    expect(r.margin.total).toBeGreaterThan(0);
    expect(r.byPosition.every((p) => p.definedRisk)).toBe(true);
  });
});

describe('analyzeBook — beta-weighted delta', () => {
  it('is present only with an index price, and matches Σ δ·spot·β / indexPrice', () => {
    const book: BookPosition[] = [
      { position: bullPutSpread(), market: MKT, underlying: 'XYZ', beta: 1.2 },
      { position: bearCallSpread(), market: { ...MKT, spot: 50 }, underlying: 'ABC', beta: 0.8 },
    ];
    expect(analyzeBook(book).betaWeightedDelta).toBeUndefined();

    const r = analyzeBook(book, { indexPrice: 500 });
    expect(r.betaWeightedDelta).toBeDefined();
    const expectedDollar = r.byPosition.reduce((a, p, i) => {
      const beta = book[i]!.beta!;
      const spot = book[i]!.market.spot;
      return a + p.greeks.delta * spot * beta;
    }, 0);
    expect(r.betaWeightedDelta!.dollarDelta).toBeCloseTo(expectedDollar, 6);
    expect(r.betaWeightedDelta!.indexDelta).toBeCloseTo(expectedDollar / 500, 6);
  });
});

describe('analyzeBook — concentration', () => {
  it('a one-name book is maximally concentrated; a balanced two-name book is not', () => {
    const oneName = analyzeBook([
      { position: bullPutSpread(), market: MKT, underlying: 'XYZ' },
      { position: bearCallSpread(), market: MKT, underlying: 'XYZ' },
    ]);
    expect(oneName.concentration.hhi).toBeCloseTo(1, 6); // all margin in one name
    expect(oneName.concentration.effectiveCount).toBeCloseTo(1, 6);

    const twoNames = analyzeBook([
      { position: bullPutSpread(), market: MKT, underlying: 'XYZ' },
      { position: bullPutSpread(), market: MKT, underlying: 'ABC' },
    ]);
    expect(twoNames.concentration.hhi).toBeLessThan(oneName.concentration.hhi);
    expect(twoNames.concentration.effectiveCount).toBeGreaterThan(1.5);
  });
});

describe('analyzeBook — scenario roll-up', () => {
  it('stresses the book under scenarios; a positive-delta book loses on a spot drop', () => {
    const book: BookPosition[] = [{ position: bullPutSpread(), market: MKT, underlying: 'XYZ' }];
    const r = analyzeBook(book, { scenarios: [scenario('down5', shock.spot('-5%'))] });
    expect(r.scenarios).toHaveLength(1);
    expect(r.scenarios![0]!.scenario).toBe('down5');
    // The book is net long delta (short put spread), so a -5% spot move is a loss.
    expect(r.greeks.delta).toBeGreaterThan(0);
    expect(r.scenarios![0]!.pnl).toBeLessThan(0);
  });
});

describe('analyzeBook — stock-covered structures use stock-inclusive margin', () => {
  // Covered call: long 100 shares @ 100 + short 105 call. The stock cover caps the risk, so it is
  // defined-risk with the position's own (bounded) max loss as margin — NOT a naked short call.
  const coveredCall = strategy(
    [
      { kind: 'stock', price: 100, quantity: 100 },
      { kind: 'call', strike: 105, premium: 2, quantity: -1 },
    ],
    { multiplier: 100, expiry: EXPIRY },
  );

  it('a covered call is defined-risk with max-loss margin, not a naked short', () => {
    const r = analyzeBook([{ position: coveredCall, market: MKT, underlying: 'XYZ' }]);
    const row = r.byPosition[0]!;
    expect(row.definedRisk).toBe(true); // was false (seen as a naked call) before the fix
    // Margin is the position's own stock-inclusive max loss, far above a naked-call Reg-T (~$1.8k).
    expect(row.margin).toBeCloseTo(-coveredCall.metrics().maxLoss!, 6);
    expect(row.margin).toBeGreaterThan(5000);
  });
});

describe('analyzeBook — a zero-margin book never leaks NaN', () => {
  it('a stock-only book reports neutral concentration (effectiveCount 0, not NaN)', () => {
    const stockOnly = strategy([{ kind: 'stock', price: 100, quantity: 100 }], {
      multiplier: 100,
      expiry: EXPIRY,
    });
    const r = analyzeBook([{ position: stockOnly, market: MKT, underlying: 'XYZ' }]);
    expect(r.margin.total).toBe(0);
    expect(Number.isNaN(r.concentration.effectiveCount)).toBe(false);
    expect(r.concentration.effectiveCount).toBe(0);
    expect(r.concentration.hhi).toBe(0);
  });
});

describe('analyzeBook — value is net P&L (since entry), not liquidation NAV', () => {
  it('a single position value equals Position.value().pnl', () => {
    const longCall = strategy(
      [{ kind: 'call', strike: 100, quantity: 1, premium: 3, impliedVolatility: 0.2 }],
      {
        multiplier: 100,
        expiry: EXPIRY,
      },
    );
    const market = { spot: 105, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' } as const;
    const r = analyzeBook([{ position: longCall, market, underlying: 'XYZ' }]);
    expect(r.value).toBeCloseTo(longCall.value(market).pnl, 6);
    // net P&L is not the mark/NAV: a 3.00 call now worth ~5 is +2 P&L, not ~5.
    expect(r.value).toBeLessThan(longCall.value(market).pnl + 1);
  });
});

describe('analyzeBook — envelope & guards', () => {
  it('an empty book returns zeros and a valid envelope', () => {
    const r = analyzeBook([]);
    expect(r.value).toBe(0);
    expect(r.greeks).toEqual({ delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 });
    expect(r.margin.total).toBe(0);
    expect(r.byPosition).toHaveLength(0);
    expect(r.assumptions.conventionsVersion).toBeDefined();
    expect(r.diagnostics.engine).toBe('portfolio-book');
  });

  it('throws typed errors on garbage (never a raw crash)', () => {
    expect(() => analyzeBook(undefined as never)).toThrowError();
    try {
      analyzeBook([{ position: {}, market: MKT } as never]);
      expect.unreachable('a non-Position should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
  });
});
