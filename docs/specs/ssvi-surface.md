# Spec — SSVI arbitrage-free surface (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → _"SSVI/eSSVI global surface calibration with arbitrage-free
> interpolation in time."_ Status: **shipped** as `calibrateSSVI` / `ssviVolatility` / `ssviTotalVariance` /
> `ssviArbitrageFree` in `packages/volatility/src/ssvi.ts`, covered by `packages/volatility/test/ssvi.test.ts`, full
> CI green. (eSSVI — per-maturity ρ — is a documented follow-up.)

## Goal

The package already fits **per-slice SVI** (`fitSVI`) — one smile at a time. But independent slices can
**cross in maturity**, producing calendar-spread arbitrage the per-slice fit can't see. **SSVI**
(Gatheral–Jacquier, _Arbitrage-free SVI volatility surfaces_, 2014) parametrizes the **whole surface**
with the ATM total-variance term structure `θ(t)` plus a global skew `ρ` and a curvature function
`φ(θ)`, and is **free of calendar arbitrage by construction** whenever `θ(t)` is non-decreasing. This
adds that surface: a global fit, the no-arbitrage diagnostics, and **arbitrage-free interpolation in
time** so the surface is evaluable at any maturity, not just the observed ones.

## The SSVI parametrization

Total implied variance as a function of log-moneyness `k = ln(K/F)` and the ATM total variance `θ = θ(t)`:

```
w(k, θ) = (θ/2)·[ 1 + ρ·φ(θ)·k + √( (φ(θ)·k + ρ)² + (1 − ρ²) ) ]
```

- At `k = 0`: `w(0, θ) = θ` — the ATM total variance, exactly (verified). So `θ(t) = σ_ATM(t)²·t`.
- `ρ ∈ (−1, 1)` is the skew (rotation); `φ(θ) > 0` sets the curvature (smile width).
- **φ functions** (`options.phi`):
  - `'power-law'` (default): `φ(θ) = η·θ^(−γ)`, `η > 0`, `γ ∈ (0, 1)`.
  - `'heston'`: `φ(θ) = (1/(λθ))·(1 − (1 − e^(−λθ))/(λθ))`, `λ > 0` (the large-maturity Heston shape).

### Exact reduction to raw SVI

SSVI at a fixed `θ` **is** a raw-SVI slice, so the Gatheral `g` density / butterfly check reuses the
existing SVI machinery (`sviButterflyFree` / `sviMinG`) rather than re-deriving the density (evaluation
itself uses the closed SSVI formula directly). The algebra (verified to 1e-17):

```
a = (θ/2)(1 − ρ²)    b = θ·φ(θ)/2    ρ_svi = ρ    m = −ρ/φ(θ)    σ = √(1 − ρ²)/φ(θ)
```

## No-arbitrage

- **Calendar** (no crossing in maturity) — guaranteed when `θ(t)` is non-decreasing **and**
  `0 ≤ ∂_θ(θφ(θ)) ≤ (1/ρ²)·(1 + √(1−ρ²))·φ(θ)` (Gatheral–Jacquier). The first is enforced by
  construction (θ knots are made monotone; a non-monotone raw ATM term structure is a data arbitrage —
  clamped to its increasing hull with a `volatility.ssvi_calendar_data` warning). The `∂_θ(θφ)` bound is
  checked and disclosed. _(Verified: `w(k, θ₂) ≥ w(k, θ₁)` for all `k` when `θ₂ > θ₁`.)_
- **Butterfly** (non-negative risk-neutral density) — checked **exactly** per θ-knot via the Gatheral
  `g(k) ≥ 0` density test on the reduced SVI slice (`sviButterflyFree`), reported as `minButterflyG`.
  The Gatheral–Jacquier **sufficient** conditions `θφ(1+|ρ|) < 4` and `θφ²(1+|ρ|) ≤ 4` are reported too
  — they guarantee arb-freedom for **all** `k` (not just the grid), but are conservative (the exact `g`
  test can still pass when they fail; verified).

## Calibration

`calibrateSSVI(surface)` fits the surface to market total variances:

1. **θ knots from ATM.** For each maturity slice, `θ_i` = the total variance at `k = 0` (interpolated
   from the two nearest points when `k = 0` isn't observed). Sort by `t`; enforce monotonicity (clamp to
   the running max, warn on any clamp).
2. **Global `ρ`, `φ`-params by least squares.** Minimize `Σ_i Σ_j (w_SSVI(k_ij, θ_i) − w_ij)²` over
   `ρ` and the φ-parameters (`η, γ` or `λ`) with Nelder–Mead, bounded to the valid region. _(Verified:
   recovers `ρ = −0.5, η = 2, γ = 0.4` from a synthetic surface to sse 1e-30.)_
3. **Diagnose.** Report the fit RMSE (total-variance units), per-slice RMSE, and the calendar/butterfly
   arbitrage status of the calibrated surface.

## Interpolation in time

`θ(t)` is interpolated **linearly in `t`** between knots (monotone, so calendar-arb-free preserved),
from the origin `θ(0) = 0` to the first knot, and held flat beyond the last knot (constant total
variance — a decreasing vol, disclosed). `φ(θ(t))` follows from the φ function, so `ssviVolatility(params, k, t)`
is defined and arbitrage-consistent at **any** maturity.

## Honesty / envelope contract

- **Calendar-arb-free by construction, and said so** — monotone θ is enforced; a non-monotone input term
  structure is clamped with a warning rather than silently producing a crossing surface.
- **Butterfly checked exactly** — the reported `butterflyArbitrageFree` is the exact `g ≥ 0` density
  test, not just the sufficient conditions; both are surfaced.
- **Fit quality disclosed** — RMSE overall and per slice; `converged` from the optimizer; a poor fit is
  visible, never hidden.
- **Flat-vol extrapolation, documented** — evaluating past the last calibrated maturity holds θ
  constant (a decreasing vol) rather than fabricating a term structure it didn't calibrate; the
  behaviour is documented on `ssviTotalVariance`/`ssviVolatility` (which, like `sviVolatility`, return a plain number
  and so carry no per-call envelope). The calibrated `thetaTerm` exposes the fitted maturity range.
- Typed guards (≥ 2 slices with ≥ 3 points each for identifiability; valid φ params; `t > 0`; aligned
  `k`/`w`); pure and deterministic.

## API

```ts
type SSVIPhi =
  | { kind: 'power-law'; eta: number; gamma: number }
  | { kind: 'heston'; lambda: number };
interface SSVIParameters {
  rho: number;
  phi: SSVIPhi;
  thetaTerm: Array<{ timeToExpiryYears: number; theta: number }>; // increasing θ knots
}
interface SSVISliceInput {
  timeToExpiryYears: number; // maturity (years)
  k: number[]; // log-moneyness ln(K/F)
  w?: number[]; // total variance σ²·t (aligned to k) — or
  impliedVolatility?: number[]; // implied vols (aligned to k); converted to w = iv²·t
}
interface SSVICalibrationInput {
  slices: SSVISliceInput[];
}
interface SSVICalibrationOptions {
  phi?: 'power-law' | 'heston';
  maximumIterations?: number;
  tolerance?: number;
}
interface SSVIArbitrage {
  calendarArbitrageFree: boolean;
  butterflyArbitrageFree: boolean;
  minButterflyG: number; // min Gatheral g over the grid (≥ 0 ⇔ free)
  sufficientConditionsHold: boolean; // the GJ θφ(1+|ρ|)<4 & θφ²(1+|ρ|)≤4 (conservative)
}
interface SSVICalibration {
  parameters: SSVIParameters;
  rmse: number;
  perSliceRmse: Array<{ timeToExpiryYears: number; rmse: number }>;
  arbitrage: SSVIArbitrage;
  converged: boolean;
  assumptions: { conventionsVersion: string; phi: 'power-law' | 'heston' };
  diagnostics: Diagnostics;
}
function ssviTotalVariance(parameters: SSVIParameters, k: number, t: number): number;
function ssviVolatility(parameters: SSVIParameters, k: number, t: number): number;
function ssviArbitrageFree(parameters: SSVIParameters, opts?: { grid?: number[] }): SSVIArbitrage;
function calibrateSSVI(
  surface: SSVICalibrationInput,
  opts?: SSVICalibrationOptions,
): SSVICalibration;
```

## Build checklist

1. **Core** — `phiValue`, `ssviTotalVariance`/`ssviVolatility` with θ(t) interpolation, the internal SSVI→SVI
   reduction (reuse `sviButterflyFree`/`sviMinG` for the density check).
2. **Arbitrage** — `ssviArbitrageFree`: calendar (monotone θ + ∂θ bound), butterfly (exact `g` + GJ
   sufficient), `minButterflyG`.
3. **Calibration** — θ from ATM (+ monotone clamp/warn), global `ρ`/φ least squares (Nelder–Mead),
   RMSE + per-slice RMSE + arbitrage diagnosis.
4. **Exports + API report + READMEs/llms** (+ deep-sweep fixtures for the multi-arg evaluators).
5. **Tests** — `w(0,t) = θ`; SSVI = the reduced SVI; calibration recovers synthetic `ρ/η/γ`;
   calendar-arb-free (`w` monotone in `t`); butterfly arb detected on a bad slice and cleared on a good
   one; time interpolation between/around knots; non-monotone ATM data clamped + warned; guards.

## Deferred (explicitly)

- **eSSVI** — per-maturity `ρ(θ)` (Corbetta et al. / Hendriks–Martini) for a closer skew-term-structure
  fit, with its stricter no-arbitrage conditions.
- **Wiring SSVI into `volatilitySurface`** as a `model: 'ssvi'` so it flows through the existing surface façade.
- **Vega-weighted / robust calibration** and a mean-excess-style threshold for outlier quotes.
- **A `φ` with a global no-arb guarantee** (Gatheral–Jacquier's `η/(θ^γ (1+θ)^{1−γ})`) as an option.
