# Spec — Napoleon & reverse-cliquet options (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → "More exotics: reverse cliquet / napoleon". The last exotic in the
> cliquet family (`forwardStart` → `cliquet` → these), completing the exotic-options catalogue.
> Status: **shipped** as `napoleon` + `reverseCliquet` in `packages/options/src/exotics.ts`, covered by
> `packages/options/test/napoleon.test.ts`, full CI green.

## Goal

The third generation of cliquet structures. Both pay a **fixed coupon** each degraded by the underlying's
periodic (e.g. monthly) returns `rᵢ = S(tᵢ)/S(tᵢ₋₁) − 1`, but in opposite ways — and both leave the investor
**short volatility**, which is the whole point of the product:

- **Napoleon** — pays the coupon plus the **single worst** period return: `max(floor, C + minᵢ rᵢ)`. One bad
  month can wipe the coupon; the investor is short the vol of the _minimum_ return.
- **Reverse cliquet** — pays the coupon eroded by the **sum of the negative** period returns:
  `max(floor, C + Σᵢ min(rᵢ, 0))`. Up-months don't help, down-months subtract; the investor is short
  _downside_ vol across every period.

Both are path-dependent (a minimum / a floored sum), so both are priced by **Monte-Carlo** built on the
same per-period GBM the `cliquet` engine already uses. Reverse cliquet additionally has a **closed-form
floorless value** (the price with no `max(floor, ·)`), which is exact for the unfloored note and a fast
lower bound for the floored one.

## The construction

For reset times `t₁ < … < tₙ` (with `t₀ = 0`), period `τᵢ = tᵢ − tᵢ₋₁`, drift `b = rate − q`, the period
return `rᵢ = S(tᵢ)/S(tᵢ₋₁) − 1` is simulated by the same `gbmTerminal` step the cliquet uses (each period
is an independent GBM increment). At maturity `T = tₙ`:

```
napoleon:        payoff = notional · max(globalFloor, C + minᵢ rᵢ)
reverse cliquet: payoff = notional · max(globalFloor, C + Σᵢ min(rᵢ, 0))
price = e^{−rate·T} · E[payoff]
```

**Floorless reverse-cliquet closed form.** With `globalFloor = −∞`, the outer max drops and expectation is
linear, so the price is a discounted strip of per-period **expected negative returns**:

```
E[min(rᵢ, 0)] = (e^{b·τᵢ} − 1) − returnCaplet(1, τᵢ, b, σ)     (= e^{b·τᵢ}·N(−d₁) − N(−d₂))
floorlessValue = e^{−rate·T} · notional · (C + Σᵢ E[min(rᵢ, 0)])
```

reusing the existing `returnCaplet` (`E[max(rᵢ, 0)]`) since `E[min(rᵢ,0)] = E[rᵢ] − E[max(rᵢ,0)]`.
_Verified: this matches the MC price to ~1e-5 for a large coupon (the floor never binds), the MC is short
volatility (a 15 % → 40 % vol bump lowers the napoleon value 0.038 → 0.014), and the zero-vol limits are
exact (reverse cliquet with positive drift → `df·C`, napoleon → `df·max(floor, C + worst deterministic return)`)._

## Honesty / envelope contract

- **MC is the price; the floorless form is a disclosed bound** — `reverseCliquet.floorlessValue` returns the
  price **ignoring the global floor** (exact when `globalFloor = −∞`, a lower bound otherwise); it never
  pretends to be the floored price. The MC results carry `result.monteCarlo` error statistics.
- **Short-vol disclosed** — both engines note (`method`) that the investor is short the worst-return /
  downside vol, so a higher `vol` _lowers_ the value — the opposite of a vanilla.
- **First-touch** — namespaced facades (`napoleon.monteCarloPrice`, `reverseCliquet.monteCarloPrice`/`.floorlessValue`) ⇒
  first-touch **deep-sweep fixtures**. Guards: non-object input; non-positive `spot`/`vol`; a non-array /
  empty / non-increasing `resetTimes`; non-finite `rate`/`coupon`/`globalFloor`/`notional`; a missing MC
  `opts` — all typed `QuantError`.
- **Envelope** — `monteCarloPrice` → `ExoticMonteCarloResult` (`Computed<number>` + `mc`); `floorlessValue` → `ExoticResult`.

## API

```ts
interface NapoleonInput {
  spot: number;
  /** Reset times t₁…tₙ (years, strictly increasing, > 0); t₀ = 0, tₙ = maturity. */
  resetTimes: number[];
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** The fixed coupon degraded by the worst period return. */
  coupon: number;
  /** Floor on the payoff. Default 0 (the note cannot pay less than 0); pass `-Infinity` for the unfloored note. */
  globalFloor?: number;
  /** Notional multiplier. Default 1. */
  notional?: number;
}
type ReverseCliquetInput = NapoleonInput; // same shape; the coupon is degraded by Σ min(rᵢ, 0)

const napoleon: {
  monteCarloPrice(input: NapoleonInput, options: MonteCarloSamplingOptions): ExoticMonteCarloResult;
};
const reverseCliquet: {
  monteCarloPrice(
    input: ReverseCliquetInput,
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult;
  /** Closed-form value ignoring the global floor — exact if globalFloor = −∞, else a lower bound. */
  floorlessValue(input: ReverseCliquetInput): ExoticResult;
};
```

## Build checklist

1. **Shared validation** — reuse the cliquet reset-time / period logic (strictly-increasing, > 0), plus
   `coupon`/`globalFloor`/`notional` finiteness.
2. **`napoleon.monteCarloPrice`** — per-path min of the period returns, `max(floor, C + min)`, discounted; `monteCarloEstimate`.
3. **`reverseCliquet.monteCarloPrice`** — per-path `Σ min(rᵢ, 0)`, `max(floor, C + Σ)`, discounted.
4. **`reverseCliquet.floorlessValue`** — the closed-form strip via `returnCaplet`.
5. **Export + deep-sweep fixtures + API report + READMEs/llms.**
6. **Tests** — MC ⇄ floorless (large coupon); zero-vol limits; short-vol monotonicity; the reverse-cliquet
   floor binding (a negative coupon floored to 0); guards.

## Deferred (explicitly)

- **Local per-period floors/caps** on the returns (a capped napoleon / capped reverse cliquet) and a global
  cap — the raw-return canonical forms ship here.
- **A napoleon analytic** — the expected minimum of `n` dependent lognormal returns has no simple closed
  form; MC only (reverse cliquet gets the floorless analytic because the sum is linear).
- **Greeks** (short-vol vega, the cross-period gammas) via pathwise/bumped MC.
