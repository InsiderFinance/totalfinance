# Spec — P&L explain (`@totalfinance/risk`)

> Graduates roadmap §1.3 into an implementable workstream. P&L explain is a **spec'd feature**
> (spec §12.2 lists it under `@totalfinance/risk`). Authored from the primitives map; every composed
> primitive is real and cited. Status: **shipped** in `packages/risk/src/pnl-explain.ts`, covered by
> `packages/risk/test/pnl-explain.test.ts`, full CI green.

## Goal

Decompose a position's (or a portfolio's) **realized** P&L between two market states into the greek
contributions — delta, gamma, vega, theta, rho — plus an honest **unexplained residual**. "Why did I
make or lose money between Monday and Tuesday?" is a question traders ask daily and almost nothing
open-source answers cleanly.

## The core idea (and why it reuses existing code)

The risk package already has the greek-Taylor engine: `taylorPnl(greeks, scenario)` (scenario.ts:186)
returns `PnlAttribution { total, delta, gamma, vega, theta, rho, other }` computing
`Δ·dS + ½Γ·dS² + Vega·dσ + Θ·timeStepYears + Rho·dr`. Its module doc already calls this "a P&L explain
decomposition."

P&L explain is the **realized** wrapper: instead of a hypothetical scenario shock, feed the **actual
observed move** (t0 → t1) and the **actual realized P&L**, then set

```
unexplained = actualPnl − (Δ·dS + ½Γ·dS² + Vega·dσ + Θ·timeStepYears + Rho·dr)
```

`taylorPnl`'s `other` is always 0 (pure Taylor); P&L explain's residual is the load-bearing honesty
term — it holds the higher-order (3rd+ order in spot), cross (vanna·dS·dσ, vomma·dσ², charm), and any
model/data effects the first-order-plus-gamma expansion doesn't capture. Small moves ⇒ residual ≈ 0;
large moves ⇒ residual grows, which is exactly the signal that "the greeks stopped being a good
approximation over this move."

**Invariant (exact up to floating-point rounding):** `delta + gamma + vega + theta + rho + unexplained
=== total` — reconstructed as `Σterms + (actual − Σterms)`, bit-exact except under catastrophic
cancellation (explained P&L dwarfing actual by ~16 orders of magnitude, never a real book).

## Placement & dependencies

Lives in **`@totalfinance/risk`** (its spec'd home, §12.2), a new module `src/pnl-explain.ts`. The
greek-Taylor engine (`taylorPnl`) is already here. The position-level convenience composes the
strategy `Position` (`Position.value()` for marking + greeks), a legal downward dependency (strategy
sits above risk in the §3 graph; risk currently deps core/math/performance — we add `@totalfinance/strategy`
and `@totalfinance/options` for the `Greeks` type). No cycle: nothing depends on risk except backtest.

## Units — the one thing that must be exact

`taylorPnl` (and `PositionGreeks`) use **raw** greeks: theta per +1 **year**, vega per +1.00 vol,
rho per +1.00 rate; delta per $1 spot, gamma per $1². `Position.value().greeks` (and `blackScholesGreeks`)
use **display** units: theta per **day**, vega per **1%** (0.01), rho per **1%** (0.01). The bridge
(`bsm.ts:85-88`: `theta = thetaPerYear/365`, `vega = vegaPerWhole/100`, `rho = rhoPerWhole/100`) is
inverted exactly in the position convenience:

```
raw.theta = display.theta × 365     raw.vega = display.vega × 100     raw.rho = display.rho × 100
raw.delta = display.delta           raw.gamma = display.gamma
```

The primitive `explainPnl` takes raw greeks + a raw realized move (consistent with `taylorPnl`); only
the position convenience does the display→raw conversion, keeping the footgun localized.

## API

### `explainPnl(greeks, move, actualPnl)` — the primitive (any instrument with greeks)

```ts
interface PnlMove {
  dSpot?: number; // absolute spot change ($)
  dVolatility?: number; // absolute vol change (decimal; +0.02 = +2 vol points)
  dTimeYears?: number; // time elapsed (YEARS)
  dRate?: number; // absolute rate change (decimal; +0.005 = +50bp)
}
interface PnlExplain {
  total: number; // the actual realized P&L
  delta: number; // Δ·dS
  gamma: number; // ½Γ·dS²
  vega: number; // Vega·dσ
  theta: number; // Θ·timeStepYears
  rho: number; // Rho·dr
  unexplained: number; // total − Σ(terms): higher-order + cross + model/data
}
function explainPnl(greeks: PositionGreeks, move: PnlMove, actualPnl: number): PnlExplain;
```

Builds an absolute-shock scenario from `move`, runs `taylorPnl`, and sets `unexplained = actualPnl −
taylor.total`, `total = actualPnl`.

### `explainPositionPnl(position, from, to)` — the strategy-Position convenience (with per-leg)

```ts
interface PnlMarket {
  spot: number;
  volatility?: number;
  riskFreeRate: number;
  asOf: EpochMs | string;
  dividendYield?: number;
}
interface LegPnlExplain extends PnlExplain {
  leg: Leg;
}
interface PositionPnlExplain extends PnlExplain {
  perLeg: LegPnlExplain[];
}
function explainPositionPnl(position: Position, from: PnlMarket, to: PnlMarket): PositionPnlExplain;
```

- `v0 = position.value(from)`, `v1 = position.value(to)` (respecting per-leg IV / expiry).
- `actualPnl = v1.pnl − v0.pnl`; move = `{ dSpot: to.spot−from.spot, dVolatility: to.vol−from.vol,
dTimeYears: yearFraction(from.asOf, to.asOf, 'ACT/365F'), dRate: to.rate−from.rate }`.
- Aggregate explain from `toRaw(v0.greeks)`; per-leg explain from each `v0.perLeg[i].greeks` and
  `v1.perLeg[i].pnl − v0.perLeg[i].pnl`.

**Volatility attribution is honest per leg.** A leg built with per-leg fixed IV (e.g. from a chain) holds
that IV in `Position.value()`, so `from.vol`/`to.vol` don't move it — its actual vol P&L is 0, and it
is therefore attributed against a **zero** vol move: vega ≈ 0, no phantom vega and no phantom residual.
A leg pricing off the position-level `vol` (no per-leg IV) is attributed with the full `to.vol −
from.vol`. The aggregate is the term-wise sum of the per-leg attributions, so it stays exactly
consistent even for a mixed book. To break out a per-leg IV change, mark that leg's own IV, or use the
`explainPnl` primitive directly with your greeks + the vol move you observed.

### `explainPortfolioPnl(items)` — the portfolio roll-up (multi-underlying)

```ts
interface PortfolioPnlItem {
  position: Position;
  from: PnlMarket;
  to: PnlMarket;
  id?: string;
}
interface PortfolioPnlExplain extends PnlExplain {
  byPosition: (PositionPnlExplain & { id?: string })[];
}
function explainPortfolioPnl(items: readonly PortfolioPnlItem[]): PortfolioPnlExplain;
```

Each item carries its own market context (so a portfolio can span underlyings); the book explain is
the term-wise sum, with `byPosition` preserved.

## Honesty / envelope contract

- The residual is a first-class, always-present field — the decomposition never silently drops the
  unexplained part.
- Typed guards on every entry (garbage greeks/move/market → teaching error, not a raw crash); the
  multi-arg callables ship deep-sweep fixtures.
- Pure and deterministic; no clock reads (times are explicit `asOf`s resolved via core `resolveAsOf`).

## Build checklist

1. **Types** — `PnlMove`, `PnlExplain`, `PnlMarket`, `LegPnlExplain`, `PositionPnlExplain`,
   `PortfolioPnlItem`, `PortfolioPnlExplain`.
2. **`explainPnl`** — scenario build + `taylorPnl` + residual; guards.
3. **Unit bridge** — `toRaw(display, value, spot)`.
4. **`explainPositionPnl`** — value(from)/value(to), move, aggregate + per-leg; guards.
5. **`explainPortfolioPnl`** — sum over items; guards.
6. **Exports + package wiring** — risk index, package.json deps (`strategy`, `options`),
   tsconfig.build references.
7. **Tests** — the sum-to-total identity; residual ≈ 0 for tiny moves and growing for large moves;
   per-leg attribution sums to the aggregate; a known hand-computed single-option case; portfolio
   sum; envelope/guards; deep-sweep fixtures.

## Deferred (explicitly, for a follow-up)

- Higher-order terms (vanna/vomma/charm via `blackScholesExtendedGreeks`) to shrink the residual on demand
  (`{ order: 2 }`); v1 is first-order + gamma with everything else in the residual.
- A `dividend`/`carry` (epsilon) term; v1 folds dividend-yield changes into the residual.
- Backtester integration (per-trade / per-snapshot attribution in `@totalfinance/backtest/options`) — a
  natural consumer once this lands, and the piece that makes the backtester's vega story real.
