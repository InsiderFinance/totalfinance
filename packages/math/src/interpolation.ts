/**
 * Linear interpolation (spec §8.5).
 *
 * `xs` must be sorted strictly ascending. Outside the data range, the default policy is flat
 * extrapolation (clamp to the nearest endpoint); pass `extrapolate: 'linear'` to extend the end
 * slopes, or `'forbid'` to throw.
 */

import { ensureKnownKeys, requireArgumentObject, ErrorCode, InputError } from '@totalfinance/core';

export type ExtrapolationPolicy = 'flat' | 'linear' | 'forbid';

export interface InterpolateOptions {
  extrapolate?: ExtrapolationPolicy;
}

function lowerBound(xs: ArrayLike<number>, x: number): number {
  // Largest index i with xs[i] <= x, via binary search.
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Interpolate `y` at `x` over the points `(xs[i], ys[i])`.
 *
 * TRUSTED FAST PATH: `xs` MUST be strictly ascending and the same length as `ys` — this function
 * does not validate (it binary-searches and assumes order), so out-of-order input yields nonsense.
 * For validated, axis-checked construction use {@link makePchipInterpolator} /
 * {@link makeNaturalCubicSpline} (or call {@link validateInterpolationData} first).
 */
export function linearInterp(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  x: number,
  options: InterpolateOptions = {},
): number {
  // The lookup point is positional: an omitted x used to interpolate at undefined and return NaN.
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new InputError(
      `linearInterp: x must be a finite number — linearInterp([0, 1], [10, 20], 0.5). Received ${x === null ? 'null' : x === undefined ? 'undefined' : typeof x === 'number' ? String(x) : typeof x}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'x' } },
    );
  }
  requireArgumentObject('linearInterp', 'options', options);
  ensureKnownKeys('linearInterp', 'options', options, ['extrapolate']);
  if (
    options.extrapolate !== undefined &&
    !(EXTRAPOLATION_POLICIES as readonly string[]).includes(options.extrapolate as string)
  ) {
    throw new InputError(
      `linearInterp: extrapolate must be one of ${EXTRAPOLATION_POLICIES.join(' | ')} when provided. Received ${options.extrapolate === null ? 'null' : JSON.stringify(options.extrapolate)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'extrapolate' } },
    );
  }
  const n = xs.length;
  if (n === 0 || ys.length !== n) {
    throw new InputError('linearInterp: xs and ys must be non-empty and equal length.', {
      code: ErrorCode.InputOutOfRange,
      context: { xsLength: n, ysLength: ys.length },
    });
  }
  if (n === 1) return ys[0]!;

  const policy = options.extrapolate ?? 'flat';
  const x0 = xs[0]!;
  const xLast = xs[n - 1]!;

  if (x <= x0 || x >= xLast) {
    if (x === x0) return ys[0]!;
    if (x === xLast) return ys[n - 1]!;
    if (policy === 'forbid') {
      throw new InputError(
        `linearInterp: x=${x} is outside [${x0}, ${xLast}] and extrapolation is forbidden.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { x, min: x0, max: xLast },
        },
      );
    }
    if (policy === 'flat') return x < x0 ? ys[0]! : ys[n - 1]!;
    // linear extrapolation off the nearest segment
    const [ia, ib] = x < x0 ? [0, 1] : [n - 2, n - 1];
    return extend(xs, ys, ia, ib, x);
  }

  const i = lowerBound(xs, x);
  const j = Math.min(i + 1, n - 1);
  return extend(xs, ys, i, j, x);
}

function extend(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  i: number,
  j: number,
  x: number,
): number {
  const xa = xs[i]!;
  const xb = xs[j]!;
  const ya = ys[i]!;
  const yb = ys[j]!;
  if (xb === xa) return ya;
  return ya + ((yb - ya) * (x - xa)) / (xb - xa);
}

export interface AxisOptions {
  /** Skip validation (trusted fast path for pre-validated data). */
  assumeSorted?: boolean;
  /** How to handle duplicate x-values. Omitted → duplicates are rejected. */
  aggregate?: 'mean' | 'first' | 'last';
  /**
   * Behavior outside the data range: `flat` (default — clamp to the nearest endpoint), `linear`
   * (extend the end slope), or `forbid` (throw `interpolation.out_of_domain`).
   */
  extrapolate?: ExtrapolationPolicy;
}

/** Validate a 2-D grid: both axes strictly increasing and length ≥ 2, and `z` shaped `nx × ny`. */
function validateGrid(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  z: number[][],
  functionName: string,
): void {
  const nx = xs.length;
  const ny = ys.length;
  if (nx < 2 || ny < 2) {
    throw new InputError(`${functionName}: both axes must have length ≥ 2 (got ${nx}×${ny}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { xsLength: nx, ysLength: ny },
    });
  }
  for (let i = 1; i < nx; i++) {
    if (!(xs[i]! > xs[i - 1]!)) {
      throw new InputError(
        `${functionName}: xs must be strictly increasing (breaks at index ${i}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { index: i, previous: xs[i - 1]!, current: xs[i]! },
        },
      );
    }
  }
  for (let j = 1; j < ny; j++) {
    if (!(ys[j]! > ys[j - 1]!)) {
      throw new InputError(
        `${functionName}: ys must be strictly increasing (breaks at index ${j}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { index: j, previous: ys[j - 1]!, current: ys[j]! },
        },
      );
    }
  }
  if (z.length !== nx || z.some((row) => row.length !== ny)) {
    throw new InputError(`${functionName}: z must be ${nx}×${ny}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { xsLength: nx, ysLength: ny, zRows: z.length },
    });
  }
}

/** One axis of a surface grid: finite and strictly increasing (checked once, at construction). */
function requireIncreasingAxis(axis: ArrayLike<number>, n: number, name: string): void {
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(axis[i]!)) {
      throw new InputError(
        `makeBicubicInterpolator: ${name}[${i}] is ${axis[i]}; grid axes must be finite.`,
        {
          code: ErrorCode.InterpolationInvalidGrid,
          context: { axis: name, index: i, value: axis[i] },
        },
      );
    }
    if (i > 0 && !(axis[i]! > axis[i - 1]!)) {
      throw new InputError(
        `makeBicubicInterpolator: ${name} must be strictly increasing (breaks at index ${i}: ${axis[i - 1]} → ${axis[i]}).`,
        {
          code: ErrorCode.InterpolationInvalidGrid,
          context: { axis: name, index: i, previous: axis[i - 1], current: axis[i] },
        },
      );
    }
  }
}

function outOfDomain(functionName: string, x: number, min: number, max: number): InputError {
  return new InputError(
    `${functionName}: x=${x} is outside the data domain [${min}, ${max}] and extrapolation is forbidden.`,
    { code: ErrorCode.InterpolationOutOfDomain, context: { x, min, max } },
  );
}

/**
 * Every knot must be a finite number.
 *
 * This is not decoration. The dedup loop below advances `i` by the length of the run of x-values
 * EQUAL to `x`, and `NaN === NaN` is false — so a NaN x-knot makes the run length 0, the loop never
 * advances, and it pushes onto `outX`/`outY` forever: an unbounded allocation spin that ends in a raw
 * `RangeError: Invalid array length` after seconds of thrash, inherited by every interpolator and
 * spline constructor. Naming the offending index up front costs one pass and turns a hang into a
 * diagnosis.
 */
function requireFiniteKnots(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): void {
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    if (!Number.isFinite(x)) {
      throw new InputError(
        `interpolation: xs[${i}] is ${x}; every knot must be a finite number (a non-finite x-knot cannot be ordered against its neighbours).`,
        { code: ErrorCode.InputNotFinite, context: { index: i, axis: 'xs', value: x } },
      );
    }
    const y = ys[i]!;
    if (!Number.isFinite(y)) {
      throw new InputError(
        `interpolation: ys[${i}] is ${y}; every knot must be a finite number (a non-finite y-knot poisons every evaluation of the interpolant).`,
        { code: ErrorCode.InputNotFinite, context: { index: i, axis: 'ys', value: y } },
      );
    }
  }
}

/**
 * Validate (and optionally clean) interpolation data. Requires strictly increasing x unless
 * `assumeSorted`; rejects duplicate x-values unless an `aggregate` policy is given. Non-finite knots
 * are always rejected on the validating path.
 */
const AXIS_OPTION_KEYS = ['assumeSorted', 'aggregate', 'extrapolate'] as const;
const AGGREGATES = ['mean', 'first', 'last'] as const;
const EXTRAPOLATION_POLICIES = [
  'flat',
  'linear',
  'forbid',
] as const satisfies readonly ExtrapolationPolicy[];

/** When-present ladders for the axis options (the 350c2796 ruling): shared by every maker. */
function requireAxisOptions(functionName: string, options: AxisOptions): void {
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, AXIS_OPTION_KEYS);
  if (options.assumeSorted !== undefined && typeof options.assumeSorted !== 'boolean') {
    throw new InputError(
      `${functionName}: assumeSorted must be a boolean when provided. Received ${options.assumeSorted === null ? 'null' : typeof options.assumeSorted}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'assumeSorted' } },
    );
  }
  if (
    options.aggregate !== undefined &&
    !(AGGREGATES as readonly string[]).includes(options.aggregate as string)
  ) {
    throw new InputError(
      `${functionName}: aggregate must be one of ${AGGREGATES.join(' | ')} when provided. Received ${options.aggregate === null ? 'null' : JSON.stringify(options.aggregate)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'aggregate' } },
    );
  }
  if (
    options.extrapolate !== undefined &&
    !(EXTRAPOLATION_POLICIES as readonly string[]).includes(options.extrapolate as string)
  ) {
    throw new InputError(
      `${functionName}: extrapolate must be one of ${EXTRAPOLATION_POLICIES.join(' | ')} when provided. Received ${options.extrapolate === null ? 'null' : JSON.stringify(options.extrapolate)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'extrapolate' } },
    );
  }
}

export function validateInterpolationData(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  options: AxisOptions = {},
): { xs: number[]; ys: number[] } {
  requireAxisOptions('validateInterpolationData', options);
  const n = xs.length;
  if (n === 0 || ys.length !== n) {
    throw new InputError('interpolation: xs and ys must be non-empty and equal length.', {
      code: ErrorCode.InputOutOfRange,
      context: { xsLength: n, ysLength: ys.length },
    });
  }
  if (options.assumeSorted) {
    return { xs: Array.from(xs as ArrayLike<number>), ys: Array.from(ys as ArrayLike<number>) };
  }
  requireFiniteKnots(xs, ys, n);

  const outX: number[] = [];
  const outY: number[] = [];
  let i = 0;
  while (i < n) {
    const x = xs[i]!;
    if (outX.length > 0 && x < outX[outX.length - 1]!) {
      throw new InputError(`interpolation: x-axis must be strictly increasing (at index ${i}).`, {
        code: ErrorCode.InputOutOfRange,
        context: { index: i, x },
      });
    }
    // gather a run of duplicate x
    let j = i;
    let sum = 0;
    while (j < n && xs[j]! === x) {
      sum += ys[j]!;
      j++;
    }
    if (j - i > 1) {
      if (!options.aggregate) {
        throw new InputError(
          `interpolation: duplicate x-value ${x} (provide an aggregate policy).`,
          {
            code: ErrorCode.InterpolationDuplicateKnots,
            context: { x },
          },
        );
      }
      outX.push(x);
      outY.push(
        options.aggregate === 'mean'
          ? sum / (j - i)
          : options.aggregate === 'first'
            ? ys[i]!
            : ys[j - 1]!,
      );
    } else {
      outX.push(x);
      outY.push(ys[i]!);
    }
    i = j;
  }
  return { xs: outX, ys: outY };
}

/** Build a reusable linear interpolator over fixed points (validates the axis by default). */
export function makeLinearInterpolator(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  options?: InterpolateOptions & AxisOptions,
): (x: number) => number {
  const clean = validateInterpolationData(xs, ys, options);
  return (x: number) => linearInterp(clean.xs, clean.ys, x, options);
}

/** Build a PCHIP (monotone cubic Hermite) interpolator — shape-preserving, no overshoot. */
export function makePchipInterpolator(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  options: AxisOptions = {},
): (x: number) => number {
  const { xs: X, ys: Y } = validateInterpolationData(xs, ys, options);
  const n = X.length;
  if (n < 2) {
    const y0 = Y[0] ?? NaN;
    return () => y0;
  }
  const h = new Array<number>(n - 1);
  const delta = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = X[i + 1]! - X[i]!;
    delta[i] = (Y[i + 1]! - Y[i]!) / h[i]!;
  }
  const d = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const dl = delta[i - 1]!;
    const dr = delta[i]!;
    if (dl * dr <= 0) {
      d[i] = 0;
    } else {
      const w1 = 2 * h[i]! + h[i - 1]!;
      const w2 = h[i]! + 2 * h[i - 1]!;
      d[i] = (w1 + w2) / (w1 / dl + w2 / dr);
    }
  }
  d[0] = pchipEndpoint(h[0]!, h[1] ?? h[0]!, delta[0]!, delta[1] ?? delta[0]!);
  d[n - 1] = pchipEndpoint(
    h[n - 2]!,
    h[n - 3] ?? h[n - 2]!,
    delta[n - 2]!,
    delta[n - 3] ?? delta[n - 2]!,
  );

  const policy = options.extrapolate ?? 'flat';
  return (x: number): number => {
    if (x <= X[0]!) {
      if (x === X[0]!) return Y[0]!;
      if (policy === 'forbid') throw outOfDomain('makePchipInterpolator', x, X[0]!, X[n - 1]!);
      if (policy === 'linear') return Y[0]! + d[0]! * (x - X[0]!);
      return Y[0]!;
    }
    if (x >= X[n - 1]!) {
      if (x === X[n - 1]!) return Y[n - 1]!;
      if (policy === 'forbid') throw outOfDomain('makePchipInterpolator', x, X[0]!, X[n - 1]!);
      if (policy === 'linear') return Y[n - 1]! + d[n - 1]! * (x - X[n - 1]!);
      return Y[n - 1]!;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (X[mid]! <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - X[lo]!) / h[lo]!;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * Y[lo]! + h10 * h[lo]! * d[lo]! + h01 * Y[lo + 1]! + h11 * h[lo]! * d[lo + 1]!;
  };
}

function pchipEndpoint(h0: number, h1: number, d0: number, d1: number): number {
  let d = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(d) !== Math.sign(d0)) d = 0;
  else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(d) > 3 * Math.abs(d0)) d = 3 * d0;
  return d;
}

/** Build a natural cubic spline interpolator (second derivative zero at both ends). */
export function makeNaturalCubicSpline(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  options: AxisOptions = {},
): (x: number) => number {
  const { xs: X, ys: Y } = validateInterpolationData(xs, ys, options);
  const n = X.length;
  if (n < 3) {
    return makeLinearInterpolator(X, Y, {
      assumeSorted: true,
      ...(options.extrapolate !== undefined ? { extrapolate: options.extrapolate } : {}),
    });
  }

  const h = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) h[i] = X[i + 1]! - X[i]!;

  // Solve the tridiagonal system for second derivatives m[], natural BC m[0]=m[n-1]=0.
  const alpha = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    alpha[i] = (3 / h[i]!) * (Y[i + 1]! - Y[i]!) - (3 / h[i - 1]!) * (Y[i]! - Y[i - 1]!);
  }
  const l = new Array<number>(n).fill(0);
  const mu = new Array<number>(n).fill(0);
  const z = new Array<number>(n).fill(0);
  l[0] = 1;
  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (X[i + 1]! - X[i - 1]!) - h[i - 1]! * mu[i - 1]!;
    mu[i] = h[i]! / l[i]!;
    z[i] = (alpha[i]! - h[i - 1]! * z[i - 1]!) / l[i]!;
  }
  l[n - 1] = 1;
  const m = new Array<number>(n).fill(0);
  for (let i = n - 2; i >= 0; i--) m[i] = z[i]! - mu[i]! * m[i + 1]!;

  // End slopes for linear extrapolation (derivative of the first/last cubic segment at the endpoints).
  const leftSlope = (Y[1]! - Y[0]!) / h[0]! - (h[0]! * (m[1]! + 2 * m[0]!)) / 3;
  const hL = h[n - 2]!;
  const bL = (Y[n - 1]! - Y[n - 2]!) / hL - (hL * (m[n - 1]! + 2 * m[n - 2]!)) / 3;
  const rightSlope = bL + 2 * m[n - 2]! * hL + 3 * ((m[n - 1]! - m[n - 2]!) / (3 * hL)) * hL * hL;
  const policy = options.extrapolate ?? 'flat';

  return (x: number): number => {
    if (x <= X[0]!) {
      if (x === X[0]!) return Y[0]!;
      if (policy === 'forbid') throw outOfDomain('makeNaturalCubicSpline', x, X[0]!, X[n - 1]!);
      if (policy === 'linear') return Y[0]! + leftSlope * (x - X[0]!);
      return Y[0]!;
    }
    if (x >= X[n - 1]!) {
      if (x === X[n - 1]!) return Y[n - 1]!;
      if (policy === 'forbid') throw outOfDomain('makeNaturalCubicSpline', x, X[0]!, X[n - 1]!);
      if (policy === 'linear') return Y[n - 1]! + rightSlope * (x - X[n - 1]!);
      return Y[n - 1]!;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (X[mid]! <= x) lo = mid;
      else hi = mid;
    }
    const dx = x - X[lo]!;
    const hi2 = h[lo]!;
    const a = Y[lo]!;
    const b = (Y[lo + 1]! - Y[lo]!) / hi2 - (hi2 * (m[lo + 1]! + 2 * m[lo]!)) / 3;
    const c = m[lo]!;
    const dCoef = (m[lo + 1]! - m[lo]!) / (3 * hi2);
    return a + b * dx + c * dx * dx + dCoef * dx * dx * dx;
  };
}

/**
 * Bilinear interpolation on a grid. `z[i][j]` is the value at `(xs[i], ys[j])`. Clamps to the grid
 * edges outside the domain.
 */
export function bilinearInterp(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  z: number[][],
  x: number,
  y: number,
): number {
  validateGrid(xs, ys, z, 'bilinearInterp');
  const nx = xs.length;
  const ny = ys.length;
  const ix = clampIndex(xs, x, nx);
  const iy = clampIndex(ys, y, ny);
  const x0 = xs[ix]!;
  const x1 = xs[ix + 1]!;
  const y0 = ys[iy]!;
  const y1 = ys[iy + 1]!;
  const tx = x1 === x0 ? 0 : Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
  const ty = y1 === y0 ? 0 : Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
  const z00 = z[ix]![iy]!;
  const z10 = z[ix + 1]![iy]!;
  const z01 = z[ix]![iy + 1]!;
  const z11 = z[ix + 1]![iy + 1]!;
  return z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty) + z01 * (1 - tx) * ty + z11 * tx * ty;
}

/**
 * Build a reusable **bicubic** interpolator over a regular grid `z[i][j] = f(xs[i], ys[j])` — a smooth
 * tensor-product natural cubic spline (C² in both axes). One x-spline is precomputed per y-column; each
 * query splines those column values along y. Smoother than {@link bilinearInterp} for vol/price
 * surfaces. Both axes must be strictly increasing and `z` must be `xs.length × ys.length`; both are
 * CHECKED once here, at construction.
 */
export function makeBicubicInterpolator(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  z: number[][],
): (x: number, y: number) => number {
  const nx = xs.length;
  const ny = ys.length;
  if (nx < 2 || ny < 2 || z.length !== nx || z.some((row) => row.length !== ny)) {
    throw new InputError(
      `makeBicubicInterpolator: z must be ${nx}×${ny} with both axes length ≥ 2.`,
      { code: ErrorCode.InterpolationInvalidGrid, context: { nx, ny } },
    );
  }
  // The strictly-increasing requirement above was documented but never enforced: both column and
  // row splines are built with `assumeSorted: true` (they must be — the axes are re-splined on every
  // query), so an out-of-order axis silently produced a smooth-looking surface fitted to the wrong
  // knots. Validate each axis ONCE here instead, which is both correct and free at query time.
  requireIncreasingAxis(xs, nx, 'xs');
  requireIncreasingAxis(ys, ny, 'ys');
  const xArr = Array.from({ length: nx }, (_, i) => xs[i]!);
  const yArr = Array.from({ length: ny }, (_, j) => ys[j]!);
  // One natural cubic spline along x for each y-column.
  const columnSplines = Array.from({ length: ny }, (_, j) =>
    makeNaturalCubicSpline(
      xArr,
      z.map((row) => row[j]!),
      { assumeSorted: true },
    ),
  );
  return (x: number, y: number): number => {
    const colValues = columnSplines.map((spline) => spline(x));
    return makeNaturalCubicSpline(yArr, colValues, { assumeSorted: true })(y);
  };
}

/** Bicubic interpolation at a single `(x, y)` (see {@link makeBicubicInterpolator}). */
export function bicubicInterp(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  z: number[][],
  x: number,
  y: number,
): number {
  return makeBicubicInterpolator(xs, ys, z)(x, y);
}

function clampIndex(axis: ArrayLike<number>, v: number, n: number): number {
  if (v <= axis[0]!) return 0;
  if (v >= axis[n - 1]!) return n - 2;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (axis[mid]! <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}
