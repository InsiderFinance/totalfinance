# Spec — `estimateCovariance` front door (`@totalfinance/math`)

> Roadmap Tier 2 → Sizing → the covariance-estimation follow-up deferred by both `shrunkKelly` and
> `ledoitWolfShrinkage` ("_an `estimateCovariance` front door_"). Status: **shipped** as
> `estimateCovariance` in `packages/math/src/linalg.ts`, covered by
> `packages/math/test/estimate-covariance.test.ts`, full CI green.

## Goal

Every optimizer and `Σ⁻¹` consumer — the Kelly solvers, mean-variance / max-Sharpe / risk-parity,
Black–Litterman, PCA — needs a covariance it can actually **invert**. The raw sample covariance often
can't be: with `p` variables comparable to `T` observations it is ill-conditioned, and with `T < p` it is
**singular**. `estimateCovariance` is the one call that turns a returns matrix into a **well-conditioned,
usually-invertible** covariance and, crucially, reports the **conditioning** so the caller knows whether
it is safe to invert. It composes the pieces already here — `covarianceMatrix`, `ledoitWolfShrinkage`, a
diagonal ridge, and `jacobiEigen` for the spectrum — behind one honest front door.

## Methods

- **`sample`** — the raw sample covariance (`covarianceMatrix`). Honest: returned as-is, and flagged
  `isPositiveDefinite: false` with a warning when it is singular / ill-conditioned (you asked for it).
- **`ledoit-wolf`** — the Ledoit–Wolf shrinkage (`ledoitWolfShrinkage`); always SPD, so invertible even
  when `T < p`. Reports the shrinkage intensity `δ`.
- **`ridge`** — the sample covariance plus a diagonal load `λ·I`, `λ = ridge · (average variance)`; always
  SPD for `ridge > 0`, a transparent regularization that lifts the smallest eigenvalue.
- **`auto`** (default) — use `sample` when it is positive-definite **and** well-conditioned
  (`conditionNumber ≤ conditionThreshold`, default `1e4`); otherwise fall back to `ledoit-wolf` (which is
  always SPD and optimally shrinks). The resolved method and the reason are disclosed.

## Conditioning diagnostics (the point)

Computed from the returned covariance's eigenvalues (`jacobiEigen`):

```
minEigenvalue, maxEigenvalue
conditionNumber   = maxEigenvalue / minEigenvalue   (Infinity when singular)
isPositiveDefinite = minEigenvalue > 1e-12 · maxEigenvalue
effectiveRank      = #{ eigenvalue > 1e-9 · maxEigenvalue }
```

_Verified: a `T = 500, p = 4` sample is SPD with condition number ≈ 18; a `T = 4, p = 6` sample is
singular (condition ∞, effective rank 3 = T − 1), while Ledoit–Wolf on it is SPD with condition ≈ 4 and
ridge(0.1) is SPD with condition ≈ 37._ The condition number is the number a caller actually needs: a
huge one means an inverse that amplifies estimation noise; `∞` means no inverse at all.

## Honesty / envelope contract

- **Never silently returns junk** — the `sample` method discloses when its result is not invertible
  (`math.covariance_singular`); `auto` refuses to return a singular matrix (it shrinks); a repaired or
  still-ill-conditioned result is flagged (`math.covariance_ill_conditioned`).
- **The conditioning is always reported** — the caller sees the eigenvalue extremes, condition number,
  SPD-ness, and effective rank, whichever method was used.
- **`auto` discloses its choice** — the resolved `method` and a `math.covariance_method_auto` note say why
  it shrank (or didn't).
- **First-touch guards** — a non-array / ragged / `< 2`-observation / non-finite series, or a non-positive
  `ridge`, throws a typed `InputError`; never a `NaN` covariance.

## API

```ts
type CovarianceMethod = 'sample' | 'ledoit-wolf' | 'ridge' | 'auto';

interface EstimateCovarianceOptions {
  /** Estimator; default 'auto'. */
  method?: CovarianceMethod;
  /** Ridge diagonal load as a fraction of the average variance (method 'ridge'). Default 0.1. Must be > 0. */
  ridge?: number;
  /** Condition-number threshold above which 'auto' shrinks instead of using the sample. Default 1e4. */
  conditionThreshold?: number;
  /** Population (1/T) vs sample (1/(T−1)) normalization. Default true (matches Ledoit–Wolf). */
  population?: boolean;
}

interface CovarianceEstimate {
  /** The estimated, well-conditioned covariance. */
  covariance: Matrix;
  /** The estimator actually used ('auto' resolves to one of these). */
  method: 'sample' | 'ledoit-wolf' | 'ridge';
  variables: number; // p
  observations: number; // T
  minEigenvalue: number;
  maxEigenvalue: number;
  conditionNumber: number; // Infinity when singular
  isPositiveDefinite: boolean;
  effectiveRank: number;
  /** Ledoit–Wolf shrinkage intensity, present when `method` is 'ledoit-wolf'. */
  shrinkage?: number;
  assumptions: { conventionsVersion: string; method: string; population: boolean };
  diagnostics: Diagnostics;
}

function estimateCovariance(
  series: number[][],
  opts?: EstimateCovarianceOptions,
): CovarianceEstimate;
```

`series[k]` is variable k's observations (p variables × T), matching `covarianceMatrix`.

## Build checklist

1. **Validate** — extract the shared `series` validator (reused by `ledoitWolfShrinkage`): non-empty,
   rectangular, `T ≥ 2`, finite.
2. **Resolve the method** — `sample`/`ledoit-wolf`/`ridge` build the covariance; `auto` computes the
   sample spectrum and picks `sample` (SPD + well-conditioned) or `ledoit-wolf`.
3. **Diagnose** — `jacobiEigen` on the result → min/max eigenvalue, condition number, SPD-ness,
   effective rank; the singular / ill-conditioned / auto-choice warnings; envelope; export; API report +
   READMEs/llms.
4. **Tests** — `sample` equals `covarianceMatrix`; `ledoit-wolf` equals `ledoitWolfShrinkage`; `ridge` is
   the sample plus `λI` and is SPD; `auto` picks `sample` on a well-conditioned matrix and `ledoit-wolf`
   on a singular one; the diagnostics match a direct `jacobiEigen`; the singular-`sample` warning; guards.

## Deferred (explicitly)

- **The mean too** — a paired `(μ̂, Σ̂)` estimator (with James–Stein `μ̂` shrinkage) as a single call.
- **Constant-correlation / factor-model covariance targets** (beyond LW's scaled identity) and an EWMA /
  exponentially-weighted covariance.
- **Wiring the front door into the optimizers** so `minVariance`/`kelly`/… accept a returns matrix
  directly and estimate `Σ` internally.
