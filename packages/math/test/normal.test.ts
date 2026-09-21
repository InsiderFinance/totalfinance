import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalCdf, normalInverseCdf, normalPdf } from '@totalfinance/math';

describe('normal: golden values', () => {
  it('pdf matches references', () => {
    expect(normalPdf(0)).toBeCloseTo(0.3989422804014327, 15);
    expect(normalPdf(1)).toBeCloseTo(0.24197072451914337, 15);
    expect(normalPdf(-1)).toBeCloseTo(0.24197072451914337, 15);
  });

  it('cdf matches references', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 15);
    expect(normalCdf(1)).toBeCloseTo(0.8413447460685429, 12);
    expect(normalCdf(-1)).toBeCloseTo(0.15865525393145707, 12);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 12);
    expect(normalCdf(2.5)).toBeCloseTo(0.9937903346742238, 12);
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980316300933, 12);
  });

  it('inv matches references and boundary behavior', () => {
    expect(normalInverseCdf(0.5)).toBeCloseTo(0, 12);
    expect(normalInverseCdf(0.975)).toBeCloseTo(1.959963984540054, 10);
    expect(normalInverseCdf(0.025)).toBeCloseTo(-1.959963984540054, 10);
    expect(normalInverseCdf(0)).toBe(-Infinity);
    expect(normalInverseCdf(1)).toBe(Infinity);
  });
});

describe('normal: properties', () => {
  it('property: cdf is monotonic non-decreasing', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -6, max: 6, noNaN: true }),
        fc.double({ min: 0, max: 6, noNaN: true }),
        (x, dx) => {
          expect(normalCdf(x + dx)).toBeGreaterThanOrEqual(normalCdf(x) - 1e-15);
        },
      ),
    );
  });

  it('property: reflection Φ(x) + Φ(-x) = 1', () => {
    fc.assert(
      fc.property(fc.double({ min: -8, max: 8, noNaN: true }), (x) => {
        expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 12);
      }),
    );
  });

  it('property: cdf(inverseCdf(p)) ≈ p', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-9, max: 1 - 1e-9, noNaN: true }), (p) => {
        expect(normalCdf(normalInverseCdf(p))).toBeCloseTo(p, 9);
      }),
    );
  });

  it('property: inverseCdf(cdf(x)) ≈ x', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 5, noNaN: true }), (x) => {
        expect(normalInverseCdf(normalCdf(x))).toBeCloseTo(x, 7);
      }),
    );
  });
});
