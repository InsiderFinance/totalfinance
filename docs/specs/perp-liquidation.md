# Spec — Perp/future liquidation & bankruptcy price (`@totalfinance/crypto`)

> Wave 4 (Crypto completion). Status: **shipped** as `liquidationPrice` in
> `packages/crypto/src/liquidation.ts` (+ the `./liquidation` subpath), covered by
> `packages/crypto/test/liquidation.test.ts`, full CI green.

## Goal

The single most-watched number for a leveraged crypto trader: **at what mark price am I liquidated?** —
for both **inverse** (coin-margined, Deribit/BitMEX) and **linear** (USDT-margined) perps/futures, plus the
**bankruptcy price** (where all posted margin is gone). Pure closed form; depends only on `@totalfinance/core`.

## The definition (and the convention that matters)

Liquidation is where **account equity first equals the maintenance margin**. Everything hinges on where the
maintenance margin is assessed. We use the economically exact **mark-based** convention (maintenance on the
position value at the _current_ mark), **isolated** margin. Some venues publish an entry-notional closed
form (e.g. BitMEX's `entry/(1 + IMR − MMR)`, maintenance on the _entry_ notional) — a few basis points
apart; the difference is disclosed in `assumptions.marginBasis`.

With the initial-margin rate `IMR = 1/leverage` and the maintenance-margin rate `MMR = m`, the mark-based
prices are **size-independent**:

```
                inverse (coin-margined)      linear (USDT-margined)
  long         F₀·(1+m)/(1+IMR)              F₀·(1−IMR)/(1−m)
  short        F₀·(1−m)/(1−IMR)              F₀·(1+IMR)/(1+m)
```

The **bankruptcy price** is the same formula with `m = 0` (equity = 0). Liquidation always sits between the
entry and the bankruptcy price by the maintenance buffer: a long liquidates _below_ entry, a short _above_.

Each formula is **derived, then verified against its own definition**: substituting the returned price back
into `equity(F)` and `maintenanceMargin(F)` gives equality to ~1e-10 for all four (inverse/linear ×
long/short), and `equity(bankruptcyPrice) = 0`.

## API (`@totalfinance/crypto`, subpath `./liquidation`)

```ts
liquidationPrice(input: {
  margin: 'inverse' | 'linear';   // coin-margined vs USDT-margined
  entryPrice: number;             // USD per coin
  leverage: number;               // > 1 (IMR = 1/leverage)
  maintenanceMarginRate: number;  // m, in [0, 1)
  side?: 'long' | 'short';        // default 'long'
}): Computed<{
  liquidationPrice: number;
  bankruptcyPrice: number;
  distanceToLiquidation: number;  // |liq − entry| / entry
  initialMarginRate: number;      // 1/leverage
}, { margin; side; maintenanceMarginRate; marginBasis }>
```

## Honesty / envelope contract

- A `Computed` envelope; `assumptions` echoes the margin mode, side, MMR, and the exact margin basis
  (`isolated; maintenance assessed at the mark`).
- Guards (typed `QuantError`, never a raw crash or silent NaN): `leverage > 1` (an isolated liquidation
  price is degenerate at ≤1× — a 1× long liquidates only at 0, a 1× inverse short never within margin),
  `maintenanceMarginRate ∈ [0, 1)`, positive `entryPrice`, a known `margin` mode, and Law-12 unknown-key
  rejection.

## Verified

Definitional equality (`equity == maintenance margin` at the liquidation price, `equity == 0` at bankruptcy)
for all four cases; the closed forms (inverse-long 45681.82, linear-short 54726.37 at F₀=50000, 10×, m=0.5%);
direction (long below / short above entry); size-independence; monotonicity (higher leverage ⇒ closer
liquidation).

## Deferred (explicitly)

- **Cross margin** (v1 is isolated): cross liquidation depends on the whole account's equity and the other
  positions' unrealized PnL — a portfolio computation, not a per-position closed form.
- **Fees & funding accrual** in the liquidation threshold (v1 is the pure margin math); a taker-fee /
  accrued-funding buffer shifts the price slightly and is venue-specific.
- **Tiered maintenance margin** (the MMR rises with position size on most venues); v1 takes a single MMR.
