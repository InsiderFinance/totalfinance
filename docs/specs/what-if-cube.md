# Spec — What-if cube (`@totalfinance/strategy`)

> Roadmap Tier 3 → Strategy intelligence → _"What-if cubes: position value over spot × vol × time with
> optimal-exit surfaces (`scenarioTable` extended a dimension)."_ Status: **shipped** as
> `Position.whatIfCube(...)` in `packages/strategy/src/position.ts`, covered by
> `packages/strategy/test/what-if-cube.test.ts`, full CI green.

## Goal

Every options trader asks the same three-variable question: **"what happens to my position if the stock
moves _and_ implied vol shifts _and_ time passes?"** `scenarioTable` already marks a position across a
spot × vol-shock × days-forward grid, but it returns a **flat list of rows** — you can't slice it, and
it stops at the raw marks. `whatIfCube` turns that grid into a navigable **cube** and adds the thing a
trader actually wants out of it: the **optimal-exit surface** — for every (spot, vol) outcome, the day
along the time axis at which the mark-to-market is best (or worst). "If the stock lands at 110 with IV
down 5%, your best exit is day 12 for +\$340" becomes one lookup.

Built by composing `Position.value()` per cell — the same time-aware, per-leg-IV, vol-shock-through-to-
leg-IV mark `scenarioTable` uses — so a calendar/diagonal (multi-expiry) position is handled correctly
and nothing about the pricing is re-implemented.

## The cube

Three axes, each supplied explicitly (a `PriceRange` is expanded for the price axis):

- **prices** — underlying spot levels (`number[]` or `{ from, to, steps }`).
- **volatilityShocks** — additive vol shocks in decimal (e.g. `[-0.05, 0, 0.05]`); default `[0]`. The shock
  reaches every effective leg vol (a leg's own `impliedVolatility`, or the position `volatility`), exactly as in `value()`.
- **daysForward** — calendar days to advance `asOf` (e.g. `[0, 7, 14, 30]`); default `[0]`.

The cube is the full cartesian product. Each **cell** carries the mark and the live Greeks:

```ts
interface WhatIfCell {
  underlyingPrice: number;
  volatilityShock: number;
  daysForward: number;
  pnl: number; // mark-to-market P&L in this scenario
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}
```

`cells` is a flat array in **row-major order — price outer, vol middle, day inner** — so the cell for
`(priceᵢ, volⱼ, dayₖ)` is at index `((i·|volatilityShocks|) + j)·|daysForward| + k`. `axes` echoes the three
resolved axes so a caller can index or pivot without re-deriving them.

## The optimal-exit surface

The new dimension-reduction. For each **(price, volatilityShock)** pair, scan the `daysForward` axis and pick
the day that **optimizes** P&L — `max-pnl` by default, or `min-pnl` (worst-case). The result is a
surface over the (spot, vol) plane:

```ts
interface OptimalExitPoint {
  underlyingPrice: number;
  volatilityShock: number;
  daysForward: number; // the time-axis day that optimizes P&L at this (spot, vol)
  pnl: number; // the optimized P&L there
}
```

- For a **short-premium** position (net theta positive) the optimum is typically the **latest** day —
  decay is your friend, so hold. For a **long-premium** position at a favourable spot it is often an
  **earlier** day — exit before theta erodes the gain.
- **Semantics, disclosed:** this is a _conditional what-if_ — "if the underlying is at this spot with
  this vol shock, which day marks best?" — not a path-dependent optimal-stopping rule (it does not model
  a stochastic path or early-exercise timing). The cube holds spot and vol fixed while advancing time.

## Cube extremes

`best` and `worst` are the single cells with the global maximum and minimum P&L across the whole cube —
the trader's "best case / worst case over everything I'm considering," with the exact (spot, vol, day)
that produces each.

## Honesty / envelope contract

- **One-envelope (R2)** — the cube (`{ axes, cells, optimalExit, best, worst }`) is the `value`;
  `assumptions` echoes `marketSource` (construction / call / merged, R5); warnings ride `diagnostics`.
- **Volatility-floor disclosed** — a shocked vol that lands at/below the `1e-6` floor is priced at the floor
  (not a non-positive vol), and the number of such cells rides a `strategy.volatility_floored` warning, exactly
  as `scenarioTable` does — never a silent floor-vol mark.
- **Composes, never re-prices** — every cell is a `Position.value()` mark, so multi-expiry positions,
  per-leg IVs, dividends, and the market-source precedence all behave identically to the rest of the
  position API.
- **`asOf` required** — advancing time needs a base `asOf` (from the call market or the construction
  market); its absence throws a typed error naming the field, like `scenarioTable`.
- Typed guards (a valid price range/array; finite vol shocks; non-negative integer... — `daysForward`
  may be any finite day count including fractional; a valid `objective`).

## API

```ts
interface WhatIfCubeOptions {
  market?: Partial<Omit<MarkToMarketInput, 'spot'>>;
  prices: number[] | PriceRange;
  volatilityShocks?: number[];                 // default [0]
  daysForward?: number[];               // default [0]
  /** Which extremum the optimal-exit surface picks per (spot, vol); default 'max-pnl'. */
  objective?: 'max-pnl' | 'min-pnl';
}
interface WhatIfCubeValue {
  axes: { prices: number[]; volatilityShocks: number[]; daysForward: number[] };
  cells: WhatIfCell[];                  // flat, row-major (price outer, vol mid, day inner)
  optimalExit: OptimalExitPoint[];      // one per (price, volatilityShock)
  best: WhatIfCell;                     // global max-P&L cell
  worst: WhatIfCell;                    // global min-P&L cell
}
type WhatIfCubeResult = Computed<WhatIfCubeValue, { marketSource: MarketSource }>;

// method on Position:
whatIfCube(options: WhatIfCubeOptions): WhatIfCubeResult;
```

## Build checklist

1. **Types** — `WhatIfCell`, `OptimalExitPoint`, `WhatIfCubeValue`, `WhatIfCubeOptions`,
   `WhatIfCubeResult` in `types.ts`.
2. **Method** — `Position.whatIfCube`: resolve the axes (expand a `PriceRange`), loop the cartesian
   product calling `this.value()` per cell (row-major), tally vol-floored cells.
3. **Reductions** — the optimal-exit surface (argmax/argmin over the day axis per (spot, vol)) and the
   global `best`/`worst` cells.
4. **Envelope** — `value` = the cube; `assumptions.marketSource`; the vol-floor warning on diagnostics.
5. **Exports + API report + READMEs/llms** (+ a deep-sweep fixture — `whatIfCube` is a Position method,
   probed via the position facade fixture).
6. **Tests** — the cube dimensions and row-major indexing match the equivalent `scenarioTable` cells;
   the optimal-exit surface picks the true argmax day (short-premium → latest, long-premium → an earlier
   day) and honours `min-pnl`; `best`/`worst` are the global extremes; the vol-floor disclosure fires on
   a crushing negative shock; `asOf`-missing and bad-axis guards.

## Wave 6 §3 — probability mass + break-even-time (shipped)

- **Break-even-in-time** — `value.breakEven.firstNonNegativeDayByPriceAndVolatility` (price outer, vol inner):
  the first requested `daysForward` with non-negative P&L per (price, vol), or `null`. A conditional
  surface, not a simulated path, and not assumed monotone. Always present.
- **Probability-weighting** — opt-in via `probability: { model, gridPolicy? }`. Resolves a spot
  distribution per day (GBM by `measure` — `riskNeutral` default / `realWorld` / `explicit`, no silent
  zero drift — or a `custom` density over an explicit support), converts the grid to midpoint bins with
  CDF/quadrature mass, discloses the out-of-grid tails, and reports `spotMassByDay` + `expectedPnlByVolatilityAndDay`
  (per vol-shock and day — no probability is placed on the vol axis). Shares the `priceGridDistribution`
  quadrature with the strategy optimizer. At expiry on the zero-vol slice the weighted P&L converges to
  `probability().expectedValue` as the grid refines. See
  [`specs/wave6-quant-moats.md`](./wave6-quant-moats.md#wave6-cube-probability).

## Deferred (explicitly)

- **A rendered heat-map** (spot × vol/time SVG) — pairs with `payoffSvg`; a `@totalfinance/viz` concern.
- **Path-aware optimal stopping** — a genuine early-exit policy over a stochastic path (this cube is the
  conditional what-if that feeds one).
- **A joint spot-volatility distribution** and **probability over optimal-exit decisions** — the cube
  places mass on spot only; the vol axis stays a scenario knob.
