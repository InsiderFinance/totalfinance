# Spec — Portfolio book / risk aggregation (`@totalfinance/risk`)

> Roadmap Tier 2 → "Multi-strategy portfolio ledger: positions aggregated with beta-weighted greeks,
> margin, stress" (also spec §12.2 "Greeks aggregation, options scenario grids, concentration"). The
> first-class **book** abstraction that ties the risk primitives together. Status: **shipped** as
> `analyzeBook` in `packages/risk/src/book.ts`, covered by `packages/risk/test/book.test.ts`, full CI
> green.

## Goal

Answer, in one call, "what is my whole book's risk **right now**?" — net greeks, beta-weighted delta
to a reference index, total and per-position margin, concentration by name, a per-position and
per-underlying breakdown, and (optionally) the book's P&L under a set of scenarios. It composes the
existing risk primitives; the value it adds is the missing **top-level book object** and the marking
that turns a list of strategy `Position`s into aggregate risk.

## Why this is a composition, not a re-implementation

The risk package already has the pieces, but they take raw greek data, not strategy positions:

- `aggregateGreeks(positions)` (portfolio.ts:430) sums greeks — but wants `{ quantity, greeks }`, not
  a marked strategy `Position`.
- `betaWeightedDelta(positions, { indexPrice })` (portfolio.ts:471) — wants `{ delta, spot, beta }`.
- `optionsMargin(legs, { spot })` (portfolio.ts:335) — per-position Reg-T margin.
- `concentration(weights)` (portfolio.ts:38) — HHI / effective-N / top-k / Gini.
- `stressTest(positions, scenarios)` (scenario.ts:235) — book P&L via `taylorPnl` (raw greeks).

`analyzeBook` marks each strategy `Position` at its market (`Position.value()`), converts to the
shapes those primitives expect (reusing the display→raw greek bridge from `pnl-explain`), and returns
one coherent `BookRisk`.

## API

```ts
interface BookPosition {
  position: Position; // a strategy Position (multi-leg on one underlying)
  market: PnlMarket; // { spot, vol?, rate, asOf, dividendYield? } — reused from pnl-explain
  id?: string;
  underlying?: string; // for per-underlying grouping (default: id ?? `position-${i}`)
  beta?: number; // to the reference index (default 1)
}

interface BookOptions {
  indexPrice?: number; // reference index price → beta-weighted delta
  scenarios?: readonly Scenario[]; // optional book P&L under scenarios (reuses stressTest)
  multiplier?: number; // margin contract multiplier (default 100)
  regulationTRate?: number; // Reg-T naked-margin rate knob (forwarded to optionsMargin)
}

/** Net book greeks in trader-facing DISPLAY units (delta $, theta/day, vega/1%, rho/1%), dollar-scaled. */
interface BookGreeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
}

interface PositionRisk {
  id: string;
  underlying: string;
  value: number; // net unrealized P&L of the position ($) — Position.value() (since entry), not NAV
  greeks: BookGreeks;
  margin: number; // initial margin
  definedRisk: boolean;
}

interface UnderlyingRisk {
  underlying: string;
  value: number;
  greeks: BookGreeks;
  margin: number;
}

interface BookRisk {
  value: number; // net unrealized P&L of the book ($) — Σ Position.value() (since entry), not NAV
  greeks: BookGreeks; // net, display units
  betaWeightedDelta?: BetaWeightedDeltaResult; // present when indexPrice is given
  margin: { total: number; buyingPowerReduction: number };
  concentration: ConcentrationResult; // on per-underlying margin (risk allocation by name)
  byPosition: PositionRisk[];
  byUnderlying: UnderlyingRisk[];
  scenarios?: ScenarioResult[]; // present when options.scenarios is given
  assumptions: { conventionsVersion: string; indexPrice?: number; multiplier: number };
  diagnostics: Diagnostics;
}

function analyzeBook(positions: readonly BookPosition[], opts?: BookOptions): BookRisk;
```

## Semantics

- **Value** is net **unrealized P&L** since entry (Σ `Position.value().value`, which is P&L), not
  liquidation NAV — the "am I up or down?" read-out, internally consistent with the per-position rows.
- **Net greeks** are the sum of each position's `Position.value(market).greeks` (already dollar /
  share-equivalent, display units) — the trader read-out ("+$500 delta, −$200 theta/day, +$1k vega").
- **Beta-weighted delta** (when `indexPrice` given): each position's share-equivalent delta ×
  `spot` × `beta`, summed and divided by `indexPrice` — "net delta in index-equivalent shares."
- **Margin**: `optionsMargin` per position for pure-option structures (defined-risk max loss, long
  premium, or Reg-T naked). A **stock-covered** structure (covered call, collar, protective put) has
  its risk capped by the stock leg, which the options-only calc can't see, so a single-expiry
  stock-inclusive position uses the position's own stock-inclusive max loss (capital at risk) as its
  margin — a covered call reads as defined-risk, never a naked short. A stock-only or greek-only
  position contributes 0 option margin. The book totals `initialMargin` and `buyingPowerReduction`.
- **Concentration**: `concentration` over per-underlying margin — the honest "how much of my buying
  power is in one name." A zero-margin book (all long-premium / stock-only) reports the neutral zero
  rather than leaking a divide-by-zero NaN.
- **Per-underlying**: positions grouped by `underlying`, greeks + value + margin summed per name.
- **Scenarios** (when given): convert each position to a raw-greek scenario position and run
  `stressTest` — book and per-position P&L (with greek attribution) under `shock.spot('-5%')`, etc.
  Percent spot shocks resolve per-position (each underlying moves by its own %), so a multi-underlying
  book stresses correctly.

## Honesty / envelope contract

- Every result carries `assumptions` + `diagnostics`; a position that can't be marked (missing vol
  for a leg without IV) surfaces the strategy's typed error, never a NaN.
- Typed guards: a raw object is not a `Position` (instance check); `indexPrice > 0` when beta-weighting.
- Pure and deterministic; times are explicit `asOf`s.

## Build checklist

1. **Types** — `BookPosition`, `BookOptions`, `BookGreeks`, `PositionRisk`, `UnderlyingRisk`, `BookRisk`.
2. **Reuse the unit bridge** — export `rawGreeksFromDisplay` from `pnl-explain` (one source for the
   display→raw conversion).
3. **`analyzeBook`** — mark each position; aggregate net greeks; per-position margin (`optionsMargin`);
   group by underlying; beta-weighted delta (`betaWeightedDelta`); concentration (`concentration`);
   optional `stressTest` roll-up; assemble the envelope. Guards throughout.
4. **Exports + wiring** — risk index. (No new package deps — strategy/options already added for
   pnl-explain.)
5. **Tests** — net greeks = Σ per position; per-underlying grouping and sums; beta-weighted delta vs a
   hand value; margin total = Σ; concentration on a one-name vs spread book; scenario roll-up P&L
   sign; envelope/guards; deep-sweep fixture.

## Deferred (explicitly)

- Stock legs price and now margin correctly (covered call / collar / protective put use the
  stock-inclusive max loss); a pure **futures** instrument type is still a follow-up.
- VaR/CVaR on the book (the `var.ts` functions already take returns / a covariance; wiring a
  greek-based parametric book VaR is a natural next step).
- Cross-underlying correlation in stress (v1 shocks each name independently; a correlated stress
  matrix is a follow-up).
