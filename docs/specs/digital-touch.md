# Spec — Digital & one-touch options (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → _"More exotics: digitals/one-touch, forward-starts, cliquets,
> compos."_ Status: **shipped** as `digital` and `touch` in `packages/options/src/exotics.ts`, covered
> by `packages/options/test/digital-touch.test.ts`, full CI green. (Forward-starts / cliquets / compos
> remain.)

## Goal

Binary bets are the simplest exotic and a staple of retail and event trading: **digitals** (pay a fixed
amount, or the asset, if you finish in-the-money) and **one-touch / no-touch** (pay if the underlying
_ever_ touches a barrier — the classic "will BTC hit \$100k?" ticket). The package prices barriers,
Asians, and lookbacks but has no binaries; this adds them, each with a **closed-form analytic price and
a Monte-Carlo engine that converges to it**, matching the existing exotics idiom.

## Digitals (European binaries)

Pay off only on the terminal spot `S_T` vs the strike `K`. With `b = r − q`,
`d₁ = (ln(S/K) + (b + σ²/2)T)/(σ√T)`, `d₂ = d₁ − σ√T`:

- **Cash-or-nothing** — pays a fixed `cash` (default 1) if in-the-money:
  `call = cash·e^{−rT}·N(d₂)`, `put = cash·e^{−rT}·N(−d₂)`.
- **Asset-or-nothing** — pays `S_T` if in-the-money:
  `call = S·e^{−qT}·N(d₁)`, `put = S·e^{−qT}·N(−d₁)`.

Two identities the tests pin: a **vanilla call = asset-or-nothing call − K·cash-or-nothing call** (exact,
verified to machine precision), and **cash-or-nothing call + put = `cash`·e^{−rT}** (something always
finishes on one side). Monte-Carlo: discount the indicator (`cash·1{S_T ⋛ K}`) or the asset payoff.

## One-touch / no-touch (American binaries)

Pay off on whether the underlying **touches** a barrier `H` at any time in `[0, T]` (continuous
monitoring). The risk-neutral **first-passage probability** of touching `H` (log-drift `ν = b − σ²/2`,
`L = ln(H/S)`):

```
H < S (down):  P = N((L−νT)/(σ√T)) + e^{2νL/σ²}·N((L+νT)/(σ√T))
H > S (up):    P = N((−L+νT)/(σ√T)) + e^{2νL/σ²}·N((−L−νT)/(σ√T))
```

- **one-touch, pay at expiry** = `cash·e^{−rT}·P`.
- **no-touch** (always paid at expiry) = `cash·e^{−rT}·(1 − P)`.
  ⇒ **one-touch@expiry + no-touch = `cash`·e^{−rT}** (one of them always pays).
- **one-touch, pay at hit** (rebate paid the instant `H` is touched) — Reiner–Rubinstein, with
  `μ = (b − σ²/2)/σ²`, `λ = √(μ² + 2r/σ²)`, `z = ln(H/S)/(σ√T) + λσ√T`, `η = +1` if `H<S` else `−1`:
  `cash·[ (H/S)^{μ+λ}·N(η·z) + (H/S)^{μ−λ}·N(η·(z − 2λσ√T)) ]`.

**Already touched** — if the spot is already at or beyond the barrier (`H≤S` for a down barrier, `H≥S`
for an up barrier), the touch is immediate: one-touch pays `cash·e^{−rT}` (expiry) or `cash` (hit), and
no-touch is worth `0`. Handled upfront, never run through the formulas.

**Monte-Carlo** — the pay-at-expiry engine reuses the existing **Brownian-bridge survival**
(`barrierSurvival`) so discrete monitoring converges to the continuous analytic (`value =
cash·e^{−rT}·E[touch]` or `E[survival]`). The pay-at-hit engine detects the first crossing on a fine
grid and discounts at the hit time (converges from below as the discrete-monitoring bias shrinks).

_(Verified: digitals match a 400k-path MC to 4 dp and the vanilla decomposition exactly; the touch
first-passage analytic sits just above a fine-grid MC by the expected discrete-monitoring bias, and the
pay-at-expiry MC with the Brownian-bridge correction converges to it.)_

## Honesty / envelope contract

- **Analytic ⇄ MC corroboration** — every closed form has a Monte-Carlo engine that converges to it (the
  house rule for exotics); the reported `engine`/`method` name the pricing route.
- **Already-touched is explicit** — an in-the-barrier spot short-circuits to the certain payoff, never a
  formula evaluated outside its domain.
- **`no-touch` is expiry-settled** — a `payAt: 'hit'` passed with `no-touch` is meaningless (there is no
  hit) and rejected with a typed error, not silently ignored.
- **Value envelope (R2)** — `Computed<number>` with `assumptions` (day count, carry, model) and
  `diagnostics`; the MC variant adds `mc` error statistics, exactly like `barrier`/`asian`/`lookback`.
- Typed guards (positive spot/strike/barrier/t/vol; finite rate/yield/cash; valid enums).

## API

```ts
type DigitalKind = 'cash-or-nothing' | 'asset-or-nothing';
interface DigitalInput {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** Fixed payout for cash-or-nothing (ignored by asset-or-nothing); default 1. */
  cash?: number;
}
const digital: {
  price(input: DigitalInput & { type: OptionType; kind: DigitalKind }): ExoticResult;
  monteCarloPrice(
    input: DigitalInput & { type: OptionType; kind: DigitalKind },
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult;
};

type TouchKind = 'one-touch' | 'no-touch';
interface TouchInput {
  spot: number;
  barrier: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  cash?: number; // rebate; default 1
  /** When a one-touch pays: 'expiry' (default) or 'hit'. Ignored/'expiry' for no-touch. */
  payAt?: 'expiry' | 'hit';
}
interface TouchMonteCarloOptions extends MonteCarloSamplingOptions {
  steps?: number;
} // monitoring steps; default 100
const touch: {
  price(kind: TouchKind, input: TouchInput): ExoticResult;
  monteCarloPrice(
    kind: TouchKind,
    input: TouchInput,
    options: TouchMonteCarloOptions,
  ): ExoticMonteCarloResult;
};
```

## Build checklist

1. **Digitals** — `digitalAnalytic` (cash/asset-or-nothing × call/put); `digital.price`/`monteCarloPrice`.
2. **Touch** — `touchProbability` (first passage); `touchAnalytic` (expiry + Reiner–Rubinstein hit);
   already-touched short-circuit; `touch.price`.
3. **Touch MC** — pay-at-expiry via `barrierSurvival`; pay-at-hit via first-crossing + hit-time discount.
4. **Envelope + exports + API report + READMEs/llms** (+ deep-sweep fixtures for the new callables).
5. **Tests** — digitals vs the closed forms and the vanilla/parity identities, MC convergence;
   one-touch@expiry + no-touch = `cash·e^{−rT}`; the pay-at-expiry MC (BB) converges to the analytic;
   pay-at-hit ≥/≤ pay-at-expiry as rates dictate; already-touched short-circuits; `no-touch` + `payAt:
'hit'` throws; guards.

## Deferred (explicitly)

- **Double one-touch / double no-touch** (two barriers) — the range-bet tickets.
- **Discrete-monitoring digitals** (daily/weekly touch windows) with the continuity correction.
- **Digital greeks** (the notorious spike delta/gamma near the strike/barrier) and a smoothed
  call-spread approximation.
- **Forward-starts / cliquets / compos** — the rest of the roadmap's "more exotics" bullet.
