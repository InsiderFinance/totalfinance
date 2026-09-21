/**
 * Minimal complex arithmetic for Fourier/COS option pricing (spec §8.7).
 *
 * Just the operations the Heston characteristic function needs: ×, ÷, exp, √ (principal branch), and
 * ln (principal branch). Kept internal and allocation-light (plain `{ re, im }` records).
 */

export interface Complex {
  re: number;
  im: number;
}

export function complex(re: number, im = 0): Complex {
  return { re, im };
}

export function cAdd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function cSub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

export function cMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

export function cDiv(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

/** Multiply by a real scalar. */
export function cScale(a: Complex, k: number): Complex {
  return { re: a.re * k, im: a.im * k };
}

export function cExp(a: Complex): Complex {
  const e = Math.exp(a.re);
  return { re: e * Math.cos(a.im), im: e * Math.sin(a.im) };
}

/** Principal square root. */
export function cSqrt(a: Complex): Complex {
  const m = Math.hypot(a.re, a.im);
  const re = Math.sqrt(Math.max(0, (m + a.re) / 2));
  const im = (a.im >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, (m - a.re) / 2));
  return { re, im };
}

/** Principal natural logarithm (branch cut on the negative real axis). */
export function cLn(a: Complex): Complex {
  return { re: Math.log(Math.hypot(a.re, a.im)), im: Math.atan2(a.im, a.re) };
}
