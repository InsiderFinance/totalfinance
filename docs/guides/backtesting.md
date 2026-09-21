# Backtesting

TotalFinance ships three simulation engines and one accounting law. Every engine emits the portfolio
ledger's events for what it did, and the equity it reports is the ledger's net asset value — a
result that cannot reconcile is a refusal (`backtest.ledger_reconciliation_failed`), never a number.

| Engine          | Call                     | Decides over                                 | Holds                                      | Fills through                            |
| --------------- | ------------------------ | -------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| Cross-sectional | `crossSectionalBacktest` | a returns dataset + a point-in-time universe | a long/short book of weights per rebalance | the execution policy on a session bar    |
| Options book    | `optionsBacktest`        | option-chain snapshots                       | one or several structures, leg by leg      | the execution-policy costs; combo/legged |
| Portfolio       | `portfolioBacktest`      | every observation of every instrument        | any mix of the eight instrument kinds      | the execution policy on the observation  |

`vectorized` and `eventDriven` (single-instrument bars) are unchanged and remain the fastest way to
test a bar-level signal.

### Portfolio timing and funding

`portfolioBacktest` calls the strategy after the observation is complete and prior orders have
filled. A decision made from observation 0 first executes on observation 1; a market order uses
that later bar's open, and a limit/stop uses that later bar's range. It never trades on the open
of the bar whose close the strategy just read. The last observation values the book without
asking for another decision. The stepper and trading environment obey the same single-delay law.
An order cannot execute against an unchanged, already-seen bar just because another instrument
advanced the clock. Standalone callback orders get one execution attempt; use the trading
environment when you need persistent open-order, cancellation, and replacement semantics.

Pre-open entitlements and external flows precede queued fills. Derivative settlement, funding,
and rolls that use the completed observation follow those fills: a closing gain cannot finance
an earlier opening purchase, and a derivative bought at the open still settles at that close.

Entry orders must fit the declared initial-margin/buying-power budget after fees and existing
exposure. The cash default reserves unsettled payables and does not spend unsettled receivables;
fund each trading currency explicitly (there is no automatic FX conversion). An unaffordable
order gets a `backtest.limit_rejected` row, not a hidden loan or resized fill. Risk-reducing exits
remain possible. Maintenance liquidations are a declared contemporaneous-close assumption and
cannot execute retroactively at an earlier open.

FX rates are dated point quotes available at their stated timestamps, not OHLC closing fields.
Conversions use the latest supplied quote at or before the current instant; a later quote is
excluded. Timestamp a published fixing when it becomes available if it is not known at the open.

## Which engine

- **A factor, a screen, or a score over a universe** — `crossSectionalBacktest`. The signal is one
  research verb (`FactorRecipe`, `scoreUniverse`, `screenUniverse`), the selection is
  `formQuantilePortfolios`, the quantities are `allocatePortfolio`. `crossSectionalBacktestGrid` runs a
  cartesian product of variations and composes the hygiene verdicts (`researchProtocol`,
  `deflatedSharpeRatio`, `probabilityOfBacktestOverfitting`) verbatim.
- **A rules-based options program** — `optionsBacktest`. Declarative entries (spreads, condors,
  strangles, straddles, covered calls, protective puts, calendars, diagonals, double diagonals), exits
  and rolls, a book of rules with pre-trade limits, combo or legged fills, corporate-action lineage,
  dividend evidence, the surface summary.
- **A multi-asset portfolio with lifecycle** — `portfolioBacktest`. Equities, ETFs, options, futures,
  FX forwards, crypto spot and perpetuals, bonds, or a custom adapter; a model on a schedule
  (`proposePortfolioRebalance`) or a direct callback; settlement lags, external flows, a calendar,
  the margin check with forced liquidation.

## The laws every engine keeps

1. **No look-ahead.** A decision instant sees only what was available at that instant: a feature by
   its `availableTimestampMs`, a chain by its snapshot, an observation by its timestamp, universe
   membership by its history. A later restatement never reaches an earlier decision.
2. **Ordering invariance.** Shuffle the input rows and the result is byte-identical.
3. **The ledger is the truth.** Fills are `NormalizedFill`s from `@totalfinance/portfolio`; the engine
   defines no fill, cash, lot, or P&L shape of its own. `result.ledger` folds to `finalValue`.
4. **Execution is declared.** The default policy is `execution.simplified()` and every result names
   it in `assumptions.execution`; `execution.declared({...})` is a claim the caller signs.
5. **Bounded work.** Rows, positions, grid variations, and books have ceilings with typed refusals.
6. **Determinism.** No engine reads a clock; a `seed` only seeds the bootstrap confidence intervals.

## Artifacts and operations

`@totalfinance/backtest/artifacts` saves any run as a content-addressed artifact (`backtestRunArtifact`),
restores it (`readBacktestRun`), replays it to the same run hash (`replayBacktestRun` — live models
are taken back and verified against their recorded descriptions), and compares two runs
(`compareBacktestRuns`). Over the wire, the opt-in `backtestPack` exposes
`totalfinance.backtest.vectorized_run`, `options_run`, `cross_sectional_run`, and `portfolio_run` with
declarative inputs only; callbacks are SDK-only.

Cross-sectional `runId` identifies the full declarative signal/configuration and session span,
including component directions, weights, screening predicates, costs, and report settings.
It is not a digest of the dataset rows: the stored artifact's `runHash` is the separate complete
result identity. Custom callable cost/fill models retain their declared label/version identity;
callers must change those identifiers when behavior changes. Callback runs remain explicitly
non-replayable.

## Out of sample

A cross-sectional strategy fits nothing, so "training" means choosing a variation.
`crossSectionalWalkForward({ request, variations, trainSessions, testSessions })` runs the grid on every training
span, lets its selection metric choose, runs the choice once on the following held-out span, and
stitches the held-out returns in order (rolling or anchored spans). `crossSectionalPurgedFolds({ request, variations,
folds, purgeGap, embargo })` takes its folds from `purgedKFold` over the session index, pools a fold's
two training segments into one return series, and evaluates the choice on the held-out block. Both
report every window's training sweep ids and held-out run id, the train-versus-test degradation, and
the stitched held-out performance; the grid's own hygiene verdicts (`researchProtocol`,
`deflatedSharpeRatio`, `probabilityOfBacktestOverfitting`) remain the in-sample story.

## A first call

```ts
import { crossSectionalBacktest } from '@totalfinance/backtest';

// Three names, four weekly sessions, one declared field published before the first close.
const names = ['AAA', 'BBB', 'CCC'];
const sessions = ['2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23'];
// Quality ranks the names in order; the drift makes the ranking pay off.
const quality = (instrumentId: string): number => names.length - names.indexOf(instrumentId);
const drift = (instrumentId: string): number => [0.02, 0, -0.02][names.indexOf(instrumentId)]!;

const run = crossSectionalBacktest({
  dataset: {
    observations: names.map((instrumentId) => ({
      instrumentId,
      availableTimestampMs: Date.UTC(2026, 0, 1, 21),
      fields: { quality: quality(instrumentId) },
    })),
    fieldDefinitions: [{ fieldName: 'quality', kind: 'numeric' }],
    returns: names.flatMap((instrumentId) =>
      sessions.map((tradingSessionDate, i) => ({
        instrumentId,
        tradingSessionDate,
        simpleReturn: drift(instrumentId) + (i % 2 === 0 ? 0.001 : -0.001),
      })),
    ),
  },
  universeHistory: {
    universeId: 'first-call',
    members: names.map((instrumentId) => ({ instrumentId, fromTimestampMs: Date.UTC(2026, 0, 1) })),
  },
  signal: {
    score: {
      components: [
        { field: 'quality', weight: 1, direction: 'higher-is-better', standardization: 'z-score' },
      ],
      missingValuePolicy: 'exclude',
    },
  },
  rebalanceSchedule: { frequency: 'monthly', session: 'close' },
  portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
  initialCapital: 100_000,
});

run.performance.sharpe; // the performance block over the ledger's equity
run.assumptions.execution.realism; // 'simplified' — the default policy, named
run.ledger.events.length; // every fill and mark as portfolio events
```

See `docs/specs/portfolio-scale-backtesting.md` for the contract and its decisions.
