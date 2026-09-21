/**
 * OptionType is a meaning-changing enum: `type: 'Call'`, `'CALL'`, or `'c'` must throw a typed
 * `input.invalid_enum` at EVERY analytic-tier boundary that accepts a `type` — never silently fall
 * through the `type === 'call' ? call : put` branch and price the other leg (design law #4).
 */
import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import {
  asian,
  bachelier,
  barrier,
  black76,
  blackScholes,
  heston,
  impliedVolatility,
  localVolatility,
  lookback,
} from '@totalfinance/options';

const INVALID_ENUM = 'input.invalid_enum';

function expectInvalidEnum(run: () => unknown): void {
  try {
    run();
    throw new Error('expected an input.invalid_enum throw');
  } catch (err) {
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).code).toBe(INVALID_ENUM);
  }
}

// One casing typo per family is enough — the enum guard is shared, the wiring per boundary is what
// these tests pin down.
const BAD_TYPES = ['Call', 'CALL', 'c'] as const;

describe('Black–Scholes facade rejects a mistyped option type', () => {
  const base = {
    spot: 100,
    strike: 100,
    timeToExpiryYears: 0.5,
    riskFreeRate: 0.05,
    volatility: 0.2,
  };

  it('blackScholes.price / blackScholes.greeks / blackScholes.extendedGreeks throw input.invalid_enum for every casing typo', () => {
    for (const type of BAD_TYPES) {
      // @ts-expect-error — runtime garbage must throw, not price the put
      expectInvalidEnum(() => blackScholes.price({ ...base, type }));
    }
    // @ts-expect-error — greeks path
    expectInvalidEnum(() => blackScholes.greeks({ ...base, type: 'Call' }));
    // @ts-expect-error — extended greeks path
    expectInvalidEnum(() => blackScholes.extendedGreeks({ ...base, type: 'Call' }));
    // @ts-expect-error — .explain() shares the same validator
    expectInvalidEnum(() => blackScholes.price.explain({ ...base, type: 'Call' }));
  });

  it('blackScholes.impliedVolatility rejects a mistyped type', () => {
    const price = blackScholes.call(base);
    // @ts-expect-error — runtime garbage must throw, not invert the put
    expectInvalidEnum(() => blackScholes.impliedVolatility({ ...base, price, type: 'Call' }));
  });

  it("correct 'call'/'put' still price (and differ)", () => {
    const call = blackScholes.price({ ...base, type: 'call' });
    const put = blackScholes.price({ ...base, type: 'put' });
    expect(call).toBeCloseTo(blackScholes.call(base), 12);
    expect(put).toBeCloseTo(blackScholes.put(base), 12);
    expect(call).not.toBeCloseTo(put, 6);
  });
});

describe('Black-76 facade rejects a mistyped option type', () => {
  const base = {
    forward: 100,
    strike: 100,
    timeToExpiryYears: 0.5,
    riskFreeRate: 0.05,
    volatility: 0.2,
  };

  it('black76.price / black76.greeks / black76.impliedVolatility throw input.invalid_enum', () => {
    // @ts-expect-error — runtime garbage must throw
    expectInvalidEnum(() => black76.price({ ...base, type: 'Call' }));
    // @ts-expect-error — greeks path
    expectInvalidEnum(() => black76.greeks({ ...base, type: 'CALL' }));
    const price = black76.call(base);
    // A SOLVER does not take the volatility it solves for, so the IV call drops it — otherwise the
    // request carries two independent errors and Law 12 reports the unknown key before the enum,
    // which says nothing about whether the enum is checked.
    const { volatility: _solved, ...ivBase } = base;
    // @ts-expect-error — implied-vol path
    expectInvalidEnum(() => black76.impliedVolatility({ ...ivBase, price, type: 'c' }));
  });

  it("correct 'call'/'put' still price", () => {
    expect(black76.price({ ...base, type: 'call' })).toBeCloseTo(black76.call(base), 12);
    expect(black76.price({ ...base, type: 'put' })).toBeCloseTo(black76.put(base), 12);
  });
});

describe('Bachelier facade rejects a mistyped option type', () => {
  const base = {
    forward: 100,
    strike: 100,
    timeToExpiryYears: 0.5,
    riskFreeRate: 0.05,
    normalVolatility: 15,
  };

  it('bachelier.price / bachelier.greeks / bachelier.impliedVolatility throw input.invalid_enum', () => {
    // @ts-expect-error — runtime garbage must throw
    expectInvalidEnum(() => bachelier.price({ ...base, type: 'Call' }));
    // @ts-expect-error — greeks path
    expectInvalidEnum(() => bachelier.greeks({ ...base, type: 'Put' }));
    const price = bachelier.call(base);
    const { normalVolatility: _solved, ...ivBase } = base;
    // @ts-expect-error — implied-vol path
    expectInvalidEnum(() => bachelier.impliedVolatility({ ...ivBase, price, type: 'CALL' }));
  });

  it("correct 'call'/'put' still price", () => {
    expect(bachelier.price({ ...base, type: 'call' })).toBeCloseTo(bachelier.call(base), 12);
    expect(bachelier.price({ ...base, type: 'put' })).toBeCloseTo(bachelier.put(base), 12);
  });
});

describe('impliedVolatility (method suite) rejects a mistyped option type', () => {
  it('throws input.invalid_enum before touching the solver', () => {
    expectInvalidEnum(() =>
      impliedVolatility({
        price: 10,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        // @ts-expect-error — runtime garbage must throw, not invert the put
        type: 'Call',
      }),
    );
  });

  it("correct 'call' still solves", () => {
    const price = blackScholes.call({
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    });
    const res = impliedVolatility({
      price,
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      type: 'call',
    });
    expect(res.diagnostics.converged).toBe(true);
    expect(res.value).toBeCloseTo(0.2, 6);
  });
});

describe('exotics reject a mistyped option type', () => {
  const barrierInput = {
    spot: 100,
    strike: 100,
    barrier: 90,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    volatility: 0.25,
  };
  const lookInput = { spot: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, volatility: 0.25 };
  const asianInput = {
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    volatility: 0.25,
  };
  const monteCarloOpts = { paths: 200, seed: 1 };

  it('barrier.price / barrier.monteCarloPrice throw input.invalid_enum', () => {
    expectInvalidEnum(() =>
      barrier.price({ ...barrierInput, type: 'Call', barrierType: 'down-out' } as never),
    );
    expectInvalidEnum(() =>
      barrier.monteCarloPrice(
        { ...barrierInput, type: 'Call', barrierType: 'down-out' } as never,
        monteCarloOpts,
      ),
    );
    // The valid enum still prices.
    expect(
      barrier.price({ ...barrierInput, type: 'call', barrierType: 'down-out' }).value,
    ).toBeGreaterThan(0);
  });

  it('lookback.price / lookback.monteCarloPrice throw input.invalid_enum', () => {
    expectInvalidEnum(() =>
      lookback.price({ ...lookInput, type: 'Call', strikeType: 'floating' } as never),
    );
    expectInvalidEnum(() =>
      lookback.monteCarloPrice(
        { ...lookInput, type: 'Call', strikeType: 'floating' } as never,
        monteCarloOpts,
      ),
    );
    expect(
      lookback.price({ ...lookInput, type: 'call', strikeType: 'floating' }).value,
    ).toBeGreaterThan(0);
  });

  it('asian.geometricPrice / asian.monteCarloPrice throw input.invalid_enum', () => {
    expectInvalidEnum(() => asian.geometricPrice({ ...asianInput, type: 'Call' } as never));
    expectInvalidEnum(() =>
      asian.monteCarloPrice({ ...asianInput, type: 'Call' } as never, monteCarloOpts),
    );
    expect(asian.geometricPrice({ ...asianInput, type: 'call' }).value).toBeGreaterThan(0);
  });
});

describe('stochastic-vol facades reject a mistyped option type', () => {
  const hestonInput = { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.02 };
  const hestonParams = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.3, rho: -0.6 };

  it('heston.price / heston.monteCarloPrice / heston.impliedVolatility throw input.invalid_enum', () => {
    expectInvalidEnum(() =>
      heston.price({
        // @ts-expect-error — runtime garbage must throw, not price the put
        type: 'Call',
        input: hestonInput,
        parameters: hestonParams,
      }),
    );
    expectInvalidEnum(() =>
      heston.monteCarloPrice({
        // @ts-expect-error — Monte-Carlo path shares the guard
        type: 'Call',
        input: hestonInput,
        parameters: hestonParams,
        options: { paths: 100, seed: 1 },
      }),
    );
    expectInvalidEnum(() =>
      heston.impliedVolatility({
        // @ts-expect-error — implied-vol path shares the guard
        type: 'Call',
        input: hestonInput,
        parameters: hestonParams,
      }),
    );
    expect(
      heston.price({ type: 'call', input: hestonInput, parameters: hestonParams }).value,
    ).toBeGreaterThan(0);
  });

  it('localVolatility.monteCarloPrice throws input.invalid_enum', () => {
    const flat = () => 0.2;
    expectInvalidEnum(() =>
      localVolatility.monteCarloPrice({
        // @ts-expect-error — runtime garbage must throw
        type: 'Call',
        input: hestonInput,
        localVolatility: flat,
        options: { paths: 100, seed: 1 },
      }),
    );
    const priced = localVolatility.monteCarloPrice({
      type: 'call',
      input: hestonInput,
      localVolatility: flat,
      options: { paths: 500, seed: 1 },
    });
    expect(priced.value).toBeGreaterThan(0);
  });
});
