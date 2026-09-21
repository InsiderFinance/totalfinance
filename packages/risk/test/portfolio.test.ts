/** Tests for portfolio-level risk approximations: concentration, liquidity, margin, Greeks. */

import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import {
  aggregateGreeks,
  betaWeightedDelta,
  concentration,
  liquidity,
  margin,
  marketImpact,
  nakedCallMargin,
  nakedPutMargin,
  optionsMargin,
} from '@totalfinance/risk/portfolio';

describe('concentration', () => {
  it('equal weights ⇒ HHI = 1/n, effectiveCount = n, Gini = 0', () => {
    const c = concentration([0.25, 0.25, 0.25, 0.25]);
    expect(c.hhi).toBeCloseTo(0.25, 12);
    expect(c.effectiveCount).toBeCloseTo(4, 12);
    expect(c.gini).toBeCloseTo(0, 12);
    expect(c.topWeight).toBeCloseTo(0.25, 12);
  });

  it('a single dominant name ⇒ HHI → 1, effectiveCount → 1', () => {
    const c = concentration([1, 0, 0, 0]);
    expect(c.hhi).toBeCloseTo(1, 12);
    expect(c.effectiveCount).toBeCloseTo(1, 12);
    expect(c.topWeight).toBeCloseTo(1, 12);
    expect(c.gini).toBeCloseTo((4 - 1) / 4, 12); // Gini of a one-hot of length n is (n-1)/n
  });

  it('uses gross (|w|) shares so a long/short book is measured on exposure', () => {
    const c = concentration([0.5, -0.5]);
    expect(c.hhi).toBeCloseTo(0.5, 12); // two equal gross shares
    expect(c.effectiveCount).toBeCloseTo(2, 12);
  });

  it('top-k share sums the k largest names', () => {
    const c = concentration([0.4, 0.3, 0.2, 0.1], { topK: 2 });
    expect(c.topKShare).toBeCloseTo(0.7, 12);
  });

  it('throws on empty weights rather than returning a NaN-struct (WS2.7d)', () => {
    expect(() => concentration([])).toThrow(InputError);
  });
});

describe('liquidity', () => {
  it('days-to-liquidate = (size/averageDailyVolume) / participation; book takes the slowest name', () => {
    const r = liquidity(
      [
        { size: 10_000, averageDailyVolume: 100_000 }, // 0.1 ADV ⇒ 0.5 days at 20%
        { size: 50_000, averageDailyVolume: 100_000 }, // 0.5 ADV ⇒ 2.5 days at 20%
      ],
      { participation: 0.2 },
    );
    expect(r.perAsset[0]!.daysToLiquidate).toBeCloseTo(0.5, 12);
    expect(r.perAsset[1]!.daysToLiquidate).toBeCloseTo(2.5, 12);
    expect(r.portfolioDaysToLiquidate).toBeCloseTo(2.5, 12);
  });

  it('square-root market impact grows with size and volatility', () => {
    const small = marketImpact({ size: 10_000, averageDailyVolume: 1_000_000, volatility: 0.2 });
    const big = marketImpact({ size: 40_000, averageDailyVolume: 1_000_000, volatility: 0.2 });
    expect(big).toBeCloseTo(2 * small, 12); // 4× size ⇒ 2× impact (√ law)
    expect(
      marketImpact({ size: 10_000, averageDailyVolume: 1_000_000, volatility: 0.4 }),
    ).toBeCloseTo(2 * small, 12); // 2× vol ⇒ 2× impact
    // The explained companion echoes the applied coefficient default (dx §2.4).
    const explained = marketImpact.explain({
      size: 10_000,
      averageDailyVolume: 1_000_000,
      volatility: 0.2,
    });
    expect(explained.value).toBe(small);
    expect(explained.assumptions.coefficient).toBe(1);
    expect(explained.diagnostics.warnings).toEqual([]);
  });

  it('rejects non-positive ADV and out-of-range participation', () => {
    expect(() => liquidity([{ size: 1, averageDailyVolume: 0 }])).toThrow(/averageDailyVolume/);
    expect(() => liquidity([{ size: 1, averageDailyVolume: 10 }], { participation: 2 })).toThrow(
      /participation/,
    );
  });

  it('marketImpact rejects a NaN size and a negative volatility/coefficient', () => {
    expect(() =>
      marketImpact({ size: NaN, averageDailyVolume: 1_000_000, volatility: 0.2 }),
    ).toThrow(/size/);
    expect(() =>
      marketImpact({ size: 10_000, averageDailyVolume: 1_000_000, volatility: -0.2 }),
    ).toThrow(/vol/);
    expect(() =>
      marketImpact(
        { size: 10_000, averageDailyVolume: 1_000_000, volatility: 0.2 },
        { coefficient: -1 },
      ),
    ).toThrow(/coefficient/);
  });
});

describe('margin', () => {
  it('computes gross/net/long/short, Reg-T margins, and leverage', () => {
    const r = margin([60_000, -40_000], { equity: 50_000 });
    expect(r.grossExposure).toBe(100_000);
    expect(r.netExposure).toBe(20_000);
    expect(r.longExposure).toBe(60_000);
    expect(r.shortExposure).toBe(40_000);
    expect(r.initialMargin).toBe(50_000); // 50% of gross
    expect(r.maintenanceMargin).toBe(25_000); // 25% of gross
    expect(r.leverage).toBeCloseTo(2, 12);
    expect(r.meetsMaintenance).toBe(true);
  });

  it('flags a maintenance breach', () => {
    const r = margin([200_000], { equity: 40_000, maintenanceRate: 0.25 });
    expect(r.maintenanceMargin).toBe(50_000);
    expect(r.meetsMaintenance).toBe(false);
  });

  it('rejects non-positive equity', () => {
    expect(() => margin([1], { equity: 0 })).toThrow(/equity/);
  });

  it('rejects a negative/NaN initial or maintenance rate (PR review)', () => {
    expect(() => margin([1], { equity: 100, initialRate: -0.5 })).toThrow(/initialRate/);
    expect(() => margin([1], { equity: 100, maintenanceRate: Number.NaN })).toThrow(
      /maintenanceRate/,
    );
  });
});

describe('options margin / buying-power (§15.3)', () => {
  it('naked call: premium + max(20%·U − OTM, 10%·U), × 100', () => {
    // U=100, K=105 (5 OTM), premium 2 ⇒ 2 + max(20−5, 10) = 17/sh ⇒ $1700/contract.
    expect(nakedCallMargin({ spot: 100, strike: 105, premium: 2 })).toBeCloseTo(1700, 9);
    // Deep OTM hits the 10% floor: K=150 ⇒ OTM 50, 20−50<0 ⇒ floor 10 ⇒ (2+10)·100 = 1200.
    expect(nakedCallMargin({ spot: 100, strike: 150, premium: 2 })).toBeCloseTo(1200, 9);
    // The envelope echoes the applied Reg-T defaults (dx §2.4).
    const env = nakedCallMargin.explain({ spot: 100, strike: 105, premium: 2 });
    expect(env.assumptions).toMatchObject({ multiplier: 100, equityRate: 0.2, floorRate: 0.1 });
  });

  it('naked put: floor is 10% of the strike', () => {
    // U=100, K=95 (5 OTM), premium 2 ⇒ 2 + max(20−5, 9.5) = 17/sh ⇒ $1700.
    expect(nakedPutMargin({ spot: 100, strike: 95, premium: 2 })).toBeCloseTo(1700, 9);
  });

  it('a debit vertical is defined-risk: margin = net debit = max loss', () => {
    const r = optionsMargin(
      [
        { type: 'call', quantity: 1, strike: 100, premium: 5 },
        { type: 'call', quantity: -1, strike: 110, premium: 1.5 },
      ],
      { spot: 100 },
    );
    expect(r.definedRisk).toBe(true);
    expect(r.netDebit).toBeCloseTo(350, 9); // (5 − 1.5) × 100
    expect(r.maxLoss).toBeCloseTo(350, 9);
    expect(r.initialMargin).toBeCloseTo(350, 9);
    expect(r.method).toBe('defined-risk-max-loss');
  });

  it('a credit vertical is defined-risk: margin = width − credit', () => {
    // Short 95 put / long 90 put, net credit 1.2 ⇒ max loss (5 − 1.2)·100 = 380.
    const r = optionsMargin(
      [
        { type: 'put', quantity: -1, strike: 95, premium: 2 },
        { type: 'put', quantity: 1, strike: 90, premium: 0.8 },
      ],
      { spot: 100 },
    );
    expect(r.definedRisk).toBe(true);
    expect(r.netDebit).toBeCloseTo(-120, 9); // credit received
    expect(r.maxLoss).toBeCloseTo(380, 9);
    expect(r.initialMargin).toBeCloseTo(380, 9);
  });

  it('a long option is fully paid: buying-power reduction = debit', () => {
    const r = optionsMargin([{ type: 'call', quantity: 1, strike: 100, premium: 5 }], {
      spot: 100,
    });
    expect(r.method).toBe('long-premium');
    expect(r.maxLoss).toBeCloseTo(500, 9);
    expect(r.buyingPowerReduction).toBeCloseTo(500, 9);
  });

  it('a naked short call is unbounded: Reg-T naked requirement, max loss null-with-reason', () => {
    const r = optionsMargin([{ type: 'call', quantity: -1, strike: 105, premium: 2 }], {
      spot: 100,
    });
    expect(r.definedRisk).toBe(false);
    // Law 7: `Infinity` is not JSON-safe — the unbounded loss is null, discriminated by
    // `definedRisk: false` and explained by a `risk.unbounded_loss` warning.
    expect(r.maxLoss).toBeNull();
    expect(r.diagnostics.warnings.map((w) => w.code)).toContain('risk.unbounded_loss');
    expect(r.method).toBe('reg-t-naked');
    expect(r.initialMargin).toBeCloseTo(nakedCallMargin({ spot: 100, strike: 105, premium: 2 }), 9);
  });

  it('[P2] an uncovered short put is margined at Reg-T, not as if it were cash-secured', () => {
    // Short 95 put, spot 100, premium 2. Reg-T naked = (2 + max(20 − 5, 9.5)) × 100 = $1,700.
    // This used to report the CASH-SECURED (95 − 2) × 100 = $9,300 — 5.5× a margin account's
    // actual requirement — because a short put's loss is bounded and the "defined risk" branch
    // charged the whole capped max loss.
    const r = optionsMargin([{ type: 'put', quantity: -1, strike: 95, premium: 2 }], { spot: 100 });
    expect(r.method).toBe('reg-t-naked-put');
    expect(r.initialMargin).toBeCloseTo(nakedPutMargin({ spot: 100, strike: 95, premium: 2 }), 9);
    expect(r.initialMargin).toBeCloseTo(1700, 9);
    expect(r.buyingPowerReduction).toBeCloseTo(1700, 9);
    // maxLoss is a property of the POSITION, not of the margin basis — unchanged.
    expect(r.maxLoss).toBeCloseTo(9300, 9);
    expect(r.definedRisk).toBe(true);
    expect(r.assumptions['putMarginBasis']).toBe('reg-t-naked');
    expect(r.diagnostics.warnings.some((w) => /uncovered put contract/.test(w.message))).toBe(true);
  });

  it("[P2] putMarginBasis: 'cash-secured' opts back into the exercise-value requirement", () => {
    const r = optionsMargin([{ type: 'put', quantity: -1, strike: 95, premium: 2 }], {
      spot: 100,
      putMarginBasis: 'cash-secured',
    });
    expect(r.method).toBe('defined-risk-max-loss');
    expect(r.initialMargin).toBeCloseTo(9300, 9); // the pre-fix number, now opt-in
    expect(r.assumptions['putMarginBasis']).toBe('cash-secured');
    // and it applies to the naked branch too (a short strangle in a cash account)
    const strangle = optionsMargin(
      [
        { type: 'call', quantity: -1, strike: 110, premium: 1.5 },
        { type: 'put', quantity: -1, strike: 90, premium: 1.2 },
      ],
      { spot: 100, putMarginBasis: 'cash-secured' },
    );
    expect(strangle.method).toBe('reg-t-naked');
    expect(strangle.initialMargin).toBeCloseTo(
      nakedCallMargin({ spot: 100, strike: 110, premium: 1.5 }) + (90 - 1.2) * 100,
      9,
    );
  });

  it('rejects an unknown putMarginBasis rather than silently defaulting', () => {
    expect(() =>
      optionsMargin([{ type: 'put', quantity: -1, strike: 95, premium: 2 }], {
        spot: 100,
        putMarginBasis: 'portfolio-margin' as never,
      }),
    ).toThrow(/putMarginBasis/);
  });

  it('validates legs', () => {
    expect(() => optionsMargin([], { spot: 100 })).toThrow(/leg/);
    expect(() =>
      optionsMargin([{ type: 'x' as unknown as 'call', quantity: 1, strike: 100, premium: 1 }], {
        spot: 100,
      }),
    ).toThrow(/call.*put|type/);
  });

  it('rejects a negative multiplier / rate rather than emitting negative margin (PR review)', () => {
    expect(() =>
      nakedCallMargin({ spot: 100, strike: 105, premium: 2 }, { multiplier: -100 }),
    ).toThrow(/multiplier/);
    expect(() =>
      nakedPutMargin({ spot: 100, strike: 95, premium: 2 }, { equityRate: -0.2 }),
    ).toThrow(/equityRate/);
    expect(() =>
      nakedCallMargin({ spot: 100, strike: 105, premium: 2 }, { floorRate: -0.1 }),
    ).toThrow(/floorRate/);
    expect(() =>
      optionsMargin([{ type: 'call', quantity: 1, strike: 100, premium: 5 }], {
        spot: 100,
        multiplier: -1,
      }),
    ).toThrow(/multiplier/);
  });
});

describe('aggregateGreeks', () => {
  it('sums quantity-scaled Greeks across a mixed book', () => {
    const g = aggregateGreeks([
      {
        quantity: 10,
        greeks: { value: 5, delta: 0.5, gamma: 0.01, vega: 0.2, theta: -0.1, rho: 0.05 },
      },
      { quantity: -4, greeks: { value: 3, delta: -0.6, vega: 0.1 } }, // missing greeks count as 0
    ]).value;
    expect(g.value).toBeCloseTo(10 * 5 + -4 * 3, 12);
    expect(g.delta).toBeCloseTo(10 * 0.5 + -4 * -0.6, 12);
    expect(g.gamma).toBeCloseTo(10 * 0.01, 12);
    expect(g.vega).toBeCloseTo(10 * 0.2 + -4 * 0.1, 12);
    expect(g.theta).toBeCloseTo(10 * -0.1, 12);
    expect(g.rho).toBeCloseTo(10 * 0.05, 12);
  });

  it('defaults quantity to 1 and skips positions without Greeks', () => {
    const r = aggregateGreeks([{ greeks: { value: 2, delta: 1 } }, { quantity: 3 }]);
    expect(r.value.value).toBe(2);
    expect(r.value.delta).toBe(1);
    // The missing-greeks convention is disclosed on the envelope (dx §2.4).
    expect(r.assumptions).toMatchObject({ positions: 2, missingGreeks: 'counted-as-zero' });
  });
});

describe('betaWeightedDelta', () => {
  it('expresses book delta in index-equivalent shares', () => {
    const r = betaWeightedDelta(
      [
        { delta: 100, spot: 50, beta: 1.2 }, // $ delta 6000
        { delta: -30, spot: 200, beta: 0.8 }, // $ delta -4800
      ],
      { indexPrice: 400 },
    );
    expect(r.dollarDelta).toBeCloseTo(6000 - 4800, 9);
    expect(r.indexDelta).toBeCloseTo((6000 - 4800) / 400, 9); // 3 index-equivalent shares
    expect(r.perPosition[0]!.indexDelta).toBeCloseTo(15, 9);
  });

  it('rejects a non-positive index price', () => {
    expect(() => betaWeightedDelta([{ delta: 1, spot: 1, beta: 1 }], { indexPrice: 0 })).toThrow(
      /indexPrice/,
    );
  });
});

describe('Law 2 report grammar — margin / optionsMargin / betaWeightedDelta', () => {
  it('margin echoes the applied Reg-T rate defaults (50%/25%) and carries a warnings channel', () => {
    const r = margin([60_000, -40_000], { equity: 50_000 });
    expect(r.assumptions.conventionsVersion).toBeTruthy();
    expect(r.assumptions['initialRate']).toBe(0.5);
    expect(r.assumptions['maintenanceRate']).toBe(0.25);
    expect(r.assumptions['equity']).toBe(50_000);
    expect(r.assumptions['positions']).toBe(2);
    expect(r.diagnostics.warnings).toEqual([]);
    expect('value' in r).toBe(false); // report, not envelope
  });

  it('margin echoes explicit rates over the defaults', () => {
    const r = margin([100_000], { equity: 80_000, initialRate: 0.6, maintenanceRate: 0.3 });
    expect(r.assumptions['initialRate']).toBe(0.6);
    expect(r.assumptions['maintenanceRate']).toBe(0.3);
  });

  it('optionsMargin echoes the multiplier + Reg-T knob defaults; bounded risk carries no warning', () => {
    const r = optionsMargin(
      [
        { type: 'call', quantity: 1, strike: 100, premium: 5 },
        { type: 'call', quantity: -1, strike: 110, premium: 1.5 },
      ],
      { spot: 100 },
    );
    expect(r.assumptions['spot']).toBe(100);
    expect(r.assumptions['multiplier']).toBe(100);
    expect(r.assumptions['equityRate']).toBe(0.2);
    expect(r.assumptions['floorRate']).toBe(0.1);
    expect(r.assumptions['legs']).toBe(2);
    expect(r.diagnostics.warnings).toEqual([]);
  });

  it('betaWeightedDelta echoes the reference index price and position count', () => {
    const r = betaWeightedDelta([{ delta: 100, spot: 50, beta: 1.2 }], { indexPrice: 400 });
    expect(r.assumptions.conventionsVersion).toBeTruthy();
    expect(r.assumptions['indexPrice']).toBe(400);
    expect(r.assumptions['positions']).toBe(1);
    expect(r.diagnostics.warnings).toEqual([]);
  });
});
