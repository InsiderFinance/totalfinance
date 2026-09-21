/**
 * Unchecked SSVI kernels — the arithmetic with no validation, shared by `./ssvi.ts` and `./essvi.ts`.
 *
 * WHY THIS FILE EXISTS. Spec 3B.1b requires two things that pull against each other: every public
 * boundary validates its numeric fields, and validation never lands inside an already-validated loop.
 * The arbitrage diagnostics sweep a log-moneyness grid crossed with a maturity grid and evaluate
 * `φ(θ)` and the slice at every pair, so per-call validation there is per-iteration cost for input
 * that was checked once at the entry point.
 *
 * The obvious fix — exporting `…Unchecked` next to the guarded function — is wrong HERE, because
 * `./ssvi` and `./essvi` are both entries in the package `exports` map. Anything exported from those
 * modules is public API, and publishing an unchecked numeric routine is exactly what spec 3B.1b
 * forbids: "keep unchecked financial routines file-private and reachable only after validation."
 *
 * This module is deliberately NOT in the exports map. It is therefore invisible to the runtime
 * manifest (which walks exports-map entrypoints only), carries no public contract, and cannot be
 * imported by a consumer.
 *
 * It holds the SSVI internals that must stay off the public surface: the unchecked kernels (whose
 * rule is that every caller has already validated) and the shared `phi` GUARD, which belongs here for
 * the same reason — `./ssvi` and `./essvi` both need it, and exporting it from either would publish a
 * validation helper as API.
 */

import { ensureEnum, requireArgumentObject, requireFiniteFields } from '@totalfinance/core';
import type { SVIParameters } from './svi.js';

/** The SSVI curvature function `φ(θ)`. Duplicated in `./ssvi.ts` as the public, validated type. */
export type SSVIPhiShape =
  | { kind: 'power-law'; eta: number; gamma: number }
  | { kind: 'heston'; lambda: number };

/** @internal `φ(θ)` with no validation — callers validate the phi union once, up front. */
export function phiValueUnchecked(phi: SSVIPhiShape, theta: number): number {
  if (phi.kind === 'power-law') return phi.eta * Math.pow(theta, -phi.gamma);
  // Heston-like: (1/(λθ))·(1 − (1 − e^(−λθ))/(λθ)).
  const lt = phi.lambda * theta;
  return (1 / lt) * (1 - (1 - Math.exp(-lt)) / lt);
}

/** The SSVI slice inputs at a fixed θ. Mirrors the public `SsviSliceInput` in `./ssvi.ts`. */
export interface SsviSliceShape {
  k: number;
  theta: number;
  rho: number;
  psi: number;
}

/**
 * @internal The SSVI slice at a fixed θ, unchecked.
 *
 * Object-shaped, not positional: `(k, theta, rho, psi)` is four interchangeable numbers and the
 * internal signature law rejects that vector for the obvious reason — a transposition compiles and
 * prices a different smile. A positional form was tried on the argument that the grid sweeps would
 * save an allocation per iteration; that saving was never measured, and an unmeasured micro-benefit
 * is not worth a silently-wrong surface.
 */
export function ssviSliceWUnchecked(input: SsviSliceShape): number {
  const { k, theta, rho, psi } = input;
  return (theta / 2) * (1 + rho * psi * k + Math.sqrt((psi * k + rho) ** 2 + (1 - rho * rho)));
}

/** The (θ, ρ, ψ) triplet of one SSVI slice. Mirrors the public `SsviToSviInput` in `./ssvi.ts`. */
export interface SsviToSviShape {
  theta: number;
  rho: number;
  psi: number;
}

/**
 * @internal The exact SSVI-at-θ → raw-SVI reduction, unchecked. The arbitrage diagnostics in
 * `./ssvi.ts` and `./essvi.ts` reduce once per θ-knot (or per maturity-grid point) inside a sweep
 * whose surface parameters were validated at the public head — re-validating the triplet there is
 * the per-iteration cost spec 3B.1b forbids. The public, validated boundary is `ssviToSVI`.
 */
export function ssviToSviUnchecked(input: SsviToSviShape): SVIParameters {
  const { theta, rho, psi } = input;
  return {
    a: (theta / 2) * (1 - rho * rho),
    b: (theta * psi) / 2,
    rho,
    m: -rho / psi,
    sigma: Math.sqrt(1 - rho * rho) / psi,
  };
}

/** The curvature-function discriminants, and the fields each branch actually consumes. */
const PHI_KINDS = ['power-law', 'heston'] as const;

const PHI_EXAMPLE_CALL = "phiValue({ kind: 'power-law', eta: 1.0, gamma: 0.5 }, 0.04)";

const PHI_HINTS: Record<string, string> = {
  eta: 'power-law level',
  gamma: 'power-law decay, in (0, 1)',
  lambda: 'Heston-like mean-reversion speed',
};

/**
 * Validate an SSVI curvature function — a DISCRIMINATED UNION, so the branch decides which fields
 * are required and a shape check on the container alone proves nothing.
 *
 * The measured defect is worth stating exactly, because it is subtler than a missing guard:
 * `requireArgumentObject` accepted `phi: {}`, `phi.kind` was then `undefined`, the `=== 'power-law'`
 * test failed, and control FELL THROUGH to the Heston branch — which multiplied by an absent
 * `lambda` and returned `NaN`. A missing discriminant did not merely skip validation, it silently
 * SELECTED a branch. Checking `kind` against the allowed set is what makes the branch choice mean
 * anything; only then can that branch's own fields be required.
 *
 * @internal Not exported from the package: this is a guard, not API.
 */
export function requirePhi(
  phi: SSVIPhiShape,
  functionName: string,
  field = 'phi',
  /**
   * The failing function's OWN example.
   *
   * `requirePhi` is shared by `phiValue` and by every SSVI/eSSVI surface evaluator, and it used to
   * emit one constant naming `phiValue` — which is `@internal` and absent from the exports map. So a
   * caller whose `ssviTotalVariance` parameters were malformed was told to go call a function they
   * cannot import. Each caller now supplies a runnable call to itself; the default keeps `phiValue`'s
   * own boundary correct.
   */
  exampleCall: string | (() => string) = PHI_EXAMPLE_CALL,
): void {
  requireArgumentObject(functionName, field, phi);
  ensureEnum((phi as { kind?: unknown }).kind, PHI_KINDS, `${field}.kind`, functionName);
  const branch = phi.kind === 'power-law' ? (['eta', 'gamma'] as const) : (['lambda'] as const);
  requireFiniteFields(functionName, phi, branch, {
    exampleCall,
    hints: PHI_HINTS,
    path: field,
  });
}
