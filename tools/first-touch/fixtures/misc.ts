/**
 * Deep-sweep fixture shard — see ../fixtures.ts for the contract. Keys are sweep paths; thunks
 * return FRESH valid argument lists (probes mutate arguments). Covers calendars, backtest signal
 * helpers, strategy entrypoints, and structure.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { NYSE } from '@totalfinance/calendars';
import { type FixtureThunk, CLOSES } from '../inputs.js';

const CHAIN_EXPIRY = '2026-06-19';
const AS_OF = Date.UTC(2026, 0, 2);

/** A small two-sided option chain with IVs, deltas, and open interest. */
function chainQuote(type: 'call' | 'put', strike: number, mid: number, delta: number) {
  return {
    /**
     * A COMPLETE `OptionContract`, including the resolved instant and how it resolved.
     *
     * `expiresAt` and `expiryConvention` are required — "an unresolved literal is not a contract"
     * (ONE EXPIRY LAW) — and this literal omitted both. It went unnoticed because the element of a
     * sequence parameter was described by a member list resolved from the type's NAME, which reported
     * only what the arms of `OptionQuote`'s contract share; the element now carries its own declared
     * members, so the omission is visible.
     */
    contract: {
      underlying: 'XYZ',
      type,
      style: 'american' as const,
      strike,
      expiry: CHAIN_EXPIRY,
      expiresAt: Date.parse(`${CHAIN_EXPIRY}T20:00:00Z`),
      expiryConvention: 'us-equity-close' as const,
      multiplier: 100,
    },
    timestampMs: AS_OF,
    bid: mid - 0.1,
    ask: mid + 0.1,
    mid,
    impliedVolatility: 0.25,
    openInterest: 500,
    underlyingPrice: 100,
    greeks: { delta },
  };
}

function chain(): unknown[] {
  const rows: unknown[] = [];
  for (let k = 85; k <= 115; k += 5) {
    rows.push(
      chainQuote(
        'call',
        k,
        Math.max(0.5, 100 - k + 6),
        Math.min(0.9, Math.max(0.1, (115 - k) / 35)),
      ),
    );
    rows.push(
      chainQuote(
        'put',
        k,
        Math.max(0.5, k - 100 + 6),
        -Math.min(0.9, Math.max(0.1, (k - 85) / 35)),
      ),
    );
  }
  return rows;
}

/** European chain with OI for structure.exposure. */
function exposureChain(): unknown[] {
  const rows: unknown[] = [];
  for (let k = 85; k <= 115; k += 5) {
    for (const [type, oi] of [
      ['call', 200 + Math.max(0, k - 100) * 10],
      ['put', 200 + Math.max(0, 100 - k) * 10],
    ] as const) {
      rows.push({
        contract: {
          underlying: 'X',
          type,
          style: 'european',
          strike: k,
          expiry: CHAIN_EXPIRY,
          // `expiresAt` + `expiryConvention` are REQUIRED on OptionContract and the builders stamp
          // them; this fixture predated that and no check reached an array element to notice.
          ...resolvedExpiry(CHAIN_EXPIRY),
          multiplier: 100,
        },
        timestampMs: AS_OF,
        impliedVolatility: 0.2,
        openInterest: oi,
        underlyingPrice: 100,
      });
    }
  }
  return rows;
}

/** A complete FundamentalPeriod (FC0 frozen contract) — fresh per call, probes mutate. */
function fundamentalPeriod() {
  return {
    periodStartDate: '2026-01-01',
    periodEndDate: '2026-03-31',
    fiscalYear: 2026,
    fiscalQuarter: 1,
    periodType: 'quarter',
    filedTimestampMs: Date.UTC(2026, 3, 28),
    availableTimestampMs: Date.UTC(2026, 3, 28, 21, 30),
    currency: 'USD',
    monetaryScale: 1_000_000,
    form: '10-Q',
  };
}

export const MISC_FIXTURES: Record<string, FixtureThunk> = {
  // FC1 — the valuation return solvers (fresh flow arrays per call; probes mutate).
  'valuation.internalRateOfReturn': () => [
    {
      cashFlows: [
        { amount: -1_000, timeYears: 0 },
        { amount: 600, timeYears: 1 },
        { amount: 600, timeYears: 2 },
      ],
    },
  ],
  'valuation.datedInternalRateOfReturn': () => [
    {
      cashFlows: [
        { amount: -1_000, cashFlowDate: '2026-01-01' },
        { amount: 1_200, cashFlowDate: '2027-01-01' },
      ],
      asOf: '2026-01-01',
    },
  ],
  // FC1 — the shared when-present validators over the ONE compounding/day-count vocabularies.
  'valuation.requireCompoundingWhenPresent': () => ['deepSweepProbe', 'monthly'],
  'valuation.requireDayCountWhenPresent': () => ['deepSweepProbe', 'ACT/365F'],
  // FC0 — @totalfinance/fundamentals first slice (the frozen contracts + point-in-time law).
  'fundamentals.requireFundamentalPeriod': () => ['deepSweepProbe', fundamentalPeriod()],
  'fundamentals.isPeriodAvailableAt': () => [fundamentalPeriod(), Date.UTC(2026, 4, 15)],

  // ── calendars ─────────────────────────────────────────────────────────────────────────────────
  'calendars.NYSE.addBusinessDays': () => ['2026-01-02', 3],
  'calendars.NYSE.businessDaysBetween': () => ['2026-01-02', '2026-02-02'],
  'calendars.CBOE.addBusinessDays': () => ['2026-01-02', 3],
  'calendars.CBOE.businessDaysBetween': () => ['2026-01-02', '2026-02-02'],
  'calendars.crypto24x7.addBusinessDays': () => ['2026-01-02', 3],
  'calendars.crypto24x7.businessDaysBetween': () => ['2026-01-02', '2026-02-02'],
  'calendars.expirations': () => [NYSE, { from: '2026-01-01', to: '2026-03-31', kind: 'monthly' }],
  'calendars.nextExpiry': () => [NYSE, '2026-01-02', 'monthly'],
  'calendars.tradingDaysToExpiry': () => [NYSE, '2026-09-14', '2026-09-18'],
  'calendars.requireCalendar': () => ['calendars.requireCalendar', NYSE],

  // ── backtest signal helpers ───────────────────────────────────────────────────────────────────
  'backtest.gtSeries': () => [CLOSES(), 100],
  'backtest.ltSeries': () => [CLOSES(), 100],
  'backtest.crossOverSeries': () => [CLOSES(), 103],
  'backtest.crossUnderSeries': () => [CLOSES(), 103],
  'backtest.latchSeries': () => [CLOSES(), CLOSES()],
  'backtest.crossOver': () => [
    { previous: 1, value: 3 },
    { previous: 2, value: 2 },
  ],
  'backtest.crossUnder': () => [
    { previous: 3, value: 1 },
    { previous: 2, value: 2 },
  ],
  'backtest.toEquityPoints': () => [
    [1, 1.01, 1.02],
    [AS_OF, AS_OF + 86_400_000, AS_OF + 2 * 86_400_000],
  ],

  // ── strategy entrypoints ──────────────────────────────────────────────────────────────────────
  'strategy.strategy': () => [
    [
      { kind: 'call', strike: 100, expiry: CHAIN_EXPIRY, premium: 4.25, quantity: 1 },
      { kind: 'call', strike: 110, expiry: CHAIN_EXPIRY, premium: 1.4, quantity: -1 },
    ],
    { multiplier: 100 },
  ],
  'strategy.strategyOf': () => [
    [
      { kind: 'call', strike: 100, expiry: CHAIN_EXPIRY, premium: 4.25, quantity: 1 },
      { kind: 'call', strike: 110, expiry: CHAIN_EXPIRY, premium: 1.4, quantity: -1 },
    ],
    { multiplier: 100 },
  ],
  'strategy.strategyFromChain': () => [
    chain(),
    { type: 'ironCondor', expiry: CHAIN_EXPIRY, shortDelta: 0.3, wingWidth: 5, price: 'mid' },
  ],

  // ── structure ─────────────────────────────────────────────────────────────────────────────────
  'structure.exposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  // The nine single-metric shortcuts: the same chain, each its own one-metric selection.
  'structure.gammaExposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  'structure.deltaExposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  'structure.vegaExposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  'structure.thetaExposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  'structure.vannaExposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  'structure.charmExposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  'structure.vommaExposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  'structure.speedExposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  'structure.colorExposure': () => [
    {
      quotes: exposureChain(),
      market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
      config: { convention: 'dealerShortGamma' },
    },
  ],
  'structure.unusualness': () => [200, [50, 60, 55, 40, 70, 65, 45, 58, 62, 51]],
};
