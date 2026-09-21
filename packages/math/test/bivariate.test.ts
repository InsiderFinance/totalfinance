import { describe, expect, it } from 'vitest';
import { bivariateNormalCdf, normalCdf } from '@totalfinance/math';

describe('bivariateNormalCdf', () => {
  it('reduces to a product of marginals when rho = 0', () => {
    for (const a of [-2, -0.5, 0, 1, 2.5]) {
      for (const b of [-1.5, 0, 0.7, 3]) {
        expect(bivariateNormalCdf(a, b, 0)).toBeCloseTo(normalCdf(a) * normalCdf(b), 12);
      }
    }
  });

  it('matches the closed form Φ₂(0,0;ρ) = 1/4 + asin(ρ)/(2π)', () => {
    for (const rho of [-0.9, -0.5, -0.2, 0.1, 0.3, 0.6, 0.85, 0.95]) {
      const expected = 0.25 + Math.asin(rho) / (2 * Math.PI);
      expect(bivariateNormalCdf(0, 0, rho)).toBeCloseTo(expected, 10);
    }
  });

  it('collapses to a single marginal at the correlation extremes', () => {
    // ρ = +1: P(X≤a, Y≤b) = Φ(min(a,b))
    expect(bivariateNormalCdf(0.4, 1.2, 1)).toBeCloseTo(normalCdf(0.4), 9);
    expect(bivariateNormalCdf(1.2, 0.4, 1)).toBeCloseTo(normalCdf(0.4), 9);
    // ρ = -1: P(X≤a, Y≤b) = max(0, Φ(a) + Φ(b) − 1)
    expect(bivariateNormalCdf(0.5, 0.5, -1)).toBeCloseTo(Math.max(0, 2 * normalCdf(0.5) - 1), 9);
    expect(bivariateNormalCdf(-0.5, -0.5, -1)).toBeCloseTo(0, 9);
  });

  it('integrates to the marginal as the other limit → ∞', () => {
    for (const rho of [-0.7, 0.2, 0.8]) {
      expect(bivariateNormalCdf(0.8, Infinity, rho)).toBeCloseTo(normalCdf(0.8), 12);
      expect(bivariateNormalCdf(Infinity, -0.3, rho)).toBeCloseTo(normalCdf(-0.3), 12);
      expect(bivariateNormalCdf(-Infinity, 1, rho)).toBe(0);
    }
  });

  it('is symmetric in its arguments: Φ₂(a,b;ρ) = Φ₂(b,a;ρ)', () => {
    expect(bivariateNormalCdf(0.3, -1.1, 0.4)).toBeCloseTo(bivariateNormalCdf(-1.1, 0.3, 0.4), 12);
    expect(bivariateNormalCdf(1.5, 0.2, -0.6)).toBeCloseTo(bivariateNormalCdf(0.2, 1.5, -0.6), 12);
  });

  it('reflection identity: Φ₂(a,b;ρ) + Φ₂(a,−b;−ρ) = Φ(a)', () => {
    for (const [a, b, rho] of [
      [0.5, 0.3, 0.4],
      [-0.7, 1.2, -0.55],
      [2, -1, 0.9],
    ] as const) {
      expect(bivariateNormalCdf(a, b, rho) + bivariateNormalCdf(a, -b, -rho)).toBeCloseTo(
        normalCdf(a),
        10,
      );
    }
  });

  it('matches a high-accuracy independent quadrature oracle', () => {
    // Values verified to 10 digits against Simpson integration of φ(x)·Φ((b−ρx)/√(1−ρ²)).
    expect(bivariateNormalCdf(-1, -1, 0.5)).toBeCloseTo(0.0625140947, 9);
    expect(bivariateNormalCdf(1, 1, -0.5)).toBeCloseTo(0.6864717942, 9);
    expect(bivariateNormalCdf(-2, 1, 0.3)).toBeCloseTo(0.0219058155, 9);
    expect(bivariateNormalCdf(2, -1, 0.9)).toBeCloseTo(0.1586552539, 9);
    expect(bivariateNormalCdf(-0.7, 1.2, -0.55)).toBeCloseTo(0.1726432456, 9);
  });

  it('returns NaN for invalid inputs', () => {
    expect(bivariateNormalCdf(NaN, 0, 0.5)).toBeNaN();
    expect(bivariateNormalCdf(0, 0, 1.5)).toBeNaN();
    expect(bivariateNormalCdf(0, 0, -1.01)).toBeNaN();
  });
});
