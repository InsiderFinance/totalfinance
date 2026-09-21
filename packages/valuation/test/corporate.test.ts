/**
 * FC2 — corporate valuation: primitive goldens, the DCF acceptance laws (bridge reconciliation,
 * terminal recovery, cell-equals-direct-call, seeded reproducibility, deterministic collapse,
 * monotonicity), and the equity models.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  afterTaxCostOfDebt,
  capitalAssetPricingExpectedReturn,
  costOfEquity,
  discountedCashFlow,
  discountedCashFlowScenarioAnalysis,
  discountedCashFlowSensitivityTable,
  dividendDiscountValuation,
  enterpriseToEquityValue,
  freeCashFlowToEquity,
  freeCashFlowToFirm,
  probabilisticDiscountedCashFlow,
  residualIncomeValuation,
  reverseDiscountedCashFlow,
  terminalValue,
  weightedAverageCostOfCapital,
} from '../src/index.js';
import type { DiscountedCashFlowInput } from '../src/index.js';

const close = (actual: number, expected: number, tolerance = 1e-10): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

describe('cost of capital and cash-flow primitives', () => {
  it('capital-asset-pricing expected return and both cost-of-equity methods', () => {
    close(
      capitalAssetPricingExpectedReturn({
        annualRiskFreeRate: 0.04,
        beta: 1.2,
        annualMarketRiskPremium: 0.05,
      }),
      0.1,
    );
    close(
      costOfEquity({
        method: 'capital-asset-pricing',
        annualRiskFreeRate: 0.04,
        beta: 1.2,
        annualMarketRiskPremium: 0.05,
      }),
      0.1,
    );
    close(
      costOfEquity({
        method: 'dividend-growth',
        nextAnnualDividendPerShare: 2.1,
        sharePrice: 42,
        perpetualGrowthRate: 0.03,
      }),
      2.1 / 42 + 0.03,
    );
  });

  it('after-tax cost of debt, with the explicit unusable-shield adjustment', () => {
    close(afterTaxCostOfDebt({ annualPreTaxCostOfDebt: 0.06, marginalTaxRate: 0.21 }), 0.06 * 0.79);
    close(
      afterTaxCostOfDebt({
        annualPreTaxCostOfDebt: 0.06,
        marginalTaxRate: 0.21,
        unusableTaxShieldAdjustment: 0.005,
      }),
      0.06 * 0.79 + 0.005,
    );
  });

  it('WACC: normalized weights sum to one, scale invariance holds, zero base refused', () => {
    const components = [
      { label: 'equity', marketValue: 700, annualCostOfCapital: 0.1 },
      { label: 'debt', marketValue: 300, annualCostOfCapital: 0.045 },
    ];
    const result = weightedAverageCostOfCapital({ components });
    close(result.weightedAverageCostOfCapital, 0.7 * 0.1 + 0.3 * 0.045);
    close(
      result.components.reduce((sum, component) => sum + component.weight, 0),
      1,
      1e-12,
    );
    // Scale invariance: multiplying every market value by 1,000 moves no weight.
    const scaled = weightedAverageCostOfCapital({
      components: components.map((component) => ({
        ...component,
        marketValue: component.marketValue * 1_000,
      })),
    });
    close(scaled.weightedAverageCostOfCapital, result.weightedAverageCostOfCapital, 1e-12);
    expect(() =>
      weightedAverageCostOfCapital({
        components: [{ label: 'equity', marketValue: 0, annualCostOfCapital: 0.1 }],
      }),
    ).toThrow(/total capital base must be positive/);
  });

  it('FCFF and FCFE goldens, and the identity linking them', () => {
    close(
      freeCashFlowToFirm({
        operatingIncome: 180,
        taxRate: 0.25,
        depreciationAndAmortization: 45,
        capitalExpenditure: 70,
        increaseInNetWorkingCapital: 15,
      }),
      95,
    );
    close(
      freeCashFlowToEquity({
        netIncome: 126,
        depreciationAndAmortization: 45,
        capitalExpenditure: 70,
        increaseInNetWorkingCapital: 15,
        netBorrowing: 10,
      }),
      96,
    );
    // Identity from independently supplied components: with NI = (OI − interest) × (1 − t),
    // FCFE = FCFF − interest × (1 − t) + net borrowing. 95 − 12 × 0.75 + 10 = 96.
    close(95 - 12 * 0.75 + 10, 96, 1e-12);
  });

  it('terminal value recovers both direct primitives, and refuses growth ≥ rate', () => {
    close(
      terminalValue({
        terminalValueMethod: {
          method: 'perpetual-growth',
          terminalCashFlow: 135,
          perpetualGrowthRate: 0.025,
        },
        annualDiscountRate: 0.09,
      }),
      (135 * 1.025) / 0.065,
    );
    close(
      terminalValue({
        terminalValueMethod: {
          method: 'exit-multiple',
          terminalMetricAmount: 225,
          exitMultiple: 9,
        },
        annualDiscountRate: 0.09,
      }),
      2_025,
    );
    expect(() =>
      terminalValue({
        terminalValueMethod: {
          method: 'perpetual-growth',
          terminalCashFlow: 135,
          perpetualGrowthRate: 0.09,
        },
        annualDiscountRate: 0.09,
      }),
    ).toThrow(/annualDiscountRate > perpetualGrowthRate/);
  });

  it('the enterprise-to-equity bridge round-trips the enterprise-value definition', () => {
    close(
      enterpriseToEquityValue({
        enterpriseValue: 2_090,
        enterpriseToEquityBridge: {
          cashAndCashEquivalents: 150,
          totalDebt: 280,
          preferredEquity: 0,
          minorityInterest: 0,
          nonOperatingAssets: 0,
        },
      }),
      1_960,
    );
  });
});

const BASE_DCF: DiscountedCashFlowInput = {
  valuationBasis: 'firm',
  valuationDate: '2026-12-31',
  currency: 'USD',
  projectedCashFlows: [
    { timeYears: 1, amount: 120 },
    { timeYears: 2, amount: 135 },
  ],
  annualDiscountRate: 0.09,
  compounding: 'annual',
  terminalValueMethod: {
    method: 'perpetual-growth',
    terminalCashFlow: 135,
    perpetualGrowthRate: 0.025,
  },
};

// The hand-computed pieces of BASE_DCF.
const PV_FLOWS = 120 / 1.09 + 135 / 1.09 ** 2;
const TERMINAL = (135 * 1.025) / 0.065;
const PV_TERMINAL = TERMINAL / 1.09 ** 2;
const ENTERPRISE = PV_FLOWS + PV_TERMINAL;

describe('discountedCashFlow', () => {
  it('reproduces the hand-computed enterprise value, rows and all', () => {
    const result = discountedCashFlow(BASE_DCF);
    expect(result.valuationBasis).toBe('firm');
    if (result.valuationBasis !== 'firm') return;
    close(result.projectedCashFlowPresentValue, PV_FLOWS);
    close(result.terminalValue, TERMINAL);
    close(result.terminalValuePresentValue, PV_TERMINAL);
    close(result.enterpriseValue, ENTERPRISE);
    expect(result.projectedCashFlows).toHaveLength(2);
    close(result.projectedCashFlows[0]!.discountFactor, 1 / 1.09);
    close(result.projectedCashFlows[1]!.presentValue, 135 / 1.09 ** 2);
    expect(result.assumptions.contractVersion).toBe(1);
    expect(result.assumptions.discountRateSource).toBe('user-supplied');
    // No bridge: equity value ABSENT with the reason, never a silent zero.
    expect(result.equityValue).toBeUndefined();
    expect(result.equityValueAbsentReason).toMatch(/never silently zeroed/);
  });

  it('a dated schedule at exactly one ACT/365F year equals the timed schedule', () => {
    const dated = discountedCashFlow({
      ...BASE_DCF,
      projectedCashFlows: [
        { cashFlowDate: '2027-12-31', amount: 120 },
        { cashFlowDate: '2028-12-30', amount: 135 }, // 730 days = 2.0 years ACT/365F
      ],
      dayCount: 'ACT/365F',
    });
    const timed = discountedCashFlow(BASE_DCF);
    if (dated.valuationBasis !== 'firm' || timed.valuationBasis !== 'firm')
      throw new Error('basis');
    close(dated.enterpriseValue, timed.enterpriseValue, 1e-10);
  });

  it('the bridge reconciles exactly and per-share follows equity', () => {
    const result = discountedCashFlow({
      ...BASE_DCF,
      enterpriseToEquityBridge: {
        cashAndCashEquivalents: 40,
        totalDebt: 150,
        preferredEquity: 10,
        minorityInterest: 5,
        nonOperatingAssets: 20,
      },
      dilutedSharesOutstanding: 50,
    });
    if (result.valuationBasis !== 'firm') throw new Error('basis');
    const equity = ENTERPRISE - 150 - 10 - 5 + 40 + 20;
    close(result.equityValue!, equity);
    close(result.valuePerShare!, equity / 50);
  });

  it('FCFE produces equity value directly and REJECTS a bridge — never relabeled', () => {
    const result = discountedCashFlow({ ...BASE_DCF, valuationBasis: 'equity' });
    expect(result.valuationBasis).toBe('equity');
    if (result.valuationBasis !== 'equity') return;
    close(result.equityValue, ENTERPRISE);
    expect((result as { enterpriseValue?: number }).enterpriseValue).toBeUndefined();
    expect(() =>
      discountedCashFlow({
        ...BASE_DCF,
        valuationBasis: 'equity',
        enterpriseToEquityBridge: {
          cashAndCashEquivalents: 0,
          totalDebt: 0,
          preferredEquity: 0,
          minorityInterest: 0,
          nonOperatingAssets: 0,
        },
      }),
    ).toThrow(/'firm' basis only/);
  });

  it('a professional DCF refuses a defaulted convention and a mixed schedule', () => {
    const { compounding: _dropped, ...withoutCompounding } = BASE_DCF;
    expect(() => discountedCashFlow(withoutCompounding as DiscountedCashFlowInput)).toThrow(
      /compounding is required/,
    );
    expect(() =>
      discountedCashFlow({
        ...BASE_DCF,
        projectedCashFlows: [
          { timeYears: 1, amount: 120 },
          { cashFlowDate: '2028-12-31', amount: 135 },
        ] as never,
        dayCount: 'ACT/365F',
      }),
    ).toThrow(/mixes dated and timed/);
    expect(() => discountedCashFlow({ ...BASE_DCF, dayCount: 'ACT/365F' })).toThrow(
      /every projected flow is timed/,
    );
  });

  it('value is monotone where the economics require it', () => {
    const at = (annualDiscountRate: number, perpetualGrowthRate: number): number => {
      const result = discountedCashFlow({
        ...BASE_DCF,
        annualDiscountRate,
        terminalValueMethod: {
          method: 'perpetual-growth',
          terminalCashFlow: 135,
          perpetualGrowthRate,
        },
      });
      if (result.valuationBasis !== 'firm') throw new Error('basis');
      return result.enterpriseValue;
    };
    // Decreasing in the discount rate; increasing in growth (inside the valid domain).
    expect(at(0.08, 0.025)).toBeGreaterThan(at(0.09, 0.025));
    expect(at(0.09, 0.025)).toBeGreaterThan(at(0.1, 0.025));
    expect(at(0.09, 0.03)).toBeGreaterThan(at(0.09, 0.025));
  });
});

describe('reverse, sensitivity, scenario, probabilistic', () => {
  it('reverseDiscountedCashFlow recovers the rate that produced a value', () => {
    const reversed = reverseDiscountedCashFlow({
      discountedCashFlowInput: BASE_DCF,
      target: { variable: 'annual-discount-rate', searchRange: { from: 0.03, to: 0.3 } },
      targetValue: ENTERPRISE,
    });
    expect(reversed.converged).toBe(true);
    close(reversed.impliedValue!, 0.09, 1e-9);
    expect(reversed.residual).toBeLessThanOrEqual(1e-6);
    // An unbracketed target is null WITH the reason — never the nearest endpoint.
    const unbracketed = reverseDiscountedCashFlow({
      discountedCashFlowInput: BASE_DCF,
      target: { variable: 'annual-discount-rate', searchRange: { from: 0.2, to: 0.3 } },
      targetValue: ENTERPRISE * 2,
    });
    expect(unbracketed.impliedValue).toBeNull();
    expect(unbracketed.reason).toMatch(/not bracketed/);
  });

  it('every sensitivity cell equals a direct DCF call (the acceptance law, literally)', () => {
    const table = discountedCashFlowSensitivityTable({
      discountedCashFlowInput: BASE_DCF,
      rowAxis: { variable: 'annual-discount-rate', values: [0.08, 0.09, 0.1] },
      columnAxis: { variable: 'perpetual-growth-rate', values: [0.02, 0.025, 0.03] },
    });
    expect(table.rowUnit).toBe('annual decimal rate');
    table.rowValues.forEach((rate, rowIndex) => {
      table.columnValues.forEach((growth, columnIndex) => {
        const direct = discountedCashFlow({
          ...BASE_DCF,
          annualDiscountRate: rate,
          terminalValueMethod: {
            method: 'perpetual-growth',
            terminalCashFlow: 135,
            perpetualGrowthRate: growth,
          },
        });
        if (direct.valuationBasis !== 'firm') throw new Error('basis');
        close(table.cells[rowIndex]![columnIndex]!, direct.enterpriseValue, 1e-12);
      });
    });
    if (table.baseCase.valuationBasis !== 'firm') throw new Error('basis');
    close(table.baseCase.enterpriseValue, ENTERPRISE);
  });

  it('scenario results equal direct calls with exactly the stated overrides', () => {
    const analysis = discountedCashFlowScenarioAnalysis({
      discountedCashFlowInput: BASE_DCF,
      scenarios: [
        { scenarioName: 'bear', overrides: { annualDiscountRate: 0.11 } },
        { scenarioName: 'bull', overrides: { annualDiscountRate: 0.075 } },
      ],
    });
    expect(analysis.scenarios.map((scenario) => scenario.scenarioName)).toEqual(['bear', 'bull']);
    for (const scenario of analysis.scenarios) {
      const direct = discountedCashFlow({
        ...BASE_DCF,
        annualDiscountRate: scenario.scenarioName === 'bear' ? 0.11 : 0.075,
      });
      if (direct.valuationBasis !== 'firm' || scenario.result.valuationBasis !== 'firm') {
        throw new Error('basis');
      }
      close(scenario.result.enterpriseValue, direct.enterpriseValue, 1e-12);
      expect(scenario.overriddenFields).toEqual(['annualDiscountRate']);
    }
    expect(() =>
      discountedCashFlowScenarioAnalysis({
        discountedCashFlowInput: BASE_DCF,
        scenarios: [{ scenarioName: 'empty', overrides: {} }],
      }),
    ).toThrow(/overrides nothing/);
  });

  it('probabilistic runs reproduce exactly for the same seed and collapse when degenerate', () => {
    const shape = {
      discountedCashFlowInput: BASE_DCF,
      distributions: [
        {
          variable: 'annual-discount-rate' as const,
          distribution: { type: 'normal' as const, mean: 0.09, standardDeviation: 0.01 },
        },
      ],
      sampleCount: 2_000,
      seed: 42,
    };
    const first = probabilisticDiscountedCashFlow(shape);
    const second = probabilisticDiscountedCashFlow(shape);
    expect(second).toEqual(first);
    expect(first.validSampleCount + first.rejectedSamples.count).toBe(2_000);

    // Degenerate marginals collapse to the deterministic result exactly.
    const degenerate = probabilisticDiscountedCashFlow({
      ...shape,
      distributions: [
        {
          variable: 'annual-discount-rate',
          distribution: { type: 'normal', mean: 0.09, standardDeviation: 0 },
        },
      ],
      sampleCount: 50,
    });
    close(degenerate.mean, ENTERPRISE, 1e-9);
    // Zero up to accumulation dust: the mean of N identical ~2,100 values differs from each
    // value by a few ulp, and the (v − mean)² sum surfaces it. ~1e-12 absolute ≈ 1e-15 relative.
    close(degenerate.standardDeviation, 0, 1e-9);
    close(degenerate.quantiles.p50, ENTERPRISE, 1e-9);

    // A marginal straddling the model's domain: the invalid draws are counted with reasons.
    const straddling = probabilisticDiscountedCashFlow({
      ...shape,
      distributions: [
        {
          variable: 'perpetual-growth-rate',
          distribution: { type: 'uniform', from: 0.05, to: 0.13 },
        },
      ],
      sampleCount: 500,
    });
    expect(straddling.rejectedSamples.count).toBeGreaterThan(0);
    expect(Object.keys(straddling.rejectedSamples.reasons).length).toBeGreaterThan(0);
    expect(straddling.validSampleCount + straddling.rejectedSamples.count).toBe(500);
  });

  it('2026-08-23 review P0: sampleCount is a safe integer capped at 1,000,000 — never unbounded work', () => {
    // `Number.isInteger(1e308)` is `true`, and above 2^53 `sample++` stops changing — the old
    // gate let one call request effectively infinite (or literally non-terminating) synchronous
    // work, one full DCF per "sample".
    const base = {
      discountedCashFlowInput: BASE_DCF,
      distributions: [
        {
          variable: 'annual-discount-rate' as const,
          distribution: { type: 'normal' as const, mean: 0.09, standardDeviation: 0.01 },
        },
      ],
      seed: 42,
    };
    for (const bad of [2 ** 53, 2 ** 53 + 2, 1e308, -(2 ** 53), 1_000_001, 2.5]) {
      let caught: unknown;
      try {
        probabilisticDiscountedCashFlow({ ...base, sampleCount: bad });
      } catch (error) {
        caught = error;
      }
      expect(isQuantError(caught, 'input.out_of_range'), `sampleCount ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('sampleCount');
    }
    // The refusal just above the cap teaches the bound and the work it prices.
    let caught: unknown;
    try {
      probabilisticDiscountedCashFlow({ ...base, sampleCount: 1_000_001 });
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error).message)).toContain('1,000,000');
    expect(String((caught as Error).message)).toContain('full discountedCashFlow');
    // The cap itself is accepted (10^6 samples measured at ~8 s — too slow for a unit test, so
    // the acceptance boundary here is a large-but-quick run; the cap boundary is exercised by
    // refusal at cap + 1 above).
    const accepted = probabilisticDiscountedCashFlow({ ...base, sampleCount: 20_000 });
    expect(accepted.sampleCount).toBe(20_000);
  });
});

describe('equity models', () => {
  it('single-stage dividend discount IS the Gordon model', () => {
    const result = dividendDiscountValuation({
      projectedDividendsPerShare: [],
      annualCostOfEquity: 0.09,
      terminalValueMethod: {
        method: 'perpetual-growth',
        terminalCashFlow: 2,
        perpetualGrowthRate: 0.03,
      },
    });
    close(result.valuePerShare, (2 * 1.03) / 0.06);
  });

  it('two-stage dividend discount matches the hand sum', () => {
    const result = dividendDiscountValuation({
      projectedDividendsPerShare: [
        { amount: 2, timeYears: 1 },
        { amount: 2.2, timeYears: 2 },
      ],
      annualCostOfEquity: 0.09,
      terminalValueMethod: {
        method: 'perpetual-growth',
        terminalCashFlow: 2.2,
        perpetualGrowthRate: 0.03,
      },
    });
    const explicit = 2 / 1.09 + 2.2 / 1.09 ** 2;
    const terminal = (2.2 * 1.03) / 0.06 / 1.09 ** 2;
    close(result.valuePerShare, explicit + terminal);
    close(result.projectedDividendPresentValue, explicit);
  });

  it('residual income rolls clean surplus and matches the hand values, both terminals', () => {
    const base = {
      beginningBookValuePerShare: 20,
      annualCostOfEquity: 0.1,
      projections: [
        { earningsPerShare: 3, dividendsPerShare: 1 },
        { earningsPerShare: 3.3, dividendsPerShare: 1.1 },
      ],
    };
    // Year 1: charge 2, RI 1, book rolls 20 → 22. Year 2: charge 2.2, RI 1.1.
    const none = residualIncomeValuation({ ...base, terminalResidualIncome: { method: 'none' } });
    close(none.rows[0]!.residualIncomePerShare, 1);
    close(none.rows[1]!.residualIncomePerShare, 1.1);
    close(none.rows[1]!.beginningBookValuePerShare, 22);
    close(none.valuePerShare, 20 + 1 / 1.1 + 1.1 / 1.21);

    const perpetuity = residualIncomeValuation({
      ...base,
      terminalResidualIncome: { method: 'perpetuity', perpetualGrowthRate: 0 },
    });
    close(perpetuity.valuePerShare, 20 + 1 / 1.1 + 1.1 / 1.21 + 1.1 / 0.1 / 1.21);
  });
});

describe('near-MAX magnitudes: representable answers compute, unrepresentable ones teach (2026-08-23 review wave)', () => {
  it('WACC of two near-MAX components is exact — never weights 0 and a silently wrong 0', () => {
    const result = weightedAverageCostOfCapital({
      components: [
        { label: 'equity', marketValue: 1e308, annualCostOfCapital: 0.1 },
        { label: 'debt', marketValue: 1e308, annualCostOfCapital: 0.2 },
      ],
    });
    expect(result.weightedAverageCostOfCapital).toBeCloseTo(0.15, 12);
    expect(result.components[0]!.weight).toBeCloseTo(0.5, 12);
    expect(result.components[1]!.weight).toBeCloseTo(0.5, 12);
    expect(result.totalCapital).toBeNull();
    expect(result.totalCapitalAbsentReason).toContain('Number.MAX_VALUE');
    expect(result.diagnostics.warnings.some((w) => w.includes('totalCapital'))).toBe(true);
  });

  it('WACC with a representable total still reports it as a number', () => {
    const result = weightedAverageCostOfCapital({
      components: [
        { label: 'equity', marketValue: 700, annualCostOfCapital: 0.1 },
        { label: 'debt', marketValue: 300, annualCostOfCapital: 0.045 },
      ],
    });
    expect(result.totalCapital).toBe(1000);
    expect(result.totalCapitalAbsentReason).toBeUndefined();
  });

  it('CAPM survives an intermediate `beta × premium` overflow when the sum cancels back into range', () => {
    const value = capitalAssetPricingExpectedReturn({
      annualRiskFreeRate: 1.7e308,
      beta: 1.2,
      annualMarketRiskPremium: -1.7e308,
    });
    expect(value).toBeCloseTo(-0.2 * 1.7e308, -300);
    expect(Number.isFinite(value)).toBe(true);
  });

  it('terminal value computes ratio-first: near-MAX cash flow with deep negative growth is finite', () => {
    const value = terminalValue({
      terminalValueMethod: {
        method: 'perpetual-growth',
        terminalCashFlow: 1.7e308,
        perpetualGrowthRate: -1.7e308,
      },
      annualDiscountRate: 0.09,
    });
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeLessThan(0);
  });

  it('a genuinely unrepresentable sum refuses with a typed teaching, never Infinity', () => {
    expect(() =>
      freeCashFlowToEquity({
        netIncome: 1.7e308,
        depreciationAndAmortization: 1.7e308,
        capitalExpenditure: 70,
        increaseInNetWorkingCapital: 15,
        netBorrowing: 10,
      }),
    ).toThrowError(/IEEE-754|representable/);
  });
});

describe('exact cancellation is a SUCCESS, never a refusal (2026-08-23, fourth review)', () => {
  it('freeCashFlowToEquity: 1e308 + 1e308 − 1e308 − 1e308 is exactly 0', () => {
    expect(
      freeCashFlowToEquity({
        netIncome: 1e308,
        depreciationAndAmortization: 1e308,
        capitalExpenditure: 1e308,
        increaseInNetWorkingCapital: 1e308,
        netBorrowing: 0,
      }),
    ).toBe(0);
  });

  it('freeCashFlowToFirm cancels the same way at zero tax', () => {
    expect(
      freeCashFlowToFirm({
        operatingIncome: 1e308,
        taxRate: 0,
        depreciationAndAmortization: 1e308,
        capitalExpenditure: 1e308,
        increaseInNetWorkingCapital: 1e308,
      }),
    ).toBe(0);
  });

  it('enterpriseToEquityValue: near-MAX debt against near-MAX cash nets exactly', () => {
    expect(
      enterpriseToEquityValue({
        enterpriseValue: 0,
        enterpriseToEquityBridge: {
          cashAndCashEquivalents: 1e308,
          totalDebt: 1e308,
          preferredEquity: 0,
          minorityInterest: 0,
          nonOperatingAssets: 0,
        },
      }),
    ).toBe(0);
  });
});
