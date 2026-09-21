/**
 * FC2 — ratio and score goldens over the hand-computed fixture, the scale-invariance metamorphic
 * law, the market point-in-time law, and the one-call analysis with its honest gaps ledger.
 */

import { describe, expect, it } from 'vitest';
import {
  accrualRatio,
  altmanZScore,
  analyzeFundamentals,
  assetTurnover,
  beneishMScore,
  bookValuePerShare,
  cashConversionCycle,
  cashFlowToNetIncome,
  cashRatio,
  cashReturnOnAssets,
  currentRatio,
  daysInventoryOutstanding,
  daysPayablesOutstanding,
  daysSalesOutstanding,
  debtServiceCoverage,
  debtToAssets,
  debtToEquity,
  dividendYield,
  earningsPerShare,
  earningsYield,
  ebitdaMargin,
  enterpriseValueToEbitda,
  enterpriseValueToRevenue,
  freeCashFlowPerShare,
  freeCashFlowYield,
  grossMargin,
  interestCoverage,
  inventoryTurnover,
  netDebtToEbitda,
  netProfitMargin,
  operatingMargin,
  payablesTurnover,
  piotroskiFScore,
  priceToBook,
  priceToEarnings,
  priceToSales,
  quickRatio,
  receivablesTurnover,
  returnOnAssets,
  returnOnCapitalEmployed,
  returnOnEquity,
  returnOnInvestedCapital,
  revenuePerShare,
} from '../src/index.js';
import type { MarketObservation } from '../src/index.js';
import { AVAILABLE_2025, FY2023, FY2024, FY2025, scaledStatements } from './fc2-fixture.js';

const close = (actual: number | null, expected: number): void => {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(1e-10);
};

/** Observed the day after the FY2025 filing became available; 98 shares at $20 → 1,960 cap. */
const MARKET: MarketObservation = {
  observedTimestampMs: AVAILABLE_2025 + 24 * 60 * 60 * 1000,
  sharePrice: 20,
  sharesOutstanding: 98,
};

describe('ratio goldens (hand-recomputed from the fixture)', () => {
  it('profitability', () => {
    close(grossMargin({ statements: FY2025 }), 0.42);
    close(operatingMargin({ statements: FY2025 }), 0.18);
    close(ebitdaMargin({ statements: FY2025 }), (180 + 45) / 1_000);
    close(netProfitMargin({ statements: FY2025 }), 0.132);
  });

  it('returns on average balances', () => {
    close(returnOnAssets({ current: FY2025, prior: FY2024 }), 132 / 1_175);
    close(returnOnEquity({ current: FY2025, prior: FY2024 }), 132 / 625);
    // NOPAT = 180 × (1 − 36/168); invested capital = (280+690−150 , 300+560−120) → avg 780.
    close(
      returnOnInvestedCapital({ current: FY2025, prior: FY2024 }),
      (180 * (1 - 36 / 168)) / 780,
    );
    close(returnOnCapitalEmployed({ current: FY2025, prior: FY2024 }), 180 / 1_010);
  });

  it('liquidity', () => {
    close(currentRatio({ statements: FY2025 }), 380 / 170);
    close(quickRatio({ statements: FY2025 }), 305 / 170);
    close(cashRatio({ statements: FY2025 }), 150 / 170);
  });

  it('leverage and coverage', () => {
    close(debtToEquity({ statements: FY2025 }), 280 / 690);
    close(debtToAssets({ statements: FY2025 }), 280 / 1_250);
    close(netDebtToEbitda({ statements: FY2025 }), 130 / 225);
    close(interestCoverage({ statements: FY2025 }), 15);
    close(debtServiceCoverage({ statements: FY2025, debtServiceAmount: 60 }), 3);
  });

  it('efficiency, day metrics, and the cash-conversion cycle', () => {
    close(assetTurnover({ current: FY2025, prior: FY2024 }), 1_000 / 1_175);
    close(inventoryTurnover({ current: FY2025, prior: FY2024 }), 8);
    close(receivablesTurnover({ current: FY2025, prior: FY2024 }), 1_000 / 97.5);
    close(payablesTurnover({ current: FY2025, prior: FY2024 }), 580 / 47.5);
    const pair = { current: FY2025, prior: FY2024, periodDays: 365 };
    const inventoryDays = 365 / 8;
    const receivableDays = (365 * 97.5) / 1_000;
    const payableDays = (365 * 47.5) / 580;
    close(daysInventoryOutstanding(pair), inventoryDays);
    close(daysSalesOutstanding(pair), receivableDays);
    close(daysPayablesOutstanding(pair), payableDays);
    close(cashConversionCycle(pair), inventoryDays + receivableDays - payableDays);
  });

  it('quality', () => {
    close(accrualRatio({ current: FY2025, prior: FY2024 }), (132 - 170) / 1_175);
    close(cashFlowToNetIncome({ statements: FY2025 }), 170 / 132);
    close(cashReturnOnAssets({ current: FY2025, prior: FY2024 }), 170 / 1_175);
  });

  it('per-share', () => {
    close(earningsPerShare({ statements: FY2025 }), 132 / 98);
    close(bookValuePerShare({ statements: FY2025 }), 690 / 98);
    close(revenuePerShare({ statements: FY2025 }), 1_000 / 98);
    close(freeCashFlowPerShare({ statements: FY2025 }), 100 / 98);
  });

  it('valuation multiples (market cap 1,960; enterprise value 2,090)', () => {
    const withMarket = { statements: FY2025, marketObservation: MARKET };
    close(priceToEarnings(withMarket), 20 / (132 / 98));
    close(priceToBook(withMarket), 1_960 / 690);
    close(priceToSales(withMarket), 1.96);
    close(enterpriseValueToRevenue(withMarket), 2_090 / 1_000);
    close(enterpriseValueToEbitda(withMarket), 2_090 / 225);
    close(freeCashFlowYield(withMarket), 100 / 1_960);
    close(earningsYield(withMarket), 132 / 1_960);
    close(dividendYield(withMarket), 25 / 1_960);
  });
});

describe('metamorphic and boundary laws', () => {
  it('ratio values are invariant under monetaryScale (the same economics in thousands)', () => {
    const current = scaledStatements(FY2025);
    const prior = scaledStatements(FY2024);
    close(grossMargin({ statements: current }), 0.42);
    close(returnOnAssets({ current, prior }), 132 / 1_175);
    close(
      cashConversionCycle({ current, prior, periodDays: 365 }),
      365 / 8 + 35.5875 - (365 * 47.5) / 580,
    );
    // Per-share and multiples stay in ABSOLUTE currency: 0.132 thousand × 1,000 / 98 shares.
    close(earningsPerShare({ statements: current }), 132 / 98);
    close(priceToBook({ statements: current, marketObservation: MARKET }), 1_960 / 690);
    close(enterpriseValueToEbitda({ statements: current, marketObservation: MARKET }), 2_090 / 225);
  });

  it('a market observation BEFORE the fundamentals are available is rejected — in both spellings', () => {
    const early: MarketObservation = { ...MARKET, observedTimestampMs: AVAILABLE_2025 - 1 };
    expect(() => priceToEarnings({ statements: FY2025, marketObservation: early })).toThrow(
      /precedes the fundamentals' availability/,
    );
    expect(() =>
      enterpriseValueToRevenue({ statements: FY2025, marketObservation: early }),
    ).toThrow(/precedes the fundamentals' availability/);
  });

  it('the explicit freshness limit bounds price-fundamentals staleness', () => {
    const lateObservation: MarketObservation = {
      ...MARKET,
      observedTimestampMs: AVAILABLE_2025 + 90 * 24 * 60 * 60 * 1000,
    };
    expect(() =>
      priceToBook({
        statements: FY2025,
        marketObservation: lateObservation,
        maximumStalenessMs: 30 * 24 * 60 * 60 * 1000,
      }),
    ).toThrow(/beyond the declared maximumStalenessMs/);
    // Within the limit it computes and reports the staleness.
    const report = priceToBook.explain({
      statements: FY2025,
      marketObservation: MARKET,
      maximumStalenessMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(report.diagnostics.marketStalenessMs).toBe(24 * 60 * 60 * 1000);
  });

  it('a zero or meaningless denominator is null WITH the reason — never Infinity or NaN', () => {
    const zeroEquity = {
      ...FY2025,
      balance: { ...FY2025.balance, totalEquity: 0, totalLiabilities: 1_250 },
    };
    const report = debtToEquity.explain({ statements: zeroEquity });
    expect(report.value).toBeNull();
    expect(report.diagnostics.reason).toMatch(/totalEquity is zero/);
    const negativeEarnings = {
      ...FY2025,
      income: { ...FY2025.income, netIncome: -10 },
    };
    const pe = priceToEarnings.explain({
      statements: negativeEarnings,
      marketObservation: MARKET,
    });
    expect(pe.value).toBeNull();
    expect(pe.diagnostics.reason).toMatch(/not positive/);
  });

  it('.explain disclosures name every derivation the value relied on', () => {
    const withoutGrossProfit = {
      ...FY2025,
      income: (() => {
        const { grossProfit: _g, ...rest } = FY2025.income;
        return rest;
      })(),
    };
    const report = grossMargin.explain({ statements: withoutGrossProfit });
    close(report.value, 0.42);
    expect(report.diagnostics.notes).toContain('grossProfit derived as revenue - costOfRevenue');
    const roic = returnOnInvestedCapital.explain({ current: FY2025, prior: FY2024 });
    expect(
      roic.diagnostics.notes.some((note) =>
        note.startsWith('taxRate derived as the effective rate'),
      ),
    ).toBe(true);
  });
});

describe('scores', () => {
  it('Piotroski: the fixture earns all nine signals, each reported', () => {
    const result = piotroskiFScore({ current: FY2025, prior: FY2024, priorPrior: FY2023 });
    expect(result.fScore).toBe(9);
    expect(result.evaluableSignals).toBe(9);
    expect(result.signals).toHaveLength(9);
    for (const signal of result.signals) expect(signal.value).toBe(1);
  });

  it('Piotroski: net share issuance flips its signal; a missing line is null with a reason', () => {
    const issued = {
      ...FY2025,
      income: { ...FY2025.income, dilutedSharesOutstanding: 102 },
    };
    const flipped = piotroskiFScore({ current: issued, prior: FY2024, priorPrior: FY2023 });
    expect(flipped.fScore).toBe(8);
    expect(flipped.signals.find((signal) => signal.signal === 'no net share issuance')!.value).toBe(
      0,
    );

    const withoutDebt = {
      ...FY2025,
      balance: (() => {
        const { longTermDebt: _l, ...rest } = FY2025.balance;
        return rest;
      })(),
    };
    const partial = piotroskiFScore({ current: withoutDebt, prior: FY2024, priorPrior: FY2023 });
    const leverage = partial.signals.find(
      (signal) => signal.signal === 'falling long-term-debt ratio',
    )!;
    expect(leverage.value).toBeNull();
    expect(leverage.reason).toMatch(/longTermDebt is absent/);
    expect(partial.evaluableSignals).toBe(8);
  });

  it('Altman: all three published variants with their exact coefficients', () => {
    // X1 = 210/1250, X2 = 350/1250, X3 = 180/1250, X5 = 1000/1250; X4 varies by equity basis.
    const x1 = 0.168;
    const x2 = 0.28;
    const x3 = 0.144;
    const x5 = 0.8;
    const publicVariant = altmanZScore({
      statements: FY2025,
      variant: 'public-manufacturing',
      marketEquity: 1_960,
    });
    close(publicVariant.zScore, 1.2 * x1 + 1.4 * x2 + 3.3 * x3 + 0.6 * (1_960 / 560) + 1.0 * x5);
    expect(publicVariant.components).toHaveLength(5);

    const privateVariant = altmanZScore({ statements: FY2025, variant: 'private-manufacturing' });
    close(
      privateVariant.zScore,
      0.717 * x1 + 0.847 * x2 + 3.107 * x3 + 0.42 * (690 / 560) + 0.998 * x5,
    );

    const nonManufacturing = altmanZScore({ statements: FY2025, variant: 'non-manufacturing' });
    close(nonManufacturing.zScore, 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * (690 / 560));
    expect(nonManufacturing.components).toHaveLength(4); // no sales/assets term
  });

  it('Altman: the variant is explicit, market equity binds to the public variant only', () => {
    expect(() => altmanZScore({ statements: FY2025, variant: 'public-manufacturing' })).toThrow(
      /marketEquity .* required for the public-manufacturing variant/,
    );
    expect(() =>
      altmanZScore({ statements: FY2025, variant: 'private-manufacturing', marketEquity: 1_960 }),
    ).toThrow(/applies only to the public-manufacturing variant/);
  });

  it('Beneish: the original eight-variable equation, every component reported', () => {
    const result = beneishMScore({ current: FY2025, prior: FY2024 });
    const dsri = 100 / 1_000 / (95 / 900);
    const gmi = 370 / 900 / (420 / 1_000);
    const aqi = (1 - 830 / 1_250) / (1 - 760 / 1_100);
    const sgi = 1_000 / 900;
    const depi = 40 / 460 / (45 / 495);
    const sgai = 0.14 / (130 / 900);
    const tata = (132 - 170) / 1_250;
    const lvgi = 420 / 1_250 / (425 / 1_100);
    close(
      result.mScore,
      -4.84 +
        0.92 * dsri +
        0.528 * gmi +
        0.404 * aqi +
        0.892 * sgi +
        0.115 * depi -
        0.172 * sgai +
        4.679 * tata -
        0.327 * lvgi,
    );
    expect(result.components).toHaveLength(8);
    expect(result.components.map((component) => component.index)).toEqual([
      'DSRI',
      'GMI',
      'AQI',
      'SGI',
      'DEPI',
      'SGAI',
      'TATA',
      'LVGI',
    ]);
    for (const component of result.components) {
      expect(component.expandedName.length).toBeGreaterThan(0);
      expect(component.currentPeriodEndDate).toBe('2025-12-31');
      expect(component.priorPeriodEndDate).toBe('2024-12-31');
    }
  });

  it('Beneish: a missing model variable is an error naming it — no five-variable fallback', () => {
    const sparse = {
      ...FY2025,
      income: (() => {
        const { sellingGeneralAdministrativeExpense: _s, ...rest } = FY2025.income;
        return rest;
      })(),
    };
    expect(() => beneishMScore({ current: sparse, prior: FY2024 })).toThrow(
      /sellingGeneralAdministrativeExpense is required by this model/,
    );
  });
});

describe('analyzeFundamentals — the one-call analysis', () => {
  const HISTORY = [FY2023, FY2024, FY2025];

  it('composes ratios and scores at asOf, reporting every gap with its reason', () => {
    const analysis = analyzeFundamentals({
      statements: HISTORY,
      marketSnapshot: MARKET,
      asOf: Date.UTC(2026, 7, 12),
      restatementPolicy: 'latest-available',
      periodDays: 365,
      altmanVariant: 'public-manufacturing',
    });
    expect(analysis.periodsVisible).toBe(3);
    expect(analysis.periodUsed.fiscalYear).toBe(2025);
    expect(analysis.priorPeriodUsed!.fiscalYear).toBe(2024);
    expect(analysis.ratios['grossMargin']!.value).toBeCloseTo(0.42, 12);
    expect(analysis.ratios['returnOnAssets']!.value).toBeCloseTo(132 / 1_175, 12);
    expect(analysis.ratios['priceToBook']!.value).toBeCloseTo(1_960 / 690, 12);
    expect(analysis.scores.piotroski!.fScore).toBe(9);
    expect(analysis.scores.altman!.variant).toBe('public-manufacturing');
    expect(analysis.scores.beneish).toBeDefined();
    // The one gap by construction: debt service was not supplied.
    const debtService = analysis.missing.find((entry) => entry.metric === 'debtServiceCoverage')!;
    expect(debtService.reason).toMatch(/debtServiceAmount not supplied/);
  });

  it('the point-in-time law flows through: an earlier asOf analyzes the earlier period', () => {
    const analysis = analyzeFundamentals({
      statements: HISTORY,
      asOf: Date.UTC(2025, 5, 1),
      restatementPolicy: 'latest-available',
    });
    expect(analysis.periodsVisible).toBe(2);
    expect(analysis.periodUsed.fiscalYear).toBe(2024);
    expect(analysis.ratios['grossMargin']!.value).toBeCloseTo(370 / 900, 12);
    // Three-period scores state the visibility gap.
    expect(analysis.missing.find((entry) => entry.metric === 'piotroskiFScore')!.reason).toMatch(
      /fewer than three periods/,
    );
    // Market multiples state their missing side.
    expect(analysis.missing.find((entry) => entry.metric === 'priceToEarnings')!.reason).toMatch(
      /marketSnapshot not supplied/,
    );
  });

  it('day metrics without periodDays are reported missing, never guessed from periodType', () => {
    const analysis = analyzeFundamentals({
      statements: HISTORY,
      asOf: Date.UTC(2026, 7, 12),
      restatementPolicy: 'latest-available',
    });
    expect(
      analysis.missing.find((entry) => entry.metric === 'daysInventoryOutstanding')!.reason,
    ).toMatch(/periodDays not supplied/);
  });
});
