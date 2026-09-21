/**
 * Inflation analytics (`tipsIndexRatio`, `breakevenInflation`, `cpiSeasonality`). The TIPS index ratio is
 * pinned to the Treasury daily-interpolation convention (ref CPI = CPI₋₃ on the 1st, the exact linear
 * blend mid-month, continuity across the month boundary, with the SETTLEMENT month's day count). The
 * breakeven is pinned by the exact Fisher identity and the premium decomposition; seasonality by exact
 * recovery of known factors (order-independent), the average-1 normalization, and peak/trough. Plus guards.
 */

import { describe, expect, it } from 'vitest';
import {
  breakevenInflation,
  cpiSeasonality,
  tipsIndexRatio,
  zeroCouponInflationSwap,
} from '@totalfinance/fixed-income';

const CPI = {
  '2023-02': 300.0,
  '2023-03': 303.0,
  '2023-04': 306.0,
  '2023-05': 309.0,
  '2023-06': 312.0,
};

describe('tipsIndexRatio', () => {
  it('reference CPI equals CPI₋₃ on the 1st, blends linearly mid-month, and is continuous at the boundary', () => {
    const first = tipsIndexRatio({ settlementDate: '2023-05-01', cpi: CPI, baseReferenceCpi: 250 });
    expect(first.referenceCpi).toBeCloseTo(300.0, 10); // (t-1)/D = 0 → CPI Feb
    expect(first.lagMonth3).toBe('2023-02');
    expect(first.lagMonth2).toBe('2023-03');

    const mid = tipsIndexRatio({ settlementDate: '2023-05-15', cpi: CPI, baseReferenceCpi: 250 });
    expect(mid.referenceCpi).toBeCloseTo(300 + (14 / 31) * 3, 10); // May has 31 days

    // May-31 approaches, but stays below, June-01 (= CPI Mar); continuity across the boundary.
    const last = tipsIndexRatio({ settlementDate: '2023-05-31', cpi: CPI, baseReferenceCpi: 250 });
    const next = tipsIndexRatio({ settlementDate: '2023-06-01', cpi: CPI, baseReferenceCpi: 250 });
    expect(last.referenceCpi).toBeCloseTo(300 + (30 / 31) * 3, 10);
    expect(next.referenceCpi).toBeCloseTo(303.0, 10);
    expect(last.referenceCpi).toBeLessThan(next.referenceCpi);
  });

  it('computes the index ratio over an explicit base and over a datedDate, and rounds to 5 dp', () => {
    const r = tipsIndexRatio({ settlementDate: '2023-05-15', cpi: CPI, baseReferenceCpi: 250 });
    expect(r.indexRatio).toBeCloseTo(r.referenceCpi / 250, 12);
    expect(r.indexRatioRounded).toBeCloseTo(Math.round((r.referenceCpi / 250) * 1e5) / 1e5, 12);
    expect(r.inflationSinceBase).toBeCloseTo(r.indexRatio - 1, 12);

    // datedDate path: base = ref CPI at 2023-05-01 (= 300); ratio at 2023-06-01 (= 303) is 1.01.
    const d = tipsIndexRatio({ settlementDate: '2023-06-01', cpi: CPI, datedDate: '2023-05-01' });
    expect(d.baseReferenceCpi).toBeCloseTo(300, 10);
    expect(d.indexRatio).toBeCloseTo(303 / 300, 12);
  });

  it('guards bad input, the base/datedDate XOR, a missing lag CPI, and a bad base', () => {
    expect(() => tipsIndexRatio(undefined as never)).toThrowError();
    expect(() =>
      tipsIndexRatio({ settlementDate: '2023-05-15', cpi: CPI } as never),
    ).toThrowError(); // neither base nor dated
    expect(() =>
      tipsIndexRatio({
        settlementDate: '2023-05-15',
        cpi: CPI,
        baseReferenceCpi: 250,
        datedDate: '2023-01-01',
      }),
    ).toThrowError(); // both
    expect(() =>
      tipsIndexRatio({ settlementDate: '2020-05-15', cpi: CPI, baseReferenceCpi: 250 }),
    ).toThrowError(); // lag CPI (2020-02/03) missing
    expect(() =>
      tipsIndexRatio({ settlementDate: '2023-05-15', cpi: CPI, baseReferenceCpi: 0 }),
    ).toThrowError(); // base ≤ 0
    expect(() =>
      tipsIndexRatio({ settlementDate: 5 as never, cpi: CPI, baseReferenceCpi: 250 }),
    ).toThrowError(); // non-string settlement
  });
});

describe('breakevenInflation', () => {
  it('reports the arithmetic and exact Fisher-compounded breakeven', () => {
    const be = breakevenInflation({ nominalYield: 0.0455, realYield: 0.019 });
    expect(be.breakeven).toBeCloseTo(0.0455 - 0.019, 12);
    expect(be.breakevenCompounded).toBeCloseTo(1.0455 / 1.019 - 1, 12);
    // exact Fisher: (1 + real)·(1 + breakevenCompounded) == (1 + nominal)
    expect((1 + 0.019) * (1 + be.breakevenCompounded)).toBeCloseTo(1.0455, 12);
    expect(be.expectedInflation).toBeNull(); // no premia supplied
  });

  it('decomposes into expected inflation when the premia are supplied', () => {
    const be = breakevenInflation({
      nominalYield: 0.0455,
      realYield: 0.019,
      inflationRiskPremium: 0.0025,
      liquidityPremium: 0.001,
    });
    // expected = breakeven − riskPremium + liquidityPremium
    expect(be.expectedInflation).toBeCloseTo(0.0265 - 0.0025 + 0.001, 12);
    // a single premium is enough to populate the decomposition (the other defaults to 0).
    expect(
      breakevenInflation({ nominalYield: 0.04, realYield: 0.02, inflationRiskPremium: 0.003 })
        .expectedInflation,
    ).toBeCloseTo(0.02 - 0.003, 12);
  });

  it('guards non-finite yields and a real yield at or below −100%', () => {
    expect(() => breakevenInflation(undefined as never)).toThrowError();
    expect(() => breakevenInflation({ nominalYield: Number.NaN, realYield: 0.02 })).toThrowError();
    expect(() => breakevenInflation({ nominalYield: 0.04, realYield: -1 })).toThrowError();
    expect(() => breakevenInflation({ nominalYield: 0.04, realYield: -1.5 })).toThrowError();
  });
});

describe('cpiSeasonality', () => {
  // A synthetic NSA series = linear trend × known seasonal factors (normalized to average 1).
  const KNOWN = [1.002, 0.998, 1.004, 1.001, 0.999, 0.997, 1.003, 1.0, 0.996, 1.005, 0.998, 0.997];
  const meanK = KNOWN.reduce((a, b) => a + b, 0) / 12;
  const NORM = KNOWN.map((x) => x / meanK);
  const build = (months: number) => {
    const series: Array<{ month: string; level: number }> = [];
    for (let k = 0; k < months; k++) {
      const y = 2018 + Math.floor(k / 12);
      const mo = k % 12;
      series.push({
        month: `${y}-${String(mo + 1).padStart(2, '0')}`,
        level: (200 + k * 0.5) * NORM[mo]!,
      });
    }
    return series;
  };

  it('recovers the known seasonal factors (order-independent) and normalizes to average 1', () => {
    const series = build(48).reverse(); // reversed → tests the internal sort
    const res = cpiSeasonality({ series });
    for (let m = 0; m < 12; m++) expect(res.factors[m]).toBeCloseTo(NORM[m]!, 4);
    expect(res.factors.reduce((a, b) => a + b, 0) / 12).toBeCloseTo(1, 10);
    expect(res.peakMonth).toBe(NORM.indexOf(Math.max(...NORM)) + 1);
    expect(res.troughMonth).toBe(NORM.indexOf(Math.min(...NORM)) + 1);
    expect(res.monthsUsed).toBe(48 - 12);
    expect(res.yearsSpanned).toBe(4);
    expect(res.diagnostics.warnings).toHaveLength(0); // 48 months ≥ 3 years
  });

  it('warns on a short (< 3-year) history', () => {
    const res = cpiSeasonality({ series: build(30) });
    expect(
      res.diagnostics.warnings.some((w) => w.code === 'fixedIncome.seasonality_short_history'),
    ).toBe(true);
  });

  it('guards a too-short history, a month gap, and bad levels/months', () => {
    expect(() => cpiSeasonality(undefined as never)).toThrowError();
    expect(() => cpiSeasonality({ series: build(12) })).toThrowError(); // < 24 months
    const gapped = [...build(24)];
    gapped[10] = { month: '2099-05', level: 400 }; // breaks contiguity
    expect(() => cpiSeasonality({ series: gapped })).toThrowError();
    const badLevel = [...build(24)];
    badLevel[3] = { month: badLevel[3]!.month, level: -1 };
    expect(() => cpiSeasonality({ series: badLevel })).toThrowError();
    const badMonth = [...build(24)];
    badMonth[3] = { month: '2018-13', level: 200 }; // well-formed but month out of range
    expect(() => cpiSeasonality({ series: badMonth })).toThrowError();
    const malformedMonth = [...build(24)];
    malformedMonth[3] = { month: '2018-5', level: 200 }; // fails the 'YYYY-MM' shape
    expect(() => cpiSeasonality({ series: malformedMonth })).toThrowError();
  });
});

describe('zeroCouponInflationSwap', () => {
  it('the par rate IS the geometric breakeven: (1+K)^N == forward index ratio (both directions)', () => {
    const N = 10;
    const K = 0.025;
    const fromRate = zeroCouponInflationSwap({ maturityYears: N, swapRate: K });
    expect(fromRate.parRate).toBe(K);
    expect(fromRate.forwardIndexRatio).toBeCloseTo(Math.pow(1 + K, N), 12);
    expect(fromRate.fixedLeg).toBeCloseTo(Math.pow(1 + K, N) - 1, 12);
    // The inverse (forward ratio → par rate) round-trips exactly.
    const fromRatio = zeroCouponInflationSwap({
      maturityYears: N,
      forwardIndexRatio: fromRate.forwardIndexRatio,
    });
    expect(fromRatio.parRate).toBeCloseTo(K, 12);
    expect(fromRatio.markToMarket).toBeNull(); // no contractRate ⇒ no MTM
  });

  it('marks a position to market: zero at par, and pay-fixed gains when the par rate rises', () => {
    const N = 10;
    const K_c = 0.022; // contracted fixed rate
    const df = 0.8;
    const notional = 1_000_000;
    // At par (swapRate == contractRate) the swap is worth 0.
    const atPar = zeroCouponInflationSwap({
      maturityYears: N,
      swapRate: K_c,
      contractRate: K_c,
      discountFactor: df,
      notional,
    });
    expect(atPar.markToMarket).toBeCloseTo(0, 6);
    // Par rate above the contract ⇒ pay-fixed / receive-inflation is in the money.
    const K_par = 0.03;
    const r = zeroCouponInflationSwap({
      maturityYears: N,
      swapRate: K_par,
      contractRate: K_c,
      discountFactor: df,
      notional,
    });
    const expected = notional * df * (Math.pow(1 + K_par, N) - Math.pow(1 + K_c, N));
    expect(r.markToMarket).toBeCloseTo(expected, 6);
    expect(r.markToMarket!).toBeGreaterThan(0);
    // The 'inflation' payer holds the exact opposite position.
    const opp = zeroCouponInflationSwap({
      maturityYears: N,
      swapRate: K_par,
      contractRate: K_c,
      discountFactor: df,
      notional,
      payer: 'inflation',
    });
    expect(opp.markToMarket).toBeCloseTo(-r.markToMarket!, 8);
  });

  it('discloses the forward-measure convention and guards its inputs', () => {
    const r = zeroCouponInflationSwap({ maturityYears: 5, swapRate: 0.02 });
    expect(r.assumptions.method).toBe('zero-coupon-inflation-swap');
    expect(r.diagnostics.converged).toBe(true);
    // exactly one of swapRate / forwardIndexRatio
    expect(() => zeroCouponInflationSwap({ maturityYears: 5 })).toThrow(/exactly one/);
    expect(() =>
      zeroCouponInflationSwap({ maturityYears: 5, swapRate: 0.02, forwardIndexRatio: 1.1 }),
    ).toThrow(/exactly one/);
    // guards: bad maturity, rate ≤ −100%, non-positive forward ratio / notional / DF, unknown key
    expect(() => zeroCouponInflationSwap({ maturityYears: 0, swapRate: 0.02 })).toThrowError();
    expect(() => zeroCouponInflationSwap({ maturityYears: 5, swapRate: -1 })).toThrowError();
    expect(() =>
      zeroCouponInflationSwap({ maturityYears: 5, forwardIndexRatio: 0 }),
    ).toThrowError();
    expect(() =>
      zeroCouponInflationSwap({
        maturityYears: 5,
        swapRate: 0.02,
        contractRate: 0.01,
        notional: -1,
      }),
    ).toThrowError();
    expect(() =>
      zeroCouponInflationSwap({ maturityYears: 5, swapRate: 0.02, bogus: 1 } as never),
    ).toThrowError();
  });
});
