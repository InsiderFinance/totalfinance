import { expect, it } from 'vitest';
import {
  blackScholes,
  blackScholesImpliedVolatility,
  blackScholesPrice,
} from '@totalfinance/options/black-scholes';
import { black76, black76Price } from '@totalfinance/options/black76';
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
it('gives a precise refusal for unresolved forward-moneyness cancellation', () => {
  expect(() =>
    blackScholes.price({ ...input, strike: 100 * Math.exp(0.01), riskFreeRate: 0.01 }),
  ).toThrowError(
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

const tinySpread = {
  type: 'call' as const,
  spot1: 1,
  spot2: 1,
  strike: 0,
  timeToExpiryYears: Number.MIN_VALUE,
  riskFreeRate: 0,
  dividendYield1: 0,
  dividendYield2: 0,
  volatility1: Number.MIN_VALUE,
  volatility2: Number.MIN_VALUE,
  correlation: 0,
};
it('distinguishes positive horizon-volatility underflow from premium subtraction cancellation', () => {
  expect(() => spread.price(tinySpread)).toThrowError(
    expect.objectContaining({
      code: 'input.out_of_range',
      context: { field: 'timeToExpiryYears', reason: 'horizon_volatility_underflow' },
      message: expect.stringContaining('underflows'),
    }),
  );
});
it('retains a genuinely deterministic zero spread at the same tiny horizon', () => {
  const result = spread.price({ ...tinySpread, correlation: 1 });
  expect(result.value).toBe(0);
  expect(result.diagnostics.converged).toBe(true);
});

// Independent 400-digit Gaussian-CDF references at the exact binary64 inputs.
it('resolves the accepted tail price that previously had five percent relative error', () => {
  const t = { ...input, strike: 100.00000004, volatility: 2e-11 };
  const expected = 2.73993407744911265788097967721298334851669726e-99;
  expect(blackScholes.price(t) / expected).toBeCloseTo(1, 10);
  expect(blackScholes.evaluate({ ...t, outputs: ['price'] }).price! / expected).toBeCloseTo(1, 10);
  expect(
    black76.price({
      type: 'call',
      forward: 100,
      strike: t.strike,
      timeToExpiryYears: 1,
      riskFreeRate: 0,
      volatility: t.volatility,
    }) / expected,
  ).toBeCloseTo(1, 10);
});
it('retains representable intrinsic value at adjacent prices with negligible time value', () => {
  const t = { ...input, spot: 100.00000000000001 };
  expect(blackScholes.price(t)).toBe(t.spot - t.strike);
  expect(blackScholes.price({ ...t, type: 'put' }) / 2.73394863828112e-62).toBeCloseTo(1, 10);
});
for (const type of ['call', 'put'] as const)
  it(`teaches ${type} horizon-volatility underflow through price and evaluate`, () => {
    const t = { ...input, type, timeToExpiryYears: Number.MIN_VALUE, volatility: Number.MIN_VALUE };
    for (const run of [
      () => blackScholes.price(t),
      () => blackScholes.evaluate({ ...t, outputs: ['price'] }),
      () =>
        black76.price({
          type,
          forward: 100,
          strike: 100,
          timeToExpiryYears: t.timeToExpiryYears,
          riskFreeRate: 0,
          volatility: t.volatility,
        }),
    ])
      expect(run).toThrowError(
        expect.objectContaining({
          name: 'InputError',
          code: 'input.out_of_range',
          context: expect.objectContaining({ reason: 'horizon_volatility_underflow' }),
        }),
      );
  });

it('keeps IV solvable with explicit tiny lower bounds', () => {
  const t = { ...input, strike: 100 * (1 + 2e-11), volatility: 0.1003 };
  const { volatility, ...terms } = t;
  const r = blackScholesImpliedVolatility({
    ...terms,
    price: blackScholes.price(t),
    lowerVolatilityBound: 1e-12,
  });
  expect(r.converged).toBe(true);
  expect(r.value).toBeCloseTo(volatility, 9);
});
it('recovers a finite lower-endpoint trial within the caller bounds', () => {
  const t = { ...input, strike: 100 * Math.exp(0.01), riskFreeRate: 0.01, volatility: 0.2 };
  const { volatility: _, ...terms } = t;
  const r = blackScholesImpliedVolatility({
    ...terms,
    price: blackScholes.price(t),
    lowerVolatilityBound: 1e-17,
  });
  expect(r.converged).toBe(true);
  expect(r.value).toBeCloseTo(0.2, 9);
});

// 400-digit erfc references, computed independently from actual binary64 inputs.
for (const [strike, volatility, expected] of [
  [100.000000001, 1e-10, 3.5093516391325042e-9],
  [100.000000009, 1e-10, 1.0043105800109443e-9],
  [100.00000001000001, 1e-10, 8.331534474132824e-10],
  [100.000000011, 1e-10, 6.861954585421988e-10],
  [100.00000002, 1e-10, 8.490698857520758e-11],
  [100.00000008, 1e-10, 7.55022143618012e-25],
  [100.00000019999999, 1e-10, 1.3700457427551547e-98],
  [100.00000035000001, 1e-10, 3.208725404057108e-278],
  [100.00001, 1e-6, 3.5093535103771864e-5],
  [100.00009000000001, 1e-6, 1.0043125679860215e-5],
  [100.00009999999999, 1e-6, 8.3315591590328e-6],
  [100.00010999999999, 1e-6, 6.861962982070521e-6],
  [100.0002, 1e-6, 8.490756606373426e-7],
  [100.0008, 1e-6, 7.552283577521103e-21],
  [100.002, 1e-6, 1.3755444824037735e-94],
  [100.0035, 1e-6, 3.278505432596996e-274],
  [100.00099, 9.9e-5, 0.0034742792299490596],
  [100.00891, 9.9e-5, 0.000994385612025838],
  [100.0099, 9.9e-5, 0.0008249417365711662],
  [100.01089, 9.9e-5, 0.0006794505840770765],
  [100.01979999999999, 9.9e-5, 8.411088096580301e-5],
  [100.07919999999999, 9.9e-5, 7.675332268415869e-19],
  [100.19800000000001, 9.9e-5, 2.019812863872322e-92],
  [100.3465, 9.9e-5, 2.6486146973560484e-271],
])
  it(`matches independent small-volatility tail reference ${strike}/${volatility}`, () => {
    const t = { ...input, strike: strike!, volatility: volatility! };
    expect(blackScholes.price(t) / expected!).toBeCloseTo(1, 9);
    expect(
      blackScholes.price({ ...t, type: 'put', spot: strike!, strike: 100 }) / expected!,
    ).toBeCloseTo(1, 9);
  });

it("preserves the expert kernels' existing finite non-ATM expiry answers", () => {
  for (const type of ['call', 'put'] as const) {
    expect(
      blackScholesPrice({ ...input, type, strike: 80, timeToExpiryYears: 0, volatility: 0.2 }),
    ).toBe(type === 'call' ? 20 : 0);
    expect(
      black76Price({
        type,
        forward: 100,
        strike: 80,
        timeToExpiryYears: 0,
        volatility: 0.2,
        riskFreeRate: 0,
      }),
    ).toBe(type === 'call' ? 20 : 0);
  }
});

it('reports precision_limit when the entire explicit IV bracket is unavailable', () => {
  const t = { ...input, strike: 100 * Math.exp(0.01), riskFreeRate: 0.01, volatility: 0.2 };
  const { volatility: _, ...terms } = t;
  const r = blackScholesImpliedVolatility({
    ...terms,
    price: blackScholes.price(t),
    lowerVolatilityBound: 1e-18,
    upperVolatilityBound: 1e-17,
  });
  expect(r.converged).toBe(false);
  expect(r.iterations).toBe(0);
  expect(r.reason).toBe('precision_limit');
});

it('recovers facade IV at the reported sub-second horizon', () => {
  const t = {
    ...input,
    timeToExpiryYears: 1e-10,
    strike: 100 * (1 + 2e-11),
    riskFreeRate: 0.04,
    volatility: 0.2003,
  };
  const { volatility, ...terms } = t;
  const report = blackScholes.impliedVolatility.explain({ ...terms, price: blackScholes.price(t) });
  expect(report.diagnostics.converged).toBe(true);
  expect(report.value).toBeCloseTo(volatility, 9);
});
it('recovers ordinary forward-ATM IV when the default lower trial is unavailable', () => {
  const t = { ...input, strike: 100 * Math.exp(0.4), riskFreeRate: 0.4, volatility: 0.2 };
  const { volatility, ...terms } = t;
  const report = blackScholes.impliedVolatility.explain({ ...terms, price: blackScholes.price(t) });
  expect(report.diagnostics.converged).toBe(true);
  expect(report.value).toBeCloseTo(volatility, 9);
});
