/**
 * Stage 4.7 (FC9, Decision 2) — the end-to-end journey: fundamentals → valuation → screen /
 * factor → portfolio → backtest → performance, on committed fixtures, through public types only,
 * with a reconciliation the primitives already prove at every step. No provider, no network, no
 * clock, no seed. The guide `docs/guides/end-to-end.md` is this file in prose.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonOf, createMarketSnapshot } from '@totalfinance/core/artifacts';
import { analyzeFundamentals, type FinancialStatements } from '@totalfinance/fundamentals';
import { discountedCashFlow, discountedCashFlowFromStatements } from '@totalfinance/valuation';
import { scoreUniverse, type UniverseObservation } from '@totalfinance/research';
import {
  applyPortfolioEvents,
  proposePortfolioRebalance,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';
import { crossSectionalBacktest } from '@totalfinance/backtest';
import { analyze } from '@totalfinance/performance';

// ── 1. fundamentals: three companies, one fiscal year each, typed statements ─────────────────

const AS_OF = Date.UTC(2026, 2, 1);
const NAMES = ['AAA', 'BBB', 'CCC'] as const;

/** A typed year of statements for one company, scaled by `size`, with a margin of `margin`. */
function statements(size: number, margin: number): FinancialStatements {
  const period = {
    periodEndDate: '2025-12-31',
    fiscalYear: 2025,
    periodType: 'year' as const,
    availableTimestampMs: Date.UTC(2026, 1, 20),
    currency: 'USD',
    monetaryScale: 1 as const,
  };
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
}

const COMPANIES: Record<(typeof NAMES)[number], FinancialStatements> = {
  AAA: statements(1, 0.22),
  BBB: statements(2, 0.15),
  CCC: statements(0.5, 0.08),
};

// ── 2. valuation: a DCF from the statements under explicit conventions ───────────────────────

const valuation = (name: (typeof NAMES)[number]) =>
  discountedCashFlowFromStatements({
    projection: {
      baseStatements: COMPANIES[name],
      periods: [1, 2, 3].map((year) => ({
        periodLabel: `FY${2025 + year}`,
        revenue: { growthRate: 0.06 },
        operatingMargin: COMPANIES[name].income.operatingIncome / COMPANIES[name].income.revenue,
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
        terminalCashFlow: COMPANIES[name].income.operatingIncome * 0.75,
        perpetualGrowthRate: 0.02,
      },
    },
  });

// ── 3. research: the valuation outputs are declared fields of a universe ─────────────────────

const fieldDefinitions = [
  { fieldName: 'operatingMargin', kind: 'numeric' as const, unit: 'decimal ratio' },
  { fieldName: 'enterpriseValueToRevenue', kind: 'numeric' as const, unit: 'multiple' },
];

// ── the journey ──────────────────────────────────────────────────────────────────────────────

describe('the end-to-end journey (FC9 Decision 2)', () => {
  it('fundamentals → valuation → score → rebalance → backtest → performance, reconciled at every step', () => {
    // 1. fundamentals: the ratios of each company at the instant, point in time
    const fundamentals = Object.fromEntries(
      NAMES.map((name) => [
        name,
        analyzeFundamentals({
          statements: [COMPANIES[name]],
          asOf: AS_OF,
          restatementPolicy: 'latest-available',
        }),
      ]),
    ) as Record<(typeof NAMES)[number], ReturnType<typeof analyzeFundamentals>>;
    for (const name of NAMES) {
      expect(fundamentals[name].periodsVisible).toBe(1);
      expect(fundamentals[name].ratios['operatingMargin']?.value).toBeCloseTo(
        COMPANIES[name].income.operatingIncome / COMPANIES[name].income.revenue,
        12,
      );
    }

    // 2. valuation: the composition equals the direct DCF of the projected flows (the acceptance law)
    const valuations = Object.fromEntries(NAMES.map((name) => [name, valuation(name)])) as Record<
      (typeof NAMES)[number],
      ReturnType<typeof valuation>
    >;
    for (const name of NAMES) {
      const composed = valuations[name];
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
          terminalCashFlow: COMPANIES[name].income.operatingIncome * 0.75,
          perpetualGrowthRate: 0.02,
        },
      });
      expect(canonicalJsonOf(composed.valuation)).toBe(canonicalJsonOf(direct));
    }

    // 3. research: score the universe on the fundamentals and the valuation, point in time
    const observations: UniverseObservation[] = NAMES.map((name) => {
      const value = valuations[name].valuation;
      const enterpriseValue = 'enterpriseValue' in value ? value.enterpriseValue : Number.NaN;
      return {
        instrumentId: name,
        availableTimestampMs: COMPANIES[name].income.period.availableTimestampMs,
        fields: {
          operatingMargin: fundamentals[name].ratios['operatingMargin']!.value!,
          enterpriseValueToRevenue: enterpriseValue / COMPANIES[name].income.revenue,
        },
      };
    });
    const scored = scoreUniverse({
      universeId: 'journey',
      asOf: AS_OF,
      observations,
      fieldDefinitions,
      components: [
        {
          field: 'operatingMargin',
          weight: 0.5,
          direction: 'higher-is-better',
          standardization: 'z-score',
        },
        {
          field: 'enterpriseValueToRevenue',
          weight: 0.5,
          direction: 'lower-is-better',
          standardization: 'z-score',
        },
      ],
      missingValuePolicy: 'exclude',
    });
    expect(scored.rows).toHaveLength(3);
    const best = scored.rows[0]!.instrumentId;

    // 4. portfolio: a fresh ledger with cash, and a proposal that buys the two best names
    const deposit: PortfolioEventEnvelope = {
      eventId: 'journey:deposit',
      schemaVersion: 1,
      eventType: 'cash.deposit',
      sourceId: 'journey',
      accountId: 'main',
      effectiveTimestampMs: Date.UTC(2026, 1, 1, 15),
      recordedTimestampMs: Date.UTC(2026, 1, 1, 15),
      event: { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' },
      provenance: {},
    } as never;
    const state = applyPortfolioEvents({ portfolio: { baseCurrency: 'USD' }, events: [deposit] });
    const spots = Object.fromEntries(
      NAMES.map((name, index) => [name, { price: 50 + index * 10, currency: 'USD' }]),
    );
    const market = createMarketSnapshot({ asOf: AS_OF, observations: { spots } });
    const [first, second] = scored.rows.map((row) => row.instrumentId);
    const proposal = proposePortfolioRebalance({
      portfolio: state,
      market,
      asOf: AS_OF,
      policy: {
        targets: [
          { group: { instrumentId: first! }, weight: 0.5 },
          { group: { instrumentId: second! }, weight: 0.3 },
          { group: { assetClass: 'cash' }, weight: 0.2 },
        ],
      },
      scope: 'to-target',
    });
    expect(proposal.trades.map((trade) => trade.instrumentId).sort()).toEqual(
      [first, second].sort(),
    );
    expect(proposal.unresolvedTargets).toEqual([]);
    const traded = proposal.trades.reduce((sum, trade) => sum + trade.estimatedNotional, 0);
    expect(traded).toBeLessThanOrEqual(proposal.netAssetValue * 0.8 + 1e-6);

    // 5. backtest: the same score as a cross-sectional signal over a returns dataset
    const sessions = [
      '2026-03-06',
      '2026-03-13',
      '2026-03-20',
      '2026-03-27',
      '2026-04-03',
      '2026-04-10',
    ];
    const drift: Record<string, number> = { AAA: 0.015, BBB: 0.005, CCC: -0.01 };
    const run = crossSectionalBacktest({
      dataset: {
        observations,
        fieldDefinitions,
        returns: NAMES.flatMap((name) =>
          sessions.map((tradingSessionDate, index) => ({
            instrumentId: name,
            tradingSessionDate,
            simpleReturn: drift[name]! + (index % 2 === 0 ? 0.002 : -0.002),
          })),
        ),
      },
      universeHistory: {
        universeId: 'journey',
        members: NAMES.map((instrumentId) => ({
          instrumentId,
          fromTimestampMs: Date.UTC(2026, 0, 1),
        })),
      },
      signal: {
        score: {
          components: [
            {
              field: 'operatingMargin',
              weight: 0.5,
              direction: 'higher-is-better',
              standardization: 'z-score',
            },
            {
              field: 'enterpriseValueToRevenue',
              weight: 0.5,
              direction: 'lower-is-better',
              standardization: 'z-score',
            },
          ],
          missingValuePolicy: 'exclude',
        },
      },
      rebalanceSchedule: { frequency: 'monthly', session: 'close' },
      portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
      initialCapital: 100_000,
    });
    expect(run.holdings.some((row) => row.instrumentId === best)).toBe(true);
    expect(Math.abs(run.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-9);
    expect(run.assumptions.execution.realism).toBe('simplified');

    // 6. performance: the run's summary IS analyze(...) of its returns
    const summary = analyze(
      { equity: run.points.map((point) => point.equity) },
      { periodsPerYear: 252 },
    );
    expect(canonicalJsonOf(run.performance)).toBe(canonicalJsonOf(summary));
    expect(summary.periods).toBe(run.returns.length);
  });
});
