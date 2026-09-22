# The safe trade lifecycle

TotalFinance gives an agent — coded, learned, or an LLM — one lifecycle through which a decision may
become an order, and no other: `observe → analyze → propose → preflight → authorize → execute →
reconcile`. Every stage is an explicit, content-addressed artifact; every write is an explicit,
capability-gated operation; free text never executes a trade. This stage ships the paper adapter;
live execution is a later stage behind the same lifecycle (`mode: 'live'` is a typed refusal today).

| Verb                                                    | What it does                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `normalizeTradePlan`                                    | a trade intent (quantities or target weights) or a rebalance proposal → one execution plan, priced at the mark, hashed         |
| `preflightTradePlan`                                    | the plan against the ledger, the market, and the policy: before/after through the ledger's own fold, every check, one decision |
| `createAuthorizationGrant` / `verifyAuthorizationGrant` | human authority bound to the plan, the preflight, the snapshots, the account, a variance envelope, an expiry, a key set        |
| `createPaperBroker`                                     | the first execution adapter: submit, step (fills through the engines' own fill path), cancel, deliver, halt                    |
| `applyJournalEvents` / `journalOrderStates`             | the execution journal folded to per-order states with the transition table enforced                                            |
| `reconcileExecution`                                    | the journal joined to the ledger's fills and, with an external snapshot, `reconcilePortfolio` verbatim                         |
| `tradePack`                                             | the six operations — preflight, authorize, submit, cancel, reconcile, record_events — on every transport                       |

## The laws the lifecycle keeps

- **Preflight never upgrades missing information.** Every check has a verdict; an unverifiable
  check is `require-approval` (or `deny` under the stricter policy); a failed check is `deny`; an
  allow comes only from evidence, never from silence. The before and after states are the
  ledger's own fold of the hypothetical fills and the monitor's judgment of the result.
- **A grant binds what preflight saw.** The plan hash, the preflight hash, the portfolio and
  market hashes, the market instant and an age allowance, the mode, the account, a variance
  envelope, an expiry, the approver, and a closed set of idempotency keys. The broker checks those
  bindings at first submission acceptance and lists every failed one; a changed plan needs new
  authority. It does not re-check grant expiry on each fill or when returning an existing receipt.
  Supplied `orders` must retain every authorized order exactly once: omitting an independent
  hedge is material too. Quantity/notional variance is not permission to remove orders or change
  their execution type, time-in-force or stop. To trade a subset, preflight and authorize that plan.
- **A hash is integrity, not approval authority.** Workflow submission requires an unchanged
  approved grant in the configured trusted authorization store, whether supplied by `grantHash`
  or inline as `grant`. Only the approval path needs `trade:approve`; `trade:paper` cannot mint
  its own authority by editing and rehashing a grant.
- **Idempotency belongs to a journal and its authoritative store.** Retain both `sourceId` and
  the store on retries: the same key and plan returns the same receipt without another order;
  the same key with another plan is `trade.idempotency_conflict`. Order identities include the
  intent's economic-body hash within that simulation.
- **A grant licenses one durably prepared submission.** Before committing its journal, the authorization
  store atomically records the storage identity, journal, receipt, key and exact validated events;
  a retry with that key into that original store/journal recovers the
  same receipt, and any other use — a second licensed key, another `sourceId`, another store —
  is `trade.grant_consumed`. New authority means a new grant. (Pre-publish repairs B6.)
- **An order fills only against a market it has seen.** The plan stamps `plannedTimestampMs`;
  the broker stamps `submittedTimestampMs` at submission, journals it on the `submitted` event,
  and never fills an order against an observation older than that stamp
  (`observation-before-submission` in `unfilled`).
- **A multi-leg order is one order.** Intent lines that share a `comboId` are legs of a combo;
  the plan lists each combo with its legs in plan order and, when the intent gave one, its
  `netLimitPrice` per combo unit (net debit positive, net credit negative; a combo unit is the
  legs' quantities divided by their greatest common divisor for integer quantities, or by the
  smallest leg quantity otherwise). When allowed quantity scaling changes that unit size, the
  broker translates the limit to the submitted unit and persists it: the authorized economics
  remain unchanged, including after restart. Preflight judges undefined risk on
  the combo's after-state — a short call beside its longer-or-equal-dated long call is defined
  risk — the grant binds the combo ids, and the paper broker fills a combo all-or-none against one
  observation instant, only within the net limit (`combo-leg-unfilled`, `combo-net-limit`). A hedge
  is allocated once across existing and proposed positions; removing a hedge is also checked.
  Submit every authorized order, preserving each combo's quantity ratios even within a variance
  allowance. Cancelling one leg cancels all remaining legs. Labels are plan-local: two plans can
  both call their combo `vertical` without sharing limits or cancellation. External partial fills
  or a closed leg block further simulated combo fills until reconciled/cancelled.
- **The journal is not the ledger.** The execution journal is an append-only story of each order
  (`submitted`, `acknowledged`, `partially-filled`, `filled`, `cancelled`, …) with its transition
  table enforced; the ledger's `trade.fill` events are the accounting truth. A fill after a
  cancellation is a late fill: journaled, ledgered, and the order left `unresolved` until
  reconciliation says otherwise. A duplicate delivery is recorded once.
- **Paper, backtest, and replay share one fill path.** `fillOrderWithPolicy` is the engine's fill
  sequence — the fill model, slippage, the half-spread, impact, commission, the ledger's fill — and
  the paper broker calls the same function; the difference is who supplies the observations.
  Slippage, spread and impact already included in `pricePerUnit` are not charged again.
  `executionPriceAdjustment` reports their absolute cash-equivalent deviation for attribution;
  `costs` holds only additional cash charges. The ledger does not debit attribution fields.
- **Writes are capabilities.** `trade.preflight` and `portfolio.rebalance_proposal` need
  `trade:propose` (held by default); `trade.authorize` needs `trade:approve`; `trade.submit`,
  `trade.cancel`, and `trade.reconcile` need `trade:paper`; `portfolio.record_events` needs
  `portfolio:write`. The runtime refuses a missing capability with `operation.capability_missing`
  before it parses the input.
- **One order vocabulary.** Every order on the surface spells `side` as core `OrderSide`, `type`
  as core `OrderType` (kebab-case: `market`, `limit`, `stop`, `stop-limit`, `market-on-open`,
  `market-on-close`) and `timeInForce` as core `TimeInForce`; `sideOf` and `signOf` are the one
  bridge between a signed exposure and a sided order. An intent line sizes a `quantity` or a
  `notionalWeight` (a fraction of NAV at the mark); market data is keyed by `symbol`, ledger and
  trade objects by `instrumentId`.

## A first paper trade, directly

This is the pure SDK path: the application owns approval and supplies the domain grant itself.
`createAuthorizationGrant` creates a representation; it does not establish trusted runtime approval.
For registry/CLI/HTTP/MCP execution, use `totalfinance.trade.authorize` against the same authorization
store that submission will use, as in the transport example below.

```ts
import { createMarketSnapshot } from '@insiderfinance/totalfinance/core/artifacts';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
} from '@insiderfinance/totalfinance/portfolio';
import {
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
  reconcileExecution,
} from '@insiderfinance/totalfinance/portfolio/trade';
import { createPaperBroker } from '@insiderfinance/totalfinance/backtest/paper';

const NOW = Date.UTC(2026, 0, 7, 21);
const ledger = createPortfolioLedger({ portfolioId: 'primary', baseCurrency: 'USD', events });
const spots = Object.fromEntries([
  ['AAPL', { price: 110, currency: 'USD' }],
  ['MSFT', { price: 50, currency: 'USD' }],
]);
const market = createMarketSnapshot({ asOf: NOW, observations: { spots } });

// 1. propose — an intent in the frozen order grammar; the rationale is metadata
const plan = normalizeTradePlan({
  intent: {
    kind: 'totalfinance.trade-intent',
    schemaVersion: 1,
    accountId: 'main',
    asOf: NOW,
    orders: [{ instrumentId: 'MSFT', side: 'buy', quantity: 200, type: 'market' }],
    rationale: 'rotate a fifth of AAPL into MSFT',
  },
  portfolio: ledger.state,
  market,
  asOf: NOW,
});

// 2. preflight — every check with its verdict, one decision
const preflight = preflightTradePlan({
  plan,
  portfolio: ledger.state,
  market,
  asOf: NOW,
  policy: {
    mode: 'paper',
    limits: { maximumPositionWeight: 0.5 },
    maximumOrderNotional: 50_000,
    marketMaximumAgeMs: 86_400_000,
  },
  costs: { commissionBps: 5, slippageBps: 10 },
});
if (preflight.decision.verdict !== 'allow') throw new Error(preflight.decision.verdict);

// 3. authorize — bounded, content-addressed, expiring
const grant = createAuthorizationGrant({
  plan,
  preflight,
  marketMaximumAgeMs: 86_400_000,
  mode: 'paper',
  variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
  expiresAt: NOW + 86_400_000,
  approvedBy: 'trey',
  idempotencyKeys: { prefix: 'run', count: 3 },
  now: NOW,
});

// 4. execute on paper — submit, then meet the market
const broker = createPaperBroker({
  baseCurrency: 'USD',
  sourceId: 'paper:main',
  accountId: 'main',
});
const receipt = broker.submit({
  plan,
  grant,
  idempotencyKey: 'run:1',
  now: NOW + 1_000,
  portfolioHash: preflight.portfolioHash,
  marketHash: preflight.marketHash,
  marketAsOf: NOW,
});
const bar = {
  kind: 'bar',
  bar: {
    symbol: 'MSFT',
    timestampMs: NOW + 60_000,
    open: 50,
    high: 51,
    low: 49,
    close: 50.5,
    volume: 10_000,
  },
};
const stepped = broker.step({
  observations: Object.fromEntries([['MSFT', bar]]),
  asOf: NOW + 60_000,
});
const after = applyPortfolioEvents({ previousState: ledger.state, events: stepped.events });

// 5. reconcile — the journal against the ledger's fills
const report = reconcileExecution({
  journal: broker.journal(),
  ledger: after,
  sourceId: 'paper:main',
  fills: stepped.fills,
  asOf: NOW + 120_000,
  tolerance: { quantity: 1e-9, cashAmount: 0.01 },
});
// receipt.orders → acknowledged; stepped.fills → one fill of 200 MSFT at the open; report.reconciled → true
```

A retry of `broker.submit` with `run:1` returns `receipt` itself; `run:1` with another plan is
`trade.idempotency_conflict`; `broker.cancel`, `broker.deliver` (a late fill, a duplicate delivery,
an asynchronous rejection), and `broker.halt` are the hazard surface, and every one of them leaves
the journal consistent and the unresolved state visible.

## The same lifecycle on every transport

The six operations of `tradePack` run through the registry, the CLI, the HTTP server, and the MCP
server with one result. The runtime holds the caller's capabilities and the lifecycle's stores as
explicit parameters:

```ts
import {
  createMemoryArtifactStore,
  createMemoryAuthorizationStore,
  createMemoryExecutionJournalStore,
  createOperationRegistry,
  defaultPacks,
  journeyPacks,
  tradePack,
} from '@insiderfinance/totalfinance/workflows';

const registry = createOperationRegistry({
  packs: [...defaultPacks(), ...journeyPacks(), tradePack()],
});
const options = {
  artifacts: createMemoryArtifactStore(),
  stores: {
    authorization: createMemoryAuthorizationStore(),
    journal: createMemoryExecutionJournalStore(),
  },
  capabilities: [
    'portfolio:read',
    'analytics:run',
    'trade:propose',
    'trade:approve',
    'trade:paper',
    'portfolio:write',
  ],
  createdTimestampMs: Date.parse('2026-09-06T12:00:00Z'),
};
const { plan, ...preflight } = registry.run({
  id: 'totalfinance.trade.preflight',
  input: { intent, portfolio: ledgerHandle.uri, market, asOf, policy },
  ...options,
}).structured;
const { grant } = registry.run({
  id: 'totalfinance.trade.authorize',
  input: {
    plan,
    preflight,
    approvedBy,
    expiresAt,
    now,
    variance,
    marketMaximumAgeMs,
    idempotencyKeys,
    createdTimestampMs,
  },
  ...options,
}).structured;
const submitted = registry.run({
  id: 'totalfinance.trade.submit',
  input: {
    plan,
    grantHash: grant.contentHash,
    idempotencyKey,
    now,
    portfolioHash,
    marketHash,
    marketAsOf,
    sourceId,
    accountId,
    baseCurrency,
    observations,
    asOf,
  },
  ...options,
}).structured;
const recorded = registry.run({
  id: 'totalfinance.portfolio.record_events',
  input: { portfolio: ledgerHandle.uri, events: submitted.recovery.events, createdTimestampMs },
  ...options,
}).structured;
const reconciled = registry.run({
  id: 'totalfinance.trade.reconcile',
  input: {
    journalId: 'paper:main:journal',
    ledger: recorded.handle.uri,
    sourceId,
    fills: submitted.recovery.fills,
    asOf,
    tolerance,
  },
  ...options,
}).structured;
```

On the CLI, select `--profile full` to include `tradePack`. First run
`totalfinance run totalfinance.trade.authorize --profile full --input authorize.json --capability trade:approve --store ~/.totalfinance/store`,
then use that approved grant's hash in
`totalfinance run totalfinance.trade.submit --profile full --input submit.json --capability trade:paper --store ~/.totalfinance/store`.
The same store directory holds the artifacts, authorizations, and journals. Without the required
capability the CLI exits with `operation.capability_missing` before reading the input. These local
CLI calls do not use HTTP bearer authentication.

The HTTP server additionally requires `authenticationToken` when write operations are enabled,
including approval even though its operation declares `sideEffect: 'none'`. Configure the server's
`capabilities` and `stores` explicitly; generate a token with at least 32 cryptographically random
bearer-token characters and share it privately with trusted clients. The server CLI reads
`--token-file <path>` or `TOTALFINANCE_HTTP_TOKEN`, never a secret CLI argument. Clients send
`Authorization: Bearer <token>` and `Content-Type: application/json` on JSON POSTs. A token does
not grant capabilities or replace stored approval. Job creation/cancellation also requires the
token; unauthenticated inline read-only analytics remain available. See the
[HTTP guide](./http.md) for executable setup, Host/Origin restrictions, and status codes.

The MCP server takes `capabilities`, `stores`, and `readOnly: false` to list the write tools.
Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) derive from
the operation's effect fields; those annotations do not replace capability or approval checks.

## Continuing a paper order and upgrading stores

A workflow call rebuilds its broker from the authoritative journal store at `<sourceId>:journal`.
To advance an unmatched or partially filled order, retry `totalfinance.trade.submit` with the same
source, account, plan, idempotency key, and stores, and provide later `observations` and `asOf`.
Changing `sourceId` or switching the authoritative store requires fresh approval; replaying a
consumed grant there refuses with `trade.grant_consumed`, even when the key is unchanged.
The workflow still checks `trade:paper` and matching approval in the trusted store on each submission
call. Grant expiry is checked at first acceptance, not on a same-key receipt retry or subsequent
`step`. Expiry does not cancel already-accepted orders: an accepted GTC order can continue filling.
Use `totalfinance.trade.cancel` or the SDK broker's `halt` to stop outstanding orders; order time-in-force
expiry rules still apply. This is not per-fill reauthorization or an account-wide revocation model.
The receipt stays the same, but the response can contain new fills,
ledger events, expiries, and the current `open` set. Top-level `fills`/`events` are current-call
deltas; `recovery` is cumulative for that receipt, as explained below. Journal restoration
preserves fill identities across calls.
Use `totalfinance.trade.cancel` with `trade:paper` and the same authoritative journal to cancel outstanding
orders. Cancellation uses the persisted order context and has no grant input; it does not require
a new grant or `trade:approve`. It does require the original authorization store as well as the
journal, so any durably prepared submission is recovered before cancellation allocates event IDs.
HTTP cancellation still requires the server's bearer credential.
The pure broker also supports restoring `journal: broker.journal()` and then calling `step`,
`cancel`, or `deliver`.

### Recovering a lost submission response

A journal commit can succeed even when its HTTP/CLI response is lost. Retry the original submission
with the same source, authoritative store, plan, and key. Capability and trusted-store approval
checks still apply; grant expiry was checked at first acceptance. Receipt recovery remains possible
after grant expiry. Do not treat an empty current-call delta as proof that nothing previously filled.

The same retry also recovers a failure **between** the authorization claim and journal commit.
The authorization store retains the exact prepared event batch; every submit or cancel into the
original journal recovers all its pending batches before allocating new identities. The journal
appends them idempotently before reconstructing receipts. No prices, quantities or identities are
recalculated. An authorization-write failure before the claim leaves no journal effects. An
ambiguous persistence failure keeps authority claimed and fails closed until the original stores
can recover it; never delete the claim to retry. Memory stores survive only within their process.

| Submission field                    | Meaning                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `receipt`                           | immutable submission identity; the same receipt on retry                                                 |
| `fills`, `events`                   | only the new fills and ledger events produced by this call                                               |
| `recovery.fills`, `recovery.events` | cumulative persisted fills and reproducible ledger events for this receipt's orders, including this call |

Apply `recovery.events` with `totalfinance.portfolio.record_events` against the latest ledger handle,
as in the example above. Reapplying an identical event ID and body is idempotent in the ledger,
so this recovers committed-but-lost fills without recording already-applied economics twice.
Use `recovery.fills` for reconciliation of those same orders. Recovery grows with later fills;
it neither re-runs the fill engine nor includes unrelated receipts from the journal. Preserve
the returned event IDs and bodies: do not generate replacement IDs or modify timestamps on retry.

### Authoritative stores and legacy upgrades

Submit and cancel require `stores.journal` and `stores.authorization`; an optional inline `journal` is an exact snapshot
assertion, not a way to import or replace persisted history. Custom `ExecutionJournalStore`
implementations must provide a stable, non-empty `storeId` and `transact`: one synchronous transaction serializes restoration,
idempotency checks, identity allocation, and the appended event batch, committing before returning
the result. Use the supplied memory/file stores unless implementing that contract deliberately.
Custom authorization stores must atomically compare-and-set `consume`, persist its exact
`journalEvents` before returning, and return detached consumption snapshots. A different claim
must fail before it can commit journal effects. The file store's `journals/store-id` belongs to
the backup together with authorization records and journal history: do not delete, edit, or copy
it into an independent simulation. Do not run a restored backup and its original as independent
active stores. This is one-host local persistence, not distributed fencing or live-broker exactly-once delivery.

Before upgrading file stores, stop all old-version writers. Journals now use an identity-checked
envelope in `journals/v2/<sha256-of-exact-id>.json`; `list()` returns original journal IDs. A legacy
sanitized file is readable only when every embedded ID matches the exact requested journal ID.
The next successful transaction migrates it and retains the old file. Do not rename a foreign or
colliding file to force adoption. Malformed JSON, invalid event bodies, mixed identities, and
filename/identity mismatches fail closed; corruption is not treated as an empty journal and does
not trigger migration or a replacement write. A valid foreign collision can be ignored only after
its full body and identity have been validated. Incomplete legacy paper-order context refuses restoration:
recover the original order/instrument/account/execution facts, rather than inventing them or
silently discarding open orders. File transactions require a coherent local filesystem on one host,
not a distributed/shared-network lock service.
Pre-preview consumption records lacking storage identity or write-ahead events fail closed;
recover the original facts explicitly or start a separately approved simulation. An empty
replacement store never silently inherits an earlier grant.

## What is deferred, and why

- **Live execution** (`AT8`): the lifecycle is the same; the adapter is not written, and a `mode`
  of `'live'` is `trade.live_unavailable` everywhere.
- **Declared execution policies on the wire**: the paper broker on a transport runs the simplified
  policy; a declared policy (fill models, cost models) is SDK-only, as it is for the environment.

Read next: [`trading-environment.md`](./trading-environment.md) for the environment the lifecycle
composes with, and the contract
[`trade-lifecycle-and-paper-execution.md`](../specs/trade-lifecycle-and-paper-execution.md) for every
decision and its evidence.
