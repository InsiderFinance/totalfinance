/** Gate C discount-curve bond adapter: protocol honesty and no-second-engine parity. */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError, type RateCurve } from '@totalfinance/core';
import {
  requirementKey,
  validatePricer,
  type MarketObservation,
  type PricerProbe,
} from '@totalfinance/core/pricing';
import { bonds, curves, priceMultiCurve, type Bond } from '@totalfinance/fixed-income';
import {
  BOND_DISCOUNT_CURVE_PRICER_NAME,
  BOND_SETTLEMENT_DATE_PROJECTION,
  bondDiscountCurvePricer,
} from '../src/pricer.js';

const CURVE_ID = 'USD.treasury';
const CURVE_AS_OF = Date.UTC(2026, 0, 1);
const VALUATION_INSTANT = Date.UTC(2026, 5, 15, 13, 45);

const observedCurve: RateCurve = {
  currency: 'USD',
  asOf: CURVE_AS_OF,
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

const fixedBond = bonds.fixedRate({
  issueDate: '2025-01-01',
  maturityDate: '2031-01-01',
  couponRate: 0.05,
  frequency: 'semiannual',
  faceValue: 100,
  dayCount: '30/360',
});
const zeroBond = bonds.zeroCoupon({
  issueDate: '2025-01-01',
  maturityDate: '2031-01-01',
  faceValue: 100,
});
const amortizingBond = bonds.amortizing({
  issueDate: '2025-01-01',
  maturityDate: '2031-01-01',
  couponRate: 0.05,
  frequency: 'annual',
  faceValue: 100,
  amortization: { type: 'straight' },
});
const floatingRateBond = bonds.floatingRateNote({
  issueDate: '2025-01-01',
  maturityDate: '2031-01-01',
  couponRate: 0,
  frequency: 'quarterly',
});

function observations(
  curve: RateCurve = observedCurve,
  valuationInstant: number = VALUATION_INSTANT,
  extra: MarketObservation[] = [],
): MarketObservation[] {
  return [
    { requirement: { kind: 'valuationInstant' }, value: valuationInstant },
    {
      requirement: { kind: 'discountCurve', curveId: CURVE_ID, currency: 'USD' },
      value: curve,
    },
    ...extra,
  ];
}

function directCurve(curve: RateCurve = observedCurve) {
  return curves.fromZeroRates(
    curve.points.map((point) => [point.date, point.zeroRate] as const),
    {
      referenceDate: new Date(curve.asOf).toISOString().slice(0, 10),
      dayCount: curve.dayCount,
      compounding: curve.compounding,
      interpolation: 'logLinearDiscount',
      extrapolation: 'flatForward',
    },
  );
}

function adapter(priceType: 'clean' | 'dirty' = 'dirty') {
  return bondDiscountCurvePricer({
    curveId: CURVE_ID,
    currency: 'USD',
    priceType,
    interpolation: 'logLinearDiscount',
    extrapolation: 'flatForward',
  });
}

function expectQuantCode(call: () => unknown, code: string): void {
  try {
    call();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(isQuantError(error, code), error instanceof Error ? error.message : typeof error).toBe(
      true,
    );
  }
}

describe('bondDiscountCurvePricer — requirements and support', () => {
  it('declares exactly valuationInstant and its named discount curve', () => {
    expect(adapter().requirements(fixedBond).map(requirementKey)).toEqual([
      'valuationInstant',
      `discountCurve(curveId=${CURVE_ID}, currency=USD)`,
    ]);
  });

  it('supports fixed-rate, zero-coupon, and fixed-amortizing bonds only', () => {
    const pricer = adapter();
    expect(pricer.supports(fixedBond)).toBe(true);
    expect(pricer.supports(zeroBond)).toBe(true);
    expect(pricer.supports(amortizingBond)).toBe(true);
    expect(pricer.supports(floatingRateBond)).toBe(false);
    expect(() =>
      pricer.price({ instrument: floatingRateBond, observations: observations() }),
    ).toThrow(/forecast|not supported/i);
  });

  it('teaches missing requirements and rejects malformed factory economics', () => {
    expect(() => adapter().price({ instrument: fixedBond, observations: [] })).toThrow(
      /valuationInstant/,
    );
    expect(() =>
      bondDiscountCurvePricer({
        curveId: CURVE_ID,
        currency: 'USD',
        priceType: 'mid' as never,
        interpolation: 'logLinearDiscount',
        extrapolation: 'flatForward',
      }),
    ).toThrow(/priceType/);
    expect(() =>
      bondDiscountCurvePricer({
        curveId: CURVE_ID,
        currency: 'USD',
        priceType: 'dirty',
        interpolation: 'logLinearDiscount',
        extrapolation: 'flatForward',
        curveID: CURVE_ID,
      } as never),
    ).toThrow(/curveID/);
    expect(() =>
      bondDiscountCurvePricer({
        curveId: CURVE_ID,
        currency: 'usd',
        priceType: 'dirty',
        interpolation: 'logLinearDiscount',
        extrapolation: 'flatForward',
      }),
    ).toThrow(/write it as 'USD'/);
  });

  it('validates the complete public request grammar', () => {
    expect(() =>
      adapter().price({
        instrument: fixedBond,
        observations: observations(),
        request: { greeks: 'yes' as never },
      }),
    ).toThrow(/request\.greeks must be a boolean/);
    expect(() =>
      adapter().price({
        instrument: fixedBond,
        observations: observations(),
        request: { seed: -1 },
      }),
    ).toThrow(/non-negative safe integer/);
  });
});

describe('bondDiscountCurvePricer — descriptor-safe public boundaries', () => {
  const validOptions = () => ({
    curveId: CURVE_ID,
    currency: 'USD',
    priceType: 'dirty' as const,
    interpolation: 'logLinearDiscount' as const,
    extrapolation: 'flatForward' as const,
  });

  it('rejects factory accessors, hidden fields, symbols, and coercion hooks without invoking them', () => {
    let calls = 0;
    const accessorOptions = validOptions() as Record<string, unknown>;
    Object.defineProperty(accessorOptions, 'curveId', {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    });
    expectQuantCode(
      () => bondDiscountCurvePricer(accessorOptions as never),
      ErrorCode.InputWrongType,
    );
    expect(calls).toBe(0);

    const hiddenOptions = validOptions();
    Object.defineProperty(hiddenOptions, 'currency', {
      enumerable: false,
      value: 'USD',
    });
    expectQuantCode(
      () => bondDiscountCurvePricer(hiddenOptions as never),
      ErrorCode.InputWrongType,
    );

    const hiddenUnknown = validOptions() as Record<string, unknown>;
    Object.defineProperty(hiddenUnknown, 'curveID', { enumerable: false, value: CURVE_ID });
    expectQuantCode(
      () => bondDiscountCurvePricer(hiddenUnknown as never),
      ErrorCode.InputUnknownField,
    );

    const symbolOptions = validOptions() as Record<PropertyKey, unknown>;
    symbolOptions[Symbol('vendor')] = 1;
    expectQuantCode(
      () => bondDiscountCurvePricer(symbolOptions as never),
      ErrorCode.InputUnknownField,
    );

    const coercible = validOptions() as Record<PropertyKey, unknown>;
    coercible.toString = () => {
      calls += 1;
      throw new Error('must not execute');
    };
    coercible[Symbol.toPrimitive] = () => {
      calls += 1;
      throw new Error('must not execute');
    };
    expectQuantCode(() => bondDiscountCurvePricer(coercible as never), ErrorCode.InputUnknownField);

    const coercibleCurrency = validOptions() as Record<string, unknown>;
    coercibleCurrency['currency'] = {
      toString: () => {
        calls += 1;
        throw new Error('must not execute');
      },
      [Symbol.toPrimitive]: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    };
    expectQuantCode(
      () => bondDiscountCurvePricer(coercibleCurrency as never),
      ErrorCode.InputWrongType,
    );
    expect(calls).toBe(0);
  });

  it('answers supports from stored descriptors without running instrument behavior', () => {
    const pricer = adapter();
    let calls = 0;

    const accessorKind = { ...fixedBond } as Record<string, unknown>;
    Object.defineProperty(accessorKind, 'kind', {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    });
    expect(pricer.supports(accessorKind as never)).toBe(false);

    const hiddenKind = { ...fixedBond } as Record<string, unknown>;
    Object.defineProperty(hiddenKind, 'kind', { enumerable: false, value: 'fixed' });
    expect(pricer.supports(hiddenKind as never)).toBe(false);

    const hostileCoercion = { ...fixedBond } as Record<PropertyKey, unknown>;
    Object.defineProperty(hostileCoercion, 'toString', {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    });
    expect(pricer.supports(hostileCoercion as never)).toBe(false);

    const symbolInstrument = { ...fixedBond } as Record<PropertyKey, unknown>;
    symbolInstrument[Symbol.toPrimitive] = () => {
      calls += 1;
      throw new Error('must not execute');
    };
    expect(pricer.supports(symbolInstrument as never)).toBe(false);
    expect(calls).toBe(0);
  });

  it('rejects accessor-backed and decorated price/request shells without invoking hooks', () => {
    const pricer = adapter();
    let calls = 0;

    const inputAccessor = {
      observations: observations(),
    } as Record<string, unknown>;
    Object.defineProperty(inputAccessor, 'instrument', {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    });
    expectQuantCode(() => pricer.price(inputAccessor as never), ErrorCode.InputWrongType);

    const requestAccessor = {} as Record<string, unknown>;
    Object.defineProperty(requestAccessor, 'seed', {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    });
    expectQuantCode(
      () =>
        pricer.price({
          instrument: fixedBond,
          observations: observations(),
          request: requestAccessor as never,
        }),
      ErrorCode.InputWrongType,
    );

    const hiddenInput = { instrument: fixedBond, observations: observations() };
    Object.defineProperty(hiddenInput, 'request', { enumerable: false, value: {} });
    expectQuantCode(() => pricer.price(hiddenInput), ErrorCode.InputWrongType);

    const symbolInput = {
      instrument: fixedBond,
      observations: observations(),
    } as Record<PropertyKey, unknown>;
    symbolInput[Symbol('input-extension')] = true;
    expectQuantCode(() => pricer.price(symbolInput as never), ErrorCode.InputUnknownField);

    const symbolRequest = {} as Record<PropertyKey, unknown>;
    symbolRequest[Symbol('request-extension')] = true;
    expectQuantCode(
      () =>
        pricer.price({
          instrument: fixedBond,
          observations: observations(),
          request: symbolRequest,
        } as never),
      ErrorCode.InputUnknownField,
    );

    const coercibleRequest = {} as Record<PropertyKey, unknown>;
    coercibleRequest.toString = () => {
      calls += 1;
      throw new Error('must not execute');
    };
    coercibleRequest[Symbol.toPrimitive] = () => {
      calls += 1;
      throw new Error('must not execute');
    };
    expectQuantCode(
      () =>
        pricer.price({
          instrument: fixedBond,
          observations: observations(),
          request: coercibleRequest,
        } as never),
      ErrorCode.InputUnknownField,
    );

    const coercibleSeed = {
      toString: () => {
        calls += 1;
        throw new Error('must not execute');
      },
      [Symbol.toPrimitive]: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    };
    expectQuantCode(
      () =>
        pricer.price({
          instrument: fixedBond,
          observations: observations(),
          request: { seed: coercibleSeed as never },
        }),
      ErrorCode.InputWrongType,
    );
    expect(calls).toBe(0);
  });

  it('snapshots dense observation data without reading accessor-backed slots or fields', () => {
    const pricer = adapter();
    let calls = 0;

    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    });
    expectQuantCode(
      () => pricer.price({ instrument: fixedBond, observations: accessorArray as never }),
      ErrorCode.InputWrongType,
    );

    expectQuantCode(
      () => pricer.price({ instrument: fixedBond, observations: new Array(2) as never }),
      ErrorCode.InputWrongType,
    );

    const accessorObservation = { value: VALUATION_INSTANT } as Record<string, unknown>;
    Object.defineProperty(accessorObservation, 'requirement', {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    });
    expectQuantCode(
      () =>
        pricer.price({
          instrument: fixedBond,
          observations: [accessorObservation] as never,
        }),
      ErrorCode.InputWrongType,
    );

    const accessorCurve = { ...observedCurve } as Record<string, unknown>;
    Object.defineProperty(accessorCurve, 'points', {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error('must not execute');
      },
    });
    expectQuantCode(
      () =>
        pricer.price({
          instrument: fixedBond,
          observations: observations(accessorCurve as never),
        }),
      ErrorCode.InputWrongType,
    );

    const symbolArray = observations() as Array<MarketObservation> & Record<PropertyKey, unknown>;
    symbolArray[Symbol('metadata')] = true;
    expectQuantCode(
      () => pricer.price({ instrument: fixedBond, observations: symbolArray }),
      ErrorCode.InputUnknownField,
    );
    expect(calls).toBe(0);
  });
});

describe('bondDiscountCurvePricer — direct-path parity', () => {
  it.each([
    ['dirty', 'dirtyPrice'],
    ['clean', 'cleanPrice'],
  ] as const)('%s value preserves the complete direct result', (priceType, selectedField) => {
    const settlementDate = '2026-06-15';
    const direct = priceMultiCurve(fixedBond, {
      settlementDate,
      discountCurve: directCurve(),
    });
    const result = adapter(priceType).price({
      instrument: fixedBond,
      observations: observations(),
    });

    expect(Object.is(result.value, direct[selectedField])).toBe(true);
    expect(Object.is(result.dirtyPrice, direct.dirtyPrice)).toBe(true);
    expect(Object.is(result.cleanPrice, direct.cleanPrice)).toBe(true);
    expect(Object.is(result.accruedInterest, direct.accruedInterest)).toBe(true);
    expect(result.diagnostics).toEqual(direct.diagnostics);
    expect(result.assumptions).toMatchObject(direct.assumptions);
    expect(result.assumptions).toMatchObject({
      priceType,
      curveId: CURVE_ID,
      currency: 'USD',
      interpolation: 'logLinearDiscount',
      extrapolation: 'flatForward',
      valuationInstant: VALUATION_INSTANT,
      settlementDate,
      curveReferenceDate: '2026-01-01',
      settlementDateProjection: BOND_SETTLEMENT_DATE_PROJECTION,
    });
  });

  it('revalues through the supplied curve and preserves direct parity after a curve shock', () => {
    const shocked: RateCurve = {
      ...observedCurve,
      points: observedCurve.points.map((point) => ({
        ...point,
        zeroRate: point.zeroRate + 0.01,
      })),
    };
    const base = adapter().price({ instrument: fixedBond, observations: observations() });
    const result = adapter().price({
      instrument: fixedBond,
      observations: observations(shocked),
    });
    const direct = priceMultiCurve(fixedBond, {
      settlementDate: '2026-06-15',
      discountCurve: directCurve(shocked),
    });
    expect(result.value).toBeLessThan(base.value);
    expect(Object.is(result.value, direct.dirtyPrice)).toBe(true);
    expect(result.dirtyPrice).toBe(direct.dirtyPrice);
    expect(result.cleanPrice).toBe(direct.cleanPrice);
    expect(result.accruedInterest).toBe(direct.accruedInterest);
  });

  it('projects every valuation epoch to its containing UTC date and leaves the curve anchor fixed', () => {
    const sameUtcDay = adapter().price({
      instrument: fixedBond,
      observations: observations(observedCurve, Date.UTC(2026, 5, 15, 23, 59, 59, 999)),
    });
    const nextUtcDay = adapter().price({
      instrument: fixedBond,
      observations: observations(observedCurve, Date.UTC(2026, 5, 16)),
    });
    const sameDayDirect = priceMultiCurve(fixedBond, {
      settlementDate: '2026-06-15',
      discountCurve: directCurve(),
    });
    const nextDayDirect = priceMultiCurve(fixedBond, {
      settlementDate: '2026-06-16',
      discountCurve: directCurve(),
    });

    expect(sameUtcDay.value).toBe(sameDayDirect.dirtyPrice);
    expect(nextUtcDay.value).toBe(nextDayDirect.dirtyPrice);
    expect(sameUtcDay.assumptions.settlementDate).toBe('2026-06-15');
    expect(nextUtcDay.assumptions.settlementDate).toBe('2026-06-16');
    expect(nextUtcDay.assumptions.curveReferenceDate).toBe('2026-01-01');
    expect(nextUtcDay.assumptions.valuationInstant).toBe(Date.UTC(2026, 5, 16));
  });

  it('rejects non-midnight curve anchors and contradictory stored interpolation', () => {
    const nonMidnight = {
      ...observedCurve,
      asOf: CURVE_AS_OF + 1,
      points: observedCurve.points.slice(1),
    };
    expect(() =>
      adapter().price({ instrument: fixedBond, observations: observations(nonMidnight) }),
    ).toThrow(/UTC midnight/);

    const contradictory = { ...observedCurve, interpolation: 'linearZero' };
    expect(() =>
      adapter().price({ instrument: fixedBond, observations: observations(contradictory) }),
    ).toThrow(/interpolation.*conflicts/);
  });
});

describe('bondDiscountCurvePricer — Gate C conformance', () => {
  it('passes the behavioral kit with real fixed-income fixtures', () => {
    const probes: PricerProbe<Bond>[] = [
      {
        instrument: fixedBond,
        observations: observations(observedCurve, VALUATION_INSTANT, [
          { requirement: { kind: 'spot', symbol: 'UNDECLARED' }, value: 999 },
        ]),
      },
      { instrument: zeroBond, observations: observations() },
      { instrument: amortizingBond, observations: observations() },
    ];
    const validated = validatePricer(adapter(), probes);
    expect(validated.name).toBe(BOND_DISCOUNT_CURVE_PRICER_NAME);
    expect(validated.capabilities).toEqual({
      greeks: 'none',
      randomness: 'none',
      batch: false,
    });
  });

  it('uses the protocol taxonomy for a mismatched curve currency', () => {
    const eurCurve = { ...observedCurve, currency: 'EUR' };
    try {
      adapter().price({ instrument: fixedBond, observations: observations(eurCurve) });
      expect.unreachable('a USD requirement must not consume an EUR curve');
    } catch (error) {
      expect(isQuantError(error, ErrorCode.PricerObservationInvalid)).toBe(true);
    }
  });
});
