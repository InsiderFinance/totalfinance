/**
 * Seedable pseudo-random numbers and resampling (spec §8.6).
 *
 * Rule: every stochastic API accepts a seed and echoes it. The PRNG is deterministic given a seed,
 * so simulations and bootstraps are fully reproducible.
 */

import { ensureKnownKeys, requireArgumentObject, ErrorCode, InputError } from '@totalfinance/core';
import { mean, quantile, standardDeviation } from './statistics.js';

/**
 * The most samples one `uniformSamples` / `stratifiedUniforms` call will materialize (2026-08-23
 * review, P0 "unbounded work"): `Number.isInteger(1e308)` is `true`, so the old check let a count of
 * 1e308 reach `new Float64Array(count)` — a raw `RangeError: Invalid typed array length` that names
 * neither the function nor the argument — and a count between 2^32 and 2^53 requested a multi-gigabyte
 * allocation as if it were routine. 10^8 doubles is 0.8 GB and was measured at ~9 ns/sample to fill
 * (~0.9 s) — the largest allocation a synchronous call should make, and far past any Monte-Carlo
 * budget that would consume the samples afterwards.
 */
const MAX_SAMPLE_COUNT = 100_000_000;

/**
 * The most bootstrap resamples one call will run (2026-08-23 review, P0 "unbounded work"): each
 * iteration redraws ALL n data points and evaluates the statistic, so total work is
 * `iterations × n` — at the cap with a modest n = 1,000 that is 10^9 element draws, already several
 * seconds. Percentile confidence intervals stabilize by 10^4–10^5 replications (Efron & Tibshirani's
 * guidance), so 10^6 is an order of magnitude beyond practice, not a limit anyone meets.
 */
const MAX_BOOTSTRAP_ITERATIONS = 1_000_000;

/**
 * Serializable PRNG state — restore an RNG mid-stream with `restoreRandomNumberGenerator`.
 *
 * A DISCRIMINATED UNION, because `algorithm: string` with `state: number[]` declared something the
 * runtime does not accept: every string was a legal algorithm and every length a legal state, while
 * the implementation admits exactly two algorithms and a fixed word count for each. A caller reading
 * the type could not tell that `{ algorithm: 'mt19937', state: [] }` is unusable, and the harness
 * could not either — it filed the refusal as a boundary that rejects valid input.
 *
 * The state word counts are part of the contract, not an implementation note: mulberry32 carries one
 * 32-bit word, xoshiro128** carries four. Tuple types state that, so the length check below is a
 * restatement of the declaration rather than a rule that lives only in the runtime.
 */
export type RandomNumberGeneratorState =
  | { algorithm: 'mulberry32'; state: [number]; seed: number }
  | { algorithm: 'xoshiro128ss'; state: [number, number, number, number]; seed: number };

/**
 * The algorithms a snapshot may name. Deliberately NOT exported: its only job is to keep the
 * unknown-algorithm error in step with the union above, and a new public export has to earn its
 * place — this one would add a manifest entry, a naming identity and a curation obligation to say
 * something the type already says.
 */
const RANDOM_NUMBER_GENERATOR_ALGORITHMS = ['mulberry32', 'xoshiro128ss'] as const;

export interface RandomNumberGenerator {
  /** Uniform sample in [0, 1). */
  next(): number;
  /** The seed this generator was created with (echoed for reproducibility). */
  readonly seed: number;
  /** Snapshot the current internal state for exact restoration. */
  getState(): RandomNumberGeneratorState;
}

function makeMulberry32(a0: number, seed: number): RandomNumberGenerator {
  let a = a0 >>> 0;
  return {
    seed,
    next(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    getState: () => ({ algorithm: 'mulberry32', state: [a >>> 0], seed }),
  };
}

/**
 * Mulberry32 — a small, fast, well-distributed seedable PRNG.
 *
 * The state is seeded with `seed >>> 0` (the algorithm is 32-bit), but the ECHOED `seed` is the
 * caller's literal argument: a run seeded with `-1` is reproduced by passing `-1`, and reporting
 * `4294967295` back would send a reader looking for a seed they never used.
 */
export function mulberry32(seed: number): RandomNumberGenerator {
  return makeMulberry32(seed >>> 0, seed);
}

function splitmix32(seed: number): () => number {
  let z = seed >>> 0;
  return () => {
    z = (z + 0x9e3779b9) >>> 0;
    let x = z;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    return (x ^ (x >>> 15)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function makeXoshiro128(
  s0: number,
  s1: number,
  s2: number,
  s3: number,
  seed: number,
): RandomNumberGenerator {
  let a = s0 >>> 0;
  let b = s1 >>> 0;
  let c = s2 >>> 0;
  let d = s3 >>> 0;
  return {
    seed,
    next(): number {
      const result = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
      const t = (b << 9) >>> 0;
      c ^= a;
      d ^= b;
      b ^= c;
      a ^= d;
      c ^= t;
      d = rotl(d, 11);
      return result / 4294967296;
    },
    getState: () => ({
      algorithm: 'xoshiro128ss',
      state: [a >>> 0, b >>> 0, c >>> 0, d >>> 0],
      seed,
    }),
  };
}

/**
 * xoshiro128** — a higher-quality seedable PRNG (longer period, better statistical properties).
 * As with {@link mulberry32}, the state is derived from `seed >>> 0` but the caller's literal `seed`
 * is echoed.
 */
export function xoshiro128ss(seed: number): RandomNumberGenerator {
  const sm = splitmix32(seed);
  return makeXoshiro128(sm(), sm(), sm(), sm(), seed);
}

/** Restore an RNG from a serialized state snapshot. Rejects malformed snapshots (no silent degeneracy). */
export function restoreRandomNumberGenerator(
  snapshot: RandomNumberGeneratorState,
): RandomNumberGenerator {
  /**
   * Read through a WIDE view for validation. The parameter is the discriminated union, which is what
   * a caller should pass — but a snapshot arrives from JSON, a database, or another process, where
   * the type system was never present. Narrowing on the union alone leaves the unknown-algorithm arm
   * unreachable to the compiler (`never`) while it is entirely reachable at runtime, so the guard
   * that exists for untyped input would be the one the types delete.
   */
  const raw = snapshot as unknown as { algorithm?: unknown; state?: unknown; seed?: unknown };
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    !Array.isArray(snapshot.state) ||
    !Number.isFinite(snapshot.seed)
  ) {
    throw new InputError(
      'restoreRandomNumberGenerator: malformed snapshot (expected { algorithm, state[], seed }).',
      {
        code: ErrorCode.InputWrongType,
        context: { snapshot },
      },
    );
  }
  const requireState = (count: number): void => {
    /**
     * EXACT length, matching the declared tuple. This accepted a state LONGER than the algorithm
     * uses (`length < count`), so a four-word snapshot restored a one-word generator and silently
     * discarded three words — the declaration now says `[number]` and `[number, number, number,
     * number]`, and the check has to mean the same thing or one of them is decoration.
     */
    if (snapshot.state.length !== count || !snapshot.state.every(Number.isFinite)) {
      throw new InputError(
        `restoreRandomNumberGenerator: ${snapshot.algorithm} state must have exactly ${count} finite element(s), got ${JSON.stringify(snapshot.state)}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { algorithm: snapshot.algorithm, state: snapshot.state },
        },
      );
    }
  };
  if (snapshot.algorithm === 'mulberry32') {
    requireState(1);
    return makeMulberry32(snapshot.state[0]!, snapshot.seed);
  }
  if (snapshot.algorithm === 'xoshiro128ss') {
    requireState(4);
    const [a, b, c, d] = snapshot.state;
    // The all-zero state is xoshiro's fixed point: every word stays 0 and `next()` returns 0
    // forever. It is not a state the generator can ever reach, so a snapshot carrying it was
    // hand-written or corrupted — accepting it hands back a "random" stream that is a column of
    // zeros, and every simulation built on it silently degenerates.
    if (a! >>> 0 === 0 && b! >>> 0 === 0 && c! >>> 0 === 0 && d! >>> 0 === 0) {
      throw new InputError(
        'restoreRandomNumberGenerator: xoshiro128ss cannot be restored from the all-zero state — it is a fixed point of the generator (next() would return 0 forever). Re-seed with xoshiro128ss(seed) instead of hand-writing a state.',
        {
          code: ErrorCode.InputOutOfRange,
          context: { algorithm: snapshot.algorithm, state: snapshot.state.slice(0, 4) },
        },
      );
    }
    return makeXoshiro128(a!, b!, c!, d!, snapshot.seed);
  }
  throw new InputError(
    `restoreRandomNumberGenerator: unknown algorithm "${String(raw.algorithm)}" — must be one of ` +
      `${RANDOM_NUMBER_GENERATOR_ALGORITHMS.map((name) => `'${name}'`).join(', ')}.`,
    {
      code: ErrorCode.InputInvalidEnum,
      context: { algorithm: raw.algorithm },
    },
  );
}

/** Standard-normal (Box–Muller) sample, optionally scaled to N(mu, sigma²). */
/**
 * The samplers consume a PRNG artifact — validate the ONE member they call (C05: decoration on a
 * generator passes; a null/absent `next` used to crash raw or return NaN samples).
 */
function requireGenerator(value: unknown, functionName: string): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { next?: unknown }).next !== 'function'
  ) {
    throw new InputError(
      `${functionName}: randomNumberGenerator must be a generator with next() — build one with createRandomNumberGenerator(seed). Received ${value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName } },
    );
  }
}

export function normalSample(
  randomNumberGenerator: RandomNumberGenerator,
  mu = 0,
  sigma = 1,
): number {
  requireGenerator(randomNumberGenerator, 'normalSample');
  let u1 = 0;
  while (u1 === 0) u1 = randomNumberGenerator.next();
  const u2 = randomNumberGenerator.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mu + sigma * z;
}

/** Fill a typed array with uniform [0, 1) samples. */
export function uniformSamples(
  randomNumberGenerator: RandomNumberGenerator,
  count: number,
): Float64Array {
  requireGenerator(randomNumberGenerator, 'uniformSamples');
  // Safe integer AND a work cap (2026-08-23 review, P0): see MAX_SAMPLE_COUNT — the old
  // `Number.isInteger` check let 1e308 through to a raw, unteaching `RangeError` from the allocator.
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_SAMPLE_COUNT) {
    throw new InputError(
      `uniformSamples: count must be an integer in [0, ${MAX_SAMPLE_COUNT.toLocaleString('en-US')}] — the call materializes one 8-byte double per sample (0.8 GB at the cap, filled in ~1 s), so a larger count is an allocation request, not a sample size. Received ${count}.\n  e.g. uniformSamples(createRandomNumberGenerator(42), 10_000)`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { count, max: MAX_SAMPLE_COUNT },
      },
    );
  }
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = randomNumberGenerator.next();
  return out;
}

export interface BootstrapOptions {
  /** Number of resamples (default 1000). */
  iterations?: number;
  /** Seed — required so results are reproducible (and echoed back). */
  seed: number;
}

export interface BootstrapResult {
  estimates: number[];
  mean: number;
  standardDeviation: number;
  /** 95% percentile confidence interval. */
  confidenceInterval95: [number, number];
  seed: number;
  iterations: number;
}

/**
 * Nonparametric bootstrap: resample `data` with replacement `iterations` times, apply `statistic`,
 * and summarize the distribution of the estimate. Deterministic given `seed`.
 */
export function bootstrap(
  data: ArrayLike<number>,
  statistic: (sample: number[]) => number,
  options: BootstrapOptions,
): BootstrapResult {
  if (typeof statistic !== 'function') {
    throw new InputError(
      `bootstrap: statistic must be a function of a resample — bootstrap(data, (s) => mean(s), { seed: 1 }). Received ${statistic === null ? 'null' : typeof statistic}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'statistic' } },
    );
  }
  requireArgumentObject('bootstrap', 'options', options);
  ensureKnownKeys('bootstrap', 'options', options, ['iterations', 'seed']);
  if (
    options.iterations !== undefined &&
    (typeof options.iterations !== 'number' || !Number.isFinite(options.iterations))
  ) {
    throw new InputError(
      `bootstrap: iterations must be a finite number when provided. Received ${options.iterations === null ? 'null' : typeof options.iterations}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'iterations' } },
    );
  }
  const iterations = options.iterations ?? 1000;
  const n = data.length;
  if (!Number.isFinite(options.seed)) {
    throw new InputError(`bootstrap: seed must be a finite number, got ${options.seed}.`, {
      code: ErrorCode.InputNotFinite,
      context: { seed: options.seed },
    });
  }
  if (n === 0) {
    throw new InputError('bootstrap: data must be non-empty.', {
      code: ErrorCode.InputOutOfRange,
      context: { length: n },
    });
  }
  // Safe integer AND a work cap (2026-08-23 review, P0): `Number.isInteger(1e308)` is `true`, so the
  // old check admitted an `iterations` the resampling loop could never finish (and above 2^53 the
  // loop counter itself stops advancing — a literal hang). See MAX_BOOTSTRAP_ITERATIONS.
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_BOOTSTRAP_ITERATIONS
  ) {
    throw new InputError(
      `bootstrap: iterations must be an integer in [1, ${MAX_BOOTSTRAP_ITERATIONS.toLocaleString('en-US')}] — every iteration resamples all ${n} observations and re-evaluates the statistic, and percentile intervals are stable by 10^4–10^5 replications, so the cap is already 10× beyond practice. Received ${iterations}.\n  e.g. bootstrap(data, (s) => mean(s), { iterations: 2_000, seed: 42 })`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { iterations, max: MAX_BOOTSTRAP_ITERATIONS },
      },
    );
  }
  const randomNumberGenerator = mulberry32(options.seed);
  const estimates = new Array<number>(iterations);
  const sample = new Array<number>(n);
  for (let b = 0; b < iterations; b++) {
    for (let i = 0; i < n; i++) sample[i] = data[Math.floor(randomNumberGenerator.next() * n)]!;
    const est = statistic(sample);
    if (!Number.isFinite(est)) {
      throw new InputError(
        `bootstrap: statistic returned a non-finite value (${est}) on resample ${b}; a NaN/∞ estimate must not surface as a successful summary.`,
        { code: ErrorCode.InputNotFinite, context: { resample: b, value: est } },
      );
    }
    estimates[b] = est;
  }
  return {
    estimates,
    mean: mean(estimates),
    standardDeviation: standardDeviation(estimates),
    confidenceInterval95: [quantile(estimates, 0.025), quantile(estimates, 0.975)],
    // Echo the caller's literal seed — `options.seed >>> 0` turned a run seeded with -1 into a
    // report of 4294967295, a value that reproduces the run but that nobody typed.
    seed: options.seed,
    iterations,
  };
}
