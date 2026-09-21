/**
 * "Explain this position" narrative (`explainPosition`). Verifies the derived postures (direction /
 * movement / vol / time), the economics + probability, the risk flags, graceful no-market degradation,
 * a custom position, the multi-expiry guard, and that the prose is grounded (contains the real numbers,
 * no NaN/undefined).
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { explainPosition, legs, strategy } from '@totalfinance/strategy';

const EXPIRY = '2026-09-18';
const MKT = {
  market: { spot: 100, volatility: 0.25, riskFreeRate: 0.03, asOf: '2026-05-01T00:00:00Z' },
  underlyingLabel: 'XYZ',
};

const ironCondor = () =>
  strategy(
    [
      legs.put({ strike: 80, premium: 0.9, quantity: 1 }),
      legs.put({ strike: 90, premium: 2.1, quantity: -1 }),
      legs.call({ strike: 110, premium: 2.0, quantity: -1 }),
      legs.call({ strike: 120, premium: 0.8, quantity: 1 }),
    ],
    { expiry: EXPIRY },
  );
const bullCallSpread = () =>
  strategy(
    [
      legs.call({ strike: 100, premium: 5.2, quantity: 1 }),
      legs.call({ strike: 115, premium: 1.8, quantity: -1 }),
    ],
    { expiry: EXPIRY },
  );
const longStraddle = () =>
  strategy(
    [
      legs.call({ strike: 100, premium: 6, quantity: 1 }),
      legs.put({ strike: 100, premium: 6, quantity: 1 }),
    ],
    {
      expiry: EXPIRY,
    },
  );

describe('explainPosition — postures', () => {
  it('an iron condor reads neutral / wants-stability / short-vol / decay-helps / defined-risk', () => {
    const e = explainPosition(ironCondor(), MKT);
    expect(e.name).toBe('ironCondor');
    expect(e.directionalBias).toBe('neutral');
    expect(e.moveBias).toBe('wants-stability');
    expect(e.volatilityBias).toBe('benefits-from-falling-impliedVolatility');
    expect(e.timeBias).toBe('decay-helps');
    expect(e.definedRisk).toBe(true);
    expect(e.economics.breakevens).toHaveLength(2);
    expect(e.probability!.probabilityOfProfit).toBeGreaterThan(0);
    // Grounded prose: humanized name, a breakeven, the PoP, no leaked placeholders.
    expect(e.summary).toContain('iron condor');
    expect(e.summary).toContain('probability of profit');
    expect(e.summary).not.toContain('NaN');
    expect(e.summary).not.toContain('undefined');
  });

  it('a bull call spread reads bullish / long-vol / decay-hurts', () => {
    const e = explainPosition(bullCallSpread(), MKT);
    expect(e.directionalBias).toBe('bullish');
    expect(e.volatilityBias).toBe('benefits-from-rising-impliedVolatility');
    expect(e.timeBias).toBe('decay-hurts');
    expect(e.summary).toContain('bullish');
  });

  it('a long straddle reads neutral / wants-movement / long-vol, with unlimited upside', () => {
    const e = explainPosition(longStraddle(), MKT);
    expect(e.directionalBias).toBe('neutral');
    expect(e.moveBias).toBe('wants-movement');
    expect(e.volatilityBias).toBe('benefits-from-rising-impliedVolatility');
    expect(e.economics.maxProfit).toBeNull();
    expect(e.summary).toContain('max profit unbounded'); // an unbounded side is the word, never ∞
  });
});

describe('explainPosition — risks', () => {
  it('a short option flags assignment risk', () => {
    const e = explainPosition(
      strategy([legs.put({ strike: 95, premium: 3, quantity: -1 })], { expiry: EXPIRY }),
      MKT,
    );
    expect(e.risks.some((r) => r.includes('Assignment risk') && r.includes('put'))).toBe(true);
  });

  it('a short call (unbounded loss) flags undefined risk', () => {
    const e = explainPosition(
      strategy([legs.call({ strike: 105, premium: 3, quantity: -1 })], { expiry: EXPIRY }),
      MKT,
    );
    expect(e.definedRisk).toBe(false);
    expect(e.economics.maxLoss).toBeNull();
    expect(e.economics.rewardToRisk).toBeNull();
    expect(e.risks.some((r) => r.includes('Undefined risk'))).toBe(true);
    expect(e.summary).toContain('undefined-risk');
  });
});

describe('explainPosition — graceful degradation', () => {
  it('without a market, still names/describes/economics + directional posture, and discloses', () => {
    const e = explainPosition(bullCallSpread()); // no market
    expect(e.name).toBe('bullCallSpread');
    expect(e.directionalBias).toBe('bullish'); // market-free (payoff shape)
    expect(e.greeks).toBeUndefined();
    expect(e.probability).toBeUndefined();
    expect(e.volatilityBias).toBeUndefined();
    expect(e.economics.maxProfit).toBeGreaterThan(0);
    expect(e.summary).toContain('Supply a market');
  });

  it('a custom (unnamed) position is still fully explained', () => {
    const custom = strategy(
      [
        legs.call({ strike: 100, premium: 5, quantity: 1 }),
        legs.call({ strike: 105, premium: 3, quantity: -1 }),
        legs.call({ strike: 130, premium: 0.3, quantity: 1 }),
      ],
      { expiry: EXPIRY },
    );
    const e = explainPosition(custom, MKT);
    expect(e.name).toBe('custom');
    expect(e.summary).toContain('custom position');
    expect(e.structure).toContain('call');
    expect(e.summary).not.toContain('NaN');
  });
});

describe('explainPosition — envelope & guards', () => {
  it('validates a supplied market expiry before optional market analysis branches', () => {
    for (const expiry of ['not-a-date', '2025-02-30', '2026-06-19T16:00:00']) {
      expect(() => explainPosition(bullCallSpread(), { market: { expiry } })).toThrow(
        /market\.expiry/,
      );
    }
  });

  it('throws on garbage and on a multi-expiry position', () => {
    expect(() => explainPosition(undefined as never)).toThrowError();
    expect(() => explainPosition({ legs: [] } as never)).toThrowError();
    const calendar = strategy([
      { kind: 'call', strike: 100, quantity: 1, premium: 2, expiry: '2026-06-19' },
      { kind: 'call', strike: 100, quantity: -1, premium: 1, expiry: '2026-07-17' },
    ]);
    try {
      explainPosition(calendar);
      expect.unreachable('a multi-expiry position should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
  });
});
