/**
 * E5 fixture tranche: happy-path fixtures for previously-unfixtured ANALYSIS exports
 * (see tools/first-touch/unfixtured-analysis.ts — the shrink-only ratchet these burn down).
 * Same contract as every shard: thunks return FRESH, valid argument lists; probes mutate them.
 *
 * Design notes (mirrors fi-vol-risk.ts):
 *   - calibration inputs are GENERATED from a known parameterization (SVI / SSVI / SABR / the
 *     additive event-variance model), so every fit converges quickly and deterministically;
 *   - expensive immutable artifacts (the vol surface, the swaption cube, the PCA result) are
 *     built once and shared — probes clone/delete only TOP-LEVEL argument keys, never nested
 *     structure, so a shared leaf is safe (the VOL_SURFACE precedent);
 *   - the option chains price from a local Black formula with a put-skewed smile, so the parity
 *     forward, the OTM strip, and the model-free integrals are all internally consistent.
 */

import {
  type OptionQuote,
  optionExpiryToMs,
  resolvedExpiry,
  yearFraction,
} from '@totalfinance/core';
import { sabrVolatility } from '@totalfinance/options/sabr';
import { type SVIParameters, sviTotalVariance, sviVolatility } from '@totalfinance/volatility/svi';
import { type SSVIParameters, ssviTotalVariance } from '@totalfinance/volatility/ssvi';
import {
  type ArbitrageSlice,
  type SurfacePcaResult,
  type SwaptionCube,
  type VolatilitySurface,
  calibrateEventVolatility,
} from '@totalfinance/volatility';
import { surfacePCA, swaptionCube, volatilitySurface } from '@totalfinance/volatility';
import { RETURNS, type FixtureThunk } from '../inputs.js';

// ── shared market frame ──────────────────────────────────────────────────────────────────────────

const AV_ASOF = Date.UTC(2026, 0, 2);
const AV_SPOT = 100;
const AV_RATE = 0.03;

// ── local Black pricer (deterministic, dependency-free) ──────────────────────────────────────────

/** Abramowitz–Stegun 7.1.26 erf — plenty for fixture prices (|ε| < 1.5e-7). */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}

const normCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

/** Discounted Black call/put on the forward. */
function blackPrice(
  type: 'call' | 'put',
  F: number,
  K: number,
  timeToExpiryYears: number,
  r: number,
  impliedVolatility: number,
): number {
  const sq = impliedVolatility * Math.sqrt(timeToExpiryYears);
  const d1 =
    (Math.log(F / K) + 0.5 * impliedVolatility * impliedVolatility * timeToExpiryYears) / sq;
  const d2 = d1 - sq;
  const disc = Math.exp(-r * timeToExpiryYears);
  if (type === 'call') return disc * (F * normCdf(d1) - K * normCdf(d2));
  return disc * (K * normCdf(-d2) - F * normCdf(-d1));
}

/** Put-skewed, floor/capped smile in forward log-moneyness (arb-benign for the fixture chain). */
const chainImpliedVolatility = (K: number, F: number): number =>
  Math.min(0.45, Math.max(0.12, 0.2 - 0.25 * Math.log(K / F)));

// ── arbitrage-check slices (clean SVI smiles, total variance growing in maturity) ────────────────

const ARB_P_NEAR: SVIParameters = { a: 0.02, b: 0.1, rho: -0.3, m: 0, sigma: 0.1 };
const ARB_P_FAR: SVIParameters = { a: 0.06, b: 0.18, rho: -0.3, m: 0, sigma: 0.12 };

function ARB_SLICE(expiry: string, timeToExpiryYears: number, p: SVIParameters): ArbitrageSlice {
  const forward = AV_SPOT;
  return {
    expiry,
    timeToExpiryYears,
    forward,
    impliedVolatility: (K: number) => sviVolatility(p, Math.log(K / forward), timeToExpiryYears),
    strikeRange: [forward * Math.exp(-0.4), forward * Math.exp(0.4)],
  };
}

// ── shared surface (same construction as the fi-vol-risk shard's VOL_SURFACE) ────────────────────

const SURF_E0 = '2026-04-02';
const SURF_E1 = '2026-07-02';
const SURF_SVI: Record<string, SVIParameters> = {
  [SURF_E0]: { a: 0.008, b: 0.06, rho: -0.4, m: 0, sigma: 0.08 },
  [SURF_E1]: { a: 0.018, b: 0.1, rho: -0.4, m: 0, sigma: 0.1 },
};

function SURF_QUOTES(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const expiry of [SURF_E0, SURF_E1]) {
    const t = yearFraction(AV_ASOF, optionExpiryToMs(expiry), 'ACT/365F');
    const F = AV_SPOT * Math.exp(AV_RATE * t);
    for (const strike of [80, 90, 95, 100, 105, 110, 120]) {
      const impliedVolatility = sviVolatility(SURF_SVI[expiry]!, Math.log(strike / F), t);
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
          timestampMs: AV_ASOF,
          impliedVolatility,
          underlyingPrice: AV_SPOT,
        });
      }
    }
  }
  return rows;
}

// Immutable class instance — shared across probes (never key-deleted), one SVI fit total.
let surfCache: VolatilitySurface | null = null;
const AV_SURFACE = (): VolatilitySurface =>
  (surfCache ??= volatilitySurface({
    quotes: SURF_QUOTES(),
    market: { spot: AV_SPOT, riskFreeRate: AV_RATE, asOf: AV_ASOF },
    config: { model: 'svi' },
  }));

// ── calibration targets generated from known parameterizations ───────────────────────────────────

const SVI_KS = [-0.4, -0.25, -0.1, 0, 0.1, 0.25, 0.4];
const SVI_TRUE: SVIParameters = { a: 0.02, b: 0.1, rho: -0.3, m: 0, sigma: 0.1 };

const SSVI_TRUE: SSVIParameters = {
  rho: -0.3,
  phi: { kind: 'power-law', eta: 1.2, gamma: 0.4 },
  thetaTerm: [
    { timeToExpiryYears: 0.25, theta: 0.02 },
    { timeToExpiryYears: 1, theta: 0.06 },
  ],
};
const SSVI_KS = [-0.3, -0.15, 0, 0.15, 0.3];

/** Two-maturity total-variance slices sampled exactly from {@link SSVI_TRUE} (k = 0 pins θ). */
const SSVI_SLICES = (): Array<{ timeToExpiryYears: number; k: number[]; w: number[] }> =>
  [0.25, 1].map((t) => ({
    timeToExpiryYears: t,
    k: [...SSVI_KS],
    w: SSVI_KS.map((k) => ssviTotalVariance(SSVI_TRUE, k, t)),
  }));

const SABR_TRUTH = { alpha: 2.0, beta: 0.5, rho: -0.3, nu: 0.4 } as const;
const SABR_F = 100;
const SABR_T = 0.5;
const SABR_STRIKES = [80, 90, 100, 110, 120];

// ── event-vol term structure generated from the additive event-variance model ────────────────────

const EV_EVENT_DATE = '2026-02-05';
const EV_BASE_VAR = 0.04; // σ_base = 20%
const EV_EVENT_VAR = 0.0025; // J = 5%

function EV_TERM(): Array<{ expiry: string; atmVolatility: number }> {
  return ['2026-01-30', '2026-02-20', '2026-04-17'].map((expiry) => {
    const t = yearFraction(AV_ASOF, optionExpiryToMs(expiry), 'ACT/365F');
    const spans = optionExpiryToMs(expiry) >= optionExpiryToMs(EV_EVENT_DATE);
    const v = EV_BASE_VAR * t + (spans ? EV_EVENT_VAR : 0);
    return { expiry, atmVolatility: Math.sqrt(v / t) };
  });
}

// ── model-free chain (mid quotes priced from the local Black formula, parity-consistent) ─────────

const CHAIN_EXPIRIES = ['2026-02-06', '2026-03-20']; // daysToExpiry 35 / 77 from AV_ASOF → 45d is bracketed
const CHAIN_STRIKES = [70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130];

function AV_CHAIN(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const expiry of CHAIN_EXPIRIES) {
    const t = yearFraction(AV_ASOF, optionExpiryToMs(expiry), 'ACT/365F');
    const F = AV_SPOT * Math.exp(AV_RATE * t);
    for (const strike of CHAIN_STRIKES) {
      const impliedVolatility = chainImpliedVolatility(strike, F);
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
          timestampMs: AV_ASOF,
          mid: blackPrice(type, F, strike, t, AV_RATE, impliedVolatility),
          underlyingPrice: AV_SPOT,
        });
      }
    }
  }
  return rows;
}

/** A single-expiry OTM strip for varianceSwapRate (puts below the forward, calls above). */
function VS_STRIP(): {
  strikes: number[];
  otmPrices: number[];
  forward: number;
  timeToExpiryYears: number;
} {
  const t = 0.25;
  const F = AV_SPOT * Math.exp(AV_RATE * t);
  const strikes = [80, 85, 90, 95, 100, 105, 110, 115, 120];
  const otmPrices = strikes.map((K) =>
    blackPrice(K <= F ? 'put' : 'call', F, K, t, AV_RATE, chainImpliedVolatility(K, F)),
  );
  return { strikes, otmPrices, forward: F, timeToExpiryYears: t };
}

// ── sticky-regime / volatility-spot-beta histories (noisy so the OLS t-stat stays finite) ───────────────

function SPOT_HISTORY(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 100 * Math.exp(0.01 * Math.sin(i / 2)));
}

/** IV path co-moving with spot at β ≈ −0.4 per unit log-return, plus a small wiggle. */
function IV_PATH(n: number): number[] {
  const spot = SPOT_HISTORY(n);
  const out = [0.25];
  for (let i = 1; i < n; i++) {
    const dLnS = Math.log(spot[i]! / spot[i - 1]!);
    out.push(out[i - 1]! - 0.4 * dLnS + 0.0004 * Math.cos(i * 1.7));
  }
  return out;
}

/** Positive realized-variance history for the HAR-RV fit (40 ≥ monthly 22 + 4 rows). */
const RV_HISTORY = (): number[] =>
  Array.from({ length: 40 }, (_, i) => 1e-4 * (1 + 0.3 * Math.sin(i / 2) + 0.05 * ((i % 5) / 5)));

// ── surface-PCA snapshots (level + slope + curvature motion over a 4-point grid) ─────────────────

const PCA_GRID = [-0.2, -0.1, 0, 0.1];
const PCA_BASE = [0.25, 0.22, 0.2, 0.21];

function PCA_SNAPSHOTS(): number[][] {
  return Array.from({ length: 8 }, (_, s) =>
    PCA_BASE.map(
      (v, g) =>
        v +
        0.01 * Math.sin(s / 1.3) + // level
        0.004 * Math.cos(s / 0.9) * PCA_GRID[g]! * 5 + // slope
        0.002 * Math.sin(s / 0.7) * (PCA_GRID[g]! * PCA_GRID[g]! * 25 - 0.5), // curvature
    ),
  );
}

// The PCA result is treated as immutable input data — one eigen-decomposition total.
let pcaCache: SurfacePcaResult | null = null;
const AV_PCA = (): SurfacePcaResult =>
  (pcaCache ??= surfacePCA({
    snapshots: PCA_SNAPSHOTS(),
    gridPoints: [...PCA_GRID],
    maxComponents: 3,
  }));

// ── swaption cube (2×2 grid, smiles sampled exactly from a SABR truth) ───────────────────────────

const CUBE_SABR = { alpha: 0.05, beta: 0.5, rho: -0.2, nu: 0.3 } as const;

// Data-only object — shared across probes (only the top-level query is cloned), 4 SABR fits total.
let cubeCache: SwaptionCube | null = null;
function AV_CUBE(): SwaptionCube {
  if (cubeCache) return cubeCache;
  const strikes = [0.02, 0.025, 0.03, 0.035, 0.04, 0.05];
  const nodes = [];
  for (const expiry of [1, 2]) {
    for (const tenor of [3, 5]) {
      const forward = 0.03 + (0.002 * tenor) / 5 + 0.001 * expiry;
      nodes.push({
        expiryYears: expiry,
        tenorYears: tenor,
        forward,
        strikes: [...strikes],
        volatilities: strikes.map((K) =>
          sabrVolatility({
            input: { forward, strike: K, timeToExpiryYears: expiry },
            parameters: { ...CUBE_SABR },
          }),
        ),
      });
    }
  }
  cubeCache = swaptionCube({ nodes, beta: 0.5, volatilityType: 'lognormal' });
  return cubeCache;
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

export const ANALYSIS_VOL_FIXTURES: Record<string, FixtureThunk> = {
  // static no-arbitrage diagnostics
  'volatility.arbitrageReport': () => [
    [ARB_SLICE('2026-04-17', 0.25, ARB_P_NEAR), ARB_SLICE('2027-01-15', 1.0, ARB_P_FAR)],
    { butterflyPoints: 40, calendarPoints: 21, tolerance: 1e-4 },
  ],
  'volatility.checkCalendar': () => [
    [ARB_SLICE('2026-04-17', 0.25, ARB_P_NEAR), ARB_SLICE('2027-01-15', 1.0, ARB_P_FAR)],
    { calendarPoints: 21, tolerance: 1e-4 },
  ],
  'volatility.checkButterfly': () => [
    ARB_SLICE('2026-04-17', 0.5, { a: 0.04, b: 0.4, rho: -0.4, m: 0.05, sigma: 0.15 }),
    { butterflyPoints: 40, step: 0.01, tolerance: 1e-4 },
  ],
  'volatility.surfaceArbitrageReport': () => [
    AV_SURFACE(),
    { butterflyPoints: 40, calendarPoints: 21, tolerance: 1e-4 },
  ],

  // term structure
  'volatility.atmTermStructure': () => [AV_SURFACE()],

  // smile / surface calibrations (targets sampled from the generating model)
  'volatility.calibrateSvi': () => [
    { k: [...SVI_KS], w: SVI_KS.map((k) => sviTotalVariance(SVI_TRUE, k)) },
    { maximumIterations: 400, tolerance: 1e-12 },
  ],
  'volatility.calibrateSabrSmile': () => [
    {
      forward: SABR_F,
      strikes: [...SABR_STRIKES],
      impliedVolatilities: SABR_STRIKES.map((K) =>
        sabrVolatility({
          input: { forward: SABR_F, strike: K, timeToExpiryYears: SABR_T },
          parameters: { ...SABR_TRUTH },
        }),
      ),
      timeToExpiryYears: SABR_T,
    },
    { beta: 0.5, maximumIterations: 200, tolerance: 1e-12 },
  ],
  'volatility.calibrateSsvi': () => [
    { slices: SSVI_SLICES() },
    { phi: 'power-law', maximumIterations: 800, tolerance: 1e-12 },
  ],
  'volatility.calibrateEssvi': () => [
    { slices: SSVI_SLICES() },
    { phi: 'power-law', maximumIterations: 800, tolerance: 1e-12 },
  ],
  'volatility.calibrateVannaVolga': () => [
    {
      forward: 100,
      timeToExpiryYears: 0.25,
      atmVolatility: 0.2,
      riskReversal: -0.02,
      butterfly: 0.005,
      delta: 0.25,
      strikes: [92, 96, 100, 104, 108],
    },
  ],
  'volatility.calibrateVannaVolga5': () => [
    {
      forward: 100,
      timeToExpiryYears: 0.25,
      atmVolatility: 0.2,
      riskReversal25: -0.015,
      butterfly25: 0.004,
      riskReversal10: -0.025,
      butterfly10: 0.012,
      innerDelta: 0.25,
      outerDelta: 0.1,
      wingExtrapolation: 'flat',
      strikes: [90, 95, 100, 105, 110],
    },
  ],
  'volatility.vannaVolgaDensity': () => [
    {
      forward: 100,
      timeToExpiryYears: 0.5,
      atmVolatility: 0.2,
      riskReversal: -0.02,
      butterfly: 0.005,
      gridPoints: 21,
    },
  ],
  'volatility.vannaVolga5Density': () => [
    {
      forward: 100,
      timeToExpiryYears: 0.5,
      atmVolatility: 0.2,
      riskReversal25: -0.02,
      butterfly25: 0.005,
      riskReversal10: -0.035,
      butterfly10: 0.015,
      gridPoints: 21,
    },
  ],

  // event vol
  'volatility.calibrateEventVolatility': () => [
    { termStructure: EV_TERM(), eventDate: EV_EVENT_DATE, asOf: AV_ASOF },
  ],
  'volatility.calibrateEventMove': () => [
    [
      { impliedMove: 0.05, realizedMove: 0.04, date: '2026-01-28' },
      { impliedMove: 0.06, realizedMove: 0.07, date: '2026-04-29' },
      { impliedMove: 0.055, realizedMove: 0.03, date: '2026-07-29' },
    ],
  ],
  'volatility.eventVolatilityDecomposition': () => [
    { atmVolatility: 0.35, timeToExpiryYears: 10 / 365, baseVolatility: 0.22 },
  ],
  'volatility.eventStrippedVolatility': () => [
    { atmVolatility: 0.35, timeToExpiryYears: 10 / 365, eventMove: 0.04 },
  ],

  // forecasting fits
  'volatility.fitGarch': () => [RETURNS(), { seed: 7, mean: 'zero' }],
  'volatility.fitHarRv': () => [RV_HISTORY(), { weekly: 5, monthly: 22 }],

  // hedging / regime measurement
  'volatility.minimumVarianceDelta': () => [
    {
      type: 'call',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.03,
      volatility: 0.2,
      volatilitySpotBeta: -0.002,
    },
  ],
  'volatility.estimateVolatilitySpotBeta': () => [
    {
      spot: SPOT_HISTORY(40),
      impliedVolatility: IV_PATH(40),
      basis: 'log',
      referenceSpot: 100,
      hacLags: 2,
    },
  ],
  'volatility.stickyRegime': () => [
    { spot: SPOT_HISTORY(20), fixedStrikeVolatility: IV_PATH(20), skewSlope: 0.4 },
  ],

  // smile quoting
  'volatility.riskReversalButterfly': () => [
    {
      forward: 100,
      timeToExpiryYears: 0.25,
      smile: (K: number) => 0.2 + 0.0004 * (100 - K),
      delta: 0.25,
    },
  ],

  // surface motion
  'volatility.surfacePCA': () => [
    {
      snapshots: PCA_SNAPSHOTS(),
      gridPoints: [...PCA_GRID],
      changes: 'absolute',
      maxComponents: 3,
    },
  ],
  'volatility.surfacePcaScenarios': () => [
    {
      pca: AV_PCA(),
      base: [...PCA_BASE],
      sigmas: [-1, 1],
      maxModes: 2,
      floor: 0,
      combined: [1, -0.5],
    },
  ],

  // swaption cube evaluation
  'volatility.swaptionCubeVolatility': () => [
    { cube: AV_CUBE(), expiryYears: 1.5, tenorYears: 4, strike: 0.035 },
  ],

  // model-free chain indices
  'volatility.varianceIndex': () => [
    {
      quotes: AV_CHAIN(),
      spot: AV_SPOT,
      riskFreeRate: AV_RATE,
      asOf: AV_ASOF,
      horizonDays: 45,
      dividendYield: 0,
    },
  ],
  'volatility.varianceRiskPremiumTermStructure': () => [
    {
      quotes: AV_CHAIN(),
      spot: AV_SPOT,
      riskFreeRate: AV_RATE,
      asOf: AV_ASOF,
      horizonDays: 45,
      realizedVolatility: 0.18,
    },
  ],
  'volatility.tailRiskIndex': () => [
    { quotes: AV_CHAIN(), spot: AV_SPOT, riskFreeRate: AV_RATE, asOf: AV_ASOF, horizonDays: 45 },
  ],
  'volatility.varianceSwapRate': () => {
    const s = VS_STRIP();
    return [
      {
        strikes: s.strikes,
        otmPrices: s.otmPrices,
        forward: s.forward,
        riskFreeRate: AV_RATE,
        timeToExpiryYears: s.timeToExpiryYears,
      },
    ];
  },
  // Stage 4.5 slice 2 — the event-volatility forward evaluator (its fit built fresh per call).
  'volatility.eventVolatilityAtExpiry': () => [
    {
      fit: calibrateEventVolatility({
        termStructure: [
          { expiry: '2026-05-08', atmVolatility: 0.3 },
          { expiry: '2026-05-15', atmVolatility: 0.42 },
          { expiry: '2026-06-30', atmVolatility: 0.33 },
        ],
        eventDate: '2026-05-11',
        asOf: '2026-05-01T00:00:00Z',
      }),
      expiries: ['2026-05-05', '2026-06-19'],
    },
  ],
};
