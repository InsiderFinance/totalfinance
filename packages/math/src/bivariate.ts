/**
 * Cumulative bivariate normal distribution.
 *
 * `bivariateNormalCdf(a, b, rho)` returns P(X ≤ a, Y ≤ b) for a standard bivariate normal (X, Y)
 * with correlation `rho`. This is the kernel behind the Bjerksund–Stensland (2002) American
 * approximation, spread/exchange options, and any two-asset payoff.
 *
 * The implementation is Alan Genz's `BVU` routine (the standard high-accuracy method, ~1e-15),
 * which switches between a direct Gauss–Legendre integration of the bivariate density and a
 * near-singular expansion as |ρ| → 1. Node/weight order scales with |ρ|.
 */

import { normalCdf } from './normal.js';

const TWO_PI = 2 * Math.PI;

// Gauss–Legendre nodes/weights (positive halves; the routine mirrors them). 6-, 12-, 20-point sets.
const GL6_X = [0.9324695142031522, 0.6612093864662647, 0.238619186083197] as const;
const GL6_W = [0.1713244923791705, 0.3607615730481384, 0.4679139345726904] as const;

const GL12_X = [
  0.9815606342467191, 0.904117256370475, 0.769902674194305, 0.5873179542866175, 0.3678314989981802,
  0.1252334085114692,
] as const;
const GL12_W = [
  0.04717533638651177, 0.1069393259953183, 0.1600783285433464, 0.2031674267230659,
  0.2334925365383547, 0.2491470458134029,
] as const;

const GL20_X = [
  0.9931285991850949, 0.9639719272779138, 0.9122344282513259, 0.8391169718222188,
  0.7463319064601508, 0.636053680726515, 0.5108670019508271, 0.3737060887154196, 0.2277858511416451,
  0.07652652113349733,
] as const;
const GL20_W = [
  0.01761400713915212, 0.04060142980038694, 0.06267204833410906, 0.08327674157670475,
  0.1019301198172404, 0.1181945319615184, 0.1316886384491766, 0.1420961093183821,
  0.1491729864726037, 0.1527533871307259,
] as const;

function nodesFor(absR: number): { x: readonly number[]; w: readonly number[] } {
  if (absR < 0.3) return { x: GL6_X, w: GL6_W };
  if (absR < 0.75) return { x: GL12_X, w: GL12_W };
  return { x: GL20_X, w: GL20_W };
}

/** Genz BVU: P(X > sh, Y > sk) for standard bivariate normal with correlation `r`. */
function bvu(sh: number, sk: number, r: number): number {
  const h = sh;
  let k = sk;
  let hk = h * k;
  let bvn = 0;
  const { x, w } = nodesFor(Math.abs(r));

  if (Math.abs(r) < 0.925) {
    const hs = (h * h + k * k) / 2;
    const asr = Math.asin(r);
    for (let i = 0; i < x.length; i++) {
      for (let is = -1; is <= 1; is += 2) {
        const sn = Math.sin((asr * (is * x[i]! + 1)) / 2);
        bvn += w[i]! * Math.exp((sn * hk - hs) / (1 - sn * sn));
      }
    }
    bvn = (bvn * asr) / (2 * TWO_PI) + normalCdf(-h) * normalCdf(-k);
    return bvn;
  }

  if (r < 0) {
    k = -k;
    hk = -hk;
  }
  if (Math.abs(r) < 1) {
    const as = (1 - r) * (1 + r);
    let a = Math.sqrt(as);
    const bs = (h - k) ** 2;
    const c = (4 - hk) / 8;
    const d = (12 - hk) / 16;
    let asr = -(bs / as + hk) / 2;
    if (asr > -100) {
      bvn =
        a * Math.exp(asr) * (1 - (c * (bs - as) * (1 - (d * bs) / 5)) / 3 + (c * d * as * as) / 5);
    }
    if (-hk < 100) {
      const b = Math.sqrt(bs);
      bvn -=
        Math.exp(-hk / 2) *
        Math.sqrt(TWO_PI) *
        normalCdf(-b / a) *
        b *
        (1 - (c * bs * (1 - (d * bs) / 5)) / 3);
    }
    a /= 2;
    for (let i = 0; i < x.length; i++) {
      for (let is = -1; is <= 1; is += 2) {
        const xs = (a * (is * x[i]! + 1)) ** 2;
        const rs = Math.sqrt(1 - xs);
        asr = -(bs / xs + hk) / 2;
        if (asr > -100) {
          const sp = 1 + c * xs * (1 + d * xs);
          const ep = Math.exp((-hk * xs) / (2 * (1 + rs) ** 2)) / rs;
          bvn += a * w[i]! * Math.exp(asr) * (ep - sp);
        }
      }
    }
    bvn = -bvn / TWO_PI;
  }
  if (r > 0) return bvn + normalCdf(-Math.max(h, k));
  return -bvn + Math.max(0, normalCdf(-h) - normalCdf(-k));
}

/**
 * Cumulative bivariate normal: P(X ≤ a, Y ≤ b) where (X, Y) is standard bivariate normal with
 * correlation `rho ∈ [-1, 1]`. Returns `NaN` if any argument is `NaN` or `|rho| > 1`.
 */
export function bivariateNormalCdf(a: number, b: number, rho: number): number {
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(rho) || Math.abs(rho) > 1) return NaN;
  if (a === Infinity) return normalCdf(b);
  if (b === Infinity) return normalCdf(a);
  if (a === -Infinity || b === -Infinity) return 0;
  if (rho === 0) return normalCdf(a) * normalCdf(b);
  // P(X ≤ a, Y ≤ b) = P(-X ≥ -a, -Y ≥ -b); (-X, -Y) keeps correlation rho.
  const p = bvu(-a, -b, rho);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}
