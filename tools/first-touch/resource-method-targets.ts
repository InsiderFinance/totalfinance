/**
 * Executable fixtures for resource-bearing receiver methods.
 *
 * Module-export sweeps cannot discover `position.payoff({ prices: { steps } })` or
 * `features(bars).sma('close', { period })`: the count lives on a receiver returned at runtime.
 * Keep this registry exact against compiler-derived method declarations in count-safety-sweep;
 * adding a resource-bearing method without an executable fixture must fail CI.
 */

import { cdsParSpread, creditSpreadCurve } from '@totalfinance/fixed-income';
import { strategy } from '@totalfinance/strategy';
import { exposure } from '@totalfinance/structure';
import { features, signal } from '@totalfinance/technical-analysis';
import { volatilityCone, volatilitySurface } from '@totalfinance/volatility';
import { allFixtures, BARS } from './fixtures.js';

type Callable = (...args: unknown[]) => unknown;

export interface ResourceMethodTarget {
  /** Compiler contract head, e.g. `strategy.Position#payoff`. */
  key: string;
  /** A boundary wrapper that constructs a fresh receiver before invoking the method. */
  fn: Callable;
  /** Fresh method arguments with every declared resource coordinate materialized. */
  fixture: () => unknown[];
}

function fixtureArguments(key: string): unknown[] {
  const fixture = allFixtures().get(key);
  if (fixture === undefined) throw new Error(`resource-method-targets: no fixture for ${key}`);
  return fixture();
}

function call(fn: unknown, args: unknown[]): unknown {
  if (typeof fn !== 'function') throw new Error('resource-method-targets: subject is not callable');
  return Reflect.apply(fn, undefined, args);
}

function callMethod(receiver: unknown, method: string, args: unknown[]): unknown {
  if (receiver === null || (typeof receiver !== 'object' && typeof receiver !== 'function')) {
    throw new Error(`resource-method-targets: ${method} receiver was not an object`);
  }
  const fn = (receiver as Record<string, unknown>)[method];
  if (typeof fn !== 'function') {
    throw new Error(`resource-method-targets: receiver has no callable ${method}`);
  }
  return Reflect.apply(fn, receiver, args);
}

function position(): unknown {
  return strategy(
    [
      { kind: 'call', strike: 100, expiry: '2026-06-19', premium: 4.25, quantity: 1 },
      { kind: 'call', strike: 110, expiry: '2026-06-19', premium: 1.4, quantity: -1 },
    ],
    {
      multiplier: 100,
      market: {
        spot: 105,
        volatility: 0.22,
        riskFreeRate: 0.03,
        asOf: '2026-01-02T00:00:00Z',
        expiry: '2026-06-19',
      },
    },
  );
}

function exposureProfile(): unknown {
  return call(exposure, fixtureArguments('structure.exposure'));
}

function surface(): unknown {
  return call(volatilitySurface, fixtureArguments('volatility.volatilitySurface'));
}

const priceGrid = (): unknown[] => [{ prices: { from: 80, to: 130, steps: 21 } }];
const scenarioGrid = (): unknown[] => [
  {
    prices: { from: 80, to: 130, steps: 11 },
    volatilityShocks: [0],
    daysForward: [0],
  },
];

const positionTarget = (
  key: string,
  method: string,
  fixture: () => unknown[],
): ResourceMethodTarget => ({
  key,
  fn: (...args) => callMethod(position(), method, args),
  fixture,
});

const featureTarget = (
  key: string,
  method: string,
  fixture: () => unknown[],
): ResourceMethodTarget => ({
  key,
  fn: (...args) => callMethod(features(BARS()), method, args),
  fixture,
});

const signalTarget = (
  key: string,
  method: string,
  fixture: () => unknown[],
): ResourceMethodTarget => ({
  key,
  fn: (...args) => callMethod(signal(BARS()), method, args),
  fixture,
});

export const RESOURCE_METHOD_TARGETS: readonly ResourceMethodTarget[] = [
  {
    key: 'fixed-income.CdsParSpreadFacade#explain',
    fn: (...args) => callMethod(cdsParSpread, 'explain', args),
    fixture: () => fixtureArguments('fixed-income.cdsParSpread'),
  },
  {
    key: 'fixed-income.CreditSpreadCurveFacade#explain',
    fn: (...args) => callMethod(creditSpreadCurve, 'explain', args),
    fixture: () => fixtureArguments('fixed-income.credit.creditSpreadCurve'),
  },

  positionTarget('strategy.Position#chartData', 'chartData', priceGrid),
  positionTarget('strategy.Position#payoff', 'payoff', priceGrid),
  positionTarget('strategy.Position#scenarioTable', 'scenarioTable', scenarioGrid),
  positionTarget('strategy.Position#whatIfCube', 'whatIfCube', scenarioGrid),
  positionTarget('strategy.Position#monteCarloProbability', 'monteCarloProbability', () => [
    { seed: 7, paths: 200, steps: 10 },
  ]),

  {
    key: 'structure.ExposureProfile#scenarioMap',
    fn: (...args) => callMethod(exposureProfile(), 'scenarioMap', args),
    fixture: () => [{ spot: { from: 90, to: 110, steps: 11 } }],
  },

  featureTarget('technical-analysis.FeaturePipeline#atr', 'atr', () => [{ period: 14 }]),
  featureTarget('technical-analysis.FeaturePipeline#bbands', 'bbands', () => [
    'close',
    { period: 20 },
  ]),
  featureTarget('technical-analysis.FeaturePipeline#ema', 'ema', () => ['close', { period: 14 }]),
  featureTarget('technical-analysis.FeaturePipeline#macd', 'macd', () => [
    'close',
    { fast: 12, slow: 26, signal: 9 },
  ]),
  featureTarget('technical-analysis.FeaturePipeline#rollingVolatility', 'rollingVolatility', () => [
    'close',
    { period: 20, annualization: 252 },
  ]),
  featureTarget('technical-analysis.FeaturePipeline#rsi', 'rsi', () => ['close', { period: 14 }]),
  featureTarget('technical-analysis.FeaturePipeline#sma', 'sma', () => ['close', { period: 14 }]),
  featureTarget('technical-analysis.FeaturePipeline#wma', 'wma', () => ['close', { period: 14 }]),

  signalTarget('technical-analysis.SignalBuilder#atr', 'atr', () => [{ period: 14 }]),
  signalTarget('technical-analysis.SignalBuilder#ema', 'ema', () => ['close', { period: 14 }]),
  signalTarget('technical-analysis.SignalBuilder#rsi', 'rsi', () => ['close', { period: 14 }]),
  signalTarget('technical-analysis.SignalBuilder#sma', 'sma', () => ['close', { period: 14 }]),
  signalTarget('technical-analysis.SignalBuilder#wma', 'wma', () => ['close', { period: 14 }]),

  {
    key: 'volatility.VolatilityConeFacade#explain',
    fn: (...args) => callMethod(volatilityCone, 'explain', args),
    fixture: () => fixtureArguments('volatility.volatilityCone'),
  },
  {
    key: 'volatility.VolatilitySurface#arbitrage',
    fn: (...args) => callMethod(surface(), 'arbitrage', args),
    fixture: () => [{ butterflyPoints: 40, calendarPoints: 21 }],
  },
];
