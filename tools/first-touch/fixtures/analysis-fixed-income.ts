/**
 * E5 fixture tranche: happy-path fixtures for previously-unfixtured ANALYSIS exports
 * (see tools/first-touch/unfixtured-analysis.ts — the shrink-only ratchet these burn down).
 * Same contract as every shard: thunks return FRESH, valid argument lists; probes mutate them.
 *
 * Inputs are deliberately SMALL (short curves, two-bond baskets, coarse lattices) so the four-way
 * probe matrix stays fast, and Bonds/curves are BUILT instances (`bonds.*` / `curves.*`) because
 * the boundary guards reject raw spec literals.
 */

import { bonds, curves, yieldCurveFromRateCurve } from '@totalfinance/fixed-income';
import type { FixtureThunk } from '../inputs.js';

const REF = '2026-01-01';

const FI_FLAT = (): unknown =>
  curves.flat({ rate: 0.03, referenceDate: REF, options: { dayCount: 'ACT/365F' } });

const FI_ZERO = (): unknown =>
  curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.035],
      ['2032-01-01', 0.04],
    ],
    { referenceDate: REF },
  );

/** 5y 5% semiannual premium bond on the flat 3% curve — the lattice subject. */
const LATTICE_BOND = (): unknown =>
  bonds.fixedRate({
    issueDate: REF,
    maturityDate: '2031-01-01',
    couponRate: 0.05,
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });

/** A deliverable Treasury-style bond for the futures basket (issued before settlement). */
const DELIVERABLE = (maturityDate: string, couponRate: number): unknown =>
  bonds.fixedRate({
    issueDate: '2025-07-01',
    maturityDate,
    couponRate,
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });

/** Two-bond deliverable basket: settle 2026-04-01, deliver 2026-06-01 (no interim coupon). */
const BOND_FUTURE_INPUT = (): Record<string, unknown> => ({
  futuresPrice: 105,
  settlementDate: '2026-04-01',
  deliveryDate: '2026-06-01',
  repoRate: 0.03,
  deliverables: [
    { id: '5s31', bond: DELIVERABLE('2031-01-01', 0.05), cleanPrice: 104 },
    { id: '4.5s33', bond: DELIVERABLE('2033-01-01', 0.045), cleanPrice: 101 },
  ],
});

/** 36 contiguous NSA CPI months (2023-01 … 2025-12): mild trend + a 12-month seasonal wave. */
const CPI_SERIES = (): Array<{ month: string; level: number }> =>
  Array.from({ length: 36 }, (_, i) => {
    const year = 2023 + Math.floor(i / 12);
    const month = (i % 12) + 1;
    return {
      month: `${year}-${String(month).padStart(2, '0')}`,
      level: 100 * (1 + 0.002 * i) * (1 + 0.01 * Math.sin((2 * Math.PI * (month - 1)) / 12)),
    };
  });

export const ANALYSIS_FIXED_INCOME_FIXTURES: Record<string, FixtureThunk> = {
  // lattice instruments (short-rate tree; 12 steps/year keeps the probe matrix fast)
  'fixed-income.bermudanSwaption': () => [
    {
      curve: FI_ZERO(),
      maturityDate: '2031-01-01',
      fixedRate: 0.035,
      optionType: 'payer',
      exerciseDates: ['2027-01-01', '2028-01-01'],
      meanReversion: 0.05,
      sigma: 0.01,
      stepsPerYear: 12,
    },
  ],
  'fixed-income.callableBond': () => [
    {
      bond: LATTICE_BOND(),
      curve: FI_FLAT(),
      meanReversion: 0.05,
      sigma: 0.01,
      calls: [{ date: '2029-01-01', price: 102 }],
      stepsPerYear: 12,
    },
  ],
  'fixed-income.oasAnalytics': () => [
    {
      bond: LATTICE_BOND(),
      curve: FI_FLAT(),
      meanReversion: 0.05,
      sigma: 0.01,
      calls: [{ date: '2029-01-01', price: 102 }],
      stepsPerYear: 12,
      marketPrice: 104,
    },
  ],

  // bond futures — basis / carry / implied-repo CTD, and the DV01 hedge on the same basket
  'fixed-income.bondFuture': () => [BOND_FUTURE_INPUT()],
  'fixed-income.bondFutureHedge': () => [{ ...BOND_FUTURE_INPUT(), hedgeDv01: 500 }],
  'fixed-income.bondFutureCtdFrontier': () => [BOND_FUTURE_INPUT()],

  // convertible bond — equity lattice + flat reduced-form hazard
  'fixed-income.convertibleBond': () => [
    {
      issueDate: REF,
      maturityDate: '2029-01-01',
      couponRate: 0.02,
      frequency: 'semiannual',
      conversionRatio: 4,
      spot: 20,
      volatility: 0.25,
      riskFreeRate: 0.03,
      hazardRate: 0.02,
      recovery: 0.4,
      stepsPerYear: 60,
    },
  ],

  // inflation analytics
  'fixed-income.breakevenInflation': () => [
    {
      nominalYield: 0.042,
      realYield: 0.018,
      inflationRiskPremium: 0.003,
      liquidityPremium: 0.001,
    },
  ],
  'fixed-income.cpiSeasonality': () => [{ series: CPI_SERIES() }],
  'fixed-income.zeroCouponInflationSwap': () => [
    {
      maturityYears: 10,
      swapRate: 0.025,
      contractRate: 0.022,
      discountFactor: 0.8,
      notional: 1_000_000,
    },
  ],

  // rates: CMS convexity adjustment (Hull par-bond G(y))
  'fixed-income.cmsConvexityAdjustment': () => [
    { forwardSwapRate: 0.035, swapTenorYears: 5, paymentsPerYear: 2, volatility: 0.2, expiry: 1 },
  ],

  // credit: the credit-triangle hazard (canonical fixture; `credit.creditTriangleHazard` is the
  // same function, covered via identity)
  'fixed-income.creditTriangleHazard': () => [{ spread: 0.015, recovery: 0.4 }],
  // Stage 4.5 slice 2 — the live-curve ↔ core RateCurve data mappers.
  'fixed-income.yieldCurveFromRateCurve': () => [
    {
      curve: {
        currency: 'USD',
        asOf: Date.UTC(2026, 0, 1),
        dayCount: 'ACT/365F',
        compounding: 'continuous',
        points: [
          { date: '2026-01-01', zeroRate: 0.04 },
          { date: '2027-01-01', zeroRate: 0.042 },
          { date: '2029-01-01', zeroRate: 0.045 },
        ],
      },
      interpolation: 'logLinearDiscount',
      extrapolation: 'flatForward',
    },
  ],
  'fixed-income.rateCurveFromYieldCurve': () => [
    {
      curve: yieldCurveFromRateCurve({
        curve: {
          currency: 'USD',
          asOf: Date.UTC(2026, 0, 1),
          dayCount: 'ACT/365F',
          compounding: 'continuous',
          points: [
            { date: '2026-01-01', zeroRate: 0.04 },
            { date: '2027-01-01', zeroRate: 0.042 },
          ],
        },
        interpolation: 'logLinearDiscount',
        extrapolation: 'flatForward',
      }),
      currency: 'USD',
    },
  ],
};
