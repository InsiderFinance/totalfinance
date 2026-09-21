# FC7 slices 1–5 — the durable portfolio ledger foundation, the through-time reports, the repair/reconciliation flow, policy-driven management, and the lifecycle families

Status: slices 1–5 are `COMPLETE` (reviewed 2026-08-28/29). The final review closeout is
`a6f9842b`: every FC7 required API, hostile-input boundary, lifecycle family, packed fixture, and
exit-gate law is closed. FC7 is the durable-portfolio portion of Platform Stage 4.4 (`4.4a`); the
separate shared-scenario runner is now `4.4b` and is specified in
[`shared-scenario-runner.md`](./shared-scenario-runner.md).
This document records what the slice implements, what it defers, and the already-decided direction
each choice follows. FC7's direction is settled by two documents and is NOT re-decided here:

- [`finance-portfolio-backtesting-completeness.md`](./finance-portfolio-backtesting-completeness.md)
  §FC7 — the required APIs, mandatory economic state, and the portfolio exit gate;
- [`agent-native-portfolio-and-trading-platform.md`](../agent-native-portfolio-and-trading-platform.md)
  — the accepted ledger, economic-event, P&L-reconciliation, replay, and package-boundary contract
  ("Durable portfolio ledger", "Permanent laws", "Package and dependency posture", AT1).

Every section below cites the decision it executes.

## What this slice implements

### 1. The package: `@totalfinance/portfolio` (D5; agent-native "Package and dependency posture")

A new browser-safe, event-derived economic-state package. Runtime dependencies are exactly the FC0
pre-declared row in `tools/package-graph.test.ts`: `@totalfinance/core` and `@totalfinance/performance` —
never `@totalfinance/risk` (both forbidden directions are named there). Layer: **L4** in
`tools/layer-model.test.ts` (a composition deriving one coherent state and composing the
performance domain API; the same shelf as risk/strategy/backtest).

Subpaths land only with real code (FC0 no-empty-barrel rule): this slice ships `.`, `./events`,
`./ledger`, `./performance`. The required `./policy` and `./reconciliation` subpaths
(spec "Package roots and subpaths") arrive with the rebalance/monitoring and reconciliation slices.

### 2. The economic-event grammar (`./events`; agent-native "Economic event model", D15/D16)

A closed discriminated union with per-variant closed key sets and teaching validation
(`requirePortfolioEventEnvelope`). The variants cover the families this slice folds COMPLETELY:

| Family (doc table row) | This slice's variants                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Cash                   | `cash.deposit`, `cash.withdrawal`, `cash.transfer`, `cash.conversion`                             |
| Trading                | `trade.fill`                                                                                      |
| Costs                  | `cost.charge` (`commission` \| `exchange-fee` \| `regulatory-fee` \| `slippage-adjustment`)       |
| Income                 | `income.received` (`dividend` \| `coupon` \| `interest` \| `staking-reward` \| `funding-receipt`) |
| Financing              | `financing.charge` (`margin-interest` \| `borrow-charge` \| `funding-payment`)                    |
| Corporate actions      | `corporate.split`                                                                                 |

The doc's event LIST inside each family is encoded as a closed literal field (`costType`,
`incomeType`, `financingType`) rather than one variant per list entry — same closed grammar,
smaller union. Costs are separate events with explicit attribution (`instrumentId?`,
`relatesToEventId?`), never folded into lot cost basis, exactly as the FC7 mandatory-state bullet
requires ("commissions, exchange/regulatory fees, slippage adjustments … as separate components").

The envelope is the agent-native doc's decided `PortfolioEventEnvelope` verbatim (eventId,
schemaVersion, eventType, sourceId, accountId, effectiveTimestampMs, recordedTimestampMs,
correlationId?, causationId?, reversesEventId?, event, provenance) with two first-slice notes:

- it is non-generic in this slice (`event: PortfolioEvent`); the generic refinement
  `PortfolioEventEnvelope<Event>` is a compatible later widening;
- both timestamps are caller-supplied; the package never reads the system clock (envelope law).

**The duplicate boundary** is `(sourceId, eventId)` (agent-native "Event envelope"): replaying an
identical event is a **no-op**; a same-key event whose body differs is a **typed conflict**
(`portfolio.duplicate_event_conflict`). Body identity is `portfolioEventContentHash` — the
canonical-JSON SHA-256 of the envelope EXCLUDING `provenance`, following Gate B's decided rule
that provenance is outside every identity (gate-b-artifact-spine.md, Decision 3).

### 3. The reducer and derived state (root `applyPortfolioEvents`; Law 1, D16, AT1)

"Portfolio truth is event-derived" (agent-native Permanent law 1): `PortfolioState` is a pure fold
over envelopes. `applyPortfolioEvents({ portfolio | previousState, events })` accepts exactly one
of a fresh `PortfolioDefinition` or a prior state (both decided first-touch shapes — the spec's
`{ previousState, events }` and the agent-native doc's `{ portfolio: { baseCurrency }, events }`),
and returns a new deeply-frozen state. Derived per account (agent-native "Derived state and
reports" — the fold-time subset):

- cash by currency (`totalAmount` plus a `settlementSchedule` of dated cash legs — the
  settled/unsettled SPLIT is classified at an explicit `asOf` by `portfolioSnapshot`, so the fold
  stays clock-free);
- positions and signed fractional lots (long lots positive, short lots negative), one trading
  currency per open position (a mixed-currency position refuses with teaching);
- realized P&L from lot relief, and income / transaction-cost / financing accumulators by
  currency. Unrealized P&L, NAV, and FX P&L are snapshot-time derivations (Law 2: "P&L is a
  derived result, not a ledger event").

**Lot relief** is the doc's decided set (`'fifo' | 'lifo' | 'highest-cost' | 'specific-lot'`,
agent-native "Initial accounting scope"), defaulting to `'fifo'` — documented here and echoed in
`state.lotRelief` and the ledger envelope ("the selected policy echoed in artifacts").
`'highest-cost'` relieves lots by descending `costBasisPerUnit` (ties: earlier lot first) for long
and short lots alike; `'specific-lot'` requires `lotSelections` naming existing lots whose
quantities sum exactly to the relieved quantity (1e-9 tolerance), and refuses `lotSelections`
under any other policy or on a pure open (no silently ignored fields).

**Ordering:** events fold in array order and must be non-decreasing in `effectiveTimestampMs`
(ties keep array order); an out-of-order batch refuses with teaching. Out-of-order ingestion /
as-recorded bitemporality is deferred (see below).

### 4. Serialization through the Gate B spine (`./ledger`; gate-b-artifact-spine.md Decisions 2, 3, 7)

`createPortfolioLedger` is the immutable reusable artifact of the decided API ladder;
`ledger.apply(moreEvents)` returns a NEW ledger, `ledger.toJSON()` returns the versioned envelope
`PortfolioLedgerSnapshot` (`kind: 'totalfinance.portfolio-ledger'`, `schemaVersion: 1`). The envelope
rides the spine, not a second invention:

- canonical form and identity via `canonicalJsonOf` / `contentHash` from
  `@totalfinance/core/artifacts`;
- **the envelope stores EVENTS, never derived state** — a ledger is a fold over its events, so
  serializing state would create a second truth; `readPortfolioLedgerSnapshot` re-folds (replay);
- create/read symmetry mirrors `readMarketSnapshot` exactly: closed envelope keys, kind check,
  newer-version refusal, older versions only through an explicitly registered
  `createArtifactMigrationRegistry` chain (the registry is an ARGUMENT, never module-global),
  full body re-validation, frozen canonical copy, and a `migrationsApplied` report;
- `portfolioLedgerContentHash` covers kind, schemaVersion, portfolioId, baseCurrency, lotRelief,
  and the events with their `provenance` fields excluded; ledger- and event-level provenance are
  outside identity (Gate B Decision 3: two vendors delivering identical facts are the same
  ledger). It validates through the read path before hashing (the Gate B serial-landing lesson:
  a malformed envelope must never acquire a confident-looking hash).

### 5. Valuation snapshot (root `portfolioSnapshot`; FC7 required API; Law 2)

`portfolioSnapshot({ portfolio, asOf, market, currencyConversions? })` values a state against an
explicit Gate B `MarketSnapshot` (validated through `readMarketSnapshot` — one validator) at an
explicit `asOf`:

- position marks come from `market.observations.spots[instrumentId]`; a held instrument without a
  spot, or a spot whose stated `currency` differs from the position's trading currency, is a typed
  failure (`portfolio.mark_unavailable` / teaching error) — unavailable marks never guess;
- multi-currency cash and position values convert to base currency through explicit
  `CurrencyPairQuote`s — **FC5's vocabulary and arithmetic** (`quotePerBase`; direct = multiply,
  inverted = divide), reused structurally because the FC0 graph row forbids a runtime
  `portfolio → foreign-exchange` edge. Parity is proven two ways in tests: compile-time mutual
  assignability with `@totalfinance/foreign-exchange`'s `CurrencyPairQuote`, and runtime equality with
  `convertCurrency` on the same quotes (the Gate B "spine defines the grammar, owner stays
  structurally identical" precedent for core↔risk `Shock`). A missing or ambiguous
  (duplicate-pair) quote refuses;
- cash splits into settled / unsettled-receivable / unsettled-payable by comparing each
  `settlementSchedule` leg to `asOf` (FC7 mandatory state: "settled, unsettled, receivable,
  payable … where supplied");
- NAV = cash base value + position base value (a tested conservation identity), unrealized P&L is
  reported per position in trading and base currency, `market.asOf ≠ asOf` is a disclosed warning,
  and the result carries the Law-2 floor (`assumptions.conventionsVersion`,
  `diagnostics.warnings`) so it is artifact-saveable through `createAnalysisArtifact`.

### 6. The P&L reconciliation seam (`./performance`; FC4 reuse; FC8 acceptance hook)

`portfolioPerformanceInputs({ ledger, valuationMarks })` derives the EXACT series
`@totalfinance/performance`'s flow-aware calls consume — the output types ARE FC4's
`PortfolioValuation` / `ExternalCashFlow`, imported from `@totalfinance/performance`, not copied:

- each mark folds the ledger prefix `effectiveTimestampMs < 00:00 UTC of valuationDate` and
  values it via `portfolioSnapshot` — the mark lands BEFORE any same-day flow, matching FC4's
  stated flow convention ("a valuation dated D marks the portfolio BEFORE any external flow dated
  D lands");
- external flows are deposits (+) and withdrawals (−) only; internal transfers and currency
  conversions are never external flows (agent-native "Performance through time": "Transfers and
  contributions remain external flows rather than trading gains" — and a transfer between two
  accounts of the SAME ledger crosses no portfolio boundary); non-base-currency flows convert at
  the same-date mark's quotes and refuse when no such quote exists; flows outside the mark window
  are excluded and counted, with a warning;
- the FC8 hook is proven now, as a test: ledger-derived series fed to `timeWeightedReturn` and
  `moneyWeightedReturn` produce results deep-equal to the same FC4 calls on hand-built series
  ("TWR/MWR consume the exact ledger flows and marks and match FC4 direct calls" — FC7 exit
  gate). The ledger FEEDS FC4; it re-implements nothing (Permanent law "No second engine").

## Acceptance laws closed by this slice (FC7 "Portfolio exit gate")

- [x] **Replay determinism** — same events → same state (fold purity; create → serialize → read
      → re-fold deep-equal, content hash identical); **idempotent** for duplicate
      `(sourceId, eventId)` (no-op, tested); **conflict-detecting** for changed payloads (typed
      `portfolio.duplicate_event_conflict`, tested).
- [x] **Golden journey reconciliation (implemented families)** — a hand-computed journey
      (deposits, fills long/short across all four relief policies, costs, income, financing,
      split, transfer, conversion, settlement) reconciles cash, quantities, lots, cost basis,
      realized P&L, and NAV at each step (1e-9/1e-12).
- [x] **Conservation identities** — position quantity ≡ Σ lot quantities; relieved + remaining
      basis ≡ acquired basis; internal transfers net to zero and never appear as flows; snapshot
      NAV ≡ cash base value + position base value; split preserves total basis and scales
      quantity exactly.
- [x] **TWR/MWR seam** — ledger-derived flows and marks match FC4 direct calls exactly (the FC8
      hook, closed early).
- [x] **Serialization/migration/replay without a database** — Node/vitest fixtures round-trip the
      envelope through canonical JSON; newer version refuses; older version requires a registered
      migration and reports each applied step.
- [x] **`analyzeBook` untouched** — `@totalfinance/risk` is not modified and portfolio does not
      import it (graph law re-run green).

## Initial deferrals (status updated after slices 2–5)

| Deferred                                                                                                                             | Decision it follows                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Derivative lifecycle events (exercise/assignment/expiration, physical/cash settlement, multiplier changes) — LANDED in slice 5       | FC7 mandatory state; agent-native "Derivative lifecycle" family                |
| Corporate actions beyond splits (merger, spin-off, symbol change, return of capital, cash-in-lieu) — LANDED in slice 5               | agent-native "Corporate actions" family                                        |
| Corrections/reversals (`admin.*`; `reversesEventId` repair flow) — LANDED in slice 3 (below)                                         | Law 1 "explicit correction/reversal relationship"                              |
| `portfolioTimeline`, `portfolioPnl` — LANDED in slice 2 (below)                                                                      | FC7 required APIs; agent-native "Derived state and reports" P&L identity       |
| `reconcilePortfolio`, `./reconciliation` — LANDED in slice 3 (below)                                                                 | agent-native "Reconciliation"                                                  |
| `createModelPortfolio`, `allocatePortfolio`, `proposePortfolioRebalance`, `monitorPortfolio`, `./policy` — LANDED in slice 4 (below) | FC7 "Portfolio-side management"; agent-native "Portfolio management workflows" |
| `estimateExpectedReturns` / `efficientFrontier` — LANDED in slice 4 (below), in `@totalfinance/risk`                                 | FC7 "Risk-side portfolio construction"                                         |
| Scenario runner over books — COMPLETE @ `3095cf91` as Platform Stage 4.4b                                                            | Gate D; evidence in [`shared-scenario-runner.md`](./shared-scenario-runner.md) |
| Out-of-order/bitemporal ingestion; storage interfaces; provider/broker anything                                                      | agent-native "Runtime/transport edge", data layer — Stages 6–7                 |
| Futures variation margin, fixed-income accrual, and crypto funding mechanics — LANDED in slice 5                                     | FC7 mandatory state                                                            |
| Netting/grouping beyond per-account/per-instrument — LANDED in slice 2 (below)                                                       | FC7 grouping bullet — with `portfolioTimeline`/`portfolioPnl`                  |

## Serial landing (2026-08-28) — what the landing added to the draft

The draft wired only the root `tsconfig` paths/reference, the vitest aliases, the L4 layer row,
and a tier-only manifest. The landing closed every serial-landing debt and, by enrolling the
package in every repo gate on day one, found and fixed six boundary defects the draft's own 79
tests could not see:

- **Registration:** `MANIFEST_TIERS` (facade), hand-curated Manifest Law 1 rows for all 14
  runtime exports, the garbage/deep/magnitude/count-safety sweep rosters, the api-report package
  list, the umbrella (`totalfinance.portfolio` namespace + `totalfinance/portfolio` subpath — D20: no root
  hoist), the 19th domain in the frozen-hoist law, a measured bundle budget (22.4 KB gzip; 23 KB
  budget), and the generated README/llms docs.
- **Fixtures:** one hand-computed journey feeds every head (`tools/first-touch/fixtures/portfolio.ts`),
  including the 3-positional `requirePortfolioEventEnvelope` guard.
- **Law 7 (finite results):** `applyPortfolioEvents`, `portfolioSnapshot`, and
  `portfolioPerformanceInputs` finish through `requireRepresentableResult` — a fold, valuation, or
  series whose numbers leave IEEE-754 range refuses with the input-driven teaching (the magnitude
  mutant convicted all three at near-`MAX_VALUE` fills, deposits, and marks).
- **Envelope timestamps** are integer epoch milliseconds within the range `Date` represents
  (±8.64e15); a tampered ledger reached `toISOString()` as a raw RangeError through the seam.
- **Value objects are re-validated at every door:** the performance seam re-runs the closed
  envelope validator over `ledger.events`; `duplicateBoundaryKey` runs the full validator (a
  decorated or malformed envelope teaches, never a raw TypeError).
- **Restored state must agree with itself:** `eventCount` must equal the applied-event registry
  size; `eventCount`/`lotSequence`, split share counts, and stored schema versions are SAFE
  integers (a counter past 2^53 could never advance — corrupt state, not a big number).
- **Predicate policy:** `isPortfolioLedgerSnapshot` declares its argument `open` — a predicate
  answers false for anything malformed; the closed-key law lives on `readPortfolioLedgerSnapshot`.
- **Role honesty:** `applyPortfolioEvents` is classified `artifact` (a deeply-frozen,
  schema-versioned state object) rather than `facade` — it carries no assumptions/diagnostics by
  design (Law 2: valuation and P&L are derived reports), so a `.explain` twin would explain a
  state, not a number.
- **The TWR seam figure** was re-derived under FC4's corrected mark-first convention
  (`end / (start + flow) − 1`); the draft's hand figure encoded the pre-correction form the
  2026-08-23 review wave removed. The ledger-vs-hand identity held throughout — this pins the law.

## Slice 2 (landed 2026-08-28) — `portfolioPnl`, `portfolioTimeline`, grouping

Executes the agent-native "Derived state and reports" and "Performance through time" decisions
and the FC7 required-API rows for `portfolioTimeline` and `portfolioPnl`.

### The P&L identity, held exactly

`portfolioPnl({ ledger, from, to, instrumentClassification? })` reports the doc's identity verbatim
and it holds **by construction of the fold**, not by fitting:

```text
ending NAV − beginning NAV − external flows
  = realized P&L + unrealized P&L + income − transaction costs − financing
  + foreign-exchange P&L + explicitly unexplained residual
```

Convention (stated in `assumptions.identity` / `assumptions.conversionConvention`): every
local-currency component over the window converts to base at the CLOSING mark's quote;
foreign-exchange P&L is the translation of each non-base currency's opening value by the quote
change plus every `cash.conversion` valued at closing quotes (received − given). Algebraically
`ΔNAV = Σ_c ΔL_c·q_end,c + Σ_c L_begin,c·(q_end,c − q_begin,c)`, and each currency's local change
is exactly the sum of its booked components, so the residual is float rounding — tested to 1e-9
on a hand-computed multi-currency journey (deposits in two currencies, buys, a partial sale,
dividend, margin interest, a USD→EUR conversion, a withdrawal, an unattributed fee, and a 5%
currency move). A larger residual is disclosed with a warning, never absorbed.

`byCurrency` exposes the per-currency ledger behind the figures (opening/closing local value,
each component in local units, the conversion net, and the translation effect in base).

### Grouping that reconciles

The fold now attributes realized P&L, income, and costs **per instrument** (`AccountState.
realizedPnlByInstrument` / `incomeByInstrument` / `transactionCostsByInstrument`, state schema
version 2; these survive a position closing). `portfolioPnl` groups the instrument-attributable
components by position, instrument, account, currency, underlying, asset class, strategy, and
tag — the caller supplies `instrumentClassification` (`underlying? assetClass? strategy? tags?`);
unknown instruments group as `unclassified`. Whatever no instrument owns (account-level costs,
financing, foreign exchange) lands in an explicit `unattributed` row, so every partitioning
dimension reconciles to the total (`reconciliationResidual` 0 within 1e-9, tested). Tags overlap
by nature; that grouping is emitted with `reconciles: false` and the reason.

### The timeline composes FC4 — no second engine

`portfolioTimeline({ ledger, valuationMarks, instrumentClassification? })` reports, at each mark:
NAV, cash and positions in base, exposure (long / short / gross / net / gross leverage) and
exposure by every grouping dimension, external flows since the prior mark, and the
`portfolioPnl` kernel over the step. The step totals telescope to the whole window's investment
return exactly (tested); components telescope within one currency, and across currencies the
component-versus-FX split is path-dependent (each step translates at its own closing quote) —
stated, not hidden. The return index is `@totalfinance/performance`'s `portfolioReturnIndex` (base
1, geometric linking, flows at-flow-timestamp) over the exact series `portfolioPerformanceInputs`
emits, and drawdown is `underwater()` over that index — flow-adjusted, so a withdrawal is never
mistaken for a loss. A flow date with no mark withholds the index with FC4's reason (`gaps` are
published); a mark that cannot value the book is a typed failure, never a forward-fill.

The ledger artifact gained `ledger.pnl(...)` and `ledger.timeline(...)` (the API ladder's
`nextLedger.pnl`), delegating to the free functions. ONE mark grammar and ONE window builder
(`marks.ts`, internal) now serve the seam, the P&L, and the timeline, so the three cannot
disagree about which events precede a mark.

### Acceptance laws this slice closes (FC7 "Portfolio exit gate")

- Every golden journey reconciles cash, quantities, lots, cost basis, NAV, **and P&L** at each
  mark — for the event families implemented at slice 2; slice 5 later closed the remaining
  lifecycle families and re-ran the same law over them.
- Snapshot/group totals reconcile by position, strategy, underlying, account, asset class,
  currency, and tag — P&L groupings and exposure groupings alike, with the overlap of tags
  disclosed.

## Slice 3 (landed 2026-08-28) — exact repair (`admin.*`) and `reconcilePortfolio`

Executes Law 1's "explicit correction/reversal relationship", the agent-native "Reconciliation"
family, the FC7 required-API row for `reconcilePortfolio` / `./reconciliation`, and the
mandatory-state line "correction/reversal links and reconciliation status". History is never
rewritten: a repair is one more applied fact that names the fact it repairs.

### The administration family — `admin.reversal`, `admin.correction`, `admin.account-migration`

- **Grammar.** `EconomicPortfolioEvent` names the nine economic families; `PortfolioEvent` is
  that union plus `admin.reversal { original, reason? }`, `admin.correction { original,
replacement, reason? }`, and `admin.account-migration { fromAccountId, toAccountId, reason? }`.
  A repair CARRIES the original envelope it repairs, so the record is self-describing without a
  registry lookup; the fold then proves the carried copy against the registry.
- **Link law (envelope).** `reversesEventId` is REQUIRED on a reversal/correction and must equal
  `original.eventId`; on any other family it is refused (`input.out_of_range`) — an economic event
  cannot reverse anything, its own effect stands. The carried original's `accountId` must equal
  the envelope's. A reversal may target any applied fact except a migration marker; a correction
  targets only an economic fact, and its `replacement` must itself be economic (it is validated as
  if it sat in the original's envelope). A migration names two DIFFERENT accounts.
- **Exact reversal, or a typed refusal.** Two new codes: `portfolio.reversal_target_missing` (the
  named fact was never applied) and `portfolio.reversal_infeasible`. Before anything moves, the
  carried `original` must content-hash identically to the registry's copy (a paraphrased or
  tampered original "hashes differently" — refused) and the fact must not already be reversed.
  The inverse is per family: deposits, withdrawals, transfers, conversions, costs, income, and
  financing un-book exactly, and the settlement legs a fact booked are removed by that fact's
  event id. A fill is un-booked from its recorded `fillEffects` (opened lot ids, relieved
  quantity, realized P&L) ONLY while those lots are intact: a buy whose lots were later relieved
  or rescaled, and a sell that relieved lots, refuse with the lots/quantities named (record a
  correcting fill instead); a split refuses (record a counter-split). `state.reversals` maps the
  reversed fact's duplicate-boundary key to its reverser's; the fill effect is dropped with the
  fact.
- **Corrections are atomic and time-faithful.** A correction reverses the original and folds the
  replacement AT THE ORIGINAL'S INSTANT under the correction's identity: lots opened by the
  replacement carry `openedByEventId` = the correction's id and `openedTimestampMs` = the
  original's, and its settlement legs are keyed by the correction. Later relief therefore sees
  the corrected basis (tested: 151 after a 150 → 151 price correction). The correction's own
  effective timestamp orders it in the fold; a correction that arrives after a later fact
  consumed the original meets the same infeasibility as a reversal would.
- **Repair of a repair.** Reversing a reversal or a correction re-applies the inner fact (the
  position returns at 100 @ 150 with cash 85,000) and the link table then names exactly the outer
  repair; correcting a repair is refused — correct the fact, not the repair.
- **Migration marker.** `admin.account-migration` records `{ eventId, fromAccountId,
toAccountId, effectiveTimestampMs }` in `state.accountMigrations` with NO economic effect: the
  marker is the continuity fact reports can follow, and balances move only through explicit
  `cash.transfer` facts (a position-transfer family is not in this build — deferred below).
- **State schema version 3** adds `fillEffects`, `reversals`, and `accountMigrations`; a restored
  state validates all three, and an older snapshot still requires a registered migration.

### Reconciliation — the ledger against the external record, differences explained or drafted

`reconcilePortfolio({ portfolio, external, asOf, tolerance, correctionSourceId? })` on
`./reconciliation` compares a derived state with an `ExternalPortfolioSnapshot` (`asOf`,
`source?`, per-account `cash: { CCY: { total, settled? } }` and `positions: [{ instrumentId,
quantity, currency?, costBasis? }]`) at an explicit instant.

- **Tolerances are explicit** (`quantity`, `cashAmount`, `costBasis?` defaulting to
  `cashAmount`) — no hidden epsilon; `asOf` is required because settled versus unsettled cash is
  classified at that instant (a leg with `settleTimestampMs ≤ asOf` is settled).
- **Report.** Every account either side knows (an account only one side reports is a difference
  in itself), each cash currency (total and, when the source reports one, settled difference,
  plus the ledger's unsettled receivable/payable), and each position with a `kind` of
  `matched`, `quantity-difference`, `missing-in-external`, or `extra-in-external`, a currency
  mismatch flag, and a cost-basis comparison when the source supplies a basis. Differences are
  external − ledger. `reconciled` is exactly `differenceCount === explainedCount`.
- **Explanations are declared, never applied.** `pending-settlement`: the source reports totals
  only, its total equals the ledger's SETTLED cash, and the gap is the ledger's own unsettled
  legs — timing, not a difference. `corporate-action-candidate`: the quantity ratio (either way)
  is a clean integer ≥ 2 within 1e-9 — a split the ledger has not yet been told about; the ratio
  is reported.
- **Drafts, not writes.** Every unexplained difference that can be priced becomes a validated
  DRAFT envelope in `suggestedCorrections`: cash gaps as `cash.deposit` / `cash.withdrawal`,
  quantity gaps as `trade.fill`s priced at the source's cost basis per unit (or the ledger's own
  basis for a position the source no longer holds), ids `reconcile:<asOf>:<account>:cash:<CCY>`
  / `…:position:<instrumentId>`, provenance naming the source and stating that applying is a
  separate authorized write. A difference that cannot be priced is listed under `undraftable`
  with its reason. `reconcilePortfolio` NEVER mutates the ledger — the test applies a draft
  through `ledger.apply` separately and shows the next reconciliation clean.
- **Assumptions and diagnostics** carry the conventions version, the lot-relief policy, the
  tolerance used, and the comparison convention verbatim; warnings disclose a source `asOf` that
  differs from the requested one.

### Enrolment (the package stays measured whole)

Manifest Law 1 row (`analysis` / `report`, entrypoints `.` and `./reconciliation`), a
hand-computed fixture, a count-semantics row for the state's `eventCount`, the state-schema pin,
the export map / umbrella / vitest alias for `./reconciliation`, budgets reconciled rather than
absorbed (portfolio 37 → 41 KB, umbrella 480 → 483 KB, and `performance/sharpe` 7.5 → 7.75 KB
because two repair codes joined core's central `ErrorCode` table), and the first-touch sweeps
over the administration arms: the migration marker baselines through the portfolio hook; the
two repair arms cannot (a reversal or correction names an already-applied fact, and the builder
grafts an arm at index 0 and reads index 0 back), so they sit in the declared-branch ledger with
that reason and their end-to-end coverage. Enrolment caught two defects the package's own tests
had not: `reconcilePortfolio` swallowed an explicit `correctionSourceId: null` into the default
(now `input.wrong_type`), and an epoch-millisecond `asOf` outside the instants a `Date`
represents reached `toISOString()` as a raw RangeError — the envelope's epoch law moved to the
shared internal module and now guards `reconcilePortfolio` (both instants) and
`portfolioSnapshot`: ONE as-of law for the package. Twenty-five hand-computed tests cover every
journey above, including a transfer, a conversion, and a cash-amount correction.

### Acceptance laws this slice closes (FC7 "Portfolio exit gate")

- "Correction … journeys pass": exact reversal and correction journeys pass for every economic
  family, including the refusals (relieved lots, double reversal, tampered original, phantom
  target, split) and the repair-of-a-repair semantics.
- Mandatory state "correction/reversal links and reconciliation status": links live in
  `state.reversals` (and each repair's `reversesEventId`); reconciliation status is the
  `ReconcilePortfolioResult` with explanations and drafts.

### Deferred by this slice (each with its decided home)

| Deferred                                                                                         | Home                                                               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Reversing a fill whose lots were relieved/rescaled; reversing a split                            | Record a correcting fill / counter-split (Law 1: append, not undo) |
| Position transfer between accounts as an event family                                            | Slice 5 lifecycle families                                         |
| Per-lot (tax-lot) comparison against an external lot list                                        | Reconciliation follow-up when a source supplies lots               |
| Draft corrections for pending settlement or corporate-action candidates (explained, not drafted) | By design: an explanation is not a write                           |

## Slice 4 (landed 2026-08-29) — the investment policy, `./policy`, and the risk-side construction calls

Executes the agent-native "Portfolio management workflows" decisions (Investment policy, Rebalance
proposal, Monitoring and alerts), the tracker's "Portfolio-side management" and "Risk-side portfolio
construction" requirements, and the FC7 required-API rows for `createModelPortfolio`,
`allocatePortfolio`, `proposePortfolioRebalance`, and `monitorPortfolio`. The governing law of the
slice: **a policy is a user-supplied artifact, never advice, and missing goals never become secret
defaults** — every gap is a typed refusal or an explicit `unresolved` row.

### The grammar (`policy-grammar.ts`, internal; `./policy` re-exports the reviewed surface)

- **Targets on groups.** A target names exactly ONE group — `instrumentId`, `sleeveId`,
  `assetClass`, `currency`, `tag`, `underlying`, or `strategy` (the P&L/timeline grouping
  vocabulary) — and declares exactly one of `weight` (decimal of NAV, |w| ≤ 1; a percentage is
  refused with the teaching) or `riskBudget`. `{ assetClass: 'cash' }` is THE cash target — the
  accepted example's spelling. A target set is dated (`effectiveFrom`, optional exclusive
  `effectiveTo`); duplicate groups and per-dimension sums above 1 are refused.
- **Model portfolios** (`createModelPortfolio`) are immutable, content-addressed artifacts
  (`kind: 'totalfinance.model-portfolio'`, schema version 1, `sha256:` over the canonical definition):
  `modelId` + safe-integer `version` (a changed model is a new version), a strategic set, dated
  tactical overrides, an optional glide path whose `interpolation` (`'step'` | `'linear'`) is
  REQUIRED and whose linear form must keep one group set across points, hierarchical sleeves (a
  leaf declares members summing to 1; a child declares `weightWithinParent`, siblings summing to
  1; cycles, orphans, and empty sleeves refuse), benchmark identity with dated membership, a
  liability schedule, and a horizon. `isModelPortfolio` routes through the complete validator
  including the hash — an edited artifact is `artifact.id_mismatch`, never trusted.
- **Resolution** (`resolveModelTargets({ model, asOf })`): the latest tactical set covering the
  instant wins, else the glide path (stepped, or interpolated by time fraction only when the
  model says `linear` — tested at 182/365 of the way between two points), else the strategic set;
  an instant before the strategic set is a typed refusal (a model has no goals there).
- **The investment policy** (`InvestmentPolicy`, closed): targets inline XOR a model; the
  within-group split rule; drift band; review cadence; maximum turnover and maximum estimated
  transaction cost; minimum cash (amount and/or weight — the larger binds); hard limits (position
  weight, group weights, gross leverage, drawdown, one-evaluation loss, days-to-liquidate,
  settled-cash floor); allowed/restricted instruments and allowed accounts; benchmark; prose
  performance objective; contribution/withdrawal handling; income reinvestment; and the identity
  of an external lot-selection objective (echoed, never applied — this build reports lots under
  the ledger's own relief policy).
- **Expansion** (`expandTargets`, internal — the ONE law `allocatePortfolio`,
  `proposePortfolioRebalance`, and `monitorPortfolio` share): instrument targets bind directly;
  sleeve targets flow down the tree (0.6 × 0.7 = 0.42, tested); classification and currency
  targets bind to the universe members carrying the group and split by `withinGroupAllocation`
  (`'equal'` or `'proportional-to-current'`, which falls back to equal with a warning when nothing
  is held) — a multi-member group with no declared split is `unresolved`, as is a group with no
  members, a risk budget (needs a covariance — the risk side), and an instrument named by two
  targets (a conflict, never a sum). When the declared weights sum to 1, uncovered holdings and a
  missing cash target are IMPLIED zeros and flagged `implied`; when they sum to less, the
  remainder is undeclared and reported — not assumed.

### Risk-side construction (`@totalfinance/risk`): `estimateExpectedReturns`, `efficientFrontier`

The tracker keeps every optimizer in `@totalfinance/risk` and forbids copying them into the portfolio
package (the FC0 graph forbids the edge in both directions); the two new calls compose what exists.

- **`estimateExpectedReturns`** takes an explicit `method` — `'historical-mean'` (bit-identical to
  `meanReturns`), `'exponentially-weighted'` (a REQUIRED `halfLifePeriods`; weights
  `0.5^((T−1−t)/h)`, most recent heaviest; `effectiveSampleSize = (Σw)²/Σw²` disclosed),
  `'capital-asset-pricing'` (composes FC2's `capitalAssetPricingExpectedReturn` per asset —
  `@totalfinance/risk` gained the L4 → L3 edge to `@totalfinance/valuation`, accepted by the graph and
  layer laws), or `'supplied'` (an explicit `annualized` flag). Annualization is never silent:
  omitted `periodsPerYear` means per-period means with `annualized: false`. Point-in-time inputs:
  `observationTimestamps` aligned to the rows and an `asOf` exclude every later row and disclose
  the count; a bare `asOf` without timestamps is echoed with a warning that nothing was screened.
- **`efficientFrontier`** traces the constrained mean-variance frontier over the EXISTING
  `OptimizeConstraints` grammar by composing `minVariance` (left endpoint), `meanVariance` (a
  risk-aversion sweep, or bisection on log λ for target returns), and `maxSharpe` (the tangency
  point when `riskFreeRatePerPeriod` is given — per period, the spelling `maxSharpe` uses, because
  `mean`/`covariance` are per period). The grid is REQUIRED (`risk-aversion` values, `target-return`
  values, or a `points` count between the minimum-variance return and the maximum achievable
  return); `count` is a count coordinate (safe integer ≥ 2, capped at 10,000, typed refusals for
  2^32 / 2^53+2 / 1e308 / negative / fractional). Every point is kept in grid order — a target
  outside the achievable range is a FAILED point with the range in its reason, never a throw;
  feasibility is measured per point (budget, box, group, and turnover violation ≤ 1e-6, mirroring
  the optimizers), convergence is reported per point and in aggregate, and the volatility-versus-
  return monotonicity of the solved points is checked. An unbounded problem (an asset with no upper
  bound and another with no lower bound) is reported structurally and the `points` grid falls back
  to a descending λ grid with a warning. The maximum-return endpoint is found by a descending λ
  ladder that stops at a plateau or the first non-converged solve (a single λ = 1e-6 solve sits
  past the projector's precision and jitters — measured, not assumed).
- Analytic evidence: two uncorrelated assets (σ₁² = 0.04, σ₂² = 0.01, μ = 0.10 / 0.05) —
  minimum-variance weight 0.2 on asset 1 and target-return weights `(μ* − 0.05)/0.05` to 1e-6;
  the long-only maximum return is exactly 0.10; the EWMA weights and effective sample size are
  hand-computed. 56 tests across the two files.

### `allocatePortfolio` — target weights to executable quantities

`allocatePortfolio({ policy, asOf, baseCurrency, netAssetValue, prices, currentHoldings?,
currencyConversions?, instrumentClassification?, lotSizes?, defaultLotSize?, minimumNotional?,
cashReserve?, transactionCosts? })` resolves the policy's targets at `asOf` through the one
expansion law and sizes them against explicit prices (FC5 conversion for a non-base instrument;
a missing or non-positive price is an unresolved target, never a guess). Quantities round TOWARD
ZERO to the lot size (an instrument no lot-size rule covers stays fractional — the assumptions say
so), a trade below the minimum notional is dust (skipped and listed with its aggregate cash
effect), and costs are estimated as commission per trade + per unit + (spread + slippage) basis
points of notional. Funding is cash conservation — `Σ buys ≤ current cash + Σ sells − (reserve +
cash target × NAV)` — so a reserve on top of fully declared targets, or a short target whose
rounding under-raises the intended cash, is reported INFEASIBLE with the shortfall named and
"nothing was scaled"; restricted or non-allowed instruments with a non-zero target are unresolved
rows. The result reports per-instrument target/achieved weights, quantities, rounding residuals,
the cash ledger (reserve, target, residual, achieved), the trades, the dust, the estimated cost
and turnover, and `feasible`.

### `proposePortfolioRebalance` — a plan, never an execution

`proposePortfolioRebalance({ portfolio, market, asOf, policy, scope, externalFlow?,
tradingAccountId?, … })` values the managed book with `portfolioSnapshot` (accounts filtered by
`policy.allowedAccounts`; excluded accounts are disclosed, never traded), resolves and expands
the targets, measures drift per instrument and group against the bands, and sizes trades through
`allocatePortfolio` over the post-flow NAV. `scope` is REQUIRED — `'to-target'` trades every
instrument to its target; `'drift-only'` trades only what sits outside its band. A planned
contribution buys the most-underweight instruments first (using new cash where that reduces
turnover, as the accepted contract asks); a withdrawal raises cash from overweights or pro-rata
exactly as the policy's `withdrawalHandling` declares; `hold-as-cash` leaves the flow in cash — a
flow without a declared handling is a typed refusal, because that is a goal. The turnover cap and
the cash floor (the larger of `minimumCash` and `minimumCashWeight × NAV`, funded from SETTLED
cash) TRIM the plan and are reported as `capped` goals; every hard limit is evaluated on the
POST-trade book and a violation is a `violated` row with `feasible: false` — the trades stay
listed, nothing is relaxed. Closing trades carry a lot-selection preview under the state's own
relief policy (fifo / lifo / highest-cost through the reducer's exported `reliefOrder`; a
`specific-lot` book reports `null` with the reason), proven to relieve the same lots for the same
realized P&L as `applyPortfolioEvents`. The objective is reported before and after (`driftDistance`
= Σ|w − t|/2 over instrument targets and cash; `trackingDistance` against the benchmark's
constituents when the policy or model states them, else `null` with the reason), as are
concentration and leverage (maximum weight, Herfindahl index, top-three weight, gross leverage,
cash weight), the estimates (commission, spread, slippage, turnover), the dust, convergence, and a
content-addressed `TradePlanArtifact` (`kind: 'totalfinance.trade-plan'`, schema version 1, the
policy's content hash, per-account trades with a reference price) — normalized for preflight and
carrying no execution capability. Buys book to the trading account (required when more than one
allowed account holds cash); closing quantities book to the holding accounts; a plan that would
need cash moved between accounts says so. 52 hand-computed tests across the two files, including
the accepted example's drift scenario (0.66/0.26/0.08 trades in `drift-only`; 0.61/0.30/0.09
proposes nothing), turnover capping, contribution-first investing, both withdrawal handlings,
limit violations, and lot-preview parity.

### `monitorPortfolio` — a pure state transition returning typed alerts with evidence

One explicit snapshot (state + Gate B market + `asOf`) is evaluated against the policy and the
PRIOR monitor state (`previousState` is a required key — `null` on the first evaluation, because
forgetting it would silently reset hysteresis and cooldowns), and the result is the alerts plus
the NEXT state. It never notifies; the host schedules and delivers.

- **Families evaluated in this build:** allocation drift (per instrument and group target, against
  its band), concentration (position and group weights), leverage, drawdown (against the peak NAV
  carried in the state), one-evaluation loss, cash reserve, margin pressure (settled base cash),
  liquidity (days to liquidate at a stated 0.1 participation rate), stale/missing marks,
  reconciliation differences (from a `reconcilePortfolio` result), and unexplained residual /
  unusual P&L (from a `portfolioPnl` result). A family evaluates only when the policy (or an
  explicit rule threshold) declares its bound — otherwise it is `skipped` with the reason, never
  given a default threshold. Deferred families (option expiration/assignment/exercise/dividend
  risk, failed/rejected/stuck orders, scenario-loss change) are named in
  `diagnostics.unsupportedFamilies` with their home (slice 5 lifecycle, the order journal, Gate D).
- **Rule mechanics** per `(family, key)`: threshold and direction, hysteresis (`enter`/`exit`,
  validated against the direction), debounce (consecutive breaching evaluations before raising),
  cooldown (a re-breach inside the window reports `suppressed`, never re-raises), severity, and
  acknowledgment (an acknowledged active rule reports `acknowledged` until it clears, then one
  `cleared`). Every mechanic default is echoed in `assumptions.rulesApplied` with the source of
  the bound (`policy` / `input` / `rule` / `per-observation`).
- **Missing marks are not a crash:** holdings are pre-scanned against the snapshot's spots, every
  unvalued instrument raises `stale-market-data`, the cash-only families still run on a
  positions-stripped valuation, and the weight-based families are skipped as `unvalued` — with
  the instrument ids in the reason.
- **Replay law:** a recorded sequence of (market, portfolio, previous state) inputs reproduces the
  same alerts and states (tested), and companion results are validated (closed keys, matching
  base currency, not dated after `asOf`, a `reconciled` flag that disagrees with its counts is
  refused as edited). 42 hand-computed tests: drift, concentration, leverage, a 100k → 110k → 95k
  drawdown sequence (13.6% against a 10% limit), daily loss, cash reserve, margin pressure, stale
  and missing marks, reconciliation and P&L companions, hysteresis 0.05/0.02, debounce 2,
  cooldown, acknowledgment, replay, and the typed refusals.

### Enrolment (the packages stay measured whole)

Manifest Law 1 rows for every new export (four `analysis` / `report` heads, the `artifact`
`createModelPortfolio`, the open-input predicate `isModelPortfolio`, the plain-value helper
`resolveModelTargets`, six constants, and the two risk-side `analysis` / `envelope` heads);
hand-computed fixtures for every head plus a `previous-state` variant for the monitor; the
first-touch hook learned the policy grammar (real, ORDERED dates for every date arm; a grafted model
is rebuilt as a real `createModelPortfolio` artifact that mirrors the synthesized arm kinds, because
a synthesized artifact can never carry a valid hash) so the declared-branch sweep feeds every
policy arm; the thirteen `reconciliation`-companion arms of the monitor are ledgered with the
reason that a produced report cannot be synthesized consistently (the family is measured with a
real result), and the declared-coverage residual records the same builder route; the glide-path
point type says in the TYPE that a point has no `effectiveTo`;
count-semantics rows for the state's `eventCount` and the carried `evaluationCount`
(`halfLifePeriods` curated as a magnitude — a continuous exponent, never a loop bound; the
monitor's companion-report counts curated as closed-form values, and the frontier's
`maximumIterations` cap materialized in its fixture); five risk warning codes registered in
core's `WarningCode` (the codes gate admits no unregistered literal); the monitor's severity
literal spelled `'informational'` (the naming gate admits no abbreviation);
`resolveModelTargets` takes ONE request object so no multi-positional rationale is needed; the
`./policy` export map, vitest alias, and root re-exports; `@totalfinance/risk` gained the L4 → L3
edge to `@totalfinance/valuation` (graph and layer laws re-ran green); and budgets reconciled rather
than absorbed — portfolio 41 → 70 KB (four modules of closed-key validators and teaching strings,
measured 69,020 B) and the umbrella 483 → 517 KB (measured 526,967 B). Enforcement after the
chain: 0 defective, 176 unmeasured (unchanged) of 5,110 candidates; every new head's canonical
fixture is `enforced`. The slice was built in parallel — the grammar first, then the risk side,
allocation/rebalance, and monitoring as three concurrent drafts over the shared grammar — and
landed serially through the one artifact chain. 138 new hand-computed tests (12 grammar, 19
allocation, 33 rebalance, 42 monitor, 29 expected returns, 27 frontier... see each file).

### Acceptance laws this slice closes (FC7 "Portfolio exit gate")

- "Rebalance proposals satisfy or explicitly fail every policy constraint and never mutate or
  execute": a proposal is a frozen plan plus a content-addressed trade-plan artifact with no
  execution capability; caps trim and are reported, limits are evaluated post-trade and reported,
  nothing is relaxed.
- The FC7 required-API rows for `createModelPortfolio`, `allocatePortfolio`,
  `proposePortfolioRebalance`, and `monitorPortfolio`, and the risk-side rows for
  `estimateExpectedReturns` and `efficientFrontier`.

### Deferred by this slice (each with its decided home)

| Deferred                                                                       | Home                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Risk-budget targets → weights (needs a covariance)                             | Risk side: `efficientFrontier` / the optimizers, then restate as weight targets |
| Monitor families for option lifecycle, order journal, and scenario-loss change | Slice 5 lifecycle families; the order journal; Gate D                           |
| Cash moved between accounts inside a plan; a position-transfer family          | Slice 5                                                                         |
| Tax-aware lot selection (an external objective is echoed, never applied)       | A specialized extension over the ledger's lot facts                             |
| Projected cash availability from coupons/dividends/option lifecycle            | Slice 5 lifecycle families (liabilities are already carried)                    |

## Slice 5 (landed 2026-08-29) — the lifecycle families and the packed fixtures

Executes the agent-native "Derivative lifecycle" and "Corporate actions" event families, the FC7
mandatory-state lines for option multiplier/exercise/assignment/expiration/settlement, futures
variation margin and rolls, fixed-income accrual/coupon/call/maturity/principal, crypto funding,
mergers/spin-offs/symbol changes/return of capital/cash-in-lieu, and position transfers, and the
exit-gate row for packed browser/worker/local-store fixtures.

### The foundation: one kernel, one instrument profile

- **`reducer-kernel.ts`** (internal) now holds the ONE set of lot, cash, and position primitives
  every family folds through — `ensurePosition` (create or prove profile agreement), `openLot`,
  `relieveQuantity` (policy-ordered or specific-lot relief with the fill's teachings, realized P&L
  carrying the multiplier), `finalizePosition`, `bookCash`, `recordRealized`, `recordIncome`,
  `requireHeldPosition`, `closingCapacity`, `infeasible`. The fill reducer was re-based on it with
  no behaviour change (the 236 prior tests pass unchanged), so an exercise relieves option lots
  and opens underlying lots with exactly the arithmetic a fill uses.
- **The instrument profile.** A fill may state `contractMultiplier` (units of the underlying per
  unit of quantity; REQUIRED with contract terms — the ledger never assumes an option's 100),
  `settlementStyle` (`'cash-on-trade'` books `quantity × price × multiplier` at the fill;
  `'variation-margin'` books nothing at the fill and realizes P&L through settlements and on
  close — REQUIRED for futures and perpetuals, refused for options), `contract` terms (option
  right/strike/expiry, future expiry, perpetual), and `accruedInterest` (an income adjustment,
  never basis; the next coupon recovers it). The position carries the profile from its opening
  fill; a later fill that disagrees (currency, multiplier, style, or terms) is a typed refusal —
  one profile per open position. The lot basis stays PER UNIT. State schema 3 → 4; each fill
  effect now records the signed `cashDelta` it booked, so a reversal restores cash exactly whatever
  the style.
- **Valuation.** A cash-on-trade position values at `quantity × mark × multiplier`; a
  variation-margin position contributes its UNSETTLED P&L since the last settlement (`Σ (mark −
lot basis) × lot quantity × multiplier`, `costBasis` 0) — its notional is not owned. Every
  snapshot position now also reports `notionalValue` / `baseCurrencyNotionalValue` (= `quantity ×
mark × multiplier`); exposure, drift, concentration, leverage, and sizing use NOTIONAL (a futures
  overlay's exposure is its notional, not its 2,000 of unsettled P&L — tested: NAV 102,400 against
  long exposure 453,400), while NAV, drawdown, and P&L use market value. `allocatePortfolio` takes
  `contractMultipliers`; `proposePortfolioRebalance` passes the state's; `reconcilePortfolio`
  compares basis × multiplier against a broker's currency-terms basis.
- **The first-touch hook** repairs every lifecycle arm's body and a fill's contract profile
  (multiplier and settlement style per contract kind, real terms and dates), so the declared-branch
  sweep reaches each family's own teaching rather than a placeholder.

### The derivative lifecycle (`lifecycle-derivatives.ts`)

- **`derivative.exercise`** (a long option) and **`derivative.assignment`** (a short one) relieve
  the option lots and settle: cash settlement at the intrinsic value from an explicit
  `settlementPricePerUnit` (`premiumTreatment` must be `'realize'` — there is nothing to fold
  into); physical settlement delivers the underlying at the strike with the premium either
  realized on the option lots (`'realize'`, relief at 0) or folded into the delivery price
  (`'fold-into-underlying-basis'`: the relieved-quantity-weighted premium per unit moves into
  `K ± p`, cash always at `K`). The underlying leg uses the fill's exact lot mechanics — opposing
  lots are covered or relieved first, the remainder opens — through the one kernel. Under
  `specific-lot` relief a derived underlying leg the event cannot name is a typed refusal rather
  than a silent pick.
- **`derivative.expiration`** relieves at 0 with no cash (a long loses the premium, a short keeps
  it) and requires option terms — a future or perpetual retires through a final settlement and a
  close, not a worthless expiry.
- **`derivative.variation-margin`** re-bases every open lot of a `'variation-margin'` position to
  the settlement price and realizes `Σ (S − basis) × signed quantity × multiplier` in cash — the
  fold computes the amount, so a statement's figure reconciles rather than being trusted; a
  second settlement at the same price realizes 0; a cash-on-trade position refuses (it marks
  through `portfolioSnapshot`). NAV is conserved across a settlement at the same mark (tested:
  103,000 before and after).
- **`derivative.roll`** closes the contract with the sign-aware cash law (proceeds for
  cash-on-trade, realized difference for variation margin) and opens its successor with the same
  sign, currency, multiplier, and style; the successor's terms come from the event (a perpetual's
  carry over; an option or future needs its own expiry), its kind must equal the closed kind, and
  the fill validator's style-versus-kind law is re-applied so a roll can never mint a position a
  fill could not.
- **`derivative.multiplier-change`** scales every lot's per-unit basis by `before / after` so
  `Σ quantity × basis × multiplier` is preserved exactly (100 → 200 proven with `toBe`) and,
  when the event states `strikePricePerUnitAfter`, restates an option's strike (an OCC-style
  adjustment changes both; the ledger never derives a strike from a ratio, and a future has none
  to adjust).
- Zero cash amounts are never booked, so an out-of-the-money cash exercise or a variation-margin
  open never pushes a phantom dated leg onto the settlement schedule.
- **Reversals** of every family here are typed `portfolio.reversal_infeasible` refusals naming
  the correcting event to record (a multiplier change carries only the multiplier after, and the
  fold keeps no "before", so its inverse cannot be proven from the fact). Correcting a derivative
  fact refuses the same way.
- 49 hand-computed tests: every settlement path above, a specific-lot exercise, a short-underlying
  cover, NAV conservation, a futures sequence (open, settle 4,520 → +2,000, settle 4,490 → −3,000,
  close 4,500 → +1,000; total 0), a roll, and a BTC perpetual journey (variation margin plus
  funding paid and received through the existing financing/income families).

### Corporate actions, redemptions, and transfers (`lifecycle-corporate.ts`)

- **`corporate.symbol-change`** re-keys the position (lots, lot ids, basis, profile) and carries the
  per-instrument attribution history to the new name; it refuses to rename onto a held instrument
  (a rename never merges — that is a merger). Its reversal is exact while the account holds the
  new name and not the old.
- **`corporate.merger`** — pure cash: every lot is relieved at `cashPerShare` (realized through the
  kernel) and cash `+= cashPerShare × quantity × multiplier`; stock: every lot converts
  (`quantity × sharesPerShare`, basis `÷ sharesPerShare` — total basis preserved exactly) and moves
  to the successor with its ids and dates; mixed: the cash consideration first REDUCES basis per
  unit (the return-of-capital convention, stated because no mark exists to split basis by value),
  any excess over a lot's basis is realized and the lot floors at 0, then the remaining basis
  converts. Long, cash-on-trade positions only.
- **`corporate.spin-off`** creates child lots (`quantity × sharesPerParentShare`) carrying the
  EXPLICIT `basisAllocationFraction` of each parent lot's basis (the parent keeps `1 − f`; total
  basis preserved exactly, tested with `toBe`); child lots keep the parent lot's opening date (the
  holding period carries over) and are opened by the spin-off event.
- **`corporate.return-of-capital`** books cash and reduces basis per unit — never income; excess
  over basis is realized and the lot floors at 0. **`corporate.cash-in-lieu`** relieves the
  surrendered fraction at `amount ÷ (quantity × multiplier)` so proceeds equal the booked cash
  exactly. **`fixed-income.redemption`** relieves face units at the redemption price (maturity,
  call, principal paydown, sinking fund) with cash `+= quantity × price × multiplier`; a maturity
  of less than the whole position is refused, naming `'principal-paydown'`.
- **`position.transfer`** moves lots between accounts by `lotSelections` (specific-lot) or the
  relief order: a lot moved whole keeps its id; a partial move splits it, and the moved part
  keeps the source lot's opening date and opening event; no cash, no realized P&L; the receiving
  position must agree with the profile and never mixes signs.
- Variation-margin positions refuse every basis-transforming action here (their basis is a
  settlement price, not capital); shorts refuse mergers, spin-offs, returns of capital,
  redemptions, and cash-in-lieu with the event to record instead. Under `specific-lot` relief a
  whole-position or single-lot action derives its selections (nothing to choose, so nothing
  guessed); a multi-lot cash-in-lieu refuses, naming a `trade.fill` with `lotSelections`.
- **Reversals**: symbol change is exact; every other family here is a typed
  `portfolio.reversal_infeasible` refusal naming the correcting event (the fold keeps no per-lot
  record of what a merger, spin-off, return of capital, or transfer did).
- 37 hand-computed tests, including the fifo transfer that splits the second lot (40 + 20 of 100),
  the specific-lot transfer, and every refusal.

### Packed browser, worker, and local-store fixtures (exit-gate row)

`tools/packed-consumer.test.ts` now folds ONE plain-JavaScript journey (deposit, 100 AAPL at 150,
a 4-for-1 split) against the PACKED `@totalfinance/portfolio` in three environments and proves the
same content hash in each: a `worker_threads` Worker that folds and posts `toJSON()` across the
thread boundary (the parent restores it with `readPortfolioLedgerSnapshot` and checks hash,
`eventCount`, 400 AAPL, cash 85,000 — and that the clone is not frozen, proving it really crossed);
an esbuild `--platform=browser` bundle executed in `node:vm` with only web globals (`TextEncoder`,
`TextDecoder`, `console`, `structuredClone`, `webcrypto`) — the harness proves there is no
`process`, `require`, `Buffer`, or `module` before the bundle runs and the bundle proves it again
from inside (esbuild rewrites a bare `require` into its own shim, so the probe reads
`globalThis`); and a `Map`-backed `getItem`/`setItem` store that stores, restores, applies more
events, stores and restores again, and matches a single-pass fold — with the migration law from
the packed install (a `schemaVersion + 1` envelope refuses with `snapshot.unsupported_version` and
the store survives the refusal). A fourth test asserts the three environments agree and logs the
hashes.

### The monitor learns notional exposure and the option-lifecycle families

`monitorPortfolio` now weighs concentration, leverage, and drift on `baseCurrencyNotionalValue`
(a futures overlay's exposure is its notional — 452,000 beside 2,000 of unsettled P&L in the
evidence) while NAV, drawdown, daily loss, and cash stay on market value. Two families join:
`option-expiration` (days to expiry from the position's terms against `optionExpirationWarningDays`
or a rule threshold; evidence carries the expiry date, right, strike, underlying, and the
underlying's mark) and `assignment-risk` (short options only: moneyness at the underlying's mark,
`(S − K)/K` for a call, `(K − S)/K` for a put, against `assignmentRiskMoneyness`; a short option
whose underlying is unmarked is raised as a null-valued observation rather than carried silently).
Neither gates on valuation, so both evaluate when the option itself is unmarked; both are skipped
with the reason when no bound is declared. Still deferred, each with its reason: dividend risk
(no ex-dividend calendar), order status (the order journal), scenario-loss change (Gate D).

### Enrolment (the package stays measured whole)

No new runtime export: the slice widens the event union (twenty-two families) and the fill's
profile, so the manifest is unchanged and the twenty-three new grammar types ride the root. The
widened envelope pushed the four single-envelope heads (`requirePortfolioEventEnvelope`,
`duplicateBoundaryKey`, `portfolioEventContentHash`, `PortfolioLedger#apply`) past the
enumeration cap — the truncation gate fired as designed, the cap was lifted, the widest contract
re-measured at 108 alternatives, and `VARIANT_LIMIT` re-set from that measurement (176 ≈ 1.6×).
The declared-branch ledger records, with reasons, the lifecycle arms the builder cannot baseline
(every one transforms HELD lots, and an arm grafted onto the first event meets the fold's own
position teaching), the fill's and the roll's `contract` union (recorded `truncated` below the
inventory's field-tree depth), the thirteen new `admin.correction` replacement arms, and the
monitor companion's thirteen new draft-event arms; every one is exercised end-to-end in the three
lifecycle suites. The declared-coverage residual ledger gained the same rows under every
spelling (156, keyed per record id as before). The whole-library realization sweep, which re-derives
every variant of every record, went from ~20 s to ~267 s with the widened envelope and failed its own
180 s budget while asserting nothing — the same defect the budget's rationale records; the sweep now
derives ONE result per declaration and replays it under each umbrella spelling (exact: same
enumeration, same synthesis, same gaps, identity counter reset per derivation), which brought it to
~144 s alone and turned the second sweep into a cache replay; the budget was re-set from that
measurement (600 s ≈ 4×). Budgets reconciled rather than absorbed: portfolio 70 → 80 KB (the kernel, two
lifecycle modules, thirteen validators, two monitor families; measured 79,166 B) and the umbrella
517 → 527 KB (measured 537,258 B). Enforcement after the chain: 0 defective, 176 unmeasured
(unchanged) of 5,110; naming 27,865 / 0 unresolved. Built in parallel — the kernel, grammar, and
profile first, then the derivative family, the corporate/fixed-income/transfer family, and the
packed fixtures + monitor families as three concurrent drafts — and landed serially through the
one artifact chain. 108 new hand-computed tests (7 foundation, 49 derivatives, 37 corporate, 11
monitor, 4 packed).

### Acceptance laws this slice closes (FC7 "Portfolio exit gate")

- "Trade/settlement, option assignment, futures variation margin, fixed-income accrual, crypto
  funding, FX conversion, corporate action, correction, and multi-account transfer journeys
  pass" — every lifecycle family above has a hand-computed golden journey, and the reducer's
  replay, duplicate, and conflict laws re-ran over them.
- "Serialization/migration/replay works through packed browser, Node, worker, and local-store
  fixtures without a database dependency" — the three packed environments above agree on one
  content hash.
- "Every golden journey reconciles cash, quantities, lots, cost basis, NAV, and P&L" — re-run over
  multiplier and variation-margin positions (NAV conserved across a settlement; exposure on
  notional).
- With this slice every row of the FC7 exit gate is closed; the mandatory-state lines for option
  multiplier/exercise/assignment/expiration/settlement/multiplier changes, futures variation
  margin and rolls, fixed-income accrued interest/coupon/call/maturity/principal, crypto funding,
  corporate actions beyond splits and cash-in-lieu, and internal transfer identity are implemented.

### Deferred by this slice (each with its decided home)

| Deferred                                                                                          | Home                                                                               |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Exact reversal of lot-transforming lifecycle events (exercise, merger, spin-off, transfer, …)     | Append the correcting event (Law 1); a per-lot effect record is a later refinement |
| Accrued-interest VALUATION between coupons (marks are clean prices; the fill's accrued is booked) | FC8 cross-asset lifecycle valuation with dirty-price marks                         |
| Dividend-risk, order-status, and scenario-loss monitor families                                   | Ex-dividend calendar (data layer); the order journal; Gate D                       |
| Liquidation policy for perpetuals; futures expiry as a final settlement event                     | FC8 "Cross-asset lifecycle" (settle + close is expressible today)                  |
| Mixed-merger basis split by VALUE                                                                 | Needs marks at the merger instant; the return-of-capital convention is stated      |
