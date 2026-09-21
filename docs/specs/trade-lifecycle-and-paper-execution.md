# The safe trade lifecycle and paper execution — the Stage 7B.2 (AT5) contract

**Status: `COMPLETE` — five slices landed @ `b25e28573`, `f3ef2b2ce`, `834a11758`, `ac3e00885`, `44cd9d72e`; every exit-gate row ticked; authored 2026-09-05 from the `AT5` row of
[`agent-native-portfolio-and-trading-platform.md`](../agent-native-portfolio-and-trading-platform.md)
(its safe-trade-lifecycle, permanent-laws, store, and Journey 4 sections), the Stage 7 crosswalk of
[`implementation-order.md`](../implementation-order.md), and the frozen FC7 / FC8 / 7A / 7B.1
surfaces; accepted 2026-09-05 after the review record below; slices land in the order listed.**

Stage 7B.1 gave agents a deterministic environment to be evaluated in. `AT5` gives them the one
lifecycle through which a decision may become an order — `observe → analyze → propose → preflight →
authorize → execute → reconcile` — with every stage an explicit artifact, every write an explicit
effect, every external action idempotent, and the first execution adapter a deterministic paper
broker that shares the ledger's accounting law. No live venue ships here (`AT8` is separately
authorized); what ships is everything a live adapter would have to satisfy, proven on paper.

## Outcome

**September correctness addendum:** the original completion evidence below is historical.
[`review-september-2026-repairs.md`](./review-september-2026-repairs.md) is locally verified complete
on `dccfce53` plus the repair changes. Stage 5A/5B remain maintainer-held; this is not publication or
commit/push authority, and does not claim hosted-matrix success. Paper submission/cancellation
requires an authoritative journal store and one
transaction covering restore, idempotency, identity allocation and append. An optional inline
journal asserts the exact persisted snapshot; it cannot replace history. Restored submissions
retain the full order, instrument, account, execution-policy identity and normalized fills.
Incomplete legacy paper journals refuse explicitly and require recovery from original facts.

Inline grants must have matching approval in the trusted authorization store just like
`grantHash` inputs; a valid hash is integrity, not authority. The pure domain grant function
remains usable independently, but transports require the approved runtime path. HTTP mutations
also require the server-owned bearer credential and the server's capability ceiling; see the
[HTTP guide](../guides/http.md). Local file stores serialize writers and use exact identities;
they are local-host stores, not a distributed/database substitute. Live execution and an
account-wide durable kill switch remain separately governed work.

**Idempotency scope (September 21 amendment):** retain `sourceId`, the authorization store and the
original journal store on retries. Workflow submission consumes each grant once in its trusted
authorization store, binding the journal's persistent `storeId`, receipt, key and exact validated
event batch before journal commit. Retry recovers that batch after a failed commit; a fresh store,
source or key is refused. The pure SDK verifier/broker remains state-passing and does not supply
this cross-store coordinator. There is no account-wide or live-venue exactly-once guarantee.
The [pre-publish repair checklist](./pre-publish-interface-repairs.md#september-21-freeze-repair-checklist-takes-precedence-over-historical-completion-claims)
supersedes the older independent-simulation and consumption wording in the historical slice records.

A cold TypeScript developer, with the packed tarballs and this repository's docs, can:

1. turn a trade intent or a rebalance proposal into a normalized, content-addressed `TradePlan`
   whose orders use the frozen execution grammar, with the evidence that produced it;
2. preflight that plan against a ledger, a market snapshot, and a structured policy and receive a
   report that shows the portfolio before and after, every check with its verdict, the estimated
   costs, and every assumption or check that could not be made — a report that never upgrades
   missing information into an allow;
3. mint an authorization grant that binds the exact plan hash, the portfolio and market snapshot
   hashes with a maximum age, the execution mode, variance bounds, an expiry, an audit identity,
   and a bounded idempotency key set, and have execution refuse anything the grant does not cover;
4. execute the plan against the paper broker with an idempotency key, replay a timeout and retry, a
   partial fill, a cancellation, a late fill, and a duplicate delivery, and see one economic trade
   per intent within the same journal/store, with every unresolved state visible in that journal;
5. reconcile the journal, the fills, the ledger's cash and holdings, and the P&L, and read the
   differences as typed rows with the corrections the reconciliation drafts;
6. run every stage as an operation — `trade.preflight`, `trade.authorize`, `trade.submit`,
   `trade.cancel`, `trade.reconcile`, `portfolio.record_events` — on the registry, the CLI, the
   HTTP server, and the MCP adapter with the same schema, result, effect metadata, capability
   refusal, and teaching errors, from the packed tarballs.

## Non-goals

- **No live broker or provider credential.** The paper broker is the only adapter; `AT8`
  ships live adapters under their own authorization. Domain computation remains credential-free;
  the HTTP transport's server-owned mutation credential is required by the September addendum.
- **No hosted authorization.** Grants are content-addressed records in a store the caller
  supplies; OAuth, tenancy, audience binding, and step-up flows are the hosted product's (`AT7`).
  The runtime's capability check is a local, explicit gate, not an identity system.
- **No second accounting.** Every fill reaches the ledger through `portfolioEventsFromFill`; the
  paper broker fills through the declared execution policy's models; preflight values the
  before/after states through `portfolioSnapshot` and judges them through `monitorPortfolio`.
- **No free-text execution.** The actionable boundary accepts a closed `TradePlan` or a
  `TradeIntent`; rationale is metadata.
- **No optimizer, no new risk formula.** Preflight composes the existing risk and policy verbs; a
  limit the platform cannot yet evaluate is reported as `unverifiable`, never assumed satisfied.
- **No acceleration; no Stage 6 data.** Market snapshots are supplied.

## Decision 1 — package placement and dependency edges

- **`@totalfinance/portfolio` gains the `./trade` subpath** (`packages/portfolio/src/trade/`): the
  lifecycle's pure compute — the artifacts and their guards, `normalizeTradePlan`,
  `preflightTradePlan`, `evaluateTradePolicy`, `createAuthorizationGrant` / `verifyAuthorizationGrant`,
  the execution journal (`applyJournalEvents`, `journalOrderStates`), and `reconcileExecution`. It is
  browser-safe economic state, credential-free, and depends on nothing new.
- **`@totalfinance/backtest` gains the `./paper` subpath** (`packages/backtest/src/paper/`):
  `createPaperBroker` — fills through the FC8 execution policy against explicit market
  observations and emits journal events and normalized fills; it depends on `@totalfinance/portfolio`
  as the package already does. The legacy single-instrument `SimulatedBroker` is untouched.
- **`@totalfinance/workflows`** gains the `tradePack` (six operations), the `capabilities` runtime
  option, the `authorization` and `journal` handle kinds, `createMemoryAuthorizationStore` and
  `createMemoryExecutionJournalStore`, and their file counterparts under `./local`. The CLI, HTTP
  server, and MCP server expose the capability and store options. No new package.
- Names follow the naming policy: `TradeIntent`, `TradePlan` (the existing `TradePlanArtifact`
  stays the rebalance proposal's plan and IS the plan this stage normalizes — one grammar),
  `PreflightReport`, `TradePolicy`, `PolicyDecision`, `PolicyCheck`, `AuthorizationGrant`,
  `ExecutionJournalEvent`, `ExecutionOrderState`, `ExecutionReceipt`, `ReconciliationReport`,
  `PaperBroker`.

## Decision 2 — the artifacts, content-addressed

| Artifact               | Kind                                 | Carries                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TradeIntent`          | `totalfinance.trade-intent`          | the desired economic action in the frozen order grammar (`instrumentId`, `side`, `quantity` or `targetWeight`, `type`, `limitPrice?`, `stopPrice?`, `timeInForce?`), the account, `asOf`, `rationale?`, `evidence?` (artifact ids)                                 |
| `TradePlanArtifact`    | `totalfinance.trade-plan`            | the existing FC7 shape (trades with reference prices and estimated notional, `policyContentHash`, `contentHash`) plus `orders: OrderIntent[]` (the normalized execution orders), `source` (`intent` or `rebalance-proposal` with its id), `rationale?`, `evidence` |
| `PreflightReport`      | `totalfinance.preflight-report`      | `planHash`, `portfolioHash`, `marketHash`, `before` / `after` (`portfolioSnapshot` blocks), `estimates`, `checks: PolicyCheck[]`, `decision: PolicyDecision`, `unverifiable: string[]`, `assumptions`, `diagnostics`                                               |
| `AuthorizationGrant`   | `totalfinance.authorization-grant`   | Decision 5                                                                                                                                                                                                                                                         |
| `ExecutionReceipt`     | `totalfinance.execution-receipt`     | `planHash`, `grantHash`, `idempotencyKey`, `adapter`, `orders: ExecutionOrderState[]`, `fills: NormalizedFill[]`, `journalEventIds`, `assumptions`, `diagnostics`                                                                                                  |
| `ReconciliationReport` | `totalfinance.reconciliation-report` | `planHash?`, the journal's order states, the fills matched to ledger events, `reconcilePortfolio`'s result against an external snapshot when one is given, `unresolved: […]`, `assumptions`, `diagnostics`                                                         |

Every artifact carries `kind`, `schemaVersion`, and `contentHash` over its canonical body; every
guard is a `(functionName, label, value)` door; every artifact is deeply frozen.

## Decision 3 — normalization and preflight

- `normalizeTradePlan({ intent | proposal, portfolio, market, asOf, accountId? })` produces the
  plan: an intent's `targetWeight` becomes a whole-unit quantity at the mark (the environment's
  `unitsFor` rule, lot size aware through `allocatePortfolio` when the instrument declares one),
  every order is validated by `requireOrderIntent`, reference prices come from the market snapshot,
  and a proposal's plan is taken verbatim with its orders derived from its trades.
- `preflightTradePlan({ plan, portfolio, market, asOf, policy, execution?, currencyConversions?,
averageDailyVolumes?, marketMaximumAgeMs? })` — the checks the agent-native doc lists, each a
  `PolicyCheck { name, verdict: 'pass' | 'fail' | 'unverifiable' | 'require-approval', value,
limit, detail }`:
  - schema and instrument validity (the plan's orders against the portfolio's instruments);
  - market age and provenance (`asOf − market.asOf` against `marketMaximumAgeMs`);
  - holdings, cash, buying power, and open orders (from the ledger state and the journal when one
    is supplied);
  - duplicate or conflicting orders within the plan and against open orders;
  - estimated commission, spread, slippage, and impact through the execution policy's cost models
    (`execution.simplified()` by default, described in `assumptions`);
  - the portfolio before and after: hypothetical fills at the reference prices folded through
    `portfolioEventsFromFill` and `applyPortfolioEvents` into an after-state, both states valued by
    `portfolioSnapshot`; concentration, leverage, drawdown, daily loss, cash reserve, and margin
    families judged by `monitorPortfolio` on the after-state with `policy.limits`;
  - option implications (a net-short option leg under `allowUndefinedRiskOptions: false`, expiry
    within `optionExpirationWarningDays`, assignment moneyness — the monitor's families);
  - the calendar and session (`calendar` + the execution policy's session halts);
  - every limit the platform cannot evaluate from the inputs given (VaR without a scenario set,
    liquidity without volumes, factor exposure) is `unverifiable` and listed.
- The decision is `allow` only when every check passes; `deny` when any fails; `require-approval`
  when any check is `require-approval` or `unverifiable` and the policy's `onUnverifiable` is
  `'require-approval'` (the default; `'deny'` is the alternative). Missing information never
  becomes an allow.

## Decision 4 — the policy model

`TradePolicy` is a closed record: FC7's `PolicyLimits` verbatim under `limits`, plus
`allowedAccounts?`, `allowedAssetClasses?`, `allowedInstruments?`, `allowedOrderTypes?`,
`allowedSessions?`, `maximumOrderQuantity?`, `maximumOrderNotional?`, `maximumEstimatedCost?`,
`maximumSlippageBps?`, `maximumParticipation?`, `allowUndefinedRiskOptions?`, `marketMaximumAgeMs?`,
`cooldownMs?`, `maximumTurnover?`, `requireApprovalAbove?: { notional?, quantity? }`,
`onUnverifiable?`, and `mode: 'paper'` (the only mode this stage accepts; `'live'` is a typed
refusal naming `AT8`). `evaluateTradePolicy` is a deterministic function of the plan, the states,
and the policy; a stricter policy composed with a looser one is the stricter (`mergeTradePolicies`
takes the minimum of every bound and the intersection of every allow list).

## Decision 5 — the authorization grant and its verification

- `createAuthorizationGrant({ plan, preflight, portfolioHash, marketHash, marketMaximumAgeMs,
mode: 'paper', account, variance: { maximumQuantityRatio, maximumNotionalRatio, maximumSlippageBps },
expiresAt, approvedBy, idempotencyKeys: string[] | { prefix, count }, now })` refuses a preflight
  whose decision is `deny`, a plan hash that does not match the preflight, or an expiry in the past,
  and returns the grant with its own `contentHash`.
- `verifyAuthorizationGrant({ grant, plan, preflight, now, portfolioHash, marketHash, marketAsOf,
idempotencyKey })` returns `{ valid: boolean; reasons: GrantRefusal[] }` — expired, plan hash
  mismatch, portfolio or market hash mismatch, market older than the grant allows, mode mismatch,
  account mismatch, idempotency key outside the set, quantity or notional variance exceeded. A
  material change produces a new plan and needs new authority. The broker invokes verification
  at first submission acceptance, not when returning an existing same-key receipt or at each fill.
- `totalfinance.trade.submit` requires a grant hash or inline grant matching approved content in the
  trusted authorization store on every call. The broker verifies its bindings, including expiry,
  at first acceptance; an existing same-key receipt returns before that check and `step` does not
  re-check expiry. Grant expiry does not cancel accepted GTC orders or prevent receipt recovery.
  Stop accepted orders explicitly with cancellation or the SDK broker's halt; the orders' own
  time-in-force expiry still applies. There is no new per-fill authority or account-wide revocation
  model. `totalfinance.trade.cancel` has no grant
  input: it requires `trade:paper` and uses persisted order context in the authoritative journal.
  The shared `authorization: 'policy'` metadata does not imply that every operation accepts a
  grant. `authorization: 'human'` marks approval, which needs `trade:approve`.

## Decision 6 — the execution journal

An append-only event list separate from the portfolio ledger (agent-platform law 3):
`ExecutionJournalEvent { eventId, journalId, timestampMs, orderId, planHash, idempotencyKey?,
eventType, detail, sourceId, provenance }` with the closed type set `proposed`, `preflighted`,
`authorized`, `submitted`, `acknowledged`, `partially-filled`, `filled`, `rejected`, `cancel-requested`,
`cancelled`, `replaced`, `expired`, `reconciled`, `unresolved`. `applyJournalEvents` folds them to
`ExecutionOrderState { orderId, planHash, state: 'submitted' | 'acknowledged' | 'partially-filled' |
'filled' | 'cancelled' | 'rejected' | 'expired' | 'unresolved', filledQuantity, remainingQuantity,
fillIds, lastEventId, terminal: boolean }` with the transition table enforced (a fill after a
cancellation is a `late fill`: the order stays terminal, the fill is journaled AND reaches the ledger,
and the state is marked `unresolved` with the reason). Duplicate delivery of an event with a known
`eventId` is idempotent — recorded once, reported in diagnostics.

## Decision 7 — the paper broker

`createPaperBroker({ baseCurrency, sourceId, accountId, execution?, journal?, instruments? })` — the first
adapter, deterministic and credential-free. The broker does not hold a ledger or a clock; callers
apply its returned events to the ledger and supply operation instants explicitly. Restoring a
complete journal retains the original order/instrument/account/execution context:

- `submit({ plan, grant, idempotencyKey, now })` verifies the grant on first acceptance (Decision 5), refuses a key
  already used with a different plan hash (`trade.idempotency_conflict`), returns the SAME receipt
  for a key already used with the same plan in that journal (a retry is not a second order), journals `submitted`
  and `acknowledged`, and holds the orders open;
- `step({ observations, asOf })` meets every open order with the market through the execution
  policy's fill model (the same `policy.fill.fill` the engines call, the same `normalizedFillFromDecision`
  bridge), journals `partially-filled` / `filled` / `expired`, and returns the fills and the ledger
  events (`portfolioEventsFromFill`) — the caller applies them to the ledger (or `portfolio.record_events`
  does);
- `cancel({ orderId, now })` journals `cancel-requested` then `cancelled` (or `rejected` when the
  order is terminal); a fill that arrives after a cancellation is the late-fill path of Decision 6;
- `deliver({ event })` accepts an external journal event (a duplicate delivery, a late fill, an
  asynchronous rejection) for the hazard suite;
- `halt({ reason, now })` is the kill switch: every open order is cancelled and every later submit
  refuses with `trade.halted` until `resume`.

Paper, backtest, and replay therefore share fills, events, and accounting exactly; the difference is
who supplies the observations.

## Decision 8 — reconciliation

`reconcileExecution({ journal, ledger, fills, external?, asOf, tolerance })` joins the journal's
order states to the ledger's `fillEffects` (every filled quantity must be a ledger fill; every
ledger fill from this source must be journaled), lists the unresolved orders, and — when an external
snapshot is given — composes `reconcilePortfolio` verbatim for cash, holdings, and the drafted
corrections. `reconciled` is true only when the journal, the fills, and the external snapshot agree
within tolerance and no order is unresolved.

## Decision 9 — capabilities in the runtime

- `runOperation` / `OperationRegistry#run` gain `capabilities?: readonly string[]` (default
  `['portfolio:read', 'analytics:run', 'trade:propose']`). An operation whose
  `requiredCapabilities` are not all present refuses with the new registered code
  `operation.capability_missing`, naming the missing ones, before parsing the input.
- `trade.preflight` requires none beyond the defaults; `trade.authorize` requires `trade:approve`;
  `trade.submit`, `trade.cancel`, and `trade.reconcile` require `trade:paper`;
  `portfolio.record_events` requires `portfolio:write`. Live is a typed refusal.
- The CLI takes `--capability <name>` (repeatable); `totalfinance-http` and the MCP server take a
  `capabilities` option; every transport's description carries `requiredCapabilities`, and the
  annotations become honest: `readOnlyHint: false` and `idempotentHint` per the operation for the
  write operations (Stage 7A's "every operation read-only" derivation is replaced by a derivation
  from the effect fields).

## Decision 10 — the operations and the stores

| Operation                              | Effect                                            | Authorization | Idempotency | Capability        |
| -------------------------------------- | ------------------------------------------------- | ------------- | ----------- | ----------------- |
| `totalfinance.trade.preflight`         | none                                              | none          | n/a         | defaults          |
| `totalfinance.trade.authorize`         | none (mints a grant into the authorization store) | human         | n/a         | `trade:approve`   |
| `totalfinance.trade.submit`            | external-order (paper)                            | policy        | required    | `trade:paper`     |
| `totalfinance.trade.cancel`            | external-order (paper)                            | policy        | optional    | `trade:paper`     |
| `totalfinance.trade.reconcile`         | none                                              | none          | n/a         | `trade:paper`     |
| `totalfinance.portfolio.record_events` | portfolio-state                                   | none          | required    | `portfolio:write` |

- Stores: `AuthorizationStore` (`put({ grant, createdAt })`, `get(hash)`, `list()`) and `ExecutionJournalStore`
  (`transact({ journalId, execute })`, `append({ events })`, `read(journalId)`, `list()`), memory and file implementations, passed to the
  runtime as `stores: { authorization, journal }` beside `artifacts`; nothing is looked up by session.
  Current pre-preview amendments: put timestamps are `createdTimestampMs`; authorizations also
  expose atomic `consume` with `journalStoreId`, `journalId`, `receiptId`, `idempotencyKey`,
  `consumedTimestampMs` and the exact `journalEvents` batch. Journal stores expose a stable
  `storeId`. Every workflow submit/cancel recovers all pending batches for that store/journal before
  another identity is allocated; both stores are required, although cancellation takes no grant.
  `transact` is mandatory: its synchronous `execute` receives a detached prior event snapshot and
  returns `{ events, result }`. It serializes restoration, idempotency, identity allocation and
  commit, appends only the new batch, and returns the result only after commit; exceptions commit
  nothing. Nested transactions/appends on the same journal are disallowed. Submit/cancel always
  use the authoritative store; inline history must match that complete snapshot exactly.
  File-store upgrades stop old writers before identity-checked legacy migration; incomplete paper
  contexts require original facts. See the [store upgrade guide](../guides/trade-lifecycle.md#continuing-a-paper-order-and-upgrading-stores).
  The `portfolio` handle kind stores the ledger; `portfolio.record_events` reads a ledger handle,
  applies validated events, and puts the new ledger, returning its handle (the write is the
  content-addressed put; an unchanged ledger is the same handle).
- Handle kinds gain `authorization` (`totalfinance://authorizations/<hash>`) and `journal`
  (`totalfinance://journals/<id>`).
- Declarative inputs only: a plan travels inline or by handle; the paper broker's observations travel
  inline (bars, quotes, books) under the row caps.
- Submission response recovery is additive: `receipt` remains immutable and top-level `fills` /
  `events` remain current-call deltas. `recovery: { fills, events }` contains cumulative persisted
  normalized fills and reproducible ledger envelopes for that receipt's orders, including the
  current call. A retry after a committed-but-lost response uses the same source/store and key,
  then applies `recovery.events` to the latest ledger via `portfolio.record_events`; identical
  event IDs and bodies fold once. Recovery does not re-run execution or include other receipts,
  and retains capability/trusted-store checks. Grant expiry is an initial-acceptance check, so
  an already-issued receipt remains recoverable after grant expiry. See the
  [recovery guide](../guides/trade-lifecycle.md#recovering-a-lost-submission-response).

## Decision 11 — bounded work, failure behavior, stable codes

New codes: `trade.plan_invalid`, `trade.preflight_denied`, `trade.grant_invalid` (with the refusal
reasons), `trade.grant_expired`, `trade.idempotency_conflict`, `trade.halted`, `trade.live_unavailable`,
`trade.journal_transition_invalid`, `operation.capability_missing`. Every one joins the catalogue.
Bounds: a plan holds at most 1,000 orders; a journal read at most 100,000 events; the reconciliation
tolerance is explicit (no default); observation row caps are the engines'.

## Decision 12 — determinism, immutability, provenance

Every function here is pure or explicitly state-passing: clocks are `now` / `createdAt` arguments,
stores are parameters, results are deeply frozen and content-addressed, and every artifact names
its conventions version, the execution policy's description, the plan and snapshot hashes, and its
parents. The no-side-effects gate scans the new directories with no allowance.

## Ordered implementation slices

| Slice | Content                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `@totalfinance/portfolio/trade`: the artifacts and guards, `normalizeTradePlan`, `TradePolicy` + `evaluateTradePolicy` + `mergeTradePolicies`, `preflightTradePlan` (before/after through the ledger and the monitor); the new codes; manifest rows; fixtures; the budget row. |
| 2     | Authorization: `createAuthorizationGrant` / `verifyAuthorizationGrant`; the execution journal (`applyJournalEvents`, `journalOrderStates`, the transition table); `reconcileExecution`.                                                                                        |
| 3     | `@totalfinance/backtest/paper`: `createPaperBroker` over the execution policy and the ledger; the hazard suite (timeout/retry, partial fill, cancellation, late fill, duplicate delivery, asynchronous rejection, kill switch); Journey 4 as a test.                           |
| 4     | Runtime capabilities and `operation.capability_missing`; the authorization and journal stores (memory + file); the two handle kinds; the `tradePack` operations; transport options (CLI flags, HTTP and MCP options); parity fixtures; the packed-consumer case; pins.         |
| 5     | `docs/guides/trade-lifecycle.md` + `docs/examples/trade-lifecycle.test.ts`; the agent-native doc's lifecycle section amended to the shipped grammar; the closeout: exit gate, completion record, trackers.                                                                     |

Each slice lands as one commit (tests, generated evidence, its record here), followed by a records
commit that names the hash; fetch/fast-forward before every push; never force.

## Acceptance and exit gate

The `AT5` exit ("every submitted paper order has valid bounded authority and reconciles to portfolio
events") and Journey 4, each closed by a named test at a named commit:

- [x] A plan from an intent and a plan from a rebalance proposal normalize to the same grammar; a
      malformed intent teaches; free text is metadata (a rationale never changes an order) —
      `packages/portfolio/test/trade.test.ts` "normalizeTradePlan" @ `b25e28573`.
- [x] Preflight never upgrades missing information: an unverifiable check yields
      `require-approval` (or `deny` under the stricter policy); a failed check yields `deny`; the
      before/after states are the ledger's and the monitor's — `trade.test.ts` "preflightTradePlan" @ `b25e28573`.
- [x] A grant binds the plan hash, both snapshot hashes, the age, the mode, the account, the
      variance, the expiry, the audit identity, and the key set; execution refuses each violated
      binding with its reason; a material plan change needs a new grant —
      `packages/portfolio/test/trade-lifecycle.test.ts` "createAuthorizationGrant" / "verifyAuthorizationGrant" @ `f3ef2b2ce`.
- [x] Idempotency within the same source journal and authoritative store: a retry with the same key and plan returns the same receipt and creates no
      order; the same key with another plan is a conflict; duplicate delivery of a journal event is
      recorded once — `packages/backtest/test/paper-broker.test.ts` "createPaperBroker.submit" and "the hazard suite" @ `834a11758`.
- [x] The hazard suite: timeout/retry, partial fill, cancellation, late fill (journaled, ledgered,
      unresolved), asynchronous rejection, kill switch — one economic trade per intent within that journal/store, every
      unresolved state visible — `paper-broker.test.ts` "the hazard suite" and "Journey 4" @ `834a11758`.
- [x] Reconciliation joins journal states to ledger fills, composes `reconcilePortfolio` for cash
      and holdings, and is true only with no unresolved order — `trade-lifecycle.test.ts` "reconcileExecution" @ `f3ef2b2ce`.
- [x] Capabilities: every write operation refuses without its capability with
      `operation.capability_missing`, on every transport; `mode: 'live'` is a typed refusal —
      `packages/workflows/test/trade-pack.test.ts` "refuses a write operation without its capability", `tools/transport-parity.test.ts`, `tools/packed-consumer.test.ts` (the CLI without --capability) @ `ac3e00885`; `trade.test.ts` "refuses live" @ `b25e28573`.
- [x] The six operations ship with schema, effects, authorization, idempotency, parity across the
      five transports, and a packed-consumer run; annotations derive from the effect fields —
      `trade-pack.test.ts` "registers the six operations", `tools/transport-parity.test.ts`, `tools/packed-consumer.test.ts` @ `ac3e00885`.
- [x] Every new export is manifest-classified, guarded at every door, in the field reference, the
      API report, the README, `llms.txt`, and within its bundle budget; the no-side-effects gate
      scans the new directories; `pnpm regen:check` is byte-stable; `pnpm run ci` and
      `pnpm api:check` exit 0 twice at one commit — every slice landed under the full chain, `pnpm regen:check` clean on each slice commit, `pnpm run ci` + `pnpm api:check` green twice; last at `44cd9d72e`.

## Review record (self-review against the laws, 2026-09-05)

- **Direct APIs preserved; no duplicated math.** Preflight composes `portfolioSnapshot`,
  `applyPortfolioEvents`, `monitorPortfolio`, and the execution policy's cost models; the paper
  broker composes the fill models and `normalizedFillFromDecision`; reconciliation composes
  `reconcilePortfolio`; the rebalance proposal's `TradePlanArtifact` is the plan.
- **The permanent laws, each with an executable row:** event-derived truth (the ledger is written
  only through events); journal and ledger separate, joined by fills; effects explicit per stage;
  free text never executes; authorization bounded, content-addressed, expiring; external actions
  idempotent and reconciled; paper shares the engines' semantics; transport parity generated; the
  compute core credential-free.
- **Bounded.** Plan size, journal size, observation rows, and every tolerance are explicit.
- **Accepted 2026-09-05.** Slice 1 begins.

## Slice records

### Slice 1 (landed 2026-09-05, `b25e28573`) — the artifacts, normalization, the policy, preflight

**Decisions taken while landing.**

- **The executable plan is its own artifact.** `ExecutionPlan` (`totalfinance.execution-plan`, v1)
  carries the orders in the frozen execution grammar, the FC7 trade rows, the source (an intent's
  hash, or a proposal's plan hash and policy hash), the rationale as metadata, the evidence, and a
  content hash over the body; `proposePortfolioRebalance`'s `TradePlanArtifact` stays exactly what
  it is and normalizes into one. Decision 1's "the FC7 plan IS the plan" is amended to "the FC7
  plan normalizes into the plan" — two shapes under one kind and version would have been a lie.
- **`TradeOrder` mirrors `OrderIntent` field for field** in `@totalfinance/portfolio`, because the
  execution grammar lives in `@totalfinance/backtest` and the dependency edge runs the other way; the
  paper broker (slice 3) passes plan orders to the fill models unchanged, and a type-level identity
  test guards the mirror (`packages/backtest/test/trade-order-mirror.test.ts`, on the backtest
  side because that is where both types are visible).
- **A spot-quoted instrument the ledger does not hold is priced as a plain cash instrument**
  (multiplier 1, no contract) and the report says so in `assumptions.instrumentSources`; an option
  or future the ledger does not hold must be described in `instruments` for its terms to count.
  The first draft raised an unverifiable check for every such instrument, which turned every
  first-time equity buy into an approval — evidence, not a gate.
- **The reference price is the spot; a limit price stands in only without one**, so a limit order's
  notional and cost are estimated at the market, not at the caller's price.
- **Sessions are an explicit input** (`session: { open, halted }`), not a calendar lookup —
  `@totalfinance/portfolio` does not depend on the calendars package, and preflight must stay pure.
- **Every exported helper is a typed door.** The enforcement gate measured `decideFromChecks`,
  `referencePriceOf`, and the `currencyConversions` field as defective at the first pass (positional
  arguments read without a guard; `null` where an array is optional crashed untyped). They now refuse
  through the same doors as the verbs — an empty check list is refused outright, because an allow never
  comes from no evidence — and the loops inside the verbs read the already-validated snapshot through an
  internal reader, so the door's cost is paid once per call, not once per order.
- **The plan never carries an unrepresentable number.** The overflow sweep found a target weight sizing
  to `Infinity` at a degenerate mark and a quantity × price overflowing the estimated notional; both
  now refuse with a typed error. The instrument resolver (`resolveInstrument`) is internal — a
  five-positional helper with an optional middle argument is not a grammar the library reviews — and
  the trade fixtures sit at 2026-02-01T00:00Z over a January-only ledger, the instant the declaration
  synthesizer's branch variants use, so every declared branch (the proposal source, the monitor
  state, each compounding convention) folds its hypothetical fills through the ledger successfully. The proposal-sourced plan and the
  monitor-state continuation are registry variants (`tools/first-touch/overflow-variants.ts`), and the
  builder's own graft of the proposal arm — a hash-breaking edit by design — is recorded in the overflow
  sweep's declared-branch ledger with the variant named as its coverage; the carried monitor evaluation count is classified as metadata in
  `tools/first-touch/count-semantics.ts`, as the monitor's own is.
- **Cost rates are declared** (`costs: { commissionBps, commissionPerOrder, spreadBps,
slippageBps }`, default 0 and recorded); the execution policy's own models belong to the broker.

**Evidence.** `packages/portfolio/test/trade.test.ts`: an intent and a proposal normalize to the
same grammar; a target weight sizes to whole units at the mark; free text changes the hash and
nothing else; the plan is bound by its content hash and every guard teaches; `mergeTradePolicies`
takes the minimum of every bound and the intersection of every allow list and refuses `'live'`;
preflight values the portfolio before and after through the ledger's own fold (the after-state
equals `applyPortfolioEvents` over the hypothetical events), estimates costs at the declared rates,
allows a plan inside every limit, denies on a failed check (notional, market age, a concentration
alert from the monitor, negative cash, a duplicate of an open order, a halted session), requires
approval on an unverifiable check and denies it under the stricter policy, names the approval scope
above a threshold, and is deterministic. Gates at landing: eighteen manifest rows, six retained
signature rows, first-touch fixtures, the `@totalfinance/portfolio/trade` budget row (65 KB; measured
63.2 KB), the portfolio root 85.25 → 94 KB, the umbrella 634 → 640 KB, and eight entrypoints that sat within a
few dozen bytes of their lines moved a step because the ten codes registered in core ride every
bundle that carries the error taxonomy (core/artifacts, math, performance/sharpe,
technical-analysis/rsi, fixed-income/convertible, research, foreign-exchange, commodities — each
with a dated rationale in `tools/bundle-size/budgets.ts`).

### Slice 2 (landed 2026-09-06, `f3ef2b2ce`) — the authorization grant, the execution journal, reconciliation

**Decisions taken while landing.**

- **The grant binds what preflight saw, and verification lists every failed binding.**
  `createAuthorizationGrant` takes the portfolio and market hashes from the preflight report by default
  (given, they must match — a grant never binds a snapshot preflight did not judge) and carries the
  preflight's market instant; `verifyAuthorizationGrant` refuses a market older than that instant as
  well as one older than the allowance, and its `reasons` are the complete list, never the first, so
  an operator sees expiry, hash drift, and a variance breach together.
- **Variance is judged on the orders about to be submitted, not on the plan.** A changed plan is a
  `plan-hash-mismatch` (new authority); the variance envelope bounds how far the broker's submission
  may drift from the authorized order — quantity ratio, notional ratio at the plan's reference prices,
  and a limit price's distance in bps — with `orders` defaulting to the plan's (zero variance).
- **The journal fold is total over a consistent journal and refuses what would make it inconsistent.**
  `applyJournalEvents` throws `trade.journal_transition_invalid` on a sequence the table forbids (a
  fill on an unsubmitted order, a partial fill that completes, a "filled" that does not, a second
  acknowledgement, a pre-submission event after submission, a plan hash that changes mid-order), so a
  store appends only what folds. A fill on a closed order is the one exception the contract names: it is
  recorded, the order becomes `unresolved` with the reason, and the result lists it as a late fill.
  `replaced` closes the order as `cancelled` with `replacedBy`; `reconciled` marks without moving.
- **Reconciliation joins by the fill id.** `portfolioEventsFromFill` makes the ledger's `trade.fill`
  event id the fill id under the execution's `sourceId`, so `reconcileExecution` parses the ledger's
  `fillEffects` keys (`[sourceId, eventId]`) back to fill ids and requires both directions: every
  journaled fill is in the ledger, every ledger fill under the source is journaled. The delivered fills'
  quantities are compared per order to the journal within `tolerance.quantity`; an external snapshot is
  judged by `reconcilePortfolio` verbatim, its correction drafts stamped `reconciliation:<sourceId>`.
- **A content-addressed input cannot be grafted.** The overflow sweep's declaration builder cannot
  baseline any arm beneath the grant's `preflight` and `plan` (or the plan a verification takes): the
  door re-verifies the hash, so every graft is the typed hash refusal. Those forty-one arms are recorded
  in the sweep's declared-branch ledger under one dated helper, and the arms are fed whole through
  registry variants (`#proposal`, `#prefix-keys`, `#previous-state`, `#folded-journal`, `#external`) so
  their count coordinates (a grant's key count, a folded journal's event count) are materialized and
  mutated. A folded state's `eventCount` must equal its `eventIds.length` — the count is the fold's
  tally, never an input — and a fill that overflows the tally or the average price refuses.
- **A verification is a report.** `verifyAuthorizationGrant` returns `valid` and `reasons` with
  `assumptions` (the mode, the market instant and age judged, whether the plan's or supplied orders
  were judged, the binding convention in words) and `diagnostics` (nine bindings, the reason count),
  because the manifest's analysis grammar admits exactly two shapes and an unexplained result is a
  report in costume. The premature-grant reason is `premature` (a grant checked before its issue).
- **The ceilings are the contract's**: a grant licenses at most 1,000 idempotency keys; a journal read
  folds at most 100,000 events; the reconciliation tolerance is explicit (no default).

**Evidence.** `packages/portfolio/test/trade-lifecycle.test.ts`: the grant binds the plan, preflight,
snapshots, account, variance, expiry, and key set and is deterministic; carries a `require-approval`
scope; refuses a denied preflight (`trade.preflight_denied`), an unjudged plan, a foreign account and
hash (`trade.grant_invalid`), a stale expiry (`trade.grant_expired`), `'live'`
(`trade.live_unavailable`); a tampered grant fails its door. Verification accepts the bound execution,
lists six failed bindings at once, judges market age and instant, holds orders inside the variance
envelope and names each breach by order. The journal folds a full lifecycle (states, average price,
cancel flag, replacement, rejection, expiry), skips duplicate deliveries, records late fills as
unresolved, equals its incremental fold, and refuses thirteen invalid transitions with the code.
Reconciliation reconciles an execution whose fills are the ledger's, composes `reconcilePortfolio`
for an agreeing and a disagreeing external snapshot, and names a journaled fill the ledger lacks, a
ledger fill the journal lacks, a quantity outside tolerance, an unresolved order, another source, and
a plan filter. Gates at landing: eighteen manifest rows, six retained signature rows, eleven
first-touch fixtures, the `@totalfinance/portfolio/trade` budget 65 → 76 KB (measured 72.9 KB), the portfolio root
94 → 101 KB (99.3 KB), the umbrella 640 → 648 KB (644.8 KB).

### Slice 3 (landed 2026-09-06, `834a11758`) — the paper broker and the hazard suite

**Decisions taken while landing.**

- **One fill path.** The portfolio engine's fill sequence — the fill context, `policy.fill.fill`,
  slippage, the half-spread, market impact, commission, the slippage adjustment, and
  `normalizedFillFromDecision` — is now `fillOrderWithPolicy` in `@totalfinance/backtest/execution`,
  and the engine calls it; the thirteen portfolio goldens are byte-identical before and after. The
  paper broker calls the same function, so paper, backtest, and replay share fills, costs, and
  accounting exactly; the difference is who supplies the observations.
- **The broker holds no ledger.** Decision 7 wrote `createPaperBroker({ ledger, … })`; the broker
  only ever needed the ledger's base currency (to price an instrument it is not told about) and
  never applies anything — the caller (or `portfolio.record_events`) folds the events it returns. The
  input is `baseCurrency`, which says exactly that. `instruments` carries an instrument's currency,
  contract terms, and settlement lag (T+0/1/2 sessions).
- **Order ids are unique per economic intent.** Two plans from two intents used to mint the same
  `plan:1:BBB:buy`, so a journal keyed by order id could not tell them apart and a resubmission after
  a halt was refused as "already journaled". A plan's order ids now carry twelve characters of the
  intent's economic body hash (the orders and account; free text and evidence excluded) or the
  proposal's hash: the same intent submits once within that source journal/store (Journey 4's law).
  Different sources/stores are independent simulations, not global grant consumption.
- **Expiry takes precedence at first acceptance.** A new submission whose grant is expired refuses with `trade.grant_expired`
  even when the market has also gone stale; every other failed binding is `trade.grant_invalid`, with
  the reasons in the error's context.
- **A late fill needs its intent.** The broker keeps every submitted order's intent after the order
  closes so a fill delivered after a cancellation still becomes a ledger fill (Decision 6's path); a
  delivered fill for an order this broker never submitted is journaled but produces no ledger events.
- **Cancelling a terminal order journals nothing.** Decision 7 said "or `rejected` when the order is
  terminal", but a `rejected` after a terminal state is exactly the transition Decision 6's table
  forbids; `cancel` returns `accepted: false` with the order's state instead, and the journal stays
  consistent.
- **The shared helper's optional members are present-or-absent.** The enforcement gate found
  `fillOrderWithPolicy` accepting a null `terms`, `accruedPerUnit`, or timestamp; every optional member
  now teaches when present with the wrong shape, and the identity strings and instants are validated
  at the door — the engine passes them correct, the broker passes them validated, and a direct caller
  is told.
- **Day orders expire by the clock the caller supplies**: an order with `timeInForce: 'day'` (the
  simplified policy's default) is journaled `expired` on the first `step` a day or more after its
  submission; `gtc` orders stay open.

**Evidence.** `packages/backtest/test/paper-broker.test.ts`: initial submit verifies the grant, journals
`submitted` and `acknowledged`, returns a content-addressed receipt and the SAME receipt for a retry
(no second order), and refuses the same key with another plan (`trade.idempotency_conflict`), an
expired grant (`trade.grant_expired`), a drifted portfolio hash and an unlicensed key
(`trade.grant_invalid`), a foreign account, a tampered grant, and every malformed input; step meets
open orders with bars through the fill path (a market buy at the open, a limit sell at the touch),
returns fills the ledger folds exactly, fills partially under a participation cap and completes on
the next observation, leaves an order open without an observation, and expires a day order; the
hazard suite covers cancellation (and a second cancel of a terminal order), a late fill (journaled,
ledgered, unresolved, and named by `reconcileExecution`), duplicate delivery (recorded once), an
asynchronous rejection, a foreign journal, the kill switch (every open order cancelled, submits
refused until resume), continuation from a prior journal, and determinism; Journey 4 runs
authorize → submit → retry → partial fill → cancellation → late fill → reconcile with one economic
trade within its journal/store and the unresolved state visible; `fillOrderWithPolicy` reproduces the engine arithmetic and
refuses garbage. `golden.test.ts`, `portfolio-backtest.test.ts`, `portfolio-stepper.test.ts`, and the
environment suites pass unchanged over the refactored engine. Gates at landing: six manifest rows,
two retained signature rows, four first-touch fixtures, the `@totalfinance/backtest/paper` budget row
(33 KB; measured 30.5 KB), the `@totalfinance/backtest/portfolio` budget 100 → 101 KB (the shared helper's
typed doors ride the engine's entry; measured 100.1 KB), and the two rows of the shared helper on the
ledger-vocabulary allowlist (`tools/backtest-fill-shape.test.ts`: a request and a decision, never a
fill shape of the backtest's own), and the broker's optional `execution` policy on the declared-coverage
residual (the same optional-argument gate the engines' policies sit behind).

### Slice 4 (landed 2026-09-06, `ac3e00885`) — runtime capabilities, the stores, the trade pack, the transports

**Decisions taken while landing.**

- **Registration is effect-aware; execution is capability-gated.** Stage 7A's registry refused any
  operation with an effect ("a later stage adds an effect-aware runtime, not a flag"). That refusal
  is gone: a write operation registers like any other, and `runOperation` refuses the call with
  `operation.capability_missing` — naming the missing capabilities and the held ones — before the
  input is parsed, so a caller without authority learns that first and nothing about the input's
  validity. The defaults are `portfolio:read`, `analytics:run`, `trade:propose`; `trade:approve`,
  `trade:paper`, and `portfolio:write` are granted explicitly (`capabilities` on the runtime and the
  HTTP and MCP servers; `--capability` on the CLI, repeatable).
- **Stores are parameters.** `stores: { authorization, journal }` ride beside `artifacts`; the memory
  implementations live in `@totalfinance/workflows`, the file implementations in `@totalfinance/workflows/local`
  (`<store>/authorizations`, `<store>/journals`), and the CLI's `--store` directory holds all three.
  Two handle kinds join: `authorization` (`totalfinance://authorizations/<hash>`) and `journal`
  (`totalfinance://journals/<id>`). An operation that needs a store it was not given refuses with
  `operation.handle_store_missing` and says which option to pass.
- **The paper broker lives in the journal store, not in a process.** `trade.submit` and
  `trade.cancel` rebuild the broker from `<sourceId>:journal` on every call and append what they add;
  `trade.submit` takes the observations inline and returns the fills and their ledger events, which
  `portfolio.record_events` applies as a content-addressed put of the new ledger (an unchanged
  ledger is the same handle). The execution policy on the wire is the simplified one — a declared
  policy is SDK-only, like the environment's.
- **A receipt is reconstructed from the journal.** The broker an operation rebuilds from the store
  has no memory of receipts, so the `submitted` events carry the grant hash and the receipt id and a
  retry rebuilds the receipt from the journal prefix up to that submission's acknowledgements — the
  same bytes the first call returned, on any transport, from any process.
- **A journal travels inline or by store.** `trade.submit` and `trade.cancel` take an optional
  inline `journal` (the events so far) and rebuild the broker from it instead of the store; a store
  present still receives the whole journal (duplicates skipped once). Parity across four transports
  with four independent stores needs exactly this, and a caller without a store gets the same
  lifecycle. The MCP server gained the HTTP server's `clock` option for the same reason: a writable
  artifact store stamps the edge's instant on a stored result's handle.
- **`createdAt` is an input where a handle is minted.** `trade.authorize` and
  `portfolio.record_events` take the caller's instant so the handles they return are the same on
  every transport; parity holds byte for byte.
- **`missingCapabilities` takes two lists.** The enforcement gate reads an operation-shaped first
  argument as a closed object and found an unknown key accepted; the helper now takes the required
  and the held capability lists, both validated, and the runtime passes the operation's own.
- **`registry.run` passes every runtime option through.** It had never accepted `createdAt` or
  `inlineResultBytes`, so a writable artifact store could not be used through the registry at all
  (the runtime requires `createdAt` with one); both ride with `capabilities` and `stores` now.
- **The shared wire schemas moved** (`MarketSnapshotSchema`, `PortfolioLedgerEnvelopeSchema`,
  `PortfolioStateSchema`) so the journey and trade packs declare one shape.
- **Annotations were already honest.** `operationAnnotations` derived `readOnlyHint` from the effect
  fields since Stage 7A; the trade pack is the first to exercise the write branches
  (`readOnlyHint: false`, `destructiveHint: true` for the external-order operations,
  `idempotentHint` from the idempotency field, `openWorldHint` from the capabilities).

**Evidence.** `packages/workflows/test/trade-pack.test.ts`: the six operations register with the
contract's effects, authorization, idempotency, and capabilities; the annotations derive; the full
profile lists them; a write without its capability refuses before parsing and with it the same
garbage is an input refusal; the lifecycle runs preflight (by portfolio handle) → authorize (into the
store, a handle returned) → submit by grant hash with observations (fills, ledger events, six journal
events appended) → a retry returns the same receipt and appends nothing → the same key with another
plan conflicts → record_events puts a new portfolio handle (idempotent) → reconcile from the journal
store against the new ledger reconciles; without the stores the operations teach.
`tools/transport-parity.test.ts` runs every one of the forty-six operations — the six writes included —
through the registry, HTTP, MCP, and the CLI with the capabilities and stores, and the malformed
fixtures refuse with one code and message everywhere; `tools/packed-consumer.test.ts` runs the
lifecycle from the tarballs and the CLI refuses without the capability. Pins: forty-six operations in
the full profile (the CLI, HTTP, and job-runner counts, the HTTP capabilities document, seventeen
packs), and the registry suite's write case now registers a write and refuses its RUN without the
capability; fifty-five run paths in the committed OpenAPI document, each with its own effect fields; the `@totalfinance/workflows` budget 447 → 476 KB (measured 471.2 KB) and no other budget moved (the CLI, HTTP, MCP, and umbrella lines held); the fixture/contract join 1272 → 1288; the measurement ratchet 183 → 185 for the two new store interface methods (`AuthorizationStore#put`, `ExecutionJournalStore#append`) the library calls — the same class as `ArtifactStore#put` — with the memory and file implementations enforced through their factories.

### Slice 5 (landed 2026-09-06, `44cd9d72e`) — the guide, the example, the agent-native amendment, the closeout

**Decisions taken while landing.**

- **The guide is the lifecycle in the reader's order** — `observe → analyze → propose → preflight →
authorize → execute → reconcile` — first directly (`normalizeTradePlan` → `preflightTradePlan` →
  `createAuthorizationGrant` → `createPaperBroker` → `reconcileExecution`), then through the registry
  with the stores and the capabilities, and every number in it runs in
  `docs/examples/trade-lifecycle.test.ts`.
- **The agent-native document keeps its sketches and names what shipped.** The lifecycle, adapter
  boundary, and capabilities sections each gain an "adopted / shipped (Stage 7B.2)" paragraph
  pointing at the modules, the operations, the artifact kinds, and the guide; the original intent
  stays visible beneath, as the environment section did for Stage 7B.1.
- **The one load-sensitive test of the landing runs is made deterministic.** `packages/cli/test/bin.test.ts`'s
  job-cancel case submitted a 14 MB job at the transport's default 64 KB budget and, under `test:coverage`
  load, sometimes failed on the budget before the external cancel landed; it now passes
  `--max-input-bytes 16777216`, so the record it asserts on can only be `cancelled`.
- **A guide's fences name no identity the library does not export.** The documentation naming gate reads
  every key of an object literal in a fence as a field, so a spots or observations record keyed by a
  ticker (`{ AAPL: … }`) is written with `Object.fromEntries([...])`, as the end-to-end guide writes
  its spots.
- **What is deferred is written down**: live execution (`AT8`), declared execution policies on the
  wire, and a broker that steps across operation calls.

**Evidence.** `docs/examples/trade-lifecycle.test.ts` runs the first paper trade directly (one fill
of 200 at the open, reconciled, the same-key conflict) and the same lifecycle through the registry
(the capability refusal before parsing, a handle for the ledger, a grant into the store, fills and
ledger events, a new portfolio handle, reconciliation from the journal store); `docs/README.md`
indexes the guide and the example; the docs conformance gate holds.

## Completion record (2026-09-06)

Stage 7B.2 (`AT5`) is complete at `44cd9d72e`: the safe trade lifecycle — intent, plan, preflight, grant,
paper execution, journal, reconciliation — as pure compute in `@totalfinance/portfolio/trade` and
`@totalfinance/backtest/paper`, the six operations of `tradePack` on every transport behind explicit
capabilities and stores, the guide and its runnable example, and the agent-native document amended
to the shipped grammar. The `AT5` exit holds: every submitted paper order has valid bounded
authority at acceptance (a grant verified on first submission, one key one plan) and reconciles to portfolio events
(`reconcileExecution` over the journal store and the ledger's fills); Journey 4 runs as a test with
one economic trade per intent within its journal/store and the unresolved state visible. Historical next rows: `AT6`/`AT7` per
`implementation-order.md`, and the maintainer-held publish (Stage 5A slice 4).
