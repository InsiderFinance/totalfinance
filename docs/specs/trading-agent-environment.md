# Trading-agent environment and Agent Bench — the Stage 7B.1 (AT4) contract

**Status: `COMPLETE @ f7677ebcb` — five slices landed; authored 2026-09-05 from the `AT4` row of
[`agent-native-portfolio-and-trading-platform.md`](../agent-native-portfolio-and-trading-platform.md)
(its trading-environment and Agent Bench sections), the Stage 7 crosswalk of
[`implementation-order.md`](../implementation-order.md), and the frozen FC7/FC8 surface; accepted
2026-09-05 after the review record below; slices land in the order listed.**

Stage 4.7 froze the core: one ledger law, three simulation engines, a pluggable execution reality,
run artifacts, thirty-nine operations, and the gates that keep them honest. `AT4` is the first
dependency-ready row after that freeze that needs no provider, no host, no broker, and no maintainer
decision: a deterministic environment in which coded policies, learned policies, and LLM agents can be
developed and evaluated over the exact ledger, simulator, and artifacts users receive. This contract
settles it decision-complete: the loop it reuses, the observation an agent may see, the actions it may
take, the reward it is paid, the episodes it is measured on, the bench that scores it, and the gates
that keep a profitable unsafe agent from passing.

## Outcome

**September correctness addendum:** see the release-blocking
[`review repair gate`](./review-september-2026-repairs.md). Standalone `portfolioBacktest` now
shares the environment's next-observation timing; equivalence tests no longer shift its orders
a second time. Entry checks enforce both the leverage ceiling and initial-margin requirement,
fees and unsettled obligations. The multi-currency episode funds EUR explicitly; opening
foreign cash is converted into initial capital, not counted as a first-step gain. The original
slice evidence below is retained as historical evidence, not a claim that these defects were
covered by the original goldens.

A cold TypeScript developer can, with the packed tarballs and this repository's docs:

1. create a trading environment from the same inputs `portfolioBacktest` takes (instruments, market
   data, accounting, an execution policy) plus a limits block and a declared reward composition, and
   drive it with the familiar `reset` / `step` contract — an observation in, an action out, a step
   result back — over any mix of the eight instrument kinds;
2. trust that the observation at an instant contains nothing published after it: not a later row, a
   later revision, a whole-series statistic, or the bar the pending orders will meet;
3. submit orders, cancel or replace the ones still open, or hold, and receive typed rejections and a
   declared penalty for anything invalid — never a crash, never a silent coercion;
4. read the reward as the composition it declared, every component returned separately beside the
   raw financial outcome, with the guarantee that changing the reward never changes the accounting;
5. run a policy over a maintained library of seeded synthetic episodes — trends, ranges, vol
   regimes, gaps and limit moves, stale / missing / duplicated / corrected / out-of-order data, wide
   spreads and thin liquidity, expiration and assignment, margin pressure, corporate actions,
   multi-currency marks, model/market disagreement — with license-safe reproducibility;
6. save an episode as a run artifact, replay it from the recorded actions to byte-identical results,
   and compare two episodes;
7. score any policy on Agent Bench: operational conformance (no look-ahead, replay equality, retry
   idempotency, mask compliance, violation counts) reported separately from strategy quality
   (return, volatility, Sharpe, Sortino, drawdown, turnover, cost, exposure) against the maintained
   baselines, and score a recorded agent transcript against the expected operation use; and
8. run a named policy over a named episode through the registry, CLI, HTTP, and MCP with the same
   schema, result, and teaching errors as the SDK.

## Non-goals

- **No second simulator.** The environment IS the portfolio engine's per-instant loop driven from
  outside. No fill, cost, lifecycle, mark, margin, or ledger rule is re-implemented; the equivalence
  test in slice 1 proves `portfolioBacktest` is byte-identical before and after the refactor.
- **No Python, no Gymnasium, no PettingZoo.** The TypeScript contract aligns with the
  `reset` / `step` model so a thin adapter can implement Gymnasium later without moving finance
  logic; multi-agent markets wait for a real consumer (the agent-native doc's deferral).
- **No learning loop.** The environment evaluates policies; it trains none. A policy is a
  TypeScript function or a named baseline.
- **No LLM in the repository.** Agent Bench's model-dependent half (operation selection, valid
  arguments on the first attempt, recovery after one teaching error) is scored from a recorded
  transcript by a deterministic scorer; producing the transcript is the caller's job.
- **No stateful stepping over a transport.** A registry operation that holds an environment open
  across calls needs a session store with lifetimes and authorization (`AT5`/`AT7`). The one
  operation here runs a named policy over an episode to completion.
- **No paper or live edge, no external-order effect, no dataset handles, no proprietary fixtures.**
  Every episode is synthetic and seeded; public datasets may be added later with their licenses.
- **No acceleration.** Bundle budgets are measured at every commit; runtime budgets stay under the
  maintainer's standing deferral (TotalFinance §1.4).

## Decision 1 — package placement, names, and dependency edges

- The surface lives at the earned subpath **`@totalfinance/backtest/environment`**
  (`packages/backtest/src/environment/`): `types.ts`, `validate.ts`, `environment.ts`, `reward.ts`,
  `limits.ts`, `episodes.ts`, `bench.ts`, `index.ts`. The umbrella's `totalfinance/backtest` namespace
  re-exports it as it re-exports every backtest subpath.
- New dependency edges: none. The environment composes `@totalfinance/portfolio` (the ledger,
  `portfolioSnapshot`, `monitorPortfolio`), `@totalfinance/performance` (`analyze`),
  `@totalfinance/math` (`mulberry32`), and the backtest package's own execution and portfolio modules —
  all already dependencies of `@totalfinance/backtest`.
- Public names follow the naming policy's grammar and the existing execution vocabulary
  (`OrderIntent`, `instrumentId`, `type`, `limitPrice`, `timeInForce`): `createTradingEnvironment`,
  `TradingEnvironment`, `TradingEnvironmentDefinition`, `EnvironmentObservation`,
  `EnvironmentAction`, `EnvironmentStepResult`, `EnvironmentResetResult`, `RewardComposition`,
  `RewardBreakdown`, `EnvironmentLimits`, `ActionMask`, `environmentEpisodes`, `EnvironmentEpisode`,
  `runAgentBench`, `AgentBenchReport`, `agentBaselines`, `scoreAgentTranscript`,
  `AgentTranscript`, `requireTradingEnvironmentDefinition`, `requireEnvironmentAction`. The
  agent-native doc's sketch (`instrument: { type, symbol }`, `orderType`) is NOT adopted: the
  frozen execution grammar wins, and the doc is amended to say so when slice 1 lands.
- The environment's run kind joins `@totalfinance/backtest/artifacts` as `'environment'` (Decision 7).
- The one operation is `totalfinance.backtest.environment_episode` in `@totalfinance/workflows`
  (`operations-journey.ts`, the backtest pack), adapted by the CLI, HTTP, and MCP transports without
  a second schema (Decision 9).

## Decision 2 — one loop, two callers

`portfolioBacktest`'s per-instant loop (`packages/backtest/src/portfolio/engine.ts`, "the loop")
does, at each decision instant: stamp the clock, clear the mark cache, run the lifecycle facts since
the previous instant, fold the external flows due, ask the strategy for orders, execute them through
the execution policy, run the margin check with forced liquidation, and record the valuation mark and
the net asset value. The environment needs exactly that loop with one difference: the orders come
from outside, decided on the previous instant's observation.

- The engine module exports an internal stepper, `createPortfolioStepper(request)`, whose request
  is `PortfolioBacktestRequest` without `strategy`. It returns `{ instants, open(index),
close(index, orders), finish() }`: `open` stamps, clears the cache, runs the lifecycle and the
  flows and returns the `SessionContext` the strategy path already builds; `close` executes the
  given orders (source `'strategy'`), runs the margin check, records the mark and the equity, and
  returns the step frame (the fills, rejections, liquidations, events folded, the net asset value);
  `finish` assembles the `PortfolioBacktestResult` exactly as today. `portfolioBacktest` becomes
  `for each instant: close(i, strategyOrders(open(i)))` and its results are byte-identical (the slice
  1 equivalence test runs every existing portfolio-backtest fixture through the old and the new
  path and compares JSON).
- The stepper is exported from `./portfolio` as a `helper`-role name (manifest-classified, guarded,
  documented as the engine's seam), not hidden — a reader of the environment must be able to see
  the loop it drives.
- The environment never touches the ledger, the marks, or the execution policy directly; every
  economic effect passes through `close`.

## Decision 3 — instants, the next-observation law, and open orders

- The environment's steps are the engine's decision instants — the observation timestamps inside the
  window in ascending order, business days only when a calendar is named — so an episode over a
  given request has exactly the session count `portfolioBacktest` would report.
- **The next-observation law.** An order decided on the observation at instant `k` meets the market
  at instant `k + 1` through the declared fill model; it is never filled on the observation that
  produced it. This is not an option: an environment whose observation includes the bar its orders
  fill on is the look-ahead the observation contract forbids. A caller who wants same-instant fills
  has `portfolioBacktest` with `onSession`.
- `reset` runs `open(0)` and `close(0, [])` and returns observation 0. `step(action)` at step `k`
  (observation `k` in hand) does, in this order: apply the action's cancellations to the open
  orders; validate the action's new orders and add the accepted ones to the open orders (a rejected
  one is dropped with its typed rejection); run `open(k + 1)`; run `close(k + 1, openOrders)` so
  every open order meets the market at instant `k + 1` in submission order; then build observation
  `k + 1`, the reward, and the flags. An order the fill model leaves unfilled for a market reason
  (`not-triggered` limit/stop, `insufficient-depth` remainder, `halted`, `no-observation`,
  `stale-quote`) stays open while its `timeInForce` allows — `day` expires at the session's last
  instant, `gtc` until cancelled (the execution grammar's two values; there is no `ioc`) — and is reported with the reason it is still
  open; an order rejected for a structural reason (unknown instrument, limit breach, disallowed
  action, wrong shape) never becomes open. Cancel/replace therefore acts on orders submitted in the
  same action and on carried orders from earlier steps, always before they meet the market.
- The observation reports `openOrders` — every carried order with its `orderId`, the submission
  step, the reason it is still open, and its remaining quantity — so the "open-order state" the
  agent-native doc requires is real, not decorative.
- `terminated` is true when the economic or policy terminal state is reached: net asset value
  `<= 0`, a `limits` breach whose declared consequence is `'terminate'`, or forced liquidation that
  cannot restore maintenance margin. `truncated` is true when the instants are exhausted (the data
  boundary) or the definition's `maximumSteps` is reached. After either, `step` refuses with
  `environment.episode_over` until `reset`.

## Decision 4 — the observation contract

`EnvironmentObservation` carries only what was published at or before its instant:

| Field           | Content                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asOf`, `index` | the instant and its ordinal among the decision instants; `sequence` counts steps since `reset` (identical to `index` unless a reset with a later `fromTimestampMs` was requested)                                                                     |
| `market`        | per instrument, the engine's `LatestObservations` at `asOf` (bar, quote, trade, book, chain quote, underlying, forward or funding rate) — the same accessor the strategy path uses, hence the same point-in-time truth                                |
| `portfolio`     | `netAssetValue`, `cash` by currency, `positions` (`SessionPosition` rows), `grossExposure`, `netExposure`, `buyingPower` under the execution policy's margin, `openOrders`                                                                            |
| `limits`        | the utilization of every declared limit (value, bound, fraction) and the breaches active at this instant, from `monitorPortfolio` (Decision 5)                                                                                                        |
| `features`      | the declared feature recipes evaluated over rows `<= asOf` only: `lookbackReturns` (per lookback, per instrument), `realizedVolatility` (per lookback), `drawdown` of the instrument's own bar closes — each a plain `Record<string, number \| null>` |
| `freshness`     | per instrument: the age of the latest observation in ms, whether it exceeds the policy's `staleQuotes.maximumAgeMs`, and the observation kinds present                                                                                                |
| `actionMask`    | Decision 6                                                                                                                                                                                                                                            |
| `previous`      | the outcome of the previous action: fills, rejections, liquidations, lifecycle events, and the reward breakdown — `null` at `reset`                                                                                                                   |
| `provenance`    | `runId`, `definitionHash`, `seed`, the execution policy's label, and the adapter versions                                                                                                                                                             |

**The no-leak law, as gates.** (a) The observation is built from `latestFor(id, asOf)` and the
ledger state — never from the raw arrays; (b) a leakage suite mutates every row after `asOf` (bars,
quotes, chains, dividends, corporate actions, fx, funding, forward rates, restated features) and
asserts observation `k` is byte-identical; (c) the feature recipes are evaluated by a function that
receives only the prefix of rows `<= asOf`, and a test proves a series-wide statistic (the full-period
mean, the last bar) never appears; (d) the observation is frozen (`Object.freeze`, deep) so a policy
cannot write into the environment's state.

## Decision 5 — limits and their consequence

`EnvironmentLimits` reuses the FC7 `PolicyLimits` grammar verbatim — `maximumPositionWeight`,
`maximumGroupWeights`, `maximumGrossLeverage`, `maximumDrawdown`, `maximumDailyLoss`,
`minimumSettledCash` — plus three environment-only members: `allowUndefinedRiskOptions` (default
`false`: a naked short call or short put on an option instrument is a disallowed action),
`maximumPositionNotional` (base currency, per instrument, the agent-native doc's example), and
`onBreach: 'terminate' | 'reject-and-continue'` (default `'terminate'`).

- Post-trade evaluation composes `monitorPortfolio` with `policy: { limits }`, the current market
  snapshot, and the environment's monitor state carried step to step, and reads the families it
  raises (`concentration-limit`, `leverage-limit`, `drawdown`, `daily-loss`, `cash-reserve`,
  `margin-pressure`, `stale-market-data`). No limit arithmetic is written twice.
- Pre-trade evaluation projects each queued order's effect on position weight, gross leverage, and
  notional at the current marks — the same three ratios `monitorPortfolio` reports, computed on the
  projected quantities — and rejects an order that would breach with
  `environment.limit_breach` and the family name. A projection is not a guarantee (the fill price
  moves); the post-trade check is the truth, and a post-trade breach under `'terminate'` ends the
  episode with `terminated: true` and `reason` naming the family.

## Decision 6 — the action contract, the mask, and rejections

```ts
type EnvironmentAction =
  | { kind: 'hold'; rationale?: string }
  | { kind: 'orders'; orders: EnvironmentOrder[]; cancel?: string[]; rationale?: string };

interface EnvironmentOrder {
  orderId?: string; // assigned `${runId}:a${n}` when absent; a repeated id is an idempotent retry
  instrumentId: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: 'market' | 'limit' | 'stop' | 'stop-limit';
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: 'day' | 'gtc'; // the execution policy's grammar; default: the policy's
}
```

- `rationale` is metadata: recorded in the trace, never read by the environment, bounded to 4,096
  bytes (longer is truncated with a diagnostic, never a refusal — an adversarial or malformed
  rationale cannot stall an episode).
- **Idempotent retry.** An `orderId` seen before in the episode is not executed again: the action
  receives a `environment.duplicate_order` rejection referencing the original submission step and
  the original outcome. The maintained retry suite submits every baseline's actions twice and
  asserts zero additional fills.
- **Replace** is `cancel: [id]` plus a new order in the same action; the environment applies
  cancellations first, so a replace never double-executes.
- `ActionMask` lists, per instrument, whether `buy` and `sell` are allowed and the reasons when
  not: `no-observation`, `halted`, `stale-quote`, `position-limit`, `notional-limit`,
  `leverage-limit`, `undefined-risk`, `insufficient-buying-power`, `episode-over`. The mask is a
  promise: an order the mask allows is never rejected for a mask reason at submission; an order the
  mask disallows is rejected with that reason and the penalty policy applies.
- Every rejection is typed: `{ orderId, instrumentId, code, detail, step }` with the closed code set
  `environment.duplicate_order`, `environment.limit_breach`, `environment.action_disallowed`,
  `environment.unknown_instrument`, `environment.order_invalid` (a guard failure on the order's
  shape, teaching text verbatim), plus the engine's own `backtest.unfilled.*` and
  `backtest.data_missing` for orders that met the market and did not fill. Invalid actions never
  throw: an action whose shape is wrong is rejected whole with `environment.action_invalid` and
  the step proceeds as `hold`. Only a wrong-shaped `step` argument (not an object) refuses with the
  shared guard.

## Decision 7 — the reward contract, identity, and the artifact

```ts
interface RewardComposition {
  pnl?: number; // weight on the step's net return (Δ NAV / NAV before the step)
  drawdown?: number; // weight on the INCREASE in drawdown from the episode's running peak (≤ 0 change pays 0)
  turnover?: number; // weight on traded notional / NAV before the step
  cost?: number; // weight on commissions + slippage + spread + impact + borrow / NAV before the step
  concentration?: number; // weight on the largest absolute position weight after the step
  leverage?: number; // weight on gross exposure / NAV after the step
  riskViolation?: number; // weight on the count of limit breaches + mask rejections in the step
  benchmark?: { weight: number; instrumentId: string }; // weight on (step return − the benchmark instrument's bar return)
  goal?: (frame: RewardFrame) => Record<string, number>; // extra named terms; makes the definition non-replayable, as every callback does
}
```

- `RewardBreakdown` returns every component's raw value, its weight, and its contribution, plus
  `total = Σ weight × value`; components absent from the composition are reported with weight 0 so
  a consumer sees the raw outcome regardless of what it is paid for.
- **Reward never changes accounting.** A property test runs the same action trace under two
  compositions and asserts the fills, events, ledger, and equity are byte-identical and only the
  rewards differ.
- **Identity.** `runId` hashes the definition in canonical order (the request rows through the
  engine's own identity ordering, the limits, the reward weights, the feature recipes, the window,
  the calendar) with the seed; it identifies the environment, not what was done in it. Each step
  returns `identity: { runId, step, traceHash }` where `traceHash` chains the previous trace hash
  with the canonical action; two policies that act identically produce identical traces.
- **The artifact.** Run kind `'environment'` in `@totalfinance/backtest/artifacts`: the input is
  `{ definition, seed, actions }` (the action log, rationales included), the run is the final
  `PortfolioBacktestResult` from `finish()` plus the reward series and the breakdowns; `replay`
  re-drives the stepper with the recorded actions and reports `matches` on the trace hash, the
  equity, and the rewards; `compare` reuses the portfolio kind's deltas plus the reward totals and
  the violation counts. A definition with a `goal` callback or a custom adapter is saved with
  `replayable: false` and `replay` refuses with `backtest.not_replayable`, the existing law.
- The seed feeds every stochastic element a definition declares — a latency model that draws, the
  random baseline, synthetic episode generation — through `mulberry32`; the accounting never
  consumes it, and a definition with no stochastic element yields identical episodes for every seed.

## Decision 8 — the episode and scenario library

`environmentEpisodes` is a frozen catalogue of `EnvironmentEpisode` rows, each `{ id, title,
description, definition, seed, sessions, expectations }` built by a seeded synthetic generator
(`mulberry32`) over a small instrument set (two equities, one ETF, one option on the ETF, one
future, one FX forward, one crypto perpetual, one bond, in the mixes each scenario needs):

| Episode id                  | Regime or hazard                                                              | Expectation the suite asserts                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `trending`                  | a drifting random walk with low noise                                         | buy-and-hold beats hold-cash; a trend follower's turnover stays under the declared bound                         |
| `mean-reverting`            | an Ornstein–Uhlenbeck path                                                    | the periodic rebalance baseline's return exceeds buy-and-hold                                                    |
| `range-bound`               | a bounded oscillation                                                         | the random-valid-action baseline stays inside the limits with zero violations                                    |
| `volatility-expansion`      | a GARCH-like variance ramp                                                    | the realized-volatility feature rises monotonically over the ramp                                                |
| `volatility-contraction`    | the ramp reversed                                                             | the feature falls; the drawdown component of a leveraged baseline shrinks                                        |
| `overnight-gaps`            | opens far from the previous close                                             | a limit order inside the gap is `not-triggered`; a stop is filled at the open, clamped to the price limit        |
| `limit-moves`               | a session halted by the execution policy's session rules                      | the mask reports `halted`; the order carries forward and fills the next session                                  |
| `stale-data`                | quotes older than `staleQuotes.maximumAgeMs`                                  | `freshness` flags it; the mask reports `stale-quote` under a refusing policy                                     |
| `missing-data`              | an instrument with no observation at several instants                         | the mask reports `no-observation`; positions still mark from the previous mark with its stated source            |
| `duplicated-data`           | the same bar delivered twice                                                  | the run is byte-identical to the deduplicated one (the engine's identity ordering)                               |
| `corrected-data`            | a restated bar effective after its original instant                           | the observation at the original instant is unchanged (the leakage suite)                                         |
| `out-of-order-data`         | rows shuffled                                                                 | byte-identical to the sorted episode (permutation invariance)                                                    |
| `wide-spreads`              | a quote policy with a wide half-spread                                        | the `cost` component dominates a high-turnover baseline's reward                                                 |
| `thin-liquidity`            | an order-book policy with shallow depth and a participation cap               | partial fills; `insufficient-depth` carries the remainder forward                                                |
| `option-expiration`         | an ETF option through expiry with a dividend before it                        | assignment and exercise events appear in `previous.events`; `undefined-risk` masks a naked short when disallowed |
| `margin-pressure`           | a leveraged future position against an adverse move                           | forced liquidation events; `terminated` under `'terminate'`, a reject-and-continue trail otherwise               |
| `retry-storm`               | every action submitted twice                                                  | zero duplicate fills; every second submission is `environment.duplicate_order`                                   |
| `corporate-actions`         | a split and a cash dividend on a held equity                                  | the position quantity and cash follow the adapter's events; the equity is continuous across the split            |
| `multi-currency`            | a EUR bond and a USD book with dated FX                                       | the base-currency NAV moves with the FX rate; the P&L block attributes FX separately                             |
| `model-market-disagreement` | an option marked by the chain against a model price the feature block reports | the observation exposes the residual (`features.modelResidual`) and never silently replaces the mark             |

- Every episode's `sessions` is ≤ 260 and its generation is ≤ 50 ms on the reference machine, so
  the whole library runs in the unit suite.
- The expectations are executable (`episodes.test.ts`); an episode with no assertable expectation is
  not added.
- Proprietary data never enters this table. Adding a public dataset requires its license text in the
  row and a pinned hash of the rows.

## Decision 9 — Agent Bench

`runAgentBench({ policy, episodes?, seeds?, limits? })` runs a policy over the catalogue (or the
named subset) at each seed and returns `AgentBenchReport`:

- `operational`: per episode, the absolute gates — `lookAhead: 0` (the leakage probe re-runs the
  episode with every future row perturbed and asserts an identical trace), `replayEquality: true`
  (the episode saved and replayed matches), `duplicateOrders: 0` (the retry suite), `maskViolations`
  (orders submitted against the mask), `limitBreaches`, `externalOrderAttempts: 0` (structurally
  zero: the environment has no external edge; the no-side-effects gate scans the module), and
  `reconciled: true` (the ledger law, inherited). A policy failing any absolute gate `passes: false`
  regardless of its returns.
- `strategy`: per episode and pooled — return, volatility, Sharpe, Sortino, maximum drawdown,
  turnover, cost, gross and net exposure, violation counts — from `analyze` over the equity and the
  step frames; reported beside the same table for every baseline. No single number ranks the two
  dimensions: the report has no `score` field by design.
- `agentBaselines`: `holdCash`, `buyAndHold(weights?)`, `periodicRebalance(targets, frequency)`,
  `randomValidAction(seed)` (draws only from the mask), `riskParity(lookback)` (inverse realized
  volatility from the feature block), `movingAverageCrossover(fast, slow)`. Each is a
  `TradingPolicy = (observation) => EnvironmentAction` and each is itself benched in the suite.
- `scoreAgentTranscript({ transcript, expected })` scores a recorded transcript
  (`AgentTranscript`: the operations called with their arguments and results, the teaching errors
  received, the final answer) against `expected` (the operation ids, the argument predicates, the
  parity tolerance against a direct SDK call, the artifacts the answer must cite): correct operation
  selection, valid arguments on the first attempt, recovery after one teaching error, numerical
  parity, refusal to invent unavailable data (an expected refusal that did not happen fails), as-of
  and unit correctness, context bytes and calls per journey, traceability of the conclusion to
  artifacts. Deterministic: the same transcript always scores the same.
- The bench's release gates (the exit gate below) are the agent-native doc's, verbatim.

## Decision 10 — the operation and the transports

`totalfinance.backtest.environment_episode` (`sideEffect: 'none'`, `costClass: 'job'`,
`deterministic: true`, `supportsCancellation: true`) takes `{ episode: <catalogue id> | definition,
policy: { baseline: <name>, parameters? }, seed?, artifacts?: 'embed' | 'reference' }` and returns
the bench report for that one episode plus the artifact id (or the embedded artifact). Declarative
inputs only: a TypeScript policy or a `goal` callback is SDK-only, the existing callback law. Parity
fixtures in `tools/transport-parity/fixtures.ts`; the registry/CLI/HTTP pin moves 39 → 40 and the
backtest MCP pack gains one tool; `openapi.paths` in `smoke-expected.json` moves accordingly and
the packed-consumer test runs the operation from the tarballs.

## Decision 11 — bounded work, failure behavior, stable codes

- Work is bounded by `maximumSteps` (default the instant count; ceiling 100,000), by the engine's
  existing limits, and by the rationale byte bound. An episode over the ceiling refuses at
  `createTradingEnvironment` with `InputRange`.
- New stable codes: `environment.episode_over`, `environment.duplicate_order`,
  `environment.limit_breach`, `environment.action_disallowed`, `environment.unknown_instrument`,
  `environment.order_invalid`, `environment.action_invalid` — rejection rows, never thrown; and the
  refusal `environment.not_reset` when `step` precedes `reset`. Every code joins the error catalogue
  and the field reference.
- Every door takes `unknown`: `createTradingEnvironment(definition)`, `environment.reset(options?)`,
  `environment.step(action)`, `runAgentBench(input)`, `scoreAgentTranscript(input)` guard with the
  shared `(functionName, label, value)` grammar; the closed-key law and the null law hold at every
  depth ≤ 4 (the depth law from the FC8 landing).

## Decision 12 — determinism, immutability, provenance

The environment is a pure function of its definition, its seed, and the action trace. No clock
(instants come from the data), no environment variable, no filesystem, no network, no
`Math.random` (the no-side-effects gate extends its scan to the new directory with no allowance).
Observations and step results are deeply frozen. Every result names the execution policy's label,
the adapters' versions, the conventions version, and the definition hash.

## Ordered implementation slices

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | The stepper seam (`createPortfolioStepper`) with the equivalence test; `createTradingEnvironment` core: definition guard, `reset`/`step`, the next-observation law, open orders with carry-forward and cancel/replace, typed rejections, idempotent retry, `terminated`/`truncated`, identity; the subpath, the manifest rows, first-touch fixtures, the bundle budget row. |
| 2     | Limits (pre-trade projection, post-trade `monitorPortfolio`), the action mask, the reward composition and breakdown, features and freshness, provenance; the leakage suite, the reward-invariance property, the mask promise, the retry suite.                                                                                                                              |
| 3     | The episode library (twenty seeded generators) with executable expectations; run kind `'environment'` (artifact/read/replay/compare) with the replay-equality suite.                                                                                                                                                                                                        |
| 4     | Agent Bench: the six baselines, `runAgentBench`, `scoreAgentTranscript`; `docs/guides/trading-environment.md`, README rows, `docs/examples/trading-environment.test.ts`; the agent-native doc amended for the adopted grammar.                                                                                                                                              |
| 5     | Operation `environment_episode` + parity + packed consumer; the closeout: trackers, the exit gate, the completion record.                                                                                                                                                                                                                                                   |

Each slice lands as one commit (tests, generated evidence, its record here), followed by a records
commit that names the hash; fetch/fast-forward before every push; never force.

## Acceptance and exit gate

The agent-native doc's release gates and the `AT4` row, each closed by a named test at a named
commit:

- [x] `portfolioBacktest` is byte-identical through the stepper seam over every existing fixture —
      `portfolio-stepper.test.ts` against the thirteen goldens captured at `fcb9b8ac8` @ `83ee0c64d`.
- [x] 100% replay equality for every maintained episode under every baseline (the artifact's
      `replay` matches the trace hash, the equity, and the rewards) — `environment-episode.test.ts` over
      every callback journey @ `5680655fa`; the baselines join in slice 4.
- [x] 0 hidden future-data access: the leakage suite perturbs every future row of every episode
      and every observation is byte-identical; series-wide statistics never appear —
      `trading-environment-limits.test.ts` "never leaks" over every journey @ `35dd160e4`; the library's
      corrected-data row @ `5680655fa`.
- [x] 0 duplicate orders under the retry suite (every baseline, every episode, every action twice) —
      `runAgentBench`'s retry drive, asserted for every baseline in `trading-environment.test.ts` @ `2fe238e27`.
- [x] 0 unauthorized external-order submissions: structurally none, and the no-side-effects gate
      scans `packages/backtest/src/environment/` with no allowance — `tools/no-side-effects.test.ts` (the
      backtest package is in its scan set; no route under `environment/` is allowed) @ `f7677ebcb`.
- [x] 100% portfolio reconciliation: every episode's equity is the ledger's net asset value (the
      engine's reconciliation refusal is reachable from the environment and never fires) — every
      `finish()` in the suites passes the engine's reconciliation; the bench's `reconciled` gate holds for
      every baseline over every episode @ `f7677ebcb`.
- [x] A reward change never changes fills, events, ledger, or equity (the invariance property) —
      `trading-environment-limits.test.ts` "never changes the accounting" @ `35dd160e4`.
- [x] The mask is a promise: no mask-allowed order is rejected for a mask reason; every mask-
      disallowed order is rejected with that reason — `trading-environment-limits.test.ts` "the action
      mask is a promise" @ `35dd160e4`.
- [x] Operational conformance and strategy quality are reported separately; the report has no
      single score — `trading-environment.test.ts` asserts the two blocks and the absent field @ `2fe238e27`.
- [x] Every baseline passes the operational gates; `randomValidAction` records zero violations —
      `trading-environment.test.ts` @ `2fe238e27`.
- [x] The operation ships with schema, effects, authorization, parity across the five transports,
      and a packed-consumer run; the pins move 39 → 40 — `tools/transport-parity.test.ts`,
      `tools/packed-consumer.test.ts` "Stage 7B.1" @ `f7677ebcb`.
- [x] Every new export is manifest-classified, guarded at every door, in the field reference, the
      API report, the README, `llms.txt`, and within its bundle budget; `pnpm regen:check` is
      byte-stable; `pnpm run ci` and `pnpm api:check` exit 0 twice at one commit — @ `f7677ebcb`: CI 498
      files / 10473 tests, tools gates 59 / 3129, enforcement 0 defective, `regen:check`
      byte-stable, `api:check` 0, the second pass green.

## Review record (self-review against the laws, 2026-09-05)

- **Direct APIs preserved.** `portfolioBacktest` keeps its signature and results; the stepper is an
  addition. Nothing is renamed.
- **No duplicated math.** Fills, costs, lifecycle, marks, margin, and the ledger stay in the engine;
  limits come from `monitorPortfolio`; performance from `analyze`; the seed from `mulberry32`.
  The environment adds bookkeeping (open orders, the mask, the reward arithmetic) and nothing that
  exists elsewhere.
- **One law per question.** Next-observation fills are a law, not an option; the callback law and
  the identity law are the FC8 ones; the error grammar is the shared one.
- **Truthfulness.** The open-order state is real; the mask is a promise tested as one; the seed's
  reach is stated; strategy quality never masks an operational failure.
- **Bounded.** Steps, rationale bytes, episode sizes, and generation times are capped and tested.
- **Accepted 2026-09-05.** Slice 1 begins.

## Slice records

### Slice 1 (landed 2026-09-05, `83ee0c64d`) — the stepper seam and the environment core

**Decisions taken while landing.**

- **The seam is public and named.** `createPortfolioStepper` is exported from `./portfolio` (and the
  root) as a helper-role name with `open(index)` / `close(index, orders)` / `context()` /
  `finish()`; `finish()` is idempotent and reports the instants closed so far, so an episode may
  stop early. The `context()` accessor was added beyond the contract's sketch: the observation must
  reflect the state AFTER the instant's orders, margin check, and mark, and the session context the
  engine already builds for a strategy is exactly that view — nothing new is computed.
- **`SessionPosition` gains `baseCurrencyMarketValue`** (signed, base currency, null without a mark),
  read from the `portfolioSnapshot` the engine already takes for the net asset value, so the
  environment's gross and net exposures compose FC7's valuation instead of converting currencies
  again.
- **The doors are typed.** `createPortfolioStepper(request: PortfolioStepperRequest)` and
  `createTradingEnvironment(definition: TradingEnvironmentDefinition)` carry their contract in the
  signature (the field walker cannot see through `unknown`), and the runtime guards refuse every
  hostile shape regardless.
- **The environment is a helper-role export.** It returns a stateful object with methods, not a
  report; the manifest's analysis-shape law rightly refused the `analysis` role.
- **Time in force is the execution grammar's** — `day` and `gtc`; the contract's `ioc` is struck
  (Decision 3 and 6 amended in place): the frozen grammar has no such value and the environment adds
  none.
- **`finish()` is the third verb**, beside `reset` and `step`: the engine's own result over the
  episode, ending it; a later `step` is an `environment.episode_over` rejection row.
- **A new stable error code**, `environment.not_reset` (`ErrorCode.EnvironmentNotReset`): `step()`
  or `finish()` before `reset()`. Every other environment code is a rejection row, as decided.
- **Every environment code is registered.** The seven rejection-row codes join `ErrorCode` beside
  `environment.not_reset` (each doc-commented "a rejection row, never thrown"), because the
  code-conformance gate registers every code literal once and the field reference reads the
  catalogue; `EnvironmentRejectionCode` is derived from them. The eight codes ride every core
  entrypoint that bundles the taxonomy, so `@totalfinance/core/pricing` moves 14 → 15 KB (it sat 1 B
  over its line before the seven were added).
- **The retry law is exact.** An order id repeats → `environment.duplicate_order` naming the original
  step and its outcome (`accepted`, `filled`, `partial`, `unfilled`, `cancelled`); the order is not
  executed, and the maintained suite proves zero additional fills.

**Gate findings at landing, each recorded rather than absorbed.** The manifest's analysis-shape law
refused `analysis` for the environment (a stateful object, not a report — `helper`); the count-safety
sweep could not see `maximumSteps` through an `unknown` door (the doors are typed); the
code-conformance gate wanted every `environment.*` literal registered (they are, in `ErrorCode`);
the eight registered codes ride every entrypoint that bundles the error taxonomy, so six budgets
that sat within a few dozen bytes of their lines move a quarter kilobyte each with the same dated
rationale (`core/pricing` 14 → 15, `options/black-scholes` and `fixed-income/xva` 11.25 → 11.5,
`math/montecarlo` 7 → 7.25, `calendars/crypto` 4.5 → 4.75, `fixed-income/lattice` 12.5 → 12.75);
the fixture/contract join moves 1225 → 1231; the declared-coverage residual gains the twelve
execution-gate rows the two verbs inherit from `portfolioBacktest`'s request; the bundle table's
rationale text may not carry a bare `*` (markdown emphasis pairs across rows).

**Evidence.**

- `packages/backtest/test/portfolio-stepper.test.ts`: `portfolioBacktest` is byte-identical to the
  thirteen goldens captured at `fcb9b8ac8` before the refactor (`portfolio-golden.json`: every
  lifecycle kind, the model on a schedule, the callback, external flows, three margin policies); a
  stepper driven by hand reproduces every callback journey; the sequencing law; early finish; the
  guards; immutability.
- `packages/backtest/test/trading-environment.test.ts`: reset/step over the data; the next-observation
  law (decided on bar 0 at 100, filled on bar 1 at 101); equality with `portfolioBacktest` under a
  one-instant order shift for every callback journey; a resting `gtc` limit carried with its reason
  and attempt count, a `day` order expired, cancel-and-replace in one action, the duplicate law;
  every malformed action and order as a rejection row with the step proceeding as hold; the rationale
  bounded and never read; determinism and the seed as identity; `terminated` on insolvency,
  `truncated` at the data boundary and at `maximumSteps`; deep-frozen results; every guard.
- Gates at landing: the manifest rows (eight new exports, one owner each), the signature policy's
  retained rows for the four new three-positional guards, first-touch fixtures for every new callable,
  the bundle budget row (`@totalfinance/backtest/environment` 103 KB; measured 100.9 KB) and the umbrella
  615 → 617 KB with its rationale, the docs inventory.

### Slice 2 (landed 2026-09-05, `35dd160e4`) — limits, the mask, the reward, features and freshness

**Decisions taken while landing.**

- **The monitor is the judge; the utilization is the dashboard.** Post-trade limits compose
  `monitorPortfolio` over the engine's own valuation inputs — the stepper gained `valuation()`
  (the ledger state, the market snapshot, the conversions, and the valued snapshot at the last
  closed instant) so no conversion or exposure is computed twice — with `policy: { limits }` and
  the monitor state carried step to step; a breach is any alert the monitor raises or keeps active.
  The observation's `limits.utilization` rows (value, bound, fraction per declared limit) are
  arithmetic over the snapshot's own figures; `limits.breaches` are the monitor's.
- **A projection is not a guarantee, and the test says so.** The pre-trade projection at the
  current marks passes an order that fills at a worse price and overshoots; the monitor then
  raises the breach and `onBreach` decides. `SessionContext.marks` (every instrument's adapter
  mark at the instant) was added so a flat instrument can be projected at all.
- **The mask's `episode-over` reason is real**: after a terminal step every side is disallowed
  with that reason, and a limit breach under `'terminate'` ends the episode with
  `reason: 'limit-breach'`.
- **Undefined risk is judged per option**: a sell that leaves the position net short is
  disallowed unless `allowUndefinedRiskOptions`, except a call covered by the underlying held; the
  journeys that write options opt in explicitly in the equivalence and leakage suites.
- **Features compose the dependency set the package already has**: close-to-close returns, the
  annualized standard deviation of log returns (`@totalfinance/math` × `@totalfinance/performance`), and the
  drawdown from the running peak close — over the bar prefix at or before the instant, found by
  binary search on the environment's own time-ordered index. `@totalfinance/technical-analysis` is
  not a dependency of the backtest package and is not made one.
- **Identity moves with the data; content may not.** The leakage suite strips the environment's
  and the engine's run identities (the episode now reports `engineRunId` beside `runId`, since
  the engine's id prefixes every event and fill id) and the instrument specifications (a custom
  adapter carries functions) before comparing observations byte for byte.
- **`goal` terms are validated at every step**: a non-record, a non-finite term, or a term that
  shadows a built-in component refuses with the shared codes — the caller's callback misbehaving
  is not a rejection row.

**Gate findings at landing.** The count-safety sweep fed a lookback of 2³² and the environment
accepted it (every feature came back null) — an absurd count must refuse, so lookbacks are bounded by
the episode ceiling (100,000 bars, `backtest.input_too_large`); the fixture/contract join moves
1231 → 1234 for the three new guards.

**Evidence.** `packages/backtest/test/trading-environment-limits.test.ts`: the projection names
the limit (`maximumPositionWeight`, `maximumPositionNotional`, `maximumGrossLeverage`, cumulative
across one action); a drawdown breach terminates under the default and is recorded under
`'reject-and-continue'`; the mask names `position-limit`, `undefined-risk`, `halted`, and
`stale-quote` and the submission check keeps its promise both ways; a covered call is allowed;
the reward's eight components are returned separately with weight 0 when absent, the accounting
is byte-identical under two compositions, the benchmark and `goal` terms pay as declared, and a bad
goal refuses; features from the prefix only; the leakage suite over every journey (every row after
the cutoff perturbed, every observation identical); the retry suite over every callback journey
(every submission repeated, zero additional fills); every malformed limits, reward, and features
block teaches. Gates at landing: three manifest rows, three retained signature rows, first-touch
fixtures, the environment budget 103 → 119 KB (the monitor is bundled, not re-derived) and the
umbrella 617 → 623 KB with their rationales.

### Slice 3 (landed 2026-09-05, `5680655fa`) — the episode library and the `environment` run kind

**Decisions taken while landing.**

- **The trace is the artifact's input.** `runEnvironmentEpisode({ definition, seed?, actions })`
  drives an environment from `reset` through every recorded action and returns the episode as one
  record — each step's canonical action, reward, and identity, the trace hash, and the engine's own
  result — and refuses a trace that outlives its episode. The `environment` run kind re-issues that
  verb on replay; `runHash` equality therefore covers the trace hash and every reward. The kind's
  identity names the engine run as its one child run and the trace in its strategy block.
- **`reset` reports the episode's flags.** An episode can be over at reset (a single instant,
  insolvency, a limit breached at the start), so `EnvironmentResetResult` carries `terminated`,
  `truncated`, and `reason` — the verb reads them instead of inferring them from the mask.
- **Identity hashes the rows as given.** Duplicated rows produce the same outcome (fills, rewards,
  equity) under a different identity; shuffled rows are the same run (the engine's identity
  ordering). The library's expectations say exactly that rather than "byte-identical" for both.
- **Freshness is judged on the policy's observation kind.** A quote-driven policy with bars alongside
  was never stale under the first draft (the newest observation of any kind was fresh); the age now
  measures the observation the fill model reads — the chain quote for an option — and the mask's
  `stale-quote` follows the same rule.
- **The scenario table was tightened where the engine's law is sharper than the sketch:** a
  missing session reuses the previous bar with its age visible (`no-observation` is the state before
  an instrument's first observation); a dividend pays the holder of the underlying, not of the put;
  a day order's partial remainder expires with the session (`gtc` carries it); a declared drawdown
  limit ends the margin-pressure episode before the maintenance breach, so the scenario's limit sits
  above the liquidation path. The rows and their expectations read accordingly.
- **The metrics extraction reads the engine result for this kind** (`run.result.performance`,
  `run.result.finalValue`) — one honest branch in `metricsOf`, not a mirrored performance block.

**Gate findings at landing.** The fixture/contract join moves 1234 → 1238 for the four new
callables; nothing else moved — the environment's guards already carried the shapes the artifact
spine reads.

**Evidence.** `packages/backtest/test/environment-episode.test.ts` (the verb: every step, the rewards,
the trace hash equal to a hand-driven episode, the data boundary, the outliving trace refused, the
guards; the run kind: save → JSON → restore → replay to the same run hash → compare two episodes;
a `goal` callback and a custom adapter recorded as not replayable with replay refusing; every
callback journey replays to its saved hash with the declared policy handed back as a live model);
`packages/backtest/test/environment-episodes.test.ts` (twenty ids built from their seed within the
size and time bounds, deterministic per seed; each row's expectation executable — the trend, the
anchor, the band, both volatility regimes through the feature block, the gap's limit and stop, the
halt through the mask and a carried `gtc`, staleness and the refusing mask, missing data, the
duplicated and shuffled feeds, the spread as a recorded cost, the thin book's partial remainder, the
put's expiry and the ETF's dividend, the pro-rata liquidation, the retry storm, the split and
dividend, the EUR bond through dated quotes, the visible model/market residual); the kind table's
fifth row in `run-artifacts.test.ts`. Gates at landing: five manifest rows, a retained signature row
for the episode-input guard, first-touch fixtures, the environment budget 119 → 124 KB, the artifacts
subpath 202 → 223 KB (it bundles the environment it replays), the umbrella 623 → 628 KB.

### Slice 4 (landed 2026-09-05, `2fe238e27`) — Agent Bench, the guide, the doc amendment

**Decisions taken while landing.**

- **The engine visits instruments in id order.** A saved episode's stored input is canonical JSON,
  whose record keys are sorted; the engine's lifecycle loop, marks, and assumptions block followed
  the record's insertion order, so an episode saved from an object literal (`UP`, `FLAT`) replayed
  in another order and to another run hash. `portfolioBacktest` and the stepper now iterate a
  sorted copy of `instruments` everywhere; the thirteen goldens are unchanged (their keys were
  already sorted), and every episode replays.
- **The leakage probe compares content, not identity.** Identities hash every row, so a perturbed
  future legitimately moves `runId`, the engine run id, and therefore every trace hash; the probe
  strips both identities and the instrument specifications (a custom adapter carries functions) and
  compares each first-half observation byte for byte — the same projection the leakage suite uses.
- **Baselines are labeled policies with declared needs.** `agentBaselines.*` return
  `{ label, requires, decide }`; `runAgentBench` merges the feature recipes a policy `requires`
  into the definition it runs, so `riskParity` and `momentumCrossover` read the feature block they
  need on any episode. `momentumCrossover` compares lookback returns (the observation carries no
  price history), and is named for what it does.
- **The random baseline sells only what it holds** and buys at most 5% of NAV at the mark, drawing
  only from the mask — zero violations by construction, which the journey asserts.
- **The bench report has no `score` field**, and the journey asserts its absence: operational
  conformance (`passes` over the absolute gates: look-ahead, replay equality, duplicate orders,
  external-order attempts, reconciliation) and strategy quality (return, volatility, Sharpe,
  Sortino, drawdown, turnover, cost, exposure, violations) are separate blocks, per episode and
  pooled.
- **The transcript scorer is deterministic and null-aware**: a dimension the expectation did not
  declare scores `null`, not 0, and `passes` reads only what was declared.
- **The agent-native doc is amended in place** with the adopted grammar (the frozen execution
  fields, `day | gtc`, `finish()`, the definition's blocks) and points to the guide.

**Gate findings at landing.** The enforcement measurement returned `defective 12`: the three
baseline factories that take an options object (`periodicRebalance`, `riskParity`,
`momentumCrossover`) and the two bench verbs accepted null, wrong-typed, omitted, and unknown fields
where every other door refuses — the factories had no guards at all, and `??` defaults on `episodes`,
`seeds`, `limits`, and the transcript's optional blocks accepted `null`. Every door now carries the
shared grammar (closed keys, the null law, positive safe integers, string arrays, function records),
`momentumCrossover` refuses a fast window that is not shorter than the slow one, and the measurement
returned to `defective 0`. The fixture/contract join moves 1238 → 1240 for the two bench verbs; the
declared-coverage residual gains three rows for the policy callback's return union (`hold | orders`),
which the walker names as branches of the callback field and no fixture can build — the FC8
callback residual's class. The manifest's live-surface law named the six `agentBaselines.*` members
as exports of their own — classified as `artifact`-role members of a `namespace` object, at the root
entrypoint as the live walk sees them (the `fees.*` pattern). The analysis-shape law refused
`scoreAgentTranscript`'s result without a `diagnostics` block (a report is assumptions + diagnostics),
so the score carries one. The docs-truthfulness gate read the guide's instrument record keys and a
property access as identities; the guide builds the record with `Object.fromEntries` and indexes
`actionMask['AAA']`. Once classified, the six members became governed heads of the count-safety
sweep: each gained a first-touch fixture (the join moves 1240 → 1246), and every window and budget
coordinate in the bench and the scorer now carries a ceiling (the episode ceiling for windows in
bars, one GiB for byte budgets) so a 2³² lookback is a typed refusal rather than a policy that never
trades. The unknown-key sweep then read `buyAndHold`'s positional weights record as a closed
config that accepted a bogus key, so the factory takes `{ weights? }` — the record sits under a
declared key, as `periodicRebalance` already did. The measurement ratchet holds at its bound: the
one new unmeasured path is the policy's `decide` callback contract, which no probe can input.

**Evidence.** `docs/examples/trading-environment.test.ts` (every baseline benched over two episodes
with operational conformance passing and no `score`; the random baseline's zero violations;
buy-and-hold beating hold-cash on the trend; a recorded episode saved and replayed to its run hash;
a transcript scored deterministically, with the refusal expectation flipping the verdict);
`docs/guides/trading-environment.md` executed by the guides gate; the engine's goldens and every
environment suite unchanged. Gates at landing: four manifest rows, first-touch fixtures, the guide
registered and indexed, the environment budget 124 → 129 KB, the umbrella 628 → 634 KB.

### Slice 5 (landed 2026-09-05, `f7677ebcb`) — the operation and the closeout

**Decisions taken while landing.**

- **One operation, declarative inputs only.** `totalfinance.backtest.environment_episode` takes a
  catalogue id or a named declarative definition, one of the six maintained baselines with its
  parameters, a seed, and `artifact: 'none' | 'embed'`; it composes `runAgentBench` over that one
  episode and returns the bench row (operational and strategy blocks), the recorded trace, and — on
  request — the recorded episode as an `environment` run artifact that replays to its run hash. A
  TypeScript policy or a reward `goal` callback is SDK-only, the existing callback law; an unknown
  baseline is `input.invalid_enum` everywhere.
- **`artifact: 'reference'` is the runtime's, not the operation's.** The contract's Decision 10
  sketched `artifacts: 'embed' | 'reference'`; the workflows runtime already spills a large output
  to the artifact store by handle, so the operation offers `'none'` (default) and `'embed'` and the
  transport decides how the bytes travel.
- **The bench accepts named definitions and returns its traces.** `runAgentBench`'s `episodes`
  entries are catalogue ids or `{ id, definition }`; every run's recorded input and result travel in
  `report.traces`, so the operation embeds the artifact without a third run of the episode.
- **The wire schema shares the portfolio request's members by name**: the accounting, market-data,
  external-flows, calendar, and window schemas are named constants both `portfolio_run` and the
  environment definition reuse — one schema per member, no second grammar.
- **The pins move 39 → 40** (registry, CLI, HTTP), the opt-in MCP expansion 27 → 28, the release
  smoke's OpenAPI paths 48 → 49; the manifest names `runAgentBench` as the tool's one owner verb.

**Gate findings at landing.** The count-safety sweep asked for a fixture that materializes the
named-definition branch of the bench's `episodes` (its `maximumSteps` is a count coordinate), so the
bench's first-touch fixture runs a named definition; the declared-coverage residual's three
slice-4 rows are restated under the `episodes` gate (a catalogue id or a named definition) crossed
with the policy callback's return union, and the list stays exact.

**Evidence.** `packages/workflows/test/environment-episode.test.ts` (the operation's row equals a
direct `runAgentBench` call; the embedded artifact restores and replays; a named definition runs
through the same door; the refusals); `tools/transport-parity.test.ts` (registry, CLI, HTTP, and MCP
agree on the result and on the malformed refusal); `tools/packed-consumer.test.ts` "Stage 7B.1" (the
operation runs from the tarballs through the registry and the CLI and agrees); the count pins in the
CLI, HTTP, MCP, and registry suites. Gates at landing: the workflows budget 415 → 447 KB (the pack now
bundles the environment, the baselines, the bench, and the episode library), the regenerated
inventories, OpenAPI, the field reference, llms.txt.

### Completion record (2026-09-05, `f7677ebcb`)

Stage 7B.1 (`AT4`) is complete: five slices landed in order, each with its tests, generated evidence,
and a records commit, and every exit-gate row above is ticked with the test that closes it. The
deterministic trading environment drives `portfolioBacktest`'s own loop from outside; the observation
holds only what was published; open orders, cancellations, and retries are real and typed; the
reward is a declared composition that never touches the accounting; twenty seeded scenarios carry
executable expectations; a saved episode replays to its run hash; Agent Bench reports operational
conformance apart from strategy quality with no single score; and one declarative operation carries
the bench across the registry, the CLI, the HTTP server, and the MCP adapter, from the packed
tarballs. The engine change this stage forced — instruments visited in id order — is recorded in the
slice-4 record. What stays open by design: stateful stepping over a transport, paper and live edges,
Agent2Agent, and the model-dependent half of Agent Bench beyond the deterministic scorer (`AT5`–`AT8`,
each gated separately per the crosswalk).
