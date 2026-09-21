/**
 * Monte Carlo runner and variance-reduction primitives (spec §8.6).
 *
 * The runner accumulates online (Welford) mean/variance and reports a typed `MonteCarloResult` with
 * standard error, confidence interval, and the seed. It is model-agnostic: the caller supplies a
 * `sampler` callback — no option-payoff logic lives here.
 */

import { ensureKnownKeys, requireArgumentObject, ErrorCode, InputError } from '@totalfinance/core';
import { cholesky, type Matrix } from './linalg.js';
import { normalInverseCdf } from './normal.js';
import { mulberry32, normalSample, type RandomNumberGenerator } from './random.js';
import { covariance, mean, variance } from './statistics.js';

/**
 * The most paths one `monteCarlo` run will draw (2026-08-23 review, P0 "unbounded work"):
 * `Number.isInteger(1e308)` is `true`, so the old check admitted a budget the path loop could never
 * finish — and above 2^53 the loop counter stops advancing entirely, a literal hang. The runner's own
 * Welford update costs ~10 ns/path before the caller's sampler runs (a bare normal draw was measured
 * at ~37 ns), so 10^8 paths is already 1–4 s with a FREE sampler; standard error shrinks only ∝ 1/√n,
 * so the cap's last decade buys a mere 3× precision.
 */
const MAX_MONTE_CARLO_PATHS = 100_000_000;

/**
 * The most dimensions one antithetic sampler will draw per path (2026-08-23 review, P0 "unbounded
 * work"): the wrapper allocates TWO scratch arrays of `dimensions` doubles and fills both with
 * normal draws (~37 ns each, measured) on EVERY path — at the cap that is 16 MB of scratch and
 * ~75 ms per path, already an extreme problem; beyond it the "dimension count" is an allocation
 * request, and above 2^53 the fill loop cannot terminate.
 */
const MAX_SAMPLER_DIMENSIONS = 1_000_000;

/**
 * The most strata one `stratifiedUniforms` call will materialize (2026-08-23 review, P0 "unbounded
 * work"): one 8-byte double per stratum — 0.8 GB at the cap, filled in ~1 s (measured ~9 ns/sample) —
 * and the old `Number.isInteger` check let 1e308 reach `new Array(count)` as if it were a sample size.
 * Matches MAX_SAMPLE_COUNT in random.ts, its per-sample sibling.
 */
const MAX_STRATIFIED_COUNT = 100_000_000;

export interface MonteCarloResult {
  value: number;
  variance: number;
  standardError: number;
  /** Confidence interval at the requested level (default 95%). */
  confidenceInterval: [number, number];
  paths: number;
  seed: number;
  /** Whether the target standard error was reached (always true when no target is set). */
  converged: boolean;
}

export interface MonteCarloOptions {
  /** Maximum paths (default 100_000). */
  paths?: number;
  /** Seed — required and echoed for reproducibility. */
  seed: number;
  /** Stop once the standard error falls to/below this (after `minPaths`). */
  targetStandardError?: number;
  /** Minimum paths before the stopping rule applies (default 1000). */
  minPaths?: number;
  /** Confidence level for the interval (default 0.95). */
  confidence?: number;
  /** RNG factory (default mulberry32). */
  randomNumberGenerator?: (seed: number) => RandomNumberGenerator;
}

/** Run a Monte Carlo estimate of `E[sampler(randomNumberGenerator)]` with online statistics and a stopping rule. */
function finiteWhenPresent(value: unknown, functionName: string, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${field} must be a finite number when provided — omit the field to use the default. Received ${value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
}

export function monteCarlo(
  sampler: (randomNumberGenerator: RandomNumberGenerator) => number,
  options: MonteCarloOptions,
): MonteCarloResult {
  if (typeof sampler !== 'function') {
    throw new InputError(
      `monteCarlo: sampler must be a function of the RNG — monteCarlo((rng) => rng.next(), { seed: 1 }). Received ${sampler === null ? 'null' : typeof sampler}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'sampler' } },
    );
  }
  requireArgumentObject('monteCarlo', 'options', options);
  ensureKnownKeys('monteCarlo', 'options', options, [
    'paths',
    'seed',
    'targetStandardError',
    'minPaths',
    'confidence',
  ]);
  for (const field of ['paths', 'targetStandardError', 'minPaths', 'confidence'] as const) {
    finiteWhenPresent((options as unknown as Record<string, unknown>)[field], 'monteCarlo', field);
  }
  const maxPaths = options.paths ?? 100_000;
  const minPaths = options.minPaths ?? 1000;
  const confidence = options.confidence ?? 0.95;

  // Validate the budget up front — a meaningful estimate needs ≥ 2 paths; an invalid budget must
  // throw, never return a successful-looking NaN/∞ result (design law #4).
  if (!Number.isFinite(options.seed)) {
    throw new InputError(`monteCarlo: seed must be a finite number, got ${options.seed}.`, {
      code: ErrorCode.InputNotFinite,
      context: { seed: options.seed },
    });
  }
  // Safe integer AND a work cap (2026-08-23 review, P0): see MAX_MONTE_CARLO_PATHS.
  if (!Number.isSafeInteger(maxPaths) || maxPaths < 2 || maxPaths > MAX_MONTE_CARLO_PATHS) {
    throw new InputError(
      `monteCarlo: paths must be an integer in [2, ${MAX_MONTE_CARLO_PATHS.toLocaleString('en-US')}] — every path runs the sampler plus a ~10 ns accumulator update, so the cap is already seconds of synchronous work even for a free sampler, and standard error ∝ 1/√n gains only 3× per extra decade. Received ${maxPaths}.\n  e.g. monteCarlo((rng) => rng.next(), { paths: 100_000, seed: 42 })`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { paths: maxPaths, max: MAX_MONTE_CARLO_PATHS },
      },
    );
  }
  // Safe integer only (2026-08-23 review, P0): minPaths bounds NO loop — the path loop is bounded by
  // `paths` above; this is merely the threshold before the stopping rule may fire. Above 2^53 it is
  // no longer an exact integer, so the `count >= minPaths` comparison would silently misfire instead.
  if (!Number.isSafeInteger(minPaths) || minPaths < 1) {
    throw new InputError(`monteCarlo: minPaths must be a positive integer, got ${minPaths}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { minPaths },
    });
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new InputError(`monteCarlo: confidence must be in (0, 1), got ${confidence}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { confidence },
    });
  }
  if (options.targetStandardError !== undefined && !(options.targetStandardError > 0)) {
    throw new InputError(
      `monteCarlo: targetStandardError must be positive, got ${options.targetStandardError}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { targetStandardError: options.targetStandardError },
      },
    );
  }

  const z = normalInverseCdf(0.5 + confidence / 2);
  const randomNumberGenerator = (options.randomNumberGenerator ?? mulberry32)(options.seed);

  let m = 0;
  let m2 = 0;
  let count = 0;
  let converged = options.targetStandardError === undefined;

  for (let i = 1; i <= maxPaths; i++) {
    const x = sampler(randomNumberGenerator);
    if (!Number.isFinite(x)) {
      throw new InputError(
        `monteCarlo: sampler returned a non-finite value (${x}) at path ${i}; a NaN/∞ sample must not surface as a successful estimate.`,
        { code: ErrorCode.InputNotFinite, context: { path: i, value: x } },
      );
    }
    count++;
    const delta = x - m;
    m += delta / count;
    m2 += delta * (x - m);
    if (options.targetStandardError !== undefined && count >= minPaths) {
      const v = m2 / (count - 1);
      if (Math.sqrt(v / count) <= options.targetStandardError) {
        converged = true;
        break;
      }
    }
  }

  const v = count > 1 ? m2 / (count - 1) : NaN;
  const se = Math.sqrt(v / count);
  return {
    value: m,
    variance: v,
    standardError: se,
    confidenceInterval: [m - z * se, m + z * se],
    paths: count,
    // The caller's literal seed, not `seed >>> 0`: a run seeded with -1 reported 4294967295, which
    // reproduces the run but is not the number anyone passed in.
    seed: options.seed,
    converged,
  };
}

/**
 * Wrap a payoff over a standard-normal vector into an antithetic sampler: each path evaluates the
 * payoff at `Z` and `-Z` and averages, reducing variance for monotone payoffs.
 */
export function antitheticSampler(
  payoff: (normals: number[]) => number,
  dimensions: number,
): (randomNumberGenerator: RandomNumberGenerator) => number {
  // Safe integer AND a work cap (2026-08-23 review, P0): see MAX_SAMPLER_DIMENSIONS — the old
  // `Number.isInteger` check let 1e308 through to `new Array(dimensions)` inside every path.
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > MAX_SAMPLER_DIMENSIONS) {
    throw new InputError(
      `antitheticSampler: dimensions must be an integer in [1, ${MAX_SAMPLER_DIMENSIONS.toLocaleString('en-US')}] — every path fills TWO scratch arrays of this length with normal draws (~37 ns each), so the cap is already ~75 ms per path and 16 MB of scratch. Received ${dimensions}.\n  e.g. antitheticSampler((z) => Math.max(0, z[0]), 1)`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { dimensions, max: MAX_SAMPLER_DIMENSIONS },
      },
    );
  }
  return (randomNumberGenerator: RandomNumberGenerator) => {
    const z = new Array<number>(dimensions);
    const zNeg = new Array<number>(dimensions);
    for (let i = 0; i < dimensions; i++) {
      z[i] = normalSample(randomNumberGenerator);
      zNeg[i] = -z[i]!;
    }
    return 0.5 * (payoff(z) + payoff(zNeg));
  };
}

/**
 * Control-variate adjusted estimate: `E[Y] ≈ Ȳ − c·(X̄ − E[X])`, with `c = cov(Y,X)/var(X)`.
 * `samples` are the target outputs, `controls` the control outputs, `controlMean` the known `E[X]`.
 */
export function controlVariateEstimate(
  samples: ArrayLike<number>,
  controls: ArrayLike<number>,
  controlMean: number,
): number {
  // The control's true mean is positional: omitted, the correction subtracted NaN and the
  // "variance-reduced" estimate WAS the noise it claimed to remove.
  if (typeof controlMean !== 'number' || !Number.isFinite(controlMean)) {
    throw new InputError(
      `controlVariateEstimate: controlMean must be a finite number — controlVariateEstimate(samples, controls, 0.5). Received ${controlMean === null ? 'null' : controlMean === undefined ? 'undefined' : typeof controlMean}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'controlMean' } },
    );
  }
  const vx = variance(controls);
  if (vx === 0) return mean(samples);
  const c = covariance(samples, controls) / vx;
  return mean(samples) - c * (mean(controls) - controlMean);
}

/** `n` stratified uniforms — one sample in each stratum `[i/n, (i+1)/n)`. */
export function stratifiedUniforms(
  randomNumberGenerator: RandomNumberGenerator,
  count: number,
): number[] {
  if (
    randomNumberGenerator === null ||
    typeof randomNumberGenerator !== 'object' ||
    typeof (randomNumberGenerator as { next?: unknown }).next !== 'function'
  ) {
    throw new InputError(
      `stratifiedUniforms: randomNumberGenerator must be a generator with next() — build one with createRandomNumberGenerator(seed). Received ${randomNumberGenerator === null ? 'null' : typeof randomNumberGenerator}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'randomNumberGenerator' } },
    );
  }
  // `new Array(-1)` / `new Array(2.5)` throw a raw `RangeError: Invalid array length` that names
  // neither this function nor the argument. Its siblings (uniformSamples, antitheticSampler) all
  // validate; this one didn't. Safe integer AND a work cap (2026-08-23 review, P0): see
  // MAX_STRATIFIED_COUNT — `Number.isInteger(1e308)` is `true`, so an absurd count sailed through
  // to the allocator (below 2^32 as a multi-gigabyte allocation, above it as that same raw RangeError).
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STRATIFIED_COUNT) {
    throw new InputError(
      `stratifiedUniforms: count must be an integer in [1, ${MAX_STRATIFIED_COUNT.toLocaleString('en-US')}] (one sample per stratum) — the call materializes one 8-byte double per stratum, 0.8 GB at the cap, filled in ~1 s. Received ${count}.\n  e.g. stratifiedUniforms(createRandomNumberGenerator(42), 1_000)`,
      { code: ErrorCode.InputOutOfRange, context: { count, max: MAX_STRATIFIED_COUNT } },
    );
  }
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = (i + randomNumberGenerator.next()) / count;
  return out;
}

/**
 * Brownian-bridge path construction on a uniform grid of `n` steps of size `stepSize` (a DIMENSIONLESS
 * grid spacing — callers building a unit grid pass `1` and scale later, so this is deliberately not
 * a `*Years` quantity). Consumes `n`
 * standard normals, assigning the most significant (endpoint, then successive midpoints) first —
 * ideal for quasi-Monte Carlo. Returns `W[0..n]` with `W[0] = 0`.
 */
export function brownianBridge(normals: ArrayLike<number>, stepSize: number): number[] {
  if (!(stepSize > 0) || !Number.isFinite(stepSize)) {
    throw new InputError(`brownianBridge: stepSize must be a positive number, got ${stepSize}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { stepSize },
    });
  }
  const n = normals.length;
  const W = new Array<number>(n + 1).fill(0);
  if (n === 0) return W;
  let k = 0;
  W[n] = Math.sqrt(n * stepSize) * normals[k++]!;
  const queue: Array<[number, number]> = [[0, n]];
  while (queue.length) {
    const [l, r] = queue.shift()!;
    if (r - l <= 1) continue;
    const mid = (l + r) >> 1;
    const tl = l * stepSize;
    const tm = mid * stepSize;
    const tr = r * stepSize;
    W[mid] =
      W[l]! +
      ((W[r]! - W[l]!) * (tm - tl)) / (tr - tl) +
      Math.sqrt(((tr - tm) * (tm - tl)) / (tr - tl)) * normals[k++]!;
    queue.push([l, mid]);
    queue.push([mid, r]);
  }
  return W;
}

/** Build a sampler of correlated standard normals from a covariance/correlation matrix (via Cholesky). */
export function correlatedNormalSampler(
  covarianceOrCorrelation: Matrix,
): (randomNumberGenerator: RandomNumberGenerator) => number[] {
  const L = cholesky(covarianceOrCorrelation);
  const n = L.length;
  return (randomNumberGenerator: RandomNumberGenerator) => {
    const z = new Array<number>(n);
    for (let i = 0; i < n; i++) z[i] = normalSample(randomNumberGenerator);
    const out = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) out[i]! += L[i]![j]! * z[j]!;
    return out;
  };
}
