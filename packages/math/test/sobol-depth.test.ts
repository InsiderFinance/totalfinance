import { describe, expect, it } from 'vitest';
import { sobolSequence } from '../src/lowdiscrepancy.js';
import { sobolPrimitive } from '../src/sobol-data.js';

// The embedded Joe–Kuo (s, a) for dimensions 2..13 (dimension 1 is the all-ones direction). The
// generator must reproduce these exactly — that is the correctness anchor for the primitive-polynomial
// enumeration (WS9.5b).
const KNOWN: Array<{ s: number; a: number }> = [
  { s: 1, a: 0 }, // dimensions 2
  { s: 2, a: 1 }, // dimensions 3
  { s: 3, a: 1 }, // dimensions 4
  { s: 3, a: 2 }, // dimensions 5
  { s: 4, a: 1 }, // dimensions 6
  { s: 4, a: 4 }, // dimensions 7
  { s: 5, a: 2 }, // dimensions 8
  { s: 5, a: 4 }, // dimensions 9
  { s: 5, a: 7 }, // dimensions 10
  { s: 5, a: 11 }, // dimensions 11
  { s: 5, a: 13 }, // dimensions 12
  { s: 5, a: 14 }, // dimensions 13
];

describe('WS9.5b Sobol depth — generated primitive polynomials', () => {
  it('reproduces the embedded Joe–Kuo (s, a) for dimensions 2..13', () => {
    KNOWN.forEach((expected, i) => {
      expect(sobolPrimitive(i + 1)).toEqual(expected);
    });
  });

  it('generates in canonical order: degree non-decreasing, and correct primitive-polynomial counts', () => {
    // Primitive polynomials per degree over GF(2): deg 1→1, 2→1, 3→2, 4→2, 5→6, 6→6, 7→18.
    const byDegree = new Map<number, number>();
    let prevS = 0;
    for (let dimIndex = 1; dimIndex <= 36; dimIndex++) {
      const { s } = sobolPrimitive(dimIndex);
      expect(s).toBeGreaterThanOrEqual(prevS);
      prevS = s;
      byDegree.set(s, (byDegree.get(s) ?? 0) + 1);
    }
    expect(byDegree.get(1)).toBe(1);
    expect(byDegree.get(2)).toBe(1);
    expect(byDegree.get(3)).toBe(2);
    expect(byDegree.get(4)).toBe(2);
    expect(byDegree.get(5)).toBe(6);
    expect(byDegree.get(6)).toBe(6);
    expect(byDegree.get(7)).toBe(18);
  });

  it('lifts the 13-dimension cap: sobolSequence works at dimensions 50 and 200', () => {
    for (const dimensions of [50, 200]) {
      const pts = sobolSequence(64, dimensions);
      expect(pts).toHaveLength(64);
      expect(pts[0]).toEqual(new Array(dimensions).fill(0)); // index 0 is the origin
      for (const p of pts) {
        expect(p).toHaveLength(dimensions);
        expect(p.every((u) => u >= 0 && u < 1)).toBe(true);
      }
    }
  });

  it('every dimension is a balanced (0,1)-net: the first 2^k points split 50/50 about 0.5', () => {
    const k = 6;
    const pts = sobolSequence(2 ** k, 120);
    for (const d of [0, 13, 60, 119]) {
      const below = pts.filter((p) => p[d]! < 0.5).length;
      expect(below).toBe(2 ** (k - 1)); // exact stratification of the leading bit
    }
  });

  it('a Sobol dimension is more uniform than pseudo-random (lower star-discrepancy proxy in 1-D)', () => {
    // The 1-D Sobol coordinate covers [0,1) far more evenly than a uniform-random draw would.
    const n = 256;
    const pts = sobolSequence(n, 60);
    const coord = pts.map((p) => p[59]!).sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < coord.length; i++) maxGap = Math.max(maxGap, coord[i]! - coord[i - 1]!);
    expect(maxGap).toBeLessThan(2 / n); // Sobol's max spacing is ~1/n, far below a random 1/√n
  });
});
