/**
 * Deep-sweep fixture shard — see ../fixtures.ts for the contract. Keys are sweep paths; thunks
 * return FRESH valid argument lists (probes mutate arguments).
 *
 * Covers the fixed-income, vol, and risk packages. Inputs are deliberately SMALL (short curves,
 * two-expiry chains, few Monte-Carlo paths) so the four-way probe matrix stays fast; stochastic
 * callables carry explicit integer seeds so every probe run is reproducible.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { type OptionQuote, optionExpiryToMs, yearFraction } from '@totalfinance/core';
import { bonds, credit, curves, type YieldCurve } from '@totalfinance/fixed-income';
import { shock, type Scenario } from '@totalfinance/risk';
import { legs, strategy } from '@totalfinance/strategy';
import {
  type ESSVIParameters,
  fitGarch,
  fitHarRv,
  type GarchFit,
  type HarRvFit,
  type SSVIParameters,
  type SVIParameters,
  volatilitySurface,
  type VolatilitySurface,
} from '@totalfinance/volatility';
import { sviVolatility } from '@totalfinance/volatility/svi';
import { COV2, RETURNS, type FixtureThunk } from '../inputs.js';

// ── fixed-income inputs ──────────────────────────────────────────────────────────────────────────

const REF = '2026-01-01';

const FI_FLAT = (): YieldCurve =>
  curves.flat({ rate: 0.03, referenceDate: REF, options: { dayCount: 'ACT/365F' } });

const FI_ZERO = (): YieldCurve =>
  curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.035],
      ['2032-01-01', 0.04],
    ],
    { referenceDate: REF },
  );

const FI_SURVIVAL = (): unknown => credit.flatHazard({ hazardRate: 0.025, referenceDate: REF });

const FI_BOND = (): unknown =>
  bonds.fixedRate({
    issueDate: REF,
    maturityDate: '2031-01-01',
    couponRate: 0.05,
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });

const FI_SWAP = (): Record<string, unknown> => ({
  startDate: REF,
  maturityDate: '2030-01-01',
  fixedRate: 0.035,
  fixedFrequency: 'semiannual',
  floatFrequency: 'quarterly',
});

const FI_CDS = (): Record<string, unknown> => ({
  effectiveDate: REF,
  maturityDate: '2029-01-01',
  spread: 0.015,
  recovery: 0.4,
  protectionSteps: 4,
});

// ── vol inputs ───────────────────────────────────────────────────────────────────────────────────

const VOL_ASOF = Date.UTC(2026, 0, 2);
const VOL_E0 = '2026-04-02';
const VOL_E1 = '2026-07-02';
const VOL_SPOT = 100;
const VOL_RATE = 0.03;
const VOL_STRIKES = [80, 90, 95, 100, 105, 110, 120];

/** Arbitrage-free SVI smiles with total variance growing in maturity (calendar-safe). */
const VOL_SVI: Record<string, SVIParameters> = {
  [VOL_E0]: { a: 0.008, b: 0.06, rho: -0.4, m: 0, sigma: 0.08 },
  [VOL_E1]: { a: 0.018, b: 0.1, rho: -0.4, m: 0, sigma: 0.1 },
};

const SVI_P = (): SVIParameters => ({ a: 0.008, b: 0.06, rho: -0.4, m: 0, sigma: 0.08 });
const SSVI_P = (): SSVIParameters => ({
  rho: -0.4,
  phi: { kind: 'power-law', eta: 1.5, gamma: 0.4 },
  thetaTerm: [
    { timeToExpiryYears: 0.25, theta: 0.02 },
    { timeToExpiryYears: 1, theta: 0.06 },
  ],
});
const ESSVI_P = (): ESSVIParameters => ({
  phi: { kind: 'power-law', eta: 1.5, gamma: 0.4 },
  thetaTerm: [
    { timeToExpiryYears: 0.25, theta: 0.02, rho: -0.6 },
    { timeToExpiryYears: 1, theta: 0.06, rho: -0.3 },
  ],
});

function VOL_QUOTES(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const expiry of [VOL_E0, VOL_E1]) {
    const t = yearFraction(VOL_ASOF, optionExpiryToMs(expiry), 'ACT/365F');
    const F = VOL_SPOT * Math.exp(VOL_RATE * t);
    for (const strike of VOL_STRIKES) {
      const impliedVolatility = sviVolatility(VOL_SVI[expiry]!, Math.log(strike / F), t);
      for (const type of ['call', 'put'] as const) {
        rows.push({
          contract: {
            underlying: 'X',
            type,
            style: 'european',
            strike,
            expiry,
            ...resolvedExpiry(expiry),
          },
          timestampMs: VOL_ASOF,
          impliedVolatility,
          underlyingPrice: VOL_SPOT,
        });
      }
    }
  }
  return rows;
}

const VOL_MARKET = (): Record<string, unknown> => ({
  spot: VOL_SPOT,
  riskFreeRate: VOL_RATE,
  asOf: VOL_ASOF,
});

// The surface is an immutable class instance (exempt from key-deletion; probes never mutate it),
// so one shared build serves every surface-first fixture without paying the SVI fit per probe.
let volatilitySurfaceCache: VolatilitySurface | null = null;
const VOL_SURFACE = (): VolatilitySurface =>
  (volatilitySurfaceCache ??= volatilitySurface({
    quotes: VOL_QUOTES(),
    market: { spot: VOL_SPOT, riskFreeRate: VOL_RATE, asOf: VOL_ASOF },
    config: { model: 'svi' },
  }));

const IV_HISTORY = (): number[] =>
  Array.from({ length: 40 }, (_, i) => 0.18 + 0.06 * Math.sin(i / 3) + (i % 4) * 0.005);

/**
 * Positive realized-variance history for the HAR-RV fit AND forecast (40 ≥ monthly 22 + the 4 rows
 * OLS needs). The `i % 5` term is load-bearing: a PURE sinusoid makes the daily/weekly/monthly
 * predictors near-exact linear combinations of one another, and `fitHarRv` rightly refuses that
 * design as singular — at every length, not just this one. Same series `volatility.fitHarRv` uses
 * (analysis-vol.ts), so the two HAR fixtures measure the same data.
 */
const RV_HISTORY = (): number[] =>
  Array.from({ length: 40 }, (_, i) => 1e-4 * (1 + 0.3 * Math.sin(i / 2) + 0.05 * ((i % 5) / 5)));

/**
 * A REAL fit, not a hand-rolled literal. `garchForecast` declares `fit: GarchFit`, and a GarchFit
 * carries `assumptions` and `diagnostics` — both REQUIRED, and neither honestly inventable by hand.
 * The literal that used to live here omitted them, so the fixture measured a call TypeScript would
 * reject; `fitGarch` is the producer the implementation's own error path names. Seeded, so every
 * probe run is reproducible.
 */
const GARCH_FIT = (): GarchFit => fitGarch(RETURNS(), { seed: 7 });

/**
 * A REAL fit, which is what `harRvForecast` tells callers to pass. The hand-written stand-in drifted
 * twice: it carried `n`, renamed to `observationCount`, and predated the `assumptions`/`diagnostics`
 * blocks. Sourcing it from the producer cannot drift again.
 */
const HAR_FIT = (): HarRvFit => fitHarRv(RV_HISTORY(), { weekly: 5, monthly: 22 });

// ── risk inputs ──────────────────────────────────────────────────────────────────────────────────

const GREEKS = (): Record<string, unknown> => ({
  value: 5.2,
  spot: 100,
  delta: 0.55,
  gamma: 0.02,
  vega: 0.12,
  theta: -0.01,
  rho: 0.05,
});

const SCENARIO = (): Scenario => ({
  name: 'sell-off',
  shocks: [
    { factor: 'spot', kind: 'absolute', value: -5 },
    { factor: 'vol', kind: 'absolute', value: 0.02 },
  ],
});

const SHARPE_STATS = (): Record<string, unknown> => ({
  sharpe: 0.08,
  observations: 120,
  skewness: -0.2,
  kurtosis: 3.4,
});

const TRIAL_SHARPES = (): number[] => [0.02, 0.05, 0.11, 0.07, 0.04];

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

export const FI_VOL_RISK_FIXTURES: Record<string, FixtureThunk> = {
  // fixed-income: conventions
  'fixed-income.addMonths': () => ['2026-01-31', 3, true],
  'fixed-income.compareDates': () => ['2026-01-01', '2027-06-15'],
  'fixed-income.daysInMonth': () => [2026, 2],
  'fixed-income.yearFraction': () => ['2026-01-01', '2027-07-01', 'ACT/365F'],

  // fixed-income: curves
  'fixed-income.curves.bootstrap': () => [
    [
      { type: 'deposit', maturity: '2026-07-01', rate: 0.03 },
      { type: 'swap', maturity: '2028-01-01', rate: 0.032, fixedFrequency: 'semiannual' },
    ],
    { referenceDate: REF },
  ],
  'fixed-income.curves.bootstrapProjection': () => [
    [{ type: 'swap', maturity: '2028-01-01', rate: 0.034 }],
    { referenceDate: REF, discountCurve: FI_FLAT() },
  ],
  'fixed-income.curves.flat': () => [
    { rate: 0.03, referenceDate: REF, options: { dayCount: 'ACT/365F' } },
  ],
  'fixed-income.discountFromZero': () => [0.03, 2, 'continuous'],
  'fixed-income.zeroFromDiscount': () => [0.94, 2, 'continuous'],

  // fixed-income: bonds
  'fixed-income.priceMultiCurve': () => [
    FI_BOND(),
    { settlementDate: REF, discountCurve: FI_FLAT() },
  ],
  'fixed-income.bondDiscountCurvePricer': () => [
    {
      curveId: 'USD.treasury',
      currency: 'USD',
      priceType: 'dirty',
      interpolation: 'logLinearDiscount',
      extrapolation: 'flatForward',
    },
  ],
  'fixed-income.yieldToCall': () => [
    FI_BOND(),
    { callDate: '2029-01-01', callPrice: 102 },
    { settlementDate: '2026-06-01', price: 104 },
  ],

  // fixed-income: rates derivatives
  'fixed-income.blackKernel': () => [
    { forward: 0.04, strike: 0.035, volatility: 0.2, timeToExpiryYears: 1.5, right: 'call' },
  ],
  'fixed-income.bachelierKernel': () => [
    { forward: 0.03, strike: 0.035, normalVolatility: 0.01, timeToExpiryYears: 1.5, right: 'call' },
  ],
  'fixed-income.fraValue': () => [
    { start: '2026-04-01', end: '2026-07-01', fixedRate: 0.03 },
    { curve: FI_FLAT() },
  ],
  'fixed-income.swapValue': () => [FI_SWAP(), { discountCurve: FI_ZERO() }],
  'fixed-income.swapRate': () => [
    // H04: the par spec OMITS fixedRate — the par rate is the answer, and passing one teaches.
    (({ fixedRate: _irrelevant, ...par }) => par)(FI_SWAP()),
    { discountCurve: FI_ZERO() },
  ],
  'fixed-income.forwardSwap': () => [
    { startDate: '2027-01-01', maturityDate: '2030-01-01', fixedFrequency: 'semiannual' },
    { discountCurve: FI_ZERO() },
  ],
  'fixed-income.crossCurrencyBasisCurve': () => [
    { spot: 1.08, domestic: FI_ZERO(), foreign: FI_FLAT(), basis: FI_FLAT() },
  ],
  'fixed-income.impliedCrossCurrencyBasis': () => [
    {
      spot: 1.08,
      domestic: FI_ZERO(),
      foreign: FI_FLAT(),
      forwards: [['2028-01-01', 1.1]] as [string, number][],
    },
  ],
  'fixed-income.swaptionPrice': () => [
    {
      startDate: '2027-01-01',
      maturityDate: '2030-01-01',
      fixedRate: 0.035,
      fixedFrequency: 'semiannual',
      floatFrequency: 'quarterly',
      expiry: '2027-01-01',
      volatility: 0.25,
      optionType: 'payer',
    },
    { discountCurve: FI_ZERO() },
  ],
  'fixed-income.capFloorPrice': () => [
    {
      startDate: REF,
      maturityDate: '2028-01-01',
      strike: 0.035,
      volatility: 0.3,
      type: 'cap',
      frequency: 'quarterly',
      dayCount: 'ACT/360',
    },
    { discountCurve: FI_ZERO() },
  ],
  'fixed-income.forwardCmsRate': () => [
    { resetDate: '2028-01-01', swapTenorYears: 3, volatility: 0.25 },
    { discountCurve: FI_ZERO() },
  ],

  // fixed-income: short-rate models
  'fixed-income.hullWhite': () => [FI_ZERO(), { a: 0.05, sigma: 0.01 }],
  'fixed-income.g2pp': () => [FI_ZERO(), { a: 0.05, sigma: 0.01, b: 0.1, eta: 0.008, rho: -0.5 }],
  'fixed-income.shortRateTree': () => [
    FI_FLAT(),
    { meanReversion: 0.05, sigma: 0.01, model: 'hull-white', horizonYears: 2, steps: 8 },
  ],

  // fixed-income: XVA (seeded, few paths — structural checks only)
  'fixed-income.swapXva': () => [
    {
      curve: FI_ZERO(),
      startDate: REF,
      maturityDate: '2029-01-01',
      fixedRate: 0.033,
      optionType: 'payer',
      notional: 1_000_000,
      fixedFrequency: 'semiannual',
    },
    {
      meanReversion: 0.05,
      sigma: 0.01,
      counterpartySurvival: FI_SURVIVAL(),
      recovery: 0.4,
      seed: 7,
      paths: 200,
      stepsPerYear: 4,
    },
  ],

  // fixed-income: credit
  'fixed-income.cdsValue': () => [
    FI_CDS(),
    { discountCurve: FI_FLAT(), survivalCurve: FI_SURVIVAL() },
  ],
  'fixed-income.cdsParSpread': () => [
    // H02: the par spec OMITS spread — the par spread is the answer, and passing one teaches.
    (({ spread: _irrelevant, ...par }) => par)(FI_CDS()),
    { discountCurve: FI_FLAT(), survivalCurve: FI_SURVIVAL() },
  ],
  'fixed-income.credit.flatHazard': () => [{ hazardRate: 0.02, referenceDate: REF }],
  'fixed-income.credit.bootstrapHazardFromCds': () => [
    [
      { maturity: '2027-01-01', spread: 0.008 },
      { maturity: '2029-01-01', spread: 0.012 },
    ],
    { referenceDate: REF, discountCurve: FI_FLAT(), recovery: 0.4, protectionSteps: 4 },
  ],
  'fixed-income.credit.creditSpreadCurve': () => [
    ['2027-01-01', '2029-01-01'],
    {
      referenceDate: REF,
      discountCurve: FI_FLAT(),
      survivalCurve: FI_SURVIVAL(),
      recovery: 0.4,
      protectionSteps: 4,
    },
  ],
  'fixed-income.credit.cdsBasis': () => [{ cdsParSpread: 0.015, bondImpliedSpread: 0.012 }],

  // volatility: surface + term structure
  'volatility.volatilitySurface': () => [
    { quotes: VOL_QUOTES(), market: VOL_MARKET(), config: { model: 'svi' } },
  ],
  'volatility.skew': () => [
    { quotes: VOL_QUOTES(), market: VOL_MARKET(), config: { expiry: VOL_E0 } },
  ],
  'volatility.forwardVolatility': () => [VOL_SURFACE(), VOL_E0, VOL_E1],
  'volatility.calendarSkew': () => [VOL_SURFACE(), VOL_E0, VOL_E1],
  'volatility.forwardSkew': () => [VOL_SURFACE(), VOL_E0, VOL_E1, { step: 0.05 }],
  'volatility.localVolatilitySurface': () => [
    {
      impliedVolatility: () => 0.2,
      market: { spot: VOL_SPOT, riskFreeRate: VOL_RATE },
      options: {},
    },
  ],
  'volatility.surfaceLocalVolatility': () => [
    { surface: VOL_SURFACE(), market: { spot: VOL_SPOT, riskFreeRate: VOL_RATE }, options: {} },
  ],
  'volatility.calibrateHestonSurface': () => [
    {
      targets: [
        { strike: 95, timeToExpiryYears: 0.25, impliedVolatility: 0.22, forward: 100.75 },
        { strike: 100, timeToExpiryYears: 0.25, impliedVolatility: 0.2, forward: 100.75 },
        { strike: 105, timeToExpiryYears: 0.25, impliedVolatility: 0.19, forward: 100.75 },
        { strike: 100, timeToExpiryYears: 0.5, impliedVolatility: 0.21, forward: 101.5 },
      ],
      market: { spot: VOL_SPOT, riskFreeRate: VOL_RATE, dividendYield: 0 },
      options: { terms: 32, maximumIterations: 40 },
    },
  ],

  // volatility: SVI slice math
  'volatility.sviTotalVariance': () => [SVI_P(), 0.1],
  'volatility.sviVolatility': () => [SVI_P(), 0.1, 0.5],
  'volatility.sviG': () => [SVI_P(), 0.1],

  // volatility: SSVI surface evaluators
  'volatility.ssviTotalVariance': () => [SSVI_P(), 0.1, 0.5],
  'volatility.ssviVolatility': () => [SSVI_P(), 0.1, 0.5],

  // volatility: eSSVI surface evaluators (per-maturity skew)
  'volatility.essviTotalVariance': () => [ESSVI_P(), 0.1, 0.5],
  'volatility.essviVolatility': () => [ESSVI_P(), 0.1, 0.5],

  // volatility: SABR Bartlett (minimum-variance) greeks
  'volatility.sabrBartlettGreeks': () => [
    {
      type: 'call',
      input: { forward: 100, strike: 105, timeToExpiryYears: 0.5 },
      parameters: { alpha: 0.2, beta: 0.5, rho: -0.3, nu: 0.4 },
      options: { volatilityType: 'lognormal' },
    },
  ],

  // volatility: analytics
  'volatility.riskNeutralDistribution': () => [
    (_strike: number) => 0.2,
    { spot: VOL_SPOT, timeToExpiryYears: 0.25, riskFreeRate: VOL_RATE },
  ],
  'volatility.volatilityCone': () => [RETURNS(), { windows: [10, 20], periodsPerYear: 252 }],

  // volatility: IV metrics & spreads
  'volatility.impliedVolatilityRank': () => [{ current: 0.25, history: IV_HISTORY() }],
  'volatility.impliedVolatilityPercentile': () => [{ current: 0.25, history: IV_HISTORY() }],
  'volatility.impliedVolatilityStatistics': () => [{ current: 0.25, history: IV_HISTORY() }],
  'volatility.expectedMoveFromImpliedVolatility': () => [
    { spot: 100, impliedVolatility: 0.2, timeToExpiryYears: 0.25 },
  ],
  'volatility.expectedMoveFromStraddle': () => [{ spot: 100, straddlePrice: 5 }],
  'volatility.probabilityInTheMoney': () => [
    {
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
    },
  ],
  'volatility.probabilityOfTouch': () => [
    { spot: 100, barrier: 115, timeToExpiryYears: 0.5, riskFreeRate: 0.03, volatility: 0.2 },
  ],
  'volatility.realizedImpliedSpread': () => [{ impliedVolatility: 0.25, realizedVolatility: 0.2 }],
  'volatility.varianceRiskPremium': () => [{ impliedVolatility: 0.25, realizedVolatility: 0.2 }],

  // volatility: forecasting
  'volatility.garchForecast': () => [
    {
      fit: GARCH_FIT(),
      lastVariance: 1.2e-4,
      horizonPeriods: 5,
      options: { periodsPerYear: 252 },
    },
  ],
  'volatility.harRvForecast': () => [HAR_FIT(), RV_HISTORY()],

  // risk: portfolio variance / decomposition
  'risk.explainPnl': () => [
    {
      greeks: {
        value: 5,
        spot: 100,
        delta: 0.5,
        gamma: 0.02,
        vega: 0.1,
        theta: -0.01,
        rho: 0.05,
      },
      move: { dSpot: 1, dVolatility: 0.01, dTimeYears: 0.01, dRate: 0.001 },
      actualPnl: 1.0,
    },
  ],
  'risk.analyzeBook': () => [
    [
      {
        position: strategy(
          [
            legs.put({ strike: 95, premium: 2, quantity: -1 }),
            legs.put({ strike: 90, premium: 1, quantity: 1 }),
          ],
          { multiplier: 100, expiry: '2026-06-19' },
        ),
        market: { spot: 100, volatility: 0.2, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' },
        underlying: 'XYZ',
        beta: 1,
      },
    ],
    { indexPrice: 500 },
  ],
  'risk.explainPositionPnl': () => [
    {
      position: strategy(
        [
          legs.put({ strike: 95, premium: 2, quantity: -1 }),
          legs.put({ strike: 90, premium: 1, quantity: 1 }),
        ],
        { multiplier: 100, expiry: '2026-06-19' },
      ),
      from: { spot: 100, volatility: 0.2, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' },
      to: { spot: 101, volatility: 0.21, riskFreeRate: 0.04, asOf: '2026-05-08T00:00:00Z' },
    },
  ],
  'risk.bookVaR': () => [
    [
      {
        position: strategy(
          [
            legs.put({ strike: 95, premium: 2, quantity: -1 }),
            legs.put({ strike: 90, premium: 1, quantity: 1 }),
          ],
          { multiplier: 100, expiry: '2026-06-19' },
        ),
        market: { spot: 100, volatility: 0.2, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' },
        underlying: 'XYZ',
      },
    ],
    {
      factors: { XYZ: { spotReturnVolatility: 0.2 } },
      confidence: 0.95,
      horizonDays: 1,
      samples: 500,
      seed: 42,
    },
  ],
  'risk.portfolioVariance': () => [[0.5, 0.5], COV2()],
  'risk.portfolioVolatility': () => [[0.5, 0.5], COV2()],
  'risk.riskContributions': () => [[0.5, 0.5], COV2()],
  'risk.diversificationRatio': () => [[0.5, 0.5], COV2()],
  'risk.portfolioVaR': () => [
    {
      weights: [0.5, 0.5],
      covariance: COV2(),
      method: 'monteCarlo',
      options: { confidence: 0.95, horizonPeriods: 1, samples: 500, seed: 42 },
    },
  ],

  // risk: optimizers
  'risk.maxSharpe': () => [
    {
      mean: [0.06, 0.04],
      covariance: COV2(),
      options: { riskFreeRatePerPeriod: 0.01, longOnly: true, maximumIterations: 200 },
    },
  ],
  'risk.meanVariance': () => [
    {
      mean: [0.06, 0.04],
      covariance: COV2(),
      options: { riskAversion: 4, longOnly: true, maximumIterations: 200 },
    },
  ],
  'risk.kelly': () => [
    {
      mean: [0.06, 0.04],
      covariance: COV2(),
      options: { fraction: 0.5, longOnly: true, maximumIterations: 200 },
    },
  ],

  // risk: scenarios & stress
  'risk.shock.factor': () => ['oilPrice', '+2pts'],
  'risk.taylorPnl': () => [GREEKS(), SCENARIO()],
  'risk.stressTest': () => [
    { positions: [{ id: 'p1', quantity: 2, greeks: GREEKS() }], scenarios: [SCENARIO()] },
  ],
  'risk.scenarioGrid': () => [
    {
      greeks: GREEKS(),
      spotShocks: [shock.spot('-5%'), shock.spot('+5%')],
      volatilityShocks: [shock.volatility('-2pts'), shock.volatility('+2pts')],
    },
  ],

  // risk: margin & book delta
  'risk.margin': () => [[500_000, -200_000], { equity: 400_000 }],
  'risk.optionsMargin': () => [
    [
      { type: 'call', strike: 105, premium: 2.5, quantity: -1 },
      { type: 'call', strike: 110, premium: 1.2, quantity: 1 },
    ],
    { spot: 100 },
  ],
  'risk.betaWeightedDelta': () => [
    [
      { delta: 100, spot: 250, beta: 1.2 },
      { delta: -40, spot: 90, beta: 0.8 },
    ],
    { indexPrice: 500 },
  ],

  // risk: research (Sharpe inference & CV splitters)
  'risk.deflatedSharpeRatio': () => [SHARPE_STATS(), { trialSharpes: TRIAL_SHARPES() }],
  'risk.parameterSweepDiagnostics': () => [TRIAL_SHARPES(), SHARPE_STATS()],
  'risk.covariance': () => [
    {
      returns: [
        [0.012, -0.004],
        [-0.008, 0.011],
        [0.005, 0.003],
        [0.014, -0.009],
      ],
    },
    { method: 'auto' },
  ],
  'risk.meanReturns': () => [
    {
      returns: [
        [0.01, 0.02],
        [0.03, -0.01],
      ],
      periodsPerYear: 252,
    },
  ],
  'risk.walkForwardSplits': () => [60, { trainSize: 20, testSize: 10, step: 10, mode: 'rolling' }],
  'risk.purgedKFold': () => [60, { folds: 5, embargo: 0.02, purgeGap: 2 }],
};
