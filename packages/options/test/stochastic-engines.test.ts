import { describe, expect, it } from 'vitest';
import { compareEngines, engines, market, option } from '@totalfinance/options';
import { type HestonParameters, hestonPrice } from '@totalfinance/options/heston';
import { type SabrParameters, sabrPrice } from '@totalfinance/options/sabr';
import {
  type ImpliedVolatilityFunction,
  dupireLocalVolatility,
  localVolatilityMonteCarloPrice,
} from '@totalfinance/options/local-volatility';

const asOf = Date.UTC(2026, 0, 1, 21);
const expiry = '2027-01-01'; // T = 1 exactly
const T = 1;

describe('engines.heston adapter (WS4.3)', () => {
  const parameters: HestonParameters = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.6 };

  it('option.price({ contract: europeanCall, market: mkt, engine: engines.heston }) equals hestonPrice(...) to 1e-12', () => {
    const call = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const viaEngine = option.price({
      contract: call,
      market: market({ spot: 100, riskFreeRate: 0.03, asOf }),
      engine: engines.heston(parameters),
    }).value;
    const direct = hestonPrice({
      type: 'call',
      input: { spot: 100, strike: 100, timeToExpiryYears: T, riskFreeRate: 0.03, dividendYield: 0 },
      parameters,
    }).value;
    expect(viaEngine).toBeCloseTo(direct, 12);
  });

  it('supports() gates American to false', () => {
    const am = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    expect(engines.heston(parameters).supports(am)).toBe(false);
  });
});

describe('engines.sabr adapter (WS4.3)', () => {
  const parameters: SabrParameters = { alpha: 0.3, beta: 0.8, rho: -0.3, nu: 0.5 };

  it('equals sabrPrice(...) via option.price (spot-implied forward)', () => {
    const call = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 105,
      expiry,
      style: 'european',
    });
    const viaEngine = option.price({
      contract: call,
      market: market({ spot: 100, riskFreeRate: 0.03, asOf }),
      engine: engines.sabr(parameters),
    }).value;
    const direct = sabrPrice({
      type: 'call',
      input: { spot: 100, strike: 105, timeToExpiryYears: T, riskFreeRate: 0.03, dividendYield: 0 },
      parameters,
    }).value;
    expect(viaEngine).toBeCloseTo(direct, 12);
  });
});

describe('engines.localVolatility adapter (WS4.3)', () => {
  const flatImpliedVolatility: ImpliedVolatilityFunction = () => 0.2;
  const lv = dupireLocalVolatility({
    impliedVolatility: flatImpliedVolatility,
    market: { spot: 100, riskFreeRate: 0.03, dividendYield: 0 },
  });

  it('equals localVolatilityMonteCarloPrice(...) via option.price (same seed → deterministic)', () => {
    const options = { paths: 20_000, seed: 7, steps: 50 };
    const call = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const viaEngine = option.price({
      contract: call,
      market: market({ spot: 100, riskFreeRate: 0.03, asOf }),
      engine: engines.localVolatility(lv, options),
    }).value;
    const direct = localVolatilityMonteCarloPrice({
      type: 'call',
      input: { spot: 100, strike: 100, timeToExpiryYears: T, riskFreeRate: 0.03, dividendYield: 0 },
      localVolatility: lv,
      options,
    }).value;
    expect(viaEngine).toBeCloseTo(direct, 10);
  });

  it('does not compute Greeks (absent, never fabricated)', () => {
    const call = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const r = option.price({
      contract: call,
      market: market({ spot: 100, riskFreeRate: 0.03, asOf }),
      engine: engines.localVolatility(lv, { paths: 5_000, seed: 1, steps: 20 }),
    });
    expect(r.greeks).toBeUndefined();
  });
});

describe('compareEngines with a stochastic panel (WS4.3)', () => {
  it('runs [bsm, heston, monteCarlo] without error and returns finite rows', () => {
    const call = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const mkt = market({ spot: 100, riskFreeRate: 0.03, volatility: 0.2, asOf });
    const cmp = compareEngines({
      contract: call,
      market: mkt,
      options: {
        engines: [
          engines.blackScholesMerton(),
          engines.heston({ v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.6 }),
          engines.monteCarlo({ paths: 20_000, seed: 3 }),
        ],
      },
    });
    expect(cmp.rows).toHaveLength(3);
    expect(cmp.rows.every((row) => Number.isFinite(row.value))).toBe(true);
  });
});
