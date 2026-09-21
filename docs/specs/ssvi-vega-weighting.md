# Spec — Vega-weighted SSVI / eSSVI calibration (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the SSVI / eSSVI follow-up: "vega-weighted (SSVI) calibration".
> Status: **shipped** as `weight: 'vega'` on `calibrateSSVI` / `calibrateESSVI` (and `ssviWeight` /
> `essviWeight` on `volatilitySurface`) in `@totalfinance/volatility`, covered by `packages/volatility/test/…`, full CI green.

## Goal

`calibrateSSVI` / `calibrateESSVI` minimize the **unweighted** sum of squared total-variance residuals across
all `(k, t)` points. That treats a thin, noisy, deep-OTM wing quote the same as a liquid ATM one — so a few
bad wing marks can pull the fit off the strikes that matter. Production desks fit the **vega-weighted**
objective: weight each residual by the option's Black **vega**, so high-vega ATM/near-the-money strikes (where
quotes are reliable _and_ the price sensitivity is greatest) dominate, and the low-vega wings are downweighted.
This adds an opt-in `weight: 'vega'` to both calibrations, and threads it through the `volatilitySurface`
`ssvi`/`essvi` models.

## Method

For each market point `(kᵢ, tᵢ)` with total variance `wᵢ = σᵢ²·tᵢ` (so `σᵢ = √(wᵢ/tᵢ)`), the Black vega is
`∝ φ(d₁ᵢ)·√tᵢ` with `d₁ᵢ = −kᵢ/(σᵢ√tᵢ) + ½σᵢ√tᵢ` (`φ` the standard-normal pdf). The **weights are fixed** —
they depend only on the market data, not the SSVI parameters — so they are **precomputed once** and the
objective becomes

```
minimize   Σ ωᵢ · (w_model(kᵢ, tᵢ; params) − wᵢ)²,   ωᵢ = φ(d₁ᵢ)·√tᵢ   (vega)   or   1   (uniform)
```

The change is confined to the objective's summand; the θ-clamping, the Nelder–Mead search, the arbitrage
diagnostics, and the eSSVI warm-start are untouched. A degenerate point (`wᵢ ≤ 0`) gets weight 0 under `vega`.

## Reported RMSE stays unweighted

The returned `rmse` / `perSliceRmse` remain the **unweighted** RMS total-variance error, so they are
comparable across `weight` modes and against the old behaviour. (Vega-weighting deliberately trades a slightly
higher _unweighted_ RMSE for a tighter fit where vega — and liquidity — is concentrated.) The chosen mode is
echoed in `assumptions.weight`.

## API

```ts
// added to SSVICalibrationOptions and ESSVICalibrationOptions:
weight?: 'uniform' | 'vega'; // default 'uniform' (backward-compatible)

// added to SurfaceConfig, for the volatilitySurface ssvi/essvi models:
ssviWeight?: 'uniform' | 'vega';
essviWeight?: 'uniform' | 'vega';
```

`assumptions` (of the calibration results) gains `weight: 'uniform' | 'vega'`.

## Honesty / verification

- **Default is unchanged.** `weight` defaults to `'uniform'`, so every existing caller — and the surface
  models — behave byte-identically unless they opt in. Verified: a `'uniform'` fit equals the pre-change fit.
- **Vega-weighting tightens the ATM fit.** The definitive check: take a true SSVI/eSSVI surface, add noise to
  the **wing** quotes only, and fit both ways. The `'vega'` fit has a **smaller ATM / near-the-money residual**
  than the `'uniform'` fit (which the noisy wings pull off), at the cost of a larger wing residual — the
  intended trade. _Verified numerically before shipping._
- **Weights are the market's, not the model's.** Because `ωᵢ` uses the market total variance, they are fixed
  across the optimization — no chicken-and-egg with the fitted vol, and the objective stays a clean weighted
  least-squares.
- **Guards.** `weight` is validated (`'uniform' | 'vega'`); everything else inherits the existing calibration
  guards (`≥ 2 slices`, aligned `k`/`w`, feasible params). The `volatilitySurface` pass-through validates through the
  same calibration.

## Build checklist

1. `calibrateSSVI`: `weight` option, `normalPdf` import, precomputed per-point weights, weighted `sse`,
   `assumptions.weight`. Same for `calibrateESSVI` (its own objective + the SSVI warm-start it calls).
2. `volatilitySurface`: `SurfaceConfig.ssviWeight` / `essviWeight`, passed to the `calibrateSSVI` / `calibrateESSVI`
   calls in the constructor.
3. Tests: vega-weighting tightens the ATM residual vs uniform on a noisy-wing surface; the `'uniform'` default
   reproduces the old fit; `assumptions.weight` is echoed; the `volatilitySurface` knob flows through; guards.

## Deferred (explicitly)

- **Bid/ask- or quote-count-weighted calibration** (weight by real quote quality, not just vega) — needs a
  richer quote input than the current `(k, w)` slices; this ships the model-free vega weighting.
