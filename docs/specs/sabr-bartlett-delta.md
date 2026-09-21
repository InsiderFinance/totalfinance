# Spec — SABR Bartlett (minimum-variance) delta & vega (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the `minimumVarianceDelta` follow-up: "a SABR/Bartlett backbone β,
> minimum-variance vega/gamma".
> Status: **shipped** as `sabrBartlettGreeks` in `packages/volatility/src/sabr-delta.ts`, covered by
> `packages/volatility/test/sabr-delta.test.ts`, full CI green.

## Goal

`minimumVarianceDelta` gives the smile-adjusted delta from an _externally supplied_ vol–spot sensitivity
`β = ∂σ/∂S`. When the smile is a **SABR** fit, that sensitivity is not a free input — the model _dictates_ it,
because SABR's forward `F` and its vol level `α` are correlated (`dW_F · dW_α = ρ timeStepYears`). Bartlett (2006)
derived the resulting **minimum-variance greeks**: the hedge ratios that account for the vol move that, on
average, _accompanies_ a forward move (and vice-versa). This ships `sabrBartlettGreeks` — the Bartlett delta
and vega for a SABR-parametrised option, the model-consistent realization of the minimum-variance hedge.

## The formulas

Under SABR, `dF = α F^β dW_F`, `dα = ν α dW_α`, `⟨dW_F, dW_α⟩ = ρ timeStepYears`. So a forward move of `δF` is
accompanied by an expected vol-level move `E[δα | δF] = (ρν / F^β)·δF`, and an `α` move of `δα` by an expected
`E[δF | δα] = (ρ F^β / ν)·δα`. Applying the chain rule to the SABR price `V(F, α)` (Black-76 / Bachelier at
the Hagan vol) gives:

```
Δ_Bartlett = ∂V/∂F + ∂V/∂α · (ρν / F^β)            (min-variance delta)
V_Bartlett = ∂V/∂α + ∂V/∂F · (ρ F^β / ν)           (min-variance vega, w.r.t. α)
```

`∂V/∂F` (the **total** SABR delta, holding params fixed — it already includes the Hagan vol's own
`F`-dependence) and `∂V/∂α` (the SABR vega, w.r.t. the level `α`) are exactly the finite-difference greeks
`sabrPrice(…, { greeks: true })` already computes, so `sabrBartlettGreeks` composes that verified engine and
adds the two correlation-coupling terms. The coupling `ρν/F^β` is independent of `α` and reduces to `ρν` for
the normal backbone (`β = 0`).

## Honesty / verification

- **Matches a correlated-bump reprice.** The definitive check: the Bartlett delta equals the central
  finite difference of the SABR price under the _correlated_ bump `(F ± δF, α ± (ρν/F^β)·δF)`, and the
  Bartlett vega under `(F ± (ρF^β/ν)·δα, α ± δα)`. _Verified to ~1e-8 relative_ (β = 0.5, ρ = −0.3, ν = 0.4).
- **Correct signs & limits.** For an equity skew (`ρ < 0`) the Bartlett delta of a call is **below** the naive
  SABR delta (as `F` rises the vol falls, so the call gains less) — verified −0.079 at ρ = −0.5; symmetric and
  **exactly zero at ρ = 0** (no correlation ⇒ Bartlett = naive). The adjustment scales with `ρ`.
- **Decomposition reported.** The result carries both the naive SABR greeks and the Bartlett greeks plus the
  adjustment (`bartlett − naive`), so a caller sees the size of the correlation correction, not just the
  final number.
- **Units.** `sabrDelta`/`bartlettDelta` are raw (per 1.00 of forward); `sabrVega`/`bartlettVega` are display
  (per 1% of `α`), matching the `sabrPrice` convention. All greeks are w.r.t. the **forward** (SABR is a
  forward model), as in `sabrPrice`.
- **Guards.** Reuses `sabrPrice`/`sabrVolatility` validation (`α > 0`, `β ∈ [0,1]`, `ρ ∈ (−1,1)`, `ν ≥ 0`, positive
  strike/`t`, `forward` or `spot`). `ν = 0` (no vol-of-vol) has no Bartlett vega coupling by definition — the
  `ρF^β/ν` term is undefined, so `ν = 0` is a typed error for the vega (the delta coupling `ρν/F^β` is 0, so a
  degenerate `ν = 0` simply gives Bartlett = naive; but with no stochastic vol the whole model is degenerate,
  so we reject `ν = 0` up front with a clear message). The named request object is covered by the standard
  deep-sweep fixture.

## API

```ts
// Reuses SabrInput and SabrParameters from @totalfinance/options.
export interface SabrBartlettOptions {
  /** Hagan expansion: 'lognormal' (Black, default) or 'normal' (Bachelier). */
  volatilityType?: 'lognormal' | 'normal';
}

export interface SabrBartlettGreeks {
  /** Hagan implied vol at (F, K, t). */
  impliedVolatility: number;
  /** ∂V/∂F holding params fixed — the naive SABR (model) delta. */
  sabrDelta: number;
  /** The Bartlett minimum-variance delta. */
  bartlettDelta: number;
  /** bartlettDelta − sabrDelta — the correlation contribution to the delta. */
  deltaAdjustment: number;
  /** ∂V/∂α, per 1% — the naive SABR vega. */
  sabrVega: number;
  /** The Bartlett minimum-variance vega, per 1%. */
  bartlettVega: number;
  /** bartlettVega − sabrVega — the correlation contribution to the vega. */
  vegaAdjustment: number;
}

export function sabrBartlettGreeks(
  type: OptionType,
  input: SabrInput,
  parameters: SabrParameters,
  opts?: SabrBartlettOptions,
): Computed<
  SabrBartlettGreeks,
  { measure: 'min-variance-hedge'; model: 'sabr'; volatilityType: string }
>;
```

## Build checklist

1. `sabrBartlettGreeks` — resolve `F`; `sabrVolatility` for the implied vol; `sabrPrice(…, { greeks: true })` for the
   naive delta/vega; apply the two coupling terms; assemble the `Computed` envelope.
2. Export (`sabrBartlettGreeks`, `SabrBartlettOptions`, `SabrBartlettGreeks`) in `index.ts`; a vitest alias for
   the subpath is not required (no deep entrypoint).
3. Tests: the correlated-bump FD match (delta and vega), the ρ-sign sanity + ρ = 0 ⇒ Bartlett = naive, the
   normal (Bachelier) backbone, the decomposition invariant, and the guards; 100% coverage of the new code.

## Deferred (explicitly)

- **Minimum-variance gamma** — ✅ shipped as the `sabrGamma` / `bartlettGamma` / `gammaAdjustment` fields on
  this same result; see [`sabr-bartlett-gamma.md`](./sabr-bartlett-gamma.md).
- **Empirical β estimation from an IV/return history** — the remaining `minimumVarianceDelta` follow-up (a
  data/regression tool, not a model greek).
