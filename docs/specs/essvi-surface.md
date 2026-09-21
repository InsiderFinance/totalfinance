# Spec — eSSVI: a per-maturity skew `ρ(θ)` (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the first SSVI follow-up: "eSSVI (per-maturity `ρ(θ)`)".
> Status: **shipped** as `calibrateESSVI`, `essviTotalVariance`, `essviVolatility`, `essviArbitrageFree` in
> `packages/volatility/src/essvi.ts`, covered by `packages/volatility/test/essvi.test.ts`, full CI green.

## Goal

`calibrateSSVI` parametrizes the whole surface with **one global skew `ρ`**. That is its strength (calendar
arbitrage is nearly free) and its limitation: real equity surfaces have a **term structure of skew** — short
maturities are steeply skewed (`ρ ≈ −0.8`), long maturities much flatter (`ρ ≈ −0.2`) — and a single `ρ`
cannot fit both. eSSVI (the "extended" SSVI of Gatheral–Jacquier / Hendriks–Martini) keeps the SSVI slice
form but lets **`ρ` vary with maturity**, `ρ = ρ(θ)`, while the curvature `φ(θ)` stays a global function:

```
w(k, θ) = (θ/2)·[ 1 + ρ(θ)·ψ·k + √((ψ·k + ρ(θ))² + (1 − ρ(θ)²)) ],   ψ = φ(θ),   θ = σ_ATM(t)²·t
```

At a fixed θ this is still an ordinary SSVI slice (hence a raw-SVI slice), so **evaluation and the Gatheral-`g`
butterfly test reuse `./svi.ts`/`./ssvi.ts`** exactly as SSVI does. When `ρ(θ)` is constant, eSSVI **is** SSVI
— the extension is strictly a superset, so it never fits worse.

_Verified numerically before implementation: constant `ρ(θ)` reproduces SSVI to 0; on a steep-short/mild-long
surface a single global `ρ` fits at RMSE ~1e-2 while per-slice `ρ` recovers the true skews to ~3e-17 (a ~1e14×
improvement); and a θ-monotone pair with a very steep short slice **still crosses in total variance**
(min Δw ≈ −0.07 < 0), proving the calendar check must scan the surface, not just test θ-monotonicity._

## The calendar-arbitrage subtlety (why eSSVI needs a real check)

For global-ρ SSVI, `θ(t)` non-decreasing is **sufficient** for no calendar arbitrage (the Gatheral–Jacquier
result). Once `ρ` varies this breaks: a short slice with a very negative `ρ` can push its deep-wing total
variance **above** a longer slice whose `θ` is only slightly larger (verified: `θ`s 0.020 < 0.021 but
`w_short(k=−0.6) = 0.180 > w_long = 0.108`). So eSSVI's `calendarArbitrageFree` is decided by the **definition**
— `w(k, t)` non-decreasing in `t` at every `k` — scanned on a dense `(k, t)` grid (knots **and** interpolated
maturities, since `θ` and `ρ` are interpolated between knots). The minimum `∂ₜw`-proxy (`Δw` between adjacent
`t`-grid steps) is reported; `< 0` ⇒ calendar arbitrage. Butterfly is per-slice as in SSVI (reduce to SVI at
each grid maturity, test Gatheral `g ≥ 0`), now scanned across the `t`-grid because each maturity has its own
`ρ`.

## Construction

- **Params** — `ESSVIParameters = { phi: SSVIPhi; thetaTerm: Array<{ t; theta; rho }> }`: the SSVI `φ` (power-law
  or Heston) plus per-knot `(t, θ, ρ)`. `θ` strictly increasing (calendar backbone); `ρ ∈ (−1, 1)` per knot.
- **Interpolation** — `θ(t)` linear in `t` (θ(0)=0, flat beyond the last knot), identical to SSVI; `ρ(t)`
  linear in `t` between knots, **flat** below the first / above the last knot (`ρ` can't be extrapolated to
  `t=0`). Monotone `θ` + smooth `ρ` — but calendar-freedom is still checked on the grid (see above).
- **Evaluation** — `essviTotalVariance(params, k, t)` / `essviVolatility(params, k, t)`: interpolate `θ(t)`, `ρ(t)`,
  set `ψ = φ(θ(t))`, evaluate the slice. `essviVolatility = √(w/t)`.
- **Diagnosis** — `essviArbitrageFree(params, opts?)`: `{ calendarArbitrageFree, butterflyArbitrageFree,
minButterflyG, minCalendarSlope }` over a `k`-grid × `t`-grid.
- **Calibration** — `calibrateESSVI(surface, opts?)`:
  1. `θ` knots from each slice's ATM total variance, made non-decreasing (clamp + disclose) — reuses the
     SSVI slice prep.
  2. **Warm-start from a global SSVI fit** (`calibrateSSVI`): its `ρ` seeds every knot's `ρ`, its `φ` seeds
     the curvature — so eSSVI starts from the best single-`ρ` surface and can only improve.
  3. Refine `(ρ₁…ρₘ, φ-params)` jointly by Nelder–Mead, minimizing total-variance SSE **plus a
     calendar-crossing penalty** (any `Δw < 0` on the grid is penalized), so the fit stays arbitrage-free.
  4. Report `parameters`, overall + per-slice RMSE, the arbitrage diagnosis, `converged`, and — the eSSVI payoff
     — the fitted `ρ(θ)` term structure.

## API

```ts
export type SSVIPhi = /* reused from ssvi.ts */;
export interface ESSVIParameters {
  phi: SSVIPhi;
  /** Per-knot `(t, θ, ρ)`; θ strictly increasing, ρ ∈ (−1, 1). */
  thetaTerm: Array<{ timeToExpiryYears: number; theta: number; rho: number }>;
}
export function essviTotalVariance(parameters: ESSVIParameters, k: number, t: number): number;
export function essviVolatility(parameters: ESSVIParameters, k: number, t: number): number;
export interface ESSVIArbitrage {
  calendarArbitrageFree: boolean;
  butterflyArbitrageFree: boolean;
  minButterflyG: number;
  /** Minimum `Δw` between adjacent maturities on the grid (`≥ 0` ⇔ calendar-free). */
  minCalendarSlope: number;
}
export function essviArbitrageFree(parameters: ESSVIParameters, opts?: { grid?: number[]; maturityGrid?: number[] }): ESSVIArbitrage;
export interface ESSVICalibrationInput { slices: SSVISliceInput[]; }   // reuses SSVI's slice type
export interface ESSVICalibrationOptions { phi?: 'power-law' | 'heston'; maximumIterations?: number; tolerance?: number; }
export interface ESSVICalibration {
  parameters: ESSVIParameters;
  rmse: number;
  perSliceRmse: Array<{ timeToExpiryYears: number; rmse: number }>;
  /** The fitted skew term structure — the point of eSSVI. */
  rhoTerm: Array<{ timeToExpiryYears: number; rho: number }>;
  arbitrage: ESSVIArbitrage;
  converged: boolean;
  assumptions: { conventionsVersion: string; phi: 'power-law' | 'heston'; skew: 'per-maturity' };
  diagnostics: Diagnostics;
}
export function calibrateESSVI(surface: ESSVICalibrationInput, opts?: ESSVICalibrationOptions): ESSVICalibration;
```

## Honesty / envelope contract

- **Strict superset of SSVI** — constant `ρ(θ)` reproduces SSVI; the warm start guarantees eSSVI's fit ≤
  SSVI's SSE. Disclosed via the `skew: 'per-maturity'` assumption.
- **Calendar arbitrage is checked honestly** — by the definition (grid crossing), not the θ-monotone
  shortcut that is _false_ for eSSVI; a residual crossing after calibration is a `volatility.essvi_calendar` warning,
  and butterfly a `volatility.essvi_butterfly` warning, mirroring SSVI.
- **Data arbitrage disclosed** — a non-monotone raw ATM term structure is clamped to its increasing hull with
  a `volatility.essvi_calendar_data` warning (reused from the SSVI prep).
- **Non-convergence disclosed** — `converged=false` + `volatility.essvi_not_converged`.
- **First-touch guards** — garbage `surface`/`parameters` throw typed `QuantError`s (`calibrateESSVI` /
  `essviArbitrageFree` are single-arg-object → garbage-sweep-covered; `essviTotalVariance` / `essviVolatility` get
  deep-sweep fixtures).
- **Envelope (R2)** — calibration returns the domain object + `assumptions` + `diagnostics`.

## Build checklist

1. `ESSVIParameters` + interpolation helpers (`thetaAt` reused; new `rhoAt`), `essviSliceParams(params, t)`.
2. `essviTotalVariance` / `essviVolatility` with param + `k`/`t` guards.
3. `essviArbitrageFree` — butterfly (per grid-maturity SVI reduction) + calendar (grid crossing).
4. `calibrateESSVI` — SSVI warm start → Nelder–Mead refine (SSE + calendar penalty) → RMSE + `rhoTerm` +
   arbitrage + warnings.
5. Exports in `index.ts`; deep-sweep fixtures for the two evaluators.
6. Tests: reduces-to-SSVI, skew-term-structure recovery + RMSE beats global SSVI, no-arb + crossing
   detection, interpolation, and all guards; 100% coverage.

## Deferred (explicitly)

- **Fully-general eSSVI** with a per-slice curvature `ψᵢ` free of a global `φ` (Hendriks–Martini), and the
  closed-form Martini–Mingone no-arbitrage inequalities in place of the grid scan.
- **A vega-weighted objective** and **wiring into `volatilitySurface` as `model: 'essvi'`** (shared with the SSVI
  follow-up list).
