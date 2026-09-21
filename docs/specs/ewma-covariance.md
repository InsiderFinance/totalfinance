# Spec — EWMA (RiskMetrics) covariance (`@totalfinance/math`)

> Roadmap Tier 2 → Portfolio & risk → the follow-up flagged on `estimateCovariance`: "EWMA covariance".
> Status: **shipped** as the `'ewma'` method of `estimateCovariance` in `packages/math/src/linalg.ts`,
> covered by `packages/math/test/estimate-covariance.test.ts`, full CI green.

## Goal

`estimateCovariance` estimates a **static** covariance — every observation weighted equally, so it lags a
changing market. Risk desks want the **current** covariance, which weights recent observations more.
RiskMetrics' **exponentially-weighted moving average** does exactly that: an `O(T)` estimator with a decay
`λ` that adapts to volatility regimes while staying positive-semidefinite. This adds it as a method to the
front door every `Σ⁻¹` consumer already uses (optimizers, VaR, Kelly), completing the estimator suite
(`sample` / `ledoit-wolf` / `ridge` / `auto` → **+ `ewma`**).

## The construction

For `series[k]` = variable `k`'s observations **in chronological order** (oldest first, `series[k][T−1]`
the most recent), the EWMA weights decay geometrically into the past:

```
wₜ ∝ λ^{(T−1)−t}          (the newest observation, t = T−1, gets weight ∝ λ⁰ = 1)
```

normalized so `Σ wₜ = 1`. Demeaning with the **EWMA-weighted mean** `μ = Σ wₜ·rₜ`, the estimate is the
weighted covariance:

```
Σᵢⱼ = c · Σₜ wₜ (rᵢ,ₜ − μᵢ)(rⱼ,ₜ − μⱼ)
```

with `c = 1` when `population` (default), or the unbiased weighted-covariance correction `c = 1/(1 − Σwₜ²)`
when `population: false`. It is a positive-weighted sum of outer products, hence PSD (SPD when the effective
sample supports the rank).

**Parameterization.** The decay is set by `lambda` (`0 < λ < 1`, default RiskMetrics **0.94**) or,
ergonomically, by `halfLife` (in periods) — `λ = 2^{−1/halfLife}` — used when `lambda` is omitted.

**Effective sample size.** The estimate reports `effectiveObservations = 1/Σwₜ²` (Kish), which tends to
`(1+λ)/(1−λ)` for large `T` — the count of equally-weighted observations the EWMA is "worth" (32 at
λ = 0.94). When it drops below the number of variables `p`, the estimate is noisy even if technically
full-rank — surfaced as a `math.covariance_ewma_effective_sample` warning.

_Verified: as `λ → 1` the EWMA reduces to the equal-weighted sample covariance; on a series whose recent
half is higher-vol the EWMA variance exceeds the sample (it tracks the regime); `effectiveObservations`
equals `1/Σwₜ²` and matches `(1+λ)/(1−λ)`; and the estimate is symmetric and PSD._

## Honesty / envelope contract

- **Regime-aware, disclosed** — `method: 'ewma'`, the `lambda` used, and `effectiveObservations` are echoed;
  a small effective sample is warned, not hidden.
- **Same conditioning report** — reuses the shared eigenvalue conditioning (min/max eigenvalue, condition
  number, SPD-ness, effective rank), so the singular / ill-conditioned warnings fire exactly as for the
  other methods; a rank-deficient EWMA (`T < p`) is flagged singular.
- **Chronological-order contract** — the newest observation is `series[k][T−1]`; documented, since EWMA is
  order-sensitive (unlike the equal-weighted methods).
- **First-touch guards** — `lambda` outside `(0, 1)`; a non-positive `halfLife`; the existing series guards
  (ragged / too-few / non-finite) — all throw a typed `QuantError`. Single-array + options ⇒ the existing
  `estimateCovariance` first-touch coverage applies.

## API

Additive to `estimateCovariance` — a new method and two options:

```ts
type CovarianceMethod = 'sample' | 'ledoit-wolf' | 'ridge' | 'ewma' | 'auto';
interface EstimateCovarianceOptions {
  method?: CovarianceMethod;
  /** EWMA decay `0 < λ < 1` (method `'ewma'`). Default 0.94 (RiskMetrics). */
  lambda?: number;
  /** EWMA half-life in periods (method `'ewma'`); `λ = 2^{−1/halfLife}` when `lambda` is omitted. */
  halfLife?: number;
  // …existing ridge / conditionThreshold / population…
}
interface CovarianceEstimate {
  // …existing fields…
  /** The EWMA decay used — present only for method `'ewma'`. */
  lambda?: number;
  /** Kish effective sample size `1/Σwₜ²` — present only for method `'ewma'`. */
  effectiveObservations?: number;
}
```

## Build checklist

1. **Resolve the decay** — `lambda` (validated `(0,1)`) or `halfLife` (`> 0`) → `λ`; default 0.94.
2. **EWMA covariance** — geometric weights, EWMA-weighted mean, `population` bias correction; the effective
   sample size.
3. **Wire the method** — into the `estimateCovariance` switch; reuse the conditioning + singular /
   ill-conditioned warnings; add the small-effective-sample warning; echo `lambda`/`effectiveObservations`.
4. **Tests** — the `λ → 1` reduction to sample; regime tracking; `effectiveObservations = 1/Σwₜ²`; the
   `halfLife` parameterization; the `population: false` correction; the small-sample warning; SPD; guards.

## Deferred (explicitly)

- **The EWMA correlation + separate EWMA volatilities** (RiskMetrics' two-parameter EWMA vol/corr) as a
  distinct decomposition.
- **A recursive/streaming update** (`Σₜ = λΣₜ₋₁ + (1−λ)rₜrₜᵀ`) for incremental use once the live layer lands.
- **`auto` selecting `ewma`** — currently EWMA is an explicit choice (time-decay is a modeling decision,
  not a conditioning one).
