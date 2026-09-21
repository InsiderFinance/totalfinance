# Spec — Digital (binary) greeks (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → _"More exotics: … digital greeks …"_ Status: **shipped** as
> `digital.greeks` in `packages/options/src/exotics.ts`, covered by
> `packages/options/test/digital-greeks.test.ts`, full CI green. (Extends the `digital` binaries.)

## Goal

The `digital` object prices European binaries (cash-or-nothing / asset-or-nothing) but exposes no risk.
This adds the **closed-form greeks** — delta, gamma, vega, theta, rho — for both kinds and both option
types. Digital greeks are the ones traders actually fear: a cash-or-nothing's delta **spikes** near the
strike and its **gamma flips sign** across it (the "pin risk" that makes binaries hard to hedge into
expiry). Having them analytic (exact, no bump noise) is the point.

## Closed forms

With `b = r − q`, `vol = σ√T`, `d₁ = (ln(S/K) + (b + σ²/2)T)/vol`, `d₂ = d₁ − vol`, standard normal
pdf `n(·)` / cdf `N(·)`, `φ = +1` (call) / `−1` (put), `df = e^{−rT}`, `dq = e^{−qT}`:

**Cash-or-nothing** (`V = cash·df·N(φ d₂)`):

```
delta = φ·cash·df·n(d₂) / (S·vol)
gamma = −φ·cash·df·n(d₂)·d₁ / (S²·σ²T)
∂V/∂σ = −φ·cash·df·n(d₂)·d₁ / σ
∂V/∂r =  cash·df·( −T·N(φd₂) + φ·n(d₂)·√T/σ )
−∂V/∂T = cash·df·( r·N(φd₂) − φ·n(d₂)·∂d₂/∂T )
```

**Asset-or-nothing** (`V = S·dq·N(φ d₁)`):

```
delta = dq·N(φd₁) + φ·dq·n(d₁) / vol
gamma = −φ·dq·n(d₁)·d₂ / (S·σ²T)
∂V/∂σ = −φ·S·dq·n(d₁)·d₂ / σ
∂V/∂r =  φ·S·dq·n(d₁)·√T / σ
−∂V/∂T = S·dq·( q·N(φd₁) − φ·n(d₁)·∂d₁/∂T )
```

where `∂d₂/∂T = ((b−σ²/2)/σ − ln(S/K)/(σT)) / (2√T)` and `∂d₁/∂T` is the same with `(b+σ²/2)/σ`.

Two features the tests pin: the **asset-or-nothing gamma and vega are exactly 0 at `d₂ = 0`** (just ITM
of the strike), and the greeks satisfy the **vanilla decomposition** — since a vanilla call is
`asset-or-nothing call − K·(cash-or-nothing call with cash = 1)`, each greek of the vanilla equals the
asset greek minus `K ×` the cash greek. _Verified: every greek matches a central finite-difference bump
of the exact `digital.price` across ITM/ATM/OTM, both kinds, both types (near-zero cases excluded)._

## Units

Matches the package convention (echoed in `assumptions.units`, the `DEFAULT_GREEK_UNITS`):

- `delta`, `gamma` — raw (per \$1 spot).
- `vega` — per **1 vol point** (`∂V/∂σ ÷ 100`).
- `theta` — per **calendar day** (`−∂V/∂T ÷ 365`).
- `rho` — per **1%** rate (`∂V/∂r ÷ 100`).

## Honesty / envelope contract

- **Analytic, FD-corroborated** — every greek has a closed form pinned to a finite-difference bump of the
  priced value; no silent reliance on numeric differentiation.
- **Exact zeros are exact** — the asset-or-nothing gamma/vega return `0` at `d₂ = 0` rather than a bump's
  numerical dust.
- **Envelope (R2)** — `Computed<Greeks>` (`value` = the greeks) with `assumptions` (incl. `units`) +
  `diagnostics`, parallel to `digital.price`'s `ExoticResult = Computed<number>`.
- **First-touch guards** — same `validateDigital` as `digital.price`: non-object input, non-positive
  `spot`/`strike`/`t`/`vol`, non-finite `rate`/`dividendYield`/`cash`, a bad `type`/`kind` — all throw a
  typed `QuantError`; never a `NaN`.

## API

```ts
digital.greeks(input: DigitalInput & { type: OptionType; kind: DigitalKind }): Computed<Greeks>;
// Greeks = { delta, gamma, theta, vega, rho }; result.value carries them, result.assumptions.units the units.
```

## Build checklist

1. **Greeks** — the closed forms above for both kinds × both types, with the package scaling
   (`vega/100`, `theta/365`, `rho/100`) and `assumptions.units = DEFAULT_GREEK_UNITS`.
2. **Envelope + export + API report + READMEs/llms** (+ a deep-sweep fixture `options.digital.greeks`,
   mirroring `options.digital.price`).
3. **Tests** — every greek matches a central FD bump of `digital.price` (both kinds/types, ITM/ATM/OTM,
   near-zero cases handled); the vanilla-decomposition identity (`asset − K·cash` greek = vanilla greek);
   the exact-zero asset gamma/vega at `d₂ = 0`; `assumptions.units` echoed; guards.

## Deferred (explicitly)

- **Higher-order greeks** (vanna/charm/vomma/speed) for the binaries.
- **Greeks for the barrier binaries** (`touch`, `doubleTouch`) — a separate derivation from the
  first-passage values, not the terminal-payoff digitals here.
- **A Monte-Carlo greek estimator** (pathwise / likelihood-ratio) as an MC cross-check.
