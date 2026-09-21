# Spec — Inverse (coin-settled, Deribit-style) options (`@totalfinance/options`)

> Roadmap Tier 2 → Crypto → "inverse-option (Deribit-style) conventions". The first crypto-native
> analytics in the library.
> Status: **shipped** as `inverseOption` in `packages/options/src/exotics.ts`, covered by
> `packages/options/test/inverse-option.test.ts`, full CI green. Composes `blackScholesPrice`/`blackScholesGreeks`.

## Goal

Deribit — **the** crypto options venue — lists **inverse** (coin-margined) options on BTC and ETH: the
premium is quoted in the coin, the margin is posted in the coin, and settlement is paid in the coin. A
BTC call still has the USD payoff `max(S_T − K, 0)`, but it is **paid in BTC at the expiry price**, so its
settlement is

```
call:  max(S_T − K, 0) / S_T   BTC          put:  max(K − S_T, 0) / S_T   BTC
```

where `S = BTC/USD` (USD per coin). Pricing and — more importantly — **hedging** these correctly is
something most option libraries get wrong, because the coin-denominated greeks are _not_ the vanilla
greeks. This is the crypto sibling of the existing `quanto`/`compo` FX-settlement engines: a
change-of-numeraire problem, not a new PDE.

## The construction

**Value.** Receiving `P_coin(S_T)` BTC at expiry is worth, in USD at `T`, `P_coin·S_T` — and for both the
call and put that product is exactly the vanilla USD payoff (`(S_T−K)^+` / `(K−S_T)^+`). So the **USD
value of an inverse option equals the vanilla BSM value**, and the **coin premium Deribit quotes is just
that, divided by spot**:

```
V_coin(S, K, T, r, q, σ) = V_usd / S,     V_usd = BSM(type; S, K, T, r, q, σ)
```

`r` is the **USD (quote) rate**; `q` is the **coin yield** (lending/staking; usually 0), entering the
forward `F = S·e^{(r−q)T}` exactly as a dividend yield.

This is confirmed by a **coin-numeraire Monte-Carlo**: valuing the coin payoff under the coin money-market
numeraire, `S` picks up the self-quanto drift `r − q + σ²`, and `E^{Q_coin}[e^{−qT}·(S_T−K)^+/S_T]` matches
`V_usd/S` to the MC error. (The USD-measure form `E^Q[e^{−rT}(S_T−K)^+]/S` matches too — same number, two
measures.)

**Coin greeks.** Because the `1/S` numeraire factor itself depends on spot, differentiating
`V_coin = V_usd/S` gives the inverse-specific risk. Only **delta** and **gamma** pick up correction terms;
vega/theta/rho just scale by `1/S`:

```
Δ_coin = Δ_usd/S − V_usd/S²                                  (= Δ_usd/S − V_coin/S)
Γ_coin = Γ_usd/S − 2·Δ_usd/S² + 2·V_usd/S³
vega_coin = vega_usd/S     θ_coin = θ_usd/S     ρ_coin = ρ_usd/S
```

The `−V_coin/S` term in the delta is the punchline traders care about: paying the premium **in BTC** is an
embedded short-coin position, so an inverse option's hedge ratio is _not_ the Black–Scholes delta. Every
coin greek is validated to ~1e-13 against a finite-difference bump of `blackScholesPrice/S` in the package's greek
units (delta/gamma raw per $, vega/1%, theta/day, rho/1%).

**Both risk views, one call.** `greeks` returns the `coin` greeks (the inverse-specific risk) **and** the
`usd` greeks (which equal the vanilla BSM greeks, since the USD payoff is a vanilla) — so a trader hedging
in coin _or_ in USD terms is served from one call.

**Inverse put–call parity** (a pinned identity, verified to 1e-16):

```
C_coin − P_coin = e^{−qT} − (K/S)·e^{−rT}
```

## Honesty / envelope contract

- **Exact composition, no new model** — `V_coin = V_usd/S` and the greeks are exact chain-rule derivatives;
  no approximation, disclosed as `model: 'inverse'` over the BSM engine.
- **Convention disclosed** — `assumptions` echo that the value is the **coin (base-currency) premium**,
  `r` is the USD/quote rate, `q` is the coin yield, and the greeks carry `units: DEFAULT_GREEK_UNITS`.
- **First-touch guards** — non-object input; non-positive `spot`/`strike`/`t`/`vol`; non-finite
  `rate`/`coinYield` — all throw a typed `QuantError`. `type` is enum-checked.
- **Envelope** — `price` → `Computed<number>` (the coin premium; `value·spot` recovers the USD premium);
  `greeks` → `Computed<InverseGreeks>`; `monteCarloPrice` → `ExoticMonteCarloResult` (adds `mc`).

## API

```ts
interface InverseOptionInput {
  /** Underlying spot, quote per coin (e.g. BTC/USD). */
  spot: number;
  /** Strike, in the QUOTE currency (USD). */
  strike: number;
  timeToExpiryYears: number;
  /** USD (quote-currency) risk-free rate. */
  riskFreeRate: number;
  /** Coin (base-currency) yield — lending/staking. Default 0. Enters the forward as the dividend yield. */
  coinYield?: number;
  /** Volatility. */
  volatility: number;
}
interface InverseGreeks {
  /** Coin-denominated greeks: derivatives of the coin premium (delta/gamma raw per $, vega/1%, theta/day, rho/1%). */
  coin: Greeks;
  /** USD-linear greeks (= the vanilla BSM greeks; the inverse option's USD payoff equals a vanilla's). */
  usd: Greeks;
}
interface InverseOptionMonteCarloOptions extends MonteCarloSamplingOptions {}

const inverseOption: {
  price(input: InverseOptionInput & { type }): ExoticResult; // vanilla coin premium
  greeks(input: InverseOptionInput & { type }): Computed<InverseGreeks>; // coin + usd greeks
  monteCarloPrice(
    input: InverseOptionInput & { type },
    options: InverseOptionMonteCarloOptions,
  ): ExoticMonteCarloResult;
  // coin-settled exotics — the same coinPrice = usdPrice/spot identity applied to the vanilla binary/barrier:
  digital(input: InverseOptionInput & { type; kind: DigitalKind; cash? }): ExoticResult; // coin premium
  barrier(input: InverseOptionInput & { type; barrierType: BarrierType; barrier }): ExoticResult; // coin premium
};
```

### Coin-settled binaries & barriers — the universal identity

Every coin-settled exotic obeys the **same** identity as the vanilla: a coin payoff `H(S_T)/S_T` is worth
`H(S_T)` USD at expiry (1 coin = `S_T` USD then), so its USD price is the vanilla's and its coin premium is
exactly `vanillaUsd/spot`. `inverseOption.digital` and `inverseOption.barrier` therefore compose the
already-tested `digital.price`/`barrier.price` and divide by spot — a coin-settled `cash-or-nothing` settles
its `cash` USD-equivalent in the coin, an `asset-or-nothing` settles 1 coin if ITM, and a coin-settled
barrier is the vanilla barrier's coin premium. Verified: a coin-numeraire Monte-Carlo of the real coin
payoff `H(S_T)/S_T` converges to `vanillaUsd/spot` for both (digital ~1.8e-3, barrier ~3e-3 at 1M paths);
the coin-settled asset-or-nothing call equals the BSM call delta `e^{−qT}N(d1)` (independent anchor); and
knock-in + knock-out reconstruct the vanilla coin premium (in–out parity).

## Build checklist

1. **`price`** — validate; `V_usd = blackScholesPrice`; return `V_usd/spot` as the coin premium envelope.
2. **`greeks`** — `blackScholesGreeks` (usd) + `blackScholesPrice` (V_usd) → the coin greeks via the correction formulas;
   return `{ coin, usd }` with `units`.
3. **`monteCarloPrice`** — one-factor coin-measure MC: `S_T` via `gbmTerminal(S, r+σ², q, σ, T, z)` (the self-quanto
   drift), payoff `e^{−qT}·(±(S_T−K))^+/S_T`; converges to the coin premium.
4. **Export + fixture + API report + READMEs/llms.** (Namespaced facade ⇒ first-touch **deep-sweep
   fixture** for `.price`/`.greeks`/`.monteCarloPrice`.)
5. **Tests** — coin premium `= blackScholesPrice/spot` (call & put); coin greeks vs finite-difference of
   `blackScholesPrice/S`; the delta correction `= −V_coin/S`; MC converges to the coin premium; inverse put–call
   parity; guards.

## Deferred (explicitly)

- **Inverse _futures_/perpetuals and the linear-vs-inverse hedge** — the inverse-future delta that an
  inverse option is actually hedged against (pairs with the crypto perp funding/basis/carry roadmap item).
- **Inverse _touch_** settlement (coin-settled one-touch/no-touch — the `touch` sibling of the now-shipped
  coin-settled `digital`/`barrier`, deferred pending the same numeraire treatment for the rebate leg).
- **Quanto-style USD-collateralized crypto options** (linear settlement) and the coin-vs-USD margin/PnL
  attribution an inverse book carries from its premium leg.
