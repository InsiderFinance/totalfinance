/**
 * Sticky-strike vs sticky-delta regime (`stickyRegime`). Verifies the measurement against synthetic
 * worlds with a KNOWN regime — a sticky-strike world reads β≈0 / s≈0, a sticky-moneyness world reads
 * β≈−skewSlope / s≈1 / high R², a blend reads intermediate — plus the sign works for an upside skew, a
 * flat/absent skewSlope is indeterminate, and a non-trivial placement on a weak regression is flagged.
 */

import { describe, expect, it } from 'vitest';
import { stickyRegime } from '@totalfinance/volatility';

const K = 100;

function normals(n: number, seed: number): number[] {
  let s = seed >>> 0;
  const u = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 0) / 2 ** 32;
  };
  return Array.from(
    { length: n },
    () => Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u()),
  );
}

/** A spot random walk. */
function spotPath(n: number, seed: number): number[] {
  const z = normals(n, seed);
  const spot = [100];
  for (let t = 1; t < n; t++) spot.push(spot[t - 1]! * Math.exp(0.01 * z[t]!));
  return spot;
}

describe('stickyRegime', () => {
  const n = 500;
  const spot = spotPath(n, 4);
  const skewSlope = -0.4; // a downside (put) skew

  it('recovers a sticky-strike world (β ≈ 0, s ≈ 0) without a weak-fit warning', () => {
    const noise = normals(n, 20);
    const fixedStrikeVolatility = spot.map((_, i) => 0.25 + 0.001 * noise[i]!); // fixed-strike vol constant
    const r = stickyRegime({ spot, fixedStrikeVolatility, skewSlope });
    expect(Math.abs(r.volatilitySpotBetaPerLogSpot)).toBeLessThan(0.05);
    expect(Math.abs(r.stickiness!)).toBeLessThan(0.2);
    expect(r.regime).toBe('sticky-strike');
    // A low R² is EXPECTED here (the vol doesn't respond to spot) — not flagged as weak.
    expect(r.diagnostics.warnings.some((w) => w.code === 'volatility.sticky_weak_fit')).toBe(false);
  });

  it('recovers a sticky-moneyness world (β ≈ −skewSlope, s ≈ 1, high R²)', () => {
    const noise = normals(n, 21);
    const fixedStrikeVolatility = spot.map(
      (S, i) => 0.25 + skewSlope * Math.log(K / S) + 0.0005 * noise[i]!,
    );
    const r = stickyRegime({ spot, fixedStrikeVolatility, skewSlope });
    expect(r.volatilitySpotBetaPerLogSpot).toBeCloseTo(-skewSlope, 1);
    expect(r.stickiness!).toBeCloseTo(1, 1);
    expect(r.rSquared).toBeGreaterThan(0.9);
    expect(r.regime).toBe('sticky-moneyness');
    expect(Math.abs(r.tStatistic)).toBeGreaterThan(2);
  });

  it('reads a 50/50 blend as intermediate (s ≈ 0.5)', () => {
    const noise = normals(n, 22);
    const ss = spot.map((_, i) => 0.25 + 0.001 * noise[i]!);
    const sm = spot.map((S, i) => 0.25 + skewSlope * Math.log(K / S) + 0.0005 * noise[i]!);
    const blend = spot.map((_, i) => 0.5 * ss[i]! + 0.5 * sm[i]!);
    const r = stickyRegime({ spot, fixedStrikeVolatility: blend, skewSlope });
    expect(r.stickiness!).toBeGreaterThan(0.3);
    expect(r.stickiness!).toBeLessThan(0.7);
    expect(r.regime).toBe('intermediate');
  });

  it('handles an upside skew (skewSlope > 0) with the same s = −β/skewSlope', () => {
    const up = 0.3;
    const noise = normals(n, 23);
    const sm = spot.map((S, i) => 0.25 + up * Math.log(K / S) + 0.0005 * noise[i]!);
    const r = stickyRegime({ spot, fixedStrikeVolatility: sm, skewSlope: up });
    expect(r.volatilitySpotBetaPerLogSpot).toBeCloseTo(-up, 1); // β = −skewSlope regardless of sign
    expect(r.stickiness!).toBeCloseTo(1, 1);
    expect(r.regime).toBe('sticky-moneyness');
  });

  it('is indeterminate without a skewSlope or with a flat smile', () => {
    const noise = normals(n, 24);
    const sm = spot.map((S, i) => 0.25 + skewSlope * Math.log(K / S) + 0.0005 * noise[i]!);
    const noRef = stickyRegime({ spot, fixedStrikeVolatility: sm }); // no skewSlope
    expect(noRef.stickiness).toBeNull();
    expect(noRef.regime).toBe('indeterminate');
    expect(
      noRef.diagnostics.warnings.some((w) => w.code === 'volatility.sticky_indeterminate'),
    ).toBe(true);
    // The raw beta is still reported even without a reference.
    expect(noRef.volatilitySpotBetaPerLogSpot).toBeCloseTo(-skewSlope, 1);

    const flat = stickyRegime({ spot, fixedStrikeVolatility: sm, skewSlope: 0 });
    expect(flat.stickiness).toBeNull();
    expect(flat.regime).toBe('indeterminate');
  });

  it('flags a non-trivial placement resting on a weak (low-R²) regression', () => {
    const noise = normals(n, 25);
    // A sticky-moneyness signal buried in heavy idiosyncratic noise: β stays ≈ −skewSlope (unbiased),
    // so the placement is still sticky-moneyness, but R² collapses ⇒ the weak-fit caution fires.
    const sm = spot.map((S, i) => 0.25 + skewSlope * Math.log(K / S) + 0.02 * noise[i]!);
    const r = stickyRegime({ spot, fixedStrikeVolatility: sm, skewSlope });
    expect(r.rSquared).toBeLessThan(0.1);
    expect(r.regime).not.toBe('sticky-strike');
    expect(r.diagnostics.warnings.some((w) => w.code === 'volatility.sticky_weak_fit')).toBe(true);
  });

  it('guards misaligned, too-short, and non-positive inputs', () => {
    expect(() => stickyRegime(undefined as never)).toThrowError();
    expect(() => stickyRegime({ spot: [100, 101], fixedStrikeVolatility: [0.2] })).toThrowError(); // misaligned
    expect(() =>
      stickyRegime({ spot: [100, 101, 102], fixedStrikeVolatility: [0.2, 0.2, 0.2] }),
    ).toThrowError(); // < 4 obs
    expect(() =>
      stickyRegime({ spot: [100, 101, 102, -1], fixedStrikeVolatility: [0.2, 0.2, 0.2, 0.2] }),
    ).toThrowError(); // non-positive spot
    expect(() =>
      stickyRegime({
        spot: [100, 101, 102, 103],
        fixedStrikeVolatility: [0.2, 0.2, 0.2, 0],
        skewSlope: -0.3,
      }),
    ).toThrowError(); // non-positive vol
  });
});
