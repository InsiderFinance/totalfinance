/**
 * Stage 4.5 slice 2 — the live-curve ↔ core RateCurve mappers:
 *
 * - `yieldCurveFromRateCurve` IS the bond pricer's former private builder: the pricer prices to the
 *   same value through it, with its own protocol taxonomy preserved;
 * - `rateCurveFromYieldCurve` emits valid core data (proven by core's one validator) that
 *   round-trips through `yieldCurveFromRateCurve` to an equal curve at and between pillars;
 * - the conventions are explicit: UTC-midnight asOf, continuous zeros, the three core day counts.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError, requireRateCurveData, type RateCurve } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  bonds,
  curves,
  priceMultiCurve,
  rateCurveFromYieldCurve,
  yieldCurveFromRateCurve,
} from '@totalfinance/fixed-income';
import { bondDiscountCurvePricer } from '@totalfinance/fixed-income/pricer';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

const observed: RateCurve = {
  currency: 'USD',
  asOf: Date.UTC(2026, 0, 1),
  dayCount: 'ACT/365F',
  compounding: 'continuous',
  interpolation: 'logLinearDiscount',
  points: [
    { date: '2026-01-01', zeroRate: 0.04 },
    { date: '2027-01-01', zeroRate: 0.042 },
    { date: '2029-01-01', zeroRate: 0.045 },
    { date: '2032-01-01', zeroRate: 0.047 },
  ],
};

describe('yieldCurveFromRateCurve', () => {
  it('builds the live curve the pricer builds, so the pricer prices to the same value through it', () => {
    const curve = yieldCurveFromRateCurve({
      curve: observed,
      interpolation: 'logLinearDiscount',
      extrapolation: 'flatForward',
    });
    expect(curve.referenceDate).toBe('2026-01-01');
    expect(curve.discount('2027-01-01')).toBeCloseTo(Math.exp(-0.042), 12);
    const bond = bonds.fixedRate({
      issueDate: '2025-01-01',
      maturityDate: '2031-01-01',
      couponRate: 0.05,
      frequency: 'semiannual',
      faceValue: 100,
      dayCount: '30/360',
    });
    const direct = priceMultiCurve(bond, { settlementDate: '2026-06-15', discountCurve: curve });
    const pricer = bondDiscountCurvePricer({
      curveId: 'USD.treasury',
      currency: 'USD',
      priceType: 'clean',
      interpolation: 'logLinearDiscount',
      extrapolation: 'flatForward',
    });
    const priced = pricer.price({
      instrument: bond,
      observations: [
        { requirement: { kind: 'valuationInstant' }, value: Date.UTC(2026, 5, 15, 13, 45) },
        {
          requirement: { kind: 'discountCurve', curveId: 'USD.treasury', currency: 'USD' },
          value: observed,
        },
      ],
    });
    expect(priced.value).toBe(direct.cleanPrice);
  });

  it('keeps the conventions explicit: UTC midnight, matching interpolation, closed request', () => {
    expect(() =>
      yieldCurveFromRateCurve({
        curve: { ...observed, asOf: observed.asOf + 1, points: observed.points.slice(1) },
        interpolation: 'logLinearDiscount',
        extrapolation: 'flatForward',
      }),
    ).toThrow(/UTC midnight/);
    expect(
      codeOf(() =>
        yieldCurveFromRateCurve({
          curve: observed,
          interpolation: 'linearZero',
          extrapolation: 'flatForward',
        }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        yieldCurveFromRateCurve({
          curve: observed,
          interpolation: 'spline',
          extrapolation: 'flatForward',
        } as never),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        yieldCurveFromRateCurve({
          curve: { ...observed, dayCount: 'ACT/ACT' } as never,
          interpolation: 'logLinearDiscount',
          extrapolation: 'flatForward',
        }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        yieldCurveFromRateCurve({
          curve: observed,
          interpolation: 'logLinearDiscount',
          extrapolation: 'flatForward',
          bogus: 1,
        } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    // The pricer keeps its own taxonomy over the same law.
    const pricer = bondDiscountCurvePricer({
      curveId: 'USD.treasury',
      currency: 'USD',
      priceType: 'clean',
      interpolation: 'logLinearDiscount',
      extrapolation: 'flatForward',
    });
    try {
      pricer.price({
        instrument: bonds.zeroCoupon({
          issueDate: '2025-01-01',
          maturityDate: '2031-01-01',
          faceValue: 100,
        }),
        observations: [
          { requirement: { kind: 'valuationInstant' }, value: Date.UTC(2026, 5, 15) },
          {
            requirement: { kind: 'discountCurve', curveId: 'USD.treasury', currency: 'USD' },
            value: { ...observed, interpolation: 'linearZero' },
          },
        ],
      });
      expect.unreachable('a conflicting stored interpolation must refuse');
    } catch (error) {
      expect(isQuantError(error, ErrorCode.PricerObservationInvalid)).toBe(true);
      expect((error as Error).message).toMatch(/interpolation.*conflicts/);
    }
  });
});

describe('rateCurveFromYieldCurve', () => {
  const live = curves.fromDiscountFactors(
    [
      ['2026-01-01', 1],
      ['2026-07-01', 0.98],
      ['2027-01-01', 0.958],
      ['2029-01-01', 0.87],
    ],
    {
      referenceDate: '2026-01-01',
      dayCount: 'ACT/360',
      interpolation: 'linearZero',
      extrapolation: 'flatZero',
    },
  );

  it('emits valid core data (every pillar, continuous zeros, the interpolation echoed) that round-trips', () => {
    const data = rateCurveFromYieldCurve({ curve: live, currency: 'USD' });
    expect(data).toEqual({
      currency: 'USD',
      asOf: Date.UTC(2026, 0, 1),
      dayCount: 'ACT/360',
      compounding: 'continuous',
      interpolation: 'linearZero',
      points: live.pillars.map((pillar) => ({ date: pillar.date, zeroRate: pillar.zero })),
    });
    expect(requireRateCurveData('test', 'data', data)).toBe(data);
    const rebuilt = yieldCurveFromRateCurve({
      curve: data,
      interpolation: 'linearZero',
      extrapolation: 'flatZero',
    });
    for (const at of [
      '2026-01-01',
      '2026-04-15',
      '2026-07-01',
      '2027-01-01',
      '2028-03-03',
      '2029-01-01',
    ]) {
      expect(rebuilt.discount(at)).toBeCloseTo(live.discount(at), 12);
      expect(rebuilt.zeroRate(at)).toBeCloseTo(live.zeroRate(at), 12);
    }
    // The bridge: mapped data drops into a market snapshot as-is.
    const snapshot = createMarketSnapshot({
      asOf: Date.UTC(2026, 0, 1),
      observations: { curves: { 'USD.ois': data } },
    });
    expect(snapshot.observations.curves?.['USD.ois']).toEqual(data);
  });

  it('refuses raw pillar data, a missing currency, and a day count core cannot state', () => {
    expect(
      codeOf(() => rateCurveFromYieldCurve({ curve: live.pillars as never, currency: 'USD' })),
    ).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => rateCurveFromYieldCurve({ curve: live, currency: '' }))).toBe(
      ErrorCode.InputWrongType,
    );
    // A half-object is not a built curve: every declared method and convention must be present.
    const { addSpread: _dropped, ...withoutMethod } = live;
    expect(
      codeOf(() => rateCurveFromYieldCurve({ curve: withoutMethod as never, currency: 'USD' })),
    ).toBe(ErrorCode.InputWrongType);
    expect(() =>
      rateCurveFromYieldCurve({ curve: { ...live, discount: null } as never, currency: 'USD' }),
    ).toThrow(/input\.curve\.discount is null, not a method/);
    expect(
      codeOf(() =>
        rateCurveFromYieldCurve({ curve: { ...live, pillars: [] } as never, currency: 'USD' }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        rateCurveFromYieldCurve({
          curve: { ...live, interpolation: 'spline' } as never,
          currency: 'USD',
        }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(codeOf(() => rateCurveFromYieldCurve({ curve: live } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    const actAct = curves.fromZeroRates(
      [
        ['2026-01-01', 0.04],
        ['2027-01-01', 0.042],
      ],
      {
        referenceDate: '2026-01-01',
        dayCount: 'ACT/ACT',
      },
    );
    expect(() => rateCurveFromYieldCurve({ curve: actAct, currency: 'USD' })).toThrow(
      /ACT\/ACT.*cannot be stated by core's RateCurve/,
    );
    expect(codeOf(() => rateCurveFromYieldCurve({ curve: actAct, currency: 'USD' }))).toBe(
      ErrorCode.InputInvalidEnum,
    );
  });
});
