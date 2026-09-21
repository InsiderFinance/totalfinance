# Spec — SSVI as a `volatilitySurface` model (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the SSVI follow-up: "wiring into `volatilitySurface` as `model: 'ssvi'`".
> Status: **shipped** as `model: 'ssvi'` on `volatilitySurface` in `packages/volatility/src/surface.ts`, covered by
> `packages/volatility/test/surface.test.ts` (ssvi cases), full CI green.

## Goal

`calibrateSSVI` / `ssviVolatility` already build the **Gatheral–Jacquier arbitrage-free** surface SVI (a global ATM
term structure `θ(t)`, a skew `ρ`, and a curvature `φ(θ)`, **calendar-arb-free by construction**). But it
lives outside the main `volatilitySurface` API a dashboard consumes — you can't say `volatilitySurface(chain, mkt, { model:
'ssvi' })` and get strike×expiry lookups, snapshots, shocks, and arbitrage diagnostics like every other
model. This wires SSVI in as a first-class **global** model, alongside the existing global `heston` — the same
integration pattern, so the surface's whole surface-level machinery (lookup, moneyness/delta axes,
`toRows`, `arbitrage()`, `toJSON`/`fromJSON`, `shock`) works unchanged.

## How it fits (mirrors `heston`)

SSVI, like Heston, is calibrated **once to the whole surface** (not per-expiry like `svi`/`sabr`):

1. After the per-expiry smiles are built, if `model: 'ssvi'`, assemble one `SSVISliceInput` per slice
   (`{ t, k: ln(K/F), iv }`) and call `calibrateSSVI({ slices }, { phi })`. The resulting `SSVIParameters` are
   stored on the surface (`VolatilitySurface.ssvi`) and mirrored onto every slice (`slice.ssvi`) — exactly as the
   global Heston params are.
2. A slice's smile closure is `K ↦ ssviVolatility(params, ln(K/F), t)` (built by the shared `buildSmile`, so a live,
   snapshot-restored, or shocked surface all answer `iv()` identically).
3. Cross-expiry lookups use SSVI's own `θ(t)` interpolation (linear-in-`θ` between knots) — **arbitrage-free
   in time by construction**, the whole point of SSVI over per-slice SVI.

## Config

- `model: 'ssvi'` — added to `SurfaceModel` and the accepted-model list.
- `ssviPhi?: 'power-law' | 'heston'` — the curvature family for the calibration (default `'power-law'`, matching
  `calibrateSSVI`).

## Honesty / verification

- **Reproduces the calibration.** Verified: `surface.iv(K, expiry)` for `model: 'ssvi'` equals a direct
  `ssviVolatility(fit.params, ln(K/F), t)` from an independent `calibrateSSVI` on the same slices — the surface is a
  thin, faithful wrapper, not a re-fit.
- **Arbitrage-free in time.** Verified: the wired surface passes its own `arbitrage()` calendar check across
  the `(k, t)` grid (SSVI's monotone `θ` guarantees it), where a per-slice `svi` surface need not.
- **Convergence & arbitrage disclosed.** A non-converged calibration raises the surface's standard
  `volatility.fit_unconverged` warning (with the RMSE), and a residual **butterfly** or **calendar** arbitrage in the
  fit (`!butterflyArbitrageFree` / `!calendarArbitrageFree`) raises a `volatility.butterfly_arbitrage` /
  `volatility.calendar_arbitrage` warning — the surface never claims arb-freedom it doesn't have.
- **Snapshot & shock round-trip.** Verified: `VolatilitySurface.fromJSON(surface.toJSON())` answers `iv()` identically
  (the `SSVIParameters` — including the `phi` object and the `θ` term-structure array — are deep-copied, never
  aliased), and `shock` degrades a parametric `ssvi` surface to `interpolated` with the standard
  `volatility.shock_degraded_to_interpolated` warning, exactly like `heston`/`svi`/`sabr`.
- **Guards.** An unknown model is already rejected; SSVI inherits every surface-level guard (empty quotes,
  non-positive spot, sparse slices). `phi` defaults sensibly.

## Build checklist

1. Register `'ssvi'` in `SurfaceModel` + `SURFACE_MODELS`; add `SurfaceConfig.ssviPhi`; add
   `SurfaceSlice.ssvi` + `VolatilitySurfaceSnapshot.ssvi` + the `VolatilitySurface.ssvi` field.
2. Constructor: the global `calibrateSSVI` block (mirroring the Heston block) — store + mirror params, emit
   convergence + arbitrage warnings.
3. `buildSmile`: the `ssvi` branch (`ssviVolatility`); `methodFor`: the `ssvi` label; `cloneSlice`: deep-copy the
   `SSVIParameters`; `shock`: treat `ssvi` as parametric; `toJSON`/`fromJSON`/`fromParts`: thread the global
   `ssvi` params.
4. Tests: reproduces `ssviVolatility`, calendar-arb-free vs a per-slice `svi` surface, per-expiry + interpolated-`t`
   lookup, snapshot `iv()`-identity, shock degradation, and the convergence/arbitrage disclosures; keep the
   surface suite's coverage.

## Deferred (explicitly)

- **eSSVI as a `volatilitySurface` model** (per-maturity skew `ρ(θ)`) and **vega-weighted SSVI calibration** — the
  other SSVI/eSSVI follow-ups; this ships the global SSVI wiring.
