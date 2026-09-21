# Spec — eSSVI as a `volatilitySurface` model (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the eSSVI / SSVI-surface follow-up: "eSSVI as a `volatilitySurface` model".
> Status: **shipped** as `model: 'essvi'` on `volatilitySurface` in `packages/volatility/src/surface.ts`, covered by
> `packages/volatility/test/surface-models.test.ts` (essvi cases), full CI green.

## Goal

`calibrateESSVI` / `essviVolatility` build the **eSSVI** surface — SSVI extended with a **per-maturity skew** `ρ(θ)`,
a strict superset that fits a steep short-dated skew and a mild long-dated one at once (where global-ρ SSVI
cannot). Having just wired the arbitrage-free **SSVI** into `volatilitySurface` as `model: 'ssvi'`, this adds eSSVI as
the sibling global model `model: 'essvi'`, using the **same integration** — so the full surface API (lookup,
axes, `arbitrage()`, `toRows`, `toJSON`/`fromJSON`, `shock`) works on the eSSVI surface.

## How it fits (mirrors `model: 'ssvi'` / `heston`)

eSSVI is calibrated **once to the whole surface**, exactly like SSVI and Heston:

1. After the per-expiry smiles are built, if `model: 'essvi'`, assemble one `ESSVISliceInput` per slice
   (`{ t, k: ln(K/F), iv }`) and call `calibrateESSVI({ slices }, { phi })`. The resulting `ESSVIParameters` are
   stored on the surface (`VolatilitySurface.essvi`) and mirrored onto every slice (`slice.essvi`).
2. A slice's smile closure is `K ↦ essviVolatility(params, ln(K/F), t)`, built by the shared `buildSmile`.
3. Cross-expiry lookups use eSSVI's own `θ(t)` / `ρ(t)` term structures.

## The one real difference from SSVI: calendar arbitrage is not free-by-construction

SSVI's single global `ρ` + a monotone `θ` **guarantee** calendar-arbitrage-freedom. eSSVI lets `ρ` vary per
maturity, so a θ-monotone fit **can still cross in total variance** — calendar-arb-freedom is no longer
automatic (the calibration checks it on the `(k, t)` grid). So the surface's **calendar-arbitrage warning is a
genuinely reachable disclosure here**, not the defensive branch it is for SSVI: `!calendarArbitrageFree`
raises a `volatility.calendar_arbitrage` warning (and `!butterflyArbitrageFree` a `volatility.butterfly_arbitrage` warning),
so a caller is told when the extra flexibility bought a residual arbitrage.

## Config

- `model: 'essvi'` — added to `SurfaceModel` and the accepted-model list.
- `essviPhi?: 'power-law' | 'heston'` — the curvature family for the calibration (default `'power-law'`).

## Honesty / verification

- **Reproduces the calibration.** Verified: `surface.iv(K, expiry)` equals a direct
  `essviVolatility(fit.params, ln(K/F), t)` from an independent `calibrateESSVI` on the same slices (exact — the
  surface faithfully evaluates its own calibrated params, never re-fits).
- **Recovers per-maturity skew.** Verified: on a chain generated from a known eSSVI with a **steep-short /
  mild-long** `ρ(θ)`, the wired surface recovers the term structure of skew (the payoff over global-ρ SSVI) and
  reprices the surface to a few vol bp — and captures the differing short/long skew that a single-`ρ` `ssvi`
  surface fit to the same chain cannot.
- **Convergence & arbitrage disclosed.** A non-converged calibration raises `volatility.fit_unconverged` (with the
  RMSE); a residual butterfly or **calendar** arbitrage raises the matching warning — the calendar one being
  reachable, unlike for SSVI.
- **Snapshot & shock round-trip.** Verified: `VolatilitySurface.fromJSON(surface.toJSON())` answers `iv()` identically
  (the `ESSVIParameters` — `phi` object and the `(t, θ, ρ)` term-structure array — deep-copied, never aliased), and
  `shock` degrades a parametric `essvi` surface to `interpolated` with the standard warning.

## Build checklist

1. Register `'essvi'` in `SurfaceModel` + `SURFACE_MODELS`; add `SurfaceConfig.essviPhi`,
   `SurfaceSlice.essvi`, `VolatilitySurfaceSnapshot.essvi`, and the `VolatilitySurface.essvi` field.
2. Constructor: the global `calibrateESSVI` block (mirroring the `ssvi` block) — store + mirror params, emit
   convergence + arbitrage warnings.
3. `buildSmile`: the `essvi` branch (`essviVolatility`); `methodFor`: the `essvi` label; `cloneESSVI`: deep-copy the
   `ESSVIParameters`; `shock`: treat `essvi` as parametric; `toJSON`/`fromJSON`/`fromParts`: thread the global
   `essvi` params.
4. Tests: reproduces `essviVolatility`, recovers a steep-short/mild-long `ρ(θ)` (and beats a single-ρ `ssvi` fit on
   the same chain), per-expiry lookup, snapshot `iv()`-identity, shock degradation, and the `essviPhi` knob.

## Deferred (explicitly)

- **Vega-weighted SSVI/eSSVI calibration** — the remaining SSVI/eSSVI follow-up (weight the least-squares by
  vega so ATM/liquid strikes dominate); this ships the global eSSVI surface wiring.
