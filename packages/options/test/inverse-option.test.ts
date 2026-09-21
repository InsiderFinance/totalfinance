/**
 * Inverse (coin-settled / Deribit-style) options (`inverseOption`). The coin premium is exactly the
 * vanilla BSM value divided by spot; the coin greeks match a central finite-difference of `blackScholesPrice/S`
 * (and the delta carries the `−V_coin/S` numeraire correction — an inverse option is NOT hedged at its
 * Black–Scholes delta); the reported `usd` greeks equal the vanilla BSM greeks; inverse put-call parity
 * holds; the coin-numeraire Monte-Carlo converges to the closed form; and the guards hold.
 */

import { describe, expect, it } from 'vitest';
import {
  barrier,
  digital,
  inverseOption,
  type Greeks,
  type OptionType,
} from '@totalfinance/options';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import { DEFAULT_GREEK_UNITS } from '@totalfinance/core';

const I = {
  spot: 60000,
  strike: 65000,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.05,
  coinYield: 0.01,
  volatility: 0.7,
} as const;
const q = I.coinYield;

/** The coin premium `blackScholesPrice/S` as a function of the risk factors, for finite-difference greeks. */
const vc = (type: OptionType, S: number, sigma: number, T: number, r: number): number =>
  blackScholesPrice({
    type,
    spot: S,
    strike: I.strike,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  }) / S;

describe('inverseOption', () => {
  it('prices the coin premium as the vanilla BSM value divided by spot', () => {
    for (const type of ['call', 'put'] as const) {
      const coin = inverseOption.price({ ...I, type }).value;
      const usd = blackScholesPrice({
        type,
        spot: I.spot,
        strike: I.strike,
        timeToExpiryYears: I.timeToExpiryYears,
        riskFreeRate: I.riskFreeRate,
        dividendYield: q,
        volatility: I.volatility,
      });
      expect(coin).toBeCloseTo(usd / I.spot, 12);
      // value·spot recovers the USD premium.
      expect(coin * I.spot).toBeCloseTo(usd, 8);
    }
  });

  it('inverse put-call parity: C_coin − P_coin = e^{−qT} − (K/S)·e^{−rT}', () => {
    const c = inverseOption.price({ ...I, type: 'call' }).value;
    const p = inverseOption.price({ ...I, type: 'put' }).value;
    expect(c - p).toBeCloseTo(
      Math.exp(-q * I.timeToExpiryYears) -
        (I.strike / I.spot) * Math.exp(-I.riskFreeRate * I.timeToExpiryYears),
      12,
    );
  });

  it('reports coin greeks matching a finite-difference of blackScholesPrice/S, for call and put', () => {
    for (const type of ['call', 'put'] as const) {
      const { coin } = inverseOption.greeks({ ...I, type }).value;
      const spotStep = I.spot * 1e-5;
      const fd = {
        delta:
          (vc(type, I.spot + spotStep, I.volatility, I.timeToExpiryYears, I.riskFreeRate) -
            vc(type, I.spot - spotStep, I.volatility, I.timeToExpiryYears, I.riskFreeRate)) /
          (2 * spotStep),
        gamma:
          (vc(type, I.spot + spotStep, I.volatility, I.timeToExpiryYears, I.riskFreeRate) -
            2 * vc(type, I.spot, I.volatility, I.timeToExpiryYears, I.riskFreeRate) +
            vc(type, I.spot - spotStep, I.volatility, I.timeToExpiryYears, I.riskFreeRate)) /
          (spotStep * spotStep),
        vega:
          (vc(type, I.spot, I.volatility + 1e-5, I.timeToExpiryYears, I.riskFreeRate) -
            vc(type, I.spot, I.volatility - 1e-5, I.timeToExpiryYears, I.riskFreeRate)) /
          2e-5 /
          100,
        theta:
          -(
            vc(type, I.spot, I.volatility, I.timeToExpiryYears + 1e-6, I.riskFreeRate) -
            vc(type, I.spot, I.volatility, I.timeToExpiryYears - 1e-6, I.riskFreeRate)
          ) /
          2e-6 /
          365,
        rho:
          (vc(type, I.spot, I.volatility, I.timeToExpiryYears, I.riskFreeRate + 1e-6) -
            vc(type, I.spot, I.volatility, I.timeToExpiryYears, I.riskFreeRate - 1e-6)) /
          2e-6 /
          100,
      };
      for (const k of Object.keys(fd) as (keyof Greeks)[]) {
        // Coin greeks span ~1e-11 (gamma) to ~1e-3 (vega), so a fixed decimal tolerance is meaningless —
        // assert relative closeness to the finite-difference (which itself carries truncation error).
        expect(Math.abs(coin[k] - fd[k])).toBeLessThan(3e-4 * Math.abs(fd[k]) + 1e-13);
      }
    }
  });

  it('the coin delta carries the −V_coin/S correction, and usd greeks equal the vanilla BSM greeks', () => {
    for (const type of ['call', 'put'] as const) {
      const { coin, usd } = inverseOption.greeks({ ...I, type }).value;
      const vanilla = blackScholesGreeks({
        type,
        spot: I.spot,
        strike: I.strike,
        timeToExpiryYears: I.timeToExpiryYears,
        riskFreeRate: I.riskFreeRate,
        dividendYield: q,
        volatility: I.volatility,
      });
      const vCoin = inverseOption.price({ ...I, type }).value;
      // Δ_coin = Δ_usd/S − V_coin/S — NOT the Black–Scholes delta.
      expect(coin.delta).toBeCloseTo(vanilla.delta / I.spot - vCoin / I.spot, 15);
      // The usd greeks are exactly the vanilla greeks.
      expect(usd).toEqual(vanilla);
    }
    expect(inverseOption.greeks({ ...I, type: 'call' }).assumptions.units).toEqual(
      DEFAULT_GREEK_UNITS,
    );
  });

  it('the coin-numeraire Monte-Carlo converges to the closed-form coin premium (call and put)', () => {
    for (const type of ['call', 'put'] as const) {
      const analytic = inverseOption.price({ ...I, type }).value;
      const monteCarlo = inverseOption.monteCarloPrice({ ...I, type }, { paths: 500_000, seed: 5 });
      expect(Math.abs(monteCarlo.value - analytic)).toBeLessThan(
        5 * monteCarlo.monteCarlo.standardError!,
      );
    }
  });

  it('defaults the coin yield to 0', () => {
    const { coinYield: _omit, ...noYield } = I;
    expect(inverseOption.price({ ...noYield, type: 'call' }).value).toBeCloseTo(
      blackScholesPrice({
        type: 'call',
        spot: I.spot,
        strike: I.strike,
        timeToExpiryYears: I.timeToExpiryYears,
        riskFreeRate: I.riskFreeRate,
        dividendYield: 0,
        volatility: I.volatility,
      }) / I.spot,
      12,
    );
  });

  it('guards a bad type, a missing input, non-positive scalars, and missing MC options', () => {
    expect(() => inverseOption.price(undefined as never)).toThrowError();
    expect(() => inverseOption.price({ ...I, type: 'nope' } as never)).toThrowError();
    expect(() => inverseOption.price({ type: 'call', ...I, spot: 0 })).toThrowError();
    expect(() => inverseOption.price({ type: 'call', ...I, strike: -1 })).toThrowError();
    expect(() => inverseOption.price({ type: 'call', ...I, timeToExpiryYears: 0 })).toThrowError();
    expect(() => inverseOption.price({ type: 'call', ...I, volatility: 0 })).toThrowError();
    expect(() => inverseOption.greeks({ type: 'call', ...I, riskFreeRate: NaN })).toThrowError();
    expect(() =>
      inverseOption.monteCarloPrice({ ...I, type: 'call' }, undefined as never),
    ).toThrowError();
  });
});

describe('inverseOption — coin-settled digital & barrier (the universal coinPrice = usdPrice/spot)', () => {
  it('coin-settled asset-or-nothing call premium equals the BSM call delta (independent anchor)', () => {
    // A coin-settled asset-or-nothing call pays 1 coin if ITM; its coin premium is
    // (S·e^{−qT}·N(d1))/S = e^{−qT}·N(d1) = the BSM call delta — a fully independent check.
    const coin = inverseOption.digital({ type: 'call', kind: 'asset-or-nothing', ...I }).value;
    const blackScholesDelta = blackScholesGreeks({
      type: 'call',
      spot: I.spot,
      strike: I.strike,
      timeToExpiryYears: I.timeToExpiryYears,
      riskFreeRate: I.riskFreeRate,
      dividendYield: q,
      volatility: I.volatility,
    }).delta;
    expect(coin).toBeCloseTo(blackScholesDelta, 12);
  });

  it('coin-settled digital = vanilla USD digital / spot; value·spot recovers the USD premium', () => {
    for (const kind of ['cash-or-nothing', 'asset-or-nothing'] as const) {
      for (const type of ['call', 'put'] as const) {
        const usd = digital.price({
          type,
          kind,
          spot: I.spot,
          strike: I.strike,
          timeToExpiryYears: I.timeToExpiryYears,
          riskFreeRate: I.riskFreeRate,
          volatility: I.volatility,
          dividendYield: q,
          cash: 1,
        }).value;
        const r = inverseOption.digital({ type, kind, ...I, cash: 1 });
        expect(r.value).toBeCloseTo(usd / I.spot, 14); // coin premium
        expect(r.value * I.spot).toBeCloseTo(usd, 8); // recovery
        expect(r.assumptions.model).toBe('inverse');
      }
    }
  });

  it('coin-settled barrier = vanilla USD barrier / spot (all four barrier types)', () => {
    for (const barrierType of ['down-in', 'down-out', 'up-in', 'up-out'] as const) {
      const H = barrierType.startsWith('down') ? 50000 : 75000;
      const usd = barrier.price({
        type: 'call',
        barrierType,
        spot: I.spot,
        strike: I.strike,
        barrier: H,
        timeToExpiryYears: I.timeToExpiryYears,
        riskFreeRate: I.riskFreeRate,
        volatility: I.volatility,
        dividendYield: q,
      }).value;
      const r = inverseOption.barrier({ type: 'call', barrierType, barrier: H, ...I });
      expect(r.value).toBeCloseTo(usd / I.spot, 14);
      expect(r.value * I.spot).toBeCloseTo(usd, 8);
    }
    // Knock-in + knock-out on the same barrier reconstruct the vanilla coin premium (in–out parity).
    const inC = inverseOption.barrier({
      type: 'call',
      barrierType: 'up-in',
      barrier: 75000,
      ...I,
    }).value;
    const outC = inverseOption.barrier({
      type: 'call',
      barrierType: 'up-out',
      barrier: 75000,
      ...I,
    }).value;
    const vanilla = inverseOption.price({ type: 'call', ...I }).value;
    expect(inC + outC).toBeCloseTo(vanilla, 10);
  });

  it('guards a bad type/kind/barrierType and non-positive scalars', () => {
    expect(() => inverseOption.digital(undefined as never)).toThrowError();
    expect(() =>
      inverseOption.digital({ type: 'nope', kind: 'cash-or-nothing', ...I } as never),
    ).toThrowError();
    expect(() =>
      inverseOption.digital({ type: 'call', kind: 'nope', ...I } as never),
    ).toThrowError();
    expect(() =>
      inverseOption.digital({ type: 'call', kind: 'cash-or-nothing', ...I, spot: 0 }),
    ).toThrowError();
    expect(() =>
      inverseOption.barrier({ type: 'call', barrierType: 'nope', barrier: 50000, ...I } as never),
    ).toThrowError();
    expect(() =>
      inverseOption.barrier({
        type: 'call',
        barrierType: 'up-out',
        barrier: 75000,
        ...I,
        volatility: 0,
      }),
    ).toThrowError();
  });
});
