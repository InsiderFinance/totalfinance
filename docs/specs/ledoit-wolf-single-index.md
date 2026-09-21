# Spec — Ledoit–Wolf single-index (market-model) shrinkage target (`@totalfinance/math`)

> Roadmap Tier 2 → Portfolio & risk → the Ledoit–Wolf follow-up: "the single-index (market-model) target".
> Status: **shipped** as `target: 'single-index'` on `ledoitWolfShrinkage` (and `ledoitWolfTarget: 'single-index'` on
> `estimateCovariance`) in `packages/math/src/linalg.ts`, covered by `packages/math/test/…`, full CI green.

## Goal

`ledoitWolfShrinkage` already shrinks the sample covariance `S` toward the scaled **identity** (default) or the
**constant-correlation** target. This adds the third classic Ledoit–Wolf (2003) target — the **single-index /
market-model** structured estimator `F` — the one designed for **stock returns**, where a single dominant
market factor drives most of the co-movement. For an equity universe it is usually the best-specified of the
three targets, so shrinking toward it gives the lowest-error, always-SPD covariance for every `Σ⁻¹` consumer
(optimizers, min-variance, risk). Exposed on the `estimateCovariance` front door too.

## The target (Ledoit–Wolf 2003, `covMarket`)

Work with the demeaned observations `xᵢₜ`. The **market proxy** is the equal-weighted cross-sectional average
return each period, `x_mkt,t = (1/p)·Σᵢ xᵢₜ`. Let `varmkt = (1/T)Σₜ x_mkt,t²` and
`covmktᵢ = (1/T)Σₜ xᵢₜ·x_mkt,t` (each stock's market covariance = `βᵢ·varmkt`). The structured target is the
covariance implied by the one-factor model:

```
Fᵢⱼ = covmktᵢ·covmktⱼ / varmkt   (i ≠ j)     Fᵢᵢ = Sᵢᵢ   (diagonal keeps the sample variance)
```

The **optimal intensity** is `δ* = max(0, min(1, κ/T))`, `κ = (π̂ − ρ̂)/γ̂`, where (per the paper):

- `π̂ = Σᵢⱼ π̂ᵢⱼ`, `π̂ᵢⱼ = (1/T)Σₜ (xᵢₜxⱼₜ − Sᵢⱼ)²` — the sampling error in `S` (same as the other targets).
- `γ̂ = ‖F − S‖²_F` — the target misspecification.
- `ρ̂ = rdiag + 2·roff₁ − roff₃`, the covariance between the estimation errors of `S` and the market target:
  - `rdiag = Σᵢ π̂ᵢᵢ`;
  - `roff₁ = (1/varmkt)·Σ_{i≠j} v1ᵢⱼ·covmktⱼ`, `v1ᵢⱼ = (1/T)Σₜ xᵢₜ²·xⱼₜ·x_mkt,t − covmktᵢ·Sᵢⱼ`;
  - `roff₃ = (1/varmkt²)·Σ_{i≠j} v3ᵢⱼ·covmktᵢ·covmktⱼ`, `v3ᵢⱼ = (1/T)Σₜ xᵢₜxⱼₜ·x_mkt,t² − varmkt·Sᵢⱼ`.

`Σ* = δ*·F + (1−δ*)·S`, always SPD for non-degenerate data (invertible even when `T < p`).

## Honesty / verification

- **Recovers a one-factor truth better than `S` and the other targets.** The definitive Monte-Carlo: generate
  returns from a genuine one-factor model (`rᵢ = βᵢ·f + εᵢ`), and the single-index shrink has **lower Frobenius
  error to the true Σ** than the raw sample `S`, and lower than the identity- and constant-correlation-target
  shrinks — because its target is correctly specified. _Verified before shipping._
- **`δ → 0` as `T` grows** (correct target ⇒ the sample dominates asymptotically); and **`δ` is larger when the
  target is misspecified** (e.g. a constant-correlation truth) than when it is correct — the intensity honestly
  reflects how much the structure helps.
- **Always SPD.** Like the other targets, the shrunk matrix is invertible even for `T < p` — verified via a
  Cholesky / eigenvalue positivity check.
- **Disclosure.** The result reports the used `target: 'single-index'` and the `marketVariance` (`varmkt`) the
  target was built from; the reported `sampleCovariance`/`averageVariance` are unchanged.
- **Guards.** A degenerate market (`varmkt = 0`, e.g. all-identical or anti-correlated returns that cancel) is
  a typed error (the target is undefined). Inherits the existing returns-series validation.

## API

```ts
// LedoitWolfOptions.target and LedoitWolfResult.target gain 'single-index':
target?: 'identity' | 'constant-correlation' | 'single-index';
// LedoitWolfResult gains (single-index only):
marketVariance?: number; // varmkt = Var of the equal-weighted market proxy
// estimateCovariance.ledoitWolfTarget gains 'single-index'.
```

## Build checklist

1. Extend the `target` union on `LedoitWolfOptions` / `LedoitWolfResult`; add `marketVariance?`.
2. `singleIndexShrinkage(series, S, means, mu, p, T, fn)` — market proxy, `covmkt`/`varmkt`, `F`, the
   `π̂`/`rdiag`/`roff₁`/`roff₃`/`ρ̂`/`γ̂` intensity, `Σ*`; a `varmkt = 0` guard.
3. Dispatch `target === 'single-index'` in `ledoitWolfShrinkage`; thread `ledoitWolfTarget: 'single-index'` through
   `estimateCovariance`.
4. Tests: the one-factor recovery vs `S`/identity/constant-correlation, `δ → 0` growth, misspecified ⇒ higher
   `δ`, SPD-ness, `marketVariance` disclosure, the `varmkt = 0` guard, and the `estimateCovariance`
   pass-through; keep 100% coverage of the new code.

## Deferred (explicitly)

- **Nonlinear (Ledoit–Wolf 2020) shrinkage** — eigenvalue-level shrinkage via a kernel estimate of the
  limiting spectral distribution; a substantially larger numerical build, the other half of this follow-up.
