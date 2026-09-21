/**
 * §14.5 cross-currency basis: covered-interest-parity FX forwards and the domestic-collateralized foreign
 * discount curve (`crossCurrencyBasisCurve`), plus the inverse that implies the basis from market forwards
 * (`impliedCrossCurrencyBasis`). FX convention: domestic units per 1 foreign unit (USD per EUR).
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  crossCurrencyBasisCurve,
  curves,
  impliedCrossCurrencyBasis,
} from '@totalfinance/fixed-income';

const REF = '2026-01-01';
const MATS = ['2027-01-01', '2029-01-01', '2031-01-01'];
const SPOT = 1.08; // USD per EUR

const domestic = curves.fromZeroRates(
  MATS.map((m, i) => [m, 0.04 + 0.002 * i] as [string, number]),
  { referenceDate: REF },
);
const foreign = curves.fromZeroRates(
  MATS.map((m, i) => [m, 0.025 + 0.001 * i] as [string, number]),
  { referenceDate: REF },
);

describe('crossCurrencyBasisCurve', () => {
  it('no basis: covered interest parity F = spot · D_for/D_dom, collateralized curve == foreign', () => {
    const x = crossCurrencyBasisCurve({ spot: SPOT, domestic, foreign });
    for (const m of MATS) {
      expect(x.collateralizedCurve.discount(m)).toBeCloseTo(foreign.discount(m), 12);
      expect(x.fxForward(m)).toBeCloseTo((SPOT * foreign.discount(m)) / domestic.discount(m), 12);
    }
    // Lower foreign rates ⇒ the foreign currency is at a forward premium (USD per EUR rises).
    expect(x.fxForward('2031-01-01')).toBeGreaterThan(SPOT);
  });

  it('with a positive basis: the collateralized curve = foreign + basis, and forwards fall', () => {
    const basis = curves.flat({ rate: 0.003, referenceDate: REF }); // +30bp EUR xccy basis
    const noBasis = crossCurrencyBasisCurve({ spot: SPOT, domestic, foreign });
    const withBasis = crossCurrencyBasisCurve({ spot: SPOT, domestic, foreign, basis });
    for (const m of MATS) {
      expect(withBasis.collateralizedCurve.zeroRate(m)).toBeCloseTo(
        foreign.zeroRate(m) + 0.003,
        10,
      );
      // A higher foreign discount rate ⇒ a lower USD-per-EUR forward.
      expect(withBasis.fxForward(m)).toBeLessThan(noBasis.fxForward(m));
      // Consistency: D_for^dom(t) = F(t)·D_dom(t)/spot.
      expect((withBasis.fxForward(m) * domestic.discount(m)) / SPOT).toBeCloseTo(
        withBasis.collateralizedCurve.discount(m),
        12,
      );
    }
    expect(withBasis.assumptions['discounting']).toBe('domestic-collateralized');
  });

  it('validates curves, reference-date agreement, and Law-12 unknown keys', () => {
    expect(() => crossCurrencyBasisCurve({ spot: SPOT, domestic, foreign: {} as never })).toThrow(
      /foreign must be a yield curve/,
    );
    const other = curves.flat({ rate: 0.02, referenceDate: '2026-06-01' }); // different reference date
    expect(() => crossCurrencyBasisCurve({ spot: SPOT, domestic, foreign: other })).toThrow(
      /referenceDate/,
    );
    expect(() =>
      crossCurrencyBasisCurve({ spot: SPOT, domestic, foreign, bogus: 1 } as never),
    ).toThrow();
    expect(() => crossCurrencyBasisCurve({ spot: -1, domestic, foreign })).toThrow(/spot/);
  });
});

describe('impliedCrossCurrencyBasis (the inverse)', () => {
  it('recovers a known basis from the FX forwards it generates', () => {
    const basis = curves.flat({ rate: 0.004, referenceDate: REF }); // +40bp
    const x = crossCurrencyBasisCurve({ spot: SPOT, domestic, foreign, basis });
    const forwards = MATS.map((m) => [m, x.fxForward(m)] as [string, number]);
    const implied = impliedCrossCurrencyBasis({ spot: SPOT, domestic, foreign, forwards });
    expect(implied.basis.map((b) => b.date)).toEqual(MATS);
    for (const b of implied.basis) expect(b.spread).toBeCloseTo(0.004, 10);
  });

  it('a non-flat basis is recovered pointwise', () => {
    const basis = curves.fromZeroRates(
      [
        ['2027-01-01', 0.002],
        ['2031-01-01', 0.008],
      ],
      { referenceDate: REF },
    );
    const x = crossCurrencyBasisCurve({ spot: SPOT, domestic, foreign, basis });
    const forwards = MATS.map((m) => [m, x.fxForward(m)] as [string, number]);
    const implied = impliedCrossCurrencyBasis({ spot: SPOT, domestic, foreign, forwards });
    for (const b of implied.basis) {
      expect(b.spread).toBeCloseTo(basis.zeroRate(b.date), 10);
    }
  });

  it('rejects non-positive forwards and pre-reference dates (typed)', () => {
    let caught: unknown;
    try {
      impliedCrossCurrencyBasis({
        spot: SPOT,
        domestic,
        foreign,
        forwards: [['2025-06-01', 1.1]],
      });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught)).toBe(true);
    expect(() =>
      impliedCrossCurrencyBasis({ spot: SPOT, domestic, foreign, forwards: [['2028-01-01', -1]] }),
    ).toThrow();
  });
});
