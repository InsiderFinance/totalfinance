# Spec — Cliquet / ratchet options (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → _"More exotics: … cliquets, …"_ Status: **shipped** as `cliquet` in
> `packages/options/src/exotics.ts`, covered by `packages/options/test/cliquet.test.ts`, full CI green.
> (Builds on `forwardStart`.)

## Goal

A **cliquet** (ratchet) is a strip of **forward-start** options: over consecutive periods it accumulates
the underlying's **period returns**, each clipped to a local floor/cap, then clips the running total to a
global floor/cap. The local floor at 0 is the "ratchet" that locks in each period's gain — the reason
cliquets sell as capital-protected upside. This adds them to the exotics suite with a closed-form price
for the locally-capped case and a Monte-Carlo engine for the general (globally-constrained) one.

## Structure

Reset/observation times `0 = t₀ < t₁ < … < tₙ = T`. The period return `rᵢ = S(tᵢ)/S(tᵢ₋₁) − 1`. The
payoff at maturity `T`:

```
payoff = clip( Σᵢ clip(rᵢ, localFloor, localCap), globalFloor, globalCap ) · notional
```

`clip(x, lo, hi) = min(hi, max(lo, x))`. Defaults: `localFloor = 0` (lock in non-negative period gains),
`localCap = +∞` (uncapped), `globalFloor = −∞`, `globalCap = +∞`, `notional = 1`. Present-valued at
`e^{−rT}` (paid at maturity).

## The closed form (no global constraint)

Without a global cap/floor the total's clip is the identity, so — since consecutive period returns are
independent under GBM — the value is the sum of the per-period expected clipped returns, discounted once:

```
V = e^{−rT}·notional·Σᵢ E[ clip(rᵢ, localFloor, localCap) ]
E[clip(rᵢ, lf, lc)] = lf + capletᵢ(1+lf) − capletᵢ(1+lc)
```

where `capletᵢ(K′) = E[max(Rᵢ − K′, 0)]` is a **Black-76** call on the period return `Rᵢ = S(tᵢ)/S(tᵢ₋₁)`
(forward `E[Rᵢ] = e^{b·τᵢ}`, `b = r − q`, `τᵢ = tᵢ − tᵢ₋₁`):

```
capletᵢ(K′) = e^{b·τᵢ}·N(d₁) − K′·N(d₂),   d₁ = (b·τᵢ + σ²τᵢ/2 − ln K′)/(σ√τᵢ),   d₂ = d₁ − σ√τᵢ
```

An uncapped strike (`localCap = +∞`) contributes `0`. _(Verified against a 400k-path Monte-Carlo:
a 4-quarterly-reset cliquet with `localFloor=0, localCap=5%` prices 8.0195 analytic vs 8.0010 MC.)_

**A global cap or floor makes the sum's clip path-dependent — the closed form no longer applies.**
`cliquet.price` therefore **throws** when a `globalCap`/`globalFloor` is supplied, directing the caller to
`cliquet.monteCarloPrice`, which handles every combination.

## Monte-Carlo (general)

One Gaussian draw per period: walk the path across the reset times, clip each period return to the local
band, sum, clip the total to the global band, scale by `notional`, discount by `e^{−rT}`. Converges to
the analytic in the no-global case; the authoritative engine when a global cap/floor is present.
_(Verified: a global cap of 12% lowers the value to 7.37; a global floor of 0 is non-binding when
`localFloor ≥ 0`.)_

## Honesty / envelope contract

- **Analytic ⇄ MC corroboration** — the closed form has a Monte-Carlo engine that converges to it; the
  `engine`/`method` name the pricing route.
- **The closed form declares its limits** — `cliquet.price` refuses (typed error) a global cap/floor
  rather than silently returning the wrong (no-global) number; `monteCarloPrice` is the general answer.
- **Value envelope (R2)** — `Computed<number>` with `assumptions` + `diagnostics`; the MC variant adds
  `mc`, exactly like the other exotics.
- Typed guards (positive spot/vol; ≥ 1 strictly-increasing positive reset; `localCap > localFloor ≥ −1`;
  `globalCap > globalFloor`; finite rate/yield/notional).

## API

```ts
interface CliquetInput {
  spot: number;
  /** Reset/observation times t₁…tₙ (years, strictly increasing, > 0); t₀ = 0 (today), tₙ = maturity. */
  resetTimes: number[];
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** Per-period return floor; default 0 (lock in non-negative gains). Must be ≥ −1. */
  localFloor?: number;
  /** Per-period return cap; default +∞ (uncapped). Must be > localFloor. */
  localCap?: number;
  /** Global (summed) floor; default −∞. Requires monteCarloPrice. */
  globalFloor?: number;
  /** Global (summed) cap; default +∞. Requires monteCarloPrice. */
  globalCap?: number;
  /** Notional multiplier; default 1. */
  notional?: number;
}
const cliquet: {
  price(input: CliquetInput): ExoticResult; // analytic; throws on a global cap/floor
  monteCarloPrice(input: CliquetInput, options: MonteCarloSamplingOptions): ExoticMonteCarloResult; // general
};
```

## Build checklist

1. **Analytic** — the Black-76 period `caplet`, `E[clip]` per period, the discounted sum; throw on a
   global cap/floor.
2. **Monte-Carlo** — path across resets, local + global clipping, notional, `e^{−rT}`.
3. **Envelope + exports + API report + READMEs/llms** (+ deep-sweep fixtures for the new callables).
4. **Tests** — the analytic matches the Monte-Carlo (no global) within the MC error, for both a
   locally-capped and an uncapped ratchet; a global cap lowers the value and a global floor is non-binding
   when `localFloor ≥ 0`; a higher `localCap` raises the value (monotone); `price` throws with a global
   constraint; guards.

## Deferred (explicitly)

- **Reverse cliquet** (accumulate the negative part), **napoleon**, and **replacement/lookback cliquets**.
- **Local floor/cap on the RETURN vs on the log-return** conventions as an option.
- **Cliquet greeks** and the vega term structure across resets.
- **Pay-as-you-go** settlement (each period paid at its own `tᵢ`) as an alternative to pay-at-maturity.
