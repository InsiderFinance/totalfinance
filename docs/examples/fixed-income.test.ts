/**
 * Runnable fixed-income examples (spec §14). Each snippet executes in CI with assertions so the
 * bonds / curves / rates / models / credit docs cannot drift from working code.
 */

import { describe, expect, it } from 'vitest';
import {
  bonds,
  bootstrapHazardFromCds,
  capFloorPrice,
  cdsParSpread,
  curves,
  curveMetrics,
  hullWhite,
  priceFromYield,
  shortRateTree,
  swapRate,
  swaptionPrice,
  vasicek,
  yieldMetrics,
  yieldToMaturity,
} from '@insiderfinance/totalfinance/fixed-income';

describe('docs: price a bond and read its risk', () => {
  it('a 5y 5% semiannual bond prices to par at a 5% yield and round-trips', () => {
    const bond = bonds.fixedRate({
      issueDate: '2026-01-01',
      maturityDate: '2031-01-01',
      couponRate: 0.05,
      frequency: 'semiannual',
      faceValue: 100,
      dayCount: '30/360',
    });

    const priced = priceFromYield(bond, { settlementDate: '2026-01-01', yield: 0.05 });
    expect(priced.cleanPrice).toBeCloseTo(100, 8);

    // Recover the yield from the price, then read duration / convexity / DV01.
    const y = yieldToMaturity(bond, { settlementDate: '2026-01-01', price: priced.cleanPrice });
    expect(y).toBeCloseTo(0.05, 8);
    const risk = yieldMetrics(bond, { settlementDate: '2026-01-01', yield: y });
    expect(risk.modifiedDuration).toBeLessThan(risk.macaulayDuration);
    expect(risk.convexity).toBeGreaterThan(0);
    expect(risk.dv01).toBeGreaterThan(0);
  });
});

describe('docs: build a curve and read effective / key-rate risk', () => {
  it('zero-rate pillars → discount factors, forwards, and key-rate durations that sum to the parallel one', () => {
    const curve = curves.fromZeroRates(
      [
        ['2027-01-01', 0.035],
        ['2030-01-01', 0.04],
        ['2033-01-01', 0.043],
      ],
      { referenceDate: '2026-01-01', dayCount: 'ACT/365F', interpolation: 'logLinearDiscount' },
    );
    expect(curve.discount('2027-01-01')).toBeLessThan(1);

    const bond = bonds.fixedRate({
      issueDate: '2026-01-01',
      maturityDate: '2033-01-01',
      couponRate: 0.04,
      frequency: 'semiannual',
      dayCount: '30/360',
    });
    const m = curveMetrics(bond, curve, { settlementDate: '2026-01-01' });
    const krdSum = m.keyRateDurations.reduce((s, k) => s + k.duration, 0);
    expect(krdSum).toBeCloseTo(m.effectiveDuration, 4);
  });
});

describe('docs: swaps, swaptions and caps off a single curve', () => {
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2030-01-01', 0.035],
      ['2034-01-01', 0.04],
    ],
    { referenceDate: '2026-01-01' },
  );

  it('a swaption priced at the forward swap rate is at-the-money', () => {
    const underlying = {
      startDate: '2027-01-01',
      maturityDate: '2032-01-01',
      fixedRate: 0,
      fixedFrequency: 'semiannual',
      floatFrequency: 'quarterly',
    } as const;
    const atm = swapRate((({ fixedRate: _strike, ...par }) => par)(underlying), {
      discountCurve: curve,
    });
    const payer = swaptionPrice(
      {
        ...underlying,
        fixedRate: atm,
        expiry: '2027-01-01',
        volatility: 0.25,
        optionType: 'payer',
      },
      { discountCurve: curve },
    );
    expect(payer.forwardSwapRate).toBeCloseTo(atm, 8);
    expect(payer.price).toBeGreaterThan(0);
  });

  it('a cap is a positive-cost strip of caplets', () => {
    const cap = capFloorPrice(
      {
        startDate: '2026-01-01',
        maturityDate: '2030-01-01',
        strike: 0.035,
        volatility: 0.3,
        type: 'cap',
        frequency: 'quarterly',
      },
      { discountCurve: curve },
    );
    expect(cap.price).toBeGreaterThan(0);
    expect(cap.caplets.length).toBeGreaterThan(10);
  });
});

describe('docs: short-rate models', () => {
  it('Hull-White reconstructs the curve; a calibrated BK tree reprices it', () => {
    const curve = curves.fromZeroRates(
      [
        ['2027-01-01', 0.03],
        ['2031-01-01', 0.04],
      ],
      { referenceDate: '2026-01-01' },
    );
    const hw = hullWhite(curve, { a: 0.1, sigma: 0.01 });
    expect(
      hw.discountBond({
        valuationTime: 0,
        timeToMaturity: 4,
        shortRate: curve.instantaneousForward(0),
      }),
    ).toBeCloseTo(curve.discount(4), 4);

    const tree = shortRateTree(curve, {
      meanReversion: 0.1,
      sigma: 0.2,
      model: 'black-karasinski',
      horizonYears: 5,
      steps: 40,
    });
    expect(tree.discountBond(40 * tree.timeStepYears)).toBeCloseTo(
      curve.discount(40 * tree.timeStepYears),
      5,
    );

    // Vasicek gives an affine bond price and mean-reverting short-rate moments.
    const v = vasicek({ a: 0.1, b: 0.05, sigma: 0.01, r0: 0.03 });
    expect(v.discountBond(0.03, 5)).toBeLessThan(1);
    expect(v.shortRateMoments(50).mean).toBeCloseTo(0.05, 3);
  });
});

describe('docs: credit — bootstrap a survival curve from CDS spreads', () => {
  it('reprices each quoted CDS to par', () => {
    const ref = '2026-01-01';
    const discountCurve = curves.flat({
      rate: 0.03,
      referenceDate: ref,
      options: { dayCount: 'ACT/365F' },
    });
    const quotes = [
      { maturity: '2029-01-01', spread: 0.012 },
      { maturity: '2031-01-01', spread: 0.016 },
      { maturity: '2036-01-01', spread: 0.02 },
    ];
    const survivalCurve = bootstrapHazardFromCds(quotes, {
      referenceDate: ref,
      discountCurve,
      recovery: 0.4,
    });

    for (const q of quotes) {
      const par = cdsParSpread(
        { effectiveDate: ref, maturityDate: q.maturity, recovery: 0.4 },
        { discountCurve, survivalCurve },
      );
      expect(par).toBeCloseTo(q.spread, 8);
    }
    expect(survivalCurve.survival('2031-01-01')).toBeLessThan(1);
  });
});
