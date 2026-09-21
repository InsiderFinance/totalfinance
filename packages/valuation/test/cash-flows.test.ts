/**
 * FC1 acceptance laws, verbatim from the spec, plus the Excel/NumPy-Financial golden corpus from
 * the FC0 evidence plan. Identities assert at 1e-12; external goldens at their published
 * precision. TotalFinance's clearer timing convention (a supplied time-zero flow enters at face
 * value; Excel's NPV discounts its first argument by one period) is documented AND tested.
 */

import { describe, expect, it } from 'vitest';
import { discountFactor, isQuantError, type InterestCompounding } from '@totalfinance/core';
import {
  amortizationSchedule,
  annuityPayment,
  cumulativeLoanInterest,
  cumulativeLoanPrincipal,
  datedInternalRateOfReturn,
  datedNetPresentValue,
  decliningBalanceDepreciation,
  discountCashFlows,
  discountedPaybackPeriod,
  doubleDecliningBalanceDepreciation,
  effectiveAnnualRate,
  equivalentAnnualAnnuity,
  equivalentInterestRate,
  futureValue,
  internalRateOfReturn,
  loanInterestPayment,
  loanNumberOfPeriods,
  loanPeriodicInterestRate,
  loanPrincipalPayment,
  modifiedInternalRateOfReturn,
  netPresentValue,
  nominalAnnualRate,
  paybackPeriod,
  presentValue,
  profitabilityIndex,
  straightLineDepreciation,
  sumOfYearsDigitsDepreciation,
} from '@totalfinance/valuation';

const EVERY_COMPOUNDING: readonly InterestCompounding[] = [
  'simple',
  'continuous',
  'annual',
  'semiannual',
  'quarterly',
  'monthly',
  { type: 'periodic', periodsPerYear: 26 },
];

describe('FC1 law: PV and FV invert under every supported compounding convention', () => {
  it('presentValue(futureValue(x)) === x to 1e-12, all seven forms', () => {
    for (const compounding of EVERY_COMPOUNDING) {
      const grown = futureValue({
        presentAmount: 1_000,
        annualInterestRate: 0.07,
        timeYears: 3.5,
        compounding,
      });
      const back = presentValue({
        futureAmount: grown,
        annualInterestRate: 0.07,
        timeYears: 3.5,
        compounding,
      });
      expect(back).toBeCloseTo(1_000, 9);
    }
  });
});

describe('FC1 law: NPV at each unambiguous IRR is zero', () => {
  const cashFlows = [
    { amount: -1_000, timeYears: 0 },
    { amount: 600, timeYears: 1 },
    { amount: 600, timeYears: 2 },
  ];

  it('the classic project: IRR matches the Excel golden and NPV(IRR) ≈ 0', () => {
    const rate = internalRateOfReturn({ cashFlows });
    expect(rate).not.toBeNull();
    // Excel IRR({-1000, 600, 600}) — closed form (−3 + √69)/6 inverted.
    expect(rate!).toBeCloseTo(0.1306623862, 9);
    expect(netPresentValue({ cashFlows, annualDiscountRate: rate! })).toBeCloseTo(0, 9);
  });

  it('the explain report carries the single root and its residual', () => {
    const report = internalRateOfReturn.explain({ cashFlows });
    expect(report.roots).toHaveLength(1);
    expect(report.value).toBeCloseTo(0.1306623862, 9);
    expect(report.diagnostics.converged).toBe(true);
    expect(Math.abs(report.roots[0]!.residualNetPresentValue)).toBeLessThan(1e-9);
    expect(report.assumptions.compounding).toBe('annual');
  });
});

describe('FC1 law: multiple sign changes never choose a root silently', () => {
  // The textbook pump project: two admissible IRRs (25% and 400%).
  const cashFlows = [
    { amount: -1_600, timeYears: 0 },
    { amount: 10_000, timeYears: 1 },
    { amount: -10_000, timeYears: 2 },
  ];

  it('the plain call returns null; the report names BOTH roots with the ambiguity warning', () => {
    expect(internalRateOfReturn({ cashFlows })).toBeNull();
    const report = internalRateOfReturn.explain({ cashFlows });
    expect(report.value).toBeNull();
    expect(report.roots.length).toBe(2);
    const rates = report.roots.map((root) => root.annualRate).sort((a, b) => a - b);
    expect(rates[0]!).toBeCloseTo(0.25, 6);
    expect(rates[1]!).toBeCloseTo(4.0, 6);
    expect(report.diagnostics.warnings.some((w) => w.message.includes('multiple'))).toBe(true);
  });

  it('a catastrophic-loss project still reports its honest (deeply negative) IRR', () => {
    // Recovering 10 of 1,000 after a year IS an internal rate: −99%/yr. The solver finds it
    // rather than calling the project rootless — first drafted as a "no root" case, wrongly.
    const rate = internalRateOfReturn({
      cashFlows: [
        { amount: -1_000, timeYears: 0 },
        { amount: 10, timeYears: 1 },
      ],
    });
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(-0.99, 6);
  });

  it('no-crossing flows: null with the no-root warning, never a fabricated rate', () => {
    // Both signs at the SAME instant: NPV ≡ −50 at every rate — no crossing exists.
    const report = internalRateOfReturn.explain({
      cashFlows: [
        { amount: -100, timeYears: 0 },
        { amount: 50, timeYears: 0 },
      ],
    });
    expect(report.value).toBeNull();
    expect(report.roots).toHaveLength(0);
    expect(report.diagnostics.converged).toBe(false);
    expect(report.diagnostics.warnings.some((w) => w.message.includes('no internal rate'))).toBe(
      true,
    );
  });
});

describe('FC1 law: periodic and dated forms agree on an exactly regular schedule', () => {
  it('NPV and IRR agree when dated flows fall exactly one 365-day year apart (ACT/365F)', () => {
    const timed = [
      { amount: -1_000, timeYears: 0 },
      { amount: 600, timeYears: 1 },
      { amount: 600, timeYears: 2 },
    ];
    // 2026-01-01 → 2027-01-01 → 2028-01-01 are 365-day gaps (no leap day inside).
    const dated = [
      { amount: -1_000, cashFlowDate: '2026-01-01' },
      { amount: 600, cashFlowDate: '2027-01-01' },
      { amount: 600, cashFlowDate: '2028-01-01' },
    ];
    const periodicValue = netPresentValue({ cashFlows: timed, annualDiscountRate: 0.1 });
    const datedValue = datedNetPresentValue({
      cashFlows: dated,
      asOf: '2026-01-01',
      annualDiscountRate: 0.1,
    });
    expect(datedValue).toBeCloseTo(periodicValue, 10);
    const periodicRate = internalRateOfReturn({ cashFlows: timed });
    const datedRate = datedInternalRateOfReturn({ cashFlows: dated, asOf: '2026-01-01' });
    expect(datedRate).not.toBeNull();
    expect(datedRate!).toBeCloseTo(periodicRate!, 8);
  });

  it('a realized flow BEFORE asOf accumulates forward — never discarded', () => {
    const value = datedNetPresentValue({
      cashFlows: [
        { amount: -1_000, cashFlowDate: '2025-01-01' }, // a year before asOf
        { amount: 1_200, cashFlowDate: '2027-01-01' },
      ],
      asOf: '2026-01-01',
      annualDiscountRate: 0.1,
    });
    // −1000 grows one year at 10% → −1100; +1200 discounts one year → 1090.909…
    expect(value).toBeCloseTo(-1_100 + 1_200 / 1.1, 10);
  });
});

describe('FC1 law: scaling every cash flow scales PV/NPV and leaves IRR unchanged', () => {
  const cashFlows = [
    { amount: -1_000, timeYears: 0 },
    { amount: 700, timeYears: 1 },
    { amount: 700, timeYears: 2 },
  ];
  const scaled = cashFlows.map((flow) => ({ ...flow, amount: flow.amount * 7 }));

  it('NPV scales by 7; IRR is identical', () => {
    const base = netPresentValue({ cashFlows, annualDiscountRate: 0.1 });
    const big = netPresentValue({ cashFlows: scaled, annualDiscountRate: 0.1 });
    expect(big).toBeCloseTo(base * 7, 9);
    expect(internalRateOfReturn({ cashFlows: scaled })!).toBeCloseTo(
      internalRateOfReturn({ cashFlows })!,
      10,
    );
  });
});

describe('FC1 law: the amortization schedule reconciles exactly', () => {
  it('the canonical 30-year 6% mortgage: the Excel PMT golden and full reconciliation', () => {
    const terms = {
      principal: 250_000,
      periodicInterestRate: 0.06 / 12,
      numberOfPeriods: 360,
      paymentTiming: 'end',
    } as const;
    // Excel PMT(0.005, 360, -250000) = 1,498.876313…
    expect(annuityPayment(terms)).toBeCloseTo(1_498.8763, 3);
    const { rows, totalInterest, totalPrincipal, payment } = amortizationSchedule(terms);
    expect(rows).toHaveLength(360);
    // Σ principal = original principal (no balloon); the final balance is ~0 (unrounded).
    expect(totalPrincipal).toBeCloseTo(250_000, 6);
    expect(rows.at(-1)!.closingBalance).toBeCloseTo(0, 6);
    // Every row reconciles: closing = opening − (payment − interest); payment = interest + principal.
    for (const row of [rows[0]!, rows[179]!, rows[359]!]) {
      expect(row.closingBalance).toBeCloseTo(row.openingBalance - row.principal, 8);
      expect(row.payment).toBeCloseTo(row.interest + row.principal, 8);
      expect(row.payment).toBeCloseTo(payment, 12);
    }
    // Cumulative heads agree with the schedule's own sums.
    expect(cumulativeLoanInterest({ ...terms, fromPeriod: 1, toPeriod: 360 })).toBeCloseTo(
      totalInterest,
      6,
    );
    expect(cumulativeLoanPrincipal({ ...terms, fromPeriod: 1, toPeriod: 360 })).toBeCloseTo(
      250_000,
      6,
    );
  });

  it('a balloon schedule amortizes principal − balloon and lands ON the balloon', () => {
    const terms = {
      principal: 100_000,
      periodicInterestRate: 0.004,
      numberOfPeriods: 60,
      paymentTiming: 'end',
      balloon: 40_000,
    } as const;
    const { rows, totalPrincipal, balloon } = amortizationSchedule(terms);
    expect(balloon).toBe(40_000);
    expect(totalPrincipal).toBeCloseTo(60_000, 8);
    expect(rows.at(-1)!.closingBalance).toBeCloseTo(40_000, 6);
  });

  it('NEGATIVE-RATE GOLDEN (2026-08-23 review defect C): interest components are SIGNED and reconcile', () => {
    // A negative periodic rate is economically real (the accepted domain is rate > −100%) and the
    // schedule documents its components as SIGNED: interest is NEGATIVE (credited to the
    // borrower), the principal component EXCEEDS the payment, and every reconciliation identity
    // holds with signs intact. Closed form / Excel PMT(−0.01, 12, −1200) = 93.6197372767….
    const terms = {
      principal: 1_200,
      periodicInterestRate: -0.01,
      numberOfPeriods: 12,
      paymentTiming: 'end',
    } as const;
    const { rows, payment, totalInterest, totalPrincipal } = amortizationSchedule(terms);
    expect(payment).toBeCloseTo(93.6197372767, 8);
    // Period 1 interest is EXACTLY principal · rate = 1_200 · (−0.01) = −12: signed, not |−12|.
    expect(rows[0]!.interest).toBe(-12);
    expect(rows[0]!.principal).toBeCloseTo(payment + 12, 10);
    for (const row of rows) {
      expect(row.interest).toBeLessThan(0);
      expect(row.principal).toBeGreaterThan(row.payment);
      expect(row.payment).toBeCloseTo(row.interest + row.principal, 10);
      expect(row.closingBalance).toBeCloseTo(row.openingBalance - row.principal, 10);
    }
    // The borrower pays LESS than the principal in total; the signed interest sum carries the gap.
    expect(totalInterest).toBeCloseTo(12 * payment - 1_200, 8);
    expect(totalInterest).toBeCloseTo(-76.5631526797, 8);
    expect(totalPrincipal).toBeCloseTo(1_200, 10);
    expect(rows.at(-1)!.closingBalance).toBeCloseTo(0, 8);
    // The per-period and cumulative heads report the SAME signed components.
    expect(loanInterestPayment({ ...terms, period: 1 })).toBe(-12);
    expect(loanPrincipalPayment({ ...terms, period: 1 })).toBeCloseTo(payment + 12, 10);
    expect(cumulativeLoanInterest({ ...terms, fromPeriod: 1, toPeriod: 12 })).toBeCloseTo(
      totalInterest,
      10,
    );
  });

  it("an annuity-due ('beginning') payment is the ordinary payment ÷ (1 + rate)", () => {
    const end = annuityPayment({
      principal: 10_000,
      periodicInterestRate: 0.01,
      numberOfPeriods: 24,
      paymentTiming: 'end',
    });
    const beginning = annuityPayment({
      principal: 10_000,
      periodicInterestRate: 0.01,
      numberOfPeriods: 24,
      paymentTiming: 'beginning',
    });
    expect(beginning).toBeCloseTo(end / 1.01, 10);
    const schedule = amortizationSchedule({
      principal: 10_000,
      periodicInterestRate: 0.01,
      numberOfPeriods: 24,
      paymentTiming: 'beginning',
    });
    expect(schedule.rows.at(-1)!.closingBalance).toBeCloseTo(0, 8);
  });

  it('the inverse heads recover the terms (NPER and RATE goldens)', () => {
    const payment = annuityPayment({
      principal: 250_000,
      periodicInterestRate: 0.005,
      numberOfPeriods: 360,
      paymentTiming: 'end',
    });
    expect(
      loanNumberOfPeriods({
        principal: 250_000,
        periodicInterestRate: 0.005,
        payment,
        paymentTiming: 'end',
      }),
    ).toBeCloseTo(360, 6);
    expect(
      loanPeriodicInterestRate({
        principal: 250_000,
        numberOfPeriods: 360,
        payment,
        paymentTiming: 'end',
      }),
    ).toBeCloseTo(0.005, 10);
  });
});

describe('FC1 edge coverage: zero rate, one period, immediate flow, long horizon, negative rate', () => {
  it('zero rate: PV = FV = face; payment = principal / periods; NPV = arithmetic sum', () => {
    expect(presentValue({ futureAmount: 500, annualInterestRate: 0, timeYears: 9 })).toBe(500);
    expect(
      annuityPayment({
        principal: 1_200,
        periodicInterestRate: 0,
        numberOfPeriods: 12,
        paymentTiming: 'end',
      }),
    ).toBe(100);
    expect(
      netPresentValue({
        cashFlows: [
          { amount: -100, timeYears: 0 },
          { amount: 60, timeYears: 3 },
          { amount: 60, timeYears: 7 },
        ],
        annualDiscountRate: 0,
      }),
    ).toBeCloseTo(20, 12);
  });

  it('an immediate (time-zero) flow enters at face value exactly once — never inferred', () => {
    const withZero = netPresentValue({
      cashFlows: [
        { amount: -1_000, timeYears: 0 },
        { amount: 1_100, timeYears: 1 },
      ],
      annualDiscountRate: 0.1,
    });
    expect(withZero).toBeCloseTo(-1_000 + 1_100 / 1.1, 12);
    // Excel-difference documentation: Excel's NPV discounts its FIRST argument one period; ours
    // reads timeYears literally. Excel's convention is reproduced by shifting every flow.
    const excelStyle = netPresentValue({
      cashFlows: [
        { amount: -1_000, timeYears: 1 },
        { amount: 1_100, timeYears: 2 },
      ],
      annualDiscountRate: 0.1,
    });
    expect(excelStyle).toBeCloseTo(withZero / 1.1, 10);
  });

  it('long horizon and negative rates stay finite and exact where valid', () => {
    expect(
      presentValue({
        futureAmount: 1,
        annualInterestRate: 0.03,
        timeYears: 100,
        compounding: 'continuous',
      }),
    ).toBeCloseTo(Math.exp(-3), 12);
    // A negative continuous rate is mathematically valid.
    expect(
      futureValue({
        presentAmount: 100,
        annualInterestRate: -0.02,
        timeYears: 5,
        compounding: 'continuous',
      }),
    ).toBeCloseTo(100 * Math.exp(-0.1), 12);
    // A periodic rate at/below −100% per period is not — it teaches.
    let caught: unknown;
    try {
      futureValue({
        presentAmount: 100,
        annualInterestRate: -1.2,
        timeYears: 1,
        compounding: 'annual',
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
  });
});

describe('FC1 goldens: rates, MIRR, capital budgeting, depreciation', () => {
  it('EAR/nominal/equivalent round-trip the Excel EFFECT/NOMINAL goldens', () => {
    // Excel EFFECT(0.12, 12) = 0.126825030…
    const effective = effectiveAnnualRate({ nominalAnnualRate: 0.12, compounding: 'monthly' });
    expect(effective).toBeCloseTo(0.1268250301, 9);
    // Excel NOMINAL(0.126825…, 12) = 0.12
    expect(
      nominalAnnualRate({ effectiveAnnualRate: effective, compounding: 'monthly' }),
    ).toBeCloseTo(0.12, 12);
    // Equivalence preserves the one-year growth factor across conventions.
    const continuous = equivalentInterestRate({
      annualInterestRate: 0.12,
      fromCompounding: 'monthly',
      toCompounding: 'continuous',
    });
    expect(Math.exp(continuous)).toBeCloseTo(Math.pow(1.01, 12), 12);
  });

  it('MIRR matches the Excel golden for the classic case', () => {
    // Excel MIRR({-1000, 600, 600}, 0.08, 0.05): PV(neg)=1000, FV(pos)=600·1.05+600=1230,
    // rate = √(1230/1000) − 1 = 0.109053…
    expect(
      modifiedInternalRateOfReturn({
        cashFlows: [
          { amount: -1_000, timeYears: 0 },
          { amount: 600, timeYears: 1 },
          { amount: 600, timeYears: 2 },
        ],
        financeRate: 0.08,
        reinvestmentRate: 0.05,
      }),
    ).toBeCloseTo(Math.sqrt(1.23) - 1, 12);
  });

  it('payback interpolates inside the recovering interval; discounted payback is later', () => {
    const cashFlows = [
      { amount: -1_000, timeYears: 0 },
      { amount: 600, timeYears: 1 },
      { amount: 600, timeYears: 2 },
    ];
    expect(paybackPeriod({ cashFlows })).toBeCloseTo(1 + 400 / 600, 12);
    const discounted = discountedPaybackPeriod({ cashFlows, annualDiscountRate: 0.1 });
    expect(discounted).toBeGreaterThan(paybackPeriod({ cashFlows })!);
    expect(
      paybackPeriod({
        cashFlows: [
          { amount: -100, timeYears: 0 },
          { amount: 10, timeYears: 1 },
        ],
      }),
    ).toBeNull();
  });

  it('profitability index and EAA agree with NPV arithmetic', () => {
    const cashFlows = [
      { amount: -1_000, timeYears: 0 },
      { amount: 700, timeYears: 1 },
      { amount: 700, timeYears: 2 },
    ];
    const value = netPresentValue({ cashFlows, annualDiscountRate: 0.1 });
    const index = profitabilityIndex({ cashFlows, annualDiscountRate: 0.1 });
    expect(index).toBeCloseTo((value + 1_000) / 1_000, 10);
    const annuity = equivalentAnnualAnnuity({
      cashFlows,
      annualDiscountRate: 0.1,
      projectLifeYears: 2,
    });
    // Discounting the EAA back over the horizon recovers the NPV.
    expect(annuity / 1.1 + annuity / 1.21).toBeCloseTo(value, 10);
  });

  it('the four depreciation methods match the Excel SLN/DDB/SYD goldens', () => {
    const asset = { cost: 10_000, salvageValue: 1_000, usefulLifePeriods: 5 };
    expect(straightLineDepreciation({ ...asset, period: 3 })).toBe(1_800); // SLN
    expect(doubleDecliningBalanceDepreciation({ ...asset, period: 1 })).toBe(4_000); // DDB p1
    expect(doubleDecliningBalanceDepreciation({ ...asset, period: 2 })).toBe(2_400); // DDB p2
    // DDB floors at salvage: by period 5 the remaining book is already at 1,296 → charge 296.
    expect(doubleDecliningBalanceDepreciation({ ...asset, period: 5 })).toBeCloseTo(296, 10);
    expect(sumOfYearsDigitsDepreciation({ ...asset, period: 1 })).toBe(3_000); // SYD 5/15
    expect(sumOfYearsDigitsDepreciation({ ...asset, period: 5 })).toBe(600); // SYD 1/15
    expect(decliningBalanceDepreciation({ ...asset, period: 1, factor: 1.5 })).toBeCloseTo(
      3_000,
      10,
    );
  });

  it('discountCashFlows rows carry the factor and per-flow PV, preserving order', () => {
    const { rows, presentValueTotal } = discountCashFlows({
      cashFlows: [
        { amount: -1_000, timeYears: 0, label: 'outlay' },
        { amount: 1_100, timeYears: 1 },
      ],
      annualDiscountRate: 0.1,
    });
    expect(rows[0]!.label).toBe('outlay');
    expect(rows[0]!.discountFactor).toBe(1);
    expect(rows[1]!.presentValue).toBeCloseTo(1_000, 10);
    expect(presentValueTotal).toBeCloseTo(0, 10);
  });
});

// ---------------------------------------------------------------------------------------------------
// Loan inverse heads: economic domain, proven brackets, verified roots, round-trip laws
// ---------------------------------------------------------------------------------------------------

describe('loan inverse heads reject the degenerate domain instead of returning plausible numbers', () => {
  it('loanNumberOfPeriods rejects a rate at or below −100% (the closed form used to return 0)', () => {
    let caught: unknown;
    try {
      loanNumberOfPeriods({
        principal: 1_000,
        periodicInterestRate: -1,
        payment: 100,
        paymentTiming: 'end',
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toContain('−100%');
  });

  it('loanNumberOfPeriods rejects a non-positive principal (used to return −9.58 periods)', () => {
    let caught: unknown;
    try {
      loanNumberOfPeriods({
        principal: -1_000,
        periodicInterestRate: 0.005,
        payment: 100,
        paymentTiming: 'end',
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toContain('principal must be > 0');
  });

  it('CORRECTED GOLDEN: the one-period rate solver reaches 9,999, not its old search cap of 128', () => {
    // n = 1, end timing, no balloon: payment = principal · (1 + rate), so the true rate is the
    // closed form payment / principal − 1 = 1_000_000 / 100 − 1 = 9_999. The old bisection
    // stopped expanding its bracket at an arbitrary cap (128) and returned the cap itself.
    const rate = loanPeriodicInterestRate({
      principal: 100,
      payment: 1_000_000,
      numberOfPeriods: 1,
      paymentTiming: 'end',
    });
    expect(Math.abs(rate - 9_999) / 9_999).toBeLessThan(1e-6);
  });

  it('refuses when NO rate in the economic domain reproduces the payment, naming the domain', () => {
    // An annuity-due pays its first installment before any interest accrues, so its level payment
    // is bounded above by the principal at EVERY rate — a payment above the principal has no
    // implied rate anywhere in rate > −1 and the solver refuses instead of returning a bound.
    // (2026-08-23 review defect B: this case used numberOfPeriods 1, whose no-balloon annuity-due
    // shape is now refused a priori as rate-free algebra before the solver runs — two periods keep
    // this test on the behavior it was written for, the solver's own searched-domain refusal.)
    let caught: unknown;
    try {
      loanPeriodicInterestRate({
        principal: 1_000,
        numberOfPeriods: 2,
        payment: 2_000,
        paymentTiming: 'beginning',
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'solver.no_convergence')).toBe(true);
    expect(String((caught as Error).message)).toContain('searched domain');
  });

  it('LAW 7 (loanNumberOfPeriods): extreme finite inputs throw — never a successful Infinity', () => {
    // 1e308 / 1e-308 overflows the period count to Infinity under IEEE-754: a refusal, never a
    // successful non-finite value.
    let caught: unknown;
    try {
      loanNumberOfPeriods({
        principal: 1e308,
        periodicInterestRate: 0,
        payment: 1e-308,
        paymentTiming: 'end',
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'solver.no_convergence')).toBe(true);
  });

  it('LAW 7 (loanPeriodicInterestRate): an unrepresentable implied rate is a refusal', () => {
    // n = 1 closed form: rate = payment / principal − 1 = 1e600 — beyond every representable
    // double, so no bracket can close and the solver refuses rather than returning a cap.
    let caught: unknown;
    try {
      loanPeriodicInterestRate({
        principal: 1e-300,
        numberOfPeriods: 1,
        payment: 1e300,
        paymentTiming: 'end',
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'solver.no_convergence')).toBe(true);
  });
});

describe('2026-08-23 review defect A: nonpositive payments are DOMAIN refusals, never solver outcomes', () => {
  // The confirmed repro: loanNumberOfPeriods({ principal: 1_000, periodicInterestRate: 0,
  // payment: -50, paymentTiming: 'end' }) used to throw the SOLVER's "no positive, finite number
  // of periods" refusal — a solver outcome for an input the public contract documents as a
  // positive magnitude. Both inverse heads now teach the domain up front, before any arithmetic.
  const nonpositivePayments = [0, -50] as const;

  it('loanNumberOfPeriods teaches payment > 0 for zero and negative payments (rate 0 and rate > 0)', () => {
    for (const payment of nonpositivePayments) {
      for (const periodicInterestRate of [0, 0.06 / 12]) {
        let caught: unknown;
        try {
          loanNumberOfPeriods({
            principal: 1_000,
            periodicInterestRate,
            payment,
            paymentTiming: 'end',
          });
        } catch (error) {
          caught = error;
        }
        expect(isQuantError(caught, 'input.out_of_range'), `payment ${payment}`).toBe(true);
        expect(String((caught as Error).message)).toContain('payment must be > 0');
        expect(String((caught as Error).message)).toContain('e.g. loanNumberOfPeriods({');
        // NOT the solver's refusal: the message must not read as a convergence outcome.
        expect(String((caught as Error).message)).not.toContain('no positive, finite number');
      }
    }
  });

  it('loanPeriodicInterestRate teaches payment > 0 for zero and negative payments', () => {
    for (const payment of nonpositivePayments) {
      let caught: unknown;
      try {
        loanPeriodicInterestRate({
          principal: 1_000,
          numberOfPeriods: 12,
          payment,
          paymentTiming: 'end',
        });
      } catch (error) {
        caught = error;
      }
      expect(isQuantError(caught, 'input.out_of_range'), `payment ${payment}`).toBe(true);
      expect(String((caught as Error).message)).toContain('payment must be > 0');
      expect(String((caught as Error).message)).toContain('e.g. loanPeriodicInterestRate({');
    }
  });
});

describe("2026-08-23 review defect B: the one-period 'beginning' no-balloon rate is refused, not 0", () => {
  // The single annuity-due payment falls at time ZERO, before any interest accrues, so the
  // amortization identity reads payment = principal at EVERY rate > −100% — the rate never
  // touches a cash flow. The bisection used to return 0 as if zero were THE implied rate.
  it('payment === principal: every rate satisfies the identity — UNIDENTIFIABLE, never 0', () => {
    let caught: unknown;
    try {
      loanPeriodicInterestRate({
        principal: 100,
        payment: 100,
        numberOfPeriods: 1,
        paymentTiming: 'beginning',
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toContain('UNIDENTIFIABLE');
    expect(String((caught as Error).message)).toContain('time zero');
    expect((caught as { context?: { reason?: string } }).context?.reason).toBe(
      'rate_unidentifiable',
    );
  });

  it('payment !== principal: the rate-free identity is already false — NO rate exists', () => {
    let caught: unknown;
    try {
      loanPeriodicInterestRate({
        principal: 100,
        payment: 90,
        numberOfPeriods: 1,
        paymentTiming: 'beginning',
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toContain('NO rate solves');
    expect((caught as { context?: { reason?: string } }).context?.reason).toBe('no_rate_exists');
  });

  it('a balloon restores identifiability: the residual is discounted, so the rate has a cash flow to touch', () => {
    // n = 1, 'beginning', balloon 50: payment = principal − balloon / (1 + rate) — rate-dependent
    // again, so the inverse must still SOLVE this shape rather than refuse it.
    const payment = annuityPayment({
      principal: 100,
      periodicInterestRate: 0.1,
      numberOfPeriods: 1,
      paymentTiming: 'beginning',
      balloon: 50,
    });
    expect(payment).toBeCloseTo(100 - 50 / 1.1, 10);
    const recovered = loanPeriodicInterestRate({
      principal: 100,
      numberOfPeriods: 1,
      payment,
      paymentTiming: 'beginning',
      balloon: 50,
    });
    expect(Math.abs(recovered - 0.1) / 0.1).toBeLessThan(1e-6);
  });
});

describe('loan inverse round-trip laws across the (principal, rate, n, timing, balloon) grid', () => {
  interface RoundTripCase {
    principal: number;
    rate: number;
    periods: number;
    timing: 'end' | 'beginning';
    balloon: number;
  }
  const grid: RoundTripCase[] = [];
  for (const principal of [1_000, 250_000]) {
    for (const rate of [-0.005, 0.0004, 0.06 / 12, 0.35, 12]) {
      for (const periods of [1, 12, 360]) {
        for (const timing of ['end', 'beginning'] as const) {
          for (const balloon of [0, principal * 0.2]) {
            // An extreme rate over a long horizon overflows (1 + rate)^n past every double —
            // annuityPayment itself has no representable payment there, nothing to round-trip.
            if (Math.pow(1 + rate, periods) > 1e300) continue;
            grid.push({ principal, rate, periods, timing, balloon });
          }
        }
      }
    }
  }

  it('annuityPayment → loanNumberOfPeriods recovers the term at 1e-9', () => {
    for (const c of grid) {
      // Once (1 + rate)^n exceeds ~1e12 the double-precision payment is P·rate to machine
      // precision REGARDLESS of the term — the payment no longer carries term information, so
      // recovery is information-theoretically impossible in doubles (catastrophic cancellation
      // in payment − principal·rate), not a solver defect.
      if (Math.pow(1 + c.rate, c.periods) > 1e12) continue;
      const payment = annuityPayment({
        principal: c.principal,
        periodicInterestRate: c.rate,
        numberOfPeriods: c.periods,
        paymentTiming: c.timing,
        balloon: c.balloon,
      });
      // 2026-08-23 review defect A: a strongly negative rate can decay the principal below the
      // balloon on its own (rate −0.005 over 360 periods against a 20% balloon here), making the
      // forward level "payment" NEGATIVE — outside the inverse head's documented positive-magnitude
      // payment domain, which loanNumberOfPeriods now refuses up front instead of letting it read
      // as a solver outcome. Same exclusion the rate round-trip below has always carried; the
      // forward schedule itself stays covered by the schedule laws.
      if (payment <= 0) continue;
      const recovered = loanNumberOfPeriods({
        principal: c.principal,
        periodicInterestRate: c.rate,
        payment,
        paymentTiming: c.timing,
        balloon: c.balloon,
      });
      expect(Math.abs(recovered - c.periods), JSON.stringify(c)).toBeLessThan(1e-9);
    }
  });

  it('annuityPayment → loanPeriodicInterestRate recovers the rate at 1e-9 relative', () => {
    for (const c of grid) {
      // An annuity-due over ONE period is the rate solver's ill-posed shape. With no balloon the
      // whole principal is paid before any interest accrues — the payment equals the principal at
      // EVERY rate, so the rate is unidentifiable (since the 2026-08-23 review defect B fix the
      // head REFUSES that shape with a teaching error instead of returning 0; the refusal tests
      // above cover it). With a balloon the ONLY rate information is the
      // single term balloon/(1 + rate): its slope in rate is balloon-scaled (≪ the principal), and
      // the head's own (1 + rate)^n − 1 representation noise divided by that flat slope displaces
      // the recoverable root past 1e-9 relative at small rates (measured ~1.1e-9 for rate 0.0004,
      // balloon 20%). This is the head's conditioning, not the solver: the returned rate still
      // reproduces the payment to machine precision (the residual check proves it). Beginning
      // timing stays fully covered at n = 12 and n = 360 across every rate in the grid.
      if (c.periods === 1 && c.timing === 'beginning') continue;
      const payment = annuityPayment({
        principal: c.principal,
        periodicInterestRate: c.rate,
        numberOfPeriods: c.periods,
        paymentTiming: c.timing,
        balloon: c.balloon,
      });
      // A negative rate can shrink the principal below the balloon on its own — the level
      // "payment" is negative there, outside the rate solver's positive-magnitude domain.
      if (payment <= 0) continue;
      const recovered = loanPeriodicInterestRate({
        principal: c.principal,
        numberOfPeriods: c.periods,
        payment,
        paymentTiming: c.timing,
        balloon: c.balloon,
      });
      expect(Math.abs(recovered - c.rate) / Math.abs(c.rate), JSON.stringify(c)).toBeLessThan(1e-9);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 2026-08-23 review P0: loan counts are SAFE integers under a stated work cap — never a request
// for unbounded synchronous work (`Number.isInteger(1e308)` is `true`; above 2^53 `period++`
// stops changing and a schedule loop cannot terminate)
// ---------------------------------------------------------------------------------------------------

describe('2026-08-23 review P0: loan period counts are safe integers capped at 100,000', () => {
  const termsWith = (numberOfPeriods: number) =>
    ({
      principal: 250_000,
      periodicInterestRate: 0.06 / 12,
      numberOfPeriods,
      paymentTiming: 'end',
    }) as const;

  it('every loan head refuses 2^53, 2^53 + 2, 1e308, −2^53, and a non-integer with one typed teaching', () => {
    for (const bad of [2 ** 53, 2 ** 53 + 2, 1e308, -(2 ** 53), 12.5]) {
      const calls: readonly [string, () => unknown][] = [
        ['annuityPayment', () => annuityPayment(termsWith(bad))],
        ['amortizationSchedule', () => amortizationSchedule(termsWith(bad))],
        ['loanInterestPayment', () => loanInterestPayment({ ...termsWith(bad), period: 1 })],
        ['loanPrincipalPayment', () => loanPrincipalPayment({ ...termsWith(bad), period: 1 })],
        [
          'cumulativeLoanInterest',
          () => cumulativeLoanInterest({ ...termsWith(bad), fromPeriod: 1, toPeriod: 1 }),
        ],
        [
          'cumulativeLoanPrincipal',
          () => cumulativeLoanPrincipal({ ...termsWith(bad), fromPeriod: 1, toPeriod: 1 }),
        ],
        [
          'loanPeriodicInterestRate',
          () =>
            loanPeriodicInterestRate({
              principal: 250_000,
              numberOfPeriods: bad,
              payment: 1_498.88,
              paymentTiming: 'end',
            }),
        ],
      ];
      for (const [head, call] of calls) {
        let caught: unknown;
        try {
          call();
        } catch (error) {
          caught = error;
        }
        expect(isQuantError(caught, 'input.out_of_range'), `${head} numberOfPeriods ${bad}`).toBe(
          true,
        );
        expect(String((caught as Error).message)).toContain('numberOfPeriods');
      }
    }
  });

  it('the cap teaches its own boundary: 100,001 is refused naming 100,000 and the row-per-period reason', () => {
    let caught: unknown;
    try {
      amortizationSchedule(termsWith(100_001));
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toContain('100,000');
    expect(String((caught as Error).message)).toContain('one row per period');
  });

  it('a schedule at EXACTLY the 100,000-period cap completes and reconciles', () => {
    const { rows, totalPrincipal } = amortizationSchedule({
      principal: 100_000,
      periodicInterestRate: 0.0001,
      numberOfPeriods: 100_000,
      paymentTiming: 'end',
    });
    expect(rows).toHaveLength(100_000);
    expect(totalPrincipal).toBeCloseTo(100_000, 6);
    expect(rows.at(-1)!.closingBalance).toBeCloseTo(0, 2);
    expect(
      cumulativeLoanPrincipal({
        principal: 100_000,
        periodicInterestRate: 0.0001,
        numberOfPeriods: 100_000,
        paymentTiming: 'end',
        fromPeriod: 1,
        toPeriod: 100_000,
      }),
    ).toBeCloseTo(100_000, 2);
  });

  it('the derived period coordinates take the same safe-integer law', () => {
    const base = termsWith(360);
    for (const bad of [2 ** 53, 2 ** 53 + 2, 1e308, -(2 ** 53), 2.5]) {
      for (const call of [
        () => loanInterestPayment({ ...base, period: bad }),
        () => loanPrincipalPayment({ ...base, period: bad }),
        () => cumulativeLoanInterest({ ...base, fromPeriod: 1, toPeriod: bad }),
        () => cumulativeLoanInterest({ ...base, fromPeriod: bad, toPeriod: 360 }),
        () => cumulativeLoanPrincipal({ ...base, fromPeriod: 1, toPeriod: bad }),
      ]) {
        let caught: unknown;
        try {
          call();
        } catch (error) {
          caught = error;
        }
        expect(isQuantError(caught, 'input.out_of_range'), `coordinate ${bad}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 2026-08-23 review finding 1: extreme magnitudes — a representable answer is computed STABLY,
// an unrepresentable one is a typed refusal, and Infinity/NaN never leaves a loan head
// ---------------------------------------------------------------------------------------------------

describe('2026-08-23 review finding 1: loan heads at ±1.7e308 magnitudes', () => {
  it('annuityPayment at a near-MAX_VALUE principal returns the representable payment the naive numerator overflowed', () => {
    // The payment is LINEAR in principal (p(k·P) = k·p(P)), so the truth at 1.7e308 is the
    // 1.7e8 payment × 1e300 ≈ 1.02e306 — representable. The old closed form computed
    // `principal · growth` first (≈ 1.02e309 → Infinity) and returned Infinity.
    const reference = annuityPayment({
      principal: 1.7e8,
      periodicInterestRate: 0.005,
      numberOfPeriods: 360,
      paymentTiming: 'end',
    });
    const extreme = annuityPayment({
      principal: 1.7e308,
      periodicInterestRate: 0.005,
      numberOfPeriods: 360,
      paymentTiming: 'end',
    });
    expect(Number.isFinite(extreme)).toBe(true);
    expect(extreme / 1e300).toBeCloseTo(reference, 3);
  });

  it('a payment past MAX_VALUE is a typed IEEE-754 refusal, never a successful Infinity', () => {
    // growth = 11^5 = 161,051 over annuity 16,105 → payment ≈ principal × 10 ≈ 1.7e309.
    let caught: unknown;
    try {
      annuityPayment({
        principal: 1.7e308,
        periodicInterestRate: 10,
        numberOfPeriods: 5,
        paymentTiming: 'end',
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toContain('IEEE-754');
  });

  it('a full schedule at principal 1.7e308 stays deeply finite and reconciles', () => {
    const { rows, payment } = amortizationSchedule({
      principal: 1.7e308,
      periodicInterestRate: 0.005,
      numberOfPeriods: 12,
      paymentTiming: 'end',
    });
    expect(Number.isFinite(payment)).toBe(true);
    for (const row of rows) {
      for (const value of [
        row.openingBalance,
        row.payment,
        row.interest,
        row.principal,
        row.closingBalance,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(row.payment).toBeCloseTo(row.interest + row.principal, -294);
    }
  });

  it('a cumulative sum past MAX_VALUE is a typed refusal, never Infinity', () => {
    // Each row's interest (~8.5e307) is finite; twelve of them sum past Number.MAX_VALUE.
    let caught: unknown;
    try {
      cumulativeLoanInterest({
        principal: 1.7e308,
        periodicInterestRate: 0.5,
        numberOfPeriods: 12,
        paymentTiming: 'end',
        fromPeriod: 1,
        toPeriod: 12,
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// equivalentAnnualAnnuity honors the declared compounding convention
// ---------------------------------------------------------------------------------------------------

describe('equivalentAnnualAnnuity round-trips the NPV under the SAME declared convention', () => {
  const cashFlows = [
    { amount: -1_000, timeYears: 0 },
    { amount: 700, timeYears: 1 },
    { amount: 700, timeYears: 2 },
  ];

  it('discounting the returned EAA over the project life recovers the NPV at 1e-12 — annual, continuous, and periodic', () => {
    // The confirmed defect: the NPV honored `compounding` but the annuity factor was hardcoded
    // annual, so under continuous compounding the returned EAA re-discounted continuously missed
    // the NPV (206.4977 vs 205.0736 in the review repro). The law: EAA × Σ df(t) = NPV EXACTLY
    // under the declared convention, for every convention.
    const conventions: readonly InterestCompounding[] = [
      'annual',
      'continuous',
      { type: 'periodic', periodsPerYear: 12 },
    ];
    for (const compounding of conventions) {
      const value = netPresentValue({ cashFlows, annualDiscountRate: 0.08, compounding });
      const annuity = equivalentAnnualAnnuity({
        cashFlows,
        annualDiscountRate: 0.08,
        projectLifeYears: 2,
        compounding,
      });
      let recovered = 0;
      for (let year = 1; year <= 2; year++) {
        recovered += annuity * discountFactor(0.08, year, compounding);
      }
      expect(Math.abs(recovered - value), JSON.stringify(compounding)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('annual behavior is UNCHANGED: the annuity-factor sum equals the classic closed form', () => {
    const rate = 0.1;
    const life = 7;
    let factorSum = 0;
    for (let year = 1; year <= life; year++) factorSum += discountFactor(rate, year, 'annual');
    const closedForm = (1 - Math.pow(1 + rate, -life)) / rate;
    expect(factorSum).toBeCloseTo(closedForm, 12);
    const value = netPresentValue({ cashFlows, annualDiscountRate: rate });
    const annuity = equivalentAnnualAnnuity({
      cashFlows,
      annualDiscountRate: rate,
      projectLifeYears: life,
    });
    expect(annuity).toBeCloseTo(value / closedForm, 10);
  });

  it('LAW 7: extreme finite inputs throw a typed postcondition error, never Infinity', () => {
    // A discount rate of 1e300 over one year makes the annuity factor ~1e-300; dividing a 1e10
    // NPV by it overflows — the head refuses instead of returning a successful Infinity.
    let caught: unknown;
    try {
      equivalentAnnualAnnuity({
        cashFlows: [{ amount: 1e10, timeYears: 0 }],
        annualDiscountRate: 1e300,
        projectLifeYears: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'postcondition.non_finite_result')).toBe(true);
  });
});

describe('finite-result law at near-MAX magnitudes (2026-08-23 review wave)', () => {
  it('presentValue past Number.MAX_VALUE refuses with a typed teaching, never Infinity', () => {
    try {
      presentValue({ futureAmount: 1e308, annualInterestRate: -0.5, timeYears: 10 });
      expect.unreachable('a PV of ~1e311 has no IEEE-754 representation and must refuse');
    } catch (error) {
      expect(isQuantError(error)).toBe(true);
      expect((error as Error).message).toMatch(/representable|IEEE-754/);
    }
  });

  it('sum-of-years-digits at a near-MAX cost computes ratio-first — the true charge is representable', () => {
    const charge = sumOfYearsDigitsDepreciation({
      cost: 1.7e308,
      salvageValue: 1_000,
      usefulLifePeriods: 5,
      period: 2,
    });
    expect(Number.isFinite(charge)).toBe(true);
    expect(charge).toBeCloseTo(1.7e308 * (4 / 15), -300);
  });

  it('depreciation refuses unsafe-integer lifetimes instead of looping forever', () => {
    expect(() =>
      sumOfYearsDigitsDepreciation({
        cost: 10_000,
        salvageValue: 1_000,
        usefulLifePeriods: 2 ** 53,
        period: 2,
      }),
    ).toThrowError(/\[1, 100_000\]/);
  });
});

describe('NPV exact cancellation is a SUCCESS, never a refusal (2026-08-23, fourth review)', () => {
  it('four time-zero flows summing to zero return exactly 0', () => {
    expect(
      netPresentValue({
        cashFlows: [
          { amount: 1e308, timeYears: 0 },
          { amount: 1e308, timeYears: 0 },
          { amount: -1e308, timeYears: 0 },
          { amount: -1e308, timeYears: 0 },
        ],
        annualDiscountRate: 0.1,
      }),
    ).toBe(0);
  });

  it('preserves a representable low-order residual regardless of overflow-prone flow order', () => {
    const amounts = [1e308, 1e308, 1, -1e308, -1e308];
    expect(
      netPresentValue({
        cashFlows: amounts.map((amount) => ({ amount, timeYears: 0 })),
        annualDiscountRate: 0.1,
      }),
    ).toBe(1);
    expect(
      netPresentValue({
        cashFlows: [...amounts].reverse().map((amount) => ({ amount, timeYears: 0 })),
        annualDiscountRate: 0.1,
      }),
    ).toBe(1);
  });

  it('a genuinely unrepresentable NPV still refuses with the teaching', () => {
    expect(() =>
      netPresentValue({
        cashFlows: [
          { amount: 1e308, timeYears: 0 },
          { amount: 1e308, timeYears: 0 },
        ],
        annualDiscountRate: 0.1,
      }),
    ).toThrowError(/representable|IEEE-754/);
  });
});
