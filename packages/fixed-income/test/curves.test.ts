/**
 * Tests for §14.2 yield curves: discount/zero/forward consistency, interpolation policies,
 * extrapolation, compounding conversions, and curve shocks (parallel + key-rate).
 */

import { describe, expect, it } from 'vitest';
import { curves } from '@totalfinance/fixed-income';

const ref = '2026-01-01';

describe('F14 — the zeroRate builder/query name collision', () => {
  it('the curves.zeroRate builder alias is DELETED (specification D5 — pre-release renames delete)', () => {
    expect('zeroRate' in curves).toBe(false);
    expect(typeof curves.fromZeroRates).toBe('function');
  });

  it('the built curve exposes zeroRate as a QUERY method (the collision the rename resolves)', () => {
    const curve = curves.fromZeroRates([['2027-01-01', 0.05]], { referenceDate: ref });
    // `curves.fromZeroRates` BUILDS; `curve.zeroRate` QUERIES — different roles, now different names.
    expect(typeof curve.zeroRate).toBe('function');
    expect(curve.zeroRate('2027-01-01')).toBeCloseTo(0.05, 6);
  });
});

describe('curve construction and self-consistency', () => {
  it('round-trips discount ⇄ continuous zero at the pillars', () => {
    const curve = curves.fromZeroRates(
      [
        ['2026-07-01', 0.043],
        ['2026-12-31', 0.041],
        ['2027-12-31', 0.039],
      ],
      { dayCount: 'ACT/365F', interpolation: 'logLinearDiscount' },
    );
    for (const p of curve.pillars) {
      expect(curve.discount(p.date)).toBeCloseTo(Math.exp(-p.zero * p.tenorYears), 10);
      expect(curve.zeroRate(p.date)).toBeCloseTo(p.zero, 10);
    }
    expect(curve.discount(0)).toBe(1); // DF at the reference date (t=0) is exactly 1
  });

  it('zeroRate at the reference date is the t→0⁺ limit, not the DF=1 anchor placeholder', () => {
    // A bootstrapped (or discount-factor-built) curve pins DF = 1 at t = 0, and −ln(1)/0 is
    // indeterminate, so the stored zero there is the placeholder 0. Returning it made
    // `zeroRate(referenceDate)` report a 0% overnight rate on a 5% curve — a number that reads as
    // data. Under logLinearDiscount the forwards are piecewise-constant, so the limit is exactly
    // the first real pillar's zero.
    const boot = curves.fromDiscountFactors(
      [
        [ref, 1],
        ['2027-01-01', Math.exp(-0.05 * 1)],
        ['2029-01-01', Math.exp(-0.055 * 3)],
      ],
      { referenceDate: ref, dayCount: 'ACT/365F', interpolation: 'logLinearDiscount' },
    );
    expect(boot.pillars[0]!.zero).toBe(0); // the stored placeholder is untouched
    expect(boot.zeroRate(ref)).toBeCloseTo(0.05, 10); // the ANSWER is the limit
    expect(boot.zeroRate(0)).toBeCloseTo(0.05, 10);
    // …and the limit really is what the curve does just past the origin.
    expect(boot.zeroRate(1e-6)).toBeCloseTo(boot.zeroRate(0), 8);

    // linearDiscount reaches the origin on a straight line in DF, so its limit is (1 − D₁)/t₁.
    const linear = curves.fromDiscountFactors(
      [
        [ref, 1],
        ['2027-01-01', 0.95],
        ['2029-01-01', 0.85],
      ],
      { referenceDate: ref, dayCount: 'ACT/365F', interpolation: 'linearDiscount' },
    );
    expect(linear.zeroRate(ref)).toBeCloseTo((1 - 0.95) / linear.pillars[1]!.tenorYears, 10);
  });

  it('a t=0 zero rate the CALLER quoted is echoed, not replaced by the limit', () => {
    // `fromZeroRates` is handed a real datum at the origin; only the DF=1 anchor is a placeholder.
    const quoted = curves.fromZeroRates(
      [
        [ref, 0.06],
        ['2027-01-01', 0.05],
      ],
      { referenceDate: ref, dayCount: 'ACT/365F' },
    );
    expect(quoted.zeroRate(ref)).toBeCloseTo(0.06, 12);
  });

  it('converts the compounding of a t=0 pillar like every other pillar', () => {
    // A pillar ON the reference date used to skip the compounding conversion entirely, so a 6%
    // SEMIANNUAL quote was stored as a 6% CONTINUOUS zero — the one pillar quoted in the caller's
    // convention that ignored it. The t→0 limit of the conversion is m·ln(1 + z/m).
    const semi = curves.fromZeroRates(
      [
        [ref, 0.06],
        ['2027-01-01', 0.05],
      ],
      { referenceDate: ref, dayCount: 'ACT/365F', compounding: 'semiannual' },
    );
    expect(semi.pillars[0]!.zero).toBeCloseTo(2 * Math.log(1 + 0.06 / 2), 12);
    // Round-trip: asking for it back in the quoted convention returns the quote.
    expect(semi.zeroRate(ref, 'semiannual')).toBeCloseTo(0.06, 12);
    // And it is genuinely a conversion, not a pass-through.
    expect(semi.pillars[0]!.zero).not.toBeCloseTo(0.06, 6);
  });

  it('a flat continuous curve discounts as exp(-r t) everywhere', () => {
    const curve = curves.flat({
      rate: 0.05,
      referenceDate: ref,
      options: { dayCount: 'ACT/365F' },
    });
    expect(curve.discount(1)).toBeCloseTo(Math.exp(-0.05), 12);
    expect(curve.discount(3)).toBeCloseTo(Math.exp(-0.15), 12);
    expect(curve.zeroRate(2)).toBeCloseTo(0.05, 12);
    // Flat curve ⇒ flat instantaneous forward equal to the zero.
    expect(curve.instantaneousForward(2)).toBeCloseTo(0.05, 6);
  });

  it('builds from discount factors and recovers them', () => {
    const curve = curves.discountFactor(
      [
        ['2027-01-01', 0.96],
        ['2028-01-01', 0.91],
      ],
      { referenceDate: ref },
    );
    expect(curve.discount('2027-01-01')).toBeCloseTo(0.96, 12);
    expect(curve.discount('2028-01-01')).toBeCloseTo(0.91, 12);
  });
});

describe('compounding conversions', () => {
  it('quotes the same curve in different conventions consistently', () => {
    // Build from an annually-compounded 5% pillar; the continuous zero should be ln(1.05).
    const curve = curves.fromZeroRates([['2027-01-01', 0.05]], {
      referenceDate: ref,
      compounding: 'annual',
      dayCount: 'ACT/365F',
    });
    const t = curve.timeTo('2027-01-01');
    expect(curve.discount('2027-01-01')).toBeCloseTo(Math.pow(1.05, -t), 10);
    expect(curve.zeroRate('2027-01-01', 'annual')).toBeCloseTo(0.05, 8);
    expect(curve.zeroRate('2027-01-01', 'continuous')).toBeCloseTo(Math.log(1.05), 8);
  });

  it('simple-compounded zero matches a money-market discount', () => {
    const curve = curves.fromZeroRates([['2026-07-02', 0.04]], {
      referenceDate: ref,
      compounding: 'simple',
    });
    const t = curve.timeTo('2026-07-02');
    expect(curve.discount('2026-07-02')).toBeCloseTo(1 / (1 + 0.04 * t), 10);
  });
});

describe('forward rates', () => {
  it('simple forward equals (DF1/DF2 − 1)/τ', () => {
    const curve = curves.fromZeroRates([
      ['2027-01-01', 0.04],
      ['2028-01-01', 0.045],
    ]);
    const df1 = curve.discount('2027-01-01');
    const df2 = curve.discount('2028-01-01');
    const tau = curve.timeTo('2028-01-01') - curve.timeTo('2027-01-01');
    expect(curve.forwardRate('2027-01-01', '2028-01-01')).toBeCloseTo((df1 / df2 - 1) / tau, 8);
  });

  it('logLinearDiscount gives a piecewise-constant instantaneous forward inside a segment', () => {
    const curve = curves.fromZeroRates(
      [
        ['2027-01-01', 0.03],
        ['2029-01-01', 0.05],
      ],
      { interpolation: 'logLinearDiscount' },
    );
    const f1 = curve.instantaneousForward(1.2);
    const f2 = curve.instantaneousForward(1.6);
    expect(f1).toBeCloseTo(f2, 4); // flat forward within the single segment
  });

  it('rejects an inverted forward window', () => {
    const curve = curves.flat({ rate: 0.03, referenceDate: ref });
    expect(() => curve.forwardRate('2028-01-01', '2027-01-01')).toThrow(/from < to/);
  });
});

describe('interpolation policies agree at pillars but differ between them', () => {
  const points = [
    ['2027-01-01', 0.03],
    ['2028-01-01', 0.05],
    ['2030-01-01', 0.045],
  ] as const;

  it('every policy reproduces the pillar zeros exactly', () => {
    for (const interp of [
      'logLinearDiscount',
      'linearZero',
      'linearDiscount',
      'cubicZero',
      'pchipZero',
    ] as const) {
      const curve = curves.fromZeroRates(points, { interpolation: interp });
      for (const p of curve.pillars) {
        expect(curve.zeroRate(p.date)).toBeCloseTo(p.zero, 8);
      }
    }
  });

  it('linearZero and cubicZero differ off-pillar', () => {
    const lin = curves.fromZeroRates(points, { interpolation: 'linearZero' });
    const cub = curves.fromZeroRates(points, { interpolation: 'cubicZero' });
    expect(Math.abs(lin.zeroRate(2.5) - cub.zeroRate(2.5))).toBeGreaterThan(1e-6);
  });
});

describe('extrapolation', () => {
  const curve = (extra: 'flatForward' | 'flatZero' | 'throw') =>
    curves.fromZeroRates(
      [
        ['2027-01-01', 0.03],
        ['2028-01-01', 0.04],
      ],
      { extrapolation: extra },
    );

  it('flatForward continues the terminal instantaneous forward', () => {
    const c = curve('flatForward');
    const tLast = c.pillars[c.pillars.length - 1]!.tenorYears;
    const f = c.instantaneousForward(tLast - 0.01);
    // DF a year past the end ≈ DF(end)·exp(−f·1)
    const dfEnd = c.discount(tLast);
    expect(c.discount(tLast + 1)).toBeCloseTo(dfEnd * Math.exp(-f * 1), 4);
  });

  it('flatZero holds the last zero flat', () => {
    const c = curve('flatZero');
    const last = c.pillars[c.pillars.length - 1]!;
    expect(c.zeroRate(last.tenorYears + 5)).toBeCloseTo(last.zero, 8);
  });

  it('throw refuses to extrapolate past the last pillar', () => {
    const c = curve('throw');
    const last = c.pillars[c.pillars.length - 1]!;
    expect(() => c.discount(last.tenorYears + 1)).toThrow(/beyond last pillar/);
  });
});

describe('curve shocks (curve risk)', () => {
  const base = curves.fromZeroRates([
    ['2027-01-01', 0.03],
    ['2028-01-01', 0.04],
    ['2030-01-01', 0.045],
  ]);

  it('parallel shift moves every zero by the bump', () => {
    const up = base.shift(0.0001); // +1bp
    for (const p of base.pillars) {
      expect(up.zeroRate(p.date)).toBeCloseTo(p.zero + 0.0001, 10);
    }
  });

  it('bumpPillar perturbs one node and leaves distant nodes unchanged', () => {
    const bumped = base.bumpPillar(1, 0.001);
    expect(bumped.pillars[1]!.zero).toBeCloseTo(base.pillars[1]!.zero + 0.001, 10);
    expect(bumped.pillars[0]!.zero).toBeCloseTo(base.pillars[0]!.zero, 12);
    expect(bumped.pillars[2]!.zero).toBeCloseTo(base.pillars[2]!.zero, 12);
  });

  it('rejects an out-of-range pillar index', () => {
    expect(() => base.bumpPillar(9, 0.001)).toThrow(/out of range/);
  });
});

describe('input validation', () => {
  it('rejects an empty curve', () => {
    expect(() => curves.fromZeroRates([])).toThrow(/at least one pillar/);
  });

  it('rejects a non-positive discount factor', () => {
    expect(() => curves.discountFactor([['2027-01-01', -0.5]])).toThrow(/positive/);
  });

  it('rejects a pillar before the reference date', () => {
    expect(() =>
      curves.fromZeroRates([['2025-01-01', 0.03]], { referenceDate: '2026-01-01' }),
    ).toThrow(/before the reference date/);
  });
});

describe('pillar dates are the ORIGINAL input dates (no day-count drift)', () => {
  const dated = [
    ['2026-07-15', 0.035],
    ['2027-01-15', 0.038],
    ['2029-01-15', 0.041],
  ] as const;

  it('zero-rate pillars under ACT/360 keep the exact input dates', () => {
    // Reconstructing dates from ACT/360 year fractions drifted ~5 days per year pre-fix.
    const curve = curves.fromZeroRates(dated, { referenceDate: ref, dayCount: 'ACT/360' });
    expect(curve.pillars.map((p) => p.date)).toEqual(dated.map(([d]) => d));
  });

  it('discount-factor pillars under 30/360 keep the exact input dates', () => {
    const curve = curves.discountFactor(
      [
        ['2027-01-15', 0.96],
        ['2029-01-15', 0.9],
      ],
      { referenceDate: ref, dayCount: '30/360' },
    );
    expect(curve.pillars.map((p) => p.date)).toEqual(['2027-01-15', '2029-01-15']);
  });

  it('bootstrapped pillars under ACT/360 keep the instrument maturity dates', () => {
    const curve = curves.bootstrap(
      [
        { type: 'deposit', maturity: '2026-07-01', rate: 0.03 },
        { type: 'swap', maturity: '2028-01-01', rate: 0.035 },
      ],
      { referenceDate: ref, dayCount: 'ACT/360' },
    );
    expect(curve.pillars.map((p) => p.date)).toEqual([ref, '2026-07-01', '2028-01-01']);
  });

  it('shift/bumpPillar preserve the original dates on the shocked curve', () => {
    const base = curves.fromZeroRates(dated, { referenceDate: ref, dayCount: 'ACT/360' });
    expect(base.shift(0.0001).pillars.map((p) => p.date)).toEqual(dated.map(([d]) => d));
    expect(base.bumpPillar(1, 0.001).pillars.map((p) => p.date)).toEqual(dated.map(([d]) => d));
  });

  it('undated pillars (curves.flat) reconstruct under the curve day count, not a hardcoded 365', () => {
    // Under ACT/360, t = 1 is 360 actual days after the reference date: 2026-12-27.
    const act360 = curves.flat({
      rate: 0.03,
      referenceDate: ref,
      options: { dayCount: 'ACT/360' },
    });
    expect(act360.pillars[0]!.date).toBe(ref);
    expect(act360.pillars[1]!.date).toBe('2026-12-27');
    // Under ACT/365F the same pillar is 365 days out: 2027-01-01.
    const act365 = curves.flat({
      rate: 0.03,
      referenceDate: ref,
      options: { dayCount: 'ACT/365F' },
    });
    expect(act365.pillars[1]!.date).toBe('2027-01-01');
  });
});

describe('curve builder input hardening (deep-sweep boundary)', () => {
  it('curves.flat rejects a null options bag instead of dying on the first option read', () => {
    // `null` slips past the `= {}` default parameter (only `undefined` triggers it).
    expect(() => curves.flat({ rate: 0.03, referenceDate: ref, options: null as never })).toThrow(
      /curves\.flat: options must be an object/,
    );
    expect(() =>
      curves.flat({ rate: 0.03, referenceDate: ref, options: 'ACT/360' as never }),
    ).toThrow(/curves\.flat: options must be an object/);
  });
});

describe('addSpread — combine with a term-structure spread curve', () => {
  const base = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.035],
      ['2031-01-01', 0.04],
    ],
    { referenceDate: ref },
  );

  it('adds continuous zeros (⇔ multiplies discount factors) at the pillars', () => {
    const spread = curves.fromZeroRates(
      [
        ['2028-01-01', 0.006],
        ['2031-01-01', 0.012],
      ],
      { referenceDate: ref },
    );
    const combined = base.addSpread(spread);
    for (const d of ['2028-01-01', '2029-01-01', '2031-01-01']) {
      expect(combined.discount(d)).toBeCloseTo(base.discount(d) * spread.discount(d), 12);
      expect(combined.zeroRate(d)).toBeCloseTo(base.zeroRate(d) + spread.zeroRate(d), 12);
    }
  });

  it('a zero spread is a no-op', () => {
    const combined = base.addSpread(curves.flat({ rate: 0, referenceDate: ref }));
    for (const d of ['2028-01-01', '2030-06-01', '2031-01-01']) {
      expect(combined.discount(d)).toBeCloseTo(base.discount(d), 12);
    }
  });

  it('a flat spread σ raises every zero by exactly σ', () => {
    const combined = base.addSpread(curves.flat({ rate: 0.005, referenceDate: ref }));
    for (const d of ['2028-01-01', '2031-01-01']) {
      expect(combined.zeroRate(d)).toBeCloseTo(base.zeroRate(d) + 0.005, 10);
    }
  });
});
