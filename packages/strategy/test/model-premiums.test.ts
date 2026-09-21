import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  bullCallLadder,
  bullPutSpread,
  ironCondor,
  jadeLizard,
  legs,
  strategy,
} from '@totalfinance/strategy';

/**
 * DX3.1 — the profit-calculator user has strikes but no fills. Passing `{ premiums: 'model', market }`
 * prices every unpriced leg from the BSM engine, so breakevens / max P&L / probability-of-profit come
 * back from strikes ALONE — and `premiumSource: 'model'` keeps the result honest.
 */

const market = {
  spot: 570,
  volatility: 0.18,
  riskFreeRate: 0.045,
  asOf: '2026-07-06T00:00:00Z',
  expiry: '2026-08-21',
};
const condorLegs = () => [
  legs.put({ strike: 540, quantity: 1 }),
  legs.put({ strike: 550, quantity: -1 }),
  legs.call({ strike: 590, quantity: -1 }),
  legs.call({ strike: 600, quantity: 1 }),
];

describe('model-priced entry premiums (§3.4)', () => {
  it('prices unpriced legs from the market and reports premiumSource: model', () => {
    const pos = strategy(condorLegs(), { premiums: 'model', market });
    expect(pos.premiumSource).toBe('model');
    expect(pos.assumptions().premiumSource).toBe('model');
    for (const leg of pos.legs) expect(leg.premium).toBeGreaterThan(0);
    const m = pos.metrics();
    expect(m.breakevens.length).toBeGreaterThan(0);
    expect(Number.isFinite(m.maxProfit)).toBe(true);
    expect(Number.isFinite(m.maxLoss)).toBe(true);
  });

  it('prices a leg with its own impliedVolatility at THAT vol, so a chain-fed position opens flat', () => {
    // Entry priced at the position vol while value() marked at the leg vol opened every chain-fed
    // position with a phantom P&L. Both now use the same source, disclosed in assumptions.
    const legVol = 0.3;
    const pos = strategy(
      [
        legs.put({ strike: 540, quantity: 1, impliedVolatility: legVol }),
        legs.call({ strike: 600, quantity: -1, impliedVolatility: legVol }),
      ],
      { premiums: 'model', market },
    );
    expect(pos.assumptions().premiumVolatilitySource).toBe('leg');
    const opened = pos.value({ ...market });
    expect(Math.abs(opened.pnl)).toBeLessThan(1e-9);
    const atPositionVol = strategy(condorLegs(), { premiums: 'model', market });
    expect(atPositionVol.assumptions().premiumVolatilitySource).toBe('position');
    expect(Math.abs(atPositionVol.value({ ...market }).pnl)).toBeLessThan(1e-9);
    const mixed = strategy(
      [
        legs.put({ strike: 540, quantity: 1, impliedVolatility: legVol }),
        legs.call({ strike: 600, quantity: -1 }),
      ],
      { premiums: 'model', market },
    );
    expect(mixed.assumptions().premiumVolatilitySource).toBe('mixed');
    expect(Math.abs(mixed.value({ ...market }).pnl)).toBeLessThan(1e-9);
    // User premiums: no volatility source to disclose.
    expect(
      strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]).assumptions()
        .premiumVolatilitySource,
    ).toBeUndefined();
  });

  it('a call-site expiry that contradicts the position is refused with the typed code', () => {
    const pos = strategy(condorLegs(), { premiums: 'model', market });
    let caught: unknown;
    try {
      pos.probability({ ...market, expiry: '2026-12-18' });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught)).toBe(true);
    if (!isQuantError(caught)) throw new Error('unreachable');
    expect(caught.code).toBe('strategy.expiry_conflict');
    expect(caught.message).toContain('"2026-08-21"');
    expect(caught.message).toContain('strategy(legs, { expiry })');
    // The same expiry is not a contradiction; a position with undated options takes the horizon.
    expect(() => pos.probability({ ...market, expiry: '2026-08-21' })).not.toThrow();
    const undated = strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]);
    expect(() =>
      undated.probability({
        spot: 100,
        volatility: 0.2,
        riskFreeRate: 0.03,
        asOf: market.asOf,
        expiry: '2026-12-18',
      }),
    ).not.toThrow();
  });

  it('user-supplied premiums report premiumSource: user', () => {
    expect(strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })]).premiumSource).toBe(
      'user',
    );
  });

  it('preserves user premiums and models only the omitted legs', () => {
    const pos = strategy(
      [
        legs.call({ strike: 100, premium: 5, quantity: 1 }),
        legs.call({ strike: 110, quantity: -1 }),
      ],
      { premiums: 'model', market: { ...market, expiry: '2026-08-21' } },
    );
    expect(pos.premiumSource).toBe('model');
    expect(pos.legs[0]!.premium).toBe(5); // user premium preserved
    expect(pos.legs[1]!.premium).toBeGreaterThan(0); // modeled
  });

  it('throws a teaching error when a premium is missing and no model market is given', () => {
    let caught: unknown;
    try {
      strategy([legs.call({ strike: 100, quantity: 1 })]);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.missing_field')).toBe(true);
    expect((caught as Error).message).toContain("premiums: 'model'");
  });

  it('the named StrikeLeg builders accept strikes alone (no premiums) with a model market', () => {
    // Ladder: three strikes, no fills.
    const ladder = bullCallLadder(
      { lower: { strike: 550 }, middle: { strike: 570 }, upper: { strike: 590 } },
      { premiums: 'model', market },
    );
    expect(ladder.premiumSource).toBe('model');
    for (const leg of ladder.legs) expect(leg.premium).toBeGreaterThan(0);
    // Jade lizard: short put + short call + long call, no fills.
    const jade = jadeLizard(
      { put: { strike: 540 }, shortCall: { strike: 590 }, longCall: { strike: 600 } },
      { premiums: 'model', market },
    );
    expect(jade.premiumSource).toBe('model');
    expect(Number.isFinite(jade.metrics().maxLoss)).toBe(true);
  });

  it('the nested-premium (dialect-B) ironCondor prices from strikes alone with no premiums object', () => {
    const pos = ironCondor(
      { putLong: 540, putShort: 550, callShort: 590, callLong: 600 },
      { premiums: 'model', market },
    );
    expect(pos.premiumSource).toBe('model');
    for (const leg of pos.legs) expect(leg.premium).toBeGreaterThan(0);
    const m = pos.metrics();
    expect(Number.isFinite(m.maxLoss)).toBe(true);
    expect(m.breakevens.length).toBeGreaterThan(0);
  });

  it('the flat-premium (dialect-A) bullPutSpread prices from strikes alone', () => {
    const pos = bullPutSpread({ short: 550, long: 540 }, { premiums: 'model', market });
    expect(pos.premiumSource).toBe('model');
    for (const leg of pos.legs) expect(leg.premium).toBeGreaterThan(0);
  });

  it('the flagship: an iron condor PoP from strikes alone', () => {
    const pos = strategy(condorLegs(), { premiums: 'model', market });
    const prob = pos.probability({
      spot: 570,
      volatility: 0.18,
      riskFreeRate: 0.045,
      asOf: '2026-07-06T00:00:00Z',
      expiry: '2026-08-21',
    });
    expect(prob.probabilityOfProfit).toBeGreaterThan(0);
    expect(prob.probabilityOfProfit).toBeLessThan(1);
  });
});
