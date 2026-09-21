# Spec — Ledoit–Wolf covariance shrinkage (`@totalfinance/math`)

> Roadmap Tier 2 → Sizing → Kelly _"Follow-up: … input shrinkage (Ledoit–Wolf `Σ̂`)…"_ Status:
> **shipped** as `ledoitWolfShrinkage` in `packages/math/src/linalg.ts`, covered by
> `packages/math/test/ledoit-wolf.test.ts`, full CI green. Lives in `math` (next to `covarianceMatrix`)
> because a shrunk covariance is a general estimator every `Σ⁻¹` consumer wants — Kelly, mean-variance /
> max-Sharpe / risk-parity optimizers, Black–Litterman, PCA.

## Goal

The sample covariance `S` is a terrible estimate when the number of variables `p` is comparable to the
number of observations `T`: its extreme eigenvalues are biased (the largest too large, the smallest too
small), and when `T < p` it is **singular** — you cannot invert it at all, which breaks every
portfolio optimizer. Ledoit–Wolf (2004) fixes this by pulling `S` toward a well-conditioned structured
target with the **analytically optimal** intensity, giving a covariance that is always invertible and,
on average, closer to the truth.

## The estimator (identity target)

For `p` variables of `T` demeaned observations, sample covariance `S = (1/T)·XᵀX` (MLE, `1/T`), shrink
toward the **scaled identity** `μI`, `μ = tr(S)/p` (the average variance):

```
Σ* = δ·μI + (1 − δ)·S
```

with the optimal shrinkage intensity from the paper:

```
d²  = ‖S − μI‖²_F                                   (how far the sample is from the target)
b̄²  = (1/T²)·Σ_{t=1}^T ‖xₜxₜᵀ − S‖²_F               (the sampling error in S)
b²  = min(b̄², d²)                                    (clamp so δ ∈ [0, 1])
δ   = b² / d²                                         (error-to-distance ratio; d² = 0 ⇒ δ = 0)
```

Intuition: `δ` is the fraction of `S`'s variation that is estimation noise rather than signal — shrink
hard when `S` is noisy (`b̄²` large) or close to the target anyway (`d²` small), and not at all when `S`
is well-estimated. _Verified against a Monte-Carlo over a known `Σ` (p = 5): `Σ*` is closer to the truth
in Frobenius norm than the raw `S` (22% lower error at `T = 8`, 8% at `T = 15`), and `δ → 0` as `T`
grows (0.53 → 0.03) so `Σ* → S` asymptotically. And with `T = 4 < p = 6`, `S` is singular
(non-invertible) while `Σ*` is **SPD** — the headline benefit._

## Honesty / envelope contract

- **Always invertible** — `Σ*` is symmetric positive-definite for any `T ≥ 2` and `μ > 0`, including
  `T < p`, so it drops straight into `cholesky` / the optimizers where `S` would fail.
- **δ is disclosed and bounded** — the returned `shrinkage ∈ [0, 1]` is the actual intensity applied; the
  raw `S`, the target's `μ`, and `T` are all returned so the caller sees exactly what was blended.
- **Degenerate targets are handled** — `p = 1` or an already-`μI` sample (`d² = 0`) yields `δ = 0`,
  `Σ* = S` (no shrinkage, not a divide-by-zero).
- **First-touch guards** — a non-array / ragged / `< 2`-observation / non-finite series throws a typed
  `InputError`; never a `NaN` covariance.

## API

```ts
interface LedoitWolfResult {
  /** The shrunk covariance Σ* = δ·μI + (1−δ)·S (symmetric positive-definite, even when T < p). */
  covariance: Matrix;
  /** Optimal shrinkage intensity δ ∈ [0, 1]. */
  shrinkage: number;
  /** The raw sample covariance S (1/T normalization). */
  sampleCovariance: Matrix;
  /** Average variance μ = tr(S)/p — the scaled-identity target's diagonal. */
  averageVariance: number;
  /** Number of observations T. */
  observations: number;
}

/**
 * `series[k]` is variable k's observations (p variables × T observations), matching `covarianceMatrix`.
 */
function ledoitWolfShrinkage(series: number[][]): LedoitWolfResult;
```

## Build checklist

1. **Sample stats** — validate the ragged/short/non-finite series; demean; `S = (1/T)XᵀX` (reuse
   `covarianceMatrix(series, {population:true})`); `μ = tr(S)/p`.
2. **Shrinkage** — `d²`, `b̄²`, `b² = min`, `δ = d²>0 ? b²/d² : 0`; `Σ* = δ·μI + (1−δ)·S`.
3. **Envelope + export + API report + READMEs/llms.** (Single-arg ⇒ first-touch **garbage sweep**; add a
   fixture only if the sweep needs a non-trivial shape.)
4. **Tests** — `Σ* = δ·μI + (1−δ)·S` exactly and symmetric; `δ ∈ [0, 1]`; `δ → 0` (Σ* → S) as `T` grows;
   `T < p` gives an SPD `Σ*`that`cholesky`accepts while`S`is rejected;`p = 1`/`d² = 0`⇒`δ = 0`;
guards (ragged, `T < 2`, non-array, non-finite).

## Deferred (explicitly)

- **The constant-correlation target** (Ledoit–Wolf 2004's other target: common-correlation matrix from
  the sample variances) and the **single-index (market-factor) target** — richer structure than the
  scaled identity for equity books.
- **Nonlinear (analytical) shrinkage** (Ledoit–Wolf 2020) — per-eigenvalue shrinkage rather than one
  global `δ`.
- **Wiring shrinkage into the optimizers/`shrunkKelly`** as a one-call `estimateCovariance` front door.
