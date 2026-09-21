# Spec — Empirical vol–spot β (the leverage effect) (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the `minimumVarianceDelta` follow-up: "empirical β estimation from an
> IV/return history".
> Status: **shipped** as `estimateVolatilitySpotBeta` in `packages/volatility/src/volatility-spot-beta.ts`, covered by
> `packages/volatility/test/volatility-spot-beta.test.ts`, full CI green.

## Goal

`minimumVarianceDelta` needs `β = ∂σ/∂S` — how implied vol moves with spot. Its spec is explicit that **the
honest β is empirical**: the regression slope of realized IV changes on spot changes (the leverage effect,
negative for equities). This estimates exactly that from a `(spot, impliedVolatility)` history, so the output feeds
straight into `minimumVarianceDelta({ volatilitySpotBeta })`. It closes the `minimumVarianceDelta` follow-up trio
(SABR/Bartlett delta ✅, minimum-variance vega/gamma ✅, empirical β ← here).

## Method

From an aligned, chronological `(spotₜ, σₜ)` series, form one-step changes and run an **OLS regression with
intercept** of the IV change on the spot-change regressor, composing `@totalfinance/math`'s `ols` (so the
standard errors, t-stat, and R² — and optional **Newey–West HAC** for the autocorrelation in overlapping IV
changes — come from the verified estimator):

- **`basis: 'log'`** (default) — regress `Δσₜ` on the **log-return** `rₜ = ln(Sₜ/Sₜ₋₁)`. The slope is
  `∂σ/∂ln S`; convert to the required `∂σ/∂S = slope / S_ref` at a reference spot (default: the latest spot).
  Log-returns are scale-free, so this is the more stationary specification and the standard one for the
  leverage effect; `volatilitySpotBeta` is then the **current** `∂σ/∂S` (at `S_ref`).
- **`basis: 'level'`** — regress `Δσₜ` on the **dollar change** `ΔSₜ = Sₜ − Sₜ₋₁`. The slope **is** `∂σ/∂S`
  directly (a sample-average over the price range); no reference spot needed.

Pairs with a non-finite `σ`/return or a non-positive spot are dropped (and counted); the reported `n` is the
number of change observations actually used.

## Honesty / verification

- **Recovers a known β.** Verified on a synthetic log-leverage series `σₜ = σ₀ + b·ln(Sₜ/S₀)`: the log-basis
  slope recovers `b` exactly (R² = 1), and `volatilitySpotBeta = b/S_ref` equals the DGP's `∂σ/∂S` at the reference
  spot; a hand OLS and the correlation (−1 for pure leverage) agree. With additive noise the slope stays
  within noise of `b` and the t-stat flags significance.
- **Feeds `minimumVarianceDelta`.** Verified round-trip: the `volatilitySpotBeta` output, passed to
  `minimumVarianceDelta({ volatilitySpotBeta })`, reproduces `Δ_BS + Vega·β`.
- **Significance is disclosed, not hidden.** The result carries the slope's **standard error, t-stat, and
  R²**, and raises a `ModelLimitation` warning when the sample is small (`n < 20`) or the slope is
  statistically insignificant (`|t| < 2`) — a β that is really noise should not masquerade as a hedge input.
  Dropped (non-finite / non-positive) observations are also disclosed.
- **Signs & units.** `volatilitySpotBeta` is `∂σ/∂S` in **decimal vol per $1** (matching `minimumVarianceDelta`);
  `correlation` is signed (leverage ⇒ negative). The `basis` and `hacLags` are echoed in the assumptions.
- **Guards.** Aligned non-empty `spot`/`impliedVolatility` of equal length; after dropping bad pairs, `≥ 3` change
  observations are required (so the intercept + slope regression has residual degrees of freedom); positive
  `referenceSpot` if supplied; a non-negative integer `hacLags`. No explicit first-touch fixture — the
  single-object-arg signature is auto-covered by the arg-0 garbage sweep.

## API

```ts
export interface VolatilitySpotBetaInput {
  /** Chronological spot prices. */
  spot: number[];
  /** The option's implied vol (decimal), aligned to `spot`. */
  impliedVolatility: number[];
  /** Regress IV changes on log-returns ('log', default) or dollar spot changes ('level'). */
  basis?: 'log' | 'level';
  /** Reference spot to convert a log-basis slope to ∂σ/∂S (default: the latest spot). */
  referenceSpot?: number;
  /** Newey–West HAC bandwidth for autocorrelation-robust errors (default 0 = White). */
  hacLags?: number;
}

export interface VolatilitySpotBeta {
  /** β = ∂σ/∂S in decimal vol per $1 — feed to `minimumVarianceDelta({ volatilitySpotBeta })`. */
  volatilitySpotBeta: number;
  /** The regression slope: ∂σ/∂ln S ('log') or ∂σ/∂S ('level'). */
  slope: number;
  slopeStandardError: number;
  slopeTStatistic: number;
  /** Correlation of IV change with the spot-change regressor (leverage ⇒ negative). */
  correlation: number;
  rSquared: number;
  /** Change observations used (after dropping bad pairs). */
  observationCount: number;
  /** Dropped (non-finite / non-positive) change observations. */
  dropped: number;
  /** Reference spot used for the ∂σ/∂S conversion. */
  referenceSpot: number;
}

export function estimateVolatilitySpotBeta(
  input: VolatilitySpotBetaInput,
): Computed<
  VolatilitySpotBeta,
  { measure: 'real-world-hedge'; basis: 'log' | 'level'; hacLags: number }
>;
```

## Build checklist

1. `estimateVolatilitySpotBeta` — validate; build `(Δσ, regressor)` change pairs dropping bad ones; `ols` (+ HAC) with
   intercept; slope/se/t/R²; correlation; `volatilitySpotBeta` (log ⇒ `slope/refSpot`, level ⇒ `slope`);
   significance / small-sample / dropped warnings; `Computed` envelope.
2. Export (`estimateVolatilitySpotBeta`, `VolatilitySpotBetaInput`, `VolatilitySpotBeta`) in `index.ts`.
3. Tests: noiseless recovery + the `∂σ/∂S` conversion, the `minimumVarianceDelta` round-trip, the level basis,
   the HAC path, the small-sample / insignificance / dropped warnings, and the guards; 100% coverage.

## Deferred (explicitly)

- **A multi-factor β** (IV changes on spot **and** a vol-level or VIX factor) and **rolling/EWMA β** — richer
  leverage estimators; this ships the single-factor static regression that `minimumVarianceDelta` consumes.
