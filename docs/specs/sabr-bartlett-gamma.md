# Spec — SABR Bartlett (minimum-variance) gamma (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the `minimumVarianceDelta` follow-up: "minimum-variance vega/**gamma**".
> Status: **shipped** as three fields on `sabrBartlettGreeks` (`sabrGamma`, `bartlettGamma`,
> `gammaAdjustment`) in `packages/volatility/src/sabr-delta.ts`, covered by
> `packages/volatility/test/sabr-delta.test.ts`, full CI green.

## Goal

`sabrBartlettGreeks` already returns the Bartlett minimum-variance **delta** and **vega**. This adds the
second-order companion — the minimum-variance **gamma**: the convexity of the SABR price along the correlated
hedge path, the P&L convexity a Bartlett-delta-hedger actually experiences when the forward moves and the vol
level moves with it. It folds into the existing result (no new function) so one call gives the full Bartlett
hedge set.

## Definition

The Bartlett hedge follows the path `α(F)` on which a forward move drags the vol level by
`dα/dF = ρν / F^β`. Integrating, `α(F') = α + ρν·(F'^{1−β} − F^{1−β})/(1−β)` (and the `β = 1` limit
`α + ρν·ln(F'/F)`). The **Bartlett gamma is the second derivative of the price along that path**:

```
Γ_Bartlett = d²/dF² V(F, α(F))   evaluated at the base (F, α)
```

Computed as the central second difference of `sabrPrice` along the exact path
`(F ± δ, α(F ± δ))`. Equivalently (verified to agree), the analytic total derivative
`Γ_B = V_FF + 2·(ρν/F^β)·V_Fα + (ρν/F^β)²·V_αα + V_α·(−βρν/F^{β+1})` — where `V_FF` is the naive SABR gamma.
The naive gamma `sabrGamma = ∂²V/∂F²` (params fixed, from `sabrPrice`) and the adjustment
`gammaAdjustment = bartlettGamma − sabrGamma` are reported alongside.

## Why it matters (the OTM finding)

Unlike the Bartlett **delta** (a first-order quantity whose adjustment is large near the money), the gamma
adjustment is **≈ 0 exactly at the money** — there the gamma is at its symmetric peak and the correlated-path
convexity correction cancels. It is **material away from the money**, where the correlated vol move reshapes
the convexity profile: _verified at F = 100, β = 0.5, ρ = −0.3, ν = 0.4, T = 1 — +27% at K = 80, −11% at
K = 110, −22% at K = 120; and ±60–150% for high-ν / long-dated OTM strikes._ So the naive SABR gamma is
materially wrong for OTM options under correlated SABR dynamics, exactly where a lot of options flow lives.

## Honesty / verification

- **Matches the exact-path reprice.** The definitive check: `bartlettGamma` equals the central second
  difference of the SABR price along the exact correlated path `α(F')`, to ~1e-6 relative — and the analytic
  total-derivative formula agrees. Verified for `β ∈ {0, 0.5, 1}` (the log-path limit at `β = 1`) and both
  signs of `ρ`.
- **ATM limit.** At `K = F` the adjustment is ≈ 0 (reported as such, not hidden) — the correction is a
  wing effect.
- **Decomposition.** `gammaAdjustment = bartlettGamma − sabrGamma` exactly; all three reported so the caller
  sees the size and sign of the convexity reshaping.
- **Units & guards.** `sabrGamma` / `bartlettGamma` are raw (per 1.00 of forward, ∂²/∂F²), matching
  `sabrPrice`. Same guards as the delta/vega (`ν > 0` etc.); the `β = 1` path uses the log form so no
  `1/(1−β)` blow-up.

## API (additive)

```ts
export interface SabrBartlettGreeks {
  impliedVolatility: number;
  sabrDelta: number;
  bartlettDelta: number;
  deltaAdjustment: number;
  sabrVega: number;
  bartlettVega: number;
  vegaAdjustment: number;
  // added:
  /** ∂²V/∂F² holding params fixed — the naive SABR gamma, per 1.00 of forward. */
  sabrGamma: number;
  /** The Bartlett minimum-variance gamma — d²V/dF² along the correlated hedge path. */
  bartlettGamma: number;
  /** bartlettGamma − sabrGamma — the correlation contribution to the gamma (≈ 0 at the money). */
  gammaAdjustment: number;
}
```

## Build checklist

1. `resolveForward` → return `{ F, r }` (the reprice needs the discount rate).
2. In `sabrBartlettGreeks`: take `sabrGamma` from `sabrPrice`'s greeks; compute `bartlettGamma` as the
   central second difference of a forward-based `sabrPrice` reprice along the exact path `α(F ± δ)` (with the
   `β = 1` log limit); report the adjustment.
3. Tests: `bartlettGamma` vs the exact-path second difference, the material OTM adjustment + the ATM ≈ 0
   limit, the `β = 1` log path, and the decomposition invariant; keep 100% coverage.
4. Update `sabr-bartlett-delta.md`'s deferred list (gamma now shipped) and the roadmap.

## Deferred (explicitly)

- **Empirical β (∂σ/∂S) estimation** from an IV/return history — the remaining `minimumVarianceDelta`
  follow-up (a data/regression tool, not a model greek).
