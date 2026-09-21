# Pre-publish interface repairs — assumptions, units and wire contracts

Status: locally complete; source-freeze ready at `af0d7cd2a` (2026-09-21). Opened 2026-09-11;
A1 landed at `be14108d3`, A2–A8 at `a750f1cd4`, B/C at `36cbd5352`, and the freeze repairs
at `a01999a1e` plus `af0d7cd2a`. Authorized by the maintainer after the fresh-eyes
interface review of head `01a352fdd`. This bounded amendment takes precedence over any earlier
guidance it contradicts; `implementation-order.md` owns its place in the launch queue (it lands
before the release revision is frozen, because every item below either changes user numbers or
freezes a wire shape at publish).

The standard for every item: it must make the model more correct, more composable or less
error-prone for a real user (an options application holding editable leg and chain state, an agent
calling the MCP server, a quant scripting). Fewer names is never a reason. Each finding below was
verified in code before it was written here.

## A. Assumptions and units (these change numbers)

### September 21 freeze-repair checklist (takes precedence over historical completion claims)

- [x] Allocate each stock/option hedge once across the portfolio after each independent order or complete combo; detect removal of an existing hedge (`portfolio/test/trade-combos.test.ts`).
- [x] Refuse empty/subset submissions, duplicate order IDs, execution-rule changes, and changed combo leg ratios within a variance allowance. Plan membership is not a variance coordinate (`portfolio/test/trade-lifecycle.test.ts`, `backtest/test/paper-combos.test.ts`).
- [x] Cancel all remaining legs together, with validation before any mutation (`backtest/test/paper-combos.test.ts`).
- [x] Scope combo identities to their plan, including restoration and cancellation (`backtest/test/paper-combos.test.ts`).
- [x] Preserve the authorized net-limit economics when quantity scaling changes the combo-unit divisor; cover debit/credit limits and restart (`backtest/test/paper-combos.test.ts`).
- [x] Charge execution-price slippage once in backtest bridges, paper execution, and preflight; prove ledger cash parity (`backtest/test/execution-accounting-parity.test.ts`).
- [x] Bind consumed grants to the original journal store; a fresh store is not a retry (`workflows/test/grant-consumption.test.ts`).
- [x] Persist validated submission events with the single-use grant before journal commit; recover the exact events after a failed commit without recalculating or spending authority twice (`workflows/test/grant-consumption.test.ts`).
- [x] Test failures, restarts, competing writers, and defensive store snapshots; reconcile public guidance and generated contracts (`workflows/test/trade-transactions.test.ts`, `workflows/test/trade-recovery.test.ts`, and the preceding cases).
- [x] Regenerate, run the complete CI and regeneration checks, and record a second green full gate before declaring the source ready to freeze (evidence below).

The durable submission record is a write-ahead record, not a second fill engine. A journal store has
an opaque persistent identity (fresh memory stores and fresh file directories are distinct).
The authorization store atomically claims a grant with its validated event batch. A failed journal
commit can replay only that batch into that same store. Validation failures before the claim leave
authority untouched. Live execution, repository creation, version selection and publication remain
outside this repair.
Before any new workflow journal write, recover every pending batch for that storage identity and
journal, not just the current grant. This prevents a later submit/cancel from reusing reserved IDs.
Workflow cancellation therefore requires the original authorization store alongside its journal
but still takes no grant and requires no approval capability. Pure SDK cancellation is unchanged.

### Freeze-repair acceptance evidence (2026-09-21)

- Final source revision: `af0d7cd2a`, over PR #303 head `f4b0e4b65`. The seven confirmed review
  findings and the adjacent complete-plan membership, pending-batch recovery, defensive-store
  snapshot, external combo-fill, and quantity-scaled net-limit defects are covered by regressions.
- Two complete local `pnpm run ci` passes: **Node 22.23.2 and Node 24.21.0**, in separate worktrees
  at that same revision. Each passed formatting, lint, library/site typechecks and builds,
  **551 files / 12,080 library tests**, **79 site tests**, coverage floors, and all **25 API reports**.
  Each includes the **60 packed-consumer tests** and registry/CLI/HTTP/MCP transport parity.
  Coverage on both: 94.09% statements, 83.88% branches, 96.96% functions, 94.66% lines.
- Clean-tree **`pnpm regen:check` passed byte-stably on Node 22** before its full CI pass. All
  signatures, contracts, validation projections, API reports, README/reference/agent docs,
  bundle measurements, OpenAPI and documentation inventories reproduce without a diff.
- Current inventories: **7,791 public callable paths**, **2,663 implementations**, **1,546 input
  contracts**, **1,898 result contracts**, **378 validator identities**; **41,983 public naming
  identities / 0 unresolved**. Enforcement: **5,302 candidates**, **2,441 enforced**, **2,674
  partial**, **0 defective**, **187 unmeasured**. The partial/unmeasured classifications remain
  explicit; a green gate is not a claim that every mathematical primitive validates every input.
- New regression evidence includes a real two-process race for one grant; file-store restart
  after a failed journal commit; a persisted authorization write followed by a lost response;
  recovery across later submissions and cancellation; stock/option hedge capacity; combo
  cancellation/isolation; debit/credit net limits under scaling; and cash parity across the
  backtest bridge, shared paper fill path, and portfolio ledger with multipliers 1 and 100.
- **Boundary of this sign-off:** local source readiness, not hosted CI, production browser/host
  acceptance, a versioned release rehearsal, publishing rights, or publication approval. No
  public repository was created, version bumped, package published, or website deployed.
  Next: `implementation-order.md` launch steps 2–4 (repository/organization prerequisites,
  remaining production-site acceptance, then the exact versioned release candidate and rehearsal).

### A1. A valuation instant names its time of day

- Core exports `resolveValuationAsOf(asOf, functionName)`: accepts finite epoch milliseconds or a
  zoned ISO datetime. A date-only string (`'2026-07-20'`) is rejected with a teaching error that
  shows the two accepted forms, explains that a same-day option's value depends on the time of day,
  and names `usEquitySessionInstant`. The existing `resolveAsOf` keeps its date-granular meaning
  (date-only → UTC midnight) for consumers whose asOf is a date: ledgers, calendars, fundamentals,
  performance and research windows. A market snapshot artifact serves both personas, so
  `createMarketSnapshot` still accepts a bare date (the ledger values calendar date D at 00:00 UTC of
  D, its documented mark convention) and stamps `conventions.asOfConvention` as
  `'date-midnight-utc'` or `'explicit-instant'`; option-pricing consumers of a snapshot (scenarios'
  valuation-instant resolution, pricer adapters) refuse a date-granular snapshot through
  `requireInstantMarketSnapshot` with the fix. Option-chain records in backtest market data are
  valuation instants and use the strict door directly.
- Every option-pricing consumer resolves through the strict door: `@totalfinance/options` (`market()`,
  `priceOption`, implied-volatility inversion, chain health, batch heads), `@totalfinance/strategy`
  (position construction, `value`, `probability`, `scenarioTable`, `whatIfCube`, scanner,
  from-chain), `@totalfinance/volatility` (event, earnings, surface, skew, term structure, cone),
  `@totalfinance/structure` (exposure, flow drift), `@totalfinance/scenarios` and `@totalfinance/risk` book
  marking. The agent surface uses ONE valuation schema (`epoch ms | zoned datetime`) for those
  operations and keeps the date-or-instant schema for ledger operations. The remedy text is
  transport-neutral (no "pass Date.now()").
- Core exports `usEquitySessionInstant(date, 'open' | 'close'): EpochMs` — DST-correct and
  half-day aware — so "as of today's close" is one call. The US half-day rules (day after
  Thanksgiving; 3 July and 24 December when they fall on a weekday) move into core as data;
  `usEquityCloseUtcMs` and the `us-equity-close` expiry convention resolve to 13:00 ET on those
  dates; `@totalfinance/calendars` consumes the same rule table so there is one definition.
- Assumptions echo `asOf` as both epoch ms and ISO text. `exerciseTime: 'AM'` is documented as
  display metadata that does not move `expiresAt`. Whole-day counts (earnings days-to-event, the
  options backtest's days-to-expiry, 0DTE classification) share ONE America/New_York day boundary in
  core (`usEquityMarketDayIndex`); the two package-private copies are deleted. The options backtest's
  chain snapshot is a valuation instant like any other: an end-of-day chain passes
  `usEquitySessionInstant(date, 'close')`. The dividend ex-date open comes from the core open helper,
  never from "close minus 6.5 hours" (wrong on early-close days).
- Stale text corrected: `docs/guides/assumptions.md` (expiry instant), the skew error example
  (`asOf: new Date()` throws), the DX assessment sentence claiming `style` defaults.

### A2. One Greek unit system

- TotalFinance Greeks are display units everywhere: per share, theta per calendar day, vega per one
  volatility point (0.01), rho per 1% rate, second-order Greeks in the units `@totalfinance/options`
  documents on `DEFAULT_GREEK_UNITS`. `@totalfinance/risk`'s `PositionGreeks` adopts those units; the
  raw per-year, per-1.00 form leaves the public surface. `taylorPnl` converts internally in one
  place. `rawGreeksFromDisplay` is deleted (no alias). `aggregateGreeks` applies each position's
  contract multiplier and says so in its result.
- Every Greek field on the agent surface states its unit in its description.

### A3. Volatility scale is never silent

- `historicalVolatility`, `realizedVolatility`, `rollingVolatility`, `parkinson`, `garmanKlass`,
  `rogersSatchell` and `yangZhang` require `annualization` (a positive number; `1` means per bar).
  The indicator registry and `technical_analysis.calculate` mark it required. The backtest
  environment's `realizedVolatility` feature requires it too.
- `@totalfinance/volatility` inputs that are annualized decimals (`realizedImpliedSpread`,
  `varianceRiskPremium`, cone and rank histories) say so in JSDoc and agent descriptions. IV rank
  and percentile are documented as 0–100 on the agent surface (the code already is).

### A4. Model premiums use the leg's volatility

`premiums: 'model'` prices each leg at `leg.impliedVolatility ?? market.volatility`, exactly as
`value()` marks it, so a chain-fed position opens flat. Assumptions echo which source priced each leg.

### A5. The position owns its horizon

A call-site `expiry` on `value`, `probability`, `scenarioTable` or `whatIfCube` that differs from
the expiry materialized on the position's option legs throws a typed error naming the position's
expiry and the rebuild path. A call-site `expiry` is accepted only when the position has no option
expiry of its own.

### A6. The agent boundary sets no financial assumption the SDK requires

- One shared chain-row schema (`type`, `strike`, `expiry`, optional quotes, `impliedVolatility`,
  `openInterest`, `volume`, `greeks`) with request-level REQUIRED `style` and `underlying` on every
  operation that builds contracts from rows; `convention` REQUIRED on exposure. No placeholder
  underlying, no hard-coded style.
- The options backtest engine requires `riskFreeRate`; no 4% phantom. The simulated broker's rate
  is documented as a disclosed cash-interest default.

### A7. Contract multipliers never fall back silently

- `normalizeTradePlan` (and preflight) refuses an instrument whose id parses as an OCC option
  symbol when it is known only from a market spot or described in `instruments` without a
  multiplier, naming `instruments[id].contractMultiplier`; the paper broker refuses the same at
  creation (an OCC-keyed description without the field) and at submit (an OCC order it has no
  terms for). Plain instruments known only from a spot remain cash with multiplier 1, and every
  plan row discloses the multiplier its estimate applied (`TradePlanTrade.contractMultiplier`).
  `proposePortfolioRebalance` leaves a non-held OCC target unresolved with the reason instead of
  sizing it at 1. The one OCC grammar stays in core; `isOccOptionSymbol` asks it as a question.
- The simulated broker charges commission on `price × multiplier`, records slippage in cash, and
  sizes notional orders and OCO sibling caps in cash, matching the shared fill kernel;
  `Trade.multiplier` is required (the vectorized and cross-sectional engines stamp 1) and
  `tradeNotional` has no fallback.

### A8. Options grammar defects

- `priceMany` defaults to `engines.auto()`, the same default as `option.price`.
- A supplied `engine` on the European implied-volatility path is honoured by the same numerical
  inversion the American path uses (one kernel, `invertEngine`, with model-free bounds by exercise
  style: undiscounted intrinsic-to-spot/strike for American, the discounted band on the escrowed
  spot for European); the closed-form knobs `method`/`fallback`/`failFast` are refused beside an
  engine; `americanImpliedVolatility` refuses a European contract and names the right door; the
  flat Black-Scholes heads (`impliedVolatility`, `impliedVolatilityMany`) no longer accept
  `engine` (they can never use it).
- `OptionMarket.bid`/`ask` are removed (read by nothing; the chain row carries quotes).
- `optionChainHealth` assesses every row under its own exercise style: American rows get the
  American intrinsic bounds and the Bjerksund–Stensland 2002 inverse on the configured σ bracket
  instead of `unsupported`; each row names its `model.engine`, the report's `exercisePolicy` is
  `by-contract-style` with `exerciseEngines`, and `dividendYield` follows the package rule
  (omitted is 0, echoed, disclosed by a `dividend_yield_defaulted` warning).

## B. Wire contracts that freeze at publish

### B1. Tool names

Wire tool names are the operation id with dots replaced by underscores
(`totalfinance_option_price`). The dotted id stays in `_meta['totalfinance/operation'].id`, resource URIs,
OpenAPI paths and the CLI. Job-control tools follow the same rule.

### B2. The MCP result is the operation envelope

`structuredContent` is the full `OperationResult` (operation, library version, assumptions,
diagnostics with status, identity, usage) — byte-for-byte the JSON HTTP and the CLI return. Each
tool's `outputSchema` wraps its existing structured schema and includes the spilled-handle branch.
The duplicate JSON text block is dropped (the summary stays). `technical_analysis.list` defaults to
`limit: 50` with search first. A call to a capability-filtered tool returns the filter reason and
the capabilities resource. `jsonSafe` converts typed arrays to arrays.

### B3. Unbounded strategy metrics are explicit

`maxProfit`, `maxLoss` and `riskReward` are `number | null`, with `bounded: { profit, loss }` on
position metrics and a `diagnostics` slot on probability results. No `Infinity` crosses the public
surface; explanations say "unbounded".

### B4. A stock leg is a stock

`Leg` and `LegInput` are a discriminated union: `{ kind: 'stock', price, quantity }` or
`{ kind: 'call' | 'put', strike, quantity, premium, expiry?, impliedVolatility? }`. No `strike: 0`,
no `premium` meaning share price, no expiry on stock rows. The wire schema is a `oneOf`; the risk
mirror follows.

### B5. Multi-leg orders are one order

`TradeIntentOrder` and `TradeOrder` gain `comboId?`; `TradeIntent.combos?` carries a combo's
terms (`{ comboId, netLimitPrice? }`); `ExecutionPlan.combos` lists
`{ comboId, orderIds, netLimitPrice? }` (net debit positive, net credit negative, per combo unit — the
legs' quantities divided by their greatest common divisor, or by the smallest leg when a quantity is
not whole). A combo has at least two legs. Preflight judges undefined-risk on the combo after-state
(a short option is defined-risk when a same-type, same-underlying long expiring no earlier covers it,
or the underlying covers a call); the paper broker fills a combo all-or-none against one observation
instant and only within the net limit (`combo-leg-unfilled`, `combo-net-limit`), expires a combo
when any leg expires, and journals `comboId` and `netLimitPrice` on every leg's `submitted` detail;
the grant binds combo ids (`comboIds`, `combo-mismatch`), complete membership and proportional leg
quantities. Labels are scoped to a plan; cancellation closes every remaining leg, and external
partial/terminal leg facts block further synthetic fills pending reconciliation. Hedge capacity is
allocated once across existing and proposed positions. Content hashes change (pre-release).

### B6. One order vocabulary

`@totalfinance/core` exports `OrderSide`, `OrderType` (kebab-case), `TimeInForce`, `sideOf(signed)`
and `signOf(side)`; portfolio and backtest re-export them and the simulated broker's enums move to
kebab-case. Hand-rolled sign-to-side conversions use `sideOf`. `symbol` stays on market data and
`instrumentId` on ledger and trade objects; the rule is written down. `TradeOrder.
submittedTimestampMs` becomes `plannedTimestampMs`; the paper broker stamps `submittedTimestampMs`
at submission and refuses to fill against an observation older than the submission.
`targetWeight` becomes `notionalWeight` on an intent line (a policy's allocation target keeps its
name: that one IS a target weight). Store `createdAt` becomes `createdTimestampMs` — and, so a
handle does not carry one epoch-ms instant beside one ISO string, its `expiresAt` becomes
`expiresTimestampMs`; the runtime option, the store put inputs and every transport's clock stamp
follow. `OptionContractTerms.right` becomes `type`; the backtest option specification's epoch-ms
`expiry` becomes `expiresAt`. `normalizedFillsFromBacktest` bridges backtest trades to the ledger.
`trade:propose` is required by preflight and rebalance proposals (an MCP tool's `openWorldHint` is
now derived from its side effect, not from its capabilities, so a gated read stays closed-world);
the authorization store atomically consumes a grant with the exact validated write-ahead events
before journal commit (it records storage identity, journal, receipt and key) and refuses replays
into any other store/journal — a retry with the same key into the
same journal reads the same receipt; a second licensed key, another source or another store is
`trade.grant_consumed`. `TradeOrder.submittedTimestampMs` stays as the broker's stamp (optional on a
plan's order, present on a journaled one); the fill models' `OrderIntent` is the projection of a
submitted order.

Execution-price slippage/spread/impact is charged once via `pricePerUnit`. The fill's optional
`executionPriceAdjustment` is non-negative cash-equivalent attribution (absolute price deviation ×
quantity × multiplier), never another ledger debit. `NormalizedFill.costs` remains additional cash
charges only, including an explicit out-of-price `slippageAdjustment` when an adapter actually
needs one. Paper/backtest/preflight and environment cost reporting share that distinction.

### B7. One chain row, and the Greeks call that exists

Core `OptionQuote` gains `greeks?` (display-unit per-share Greeks with optional provenance);
structure's supplied-Greek quote extends it with required provenance. Strategy's `ChainQuote` and
volatility's `ObservedSkewQuote` are deleted in favour of the core row. `options.chainGreeks({
quotes, market, priceSource? })` (one request object, like every other door — the positional form
this section first wrote is not the library's grammar) solves each row's implied volatility with
style routing and stamps `impliedVolatility` and `greeks` with provenance, returning the rows as a
`Computed<OptionQuote[]>` envelope. It is non-throwing per row: a row the pricers refuse (no price
at the chosen source, a price below intrinsic, expired against `asOf`) is returned unchanged and
named in `diagnostics.rows`; a row that is not a quote at all is a typed error. The error messages
that named a nonexistent `.greeks()` name `chainGreeks`. `usEquityOption({ type | occSymbol, … })`
builds a US-equity contract from data (a field given beside the symbol must agree with it);
`usEquityCall`/`usEquityPut` remain as sugar.

## C. Hygiene (consistency; no numbers change)

- `converged` is mirrored into `diagnostics.converged` wherever it is top-level; core exports
  `isTrustworthy(result)`.
- Zero-variance Kelly and research Sharpe return `null` with a diagnostic instead of an input
  error; `maxDrawdown` of an empty series throws; the `computed.ts` NaN sentence is corrected.
- A sweep asserts every `InputError` message starts with its function name; raw `code:` string
  literals become `ErrorCode` members with a gate.
- `sharpeRatio`, `sortinoRatio`, `calmarRatio`, `treynorRatio` are removed (bare names stay).
- `portfolioVaR({ weights, covariance, method: 'parametric' | 'monteCarlo' } | { weights,
returns, method: 'historical' })` replaces the two method-named functions.
- `strategyFromChain` echoes its price source in assumptions.

## Deliberately not changed

Named presets stay positive-only (mirrors have catalog names). Orders carry a side with a positive
quantity; held exposure is signed; `sideOf` is the one bridge. Technical-analysis names keep
pandas-ta and TA-Lib parity (only the silent unit default goes). Valuation keeps spreadsheet names.
`expectedMoveFromImpliedVolatility`/`expectedMoveFromStraddle` and `nakedCallMargin`/`nakedPutMargin`
stay: no user failure was found behind merging them. `dividendYield` keeps its disclosed default of
0, echoed in assumptions, now applied consistently.

### Acceptance evidence — B1–B7 (2026-09-21, `36cbd5352`)

- B1/B2: tool names are the operation id with dots replaced by underscores (`totalfinance_option_price`;
  job control `totalfinance_job_submit/status/result/cancel`); the dotted id rides
  `_meta['totalfinance/operation'].id`; `structuredContent` is the full `OperationResult` envelope,
  byte-for-byte with HTTP and the CLI, and `outputSchema` wraps each structured schema with the
  spilled-handle branch (`operationResultSchema`, `RESOURCE_HANDLE_SCHEMA` from `HANDLE_KINDS`,
  `anyOf`); the duplicate JSON text block is gone; `technical_analysis.list` defaults `limit: 50`
  with search first; a filtered tool call returns the filter reason and the capabilities resource;
  `jsonSafe` converts typed arrays; string warnings are typed `operation.untyped_warning` objects.
- B3/B4: `maxProfit`/`maxLoss`/`riskReward` are `number | null` beside `bounded: { profit, loss }`;
  no `Infinity` crosses the surface; explanations say "unbounded"; `rewardToRisk` is the one
  definition; `Leg`/`LegInput` are a discriminated union (`{ kind: 'stock', price, quantity }` |
  option row); the wire schema is a `oneOf`; the risk mirror and the options backtest follow.
- B5: combos as above — `packages/portfolio/test/trade-combos.test.ts`,
  `packages/backtest/test/paper-combos.test.ts`.
- B6: core `OrderSide`/`OrderType`/`TimeInForce`/`sideOf`/`signOf` (`packages/core/src/orders.ts`),
  re-exported by portfolio and backtest; the simulated broker's enums are kebab-case and it fills
  `market-on-open`/`market-on-close`; `plannedTimestampMs`, `notionalWeight`, `type`, `expiresAt`,
  `createdTimestampMs`/`expiresTimestampMs`; `normalizedFillsFromBacktest`; `trade:propose` on
  preflight and the rebalance proposal; grant consumption in the memory and file stores
  (`packages/workflows/test/grant-consumption.test.ts`); every hand-rolled sign→side conversion
  uses `sideOf`; naming fixtures `repairs.B6` with evidence.
- B7: core `OptionQuote.greeks?` with `OptionQuoteGreeks`/`OptionQuoteGreeksProvenance`; the
  structure supplied-Greek quote requires `provenance`; `ChainQuote` and `ObservedSkewQuote` are
  deleted (naming fixtures `repairs.B7`); `options.chainGreeks({ quotes, market, priceSource? })`
  returns `Computed<OptionQuote[]>`, non-throwing per row (`packages/options/test/chain-greeks.test.ts`);
  `usEquityOption({ type | occSymbol, … })` (`contract-builders.test.ts`); the delta-selection
  guard names `chainGreeks`; `OptionQuote` is nameable from `@totalfinance/strategy` (the 3B.2
  nameability rule: `strategyFromChain` takes the core row directly, so the scoped and umbrella
  boundaries resolve one element contract and stay measurement twins).

### Acceptance evidence — C (2026-09-21, `36cbd5352`)

- `isTrustworthy(result)` reads `diagnostics.converged !== false` and no error-severity warning;
  the envelopes that report `converged` in their value already mirror it into `diagnostics`
  (optimizers, frontier, calibrations); the `Computed.value` sentence says never NaN/±Infinity.
- Zero-variance Kelly (`kellyBet`, `costAwareKelly`) and research Sharpe (`sharpeStatistics`,
  `probabilisticSharpeRatio`, `deflatedSharpeRatio`, `parameterSweepDiagnostics`,
  `researchProtocol` → `inconclusive`, the cross-sectional grid → degenerate) return `null` with
  `risk.kelly_zero_variance` / `risk.sharpe_undefined`; `maxDrawdown`/`maxDrawdownFromReturns` of an
  empty series throw `input.out_of_range`.
- `tools/codes-conformance.test.ts` gates two rules on the AST: every `InputError`/
  `UnsupportedError`/`NumericalError` message starts with its function name (83 messages
  repaired), and no raw `code:` / `warning('…')` literal survives outside core's two registries
  (every code is an `ErrorCode`/`WarningCode` member; 3 members added).
- `sharpeRatio`/`sortinoRatio`/`calmarRatio`/`treynorRatio` are removed on the root and the
  subpaths (bare `sharpe`/`sortino`/`calmar`/`treynor` stay); `portfolioVaR({ weights, covariance,
method: 'parametric' | 'monteCarlo' } | { weights, returns, method: 'historical' })` replaces
  the two method-named functions (naming fixtures `repairs.C`); `strategyFromChain` echoes
  `assumptions.priceSource` (plus expiry, multiplier, quantity).
- Harness hygiene found by the slice: the signature classifier's numeric NAME fallback read member
  lists, so `{ createdTimestampMs: EpochMs; … }` (and `PaperBroker#resume`'s and
  `InstrumentAdapter#accrued`'s inputs) were classified `numeric` and `AuthorizationStore#put`
  silently left enforcement candidacy; the fallback is confined to arms that could be a number and
  `tools/manifest/signature-conformance.test.ts` gates it. `AuthorizationStore#consume` is admitted
  in the measurement ratchet as the same external-callback contract as `#put` (both store
  implementations are proven in `grant-consumption.test.ts`).

### Acceptance evidence — A2–A8 (2026-09-18, `a750f1cd4`)

- A2: `PositionGreeks` is the display shape (`phi`, accepted-unused higher-order names), the Taylor
  kernel converts once (`DAYS_PER_YEAR`, `PER_PERCENT`, options-sign charm/veta), `rawGreeksFromDisplay`
  and its first-touch fixture are deleted (the fixture/contract join 1,295 → 1,294), book-VaR moments
  convert `vega × 100` and `theta × 365` once, `Position.multiplier` is applied in stress tests and
  `aggregateGreeks` (`assumptions.contractMultiplier: 'applied'`), every report echoes `greekUnits`,
  and the Taylor wire schema names each unit.
- A3: `requireAnnualization` on every annualized TA estimator, the registry, and the backtest
  environment (`features`, `bench` baseline 252, `episodes` 252); the journey recipe schema requires
  it; the guides state the scale.
- A4/A5: `modelPremium` prices `leg.impliedVolatility ?? market.volatility` and the position carries
  `premiumVolatilitySource`; `resolveMarket` refuses a foreign `input.expiry` with
  `strategy.expiry_conflict` and otherwise keeps the position's own horizon.
- A6: exposures, surface and flow operations require `convention`, `style` and `underlying`; the
  options backtest requires `riskFreeRate` (`input.missing_field` / `input.wrong_type`), and every
  caller (transport-parity, MCP, journey, CLI, packed-consumer, first-touch) names it.
- A7: `isOccOptionSymbol` (core, manifest-classified helper) is the one question; `normalizeTradePlan`
  and `preflightTradePlan` refuse an OCC id known only from a spot or described without a
  multiplier; `createPaperBroker` refuses at creation and at submit before journaling;
  `proposePortfolioRebalance` leaves a non-held OCC target unresolved with the reason;
  `TradePlanTrade.contractMultiplier` (wire schema updated); the simulated broker bills commission
  on `fillPrice × multiplier`, records slippage in cash, sizes notional orders and OCO sibling caps in
  cash; `Trade.multiplier` is required (vectorized and cross-sectional stamp 1) and `tradeNotional`
  has no fallback.
- A8: `priceMany` → `engines.auto()`; `invertEngine` is the one engine-inversion kernel (style bounds:
  undiscounted intrinsic/spot-or-strike for American, the discounted band on the escrowed spot for
  European; explicit bracket never widened); `option.impliedVolatility({ engine })` inverts the named
  engine for a European contract and refuses `method`/`fallback`/`failFast` beside it;
  `americanImpliedVolatility` refuses a European contract; the flat heads drop `engine`
  (`input.unknown_field`); `OptionMarket.bid/ask` removed; `optionChainHealth` assesses American rows
  by style (`model.engine`, `exercisePolicy: 'by-contract-style'`, `exerciseEngines`) and applies the
  dividend rule (`dividend_yield_defaulted` warning, `assumptions.dividendYield` echoed).
- Tests: 545 files / 11,997 of 11,998 library tests plus 79 site tests passed under `pnpm run ci` at
  `a750f1cd4` after the seven gate corrections (the higher-order P&L spec amended to display units,
  the calendar example's foreign horizon dropped, `Position.premiumVolatilitySource` a plain optional
  so the union checker and the artifact agree, the pipeline fixture's annualization, the indicator
  reference's scale note moved into its generator, the coverage ledger re-keyed for the reordered
  observation union and stripped of the flat heads' engine residuals); the one non-pass is the
  enforcement regeneration gate, which hit its 2,400 s budget on a machine at a load average near 30
  from unrelated processes and passes in isolation on the committed tree (343 s); all 25 API
  reports up to date.
- Artifacts: enforcement 5,315 candidates · 2,445 enforced · 2,684 partial · 0 defective · 186
  unmeasured (the same six unmeasured reasons; three retired candidates are the deleted risk adapter
  and the two dropped `OptionMarket` fields' readers); naming 41,358 identities, 0 unresolved; the
  contract surface 7,791 paths / 2,653 implementations / 1,538 input contracts / 1,893 result
  contracts / 375 validator identities; the fixture/contract join 1,295 → 1,294; all 25 API reports
  current; bundle budgets moved with measured rationale (xva 11.5 → 11.75 KB, environment 141 → 142,
  paper 34 → 34.5, portfolio 101 → 102, umbrella 672 → 674) after the OCC grammar was split from
  expiry resolution so the predicate costs the parse, not the session calendar.
- Second all-green pass on the recorded tree: format, lint and all 25 API reports clean;
  `pnpm test:coverage` 545 files / 11,998 library tests passed with no timeouts; `pnpm regen:check`
  byte-stable.
- Not certified here: hosted CI, browser review, publication rights (unchanged launch-queue items).

### Acceptance evidence — A1 (2026-09-17, `be14108d3`)

- Core: `resolveValuationAsOf` (typed `time.valuation_instant_required`, fix text carries the
  date's correct offset), `usEquitySessionInstant`, `isUsEquityHalfDay` over the shared
  `US_EQUITY_HALF_DAY_RULES` (calendars consumes the same table; its cross-check asserts the
  calendar's own session close, 13:00 on two 2026 days), `usEquityMarketDayIndex` /
  `usEquityMarketDateUtcMs` (structure and volatility copies deleted). Every option-pricing consumer
  resolves through the strict door; the options ex-date open comes from the session helper.
- Market snapshots stamp `conventions.asOfConvention`; `requireInstantMarketSnapshot` guards
  scenarios' valuation-instant resolution and is measured `partial` through the one snapshot reader
  (it was `defective` when it read fields directly, and `baseline-rejected` before it was fixtured).
- Agent surface: one `ValuationInstantSchema` for pricing operations; resolved instants echoed as
  ISO text; expiry descriptions name the early-close rule.
- Tests: 545 files / 11,979 library tests plus 79 site tests passed under `pnpm run ci` at
  `be14108d3` after the three gate corrections (core artifacts budget 31 → 32 KB, the alignment
  package breakdown regenerated, the regeneration budget re-measured); all 25 API reports up to
  date; enforcement 5,318 candidates · 2,445 enforced · 2,687 partial · 0 defective · 186
  unmeasured; naming 41,334 identities, 0 unresolved; the fixture/contract join 1,294 → 1,295.
- Second all-green pass on the recorded tree: format, lint and API reports clean; the coverage run
  had two load-induced timeouts (the enforcement regeneration gate and the declared-coverage
  variant gate, on a machine at a load average above 20 from unrelated processes) that pass in
  isolation (736 s and 450 s); `pnpm regen:check` byte-stable.
- Not certified here: hosted CI, browser review, publication rights (unchanged launch-queue items).

## Ordered acceptance

- [x] A1 valuation instants (core door, session helper, half-day rule, all pricing consumers, one
      agent schema, docs). Landed `be14108d3` (2026-09-17); evidence below.
- [x] A2 one Greek unit system (risk adopts display units, `rawGreeksFromDisplay` deleted,
      aggregation applies multipliers, agent descriptions). Landed `a750f1cd4` (2026-09-18).
- [x] A3 volatility scale required (TA estimators, registry, backtest feature, volatility docs).
      Landed `a750f1cd4`.
- [x] A4/A5 strategy premiums and horizon. Landed `a750f1cd4`.
- [x] A6 agent-boundary assumptions and options-backtest rate. Landed `a750f1cd4`.
- [x] A7 multipliers (plan, paper, simulated broker, required `Trade.multiplier`). Landed `a750f1cd4`.
- [x] A8 options grammar defects. Landed `a750f1cd4`; evidence above.
- [x] B1/B2 tool names and the envelope on MCP. Landed `36cbd5352`.
- [x] B3/B4 unbounded metrics and the stock leg. Landed `36cbd5352`.
- [x] B5/B6 combo orders and the order vocabulary. Landed `36cbd5352`.
- [x] B7 chain row, `chainGreeks`, `usEquityOption`. Landed `36cbd5352`.
- [x] C hygiene. Landed `36cbd5352`.
- [x] Regenerate signatures, naming, contracts, enforcement, validation, API reports, README, llms,
      bundles, OpenAPI and docs inventories; full CI, `regen:check`, second all-green pass; record
      evidence here and hand off to the launch queue's freeze step. Complete locally at
      `af0d7cd2a`; see the September 21 evidence above.
