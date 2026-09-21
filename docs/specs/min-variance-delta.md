# Spec — Minimum-variance (smile-adjusted) delta (`@totalfinance/volatility`)

> Roadmap Tier 2 → "Options & vol": _"minimum-variance (smile-adjusted) delta."_ The hedge ratio that
> accounts for the systematic co-movement of implied vol with spot along the skew — cutting real-world
> hedging error versus the naive Black-Scholes delta. Status: **shipped** as `minimumVarianceDelta` in
> `packages/volatility/src/min-variance-delta.ts`, covered by `packages/volatility/test/min-variance-delta.test.ts`,
> full CI green.

## Goal

The BSM delta `∂V/∂S` holds implied vol fixed. In reality an option's IV moves with spot (the leverage
effect / a sticky smile), so the P&L-minimizing hedge is

```
Δ_MV = ∂V/∂S + ∂V/∂σ · (∂σ/∂S) = Δ_BS + Vega · β,   β ≡ ∂σ/∂S
```

`minimumVarianceDelta` computes this from an option's parameters and the vol–spot sensitivity `β`,
returning the adjusted delta, the BSM delta, and the skew adjustment — the number a trader actually
hedges with.

## The one thing that must be exact: β and units

- `β = ∂σ/∂S` is in **decimal vol per $1 of spot** (e.g. `β = −0.002` ⇒ IV falls 0.2 vol points per +$1).
- **The honest β is empirical** — the regression slope of realized IV changes on spot changes (the
  minimum-variance β; for equities it is negative, the leverage effect). This is the primary input and
  is what makes the result _minimum-variance_, not a model artifact.
- **Deriving β from the current smile** needs a **regime** assumption, offered as a convenience:
  - `sticky-strike` — a fixed strike's IV doesn't move with spot ⇒ `β = 0` ⇒ `Δ_MV = Δ_BS`.
  - `sticky-moneyness` — the smile is fixed in `ln(K/F)`, so a fixed strike slides along it ⇒
    `β = −skewSlope / spot` (`skewSlope = ∂σ/∂ln(K)` from `SkewMetrics.skewSlope`). **This is a smile
    model, not the leverage effect** — it can even sign β the "wrong" way for an equity put-skew; use it
    only when the smile genuinely rides moneyness. For leverage/backbone dynamics, supply `volatilitySpotBeta`.
- **Units bridge:** `blackScholesGreeks(...).vega` is DISPLAY (per 1% = per 0.01 vol); the formula needs RAW vega
  (per 1.00 vol) `= vega_display · 100`, multiplied by `β` (per $). The function computes `Δ_BS` and
  vega internally via `blackScholesGreeks`, so the units are handled once, in one place.

## API

```ts
interface MinimumVarianceDeltaOptions {
  type: OptionType; // 'call' | 'put'
  spot: number;
  strike: number;
  timeToExpiryYears: number; // years to expiry
  riskFreeRate: number;
  volatility: number; // the option's implied vol (decimal)
  dividendYield?: number; // default 0
  // The vol–spot sensitivity, exactly ONE of:
  volatilitySpotBeta?: number; // ∂σ/∂S directly (decimal vol per $1) — the empirical / min-variance β (preferred)
  skewSlope?: number; // ∂σ/∂ln(K) (SkewMetrics.skewSlope); mapped to β via `regime`
  regime?: 'sticky-strike' | 'sticky-moneyness'; // how skewSlope → β (default 'sticky-moneyness')
}
interface MinimumVarianceDeltaResult {
  /** Δ_BS + Vega_raw · β — the hedge ratio. */
  minimumVarianceDelta: number;
  /** The Black-Scholes spot delta ∂V/∂S. */
  blackScholesDelta: number;
  /** Display vega (per 1% vol) at the option. */
  vega: number;
  /** The β = ∂σ/∂S actually used (decimal vol per $1). */
  volatilitySpotBeta: number;
  /** minimumVarianceDelta − blackScholesDelta — the smile adjustment. */
  skewAdjustment: number;
}
function minimumVarianceDelta(
  options: MinimumVarianceDeltaOptions,
): Computed<
  MinimumVarianceDeltaResult,
  { measure: 'real-world-hedge'; betaSource: string; regime?: string }
>;
```

## Semantics & honesty contract

- **β source precedence** — `volatilitySpotBeta` (if given) wins; else `skewSlope` + `regime` derives it; if
  neither is given, a typed error explains that a vol–spot sensitivity is required (no silent `β = 0`,
  which would masquerade the BSM delta as "minimum-variance").
- **Regime is disclosed** — the `betaSource` (`'supplied'` / `'skew-sticky-moneyness'` /
  `'skew-sticky-strike'`) and `regime` ride in `assumptions`, and the docstring warns that the
  sticky-moneyness β is a smile model, not the leverage effect.
- **Real-world hedge measure** — labeled distinctly from the risk-neutral greeks; this is a hedging
  quantity, not a risk-neutral price sensitivity.
- Typed guards on every entry (`type` enum, positive `spot`/`strike`/`t`/`vol`, finite `rate`/β/slope);
  pure and deterministic.

## Build checklist

1. **Types** — `MinimumVarianceDeltaOptions`, `MinimumVarianceDeltaResult`.
2. **β resolution** — precedence + regime mapping (`sticky-strike → 0`, `sticky-moneyness →
−skewSlope/spot`); guard "no β source".
3. **`minimumVarianceDelta`** — `blackScholesGreeks` for `Δ_BS` + vega; `Δ_MV = Δ_BS + (vega·100)·β`; envelope.
4. **Exports + API report + READMEs/llms.**
5. **Tests** — sticky-strike returns exactly `Δ_BS` (β = 0); a supplied negative β lowers a call's delta
   (leverage) and the adjustment equals `vega_raw·β`; a put-skew under sticky-moneyness produces the
   `−skewSlope/spot` β; `volatilitySpotBeta` overrides `skewSlope`; a hand-computed single case; envelope/guards
   (no-β-source throws, bad enum/params throw).

## Deferred (explicitly)

- **SABR/Bartlett backbone** — derive β from a fitted SABR (`fitSABRSmile`) so the correlation/backbone
  term is included analytically, not just the raw slope.
- **Vega-weighted portfolio MV delta** — aggregate the smile-adjusted delta across a book (pairs with
  `analyzeBook`).
- **Minimum-variance vega / gamma** — the same co-movement correction for the other greeks.
- **Empirical β estimation** from an IV/return history (a regression helper) — pairs with the data layer.
