/**
 * WS-2.7 — the `.explain()` facades on the bond analytics surface. Every scalar/rich facade
 * (`yieldToMaturity`, `priceFromYield`, `yieldMetrics`, `curveMetrics`) pairs its plain call with
 * an envelope-returning `.explain()` built on core `facade`/`seriesFacade` plumbing:
 *
 *   - the envelope satisfies `isComputed` (value + assumptions.conventionsVersion +
 *     diagnostics.warnings) so the WS-7.2 conformance sweep can assert it;
 *   - assumptions echo the conventions actually applied (dayCount, frequency, compounding,
 *     settlementDate, businessDayConvention);
 *   - YTM is a root-find, so its diagnostics disclose the solver honestly
 *     (method 'brent', converged, iterations);
 *   - the PLAIN calls are behaviorally unchanged (same golden values as before the facades), and
 *     the rich results additionally carry a `diagnostics` key per R2.
 */

import { describe, expect, it } from 'vitest';
import { InputError, isComputed } from '@totalfinance/core';
import {
  bonds,
  curveMetrics,
  curves,
  priceFromYield,
  priceMultiCurve,
  yieldMetrics,
  yieldToMaturity,
} from '@totalfinance/fixed-income';

const bond = bonds.fixedRate({
  issueDate: '2026-01-01',
  maturityDate: '2031-01-01',
  couponRate: 0.05,
  frequency: 'semiannual',
  faceValue: 100,
  dayCount: '30/360',
});
const settlementDate = '2026-01-01';

const curve = curves.fromZeroRates(
  [
    ['2027-01-01', 0.035],
    ['2029-01-01', 0.04],
    ['2031-01-01', 0.043],
  ],
  { referenceDate: '2026-01-01' },
);

describe('WS-2.7 — yieldToMaturity facade', () => {
  const price = priceFromYield(bond, { settlementDate, yield: 0.037 }).cleanPrice;

  it('plain call is unchanged: bare number, same golden round-trip', () => {
    const y = yieldToMaturity(bond, { settlementDate, price });
    expect(typeof y).toBe('number');
    expect(y).toBeCloseTo(0.037, 8);
  });

  it('.explain() returns an isComputed envelope with the same value', () => {
    const env = yieldToMaturity.explain(bond, { settlementDate, price });
    expect(isComputed(env)).toBe(true);
    expect(env.value).toBeCloseTo(0.037, 8);
    expect(env.value).toBe(yieldToMaturity(bond, { settlementDate, price }));
  });

  it('.explain() echoes the applied conventions', () => {
    const env = yieldToMaturity.explain(bond, { settlementDate, price });
    expect(env.assumptions.dayCount).toBe('30/360');
    expect(env.assumptions.compounding).toBe('actuarial');
    expect(env.assumptions.frequency).toBe(2);
    expect(env.assumptions.settlementDate).toBe(settlementDate);
    expect(env.assumptions.businessDayConvention).toBe('modifiedFollowing');
    expect(typeof env.assumptions.conventionsVersion).toBe('string');
  });

  it('.explain() discloses the root-find honestly: brent, converged, iterations', () => {
    const env = yieldToMaturity.explain(bond, { settlementDate, price });
    expect(env.diagnostics.method).toBe('brent');
    expect(env.diagnostics.converged).toBe(true);
    expect(typeof env.diagnostics.iterations).toBe('number');
    expect(env.diagnostics.iterations!).toBeGreaterThan(0);
    expect(env.diagnostics.warnings).toEqual([]);
  });

  it('garbage first argument throws a typed teaching error on both paths', () => {
    expect(() => yieldToMaturity(undefined as never, { settlementDate, price })).toThrow(
      InputError,
    );
    expect(() => yieldToMaturity.explain('bond' as never, { settlementDate, price })).toThrow(
      InputError,
    );
  });
});

describe('WS-2.7 — priceFromYield facade', () => {
  it('plain call is unchanged (rich result) and now carries a diagnostics key per R2', () => {
    const res = priceFromYield(bond, { settlementDate, yield: 0.05 });
    expect(res.cleanPrice).toBeCloseTo(100, 8); // golden: par when yield = coupon
    expect(res.assumptions.compounding).toBe('actuarial');
    expect(res.diagnostics.warnings).toEqual([]);
    expect(res.diagnostics.method).toBe('closed-form');
  });

  it('.explain() wraps the same rich result in an isComputed envelope', () => {
    const env = priceFromYield.explain(bond, { settlementDate, yield: 0.05 });
    expect(isComputed(env)).toBe(true);
    expect(env.value.cleanPrice).toBeCloseTo(100, 8);
    expect(env.value.dirtyPrice).toBe(env.value.cleanPrice + env.value.accruedInterest);
    expect(env.assumptions.dayCount).toBe('30/360');
    expect(env.assumptions.compounding).toBe('actuarial');
    expect(env.assumptions.frequency).toBe(2);
    expect(env.assumptions.settlementDate).toBe(settlementDate);
    expect(env.diagnostics.warnings).toEqual([]);
  });
});

describe('WS-2.7 — yieldMetrics facade', () => {
  it('plain call is unchanged (golden duration identities) and carries diagnostics', () => {
    const m = yieldMetrics(bond, { settlementDate, yield: 0.05 });
    expect(m.modifiedDuration).toBeCloseTo(m.macaulayDuration / (1 + 0.05 / 2), 10);
    expect(m.pv01).toBe(m.dv01);
    expect(m.diagnostics.warnings).toEqual([]);
    expect(m.diagnostics.method).toBe('closed-form');
  });

  it('.explain() returns the isComputed envelope with the conventions echo', () => {
    const env = yieldMetrics.explain(bond, { settlementDate, yield: 0.05 });
    expect(isComputed(env)).toBe(true);
    expect(env.value.macaulayDuration).toBeGreaterThan(0);
    expect(env.value.convexity).toBeGreaterThan(0);
    expect(env.assumptions.dayCount).toBe('30/360');
    expect(env.assumptions.compounding).toBe('actuarial');
    expect(env.assumptions.frequency).toBe(2);
    expect(env.assumptions.settlementDate).toBe(settlementDate);
    expect(env.value).toEqual(yieldMetrics(bond, { settlementDate, yield: 0.05 }));
  });
});

describe('WS-2.7 — curveMetrics facade', () => {
  it('plain call is unchanged (KRD sum ≈ effective duration) and carries diagnostics', () => {
    const m = curveMetrics(bond, curve, { settlementDate });
    const krdSum = m.keyRateDurations.reduce((s, k) => s + k.duration, 0);
    expect(krdSum).toBeCloseTo(m.effectiveDuration, 4);
    expect(m.diagnostics.warnings).toEqual([]);
    expect(m.diagnostics.method).toBe('finite-difference');
  });

  it('.explain() returns the isComputed envelope with compounding: curve', () => {
    const env = curveMetrics.explain(bond, curve, { settlementDate });
    expect(isComputed(env)).toBe(true);
    expect(env.assumptions.compounding).toBe('curve');
    expect(env.assumptions.dayCount).toBe('30/360');
    expect(env.assumptions.settlementDate).toBe(settlementDate);
    expect(env.value.effectiveDuration).toBeCloseTo(
      curveMetrics(bond, curve, { settlementDate }).effectiveDuration,
      12,
    );
    expect(env.diagnostics.warnings).toEqual([]);
  });

  it('garbage first argument throws a typed error on both paths (3-arg facade)', () => {
    expect(() => curveMetrics(42 as never, curve, { settlementDate })).toThrow(InputError);
    expect(() => curveMetrics.explain(42 as never, curve, { settlementDate })).toThrow(InputError);
  });
});

describe('WS-2.7 — priceMultiCurve rich result conforms to R2', () => {
  it('carries assumptions AND diagnostics keys', () => {
    const res = priceMultiCurve(bond, { settlementDate, discountCurve: curve });
    expect(res.assumptions.compounding).toBe('curve');
    expect(res.diagnostics.warnings).toEqual([]);
  });
});
