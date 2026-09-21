/**
 * BRANCH-variant fixtures for the magnitude and count mutants (2026-08-23, fourth external
 * review): one fixture per head exercises ONE branch of a discriminated input, so the
 * `statistic: 'median'` arm of `seasonalityProfile` returned Infinity while the sweep proved the
 * `'mean'` arm finite. Every governed head with an explicit discriminant gets one ADDITIONAL
 * baseline per alternate branch here, keyed `head#branch`; the sweeps feed each variant exactly
 * like the head's own fixture. The registry derives from the canonical fixtures wherever it can,
 * so a shape change in the base propagates instead of drifting.
 */
import type { FixtureThunk } from './inputs.js';
import { allFixtures } from './fixtures.js';
import { PORTFOLIO_TRADE_VARIANTS } from './fixtures/portfolio.js';
import { applyPortfolioEvents } from '@totalfinance/portfolio';

/** Clone a head's canonical single-object argument and override top-level fields. */
function derived(key: string, overrides: Record<string, unknown>): FixtureThunk {
  return () => {
    const base = allFixtures().get(key);
    if (!base) throw new Error(`overflow-variants: no base fixture for ${key}`);
    const [input, ...rest] = base();
    return [{ ...(input as Record<string, unknown>), ...overrides }, ...rest];
  };
}

export const VARIANT_FIXTURES: Record<string, FixtureThunk> = {
  // Stage 4.5: FittedModelHoldoutSelection — { indices } | { everyNth, offset } | { lastCount }; the
  // time-series arm is a prefix split through the direct forecaster (HAR-RV).
  'volatility.fittedModelHoldout#lastCount': () => [
    {
      family: 'har-rv',
      calibration: {
        realizedVariances: Array.from(
          { length: 60 },
          (_, index) => 1e-4 + 5e-5 * Math.sin(index / 5) + 2e-5 * Math.cos(index / 3),
        ),
        options: { weekly: 5, monthly: 22 },
      },
      holdout: { lastCount: 5 },
    },
  ],

  // statistic: 'mean' | 'median' — the median arm interpolates order statistics.
  'commodities.seasonalityProfile#median': derived('commodities.seasonalityProfile', {
    statistic: 'median',
  }),

  // method: 'capital-asset-pricing' | 'dividend-growth'.
  'valuation.costOfEquity#dividend-growth': () => [
    {
      method: 'dividend-growth',
      nextAnnualDividendPerShare: 2.1,
      sharePrice: 42,
      perpetualGrowthRate: 0.03,
    },
  ],

  // TerminalValueMethod: 'perpetual-growth' | 'exit-multiple'.
  'valuation.terminalValue#exit-multiple': derived('valuation.terminalValue', {
    terminalValueMethod: { method: 'exit-multiple', terminalMetricAmount: 300, exitMultiple: 8 },
  }),
  'valuation.dividendDiscountValuation#exit-multiple': derived(
    'valuation.dividendDiscountValuation',
    {
      terminalValueMethod: { method: 'exit-multiple', terminalMetricAmount: 3, exitMultiple: 12 },
    },
  ),

  // The DCF family shares the same terminal union through a nested input.
  'valuation.discountedCashFlow#exit-multiple': () => {
    const base = allFixtures().get('valuation.discountedCashFlow')!;
    const [input] = base() as [Record<string, unknown>];
    return [
      {
        ...input,
        terminalValueMethod: {
          method: 'exit-multiple',
          terminalMetricAmount: 300,
          exitMultiple: 8,
        },
      },
    ];
  },

  // terminalResidualIncome: 'none' | 'perpetuity' — feed both arms; one duplicates the base
  // harmlessly, and the registry stays correct if the base fixture ever switches arm.
  'valuation.residualIncomeValuation#terminal-none': derived('valuation.residualIncomeValuation', {
    terminalResidualIncome: { method: 'none' },
  }),
  'valuation.residualIncomeValuation#terminal-perpetuity': derived(
    'valuation.residualIncomeValuation',
    { terminalResidualIncome: { method: 'perpetuity', perpetualGrowthRate: 0.01 } },
  ),

  // outlierPolicy: 'none' | 'interquartile-range'.
  'valuation.comparableCompanyValuation#outliers-none': derived(
    'valuation.comparableCompanyValuation',
    { outlierPolicy: { method: 'none' } },
  ),

  // applyPortfolioEvents accepts EXACTLY ONE of { portfolio } (fresh fold) or { previousState }
  // (continue a fold); the canonical fixture starts fresh, so the continuation arm — and the
  // restored-state count coordinates it carries — is fed here (FC7 landing, 2026-08-28).
  'portfolio.applyPortfolioEvents#previous-state': () => {
    const [input] = allFixtures().get('portfolio.applyPortfolioEvents')!() as [
      { portfolio: unknown; events: unknown[] },
    ];
    const previousState = applyPortfolioEvents({
      portfolio: input.portfolio as never,
      events: input.events.slice(0, 2) as never,
    });
    return [{ previousState, events: input.events.slice(2) }];
  },

  // method: 'z-score' | 'percentile-rank'.
  'research.standardizeFactor#percentile-rank': derived('research.standardizeFactor', {
    method: 'percentile-rank',
  }),

  // method: percentile | standard-deviations. This was the concrete missing arm that let a
  // successful `{ lowerBound: NaN, upperBound: Infinity }` survive the magnitude sweep.
  'research.winsorizeFactor#standard-deviations': derived('research.winsorizeFactor', {
    method: { type: 'standard-deviations', multiplier: 3 },
  }),

  // valueAtRiskReport's simulation budget exists only on the Monte-Carlo arm. Keeping the
  // historical canonical fixture and feeding this branch separately prevents accepted-but-ignored
  // samples/seed fields on a non-simulation request.
  'risk.valueAtRiskReport#monte-carlo': () => {
    const base = allFixtures().get('risk.valueAtRiskReport')!;
    const [returns] = base();
    return [
      returns,
      {
        confidence: 0.95,
        method: 'monteCarlo',
        horizonPeriods: 1,
        samples: 500,
        seed: 7,
      },
    ];
  },

  // Stage 7B.2 slice 1 (2026-09-06): the trade preflight's proposal-sourced plan and its monitor-state
  // continuation (the `evaluationCount` resource coordinate lives only on that arm).
  ...PORTFOLIO_TRADE_VARIANTS,
};
