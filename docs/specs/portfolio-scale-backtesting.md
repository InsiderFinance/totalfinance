# Spec — Stage 4.6 portfolio-scale and cross-asset backtesting (FC8)

> **Status:** `COMPLETE @ 839a955e7` — the original six Stage 4.6 slices landed after the
> 2026-09-03 contract acceptance, ahead of the maintainer-held Stage 5A publish. Stage 4.7 also
> landed. These historical completion records are supplemented by the
> [September review repairs](./review-september-2026-repairs.md), locally verified complete on
> `dccfce53` plus the repair changes. [`../implementation-order.md`](../implementation-order.md) owns the
> current queue: Stage 5A/5B remain maintainer-held. Do not restart Stage 4.6 or treat local repair
> verification as publication authority, a new commit, or hosted-matrix success.
>
> **Contract authority:** the FC8 section, Decisions D1–D20, the permanent lovability gate, the
> package-ownership graph, and the canonical first-touch shapes in
> [`finance-portfolio-backtesting-completeness.md`](./finance-portfolio-backtesting-completeness.md);
> the shipped options engine's contract [`options-backtest.md`](./options-backtest.md) (its
> "Portfolio-grade completion required by FC8" list becomes requirements here); the FC7 ledger
> ([`fc7-first-slice.md`](./fc7-first-slice.md)) and the platform doc's rule that simulation,
> paper, and live share semantics ([`../agent-native-portfolio-and-trading-platform.md`](../agent-native-portfolio-and-trading-platform.md)
> §3, §8); the artifact grammar and bounded-work law of
> [`calibration-research-artifacts.md`](./calibration-research-artifacts.md) (Decisions 4, 6, 7, 9);
> the operation registry contract of [`local-operations-and-transports.md`](./local-operations-and-transports.md).
>
> **Permanent API authority:** [`../library-alignment-spec.md`](../library-alignment-spec.md),
> [`phase-3b-decision-ledger.md`](./phase-3b-decision-ledger.md), and the naming vocabulary of
> [`phase-3b-public-naming-normalization.md`](./phase-3b-public-naming-normalization.md). Every new
> public identity enters the naming, signature, manifest, first-touch, enforcement, package-graph,
> layer, sweep, packed-consumer, generated-docs, and bundle ratchets in its first implementation
> commit, and every ratchet stays at zero.

## Outcome

A researcher can run a point-in-time cross-sectional strategy over a universe with additions,
removals, and delistings; an options trader can run a book of overlapping, multi-expiry structures
with portfolio-level margin, Greek, concentration, and scenario limits; and a portfolio manager can
simulate a multi-asset book — equities, listed options, futures, FX forwards, crypto spot and
perpetuals, bonds, custom instruments — with explicit execution reality, contributions and
withdrawals, settlement, margin, and the full lifecycle of every instrument. In every case the
simulator's economic facts are the FC7 portfolio events, folded by the FC7 reducer, so a backtest, a
deterministic replay, a paper account, and a later live account differ in clock and data source,
never in finance. Every run reproduces from its artifact, compares to another run, and carries its
research hygiene. Every direct calculation remains direct. The shipped `vectorized`, `eventDriven`,
and `optionsBacktest` calls keep their identities and behavior.

Concretely, at the closing commit:

- `@totalfinance/backtest/cross-sectional` exports `crossSectionalBacktest` and
  `crossSectionalBacktestGrid`;
- `@totalfinance/backtest/portfolio` exports `portfolioBacktest`, the instrument adapter contract, and
  the built-in adapters;
- `@totalfinance/backtest/execution` exports the pluggable execution-reality models and their
  conformance suite;
- `@totalfinance/backtest/options` exports the same `optionsBacktest`, now over a position book with
  portfolio limits, first-class calendars and diagonals, combo/legged fills, quote freshness,
  corporate-action lineage, and lifecycle evidence;
- `@totalfinance/backtest/artifacts` exports `backtestRunArtifact`, `readBacktestRun`,
  `replayBacktestRun`, and `compareBacktestRuns`;
- `@totalfinance/portfolio` exports `NormalizedFill` and `portfolioEventsFromFill` — the audited bridge
  from an execution fact to economic events; `@totalfinance/research` exports `UniverseHistory`,
  `universeMembershipAt`, and `eligibleObservationsAt` — the point-in-time vocabulary the
  simulator reads and never redefines;
- the operation registry carries `totalfinance.backtest.cross_sectional_run` and
  `totalfinance.backtest.portfolio_run` beside the extended `totalfinance.backtest.options_run`, each with
  transport-parity and packed-consumer evidence;
- the FC8 backtesting exit gate is ticked row by row, with the commit that closed each.

## Non-goals

- No provider, credential, network fetch, or data adapter: every engine takes iterables and arrays
  the caller built (D19). Provider-fed chains and bars arrive at the data edge later through the
  unchanged iterable contracts.
- No paper or live execution, order submission, broker adapter, or authorization: the
  `NormalizedFill` bridge and the shared order/fill vocabulary are defined so those adapters fit
  (Stage 7B); nothing here submits anything anywhere.
- No second accounting engine: no engine in this stage tracks cash, lots, or P&L on its own. The
  simulator emits `PortfolioEventEnvelope`s and reads back `PortfolioState` (law 11).
- No second research engine: eligibility, screening, ranking, scoring, neutralization, quantiles,
  and factor diagnostics are `@totalfinance/research` calls; risk, margin, Greeks, and stress are
  `@totalfinance/risk` calls; performance is `@totalfinance/performance`; allocation from weights to
  quantities is `@totalfinance/portfolio`'s `allocatePortfolio`.
- No claim of exchange realism by default (FC8 verbatim): a run that names no execution policy
  gets the `simplified` policy whose label and assumptions say exactly what it does.
- No acceleration, worker pools, WASM, or Arrow paths (Stage 8, user-deferred); the performance
  budgets in the exit gate are measurements, not optimizations.
- No jurisdiction-specific tax, wash-sale, suitability, or regulatory truth (FC7's boundary holds).
- No new umbrella root hoist (D20): the new verbs live on `@totalfinance/backtest` and its subpaths and
  are reached from the umbrella through the `backtest` namespace.

## Decision 1 — package placement, identities, and dependency edges

| Surface                                                                                                    | Home                                                              | Rule                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crossSectionalBacktest`, `crossSectionalBacktestGrid`                                                     | `@totalfinance/backtest/cross-sectional`, re-exported from `.`    | The tracker's first-touch shape imports the subpath; the root re-export is the "one obvious first call" for the package README. Same function object on both.                                        |
| `portfolioBacktest`, `instrumentAdapters`, `defineInstrumentAdapter`, `assertInstrumentAdapterConformance` | `@totalfinance/backtest/portfolio`, the verb re-exported from `.` | The ledger-backed engine; the adapter contract is a structural interface (FC8 "custom instruments through the structural extension contract").                                                       |
| `execution` (the policy factories), `FillModel`, `assertFillModelConformance`, `ExecutionPolicy`           | `@totalfinance/backtest/execution`                                | Shared by the cross-sectional, options, and portfolio engines. `eventDriven`'s `SimulatedBroker` is unchanged (D18) and documented as equivalent to `execution.legacyBroker()`; it is not rewritten. |
| `optionsBacktest`, `optionsTearSheet`                                                                      | `@totalfinance/backtest/options` (unchanged identities)           | Generalized in place; no `v2`, alias, or fork ([`options-backtest.md`](./options-backtest.md) Preview P1 checklist, held).                                                                           |
| `backtestRunArtifact`, `readBacktestRun`, `replayBacktestRun`, `compareBacktestRuns`, `BACKTEST_RUN_KINDS` | `@totalfinance/backtest/artifacts`                                | Subpath-only, like every `./artifacts` (Stage 4.5 Decision 1); never on the root.                                                                                                                    |
| `NormalizedFill`, `portfolioEventsFromFill`, `NORMALIZED_FILL_KEYS`                                        | `@totalfinance/portfolio` (`.` and `./events`)                    | The ownership table names `NormalizedFill` as portfolio-owned; backtest maps simulation fills into it and never defines a fill of its own.                                                           |
| `UniverseHistory`, `UniverseMember`, `universeMembershipAt`, `eligibleObservationsAt`                      | `@totalfinance/research` (`.` and `./screening`)                  | Research owns universe identity and point-in-time eligibility; the simulator calls, never copies.                                                                                                    |

**Dependency edges.** `@totalfinance/backtest` adds `@totalfinance/portfolio` and `@totalfinance/research` to
its dependencies (the ownership graph: `backtest → portfolio; focused subpaths may also depend on
research, options, strategy, risk, calendars, and performance`). It does **not** add
`@totalfinance/scenarios`: portfolio-level scenario limits are evaluated through `@totalfinance/risk`
(`taylorPnl`, `scenarioGrid`, `stressTest`, `optionsMargin`, `aggregateGreeks`, `concentration`),
which the graph already allows. All four are layer 4, so the layer law (same-or-lower) holds, and
`research → backtest` stays forbidden. The package-graph test's `FC0_ALLOWED` gains a
`'@totalfinance/backtest'` row naming exactly these edges so the graph is a ratified matrix row rather
than an implicit allowance.

**Umbrella.** `totalfinance/backtest` re-exports the package root, so `totalfinance.backtest.crossSectionalBacktest`
and `totalfinance.backtest.portfolioBacktest` resolve; the subpaths are reached through the package.
No new namespace, no hoist.

## Decision 2 — one accounting: the ledger is the truth, the fill is the bridge

Every engine in this stage produces economic facts as `PortfolioEventEnvelope`s and folds them with
`applyPortfolioEvents` (`createPortfolioLedger` at the end for the artifact). The engine never holds
its own cash, lot, cost-basis, or P&L numbers. `finalValue` is the base-currency net asset value of
`portfolioSnapshot(state, lastMark)`; the equity curve is `portfolioTimeline`'s valuations; the
reconciled decomposition is `portfolioPnl` from the first mark to the last. A run whose emitted
events do not fold to the equity it reports is a refusal (`backtest.ledger_reconciliation_failed`),
never a published number.

**The bridge.** `@totalfinance/portfolio` gains the structural fill view every execution path produces:

```ts
interface NormalizedFill {
  fillId: string;
  accountId: string;
  instrumentId: string;
  side: 'buy' | 'sell';
  quantity: number; // > 0; side carries direction
  pricePerUnit: number;
  currency: string;
  filledTimestampMs: EpochMs;
  settleTimestampMs?: EpochMs;
  contractMultiplier?: number; // required when `contract` is given
  settlementStyle?: 'cash-on-trade' | 'variation-margin';
  contract?: DerivativeContractTerms;
  accruedInterest?: number;
  costs?: { commission?: number; exchangeFees?: number; regulatoryFees?: number; slippageAdjustment?: number };
  orderId?: string;
  venue?: string;
  liquidity?: 'maker' | 'taker' | 'unknown';
}

portfolioEventsFromFill({
  fill,
  sourceId, // the emitting system — 'backtest:<runId>' here; a broker import later
  recordedTimestampMs,
  provenance,
}): PortfolioEventEnvelope[]; // one `trade.fill` + one `cost.charge` per non-zero cost component
```

Event identity is deterministic: `eventId = ${fill.fillId}` for the fill and
`${fill.fillId}:cost:<component>` for its costs; `correlationId = fill.orderId`. Two identical fills
therefore fold once (the ledger's duplicate boundary), and a replay of the same run emits the same
envelopes byte for byte. The simulator's lifecycle facts (dividends, coupons, funding, variation
margin, exercise, assignment, expiration, rolls, redemptions, splits, mergers, spin-offs, symbol
changes, contributions, withdrawals, FX conversions) are emitted with the FC7 event types directly,
with ids `${runId}:<family>:<instrumentId>:<effectiveTimestampMs>[:<n>]`.

**Same-instant ordering law** (FC8 exit gate: "invariant to same-timestamp input ordering where
policy says order is irrelevant"). Within one effective instant the simulator emits, in this fixed
order: contributions and withdrawals → corporate actions and lifecycle facts → fills sorted by
`(orderId, instrumentId)` → the costs of each fill immediately after it → financing and income. Two
runs whose inputs differ only in the order of same-timestamp rows produce identical event sequences
and identical state hashes; the property test permutes them.

## Decision 3 — point-in-time truth

Research owns the vocabulary; the simulator reads it:

```ts
interface UniverseMember {
  instrumentId: string;
  fromTimestampMs: EpochMs; // first instant the name is a member (inclusive)
  toTimestampMs?: EpochMs; // first instant it is not (exclusive); omitted = still a member
  exitReason?: 'removed' | 'delisted' | 'merged' | 'other';
  /** The return earned by a holder from the last available price to the exit — a delisting
   *  return; required when exitReason is 'delisted' and the engine must exit the position. */
  delistingReturn?: number;
}
interface UniverseHistory {
  universeId: string;
  members: readonly UniverseMember[];
}
universeMembershipAt({ universeHistory, asOf }): { instrumentIds: string[]; additions; removals; exits };
eligibleObservationsAt({ observations, asOf, lagTradingSessions?, sessionsPerDay? }): UniverseObservation[];
```

Laws (each a test in the exit gate):

1. **No look-ahead.** An observation whose `availableTimestampMs` is after the decision instant
   (minus the recipe's `lagTradingSessions`) is invisible at that instant; shifting a row's
   availability past the instant removes it from the decision. A return observation is consumed
   only for the session after the decision.
2. **Membership is an interval, not a snapshot.** A name entering the universe is eligible from
   `fromTimestampMs`; a name leaving is sold at the last available price on the session of exit; a
   `delisted` exit applies `delistingReturn` to the last position value and books the residual as
   cash (a `trade.fill` at the implied price, so the ledger holds the fact). A delisted name with
   no `delistingReturn` is a refusal, never a silent survivor
   (`backtest.delisting_return_missing`).
3. **Revisions.** Multiple observations of one instrument at one `asOf` resolve to the latest
   `availableTimestampMs` at or before the instant (the research package's version-resolution law,
   echoed in assumptions).
4. **Current universe is an explicit lie.** `universe: 'current'` (a static list) is accepted only
   when named, is recorded in assumptions as `survivorshipBiased: true`, and adds the
   `survivorshipWarning` diagnostic from `@totalfinance/risk`.

## Decision 4 — `crossSectionalBacktest`

The declarative one-line path; callbacks are an explicit, non-replayable escape hatch.

```ts
const run = crossSectionalBacktest({
  dataset: {
    observations, // UniverseObservation[] — features with availableTimestampMs
    fieldDefinitions, // FieldDefinition[] — declared, never inferred
    returns, // ReturnObservation[] — per instrument per session (research's type)
    benchmarkReturns?, // ReturnObservation[] for one benchmark id, or
    classification?, // Record<instrumentId, InstrumentClassification> (sector, asset class…)
    averageDailyVolumes?, // Record<instrumentId, number> for the liquidity constraint
    betas?, // Record<instrumentId, number> for beta-neutral targets
  },
  universeHistory,
  signal:
    | { factorRecipe: FactorRecipe } // research's versioned recipe (canonical or caller-authored)
    | { score: { components: ScoreComponent[]; missingValuePolicy } } // scoreUniverse
    | { screen: { filter: ScreenFilter; orderBy: ScreenOrdering[]; missingValuePolicy } } // screenUniverse
    | { callback: (context: SignalContext) => SignalRow[] }, // direct TypeScript; replayable: false
  rebalanceSchedule: {
    frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly';
    session: 'open' | 'close';
    bufferBand?: number; // hold a current name while its rank stays within the band (hysteresis)
  },
  portfolioConstruction: {
    method: 'equal-weight' | 'score-weight' | 'inverse-volatility' | 'risk-budget' | 'supplied-weights';
    long: { topQuantile: number } | { count: number } | { fraction: number };
    short?: { bottomQuantile: number } | { count: number } | { fraction: number };
    neutrality?: 'none' | 'dollar' | 'sector' | 'beta' | 'factor'; // long/short only
    neutralizeAgainst?: { field: string }; // factor-neutral: research's neutralizeFactor
    maximumPositions?: number;
    maximumPositionWeight?: number;
    minimumPositionWeight?: number;
    maximumTurnover?: number; // fraction of NAV per rebalance; the trim is reported, never silent
    maximumParticipation?: number; // fraction of averageDailyVolume per name per rebalance
    volatilityLookbackSessions?: number; // inverse-volatility / risk-budget
    riskBudgets?: Record<string, number>; // risk-budget weights
    suppliedWeights?: (context: WeightContext) => Record<string, number>; // optimizer escape hatch
  },
  execution?: ExecutionPolicy, // Decision 7; default `execution.simplified()`
  transactionCostModel?: { commission?: CostModelSpec; slippage?: SlippageModelSpec }, // declarative
  initialCapital?: number, // default 1_000_000
  baseCurrency?: string, // default 'USD'
  window?: { fromTimestampMs?: EpochMs; toTimestampMs?: EpochMs },
  periodsPerYear?: number, // default 252
  seed?: number, // seeds the bootstrap confidence intervals of the performance block; absent = none
});
```

Semantics, each an acceptance law:

- **Decision instant = rebalance session.** At each scheduled session the engine calls
  `universeMembershipAt`, `eligibleObservationsAt`, then exactly one research verb (`scoreUniverse`,
  `screenUniverse`, or the recipe's `winsorizeFactor → standardizeFactor → neutralizeFactor →
compositeFactorScore` chain), then `formQuantilePortfolios` for quantile selection. The engine
  contains no ranking, tie, or missing-value code of its own; ties resolve to `instrumentId`
  ascending because research does that.
- **Target formation** produces weights; `neutrality: 'dollar'` scales the short book to the long
  book's gross; `'sector'` balances long and short within each classification group;
  `'beta'` scales the short book so the weighted beta is zero; `'factor'` neutralizes the target
  weights against `neutralizeAgainst.field` through `neutralizeFactor`. Infeasible neutrality (an
  empty side) is a `violated` goal in the rebalance row, not a relaxed one.
- **Weights → quantities** is `allocatePortfolio` with inline targets, the session's prices, lot
  size 1, and the run's cash reserve; dust, rounding, and residual cash are its rows, echoed.
- **Orders → fills** go through the execution policy (Decision 7) observing the session's price
  (open or close per `session`); fills become `NormalizedFill`s, then events, then state.
- **Delistings and removals** exit at the exit session per Decision 3 before new targets form.
- **Attribution.** Per rebalance: `informationCoefficient` of the signal against the next-period
  return, the realized long/short spread (`factorSpreadReturn`), `factorTurnover` against the prior
  selection, breadth and coverage; over the run: `factorDecay` across horizons 1, 3, 6, 12
  rebalances. Benchmark: active return, `trackingError`, `informationRatio`, `beta`
  (`@totalfinance/performance`). All by calls, none by copies.
- **Result.** `{ rebalances: RebalanceRow[]; points: EquityPoint[]; returns: number[]; holdings:
HoldingsRow[] (per rebalance per name: weight, quantity, score, rank, reason); trades: Trade[];
fills: NormalizedFill[]; ledger: PortfolioLedgerSnapshot; timeline: PortfolioTimelineResult;
attribution; benchmark: BenchmarkComparison | null; performance: PerformanceSummary;
finalValue: number; assumptions: CrossSectionalAssumptions; diagnostics: Diagnostics }` — the
  ledger's final NAV equals `finalValue` and the last timeline row within 1e-9.

**The grid.** `crossSectionalBacktestGrid({ request, variations: [{ path: 'portfolioConstruction.long.count',
values: [20, 50, 100] }, …], maximumVariations? })` runs the cartesian product as independent
single runs with unchanged semantics (the same function, called), returns every run's summary
metrics, and composes the research-hygiene verdicts from `@totalfinance/risk` — `researchProtocol`
over the trial Sharpes, `probabilityOfBacktestOverfitting` over the per-variation return matrix,
`deflatedSharpeRatio` for the best trial — verbatim into `hygiene`. Walk-forward and purged CV
over a cross-sectional run compose through the existing `walkForward` and `purgedKFold` by slicing
the dataset's session index; the grid records the parent sweep hash and each child run hash so one
artifact holds the whole protocol (FC8 "without duplicated math").

## Decision 5 — `optionsBacktest` over a position book

The identity, request keys, and result envelope stay; the engine's single `open` slot becomes a
book, and the deferred items become fields:

```ts
optionsBacktest({
  chains, marking, initialCapital, riskFreeRate, dividendYield, // unchanged
  entry: EntryRule | EntryRule[], // each rule may carry an `id`; `when: 'flat'` means "this rule has no open position"
  exit, roll, hedge, commission, slippage, assignment, periodsPerYear, // unchanged
  book?: {
    maximumOpenPositions?: number; // default 1 — the shipped behavior, so existing callers change nothing
    maximumPerUnderlying?: number;
  },
  limits?: {
    maximumMarginFraction?: number; // optionsMargin of the whole book ≤ fraction × equity
    maximumNetDelta?: number; // |Σ delta × multiplier × contracts| in underlying units per underlying
    maximumNetVega?: number;
    maximumConcentration?: number; // fraction of equity in one underlying's structures (premium at risk)
    scenarioLoss?: { spotShocks: number[]; volatilityShocks: number[]; maximumLossFraction: number }; // taylorPnl / scenarioGrid over the book
  },
  fillPolicy?: {
    mode: 'combo' | 'legged'; // default 'combo'
    partialFill: 'reject' | 'allow'; // default 'reject'
    price?: PriceSource; // per-leg fill side; default 'mid'
  },
  quoteFreshness?: { maximumQuoteAgeMs: number }, // a quote older than this at asOf is 'stale' (marking's cause reused for fills)
  corporateActions?: CorporateAction[], // core's record; splits adjust strike and multiplier with lineage
  dividends?: { underlying: string; exDate: string; amount: number }[], // early-assignment and dividend-risk evidence
});
```

- **First-class calendars and diagonals.** `structure: 'calendarCallSpread' | 'calendarPutSpread' |
'diagonalCallSpread' | 'diagonalPutSpread' | 'doubleDiagonal'` with
  `select: { shortDelta; nearDaysToExpiry; farDaysToExpiry; width? }`, built through
  `@totalfinance/strategy`'s existing constructors. The multi-expiry lifecycle is explicit: when the
  near leg expires it settles at intrinsic and the far leg keeps marking; `roll.when` applies per
  leg-group; the trade closes when every leg is closed.
- **Limits are pre-trade gates, evaluated on the post-trade book**, through `optionsMargin`,
  `aggregateGreeks`, and `taylorPnl`/`scenarioGrid` from `@totalfinance/risk`; a breach rejects the
  entry with a `limitRejections` row naming the limit and the values — nothing is scaled silently.
- **Combo versus legged fills.** `combo` fills all legs at the selected price side in one instant
  or rejects the entry when any leg lacks a usable quote (`backtest.combo_leg_unfilled`);
  `legged` fills legs in the order given, each leg independently, and `partialFill: 'allow'`
  records a partially built structure with the unfilled legs named and the position's actual legs
  used for marking, margin, and limits. Rejections are rows, not warnings.
- **Intraday.** `asOf` carries time; two snapshots within one day are two decision instants;
  `quoteFreshness` refuses fills on stale quotes exactly as marking refuses stale marks. A
  deterministic intraday fixture is in the exit gate.
- **Corporate-action lineage.** A split (or reverse split) on the underlying adjusts every open
  leg's strike and multiplier (OCC style: the deliverable changes, the position's economic exposure
  does not) and records `{ lineageId, action, previous, adjusted }` on the trade; the ledger sees a
  `derivative.multiplier-change`. Symbol changes rename with lineage; mergers and spin-offs are
  refused for open option legs with a teaching error naming the unsupported action.
- **Assignment, exercise, and dividend-risk evidence.** Every settlement row carries
  `action`, `early`, `reason`, and, for early assignment on ex-dividend, the dividend versus the
  extrinsic value that triggered it; each open short call reports `dividendRisk: { exDate, dividend,
extrinsic, atRisk }` in its snapshot diagnostics when a dividend is within the leg's life.
- **Volatility-surface evolution and mark provenance.** The result gains
  `surface: { asOf, atTheMoneyVolatilityByExpiry: Record<expiry, number>, skew25Delta?: number,
markSources: TradeMarkCounts }[]` per snapshot (bounded by the snapshot count), and every trade
  keeps its P1 mark counts and exit volatilities. Nothing about marking policy changes (P1 held).
- **The ledger.** The book emits `trade.fill`, `cost.charge`, `option.exercise/assignment/expiration`,
  and `derivative.multiplier-change` envelopes with option instrument ids built by
  `@totalfinance/core`'s OCC symbology; `result.ledger` folds them and `finalValue` reconciles to it.
  `points`, `trades`, `settlements`, `performance` keep their shapes; `assumptions` gains `book`,
  `limits`, `fillPolicy`, `quoteFreshness`.

## Decision 6 — `portfolioBacktest`: the ledger-backed multi-asset simulator

```ts
const run = portfolioBacktest({
  accounting: {
    baseCurrency: 'USD',
    initialCash: [{ currency: 'USD', amount: 1_000_000 }],
    lotRelief?: LotReliefPolicy, // default 'fifo'
    settlement?: Record<AssetClass, 'T+0' | 'T+1' | 'T+2'>, // default: equities T+1, options T+1, everything else T+0
  },
  instruments: Record<string, InstrumentSpecification>, // Decision 6a
  marketData: {
    bars?: Bar[]; quotes?: Quote[]; trades?: Trade[]; orderBooks?: OrderBook[];
    optionChains?: ChainSnapshot[]; // marks and fills for option instruments
    fxRates?: CurrencyPairQuote[]; // dated; required when any instrument's currency ≠ baseCurrency
    fundingRates?: { instrumentId; timestampMs; rate }[]; // perpetuals
    corporateActions?: CorporateAction[]; dividends?: DividendRecord[]; coupons?: CouponRecord[];
  },
  strategy:
    | { model: ModelPortfolio | AllocationTarget[]; schedule: RebalanceSchedule; policy?: InvestmentPolicy } // declarative: FC7 proposal on a schedule
    | { onSession: (context: SessionContext) => OrderIntent[] }, // direct TypeScript; replayable: false
  execution?: ExecutionPolicy, // Decision 7
  externalFlows?: { timestampMs: EpochMs; amount: number; currency: string }[], // contributions (+) and withdrawals (−)
  calendar?: string, // an @totalfinance/calendars exchange id for sessions and settlement days
  window?: { fromTimestampMs?; toTimestampMs? },
  periodsPerYear?: number,
  seed?: number,
});
```

**6a — instruments and adapters.** `InstrumentSpecification = { kind: 'equity' | 'etf' | 'option' |
'future' | 'fx-forward' | 'crypto-spot' | 'crypto-perpetual' | 'bond' | 'custom'; currency;
contractMultiplier?; contract?: DerivativeContractTerms; assetClass; classification?; adapter?:
InstrumentAdapter }`. Each kind has a built-in adapter (`instrumentAdapters.<kind>`); `'custom'`
requires one. The adapter is a small structural interface:

```ts
interface InstrumentAdapter {
  readonly kind: string;
  readonly version: string;
  /** The mark for the position at the instant from the supplied observations, or a typed unavailability. */
  mark(
    input: MarkInput,
  ): { pricePerUnit: number; source: string } | { unavailable: MissingMarkCause };
  /** Lifecycle facts that occur at the instant (a coupon, a funding payment, an expiry) as FC7 events. */
  lifecycle(input: LifecycleInput): PortfolioEventEnvelope[];
  /** How a fill for this instrument settles (the fill's settlementStyle/multiplier/contract). */
  fillTerms(
    spec: InstrumentSpecification,
  ): Pick<NormalizedFill, 'settlementStyle' | 'contractMultiplier' | 'contract'>;
}
assertInstrumentAdapterConformance({ adapter, fixtures }); // pure/deterministic/finite/JSON-safe/event-envelope-valid
```

Built-in lifecycles (each a golden journey reconciling P&L in the exit gate):

| Kind               | Marks from                                                                                                                                                                                             | Lifecycle events emitted                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `equity`, `etf`    | bars/quotes                                                                                                                                                                                            | `income.received` (dividend), `corporate.stock-split`, `symbol-change`, `merger`, `spin-off`, `cash-in-lieu`                                      |
| `option`           | chain quotes (P1 marking policy)                                                                                                                                                                       | `option.exercise/assignment/expiration` at intrinsic, `derivative.multiplier-change` on splits                                                    |
| `future`           | bars/quotes                                                                                                                                                                                            | `derivative.variation-margin` daily, `derivative.roll` at the declared roll session, expiry settlement                                            |
| `fx-forward`       | forward points from `fxRates` (`convertCurrency` / forward pricing from `@totalfinance/foreign-exchange` is NOT imported — the caller supplies the forward rate series; the adapter marks and settles) | `cash.conversion` at maturity                                                                                                                     |
| `crypto-spot`      | bars/quotes                                                                                                                                                                                            | none (a spot asset)                                                                                                                               |
| `crypto-perpetual` | bars/quotes                                                                                                                                                                                            | `financing.charge` (`funding-payment`) or `income.received` (`funding-receipt`) at each funding instant; forced liquidation per the margin policy |
| `bond`             | clean price bars; accrued from the coupon terms                                                                                                                                                        | `income.received` (coupon), accrued interest on fills, `fixed-income.redemption` at call/maturity                                                 |
| `custom`           | the adapter                                                                                                                                                                                            | the adapter                                                                                                                                       |

**6b — sessions (September causal correction).** The simulator iterates the union of observation
timestamps inside the window in ascending order; a `calendar` restricts instants to sessions and
settles cash on settlement days. The required sequence at each observation is:

1. **Pre-open facts:** apply corporate actions and dividend entitlements to the eligible pre-trade
   holdings, plus external flows and settlements available before execution. Do not fold facts
   derived from this observation's close into the earlier opening account.
2. **Previously queued orders:** execute eligible decisions from an earlier observation against
   the next fresh observation, applying pre-fill buying power, costs and settlement commitments
   sequentially. Earlier-open fills cannot spend later-close derivative proceeds or use that
   close's valuation to increase opening buying power.
3. **Post-open lifecycle and valuation:** after the opening fills, apply close-derived derivative
   lifecycle facts, including expiry/settlement and variation-margin cash flows, with their declared
   timing; fold events, apply the declared maintenance-liquidation policy, and value the account.
4. **Next decision:** expose the completed observation and post-fill/post-lifecycle state to the
   strategy. Its orders first execute on a later observation. The final observation processes
   outstanding eligible orders and lifecycle/valuation but requests no new strategy decision.

Corporate/dividend entitlements must not move after trading merely to delay close-derived
derivative cash. Likewise, option expiry profits computed from a bar's close cannot finance a
purchase at that bar's earlier open. The trading environment retains exactly one observation of
delay. This contract's pre-open/post-open split is covered by R01/R02 regressions and the local
full-coverage gate; the September review repairs are locally verified complete. That local evidence
does not authorize publication or claim hosted-matrix success.

**6c — result.** `{ ledger: PortfolioLedgerSnapshot; timeline: PortfolioTimelineResult; pnl:
PortfolioPnlResult; orders: OrderRecord[]; fills: NormalizedFill[]; rejections: RejectionRow[];
events: PortfolioEventEnvelope[]; valuationMarks: PortfolioValuationMark[]; performance;
finalValue; assumptions; diagnostics }` — the ledger's final NAV equals `finalValue` and the last
timeline valuation.

## Decision 7 — pluggable execution reality

`@totalfinance/backtest/execution` defines the policy every new engine consumes:

```ts
interface ExecutionPolicy {
  label: string; // echoed in assumptions
  realism: 'simplified' | 'declared'; // 'simplified' is the default and says so
  observation: 'bar' | 'quote' | 'trade' | 'order-book'; // what fills read
  fill: FillModel; // market, limit, stop, stop-limit, market-on-open, market-on-close, combo
  ambiguity: 'optimistic' | 'pessimistic' | 'deterministic-path' | 'reject'; // intrabar order of touches
  costs: { commission: CostModel; slippage: SlippageModel; spread?: SpreadModel; marketImpact?: MarketImpactModel; latency?: LatencyModel; participation?: number; borrow?: BorrowModel };
  staleQuotes: { maximumAgeMs: number | null; behavior: 'reject' | 'fill-at-last' };
  lockedCrossed: 'reject' | 'fill-at-mid';
  sessions?: { halts?: HaltWindow[]; priceLimits?: PriceLimitWindow[]; auction?: 'ignore' | 'open-close-only' };
  partialFills: 'allow' | 'reject';
  queue?: { model: 'none' | 'depth-approximation' };
  timeInForce: { default: 'day' | 'gtc'; expireAtSessionClose: boolean };
  margin: { buyingPowerMultiplier: number; initialMarginRate: number; maintenanceMarginRate: number; forcedLiquidation: 'none' | 'close-largest-loss' | 'pro-rata' | ForcedLiquidationModel };
}
execution.simplified(): ExecutionPolicy; // label 'simplified: market at open/close, limit and stop on touch, full fills, no impact, no latency, no borrow'
execution.declared(policy: Partial<ExecutionPolicy> & { label: string }): ExecutionPolicy; // every omitted member is the simplified one, and the label must be caller-supplied
assertFillModelConformance({ fillModel, fixtures }); // determinism, side/price monotonicity, never fills outside the observation's range, JSON-safe decisions
```

- **Ambiguity is a decision, not a default.** When a bar could have touched a stop and a limit (or
  a bracket's two legs) in either order, `optimistic` fills the favorable leg, `pessimistic` the
  unfavorable, `deterministic-path` walks open → (low, high in the order implied by the close's
  side) → close, and `reject` refuses the run at that bar with `backtest.ambiguous_intrabar` naming
  the bar and orders. The chosen policy is in assumptions; the count of ambiguous bars is in
  diagnostics.
- **Observation kinds.** A `bar` policy fills market orders at the open (or the close for
  market-on-close), limit/stop orders on touch; a `quote` policy fills at bid/ask by side and
  refuses when the quote is stale, locked, or crossed per the policy; an `order-book` policy walks
  levels for the quantity (`queue.model: 'depth-approximation'`) and reports the average price and
  the levels consumed.
- **Costs.** Commission and slippage reuse `@totalfinance/backtest/costs` models and the declarative
  specs the operations already accept; `spread` (half-spread by side), `marketImpact`
  (`{ model: 'square-root'; coefficient; averageDailyVolumes }`), `latency` (`{ sessions: n }` —
  the order is worked from the n-th following observation), `participation` (fraction of the
  observation's volume), `borrow` (annual rate on short notional) are new small models with labels.
- **Margin and forced liquidation.** Buying power is checked pre-trade; maintenance margin is
  checked after every fold; a breach under `forcedLiquidation` closes positions per the model with
  `backtest.forced_liquidation` rows (never a silent sale) or, under `'none'`, records the breach
  and continues.
- **Sessions.** Halts refuse fills in their windows; price limits clamp fills to the band and
  record the clamp; auction handling is declared.
- **The default is honest.** A run without `execution` uses `execution.simplified()`;
  `assumptions.execution = { label, realism: 'simplified', … }` and the README says so. No
  default claims exchange realism.

## Decision 8 — reproducible run artifacts and comparison

`@totalfinance/backtest/artifacts` reuses the Stage 4.5 grammar: an `AnalysisArtifact` with
`artifactType: 'totalfinance.backtest-run'`, `producedBy.operation` the verb, bulk row sets embedded or
referenced by `TableHandle` (Decision 9 there), and content-addressed identity.

```ts
type BacktestRunKind = 'cross-sectional' | 'cross-sectional-grid' | 'options' | 'portfolio';
backtestRunArtifact({ kind, run, input, referenceRowSets?, locators?, hygiene?, snapshotHash?, libraryVersion?, createdFrom?, provenance?, limits? }): AnalysisArtifact;
readBacktestRun(artifact, { tables? }): { report: BacktestRunReport; … };
replayBacktestRun(artifact, { tables }): { run; runHash; matches: boolean; differences }; // re-runs the verb from the recorded input; refuses when replayable is false
compareBacktestRuns({ left, right, limits? }): BacktestRunComparison; // metric deltas, holdings membership deltas, rebalance-by-rebalance turnover/cost deltas, capped lists
```

The report records, verbatim, the FC8 list: strategy/recipe and its version; the dataset identity
(every bulk row set as a table handle with `contentHash` and `rowCount`), universe id and history
hash, point-in-time policy; conventions and calendar; the engine and every execution/accounting
model's `label` and `version`; seed, parameters, costs, benchmark, annualization; orders, fills,
rejections, events, marks, trades, settlements, and diagnostics as tables; the parent sweep hash and
child hashes (grid); `runHash` = `contentHash` of the canonical run; `execution: { completed: true }`
— cooperative checkpoint/resume of a long run is a Stage 7B item together with loop-level
cancellation (Stage 7A Decision 5), and the artifact's shape reserves the field so the format does
not change when it lands.

## Decision 9 — bounded synchronous work

Every verb is synchronous, validates before allocation, and refuses unsafe work:

| Limit                                    | Default   | Hard maximum | Refusal                    |
| ---------------------------------------- | --------- | ------------ | -------------------------- |
| observations, returns, bars, quotes rows | none      | `5_000_000`  | `backtest.input_too_large` |
| chain snapshots × quotes                 | none      | `2_000_000`  | `backtest.input_too_large` |
| grid variations                          | `256`     | `4_096`      | `backtest.grid_too_large`  |
| open positions (options book)            | `1`       | `10_000`     | `backtest.book_too_large`  |
| instruments (portfolio)                  | none      | `50_000`     | `backtest.input_too_large` |
| artifact embedded rows / bytes           | Stage 4.5 | Stage 4.5    | Stage 4.5's codes          |

Counts follow the count-safety law. The transports keep their own row caps (`capRows`, 5,000 rows
per bulk field) and hand larger inputs to the job runner through handles, as Stage 7A decided.

## Decision 10 — failure behavior and stable codes

Registered in `@totalfinance/core`'s code registry in slice 1:

| Code                                    | Kind    | When                                                                                     |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `backtest.look_ahead_refused`           | refusal | an input row would be read after its availability (a fixture proves the guard)           |
| `backtest.universe_membership_unknown`  | refusal | a return or feature names an instrument the universe history never lists                 |
| `backtest.delisting_return_missing`     | refusal | a `delisted` exit with no `delistingReturn` while a position is open                     |
| `backtest.ambiguous_intrabar`           | refusal | the `reject` ambiguity policy meets an ambiguous bar                                     |
| `backtest.stale_quote`                  | refusal | `staleQuotes.behavior: 'reject'` meets a stale quote at a fill                           |
| `backtest.combo_leg_unfilled`           | row     | a combo entry could not fill every leg (the entry is rejected; the run continues)        |
| `backtest.limit_rejected`               | row     | a portfolio limit rejected an entry (limit and values named)                             |
| `backtest.margin_breach`                | warning | maintenance margin breached under `forcedLiquidation: 'none'`                            |
| `backtest.forced_liquidation`           | row     | a forced close under the declared model                                                  |
| `backtest.ledger_reconciliation_failed` | refusal | emitted events do not fold to the reported equity (an engine invariant — never a number) |
| `backtest.grid_too_large`               | refusal | Decision 9                                                                               |
| `backtest.book_too_large`               | refusal | Decision 9                                                                               |
| `backtest.input_too_large`              | refusal | Decision 9                                                                               |
| `backtest.adapter_nonconformant`        | refusal | an instrument adapter or fill model fails its conformance suite when supplied            |
| `backtest.unsupported_corporate_action` | refusal | a merger/spin-off on an open option leg                                                  |
| `backtest.not_replayable`               | refusal | `replayBacktestRun` on an artifact whose run used a callback                             |

Every refusal names the field, the instant, and the corrected minimal call; every row-kind entry is
also counted in `diagnostics`.

## Decision 11 — operations and transports

`@totalfinance/workflows`' opt-in `backtestPack` gains `totalfinance.backtest.cross_sectional_run` and
`totalfinance.backtest.portfolio_run` (cost class `job`, declarative inputs only — callbacks are
SDK-only, exactly as `options_run` treats `when`), and `totalfinance.backtest.options_run`'s input
schema gains `book`, `limits`, `fillPolicy`, `quoteFreshness`, `corporateActions`, `dividends`.
Each lands in its own adapter/parity slice after the engine slice (the queue's rule), with: the
operation definition composing the verb verbatim, `tools/transport-parity/fixtures.ts` canonical
and malformed fixtures, a packed-consumer case, the MCP tool's derived annotations, the OpenAPI
document regenerated, and the manifest row's `mcpTools` link. Bulk row sets above the transport's
row cap travel by handle. The `optionsBacktest` operation's existing fixtures keep passing
unchanged (D18).

## Decision 12 — determinism, immutability, provenance

No engine reads a clock; every instant is an input. No engine mutates a caller array, observation,
event, or configuration (Stage 4.4b's `snapshotClosedRecord` reads every input once). Every result
and artifact is JSON-safe and deeply finite; undefined metrics are `null` with a reason. `seed`, when
given, seeds only the bootstrap confidence intervals; the engines themselves are deterministic and
the property suites prove permutation invariance. Provenance flows: the dataset's `Provenance`, the
recipe's version, every model's label/version, and the ledger's `sourceId` survive into the run,
the artifact, the operation result, and every transport.

## Ordered implementation slices

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Shared contracts: `NormalizedFill` + `portfolioEventsFromFill` (portfolio); `UniverseHistory`, `universeMembershipAt`, `eligibleObservationsAt` (research); `@totalfinance/backtest/execution` — the policy, `simplified`/`declared`, the fill models for every order type over bar/quote/order-book observations, ambiguity policies, spread/impact/latency/participation/borrow, sessions, margin hooks, the conformance suite; the codes; the dependency edges and the package-graph row. | fill → events → fold reconciles; permutation invariance of same-instant events; every fill model passes conformance; ambiguity fixtures (four policies, one bar); `pnpm run ci` |
| 2     | `crossSectionalBacktest`: eligibility, the three signal forms + callback, target formation with every neutrality, weights → `allocatePortfolio`, execution, ledger emission, attribution, benchmark; README snippet; manifest rows; first-touch fixtures.                                                                                                                                                                                                                                    | a hand-computed three-name, four-rebalance fixture reconciling NAV to the ledger; look-ahead and delisting fixtures; survivorship warning; `pnpm run ci`                        |
| 3     | `crossSectionalBacktestGrid` + hygiene composition; `@totalfinance/backtest/artifacts` for the cross-sectional kinds (artifact/read/replay/compare); operation `cross_sectional_run` + parity fixtures + packed case.                                                                                                                                                                                                                                                                        | replay equals run hash; comparison fixture; grid verdicts equal direct `researchProtocol`/`probabilityOfBacktestOverfitting`; parity 5 surfaces; packed                         |
| 4     | `optionsBacktest` over a book: multiple/overlapping positions, portfolio limits, first-class calendars/diagonals, combo/legged fills, intraday freshness, corporate-action lineage, assignment/dividend evidence, surface summary, ledger emission; `options_run` schema extension + parity + packed; artifact kind `options`.                                                                                                                                                               | the exit gate's options row fixtures (vega P&L held from P1, overlapping positions, multi-expiry, combo/legged, margin/risk limits); existing P1 fixtures unchanged             |
| 5     | `portfolioBacktest`: instruments and the eight built-in adapters, the adapter conformance suite, lifecycle events per kind, external flows, settlement, margin/forced liquidation, timeline/P&L; artifact kind `portfolio`.                                                                                                                                                                                                                                                                  | one golden journey per lifecycle kind reconciling P&L to the ledger (1e-9); the FC7 replay equality law; forced-liquidation fixture; `pnpm run ci`                              |
| 6     | Operation `portfolio_run` + parity + packed; cross-engine property suites (no-look-ahead, permutation invariance, fill models on stale/gaps/partials/cancel/reject/corporate actions/sessions); walk-forward and purged CV over the new engines; performance budgets measured; `docs/guides/backtesting.md`; closeout — FC8 exit gate ticked, trackers to `COMPLETE @ <commit>`, Stage 4.7 next.                                                                                             | every exit-gate row closed with its test named; the whole-repository gate; the second all-green pass                                                                            |

Each slice lands as one commit (tests, generated evidence, its record here), followed by a records
commit that names the hash; fetch/fast-forward before every push; never force.

## Slice records

### Slice 1 (landed 2026-09-03, `23e9a3ca2`) — the shared contracts

**What landed.** `@totalfinance/portfolio` gains the audited bridge: `NormalizedFill` (the closed
execution-fact shape every simulator, replay, paper, and later live adapter produces),
`requireNormalizedFill` (the guard in the envelope guard's `(functionName, label, value)` order),
`NORMALIZED_FILL_KEYS`, and `portfolioEventsFromFill` — one `trade.fill` plus one `cost.charge` per
non-zero cost component in a fixed order, with ids derived from the fill so a replayed fill folds once
and every envelope passes the same validator a hand-written one does. `@totalfinance/research` gains the
point-in-time vocabulary the simulators read: `UniverseHistory` / `UniverseMember` (half-open
membership intervals with exit reasons and delisting returns), `requireUniverseHistory`,
`universeMembershipAt` (members at an instant; additions and exits against a previous instant), and
`eligibleObservationsAt` (availability at or before the cutoff — an explicit lag counted in the
caller's session index, never calendar days — the latest version per instrument, universe members
only when a history is given). The three screening verbs now delegate to the same internal resolver
(`point-in-time.ts`), so eligibility has one implementation. `@totalfinance/backtest/execution` is the
pluggable execution reality: `execution.simplified()` (the honest default whose label names every
member; `realism: 'simplified'`) and `execution.declared()` (every member validated under a label
the caller signs); `fillModels.bar()` (the shipped broker's touch rules verbatim, with halts, price
limits, and participation), `fillModels.quote()` (side, freshness — named or refused with
`backtest.stale_quote` — locked/crossed at mid or refused), `fillModels.orderBook()` (level walking
with the average price and levels consumed); `orderTouchSequence` (the four intrabar ambiguity
policies; `reject` refuses with `backtest.ambiguous_intrabar` naming the orders); the spread,
square-root impact, and latency models beside the re-exported cost factories; the margin policy and
its two pure helpers; `assertFillModelConformance` (determinism, immutability on the fixture's own
objects, price within the observation, quantity within the order, finite JSON-safe decisions;
refuses with `backtest.adapter_nonconformant` naming the check); `normalizedFillFromDecision`
(the glue to the portfolio-owned fill); `describeExecutionPolicy` (the JSON-safe projection every
result will echo). Three codes registered in core. The backtest package depends on `portfolio` and
`research` (build references, lockfile), the package-graph test carries a ratified
`@totalfinance/backtest` row (no `scenarios` edge), the signature policy retains the two positional
guards as core infrastructure, the vitest alias and export map carry `./execution`, and every new
head has its manifest row and first-touch fixture.

**Decisions at landing.**

1. **The resolver is internal, not public**: `resolveLatestAvailableObservations(observations,
cutoff, addExclusion)` is a three-positional callback helper — the wrong shape for a public
   identity — so it lives in `point-in-time.ts` and both the verbs and `eligibleObservationsAt`
   import it; the public surface is the two named-object verbs.
2. **`barTriggerPrice` takes one named object** (`{ order, bar }`), the D8 shape, rather than two
   positionals; the bar model and the shipped broker agree on every archetype by test.
3. **The conformance suite hands the model the fixture's own objects** so a mutation is observable;
   the first draft passed clones and a mutating model slipped through — caught by the suite's own
   test before landing.
4. **Combo orders are not a fill-model order type**: a multi-leg order is decided leg by leg by the
   options engine's fill policy (slice 4) through the same models.
5. **Every head validates its whole closed input through shared guards** (`requireOrderIntent`,
   `requireFillDecision`, `requireMarketObservation`, `requireFillContext`, `requireExecutionPolicy`,
   `requireMarginPolicy`, all public on the subpath): the first enforcement measurement of the
   module returned `defective 6` — nested fields accepted `null` where omission was meant, unknown
   keys passed, positional labels went unchecked — and every one was fixed at its source rather
   than ledgered. `execution.declared` treats a present `null` as a refusal and hands the assembled
   policy to the same guard the engines apply, so the declared and simplified paths share one law.

6. **A fill model's `fill` takes one request object** (`{ order, observation, context }`): the
   signature-conformance gate (Law 14) refused the three-positional method on the public interface,
   and the D8 shape is the better API anyway — a custom model destructures what it reads.
7. **Four bundle budgets moved from measurements**: `@totalfinance/research` 22.75 → 24.75 KB (the
   universe vocabulary is root surface by the ownership row), `totalfinance` 572 → 575 KB, and
   `@totalfinance/fixed-income/lattice` / `@totalfinance/commodities` by 0.25 KB each because the three
   central `ErrorCode` registrations reach every entrypoint that imports the registry (~40 B gzip
   apiece); every note carries the measured bytes and the new headroom.

**Evidence.** `pnpm run ci` exit 0 at the landing tree (477 test files, 10,261 tests — 45 new across the three suites plus the guard refusals); `pnpm api:check` exit 0; the second `pnpm test:coverage` pass recorded with the push. The chain regenerated clean in order (signature → naming → contract → enforcement `defective 0` over 5,222 candidates → validation → API reports → READMEs → `llms.txt` → bundle → OpenAPI → docs), every live closeout cell refreshed (34,561 naming identities), and `pnpm exec vitest run tools` green (54 files, 3,057 tests). The bar model agrees with the shipped `SimulatedBroker` on eleven order archetypes by test; the fill bridge folds to the same ledger state as hand-written events and folds once on replay; the universe helpers share the screening verbs' resolver by test.

**Gate findings at landing.** The first enforcement measurement of the module returned `defective 6` (nested null / unknown-key / wrong-type acceptance on the new heads) — fixed at the source with the shared guards; the second returned `defective 0` over 5,222 candidates, unmeasured 182 (unchanged). The signature-conformance gate (Law 14) refused `FillModel#fill` with three positionals — the interface now takes one request object. Four bundle budgets moved from measurements (Decision 7 of this record). The fixture/contract join pin moved 1,175 → 1,203 (the new heads and guards). The declared-coverage residual list gained twenty-four rows: the fill callback's return union cannot be built into a named `unfilled` arm by the builder (the fixture model decides `filled`), so eight reasons × three heads are unmeasured by construction and exercised directly in the execution suite. `pnpm build` initially failed on `structuredClone` (packages compile with `types: []`; the root typecheck passed) — replaced by a typed JSON clone.

### Slice 2 (landed 2026-09-03, `7b7d67c13`) — `crossSectionalBacktest`

**What landed.** `@totalfinance/backtest/cross-sectional` (the verb re-exported from the package root as
its first call): a returns dataset with point-in-time observations, a universe history, one signal
(a research `FactorRecipe` run through `winsorizeFactor` / `standardizeFactor` / `neutralizeFactor`
/ `compositeFactorScore`; a `scoreUniverse` score; a `screenUniverse` screen whose order is the
ranking; or a direct callback that is not replayable), a rebalance schedule (daily / weekly /
monthly / quarterly at the open or the close, with a buffer band), and a portfolio construction
(quantile / count / fraction selection on each side through `formQuantilePortfolios`; equal,
score, inverse-volatility, risk-budget (`riskParity` over `covariance`), or supplied weights;
dollar / sector / beta / factor neutrality; position, weight, turnover, and participation caps —
every trim a reported goal, never silent). At each rebalance session: `universeMembershipAt`
(exits sell at the last level; a delisting exits at its delisting return or refuses with
`backtest.delisting_return_missing`), `eligibleObservationsAt` with the recipe's lag through the
session index, the signal, selection, weights, `allocatePortfolio` (signed target weights and an
explicit cash target; the short book is the same allocator with negative targets), the execution
policy's fill model on a synthetic session bar with the policy's spread, impact, and commission,
`normalizedFillFromDecision` → `portfolioEventsFromFill` → `applyPortfolioEvents`. Every session
marks the ledger; `portfolioTimeline` is the equity curve, `analyze` (with the benchmark option)
is the performance block, `informationCoefficient` / `factorSpreadReturn` / the selection
turnover / rank-IC decay over one to four rebalances are the attribution, `monteCarloResample`
is the seeded confidence block. The reported final value must equal the ledger's NAV at the last
mark or the run refuses (`backtest.ledger_reconciliation_failed`). Prices are return-index levels
(base 100 at each instrument's first session), session instants are a stated convention, and each
session is marked at the following midnight — the ledger's mark law — so a mark holds its
session's fills. Four codes registered; the README's first example is now this call.

**Decisions at landing.**

1. **A returns dataset, not prices**: the research vocabulary (`ReturnObservation`) is the input,
   prices are return-index levels, and the assumptions say so. `portfolioBacktest` (slice 5) is
   the price-based engine.
2. **The mark follows the ledger's law** — a mark dated D values events strictly before 00:00 UTC
   of D — so each session's mark is dated the next calendar day; the first draft dated marks on
   the session and valued every book before its own fills (caught by the reconciliation test).
3. **After the exits, the book is read again** before selection, weights, and the allocator; the
   first draft handed the allocator the pre-exit holdings and sold departed names twice (caught
   by the delisting fixture).
4. **Risk-budget weights are equal risk contributions** (`riskParity`); custom per-name budgets
   would be a second solver and are not offered.
5. **The short book is the same allocator with negative targets**, not a mirror computation.
6. **Six bundle budgets moved from measurements**: `totalfinance` 575 → 594 KB (the umbrella re-exports
   the backtest root, which now carries the engine and its guard — measured 607,224 B), and five
   entrypoints by 0.25 KB each (`options/black-scholes`, `core/artifacts`,
   `technical-analysis/rsi`, `fixed-income/convertible`, `foreign-exchange`) because the four
   central code registrations reach every entrypoint that imports the registry (~80 B gzip apiece);
   six more sit within 130 B of their budgets for the same reason, and the next registration will
   move them — the cost is recorded, not hidden.

**Evidence.** `packages/backtest/test/cross-sectional.test.ts` (nine tests: the hand-computed
three-name universe over eight sessions with two monthly rebalances reconciling the final value to
the ledger's NAV and the last timeline row; a feature that becomes available after the decision
instant is invisible to it; a delisting exits at its delisting return or refuses without one; a
removed name is sold; the benchmark block and the research attribution are present; every
construction goal is reported; a recipe, a screen, and a callback all rank and the callback is
not replayable; two runs are byte-identical; every malformed request teaches). `pnpm run ci`:
478 test files, 10,273 tests green (the naming baseline and the API reports regenerated in the
same commit); a second full `pnpm test:coverage` green; `pnpm api:check` exit 0; the whole
tools-gate run 3,060 tests green after the declared-coverage rows below; enforcement 5,225
candidates, 0 defective.

**Gate findings at landing.** Four gates found real defects, each fixed at the source:

1. **codes-conformance**: the engine emitted `backtest.data_missing` for a benchmark session absent
   from the benchmark series before the code existed — registered as a `WarningCode`
   (`BacktestDataMissing`), never a free-text literal.
2. **internal-signature-conformance**: the internal `executeTrade` took three numeric positionals
   (index, quantity, reference price) — now one request object, the same law the public surface
   keeps (Law 14).
3. **count-safety-sweep**: `portfolioConstruction.short.count` was a declared resource coordinate
   no executable fixture materialized; a `#long-short` fixture variant is not enumerated by the
   sweep, so the primary fixture is now a dollar-neutral one-long / one-short book and the sweep
   mutates the coordinate.
4. **fixture-validation**: the declaration ↔ fixture join moved 1203 → 1205 (the verb and its
   request guard), pinned deliberately with the reason on the line.

### Slice 3 (landed 2026-09-04, `f38f7da24`) — the grid, the run artifacts, the operation

**What landed.** `crossSectionalBacktestGrid` on `@totalfinance/backtest/cross-sectional` (re-exported
from the root): the cartesian product of declarative variations (dotted paths under `signal`,
`rebalanceSchedule`, `portfolioConstruction`, `execution`, `transactionCostModel`, `initialCapital`,
`riskFreeRate`; the dataset, the universe, the window, the annualization, and the seed are the same
for every point) run as independent calls of `crossSectionalBacktest` — every child equals its
direct run byte for byte — with the research-hygiene verdicts composed verbatim from
`@totalfinance/risk`: `researchProtocol` over the best trial with the pool of trial Sharpes,
`deflatedSharpeRatio` for the best trial, `probabilityOfBacktestOverfitting` over the periods ×
variations return matrix; bounded by `maximumVariations` (default 256, ceiling 4,096,
`backtest.grid_too_large`); the sweep hash over the axes and every child run hash. Hygiene a grid
cannot compute is `null` with its reason in `diagnostics.skippedHygiene`, never a number.
`@totalfinance/backtest/artifacts`: `backtestRunArtifact` / `readBacktestRun` / `replayBacktestRun` /
`compareBacktestRuns` over the kinds `cross-sectional` and `cross-sectional-grid` on the Stage 4.5
spine (`artifactType: 'totalfinance.backtest-run'`): the run verbatim with bulk row sets of the request
AND the run embedded or referenced by `TableHandle` (`dataset.returns`, `run.ledger.events`,
`run.holdings`, `run.runs`, …), callbacks recorded and omitted, execution and cost models recorded by
`describeExecutionPolicy` and label, the run hash (`contentHash` of the stored projection), the FC8
identity list, `execution: { completed: true }` reserved; replay takes the live models back as
`models` and verifies each against its recorded description before the run; comparison reports the
performance block name by name (tolerance-aware), final-holding membership, rebalance-by-rebalance
turnover and cost deltas, per-variation deltas and whether the best moved (grids), the hygiene
verdict, and the structural run diff. `totalfinance.backtest.cross_sectional_run` in the opt-in
`backtestPack` (cost class `job`, `handleFields: ['dataset']`): the three declarative signal forms,
the construction without `supplied-weights`, a declared execution policy over session bars
(`execution.declared` from spread / impact / latency / participation / commission / slippage
specs), declarative cost models; parity on five surfaces; the packed-consumer artifact journey now
runs a backtest artifact in Node, a worker, and a browser bundle; OpenAPI regenerated; the manifest
row's `mcpTools` link.

**Decisions at landing.**

1. **`baseline` / `candidate`, not `left` / `right`**: the contract's `compareBacktestRuns({ left,
right })` is `{ baseline, candidate }` — the comparison grammar every other `compare*` verb
   speaks (`compareAnalysisArtifacts`, `compareResearchRuns`, `compareFittedModels`); one vocabulary.
2. **`artifact.not_replayable`, not `backtest.not_replayable`**: the contract's code for a callback
   run is the registry's existing `ArtifactNotReplayable` — one code for one condition across every
   artifact family; `backtest.not_replayable` was not registered.
3. **Models by description, taken back at replay**: an execution policy and a cost model carry
   functions no artifact can store, so the artifact records `describeExecutionPolicy(policy)` and the
   models' labels; `replayBacktestRun` takes the live models as `models` and refuses when a supplied
   model's description or label differs from the recorded one (`backtest.adapter_nonconformant`); the
   simplified default is rebuilt without help. The description is the disclosed identity — a
   declared policy's session rules are counted, not compared member by member.
4. **Run identities are full content hashes**: `runId` (and the grid's `sweepId`) are
   `contentHash(...)` strings, not a 16-character prefix; the artifact's `runHash` is a second,
   distinct identity — the hash of the stored run, recomputed on every read.
5. **A single-variation grid is a pre-registered hypothesis**: `researchProtocol` runs without a
   pool (trial count 1) and the deflation is skipped with its reason; `deflatedSharpeRatio` needs
   two trials and is not faked with one.
6. **Degenerate trial Sharpes are 0 by a stated convention** (fewer than three periods or zero
   variance), counted in `degenerateTrialCount`, and warned per variation; the best trial being
   degenerate skips the protocol rather than deflating a number that does not exist.
7. **The grid's `runs` are returned whole** (index-aligned with `variations`); a caller who saves
   a grid references `run.runs` by handle when the sweep is large — the embedded-row law applies to
   the run's bulk row sets exactly as to the request's.

**Evidence.** `packages/backtest/test/cross-sectional-grid.test.ts` (nine tests: the product in nested order
with every child byte-equal to its direct run; the hygiene verdicts equal to the direct
`researchProtocol` / `deflatedSharpeRatio` / `probabilityOfBacktestOverfitting` calls; the selection
metric and the hygiene knobs; a degenerate series skipped with its reason; a single variation as a
pre-registered hypothesis; the ceiling; every malformed axis; a child's refusal named; no mutation
and determinism), `packages/backtest/test/run-artifacts.test.ts` (nine tests: save → JSON → read →
replay to the same run hash; referenced row sets refused without their rows and restored verified;
models recorded by description and taken back verified; a callback run non-replayable by name;
hygiene attached and the comparison's metrics, holdings, rebalances, and structural diff; the grid's
whole protocol in one artifact and replayed; two grids compared variation by variation; foreign,
tampered, mixed-kind, and malformed inputs), the operation on five surfaces
(`tools/transport-parity.test.ts` with the canonical and malformed fixtures; registry/HTTP/CLI/MCP
counts moved 35 → 36 and 25 → 26), the packed-consumer artifact journey now carrying a backtest
artifact byte-identically in Node, a worker, and a browser bundle (41 packed tests green). `pnpm run
ci`: 480 test files, 10,297 tests green (the contract inventory regenerated in the same commit);
`pnpm api:check` exit 0; enforcement 5,232 candidates (2,411 enforced · 2,639 partial · 0 defective ·
182 unmeasured); the whole tools-gate run 3,066 tests green after the findings below.

**Gate findings at landing.** Seven gate findings, each fixed at the source:

1. **count-safety-sweep**: `compareBacktestRuns` declared `diagnostics.runWarningCount` on a report
   the fixture never materialized (the fixture passed artifacts) — the primary fixture now passes
   reports and `requireReport` validates every count as a non-negative safe integer; the artifact
   verb's stored REQUEST counts are classified magnitudes (validated by the verb's own guard, which
   `backtestRunArtifact` now calls before storing — an artifact stores only a request the verb
   accepts).
2. **enforcement**: `compareBacktestRuns` accepted a report whose `assumptions.conventionsVersion`
   / `inputPolicy` were null or mistyped (1 defective) — `requireReport` now types every assumption
   and identity member and cross-checks `replayable` ↔ `nonReplayableField` and `inputPolicy` ↔
   `referencedData`.
3. **conformance**: `BACKTEST_RUN_KIND_LIST` is a frozen array — manifest kind `value`, not `object`.
4. **fixture-validation**: the declaration ↔ fixture join moved 1205 → 1211 (the grid, its guard,
   the four artifact verbs), pinned with the reason.
5. **union-checker-parity**: `readBacktestRun` / `replayBacktestRun` take a function-membered
   migrations registry (UNDESCRIBED_ALLOWLIST rows with the reason); `backtestRunArtifact#0(input).run`
   is `RunOf<Kind>`, a distributive template the artifact records erased
   (UNINSTANTIATED_GENERIC_PARAMETER_ROUTES).
6. **registry / MCP / HTTP / CLI counts**: 35 → 36 operations and 25 → 26 tools, pinned in
   `registry.test.ts`, `server.test.ts` (MCP and HTTP), `preview-gate.test.ts`, `bin.test.ts`,
   `jobs.test.ts`; the MCP and CLI guides name the operation.
7. **contract-conformance**: the inventory drifted when the guard calls were added — regenerated in
   the landing commit.

### Slice 4 (landed 2026-09-04, `9948cc3e2`) — `optionsBacktest` over a position book

**What landed.** The single open slot is a book. `entry` is one rule or `rules` several (each with an
`id`; `when: 'flat'` = the rule has no open trade, `'always'` = whenever the book has room, a
predicate sees `openTrades`); `book` bounds the open trades (default 1 — every existing request runs
unchanged; ceiling 10,000, `backtest.book_too_large`) and the trades per underlying; `limits` are
pre-trade gates on the post-trade book through `optionsMargin`, `aggregateGreeks`, and
`scenarioGrid` (margin fraction, net delta, net vega, concentration, scenario loss) — a breach is a
`limitRejections` row naming the limit, the value, and the bound (`backtest.limit_rejected`), nothing
is scaled; `fillPolicy` fills a structure as one combo (every leg or a `fillRejections` row,
`backtest.combo_leg_unfilled`) or leg by leg (`partialFill: 'allow'` holds the filled legs, the trade
is `partial` and names its `unfilledLegs`); `quoteFreshness` refuses a stale fill as marking refuses a
stale mark; calendars, diagonals, and double diagonals are first-class structures built through
`@totalfinance/strategy`'s constructors (the near leg by delta, the far leg by days) and every leg
settles at its own expiry (`legSettlements`); `corporateActions` adjust open legs OCC-style with
`lineage` (`derivative.multiplier-change` in the ledger; symbol changes rename; a merger or spin-off
on an open leg refuses, `backtest.unsupported_corporate_action`); `dividends` are `dividendRisk`
evidence per open short call before an ex-date and, under `assignment: 'model'`, early assignment
(`early: true, reason: 'dividend'`; deep-in-the-money short puts by carry, `reason: 'deep-itm'`);
`surface` rows per snapshot (ATM volatility per expiry, the 25-delta skew, this snapshot's mark
sources, the dividend-risk rows); every fill, hedge, settlement, and adjustment is a portfolio event —
`result.ledger` and `result.timeline` — and the equity at every mark equals the ledger's NAV within
1e-6 or the run refuses. `runId` is the request's content hash; `requireOptionsBacktestConfig` is the
exported guard. `totalfinance.backtest.options_run` takes `book`, `limits`, `fillPolicy`,
`quoteFreshness`, `corporateActions`, `dividends`, the `rules` book, and the calendar structures; the
existing parity fixtures pass unchanged; the run artifacts gain the `options` kind (chains,
corporate actions, and dividends as row sets; every rule's callbacks recorded by name; the cost
models by label, taken back at replay as `models.labeled`).

**Decisions at landing.**

1. **Nothing changes for an existing caller** (D18): one rule, `book.maximumOpenPositions: 1`,
   combo fills, no limits, expiry-only assignment — the P1 fixtures pass unchanged; the new result
   fields are additive.
2. **Legged fills are a usability sequence, not a price path**: the legs are checked in structure
   order against the current quotes' selected side and freshness; the first unusable leg stops the
   sequence. A leg-by-leg price evolution within one snapshot would be a second market model.
3. **Concentration is premium at risk** (Σ |entry premium| of the underlying's open trades) — the
   simplest stated measure; margin and scenario loss carry the tail.
4. **A settled leg's P&L is realized at its settlement** (`settledPnl`), the live legs keep marking,
   and the trade's `pnlExplain` covers the live legs — the settled P&L and the entry edge join
   `unexplained`, so the sums stay invariant.
5. **The ledger marks once per calendar date** (the last snapshot of a day), so intraday snapshots
   are decision instants without a second mark law; the timeline needs two marks and is `null` for
   a shorter run.
6. **Early assignment is the writer's counterparty decision**: only short legs are assigned early;
   long legs exercise at expiry.
7. **`rules?: EntryRule[]` beside `entry?: EntryRule` (exactly one), not `entry: EntryRule |
EntryRule[]`**: the generated closed-request spec is a projection of the declaration and cannot
   express an object-or-array union at one field (the projector took the array arm and refused
   every existing request), and a nested rule-book object put the entry union one level deeper than
   the contract walk records (the union-parity gate saw truncated arms). A top-level `rules` keeps
   every entry arm validated by the same spec at the same depth as `entry`, and reads as what it is.
8. **The variant cap moved from a measurement**: the rule book lifted `optionsBacktest` to 182
   declared alternatives (over the 176 cap set from the FC7 envelope); `VARIANT_LIMIT` is 288, ~1.6×
   the new widest, with the measurement in the doc comment.

**Evidence.** `packages/backtest/test/options-book.test.ts` (eleven tests: the default book runs the P1
credit-spread program unchanged and reconciles to the ledger it now emits; determinism and OCC
settlement symbols; overlapping trades to the book's capacity with a per-underlying cap; two rules
each seeing the book through a predicate; a put calendar settling its near leg and keeping the far
leg; diagonals and the double diagonal; combo rejection of a stale short leg and a legged partial
fill holding the long leg; two snapshots in one day as two decision instants with one ledger mark;
the margin-fraction, net-delta, concentration, and scenario-loss limits each naming their bound; a
reverse split adjusting open legs with lineage and `derivative.multiplier-change` in the ledger, a
merger refused; dividend-risk evidence and an early assignment under the model; the surface rows;
every malformed request), `packages/backtest/test/options-artifact.test.ts` (the `options` artifact
kind: save → read → replay with the live cost models taken back and verified → compare; a build
callback non-replayable by name), the P1 suites `options-backtest.test.ts` and
`options-marking.test.ts` unchanged and green, the transport suites (workflows, MCP, HTTP, CLI,
parity — 247 tests; the packed-consumer artifact journey now carries an options-book run). `pnpm
run ci`: 482 test files, 10,314 tests green; `pnpm api:check` exit 0; enforcement 5,232 candidates
(2,411 enforced · 2,639 partial · 0 defective · 182 unmeasured); the whole tools-gate run green
after the findings below; budgets `@totalfinance/backtest/artifacts` 130 → 180 KB (179,329 B),
`@totalfinance/workflows` 372 → 382 KB (387,285 B), `@totalfinance/portfolio` 85 → 85.25 KB (87,046 B).

**Gate findings at landing.** Eight gate findings, each fixed at the source:

1. **validation-specs**: the projected closed-request spec cannot express `entry: EntryRule |
EntryRule[]` (it took the array arm and refused every existing request) — `rules?` is a
   top-level field beside `entry?`, exactly one given; `contract:update` must precede
   `validation:update` after a declaration change (the projector reads the inventory).
2. **union-checker-parity**: a nested rule-book object (`entry: { rules }`) put the entry union one
   level deeper than the contract walk records (75 checker arms against a truncated artifact) —
   the top-level `rules` sits at the same depth as `entry` and the gate agrees again.
3. **variant-measurement**: the rule book lifted `optionsBacktest` to 182 declared alternatives,
   over the 176 cap — measured with the cap lifted (`enumerateVariants` at 100,000 over the
   inventory), `VARIANT_LIMIT` is 288 (~1.6× the widest) with the measurement in the doc comment.
4. **declared-coverage**: forty-two `optionsBacktest` rows — the optional `entry` and `rules`
   gates on every entry arm, the same optional-argument gate limitation as the earlier rows.
5. **fixture-validation**: the join moved 1211 → 1212 (`requireOptionsBacktestConfig`).
6. **count-safety-sweep**: `optionsTearSheet` receives a whole result — its diagnostics, ledger,
   timeline, surface, and rejection counts are facts of the run, classified magnitudes.
7. **internal-signature-conformance**: `tradeUnderlying` and `tryEnter` carried three numeric
   positionals — one request object each.
8. **P1 regression caught by the existing suite**: a settlement close that settled legs before
   marking left the greek explain empty (`delta` 0 on a directional fixture) — the close marks the
   whole position first, then settles; the ledger's expiration events must carry the contract's
   expiry instant (a per-snapshot event clock that only moves forward); the per-mark NAV is read
   from the current state when the mark is recorded (the final state cannot value earlier marks);
   strategy stock legs are in shares.

### Slice 5 (landed 2026-09-04, `7d0d090ff`) — `portfolioBacktest` and the instrument adapters

**September review correction (Decision 6b is normative; supersedes the historical loop description below):** decisions
see completed observations and post-fill state; their orders first execute on a later observation.
The final observation processes pending execution/lifecycle and valuation without a new decision.
Pre-open corporate/dividend entitlements and available flows precede opening fills; close-derived
derivative settlements follow them and cannot finance those earlier fills. That split is locally
verified by the R01/R02 regressions and full-coverage gate. Entry buying power includes costs, existing exposure and
unsettled commitments, with no implicit currency funding under the cash default. Dividends,
coupons, redemption and forward maturity follow signed holdings; bond accrual uses the
fixed-income package's calendar/day-count implementation. The exact regression gate is
[`review-september-2026-repairs.md`](./review-september-2026-repairs.md), and the current user
contract is in [`the backtesting guide`](../guides/backtesting.md#portfolio-timing-and-funding).

**What landed.** `@totalfinance/backtest/portfolio` (the verb re-exported from the root): the
ledger-backed multi-asset simulator. Decision instants are the observation timestamps inside the
window (a named calendar — `NYSE`, `CBOE`, `ALWAYS_OPEN` — keeps business days and counts
settlement days); at each instant, in order: every held instrument's lifecycle facts through its
adapter (dividends, coupons, funding, corporate actions, expiries, rolls, maturities — each an FC7
event payload the engine envelopes), external flows, marks (an unmarkable held instrument refuses
`backtest.mark_unavailable`), the strategy (a model or inline targets on a schedule through
`proposePortfolioRebalance` over the ledger state and a market snapshot of the marks, or a direct
`onSession` callback), orders through the execution policy (the instrument's observation of the
policy's kind, the policy's costs, the adapter's fill terms, the accounting's settlement lag, a
bond's accrued interest), the margin check (`maintenanceMarginBreached` over the gross notional;
forced liquidation `pro-rata` or `close-largest-loss` through the same execution, rows and
`backtest.forced_liquidation`; `none` warns `backtest.margin_breach`), and one valuation mark per
calendar date. The equity IS the ledger's NAV; `timeline`, `pnl`, `performance` are the portfolio
and performance packages' reports over it. Eight built-in adapters (`instrumentAdapters.*`: equity,
etf, option, future, fx-forward, crypto-spot, crypto-perpetual, bond) and
`assertInstrumentAdapterConformance` for a caller's own; `accruedFromTerms`, `splitShares`, the
four guards, three ceilings. The run artifacts gain the `portfolio` kind.

**Decisions at landing.**

1. **Adapters return event PAYLOADS, the engine envelopes them** (ids, the source, the instant) —
   an adapter cannot know an event id; the contract's "as FC7 events" is honoured at the payload.
2. **An fx-forward is a cash-on-trade instrument whose fill settles at maturity**: the entry fill
   books the notional at the contract rate with `settleTimestampMs` = maturity (NAV unaffected, the
   cash unsettled until then), the forward-rate series marks it, and at maturity a closing fill at
   the contract rate plus a `cash.conversion` deliver the base-currency notional — the FX gain lives
   in the foreign cash valued through the dated quotes. The FC7 grammar has no forward; this is the
   honest composition of what it has.
3. **Bond accrued interest comes from the coupon terms alone** (ACT/365F or 30/360 in the adapter):
   `@totalfinance/fixed-income` is not a dependency of the backtest package and the contract's "accrued
   from the coupon terms" needs no bootstrap.
4. **Perpetual funding follows the sign law** — a positive rate is paid by longs and received by
   shorts — on the position's notional at the mark; both legs are FC7 events.
5. **Forced liquidation is bounded** (eight rounds per instant) and `pro-rata` trims every position
   by `shortfall / grossNotional`; `close-largest-loss` closes the largest unrealized loss first.
6. **Calendar ids are the calendars package's names**, not MIC codes (there is no `XNYS` in the
   workspace); an unknown name refuses.
7. **`fxRates` are dated** (`DatedCurrencyPairQuote`): FC5's `CurrencyPairQuote` carries no instant,
   and a valuation needs the quote at or before the mark.

**Evidence.** `packages/backtest/test/portfolio-backtest.test.ts` (thirteen tests: a model on a schedule and a
direct strategy each reconciling to the ledger; the golden journeys — an equity through a dividend,
a split, and T+2 settlement; an option assigned at expiry; a future through variation margin, a
declared roll, and expiry; crypto spot beside a perpetual paying and receiving funding; an fx-forward
marked on the forward series and converted at maturity with the foreign cash valued through dated
quotes; a bond through coupons, accrued interest, and redemption; a caller's adapter proven by the
conformance suite and run like a built-in; external flows kept out of returns; the margin check
under `none`, `pro-rata`, and `close-largest-loss`; every malformed request including an option
whose contract vanishes from the chain), `run-artifacts.test.ts` widened to the `portfolio` kind,
the transport suites unchanged (247 tests). `pnpm run ci`: 483 test files, 10,331 tests green;
`pnpm api:check` exit 0; enforcement 5,238 candidates (2,412 enforced · 2,644 partial · 0 defective
· 182 unmeasured); the tools gates 54 files, 3,070 tests green after the findings below.

**Gate findings at landing.** The first regeneration chain measured
`accruedFromTerms`, `adapterFor`, and `assertInstrumentAdapterConformance` DEFECTIVE (three rows;
unknown keys, nulls, wrong types, and non-finite instants accepted) — the drafts had left the three
helpers without boundary guards. Fixed by extracting `requireCouponTerms` from the specification
guard and calling it at the accrual boundary (with a finite `asOf`), routing `adapterFor` through
`requireInstrumentSpecification`, and giving the conformance suite its own key, shape, and
`accrued` checks; eight refusal tests appended; the second chain measured `defective 0`. The
conformance suite's mutation and determinism checks hash a fixture through `fixtureBytes`, which
projects a custom adapter to its identity — `canonicalJsonOf` refuses functions, and the caller's
adapter IS a function bundle. The run-artifact kind table test was widened to the fourth kind (its
invalid-enum probe now names a kind that does not exist). The built-in adapters are typed through
`Object.freeze<InstrumentAdapter>` so their callbacks are contextually typed. The margin-policy
fixture had `initialMarginRate` below the maintenance rate, which `execution.declared` rightly
refuses; the fixture now declares 0.5/0.5. Budgets: `@totalfinance/backtest/portfolio` 100 KB
(99,744 B), `@totalfinance/backtest/artifacts` 180 → 202 KB (203,696 B, the portfolio kind bundles the
engine), `totalfinance` 600 → 612 KB (623,192 B). The tools gates then named seven more findings, each closed
at its cause: `@totalfinance/performance/sharpe` 8.25 → 8.5 KB (the two new WarningCodes ride the
central registry every entry carries; measured 8,461 B); the fixture/contract join 1,212 → 1,221
(nine new joins); `InstrumentAdapter#accrued|input` on the union-parity allowlist (a callback
argument the engine constructs); the naming queue refused three short names — `FundingRateRecord.rate`
→ `fundingRate`, `ForwardRateRecord.rate` → `forwardRate`, `adapterFor(spec)` → `specification` —
and `etf` joined the canonical tokens as the instrument kind's own name; and the declared-coverage
gate recorded 135 built-versus-named rows for the optional function-membered `adapter` on a
specification (the builder cannot make a synthesized callback return named nested branches; the
adapter is proven by the conformance suite at runtime).

### Slice 6 (landed 2026-09-04, `839a955e7`) — `portfolio_run`, the out-of-sample verbs, the property suites, the guide, the closeout

**What landed.** `totalfinance.backtest.portfolio_run` in the opt-in backtest pack with declarative
inputs only (accounting, built-in instrument kinds, every market-data row set through the row cap,
a model or inline targets on a schedule, the declared execution policy, flows, a calendar, a
window) — a strategy callback and a custom adapter are SDK-only; parity fixtures on all five
surfaces, the count pins (37 operations, 27 tools), the guides, and a portfolio run in the
packed-consumer artifact journey. `crossSectionalWalkForward` and `crossSectionalPurgedFolds` on
`@totalfinance/backtest/cross-sectional` (re-exported from the root): each training span runs the grid
and its selection metric chooses a variation, the choice runs once on the held-out span, the
held-out per-session returns are stitched in window order and summarized by `analyze`; the folds
are `purgedKFold` over the session index with its purge gap and embargo (two-segment training
spans pooled into one return series), and every window records its training sweep ids and its
held-out run id for replay through the artifacts. `packages/backtest/test/engine-properties.test.ts`
proves, on every engine, no look-ahead (a later feature, a later restatement, a later bar), byte-identical
results under shuffled inputs, the named simplified execution policy, and the FC7 replay law
(the emitted events fold to the reported equity). `tools/backtest-fill-shape.test.ts` scans the
package's exports for the ledger's vocabulary and holds the allowlist to requests, decisions,
policies, and report rows. The reconciliation tolerance of the options and portfolio engines is
1e-9. `docs/guides/backtesting.md` names the three engines, when to use which, the laws, the
artifacts, the operations, and the out-of-sample verbs.

**Decisions at landing.**

1. **"Training" a declarative strategy means choosing a variation** — the engines fit nothing, so
   walk-forward and purged folds compose the grid's selection on the training span and the engine on
   the held-out span; the grid's own hygiene verdicts remain the in-sample story and the stitched
   held-out series is the out-of-sample one. No new statistic was invented: the report carries the
   per-window train and test metrics, their means, the degradation, and the negative-test fraction.
2. **A window is the engine's `window`** cut at the dataset's session instants (the session-instant
   convention mirrored, not re-derived); a held-out span never overlaps a training span, and a fold's
   training sessions exclude its block, its purge gap, and its embargo exactly as `purgedKFold` says.
3. **A training segment under two sessions is dropped with `input.degenerate`**, never padded; a
   fold with no usable segment is skipped and counted; a plan with no evaluable window refuses.
4. **Pooled training segments are one return series** (`analyze({ returns })`), so every selection
   metric works across a two-segment fold without a per-metric special case.
5. **Custom adapters stay off the wire** — an adapter is behavior; the wire strategy is a model on a
   schedule and an `onSession` string is `input.unknown_field`.
6. **The reconciliation law is 1e-9** on the options and portfolio engines (the cross-sectional
   engine already held it): the ledger and the equity are the same numbers, so the earlier 1e-6 was
   slack, not tolerance.
7. **The out-of-sample requests carry the grid's members inline** (`request`, `variations`,
   `maximumVariations`, `selectionMetric`, `hygiene`, then the plan) rather than a nested `grid`:
   one object in the shape a grid call already takes, one fewer level for the caller, and the
   cross-sectional request stays at the depth the declaration walker records (its field tree stops
   four levels down, and the count-safety sweep must see every `count` a fixture materializes).
8. **The performance-budget row of the exit gate stays open by the maintainer's standing
   decision** (perf/WASM/benchmarks deferred, §1.4 of the TotalFinance programme): the bundle budgets
   are measured at every commit; runtime budgets ship with the deferred acceleration work.

**Evidence.** `packages/backtest/test/cross-sectional-folds.test.ts` (eight tests: rolling windows tile the
sessions with every choice a direct grid run and every held-out run a direct engine call; anchored
spans and a custom step; a restatement after a window's training span never reaches that window's
choice and shows only in the later window's outcome; determinism and an untouched base request;
purged folds equal `purgedKFold`'s split with the purge gap honoured and two-segment training
spans pooled; a segment under two sessions dropped with a warning; every malformed request
including a starved purge and a null mode), `engine-properties.test.ts` (no look-ahead on the
cross-sectional and portfolio engines, permutation invariance on all three, the named execution
policy, the FC7 replay law on all three), `tools/backtest-fill-shape.test.ts` (the ledger-vocabulary
allowlist and every engine result's `fills: NormalizedFill[]`), the transport suites with
`portfolio_run` (workflows, MCP, HTTP, CLI, parity), the packed-consumer journey with a portfolio
artifact, the runnable guide and the two first-call examples. `pnpm run ci`: 486 test files, 10,359
tests green; `pnpm api:check` exit 0; enforcement 5,244 candidates (2,412 enforced · 2,644 partial ·
0 defective · 182 unmeasured); the tools gates 55 files, 3,080 tests green after the findings below;
budgets `@totalfinance/workflows` 382 → 405 KB (410,809 B), `totalfinance` 612 → 615 KB (625,782 B).

**Gate findings at landing.** The property suite named three engine gaps before the tools
gates ran: `OptionsBacktestResult` carried no `fills` (its fills lived only in the ledger's events)
— it now exposes `fills: NormalizedFill[]` like the other two engines and the options artifact kind
gains the `fills` row set; the options and portfolio run ids hashed the request's rows in INPUT order,
so a shuffled request produced a different identity while the engines produced the same run — both
now hash each row set in its canonical order (a snapshot's quotes by contract and print time; the
portfolio's rows by instant and instrument), and the permutation-invariance rows became byte-exact;
the folds verbs had mirrored the cross-sectional session-instant convention with the wrong close hour
— the engine now exports `sessionInstant` and the verbs import it, so no convention is re-derived.
The cross-sectional run id is the REQUEST's identity by its slice-2 design (configuration and session
span, not the rows), so the restatement law is proven on the held-out OUTCOME, never on an id. The
transport suites fail against a stale `dist` (the CLI job worker rebuilds its registry from the
built packages): `pnpm build` precedes the transport suites after any engine change. `purgedKFold`
refuses a gap that empties a training set before the verbs can — the starved-fold test follows its
words. Budgets: `@totalfinance/workflows` 382 → 405 KB (410,809 B; the pack bundles the portfolio
engine), `totalfinance` 612 → 615 KB (625,782 B; the out-of-sample verbs). Enforcement then measured the walk-forward rows DEFECTIVE twice: first the fixture's baseline was
refused — a grid axis varying `rebalanceSchedule.session` moved the session instants outside a
window cut at the CLOSE instants, so `windowOf` now runs from the first session's open to the last
session's close and the fixtures moved to an eight-session dataset where every window chooses and
runs; then `mode: null` was accepted as the rolling default (`??`) — the guard now treats only
`undefined` as absent and refuses `null` with the enum, proven by a test. The tools gates then named the count-safety sweep: with the grid nested under
`grid`, the fixtures' `portfolioConstruction.long.count` sat one level below the declaration walker's
four-level field tree, so the sweep saw a materialized count with no declaration — Decision 7 above
(the grid's members inline) put the request back where the walker reads it; `pooledMetric` took its
five parameters as a request object (the internal-signature law); the alias-group probe ratio
re-seated 33 → 34 (the two verbs carry the deepest backtest contract one level deeper, the same
numerator class as every earlier re-seat, the umbrella spellings inheriting); the fixture/contract
join 1,221 → 1,225; the guide's first call dropped its symbol-keyed literals (the docs naming
inventory reads object keys in a fence as fields).

### Completion record (2026-09-04, `839a955e7`)

Stage 4.6 closed at `839a955e7` after its six ordered slices landed from the accepted contract and the
full repository gate, `api:check`, and the packed consumers passed at that commit. The exit gate
below is ticked row by row with the test that closes it; the one open row is the performance
budget, held by the maintainer's standing deferral of acceleration work. Stage 4.7 (FC9 integration
and the core freeze) is the next dependency-ready row.

## Acceptance and exit gate

The FC8 backtesting exit gate, verbatim, each row closed by a named test at a named commit:

- [x] No-look-ahead tests cover signals, point-in-time fundamentals, universe membership,
      normalization, event timestamps, current-chain marks, and revised data —
      `engine-properties.test.ts` "no look-ahead" (a feature published after the instant, a later
      restatement, a later bar or dividend), `cross-sectional.test.ts` (availability, membership,
      standardization inside the eligible set), `options-marking.test.ts` (current-chain marks) @ `839a955e7`.
- [x] A single event stream reduces to identical portfolio state in historical simulation and direct
      FC7 replay — `engine-properties.test.ts` "the emitted events fold to the reported equity",
      every engine @ `839a955e7`.
- [x] Multi-asset results are invariant to same-timestamp input ordering where policy says order is
      irrelevant — `engine-properties.test.ts` "permutation invariance", three engines @ `839a955e7`.
- [x] Portfolio-grade options tests prove current-implied-volatility vega P&L, overlapping
      positions, multi-expiry lifecycle, combo/legged fills, and portfolio margin/risk —
      `options-marking.test.ts` (P1), `options-book.test.ts` (overlaps, calendars and diagonals,
      combo/legged, the four limits) @ `9948cc3e2`.
- [x] Cross-asset golden journeys cover each supported lifecycle and reconcile P&L —
      `portfolio-backtest.test.ts` (equity dividend + split + T+2, option assignment at expiry, future
      variation margin + roll + expiry, crypto spot + perpetual funding, fx-forward maturity, bond
      coupon + accrued + redemption, a custom adapter), each reconciled @ `839a955e7`.
- [x] Fill models prove stale data, gaps, ambiguous bars, partial fills, cancellation, rejection,
      corporate actions, and session boundaries — `execution-policy.test.ts` and the conformance
      suite (`assertFillModelConformance`) over the policy models; `options-book.test.ts` (stale
      quotes, partial legged fills, corporate actions); `portfolio-backtest.test.ts` (the calendar
      and settlement lags) @ `839a955e7`.
- [x] Point-in-time delisting/restatement fixtures prevent survivorship and revision leakage —
      `cross-sectional.test.ts` (a delisting mid-run), `engine-properties.test.ts` (a restatement
      with a later `availableTimestampMs`) @ `839a955e7`.
- [x] Walk-forward, purged/embargoed CV, PBO, deflated Sharpe, multiple-testing correction, and
      parameter comparisons compose into one research artifact without duplicated math —
      `cross-sectional-folds.test.ts` (each choice equals the direct grid run, each held-out run the
      direct engine call), `cross-sectional-grid.test.ts` (the hygiene verdicts equal the direct
      `@totalfinance/risk` calls), `run-artifacts.test.ts` (the grid artifact) @ `839a955e7`.
- [x] Existing `vectorized`, `eventDriven`, and `optionsBacktest` packed examples remain green —
      `tools/packed-consumer.test.ts` @ `839a955e7`.
- [ ] Performance budgets separate small direct runs, broad vectorized grids, event simulation, and
      worker/Arrow paths; acceleration ships only after measurement and parity — OPEN by the
      maintainer's standing deferral of acceleration work (TotalFinance §1.4); the bundle budgets are
      measured at every commit (`tools/bundle-size/budgets.test.ts`).

Contract-specific rows:

- [x] Every engine's `finalValue` equals its ledger's base-currency NAV and its last timeline
      valuation within 1e-9, on every fixture (Decision 2) — the engines refuse above 1e-9
      (`backtest.ledger_reconciliation_failed`); `expectReconciled` in `portfolio-backtest.test.ts`,
      `options-book.test.ts`, `cross-sectional.test.ts`, and the packed journey @ `839a955e7`.
- [x] `NormalizedFill` is the only fill shape any engine produces; `@totalfinance/backtest` defines no
      fill, cash, lot, or P&L type of its own (Decision 2; a source-scan test) —
      `tools/backtest-fill-shape.test.ts` @ `839a955e7`.
- [x] The default execution policy is `simplified`, named in every result's assumptions; no run
      claims realism it did not declare (Decision 7) — `engine-properties.test.ts` "every engine
      names the simplified default and its label": the cross-sectional and portfolio engines echo
      `execution.simplified()`'s description; the options engine, which fills through its own
      declared fill policy, names that policy and its price source @ `839a955e7`.
- [x] Every new public identity is in the manifest, the naming and signature inventories, the
      enforcement record (`defective 0`), the first-touch fixtures, the API reports, the generated
      READMEs and `llms.txt`, and the bundle budgets, at every slice commit — the tools gates at
      every slice commit (`23e9a3ca2`, `7b7d67c13`, `f38f7da24`, `9948cc3e2`, 7d0d090ff, `839a955e7`).
- [x] `totalfinance.backtest.cross_sectional_run`, `portfolio_run`, and the extended `options_run` pass
      transport parity on all five surfaces and the packed-consumer cases (Decision 11) —
      `tools/transport-parity.test.ts`, the workflows/MCP/HTTP/CLI suites, `tools/packed-consumer.test.ts` @ `839a955e7`.
- [x] Nothing in `vectorized`, `eventDriven`, or the `SimulatedBroker` changed behavior; their
      tests and packed examples are byte-identical in outcome (D18) — their suites unchanged and
      green at every slice commit; the packed examples @ `839a955e7`.

## Review record (self-review against the laws, 2026-09-03)

- **No second engine** — every ranking, allocation, margin, Greek, stress, performance, and
  accounting number is a call into the package that owns it; the source-scan row of the exit gate
  makes the promise executable.
- **One obvious first call** — `crossSectionalBacktest({ dataset, universeHistory, signal: { factorRecipe },
rebalanceSchedule, portfolioConstruction })` is the README's first example, and it works with the
  canonical `value` recipe and no execution policy (which then says `simplified`).
- **No plausible wrong answers** — look-ahead, delisting without a return, ambiguous bars under
  `reject`, stale quotes, unfilled combo legs, limit breaches, and reconciliation failures are
  refusals or named rows, never numbers.
- **Preserve the shipped engines** — `optionsBacktest` defaults to `maximumOpenPositions: 1`, so
  every existing caller's result is unchanged; `vectorized` and `eventDriven` are untouched.
- **Ownership held** — the fill is portfolio-owned, the universe is research-owned, the scenario
  package is not imported (limits go through risk), and the graph gains a ratified row instead of
  an implicit allowance.
- **Sequencing named** — begun ahead of the preview publish by the maintainer's decision; the
  Stage 5A publish slice is untouched and still waits on its Decision 8.
