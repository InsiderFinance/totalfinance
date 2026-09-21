# Spec — Multi-curve (dual-curve, OIS-discounted) bootstrapping (`@totalfinance/fixed-income`)

## Goal

Post-2008, an interest-rate swap is discounted on the collateral (OIS) curve while its floating
coupons project off a separate index (e.g. term-SOFR/EURIBOR) curve. The valuation side already
supports this — `swapValue`/`swaptionPrice`/`capFloorPrice`/`cmsConvexityAdjustment` all take
`SwapCurves = { discountCurve, forecastCurve? }`. What was missing is the **construction** side: a
bootstrap that builds the index **projection curve** from par IRS quotes whose legs are discounted on
a **separate OIS curve**. This spec adds that, so a user can go from market quotes to a ready
dual-curve set in one call.

## The construction

Single-curve `curves.bootstrap` self-discounts: on one curve the floating leg telescopes to
`1 − DF(T)`, giving `rate · Σ τᵢ·DF(tᵢ) = 1 − DF(T)`, solved for the terminal `DF(T)`. Under
dual-curve discounting the float leg does **not** telescope, because projection and discounting use
different curves. For a par swap of fixed rate `K` maturing `Tₙ`, discounting on the OIS curve `D`
and projecting off the curve being built `P`:

```
K · Σᵢ τᵢ·D(tᵢ)   =   Σⱼ Fⱼ·τⱼ·D(tⱼ)         (par: fixed PV = float PV)
Fⱼ = ( P(tⱼ₋₁)/P(tⱼ) − 1 ) / τⱼ               (simple forward off the projection curve)
```

The fixed annuity `Σ τᵢ·D(tᵢ)` is known (D is fixed). The floating forwards `Fⱼ` depend on the
projection curve, whose terminal pillar `P(Tₙ)` is the single unknown; everything shorter is already
bootstrapped. A 1-D Brent solve on `P(Tₙ)` reprices the swap to par. Deposits/FRAs/futures pin the
projection curve exactly as in the single-curve bootstrap (they define forwards, not discounting).

The residual is computed with **the same conventions as `swapValue`** — fixed annuity `Σ τ·D(payDate)`,
float `Σ F·τ·D(payDate)` with `F = P.forwardRate(accrualStart, accrualEnd, dc)` — so a curve
bootstrapped here reprices its inputs to par under the real pricer (asserted in tests to < 1e-10).

## Honesty / envelope contract

- Builders reject invalid input by construction (Law 12): unknown option keys, a non-curve
  `discountCurve` (raw object), empty instrument lists, and pre-reference maturities all throw typed
  `QuantError`s, never a raw `TypeError` or a silent NaN curve.
- Non-convergence of a pillar solve throws `ConvergenceError [solver.no_convergence]` naming the
  offending instrument.
- The returned curves are ordinary immutable `YieldCurve`s (same as `curves.bootstrap`); the
  multi-curve set is a plain `{ discountCurve, forecastCurve }` — the exact `SwapCurves` shape the
  swap analytics consume, so it drops in with no adapter.

## API (`curves.*`)

```ts
// Bootstrap an index projection curve, discounting each swap on the supplied OIS curve.
curves.bootstrapProjection(
  instruments: BootstrapInstrument[],
  opts: { referenceDate: string; discountCurve: YieldCurve; dayCount?; interpolation?; extrapolation? },
): YieldCurve;

// One call: OIS discount curve + index projection curve → a ready dual-curve set.
curves.bootstrapMultiCurve(
  opts: { referenceDate: string; ois: BootstrapInstrument[]; projection: BootstrapInstrument[]; dayCount?; interpolation?; extrapolation? },
): { discountCurve: YieldCurve; forecastCurve: YieldCurve };
```

`SwapInstrument` gains optional `floatFrequency` (default `quarterly`) and `floatDayCount` (default
`ACT/360`) used only by the projection bootstrap.

## Build checklist

- [x] `SwapInstrument` float-leg conventions (`floatFrequency`/`floatDayCount`).
- [x] Shared pillar-accumulation loop; single-curve `bootstrap` refactored onto it (regression-safe).
- [x] `bootstrapProjection` — OIS-discounted dual-curve pillar solve.
- [x] `bootstrapMultiCurve` — front-door returning `SwapCurves`.
- [x] Registered on the `curves` namespace; types exported; first-touch deep-sweep fixture.
- [x] Tests: known-curve recovery, reprice-to-par under `swapValue`, single≡dual consistency,
      deposit/FRA short-end, OIS–index basis, Law 12 validation.

## Deferred (explicitly)

- Turn-of-year / meeting-date step curves and a per-instrument basis-spread overlay.
- Cross-currency basis discounting (its own workstream — the next Wave 1 item).
- Simultaneous global (all-instruments-at-once) calibration; this is the standard sequential
  ascending-maturity bootstrap.
