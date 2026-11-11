/** One literal public-import journey, compiled and executed from packed artifacts too. */
import {
  annuityPayment,
  amortizationSchedule,
  internalRateOfReturn,
} from '@insiderfinance/totalfinance/valuation';
import { minVariance } from '@insiderfinance/totalfinance/risk';
import { strategy, legs } from '@insiderfinance/totalfinance/strategy';
import { blackScholes } from '@insiderfinance/totalfinance/options/black-scholes';
import { black76 } from '@insiderfinance/totalfinance/options/black76';
import { asian, spread } from '@insiderfinance/totalfinance/options';
import { fitGarch } from '@insiderfinance/totalfinance/volatility/forecast';
import { ols } from '@insiderfinance/totalfinance/math';

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertNumericalRepairs(): void {
  const terms = {
    principal: 1e12,
    periodicInterestRate: 1e-12 / 100 / 12,
    numberOfPeriods: 1200,
    paymentTiming: 'end' as const,
    balloon: 0,
  };
  check(Math.abs(annuityPayment(terms) / 833333333.3337504 - 1) < 1e-14, '#16 annuity reference');
  check(amortizationSchedule(terms).rows.at(-1)!.closingBalance === 0, '#16 final balance');
  const risk = minVariance(
    [
      [0.04, 0.02],
      [0.02, 0.01],
    ],
    {
      budget: 1,
      bounds: [
        [0, 1],
        [0, 1],
      ],
      maximumIterations: 1000,
      tolerance: 1e-8,
    },
  );
  check(
    !risk.diagnostics.converged &&
      risk.diagnostics.warnings.some((w) => w.context?.['conditionNumber'] === null),
    '#17 honest singular report',
  );
  const expiry = '2026-01-01T00:00:00Z';
  const position = strategy([legs.call({ strike: 1e-10, premium: 2e-12, quantity: 1, expiry })], {
    multiplier: 1,
  });
  check(Math.abs(position.metrics().breakevens[0]! / 1e-12 - 102) < 1e-11, '#18 scaled break-even');
  const option = {
    type: 'call' as const,
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0,
    dividendYield: 0,
    volatility: 1e-17,
  };
  const premium = 3.989422804014327e-16;
  check(Math.abs(blackScholes.price(option) / premium - 1) < 1e-14, '#19 BSM ATM');
  check(
    Math.abs(
      black76.price({
        type: 'call',
        forward: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0,
        volatility: 1e-17,
      }) /
        premium -
        1,
    ) < 1e-14,
    '#19 Black76 ATM',
  );
  check(
    !fitGarch(Array<number>(60).fill(0.0023), { mean: 'sample', seed: 42 }).converged,
    '#20 constant GARCH',
  );
  check(
    Math.abs(
      internalRateOfReturn({
        cashFlows: [
          { amount: -1e-100, timeYears: 0 },
          { amount: 2.5e-100, timeYears: 5 },
        ],
      })! - 0.20112443398143123,
    ) < 1e-11,
    '#21 IRR scale',
  );
  const mc = asian.monteCarloPrice(
    {
      type: 'put',
      spot: 1,
      strike: 1e6,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.0001,
    },
    { averagingPoints: 12, paths: 1000, seed: 42 },
  );
  check(mc.monteCarlo.standardError! > 0, '#22 sampling uncertainty');
  check(
    mc.monteCarlo.confidenceInterval === null ||
      mc.monteCarlo.confidenceInterval[0] < mc.monteCarlo.confidenceInterval[1],
    '#22 no false point interval',
  );
  const exchange = spread.price({
    type: 'call',
    spot1: 1,
    spot2: 1,
    strike: 0,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    dividendYield1: 0,
    dividendYield2: 0,
    volatility1: 0.2000000001,
    volatility2: 0.2,
    correlation: 1,
  });
  check(
    Math.abs(exchange.value / 3.98942202681338666e-11 - 1) < 1e-13,
    '#23 binary64 exchange reference',
  );
  const regression = ols([1, 2, 2, 4], [[0], [1], [2], [3]], { intercept: true, hac: { lags: 0 } });
  check(Math.abs(regression.standardErrors[0]! ** 2 - 113 / 2500) < 1e-14, '#24 HC1 convention');
  // Ordinary supported calls remain useful alongside the precision-boundary cases.
  check(
    Math.abs(blackScholes.price({ ...option, volatility: 0.2 }) - 7.965567455405804) < 1e-12,
    'ordinary option price',
  );
  check(
    Math.abs(
      annuityPayment({
        principal: 250000,
        periodicInterestRate: 0.005,
        numberOfPeriods: 360,
        paymentTiming: 'end',
      }) - 1498.876312881881,
    ) < 1e-9,
    'ordinary annuity',
  );
}
