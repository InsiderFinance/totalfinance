# Spec — Inverse (coin-margined, Deribit-style) futures & the coin-delta hedge (`@totalfinance/crypto`)

> Roadmap Tier 2 → Crypto → "inverse-future (Deribit-style) conventions". The companion to the inverse
> _option_ ([`inverse-option.md`](./inverse-option.md)) and the perp carry ([`crypto-carry.md`](./crypto-carry.md)).
> Status: **shipped** as `inverseFuture` + `inverseHedge` in `packages/crypto/src/inverse.ts`, covered by
> `packages/crypto/test/inverse.test.ts`, full CI green.

## Goal

Deribit and BitMEX margin their futures and perpetuals **in the coin** (inverse contracts): the contract
is denominated in USD notional, but PnL, margin, and settlement are all in BTC/ETH. This makes the
coin-denominated PnL a **non-linear** function of price — and its coin delta is exactly the instrument a
trader uses to **hedge the inverse option's coin delta** (which the option package surfaces but nothing yet
hedges). This closes that loop: the coin economics of an inverse future/perp, and a one-call hedge that
sizes it against any coin delta.

`@totalfinance/crypto` depends only on `@totalfinance/core`; the option-hedge tie-in is demonstrated in the tests
(which may import `@totalfinance/options`), not as a package dependency.

## The construction

For a position of `Q` USD notional (`= contracts × contract multiplier`, e.g. `$10`/contract on Deribit),
entered at `F₀` and marked at `F` (USD per coin), with `s = +1` long / `−1` short — the BitMEX/Deribit
inverse PnL is paid in the coin:

```
coinPnl      = s · Q · (1/F₀ − 1/F)              (a long profits in coin as F rises)
usdPnl       = coinPnl · F
coinDelta    = ∂coinPnl/∂F = s · Q / F²          (NOT constant — the inverse convexity)
coinGamma    = ∂²coinPnl/∂F² = s · (−2Q / F³)    (a LONG inverse future is SHORT gamma in coin)
coinExposure = s · Q / F                         (the coin-equivalent size — how many coins you are long)
```

The `1/F` in the coin PnL is what makes it non-linear: in USD terms the position's delta is the constant
`Q/F₀`, but in **coin** terms it is `Q/F²` and its second derivative is negative — a long inverse future is
**short convexity** in coin. Every field is validated against a finite-difference of `coinPnl(F)` to
~1e-15. (Funding accrual on a perp is a separate cash flow — see `perpetualFunding`; this is the price-driven
coin PnL and its greeks.)

### The hedge

To neutralize a coin delta `D` (e.g. `inverseOption.greeks({ type, … }).value.coin.delta`) with an inverse
future/perp marked at `F` (for a perp, `F ≈ spot`, disclosed):

```
notionalUsd = |D| · F²                 side = D > 0 ? 'short' : 'long'
hedgeCoinDelta = −D                     (equal and opposite by construction ⇒ combined coin delta = 0)
```

because the future's coin delta is `s · notionalUsd / F²`, so `s · (|D|·F²) / F² = s·|D| = −D` when
`s = −sign(D)`. When the hedged position's own `coinGamma` is supplied, the **residual coin gamma** after
the delta hedge (`positionGamma + hedgeFutureGamma`) is reported — the convexity the delta hedge leaves
behind (shorting the future to hedge a long option's `+δ` _adds_ `+γ`, so the trader is left long
convexity). _Verified: an inverse call's coin delta is neutralized to exactly 0 by the sized hedge._

## Honesty / envelope contract

- **Exact identities, no model** — the PnL and greeks are closed forms; disclosed as `model: 'inverse-future'`.
- **Delta-1 perp assumption disclosed** — the hedge treats the future/perp mark as moving 1:1 with the
  underlying that the coin delta was measured against (exact for a perp; a dated future carries basis). The
  assumption is echoed and the residual gamma makes the convexity mismatch explicit rather than hidden.
- **First-touch guards** — non-object input; non-positive `notionalUsd`/`entryPrice`/`markPrice`; a bad
  `side`; a non-finite `coinDelta`/`coinGamma` — all throw a typed `QuantError`. Both are single-object
  functions ⇒ covered by the first-touch **garbage sweep** (no fixture).
- **Envelope (R2)** — each returns a domain object carrying `assumptions` + `diagnostics`.

## API

```ts
interface InverseFutureInput {
  /** USD notional (= contracts × contract multiplier, e.g. $10/contract on Deribit). */
  notionalUsd: number;
  /** Entry price (USD per coin). */
  entryPrice: number;
  /** Current mark price (USD per coin). */
  markPrice: number;
  /** Position side. Default 'long'. */
  side?: 'long' | 'short';
}
interface InverseFuture {
  coinPnl: number;
  usdPnl: number;
  coinDelta: number;
  coinGamma: number;
  coinExposure: number;
  assumptions: Assumptions;
  diagnostics: Diagnostics;
}
interface InverseHedgeInput {
  /** The coin delta to neutralize (e.g. an inverse option's coin delta). */
  coinDelta: number;
  /** Mark price of the inverse future/perp used to hedge (USD per coin; perp ≈ spot). */
  markPrice: number;
  /** Coin gamma of the position being hedged — supply to get the residual gamma after the delta hedge. */
  coinGamma?: number;
}
interface InverseHedge {
  notionalUsd: number;
  side: 'long' | 'short';
  hedgeCoinDelta: number;
  residualCoinGamma?: number;
  assumptions: Assumptions;
  diagnostics: Diagnostics;
}

function inverseFuture(input: InverseFutureInput): InverseFuture;
function inverseHedge(input: InverseHedgeInput): InverseHedge;
```

## Build checklist

1. **`inverseFuture`** — validate; the coin PnL, usdPnl, coin delta/gamma, and coin exposure with the side
   sign; R2 envelope.
2. **`inverseHedge`** — validate; `notionalUsd = |D|·F²`, `side = D>0?short:long`, `hedgeCoinDelta = −D`,
   and (given `coinGamma`) the residual coin gamma; R2 envelope.
3. **Export from `packages/crypto/src/index.ts`** (auto-discovered by api-report / READMEs / llms).
4. **Tests** — coin PnL + greeks vs finite-difference (long & short); the short-gamma-in-coin property; the
   USD-vs-coin delta contrast; the hedge sizes to `|D|·F²` and **neutralizes an `inverseOption` coin delta
   to 0** (the integration test); residual gamma; a zero-delta no-op hedge; guards.

## Deferred (explicitly)

- **Liquidation price & maintenance-margin** for an inverse position (needs the venue margin schedule).
- **The dated-future basis in the hedge** — hedging with a future whose mark ≠ spot (a basis-adjusted hedge
  ratio), and multi-leg (option + perp + spot) coin-greek booking.
- **Funding-aware carry of the hedge** — combining `perpetualFunding` with the hedge to show the funding drag of
  holding the perp hedge over time.
