/**
 * Fixtures for the constructor/factory heads of the pre-Stage-4 packages (2026-08-23, fourth
 * external review): the count-safety gate went library-wide, and completeness there has the same
 * law the overflow mutant enforces — a governed head the gate cannot feed is a head it does not
 * govern. These 49 heads (fee/slippage/borrow models, brokers, bond and curve builders, option
 * contract builders, shocks, strategy legs, smile/cube builders) had no fixtures because the
 * deep-sweep completeness ledger only requires them for multi-argument or explain-bearing
 * callables. Feeding them also enrolls them in the deep sweep's happy-path and key-deletion laws.
 *
 * Values come from each function's own documented example call or its test suite.
 */
import { kst } from '@totalfinance/technical-analysis';
import type { FixtureThunk } from '../inputs.js';

const BOND = {
  issueDate: '2026-01-15',
  maturityDate: '2031-01-15',
  couponRate: 0.05,
  frequency: 2,
};

export const CONSTRUCTOR_FIXTURES: Record<string, FixtureThunk> = {
  // technical-analysis — public class constructor/restorer whose runtime contract is exactly four
  // periods while the source-compatible declaration deliberately remains `number[]`.
  'technical-analysis.KstStream.constructor': () => [
    {
      rocPeriods: [10, 15, 20, 30],
      smaPeriods: [10, 10, 10, 15],
      signal: 9,
    },
  ],
  'technical-analysis.KstStream.fromJSON': () => [kst.stream({}).toJSON()],

  // backtest — execution-cost and borrow models, and the simulated broker
  // Stage 4.6 slice 1 (2026-09-03): the execution-reality factories on @totalfinance/backtest/execution.
  'backtest.execution.simplified': () => [],
  'backtest.execution.declared': () => [{ label: 'fixture: quote fills', observation: 'quote' }],
  'backtest.fillModels.bar': () => [],
  'backtest.fillModels.quote': () => [],
  'backtest.fillModels.orderBook': () => [],
  'backtest.spreadModels.halfSpreadBps': () => [2],
  'backtest.spreadModels.none': () => [],
  'backtest.impactModels.squareRoot': () => [{ coefficient: 0.1 }],
  'backtest.impactModels.none': () => [],
  'backtest.latencyModels.sessions': () => [1],
  'backtest.fees.none': () => [],
  'backtest.fees.bps': () => [5],
  'backtest.fees.fixed': () => [1],
  'backtest.fees.perShare': () => [0.01],
  'backtest.slippage.none': () => [],
  'backtest.slippage.bps': () => [5],
  'backtest.slippage.fixed': () => [0.01],
  'backtest.slippage.spread': () => [0.02],
  'backtest.borrow.none': () => [],
  'backtest.borrow.annualRate': () => [0.03],
  'backtest.brokers.simulated': () => [{ cash: 100_000 }],

  // fixed-income — bond builders, short-rate models, credit and discount curves
  'fixed-income.bonds.fixedRate': () => [{ ...BOND }],
  'fixed-income.bonds.zeroCoupon': () => [{ issueDate: '2026-01-15', maturityDate: '2031-01-15' }],
  'fixed-income.bonds.floatingRateNote': () => [{ ...BOND, couponRate: 0.03 }],
  'fixed-income.bonds.inflationLinked': () => [{ ...BOND, baseIndex: 100 }],
  'fixed-income.bonds.amortizing': () => [{ ...BOND, amortization: { type: 'straight' } }],
  'fixed-income.cir': () => [{ a: 0.2, b: 0.04, sigma: 0.05, r0: 0.03 }],
  'fixed-income.vasicek': () => [{ a: 0.2, b: 0.04, sigma: 0.01, r0: 0.03 }],
  'fixed-income.credit.survivalFromHazards': () => [
    [
      ['2027-01-15', 0.02],
      ['2028-01-15', 0.025],
    ],
    { referenceDate: '2026-07-20' },
  ],
  'fixed-income.credit.survivalFromProbabilities': () => [
    [
      ['2027-01-15', 0.9802],
      ['2028-01-15', 0.955],
    ],
    { referenceDate: '2026-07-20' },
  ],
  'fixed-income.curves.fromZeroRates': () => [
    [
      ['2027-01-15', 0.045],
      ['2028-01-15', 0.047],
    ],
    { referenceDate: '2026-07-20' },
  ],
  'fixed-income.curves.fromDiscountFactors': () => [
    [
      ['2027-01-15', 0.956],
      ['2028-01-15', 0.912],
    ],
    { referenceDate: '2026-07-20' },
  ],
  'fixed-income.curves.bootstrapMultiCurve': () => [
    {
      referenceDate: '2026-01-01',
      ois: [
        { type: 'ois', maturity: '2027-01-01', rate: 0.03 },
        { type: 'ois', maturity: '2029-01-01', rate: 0.033 },
      ],
      projection: [
        { type: 'swap', maturity: '2027-01-01', rate: 0.032 },
        { type: 'swap', maturity: '2029-01-01', rate: 0.035 },
      ],
    },
  ],

  // options — contract and market builders
  'options.market': () => [
    { spot: 195.3, riskFreeRate: 0.045, volatility: 0.24, asOf: '2026-07-20T00:00:00Z' },
  ],
  'options.european': () => [
    {
      convention: 'us-equity-close',
      type: 'call',
      underlying: 'AAPL',
      strike: 200,
      expiry: '2026-12-18',
    },
  ],
  'options.callContract': () => [
    {
      convention: 'us-equity-close',
      underlying: 'AAPL',
      style: 'american',
      strike: 200,
      expiry: '2026-12-18',
    },
  ],
  'options.putContract': () => [
    {
      convention: 'us-equity-close',
      underlying: 'AAPL',
      style: 'american',
      strike: 190,
      expiry: '2026-12-18',
    },
  ],
  'options.usEquityCall': () => [{ underlying: 'AAPL', strike: 200, expiry: '2026-12-18' }],
  'options.usEquityPut': () => [{ underlying: 'AAPL', strike: 190, expiry: '2026-12-18' }],
  'options.usEquityOption': () => [
    { type: 'call', underlying: 'AAPL', strike: 200, expiry: '2026-12-18' },
  ],
  'options.dividendTermStructure': () => [
    {
      spot: 100,
      riskFreeRate: 0.05,
      dividendYield: 0.01,
      dividends: [
        { exDate: '2026-04-01', amount: 1.5 },
        { exDate: '2026-10-01', amount: 1.5 },
      ],
      asOf: '2026-01-15T00:00:00Z',
      maturities: ['2026-06-19', '2026-12-18'],
    },
  ],

  // risk — scenario shocks
  'risk.shock.spot': () => ['-5%'],
  'risk.shock.volatility': () => ['+10%'],
  'risk.shock.riskFreeRate': () => ['+50bp'],
  'risk.shock.dividend': () => ['-5%'],
  'risk.shock.time': () => [1 / 252],

  // strategy — leg builders
  'strategy.legs.call': () => [
    { strike: 105, premium: 2.5, quantity: 1, expiry: '2026-12-18', impliedVolatility: 0.2 },
  ],
  'strategy.legs.put': () => [
    { strike: 95, premium: 2.1, quantity: -1, expiry: '2026-12-18', impliedVolatility: 0.2 },
  ],
  'strategy.legs.stock': () => [{ price: 100, quantity: -100 }],

  // volatility — smile and cube builders
  'volatility.smileFromQuotes': () => [
    {
      forward: 100,
      timeToExpiryYears: 0.25,
      atmVolatility: 0.2,
      riskReversal: -0.02,
      butterfly: 0.01,
    },
  ],
  'volatility.swaptionCube': () => [
    {
      nodes: [
        {
          expiryYears: 1,
          tenorYears: 5,
          forward: 0.03,
          strikes: [0.02, 0.03, 0.04],
          volatilities: [0.24, 0.2, 0.22],
        },
        {
          expiryYears: 5,
          tenorYears: 5,
          forward: 0.032,
          strikes: [0.022, 0.032, 0.042],
          volatilities: [0.23, 0.19, 0.21],
        },
      ],
      maximumIterations: 100,
    },
  ],
};
