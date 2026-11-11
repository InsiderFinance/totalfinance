import { expect, it } from 'vitest';
import { strategy, legs } from '@totalfinance/strategy';
const expiry = '2026-01-01T00:00:00Z';
for (const scale of [1e-200, 1e-12, 1, 1e100, 1e200]) {
  it(`preserves break-even and lognormal profit mass at ${scale} (#18)`, () => {
    const p = strategy(
      [legs.call({ strike: 100 * scale, premium: 2 * scale, quantity: 1, expiry })],
      { multiplier: 1 },
    );
    expect(p.metrics().breakevens).toHaveLength(1);
    expect(p.metrics().breakevens[0]! / scale).toBeCloseTo(102, 11);
    // Independent Gaussian CDF evaluation of log(102/100), drift -sigma^2/2.
    expect(
      p.probability({
        spot: 100 * scale,
        asOf: '2025-01-01T00:00:00Z',
        expiry,
        volatility: 0.2,
        riskFreeRate: 0,
        dividendYield: 0,
        measure: 'riskNeutral',
      }).probabilityOfProfit,
    ).toBeCloseTo(0.4211262343534825, 12);
  });
}
it('retains two nearby distinct roots', () => {
  const p = strategy(
    [
      legs.call({ strike: 1e-10, premium: 1e-12, quantity: 1, expiry }),
      legs.put({ strike: 1e-10, premium: 1e-12, quantity: 1, expiry }),
    ],
    { multiplier: 1 },
  );
  expect(p.metrics().breakevens.map((x) => x / 1e-10)).toEqual([0.98, 1.02]);
});
it('does not invent an isolated root for an everywhere-offset position', () => {
  const p = strategy(
    [
      legs.call({ strike: 100, premium: 2, quantity: 1, expiry }),
      legs.call({ strike: 100, premium: 2, quantity: -1, expiry }),
    ],
    { multiplier: 1 },
  );
  expect(p.metrics().breakevens).toEqual([]);
});
it('preserves a small nonzero right-tail slope', () => {
  const p = strategy([legs.call({ strike: 100, premium: 2, quantity: 1e-12, expiry })], {
    multiplier: 1,
  });
  expect(p.metrics().bounded.profit).toBe(false);
  expect(p.metrics().breakevens).toEqual([102]);
});

it('treats fractional quantity roundoff as a flat tail, while retaining standalone small quantities', () => {
  const p = strategy(
    [
      legs.call({ strike: 100, premium: 1, quantity: 0.1, expiry }),
      legs.call({ strike: 101, premium: 2, quantity: 0.2, expiry }),
      legs.call({ strike: 102, premium: 3, quantity: -0.3, expiry }),
    ],
    { multiplier: 1 },
  );
  expect(p.metrics().bounded.profit).toBe(true);
  expect(p.metrics().maxProfit).toBeCloseTo(0.8, 13);
  expect(p.metrics().breakevens.every((x) => x < 1000)).toBe(true);
});
it('does not turn roundoff in a flat decimal conversion into certain profit', () => {
  const p = strategy(
    [
      legs.call({ strike: 100, premium: 3.3, quantity: 1, expiry }),
      legs.put({ strike: 100, premium: 3.1, quantity: -1, expiry }),
      legs.stock({ price: 100.2, quantity: -1 }),
    ],
    { multiplier: 1 },
  );
  expect(p.metrics().bounded).toEqual({ profit: true, loss: true });
  expect(
    p.probability({
      spot: 100,
      asOf: '2025-01-01T00:00:00Z',
      expiry,
      volatility: 0.2,
      riskFreeRate: 0,
      dividendYield: 0,
      measure: 'riskNeutral',
    }).probabilityOfProfit,
  ).toBe(0);
});

it('retains finite stock P&L when gross cash legs would overflow', () => {
  const entry = 1e160,
    quantity = 1e160;
  const p = strategy([legs.stock({ price: entry, quantity })], { multiplier: 1 });
  expect(p.pnlAtExpiry(entry)).toBe(0);
  const terminal = entry * (1 + 1e-10);
  expect(p.pnlAtExpiry(terminal)).toBe(quantity * (terminal - entry));
});
