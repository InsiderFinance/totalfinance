# Spec — Forward-start options (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → _"More exotics: … forward-starts, cliquets, compos."_ Status:
> **shipped** as `forwardStart` in `packages/options/src/exotics.ts`, covered by
> `packages/options/test/forward-start.test.ts`, full CI green. (Cliquets / compos remain.)

## Goal

A **forward-start** option's strike is not fixed today — it is set at a future **reset** date `t₁` as a
proportion of the spot then: `K = α·S(t₁)`. `α = 1` makes it at-the-money the moment it starts. These are
the workhorse of **employee options, "reset" structures, and cliquets/ratchets** (a cliquet is a strip of
forward-starts). The package prices barriers, Asians, lookbacks, and binaries; this adds forward-starts,
with a closed-form price and a Monte-Carlo engine that converges to it — the house rule for exotics.

## The closed form (Rubinstein 1991)

At the reset `t₁`, the contract becomes a vanilla with spot `S(t₁)`, strike `α·S(t₁)`, and time to expiry
`τ = T − t₁`. Its value there is **homogeneous of degree 1 in `S(t₁)`** — `c(S(t₁), α·S(t₁), τ) = S(t₁)·φ`
with `φ` a constant (the moneyness `S/K = 1/α` fixes the shape). Discounting the expected reset value
(`E^Q[S(t₁)] = S·e^{b·t₁}`, `b = r − q`) collapses to a clean formula:

```
V = S·e^{−q·t₁}·φ,   τ = T − t₁,   d₁ = (−ln α + (b + σ²/2)·τ) / (σ√τ),   d₂ = d₁ − σ√τ
call: φ = e^{−qτ}·N(d₁) − α·e^{−rτ}·N(d₂)
put:  φ = α·e^{−rτ}·N(−d₂) − e^{−qτ}·N(−d₁)
```

The value scales with **today's** spot but does **not** depend on the vol over `[0, t₁]` (only the
forward drift matters before the strike is set) — a property the tests pin. _(Verified against a 500k
two-step GBM Monte-Carlo: `α=1` call 7.607 vs 7.588, `α=0.9` call 13.52 vs 13.49, `α=1.1` put 12.02 vs
12.03.)_

## Monte-Carlo

Two Gaussian draws per path: `S(t₁) = GBM(S, t₁)`, then `S(T) = GBM(S(t₁), τ)`; strike `K = α·S(t₁)`;
payoff `df·max(S(T) − K, 0)` (call) / `df·max(K − S(T), 0)` (put). It converges to the analytic and, like
the other exotics, reports the `mc` error statistics.

## Honesty / envelope contract

- **Analytic ⇄ MC corroboration** — the closed form has a Monte-Carlo engine that converges to it; the
  `engine`/`method` name the pricing route.
- **Reset must precede expiry** — `0 < resetTime < t` is required; a reset at/after expiry (no forward
  period, or a fully-vanilla option) throws a typed error rather than dividing by `√(T−t₁) ≤ 0`.
- **Value envelope (R2)** — `Computed<number>` with `assumptions` (day count, carry, model) and
  `diagnostics`; the MC variant adds `mc`, exactly like `barrier`/`digital`/`touch`.
- Typed guards (positive spot/t/vol; `α > 0`; finite rate/yield; valid enums).

## API

```ts
interface ForwardStartInput {
  spot: number;
  /** Strike multiplier α: the strike is set to α·S(t₁) at the reset (α=1 ⇒ at-the-money-at-reset). Default 1. */
  strikeMultiplier?: number;
  /** Reset time t₁ (years) at which the strike is fixed; must be in (0, t). */
  resetTime: number;
  /** Expiry T (years). */
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
}
const forwardStart: {
  price(input: ForwardStartInput & { type: OptionType }): ExoticResult;
  monteCarloPrice(
    input: ForwardStartInput & { type: OptionType },
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult;
};
```

## Build checklist

1. **Analytic** — `forwardStartAnalytic` (call/put, α, reset); `forwardStart.price`.
2. **Monte-Carlo** — two-step GBM (`gbmTerminal` twice), strike from the reset spot; `forwardStart.monteCarloPrice`.
3. **Envelope + exports + API report + READMEs/llms** (+ deep-sweep fixtures for the new callables).
4. **Tests** — the analytic matches the Monte-Carlo (call/put, `α ∈ {1, 0.9, 1.1}`, within the MC error);
   the value scales linearly in today's spot (homogeneity) and is invariant to the pre-reset window in the
   right sense; a very early reset approaches the corresponding vanilla; `resetTime ≥ t` and `α ≤ 0` throw;
   guards.

## Deferred (explicitly)

- **Cliquets / ratchets** — a strip of forward-starts with local/global caps and floors (the capped
  version needs Monte-Carlo; the uncapped one is a sum of these caplets).
- **Forward-start greeks** — the sensitivities, including the discontinuity of vega across the reset.
- **Compo / quanto forward-starts** — a forward-start on a foreign underlying.
- **Performance/basket forward-starts** — resets on a basket or a relative-performance payoff.
