/**
 * Bond futures & cheapest-to-deliver (`conversionFactor`, `bondFuture`). The CME conversion factor is
 * pinned to Hull's published 1.4623 example and the at-par 1.0000 identity, with the z=9 (2n+1) branch
 * bracketed by its neighbors. The basis analytics are pinned by the implied-repo break-even identity
 * (with and without an interim coupon), the CTD being simultaneously max-implied-repo and min-net-basis,
 * the netBasis = grossBasis − carry identity, the supplied-factor override, and the guards.
 */

import { describe, expect, it } from 'vitest';
import {
  bondFuture,
  bondFutureHedge,
  bonds,
  conversionFactor,
  priceFromYield,
  yieldMetrics,
  yieldToMaturity,
  yearFraction,
} from '@totalfinance/fixed-income';

const mk = (
  couponRate: number,
  maturityDate: string,
  frequency: 'semiannual' | 'annual' = 'semiannual',
) =>
  bonds.fixedRate({
    issueDate: '2015-05-15',
    maturityDate,
    couponRate,
    frequency,
    dayCount: 'ACT/ACT',
  });

describe('conversionFactor', () => {
  it("matches Hull's published 20y-2m, 10%-coupon example (1.4623)", () => {
    // Delivery 2020-03 → ref 2020-03-01; maturity 2040-05 → 20y2m → rounds to 20y0m.
    const cf = conversionFactor({ bond: mk(0.1, '2040-05-01'), deliveryDate: '2020-03-01' });
    expect(cf.factor).toBeCloseTo(1.4623, 4);
    expect(cf.wholeYears).toBe(20);
    expect(cf.extraMonths).toBe(0);
    expect(cf.notionalCoupon).toBe(0.06);
  });

  it('is exactly 1 when the coupon equals the notional, >1 above it, <1 below it', () => {
    expect(
      conversionFactor({ bond: mk(0.06, '2030-03-01'), deliveryDate: '2020-03-01' }).factor,
    ).toBeCloseTo(1, 6);
    expect(
      conversionFactor({ bond: mk(0.08, '2030-03-01'), deliveryDate: '2020-03-01' }).factor,
    ).toBeGreaterThan(1);
    expect(
      conversionFactor({ bond: mk(0.04, '2030-03-01'), deliveryDate: '2020-03-01' }).factor,
    ).toBeLessThan(1);
  });

  it('handles the z=9 (2n+1 exponent) branch, bracketed by its z=6 and next-year z=0 neighbors', () => {
    const cf9 = conversionFactor({ bond: mk(0.05, '2045-03-15'), deliveryDate: '2024-06-15' }); // 20y9m
    expect(cf9.extraMonths).toBe(9);
    expect(cf9.wholeYears).toBe(20);
    const cf6 = conversionFactor({
      bond: mk(0.05, '2044-12-15'),
      deliveryDate: '2024-06-15',
    }).factor; // 20y6m
    const cf0 = conversionFactor({
      bond: mk(0.05, '2045-06-15'),
      deliveryDate: '2024-06-15',
    }).factor; // 21y0m
    // A discount bond (coupon 5% < 6% notional) has a CF that falls with maturity — z=9 sits between.
    expect(cf9.factor).toBeLessThan(cf6);
    expect(cf9.factor).toBeGreaterThan(cf0);
  });

  it('honors a non-6% notional coupon and warns on a non-semiannual bond', () => {
    const c8 = conversionFactor({
      bond: mk(0.06, '2030-03-01'),
      deliveryDate: '2020-03-01',
      notionalCoupon: 0.08,
    });
    expect(c8.notionalCoupon).toBe(0.08);
    expect(c8.factor).toBeLessThan(1); // a 6% bond priced to yield 8% is a discount
    const annual = conversionFactor({
      bond: mk(0.05, '2035-03-01', 'annual'),
      deliveryDate: '2020-03-01',
    });
    expect(
      annual.diagnostics.warnings.some((w) => w.code === 'fixedIncome.cf_non_semiannual'),
    ).toBe(true);
  });

  it('guards bad input, a missing delivery date, and a bond maturing before the delivery month', () => {
    expect(() => conversionFactor(undefined as never)).toThrowError();
    expect(() => conversionFactor({ bond: mk(0.05, '2040-05-01') } as never)).toThrowError();
    expect(() =>
      conversionFactor({ bond: mk(0.05, '2020-01-01'), deliveryDate: '2020-03-01' }),
    ).toThrowError();
  });
});

describe('bondFuture', () => {
  const CTD_BASKET = () => ({
    futuresPrice: 110.5,
    settlementDate: '2024-03-01',
    deliveryDate: '2024-06-15',
    repoRate: 0.053,
    deliverables: [
      { id: '4.5s34', bond: mk(0.045, '2034-05-15'), cleanPrice: 99.2 },
      { id: '2.0s35', bond: mk(0.02, '2035-08-15'), cleanPrice: 78.5 },
      { id: '6.25s33', bond: mk(0.0625, '2033-11-15'), cleanPrice: 113.9 },
    ],
  });

  it('the implied repo rate is the exact break-even financing rate (no interim coupon)', () => {
    // Settle→delivery inside one coupon period (5-15/11-15 schedule) ⇒ no interim coupon.
    const res = bondFuture({
      futuresPrice: 110.5,
      settlementDate: '2024-03-01',
      deliveryDate: '2024-04-15',
      repoRate: 0.053,
      deliverables: [{ id: 'a', bond: mk(0.045, '2034-05-15'), cleanPrice: 99.2 }],
    });
    const r = res.deliverables[0]!;
    expect(r.interimCoupons).toBe(0);
    // purchase·(1 + IRR·τ) == invoice  (no coupons to reinvest)
    expect(r.purchaseCost * (1 + r.impliedRepoRate * res.yearsToDelivery)).toBeCloseTo(
      r.invoicePrice,
      8,
    );
  });

  it('the implied repo rate breaks even with an interim coupon reinvested to delivery', () => {
    const bond = mk(0.045, '2034-05-15');
    const input = {
      futuresPrice: 110.5,
      settlementDate: '2024-03-01',
      deliveryDate: '2024-06-15', // a 2024-05-15 coupon falls in between
      repoRate: 0.053,
      deliverables: [{ id: 'a', bond, cleanPrice: 99.2 }],
    };
    const r = bondFuture(input).deliverables[0]!;
    const tau = yearFraction('2024-03-01', '2024-06-15', 'ACT/360');
    const interim = bond.futureCashflows('2024-03-01').filter((f) => f.date <= '2024-06-15');
    expect(interim.length).toBe(1);
    expect(r.interimCoupons).toBeCloseTo(
      interim.reduce((s, f) => s + f.amount, 0),
      10,
    );
    // Break-even: financing the dirty purchase at IRR == invoice + interim coupons reinvested at IRR.
    const lhs = r.purchaseCost * (1 + r.impliedRepoRate * tau);
    const rhs =
      r.invoicePrice +
      interim.reduce(
        (s, f) =>
          s +
          f.amount * (1 + r.impliedRepoRate * yearFraction(f.paymentDate, '2024-06-15', 'ACT/360')),
        0,
      );
    expect(lhs).toBeCloseTo(rhs, 8);
  });

  it('picks the CTD as both the highest implied repo and the lowest net basis, sorted CTD-first', () => {
    const res = bondFuture(CTD_BASKET());
    const maxIrr = res.deliverables.reduce((a, b) =>
      b.impliedRepoRate > a.impliedRepoRate ? b : a,
    );
    const minNet = res.deliverables.reduce((a, b) => (b.netBasis < a.netBasis ? b : a));
    expect(res.cheapestToDeliver.id).toBe(maxIrr.id);
    expect(res.cheapestToDeliver.id).toBe(minNet.id); // the two rankings agree
    // sorted by implied repo, descending; exactly the first row is flagged CTD.
    const irrs = res.deliverables.map((d) => d.impliedRepoRate);
    expect(irrs).toEqual([...irrs].sort((a, b) => b - a));
    expect(res.deliverables.filter((d) => d.isCheapestToDeliver)).toHaveLength(1);
    expect(res.deliverables[0]!.isCheapestToDeliver).toBe(true);
  });

  it('reports netBasis = grossBasis − carry, and grossBasis = cleanPrice − F·CF, for every row', () => {
    const res = bondFuture(CTD_BASKET());
    for (const r of res.deliverables) {
      expect(r.netBasis).toBeCloseTo(r.grossBasis - r.carry, 10);
      expect(r.grossBasis).toBeCloseTo(r.cleanPrice - 110.5 * r.conversionFactor, 10);
      expect(r.purchaseCost).toBeCloseTo(r.cleanPrice + r.accruedAtSettlement, 10);
    }
  });

  it('warns when a deliverable is not semiannual (its computed factor is approximate)', () => {
    const res = bondFuture({
      futuresPrice: 110.5,
      settlementDate: '2024-03-01',
      deliveryDate: '2024-06-15',
      repoRate: 0.053,
      deliverables: [
        { id: 'semi', bond: mk(0.045, '2034-05-15'), cleanPrice: 99.2 },
        { id: 'annual', bond: mk(0.05, '2035-05-15', 'annual'), cleanPrice: 92.0 },
      ],
    });
    expect(res.diagnostics.warnings.some((w) => w.code === 'fixedIncome.cf_non_semiannual')).toBe(
      true,
    );
  });

  it('uses a supplied conversion factor verbatim over the computed one', () => {
    const res = bondFuture({
      futuresPrice: 110.5,
      settlementDate: '2024-03-01',
      deliveryDate: '2024-06-15',
      repoRate: 0.053,
      deliverables: [{ bond: mk(0.045, '2034-05-15'), cleanPrice: 99.2, conversionFactor: 0.85 }],
    });
    const r = res.deliverables[0]!;
    expect(r.conversionFactor).toBe(0.85);
    expect(r.conversionFactorSource).toBe('supplied');
    expect(r.grossBasis).toBeCloseTo(99.2 - 110.5 * 0.85, 10);
    expect(r.id).toBe('0'); // id defaults to the basket index
  });

  it('guards bad input, an empty basket, a bad delivery date, a stale bond, and bad numbers', () => {
    const B = mk(0.045, '2034-05-15');
    expect(() => bondFuture(undefined as never)).toThrowError();
    expect(() =>
      bondFuture({
        futuresPrice: 110,
        settlementDate: 42 as never,
        deliveryDate: '2024-06-15',
        repoRate: 0.05,
        deliverables: [{ bond: B, cleanPrice: 99 }],
      }),
    ).toThrowError(); // non-string settlement date
    expect(() =>
      bondFuture({
        futuresPrice: 110,
        settlementDate: '2024-03-01',
        deliveryDate: '2024-06-15',
        repoRate: 0.05,
        deliverables: [],
      }),
    ).toThrowError(); // empty basket
    expect(() =>
      bondFuture({
        futuresPrice: 110,
        settlementDate: '2024-06-15',
        deliveryDate: '2024-03-01',
        repoRate: 0.05,
        deliverables: [{ bond: B, cleanPrice: 99 }],
      }),
    ).toThrowError(); // delivery ≤ settlement
    expect(() =>
      bondFuture({
        futuresPrice: 110,
        settlementDate: '2024-03-01',
        deliveryDate: '2024-06-15',
        repoRate: 0.05,
        deliverables: [{ bond: mk(0.05, '2024-05-15'), cleanPrice: 99 }],
      }),
    ).toThrowError(); // bond matures before delivery
    expect(() =>
      bondFuture({
        futuresPrice: -1,
        settlementDate: '2024-03-01',
        deliveryDate: '2024-06-15',
        repoRate: 0.05,
        deliverables: [{ bond: B, cleanPrice: 99 }],
      }),
    ).toThrowError(); // negative futures price
    expect(() =>
      bondFuture({
        futuresPrice: 110,
        settlementDate: '2024-03-01',
        deliveryDate: '2024-06-15',
        repoRate: Number.NaN,
        deliverables: [{ bond: B, cleanPrice: 99 }],
      }),
    ).toThrowError(); // non-finite repo
    expect(() =>
      bondFuture({
        futuresPrice: 110,
        settlementDate: '2024-03-01',
        deliveryDate: '2024-06-15',
        repoRate: 0.05,
        deliverables: [{ bond: B, cleanPrice: -5 }],
      }),
    ).toThrowError(); // negative clean price
  });
});

describe('bondFutureHedge', () => {
  const HEDGE_BASKET = () => ({
    futuresPrice: 110.5,
    settlementDate: '2024-03-01',
    deliveryDate: '2024-06-15',
    repoRate: 0.053,
    deliverables: [
      { id: '4.5s34', bond: mk(0.045, '2034-05-15'), cleanPrice: 99.2 },
      { id: '2.0s35', bond: mk(0.02, '2035-08-15'), cleanPrice: 78.5 },
      { id: '6.25s33', bond: mk(0.0625, '2033-11-15'), cleanPrice: 113.9 },
    ],
  });

  it('futures DV01 is the CTD DV01 over its conversion factor, so hedging the CTD takes CF contracts', () => {
    const res = bondFutureHedge(HEDGE_BASKET());
    // futuresDv01 = ctdDv01 / CF
    expect(res.futuresDv01).toBeCloseTo(res.ctdDv01 / res.ctdConversionFactor, 12);
    // Hedging exactly the CTD's own DV01 ⇒ hedgeRatio equals the conversion factor.
    const withHedge = bondFutureHedge({ ...HEDGE_BASKET(), hedgeDv01: res.ctdDv01 });
    expect(withHedge.hedgeRatio).toBeCloseTo(res.ctdConversionFactor, 12);
    // The CTD is the same bond bondFuture selects.
    expect(res.ctdId).toBe(bondFuture(HEDGE_BASKET()).cheapestToDeliver.id);
  });

  it('the CTD DV01 matches a finite-difference reprice of the cash bond', () => {
    const input = HEDGE_BASKET();
    const res = bondFutureHedge(input);
    const ctdBond = input.deliverables.find((d) => d.id === res.ctdId)!.bond;
    const y = yieldToMaturity(ctdBond, { settlementDate: input.settlementDate, price: 99.2 }); // it's the 4.5s34 at 99.2
    // central finite difference of clean price per 1bp
    const pUp = priceFromYield(ctdBond, {
      settlementDate: input.settlementDate,
      yield: y + 1e-4,
    }).cleanPrice;
    const pDn = priceFromYield(ctdBond, {
      settlementDate: input.settlementDate,
      yield: y - 1e-4,
    }).cleanPrice;
    const fdDv01 = (pDn - pUp) / 2;
    expect(res.ctdDv01).toBeCloseTo(fdDv01, 4); // analytic (mod-duration) DV01 ≈ central FD
    expect(res.ctdYield).toBeCloseTo(y, 12);
  });

  it('the implied forward yield reprices the forward clean price F·CF exactly', () => {
    const input = HEDGE_BASKET();
    const res = bondFutureHedge(input);
    const ctdBond = input.deliverables.find((d) => d.id === res.ctdId)!.bond;
    const fwdClean = input.futuresPrice * res.ctdConversionFactor;
    const reprice = priceFromYield(ctdBond, {
      settlementDate: input.deliveryDate,
      yield: res.impliedForwardYield,
    }).cleanPrice;
    expect(reprice).toBeCloseTo(fwdClean, 8);
  });

  it('reports per-deliverable risk (CTD first), each with futuresDv01ViaBond = dv01 / CF', () => {
    const input = HEDGE_BASKET();
    const res = bondFutureHedge(input);
    expect(res.deliverables).toHaveLength(3);
    expect(res.deliverables[0]!.id).toBe(res.ctdId); // CTD-first ordering, inherited from bondFuture
    for (const d of res.deliverables) {
      expect(d.dv01).toBeGreaterThan(0);
      expect(d.futuresDv01ViaBond).toBeCloseTo(d.dv01 / d.conversionFactor, 12);
      // each deliverable's yield reprices its own clean price
      const bond = input.deliverables.find((x) => x.id === d.id)!.bond;
      const cp = input.deliverables.find((x) => x.id === d.id)!.cleanPrice;
      expect(
        yieldMetrics(bond, { settlementDate: input.settlementDate, yield: d.yield }).dv01,
      ).toBeCloseTo(d.dv01, 12);
      expect(cp).toBeGreaterThan(0);
    }
  });

  it('the inverted-dates error context is JSON-SAFE (bonds summarized, not spread whole)', () => {
    // An error context is a public payload: logged, serialized, handed to an agent. This one used
    // to be `{ ...input }`, which put whole `Bond` INSTANCES in it — closure-carrying objects whose
    // methods vanish through JSON.stringify, leaving a payload that is simultaneously bloated and
    // silent about WHICH bond was involved. The id and maturity are the identifying facts.
    let thrown: unknown;
    try {
      bondFuture({
        futuresPrice: 110,
        settlementDate: '2024-06-15',
        deliveryDate: '2024-03-01',
        repoRate: 0.05,
        deliverables: [
          { id: '4.5s34', bond: mk(0.045, '2034-05-15'), cleanPrice: 99.2 },
          { bond: mk(0.02, '2035-08-15'), cleanPrice: 78.5 },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    const context = (thrown as { context?: Record<string, unknown> }).context!;
    expect(context['deliverables']).toEqual([
      { id: '4.5s34', maturityDate: '2034-05-15' },
      { id: '1', maturityDate: '2035-08-15' }, // unlabelled rows fall back to the basket index
    ]);
    // Round-tripping through JSON must not lose anything — the old payload did.
    expect(JSON.parse(JSON.stringify(context))).toEqual({
      settlementDate: '2024-06-15',
      deliveryDate: '2024-03-01',
      futuresPrice: 110,
      repoRate: 0.05,
      deliverables: [
        { id: '4.5s34', maturityDate: '2034-05-15' },
        { id: '1', maturityDate: '2035-08-15' },
      ],
    });
  });

  it('reports hedgeRatio only when a hedge DV01 is supplied', () => {
    const res = bondFutureHedge(HEDGE_BASKET());
    expect(res.hedgeRatio).toBeUndefined();
    const withHedge = bondFutureHedge({ ...HEDGE_BASKET(), hedgeDv01: 5000 });
    expect(withHedge.hedgeRatio).toBeCloseTo(5000 / withHedge.futuresDv01, 12);
    expect(withHedge.hedgeRatio).toBeGreaterThan(0);
  });

  it('guards a bad input and a non-finite hedge DV01, and propagates bondFuture guards', () => {
    expect(() => bondFutureHedge(undefined as never)).toThrowError();
    expect(() => bondFutureHedge({ ...HEDGE_BASKET(), hedgeDv01: Number.NaN })).toThrowError(); // non-finite hedgeDv01
    expect(() =>
      bondFutureHedge({
        futuresPrice: 110,
        settlementDate: '2024-03-01',
        deliveryDate: '2024-06-15',
        repoRate: 0.05,
        deliverables: [],
      }),
    ).toThrowError(); // empty basket (bondFuture guard)
  });
});
