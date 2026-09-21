/**
 * Phase 3A compile contract.
 *
 * This file is included by the workspace typecheck but never executed. Every object call must
 * compile, and every pre-Phase-3A positional financial call must keep producing a type error. An
 * accidental compatibility overload therefore turns an `@ts-expect-error` into a CI failure.
 */

import { blackKernel } from '@totalfinance/fixed-income/rates';
import { maxSharpe } from '@totalfinance/risk';
import { buildStrategy } from '@totalfinance/strategy';
import { terminalCdf } from '@totalfinance/strategy/probability';
import { exposure } from '@totalfinance/structure';
import { fibExtension } from '@totalfinance/technical-analysis';
import { AlmaStream } from '@totalfinance/technical-analysis/moving-averages';
import { volatilitySurface } from '@totalfinance/volatility';
import {
  compareEngines,
  engines,
  impliedForward,
  market,
  option,
  priceMany,
} from '@totalfinance/options';
import { bachelierPrice } from '@totalfinance/options/bachelier';
import { black76Price } from '@totalfinance/options/black76';
import { blackScholesPrice } from '@totalfinance/options/bsm';
import { hestonPrice } from '@totalfinance/options/heston';
import { dupireLocalVolatility } from '@totalfinance/options/local-volatility';
import { monteCarloEuropean } from '@totalfinance/options/monte-carlo';
import { sabrVolatility } from '@totalfinance/options/sabr';

function assertSignatureCompatibility(): void {
  blackScholesPrice({
    type: 'call',
    spot: 100,
    strike: 105,
    timeToExpiryYears: 0.25,
    riskFreeRate: 0.04,
    dividendYield: 0.01,
    volatility: 0.2,
  });
  // @ts-expect-error Phase 3A removed homogeneous positional BSM scalars.
  blackScholesPrice('call', 100, 105, 0.25, 0.04, 0.01, 0.2);

  black76Price({
    type: 'call',
    forward: 100,
    strike: 105,
    timeToExpiryYears: 0.25,
    riskFreeRate: 0.04,
    volatility: 0.2,
  });
  // @ts-expect-error Phase 3A removed homogeneous positional Black-76 scalars.
  black76Price('call', 100, 105, 0.25, 0.04, 0.2);

  bachelierPrice({
    type: 'call',
    forward: 0.04,
    strike: 0.05,
    timeToExpiryYears: 1,
    riskFreeRate: 0.03,
    normalVolatility: 0.01,
  });
  // @ts-expect-error Phase 3A removed homogeneous positional Bachelier scalars.
  bachelierPrice('call', 0.04, 0.05, 1, 0.03, 0.01);

  monteCarloEuropean({
    type: 'call',
    spot: 100,
    strike: 105,
    timeToExpiryYears: 0.25,
    riskFreeRate: 0.04,
    dividendYield: 0.01,
    volatility: 0.2,
    options: { paths: 1_000, seed: 7 },
  });
  // @ts-expect-error Phase 3A removed positional Monte Carlo market coordinates.
  monteCarloEuropean('call', 100, 105, 0.25, 0.04, 0.01, 0.2, {
    paths: 1_000,
    seed: 7,
  });

  hestonPrice({
    type: 'call',
    input: {
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
    },
    parameters: { v0: 0.04, theta: 0.04, kappa: 1.5, sigma: 0.3, rho: -0.6 },
  });
  hestonPrice(
    'call',
    // @ts-expect-error Phase 3A removed split Heston arguments.
    { spot: 100, strike: 105, t: 0.25, riskFreeRate: 0.04, dividendYield: 0.01 },
    { v0: 0.04, theta: 0.04, kappa: 1.5, sigma: 0.3, rho: -0.6 },
  );

  sabrVolatility({
    input: { forward: 100, strike: 105, timeToExpiryYears: 0.25 },
    parameters: { alpha: 0.2, beta: 0.5, rho: -0.2, nu: 0.4 },
  });
  sabrVolatility(
    { forward: 100, strike: 105, t: 0.25 },
    // @ts-expect-error Phase 3A removed split SABR arguments.
    { alpha: 0.2, beta: 0.5, rho: -0.2, nu: 0.4 },
  );

  dupireLocalVolatility({
    impliedVolatility: () => 0.2,
    market: { spot: 100, riskFreeRate: 0.04, dividendYield: 0.01 },
  });
  // @ts-expect-error Phase 3A removed split local-volatility arguments.
  dupireLocalVolatility(() => 0.2, { spot: 100, riskFreeRate: 0.04, dividendYield: 0.01 });

  blackKernel({
    forward: 0.04,
    strike: 0.05,
    volatility: 0.2,
    timeToExpiryYears: 1,
    right: 'call',
  });
  // @ts-expect-error Phase 3A removed positional fixed-income Black scalars.
  blackKernel(0.04, 0.05, 0.2, 1, 'call');

  maxSharpe({
    mean: [0.1, 0.08],
    covariance: [
      [0.04, 0.01],
      [0.01, 0.03],
    ],
  });
  maxSharpe(
    [0.1, 0.08],
    // @ts-expect-error Phase 3A removed split optimizer arguments.
    [
      [0.04, 0.01],
      [0.01, 0.03],
    ],
  );

  const asOf = Date.UTC(2026, 0, 1);
  const contract = option.call({
    underlying: 'XYZ',
    strike: 100,
    expiry: '2026-06-19',
    style: 'european',
  });
  const optionMarket = market({ spot: 100, riskFreeRate: 0.04, volatility: 0.2, asOf });
  engines.blackScholes().price({ contract, market: optionMarket });
  // @ts-expect-error Phase 3A removed split engine price arguments.
  engines.blackScholes().price(contract, optionMarket);
  compareEngines({ contract, market: optionMarket });
  // @ts-expect-error Phase 3A removed split engine-comparison arguments.
  compareEngines(contract, optionMarket);

  priceMany({ contracts: [contract], market: optionMarket });
  // @ts-expect-error Phase 3A removed split row-batch arguments.
  priceMany([contract], optionMarket);

  impliedForward({ quotes: [], expiry: '2026-06-19', options: { riskFreeRate: 0.04, asOf } });
  // @ts-expect-error Phase 3A removed split parity-analysis arguments.
  impliedForward([], '2026-06-19', { riskFreeRate: 0.04, asOf });

  exposure({
    quotes: [],
    market: { spot: 100, riskFreeRate: 0.04, asOf },
    config: { convention: 'dealerShortGamma' },
  });
  // @ts-expect-error Phase 3A removed split exposure arguments.
  exposure([], { spot: 100, riskFreeRate: 0.04, asOf }, { convention: 'dealerShortGamma' });

  volatilitySurface({ quotes: [], market: { spot: 100, riskFreeRate: 0.04, asOf } });
  // @ts-expect-error Phase 3A removed split surface-construction arguments.
  volatilitySurface([], { spot: 100, riskFreeRate: 0.04, asOf });

  terminalCdf({ spot: 100, strike: 105, drift: 0.05, volatility: 0.2, timeToExpiryYears: 1 });
  // @ts-expect-error Phase 3A removed positional probability coordinates.
  terminalCdf(100, 105, 0.05, 0.2, 1);

  fibExtension({ start: 100, end: 110, projectFrom: 104 });
  // @ts-expect-error Phase 3A removed ambiguous a/b/c positional coordinates.
  fibExtension(100, 110, 104);

  new AlmaStream({ period: 20, offset: 0.85, sigma: 6 });
  // @ts-expect-error Phase 3A removed positional exported stream constructors.
  new AlmaStream(20, 0.85, 6);

  buildStrategy({ name: 'ironCondor', input: {} });
  // @ts-expect-error Phase 3A removed split dynamic-strategy arguments.
  buildStrategy('ironCondor', {});
}

void assertSignatureCompatibility;

export {};
