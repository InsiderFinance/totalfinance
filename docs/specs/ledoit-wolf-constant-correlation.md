# Spec — Ledoit–Wolf constant-correlation shrinkage target (`@totalfinance/math`)

> Roadmap Tier 2 → Portfolio & risk → the Ledoit–Wolf follow-up: "the constant-correlation / single-index
> targets".
> Status: **shipped** as the `target` option of `ledoitWolfShrinkage` (+ `ledoitWolfTarget` passthrough on
> `estimateCovariance`) in `packages/math/src/linalg.ts`, covered by `packages/math/test/ledoit-wolf.test.ts`
> and `packages/math/test/estimate-covariance.test.ts`, full CI green.

## Goal

`ledoitWolfShrinkage` shrinks the sample covariance `S` toward the **scaled identity** `μI` — a target that
assumes every variable has the same variance and **zero correlation**. That regularizes well but is a poor
description of real asset returns, which are broadly _positively_ correlated. Ledoit & Wolf's own 2004 paper
("Honey, I Shrunk the Sample Covariance Matrix") uses a better structured target: the **constant-correlation**
matrix `F` — each variable keeps its own sample variance, and every pair is given the **average** sample
correlation `r̄`. This adds that target as an option, with its distinct closed-form optimal intensity.

```
Fᵢᵢ = Sᵢᵢ,   Fᵢⱼ = r̄·√(Sᵢᵢ·Sⱼⱼ)  (i≠j),   r̄ = mean of the p(p−1)/2 off-diagonal sample correlations
```

The shrunk estimate is `Σ* = δ·F + (1−δ)·S`, with the intensity from the Ledoit–Wolf 2004 decomposition:

```
δ* = max(0, min(1, (π̂ − ρ̂) / γ̂ / T))

π̂  = Σᵢⱼ π̂ᵢⱼ,       π̂ᵢⱼ = (1/T) Σₜ (xᵢₜ·xⱼₜ − Sᵢⱼ)²                 (asymptotic variance of the Sᵢⱼ)
γ̂  = ‖F − S‖²_F                                                      (target misspecification)
ρ̂  = Σᵢ π̂ᵢᵢ + Σ_{i≠j} (r̄/2)·(√(Sⱼⱼ/Sᵢᵢ)·ϑ̂ᵢ,ᵢⱼ + √(Sᵢᵢ/Sⱼⱼ)·ϑ̂ⱼ,ᵢⱼ)
      ϑ̂ₖ,ᵢⱼ = (1/T) Σₜ (xₖₜ² − Sₖₖ)(xᵢₜ·xⱼₜ − Sᵢⱼ)                  (cov of the diagonal & off-diagonal estimates)
```

where `xᵢₜ` are the demeaned observations and `S` is the MLE (`1/T`) sample covariance (matching the existing
estimator). `Σ*` is symmetric positive-definite — the same headline benefit as the identity target (invertible
even when `T < p`), but with a target that fits correlated data.

_Verified by Monte-Carlo before implementation: on a constant-correlation truth the estimate is **25–30% closer
to the true covariance** (Frobenius) than `S` at every `T`, `r̄` recovers the true correlation, and every draw
is SPD; on a **misspecified** (1-factor) truth the optimal `δ` correctly **falls toward 0 as `T` grows**
(0.998 → 0.23), i.e. shrinkage to a wrong target vanishes once the sample is trustworthy._

## Behavior notes (the honest nuance)

- **Well-specified target ⇒ `δ` stays high even for large `T`.** Unlike the identity target (always
  misspecified for correlated data, so `δ → 0`), when the true structure _is_ roughly constant-correlation the
  target keeps helping, so `δ` does not vanish. This is correct, not a bug — the estimator only downweights a
  target that the data contradicts.
- **`p = 1`.** No pairs, `r̄ = 0`, `F = S`, `γ̂ = 0`, so `δ = 0` and `Σ* = S` (nothing to shrink). Handled.

## API

Additive and backward-compatible:

```ts
export interface LedoitWolfOptions {
  /** Shrinkage target: `'identity'` (scaled identity μI, the default & original) or
   *  `'constant-correlation'` (the Ledoit–Wolf 2004 average-correlation target). */
  target?: 'identity' | 'constant-correlation';
}
export interface LedoitWolfResult {
  // …covariance, shrinkage, sampleCovariance, averageVariance, observations (unchanged)…
  /** The shrinkage target used. */
  target: 'identity' | 'constant-correlation';
  /** Average off-diagonal sample correlation r̄ (the target's correlation) — present for the CC target. */
  averageCorrelation?: number;
}
export function ledoitWolfShrinkage(series: number[][], opts?: LedoitWolfOptions): LedoitWolfResult;

// estimateCovariance passthrough:
export interface EstimateCovarianceOptions {
  // …existing…
  /** Ledoit–Wolf target when method resolves to `'ledoit-wolf'`. Default `'identity'`. */
  ledoitWolfTarget?: 'identity' | 'constant-correlation';
}
```

`ledoitWolfShrinkage(series)` (no opts) is byte-for-byte the existing identity estimator.

## Honesty / envelope contract

- **Backward-compatible** — `target` defaults to `'identity'`; the identity path is untouched, and the result
  gains only additive fields (`target`, optional `averageCorrelation`).
- **A degenerate target is a typed error** — the constant-correlation target needs positive variances to
  normalize; a zero-variance (constant) variable throws a typed `QuantError` rather than emitting `NaN`s.
- **The target is disclosed** — `result.target` and (for CC) `result.averageCorrelation` say exactly what was
  shrunk toward.
- **Always SPD** — like the identity target, so every `Σ⁻¹` consumer stays safe.

## Build checklist

1. `LedoitWolfOptions`; compute the demeaned `x` and sample `S` once, then branch on `target`.
2. Constant-correlation branch: `r̄` → `F` → `π̂`, `γ̂`, `ρ̂` → `δ*` → `Σ* = δF + (1−δ)S`; positive-variance
   guard.
3. Result fields `target` + `averageCorrelation`; identity branch sets `target: 'identity'`.
4. `estimateCovariance`: `ledoitWolfTarget` option passed through both the `'ledoit-wolf'` and `'auto'`-shrink paths.
5. Tests: identity backward-compat (byte-identical), CC recovers `r̄` + a hand-computed `F`, MC MSE beats
   the sample, `δ ∈ [0,1]` with the well-specified/misspecified behaviors, SPD, `p = 1`, and the guards;
   100% coverage of the new lines.

## Deferred (explicitly)

- **The single-index (market-model) target** (the other half of the roadmap item) and **Ledoit–Wolf 2020
  nonlinear analytical shrinkage**.
- A **`target: 'auto'`** that picks identity vs constant-correlation by a target-fit criterion.
