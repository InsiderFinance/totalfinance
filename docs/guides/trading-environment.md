# The trading-agent environment

TotalFinance ships a deterministic environment in which coded policies, learned policies, and LLM agents
are developed and evaluated without broker risk. It is `portfolioBacktest`'s own per-instant loop
driven from outside — the same accounting, execution policy, lifecycle, marks, and margin — with the
orders decided by whoever holds the observation. The contract is the familiar `reset` / `step` one;
a thin adapter can implement Gymnasium later without moving any finance logic.

| Verb                       | What it does                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `createTradingEnvironment` | a definition (the stepper's request plus `maximumSteps`, `limits`, `reward`, `features`) → an environment |
| `environment.reset`        | the first decision instant's observation and the episode's identity; an optional seed                     |
| `environment.step`         | an action in — hold, orders, cancellations — the next observation, the reward, and the flags out          |
| `environment.finish`       | the engine's own result over the episode, the same shape `portfolioBacktest` returns                      |
| `runEnvironmentEpisode`    | a recorded action trace driven to the end — the `environment` run kind's verb                             |
| `environmentEpisode`       | one of twenty maintained scenarios built from a seed                                                      |
| `runAgentBench`            | a policy over the library: operational conformance apart from strategy quality                            |
| `scoreAgentTranscript`     | a recorded transport transcript scored against the operations, arguments, parity, and refusals expected   |

## The laws every episode keeps

- **Next-observation.** An order decided on observation `k` meets the market at instant `k + 1`
  through the declared fill model; it is never filled on the bar that produced it.
- **No leak.** The observation holds only what was published at or before its instant — the latest
  observations, the marks, the features over the bar prefix — and it is deeply frozen.
- **Rejections are rows.** A malformed action, an unknown instrument, a disallowed side, a projected
  limit breach, a repeated order id: each is a typed row in `rejections`, never a throw, and the
  step proceeds. A repeated order id is an idempotent retry, not a second order.
- **The mask is a promise.** `observation.actionMask` says per instrument and side whether an
  order is allowed and why not; an allowed order is never rejected for a mask reason.
- **The reward never touches the accounting.** It is a declared composition over the step's frame,
  every component returned with its value, weight, and contribution — weight 0 when the composition
  omits it — so two rewards over the same trace leave identical fills, events, and equity.
- **Identity is a chain.** `runId` identifies the environment and the seed; the trace hash chains
  every canonical action, so identical policies leave identical traces and an episode replays to
  the same run hash.

## A first episode

```ts
import { isoDateToEpochMs, type Bar } from '@insiderfinance/totalfinance/core';
import {
  createTradingEnvironment,
  type TradingEnvironmentDefinition,
} from '@insiderfinance/totalfinance/backtest/environment';

const day = (i: number): number => isoDateToEpochMs('2026-01-05') + i * 86_400_000 + 21 * 3_600_000;
const bars = (symbol: string, closes: number[]): Bar[] =>
  closes.map((close, i) => ({
    symbol,
    timestampMs: day(i),
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000_000,
  }));

const definition: TradingEnvironmentDefinition = {
  accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
  instruments: Object.fromEntries(
    ['AAA', 'BBB'].map((id) => [id, { kind: 'equity' as const, currency: 'USD' }]),
  ),
  marketData: {
    bars: [
      ...bars('AAA', [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]),
      ...bars('BBB', [50, 49.5, 49, 48.5, 48, 47.5, 47, 46.5, 46, 45.5]),
    ],
  },
  limits: { maximumPositionWeight: 0.5, maximumGrossLeverage: 1, onBreach: 'reject-and-continue' },
  reward: { pnl: 1, drawdown: -2, turnover: -0.1, riskViolation: -10 },
  features: { lookbackReturns: [1, 5], realizedVolatility: { lookbacks: [5], annualization: 252 } },
};

const environment = createTradingEnvironment(definition);
const start = environment.reset({ seed: 42 });
console.log(start.observation.asOf, start.observation.portfolio.netAssetValue); // 100,000 at bar 0

// decided on bar 0 (close 100), filled on bar 1 (close 101): the next-observation law
const bought = environment.step({
  kind: 'orders',
  orders: [{ orderId: 'first', instrumentId: 'AAA', side: 'buy', quantity: 300, type: 'market' }],
});
console.log(bought.fills[0]?.pricePerUnit); // 101
console.log(bought.reward.components['turnover']); // { value: 0.303, weight: -0.1, contribution: -0.0303 }
console.log(bought.observation.actionMask['AAA']); // { buy: true, sell: true, reasons: { buy: [], sell: [] } }

// a repeated id is a retry, never a second order
const retried = environment.step({
  kind: 'orders',
  orders: [{ orderId: 'first', instrumentId: 'AAA', side: 'buy', quantity: 300, type: 'market' }],
});
console.log(retried.rejections[0]?.code); // 'environment.duplicate_order'
console.log(retried.fills.length); // 0

let last = retried;
while (!last.terminated && !last.truncated) last = environment.step({ kind: 'hold' });
console.log(last.reason); // 'data-boundary'
const result = environment.finish();
console.log(result.fills.length, result.assumptions.strategy); // 1 { kind: 'external', replayable: false }
```

## Limits, the mask, and the reward

`limits` is FC7's `PolicyLimits` verbatim — `maximumPositionWeight`, `maximumGrossLeverage`,
`maximumDrawdown`, `maximumDailyLoss`, `minimumSettledCash`, … — plus `allowUndefinedRiskOptions`
(default false: a sell that leaves an option net short is disallowed, a covered call excepted),
`maximumPositionNotional`, and `onBreach` (`'terminate'` by default, or `'reject-and-continue'`).
Pre-trade, each queued order is projected at the current marks and a breach is
`environment.limit_breach` naming the limit; post-trade, `monitorPortfolio` is the judge and the
observation's `limits.breaches` are its alerts. A projection is not a guarantee: a fill at a worse
price can overshoot, and then the monitor says so.

The reward composition names weights on `pnl`, `drawdown` (the increase from the running peak),
`turnover`, `cost`, `concentration`, `leverage`, `riskViolation`, a `benchmark` instrument's excess,
and `goal` terms from a callback (which makes the definition non-replayable). Every component is
in `reward.components` regardless of what the composition paid for.

## Episodes, artifacts, and the bench

```ts
import {
  backtestRunArtifact,
  readBacktestRun,
  replayBacktestRun,
} from '@insiderfinance/totalfinance/backtest/artifacts';
import {
  agentBaselines,
  environmentEpisode,
  runAgentBench,
  runEnvironmentEpisode,
} from '@insiderfinance/totalfinance/backtest/environment';

const trending = environmentEpisode({ id: 'trending', seed: 7 });
console.log(trending.sessions, trending.expectations[0]); // 120 'buy-and-hold beats hold-cash'

// a recorded trace is the artifact's input; replay re-issues it to the same run hash
const episode = runEnvironmentEpisode({
  definition: trending.definition,
  seed: 7,
  actions: [
    {
      kind: 'orders',
      orders: [{ orderId: 'a', instrumentId: 'UP', side: 'buy', quantity: 500, type: 'market' }],
    },
    { kind: 'hold' },
    { kind: 'hold' },
  ],
});
const artifact = backtestRunArtifact({
  kind: 'environment',
  run: episode,
  input: { definition: trending.definition, seed: 7, actions: episode.steps.map((s) => s.action) },
});
console.log(readBacktestRun({ artifact }).report.identity.strategy); // { kind: 'environment', actions: 3, traceHash: '…' }
console.log(replayBacktestRun({ artifact }).matches); // true

// the bench: operational conformance apart from strategy quality, no single score
const bench = runAgentBench({
  policy: agentBaselines.buyAndHold(),
  episodes: ['trending', 'range-bound'],
  seeds: [7],
});
console.log(bench.operational.passes, bench.operational.duplicateOrders); // true 0
console.log(bench.episodes.map((e) => [e.id, e.strategy.totalReturn !== null]));
```

The six baselines — `holdCash`, `buyAndHold`, `periodicRebalance`, `randomValidAction` (draws
only from the mask), `riskParity`, `momentumCrossover` — are policies like any other; each is itself
benched in the suite. `scoreAgentTranscript` scores a recorded transport transcript (the operations
called, their arguments and results, the teaching errors received, the answer and the artifacts it
cites) against what a journey expected — deterministically, so the same transcript always scores the
same. The model that produced the transcript is the caller's; the library holds none.
