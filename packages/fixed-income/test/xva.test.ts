/**
 * Tests for §14.4 CVA/DVA/FVA. The Hull-White exposure simulator is validated by its martingale check
 * (the stochastic discount factor reprices a zero-coupon bond), then CVA's structural properties:
 * exact `(1 − R)` scaling, notional linearity, monotonicity in counterparty spread and rate vol, the
 * humped exposure profile, and DVA/FVA wiring.
 */

import { describe, expect, it } from 'vitest';
import {
  credit,
  curves,
  swapXva,
  type XvaParameters,
  type XvaSwapSpecification,
} from '@totalfinance/fixed-income';

const ref = '2026-01-01';
const curve = curves.fromZeroRates(
  [
    ['2027-01-01', 0.03],
    ['2029-01-01', 0.035],
    ['2032-01-01', 0.04],
  ],
  { referenceDate: ref },
);

const swap: XvaSwapSpecification = {
  curve,
  startDate: ref,
  maturityDate: '2031-01-01',
  fixedRate: 0.037,
  optionType: 'payer',
  notional: 1_000_000,
  fixedFrequency: 'semiannual',
};

const cpSurvival = credit.flatHazard({ hazardRate: 0.03, referenceDate: ref }); // ~300bp counterparty hazard
const baseParams: XvaParameters = {
  meanReversion: 0.05,
  sigma: 0.01,
  counterpartySurvival: cpSurvival,
  recovery: 0.4,
  seed: 11,
  paths: 4000,
  stepsPerYear: 12,
};

describe('swapXva (CVA/DVA/FVA)', () => {
  it('the simulator reprices a zero-coupon bond (martingale check)', () => {
    const r = swapXva(swap, baseParams);
    expect(r.diagnostics.repricingError).toBeLessThan(2e-3); // E[B(0,t)·P(t,T)] ≈ P(0,T)
  });

  it('CVA is positive with a humped exposure profile and a finite PFE', () => {
    const r = swapXva(swap, baseParams);
    expect(r.cva).toBeGreaterThan(0);
    const epes = r.exposure.map((e) => e.epe);
    const peak = Math.max(...epes);
    expect(peak).toBeGreaterThan(epes[0]!); // exposure builds then decays toward maturity
    expect(peak).toBeGreaterThan(epes[epes.length - 1]!);
    expect(r.exposure.every((e) => e.pfe95 >= 0 && Number.isFinite(e.pfe95))).toBe(true);
  });

  it('scales exactly with (1 − recovery)', () => {
    const r0 = swapXva(swap, { ...baseParams, recovery: 0 }).cva;
    const r50 = swapXva(swap, { ...baseParams, recovery: 0.5 }).cva;
    expect(r0 / r50).toBeCloseTo(1 / 0.5, 6); // CVA ∝ (1 − R)
  });

  it('is linear in notional', () => {
    const small = swapXva({ ...swap, notional: 1_000_000 }, baseParams).cva;
    const big = swapXva({ ...swap, notional: 3_000_000 }, baseParams).cva;
    expect(big).toBeCloseTo(3 * small, 6);
  });

  it('rises with the counterparty hazard and with rate volatility', () => {
    const safeCp = swapXva(swap, {
      ...baseParams,
      counterpartySurvival: credit.flatHazard({ hazardRate: 0.005, referenceDate: ref }),
    }).cva;
    const riskyCp = swapXva(swap, {
      ...baseParams,
      counterpartySurvival: credit.flatHazard({ hazardRate: 0.06, referenceDate: ref }),
    }).cva;
    expect(riskyCp).toBeGreaterThan(safeCp);

    const lowVolatility = swapXva(swap, { ...baseParams, sigma: 0.005 }).cva;
    const highVolatility = swapXva(swap, { ...baseParams, sigma: 0.02 }).cva;
    expect(highVolatility).toBeGreaterThan(lowVolatility);
  });

  it('reports DVA when an own-survival curve is supplied, and FVA from a funding spread', () => {
    const r = swapXva(swap, {
      ...baseParams,
      ownSurvival: credit.flatHazard({ hazardRate: 0.02, referenceDate: ref }),
      fundingSpread: 0.005,
    });
    expect(r.dva).toBeGreaterThan(0);
    expect(r.fva).toBeGreaterThan(0);
    expect(r.bilateralCva).toBeCloseTo(r.cva - r.dva, 12);
  });

  it('is deterministic given the seed and validates inputs', () => {
    expect(swapXva(swap, baseParams).cva).toBe(swapXva(swap, baseParams).cva);
    expect(() => swapXva(swap, { ...baseParams, recovery: 1.1 })).toThrow(/recovery/);
    expect(() => swapXva(swap, { ...baseParams, seed: NaN })).toThrow(/seed/);
    // A fractional seed cannot be a reproducible PRNG seed (external-review honesty gap).
    expect(() => swapXva(swap, { ...baseParams, seed: 11.5 })).toThrow(/seed must be an integer/);
  });
});

describe('swapXva curve/survival hardening (deep-sweep boundary)', () => {
  it('names a missing or raw specification.curve instead of dying inside the simulator', () => {
    const { curve: _dropped, ...withoutCurve } = swap;
    expect(() => swapXva(withoutCurve as never, baseParams)).toThrow(
      /swapXva: specification\.curve must be a yield curve/,
    );
    expect(() => swapXva({ ...swap, curve: {} as never }, baseParams)).toThrow(
      /swapXva: specification\.curve must be a yield curve/,
    );
  });

  it('names a missing or raw survival curve in parameters', () => {
    const { counterpartySurvival: _dropped, ...withoutSurvival } = baseParams;
    expect(() => swapXva(swap, withoutSurvival as never)).toThrow(
      /swapXva: parameters\.counterpartySurvival must be a survival curve/,
    );
    expect(() => swapXva(swap, { ...baseParams, ownSurvival: { pillars: [] } as never })).toThrow(
      /swapXva: parameters\.ownSurvival must be a survival curve/,
    );
  });
});
