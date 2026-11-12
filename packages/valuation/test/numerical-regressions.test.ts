import { describe, expect, it } from 'vitest';
import {
  amortizationSchedule,
  annuityPayment,
  internalRateOfReturn,
  datedInternalRateOfReturn,
  loanNumberOfPeriods,
  loanInterestPayment,
  loanPeriodicInterestRate,
  leveragedBuyoutAnalysis,
} from '@totalfinance/valuation';

const terms = {
  principal: 1e12,
  periodicInterestRate: 1e-12 / 100 / 12,
  numberOfPeriods: 1200,
  paymentTiming: 'end' as const,
  balloon: 0,
};
describe('loan precision (#16)', () => {
  it('agrees with a 100-digit discounted-annuity reference and actual schedule balances', () => {
    expect(annuityPayment(terms) / 833333333.3337503472222223).toBeCloseTo(1, 14);
    const schedule = amortizationSchedule(terms);
    expect(Math.abs(schedule.rows.at(-1)!.closingBalance)).toBeLessThan(0.01);
    expect(schedule.totalPrincipal).toBe(
      schedule.rows.reduce((sum, row) => sum + row.principal, 0),
    );
    expect(schedule.totalPrincipal / terms.principal).toBeCloseTo(1, 13);
  });
  it('refuses a payment with no representable principal reduction', () => {
    expect(() =>
      annuityPayment({ ...terms, principal: 300000, periodicInterestRate: 1 / 12 }),
    ).toThrowError(expect.objectContaining({ code: 'solver.no_convergence' }));
  });
  for (const rate of [0, 1e-15, -1e-15, 0.005, -0.002])
    for (const timing of ['end', 'beginning'] as const) {
      it(`inverts ${rate}, ${timing} and verifies discounted individual cash flows`, () => {
        const t = {
          principal: 20000,
          periodicInterestRate: rate,
          numberOfPeriods: 60,
          paymentTiming: timing,
          balloon: 5000,
        };
        const payment = annuityPayment(t);
        const periods = loanNumberOfPeriods({
          principal: t.principal,
          periodicInterestRate: rate,
          payment,
          paymentTiming: timing,
          balloon: t.balloon,
        });
        expect(periods).toBeCloseTo(60, 9);
        const solved = loanPeriodicInterestRate({
          principal: t.principal,
          numberOfPeriods: 60,
          paymentTiming: timing,
          balloon: t.balloon,
          payment,
        });
        let pv = t.balloon * Math.exp(-60 * Math.log1p(solved));
        for (let i = 0; i < 60; i++)
          pv += payment * Math.exp(-(i + (timing === 'end' ? 1 : 0)) * Math.log1p(solved));
        expect(pv / t.principal).toBeCloseTo(1, 12);
        expect(solved).toBeCloseTo(rate, 12);
      });
    }
});

describe('IRR monetary units and inclusive endpoints (#21)', () => {
  for (const scale of [1e-200, 1e-15, 1, 1e200, 1e300]) {
    it(`preserves the independent five-year 2.5x identity at ${scale}`, () => {
      const report = internalRateOfReturn.explain({
        cashFlows: [
          { amount: -scale, timeYears: 0 },
          { amount: 2.5 * scale, timeYears: 5 },
        ],
      });
      expect(report.value).toBeCloseTo(0.2011244339814312332421, 11);
      expect(report.diagnostics.converged).toBe(true);
      expect(report.roots[0]!.residualNetPresentValue / scale).toBeCloseTo(0, 11);
      const dated = datedInternalRateOfReturn({
        asOf: '2020-01-01',
        dayCount: '30/360',
        cashFlows: [
          { amount: -scale, cashFlowDate: '2020-01-01' },
          { amount: 2.5 * scale, cashFlowDate: '2025-01-01' },
        ],
      });
      expect(dated).toBeCloseTo(0.2011244339814312332421, 11);
    });
  }
  it('includes the exact upper endpoint', () => {
    expect(
      internalRateOfReturn({
        cashFlows: [
          { amount: -1, timeYears: 0 },
          { amount: 11, timeYears: 1 },
        ],
      }),
    ).toBe(10);
  });
  it('preserves the public LBO composition at small monetary units', () => {
    const s = 1e-15;
    const report = leveragedBuyoutAnalysis({
      transaction: { purchaseEnterpriseValue: 100 * s, transactionFees: 0, cashToBalanceSheet: 0 },
      sources: { sponsorEquity: 100 * s, tranches: [] },
      operatingForecast: [1, 2, 3, 4, 5].map((year) => ({
        year,
        ebitda: 10 * s,
        capitalExpenditure: 10 * s,
        increaseInNetWorkingCapital: 0,
        taxRate: 0,
      })),
      cashSweepFraction: 0,
      exit: { year: 5, exitEbitdaMultiple: 25, exitFees: 0 },
    });
    expect(report.internalRateOfReturn).toBeCloseTo(0.2011244339814312332421, 11);
  });
});
for (const principal of [1e-200, 1e-50, 1, 1e100, 1e300])
  it(`keeps actual amortization and totals scale-consistent at ${principal}`, () => {
    const schedule = amortizationSchedule({ ...terms, principal });
    expect(schedule.payment / principal).toBeCloseTo(1 / 1200, 12);
    expect(schedule.rows.at(-1)!.closingBalance).toBe(0);
    expect(schedule.totalPrincipal / principal).toBeCloseTo(1, 12);
  });
it('independently verifies rate inversion on an explicit net advance', () => {
  const r = loanPeriodicInterestRate({
    principal: 19500,
    numberOfPeriods: 60,
    paymentTiming: 'end',
    payment: 386.65603058855836767,
  });
  expect(r).toBeCloseTo(0.0058815606279390701906, 13);
});
it('includes the lower endpoint without inventing underflow roots', () => {
  const lower = -0.999999;
  expect(
    internalRateOfReturn({
      cashFlows: [
        { amount: -1, timeYears: 0 },
        { amount: 1 + lower, timeYears: 1 },
      ],
    }),
  ).toBeCloseTo(lower, 14);
  expect(
    internalRateOfReturn({
      cashFlows: [
        { amount: -1, timeYears: 1000 },
        { amount: 2, timeYears: 1001 },
      ],
    }),
  ).toBeCloseTo(1, 11);
});
it('reports a detected discontinuous discount-underflow bracket as unresolved', () => {
  const input = {
    cashFlows: [
      { amount: -1e-200, timeYears: 0 },
      { amount: 1e200, timeYears: 1000 },
    ],
  };
  const report = internalRateOfReturn.explain(input);
  expect(report.value).toBeNull();
  expect(report.diagnostics.converged).toBe(false);
  expect(report.diagnostics.warnings).toContainEqual(
    expect.objectContaining({
      context: expect.objectContaining({ unresolvedBrackets: expect.any(Array) }),
    }),
  );
});

it('refuses principal reductions smaller than the balance resolution, even with a large balloon', () => {
  expect(() => annuityPayment({ ...terms, balloon: terms.principal - 0.001 })).toThrowError(
    expect.objectContaining({ code: 'solver.no_convergence' }),
  );
});

// Independent review counterexamples: ordinary calculations must survive precision guards.
for (const [principal, rate, periods] of [
  [100000, 0.15, 50],
  [333333.33, 0.02, 360],
])
  it(`reconciles compounded schedule roundoff at ${rate}/${periods}`, () => {
    const t = {
      principal: principal!,
      periodicInterestRate: rate!,
      numberOfPeriods: periods!,
      paymentTiming: 'end' as const,
    };
    const schedule = amortizationSchedule(t);
    expect(schedule.rows.at(-1)!.closingBalance).toBe(0);
    expect(loanInterestPayment({ ...t, period: 1 })).toBe(principal! * rate!);
    expect(Math.abs(schedule.rows.at(-1)!.payment - schedule.payment) / principal!).toBeLessThan(
      1e-10,
    );
  });
it('does not write off a material high-rate residual', () => {
  expect(() =>
    amortizationSchedule({
      principal: 100000,
      periodicInterestRate: 0.1,
      numberOfPeriods: 360,
      paymentTiming: 'end',
    }),
  ).toThrowError(expect.objectContaining({ code: 'solver.no_convergence' }));
});
it('inverts a long negative-rate annuity without rounding its logarithm to minus infinity', () => {
  const t = {
    principal: 100000,
    periodicInterestRate: -0.005,
    numberOfPeriods: 12000,
    paymentTiming: 'end' as const,
  };
  expect(
    loanNumberOfPeriods({
      principal: t.principal,
      periodicInterestRate: t.periodicInterestRate,
      payment: annuityPayment(t),
      paymentTiming: 'end',
    }),
  ).toBeCloseTo(12000, 8);
});
it('resolves negative IRR with large discounted terms and offset times', () => {
  expect(
    internalRateOfReturn({
      cashFlows: [
        { timeYears: 27, amount: -100 },
        { timeYears: 30, amount: 34.3 },
      ],
    }),
  ).toBeCloseTo(-0.3, 11);
  expect(
    datedInternalRateOfReturn({
      asOf: '1990-01-01',
      dayCount: '30/360',
      cashFlows: [
        { cashFlowDate: '2020-01-01', amount: -100 },
        { cashFlowDate: '2023-01-01', amount: 34.3 },
      ],
    }),
  ).toBeCloseTo(-0.3, 11);
});
it('never silently selects the positive root of an offset two-root polynomial', () => {
  const a = 1 / 1.1,
    b = 1 / 0.7;
  const input = {
    cashFlows: [
      { timeYears: 40, amount: a * b },
      { timeYears: 41, amount: -(a + b) },
      { timeYears: 42, amount: 1 },
    ],
  };
  const report = internalRateOfReturn.explain(input);
  expect(internalRateOfReturn(input)).toBeNull();
  expect(report.roots.map((r) => r.annualRate).sort()).toEqual([
    expect.closeTo(-0.3, 10),
    expect.closeTo(0.1, 10),
  ]);
  expect(report.diagnostics.warnings).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining('multiple') }),
  );
});
it('does not reject a harmless small flow when normalization would erase it', () => {
  expect(
    internalRateOfReturn({
      cashFlows: [
        { timeYears: 0, amount: -1e300 },
        { timeYears: 1, amount: 1e-30 },
        { timeYears: 2, amount: 2e300 },
      ],
    }),
  ).toBeCloseTo(Math.SQRT2 - 1, 11);
});

it('keeps explicitly charged periodic fees separate from interest and principal', () => {
  const t = {
    principal: 20000,
    periodicInterestRate: 0.005,
    numberOfPeriods: 60,
    paymentTiming: 'end' as const,
  };
  const schedule = amortizationSchedule({ ...t, periodicFee: 12.5 });
  expect(schedule.rows.every((row) => row.fee === 12.5)).toBe(true);
  expect(schedule.rows[0]!.interest).toBe(100);
  expect(schedule.payment).toBe(annuityPayment(t));
  expect(schedule.rows.at(-1)!.closingBalance).toBe(0);
  expect(schedule.rows.reduce((sum, row) => sum + row.fee!, 0)).toBe(750);
});

for (const paymentTiming of ['end', 'beginning'] as const)
  for (const scale of [1e-100, 1, 1e100])
    for (const [principal, rate, numberOfPeriods, balloon] of [
      [100000, 0.05 / 12, 60, 99999.99],
      [500000, 0.005, 120, 499999],
      [100000, 0.01, 360, 99990],
      [250000, 0.05 / 12, 60, 249999.99],
    ])
      it(`keeps near-interest-only balloon schedules representable: ${principal}/${balloon}/${paymentTiming}/${scale}`, () => {
        const t = {
          principal: principal! * scale,
          periodicInterestRate: rate!,
          numberOfPeriods: numberOfPeriods!,
          balloon: balloon! * scale,
          paymentTiming,
        };
        const schedule = amortizationSchedule(t);
        expect(schedule.rows.at(-1)!.closingBalance).toBe(t.balloon);
        expect(
          Math.abs(schedule.rows.at(-1)!.payment - schedule.payment) / t.principal,
        ).toBeLessThan(1e-10);
        expect(loanInterestPayment({ ...t, period: 1 })).toBe(schedule.rows[0]!.interest);
        if (paymentTiming === 'end') expect(schedule.rows[0]!.interest).toBe(t.principal * rate!);
      });
