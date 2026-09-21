# Spec — Composite (compo) options (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → _"More exotics: compos/quanto exotics …"_ Status: **shipped** as
> `compo` in `packages/options/src/exotics.ts`, covered by `packages/options/test/compo.test.ts`, full
> CI green. The FX-floating sibling of the existing `quanto`.

## Goal

A **composite (compo)** option pays, in domestic currency, `(S_f(T)·X(T) − K_d)⁺` — the foreign asset
`S_f` converted at the **prevailing** FX rate `X` (domestic per foreign) against a **domestic** strike
`K_d`. It is the mirror of `quanto`: a quanto **fixes** the FX rate (and pays off in foreign-asset units
at a set rate), a compo lets it **float**, so the buyer takes FX risk. This adds it with an exact closed
form, the full multi-factor risk, and a two-factor Monte-Carlo corroboration.

## The composite reduces to Black–Scholes

The domestic value of the foreign asset, `A = S_f·X`, is itself a tradable **domestic** asset paying the
foreign dividend yield `q`. Under the domestic risk-neutral measure it drifts at `r_d − q` — so the compo
is exactly a Black–Scholes option on `A`:

```
A₀  = spot · fxSpot                                   (composite spot, domestic ccy)
σ_A = √(σ_S² + σ_X² + 2·ρ·σ_S·σ_X)                    (composite vol)
compo = BSM(A₀, K_d, T, r_d, q, σ_A)
```

**The foreign risk-free rate `r_f` drops out.** Under `Q_d`, `S_f` drifts at `r_f − q − ρσ_Sσ_X` (the
quanto drift) and `X` at `r_d − r_f`, and their sum plus the Itô cross term `ρσ_Sσ_X` is `r_d − q` — the
`r_f` cancels. _Verified: a two-factor Monte-Carlo of `S_f·X` gives the **same** price for `r_f = 2%` and
`r_f = 9%`, matching the closed form._ So `compo` takes no foreign rate.

## Multi-factor risk (the point)

Because the underlying is a product of two risky factors, a compo carries risk vanilla/quanto options do
not. From the composite BSM greeks (chain rule through `A₀ = S_f·X` and `σ_A`):

```
assetDelta      = ∂C/∂S_f  = Δ_A · X                        (foreign-asset delta)
fxDelta         = ∂C/∂X    = Δ_A · S_f                       (FX delta)
assetGamma      = ∂²C/∂S_f² = Γ_A · X²
assetVega       = ∂C/∂σ_S  = 𝒱_A · (σ_S + ρσ_X)/σ_A
fxVega          = ∂C/∂σ_X  = 𝒱_A · (σ_X + ρσ_S)/σ_A
correlationVega = ∂C/∂ρ    = 𝒱_A · (σ_S·σ_X)/σ_A            (the distinctive compo greek)
theta (per day), rho_domestic (per 1%) — the composite BSM theta/rho.
```

`correlationVega` is the standout: a compo is **long correlation** (higher `ρ` ⇒ higher `σ_A` ⇒ more
option value), a risk a vanilla or a quanto simply does not have. _Verified: all eight greeks match a
central finite-difference of the closed form to 1e-3._ Units follow the package: vega/correlation-vega
per point (per `0.01`), theta per day, rho per 1%.

## Monte-Carlo (two-factor corroboration)

`monteCarloPrice` simulates `S_f` and `X` as **two correlated GBMs** under `Q_d` (`w₂ = ρw₁ + √(1−ρ²)·z₂`) and
prices `(S_f(T)·X(T) − K)⁺` discounted at `r_d`. The two-factor path needs the individual drifts, so it
takes a `foreignRate` simulation parameter (default `domesticRate`) — the price is invariant to it (that
invariance is the corroboration). Converging to the closed form validates the `σ_A` combination
independently of the analytic derivation.

## Honesty / envelope contract

- **Exact + independently corroborated** — the closed form is exact BSM-on-composite, and the two-factor
  MC (which builds `σ_A` from the two legs, not from the formula) converges to it.
- **`r_f`-invariance is real and disclosed** — the model takes no foreign rate; the MC's `foreignRate` is
  a stated nuisance parameter the price does not depend on.
- **Value/greeks envelopes (R2)** — `price` → `ExoticResult`; `greeks` → `Computed<CompoGreeks>` with
  `assumptions.units`; `monteCarloPrice` → `ExoticMonteCarloResult` with `mc`.
- **First-touch guards** — non-object input; a bad `type`; non-positive `spot`/`fxSpot`/`strike`/`t`/`vol`;
  a negative `fxVolatility`; `|correlation| > 1`; non-finite `domesticRate`/`dividendYield` — all throw a typed
  `QuantError`; never a `NaN`.

## API

```ts
interface CompoInput {
  /** Foreign-asset spot (foreign currency). */
  spot: number;
  /** FX rate — domestic currency per unit of foreign (X₀). */
  fxSpot: number;
  /** Strike, in DOMESTIC currency. */
  strike: number;
  timeToExpiryYears: number;
  /** Domestic discount / growth rate. */
  domesticRate: number;
  /** Foreign-asset volatility σ_S. */
  volatility: number;
  /** FX volatility σ_X. */
  fxVolatility: number;
  /** Correlation between the asset and the FX rate, in [−1, 1]. */
  correlation: number;
  /** Foreign dividend yield q. Default 0. */
  dividendYield?: number;
}
interface CompoGreeks {
  assetDelta: number;
  fxDelta: number;
  assetGamma: number;
  assetVega: number;
  fxVega: number;
  correlationVega: number;
  theta: number;
  rho: number;
}
interface CompoMonteCarloOptions extends MonteCarloSamplingOptions {
  /** Foreign rate used only to split the two-factor drift; the price is invariant to it. Default = domesticRate. */
  foreignRate?: number;
}
const compo: {
  price(input: CompoInput & { type: OptionType }): ExoticResult;
  greeks(input: CompoInput & { type: OptionType }): Computed<CompoGreeks>;
  monteCarloPrice(
    input: CompoInput & { type: OptionType },
    options: CompoMonteCarloOptions,
  ): ExoticMonteCarloResult;
};
```

## Build checklist

1. **`price`** — `A₀ = spot·fxSpot`, `σ_A`, then
   `blackScholesPrice({ type, spot: A₀, strike: K, t: T, riskFreeRate: domesticRate, dividendYield: q, volatility: σ_A })`;
   envelope.
2. **`greeks`** — the composite `blackScholesGreeks`, chain-ruled to the eight multi-factor sensitivities with the
   package's unit scaling; `Computed<CompoGreeks>` with `assumptions.units`.
3. **`monteCarloPrice`** — two correlated GBMs under `Q_d` (`foreignRate` default `domesticRate`),
   `(S_f·X − K)⁺` discounted at `r_d`; reuse `monteCarloEstimate(2, …)`.
4. **Exports + API report + READMEs/llms** (+ deep-sweep fixtures for the three callables).
5. **Tests** — `price` equals `BSM(A₀, …, σ_A)`; put-call parity on the composite; every greek matches a
   central FD; `correlationVega > 0` (long correlation); the analytic matches the two-factor MC and is
   invariant to `foreignRate`; guards.

## Deferred (explicitly)

- **Compo forwards / digitals** and a **quanto-vs-compo** comparison helper (same asset, the FX-risk
  decision).
- **Higher-order cross-greeks** (∂²C/∂S_f∂X, vanna in each factor) and the FX/asset **gamma matrix**.
- **A term structure of correlation / stochastic correlation** — this milestone takes a single `ρ`.
