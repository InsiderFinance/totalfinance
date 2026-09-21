/**
 * E5 fixture tranche: happy-path fixtures for previously-unfixtured ANALYSIS exports
 * (see tools/first-touch/unfixtured-analysis.ts — the shrink-only ratchet these burn down).
 * Same contract as every shard: thunks return FRESH, valid argument lists; probes mutate them.
 *
 * Inputs are deliberately SMALL and fully deterministic (tiny covariances, a 16-row scenario set,
 * a synthetic fat-tailed sample, capped solver iterations) so the four-way probe matrix stays fast.
 */

import { legs, strategy } from '@totalfinance/strategy';
import { COV2, RETURNS, type FixtureThunk } from '../inputs.js';

// ── shared inputs ────────────────────────────────────────────────────────────────────────────────

/** 3×3 symmetric positive-definite covariance (per-period, decimal² units). */
const COV3 = (): number[][] => [
  [0.04, 0.006, 0.002],
  [0.006, 0.05, 0.004],
  [0.002, 0.004, 0.06],
];

/** 12 monthly observations × 3 assets, observations-major (one row per period), deterministic. */
const MONTHLY_RETURNS = (): number[][] =>
  Array.from({ length: 12 }, (_, t) => [
    0.004 + 0.01 * Math.sin(t / 2),
    0.003 + 0.008 * Math.cos(t / 3),
    -0.001 + 0.006 * Math.sin(t / 4),
  ]);

/**
 * Deterministic fat-tailed daily returns: a mild cyclical base with periodic crash days whose
 * magnitudes VARY (7 distinct loss levels), so the GPD excesses are non-degenerate and the fitted
 * tail index stays well below 1 (finite Expected Shortfall).
 */
const FAT_RETURNS = (): number[] =>
  Array.from({ length: 120 }, (_, i) =>
    i % 8 === 7 ? -0.02 - 0.004 * ((i * 37) % 7) : 0.0012 + 0.006 * Math.sin(i / 3),
  );

/** Strongly positive-drift returns (per-observation Sharpe ≈ 2.8) for the research verdict. */
const TREND_RETURNS = (): number[] =>
  Array.from({ length: 120 }, (_, i) => 0.004 + 0.002 * Math.sin(i / 5));

/** A slightly degraded out-of-sample version of {@link TREND_RETURNS} (still clearly positive). */
const OOS_RETURNS = (): number[] =>
  Array.from({ length: 80 }, (_, i) => 0.003 + 0.002 * Math.sin(i / 4));

/** Per-observation trial Sharpes of a small parameter sweep (low dispersion ⇒ small SR₀). */
const TRIAL_SHARPES = (): number[] => [0.01, 0.03, 0.02, 0.05, 0.04, 0.015, 0.025, 0.035];

/** Hand-built Sharpe stats in the exact 4-key input shape (also accepted: sharpeStatistics reports). */
const SHARPE_STATS = (): Record<string, unknown> => ({
  sharpe: 0.12,
  observations: 252,
  skewness: -0.2,
  kurtosis: 3.5,
});

/** 16 deterministic 2-asset return scenarios; asset 1 carries the two crash rows. */
const CVAR_SCENARIOS = (): number[][] =>
  Array.from({ length: 16 }, (_, s) => [
    0.01 * Math.sin(s),
    s < 2 ? -0.12 : 0.008 + 0.003 * Math.cos(s),
  ]);

/** A defined-risk put spread marked by `Position.value()` (same species as the bookVaR fixture). */
const PUT_SPREAD = (): unknown =>
  strategy(
    [
      legs.put({ strike: 95, premium: 2, quantity: -1 }),
      legs.put({ strike: 90, premium: 1, quantity: 1 }),
    ],
    {
      multiplier: 100,
      expiry: '2026-06-19',
    },
  );

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

export const ANALYSIS_RISK_FIXTURES: Record<string, FixtureThunk> = {
  // portfolio approximations
  'risk.aggregateGreeks': () => [
    [
      {
        id: 'p1',
        quantity: 2,
        greeks: { value: 1.5, delta: 0.5, gamma: 0.02, vega: 0.1, theta: -0.03, rho: 0.05 },
      },
      { id: 'p2', quantity: -1, greeks: { value: 0.8, delta: -0.35 } },
    ],
  ],
  'risk.concentration': () => [[0.5, 0.3, 0.2], { topK: 2 }],
  'risk.liquidity': () => [
    [
      { size: 5_000, averageDailyVolume: 100_000 },
      { size: -20_000, averageDailyVolume: 250_000 },
    ],
    { participation: 0.2 },
  ],
  'risk.marketImpact': () => [
    { size: 50_000, averageDailyVolume: 1_000_000, volatility: 0.02 },
    { coefficient: 0.8 },
  ],
  'risk.nakedCallMargin': () => [{ spot: 100, strike: 110, premium: 2.5 }, { multiplier: 100 }],
  'risk.nakedPutMargin': () => [{ spot: 100, strike: 90, premium: 2 }, { multiplier: 100 }],

  // optimizers
  'risk.minVariance': () => [COV2(), { longOnly: true, maximumIterations: 200 }],
  'risk.riskParity': () => [COV3(), { maximumIterations: 2_000 }],
  'risk.hrp': () => [COV3(), { budget: 1 }],
  'risk.blackLitterman': () => [
    {
      covariance: COV2(),
      marketWeights: [0.6, 0.4],
      views: [{ pick: [1, -1], view: 0.02 }],
      riskAversion: 2.5,
      tau: 0.05,
      constraints: { longOnly: true, maximumIterations: 200 },
    },
  ],
  // Small scenario set + a low iteration cap: every probe re-runs the subgradient solve.
  'risk.conditionalValueAtRiskOptimize': () => [
    CVAR_SCENARIOS(),
    { alpha: 0.9, longOnly: true, maximumIterations: 150 },
  ],

  // risk-side portfolio construction (FC7 slice 4): a 5-point long-only frontier over the SPD
  // 3-asset covariance (the `count` coordinate is a work budget the count-safety mutant feeds), and
  // annualized historical-mean expected returns from the monthly sample.
  'risk.efficientFrontier': () => [
    {
      mean: [0.08, 0.1, 0.06],
      covariance: COV3(),
      grid: { kind: 'points', count: 5 },
      constraints: { longOnly: true, maximumIterations: 2_000 },
    },
  ],
  'risk.estimateExpectedReturns': () => [
    { method: 'historical-mean', returns: MONTHLY_RETURNS(), periodsPerYear: 12 },
  ],

  // factor / PCA
  'risk.pca': () => [COV3(), { correlation: false }],
  'risk.factorExposure': () => [COV3(), { factorCount: 2 }],

  // VaR report
  'risk.valueAtRiskReport': () => [
    RETURNS(),
    { confidence: 0.95, method: 'historical', horizonPeriods: 1 },
  ],

  // EVT tail pack (shared fat-tailed sample; confidence 0.99 sits INSIDE the 15% fitted tail)
  'risk.fitGeneralizedParetoTail': () => [FAT_RETURNS(), { tailFraction: 0.15, method: 'pwm' }],
  'risk.extremeValueTailRisk': () => [FAT_RETURNS(), { confidence: 0.99, tailFraction: 0.15 }],
  'risk.drawdownAtRisk': () => [RETURNS(), { confidence: 0.95 }],
  'risk.spectralRisk': () => [RETURNS(), { riskAversion: 5 }],
  'risk.meanExcessPlot': () => [
    FAT_RETURNS(),
    { gridSize: 15, startQuantile: 0.5, minExceedances: 8 },
  ],

  // Kelly sizing pack
  'risk.kellyBet': () => [
    {
      edge: { binary: { winProbability: 0.55, winAmount: 1, lossAmount: 1 } },
      fraction: 0.5,
      drawdownLimit: { toFraction: 0.5, maxProbability: 0.1 },
      maxFraction: 1,
      horizonPeriods: 100,
    },
  ],
  // sampleSize ≫ 2n keeps the estimation shrinkage positive (a real, non-zero book).
  'risk.shrunkKelly': () => [
    { mean: [0.02, 0.015], covariance: COV2(), sampleSize: 1_008, fraction: 0.5 },
  ],
  'risk.costAwareKelly': () => [
    {
      edge: { gaussian: { mean: 0.02, variance: 0.04 } },
      holdingCost: 0.002,
      roundTripCost: 0.004,
      horizonPeriods: 20,
      fraction: 0.5,
    },
  ],

  // attribution (the sin(i/7) term keeps the subject OFF the factor span — finite t-stats)
  'risk.factorAttribution': () => [
    {
      returns: Array.from(
        { length: 40 },
        (_, i) => 0.001 + 0.01 * Math.sin(i / 3) + 0.0015 * Math.sin(i / 7),
      ),
      factors: [
        { name: 'mkt', returns: Array.from({ length: 40 }, (_, i) => 0.008 * Math.sin(i / 3)) },
        { name: 'val', returns: Array.from({ length: 40 }, (_, i) => 0.006 * Math.cos(i / 5)) },
      ],
      riskFreeRate: 0,
    },
  ],
  'risk.brinsonAttribution': () => [
    [
      {
        name: 'tech',
        portfolioWeight: 0.6,
        benchmarkWeight: 0.5,
        portfolioReturn: 0.04,
        benchmarkReturn: 0.03,
      },
      {
        name: 'fin',
        portfolioWeight: 0.4,
        benchmarkWeight: 0.5,
        portfolioReturn: 0.01,
        benchmarkReturn: 0.02,
      },
    ],
    { method: 'brinson-fachler' },
  ],
  'risk.linkAttribution': () => [
    [
      {
        portfolioReturn: 0.02,
        benchmarkReturn: 0.015,
        allocation: 0.003,
        selection: 0.002,
        interaction: 0,
        label: 'Q1',
      },
      {
        portfolioReturn: -0.01,
        benchmarkReturn: -0.004,
        allocation: -0.004,
        selection: -0.002,
        interaction: 0,
        label: 'Q2',
      },
    ],
    { method: 'carino' },
  ],

  // research hygiene (a strong edge vs a weak sweep ⇒ finite minTrackRecordLength)
  'risk.sharpeStatistics': () => [RETURNS(), { riskFreeRate: 0 }],
  'risk.probabilisticSharpeRatio': () => [SHARPE_STATS(), 0],
  'risk.adjustPValues': () => [[0.01, 0.02, 0.05], { method: 'benjaminiHochberg', alpha: 0.05 }],
  // A small 24×6 returns matrix (T rows × N configs) with splits=6 ⇒ C(6,3)=20 fast CSCV splits.
  'risk.probabilityOfBacktestOverfitting': () => [
    Array.from({ length: 24 }, (_, r) =>
      Array.from({ length: 6 }, (_, c) => 0.001 * ((r % 5) - 2) + 0.0005 * c),
    ),
    { splits: 6 },
  ],
  'risk.checkLeakage': () => [
    [
      { train: [0, 1, 2, 3], test: [4, 5] },
      { train: [2, 3, 4, 5], test: [6, 7] },
    ],
  ],
  'risk.researchProtocol': () => [
    {
      returns: TREND_RETURNS(),
      trials: { trialSharpes: TRIAL_SHARPES() },
      outOfSampleReturns: OOS_RETURNS(),
      confidence: 0.95,
      periodsPerYear: 252,
    },
  ],

  // scenario builder (artifact) + book-level realized P&L explain
  'risk.scenario': () => [
    'stress',
    { factor: 'spot', kind: 'percent', value: -0.05 },
    { factor: 'vol', kind: 'absolute', value: 0.02 },
  ],
  'risk.explainPortfolioPnl': () => [
    [
      {
        id: 'spread-1',
        position: PUT_SPREAD(),
        from: { spot: 100, volatility: 0.2, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' },
        to: { spot: 101, volatility: 0.21, riskFreeRate: 0.04, asOf: '2026-05-08T00:00:00Z' },
      },
    ],
  ],
};
