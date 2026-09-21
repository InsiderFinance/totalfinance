/**
 * §14.2 multi-curve (dual-curve, OIS-discounted) bootstrapping: `curves.bootstrapProjection` and the
 * `curves.bootstrapMultiCurve` front-door. The projection curve is bootstrapped from par IRS quotes
 * whose legs discount on a SEPARATE OIS curve — the post-2008 standard. Correctness is pinned two ways:
 * the bootstrapped curve must reprice its input swaps to par under the real `swapValue` pricer, and it
 * must recover a known projection curve the quotes were generated from.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { curves, swapRate, swapValue } from '@totalfinance/fixed-income';

const REF = '2026-01-01';
const MATS = ['2027-01-01', '2028-01-01', '2029-01-01', '2031-01-01', '2033-01-01', '2036-01-01'];
const OPTS = { referenceDate: REF, interpolation: 'logLinearDiscount' } as const;

/** A curve from evenly-spaced zero pillars. */
const zeroCurve = (base: number, step: number) =>
  curves.fromZeroRates(
    MATS.map((m, i) => [m, base + step * i] as [string, number]),
    OPTS,
  );

// H04: the par-rate request omits fixedRate — the par rate IS the answer.
const parSwap = (m: string) => ({ startDate: REF, maturityDate: m });
// swapValue still takes the full specification: the fixed coupon is ITS input, not an answer.
const swapAt = (m: string, k: number) => ({ startDate: REF, maturityDate: m, fixedRate: k });

describe('§14.2 dual-curve (OIS-discounted) projection bootstrap', () => {
  it('recovers a known projection curve and reprices its inputs to par under swapValue', () => {
    const discount = zeroCurve(0.03, 0.001); // OIS
    const projection = zeroCurve(0.033, 0.001); // index (≈30bp above)
    // Par IRS quotes under dual-curve (discount on OIS, project on the index curve).
    const parRates = MATS.map((m) =>
      swapRate(parSwap(m), { discountCurve: discount, forecastCurve: projection }),
    );
    const instruments = MATS.map((m, i) => ({
      type: 'swap' as const,
      maturity: m,
      rate: parRates[i]!,
    }));

    const boot = curves.bootstrapProjection(instruments, { ...OPTS, discountCurve: discount });

    // (a) reprices every input swap to par under the real pricer.
    for (let i = 0; i < MATS.length; i++) {
      const v = swapValue(swapAt(MATS[i]!, parRates[i]!), {
        discountCurve: discount,
        forecastCurve: boot,
      }).value;
      expect(Math.abs(v)).toBeLessThan(1e-10);
    }
    // (b) recovers the projection curve the quotes came from.
    for (const m of MATS) expect(boot.discount(m)).toBeCloseTo(projection.discount(m), 10);
  });

  it('captures the OIS–index basis: the projection curve sits above the OIS curve', () => {
    const discount = zeroCurve(0.03, 0.001);
    const projection = zeroCurve(0.033, 0.001);
    const rates = MATS.map((m) =>
      swapRate(parSwap(m), { discountCurve: discount, forecastCurve: projection }),
    );
    const boot = curves.bootstrapProjection(
      MATS.map((m, i) => ({ type: 'swap' as const, maturity: m, rate: rates[i]! })),
      { ...OPTS, discountCurve: discount },
    );
    for (const m of MATS.slice(1)) {
      expect(boot.zeroRate(m)).toBeGreaterThan(discount.zeroRate(m));
    }
  });

  it('single ≡ dual: with discount == projection it recovers the self-discounting curve', () => {
    const c = zeroCurve(0.035, 0.0008);
    // Par swaps self-discounted on c (single-curve), then re-bootstrapped discounting on c.
    const rates = MATS.map((m) => swapRate(parSwap(m), { discountCurve: c, forecastCurve: c }));
    const boot = curves.bootstrapProjection(
      MATS.map((m, i) => ({ type: 'swap' as const, maturity: m, rate: rates[i]! })),
      { ...OPTS, discountCurve: c },
    );
    for (const m of MATS) expect(boot.discount(m)).toBeCloseTo(c.discount(m), 9);
  });

  it('deposits/FRAs pin the projection short end closed-form, independent of the discount curve', () => {
    const anyDiscount = curves.flat({ rate: 0.02, referenceDate: REF });
    const proj = curves.bootstrapProjection(
      [
        { type: 'deposit', maturity: '2026-07-01', rate: 0.03, dayCount: 'ACT/360' },
        { type: 'fra', start: '2026-07-01', end: '2026-10-01', rate: 0.035, dayCount: 'ACT/360' },
      ],
      { ...OPTS, discountCurve: anyDiscount },
    );
    // Deposit closed form: DF = 1 / (1 + r·τ).
    const depoDf = proj.discount('2026-07-01');
    expect(depoDf).toBeGreaterThan(0);
    expect(depoDf).toBeLessThan(1);
    // The forward from the projection curve reproduces the FRA fixing.
    const fraFwd = proj.forwardRate('2026-07-01', '2026-10-01', 'ACT/360');
    expect(fraFwd).toBeCloseTo(0.035, 10);
  });

  it('rejects a raw (non-curve) discountCurve with a typed teaching error', () => {
    let caught: unknown;
    try {
      curves.bootstrapProjection([{ type: 'swap', maturity: '2028-01-01', rate: 0.03 }], {
        referenceDate: REF,
        discountCurve: {} as never,
      });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/discountCurve must be a curve/);
    expect(caught instanceof TypeError).toBe(false);
  });

  it('enforces Law 12 (unknown keys) and rejects empty / pre-reference instruments', () => {
    const d = curves.flat({ rate: 0.03, referenceDate: REF });
    expect(() =>
      curves.bootstrapProjection([{ type: 'swap', maturity: '2028-01-01', rate: 0.03 }], {
        referenceDate: REF,
        discountCurve: d,
        bogus: 1,
      } as never),
    ).toThrow();
    expect(() => curves.bootstrapProjection([], { referenceDate: REF, discountCurve: d })).toThrow(
      /at least one instrument/,
    );
    expect(() =>
      curves.bootstrapProjection([{ type: 'swap', maturity: '2025-06-01', rate: 0.03 }], {
        referenceDate: REF,
        discountCurve: d,
      }),
    ).toThrow(/not after the reference date/);
  });
});

describe('§14.2 curves.bootstrapMultiCurve front-door', () => {
  it('returns a { discountCurve, forecastCurve } that reprices the projection swaps to par', () => {
    const oisRates = [0.028, 0.029, 0.03, 0.031, 0.032, 0.033];
    const ois = MATS.map((m, i) => ({ type: 'ois' as const, maturity: m, rate: oisRates[i]! }));
    // Derive projection par quotes from a known basis over the bootstrapped OIS discount curve.
    const discount = curves.bootstrap(ois, OPTS);
    const projection = zeroCurve(0.034, 0.001);
    const parRates = MATS.map((m) =>
      swapRate(parSwap(m), { discountCurve: discount, forecastCurve: projection }),
    );
    const projSwaps = MATS.map((m, i) => ({
      type: 'swap' as const,
      maturity: m,
      rate: parRates[i]!,
    }));

    const set = curves.bootstrapMultiCurve({ ...OPTS, ois, projection: projSwaps });

    expect(Object.keys(set).sort()).toEqual(['discountCurve', 'forecastCurve']);
    // The set drops straight into swapValue and reprices its projection quotes to par.
    for (let i = 0; i < MATS.length; i++) {
      const v = swapValue(swapAt(MATS[i]!, parRates[i]!), set).value;
      expect(Math.abs(v)).toBeLessThan(1e-10);
    }
    // And the OIS discount curve reprices its own OIS instruments to par. The single-curve
    // `bootstrap` used to discount its fixed annuity at the unadjusted accrualEnd (and telescope
    // its floating leg) while `swapValue` discounts at the business-day-rolled paymentDate, which
    // left a ~1e-6 residual here; it now builds both legs exactly as `swapValue` does, so the par
    // rates come back to machine precision. The two maturities that still miss by ~1e-7 are the
    // INTERIOR ones whose terminal payment rolls past the pillar the bootstrap pins at their
    // (unadjusted) maturity — a sequential-bootstrap property, not a convention mismatch.
    for (let i = 0; i < MATS.length; i++) {
      const parOis = swapRate(
        { ...parSwap(MATS[i]!), fixedFrequency: 'annual' },
        { discountCurve: set.discountCurve, forecastCurve: set.discountCurve },
      );
      expect(parOis).toBeCloseTo(oisRates[i]!, 6);
    }
  });

  it('validates its object argument (Law 12) and the two instrument arrays', () => {
    const ois = [{ type: 'ois' as const, maturity: '2028-01-01', rate: 0.03 }];
    const projection = [{ type: 'swap' as const, maturity: '2028-01-01', rate: 0.032 }];
    expect(() => curves.bootstrapMultiCurve(undefined as never)).toThrow();
    expect(() =>
      curves.bootstrapMultiCurve({ referenceDate: REF, ois, projection, bogus: 1 } as never),
    ).toThrow();
    expect(() =>
      curves.bootstrapMultiCurve({ referenceDate: REF, ois: 'nope' as never, projection }),
    ).toThrow();
  });
});
