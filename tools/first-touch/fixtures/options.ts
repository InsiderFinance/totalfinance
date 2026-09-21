/**
 * Deep-sweep fixture shard — see ../fixtures.ts for the contract. Keys are sweep paths; thunks
 * return FRESH valid argument lists (probes mutate arguments).
 *
 * Conventions in this shard:
 *   - Monte-Carlo fixtures use ~200 paths, few steps, and a fixed seed — fast AND deterministic;
 *   - lattice/COS fixtures use small resolutions (51-step Leisen–Reimer reference, 96–128 COS terms);
 *   - the parity fixtures build an exact BSM chain at t = 0.5 (same construction as parity.test.ts),
 *     so the regression always converges.
 */

import { engines } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { resolvedExpiry } from '@totalfinance/core';
import { FLAT_IMPLIED_SURFACE, MARKET, type FixtureThunk } from '../inputs.js';

// ── shared builders ──────────────────────────────────────────────────────────────────────────────

const CONTRACT = (): Record<string, unknown> => ({
  underlying: 'ACME',
  type: 'call',
  style: 'european',
  strike: 100,
  expiry: '2026-06-19',
  ...resolvedExpiry('2026-06-19'),
});

const AMERICAN_CONTRACT = (): Record<string, unknown> => ({
  underlying: 'ACME',
  type: 'put',
  style: 'american',
  strike: 100,
  expiry: '2026-06-19',
  ...resolvedExpiry('2026-06-19'),
});

const MC = (): Record<string, unknown> => ({ seed: 7, paths: 200 });
const MC_STEPPED = (): Record<string, unknown> => ({ seed: 7, paths: 200, steps: 10 });

const BS_INPUT = (): Record<string, unknown> => ({
  spot: 105,
  strike: 100,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.04,
  volatility: 0.2,
  dividendYield: 0.01,
});

/**
 * A pricing input with the solved-for volatility REMOVED.
 *
 * `blackScholesImpliedVolatility({ ...BS_INPUT(), price })` read naturally and was wrong: it handed
 * the solver `volatility: 0.2` — the answer it was being asked to compute. While the solvers ignored
 * unknown keys this merely looked odd; once Law 12 reached them it became a rejected baseline, which
 * costs a measurement rather than an assertion. Named so the next fixture author sees the intent.
 */
const IV_TARGET = (input: Record<string, unknown>): Record<string, unknown> => {
  const { volatility: _volatility, normalVolatility: _normalVolatility, ...rest } = input;
  return rest;
};

const B76_INPUT = (): Record<string, unknown> => ({
  forward: 100,
  strike: 100,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.04,
  volatility: 0.2,
});

// Bachelier volatility is NORMAL, in price units — hence the field name normalVolatility (Law 4).
const BACHELIER_INPUT = (): Record<string, unknown> => ({
  forward: 100,
  strike: 100,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.02,
  normalVolatility: 15,
});

const HESTON_INPUT = (): Record<string, unknown> => ({
  spot: 100,
  strike: 100,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.03,
  dividendYield: 0.01,
});

// Feller-satisfying (2κθ = 0.12 ≥ ξ² = 0.09) so the happy path carries no warning.
const HESTON_PARAMS = (): Record<string, unknown> => ({
  v0: 0.04,
  kappa: 1.5,
  theta: 0.04,
  sigma: 0.3,
  rho: -0.6,
});

const SABR_PARAMS = (): Record<string, unknown> => ({
  alpha: 0.2,
  beta: 0.5,
  rho: -0.3,
  nu: 0.4,
});

/** A flat implied-vol surface — Dupire collapses it to σ_loc ≡ 0.2 (the BSM anchor). */

const BARRIER_INPUT = (): Record<string, unknown> => ({
  spot: 100,
  strike: 100,
  barrier: 140,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.03,
  volatility: 0.2,
  dividendYield: 0.01,
});

const ASIAN_INPUT = (): Record<string, unknown> => ({
  spot: 100,
  strike: 100,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.03,
  volatility: 0.2,
  dividendYield: 0.01,
});

const LOOKBACK_INPUT = (): Record<string, unknown> => ({
  spot: 100,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.03,
  volatility: 0.2,
  dividendYield: 0.01,
});

const SPREAD_INPUT = (): Record<string, unknown> => ({
  spot1: 100,
  spot2: 95,
  strike: 5,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.03,
  volatility1: 0.25,
  volatility2: 0.2,
  correlation: 0.5,
  dividendYield1: 0.01,
  dividendYield2: 0,
});

const QUANTO_INPUT = (): Record<string, unknown> => ({
  spot: 100,
  strike: 100,
  timeToExpiryYears: 0.5,
  domesticRate: 0.03,
  foreignRate: 0.01,
  volatility: 0.2,
  fxVolatility: 0.1,
  correlation: 0.3,
  dividendYield: 0.01,
});

const COMPO_INPUT = (): Record<string, unknown> => ({
  spot: 100,
  fxSpot: 1.2,
  strike: 125,
  timeToExpiryYears: 0.5,
  domesticRate: 0.03,
  volatility: 0.2,
  fxVolatility: 0.1,
  correlation: 0.3,
  dividendYield: 0.01,
});

const INVERSE_INPUT = (): Record<string, unknown> => ({
  spot: 60000,
  strike: 65000,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.05,
  coinYield: 0.01,
  volatility: 0.7,
});

const NAPOLEON_INPUT = (): Record<string, unknown> => ({
  spot: 100,
  resetTimes: [0.25, 0.5, 0.75, 1],
  riskFreeRate: 0.03,
  volatility: 0.2,
  dividendYield: 0.01,
  coupon: 0.1,
  globalFloor: 0,
  notional: 100,
});

const MULTI_ASSET_INPUT = (): Record<string, unknown> => ({
  spots: [100, 95],
  strike: 100,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.03,
  volatilities: [0.2, 0.25],
  correlation: [
    [1, 0.5],
    [0.5, 1],
  ],
  dividendYields: [0.01, 0],
});

const BASKET_INPUT = (): Record<string, unknown> => ({
  ...MULTI_ASSET_INPUT(),
  strike: 95,
  weights: [0.6, 0.4],
});

const AUTOCALLABLE_INPUT = (): Record<string, unknown> => ({
  spot: 100,
  observationTimes: [0.25, 0.5, 0.75, 1],
  riskFreeRate: 0.03,
  volatility: 0.2,
  dividendYield: 0.01,
  autocallBarrier: 105,
  couponRate: 0.02,
  knockInBarrier: 70,
  notional: 100,
});

/** Struct-of-arrays batch columns (3 rows; `type`: 1 = call, ≤ 0 = put). */
const BATCH_COLS = (): Record<string, unknown> => ({
  spot: Float64Array.from([100, 105, 95]),
  strike: Float64Array.from([100, 100, 100]),
  volatility: Float64Array.from([0.2, 0.25, 0.3]),
  riskFreeRate: Float64Array.from([0.03, 0.03, 0.03]),
  timeToExpiryYears: Float64Array.from([0.5, 0.5, 0.5]),
  type: Int8Array.from([1, -1, 1]),
});

// ── parity chain (same construction as packages/options/test/parity.test.ts) ────────────────────
//
// A full ISO datetime expiry is parsed as-is by the option-expiry convention, so asOf can be set
// such that ACT/365F time-to-expiry is exactly T = 0.5, and every mid is the exact BSM price of a
// KNOWN {spot, r, q, σ} — parity then recovers F/q/r to machine precision.

const PARITY_EXPIRY = '2026-06-19T20:00:00.000Z';
const PARITY_T = 0.5;
const PARITY_AS_OF = Date.parse(PARITY_EXPIRY) - PARITY_T * 365 * 86_400_000;
const PARITY_SPOT = 100;
const PARITY_RATE = 0.03;
const PARITY_DIV_YIELD = 0.01;
const PARITY_SIGMA = 0.22;

function parityChain(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const strike of [80, 90, 95, 100, 105, 110, 120]) {
    for (const type of ['call', 'put'] as const) {
      rows.push({
        contract: {
          underlying: 'ACME',
          type,
          style: 'european',
          strike,
          expiry: PARITY_EXPIRY,
          ...resolvedExpiry(PARITY_EXPIRY),
        },
        // `timestampMs`, not `ts`: the declared name on OptionQuote. The fixture carried the short
        // spelling and nothing looked, because validation never recursed into array ELEMENTS.
        timestampMs: PARITY_AS_OF,
        mid: blackScholesPrice({
          type,
          spot: PARITY_SPOT,
          strike,
          timeToExpiryYears: PARITY_T,
          riskFreeRate: PARITY_RATE,
          dividendYield: PARITY_DIV_YIELD,
          volatility: PARITY_SIGMA,
        }),
      });
    }
  }
  return rows;
}

// ── the shard ────────────────────────────────────────────────────────────────────────────────────

export const OPTIONS_FIXTURES: Record<string, FixtureThunk> = {
  // Black–Scholes facade (S1 object inputs, `.explain()` bearing)
  'options.blackScholes.call': () => [BS_INPUT()],
  'options.blackScholes.put': () => [BS_INPUT()],
  'options.blackScholes.price': () => [{ ...BS_INPUT(), type: 'call' }],
  'options.blackScholes.greeks': () => [{ ...BS_INPUT(), type: 'call' }],
  'options.blackScholes.extendedGreeks': () => [{ ...BS_INPUT(), type: 'call' }],
  'options.blackScholes.impliedVolatility': () => [
    { type: 'call', price: 9, spot: 105, strike: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.04 },
  ],

  // Black-76 facade + named expert kernels
  'options.black76.call': () => [B76_INPUT()],
  'options.black76.put': () => [B76_INPUT()],
  'options.black76.price': () => [{ ...B76_INPUT(), type: 'call' }],
  'options.black76.greeks': () => [{ ...B76_INPUT(), type: 'call' }],
  'options.black76.extendedGreeks': () => [{ ...B76_INPUT(), type: 'call' }],
  'options.black76.impliedVolatility': () => [
    {
      type: 'call',
      price: 5.5,
      forward: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.04,
    },
  ],
  'options.black76Price': () => [{ type: 'call', ...B76_INPUT() }],
  'options.black76Greeks': () => [{ type: 'call', ...B76_INPUT() }],
  'options.black76ExtendedGreeks': () => [{ type: 'call', ...B76_INPUT() }],
  'options.black76ImpliedVolatility': () => [
    { type: 'call', price: 5.5, ...IV_TARGET(B76_INPUT()) },
  ],
  'options.black76PriceBounds': () => [
    { type: 'call', forward: 100, strike: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.04 },
  ],

  // Bachelier facade + named expert kernels
  'options.bachelier.call': () => [BACHELIER_INPUT()],
  'options.bachelier.put': () => [BACHELIER_INPUT()],
  'options.bachelier.price': () => [{ ...BACHELIER_INPUT(), type: 'call' }],
  'options.bachelier.greeks': () => [{ ...BACHELIER_INPUT(), type: 'call' }],
  'options.bachelier.extendedGreeks': () => [{ ...BACHELIER_INPUT(), type: 'call' }],
  'options.bachelier.impliedVolatility': () => [
    {
      type: 'call',
      price: 4,
      forward: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.02,
    },
  ],
  'options.bachelierPrice': () => [{ type: 'call', ...BACHELIER_INPUT() }],
  'options.bachelierGreeks': () => [{ type: 'call', ...BACHELIER_INPUT() }],
  'options.bachelierExtendedGreeks': () => [{ type: 'call', ...BACHELIER_INPUT() }],
  'options.bachelierImpliedVolatility': () => [
    {
      type: 'call',
      price: 4,
      forward: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.02,
    },
  ],

  // BSM named expert kernels
  'options.blackScholesPrice': () => [{ type: 'call', ...BS_INPUT() }],
  'options.blackScholesGreeks': () => [{ type: 'call', ...BS_INPUT() }],
  'options.blackScholesExtendedGreeks': () => [{ type: 'call', ...BS_INPUT() }],
  // A solver takes a PRICE and returns a volatility; spreading the pricing input passed it the very
  // quantity being solved for, which Law 12 now (correctly) refuses.
  'options.blackScholesImpliedVolatility': () => [
    { type: 'call', price: 9, ...IV_TARGET(BS_INPUT()) },
  ],
  'options.blackScholesPriceBounds': () => [
    {
      type: 'call',
      spot: 105,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
    },
  ],

  // Pro API
  'options.chainGreeks': () => [
    {
      quotes: [95, 100, 105].map((strike) => ({
        contract: { ...CONTRACT(), strike },
        timestampMs: Date.UTC(2026, 0, 2),
        bid: Math.max(105 - strike, 0) + 4,
        ask: Math.max(105 - strike, 0) + 6,
        underlyingPrice: 105,
      })),
      market: { spot: 105, riskFreeRate: 0.04, asOf: '2026-01-02T00:00:00Z' },
    },
  ],
  'options.option.price': () => [{ contract: CONTRACT(), market: MARKET() }],
  'options.option.impliedVolatility': () => [
    { contract: CONTRACT(), market: { ...MARKET(), price: 9 }, method: 'brent' },
  ],
  'options.option.compareEngines': () => [
    {
      contract: CONTRACT(),
      market: MARKET(),
      options: {
        engines: [engines.blackScholesMerton()],
        reference: engines.binomial({ variant: 'leisen-reimer', steps: 51 }),
      },
    },
  ],
  'options.validateOptionPricingEngine': () => [
    engines.blackScholesMerton(),
    [{ contract: CONTRACT(), market: MARKET() }],
  ],
  'options.engines.binomial': () => [{ variant: 'leisen-reimer', steps: 51 }],
  'options.engines.trinomial': () => [{ steps: 51 }],
  'options.engines.finiteDifference.crankNicolson': () => [{ gridPoints: 51, timeSteps: 51 }],
  'options.engines.monteCarlo': () => [{ seed: 7, paths: 200 }],
  'options.engines.heston': () => [
    { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.3, rho: -0.6 },
    { terms: 64 },
  ],
  'options.engines.localVolatility': () => [FLAT_IMPLIED_SURFACE, MC_STEPPED()],
  'options.equityLattice': () => [
    {
      spot: 100,
      riskFreeRate: 0.03,
      dividendYield: 0.01,
      volatility: 0.2,
      horizonYears: 0.5,
      steps: 20,
      variant: 'crr',
    },
  ],
  'options.americanImpliedVolatility': () => [
    {
      contract: AMERICAN_CONTRACT(),
      market: { spot: 105, riskFreeRate: 0.04, asOf: '2026-01-02T00:00:00Z', price: 4 },
      options: {},
    },
  ],
  'options.americanExercise': () => [
    {
      contract: AMERICAN_CONTRACT(),
      market: { spot: 95, riskFreeRate: 0.05, volatility: 0.25, asOf: '2026-01-02T00:00:00Z' },
      options: { boundaryPoints: 8 },
    },
  ],

  // Monte-Carlo European pricing + GBM primitives
  'options.monteCarloPrice': () => [{ contract: CONTRACT(), market: MARKET(), options: MC() }],
  'options.monteCarloEuropean': () => [
    {
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      dividendYield: 0.01,
      volatility: 0.2,
      options: MC(),
    },
  ],
  'options.gbm.path': () => [
    {
      spot: 100,
      riskFreeRate: 0.03,
      dividendYield: 0.01,
      volatility: 0.2,
      timeToExpiryYears: 1,
      shocks: [0.5, -0.25, 0.8],
    },
  ],
  'options.gbm.terminal': () => [
    {
      spot: 100,
      riskFreeRate: 0.03,
      dividendYield: 0.01,
      volatility: 0.2,
      timeToExpiryYears: 1,
      shock: 0.35,
    },
  ],

  // Heston (COS analytic + QE Monte-Carlo)
  'options.heston.price': () => [
    {
      type: 'call',
      input: HESTON_INPUT(),
      parameters: HESTON_PARAMS(),
      options: { terms: 128, greeks: false },
    },
  ],
  'options.heston.monteCarloPrice': () => [
    { type: 'call', input: HESTON_INPUT(), parameters: HESTON_PARAMS(), options: MC_STEPPED() },
  ],
  'options.heston.cosineExpansion': () => [
    {
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      dividendYield: 0.01,
      parameters: HESTON_PARAMS(),
      terms: 96,
      truncation: 12,
    },
  ],
  'options.heston.impliedVolatility': () => [
    {
      type: 'call',
      input: HESTON_INPUT(),
      parameters: HESTON_PARAMS(),
      options: { terms: 128 },
    },
  ],
  'options.heston.monteCarloEstimate': () => [
    {
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      dividendYield: 0.01,
      parameters: HESTON_PARAMS(),
      options: MC_STEPPED(),
    },
  ],

  // SABR (Hagan asymptotics + Euler Monte-Carlo)
  'options.sabr.volatility': () => [
    {
      input: { forward: 100, strike: 105, timeToExpiryYears: 0.5 },
      parameters: SABR_PARAMS(),
      options: { volatilityType: 'lognormal' },
    },
  ],
  'options.sabr.price': () => [
    {
      type: 'call',
      input: { forward: 100, strike: 105, timeToExpiryYears: 0.5, riskFreeRate: 0.03 },
      parameters: SABR_PARAMS(),
      options: { greeks: false },
    },
  ],
  'options.sabr.monteCarloPrice': () => [
    {
      type: 'call',
      input: { forward: 100, strike: 105, timeToExpiryYears: 0.5, riskFreeRate: 0.03 },
      parameters: SABR_PARAMS(),
      options: MC_STEPPED(),
    },
  ],
  'options.sabr.monteCarloEstimate': () => [
    {
      type: 'call',
      forward: 100,
      strike: 105,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      parameters: SABR_PARAMS(),
      options: MC_STEPPED(),
    },
  ],

  // Dupire local volatility
  'options.localVolatility.fromImplied': () => [
    {
      impliedVolatility: FLAT_IMPLIED_SURFACE,
      market: { spot: 100, riskFreeRate: 0.03, dividendYield: 0.01 },
      options: { logMoneynessStep: 0.01, timeStepYears: 1 / 365, floorVolatility: 1e-3 },
    },
  ],
  'options.localVolatility.grid': () => [
    FLAT_IMPLIED_SURFACE,
    { levels: [50, 100, 150], times: [0.1, 0.5, 1] },
  ],
  'options.localVolatility.monteCarloPrice': () => [
    {
      type: 'call',
      input: {
        spot: 100,
        strike: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.03,
        dividendYield: 0.01,
      },
      localVolatility: FLAT_IMPLIED_SURFACE,
      options: MC_STEPPED(),
    },
  ],
  'options.localVolatility.monteCarloEstimate': () => [
    {
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      dividendYield: 0.01,
      localVolatility: FLAT_IMPLIED_SURFACE,
      options: MC_STEPPED(),
    },
  ],

  // Exotics
  'options.barrier.price': () => [{ ...BARRIER_INPUT(), type: 'call', barrierType: 'up-out' }],
  'options.barrier.monteCarloPrice': () => [
    { ...BARRIER_INPUT(), type: 'call', barrierType: 'up-out' },
    { seed: 7, paths: 200, steps: 20 },
  ],
  'options.digital.price': () => [
    {
      type: 'call',
      kind: 'cash-or-nothing',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
  ],
  'options.digital.monteCarloPrice': () => [
    {
      type: 'call',
      kind: 'cash-or-nothing',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
    MC(),
  ],
  'options.digital.greeks': () => [
    {
      type: 'call',
      kind: 'cash-or-nothing',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
  ],
  'options.digital.extendedGreeks': () => [
    {
      type: 'call',
      kind: 'cash-or-nothing',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
  ],
  'options.touch.price': () => [
    {
      kind: 'one-touch',
      spot: 100,
      barrier: 120,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
  ],
  'options.touch.greeks': () => [
    {
      kind: 'one-touch',
      spot: 100,
      barrier: 120,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
  ],
  'options.touch.monteCarloPrice': () => [
    {
      kind: 'one-touch',
      spot: 100,
      barrier: 120,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
    { seed: 7, paths: 200, steps: 20 },
  ],
  'options.doubleTouch.price': () => [
    {
      kind: 'double-no-touch',
      spot: 100,
      lower: 90,
      upper: 115,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
  ],
  'options.doubleTouch.greeks': () => [
    {
      kind: 'double-no-touch',
      spot: 100,
      lower: 90,
      upper: 115,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
  ],
  'options.doubleTouch.monteCarloPrice': () => [
    {
      kind: 'double-no-touch',
      spot: 100,
      lower: 90,
      upper: 115,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      cash: 1,
    },
    { seed: 7, paths: 200, steps: 20 },
  ],
  'options.forwardStart.price': () => [
    {
      type: 'call',
      spot: 100,
      strikeMultiplier: 1,
      resetTime: 0.25,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
    },
  ],
  'options.forwardStart.monteCarloPrice': () => [
    {
      type: 'call',
      spot: 100,
      strikeMultiplier: 1,
      resetTime: 0.25,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
    },
    MC(),
  ],
  'options.cliquet.price': () => [
    {
      spot: 100,
      resetTimes: [0.25, 0.5],
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      localFloor: 0,
      localCap: 0.05,
      notional: 100,
    },
  ],
  'options.cliquet.monteCarloPrice': () => [
    {
      spot: 100,
      resetTimes: [0.25, 0.5],
      riskFreeRate: 0.03,
      volatility: 0.2,
      dividendYield: 0.01,
      localFloor: 0,
      localCap: 0.05,
      globalCap: 0.1,
      notional: 100,
    },
    MC(),
  ],
  'options.napoleon.monteCarloPrice': () => [NAPOLEON_INPUT(), MC()],
  'options.reverseCliquet.monteCarloPrice': () => [NAPOLEON_INPUT(), MC()],
  'options.reverseCliquet.floorlessValue': () => [NAPOLEON_INPUT()],
  'options.asian.geometricPrice': () => [{ ...ASIAN_INPUT(), type: 'call', averagingPoints: 12 }],
  'options.asian.monteCarloPrice': () => [
    { ...ASIAN_INPUT(), type: 'call' },
    { ...MC(), averagingPoints: 12 },
  ],
  'options.lookback.price': () => [{ ...LOOKBACK_INPUT(), type: 'put', strikeType: 'floating' }],
  'options.lookback.monteCarloPrice': () => [
    { ...LOOKBACK_INPUT(), type: 'put', strikeType: 'floating' },
    { seed: 7, paths: 200, steps: 20 },
  ],
  'options.spread.price': () => [{ ...SPREAD_INPUT(), type: 'call' }],
  'options.spread.monteCarloPrice': () => [{ ...SPREAD_INPUT(), type: 'call' }, MC()],
  'options.quanto.price': () => [{ ...QUANTO_INPUT(), type: 'call' }],
  'options.compo.price': () => [{ ...COMPO_INPUT(), type: 'call' }],
  'options.compo.greeks': () => [{ ...COMPO_INPUT(), type: 'call' }],
  'options.compo.monteCarloPrice': () => [{ ...COMPO_INPUT(), type: 'call' }, MC()],
  'options.inverseOption.price': () => [{ ...INVERSE_INPUT(), type: 'call' }],
  'options.inverseOption.greeks': () => [{ ...INVERSE_INPUT(), type: 'call' }],
  'options.inverseOption.monteCarloPrice': () => [{ ...INVERSE_INPUT(), type: 'call' }, MC()],
  'options.basket.approximatePrice': () => [{ ...BASKET_INPUT(), type: 'call' }],
  'options.basket.monteCarloPrice': () => [{ ...BASKET_INPUT(), type: 'call' }, MC()],
  'options.rainbow.monteCarloPrice': () => [
    { ...MULTI_ASSET_INPUT(), type: 'call', kind: 'max' },
    MC(),
  ],
  'options.autocallable.monteCarloPrice': () => [AUTOCALLABLE_INPUT(), MC()],
  'options.varianceSwap.hestonFairVariance': () => [{ v0: 0.04, kappa: 1.5, theta: 0.05 }, 1],

  // Batch pricing
  'options.priceMany': () => [
    { contracts: [CONTRACT()], market: MARKET(), engine: engines.blackScholesMerton() },
  ],
  'options.blackScholesPriceManyInto': () => [BATCH_COLS(), new Float64Array(3)],

  // Quote price-source selection
  'options.selectQuotePrice': () => [
    {
      contract: {
        underlying: 'ACME',
        type: 'call',
        style: 'european',
        strike: 100,
        expiry: '2026-06-19',
        ...resolvedExpiry('2026-06-19'),
      },
      // `Quote` declares `timestampMs` (a required EpochMs) and no `ts` at all. This fixture drifted:
      // the probe was mutating an undeclared key while the required one was absent, so the boundary
      // was measured against a quote no caller could write.
      timestampMs: PARITY_AS_OF,
      bid: 5.4,
      ask: 5.6,
      mid: 5.5,
    },
    'mid',
  ],

  // Put-call parity / implied carry from a snapshot chain
  'options.impliedForward': () => [
    {
      quotes: parityChain(),
      expiry: PARITY_EXPIRY,
      options: { riskFreeRate: PARITY_RATE, asOf: PARITY_AS_OF, source: 'mid' },
    },
  ],
  'options.impliedDividendYield': () => [
    {
      quotes: parityChain(),
      expiry: PARITY_EXPIRY,
      options: {
        riskFreeRate: PARITY_RATE,
        spot: PARITY_SPOT,
        asOf: PARITY_AS_OF,
        source: 'mid',
      },
    },
  ],
  'options.impliedBorrow': () => [
    {
      quotes: parityChain(),
      expiry: PARITY_EXPIRY,
      options: {
        riskFreeRate: PARITY_RATE,
        spot: PARITY_SPOT,
        asOf: PARITY_AS_OF,
        source: 'mid',
      },
    },
  ],
  'options.boxSpreadRate': () => [
    {
      quotes: parityChain(),
      expiry: PARITY_EXPIRY,
      lowerStrike: 95,
      upperStrike: 105,
      options: { asOf: PARITY_AS_OF, source: 'mid' },
    },
  ],
};
