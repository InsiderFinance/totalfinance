import { expect, it } from 'vitest';
import { blackScholes } from '@totalfinance/options/black-scholes';
import { black76 } from '@totalfinance/options/black76';
import { spread } from '@totalfinance/options';
const input = {
  type: 'call' as const,
  spot: 100,
  strike: 100,
  timeToExpiryYears: 1,
  riskFreeRate: 0,
  dividendYield: 0,
  volatility: 1e-17,
};
for (const type of ['call', 'put'] as const)
  for (const scale of [1e-150, 1, 1e150])
    it(`resolves tiny ATM ${type} at scale ${scale} (#19)`, () => {
      const t = { ...input, type, spot: 100 * scale, strike: 100 * scale };
      const expected = 3.989422804014327e-16 * scale;
      expect(blackScholes.price(t) / expected).toBeCloseTo(1, 13);
      expect(
        black76.price({
          type,
          forward: t.spot,
          strike: t.strike,
          timeToExpiryYears: 1,
          riskFreeRate: 0,
          volatility: 1e-17,
        }) / expected,
      ).toBeCloseTo(1, 13);
      expect(blackScholes.evaluate({ ...t, outputs: ['price'] }).price! / expected).toBeCloseTo(
        1,
        13,
      );
    });
it('gives a precise refusal for unresolved adjacent-price subtraction', () => {
  expect(() => blackScholes.price({ ...input, spot: 99.99999999999999 })).toThrowError(
    expect.objectContaining({
      code: 'input.out_of_range',
      message: expect.stringMatching(/cancellation|precision/i),
    }),
  );
});
for (const type of ['call', 'put'] as const)
  for (const v of [0.200000001, 0.2000000001])
    it(`resolves ${type} exchange near-offset ${v} (#23)`, () => {
      const r = spread.price({
        type,
        spot1: 1,
        spot2: 1,
        strike: 0,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        dividendYield1: 0,
        dividendYield2: 0,
        volatility1: v,
        volatility2: 0.2,
        correlation: 1,
      });
      // 100-digit Margrabe reference evaluated at the exact binary64 volatility inputs.
      const expected = v === 0.200000001 ? 3.989422801914470757e-10 : 3.9894220268133866604e-11;
      expect(r.value / expected).toBeCloseTo(1, 13);
    });
it('keeps ordinary successful prices accurate rather than refusing them', () => {
  expect(blackScholes.price({ ...input, volatility: 0.2 })).toBeCloseTo(7.965567455405804, 12);
  expect(
    black76.price({
      type: 'put',
      forward: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0,
      volatility: 0.2,
    }),
  ).toBeCloseTo(7.965567455405804, 12);
});
it('keeps deterministic OTM spread put exactly zero', () => {
  expect(
    spread.price({
      type: 'put',
      spot1: 1,
      spot2: 50 / 110,
      strike: 50 / 110,
      timeToExpiryYears: 1,
      riskFreeRate: 0,
      dividendYield1: 0,
      dividendYield2: 0,
      volatility1: 0.22,
      volatility2: 0.44,
      correlation: 1,
    }).value,
  ).toBe(0);
});
