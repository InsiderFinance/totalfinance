/**
 * The standard normal distribution (spec §8.1).
 *
 * `normalCdf` uses Graeme West's 2009 algorithm ("Better approximations to cumulative normal
 * functions"), accurate to roughly 1e-15 across the domain — the same routine option-pricing
 * libraries rely on. `normalInverseCdf` uses Acklam's rational approximation refined by one Halley step,
 * giving full double precision.
 */

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const INV_SQRT_2PI = 1 / SQRT_2PI;
const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);

/** Standard normal probability density function φ(x). */
export function normalPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/** Log of the standard normal PDF — exact and stable everywhere. */
export function normalLogPdf(x: number): number {
  return -0.5 * x * x - LOG_SQRT_2PI;
}

// West 2009 coefficients.
const N0 = 220.2068679123761;
const N1 = 221.2135961699311;
const N2 = 112.0792914978709;
const N3 = 33.912866078383;
const N4 = 6.37396220353165;
const N5 = 0.7003830644436881;
const N6 = 0.03526249659989109;
const M0 = 440.4137358247522;
const M1 = 793.8265125199484;
const M2 = 637.3336333788311;
const M3 = 296.5642487796737;
const M4 = 86.78073220294608;
const M5 = 16.06417757920695;
const M6 = 1.755667163182642;
const M7 = 0.08838834764831844;
const SPLIT = 7.07106781186547;

/** Standard normal cumulative distribution function Φ(x). */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const z = Math.abs(x);
  let c = 0;
  if (z <= 37) {
    const e = Math.exp(-0.5 * z * z);
    if (z < SPLIT) {
      const n = (((((N6 * z + N5) * z + N4) * z + N3) * z + N2) * z + N1) * z + N0;
      const d = ((((((M7 * z + M6) * z + M5) * z + M4) * z + M3) * z + M2) * z + M1) * z + M0;
      c = (e * n) / d;
    } else {
      const f = z + 1 / (z + 2 / (z + 3 / (z + 4 / (z + 13 / 20))));
      c = e / (SQRT_2PI * f);
    }
  }
  return x <= 0 ? c : 1 - c;
}

// Acklam coefficients.
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
];
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;
const P_HIGH = 1 - P_LOW;

/**
 * Inverse standard normal CDF (quantile function). Returns `-Infinity` at p<=0 and `+Infinity` at
 * p>=1.
 */
export function normalInverseCdf(probability: number): number {
  if (Number.isNaN(probability)) return NaN;
  if (probability <= 0) return -Infinity;
  if (probability >= 1) return Infinity;

  let x: number;
  if (probability < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(probability));
    x =
      (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  } else if (probability <= P_HIGH) {
    const q = probability - 0.5;
    const r = q * q;
    x =
      ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) /
      (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    x =
      -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }

  // One Halley refinement step → full double precision. In the last denormal decades
  // (p ≲ 1e-308) exp(x²/2) overflows; the rational seed is already exact there, so skip the step
  // rather than return NaN.
  //
  // It must ALSO be skipped once `normalCdf(x)` flushes to exactly 0 (|x| > 37, i.e. p ≲ 1e-301).
  // There the residual `e = Φ(x) − p` degenerates to `−p` — a pure statement about the underflow,
  // carrying no information about x — while `exp(x²/2)` is still finite, so the step is computed
  // from noise and DRAGS the accurate seed off: at p = 1e-300 it moved the answer from −37.0471
  // (correct) to −37.0291, an error 10⁷× the seed's own.
  const c = normalCdf(x);
  if (c > 0) {
    const e = c - probability;
    const u = e * SQRT_2PI * Math.exp(0.5 * x * x);
    if (Number.isFinite(u)) {
      x = x - u / (1 + (x * u) / 2);
    }
  }
  return x;
}

/** Standard normal survival function: 1 − Φ(x) = Φ(−x) (stable in the right tail). */
export function normalSurvivalFunction(x: number): number {
  return normalCdf(-x);
}

/**
 * Log of the standard normal CDF, stable into the far-left tail (where Φ(x) underflows to 0).
 * Uses `log(Φ(x))` for `x ≥ -20` and the asymptotic expansion
 * `Φ(x) = φ(x)/(-x)·(1 − 1/x² + 3/x⁴ − 15/x⁶ + …)` below that.
 */
export function normalLogCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x >= -20) {
    const c = normalCdf(x);
    return c > 0 ? Math.log(c) : -Infinity;
  }
  const ix2 = 1 / (x * x);
  const series = 1 - ix2 * (1 - ix2 * (3 - ix2 * (15 - ix2 * 105)));
  return normalLogPdf(x) - Math.log(-x) + Math.log(series);
}

/** Log of the standard normal survival function (stable in the far-right tail). */
export function normalLogSurvivalFunction(x: number): number {
  return normalLogCdf(-x);
}

/** Convenience namespace mirroring the spec's `normal.pdf/cdf/inverseCdf` facade. */
export const normal = {
  pdf: normalPdf,
  cdf: normalCdf,
  inverseCdf: normalInverseCdf,
  survivalFunction: normalSurvivalFunction,
  logPdf: normalLogPdf,
  logCdf: normalLogCdf,
  logSurvivalFunction: normalLogSurvivalFunction,
} as const;
