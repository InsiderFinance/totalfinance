# End to end: fundamentals → valuation → screen → portfolio → backtest → performance

One journey across six packages, on committed numbers, with no provider, network, credential,
clock, database, MCP server, or UI. Every step's output feeds the next through public types only,
and every step is reconciled to a primitive the library already proves. The executable twin is
`docs/examples/end-to-end-journey.test.ts`; this page's blocks run in CI too.

## 1. Fundamentals

Typed statements in, point-in-time ratios out. A statement is visible only from its
`availableTimestampMs`; nothing is inferred from a period end.

```ts
import { analyzeFundamentals } from '@insiderfinance/totalfinance/fundamentals';

const period = {
  periodEndDate: '2025-12-31',
  fiscalYear: 2025,
  periodType: 'year' as const,
  availableTimestampMs: Date.UTC(2026, 1, 20),
  currency: 'USD',
  monetaryScale: 1 as const,
};
const company = (size: number, margin: number) => {
  const revenue = 1_000 * size;
  const operatingIncome = revenue * margin;
  return {
    income: { period, revenue, operatingIncome, netIncome: operatingIncome * 0.7 },
    balance: {
      period,
      cashAndCashEquivalents: 150 * size,
      accountsReceivable: 100 * size,
      inventory: 75 * size,
      accountsPayable: 50 * size,
      propertyPlantEquipmentNet: 450 * size,
      totalAssets: 1_250 * size,
      totalDebt: 280 * size,
      totalLiabilities: 560 * size,
      totalEquity: 690 * size,
    },
    cashFlow: {
      period,
      operatingCashFlow: operatingIncome * 0.9,
      investingCashFlow: -80 * size,
      financingCashFlow: -30 * size,
    },
  };
};
const names = ['AAA', 'BBB', 'CCC'] as const;
const sizes = [1, 2, 0.5];
const margins = [0.22, 0.15, 0.08];
const companies = Object.fromEntries(
  names.map((name, index) => [name, company(sizes[index]!, margins[index]!)]),
) as Record<(typeof names)[number], ReturnType<typeof company>>;
const asOf = Date.UTC(2026, 2, 1);

const fundamentals = Object.fromEntries(
  names.map((name) => [
    name,
    analyzeFundamentals({
      statements: [companies[name]],
      asOf,
      restatementPolicy: 'latest-available',
    }),
  ]),
) as Record<(typeof names)[number], ReturnType<typeof analyzeFundamentals>>;
if (fundamentals[names[0]].periodsVisible !== 1)
  throw new Error('one period is visible at the instant');
```

## 2. Valuation

A DCF from the statements under explicit conventions. The discount rate is required — a
convention is a goal, never a default — and the composition equals the direct DCF of the flows it
projected.

```ts
import {
  discountedCashFlow,
  discountedCashFlowFromStatements,
} from '@insiderfinance/totalfinance/valuation';
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';

const valuation = (name: (typeof names)[number]) =>
  discountedCashFlowFromStatements({
    projection: {
      baseStatements: companies[name],
      periods: [1, 2, 3].map((year) => ({
        periodLabel: `FY${2025 + year}`,
        revenue: { growthRate: 0.06 },
        operatingMargin: companies[name].income.operatingIncome / companies[name].income.revenue,
        taxRate: 0.25,
        interestExpense: 10,
        depreciationAndAmortization: { fractionOfRevenue: 0.05 },
        capitalExpenditure: { fractionOfRevenue: 0.07 },
        accountsReceivable: { fractionOfRevenue: 0.1 },
        inventory: { fractionOfRevenue: 0.075 },
        accountsPayable: { fractionOfRevenue: 0.05 },
        netBorrowing: 0,
        dividendsPaid: 0,
      })),
    },
    valuation: {
      valuationBasis: 'firm',
      valuationDate: '2025-12-31',
      currency: 'USD',
      annualDiscountRate: 0.09,
      compounding: 'annual',
      terminalValueMethod: {
        method: 'perpetual-growth',
        terminalCashFlow: companies[name].income.operatingIncome * 0.75,
        perpetualGrowthRate: 0.02,
      },
    },
  });
const valuations = Object.fromEntries(names.map((name) => [name, valuation(name)])) as Record<
  (typeof names)[number],
  ReturnType<typeof valuation>
>;
const composed = valuations[names[0]];
const direct = discountedCashFlow({
  valuationBasis: 'firm',
  valuationDate: '2025-12-31',
  currency: 'USD',
  projectedCashFlows: composed.projection.statements.map((row, index) => ({
    timeYears: index + 1,
    amount: row.freeCashFlowToFirm,
  })),
  annualDiscountRate: 0.09,
  compounding: 'annual',
  terminalValueMethod: {
    method: 'perpetual-growth',
    terminalCashFlow: companies[names[0]].income.operatingIncome * 0.75,
    perpetualGrowthRate: 0.02,
  },
});
if (canonicalJsonOf(composed.valuation) !== canonicalJsonOf(direct))
  throw new Error('the composition is not the direct DCF');
```

## 3. Research

The fundamentals and the valuation become declared fields of a universe, and a score ranks the
names — point in time, by each observation's availability.

```ts
import { scoreUniverse } from '@insiderfinance/totalfinance/research';

const fieldDefinitions = [
  { fieldName: 'operatingMargin', kind: 'numeric' as const, unit: 'decimal ratio' },
  { fieldName: 'enterpriseValueToRevenue', kind: 'numeric' as const, unit: 'multiple' },
];
const observations = names.map((name) => {
  const value = valuations[name].valuation;
  const enterpriseValue = 'enterpriseValue' in value ? value.enterpriseValue : Number.NaN;
  return {
    instrumentId: name,
    availableTimestampMs: period.availableTimestampMs,
    fields: {
      operatingMargin: fundamentals[name].ratios['operatingMargin']!.value!,
      enterpriseValueToRevenue: enterpriseValue / companies[name].income.revenue,
    },
  };
});
const components = [
  {
    field: 'operatingMargin',
    weight: 0.5,
    direction: 'higher-is-better' as const,
    standardization: 'z-score' as const,
  },
  {
    field: 'enterpriseValueToRevenue',
    weight: 0.5,
    direction: 'lower-is-better' as const,
    standardization: 'z-score' as const,
  },
];
const scored = scoreUniverse({
  universeId: 'journey',
  asOf,
  observations,
  fieldDefinitions,
  components,
  missingValuePolicy: 'exclude',
});
if (scored.rows.length !== 3) throw new Error('every name scored');
```

## 4. Portfolio

A ledger with cash, a market snapshot, and a proposal that buys the two best names to weight —
a proposal, never an order.

```ts
import {
  applyPortfolioEvents,
  proposePortfolioRebalance,
} from '@insiderfinance/totalfinance/portfolio';
import { createMarketSnapshot } from '@insiderfinance/totalfinance/core/artifacts';

const deposit = {
  eventId: 'journey:deposit',
  schemaVersion: 1,
  eventType: 'cash.deposit',
  sourceId: 'journey',
  accountId: 'main',
  effectiveTimestampMs: Date.UTC(2026, 1, 1, 15),
  recordedTimestampMs: Date.UTC(2026, 1, 1, 15),
  event: { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' },
  provenance: {},
};
const state = applyPortfolioEvents({
  portfolio: { baseCurrency: 'USD' },
  events: [deposit as never],
});
const spots = Object.fromEntries(
  names.map((name, index) => [name, { price: 50 + index * 10, currency: 'USD' }]),
);
const market = createMarketSnapshot({ asOf, observations: { spots } });
const [first, second] = scored.rows.map((row) => row.instrumentId);
const proposal = proposePortfolioRebalance({
  portfolio: state,
  market,
  asOf,
  policy: {
    targets: [
      { group: { instrumentId: first! }, weight: 0.5 },
      { group: { instrumentId: second! }, weight: 0.3 },
      { group: { assetClass: 'cash' }, weight: 0.2 },
    ],
  },
  scope: 'to-target',
});
if (proposal.trades.length !== 2 || proposal.unresolvedTargets.length !== 0)
  throw new Error('two buys, nothing unresolved');
```

## 5. Backtest

The same score as a cross-sectional signal over a returns dataset. The engine's equity is its
ledger's net asset value, and the execution policy is named.

```ts
import { crossSectionalBacktest } from '@insiderfinance/totalfinance/backtest';

const sessions = [
  '2026-03-06',
  '2026-03-13',
  '2026-03-20',
  '2026-03-27',
  '2026-04-03',
  '2026-04-10',
];
const drift = (name: string): number =>
  [0.015, 0.005, -0.01][names.indexOf(name as (typeof names)[number])]!;
const run = crossSectionalBacktest({
  dataset: {
    observations,
    fieldDefinitions,
    returns: names.flatMap((name) =>
      sessions.map((tradingSessionDate, index) => ({
        instrumentId: name,
        tradingSessionDate,
        simpleReturn: drift(name) + (index % 2 === 0 ? 0.002 : -0.002),
      })),
    ),
  },
  universeHistory: {
    universeId: 'journey',
    members: names.map((instrumentId) => ({ instrumentId, fromTimestampMs: Date.UTC(2026, 0, 1) })),
  },
  signal: { score: { components, missingValuePolicy: 'exclude' } },
  rebalanceSchedule: { frequency: 'monthly', session: 'close' },
  portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
  initialCapital: 100_000,
});
if (Math.abs(run.diagnostics.reconciliationResidual) > 1e-9)
  throw new Error('the equity is the ledger');
if (run.assumptions.execution.realism !== 'simplified')
  throw new Error('the execution policy is named');
```

## 6. Performance

The run's performance block is `analyze` of its equity curve — the same function anyone can call
on any equity or return series.

```ts
import { analyze } from '@insiderfinance/totalfinance/performance';

const summary = analyze(
  { equity: run.points.map((point) => point.equity) },
  { periodsPerYear: 252 },
);
if (canonicalJsonOf(run.performance) !== canonicalJsonOf(summary))
  throw new Error('the performance block is analyze()');
```

Six packages, one journey, every step reconciled. The workflow form of each step —
`totalfinance.valuation.company`, `totalfinance.research.score`, `totalfinance.portfolio.rebalance_proposal`,
`totalfinance.backtest.cross_sectional_run`, `totalfinance.performance.analyze` — runs the same functions
over a wire; see [the MCP guide](./mcp.md) and [the CLI guide](./cli.md).
