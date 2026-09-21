/**
 * WS2 honesty & echo audit for @totalfinance/fixed-income.
 *
 * WS2.2 — bond pricing/metrics results echo the conventions actually applied (day count,
 * compounding, frequency, settlement, business-day convention), and a serialized result is
 * self-interpreting. WS2.1 — the XVA simulator echoes its PRNG seed, path count, and grid.
 */

import { describe, expect, it } from 'vitest';
import {
  bonds,
  credit,
  curveMetrics,
  curves,
  priceFromYield,
  priceMultiCurve,
  swapXva,
  yieldMetrics,
  type XvaParameters,
  type XvaSwapSpecification,
} from '@totalfinance/fixed-income';

describe('WS2.2 — bond results echo their conventions', () => {
  const bond = bonds.fixedRate({
    issueDate: '2024-01-01',
    maturityDate: '2029-01-01',
    couponRate: 0.05,
    frequency: 'semiannual',
    dayCount: 'ACT/ACT',
  });
  const settlementDate = '2024-07-01';

  it('priceFromYield echoes actuarial conventions and JSON round-trips', () => {
    const res = priceFromYield(bond, { settlementDate, yield: 0.05 });
    // The serialized payload alone must be interpretable — no field lives only in a doc comment.
    const rt = JSON.parse(JSON.stringify(res)) as typeof res;
    expect(rt.assumptions.dayCount).toBe('ACT/ACT');
    expect(rt.assumptions.compounding).toBe('actuarial');
    expect(rt.assumptions.frequency).toBe(2);
    expect(rt.assumptions.settlementDate).toBe(settlementDate);
    expect(rt.assumptions.businessDayConvention).toBe('modifiedFollowing');
    expect(typeof rt.assumptions.conventionsVersion).toBe('string');
    // value fields unchanged.
    expect(rt.dirtyPrice).toBeGreaterThan(0);
    expect(rt.cleanPrice).toBe(rt.dirtyPrice - rt.accruedInterest);
  });

  it('yieldMetrics echoes actuarial conventions', () => {
    const m = yieldMetrics(bond, { settlementDate, yield: 0.05 });
    expect(m.assumptions.compounding).toBe('actuarial');
    expect(m.assumptions.dayCount).toBe('ACT/ACT');
    expect(m.assumptions.frequency).toBe(2);
    expect(m.assumptions.settlementDate).toBe(settlementDate);
  });

  it('curve-based results echo compounding: curve', () => {
    const curve = curves.fromZeroRates(
      [
        ['2025-01-01', 0.035],
        ['2027-01-01', 0.04],
        ['2029-01-01', 0.043],
      ],
      { referenceDate: '2024-01-01' },
    );
    const cm = curveMetrics(bond, curve, { settlementDate });
    expect(cm.assumptions.compounding).toBe('curve');
    expect(cm.assumptions.dayCount).toBe('ACT/ACT');

    const pmc = priceMultiCurve(bond, { settlementDate, discountCurve: curve });
    expect(pmc.assumptions.compounding).toBe('curve');
    expect(pmc.assumptions.settlementDate).toBe(settlementDate);
  });

  it('the echoed business-day convention follows the schedule spec', () => {
    const following = bonds.fixedRate({
      issueDate: '2024-01-01',
      maturityDate: '2029-01-01',
      couponRate: 0.05,
      frequency: 'semiannual',
      dayCount: '30/360',
      convention: 'following',
    });
    const res = priceFromYield(following, { settlementDate, yield: 0.05 });
    expect(res.assumptions.businessDayConvention).toBe('following');
  });
});

describe('WS2.1 — XVA echoes its stochastic settings', () => {
  const ref = '2026-01-01';
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.035],
      ['2032-01-01', 0.04],
    ],
    { referenceDate: ref },
  );
  const specification: XvaSwapSpecification = {
    curve,
    startDate: ref,
    maturityDate: '2031-01-01',
    fixedRate: 0.037,
    optionType: 'payer',
    notional: 1_000_000,
    fixedFrequency: 'semiannual',
  };
  const parameters: XvaParameters = {
    meanReversion: 0.05,
    sigma: 0.01,
    counterpartySurvival: credit.flatHazard({ hazardRate: 0.03, referenceDate: ref }),
    recovery: 0.4,
    seed: 20260101,
    paths: 2000,
    stepsPerYear: 12,
  };

  it('echoes seed, paths, and stepsPerYear', () => {
    const res = swapXva(specification, parameters);
    expect(res.assumptions.seed).toBe(20260101);
    expect(res.assumptions.paths).toBe(2000);
    expect(res.assumptions.stepsPerYear).toBe(12);
  });

  it('is reproducible: same seed → deep-equal result', () => {
    const a = swapXva(specification, parameters);
    const b = swapXva(specification, parameters);
    expect(b).toEqual(a);
  });

  it('defaults paths (5000) and stepsPerYear (24) are echoed honestly', () => {
    const res = swapXva(specification, {
      meanReversion: 0.05,
      sigma: 0.01,
      counterpartySurvival: credit.flatHazard({ hazardRate: 0.03, referenceDate: ref }),
      recovery: 0.4,
      seed: 20260101,
    });
    expect(res.assumptions.paths).toBe(5000);
    expect(res.assumptions.stepsPerYear).toBe(24);
  });
});
