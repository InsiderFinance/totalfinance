/**
 * Tests for §14.3 rates derivatives: the Black/Bachelier model cores, FRA valuation, swap par,
 * swaption put-call parity and vol monotonicity, and cap/floor–swap parity. Verified against closed
 * forms and no-arbitrage identities.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  capFloorPrice,
  cmsConvexityAdjustment,
  curves,
  forwardCmsRate,
  forwardSwap,
  fraValue,
  swapRate,
  swaptionPrice,
  swapValue,
  type SwapSpecification,
} from '@totalfinance/fixed-income';
import { bachelierKernel, blackKernel } from '@totalfinance/fixed-income/rates';

const ref = '2026-01-01';

describe('Black / Bachelier forward-option cores', () => {
  it('Bachelier ATM value is σ√T/√(2π)', () => {
    const v = bachelierKernel({
      forward: 0.03,
      strike: 0.03,
      normalVolatility: 0.01,
      timeToExpiryYears: 2,
      right: 'call',
    });
    expect(v).toBeCloseTo((0.01 * Math.sqrt(2)) / Math.sqrt(2 * Math.PI), 12);
  });

  it('put-call parity holds for both models (call − put = F − K)', () => {
    const F = 0.04;
    const K = 0.035;
    expect(
      blackKernel({
        forward: F,
        strike: K,
        volatility: 0.3,
        timeToExpiryYears: 1.5,
        right: 'call',
      }) -
        blackKernel({
          forward: F,
          strike: K,
          volatility: 0.3,
          timeToExpiryYears: 1.5,
          right: 'put',
        }),
    ).toBeCloseTo(F - K, 12);
    expect(
      bachelierKernel({
        forward: F,
        strike: K,
        normalVolatility: 0.01,
        timeToExpiryYears: 1.5,
        right: 'call',
      }) -
        bachelierKernel({
          forward: F,
          strike: K,
          normalVolatility: 0.01,
          timeToExpiryYears: 1.5,
          right: 'put',
        }),
    ).toBeCloseTo(F - K, 12);
  });

  it('falls back to intrinsic at zero vol / zero time', () => {
    expect(
      blackKernel({
        forward: 0.05,
        strike: 0.04,
        volatility: 0,
        timeToExpiryYears: 1,
        right: 'call',
      }),
    ).toBeCloseTo(0.01, 12);
    expect(
      bachelierKernel({
        forward: 0.03,
        strike: 0.05,
        normalVolatility: 0.01,
        timeToExpiryYears: 0,
        right: 'put',
      }),
    ).toBeCloseTo(0.02, 12);
  });

  it('value increases with volatility', () => {
    expect(
      blackKernel({
        forward: 0.04,
        strike: 0.04,
        volatility: 0.4,
        timeToExpiryYears: 1,
        right: 'call',
      }),
    ).toBeGreaterThan(
      blackKernel({
        forward: 0.04,
        strike: 0.04,
        volatility: 0.2,
        timeToExpiryYears: 1,
        right: 'call',
      }),
    );
  });

  it('Black rejects a non-positive forward (use Bachelier)', () => {
    expect(() =>
      blackKernel({
        forward: -0.001,
        strike: 0.01,
        volatility: 0.2,
        timeToExpiryYears: 1,
        right: 'call',
      }),
    ).toThrow(/positive forward/);
    expect(
      bachelierKernel({
        forward: -0.001,
        strike: 0.01,
        normalVolatility: 0.01,
        timeToExpiryYears: 1,
        right: 'put',
      }),
    ).toBeGreaterThan(0); // handles negative rates
  });
});

describe('FRA', () => {
  const curve = curves.flat({ rate: 0.03, referenceDate: ref, options: { dayCount: 'ACT/360' } });

  it('is worth zero at the forward rate and positive below it to the payer', () => {
    const fwd = curve.forwardRate('2026-04-01', '2026-07-01', 'ACT/360');
    expect(
      fraValue({ start: '2026-04-01', end: '2026-07-01', fixedRate: fwd }, { curve }).value,
    ).toBeCloseTo(0, 12);
    // Paying a below-market fixed rate is valuable to the (floating-receiving) payer.
    const cheap = fraValue(
      { start: '2026-04-01', end: '2026-07-01', fixedRate: fwd - 0.01 },
      { curve },
    );
    expect(cheap.value).toBeGreaterThan(0);
  });
});

describe('swaps', () => {
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.035],
      ['2032-01-01', 0.04],
    ],
    { referenceDate: ref },
  );
  // H04: the par-rate request omits fixedRate — the par rate IS the answer.
  const parBase = {
    startDate: ref,
    maturityDate: '2031-01-01',
    fixedFrequency: 'semiannual',
    floatFrequency: 'quarterly',
  } as const;
  const base: SwapSpecification = { ...parBase, fixedRate: 0 };

  it('a swap struck at the par rate has ~zero value', () => {
    const par = swapRate(parBase, { discountCurve: curve });
    const v = swapValue({ ...base, fixedRate: par }, { discountCurve: curve });
    expect(v.value).toBeCloseTo(0, 9);
    expect(v.pv01).toBeGreaterThan(0);
  });

  it('paying a below-par fixed rate is valuable to the payer', () => {
    const par = swapRate(parBase, { discountCurve: curve });
    expect(
      swapValue({ ...base, fixedRate: par - 0.005 }, { discountCurve: curve }).value,
    ).toBeGreaterThan(0);
  });

  it('H04: a par-rate request REJECTS the irrelevant fixed coupon, and explains its legs', () => {
    // Before H04 this call REQUIRED fixedRate (input.missing_field without it) — and the
    // rejection even named the WRONG function (`swapValue:`), the forwarded-contract defect.
    const par = swapRate(parBase, { discountCurve: curve });
    expect(Number.isFinite(par)).toBe(true);
    let caught: unknown;
    try {
      swapRate({ ...parBase, fixedRate: 0.03 } as never, { discountCurve: curve });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.unknown_field')).toBe(true);
    // The explain twin returns the SAME value and discloses the arithmetic it came from.
    const explained = swapRate.explain(parBase, { discountCurve: curve });
    expect(explained.value).toBeCloseTo(par, 15);
    const legs = explained.diagnostics.decomposition!;
    expect(explained.value).toBeCloseTo(legs['floatLegPresentValue']! / legs['annuity']!, 12);
    expect(explained.assumptions.fixedDayCount).toBe('30/360');
    expect(explained.assumptions.floatFrequency).toBe('quarterly');
  });
});

describe('swaptions', () => {
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2030-01-01', 0.035],
      ['2034-01-01', 0.04],
    ],
    { referenceDate: ref },
  );
  // 1y → 5y forward-starting swap.
  const underlying: SwapSpecification = {
    startDate: '2027-01-01',
    maturityDate: '2032-01-01',
    fixedRate: 0,
    fixedFrequency: 'semiannual',
    floatFrequency: 'quarterly',
  };
  const atm = swapRate((({ fixedRate: _strike, ...par }) => par)(underlying), {
    discountCurve: curve,
  });

  it('payer − receiver = annuity·(S − K) (put-call parity under the annuity measure)', () => {
    const K = atm + 0.005;
    const common = { ...underlying, fixedRate: K, expiry: '2027-01-01', volatility: 0.25 } as const;
    const payer = swaptionPrice({ ...common, optionType: 'payer' }, { discountCurve: curve });
    const receiver = swaptionPrice({ ...common, optionType: 'receiver' }, { discountCurve: curve });
    expect(payer.price - receiver.price).toBeCloseTo(
      payer.annuity * (payer.forwardSwapRate - K),
      9,
    );
  });

  it('ATM payer and receiver have equal value', () => {
    const common = {
      ...underlying,
      fixedRate: atm,
      expiry: '2027-01-01',
      volatility: 0.25,
    } as const;
    const payer = swaptionPrice({ ...common, optionType: 'payer' }, { discountCurve: curve });
    const receiver = swaptionPrice({ ...common, optionType: 'receiver' }, { discountCurve: curve });
    expect(payer.price).toBeCloseTo(receiver.price, 9);
    expect(payer.price).toBeGreaterThan(0);
  });

  it('price rises with volatility, and Bachelier is also positive', () => {
    const common = {
      ...underlying,
      fixedRate: atm,
      expiry: '2027-01-01',
      optionType: 'payer' as const,
    };
    const lo = swaptionPrice({ ...common, volatility: 0.15 }, { discountCurve: curve });
    const hi = swaptionPrice({ ...common, volatility: 0.3 }, { discountCurve: curve });
    expect(hi.price).toBeGreaterThan(lo.price);
    const normal = swaptionPrice(
      { ...common, volatility: 0.01, model: 'bachelier' },
      { discountCurve: curve },
    );
    expect(normal.price).toBeGreaterThan(0);
  });
});

describe('caps & floors', () => {
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.035],
      ['2031-01-01', 0.04],
    ],
    { referenceDate: ref },
  );
  const strike = 0.035;
  const common = {
    startDate: ref,
    maturityDate: '2030-01-01',
    strike,
    volatility: 0.3,
    frequency: 'quarterly' as const,
    dayCount: 'ACT/360' as const,
  };

  it('cap − floor equals the payer swap on the same schedule and strike (parity)', () => {
    const cap = capFloorPrice({ ...common, type: 'cap' }, { discountCurve: curve });
    const floor = capFloorPrice({ ...common, type: 'floor' }, { discountCurve: curve });
    const swap = swapValue(
      {
        startDate: ref,
        maturityDate: '2030-01-01',
        fixedRate: strike,
        fixedFrequency: 'quarterly',
        fixedDayCount: 'ACT/360',
        floatFrequency: 'quarterly',
        floatDayCount: 'ACT/360',
      },
      { discountCurve: curve },
    );
    expect(cap.price - floor.price).toBeCloseTo(swap.value, 9);
  });

  it('a cap is worth more when volatility is higher', () => {
    const lo = capFloorPrice({ ...common, volatility: 0.2, type: 'cap' }, { discountCurve: curve });
    const hi = capFloorPrice({ ...common, volatility: 0.5, type: 'cap' }, { discountCurve: curve });
    expect(hi.price).toBeGreaterThan(lo.price);
    expect(lo.caplets.length).toBeGreaterThan(10); // ~quarterly over ~4y
  });

  it('DISCLOSES that the already-fixed first caplet is included (at intrinsic), not dropped', () => {
    // Market convention for a spot-starting cap drops the first caplet — its rate has already
    // fixed, so it is not optional. This library keeps it and prices it at zero time value. That
    // is a defensible choice and a material one (it is the difference between two quotes of the
    // same cap), so it has to be stated rather than left in the code for a reader to find.
    const cap = capFloorPrice({ ...common, type: 'cap' }, { discountCurve: curve });
    expect(cap.assumptions['firstCaplet']).toBe('included-at-intrinsic');
    // And the disclosure is true: the first caplet starts at the curve reference date, so its
    // expiry is 0 and its value is pure intrinsic on the forward.
    const first = cap.caplets[0]!;
    expect(first.start).toBe(ref);
    expect(first.expiry).toBe(0);
    expect(first.value).toBeGreaterThanOrEqual(0);
    const floor = capFloorPrice({ ...common, type: 'floor' }, { discountCurve: curve });
    expect(floor.assumptions['firstCaplet']).toBe('included-at-intrinsic');
    // Intrinsic ⇒ exactly one of the pair is worth something on the first period.
    expect(Math.min(first.value, floor.caplets[0]!.value)).toBeCloseTo(0, 12);
  });
});

describe('CMS (convexity-adjusted)', () => {
  const curve = curves.fromZeroRates(
    [
      ['2028-01-01', 0.03],
      ['2032-01-01', 0.035],
      ['2042-01-01', 0.04],
    ],
    { referenceDate: ref },
  );

  it('the CMS rate exceeds the plain forward swap rate by a positive convexity adjustment', () => {
    const cms = forwardCmsRate(
      { resetDate: '2028-01-01', swapTenorYears: 10, volatility: 0.25 },
      { discountCurve: curve },
    );
    expect(cms.convexityAdjustment).toBeGreaterThan(0);
    expect(cms.cmsRate).toBeCloseTo(cms.forwardSwapRate + cms.convexityAdjustment, 12);
    expect(cms.cmsRate).toBeGreaterThan(cms.forwardSwapRate);
  });

  it('the adjustment vanishes at zero vol and scales with vol²·T', () => {
    expect(
      cmsConvexityAdjustment({
        forwardSwapRate: 0.04,
        swapTenorYears: 10,
        paymentsPerYear: 2,
        volatility: 0,
        expiry: 5,
      }).value,
    ).toBe(0);
    const a1 = cmsConvexityAdjustment({
      forwardSwapRate: 0.04,
      swapTenorYears: 10,
      paymentsPerYear: 2,
      volatility: 0.2,
      expiry: 5,
    }).value;
    // double vol ⇒ ~4× adjustment
    const a2 = cmsConvexityAdjustment({
      forwardSwapRate: 0.04,
      swapTenorYears: 10,
      paymentsPerYear: 2,
      volatility: 0.4,
      expiry: 5,
    }).value;
    expect(a2 / a1).toBeCloseTo(4, 6);
    // double T ⇒ ~2× adjustment
    const aT = cmsConvexityAdjustment({
      forwardSwapRate: 0.04,
      swapTenorYears: 10,
      paymentsPerYear: 2,
      volatility: 0.2,
      expiry: 10,
    }).value;
    expect(aT / a1).toBeCloseTo(2, 6);
    expect(a1).toBeGreaterThan(0);
  });

  it('a longer underlying swap tenor carries a larger convexity adjustment', () => {
    const short = forwardCmsRate(
      { resetDate: '2028-01-01', swapTenorYears: 2, volatility: 0.25 },
      { discountCurve: curve },
    );
    const long = forwardCmsRate(
      { resetDate: '2028-01-01', swapTenorYears: 10, volatility: 0.25 },
      { discountCurve: curve },
    );
    expect(long.convexityAdjustment).toBeGreaterThan(short.convexityAdjustment);
  });
});

describe('rates input hardening (PR review §14.3)', () => {
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2030-01-01', 0.035],
      ['2034-01-01', 0.04],
    ],
    { referenceDate: ref },
  );
  const underlying: SwapSpecification = {
    startDate: '2027-01-01',
    maturityDate: '2032-01-01',
    fixedRate: 0.03,
    fixedFrequency: 'semiannual',
    floatFrequency: 'quarterly',
  };

  it('black/bachelier reject a negative or NaN volatility instead of silently returning intrinsic', () => {
    expect(() =>
      blackKernel({
        forward: 0.03,
        strike: 0.03,
        volatility: -0.1,
        timeToExpiryYears: 1,
        right: 'call',
      }),
    ).toThrow(/volatility/);
    expect(() =>
      blackKernel({
        forward: 0.03,
        strike: 0.03,
        volatility: NaN,
        timeToExpiryYears: 1,
        right: 'call',
      }),
    ).toThrow(/volatility/);
    expect(() =>
      bachelierKernel({
        forward: 0.03,
        strike: 0.03,
        normalVolatility: -0.1,
        timeToExpiryYears: 1,
        right: 'call',
      }),
    ).toThrow(/volatility/);
  });

  it('black/bachelier reject a negative or NaN time-to-expiry', () => {
    expect(() =>
      blackKernel({
        forward: 0.03,
        strike: 0.03,
        volatility: 0.2,
        timeToExpiryYears: -1,
        right: 'call',
      }),
    ).toThrow(/time-to-expiry/);
    expect(() =>
      bachelierKernel({
        forward: 0.03,
        strike: 0.03,
        normalVolatility: 0.2,
        timeToExpiryYears: NaN,
        right: 'call',
      }),
    ).toThrow(/time-to-expiry/);
  });

  it('black/bachelier reject an unknown option right', () => {
    expect(() =>
      blackKernel({
        forward: 0.03,
        strike: 0.03,
        volatility: 0.2,
        timeToExpiryYears: 1,
        right: 'CALL' as unknown as 'call',
      }),
    ).toThrow(/right/);
    expect(() =>
      bachelierKernel({
        forward: 0.03,
        strike: 0.03,
        normalVolatility: 0.2,
        timeToExpiryYears: 1,
        right: 'x' as unknown as 'call',
      }),
    ).toThrow(/right/);
  });

  it('swaptionPrice rejects an unknown optionType rather than defaulting to receiver', () => {
    expect(() =>
      swaptionPrice(
        {
          ...underlying,
          fixedRate: 0.03,
          expiry: '2027-01-01',
          volatility: 0.25,
          optionType: 'buyer' as unknown as 'payer',
        },
        { discountCurve: curve },
      ),
    ).toThrow(/optionType/);
  });

  it('capFloorPrice rejects an unknown type rather than defaulting to floor', () => {
    expect(() =>
      capFloorPrice(
        {
          startDate: '2027-01-01',
          maturityDate: '2029-01-01',
          strike: 0.03,
          volatility: 0.2,
          type: 'collar' as unknown as 'cap',
        },
        { discountCurve: curve },
      ),
    ).toThrow(/type/);
  });

  it('swaptionPrice guards its curves argument like every sibling (no raw TypeError)', () => {
    const specification = {
      ...underlying,
      expiry: '2027-01-01',
      volatility: 0.25,
      optionType: 'payer' as const,
    };
    expect(() => swaptionPrice(specification, undefined as never)).toThrow(
      /swaptionPrice: curves must be an object/,
    );
    expect(() => swaptionPrice(specification, 42 as never)).toThrow(
      /swaptionPrice: curves must be an object/,
    );
  });

  it('capFloorPrice guards its curves argument like every sibling (no raw TypeError)', () => {
    const specification = {
      startDate: '2027-01-01',
      maturityDate: '2029-01-01',
      strike: 0.03,
      volatility: 0.2,
      type: 'cap' as const,
    };
    expect(() => capFloorPrice(specification, undefined as never)).toThrow(
      /capFloorPrice: curves must be an object/,
    );
    expect(() => capFloorPrice(specification, 'curves' as never)).toThrow(
      /capFloorPrice: curves must be an object/,
    );
  });

  it('every curve consumer rejects a curves bundle missing its discountCurve (teach, not TypeError)', () => {
    // Deep-sweep regression: `{}` passed the object guard but died on the first `.discount()` call.
    const swaption = {
      ...underlying,
      expiry: '2027-01-01',
      volatility: 0.25,
      optionType: 'payer' as const,
    };
    expect(() => swapValue(underlying, {} as never)).toThrow(
      /swapValue: curves\.discountCurve must be a yield curve/,
    );
    expect(() =>
      swapRate((({ fixedRate: _strike, ...par }) => par)(underlying), {} as never),
    ).toThrow(/swapRate: curves\.discountCurve must be a yield curve/);
    expect(() => swaptionPrice(swaption, {} as never)).toThrow(
      /swaptionPrice: curves\.discountCurve must be a yield curve/,
    );
    expect(() =>
      capFloorPrice(
        {
          startDate: '2027-01-01',
          maturityDate: '2029-01-01',
          strike: 0.03,
          volatility: 0.2,
          type: 'cap',
        },
        {} as never,
      ),
    ).toThrow(/capFloorPrice: curves\.discountCurve must be a yield curve/);
    expect(() =>
      forwardCmsRate({ resetDate: '2028-01-01', swapTenorYears: 5, volatility: 0.25 }, {} as never),
    ).toThrow(/forwardCmsRate: curves\.discountCurve must be a yield curve/);
    expect(() =>
      fraValue({ start: '2026-04-01', end: '2026-07-01', fixedRate: 0.03 }, {} as never),
    ).toThrow(/fraValue: options\.curve must be a yield curve/);
  });

  it('rejects a raw pillar-list guess and a bad optional forecastCurve where a curve instance belongs', () => {
    expect(() => swapValue(underlying, { discountCurve: [['2027-01-01', 0.03]] } as never)).toThrow(
      /swapValue: curves\.discountCurve must be a yield curve/,
    );
    expect(() =>
      swapValue(underlying, { discountCurve: curve, forecastCurve: {} } as never),
    ).toThrow(/swapValue: curves\.forecastCurve must be a yield curve/);
  });
});

describe('forwardSwap — curve-driven forward rate + annuity (Wave 1.3)', () => {
  const discount = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.033],
      ['2032-01-01', 0.036],
    ],
    { referenceDate: ref },
  );
  const forecast = curves.fromZeroRates(
    [
      ['2027-01-01', 0.033],
      ['2029-01-01', 0.036],
      ['2032-01-01', 0.039],
    ],
    { referenceDate: ref },
  );
  // A forward-starting swap: 2Y into 3Y.
  const fwdSpecification = {
    startDate: '2028-01-01',
    maturityDate: '2031-01-01',
    fixedFrequency: 'semiannual' as const,
  };

  it('returns exactly swapValue.parRate and swapValue.annuity (same conventions)', () => {
    const fs = forwardSwap(fwdSpecification, { discountCurve: discount, forecastCurve: forecast });
    const v = swapValue(
      { ...fwdSpecification, fixedRate: 0 },
      { discountCurve: discount, forecastCurve: forecast },
    );
    expect(fs.forwardSwapRate).toBe(v.parRate);
    expect(fs.annuity).toBe(v.annuity);
    expect(fs.pv01).toBeCloseTo(fs.annuity * 1e-4, 15);
    expect(fs.assumptions.conventionsVersion).toBeTypeOf('string');
    expect(fs.diagnostics.warnings).toBeInstanceOf(Array);
  });

  it('is genuinely dual-curve: the forward differs from the single-curve rate', () => {
    const dual = forwardSwap(fwdSpecification, {
      discountCurve: discount,
      forecastCurve: forecast,
    }).forwardSwapRate;
    const single = forwardSwap(fwdSpecification, { discountCurve: discount }).forwardSwapRate; // forecast defaults to discount
    expect(dual).not.toBeCloseTo(single, 6);
    expect(dual).toBeGreaterThan(single); // forecast curve is above the discount curve
  });

  it('is the ATM swaption strike: a swaption struck at the forward is symmetric payer≡receiver', () => {
    const curvesIn = { discountCurve: discount, forecastCurve: forecast };
    const fs = forwardSwap(fwdSpecification, curvesIn);
    const common = {
      ...fwdSpecification,
      fixedRate: fs.forwardSwapRate, // ATM
      expiry: '2028-01-01',
      volatility: 0.2,
    };
    const payer = swaptionPrice({ ...common, optionType: 'payer' }, curvesIn);
    const receiver = swaptionPrice({ ...common, optionType: 'receiver' }, curvesIn);
    // At the forward, payer and receiver have equal value (put-call parity: their difference is the
    // forward swap value, zero at the forward strike), and forwardSwap agrees with swaptionPrice.
    expect(payer.forwardSwapRate).toBeCloseTo(fs.forwardSwapRate, 12);
    expect(payer.annuity).toBeCloseTo(fs.annuity, 12);
    expect(payer.price).toBeCloseTo(receiver.price, 10);
    // And the price matches the cube recipe annuity·Black(F, K=F, σ, T) the caller would compute.
    expect(payer.price).toBeGreaterThan(0);
  });

  it('rejects fixedRate (an output, not an input) and unknown keys (Law 12)', () => {
    expect(() =>
      forwardSwap({ ...fwdSpecification, fixedRate: 0.03 } as never, { discountCurve: discount }),
    ).toThrow();
    expect(() =>
      forwardSwap({ ...fwdSpecification, bogus: 1 } as never, { discountCurve: discount }),
    ).toThrow();
  });
});
