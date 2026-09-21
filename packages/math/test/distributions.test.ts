import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  chiSquare,
  gamma,
  lgamma,
  normalCdf,
  normalInverseCdf,
  regularizedBeta,
  studentT,
} from '@totalfinance/math';

describe('lgamma (Lanczos)', () => {
  it('matches exact factorials: lnΓ(n) = ln((n-1)!)', () => {
    // HAND-COMPUTED: Γ(1)=Γ(2)=1 ⇒ 0; Γ(5)=4!=24; Γ(6)=5!=120.
    expect(lgamma(1)).toBeCloseTo(0, 12);
    expect(lgamma(2)).toBeCloseTo(0, 12);
    expect(lgamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(lgamma(6)).toBeCloseTo(Math.log(120), 12);
  });

  it('Γ(1/2) = √π ⇒ lnΓ(0.5) = ½·ln(π) (reflection branch)', () => {
    expect(lgamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 12);
    expect(lgamma(1.5)).toBeCloseTo(Math.log(0.5 * Math.sqrt(Math.PI)), 12); // Γ(1.5)=½√π
  });
});

describe('studentT', () => {
  it('cdf(0, df) = 0.5 exactly by symmetry (HAND-COMPUTED)', () => {
    for (const df of [1, 2, 5, 10, 30, 1000]) {
      expect(studentT.cdf(0, df)).toBeCloseTo(0.5, 12);
    }
  });

  it('df=1 is Cauchy: cdf(1,1)=0.75, cdf(-1,1)=0.25 (HAND-COMPUTED)', () => {
    expect(studentT.cdf(1, 1)).toBeCloseTo(0.75, 10);
    expect(studentT.cdf(-1, 1)).toBeCloseTo(0.25, 10);
    // General Cauchy cdf: 0.5 + atan(x)/π.
    expect(studentT.cdf(2, 1)).toBeCloseTo(0.5 + Math.atan(2) / Math.PI, 10);
  });

  it('df→∞ converges to the standard normal (cross-check vs normalCdf)', () => {
    expect(studentT.cdf(1.96, 1e6)).toBeCloseTo(normalCdf(1.96), 5);
    expect(studentT.cdf(1.96, 1e6)).toBeCloseTo(0.975, 4);
    expect(studentT.cdf(-0.5, 1e7)).toBeCloseTo(normalCdf(-0.5), 5);
  });

  it('inv is the CDF inverse; inverseCdf(0.975, huge df) ≈ 1.96', () => {
    expect(studentT.inverseCdf(0.975, 1e6)).toBeCloseTo(normalInverseCdf(0.975), 3);
    expect(studentT.inverseCdf(0.975, 1e6)).toBeCloseTo(1.96, 2);
    // Round-trip across df and probabilities.
    for (const df of [1, 3, 8, 40]) {
      for (const x of [-2.5, -0.7, 0.3, 1.4, 3.1]) {
        expect(studentT.inverseCdf(studentT.cdf(x, df), df)).toBeCloseTo(x, 6);
      }
    }
  });

  it('pdf ≥ 0 and symmetric; sf = 1 − cdf', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.integer({ min: 1, max: 200 }),
        (x, df) => {
          expect(studentT.pdf(x, df)).toBeGreaterThanOrEqual(0);
          expect(studentT.pdf(x, df)).toBeCloseTo(studentT.pdf(-x, df), 12);
          expect(studentT.survivalFunction(x, df)).toBeCloseTo(1 - studentT.cdf(x, df), 12);
        },
      ),
    );
  });

  it('cdf is monotone increasing', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -30, max: 30, noNaN: true }),
        fc.double({ min: 0.01, max: 10, noNaN: true }),
        fc.integer({ min: 1, max: 100 }),
        (x, step, df) => {
          expect(studentT.cdf(x + step, df)).toBeGreaterThanOrEqual(studentT.cdf(x, df) - 1e-12);
        },
      ),
    );
  });

  it('regularizedBeta symmetry Iₓ(a,b) = 1 − I_{1−x}(b,a)', () => {
    expect(regularizedBeta(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 10); // arcsine at ½
    expect(regularizedBeta(2, 3, 0.4)).toBeCloseTo(1 - regularizedBeta(3, 2, 0.6), 12);
  });
});

describe('chiSquare', () => {
  it('df=2 has the closed form cdf(x,2) = 1 − e^(−x/2) (HAND-COMPUTED)', () => {
    for (const x of [0.5, 1, 2, 4, 9]) {
      expect(chiSquare.cdf(x, 2)).toBeCloseTo(1 - Math.exp(-x / 2), 12);
    }
  });

  it('cdf(0)=0, monotone, and inv round-trips', () => {
    expect(chiSquare.cdf(0, 5)).toBe(0);
    for (const df of [1, 3, 7, 20]) {
      for (const p of [0.05, 0.25, 0.5, 0.9, 0.99]) {
        const x = chiSquare.inverseCdf(p, df);
        expect(chiSquare.cdf(x, df)).toBeCloseTo(p, 8);
      }
    }
  });

  it('median-ish check: inverseCdf(1−e^(−x/2), 2) recovers x', () => {
    const x = 3.3;
    expect(chiSquare.inverseCdf(1 - Math.exp(-x / 2), 2)).toBeCloseTo(x, 8);
  });
});

describe('gamma', () => {
  it('k=1 is exponential: cdf(x,1,θ) = 1 − e^(−x/θ) (HAND-COMPUTED)', () => {
    for (const x of [0.3, 1, 2.5]) {
      expect(gamma.cdf(x, 1, 1)).toBeCloseTo(1 - Math.exp(-x), 12);
      expect(gamma.cdf(x, 1, 2)).toBeCloseTo(1 - Math.exp(-x / 2), 12);
    }
  });

  it('chi-square(df) equals gamma(k=df/2, θ=2)', () => {
    for (const df of [2, 5, 11]) {
      for (const x of [1, 4, 8]) {
        expect(gamma.cdf(x, df / 2, 2)).toBeCloseTo(chiSquare.cdf(x, df), 12);
      }
    }
  });

  it('inv round-trips and respects the scale', () => {
    for (const k of [0.5, 1, 2.5, 7]) {
      for (const theta of [0.5, 1, 3]) {
        for (const p of [0.1, 0.5, 0.95]) {
          const x = gamma.inverseCdf(p, k, theta);
          expect(gamma.cdf(x, k, theta)).toBeCloseTo(p, 8);
        }
      }
    }
  });
});

describe('validation', () => {
  it('rejects non-positive df / shape and out-of-range probabilities', () => {
    expect(() => studentT.cdf(0, 0)).toThrow();
    expect(() => studentT.inverseCdf(1.2, 5)).toThrow();
    expect(() => chiSquare.inverseCdf(-0.1, 3)).toThrow();
    expect(() => gamma.cdf(1, -2)).toThrow();
    expect(() => gamma.cdf(1, 2, 0)).toThrow();
  });
});
