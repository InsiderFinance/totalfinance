/**
 * E5 fixture tranche: happy-path fixtures for previously-unfixtured ANALYSIS exports
 * (see tools/first-touch/unfixtured-analysis.ts — the shrink-only ratchet these burn down).
 * Same contract as every shard: thunks return FRESH, valid argument lists; probes mutate them.
 *
 * Conventions in this tranche:
 *   - IV fixtures invert EXACT BSM prices, so every solve converges (a happy path, never a
 *     `converged: false` envelope);
 *   - scanner/optimizer fixtures enumerate DEFINED-RISK structures only, so the report carries no
 *     ±Infinity (`returnOnRisk` on a long straddle is unbounded by design — Law 7 says the happy
 *     fixture must not exercise it);
 *   - flow prints are venue-tagged with NBBO on both sides, so the fixture exercises a
 *     venue-verified sweep, a block, and a direction-known spread in one pass.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { ironCondor } from '@totalfinance/strategy';
import type { OptionType } from '@totalfinance/core';
import { FLAT_IMPLIED_SURFACE, PREMIUM_MARKET, type FixtureThunk } from '../inputs.js';

// ── shared builders ──────────────────────────────────────────────────────────────────────────────

const EXPIRY = '2026-06-19';
const AS_OF_MS = Date.UTC(2026, 0, 2); // '2026-01-02', matching MARKET().asOf

/** A BSM inversion row whose price IS an exact BSM value — the solve always converges. */
const IV_ROW = (type: OptionType, strike: number): Record<string, unknown> => ({
  type,
  price: blackScholesPrice({
    type,
    spot: 105,
    strike,
    timeToExpiryYears: 0.5,
    riskFreeRate: 0.04,
    dividendYield: 0.01,
    volatility: 0.2,
  }),
  spot: 105,
  strike,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.04,
  dividendYield: 0.01,
});

/** A flat implied-vol surface — Dupire collapses it to σ_loc ≡ 0.2 (the BSM anchor). */

/** Strikes straddling the spot (105) so the condor enumerator finds both short legs. */
const SCAN_CHAIN = (): Array<{ strike: number }> =>
  [90, 95, 100, 105, 110, 115, 120].map((strike) => ({ strike }));

/** Defined-risk structures ONLY — no unbounded maxProfit, so every report number is finite. */
const SCAN_STRUCTURES = (): string[] => ['bullCallSpread', 'bearPutSpread', 'ironCondor'];

/** A model-priced iron condor Position (defined risk — finite economics for the explain report). */
const CONDOR = (): unknown =>
  ironCondor(
    { putLong: 90, putShort: 95, callShort: 110, callLong: 115 },
    // MARKET() is deliberately untyped (Record<string, unknown>) — it satisfies PremiumMarket at
    // runtime ({ spot, vol, rate, asOf, expiry }), same shape the strategyFixtures generator feeds.
    { premiums: 'model', market: PREMIUM_MARKET() } as never,
  );

/** One option print in the canonical OptionTrade shape (contract carries its resolved expiry). */
function print(
  type: OptionType,
  strike: number,
  ts: number,
  price: number,
  size: number,
  bid: number,
  ask: number,
  exchange: string,
  openInterest?: number,
): Record<string, unknown> {
  return {
    contract: {
      underlying: 'ACME',
      type,
      style: 'american',
      strike,
      expiry: EXPIRY,
      ...resolvedExpiry(EXPIRY),
      multiplier: 100,
    },
    timestampMs: ts,
    price,
    size,
    bid,
    ask,
    exchange,
    ...(openInterest !== undefined ? { openInterest } : {}),
  };
}

/**
 * Six prints on one underlying: a 3-print venue-verified buy sweep (call 100, two venues inside
 * the 500 ms window), a sell block (put 95, 150 lots), and a 2-leg direction-known spread
 * (call 105 bought / call 110 sold, 50 ms apart).
 */
function flowTrades(): unknown[] {
  const B = Date.UTC(2026, 0, 2, 15, 30);
  return [
    print('call', 100, B, 5.05, 40, 4.95, 5.05, 'ARCA', 30),
    print('call', 100, B + 200, 5.06, 35, 4.96, 5.06, 'PHLX', 30),
    print('call', 100, B + 400, 5.07, 45, 4.97, 5.07, 'ARCA', 30),
    print('put', 95, B + 60_000, 2.1, 150, 2.1, 2.2, 'CBOE', 500),
    print('call', 105, B + 120_000, 3.4, 25, 3.3, 3.4, 'ISE', 400),
    print('call', 110, B + 120_050, 1.8, 25, 1.8, 1.9, 'ISE', 400),
  ];
}

// ── the shard ────────────────────────────────────────────────────────────────────────────────────

export const ANALYSIS_OPTIONS_STRATEGY_STRUCTURE_FIXTURES: Record<string, FixtureThunk> = {
  // options — an admissible (exact-BSM) price sits strictly inside the no-arbitrage band
  'options.checkBlackScholesNoArbitrage': () => [IV_ROW('call', 100)],
  // options — kernel-form Dupire transform (identity twin of the fixtured localVolatility.fromImplied)
  'options.dupireLocalVolatility': () => [
    {
      impliedVolatility: FLAT_IMPLIED_SURFACE,
      market: { spot: 100, riskFreeRate: 0.03, dividendYield: 0.01 },
      options: { logMoneynessStep: 0.01, timeStepYears: 1 / 365, floorVolatility: 1e-3 },
    },
  ],
  // options — converging solves (exact BSM prices in, the same σ comes back out)
  'options.impliedVolatility': () => [IV_ROW('call', 100), { method: 'auto', fallback: true }],
  'options.impliedVolatilityMany': () => [
    [IV_ROW('call', 100), IV_ROW('put', 110)],
    { method: 'brent' },
  ],

  // strategy
  'strategy.classifyStrategy': () => [CONDOR()],
  'strategy.payoffSvg': () => [
    CONDOR(),
    { prices: { from: 80, to: 130, steps: 21 }, width: 640, height: 360 },
  ],
  'strategy.explainPosition': () => [
    CONDOR(),
    { market: PREMIUM_MARKET(), underlyingLabel: 'ACME' },
  ],
  'strategy.optimizeStrategy': () => [
    {
      spot: 105,
      asOf: AS_OF_MS,
      riskFreeRate: 0.04,
      volatility: 0.2,
      expiries: [{ expiry: EXPIRY, chain: SCAN_CHAIN() }],
      thesis: { targetPrice: 112, volatility: 0.25 },
      structures: SCAN_STRUCTURES(),
      top: 10,
      gridPoints: 201,
    },
  ],
  'strategy.scanStrategies': () => [
    {
      spot: 105,
      asOf: AS_OF_MS,
      expiry: EXPIRY,
      riskFreeRate: 0.04,
      volatility: 0.2,
      chain: SCAN_CHAIN(),
      structures: SCAN_STRUCTURES(),
      rankBy: 'expectedValuePerRisk',
      top: 10,
    },
  ],

  // structure
  'structure.flow': () => [
    flowTrades(),
    {
      blockMinSize: 100,
      blockMinPremium: 50_000,
      sweepWindowMs: 500,
      sweepMinPrints: 3,
      spreadWindowMs: 100,
      multiplier: 100,
    },
  ],
};
