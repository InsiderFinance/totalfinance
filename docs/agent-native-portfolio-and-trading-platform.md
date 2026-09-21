# Agent-native portfolio and trading platform

> **Status:** mixed. FC7/Stage 4.4a, Stage 7A (AT2 and local AT3), Stage 7B.1 (AT4 environment and
> Agent Bench), and Stage 7B.2 (AT5 authorization and paper execution) landed. The
> [September review-repair gate](./specs/review-september-2026-repairs.md) is locally verified complete
> on `dccfce53` plus the repair changes. Stage 5A/5B remain maintainer-held; this local result does not
> authorize publication, commit/push, or claim hosted-matrix success.
> Connected/hosted operation, live execution, and live broker adapters remain separately governed
> later work. Completed stages must not be restarted from the original sequence below.
> **Written against:** `d1883d1d`, 2026-08-01.
> **Queue authority:** [`implementation-order.md`](./implementation-order.md) remains authoritative.
> Phase 3B and the platform artifact/market-state prerequisites are complete.
> **Scope:** protocol-neutral agent operations, durable portfolio state, P&L through time, trading-agent
> simulation and evaluation, safe trade proposals, and the boundary to optional broker execution.
> **Related documents:** the
> [`platform-completeness roadmap`](./platform-completeness-roadmap.md) owns the permanent layer model;
> the
> [`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md)
> incorporates this document's durable-state requirements into FC7 and owns their complete compute
> acceptance gate;
> the [`MCP, acceleration, and data-growth strategy`](./mcp-acceleration-data-growth-strategy.md) owns
> MCP-specific delivery, data growth, and acceleration; [`data-layer.md`](./data-layer.md) owns provider
> contracts. This document supplies the missing agent-and-portfolio spine shared by every transport.

## Executive decision

MCP is one valuable transport, not the agent architecture.

TotalFinance should become the deterministic financial operating layer beneath trading agents. An agent
should be able to observe a versioned portfolio, run exact calculations, propose a change, show the
change's payoff and risk, obtain bounded authorization, execute idempotently through an optional edge
adapter, reconcile what happened, explain the resulting P&L, and replay the entire decision later.

The architecture that makes that possible is:

```text
TypeScript SDK │ CLI │ OpenAPI/HTTP │ MCP │ Agent2Agent
                         │
             protocol-neutral operation registry
                         │
       workflows │ jobs │ artifacts │ authorization policy
                         │
      portfolio ledger │ market snapshots │ execution journal
                         │
   existing TotalFinance compute, strategy, risk, and backtesting
                         │
          data adapters             broker adapters
```

No transport owns the financial semantics. No LLM owns portfolio truth. No broker adapter owns risk
policy. Every layer is independently usable, and every higher layer calls the same public TotalFinance
engines that a developer can call directly.

The two highest-leverage deliverables are:

1. a durable, replayable portfolio ledger; and
2. a deterministic trading-agent environment and public evaluation suite.

The ledger makes agents useful across sessions. The environment makes them testable before money is at
risk. A protocol-neutral workflow registry then makes the same capabilities available through SDK,
shell, HTTP, MCP, Agent2Agent, and future language clients without creating parallel implementations.

## Current foundation and the actual gap

TotalFinance already has unusually strong calculation primitives for agents:

- [`analyzeBook`](../packages/risk/src/book.ts) provides point-in-time strategy-book P&L, Greeks,
  margin, concentration, grouping, and scenarios.
- [`explainPortfolioPnl`](../packages/risk/src/pnl-explain.ts) decomposes a supplied realized P&L
  between two supplied market states.
- [`optionsBacktest`](../packages/backtest/src/options/engine.ts) records an equity curve, trades,
  costs, assignment/settlement, and Greek P&L attribution.
- [`researchProtocol`](../packages/risk/src/research-protocol.ts) turns selection-adjusted and
  out-of-sample evidence into a statistically honest verdict.
- strategy positions already expose expiration P&L, mark-to-market value, payoff curves, scenario
  tables, probability, and what-if cubes.
- the MCP package already has curated operations, runtime schemas, structured outputs, deterministic
  seed policy, budgets, and read-only filtering.

What is missing is the state between calls:

- what the user owned before and after a decision;
- which fills, transfers, fees, dividends, financing charges, assignments, and corrections occurred;
- what prices and conventions produced each mark;
- how realized, unrealized, income, cost, financing, foreign-exchange, and model P&L reconcile;
- which analysis led to a proposal;
- what the user or policy authorized;
- what was actually submitted, filled, rejected, or cancelled; and
- whether the complete sequence can be reproduced after the process, connection, or agent disappears.

The current MCP tool contract also contains transport-neutral concepts inside a transport package:
`TotalFinanceTool` owns schemas, execution, mutation classification, stochastic policy, and output grammar.
Those concepts should graduate into a shared operation contract. MCP should adapt that contract, not
define it.

This is not a pivot away from the current roadmap. It is the focused implementation direction for
the durable-book, artifact, live/replay, and agent-native programs already identified there.

## Permanent laws

### 1. Portfolio truth is event-derived

Positions, cash, cost basis, realized P&L, and holdings are derived from immutable economic events.
They are not mutable fields an agent edits directly and not prose remembered in a conversation.

A corrected upstream event is represented by an explicit correction/reversal relationship. History is
never silently rewritten.

### 2. P&L is a derived result, not a ledger event

The ledger records economic facts. Valuation combines those facts with an explicit market snapshot.
P&L reports are versioned derived artifacts. This prevents a stale or unexplained P&L number from
becoming source-of-truth state.

### 3. Portfolio ledger and execution journal are separate

An order submission does not change economic holdings. A fill does.

- The **execution journal** records proposals, approvals, broker requests, acknowledgements, partial
  fills, fills, rejections, replacements, cancellations, and reconciliation status.
- The **portfolio ledger** records economic effects such as fills, cash movements, fees, income,
  financing, exercise, assignment, settlement, and corporate actions.
- A normalized fill is the audited bridge between the two.

### 4. Effects become more explicit as risk increases

The canonical lifecycle is:

```text
observe → analyze → propose → preflight → authorize → execute → reconcile
```

No operation skips a stage by hiding it internally. Calculation can be one call; placing an external
order cannot.

### 5. Free text never executes a trade

Agents may reason in natural language, but the actionable boundary accepts only a closed, validated
`TradePlan`. Broker credentials, authorization grants, and live-account identifiers never appear in a
prompt or model-generated free-text payload.

### 6. Authorization is bounded, content-addressed, and expiring

Authorization binds an exact plan hash, portfolio snapshot, market snapshot, account, limits, and
expiry. Material changes invalidate it. “The user approved buying SPY earlier” is not authorization for
a different quantity or price now.

### 7. External actions are idempotent and reconciled

Every broker-facing request has a caller-controlled idempotency key. A retry cannot create an
accidental duplicate order. Synchronous acceptance is not treated as a fill or even as final success;
the execution journal follows the order to a terminal or explicitly unresolved state.

For the shipped paper workflow, this guarantee is scoped to the source journal and authoritative
store: preserve both on retries. Independent sources or stores do not consume one another's grants.

### 8. Simulation, paper, and live share semantics

Order intents, portfolio events, fill records, policy checks, and P&L accounting use the same contracts
in historical simulation, deterministic replay, paper trading, and live adapters. Venue behavior may
differ, but the difference is represented by an explicit adapter policy and diagnostics rather than a
second agent API.

### 9. Transport parity is generated

The typed SDK owns the public financial functions. A protocol-neutral operation registry owns workflow
schemas and effect metadata. CLI, OpenAPI, MCP, Agent2Agent, and language adapters are generated or
thinly adapted from that registry and must pass parity fixtures.

### 10. Direct calculations remain direct

Nothing here makes a portfolio, runtime, operation runner, provider, database, or agent mandatory for
`blackScholesPrice`, `position.pnlAtExpiry`, `analyzeBook`, `valueAtRisk`, or any other direct public
calculation.

### 11. The compute core stays credential-free

Portfolio reduction, valuation, risk, policy evaluation, simulation, and artifact creation remain
pure or explicitly state-passing. Data and broker credentials live only in edge adapters. Browser-safe
packages never import credentialed adapters.

### 12. Agents receive evidence, not unsupported prose

Every recommendation or narrative statement must trace to machine-readable values, assumptions,
diagnostics, market/data identity, operation version, and parent artifacts. The narrative may summarize
the calculation; it may not become the only record of it.

## Package and dependency posture

Package count must still be earned. These boundaries are materially different enough to earn focused
homes once implementation begins.

### `@totalfinance/portfolio` — browser-safe economic state

Owns:

- immutable portfolio events and reduction;
- accounts, cash, positions, lots, and economic transactions;
- snapshots, serialization, migration, replay, and reconciliation inputs;
- realized/unrealized/income/cost/financing/foreign-exchange P&L accounting;
- stable portfolio, account, instrument, lot, strategy, and event identity; and
- storage interfaces, but no database implementation in the browser-safe package.

It does not own VaR, optimization, option pricing, market-data fetching, broker credentials, or order
placement. Existing `@totalfinance/risk` analytics consume portfolio snapshots through a narrow structural
contract or are composed with them in workflows.

### `@totalfinance/workflows` — protocol-neutral operations

Owns:

- a curated operation registry;
- workflow input/output schemas;
- effect, authorization, idempotency, cost, and capability metadata;
- composition of existing public TotalFinance functions; and
- operation parity fixtures used by every transport.

It does not reimplement quantitative kernels or become the route for small direct calls.

### Runtime/transport edge

The first implementation may keep runtime pieces together until deployment needs prove package
boundaries. The earned concepts are:

- artifact, portfolio, job, authorization, and execution-journal stores;
- local CLI and HTTP/OpenAPI serving;
- MCP adaptation;
- Agent2Agent adaptation;
- data-provider adapters; and
- paper/live broker adapters.

Do not create a broad `@totalfinance/agent` package that mixes financial truth, LLM orchestration,
transport, persistence, and execution. Portfolio and workflow capabilities are useful to ordinary
applications and services too. Agent-specific packages belong only at the adapter/experience edge.

## Durable portfolio ledger

### Economic event model

The public event grammar should be a closed discriminated union. The initial event families are:

| Family               | Events                                                                 | Economic effect                                                           |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Cash                 | deposit, withdrawal, transfer, FX conversion                           | cash by account/currency; external flows remain distinct from performance |
| Trading              | fill, trade correction/reversal                                        | position quantity, lots, cost basis, cash, realized P&L                   |
| Costs                | commission, exchange/regulatory fee, slippage adjustment               | explicit cost attribution                                                 |
| Income               | dividend, coupon, interest, staking/funding receipt                    | income and cash                                                           |
| Financing            | margin interest, borrow charge, perpetual funding payment              | financing P&L and cash                                                    |
| Corporate actions    | split, merger, spin-off, symbol change, cash-in-lieu                   | instrument/lot transformation with provenance                             |
| Derivative lifecycle | exercise, assignment, expiration, physical settlement, cash settlement | option/future positions and resulting cash/underlying events              |
| Administration       | correction, reversal, account migration marker                         | explicit repair without silent history rewrite                            |

Order submission, acknowledgement, rejection, cancellation, and replacement belong to the execution
journal because they do not themselves change holdings.

### Event envelope

The canonical event envelope should be JSON-safe and compatible with CloudEvents mapping without
forcing a CloudEvents dependency into the pure package:

```ts
interface PortfolioEventEnvelope<Event extends PortfolioEvent = PortfolioEvent> {
  eventId: string;
  schemaVersion: number;
  eventType: Event['eventType'];
  sourceId: string;
  accountId: string;
  effectiveTimestampMs: EpochMs;
  recordedTimestampMs: EpochMs;
  correlationId?: string;
  causationId?: string;
  reversesEventId?: string;
  event: Event;
  provenance: Provenance;
}
```

Both timestamps are supplied explicitly. The package never reads the system clock.
`(sourceId, eventId)` is the duplicate boundary. Replaying the same event twice is a no-op or a typed
conflict when the payload differs.

### Initial accounting scope

The first durable ledger must support:

- multiple accounts under one portfolio;
- a declared base currency and cash balances by currency;
- equities, options and option strategies, futures, crypto spot/perpetuals, fixed-income cash flows,
  and custom instrument identifiers through adapters;
- long, short, and fractional quantities;
- configurable lot relief (`fifo`, `lifo`, `highest-cost`, `specific-lot`) with the selected policy
  echoed in artifacts;
- commissions, fees, borrow, financing, dividends, coupons, and funding as separate components;
- option multiplier, exercise, assignment, expiration, and physical/cash settlement;
- explicit FX marks for base-currency valuation; and
- broker-imported corrections and reconciliation.

Jurisdiction-specific tax liability, wash-sale logic, regulatory reporting, and broker-specific margin
must not be presented as universal truth. The ledger may preserve tax-lot facts and expose extension
points; specialized adapters/products own jurisdictional policy.

Prices, quantities, and amounts follow TotalFinance's public finite-number convention and always carry
explicit currency/unit context. Intermediate calculations are not rounded silently. Reconciliation
uses an explicit currency/quantity tolerance and reports every difference.

### Derived state and reports

The reducer derives:

- positions and lots;
- cash by account and currency;
- cost basis and proceeds;
- realized and unrealized P&L;
- income, transaction-cost, financing, borrow, funding, and foreign-exchange P&L;
- net asset value and gross/net exposure;
- contribution/withdrawal flows separated from investment return;
- time-weighted and money-weighted performance inputs;
- position/account/strategy/underlying/asset-class/currency/tag grouping; and
- reconciliation state.

A P&L report must reconcile at least:

```text
ending NAV - beginning NAV - external flows
  = realized P&L
  + unrealized P&L
  + income
  - transaction costs
  - financing and borrow
  + foreign-exchange P&L
  + explicitly unexplained residual
```

The exact decomposition varies by instrument and mark policy, but no remainder disappears. A residual
is reported with diagnostics and provenance, matching the honesty law already used by Greek P&L
explain.

### API ladder

Preserve a direct reducer and add an immutable reusable artifact:

```ts
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  portfolioEvents,
  portfolioSnapshot,
} from '@totalfinance/portfolio';

const state = applyPortfolioEvents({
  portfolio: { baseCurrency: 'USD' },
  events,
});

const snapshot = portfolioSnapshot({
  portfolio: state,
  asOf: '2026-08-01T20:00:00Z',
  market,
});

const ledger = createPortfolioLedger({
  baseCurrency: 'USD',
  events,
});

const nextLedger = ledger.apply(moreEvents); // new immutable artifact
const pnl = nextLedger.pnl({ from, to, market });
const serialized = nextLedger.toJSON();
```

The artifact earns its existence through repeated queries, identity, migration, and replay. It does
not hide the reducer or require storage.

### Reconciliation

`reconcilePortfolio` compares a derived snapshot with a normalized broker snapshot and returns:

- missing/extra positions;
- quantity differences;
- cash differences by currency;
- cost-basis differences when supplied;
- unsettled versus settled differences;
- known timing/corporate-action explanations;
- suggested normalized correction events; and
- an explicit `reconciled` verdict.

It never mutates the ledger automatically. Applying suggested corrections is a separate authorized
portfolio-write operation.

## Protocol-neutral operation registry

### Why extract it

`@totalfinance/mcp` currently defines a useful tool kit with schemas, outputs, mutation metadata,
stochastic classification, budgets, and execution. Those concepts apply equally to a CLI, HTTP API,
background worker, Agent2Agent server, and direct embedding.

The shared registry should replace transport-specific `mutates?: boolean` with the distinctions a
financial agent actually needs:

```ts
interface TotalFinanceOperation<Input, Output> {
  id: string;
  version: string;
  title: string;
  description: string;

  inputSchema: Schema<Input>;
  outputSchema: Schema<Output>;

  sideEffect: 'none' | 'portfolio-state' | 'external-order';
  authorization: 'none' | 'policy' | 'human';
  idempotency: 'not-applicable' | 'optional' | 'required';
  deterministic: boolean;
  stochastic?: boolean | ((input: Input) => boolean);
  costClass: 'small' | 'medium' | 'large' | 'job';
  requiredCapabilities: readonly string[];
  supportsCancellation?: boolean;

  run(input: Input, context: OperationContext): Promise<OperationResult<Output>>;
}
```

`sideEffect: 'external-order'` is structurally excluded from read-only and portfolio-write runtimes.
An operation cannot become live merely because a caller passes `readOnly: false`.

### Operation result

Every workflow result carries:

- a compact human summary;
- typed structured output;
- assumptions and diagnostics;
- operation and library versions;
- input/market/data/portfolio artifact identities;
- output artifact links for large results;
- warnings and incomplete/partial status;
- cost/usage measurements where relevant; and
- trace/correlation identity.

Narrative text is derivative and optional. Structured evidence is canonical.

### Initial workflow set

The initial registry should stay small and journey-oriented:

| Workflow                      | Purpose                                                                          | Side effect     |
| ----------------------------- | -------------------------------------------------------------------------------- | --------------- |
| `portfolio.snapshot`          | materialize a valued portfolio at an explicit market/as-of                       | none            |
| `portfolio.analyze`           | P&L, risk, Greeks, margin, concentration, factors, scenarios                     | none            |
| `portfolio.explain_pnl`       | reconcile P&L between two states and explain drivers/residual                    | none            |
| `portfolio.propose_rebalance` | compare current holdings with a target policy and produce a preflight-ready plan | none            |
| `portfolio.monitor`           | evaluate drift, risk, drawdown, stale data, and user-defined alert rules         | none            |
| `strategy.evaluate`           | payoff, mark, probability, scenarios, and capital/risk                           | none            |
| `trade.preflight`             | current-versus-proposed portfolio and policy evaluation                          | none            |
| `research.evaluate`           | backtest/walk-forward/research-hygiene workflow                                  | none/job        |
| `backtest.run`                | bounded cancellable historical simulation                                        | job             |
| `portfolio.record_events`     | append validated economic events through a store                                 | portfolio-state |
| `trade.submit`                | submit an authorized plan to an explicit broker adapter                          | external-order  |

The exact wire names remain governed by the public naming policy. The important decision is
granularity: workflows eliminate fragile agent arithmetic and context transfer while preserving all
underlying raw functions.

### Transport generation and parity

One operation definition should produce:

- TypeScript embedding metadata;
- JSON Schema;
- CLI help and command routing;
- OpenAPI operations;
- MCP tools/resources;
- Agent2Agent skills/task adapters; and
- future language-client models.

Parity fixtures run the same canonical input through every supported transport and compare normalized
output, errors, effect classification, seed, assumptions, diagnostics, and artifact identity.

## Portfolio management workflows

Agent-native portfolio management must serve long-term investors as well as active traders. The
portfolio ledger provides facts; an explicit investment policy provides goals and constraints.

### Investment policy

An `InvestmentPolicy` may declare:

- target allocations or risk budgets by instrument, sleeve, asset class, sector, currency, and tag;
- minimum cash reserve;
- drift bands and review cadence;
- maximum turnover and estimated transaction cost;
- concentration, leverage, drawdown, and liquidity limits;
- allowed instruments/accounts and restricted lists;
- benchmark and performance objective;
- contribution/withdrawal handling;
- dividend/coupon reinvestment preference; and
- optional lot-selection objective supplied by a specialized tax-aware extension.

It is a user-supplied policy artifact, not advice generated by TotalFinance. Missing goals do not become
secret defaults.

### Rebalance proposal

`proposePortfolioRebalance` should produce a plan, never execute it:

```ts
const proposal = proposePortfolioRebalance({
  portfolio,
  market,
  policy: {
    targets: [
      { group: { tag: 'equity' }, weight: 0.6 },
      { group: { tag: 'fixed-income' }, weight: 0.3 },
      { group: { assetClass: 'cash' }, weight: 0.1 },
    ],
    driftBand: 0.03,
    maximumTurnover: 0.15,
    minimumCash: 5_000,
  },
});
```

The result includes:

- current, target, and post-trade weights;
- cash raised/used and remaining reserve;
- proposed trades with lot-selection detail when applicable;
- estimated commission, spread, slippage, and turnover;
- tracking error/objective before and after;
- risk/concentration before and after;
- unresolved constraints and optimization convergence;
- skipped dust trades and their aggregate effect; and
- a normalized `TradePlanArtifact` suitable for preflight.

Automatic optimization reports infeasibility or non-convergence; it never silently relaxes a hard
constraint. Contribution-aware rebalancing should first use new cash where that reduces turnover.

### Monitoring and alerts

`monitorPortfolio` evaluates one explicit snapshot against policy and prior monitor state. It returns
typed alerts with evidence rather than sending notifications itself.

Initial alert families include:

- allocation drift;
- concentration/risk-limit approach or breach;
- drawdown/daily-loss breach;
- option expiration, assignment, exercise, and dividend risk;
- margin/buying-power pressure;
- unusual P&L or unexplained residual;
- stale/missing market data;
- reconciliation difference;
- failed/rejected/stuck order; and
- material change in payoff or scenario loss.

Rules support threshold, direction, hysteresis, debounce, cooldown, severity, and acknowledgment state.
The host schedules evaluations and delivers notifications. A recorded stream of market, portfolio, and
monitor-state inputs must reproduce the same alerts.

### Performance through time

The ledger plus versioned market snapshots should produce a `PortfolioTimeline` with NAV, cash,
external flows, exposure, drawdown, and P&L components at explicit points. The caller chooses valuation
frequency and mark policy. Missing marks create gaps/diagnostics; they are not forward-filled silently.

Performance workflows compose the existing performance package to report time-weighted return,
money-weighted return, benchmark-relative metrics, drawdowns, turnover, and contribution by grouping.
Transfers and contributions remain external flows rather than trading gains.

## Safe trade lifecycle

**Adopted (Stage 7B.2, 2026-09-06):** the shipped lifecycle is `@totalfinance/portfolio/trade`
(`normalizeTradePlan`, `preflightTradePlan`, `mergeTradePolicies`, `createAuthorizationGrant` /
`verifyAuthorizationGrant`, `applyJournalEvents` / `journalOrderStates`, `reconcileExecution`),
`@totalfinance/backtest/paper` (`createPaperBroker` over the engines' own `fillOrderWithPolicy`), and
`tradePack` in `@totalfinance/workflows` (`trade.preflight`, `trade.authorize`, `trade.submit`,
`trade.cancel`, `trade.reconcile`, `portfolio.record_events`) with the runtime's `capabilities` and
`stores` — see [`docs/guides/trade-lifecycle.md`](./guides/trade-lifecycle.md) and the contract
[`docs/specs/trade-lifecycle-and-paper-execution.md`](./specs/trade-lifecycle-and-paper-execution.md).
The artifacts are `TradeIntent` (`totalfinance.trade-intent`), `ExecutionPlan`
(`totalfinance.execution-plan` — the FC7 `TradePlanArtifact` normalizes into it), `PreflightReport`
(`totalfinance.preflight-report`), `AuthorizationGrant` (`totalfinance.authorization-grant`),
`ExecutionReceipt` (`totalfinance.execution-receipt`), and `ReconciliationReport`
(`totalfinance.reconciliation-report`); the sketches below are kept as the intent.

### Canonical artifacts

The lifecycle uses explicit artifacts:

```ts
interface TradeIntent {
  /* desired economic action, no broker credentials */
}
interface TradePlanArtifact {
  /* normalized orders + rationale/evidence + content hash */
}
interface PreflightReport {
  /* before/after economics, policy verdict, warnings */
}
interface AuthorizationGrant {
  /* exact bounded authority over one plan hash */
}
interface ExecutionReceipt {
  /* accepted broker requests and external identifiers */
}
interface ReconciliationReport {
  /* terminal order/fill and portfolio-ledger reconciliation */
}
```

An agent may produce `TradeIntent` or request a deterministic strategy/rebalance workflow. TotalFinance
normalizes that into a `TradePlanArtifact`; the agent does not handcraft broker-specific payloads.

### Preflight contract

`preflightTradePlan` evaluates at minimum:

- schema and instrument validity;
- market/data age and provenance;
- account permissions and supported order types;
- current holdings, open orders, cash, buying power, and margin;
- duplicate/conflicting orders;
- estimated commission, spread/slippage, and market impact when available;
- current versus proposed allocation and exposure;
- position and portfolio maximum loss where defined;
- option payoff, break-even, assignment/exercise, and expiration implications;
- before/after Greeks, leverage, concentration, liquidity, factor exposure, and VaR;
- configured stress scenarios and loss limits;
- trading calendar/session state;
- policy allow/deny/require-approval verdict; and
- every assumption or unavailable check.

The report never upgrades missing information into an allow. It either rejects or requires explicit
authorization with the missing evidence disclosed.

### Policy model

The reusable policy layer supports explicit limits such as:

- allowed accounts, asset classes, symbols, venues, and order types;
- maximum order quantity/notional and portfolio gross/net exposure;
- maximum position, underlying, sector, and asset-class concentration;
- leverage, margin, buying-power, VaR, expected-shortfall, drawdown, and daily-loss limits;
- options permission level and prohibition of undefined-risk structures;
- liquidity, spread, open-interest, volume, and maximum participation thresholds;
- allowed trading sessions and stale-data limits;
- maximum estimated transaction cost/slippage;
- cooldown, turnover, and duplicate-order rules; and
- paper-only versus live capability.

Policy returns structured decisions and reasons:

```ts
type PolicyDecision =
  | { verdict: 'allow'; checks: PolicyCheck[] }
  | { verdict: 'deny'; checks: PolicyCheck[] }
  | { verdict: 'require-approval'; checks: PolicyCheck[]; requiredScope: string };
```

Policies are deterministic functions of explicit inputs. A hosted product may add administrative
policy, but it cannot silently weaken a user's stricter policy.

### Authorization grant

An authorization grant binds:

- user and account;
- plan content hash;
- portfolio snapshot hash;
- market snapshot hash and maximum age;
- permitted broker and execution mode;
- maximum quantity/notional/slippage/cost variance;
- allowed substitutions, if any;
- expiration timestamp;
- approval authority and audit identity; and
- one idempotency key or an explicit bounded key set.

For the shipped paper adapter, a new submission supplies the preflight-bound plan and snapshots;
the broker checks the grant's bindings at first acceptance. A material difference before acceptance
requires a new plan and approval. A same-key receipt retry and later fills do not re-run preflight
or re-check grant expiry. Expiry does not cancel accepted orders or prevent receipt recovery;
stop orders explicitly with cancel/halt. Per-fill reauthorization and account-wide revocation are
not part of this paper contract; live execution remains separately governed.

### Execution adapter boundary

The open compute library may define normalized `OrderIntent`, `OrderStatus`, `Fill`, and adapter
conformance contracts. Credentialed execution lives in separately installed adapters or a hosted
product with stronger operational controls.

The first adapter is the existing deterministic simulator/paper broker. Live adapters do not ship
until retries, partial fills, replacement, cancellation, asynchronous rejection, reconnect, duplicate
delivery, reconciliation, kill switch, and terminal-state tests all pass. **Shipped (Stage 7B.2):**
`createPaperBroker` — submit (grant verification at first acceptance, one key one plan, the same receipt on retry),
step (fills through `fillOrderWithPolicy`, the engine's own sequence), cancel, deliver (late fills,
duplicate delivery, asynchronous rejection), halt/resume — with the hazard suite and Journey 4 as
tests in `packages/backtest/test/paper-broker.test.ts`; `mode: 'live'` is `trade.live_unavailable`.

Default capabilities should be:

```text
portfolio:read
analytics:run
trade:propose
```

Separately granted capabilities are:

```text
portfolio:write
trade:paper
trade:approve
trade:live
```

**Shipped (Stage 7B.2):** the runtime's `capabilities` option (the CLI's `--capability`, the HTTP and
MCP servers' `capabilities`) with `operation.capability_missing` refused before the input is parsed;
`trade:live` is named here and granted by no operation this stage.

Paper idempotency is scoped to the source journal in its authoritative store. Retain `sourceId`
and the store on retry; another source or store is an independent simulation. This is not global
grant consumption or an account-wide single-use guarantee.

**September trust correction:** workflow submission requires an unchanged approved grant in the
trusted authorization store, whether supplied inline or by hash. The pure grant constructor creates
a representation, not approval authority. Cancellation has no grant input: `trade:paper` and the
authoritative journal's persisted order context gate cancellation. HTTP enabled writes (including approval) and job mutations
also require the server-owned `authenticationToken`, sent as `Authorization: Bearer <token>`;
the server CLI uses `--token-file` or `TOTALFINANCE_HTTP_TOKEN`. Capabilities remain a separate ceiling.
See the [trade guide](./guides/trade-lifecycle.md) and [HTTP guide](./guides/http.md) for current setup.

Plan or subscription names map to capabilities; they never appear in stable operation contracts.

## Trading-agent environment

### Product goal

TotalFinance should provide a deterministic environment in which LLM agents, coded policies, and learned
policies can be developed and evaluated without broker risk. This is more strategically distinctive
than adding hundreds of agent-visible formula tools.

The TypeScript environment belongs initially at an earned `@totalfinance/backtest/environment` subpath and
uses the existing event-driven execution simulator, portfolio reducer, risk policy, and artifact model.

### API semantics

Use the familiar environment contract rather than inventing an agent framework. **Adopted (Stage
7B.1, 2026-09-05):** the shipped grammar is the frozen execution grammar — `instrumentId`, `side`,
`quantity`, `type`, `limitPrice`, `stopPrice`, `timeInForce: 'day' | 'gtc'` — not the
`instrument: { type, symbol }` / `orderType` sketch below, which this section kept as the intent;
`finish()` is the third verb beside `reset` and `step`, and a definition is the stepper's request
plus `maximumSteps`, `limits`, `reward`, and `features` (see
[`docs/guides/trading-environment.md`](./guides/trading-environment.md) and the Stage 7B.1 contract).

```ts
const environment = createTradingEnvironment({
  accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
  instruments: { SPY: { kind: 'etf', currency: 'USD' } },
  marketData: { bars },
  execution: execution.declared({
    label: 'my desk',
    costs: { commission: fees.perContract(0.65) },
  }),
  limits: {
    maximumPositionNotional: 20_000,
    maximumDrawdown: 0.1,
    allowUndefinedRiskOptions: false,
  },
  reward: { pnl: 1, drawdown: -2, turnover: -0.1, riskViolation: -10 },
});

let state = environment.reset({ seed: 42 });

const step = environment.step({
  kind: 'orders',
  orders: [{ instrumentId: 'SPY', side: 'buy', quantity: 10, type: 'limit', limitPrice: 590 }],
});
```

`reset` returns an observation plus episode information. `step` returns:

- next observation;
- total reward and component decomposition;
- `terminated` for an economic/policy terminal state;
- `truncated` for a time/budget/data boundary;
- fills, rejections, portfolio events, and diagnostics; and
- the exact artifact/replay identity.

This deliberately aligns with the widely understood Gymnasium `reset`/`step` model. A thin Python
adapter can later implement Gymnasium without moving or reimplementing finance logic. Multi-agent
PettingZoo compatibility is deferred until a real multi-agent market or execution consumer exists.

### Observation contract

An observation contains only information available at that event time:

- explicit event/as-of time and sequence;
- current market snapshot or scoped data handle;
- portfolio snapshot and open-order state;
- available cash/buying power and risk-limit utilization;
- normalized features requested by the environment definition;
- data freshness, quality, and provenance;
- allowed-action mask and reasons; and
- previous action outcome.

The environment must prevent future rows, future revisions, final-bar summaries, or full-series
normalization statistics from leaking into the observation.

### Action contract

An action is `hold`, one or more closed `OrderIntent`s, or an explicit cancellation/replacement of a
known open order. Natural-language rationale may be attached as metadata but cannot alter action
semantics.

Invalid and disallowed actions return typed rejections and a deterministic penalty policy. They do not
crash an episode or silently coerce the action.

### Reward contract

Do not hard-code “one-step P&L” as the universal objective. Reward is a declared composition whose
components are always returned separately, including:

- net P&L or return;
- drawdown and tail-risk penalty;
- transaction-cost/turnover penalty;
- concentration/leverage penalty;
- policy-violation penalty;
- benchmark-relative contribution; and
- optional goal-specific terms.

The environment records both raw financial outcomes and reward. A reward change never changes the
portfolio accounting or backtest result.

### Episode and scenario library

The maintained suite should cover:

- ordinary trending, mean-reverting, and range-bound periods;
- volatility expansion/contraction;
- overnight gaps and limit moves;
- stale, missing, duplicated, corrected, and out-of-order data;
- wide spreads and thin liquidity;
- option expiration, exercise, assignment, dividend, and early-assignment risk;
- margin pressure and forced policy termination;
- disconnect/reconnect and duplicate execution events;
- corporate actions;
- multi-currency marks; and
- model/market disagreement with a visible unexplained residual.

Synthetic fixtures ensure license-safe reproducibility. Public/reference datasets may be added with
clear licenses. Proprietary InsiderFinance datasets remain entitlement-aware handles, never fixtures
copied into the open repository.

## TotalFinance Agent Bench

Unit tests prove calculations, not whether an agent operates correctly. Publish a versioned benchmark
that evaluates both workflow use and trading operation.

### Calculation/workflow evaluation

Measure:

- correct operation selection;
- valid arguments on first attempt;
- recovery after one teaching error;
- numerical parity with direct SDK calls;
- refusal to invent unavailable positions, prices, or data;
- correct use of as-of, units, and assumptions;
- context bytes and calls per completed journey; and
- ability to trace conclusions to artifacts.

### Portfolio/trading operational evaluation

Measure:

- exact ledger and P&L reconciliation;
- no look-ahead;
- retry/idempotency behavior;
- stale-data response;
- compliance with action masks and risk policy;
- zero unauthorized external-order attempts;
- correct partial-fill/cancel/reject handling;
- replay equality;
- bounded behavior under malformed or adversarial text metadata; and
- explicit refusal when authorization or market evidence is missing.

### Strategy-quality evaluation

Financial performance is reported separately from operational correctness. Include baselines such as
hold-cash, buy-and-hold, periodic rebalance, random valid action, and simple risk-parity/technical
policies. Report return, volatility, Sharpe/Sortino, drawdown, turnover, cost, exposure, and violation
counts.

A profitable unsafe agent fails. A safe unprofitable baseline can pass operational conformance while
scoring poorly on strategy quality. Do not collapse those dimensions into one leaderboard number.

### Release gates

At minimum:

- 100% numerical parity for completed deterministic workflows;
- 100% replay equality for maintained deterministic episodes;
- 0 unauthorized external-order submissions;
- 0 duplicate orders under the maintained retry suite;
- 0 hidden future-data access in leakage fixtures;
- 100% portfolio reconciliation in golden economic-event journeys; and
- no new operation ships without schemas, effects, authorization, parity, and benchmark coverage.

Model-dependent tool selection rates can use maintained thresholds, but deterministic safety gates are
absolute.

## Artifacts, stores, and jobs

Agents should pass immutable references rather than repeatedly copying chains, portfolios, scenario
cubes, and backtest tables through model context.

### Store interfaces

Define narrow interfaces for:

- `ArtifactStore`;
- `PortfolioStore`;
- `DatasetStore`;
- `JobStore`;
- `AuthorizationStore`; and
- `ExecutionJournalStore`.

Ship memory and local filesystem/SQLite reference implementations first. Hosted object-store/database
implementations remain adapters. Store interfaces accept explicit clocks/expiry values where needed.

### Handles

Handles are protocol-neutral, immutable where practical, tenant/account scoped, unguessable when
hosted, schema-versioned, TTL-aware, and explicitly authorized on every read.

```ts
interface ResourceHandle {
  uri: string;
  kind: 'dataset' | 'market' | 'portfolio' | 'scenario' | 'job' | 'report' | 'authorization';
  schema: string;
  version: string;
  contentHash?: string;
  createdAt: string;
  expiresAt?: string;
  provenance: Provenance;
}
```

A handle is not implicit session state. Reconnects, different transports, and other authorized agents
can use it without guessing what “the current book” means.

### Jobs

Long backtests, calibration, optimization, and large scenario runs are durable jobs with:

- accepted/queued/running/completed/failed/cancelled states;
- progress and stage;
- input artifact identities;
- cooperative cancellation;
- deterministic seed and executor;
- resource budgets and usage;
- partial diagnostics;
- result artifact handles; and
- resume/retry semantics.

A post-hoc deadline message is not cancellation. Long-running compute must expose cooperative checks or
worker termination at defined boundaries.

## Transport surfaces beyond MCP

### CLI

The CLI makes TotalFinance usable by coding agents and every language with process execution:

```text
totalfinance operations list
totalfinance schema portfolio.analyze
totalfinance run portfolio.analyze --input request.json
totalfinance portfolio replay --events events.ndjson
totalfinance job status job_123
totalfinance serve --openapi
```

Machine mode accepts JSON from stdin/file and writes JSON or NDJSON to stdout with stable exit codes.
Human table/progress output is explicit. Protocol mode never mixes logs with stdout payloads.

### OpenAPI/HTTP

Generate OpenAPI from operation schemas. The service adds authentication, request/idempotency headers,
artifact/job endpoints, pagination, streaming/progress, and typed error mapping; it does not hand-write
a second financial API.

OpenAPI is the default cross-language boundary before maintaining native clients. Generated clients can
be offered where usage warrants them.

### MCP

Keep the local read-only compute MCP. Refactor it to consume the shared operation registry and preserve
its curated packs, resources, prompts, Apps, budgets, and seed policy.

Portfolio-write and external-order operations are never added to the default pack. If exposed by a
hosted deployment, they require explicit capability, authorization, and effect-aware UI. The MCP/data
strategy remains authoritative for MCP-specific protocol and product details.

### Agent2Agent

Agent2Agent v1.0 is complementary to MCP: it supports discoverable Agent Cards, skills, durable tasks,
artifacts, polling, streaming, and webhooks for delegation between agents.

An optional adapter advertises a deliberately small skill set:

- analyze a portfolio;
- explain P&L;
- evaluate an option strategy;
- stress a proposed trade;
- run a bounded backtest;
- assess research validity; and
- propose a rebalance.

It returns TotalFinance artifacts, not unsupported prose. It does not embed a required LLM or autonomous
planner into the library.

## Events and observability

### CloudEvents mapping

Portfolio, market, job, authorization, and execution events should map losslessly to CloudEvents so
host applications can use HTTP, Kafka, NATS, queues, or object storage without inventing another event
envelope. The pure package owns the domain schema; the runtime adapter owns CloudEvents encoding.

### OpenTelemetry

Optional instrumentation should create correlated spans for:

```text
agent task
  └─ TotalFinance operation
      ├─ data query / handle resolution
      ├─ calculation
      ├─ policy evaluation
      ├─ authorization lookup
      ├─ broker request
      └─ reconciliation
```

Use established HTTP, messaging, exception, and GenAI semantic conventions where applicable. TotalFinance
attributes cover operation/version, artifact hashes, executor, seed, status, and durations.

Raw holdings, orders, credentials, prompts, and licensed rows are redacted by default. Telemetry records
identities/hashes unless an operator explicitly opts into sensitive payload capture.

## Data and the InsiderFinance growth loop

The ledger, workflow registry, environment, and paper execution can be built and tested with supplied
data before provider integration. Connected agent usefulness nevertheless depends on explicit data and
broker edges.

The data layer should provide:

- versioned market snapshots and streams;
- capability and entitlement discovery;
- provenance, quality, freshness, corrections, and sequence semantics;
- dataset handles for chains/history too large for model context;
- normalized broker account/position/order/fill imports for reconciliation; and
- first-party InsiderFinance chains, flow, exposure, and historical options data.

The adoption path is:

```text
free compute + supplied data + paper environment
  → connected first-party snapshot/workflow
  → saved portfolio/research artifacts
  → monitored portfolio, alerts, and historical analysis
  → optional authorized execution through a separate broker adapter
```

Free/BYOD compute stays genuinely useful. First-party data converts because it removes acquisition,
normalization, history, and monitoring work—not because the quantitative engine is crippled.

Market/news text and external metadata are untrusted data, never instructions. Provider content cannot
grant capabilities, alter policy, or authorize execution.

## Security and operational requirements

Before any remote portfolio-write or live-order capability exists:

- OAuth/audience-bound authorization and strict tenant/account checks;
- secret isolation from prompts, model context, artifacts, logs, and telemetry;
- least-privilege capability scopes;
- step-up/human authorization for configured actions;
- immutable audit records and correlation IDs;
- idempotency, retry, duplicate-delivery, and replay tests;
- rate, data, compute, order, notional, and loss budgets;
- stale-data and disconnected-state fail-closed behavior;
- kill switch and broker-order cancellation path;
- approval and credential revocation;
- reconciliation monitoring and unresolved-state alerts;
- paper/live visual distinction; and
- an independent legal, compliance, security, and operations review for each live product/venue.

The open-source library must not claim that one generic policy satisfies broker, jurisdiction,
suitability, best-execution, tax, or regulatory obligations.

## Implementation sequence

This sequence is subordinate to `implementation-order.md`. Phase 3B, the shared artifact/market-state
foundation, the durable ledger, shared scenarios, Stage 4.5, FC8/FC9, Stage 7A, AT4, and AT5 have
landed. The September review repairs are locally verified complete. The AT rows below
retain the original decomposition and exit laws; completed rows are not new implementation orders.
Remaining agent-product/hosted/live work is dependency-gated, and Stage 5A/5B publication remains
maintainer-held.

### AT0 — install the ratified contracts and package ownership

- Apply FC0 and FC7 from the
  [`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md);
  the package owner and portfolio-versus-risk/workflow dependency direction are settled there.
- Freeze event, snapshot, artifact, operation, effect, authorization, and error grammars.
- Add architectural dependency tests before new package edges land.
- Define schema migration and serialized-version support policy.

**Exit:** no unresolved ownership or serialization decision can force a breaking redesign of the
ledger.

### AT1 — durable portfolio ledger

- Implement event schemas and pure reduction.
- Add cash, positions, lots, fees, income, financing, derivative lifecycle, corrections, snapshots,
  serialization, replay, and reconciliation.
- Compose existing performance and risk functions without moving them into the ledger.
- Add full golden accounting journeys and property tests.

**Exit:** replay is deterministic, every P&L total reconciles, and broker corrections are explicit.

### AT2 — operation registry and read-only workflows

**Queue placement:** COMPLETE as Stage 7A; original placement was after Stage 4.5 and before preview.

- Extract the transport-neutral contract from MCP.
- Add portfolio snapshot/analyze/explain, strategy evaluate, research evaluate, and backtest operations.
- Generate schemas/manifests and SDK-versus-operation parity tests.
- Keep direct functions independently documented and callable.
- Register only operations whose underlying compute contract is green. Later Stage 4.6 operations
  join through additive adapter/parity slices rather than speculative schemas.

**Exit:** no transport owns a duplicate calculation or schema.

### AT3 — artifacts, jobs, CLI, and OpenAPI

**Queue placement:** split. Local AT3 landed as Stage 7A, with opt-in writes added by Stage 7B.2
and local HTTP authentication corrected by September R11/R12. Authenticated remote, tenant,
entitlement, and connected-data concerns remain later Stage 7B work.

- Add memory and local filesystem/SQLite stores.
- Add immutable handles and durable cancellable jobs.
- Ship machine-first CLI commands.
- Generate and test OpenAPI/HTTP parity.
- Refactor the existing local MCP to adapt the same registry and satisfy the dedicated local-MCP
  preview gate; the MCP transport does not retain a parallel operation schema.
- Keep default HTTP analytics local/provider-free and read-only. Enabled writes and job mutations
  require the local bearer credential; hosting, OAuth, tenancy, entitlements, and data-bearing
  remote handles are not implied by an OpenAPI document or local server.

**Exit:** another language can run, poll, retrieve, and replay every read-only flagship workflow.

**Original Stage 7A preview exit:** SDK, operation registry, CLI JSON, OpenAPI/local HTTP, and local MCP return
semantically equivalent normalized results and teaching errors for the preview flagship set. The
baseline excluded provider credentials, hidden connection state, portfolio mutation, proposal/order,
and broker capability. Stage 7B.2's opt-in trade capabilities supersede those original effect limits;
the default read-only surface and separately governed hosted/live boundaries remain.

### AT4 — trading-agent environment and Agent Bench

**Queue placement:** Stage 7B after Stage 4.6; it evaluates the completed simulator rather than an
interim private backtest engine.

- Implement deterministic `reset`/`step` over the existing event-driven simulator and portfolio
  reducer.
- Add observations, action masks, reward decomposition, episode artifacts, leakage tests, and scenario
  packs.
- Publish baseline policies and operational/strategy score separation.
- Add a thin Python Gymnasium adapter only after the wire/artifact contract is stable.

**Exit:** maintained episodes replay exactly and the benchmark cannot be passed through look-ahead,
unsafe actions, or unreconciled accounting.

### AT5 — proposal, policy, authorization, and paper execution

- Add `TradeIntent`, normalized plans, preflight, structured policy, authorization grants, execution
  journal, and reconciliation.
- Integrate the existing simulator as the first paper adapter.
- Prove stale-market invalidation, idempotency, retries, partial fills, rejection, cancellation, and
  kill-switch behavior.

**Exit:** every submitted paper order has valid bounded authority and reconciles to portfolio events.

### AT6 — connected data and live monitoring

- Add provider/broker imports, market streams, incremental portfolio analytics, typed alerts, and
  record/replay.
- Add first-party InsiderFinance workflows and entitlement-aware handles.
- Keep monitoring and order placement as distinct capabilities.

**Exit:** a recorded live observation stream reproduces analytics and portfolio state exactly, subject
only to explicitly declared processing-time behavior.

### AT7 — Agent2Agent and hosted multi-agent operation

- Generate Agent Cards/skills from the operation registry.
- Map long workflows to durable tasks and artifacts.
- Add auth, tenancy, budgets, history, streaming/webhooks, and conformance tests.

**Exit:** agents from supported stacks discover and complete flagship workflows without MCP-specific
knowledge or invented data.

### AT8 — optional live broker adapters

- Implement one adapter at a time behind the complete safety contract.
- Require venue-specific conformance, paper/live parity fixtures, operational ownership, and explicit
  release authorization.
- Never install or enable live execution through the default `totalfinance` or MCP experience.

**Exit:** a live adapter is operationally supportable, not merely capable of submitting one happy-path
order.

## Acceptance journeys

### Journey 1 — persistent P&L

1. Import deposits, fills, fees, dividends, and one correction.
2. Replay the ledger to two dates.
3. Value both snapshots against versioned markets.
4. Reconcile realized, unrealized, income, costs, financing, FX, and residual.
5. Serialize, restore, and reproduce the same report.

**Pass:** every subtotal and total reconciles exactly within declared numerical/currency tolerances.

### Journey 2 — agent portfolio review

1. Resolve a portfolio and market handle.
2. Run portfolio analysis and stress.
3. Receive concise findings plus structured evidence and artifacts.
4. Reproduce every conclusion with direct SDK calls.

**Pass:** no claim depends on hidden state or agent arithmetic.

### Journey 3 — strategy consequence preview

1. Propose an options strategy against the current portfolio.
2. Compute payoff, break-evens, mark, probability, max loss, buying power, Greeks, and scenarios.
3. Compare portfolio risk before and after.
4. Return allow/deny/approval-required with reasons.

**Pass:** the proposal cannot be confused with authorization or execution.

### Journey 4 — safe paper trade

1. Authorize an exact plan hash with bounded slippage and expiry.
2. Submit with an idempotency key.
3. Replay a timeout/retry, partial fill, cancellation, and late fill event.
4. Reconcile execution journal, fills, cash, holdings, and P&L.

**Pass:** no duplicate economic trade occurs and unresolved state remains visible.

### Journey 5 — trading-agent benchmark

1. Reset a seeded episode.
2. Observe only point-in-time information and valid actions.
3. Step through orders, rejections, fills, risk limits, and a market shock.
4. Compare operational correctness and financial performance separately.
5. Replay the episode from its artifact.

**Pass:** replay matches, leakage fixtures stay inaccessible, and unsafe profitable behavior fails.

### Journey 6 — cross-language delegation

1. Discover the service through OpenAPI or an Agent2Agent Agent Card.
2. Launch a bounded portfolio/backtest workflow.
3. Poll or stream job progress.
4. Retrieve typed result artifacts.
5. Reproduce the result through TypeScript.

**Pass:** transport changes no financial semantics.

## Explicit non-goals

- No required LLM, planner, or autonomous strategy in TotalFinance core.
- No free-text-to-broker execution endpoint.
- No mutable process-global “current portfolio,” market, account, or evaluation date.
- No hidden portfolio state attached to an MCP/A2A/HTTP connection.
- No broker credentials in browser-safe packages, prompts, or operation arguments.
- No second pricing/risk/backtest implementation for workflows or transports.
- No universal broker abstraction that erases venue-specific order and lifecycle behavior.
- No claim that a generic risk policy supplies legal, tax, suitability, or regulatory compliance.
- No live adapter in the default install or default MCP pack.
- No leaderboard that rewards return while hiding drawdown, leverage, costs, violations, or leakage.
- No Python reimplementation; Python begins as a native-feeling adapter over stable wire/artifact or
  accelerated engine contracts.
- No mandatory portfolio/runtime framework for direct calculations.

## Decisions settled by this document

1. MCP remains important but does not own the agent operation contract.
2. The durable public concept is a portfolio ledger; `analyzeBook` remains the one-off professional
   calculation.
3. Portfolio economic events and execution lifecycle events are separate journals joined by fills.
4. Portfolio state and P&L are deterministic derived artifacts.
5. The workflow registry is protocol-neutral and effect-aware.
6. Agent operations distinguish no side effect, portfolio-state change, and external order.
7. The only valid external-action sequence is propose → preflight → authorize → execute → reconcile.
8. Authorization binds exact content and expires; it is never conversational memory.
9. Simulator/paper execution ships before any live broker adapter.
10. The trading-agent environment uses seeded `reset`/`step` semantics and separates `terminated` from
    `truncated`.
11. Operational correctness and strategy performance are separate benchmark dimensions.
12. CLI and OpenAPI are first-class agent/cross-language surfaces alongside MCP.
13. Agent2Agent is an optional workflow/task transport after artifacts and jobs are stable.
14. CloudEvents/OpenTelemetry are edge mappings/instrumentation, not dependencies of pure compute.
15. Data and broker adapters remain explicit edges; bring-your-own data and direct compute stay real.

## Research basis

Primary references informing the interoperability choices:

- [Agent2Agent v1.0 announcement and relationship to MCP](https://a2a-protocol.org/latest/announcing-1.0/)
- [Agent2Agent discovery and Agent Cards](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [OpenAPI specification](https://spec.openapis.org/oas/)
- [Gymnasium environment API](https://gymnasium.farama.org/api/env/)
- [PettingZoo multi-agent API](https://pettingzoo.farama.org/)
- [CloudEvents specification](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/)
- [Alpaca client-order identity endpoint](https://docs.alpaca.markets/us/reference/getorderbyclientorderidforaccount)

## Final position

The most compelling agent promise is not “TotalFinance has tools an AI can call.” It is:

> An agent can operate over durable financial truth, calculate through one trusted engine, propose a
> fully inspectable change, obtain bounded authority, act idempotently through an optional edge,
> reconcile the outcome, explain the P&L, and replay every step.

Combined with a deterministic Gymnasium-compatible trading environment and a public Agent Bench, that
would make TotalFinance useful not only to TypeScript application developers but to LLM agents, coded
policies, reinforcement-learning systems, multi-agent platforms, and cross-language services. It is a
credible path to becoming the default open quantitative substrate for agents without sacrificing the
small direct calculations that make the library lovable today.
