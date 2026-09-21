/**
 * FC4 — cash-flow-aware performance. Every acceptance law of the spec section is exercised with
 * HAND-COMPUTED goldens:
 *   (a) TWR is invariant to a pure external contribution immediately valued at the same NAV;
 *   (b) MWR equals `datedInternalRateOfReturn` on the identical cash-flow schedule;
 *   (c) with no external flows, TWR, MWR, and the linked simple return agree;
 *   (d) transfers between accounts inside one portfolio net to zero external flow;
 *   (e) single-period group contributions reconcile to the weighted total within 1e-12;
 * plus a fully hand-derived Modified Dietz example, the TWR gap law (missing mark → gap, never a
 * forward fill), and the explicit-annualization law (annualization 'none' → NO annualized field).
 */

import { describe, expect, it } from 'vitest';
import { InputError, PostconditionError } from '@totalfinance/core';
import { datedInternalRateOfReturn } from '@totalfinance/valuation';
import {
  benchmarkRelativeTimeline,
  contributionByGroup,
  linkSubperiodReturns,
  modifiedDietzReturn,
  moneyWeightedReturn,
  portfolioReturnIndex,
  segmentExternalFlows,
  timeWeightedReturn,
} from '@totalfinance/performance';

// ---------------------------------------------------------------------------------------------------
// timeWeightedReturn
// ---------------------------------------------------------------------------------------------------

describe('timeWeightedReturn', () => {
  it('links subperiod simple returns geometrically (hand-computed no-flow golden)', () => {
    // 1000 → 1100 (+10%), 1100 → 1210 (+10%); geometric link: 1.1 · 1.1 − 1 = 0.21.
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-04-01', netAssetValue: 1_100 },
        { valuationDate: '2024-07-01', netAssetValue: 1_210 },
      ],
      externalCashFlows: [],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    expect(result.timeWeightedReturn).toBeCloseTo(0.21, 12);
    expect(result.subperiods).toHaveLength(2);
    expect(result.subperiods[0]!.simpleReturn).toBeCloseTo(0.1, 12);
    expect(result.subperiods[1]!.simpleReturn).toBeCloseTo(0.1, 12);
    expect(result.subperiods[1]!.externalFlowAmount).toBe(0);
    expect(result.diagnostics.gaps).toHaveLength(0);
    expect(result.diagnostics.subperiodCount).toBe(2);
    expect(result.assumptions.flowTiming).toBe('at-flow-timestamp');
    expect(result.assumptions.linking).toBe('geometric');
    expect(result.assumptions.flowConvention).toContain('never profit or loss');
  });

  it('THE DISCRIMINATING GOLDEN: a same-day flow is invested for the WHOLE subperiod it starts', () => {
    // The exact repro that separated the two flow-timing formulas: NAV 100, a same-day contribution
    // of 100 on the first valuation date, the whole 200 grows +10%, end NAV 220. Under the stated
    // convention (mark first, then flow → the flow belongs to the subperiod STARTING that date and
    // is invested for its whole length) the return is 220 / (100 + 100) − 1 = 0.10 EXACTLY. The
    // end-of-period-flow formula the module used to compute — (220 − 100) / 100 − 1 = 0.20 —
    // contradicts its own documented convention by crediting the flow with zero period exposure.
    //
    // Why the old invariance test (law a) could not catch this: BOTH formulas satisfy "a pure
    // contribution valued at the same NAV leaves the linked return unchanged", because each
    // formula is invariant under its own self-consistent construction of the fixture — and the two
    // formulas agree numerically whenever the flow subperiod has ZERO growth (end = start + flow).
    // Only a golden with real growth in the flow subperiod, pinned to the stated convention,
    // discriminates.
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 100 },
        { valuationDate: '2024-02-01', netAssetValue: 220 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-01-01', amount: 100, label: 'same-day deposit' }],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    expect(result.timeWeightedReturn).not.toBeNull();
    expect(Math.abs(result.timeWeightedReturn! - 0.1)).toBeLessThanOrEqual(1e-12);
    expect(result.subperiods).toHaveLength(1);
    expect(result.subperiods[0]!.externalFlowAmount).toBe(100);
    expect(Math.abs(result.subperiods[0]!.simpleReturn - 0.1)).toBeLessThanOrEqual(1e-12);
    expect(result.assumptions.flowConvention).toContain(
      'endNetAssetValue / (startNetAssetValue + netExternalFlows) − 1',
    );
  });

  it('WITHDRAWAL GOLDEN: a same-day withdrawal shrinks the base for the whole subperiod', () => {
    // Hand-computed under the start-of-subperiod convention: 1000 → 1100 is +10%; then a −400
    // withdrawal lands on 2024-02-01 (after the 1100 mark), leaving 700 invested; the 700 grows
    // +10% to 770. Subperiod 2: 770 / (1100 − 400) − 1 = 770/700 − 1 = 0.10. Linked: 1.1² − 1.
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-02-01', netAssetValue: 1_100 },
        { valuationDate: '2024-03-01', netAssetValue: 770 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-02-01', amount: -400, label: 'withdrawal' }],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    expect(result.subperiods).toHaveLength(2);
    expect(result.subperiods[1]!.externalFlowAmount).toBe(-400);
    expect(result.subperiods[1]!.simpleReturn).toBeCloseTo(0.1, 12);
    expect(result.timeWeightedReturn).toBeCloseTo(0.21, 12);
  });

  it('a same-day withdrawal of the whole portfolio makes the subperiod a GAP, never a blow-up', () => {
    // Base on 2024-02-01: 1100 + (−1100) = 0 — nothing remains invested, so no return is
    // measurable over that subperiod. It is a gap with a reason, mirroring the zero-start gap.
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-02-01', netAssetValue: 1_100 },
        { valuationDate: '2024-03-01', netAssetValue: 0 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-02-01', amount: -1_100 }],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    expect(result.subperiods).toHaveLength(1);
    expect(result.timeWeightedReturn).toBeCloseTo(0.1, 12);
    expect(result.diagnostics.gaps).toHaveLength(1);
    expect(result.diagnostics.gaps[0]).toMatchObject({
      fromDate: '2024-02-01',
      toDate: '2024-03-01',
    });
    expect(result.diagnostics.gaps[0]!.reason).toContain('not positive');
  });

  it('LAW (a): is invariant to a pure contribution immediately valued at the same NAV', () => {
    // Convention under test: the mark dated D precedes same-dated flows, so NAV(2024-04-01)=1100
    // EXCLUDES the 100 deposit; the deposit belongs to the subperiod STARTING 2024-04-01 and is
    // invested for its whole length. Base portfolio: 1000 → 1100 → 1210 (10% + 10%). With the
    // deposit the whole 1200 base grows +10%: 1320 = (1100 + 100) · 1.1.
    //   subperiod 2 (with flow): 1320 / (1100 + 100) − 1 = 1320/1200 − 1 = 0.10 — identical.
    const withoutFlow = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-04-01', netAssetValue: 1_100 },
        { valuationDate: '2024-07-01', netAssetValue: 1_210 },
      ],
      externalCashFlows: [],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    const withFlow = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-04-01', netAssetValue: 1_100 },
        { valuationDate: '2024-07-01', netAssetValue: 1_320 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-04-01', amount: 100, label: 'monthly deposit' }],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    expect(withFlow.timeWeightedReturn).not.toBeNull();
    expect(withFlow.timeWeightedReturn!).toBeCloseTo(withoutFlow.timeWeightedReturn!, 12);
    expect(withFlow.timeWeightedReturn!).toBeCloseTo(0.21, 12);
    // The deposit is attributed to the START of the subperiod beginning on its date…
    expect(withFlow.subperiods[1]!.externalFlowAmount).toBe(100);
    // …and the earlier subperiod is untouched (mark precedes the same-dated flow).
    expect(withFlow.subperiods[0]!.externalFlowAmount).toBe(0);
    expect(withFlow.subperiods[0]!.simpleReturn).toBeCloseTo(0.1, 12);
    expect(withFlow.subperiods[1]!.simpleReturn).toBeCloseTo(0.1, 12);
    expect(withFlow.diagnostics.flowCount).toBe(1);
  });

  it('GAP LAW: a flow date with no valuation makes its subperiod a gap — never a forward fill', () => {
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-02-01', netAssetValue: 1_050 },
        { valuationDate: '2024-03-01', netAssetValue: 1_100 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-01-15', amount: 50 }],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    expect(result.diagnostics.gaps).toHaveLength(1);
    expect(result.diagnostics.gaps[0]).toMatchObject({
      fromDate: '2024-01-01',
      toDate: '2024-02-01',
    });
    expect(result.diagnostics.gaps[0]!.reason).toContain('no portfolio valuation');
    expect(result.diagnostics.gaps[0]!.reason).toContain('forward-filled');
    // Only the clean subperiod is measured and linked — nothing was forward-filled.
    expect(result.subperiods).toHaveLength(1);
    expect(result.subperiods[0]!.startDate).toBe('2024-02-01');
    expect(result.timeWeightedReturn).toBeCloseTo(1_100 / 1_050 - 1, 12);
    expect(result.diagnostics.warnings.some((warning) => warning.includes('gap'))).toBe(true);
  });

  it('returns null-with-reason when EVERY subperiod is a gap', () => {
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-02-01', netAssetValue: 1_050 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-01-15', amount: 50 }],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    expect(result.timeWeightedReturn).toBeNull();
    expect(result.reason).toContain('every subperiod is a gap');
    expect(result.subperiods).toHaveLength(0);
    expect('annualizedReturn' in result).toBe(false);
  });

  it('ANNUALIZATION LAW: annualization "none" produces NO annualized field', () => {
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-12-31', netAssetValue: 1_100 },
      ],
      externalCashFlows: [],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    expect('annualizedReturn' in result).toBe(false);
    expect(result.assumptions.annualization).toBe('none');
  });

  it('annualizes only under the explicit ACT/365F basis (hand-computed two-year golden)', () => {
    // 2024-01-01 → 2025-12-31 is exactly 730 actual days (366 + 364) = 2.0 ACT/365F years.
    // Linked return 0.21 → annualized = sqrt(1.21) − 1 = 0.10.
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-12-31', netAssetValue: 1_100 },
        { valuationDate: '2025-12-31', netAssetValue: 1_210 },
      ],
      externalCashFlows: [],
      flowTiming: 'at-flow-timestamp',
      annualization: { basis: 'ACT/365F' },
    });
    expect(result.timeWeightedReturn).toBeCloseTo(0.21, 12);
    expect(result.annualizedReturn).toBeCloseTo(0.1, 12);
    expect(result.assumptions.annualization).toEqual({ basis: 'ACT/365F' });
  });

  it('WITHHOLDS annualizedReturn when any subperiod is a gap — a warning is not validity', () => {
    // The linked return covers only the measured subperiods; annualizing it over the full
    // first-to-last ACT/365F window would state a rate for time the measurement excluded.
    // Mirrors the ≤ −100% withhold: the field is ABSENT, with a warning explaining why.
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-02-01', netAssetValue: 1_050 },
        { valuationDate: '2024-03-01', netAssetValue: 1_100 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-01-15', amount: 50 }],
      flowTiming: 'at-flow-timestamp',
      annualization: { basis: 'ACT/365F' },
    });
    // The measured subperiod still links…
    expect(result.timeWeightedReturn).toBeCloseTo(1_100 / 1_050 - 1, 12);
    expect(result.diagnostics.gaps).toHaveLength(1);
    // …but no annualized rate is stated over a window the linked return does not cover.
    expect('annualizedReturn' in result).toBe(false);
    expect(
      result.diagnostics.warnings.some((warning) =>
        warning.includes('annualizedReturn is withheld'),
      ),
    ).toBe(true);
  });

  it('LAW 7: an extreme-but-finite input can never return a successful non-finite number', () => {
    // 1e300 / 1e-300 overflows the linked growth factor to Infinity — the head throws a typed
    // PostconditionError instead of succeeding with a non-finite return.
    expect(() =>
      timeWeightedReturn({
        valuations: [
          { valuationDate: '2024-01-01', netAssetValue: 1e-300 },
          { valuationDate: '2024-02-01', netAssetValue: 1e300 },
        ],
        externalCashFlows: [],
        flowTiming: 'at-flow-timestamp',
        annualization: 'none',
      }),
    ).toThrow(PostconditionError);
  });

  it('warns about flows outside the window and on the final valuation date (both unmeasurable)', () => {
    const result = timeWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-02-01', netAssetValue: 1_100 },
      ],
      externalCashFlows: [
        { cashFlowDate: '2023-12-01', amount: 25 },
        { cashFlowDate: '2024-02-01', amount: 75 },
      ],
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    // Neither flow can affect a measured subperiod: the return is the clean 10%.
    expect(result.timeWeightedReturn).toBeCloseTo(0.1, 12);
    expect(
      result.diagnostics.warnings.some((warning) =>
        warning.includes('outside the valuation window'),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.warnings.some((warning) => warning.includes('final valuation date')),
    ).toBe(true);
    expect(result.diagnostics.gaps).toHaveLength(0);
  });

  it('teaches its closed request: flowTiming and annualization are explicit, keys are known', () => {
    const valuations = [
      { valuationDate: '2024-01-01', netAssetValue: 1_000 },
      { valuationDate: '2024-02-01', netAssetValue: 1_100 },
    ];
    expect(() =>
      timeWeightedReturn({
        valuations,
        externalCashFlows: [],
        // @ts-expect-error — the only v1 policy is the explicit literal.
        flowTiming: 'end-of-day',
        annualization: 'none',
      }),
    ).toThrow(/at-flow-timestamp/);
    expect(() =>
      // @ts-expect-error — annualization is required and explicit.
      timeWeightedReturn({ valuations, externalCashFlows: [], flowTiming: 'at-flow-timestamp' }),
    ).toThrow(/annualization/);
    expect(() =>
      timeWeightedReturn({
        valuations,
        externalCashFlows: [],
        flowTiming: 'at-flow-timestamp',
        annualization: 'none',
        // @ts-expect-error — unknown key must be rejected, not ignored.
        flowTimming: 'at-flow-timestamp',
      }),
    ).toThrow(InputError);
    expect(() =>
      timeWeightedReturn({
        valuations: [
          { valuationDate: '2024-02-01', netAssetValue: 1_000 },
          { valuationDate: '2024-01-01', netAssetValue: 1_100 },
        ],
        externalCashFlows: [],
        flowTiming: 'at-flow-timestamp',
        annualization: 'none',
      }),
    ).toThrow(/strictly ascending/);
    expect(() =>
      timeWeightedReturn({
        valuations: [
          { valuationDate: '01/01/2024', netAssetValue: 1_000 },
          { valuationDate: '2024-02-01', netAssetValue: 1_100 },
        ],
        externalCashFlows: [],
        flowTiming: 'at-flow-timestamp',
        annualization: 'none',
      }),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      timeWeightedReturn({
        valuations: [
          { valuationDate: '2024-01-01', netAssetValue: -5 },
          { valuationDate: '2024-02-01', netAssetValue: 1_100 },
        ],
        externalCashFlows: [],
        flowTiming: 'at-flow-timestamp',
        annualization: 'none',
      }),
    ).toThrow(/≥ 0/);
  });
});

// ---------------------------------------------------------------------------------------------------
// moneyWeightedReturn
// ---------------------------------------------------------------------------------------------------

describe('moneyWeightedReturn', () => {
  it('LAW (b): equals datedInternalRateOfReturn on the identical schedule (1e-12)', () => {
    const result = moneyWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 10_000 },
        { valuationDate: '2025-01-01', netAssetValue: 11_500 },
      ],
      externalCashFlows: [
        { cashFlowDate: '2024-05-01', amount: 1_000, label: 'spring deposit' },
        { cashFlowDate: '2024-09-01', amount: -500, label: 'autumn withdrawal' },
      ],
    });
    // The identical investor schedule, handed to the FC1 solver directly:
    // −NAV₀, deposits sign-flipped to outflows, withdrawals to inflows, +NAVₙ.
    const direct = datedInternalRateOfReturn({
      cashFlows: [
        { amount: -10_000, cashFlowDate: '2024-01-01' },
        { amount: -1_000, cashFlowDate: '2024-05-01' },
        { amount: 500, cashFlowDate: '2024-09-01' },
        { amount: 11_500, cashFlowDate: '2025-01-01' },
      ],
      asOf: '2024-01-01',
    });
    expect(direct).not.toBeNull();
    expect(result.moneyWeightedReturn).not.toBeNull();
    expect(result.moneyWeightedReturn!).toBeCloseTo(direct!, 12);
    expect('reason' in result).toBe(false);
    expect(result.diagnostics.scheduleRowCount).toBe(4);
    expect(result.assumptions.asOf).toBe('2024-01-01');
    expect(result.assumptions.signConvention).toContain('outflow');
  });

  it('preserves the FC1 solver report whole: roots, convergence, and conventions ride along', () => {
    const result = moneyWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-12-31', netAssetValue: 1_100 },
      ],
      externalCashFlows: [],
    });
    expect(result.solverReport.roots).toHaveLength(1);
    expect(result.solverReport.diagnostics.converged).toBe(true);
    expect(result.solverReport.diagnostics.method).toBe('scan-bisect');
    expect(result.solverReport.assumptions.compounding).toBe('annual');
    expect(result.solverReport.assumptions.dayCount).toBe('ACT/365F');
    expect(result.solverReport.assumptions.asOf).toBe('2024-01-01');
    expect(result.solverReport.value).toBe(result.moneyWeightedReturn);
  });

  it('warns that interior valuations do not enter the schedule', () => {
    const result = moneyWeightedReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-06-01', netAssetValue: 1_500 },
        { valuationDate: '2024-12-31', netAssetValue: 1_100 },
      ],
      externalCashFlows: [],
    });
    expect(result.diagnostics.warnings.some((warning) => warning.includes('interior'))).toBe(true);
    expect(result.diagnostics.scheduleRowCount).toBe(2);
  });

  it('rejects flows outside the anchoring window and all-one-sign schedules with teaching errors', () => {
    expect(() =>
      moneyWeightedReturn({
        valuations: [
          { valuationDate: '2024-01-01', netAssetValue: 1_000 },
          { valuationDate: '2024-12-31', netAssetValue: 1_100 },
        ],
        externalCashFlows: [{ cashFlowDate: '2025-06-01', amount: 100 }],
      }),
    ).toThrow(/outside the measurement window/);
    expect(() =>
      moneyWeightedReturn({
        valuations: [
          { valuationDate: '2024-01-01', netAssetValue: 0 },
          { valuationDate: '2024-12-31', netAssetValue: 1_100 },
        ],
        externalCashFlows: [],
      }),
    ).toThrow(/one inflow AND one outflow/);
  });
});

// ---------------------------------------------------------------------------------------------------
// LAW (c): no-flow agreement of TWR, MWR, and the linked simple return
// ---------------------------------------------------------------------------------------------------

describe('no-flow agreement (law c)', () => {
  it('TWR, MWR, and the linked simple return agree on a one-ACT/365F-year no-flow fixture', () => {
    // 2024-01-01 → 2024-12-31 is exactly 365 actual days = 1.0 ACT/365F year, so the simple
    // return 1100/1000 − 1 = 0.10 IS the annual rate: the dated IRR solves
    // −1000 + 1100/(1+r)^1 = 0 → r = 0.10 under the same convention.
    const valuations = [
      { valuationDate: '2024-01-01', netAssetValue: 1_000 },
      { valuationDate: '2024-12-31', netAssetValue: 1_100 },
    ] as const;
    const timeWeighted = timeWeightedReturn({
      valuations: [...valuations],
      externalCashFlows: [],
      flowTiming: 'at-flow-timestamp',
      annualization: { basis: 'ACT/365F' },
    });
    const moneyWeighted = moneyWeightedReturn({
      valuations: [...valuations],
      externalCashFlows: [],
    });
    const linked = linkSubperiodReturns({
      subperiodReturns: timeWeighted.subperiods.map((subperiod) => subperiod.simpleReturn),
      linking: 'geometric',
    });
    expect(timeWeighted.timeWeightedReturn).toBeCloseTo(0.1, 12);
    expect(timeWeighted.annualizedReturn).toBeCloseTo(0.1, 12);
    expect(moneyWeighted.moneyWeightedReturn).not.toBeNull();
    // The solver bisects to 1e-12 interval width — compare at 1e-9 as the honest tolerance.
    expect(
      Math.abs(moneyWeighted.moneyWeightedReturn! - timeWeighted.timeWeightedReturn!),
    ).toBeLessThan(1e-9);
    expect(linked.linkedReturn).toBeCloseTo(timeWeighted.timeWeightedReturn!, 12);
  });
});

// ---------------------------------------------------------------------------------------------------
// modifiedDietzReturn
// ---------------------------------------------------------------------------------------------------

describe('modifiedDietzReturn', () => {
  it('matches a fully hand-derived example and exposes the weights it used', () => {
    // Window 2024-01-01 → 2024-01-31: daysInPeriod = 30 actual days.
    // Flow +100 on 2024-01-11: daysSinceStart = 10, weight = (30 − 10)/30 = 2/3.
    // Numerator:   1210 − 1000 − 100                 = 110.
    // Denominator: 1000 + (2/3)·100 = 1000 + 200/3   = 3200/3.
    // Return:      110 / (3200/3) = 330/3200         = 0.103125 exactly.
    const result = modifiedDietzReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-01-31', netAssetValue: 1_210 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-01-11', amount: 100 }],
    });
    expect(result.modifiedDietzReturn).toBeCloseTo(0.103125, 12);
    expect(result.flowWeights).toHaveLength(1);
    expect(result.flowWeights[0]!.cashFlowDate).toBe('2024-01-11');
    expect(result.flowWeights[0]!.amount).toBe(100);
    expect(result.flowWeights[0]!.weight).toBeCloseTo(2 / 3, 12);
    expect(result.diagnostics.daysInPeriod).toBe(30);
    expect(result.assumptions.weightFormula).toContain(
      '(daysInPeriod − daysSinceStart_i) / daysInPeriod',
    );
    expect(result.assumptions.dayCount).toBe('ACT (actual calendar days)');
  });

  it('weights the endpoints correctly: start-date flow = 1, end-date flow = 0', () => {
    // Start-date flow (weight 1): (1210 − 1000 − 100) / (1000 + 1·100) = 110/1100 = 0.10.
    const startFlow = modifiedDietzReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-01-31', netAssetValue: 1_210 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-01-01', amount: 100 }],
    });
    expect(startFlow.flowWeights[0]!.weight).toBe(1);
    expect(startFlow.modifiedDietzReturn).toBeCloseTo(0.1, 12);
    // End-date flow (weight 0): (1210 − 1000 − 100) / (1000 + 0·100) = 110/1000 = 0.11.
    const endFlow = modifiedDietzReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-01-31', netAssetValue: 1_210 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-01-31', amount: 100 }],
    });
    expect(endFlow.flowWeights[0]!.weight).toBe(0);
    expect(endFlow.modifiedDietzReturn).toBeCloseTo(0.11, 12);
  });

  it('is a single-period estimator: exactly the two endpoint valuations', () => {
    expect(() =>
      modifiedDietzReturn({
        valuations: [
          { valuationDate: '2024-01-01', netAssetValue: 1_000 },
          { valuationDate: '2024-01-15', netAssetValue: 1_100 },
          { valuationDate: '2024-01-31', netAssetValue: 1_210 },
        ],
        externalCashFlows: [],
      }),
    ).toThrow(/EXACTLY the two period endpoints/);
  });

  it('returns null-with-reason on a non-positive average-capital denominator', () => {
    // Denominator: 100 + 1·(−200) = −100 ≤ 0 — no honest rate exists.
    const result = modifiedDietzReturn({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 100 },
        { valuationDate: '2024-01-31', netAssetValue: 50 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-01-01', amount: -200 }],
    });
    expect(result.modifiedDietzReturn).toBeNull();
    expect(result.reason).toContain('not positive');
  });
});

// ---------------------------------------------------------------------------------------------------
// linkSubperiodReturns
// ---------------------------------------------------------------------------------------------------

describe('linkSubperiodReturns', () => {
  it('links geometrically and arithmetically under the explicit policy', () => {
    const geometric = linkSubperiodReturns({ subperiodReturns: [0.1, 0.1], linking: 'geometric' });
    expect(geometric.linkedReturn).toBeCloseTo(0.21, 12); // 1.1 · 1.1 − 1
    expect(geometric.assumptions.linking).toBe('geometric');
    const arithmetic = linkSubperiodReturns({
      subperiodReturns: [0.1, 0.1],
      linking: 'arithmetic',
    });
    expect(arithmetic.linkedReturn).toBeCloseTo(0.2, 12); // 0.1 + 0.1
    expect(arithmetic.diagnostics.subperiodCount).toBe(2);
  });

  it('requires the linking policy explicitly and warns past a total wipeout', () => {
    expect(() =>
      // @ts-expect-error — linking is required.
      linkSubperiodReturns({ subperiodReturns: [0.1] }),
    ).toThrow(/geometric|arithmetic/);
    const wipeout = linkSubperiodReturns({ subperiodReturns: [-1.5, 0.1], linking: 'geometric' });
    expect(wipeout.diagnostics.warnings.some((warning) => warning.includes('−100%'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// segmentExternalFlows
// ---------------------------------------------------------------------------------------------------

describe('segmentExternalFlows', () => {
  it('LAW (d): transfers between accounts of one portfolio net to zero external flow', () => {
    const result = segmentExternalFlows({
      externalCashFlows: [
        { cashFlowDate: '2024-03-01', amount: 1_000 },
        { cashFlowDate: '2024-03-15', amount: -250, accountId: 'brokerage' },
        { cashFlowDate: '2024-03-15', amount: 250, accountId: 'retirement' },
      ],
    });
    expect(result.internalTransfers).toEqual([
      {
        cashFlowDate: '2024-03-15',
        amount: 250,
        fromAccountId: 'brokerage',
        toAccountId: 'retirement',
      },
    ]);
    // The transfer legs are internal — the ONLY external flow is the 1000 deposit.
    expect(result.externalNetAmount).toBe(1_000);
    expect(result.byAccount).toEqual([
      { accountId: 'unassigned', deposits: 1_000, withdrawals: 0, net: 1_000 },
    ]);
    expect(result.diagnostics.internalTransferCount).toBe(1);
    expect(result.diagnostics.flowCount).toBe(3);
  });

  it('a transfer-only ledger has exactly zero external flow', () => {
    const result = segmentExternalFlows({
      externalCashFlows: [
        { cashFlowDate: '2024-03-15', amount: -250, accountId: 'brokerage' },
        { cashFlowDate: '2024-03-15', amount: 250, accountId: 'retirement' },
      ],
    });
    expect(result.externalNetAmount).toBe(0);
    expect(result.byAccount).toEqual([]);
    expect(result.internalTransfers).toHaveLength(1);
  });

  it('does NOT pair legs missing an accountId — both sides must name their account', () => {
    const result = segmentExternalFlows({
      externalCashFlows: [
        { cashFlowDate: '2024-03-15', amount: -250 },
        { cashFlowDate: '2024-03-15', amount: 250, accountId: 'retirement' },
      ],
    });
    expect(result.internalTransfers).toHaveLength(0);
    expect(result.externalNetAmount).toBe(0); // they still sum to zero — but as external flows
    expect(result.byAccount).toEqual([
      { accountId: 'unassigned', deposits: 0, withdrawals: -250, net: -250 },
      { accountId: 'retirement', deposits: 250, withdrawals: 0, net: 250 },
    ]);
  });

  it('identifies transfers BEFORE the account filter so a filter never orphans a leg', () => {
    const result = segmentExternalFlows({
      externalCashFlows: [
        { cashFlowDate: '2024-03-15', amount: -250, accountId: 'brokerage' },
        { cashFlowDate: '2024-03-15', amount: 250, accountId: 'retirement' },
        { cashFlowDate: '2024-03-01', amount: 100, accountId: 'brokerage' },
        { cashFlowDate: '2024-03-02', amount: 40 }, // unassigned — excluded by any filter
      ],
      accountFilter: ['brokerage'],
    });
    // The −250 brokerage leg is a transfer, NOT a brokerage withdrawal.
    expect(result.internalTransfers).toHaveLength(1);
    expect(result.byAccount).toEqual([
      { accountId: 'brokerage', deposits: 100, withdrawals: 0, net: 100 },
    ]);
    expect(result.externalNetAmount).toBe(100);
    expect(result.diagnostics.excludedByFilterCount).toBe(1);
    expect(result.assumptions.accountFilter).toEqual(['brokerage']);
  });
});

// ---------------------------------------------------------------------------------------------------
// portfolioReturnIndex
// ---------------------------------------------------------------------------------------------------

describe('portfolioReturnIndex', () => {
  it('chains the TWR subperiod returns from the base value (hand-computed golden)', () => {
    // 100 → 100·1.1 = 110 → 110·1.1 = 121.
    const result = portfolioReturnIndex({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-04-01', netAssetValue: 1_100 },
        { valuationDate: '2024-07-01', netAssetValue: 1_210 },
      ],
      externalCashFlows: [],
    });
    expect(result.indexSeries).not.toBeNull();
    expect(result.indexSeries!.map((point) => point.date)).toEqual([
      '2024-01-01',
      '2024-04-01',
      '2024-07-01',
    ]);
    expect(result.indexSeries![0]!.indexValue).toBe(100);
    expect(result.indexSeries![1]!.indexValue).toBeCloseTo(110, 9);
    expect(result.indexSeries![2]!.indexValue).toBeCloseTo(121, 9);
    expect(result.assumptions.baseValue).toBe(100);
  });

  it('is flow-invariant exactly like TWR (law a at index scope)', () => {
    // Same construction as LAW (a): the 100 deposit lands at the start of the 2024-04-01
    // subperiod and the whole 1200 base grows +10% → 1320 = (1100 + 100) · 1.1.
    const withoutFlow = portfolioReturnIndex({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-04-01', netAssetValue: 1_100 },
        { valuationDate: '2024-07-01', netAssetValue: 1_210 },
      ],
      externalCashFlows: [],
    });
    const withFlow = portfolioReturnIndex({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-04-01', netAssetValue: 1_100 },
        { valuationDate: '2024-07-01', netAssetValue: 1_320 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-04-01', amount: 100 }],
    });
    expect(withFlow.indexSeries).not.toBeNull();
    withFlow.indexSeries!.forEach((point, index) => {
      expect(point.indexValue).toBeCloseTo(withoutFlow.indexSeries![index]!.indexValue, 12);
    });
    // The final level is the hand-computed 121 = 100 · 1.1 · 1.1 under the new formula.
    expect(withFlow.indexSeries![2]!.indexValue).toBeCloseTo(121, 9);
  });

  it('LAW 7: an extreme-but-finite input can never return a successful non-finite index', () => {
    expect(() =>
      portfolioReturnIndex({
        valuations: [
          { valuationDate: '2024-01-01', netAssetValue: 1e-300 },
          { valuationDate: '2024-02-01', netAssetValue: 1e300 },
        ],
        externalCashFlows: [],
      }),
    ).toThrow(PostconditionError);
  });

  it('GAP POLICY (decided, documented, echoed): any gap withholds the WHOLE index', () => {
    const result = portfolioReturnIndex({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-02-01', netAssetValue: 1_050 },
        { valuationDate: '2024-03-01', netAssetValue: 1_100 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-01-15', amount: 50 }],
    });
    expect(result.indexSeries).toBeNull();
    expect(result.reason).toContain('null-on-any-gap');
    expect(result.assumptions.gapPolicy).toContain('null-on-any-gap');
    expect(result.diagnostics.gaps).toHaveLength(1);
  });

  it('echoes a custom base value and anchors the series on it', () => {
    const result = portfolioReturnIndex({
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-02-01', netAssetValue: 1_100 },
      ],
      externalCashFlows: [],
      baseValue: 1_000,
    });
    expect(result.assumptions.baseValue).toBe(1_000);
    expect(result.indexSeries![0]!.indexValue).toBe(1_000);
    expect(result.indexSeries![1]!.indexValue).toBeCloseTo(1_100, 9);
    expect(() =>
      portfolioReturnIndex({
        valuations: [
          { valuationDate: '2024-01-01', netAssetValue: 1_000 },
          { valuationDate: '2024-02-01', netAssetValue: 1_100 },
        ],
        externalCashFlows: [],
        baseValue: 0,
      }),
    ).toThrow(/baseValue must be > 0/);
  });
});

// ---------------------------------------------------------------------------------------------------
// benchmarkRelativeTimeline
// ---------------------------------------------------------------------------------------------------

describe('benchmarkRelativeTimeline', () => {
  it('aligns by date and reports cumulative relative performance (hand-computed golden)', () => {
    // Portfolio: 100 → 110 (+10%) → 121 (+21% cumulative).
    // Benchmark: +5% then +5% → cumulative 0.05, then 1.05² − 1 = 0.1025.
    // Relative:  1.10/1.05 − 1 and 1.21/1.1025 − 1.
    const result = benchmarkRelativeTimeline({
      portfolioIndex: [
        { date: '2024-01-01', indexValue: 100 },
        { date: '2024-02-01', indexValue: 110 },
        { date: '2024-03-01', indexValue: 121 },
      ],
      benchmarkReturns: [
        { date: '2024-02-01', simpleReturn: 0.05 },
        { date: '2024-03-01', simpleReturn: 0.05 },
      ],
      benchmarkBasis: 'total-return',
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.date).toBe('2024-02-01');
    expect(result.rows[0]!.portfolioCumulativeReturn).toBeCloseTo(0.1, 12);
    expect(result.rows[0]!.benchmarkCumulativeReturn).toBeCloseTo(0.05, 12);
    expect(result.rows[0]!.relativePerformance).toBeCloseTo(1.1 / 1.05 - 1, 12);
    expect(result.rows[1]!.portfolioCumulativeReturn).toBeCloseTo(0.21, 12);
    expect(result.rows[1]!.benchmarkCumulativeReturn).toBeCloseTo(0.1025, 12);
    expect(result.rows[1]!.relativePerformance).toBeCloseTo(1.21 / 1.1025 - 1, 12);
    expect(result.diagnostics.gaps).toHaveLength(0);
    expect(result.assumptions.benchmarkBasis).toBe('total-return');
    expect(result.assumptions.anchorDate).toBe('2024-01-01');
  });

  it('records missing dates as gaps and never interpolates', () => {
    const result = benchmarkRelativeTimeline({
      portfolioIndex: [
        { date: '2024-01-01', indexValue: 100 },
        { date: '2024-02-01', indexValue: 110 },
        { date: '2024-03-01', indexValue: 121 },
      ],
      benchmarkReturns: [{ date: '2024-03-01', simpleReturn: 0.05 }],
      benchmarkBasis: 'total-return',
    });
    // 2024-02-01 has no benchmark return: no row, a gap, no interpolation.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.date).toBe('2024-03-01');
    expect(result.diagnostics.gaps).toHaveLength(1);
    expect(result.diagnostics.gaps[0]!.fromDate).toBe('2024-02-01');
    expect(result.diagnostics.gaps[0]!.reason).toContain('never interpolated');
  });

  it('compounds benchmark observations on non-portfolio dates into the next aligned row', () => {
    // The 2024-01-15 benchmark observation is real growth: it has no row of its own (gap), but
    // compounds into 2024-02-01's cumulative: 1.01 · 1.05 − 1 = 0.0605.
    const result = benchmarkRelativeTimeline({
      portfolioIndex: [
        { date: '2024-01-01', indexValue: 100 },
        { date: '2024-02-01', indexValue: 110 },
      ],
      benchmarkReturns: [
        { date: '2024-01-15', simpleReturn: 0.01 },
        { date: '2024-02-01', simpleReturn: 0.05 },
      ],
      benchmarkBasis: 'total-return',
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.benchmarkCumulativeReturn).toBeCloseTo(1.01 * 1.05 - 1, 12);
    expect(result.diagnostics.gaps).toHaveLength(1);
    expect(result.diagnostics.gaps[0]!.fromDate).toBe('2024-01-15');
  });

  it('REQUIRES the benchmark basis and flags the price-return caveat', () => {
    const portfolioIndex = [
      { date: '2024-01-01', indexValue: 100 },
      { date: '2024-02-01', indexValue: 110 },
    ];
    const benchmarkReturns = [{ date: '2024-02-01', simpleReturn: 0.05 }];
    expect(() =>
      // @ts-expect-error — the spec says benchmarks state their basis.
      benchmarkRelativeTimeline({ portfolioIndex, benchmarkReturns }),
    ).toThrow(/benchmarkBasis/);
    const priceReturn = benchmarkRelativeTimeline({
      portfolioIndex,
      benchmarkReturns,
      benchmarkBasis: 'price-return',
    });
    expect(
      priceReturn.diagnostics.warnings.some((warning) => warning.includes('price-return')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// contributionByGroup
// ---------------------------------------------------------------------------------------------------

describe('contributionByGroup', () => {
  it('LAW (e): single-period contributions reconcile to the weighted total within 1e-12', () => {
    // 0.6·0.10 = 0.06 and 0.4·(−0.05) = −0.02 → total 0.04.
    const result = contributionByGroup({
      groupReturns: [
        { groupLabel: 'equities', weight: 0.6, simpleReturn: 0.1 },
        { groupLabel: 'bonds', weight: 0.4, simpleReturn: -0.05 },
      ],
    });
    expect(result.contributions[0]!.contribution).toBeCloseTo(0.06, 12);
    expect(result.contributions[1]!.contribution).toBeCloseTo(-0.02, 12);
    expect(result.totalReturn).toBeCloseTo(0.04, 12);
    const contributionSum = result.contributions.reduce((sum, row) => sum + row.contribution, 0);
    expect(Math.abs(contributionSum - result.totalReturn)).toBeLessThan(1e-12);
    expect(Math.abs(result.diagnostics.reconciliationResidual)).toBeLessThan(1e-12);
    expect(result.diagnostics.weightSum).toBeCloseTo(1, 12);
    expect(result.diagnostics.warnings).toHaveLength(0);
    expect(result.assumptions.scope).toBe('single-period');
  });

  it('reconciles for many groups with messy weights (and discloses the weight sum)', () => {
    const groupReturns = Array.from({ length: 40 }, (_, index) => ({
      groupLabel: `group-${index}`,
      weight: 0.017 * (index + 1) * (index % 2 === 0 ? 1 : -0.4),
      simpleReturn: 0.003 * (index - 19),
    }));
    const result = contributionByGroup({ groupReturns });
    const contributionSum = result.contributions.reduce((sum, row) => sum + row.contribution, 0);
    expect(Math.abs(contributionSum - result.totalReturn)).toBeLessThan(1e-12);
    expect(result.diagnostics.warnings.some((warning) => warning.includes('not 1'))).toBe(true);
    expect(result.diagnostics.groupCount).toBe(40);
  });

  it('teaches its closed request', () => {
    expect(() => contributionByGroup({ groupReturns: [] })).toThrow(/must not be empty/);
    expect(() =>
      contributionByGroup({
        // @ts-expect-error — groupLabel is required and non-empty.
        groupReturns: [{ weight: 0.5, simpleReturn: 0.1 }],
      }),
    ).toThrow(/groupLabel/);
  });
});
