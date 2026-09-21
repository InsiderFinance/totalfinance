/**
 * Low-discrepancy (quasi-random) sequences for quasi-Monte Carlo (spec §8.6).
 *
 * Halton (radical inverse over the first primes) and Sobol (Gray-code construction with Joe–Kuo
 * direction numbers). These fill the unit hypercube more evenly than pseudo-random points, giving
 * faster QMC convergence.
 */

import { ensureKnownKeys, requireArgumentObject, ErrorCode, InputError } from '@totalfinance/core';
import { SOBOL_GENERATED_MAX_DIM, sobolInitialM, sobolPrimitive } from './sobol-data.js';

const PRIMES = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
];

/**
 * The most points one sequence call will materialize (2026-08-23 review, P0 "unbounded work"):
 * `Number.isInteger(1e308)` is `true`, so the old checks let a "count" reach `new Array(count)` as a
 * raw RangeError or a multi-gigabyte allocation. 2^24 points is a natural QMC ceiling — Sobol nets
 * are balanced at powers of two, QMC error ~ (log n)^d / n has long since flattened, and the
 * options-package Monte-Carlo front end (whose sobol path requests `paths + 1` points) stays
 * comfortably inside it.
 */
const MAX_SEQUENCE_POINTS = 16_777_216; // 2^24

/**
 * The most CELLS (count × dimensions doubles) one sequence call will materialize (2026-08-23 review,
 * P0): the two factors multiply into the real allocation, so each alone being under its cap proves
 * nothing — 2^24 points × 1,111 Sobol dimensions would be 149 GB. 2^26 cells is ~0.5 GB of packed
 * doubles generated in ~1–3 s, the most a synchronous call should materialize.
 */
const MAX_SEQUENCE_CELLS = 67_108_864; // 2^26

function radicalInverse(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** Halton point at `index` in `dimensions` dimensions. */
export function haltonPoint(index: number, dimensions: number): number[] {
  // Safe integer (2026-08-23 review, P0): above 2^53 an "index" is no longer exact, so the radical
  // inverse would be computed for a number the caller never had — a silently wrong point, not an error.
  if (!Number.isSafeInteger(index) || index < 0)
    throw new InputError(`haltonPoint: index must be a non-negative integer, got ${index}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { index },
    });
  if (!Number.isSafeInteger(dimensions) || dimensions < 1)
    throw new InputError(`haltonPoint: dimensions must be a positive integer, got ${dimensions}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { dimensions },
    });
  if (dimensions > PRIMES.length)
    throw new InputError(`haltonPoint: dimensions ${dimensions} exceeds ${PRIMES.length}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { dimensions, max: PRIMES.length },
    });
  return Array.from({ length: dimensions }, (_, k) => radicalInverse(index, PRIMES[k]!));
}

/** Halton sequence of `n` points in `dimensions` dimensions, starting at `start` (default 1, skips origin). */
export function haltonSequence(
  count: number,
  dimensions: number,
  options: { start?: number } = {},
): number[][] {
  requireArgumentObject('haltonSequence', 'options', options);
  ensureKnownKeys('haltonSequence', 'options', options, ['start']);
  if (
    options.start !== undefined &&
    (typeof options.start !== 'number' || !Number.isFinite(options.start))
  ) {
    throw new InputError(
      `haltonSequence: start must be a finite number when provided. Received ${options.start === null ? 'null' : typeof options.start}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'start' } },
    );
  }
  // Safe integer AND caps (2026-08-23 review, P0): see MAX_SEQUENCE_POINTS / MAX_SEQUENCE_CELLS —
  // the old `Number.isInteger` checks let 1e308 through to the allocator.
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_SEQUENCE_POINTS)
    throw new InputError(
      `haltonSequence: count must be an integer in [0, ${MAX_SEQUENCE_POINTS.toLocaleString('en-US')}] — every point is materialized (one array per point), and QMC error ~ (log n)^d / n has long flattened by 2^24 points. Received ${count}.\n  e.g. haltonSequence(1_024, 2)`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { count, max: MAX_SEQUENCE_POINTS },
      },
    );
  if (!Number.isSafeInteger(dimensions) || dimensions < 1)
    throw new InputError(
      `haltonSequence: dimensions must be a positive integer, got ${dimensions}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { dimensions },
      },
    );
  // The PRODUCT is the allocation (count × dimensions doubles) — bound it even when each factor
  // alone is under its cap (2026-08-23 review, P0: multiplying counts must be bounded together).
  if (count * dimensions > MAX_SEQUENCE_CELLS)
    throw new InputError(
      `haltonSequence: count × dimensions must not exceed ${MAX_SEQUENCE_CELLS.toLocaleString('en-US')} cells (~0.5 GB of doubles, generated in ~1–3 s) — the whole matrix is materialized, so the product is the allocation. Received ${count} × ${dimensions} = ${(count * dimensions).toLocaleString('en-US')}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { count, dimensions, maxCells: MAX_SEQUENCE_CELLS },
      },
    );
  const start = options.start ?? 1;
  const out: number[][] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = haltonPoint(start + i, dimensions);
  return out;
}

// Joe–Kuo direction-number initialization for Sobol dimensions 2.. (dimension 1 is all 1s).
interface SobolInit {
  s: number;
  a: number;
  m: number[];
}
const SOBOL_INIT: SobolInit[] = [
  { s: 1, a: 0, m: [1] },
  { s: 2, a: 1, m: [1, 1] },
  { s: 3, a: 1, m: [1, 3, 7] },
  { s: 3, a: 2, m: [1, 1, 5] },
  { s: 4, a: 1, m: [1, 1, 3, 3] },
  { s: 4, a: 4, m: [1, 3, 5, 13] },
  { s: 5, a: 2, m: [1, 1, 5, 5, 17] },
  { s: 5, a: 4, m: [1, 1, 5, 5, 5] },
  { s: 5, a: 7, m: [1, 1, 7, 11, 19] },
  { s: 5, a: 11, m: [1, 1, 5, 1, 1] },
  { s: 5, a: 13, m: [1, 1, 1, 3, 11] },
  { s: 5, a: 14, m: [1, 3, 5, 5, 31] },
];
// Dimensions 1–13 use the embedded Joe–Kuo optimized initial direction numbers above; higher
// dimensions are generated on demand (canonical primitive polynomials + valid unit initialization),
// lifting the old 13-dimension cap that contradicted the Brownian-bridge guidance (WS9.5b).
const SOBOL_MAX_DIMENSIONS = SOBOL_GENERATED_MAX_DIM;
const BITS = 32;

function directionNumbers(dimIndex: number): Uint32Array {
  const V = new Uint32Array(BITS + 1); // 1-indexed
  if (dimIndex === 0) {
    for (let k = 1; k <= BITS; k++) V[k] = (1 << (BITS - k)) >>> 0;
    return V;
  }
  // Embedded Joe–Kuo table for the first dimensions; generated primitives (unit `m`) beyond it.
  let s: number;
  let a: number;
  let m: number[];
  if (dimIndex <= SOBOL_INIT.length) {
    ({ s, a, m } = SOBOL_INIT[dimIndex - 1]!);
  } else {
    ({ s, a } = sobolPrimitive(dimIndex));
    m = sobolInitialM(s);
  }
  for (let k = 1; k <= s; k++) V[k] = (m[k - 1]! << (BITS - k)) >>> 0;
  for (let k = s + 1; k <= BITS; k++) {
    let val = V[k - s]! ^ (V[k - s]! >>> s);
    for (let j = 1; j <= s - 1; j++) {
      if ((a >>> (s - 1 - j)) & 1) val ^= V[k - j]!;
    }
    V[k] = val >>> 0;
  }
  return V;
}

function lowestSetBit(i: number): number {
  let c = 1;
  let x = i;
  while ((x & 1) === 0) {
    x >>>= 1;
    c++;
  }
  return c;
}

/**
 * Sobol sequence of `n` points in `dimensions` dimensions (indices `0..n-1`; index 0 is the origin). The
 * first `2^m` points form a regular `(0, m, dim)`-net.
 */
export function sobolSequence(count: number, dimensions: number): number[][] {
  // Safe integer AND caps (2026-08-23 review, P0): see MAX_SEQUENCE_POINTS / MAX_SEQUENCE_CELLS —
  // the old `Number.isInteger` checks let 1e308 through to the allocator.
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_SEQUENCE_POINTS)
    throw new InputError(
      `sobolSequence: count must be an integer in [0, ${MAX_SEQUENCE_POINTS.toLocaleString('en-US')}] — every point is materialized (one array per point), Sobol nets are balanced at powers of two, and QMC error ~ (log n)^d / n has long flattened by 2^24 points. Received ${count}.\n  e.g. sobolSequence(1_024, 2)`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { count, max: MAX_SEQUENCE_POINTS },
      },
    );
  if (!Number.isSafeInteger(dimensions) || dimensions < 1)
    throw new InputError(
      `sobolSequence: dimensions must be a positive integer, got ${dimensions}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { dimensions },
      },
    );
  // The PRODUCT is the allocation (count × dimensions doubles) — bound it even when each factor
  // alone is under its cap (2026-08-23 review, P0: multiplying counts must be bounded together;
  // 2^24 points × 1,111 dimensions would be 149 GB).
  if (count * dimensions > MAX_SEQUENCE_CELLS)
    throw new InputError(
      `sobolSequence: count × dimensions must not exceed ${MAX_SEQUENCE_CELLS.toLocaleString('en-US')} cells (~0.5 GB of doubles, generated in ~1–3 s) — the whole matrix is materialized, so the product is the allocation. Received ${count} × ${dimensions} = ${(count * dimensions).toLocaleString('en-US')}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { count, dimensions, maxCells: MAX_SEQUENCE_CELLS },
      },
    );
  if (dimensions > SOBOL_MAX_DIMENSIONS)
    throw new InputError(
      `sobolSequence: dimensions ${dimensions} exceeds ${SOBOL_MAX_DIMENSIONS}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { dimensions, max: SOBOL_MAX_DIMENSIONS },
      },
    );
  if (count === 0) return [];
  const V: Uint32Array[] = Array.from({ length: dimensions }, (_, d) => directionNumbers(d));
  const X = new Uint32Array(dimensions);
  const out: number[][] = new Array(count);
  out[0] = new Array(dimensions).fill(0);
  for (let i = 1; i < count; i++) {
    const c = lowestSetBit(i);
    const point = new Array<number>(dimensions);
    for (let d = 0; d < dimensions; d++) {
      X[d] = (X[d]! ^ V[d]![c]!) >>> 0;
      point[d] = X[d]! / 4294967296;
    }
    out[i] = point;
  }
  return out;
}

export { SOBOL_MAX_DIMENSIONS };
