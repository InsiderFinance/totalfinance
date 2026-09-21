# Spec — Options backtesting (`@totalfinance/backtest/options`)

> Graduates roadmap §1.2 into an implementable workstream. Authored from the primitives map; every
> composed primitive is real and cited. Status: **shipped** in `packages/backtest/src/options/`,
> covered by `packages/backtest/test/options-backtest.test.ts`, full CI green.
> This file remains the normative contract for the current implementation. FC8 in
> [`finance-portfolio-backtesting-completeness.md`](./finance-portfolio-backtesting-completeness.md)
> owns the accepted portfolio-grade completion work and its portfolio/ledger integration gate. No
> versioned public API is planned: pre-release improvements refine the existing `optionsBacktest`
> surface before its stable contract freezes.

## Goal

A chain-driven options-strategy backtester: run a rules-based options strategy (e.g. "sell the
30-delta put spread at 45 DTE, close at 50% profit or 21 DTE") over a **time series of historical
option chains**, and get back an equity curve, per-trade + per-leg P&L attribution, assignment
events, and an options-native tear sheet — all under the TotalFinance envelope (assumptions +
diagnostics, no silent degradation, no look-ahead).

## Placement & dependencies

Lives in **`@totalfinance/backtest`** as a new subpath **`@totalfinance/backtest/options`**. Rationale:

- The spec's package architecture (§3) has exactly one `backtest` package; `backtest` sits below
  `strategy`/`options`/`risk`, so depending on them is a legal downward edge.
- The option **settlement/assignment simulation** already lives in `backtest` (`broker.ts`:
  `settleExpiries`, `earlyAssignmentsForBar`, `OptionSettlement`) — the new engine belongs next to it
  and reuses its settlement record shape + cost models + tear-sheet/performance machinery.
- Subpath export keeps it tree-shakeable: `@totalfinance/backtest/vectorized` never pulls in the options
  engine's imports.

New deps added to `packages/backtest/package.json`: `@totalfinance/strategy`, `@totalfinance/options`,
`@totalfinance/risk`, `@totalfinance/calendars`. (The module-doc "core/math/performance only" note is updated.)

## Input: the chain time series (new type)

No chain-time-series type exists in the repo; introduce one (mirrored in the data-layer doc's
`optionChainSeries`):

```ts
interface ChainSnapshot {
  asOf: EpochMs | string; // resolved via core resolveAsOf
  underlyingPrice: number;
  quotes: OptionQuote[]; // the core chain row; Greeks ride `greeks` (vendor-supplied or `chainGreeks`)
}
```

The engine accepts `Iterable<ChainSnapshot>`; it sorts by resolved `asOf` and iterates ascending.
Delta-based selection requires `greeks.delta` on the quotes (thrown-with-teaching-error if absent,
pointing at `@totalfinance/options` `chainGreeks({ quotes, market })` — reusing strategyFromChain's
existing guard).

## The strategy definition (the product surface)

Declarative-first, with callback escape hatches. The declarative form captures the ~80% case an
options trader thinks in; a `when`/`select` callback covers the tail without leaving the API.

```ts
const result = optionsBacktest({
  chains, // Iterable<ChainSnapshot>
  initialCapital: 100_000,
  riskFreeRate: 0.04, // risk-free for MTM + assignment carry (vol comes from chain IV)

  entry: {
    when: 'flat', // 'flat' | 'always' | (ctx) => boolean   (default 'flat')
    daysToExpiry: { target: 45, min: 30, max: 60 }, // pick the listed expiry nearest 45 DTE within [30,60]
    structure: 'bullPutSpread', // a FromChainType
    select: { shortDelta: 0.3, width: 5 }, // maps onto strategyFromChain's per-type selection
    sizing: { quantity: 1 }, // OR { maxMarginFraction: 0.5 } for margin-aware
  },

  exit: {
    profitTarget: 0.5, // close at 50% of credit captured
    stopLoss: 2.0, // close at 2× credit lost
    daysToExpiry: 21, // close at ≤ 21 DTE
    when: (ctx) => ctx.netDelta < -60, // optional escape hatch (OR-combined)
  },

  roll: { when: { daysToExpiry: 21 } }, // optional: roll to a fresh `entry` instead of closing flat

  hedge: { deltaBand: 15 }, // optional: keep |net delta| ≤ band (share-equivalents) via the underlying

  commission: fees.perShare(0.65), // per-contract commission; slippage: slippage.bps(1) too
});
```

**Escape hatches.** `entry.when`, `entry.build` (a function returning a custom `Position`),
`exit.when`, and `roll.when` all accept callbacks receiving a context (`{ snapshot, position?, markToMarket?,
dte, netDelta, cash, equity }`). Declarative fields and callbacks OR-combine for exits.

**Why declarative-first:** the entry maps almost 1:1 onto `strategyFromChain(quotesForExpiry, { type:
structure, expiry, ...select })` (from-chain.ts:241) — the library already resolves structure +
delta + width selection from a chain, so the engine is a thin, honest driver over proven code.

## The event loop (per snapshot, ascending `asOf`, no look-ahead)

For each `ChainSnapshot`:

1. **Mark** open position(s) to market: `position.value({ spot: snap.underlyingPrice, asOf,
rate, dividendYield })` → P&L + per-leg + aggregate greeks (per-leg IV comes from the chain quotes
   the position was built from). Record MTM + portfolio greeks. A chain that carries **no stated IV**
   (delta-only / bare-price feeds) is enriched once per snapshot by implying each quote's IV from its
   entry-source premium, so every leg gets a real entry IV (an exact entry mark) and no run ever
   crashes for lack of a vol; a position that still can't be priced discloses a skip, never throws.
2. **Settle expiries**: any leg with `expiry ≤ asOf` settles at **true intrinsic** — the mark is taken
   at the leg's expiry instant (16:00 ET), not the date-only snapshot midnight, so a held-to-expiry
   position captures its full credit with no residual time value, and the booked cash equals the
   `OptionSettlement` records' intrinsic cashFlow. ITM shorts are assigned. Realize P&L, emit an
   `OptionSettlement` (mirroring broker.ts's record shape + reasons), close the position. Early
   assignment on American shorts uses the broker's disclosed heuristic (deep-ITM / ex-div) behind an
   `assignment: 'model' | 'none'` flag. A multi-expiry (calendar) position settles when its nearest
   leg expires; the far leg is marked at its remaining time value.
3. **Exit / roll**: if open and any exit trigger fires (profit target on captured credit, stop-loss,
   DTE threshold, or `when` callback), close at the current mark (minus costs) and record. If a roll
   rule matches, immediately re-enter (step 4) in the same snapshot.
4. **Entry**: if the entry condition holds, pick the expiry nearest `dte.target` within `[min,max]`
   from the snapshot's listed expiries, build the position via `strategyFromChain`, size it
   (fixed `quantity` or `optionsMargin`-bounded `maxMarginFraction`), debit/credit cash, record the
   entry trade.
5. **Delta hedge** (optional): after marking, if `|net delta| > deltaBand`, trade the underlying to
   neutralize; account slippage/commission and carry the hedge share position's P&L.
6. **Equity point**: `cash + open-position MTM + hedge MTM`, stamped at `asOf`.

Fills use the snapshot's quotes at a configurable price source (default mid); there is no intra-day
look-ahead because each snapshot only sees its own chain. Costs reuse `@totalfinance/backtest/costs`.

## Sizing & margin

- `quantity: n` — fixed contract count.
- `sizing: { maxMarginFraction }` — size to the largest whole contract count whose `optionsMargin`
  (`@totalfinance/risk`) ≤ `maxMarginFraction × equity`. Defined-risk structures margin at max loss;
  undefined-risk use the Reg-T formula the risk package already implements. Disclosed in assumptions.

## Output

```ts
interface OptionsBacktestResult {
  points: EquityPoint[];               // reuse the backtest EquityPoint
  returns: number[];
  trades: OptionsTrade[];              // entry/exit asOf, structure, legs, credit/debit, realized P&L, per-leg + greek P&L attribution, exit reason
  settlements: OptionSettlement[];     // reuse the broker's record type
  finalValue: number;
  performance: PerformanceSummary;     // via @totalfinance/performance
  assumptions: OptionsBacktestAssumptions;  // rate, priceSource, sizing, assignment, conventionsVersion — the envelope
  diagnostics: Diagnostics;            // warnings: look-ahead-free by construction; margin/assignment/marked-at-cost disclosures
}

optionsTearSheet(result): OptionsTearSheet  // extends the equity tear sheet
```

`optionsTearSheet` adds options-native stats to the base tear sheet: **win rate, average credit
received, average days held, assignment count, P&L by structure, per-leg attribution, and a
strategy-level greek P&L attribution** (below). The base attribution is per-_symbol_ and ignores
settlements.

## Per-trade greek P&L explain (Wave 2 addition)

Every `OptionsTrade` carries a `pnlExplain: TradePnlExplain` — the trade's realized gross P&L decomposed
into greek contributions (the full second-order Taylor + dividend carry from `@totalfinance/risk`'s
`explainPositionPnl`, which now attributes higher-order automatically since `Position.value()` emits
extended greeks) plus an honest `unexplained` residual. It answers **"where did this trade's P&L come
from"** — delta (direction), theta (decay), gamma (convexity), vega (vol), etc.

```ts
type TradePnlExplain = Omit<PnlExplain, 'assumptions' | 'diagnostics'>; // bare terms + total + unexplained
interface OptionsTrade {
  /* … */ pnlExplain: TradePnlExplain;
}
```

- **`total === realizedPnl + costs`** (the gross, pre-cost P&L). `explainPositionPnl` returns the model
  mark-to-mark change; the day-0 **entry edge** (fill vs. model mark) is a model/data effect, so it is
  folded into `unexplained` — matching `explainPnl`'s "residual absorbs what the greeks don't explain."
- Because the current implementation marks each leg at its **constant entry implied volatility**
  with a fixed rate, realized P&L is spot-move + decay driven: **delta/gamma/theta** (with
  `charm`/higher-order siblings) carry most strategies, and
  **vega/rho are ~0** unless a leg prices off the position-level ATM vol (a `build` position without
  per-leg implied volatility). Current-implied-volatility re-marking (required before preview below)
  will make vega a live term.
- Guarded: an attribution that cannot be produced books the whole gross to `unexplained` rather than
  crashing the run — the sums invariant `Σterms + unexplained === total` always holds.

The tear sheet rolls these up into `greekAttribution: GreekAttribution` — the per-trade explains summed
term-wise across every trade, the strategy-level "P&L by greek." `total` is the summed gross P&L (net =
`total − options.totalCosts`).

## Honesty / envelope contract (the TotalFinance laws apply)

- No look-ahead: a snapshot only ever reads its own chain; fills at that snapshot's prices.
- No silent degradation: a requested entry that can't be built from the chain (no expiry in range, no
  strike at the target delta) emits a **typed diagnostic warning** and skips — never a fabricated
  fill. Assignment, margin, and marked-at-cost all disclose via `diagnostics.warnings`.
- Every result carries `assumptions` + `diagnostics`; `optionsBacktest` and `optionsTearSheet` are
  guarded (typed errors on garbage) and ship deep-sweep fixtures.
- Deterministic: seeded where any randomness enters (MC hedging/none in v1); no clock reads.

## Build checklist (sections, in dependency order)

1. **Types** — `ChainSnapshot`, `EntryRule`/`ExitRule`/`RollRule`/`DeltaHedgeRule`, contexts,
   `OptionsBacktestConfig`, `OptionsTrade`, `OptionsBacktestResult`, `OptionsBacktestAssumptions`.
2. **Chain access** — sort snapshots; per-snapshot helpers: list expiries, quotes-for-expiry, nearest
   expiry by DTE, delta/strike selection wrappers around `strategyFromChain`.
3. **Entry** — resolve expiry + build the position + size (fixed / margin) + cash accounting.
4. **Mark & greeks** — per-snapshot `Position.value` marking + portfolio greeks aggregation.
5. **Exit / roll** — trigger evaluation (profit/stop/DTE/callback), close accounting, roll re-entry.
6. **Settlement / assignment** — expiry intrinsic settlement + American early-assignment heuristic +
   `OptionSettlement` records.
7. **Delta hedge** (optional) — band check + underlying trade + hedge P&L.
8. **Engine** — the loop composing 2–7; equity curve; envelope assembly.
9. **Tear sheet** — `optionsTearSheet` extending the base with options stats + per-leg attribution.
10. **Public API + subpath export** — `@totalfinance/backtest/options`; package.json deps + exports; guards.
11. **Tests** — unit per section + 2–3 end-to-end golden scenarios (a credit spread program, an iron
    condor program, an assignment case) + deep-sweep fixtures; full CI green.

## Portfolio-grade completion required by FC8 before the stable core freeze

- **Current-implied-volatility re-marking.** The current implementation marks each leg at its
  **entry** implied volatility (via `Position.value`)—taken from the chain quote, implied from the
  entry-source premium when the chain states no implied volatility, or filled from the snapshot's
  at-the-money implied volatility as a last resort. P&L therefore holds per-leg volatility constant
  and is **exact at expiry** (intrinsic). Re-marking each leg from its current contract quote,
  capturing vega P&L from volatility expansion/contraction, is the pre-preview requirement.
- Multiple concurrent positions / a portfolio of overlapping structures (the current implementation
  runs one position at a time; the types leave room to generalize to a position book).
- Intraday chains (the current implementation is EOD-snapshot-oriented; the loop is
  snapshot-agnostic so intraday works if fed, but is not yet a tested contract).
- Provider-fed chains (arrives with the data layer's `optionChainSeries`; the engine already takes an
  `Iterable<ChainSnapshot>`, so it's a zero-change integration later). This is the one item here that
  remains data-layer work rather than FC8 compute work.
- Calendars/diagonals in the declarative entry (currently excluded from the `structure` union — use the
  `entry.build` escape hatch; the engine settles a multi-expiry position when its nearest leg expires).

### Pre-preview truthfulness gate

The public preview may not present `optionsBacktest` as production-ready while a changing market
volatility is silently held at entry volatility. Before the preview cutover, a focused amendment to
this contract had to be reviewed and implemented with these settled outcomes (the amendment is
**Preview P1** below — accepted 2026-09-03, landed @ `db2df2451`; every row is ticked):

- [x] An open leg is re-marked from the exact current-snapshot contract quote; a valid current implied
      volatility is used directly, or derived from that current quote's selected price when absent.
- [x] Expiry remains intrinsic and does not require an implied volatility.
- [x] A missing, stale, ambiguous, or unpriceable current contract never silently falls back to entry
      volatility—the request's explicit missing-mark policy either produces a typed failure/incomplete
      observation or chooses a named fallback.
- [x] `OptionsBacktestAssumptions` identifies the marking and missing-mark policies, while trade/run
      diagnostics preserve mark-source and fallback evidence.
- [x] A deterministic fixture with unchanged spot/time and changed implied volatility proves the exact
      direct-pricer vega P&L, and a missing-current-quote fixture proves there is no plausible silent
      number.
- [x] The function remains `optionsBacktest`; no versioned identity, compatibility alias, or
      public-version fork is introduced.

This truthfulness slice is a preview blocker. Overlapping books, portfolio margin/risk, richer order
execution, intraday support, corporate actions, and first-class multi-expiry entries remain in the
larger FC8 portfolio-grade completion after the preview.

## Preview P1 amendment — marking truthfulness (accepted 2026-09-03)

**Status: COMPLETE @ `db2df2451` (2026-09-03).** Landed as one commit with the strategy and risk additions, the six fixtures, the manifest notes, the regenerated ledgers, full CI, `api:check`, and the packed consumers green. The queue row was Preview P1 in
[`implementation-order.md`](../implementation-order.md); the tracker row is in
[`finance-portfolio-backtesting-completeness.md`](./finance-portfolio-backtesting-completeness.md).
The function remains `optionsBacktest`; every change below is an additive option, an additive
report member, or a registered code — no versioned identity, alias, or fork.

### Decision M1 — the marking policy

`OptionsBacktestConfig` gains one optional, closed member:

```ts
interface MarkingPolicy {
  /**
   * Where an open leg's volatility comes from at every snapshot. `'current-quote'` (DEFAULT) re-marks
   * the leg from the exact current-snapshot contract quote; `'entry'` holds the leg's entry
   * volatility for the whole trade (the pre-P1 behaviour, now explicit and disclosed).
   */
  volatility?: 'current-quote' | 'entry';
  /**
   * What happens when the current contract cannot mark a leg under `'current-quote'`:
   * `'refuse'` (DEFAULT) throws `backtest.mark_unavailable` naming the leg, the snapshot, and the
   * cause; `'entry-volatility'` marks THAT leg at its entry volatility for THAT snapshot and records
   * the fallback; `'carry-last-volatility'` holds the leg's last successful mark value (no repricing) and
   * records it as an incomplete observation. Never a silent number.
   */
  missingMark?: 'refuse' | 'entry-volatility' | 'carry-last-volatility';
  /**
   * A current quote whose `timestampMs` is older than the snapshot's `asOf` by more than this is
   * STALE and cannot mark (it falls to `missingMark`). Omitted ⇒ every quote a snapshot carries is
   * current by definition of the snapshot (the feed's own contract).
   */
  maximumQuoteAgeMs?: number;
}
config.marking?: MarkingPolicy;
```

**The current-quote mark, per open option leg, per snapshot.** The leg's contract is matched
against the snapshot's quotes on exact `(type, strike, expiry)` (a leg without its own `expiry`
matches the position-level expiry it prices at). Then, in order:

1. exactly one match carrying a finite `impliedVolatility > 0` ⇒ the leg prices at it — mark
   source `'current-quote'`;
2. exactly one match without a usable implied volatility but with a price under the request's
   `priceSource` (`entry.price`, default `'mid'`) ⇒ the implied volatility is derived from that
   current price with the same Black–Scholes inversion the entry enrichment uses (spot = the
   snapshot's `underlyingPrice`, the snapshot's `asOf`, the request's rate and dividend yield);
   a converged positive solve prices the leg — mark source `'implied-from-price'`;
3. otherwise the leg has no current mark, with the cause `'missing'` (no match),
   `'ambiguous'` (more than one match), `'stale'` (`maximumQuoteAgeMs` exceeded), or
   `'unpriceable'` (no usable price, or the inversion did not converge / the price sits below
   intrinsic) ⇒ `missingMark` decides.

Expiry stays intrinsic and needs no volatility (unchanged): a leg on or past its expiry DATE
settles on that snapshot under the engine's trader-standard days-to-expiry law, so no current quote
is looked up for it — an expiring contract is routinely absent from an expiry-day chain — and the
pre-settlement mark of such a leg (never booked; settlement books intrinsic at the expiry instant)
prices at the leg's own or the snapshot's at-the-money volatility. A stock leg (a delta hedge, a
`build` position's shares) marks at spot (unchanged). Under `volatility: 'entry'` no lookup
happens and every mark source is `'entry-volatility'` by policy. The entry mark is unchanged
(the entry-source premium is the fill; the leg's entry volatility is the chain's or is implied
from that premium). A `build` position's leg without a per-leg entry volatility falls under the
same lookup at every snapshot; the position-level at-the-money fallback is removed for
`'current-quote'` (it was a plausible silent number) and stays, disclosed, for `'entry'` only.

**Why these defaults.** `'current-quote'` is the truthful default (the preview blocker is
exactly the silent hold); `'refuse'` is the truthful missing-mark default (lovability rule: a
missing observation is a typed failure, never a guess). The two fallbacks exist because real
feeds drop contracts; each is named, per-leg, per-snapshot, and evidenced. `'entry'` exists so a
caller can reproduce a pre-P1 run and so a synthetic constant-volatility chain can prove the
two policies agree exactly when the market does not move.

### Decision M2 — per-leg volatility in the mark and in the P&L explain (direct-API additions)

The strategy mark-to-market and the risk P&L explain each gain one additive option so that a
per-leg volatility CHANGE is priced and attributed rather than assumed away:

| Direct API                             | Addition                                                                                                                                                                                                                                                                                                                                                       | Law                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Position.value` (`MarkToMarketInput`) | `legVolatilities?: readonly (number \| undefined)[]`, aligned to `position.legs`: leg `i` prices at `legVolatilities[i]` when defined, else at its own `impliedVolatility`, else at the position-level `volatility` (`volatilityShock` still adds on top). `assumptions.volatilitySource` gains the value `'per-call'` when any override applied.              | additive, optional, validated (length = legs, finite > 0)                    |
| `explainPositionPnl` (`PnlMarket`)     | `legVolatilities?: readonly (number \| undefined)[]` on `from` and/or `to`: the marks pass the overrides through to `value`, and each leg's vol move is `to − from` at the LEG level (a leg with a fixed `impliedVolatility` and no override keeps `dVolatility = 0`, as today). `assumptions.volatilityAttribution: 'position-level' \| 'per-leg'` is echoed. | additive, optional; the sums invariant `Σ terms + unexplained = total` holds |

The backtest's per-trade `pnlExplain` therefore attributes a live `vega` (and `vanna`/`vomma`/
`veta`) from each leg's entry volatility to its exit volatility under `'current-quote'`; under
`'entry'` those terms stay ~0 as documented today. No other direct API changes.

### Decision M3 — assumptions and evidence

- `OptionsBacktestAssumptions.marking: { volatility, missingMark, maximumQuoteAgeMs: number | null }`
  — the applied policy, always present.
- `OptionsTrade.marks: { snapshots: number; currentQuote: number; impliedFromPrice: number;
entryVolatility: number; carried: number }` — how many leg-snapshot marks came from each source
  over the trade (`entryVolatility` counts the `'entry'` policy AND the `'entry-volatility'`
  fallback; `carried` counts `'carry-last-volatility'`), so a reader sees at a glance whether a trade's
  P&L is quote-driven.
- `OptionsTrade.exitVolatilities: (number | null)[]` aligned to `legs` — the volatility each leg
  was last marked at (`null` for a stock leg or a leg priced at intrinsic — expired or settled).
- Run diagnostics: one `backtest.mark_fallback` warning per (trade, cause) with the count of
  leg-snapshots it covered (bounded — never one warning per snapshot), severity `'warn'`; the
  existing `backtest.entry_skipped` / `backtest.assignment` are unchanged.
- Registered codes: error `backtest.mark_unavailable` (core `ErrorCode.BacktestMarkUnavailable`),
  warning `backtest.mark_fallback` (core `WarningCode.BacktestMarkFallback`).

### Decision M4 — what does not change

The event loop's order (mark → settle → exit/roll → entry → hedge → equity point), the entry
fill and its enrichment, expiry settlement at intrinsic, sizing, margin, hedging, the tear sheet's
statistics, the result envelope's other members, and every existing test expectation on the
synthetic constant-volatility chains (under which `'current-quote'` and `'entry'` mark identically
— the parity the fixtures below assert).

### Fixtures (the gate's evidence, each a test)

1. **Exact direct-pricer vega.** Two snapshots at the same `asOf` and spot, implied volatility
   0.20 then 0.25 on every quote: the open spread's mark change equals Σ leg `quantity × multiplier
× (BS(σ = 0.25) − BS(σ = 0.20))` from `blackScholesPrice` to 1e-9; the trade's `pnlExplain.vega`
   is nonzero and the explain sums; `marks.currentQuote` counts every leg-snapshot.
2. **Parity.** On the constant-volatility golden chains, `'current-quote'` and `'entry'` produce
   byte-identical equity curves and trades (except `assumptions.marking` and the `marks` counts).
3. **Missing contract.** The short leg's contract is absent from the second snapshot: the default
   refuses with `backtest.mark_unavailable` naming the leg, the snapshot, and `'missing'`;
   `'entry-volatility'` runs, marks that leg at its entry volatility for that snapshot, emits one
   `backtest.mark_fallback` warning with the count, and `marks.entryVolatility === 1`;
   `'carry-last-volatility'` holds the last marked volatility and `marks.carried === 1`.
4. **Ambiguous, stale, unpriceable.** A duplicated contract row ⇒ `'ambiguous'`; a quote older
   than `maximumQuoteAgeMs` ⇒ `'stale'`; a price below intrinsic (no implied volatility stated) ⇒
   `'unpriceable'` — each refuses by default with its cause in the message and context.
5. **Delta-only feed.** A chain with no stated implied volatilities re-marks from the current
   prices (`'implied-from-price'`), and a price-driven volatility change moves the mark.
6. **Identity.** `optionsBacktest` is the only export touched; no alias exists (the manifest
   diff is the proof).

### Review record (self-review against the laws, 2026-09-03)

| Finding                                                                               | Resolution                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A silent default would re-introduce the hold at entry volatility                      | `'refuse'` is the default; both fallbacks are named, per-leg, and evidenced (M1)                        |
| A position-level ATM fallback is a plausible silent number                            | removed under `'current-quote'`; kept only under `'entry'` and disclosed (M1)                           |
| `explainPositionPnl` attributes zero vol move to fixed-IV legs, so vega would stay ~0 | per-leg volatility overrides on `PnlMarket`/`MarkToMarketInput` (M2)                                    |
| One warning per snapshot would flood a long run                                       | one warning per (trade, cause) carrying the count (M3)                                                  |
| "Stale" needs a caller-stated threshold, not a library guess                          | `maximumQuoteAgeMs`, omitted ⇒ the snapshot's own contract (M1)                                         |
| Existing golden tests must not move                                                   | parity fixture 2; the constant-volatility chains mark identically under both policies (M4)              |
| Every new request member must be closed and typed at the door                         | `marking` rides the generated `validateClosedRequest` spec (roster row unchanged; the spec regenerates) |

### Preview P1 checklist (ticked at landing)

- [x] `MarkToMarketInput.legVolatilities` and `PnlMarket.legVolatilities` land with tests in
      their own packages (strategy, risk) — additive, validated, echoed.
- [x] `optionsBacktest` marks every open option leg per M1 with the default policy, discloses per
      M3, and refuses per `'refuse'` with the registered code.
- [x] The six fixtures pass; the existing options-backtest suite passes unchanged.
- [x] Manifest notes, the generated validation spec, codes, README example, and the trackers are
      updated; full CI, `api:check`, and the packed consumers are green at one commit.

## Stage 4.6 amendment — the position book (FC8 Decision 5, 2026-09-04)

The single open slot is a book. Nothing about an existing request changes: one rule and the default
`book.maximumOpenPositions: 1` run exactly the shipped engine, now with the portfolio ledger the
equity reconciles to.

- **Rules.** `entry` is one rule, `rules` several (exactly one is given); each may carry an `id`
  (default `rule-<index>`). `when: 'flat'` means the RULE has no open trade; `'always'` enters whenever the book has room; a predicate
  sees `openTrades`. Rules enter in order at each snapshot after every open trade has been marked,
  settled, rolled, or exited.
- **The book.** `book.maximumOpenPositions` (default 1, at most 10,000 —
  `backtest.book_too_large`) and `book.maximumPerUnderlying`.
- **Limits are pre-trade gates on the post-trade book**, through `optionsMargin`, the aggregated
  greeks, and `scenarioGrid`: `maximumMarginFraction`, `maximumNetDelta`, `maximumNetVega`,
  `maximumConcentration` (premium at risk in one underlying), `scenarioLoss` (the worst Taylor P&L
  over the shock grid). A breach is a `limitRejections` row naming the limit, the value, and the
  bound (`backtest.limit_rejected`); nothing is scaled.
- **Fills.** `fillPolicy.mode: 'combo'` (default) fills every leg or rejects the entry with a
  `fillRejections` row (`backtest.combo_leg_unfilled`); `'legged'` fills legs in order and, under
  `partialFill: 'allow'`, holds the filled legs (the trade is `partial` and names its
  `unfilledLegs`). `quoteFreshness.maximumQuoteAgeMs` refuses a stale fill exactly as marking refuses
  a stale mark.
- **Calendars and diagonals** are first-class structures (`calendarCallSpread`, `calendarPutSpread`,
  `diagonalCallSpread`, `diagonalPutSpread`, `doubleDiagonal`) selected by `shortDelta` on the near
  expiry and `nearDaysToExpiry` / `farDaysToExpiry` (+ `width` for diagonals). Every leg settles at
  its own expiry (`legSettlements`); the trade closes when no leg remains.
- **Corporate actions.** Splits and reverse splits adjust every open leg's strike and multiplier
  OCC-style with `lineage`; the ledger sees `derivative.multiplier-change`. Symbol changes rename
  with lineage. A merger or spin-off on an open leg refuses (`backtest.unsupported_corporate_action`).
- **Dividends.** Every open short call before an ex-date carries `dividendRisk` evidence in the
  snapshot's `surface` row; under `assignment: 'model'` an at-risk short call is assigned early
  (`early: true, reason: 'dividend'`), and a deep-in-the-money short put whose extrinsic value is
  below its carry is assigned early (`reason: 'deep-itm'`). `assignment: 'none'` (default) settles at
  expiry only.
- **The surface.** One row per snapshot: the at-the-money volatility per expiry, the 25-delta skew of
  the nearest expiry, this snapshot's mark sources, and the dividend-risk rows.
- **The ledger.** Every fill, hedge trade, settlement, and adjustment is a portfolio event
  (`result.ledger`, `result.timeline`); the equity at every mark equals the ledger's NAV within 1e-6 or
  the run refuses (`backtest.ledger_reconciliation_failed`). `runId` is the request's content hash.
