# Spec — Risk reversal & butterfly (`@totalfinance/volatility`)

> Roadmap Tier 2 → Options & vol → the standard smile-quoting decomposition (depth that makes the vol
> package best-of-its-kind). Status: **shipped** as `riskReversalButterfly` + `smileFromQuotes` in
> `packages/volatility/src/risk-reversal.ts`, covered by `packages/volatility/test/risk-reversal.test.ts`, full CI green.

## Goal

FX and crypto vol desks do not quote a smile as strikes and vols — they quote three numbers per expiry:
the **ATM** vol, the **risk reversal** (the skew: the vol difference between the out-of-the-money call
and put wings), and the **butterfly** (the smile curvature: how much the wings sit above ATM). This adds
that decomposition and its exact inverse, so a smile round-trips to `(ATM, RR, BF)` and back:

- `riskReversalButterfly` — from a smile function, find the δ-delta wing strikes and report `ATM`,
  `RR = callVolatility − putVolatility`, `BF = (callVolatility + putVolatility)/2 − ATM`.
- `smileFromQuotes` — from `(ATM, RR, BF)`, recover the three `(strike, vol)` anchor points.

## The forward decomposition

Working in **forward delta** (`Δ_call = N(d₁)`, `d₁ = (ln(F/K) + ½σ²T)/(σ√T)`), which needs no spot or
rate. For a target `δ` (default 0.25):

- **ATM** — `K_atm = F`, `σ_atm = smile(F)`.
- **δ-delta call** — the strike where `N(d₁) = δ` (an OTM call, above `F`), solved for `K` with
  `σ = smile(K)` at each step (a one-dimensional root-find, since `σ` depends on `K`).
- **δ-delta put** — the strike where the put's `|Δ| = 1 − N(d₁) = δ` (an OTM put, below `F`).
- `RR = smile(K_call) − smile(K_put)` — the skew; **negative** when puts are bid (the equity/crypto
  down-skew).
- `BF = (smile(K_call) + smile(K_put))/2 − σ_atm` — the smile curvature; **positive** for a convex smile.

_Verified: on a realistic smile the recovered wing strikes carry forward delta exactly `δ`; a negative-
skew smile yields `RR < 0` and a convex one `BF > 0`._

## The inverse (closed form)

Given the quotes, the wing vols are the decomposition inverted:

```
σ_call = ATM + BF + RR/2
σ_put  = ATM + BF − RR/2
```

and each wing strike is **closed form** — no root-find needed, because the vol is now known:
`N(d₁) = δ` ⇒ `d₁ = Φ⁻¹(δ)` (call) or `Φ⁻¹(1−δ)` (put), and

```
K = F · exp(½σ²T − d₁·σ√T)
```

_Verified: building a smile's anchors from `(ATM, RR, BF)` reproduces the decomposition's strikes and vols
to machine precision (the two functions round-trip); the reconstructed call strike has forward delta `δ`._

## Honesty / envelope contract

- **Round-trip exact** — `smileFromQuotes` is the analytic inverse of `riskReversalButterfly`'s anchors;
  the tests pin the round-trip.
- **Unreachable delta is a typed error, not a NaN** — if the smile is so extreme that no strike above `F`
  reaches call-delta `δ` (the wing vol blows up faster than the delta decays), the root-find is detected as
  non-converged and a typed `QuantError` explains it (lower `δ`, or the smile is mis-specified).
- **Convention disclosed** — the delta is **forward, non-premium-adjusted**; echoed in `assumptions`.
- **First-touch guards** — non-object input; a non-function `smile`; non-positive `forward`/`t`; a `delta`
  outside `(0, 0.5)`; non-finite quotes — all throw a typed `QuantError`.
- **Envelope (R2)** — each function returns a domain object with `assumptions` + `diagnostics`.

## API

```ts
interface RiskReversalButterflyInput {
  /** Forward price of the underlying. */
  forward: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** The smile: strike → implied vol (from any fit — SVI, SSVI, volatilitySurface, …). */
  smile: (strike: number) => number;
  /** Delta level for the wings (0.25 = 25-delta). Default 0.25. Must be in (0, 0.5). */
  delta?: number;
}
interface RiskReversalButterfly {
  atmVolatility: number;
  callStrike: number;
  callVolatility: number;
  putStrike: number;
  putVolatility: number;
  /** callVolatility − putVolatility (the skew; < 0 ⇒ puts bid). */
  riskReversal: number;
  /** (callVolatility + putVolatility)/2 − atmVolatility (the curvature; > 0 ⇒ smile). */
  butterfly: number;
  delta: number;
  assumptions: { conventionsVersion: string; deltaConvention: 'forward'; delta: number };
  diagnostics: Diagnostics;
}
function riskReversalButterfly(input: RiskReversalButterflyInput): RiskReversalButterfly;

interface SmileFromQuotesInput {
  forward: number;
  timeToExpiryYears: number;
  atmVolatility: number;
  /** Risk reversal (callVolatility − putVolatility). */
  riskReversal: number;
  /** Butterfly ((callVolatility + putVolatility)/2 − atmVolatility). */
  butterfly: number;
  /** Delta level. Default 0.25. */
  delta?: number;
}
interface SmileAnchors {
  putStrike: number;
  putVolatility: number;
  atmStrike: number;
  atmVolatility: number; // atmStrike = forward
  callStrike: number;
  callVolatility: number;
  delta: number;
  assumptions: { conventionsVersion: string; deltaConvention: 'forward'; delta: number };
  diagnostics: Diagnostics;
}
function smileFromQuotes(input: SmileFromQuotesInput): SmileAnchors;
```

## Build checklist

1. **`riskReversalButterfly`** — validate; ATM at `F`; root-find the call strike (`N(d₁) = δ`, bracket
   `[F, F·exp(nσ√T)]`) and the put strike (`1 − N(d₁) = δ`, bracket `[F·exp(−nσ√T), F]`) with `brent`,
   erroring on non-convergence; assemble `RR`/`BF`; envelope.
2. **`smileFromQuotes`** — `σ_call/σ_put` from the quotes; each strike `F·exp(½σ²T − Φ⁻¹(·)σ√T)`; envelope.
3. **Exports + API report + READMEs/llms.** (Both single-arg ⇒ first-touch **garbage sweep**; no
   deep-sweep fixture.)
4. **Tests** — the wing strikes carry forward delta `δ`; `RR`/`BF` signs on skewed/convex smiles; a flat
   smile gives `RR = 0`, `BF = 0`; the two functions round-trip to machine precision; an unreachable δ
   errors; guards.

## Deferred (explicitly)

- **Spot / premium-adjusted delta** and the **ATM delta-neutral-straddle** convention (this milestone is
  forward-delta, ATM-forward — the cleanest, spot/rate-free choice).
- **Full FX conventions** — the 10-delta wings, the strangle vs butterfly (market vs smile) distinction,
  and the vega-weighted butterfly.
- **A whole-surface RR/BF term structure** (this milestone is one expiry per call).
