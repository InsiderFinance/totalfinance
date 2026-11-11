# First useful results and first-failure recovery

These synthetic examples use the public SDK and its existing operation registry. Install
`@insiderfinance/totalfinance` with your package manager, put the TypeScript blocks below in one
`journeys.mts` file in order, and run `pnpm exec tsx journeys.mts` (add `tsx` as a development
dependency if needed). They require no provider or key. The packed-consumer test compiles and runs
these exact blocks. A prepared workspace version is not evidence that it is already on npm.

## Compute from the statement you actually have

Income-only ratios accept `{ income }`; balance-only ratios accept `{ balance }`. Each direct
request requires its period and the monetary lines its formula needs; unrelated income/balance
lines and other statements are not prerequisites. Other supplied canonical fields remain validated. Complete
`{ statements }` calls remain supported and validate the complete corresponding set. EBITDA,
market multiples and cross-statement/average-balance ratios still require their stated inputs.
Do not invent a cash-flow table or call cumulative nine-month flows a quarter. A full-set report's
period availability is the latest publication instant of its three statements; a direct statement
reports its own availability. Paired reports expose both current and prior period availability;
point-in-time use must respect both (including a later prior-period restatement).

```ts
import { grossMargin, currentRatio } from '@insiderfinance/totalfinance/fundamentals';
import { ohlcvFromBars, atr } from '@insiderfinance/totalfinance/technical-analysis';
import { vectorized, fees, slippage } from '@insiderfinance/totalfinance/backtest';
import { researchProtocol } from '@insiderfinance/totalfinance/risk';
import { screenUniverse } from '@insiderfinance/totalfinance/research';
import {
  createOperationRegistry,
  createMemoryArtifactStore,
  portfolioPack,
  tradePack,
  technicalAnalysisPack,
} from '@insiderfinance/totalfinance/workflows';

const period = {
  periodStartDate: '2026-01-01',
  periodEndDate: '2026-03-31',
  fiscalYear: 2026,
  fiscalQuarter: 1 as const,
  periodType: 'quarter' as const,
  availableTimestampMs: Date.UTC(2026, 3, 20),
  currency: 'USD',
  monetaryScale: 1_000_000 as const,
};
const income = { period, revenue: 200, costOfRevenue: 120 };
const balance = {
  period,
  currentAssets: 90,
  currentLiabilities: 45,
};
if (grossMargin({ income }) !== 0.4) throw new Error('Unexpected synthetic result');
if (currentRatio({ balance }) !== 2) throw new Error('Unexpected synthetic result');
if (
  grossMargin.explain({ income }).assumptions.period.availableTimestampMs !==
  period.availableTimestampMs
)
  throw new Error('Unexpected synthetic availability');
```

The direct family also includes operating/net margins, interest/debt-service coverage, earnings/
revenue per share, quick/cash ratios and debt/equity or debt/assets. Per-share inputs retain
absolute diluted share counts and convert reported monetary scales explicitly. A missing optional
numerator or zero denominator yields `null` with its reason in `.explain()`.

## Create, open and inspect a portfolio

Enable both the `trade` and `portfolio` packs for create → inspect: creation and the event writer
live in `trade`, while inspection lives in `portfolio` and requires `portfolio:read`.
CLI/MCP `--profile full` includes both. A trade-only configuration must enable `portfolio` before
calling the returned inspection operation. Creation requires
`portfolio:write`, a writable artifact store, durable identity, currency and explicit initial events.
An empty event array creates an unfunded ledger. To fund it, supply actual explicit `cash.deposit`
events through creation or `portfolio.record_events`—there is no implicit deposit.

```ts
const operations = createOperationRegistry({ packs: [portfolioPack(), tradePack()] });
const artifacts = createMemoryArtifactStore();
const createdTimestampMs = Date.UTC(2026, 3, 21);
const created = operations.run({
  id: 'totalfinance.portfolio.create',
  input: { portfolioId: 'synthetic-research', baseCurrency: 'USD', events: [], createdTimestampMs },
  artifacts,
  createdTimestampMs,
  capabilities: ['portfolio:write'],
});
const opened = operations.run({
  id: 'totalfinance.portfolio.inspect',
  input: { portfolio: created.structured['handle'], section: 'cash', limit: 20 },
  artifacts,
  createdTimestampMs,
  capabilities: ['portfolio:read'],
});
if (opened.structured['portfolioId'] !== 'synthetic-research')
  throw new Error('Unexpected synthetic result');
if (opened.structured['eventCount'] !== 0) throw new Error('Unexpected synthetic result');
if (JSON.stringify(opened.structured['rows']) !== JSON.stringify([]))
  throw new Error('Unexpected synthetic result');
```

Save the returned URI; the same store resolves it on the next process. For durable local use,
replace `createMemoryArtifactStore()` with
`createFileArtifactStore({ directory: '/absolute/path/to/your-store' })` from
`@insiderfinance/totalfinance/workflows/local`. CLI/MCP use `--store` for that same store.
MCP uses `--profile full --capability portfolio:write` and the tools
`totalfinance_portfolio_create`, `totalfinance_portfolio_inspect`, and
`totalfinance_portfolio_record_events`. HTTP also requires its configured mutation bearer credential;
a client capability does not enlarge the server's ceiling.

Inspection opens inline serialized ledgers too. `section` is `summary` (default), `events`,
`positions` or `cash`; `offset` defaults to 0 and `limit` to 20 (maximum 100). Rows are bounded
previews with container counts; `total` and `nextOffset` make continuation explicit. Use
`portfolio.snapshot` with actual market observations to value holdings. Event writes return new
content-addressed handles; prior handles retain their original meaning. Portfolio handles are
opened through this operation, rather than MCP `resources/read`.

## Project bars without losing their source

TA rows contain financial OHLCV fields. Core Bar records also identify symbol and observation time.
Make that projection explicit; retain the originals and their source/revision/receipt context next
to the result. No adapter infers volume, price adjustments, availability or a newer observation.

```ts
const sourceBars = [
  { symbol: 'TEST', timestampMs: 1000, open: 10, high: 12, low: 8, close: 10, volume: 2 },
  { symbol: 'TEST', timestampMs: 2000, open: 12, high: 14, low: 10, close: 12, volume: 4 },
];
const indicatorRows = ohlcvFromBars(sourceBars);
const trueRanges = atr(indicatorRows, { period: 1 });
if (JSON.stringify(trueRanges) !== JSON.stringify([4, 4]))
  throw new Error('Unexpected synthetic result');
if (sourceBars[0]!.timestampMs !== 1000) throw new Error('Unexpected synthetic result');
if ('timestampMs' in indicatorRows[0]! !== false) throw new Error('Unexpected synthetic result');
```

MCP `technical_analysis.calculate` accepts canonical `sourceBars` directly under `bars`, including
`symbol`, `timestampMs` and optional `vwap`/`adjusted`; no SDK preprocessing or field stripping is
needed. When source metadata is present, every row must have the canonical source fields, one
symbol and strictly increasing unique timestamps. Neither the tool nor the SDK projection sorts,
deduplicates, changes adjustment flags or relabels times. Bare OHLCV rows and columns under `series`
remain supported. Source context stays with the caller, and the operation's input hash covers the
original canonical input.

```ts
const technicalOperations = createOperationRegistry({ packs: [technicalAnalysisPack()] });
const sourceResult = technicalOperations.run({
  id: 'totalfinance.technical_analysis.calculate',
  input: { indicator: 'atr', bars: sourceBars, parameters: { period: 1 } },
});
if (JSON.stringify(sourceResult.structured['value']) !== JSON.stringify([4, 4]))
  throw new Error('Unexpected canonical-bar result');
```

Wire errors report exact total issue counts and at most ten representative indexed issues; fix the
named fields and retry the original data. All rows are still validated. TA discovery distinguishes
name search from category browsing: use `{ category: 'momentum' }` with
`totalfinance_technical_analysis_list` (SDK `searchIndicators` uses `query` for name search).

## Screen only available facts with the finite predicate grammar

The recursive grammar is `all: Filter[]`, `any: Filter[]`, `not: Filter`, or a field condition:

| Operators                                                          | Additional fields                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual` | numeric `value`                                                   |
| `equals`, `notEquals`                                              | number/string/boolean `value`, compatible with the declared field |
| `between`                                                          | numeric `from`, `to`                                              |
| `in`, `notIn`                                                      | number/string `values` array                                      |
| `isPresent`, `isMissing`                                           | none                                                              |

Groups are nonempty and keys are closed. There are no `gt`/`gte` aliases or expression strings.
The same grammar appears in MCP/OpenAPI discovery; declared field kinds and availability are
validated by the shared SDK.

```ts
const screened = screenUniverse({
  universeId: 'synthetic-two',
  asOf: 2000,
  observations: [
    { instrumentId: 'EARLY', availableTimestampMs: 1000, fields: { momentum: 0.1 } },
    { instrumentId: 'LATER', availableTimestampMs: 3000, fields: { momentum: 0.2 } },
  ],
  fieldDefinitions: [{ fieldName: 'momentum', kind: 'numeric', unit: 'decimal return' }],
  filter: { all: [{ field: 'momentum', operator: 'greaterThan', value: 0 }] },
  missingValuePolicy: 'exclude',
  orderBy: [{ field: 'momentum', direction: 'descending' }],
});
if (JSON.stringify(screened.rows.map((row) => row.instrumentId)) !== JSON.stringify(['EARLY']))
  throw new Error('Unexpected synthetic screen membership');
```

## Model lag and monthly sampling explicitly

Vectorized fills use closes. On a rebalance bar `i`, the engine samples `signal[i - executionLag]`.
Increasing lag does not postpone a missed monthly sample to the next day. In this five-session
example lag 1 first buys February 2, while lag 2 misses that sample and first buys March 2.

```ts
const dates = ['2026-01-29', '2026-01-30', '2026-02-02', '2026-02-03', '2026-03-02'];
const priceHistory = dates.map((date, index) => ({
  symbol: 'TEST',
  timestampMs: Date.parse(date),
  open: 100 + index * 10,
  high: 100 + index * 10,
  low: 100 + index * 10,
  close: 100 + index * 10,
}));
const controls = {
  data: priceHistory,
  signal: [0, 1, 1, 1, 1],
  initialCapital: 1000,
  rebalance: 'monthly' as const,
  fees: fees.bps(0),
  slippage: slippage.bps(0),
  periodsPerYear: 252,
  riskFreeRate: 0,
  maxLeverage: 1,
};
const lagOne = vectorized({ ...controls, executionLag: 1 });
const lagTwo = vectorized({ ...controls, executionLag: 2 });
if (lagOne.trades[0]!.timestampMs !== Date.parse('2026-02-02'))
  throw new Error('Unexpected synthetic result');
if (lagTwo.trades[0]!.timestampMs !== Date.parse('2026-03-02'))
  throw new Error('Unexpected synthetic result');
if (lagTwo.finalValue !== 1000) throw new Error('Unexpected synthetic result');
```

`totalfinance_backtest_vectorized_run` now accepts `executionLag`, `rebalance`, `slippageBps`,
`periodsPerYear`, `riskFreeRate`, and `maxLeverage` alongside existing `feeBps`. They delegate to
these SDK controls. Defaults remain the SDK's declared defaults; lag 0 produces a look-ahead warning.
Portfolio backtests use their own next-observation execution law: do not claim cross-engine
numerical equality. A one-bar lag does not prove source arrival before the next interval opened.

## Count every attempted configuration and keep evaluation separate

Freeze hypotheses and the split before viewing held-out outcomes. Select using training data only;
evaluate that same selected rule on the untouched holdout. Keep every attempt, including a rule
that made no trades. Undefined Sharpe is not zero and must not be fabricated into `trialSharpes`.
The count-plus-variance route below uses a separately declared synthetic null-model variance,
not an invented Sharpe for the flat rule. If that variance is unavailable, retain the gap rather
than claim a selection-adjusted result.

```ts
const attempts = [
  'trend: 12 training trades',
  'pullback: 8 training trades',
  'strict-filter: zero training trades',
];
const trainingReturns = [0.01, -0.01, 0.02, -0.02, 0.01, -0.01];
const heldOutReturns = [0.005, -0.005, 0.01, -0.01];
const hygiene = researchProtocol({
  returns: trainingReturns,
  outOfSampleReturns: heldOutReturns,
  trials: { trialCount: attempts.length, varianceSharpe: 0.04 },
  confidence: 0.95,
  periodsPerYear: 252,
  riskFreeRate: 0,
});
if (hygiene.trialCount !== 3) throw new Error('Unexpected synthetic result');
if (hygiene.verdict === 'significant') throw new Error('Unexpected synthetic result');
```

This is SDK guidance, not a new MCP research-verdict operation. See the
[backtesting guide](./backtesting.md) for existing grid/out-of-sample operations and the
[research-hygiene examples](../examples/research-hygiene.test.ts). Attractive simulated returns or
one short paper interval do not establish skill.

## Recover orders and distinguish estimated from charged costs

`trade.submit.currentOrders` is the receipt-scoped journal-derived current state, including
cumulative `filledQuantity`, `remainingQuantity` and `terminal`. `receipt` stays the original
immutable submission receipt. Top-level `fills`/`events` are new deltas; `recovery.fills/events` are
cumulative. After a lost response retain the original source, journal store, approved grant and
idempotency key; apply `recovery.events` idempotently to the latest portfolio handle. See the
[executable recovery examples](../examples/trade-lifecycle.test.ts) and
[recovery guide](./trade-lifecycle.md#recovering-a-lost-submission-response).

When restoring, omit `instruments` to reuse authoritative persisted terms, or repeat the exact
original mapping. Adding explicit share/settlement defaults to an older mapping is a changed
persisted identity even when it appears economically equivalent. Do not edit the journal or
retry with a new key to bypass that check. Real term changes require a separate supported lifecycle.

Proposal commissions and preflight `costs` are estimates. `maximumEstimatedCost: 0` and
`maximumSlippageBps: 0` now mean real zero ceilings: any positive estimate fails. Omitting a ceiling
means it is not supplied; zero never disables it. The MCP paper broker still uses its disclosed
simplified zero-cost policy. Estimates do not charge the ledger. Only actual normalized fill costs
and corresponding `cost.charge` events charge execution fees. For a declared nonzero execution
policy, use SDK `createPaperBroker({ ..., execution })` from
`@insiderfinance/totalfinance/backtest/paper`, with factories from `/backtest/execution`—the
[safe trade guide](./trade-lifecycle.md) explains authority and recovery. This patch adds no
wire paper-cost argument or cost-policy bypass.

Calendar discovery includes `US_EQUITY_CALENDAR_COVERAGE`: NYSE/CBOE one-off closures before
2001-01-01 are incomplete; earlier operation ranges carry `calendar.outside_historical_coverage`.
Rules do not predict future emergency closures, and `verifiedThrough: null` explicitly declines to
invent a certified endpoint. Session answers remain unchanged; independently verify old schedules.

Separate financial/time designs remain necessary for intraday P&L marks, availability-aware
research composition, and cumulative interim/YTD statements/quarter derivation. Do not relabel
source times or periods to force those unsupported compositions.
