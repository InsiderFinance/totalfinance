/**
 * Sobol direction-number extension (spec §8, WS9.5b).
 *
 * The base Sobol table in `./lowdiscrepancy` embeds the Joe–Kuo initial direction numbers for the
 * first 13 dimensions. To lift that cap — which contradicted the module's own Brownian-bridge guidance
 * (a bridged path needs one Sobol dimension per step) — this module GENERATES the primitive
 * polynomials over GF(2) for higher dimensions, in the same canonical order Joe–Kuo use (by degree,
 * then by increasing coefficient encoding). The generation is exact and reproducible, so no direction
 * number is ever fabricated.
 *
 * Initial direction numbers for the generated dimensions use the valid unit initialization
 * (`mᵢ = 1`): every `mᵢ` is odd and `< 2ⁱ`, which is the sufficient-and-necessary condition for a
 * well-defined Sobol sequence. These are NOT the Joe–Kuo *optimized* `mᵢ` (which minimize 2-D
 * projection discrepancy and require vendoring their `new-joe-kuo-6.21201` data file); the sequence is
 * a valid (t, s)-net, just not projection-optimized in the extended dimensions. Dimensions 1–13 are
 * untouched and keep the Joe–Kuo optimized values.
 */

import { ErrorCode, InputError } from '@totalfinance/core';

/** A primitive polynomial in the Sobol parameterization: degree `s` and coefficient encoding `a`. */
export interface SobolPrimitive {
  s: number;
  a: number;
}

// ── GF(2) polynomial arithmetic on 32-bit bitmask representations (bit i = coefficient of xⁱ) ──

/** Carry-less (GF(2)) multiply of two bitmask polynomials. */
function clmul(a: number, b: number): number {
  let r = 0;
  let x = a;
  let y = b;
  while (y > 0) {
    if (y & 1) r ^= x;
    x <<= 1;
    y >>>= 1;
  }
  return r >>> 0;
}

/** Degree of a bitmask polynomial (−1 for the zero polynomial). */
function degree(p: number): number {
  return p === 0 ? -1 : 31 - Math.clz32(p);
}

/** `a mod m` for GF(2) bitmask polynomials. */
function polyMod(a: number, m: number): number {
  let r = a >>> 0;
  const dm = degree(m);
  let dr = degree(r);
  while (dr >= dm && r !== 0) {
    r ^= m << (dr - dm);
    r >>>= 0;
    dr = degree(r);
  }
  return r >>> 0;
}

/** `(a · b) mod m`. */
function mulMod(a: number, b: number, m: number): number {
  return polyMod(clmul(a, b), m);
}

/** `x^e mod m` by repeated squaring (`e` a non-negative integer). */
function powXMod(e: number, m: number): number {
  let result = polyMod(1, m);
  let base = polyMod(2, m); // x
  let exp = e;
  while (exp > 0) {
    if (exp & 1) result = mulMod(result, base, m);
    base = mulMod(base, base, m);
    exp = Math.floor(exp / 2);
  }
  return result;
}

/** GCD of two GF(2) bitmask polynomials. */
function polyGcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const r = polyMod(x, y);
    x = y;
    y = r;
  }
  return x;
}

/** Distinct prime factors of `n` (n small — trial division). */
function primeFactors(n: number): number[] {
  const out: number[] = [];
  let m = n;
  for (let p = 2; p * p <= m; p++) {
    if (m % p === 0) {
      out.push(p);
      while (m % p === 0) m = Math.floor(m / p);
    }
  }
  if (m > 1) out.push(m);
  return out;
}

/**
 * Is the degree-`d` bitmask polynomial `poly` (with constant term 1) primitive over GF(2)? Primitive
 * ⟺ irreducible (Rabin's test) AND the multiplicative order of `x` modulo `poly` is `2^d − 1`.
 */
function isPrimitive(poly: number, d: number): boolean {
  const twoD = 2 ** d;
  // Irreducibility: x^(2^d) ≡ x, and gcd(x^(2^(d/p)) − x, poly) = 1 for each prime p | d.
  if (powXMod(twoD, poly) !== polyMod(2, poly)) return false;
  for (const p of primeFactors(d)) {
    const xq = powXMod(2 ** (d / p), poly);
    if (degree(polyGcd(xq ^ polyMod(2, poly), poly)) > 0) return false;
  }
  // Primitivity: order of x is 2^d − 1 ⟺ x^((2^d−1)/q) ≠ 1 for each prime q | (2^d − 1).
  const order = twoD - 1;
  for (const q of primeFactors(order)) {
    if (powXMod(order / q, poly) === 1) return false;
  }
  return true;
}

/** The Joe–Kuo coefficient encoding `a` for a primitive polynomial (its middle bits, excl. x^d & 1). */
function encodeA(poly: number, d: number): number {
  return (poly >>> 1) & ((1 << (d - 1)) - 1);
}

// Memoized list of primitive polynomials in Joe–Kuo canonical order, starting at DIMENSION 2 (index 0).
// Dimension 1 is the all-ones direction and needs no polynomial.
let CACHE: SobolPrimitive[] = [];

/** Generate primitive polynomials in canonical order until at least `count` (dims 2..count+1) exist. */
function ensurePrimitives(count: number): void {
  if (CACHE.length >= count) return;
  const list: SobolPrimitive[] = [];
  // Degree 1 first (x + 1), then each higher degree by increasing polynomial value.
  for (let d = 1; list.length < count; d++) {
    const lead = 1 << d; // x^d
    // Candidate = x^d + (middle bits) + 1; iterate middle bits in increasing value for canonical order.
    for (let mid = 0; mid < 1 << Math.max(0, d - 1); mid++) {
      const poly = (lead | (mid << 1) | 1) >>> 0;
      if (isPrimitive(poly, d)) {
        list.push({ s: d, a: encodeA(poly, d) });
        if (list.length >= count) break;
      }
    }
  }
  CACHE = list;
}

/**
 * The primitive polynomial `{ s, a }` for Sobol `dimIndex` (0-based; `dimIndex = 1` is dimension 2 —
 * dimension 1 needs none). Generated on demand and memoized. `dimIndex` must be ≥ 1.
 */
export function sobolPrimitive(dimIndex: number): SobolPrimitive {
  // Safe integer AND a domain cap (2026-08-23 review, P0 "unbounded work"): `ensurePrimitives`
  // enumerates and primitivity-tests polynomials until the cache holds `dimIndex` entries, a cost
  // that grows exponentially with polynomial degree — `Number.isInteger(1e308)` passing here was an
  // unbounded synchronous search (and an unbounded cache). The library's Sobol construction stops at
  // SOBOL_GENERATED_MAX_DIM dimensions, so the last dimIndex it can ever consume is
  // SOBOL_GENERATED_MAX_DIM − 1 (dimIndex is 0-based-plus-one: dimIndex d is dimension d + 1) —
  // a primitive beyond that serves no dimension this library can emit.
  if (!Number.isSafeInteger(dimIndex) || dimIndex < 1 || dimIndex > SOBOL_GENERATED_MAX_DIM - 1) {
    throw new InputError(
      `sobolPrimitive: dimIndex must be an integer in [1, ${SOBOL_GENERATED_MAX_DIM - 1}] (dimIndex d supplies Sobol dimension d + 1, and this build generates at most ${SOBOL_GENERATED_MAX_DIM} dimensions — primitive-polynomial search cost grows exponentially with degree, so an open-ended index is an unbounded computation). Received ${dimIndex}.\n  e.g. sobolPrimitive(13)`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { dimIndex, max: SOBOL_GENERATED_MAX_DIM - 1 },
      },
    );
  }
  ensurePrimitives(dimIndex);
  return CACHE[dimIndex - 1]!;
}

/** Valid unit initial direction numbers (`mᵢ = 1`) of length `s` for a generated dimension. */
export function sobolInitialM(s: number): number[] {
  return new Array<number>(s).fill(1);
}

/**
 * The highest Sobol dimension this generator will produce. Bounded by the 32-bit direction-number
 * width: degrees up to 27 keep every intermediate GF(2) product within 32 bits, which is far more
 * dimensions than any Brownian-bridge path needs.
 */
export const SOBOL_GENERATED_MAX_DIM = 1111;
