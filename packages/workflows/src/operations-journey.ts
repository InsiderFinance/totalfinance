/**
 * The journey operations (Stage 7A Decision 4): thin compositions of GREEN compute — a portfolio
 * valued from its ledger, a P&L explained between two marks, a scenario set run against targets, a
 * universe screened / ranked / scored, an event study, an options backtest, and the artifact read
 * and compare doors. Every schema is authored over the direct function's own input shape (same
 * field names, same defaults, same nulls — law C16); a wire-only restriction (no callbacks, no class
 * instances, no iterables) is a NARROWER schema, never a different meaning. Nothing is aggregated
 * here: each `structured` output is the direct result verbatim, and a report of several results
 * keeps them side by side under one `assumptions`.
 */

import {
  compareAnalysisArtifacts,
  readAnalysisArtifact,
  readMarketSnapshot,
  readScenarioSet,
} from '@totalfinance/core/artifacts';
import { OptionQuoteSchema, schema, type JSONSchema } from '@totalfinance/core/schema';
import { crossSectionalBacktest, fees, slippage } from '@totalfinance/backtest';
import {
  execution,
  impactModels,
  latencyModels,
  spreadModels,
} from '@totalfinance/backtest/execution';
import { optionsBacktest } from '@totalfinance/backtest/options';
import { portfolioBacktest } from '@totalfinance/backtest/portfolio';
import { backtestRunArtifact } from '@totalfinance/backtest/artifacts';
import {
  ENVIRONMENT_EPISODE_IDS,
  agentBaselines,
  runAgentBench,
} from '@totalfinance/backtest/environment';
import {
  monitorPortfolio,
  portfolioPnl,
  portfolioSnapshot,
  portfolioTimeline,
  proposePortfolioRebalance,
  readPortfolioLedgerSnapshot,
} from '@totalfinance/portfolio';
import {
  discountedCashFlowFromStatements,
  discountedCashFlowSensitivityTable,
} from '@totalfinance/valuation';
import { eventStudy, rankUniverse, scoreUniverse, screenUniverse } from '@totalfinance/research';
import {
  runScenarios,
  scenarioPortfolioBinding,
  scenarioTarget,
  scenarioTargetsFromPortfolio,
} from '@totalfinance/scenarios';
import { defineOperation, type OperationPack, type TotalFinanceOperation } from './operation.js';
import { capRows } from './operation-kit.js';
import { boundedPreview } from './preview.js';

// ── shared envelope schemas (closed at the level the direct read door re-validates) ───────────

const ASSUMPTIONS_SCHEMA: JSONSchema = { type: 'object', description: 'Applied conventions' };
const DIAGNOSTICS_SCHEMA: JSONSchema = { type: 'object', description: 'Engine, method, warnings' };

const epochMsOrDate = schema
  .union([schema.number(), schema.string()])
  .describe('Epoch ms, YYYY-MM-DD, or a zoned ISO datetime');

import {
  CurrencyPairQuoteSchema,
  MarketSnapshotSchema,
  PortfolioLedgerEnvelopeSchema,
  PortfolioStateSchema,
  ProvenanceSchema,
} from './wire-schemas.js';

const ValuationMarkSchema = schema.object({
  valuationDate: schema
    .string()
    .date()
    .describe('Strict YYYY-MM-DD; the mark instant is 00:00 UTC'),
  market: MarketSnapshotSchema,
  currencyConversions: schema.array(CurrencyPairQuoteSchema).optional(),
});

const InstrumentClassificationSchema = schema
  .record(
    schema.object({
      underlying: schema.string().optional(),
      assetClass: schema.string().optional(),
      strategy: schema.string().optional(),
      tags: schema.array(schema.string()).optional(),
    }),
  )
  .describe(
    'Identity metadata per instrument for grouping; unknown instruments group as unclassified',
  );

const AnalysisArtifactSchema = schema
  .object({
    kind: schema.literal('totalfinance.analysis-artifact'),
    schemaVersion: schema.number().integer(),
    id: schema.string(),
    artifactType: schema.string(),
    producedBy: schema.object({
      operation: schema.string(),
      libraryVersion: schema.string().optional(),
    }),
    conventionsVersion: schema.string(),
    inputs: schema.object({
      inputsHash: schema.string(),
      snapshotHash: schema.string().optional(),
      parameters: schema.unknown().optional(),
    }),
    createdFrom: schema.array(schema.string()).optional(),
    result: schema.record(schema.unknown()),
    tables: schema.record(schema.record(schema.unknown())).optional(),
    provenance: ProvenanceSchema.optional(),
  })
  .describe(
    'A Gate B analysis artifact (totalfinance.analysis-artifact); hashes are re-verified by the read door',
  );

const ScenarioSetSchema = schema
  .object({
    kind: schema.literal('totalfinance.scenario-set'),
    schemaVersion: schema.number().integer(),
    name: schema.string().nonempty(),
    scenarios: schema
      .array(
        schema.object({
          name: schema.string().nonempty(),
          shocks: schema.array(
            schema.object({
              factor: schema.string(),
              kind: schema.enum(['percent', 'absolute'] as const),
              value: schema.number(),
              target: schema.string().optional(),
            }),
          ),
          overrides: schema
            .array(
              schema.object({
                factor: schema.string(),
                value: schema.number(),
                target: schema.string().optional(),
              }),
            )
            .optional(),
        }),
      )
      .min(1),
    provenance: ProvenanceSchema.optional(),
  })
  .describe('A Gate B scenario set (totalfinance.scenario-set)');

type LedgerEnvelope = ReturnType<typeof PortfolioLedgerEnvelopeSchema.parse>;
type PortfolioStateWire = ReturnType<typeof PortfolioStateSchema.parse>;

/** A ledger envelope re-hydrates through the read door; a state is handed through as it is. */
function portfolioStateOf(portfolio: LedgerEnvelope | PortfolioStateWire) {
  if ((portfolio as LedgerEnvelope).kind === 'totalfinance.portfolio-ledger') {
    return readPortfolioLedgerSnapshot({ snapshot: portfolio }).ledger.state;
  }
  return portfolio as never;
}

// ── portfolio ─────────────────────────────────────────────────────────────────────────────────

const PortfolioSnapshotInputSchema = schema.object({
  portfolio: schema
    .union([PortfolioLedgerEnvelopeSchema, PortfolioStateSchema])
    .describe(
      'A serialized ledger envelope (re-hydrated through readPortfolioLedgerSnapshot) or a PortfolioState',
    ),
  asOf: epochMsOrDate.describe('The valuation instant'),
  market: MarketSnapshotSchema,
  currencyConversions: schema
    .array(CurrencyPairQuoteSchema)
    .optional()
    .describe(
      'Quotes to the base currency — required exactly when the portfolio holds non-base currency',
    ),
});

const PORTFOLIO_SNAPSHOT_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    asOf: { type: 'number' },
    baseCurrency: { type: 'string' },
    netAssetValue: { type: 'number' },
    cash: { type: 'array', items: { type: 'object' } },
    totalCashBaseCurrencyValue: { type: 'number' },
    positions: { type: 'array', items: { type: 'object' } },
    totalPositionsBaseCurrencyValue: { type: 'number' },
    assumptions: ASSUMPTIONS_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
  },
  required: [
    'asOf',
    'baseCurrency',
    'netAssetValue',
    'cash',
    'totalCashBaseCurrencyValue',
    'positions',
    'totalPositionsBaseCurrencyValue',
    'assumptions',
    'diagnostics',
  ],
};

const portfolioSnapshotOperation = defineOperation({
  id: 'totalfinance.portfolio.snapshot',
  handleFields: ['portfolio', 'market'],
  title: 'Value a portfolio at an instant',
  description:
    'Value every cash balance and position of a portfolio at one instant from a Gate B market snapshot: ' +
    'net asset value in the base currency, per-account cash rows (settled and unsettled), per-position marks, ' +
    'cost basis and unrealized P&L. Supply the portfolio as its serialized ledger envelope (re-hydrated ' +
    'through readPortfolioLedgerSnapshot) or as a derived PortfolioState. The result is portfolioSnapshot(...) verbatim.',
  inputSchema: PortfolioSnapshotInputSchema,
  outputSchema: PORTFOLIO_SNAPSHOT_OUTPUT,
  costClass: 'small',
  run: (input) => {
    const result = portfolioSnapshot({
      portfolio: portfolioStateOf(input.portfolio),
      asOf: input.asOf,
      market: input.market as never,
      ...(input.currencyConversions !== undefined
        ? { currencyConversions: input.currencyConversions }
        : {}),
    });
    return {
      summary: `NAV ${result.netAssetValue.toFixed(2)} ${result.baseCurrency} at ${new Date(result.asOf).toISOString()} (${result.positions.length} positions, ${result.cash.length} cash rows)`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

const PortfolioPnlInputSchema = schema.object({
  ledger: PortfolioLedgerEnvelopeSchema,
  from: ValuationMarkSchema.describe('The opening valuation mark'),
  to: ValuationMarkSchema.describe('The closing valuation mark (strictly after `from`)'),
  instrumentClassification: InstrumentClassificationSchema.optional(),
});

const PORTFOLIO_PNL_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    baseCurrency: { type: 'string' },
    from: { type: 'object' },
    to: { type: 'object' },
    netAssetValueChange: { type: 'number' },
    externalFlows: { type: 'number' },
    investmentReturn: { type: 'number' },
    components: {
      type: 'object',
      description: 'realized, unrealized, income, costs, financing, FX, total',
    },
    residual: { type: 'number' },
    byCurrency: { type: 'array', items: { type: 'object' } },
    groupings: { type: 'array', items: { type: 'object' } },
    assumptions: ASSUMPTIONS_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
  },
  required: [
    'baseCurrency',
    'from',
    'to',
    'netAssetValueChange',
    'externalFlows',
    'investmentReturn',
    'components',
    'residual',
    'byCurrency',
    'groupings',
    'assumptions',
    'diagnostics',
  ],
};

const portfolioExplainPnl = defineOperation({
  id: 'totalfinance.portfolio.explain_pnl',
  handleFields: ['ledger', 'from.market', 'to.market'],
  title: 'Explain portfolio P&L between two marks',
  description:
    'Explain the change in net asset value between two dated valuation marks: external flows, investment return, ' +
    'and the identity components (realized, unrealized, income, transaction costs, financing, foreign exchange) that ' +
    'reconcile to it with a published residual, by currency and by grouping. The result is portfolioPnl(...) verbatim.',
  inputSchema: PortfolioPnlInputSchema,
  outputSchema: PORTFOLIO_PNL_OUTPUT,
  costClass: 'small',
  run: (input) => {
    const { ledger } = readPortfolioLedgerSnapshot({ snapshot: input.ledger });
    const result = portfolioPnl({
      ledger,
      from: input.from as never,
      to: input.to as never,
      ...(input.instrumentClassification !== undefined
        ? { instrumentClassification: input.instrumentClassification }
        : {}),
    });
    return {
      summary: `NAV ${result.from.netAssetValue.toFixed(2)} → ${result.to.netAssetValue.toFixed(2)} ${result.baseCurrency} (${input.from.valuationDate} → ${input.to.valuationDate}): total P&L ${result.components.totalPnl.toFixed(2)}, external flows ${result.externalFlows.toFixed(2)}`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

// ── artifacts ─────────────────────────────────────────────────────────────────────────────────

const artifactRead = defineOperation({
  id: 'totalfinance.artifact.read',
  handleFields: ['artifact'],
  title: 'Read an analysis artifact',
  description:
    'Validate a Gate B analysis artifact (its envelope, its recomputed inputs hash, and its content-hash identity) and ' +
    'return its identity, type, producer, provenance warnings, table names, and a bounded preview of the stored result ' +
    '— the one read door for any artifact over the wire. Migrations are not registered over the wire; a stored ' +
    'older version is refused with the versions named.',
  inputSchema: schema.object({ artifact: AnalysisArtifactSchema }),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      artifactType: { type: 'string' },
      schemaVersion: { type: 'integer' },
      producedBy: { type: 'object' },
      conventionsVersion: { type: 'string' },
      inputs: { type: 'object' },
      createdFrom: { type: 'array', items: { type: 'string' } },
      tables: { type: 'array', items: { type: 'string' } },
      warnings: { type: 'array', items: { type: 'object' } },
      preview: {
        type: 'object',
        description: 'Top-level keys; scalars inline, containers by size',
      },
      migrationsApplied: { type: 'array', items: { type: 'object' } },
    },
    required: [
      'id',
      'artifactType',
      'schemaVersion',
      'producedBy',
      'conventionsVersion',
      'inputs',
      'createdFrom',
      'tables',
      'warnings',
      'preview',
      'migrationsApplied',
    ],
  },
  costClass: 'small',
  run: (input) => {
    const { artifact, migrationsApplied } = readAnalysisArtifact({ artifact: input.artifact });
    return {
      summary: `${artifact.artifactType} ${artifact.id} by ${artifact.producedBy.operation} (${Object.keys(artifact.result).length} result fields)`,
      structured: {
        id: artifact.id,
        artifactType: artifact.artifactType,
        schemaVersion: artifact.schemaVersion,
        producedBy: artifact.producedBy,
        conventionsVersion: artifact.conventionsVersion,
        inputs: artifact.inputs,
        createdFrom: artifact.createdFrom ?? [],
        tables: Object.keys(artifact.tables ?? {}),
        warnings: artifact.provenance?.warnings ?? [],
        preview: boundedPreview(artifact.result),
        migrationsApplied,
      },
    };
  },
});

const artifactCompare = defineOperation({
  id: 'totalfinance.artifact.compare',
  handleFields: ['baseline', 'candidate'],
  title: 'Compare two analysis artifacts',
  description:
    'Compare a baseline and a candidate artifact of the same type leaf by leaf: value differences with absolute and ' +
    'relative deltas, added and removed paths, whether inputs and producers match, and — when a tolerance is supplied — ' +
    'whether every numeric leaf is within it. The result is compareAnalysisArtifacts(...) verbatim.',
  inputSchema: schema.object({
    baseline: AnalysisArtifactSchema,
    candidate: AnalysisArtifactSchema,
    tolerance: schema
      .object({
        absolute: schema.number().nonnegative(),
        relative: schema.number().nonnegative(),
      })
      .optional()
      .describe('Two-sided: a leaf is within it when |Δ| ≤ absolute + relative·|baseline|'),
    limits: schema
      .object({
        maximumDifferences: schema.number().integer().positive().optional(),
        maximumLeaves: schema.number().integer().positive().optional(),
      })
      .optional(),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      artifactType: { type: 'string' },
      identical: { type: 'boolean' },
      artifactIds: { type: 'object' },
      inputs: { type: 'object' },
      producedBy: { type: 'object' },
      result: { type: 'object' },
      warningCounts: { type: 'object' },
      withinTolerance: { type: ['boolean', 'null'] },
      assumptions: ASSUMPTIONS_SCHEMA,
      diagnostics: DIAGNOSTICS_SCHEMA,
    },
    required: [
      'artifactType',
      'identical',
      'artifactIds',
      'inputs',
      'producedBy',
      'result',
      'warningCounts',
      'withinTolerance',
      'assumptions',
      'diagnostics',
    ],
  },
  costClass: 'medium',
  run: (input) => {
    const result = compareAnalysisArtifacts({
      baseline: readAnalysisArtifact({ artifact: input.baseline }).artifact,
      candidate: readAnalysisArtifact({ artifact: input.candidate }).artifact,
      ...(input.tolerance !== undefined ? { tolerance: input.tolerance } : {}),
      ...(input.limits !== undefined ? { limits: input.limits } : {}),
    });
    return {
      summary: result.identical
        ? `${result.artifactType}: identical`
        : `${result.artifactType}: ${result.result.differenceCount} differences over ${result.result.comparedLeafCount} leaves${result.withinTolerance === null ? '' : result.withinTolerance ? ' (within tolerance)' : ' (outside tolerance)'}`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

// ── portfolio.analyze (snapshot + timeline + monitor under one assumptions) ──────────────────

const TargetGroupSchema = schema
  .object({
    instrumentId: schema.string().optional(),
    sleeveId: schema.string().optional(),
    assetClass: schema.string().optional(),
    currency: schema.string().optional(),
    tag: schema.string().optional(),
    underlying: schema.string().optional(),
    strategy: schema.string().optional(),
  })
  .describe('Exactly one group key');

const AllocationTargetSchema = schema.object({
  group: TargetGroupSchema,
  weight: schema.number().optional(),
  riskBudget: schema.number().optional(),
  driftBand: schema.number().optional(),
});

const BenchmarkIdentitySchema = schema.object({
  benchmarkId: schema.string().nonempty(),
  asOf: epochMsOrDate.optional(),
  constituents: schema
    .array(schema.object({ instrumentId: schema.string(), weight: schema.number() }))
    .optional(),
});

const InvestmentPolicySchema = schema.object({
  targets: schema.array(AllocationTargetSchema).optional(),
  model: schema
    .record(schema.unknown())
    .optional()
    .describe(
      'A model portfolio envelope (totalfinance.model-portfolio), validated by the policy grammar',
    ),
  withinGroupAllocation: schema.enum(['proportional-to-current', 'equal'] as const).optional(),
  driftBand: schema.number().optional(),
  reviewCadenceDays: schema.number().optional(),
  maximumTurnover: schema.number().optional(),
  maximumEstimatedTransactionCost: schema.number().optional(),
  minimumCash: schema.number().optional(),
  minimumCashWeight: schema.number().optional(),
  limits: schema
    .object({
      maximumPositionWeight: schema.number().optional(),
      maximumGroupWeights: schema
        .array(schema.object({ group: TargetGroupSchema, maximumWeight: schema.number() }))
        .optional(),
      maximumGrossLeverage: schema.number().optional(),
      maximumDrawdown: schema.number().optional(),
      maximumDailyLoss: schema.number().optional(),
      maximumDaysToLiquidate: schema.number().optional(),
      minimumSettledCash: schema.number().optional(),
    })
    .optional(),
  allowedInstruments: schema.array(schema.string()).optional(),
  restrictedInstruments: schema.array(schema.string()).optional(),
  allowedAccounts: schema.array(schema.string()).optional(),
  benchmark: BenchmarkIdentitySchema.optional(),
  performanceObjective: schema.string().optional(),
  contributionHandling: schema.enum(['invest-to-targets', 'hold-as-cash'] as const).optional(),
  withdrawalHandling: schema.enum(['raise-from-overweights', 'pro-rata'] as const).optional(),
  incomeReinvestment: schema.enum(['reinvest', 'hold-as-cash'] as const).optional(),
  lotSelectionObjective: schema.string().optional(),
});

const nullableNumber = schema.union([schema.number(), schema.null()]);

const MonitorStateSchema = schema.object({
  schemaVersion: schema.number().integer(),
  asOf: schema.number(),
  netAssetValue: nullableNumber,
  peakNetAssetValue: nullableNumber,
  evaluationCount: schema.number().integer().nonnegative(),
  rules: schema.record(
    schema.object({
      active: schema.boolean(),
      consecutiveBreaches: schema.number().integer().nonnegative(),
      lastRaisedAtMs: nullableNumber,
      acknowledged: schema.boolean(),
      lastValue: nullableNumber,
    }),
  ),
});

const MonitorRuleSchema = schema.object({
  enabled: schema.boolean().optional(),
  threshold: schema.number().optional(),
  direction: schema.enum(['above', 'below'] as const).optional(),
  hysteresis: schema.object({ enter: schema.number(), exit: schema.number() }).optional(),
  debounceEvaluations: schema.number().integer().positive().optional().describe('Default 1'),
  cooldownMs: schema.number().nonnegative().optional().describe('Default 0'),
  severity: schema.enum(['informational', 'warning', 'critical'] as const).optional(),
});

const MonitorRequestSchema = schema
  .object({
    policy: InvestmentPolicySchema,
    previousState: schema
      .union([MonitorStateSchema, schema.null()])
      .describe(
        "The prior evaluation's state, or null for the first evaluation — required, exactly as monitorPortfolio requires it",
      ),
    rules: schema.record(MonitorRuleSchema).optional().describe('Per alert family'),
    acknowledgments: schema.array(schema.string()).optional(),
    averageDailyVolumes: schema.record(schema.number()).optional(),
    marketStalenessLimitMs: schema.number().optional(),
    unusualPnlThreshold: schema.number().optional(),
    residualTolerance: schema.number().optional(),
    optionExpirationWarningDays: schema.number().optional(),
    assignmentRiskMoneyness: schema.number().optional(),
  })
  .describe(
    'monitorPortfolio inputs beyond the shared portfolio / market / asOf / currencyConversions',
  );

const PortfolioAnalyzeInputSchema = schema.object({
  ledger: PortfolioLedgerEnvelopeSchema,
  asOf: epochMsOrDate.describe('The valuation and monitoring instant'),
  market: MarketSnapshotSchema,
  currencyConversions: schema.array(CurrencyPairQuoteSchema).optional(),
  instrumentClassification: InstrumentClassificationSchema.optional(),
  marks: schema
    .array(ValuationMarkSchema)
    .min(2)
    .optional()
    .describe(
      'At least two dated marks, strictly ascending — adds portfolioTimeline when supplied',
    ),
  monitor: MonitorRequestSchema.optional().describe('Adds monitorPortfolio when supplied'),
});

const portfolioAnalyze = defineOperation({
  id: 'totalfinance.portfolio.analyze',
  handleFields: ['ledger', 'market'],
  title: 'Analyze a portfolio (snapshot, timeline, monitor)',
  description:
    'One report of up to three direct results: the valuation snapshot at `asOf` (always), the dated timeline with ' +
    'P&L since each prior mark and drawdown (when `marks` are supplied), and the policy monitor with its alerts and ' +
    'carried state (when `monitor` is supplied). Each result is the direct function verbatim; nothing is aggregated ' +
    'across them, and one `assumptions` says which parts ran and why the others did not.',
  inputSchema: PortfolioAnalyzeInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      snapshot: { type: 'object', description: 'portfolioSnapshot(...) verbatim' },
      timeline: {
        type: ['object', 'null'],
        description: 'portfolioTimeline(...) verbatim, or null when no marks were supplied',
      },
      monitor: {
        type: ['object', 'null'],
        description: 'monitorPortfolio(...) verbatim, or null when no monitor request was supplied',
      },
      assumptions: ASSUMPTIONS_SCHEMA,
      diagnostics: DIAGNOSTICS_SCHEMA,
    },
    required: ['snapshot', 'timeline', 'monitor', 'assumptions', 'diagnostics'],
  },
  costClass: 'medium',
  run: (input) => {
    const { ledger } = readPortfolioLedgerSnapshot({ snapshot: input.ledger });
    const shared = {
      market: input.market as never,
      asOf: input.asOf,
      ...(input.currencyConversions !== undefined
        ? { currencyConversions: input.currencyConversions }
        : {}),
    };
    const classification =
      input.instrumentClassification !== undefined
        ? { instrumentClassification: input.instrumentClassification }
        : {};
    const snapshot = portfolioSnapshot({ portfolio: ledger.state, ...shared });
    const timeline =
      input.marks !== undefined
        ? portfolioTimeline({ ledger, valuationMarks: input.marks as never, ...classification })
        : null;
    const monitor =
      input.monitor !== undefined
        ? monitorPortfolio({
            portfolio: ledger.state,
            ...shared,
            ...classification,
            ...(input.monitor as never as Record<string, unknown>),
          } as never)
        : null;
    const warnings = [
      ...snapshot.diagnostics.warnings,
      ...(timeline?.diagnostics.warnings ?? []),
      ...(monitor?.diagnostics.warnings ?? []),
    ];
    return {
      summary: `NAV ${snapshot.netAssetValue.toFixed(2)} ${snapshot.baseCurrency}${timeline ? `; ${timeline.rows.length} marks` : ''}${monitor ? `; ${monitor.alerts.length} alerts` : ''}`,
      structured: {
        snapshot,
        timeline,
        monitor,
        assumptions: {
          ledger: {
            portfolioId: ledger.portfolioId ?? null,
            baseCurrency: ledger.baseCurrency,
            lotRelief: ledger.lotRelief,
            eventCount: ledger.state.eventCount,
          },
          asOf: snapshot.asOf,
          timeline: timeline
            ? `portfolioTimeline over ${input.marks!.length} marks`
            : 'omitted: no marks supplied',
          monitor: monitor
            ? 'monitorPortfolio under the supplied policy'
            : 'omitted: no monitor request supplied',
        },
        diagnostics: { warnings },
      },
    };
  },
});

// ── Stage 4.7 slice 2 (FC9 Decision 5): the rebalance proposal over the wire ──────────────────

const RebalanceProposalInputSchema = schema.object({
  ledger: PortfolioLedgerEnvelopeSchema,
  asOf: epochMsOrDate.describe('The valuation instant the proposal is sized at'),
  market: MarketSnapshotSchema,
  currencyConversions: schema.array(CurrencyPairQuoteSchema).optional(),
  policy: InvestmentPolicySchema.describe(
    'Targets come from the policy (inline targets or a model)',
  ),
  instrumentClassification: InstrumentClassificationSchema.optional(),
  scope: schema
    .enum(['to-target', 'drift-only'] as const)
    .describe(
      "'to-target' trades every target to weight; 'drift-only' trades only targets outside their band",
    ),
  externalFlow: schema
    .object({ amount: schema.number(), currency: schema.string().nonempty() })
    .optional()
    .describe('A contribution (positive) or withdrawal (negative) the proposal sizes around'),
  tradingAccountId: schema.string().optional(),
  averageDailyVolumes: schema.record(schema.number()).optional(),
  lotSizes: schema.record(schema.number()).optional(),
  defaultLotSize: schema.number().positive().optional(),
  minimumNotional: schema.number().nonnegative().optional(),
  transactionCosts: schema
    .object({
      commissionPerTrade: schema.number().nonnegative().optional(),
      commissionPerUnit: schema.number().nonnegative().optional(),
      spreadBasisPoints: schema.number().nonnegative().optional(),
      slippageBasisPoints: schema.number().nonnegative().optional(),
    })
    .optional(),
});

const portfolioRebalanceProposal = defineOperation({
  id: 'totalfinance.portfolio.rebalance_proposal',
  title: 'Propose a rebalance (a proposal, never an order)',
  description:
    'Fold the ledger snapshot to its state, mark it from the market snapshot, and propose the trades that take the ' +
    'portfolio to the policy targets (or only the drifted ones) under the policy limits, lot sizes, minimum notional, ' +
    'transaction-cost estimates, and an optional external flow. The result is proposePortfolioRebalance(...) verbatim: ' +
    'weights before and after, the cash summary, the trades with their estimates, the objective, and every target it ' +
    'could not resolve. Read-only by construction — it returns a proposal and places nothing. Opt-in (portfolioPack).',
  inputSchema: RebalanceProposalInputSchema,
  // B6: a proposal is the first step of a trade; proposing is a capability (held by default).
  requiredCapabilities: ['trade:propose'],
  outputSchema: {
    type: 'object',
    properties: {
      asOf: { type: 'number' },
      baseCurrency: { type: 'string' },
      netAssetValue: { type: 'number' },
      netAssetValueAfterFlow: { type: 'number' },
      weights: { type: 'object' },
      cash: { type: 'object' },
      trades: { type: 'array', items: { type: 'object' } },
      estimates: { type: 'object' },
      objective: { type: 'object' },
      unresolvedTargets: { type: 'array', items: { type: 'object' } },
      assumptions: ASSUMPTIONS_SCHEMA,
      diagnostics: DIAGNOSTICS_SCHEMA,
    },
    required: [
      'asOf',
      'baseCurrency',
      'netAssetValue',
      'netAssetValueAfterFlow',
      'weights',
      'cash',
      'trades',
      'estimates',
      'objective',
      'unresolvedTargets',
      'assumptions',
      'diagnostics',
    ],
  },
  costClass: 'medium',
  handleFields: ['ledger', 'market'],
  run: (input) => {
    const { ledger: envelope, ...rest } = input;
    const { ledger } = readPortfolioLedgerSnapshot({ snapshot: envelope });
    const result = proposePortfolioRebalance({
      portfolio: ledger.state,
      ...(rest as unknown as Record<string, unknown>),
    } as never);
    return {
      summary: `${result.trades.length} trade${result.trades.length === 1 ? '' : 's'} proposed on NAV ${result.netAssetValue.toFixed(2)} ${result.baseCurrency} (${input.scope})${result.unresolvedTargets.length > 0 ? `; ${result.unresolvedTargets.length} unresolved target${result.unresolvedTargets.length === 1 ? '' : 's'}` : ''}`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

// ── scenarios ─────────────────────────────────────────────────────────────────────────────────

const TargetTagsSchema = schema.array(schema.string()).optional();

const SpotTargetSchema = schema.object({
  kind: schema.literal('spot'),
  id: schema.string().nonempty(),
  symbol: schema.string().nonempty(),
  quantity: schema.number(),
  currency: schema.string(),
  strategy: schema.string().optional(),
  account: schema.string().optional(),
  book: schema.string().optional(),
  tags: TargetTagsSchema,
});

/** Greeks in the one unit system (the options package's): per unit of the target. */
const TaylorSensitivitiesSchema = schema.object({
  delta: schema.number().optional().describe('∂V/∂S per $1 of spot'),
  gamma: schema.number().optional().describe('∂²V/∂S² per $1²'),
  vega: schema
    .number()
    .optional()
    .describe('∂V/∂σ per 1 volatility POINT (0.01), as option.greeks reports it'),
  theta: schema.number().optional().describe('∂V/∂t per CALENDAR DAY, as option.greeks reports it'),
  rho: schema.number().optional().describe('∂V/∂r per 1% rate (0.01), as option.greeks reports it'),
  vanna: schema.number().optional().describe('∂Δ/∂σ per 1.00 σ per $'),
  vomma: schema.number().optional().describe('∂²V/∂σ² per 1.00 σ²'),
  charm: schema
    .number()
    .optional()
    .describe('∂Δ/∂T per year of time-to-expiry (options-package sign)'),
  veta: schema.number().optional().describe('∂vega/∂T per year, vega per 1.00 σ'),
  vera: schema.number().optional().describe('∂²V/∂σ∂r per 1.00 σ per 1.00 rate'),
  deltaRate: schema.number().optional().describe('∂Δ/∂r per $ per 1% rate'),
  thetaRate: schema.number().optional().describe('∂Θ/∂r per calendar day per 1% rate'),
  rhoConvexity: schema.number().optional().describe('∂²V/∂r² per (1%)²'),
  thetaConvexity: schema.number().optional().describe('∂²V/∂t² per calendar day²'),
  phi: schema.number().optional().describe('∂V/∂q per 1% dividend yield (dividend rho)'),
});

const TaylorFactorLevelSchema = schema.object({ subject: schema.string(), level: schema.number() });

const TaylorFactorsSchema = schema.object({
  spot: TaylorFactorLevelSchema.optional(),
  volatility: TaylorFactorLevelSchema.optional(),
  riskFreeRate: TaylorFactorLevelSchema.optional(),
  dividend: TaylorFactorLevelSchema.optional(),
  valuationInstant: schema.object({ level: schema.number() }).optional(),
});

const TaylorTargetSchema = schema.object({
  kind: schema.literal('taylor'),
  id: schema.string().nonempty(),
  quantity: schema.number(),
  contractMultiplier: schema.number(),
  currency: schema.string(),
  underlying: schema.string().optional(),
  strategy: schema.string().optional(),
  account: schema.string().optional(),
  book: schema.string().optional(),
  tags: TargetTagsSchema,
  baseValuePerUnit: schema.number(),
  greeks: TaylorSensitivitiesSchema,
  factors: TaylorFactorsSchema,
});

const TaylorBindingSchema = schema.object({
  id: schema.string().nonempty(),
  accountId: schema.string().nonempty(),
  instrumentId: schema.string().nonempty(),
  strategy: schema.string().optional(),
  book: schema.string().optional(),
  tags: TargetTagsSchema,
  baseValuePerUnit: schema.number(),
  greeks: TaylorSensitivitiesSchema,
  factors: TaylorFactorsSchema,
});

const PortfolioTargetSchema = schema.object({
  kind: schema.literal('portfolio'),
  portfolio: schema
    .union([PortfolioLedgerEnvelopeSchema, PortfolioStateSchema])
    .describe('The ledger envelope or PortfolioState whose open positions become targets'),
  bindings: schema
    .array(TaylorBindingSchema)
    .min(1)
    .describe(
      'Exactly one Taylor binding per open (accountId, instrumentId) position — the serializable binding kind',
    ),
});

const ScenarioRunInputSchema = schema.object({
  scenarioSet: ScenarioSetSchema,
  market: MarketSnapshotSchema,
  targets: schema
    .array(schema.union([SpotTargetSchema, TaylorTargetSchema, PortfolioTargetSchema]))
    .min(1)
    .describe(
      "Wire targets: kind 'spot' (scenarioTarget.spot), 'taylor' (scenarioTarget.taylor), or 'portfolio' (scenarioTargetsFromPortfolio with Taylor bindings). A custom pricer target is SDK-only.",
    ),
  reportingCurrency: schema.string().optional(),
  currencyConversions: schema.array(CurrencyPairQuoteSchema).optional(),
  options: schema
    .object({
      failureMode: schema.enum(['fail-fast', 'collect'] as const).optional(),
      seed: schema.number().integer().nonnegative().optional(),
      maximumValuationCells: schema.number().integer().positive().optional(),
      maximumWorkUnits: schema.number().integer().positive().optional(),
    })
    .optional()
    .describe('Execution options; market resolvers and factor handlers are SDK-only callbacks'),
});

const SCENARIO_RUN_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    layout: { type: 'object', description: 'scenario-major cell layout and the index formula' },
    scenarioAxis: { type: 'array', items: { type: 'object' } },
    targetAxis: { type: 'array', items: { type: 'object' } },
    base: { type: 'array', items: { type: 'object' } },
    cells: { type: 'array', items: { type: 'object' } },
    aggregates: { type: 'object' },
    assumptions: ASSUMPTIONS_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
  },
  required: [
    'layout',
    'scenarioAxis',
    'targetAxis',
    'base',
    'cells',
    'aggregates',
    'assumptions',
    'diagnostics',
  ],
};

const scenarioRun = defineOperation({
  id: 'totalfinance.scenario.run',
  handleFields: ['scenarioSet', 'market'],
  title: 'Run a scenario set against targets',
  description:
    'Revalue every target under every scenario of a Gate B scenario set against a Gate B market snapshot: a ' +
    'scenario-major cell grid with base values, per-cell P&L in local and reporting currency, and per-scenario ' +
    'aggregates. Targets are the serializable kinds — spot assets, Taylor (greeks) positions, and a portfolio bound ' +
    'through Taylor bindings. The result is runScenarios(...) verbatim.',
  inputSchema: ScenarioRunInputSchema,
  outputSchema: SCENARIO_RUN_OUTPUT,
  costClass: 'large',
  run: (input) => {
    const { scenarioSet } = readScenarioSet({ scenarioSet: input.scenarioSet });
    const { snapshot } = readMarketSnapshot({ snapshot: input.market });
    const targets = input.targets.flatMap((target) => {
      if (target.kind === 'spot') {
        const { kind: _kind, ...rest } = target;
        return [scenarioTarget.spot(rest)];
      }
      if (target.kind === 'taylor') {
        const { kind: _kind, ...rest } = target;
        return [scenarioTarget.taylor(rest)];
      }
      const { kind: _kind, portfolio, bindings } = target;
      return [
        ...scenarioTargetsFromPortfolio({
          state: portfolioStateOf(portfolio),
          bindings: bindings.map((binding) => scenarioPortfolioBinding.taylor(binding)),
        }),
      ];
    });
    const result = runScenarios({
      scenarioSet,
      market: snapshot,
      targets,
      ...(input.reportingCurrency !== undefined
        ? { reportingCurrency: input.reportingCurrency }
        : {}),
      ...(input.currencyConversions !== undefined
        ? { currencyConversions: input.currencyConversions }
        : {}),
      ...(input.options !== undefined ? { options: input.options } : {}),
    });
    return {
      summary: `${result.layout.scenarioCount} scenarios × ${result.layout.targetCount} targets = ${result.layout.cellCount} cells`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

// ── research ──────────────────────────────────────────────────────────────────────────────────

const FieldDefinitionSchema = schema.object({
  fieldName: schema.string().nonempty(),
  kind: schema.enum(['numeric', 'category', 'text', 'boolean'] as const),
  unit: schema.string().optional(),
  description: schema.string().optional(),
});

const ObservedValueSchema = schema.union([
  schema.number(),
  schema.string(),
  schema.boolean(),
  schema.null(),
]);

const UniverseObservationSchema = schema.object({
  instrumentId: schema.string().nonempty(),
  availableTimestampMs: schema.number(),
  fields: schema
    .record(ObservedValueSchema)
    .describe('Declared fields only; null is a stated missing value'),
});

const UniverseSchema = {
  universeId: schema.string().nonempty(),
  asOf: schema
    .number()
    .describe('Epoch ms; the latest observation at or before it is used per instrument'),
  observations: schema.array(UniverseObservationSchema),
  fieldDefinitions: schema.array(FieldDefinitionSchema).min(1),
};

const MissingValuePolicySchema = schema.enum(['exclude', 'evaluate-as-false'] as const);

const ScreenInputSchema = schema.object({
  ...UniverseSchema,
  filter: schema
    .record(schema.unknown())
    .optional()
    .describe(
      'A ScreenFilter tree — { all: [...] } | { any: [...] } | { not: ... } | { field, operator, value } | ' +
        "{ field, operator: 'between', from, to } | { field, operator: 'in' | 'notIn', values } | " +
        "{ field, operator: 'isPresent' | 'isMissing' } — validated node by node by screenUniverse; omitted = every eligible row passes",
    ),
  missingValuePolicy: MissingValuePolicySchema,
  orderBy: schema.array(
    schema.object({
      field: schema.string(),
      direction: schema.enum(['ascending', 'descending'] as const),
    }),
  ),
  limit: schema.number().integer().nonnegative().optional(),
});

const RESEARCH_ROWS_OUTPUT = (rowDescription: string): JSONSchema => ({
  type: 'object',
  properties: {
    assumptions: ASSUMPTIONS_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
    rows: { type: 'array', items: { type: 'object' }, description: rowDescription },
  },
  required: ['assumptions', 'diagnostics', 'rows'],
});

const researchScreen = defineOperation({
  id: 'totalfinance.research.screen',
  title: 'Screen a universe',
  description:
    'Filter a point-in-time universe of instrument observations with a declarative filter tree, order the survivors, ' +
    'and optionally limit them — a replayable screen by construction (no caller predicate crosses the wire). ' +
    'The result is screenUniverse(...) verbatim.',
  inputSchema: ScreenInputSchema,
  outputSchema: RESEARCH_ROWS_OUTPUT('{ instrumentId, availableTimestampMs, fields }'),
  costClass: 'medium',
  run: (input) => {
    const observations = capRows(
      input.observations,
      'observations',
      'totalfinance.research.screen',
    );
    const result = screenUniverse({ ...input, observations, filter: input.filter as never });
    return {
      summary: `${result.rows.length} of ${result.diagnostics.suppliedCount} instruments pass (${result.diagnostics.excludedCount} excluded)`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

const researchRank = defineOperation({
  id: 'totalfinance.research.rank',
  title: 'Rank a universe',
  description:
    'Rank a point-in-time universe by one declared numeric field with an explicit tie policy (competition, dense, ' +
    'ordinal) and missing-value policy. The result is rankUniverse(...) verbatim.',
  inputSchema: schema.object({
    ...UniverseSchema,
    rankBy: schema.object({
      field: schema.string(),
      direction: schema.enum(['ascending', 'descending'] as const),
    }),
    tiePolicy: schema.enum(['competition', 'dense', 'ordinal'] as const),
    missingValuePolicy: MissingValuePolicySchema,
  }),
  outputSchema: RESEARCH_ROWS_OUTPUT('{ instrumentId, value, rank }'),
  costClass: 'medium',
  run: (input) => {
    const observations = capRows(input.observations, 'observations', 'totalfinance.research.rank');
    const result = rankUniverse({ ...input, observations });
    return {
      summary: `${result.rows.length} instruments ranked by ${input.rankBy.field} ${input.rankBy.direction}`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

const researchScore = defineOperation({
  id: 'totalfinance.research.score',
  title: 'Score a universe',
  description:
    'Score a point-in-time universe as a weighted composite of standardized components (z-score or percentile rank, ' +
    'higher- or lower-is-better) with an explicit missing-value policy. The result is scoreUniverse(...) verbatim.',
  inputSchema: schema.object({
    ...UniverseSchema,
    components: schema
      .array(
        schema.object({
          field: schema.string(),
          weight: schema.number().positive(),
          direction: schema.enum(['higher-is-better', 'lower-is-better'] as const),
          standardization: schema.enum(['z-score', 'percentile-rank'] as const),
        }),
      )
      .min(1),
    missingValuePolicy: schema.enum(['exclude', 'renormalize-weights'] as const),
  }),
  outputSchema: RESEARCH_ROWS_OUTPUT('{ instrumentId, score, componentsUsed }'),
  costClass: 'medium',
  run: (input) => {
    const observations = capRows(input.observations, 'observations', 'totalfinance.research.score');
    const result = scoreUniverse({ ...input, observations });
    return {
      summary: `${result.rows.length} instruments scored over ${input.components.length} components`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

const TradingSessionWindowSchema = schema.object({
  startTradingSessionOffset: schema.number().integer(),
  endTradingSessionOffset: schema.number().integer(),
});

const EventStudyInputSchema = schema.object({
  events: schema.array(
    schema.object({
      eventId: schema.string().nonempty(),
      instrumentId: schema.string().nonempty(),
      eventType: schema.string(),
      announcedTimestampMs: schema.number(),
      effectiveTimestampMs: schema.number().optional(),
      metadata: schema.record(schema.unknown()).optional(),
    }),
  ),
  returnObservations: schema.array(
    schema.object({
      instrumentId: schema.string().nonempty(),
      tradingSessionDate: schema.string().date(),
      simpleReturn: schema.number(),
    }),
  ),
  marketReturns: schema
    .array(
      schema.object({ tradingSessionDate: schema.string().date(), simpleReturn: schema.number() }),
    )
    .optional()
    .describe("Required by the 'market-adjusted' and 'market' models"),
  eventWindow: TradingSessionWindowSchema,
  estimationWindow: TradingSessionWindowSchema.optional().describe(
    "Required by 'mean-adjusted' and 'market'; must end strictly before the event window starts",
  ),
  expectedReturnModel: schema
    .union([
      schema.object({ model: schema.literal('mean-adjusted') }),
      schema.object({ model: schema.literal('market-adjusted') }),
      schema.object({ model: schema.literal('market') }),
    ])
    .describe("The serializable models; a 'custom' expected-return function is SDK-only"),
  sessionPolicy: schema.enum(['announcement-session', 'next-session'] as const).optional(),
  overlappingEventPolicy: schema.enum(['reject', 'allow-contaminated'] as const),
  cumulativeConvention: schema.enum(['sum', 'compound'] as const).optional(),
});

const researchEventStudy = defineOperation({
  id: 'totalfinance.research.event_study',
  title: 'Run an event study',
  description:
    'Measure abnormal returns around dated events under a declared expected-return model (mean-adjusted, ' +
    'market-adjusted, or market model), with explicit session, overlap, and cumulation policies; per-event rows and ' +
    'cumulative abnormal returns, and the average abnormal return by offset with t-statistics. ' +
    'The result is eventStudy(...) verbatim.',
  inputSchema: EventStudyInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      assumptions: ASSUMPTIONS_SCHEMA,
      diagnostics: DIAGNOSTICS_SCHEMA,
      events: { type: 'array', items: { type: 'object' } },
      averageAbnormalReturns: { type: 'array', items: { type: 'object' } },
    },
    required: ['assumptions', 'diagnostics', 'events', 'averageAbnormalReturns'],
  },
  costClass: 'medium',
  run: (input) => {
    const id = 'totalfinance.research.event_study';
    const result = eventStudy({
      ...input,
      events: capRows(input.events, 'events', id),
      returnObservations: capRows(input.returnObservations, 'returnObservations', id),
      ...(input.marketReturns !== undefined
        ? { marketReturns: capRows(input.marketReturns, 'marketReturns', id) }
        : {}),
    });
    return {
      summary: `${result.diagnostics.eventsIncluded} of ${result.diagnostics.eventsSupplied} events studied under ${result.assumptions.expectedReturnModel}`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

// ── options backtest (opt-in backtest pack) ───────────────────────────────────────────────────

// B7: a chain row is the core `OptionQuote`; its Greeks ride `greeks` (vendor-supplied or from
// `options.chainGreeks`), never a bare `delta` beside the row.
const ChainQuoteSchema = OptionQuoteSchema;

const ChainSnapshotSchema = schema.object({
  asOf: epochMsOrDate,
  underlyingPrice: schema.number().positive(),
  quotes: schema.array(ChainQuoteSchema),
});

const CostModelSchema = schema
  .union([
    schema.object({ model: schema.literal('none') }),
    schema.object({ model: schema.literal('bps'), bps: schema.number().nonnegative() }),
    schema.object({
      model: schema.literal('perShare'),
      amountPerShare: schema.number().nonnegative(),
    }),
    schema.object({ model: schema.literal('fixed'), amount: schema.number().nonnegative() }),
  ])
  .describe('A declarative commission model (fees.none / bps / perShare / fixed)');

const SlippageModelSchema = schema
  .union([
    schema.object({ model: schema.literal('none') }),
    schema.object({ model: schema.literal('bps'), bps: schema.number().nonnegative() }),
    schema.object({ model: schema.literal('fixed'), perShare: schema.number().nonnegative() }),
    schema.object({ model: schema.literal('spread'), spread: schema.number().nonnegative() }),
  ])
  .describe('A declarative slippage model (slippage.none / bps / fixed / spread)');

type CostModelWire = ReturnType<typeof CostModelSchema.parse>;
type SlippageModelWire = ReturnType<typeof SlippageModelSchema.parse>;

function costModelOf(wire: CostModelWire) {
  switch (wire.model) {
    case 'none':
      return fees.none();
    case 'bps':
      return fees.bps(wire.bps);
    case 'perShare':
      return fees.perShare(wire.amountPerShare);
    case 'fixed':
      return fees.fixed(wire.amount);
  }
}

function slippageModelOf(wire: SlippageModelWire) {
  switch (wire.model) {
    case 'none':
      return slippage.none();
    case 'bps':
      return slippage.bps(wire.bps);
    case 'fixed':
      return slippage.fixed(wire.perShare);
    case 'spread':
      return slippage.spread(wire.spread);
  }
}

const EntryCommon = {
  id: schema.string().nonempty().optional().describe('Names the rule in trades and rows'),
  when: schema
    .enum(['flat', 'always'] as const)
    .optional()
    .describe(
      "'flat' (default) enters only when no position is open; a caller predicate is SDK-only",
    ),
  daysToExpiry: schema.object({
    target: schema.number(),
    min: schema.number().optional(),
    max: schema.number().optional(),
  }),
  sizing: schema
    .union([
      schema.object({ quantity: schema.number().positive() }),
      schema.object({ maxMarginFraction: schema.number().positive() }),
    ])
    .optional()
    .describe('Default { quantity: 1 }'),
  price: schema.enum(['bid', 'ask', 'mid', 'last', 'mark'] as const).optional(),
};

const EntryRuleSchema = schema
  .union([
    schema.object({
      ...EntryCommon,
      structure: schema.literal('ironCondor'),
      select: schema.object({ shortDelta: schema.number(), wingWidth: schema.number() }),
    }),
    schema.object({
      ...EntryCommon,
      structure: schema.enum([
        'bullCallSpread',
        'bearCallSpread',
        'bullPutSpread',
        'bearPutSpread',
      ] as const),
      select: schema.object({ shortDelta: schema.number(), width: schema.number() }),
    }),
    schema.object({
      ...EntryCommon,
      structure: schema.literal('strangle'),
      select: schema.object({ shortDelta: schema.number() }),
    }),
    schema.object({
      ...EntryCommon,
      structure: schema.literal('straddle'),
      select: schema.object({ strike: schema.number().optional() }).optional(),
    }),
    schema.object({
      ...EntryCommon,
      structure: schema.literal('coveredCall'),
      select: schema.object({
        shortDelta: schema.number(),
        stockPrice: schema.number().optional(),
      }),
    }),
    schema.object({
      ...EntryCommon,
      structure: schema.literal('protectivePut'),
      select: schema.object({
        shortDelta: schema.number(),
        stockPrice: schema.number().optional(),
      }),
    }),
    schema.object({
      ...EntryCommon,
      structure: schema.enum([
        'calendarCallSpread',
        'calendarPutSpread',
        'diagonalCallSpread',
        'diagonalPutSpread',
        'doubleDiagonal',
      ] as const),
      select: schema.object({
        shortDelta: schema.number(),
        nearDaysToExpiry: schema.object({
          target: schema.number(),
          min: schema.number().optional(),
          max: schema.number().optional(),
        }),
        farDaysToExpiry: schema.object({
          target: schema.number(),
          min: schema.number().optional(),
          max: schema.number().optional(),
        }),
        width: schema.number().positive().optional(),
      }),
    }),
  ])
  .describe('The declarative entry structures; a `build` callback is SDK-only');

const ExitTriggersSchema = schema.object({
  profitTarget: schema.number().optional().describe('Fraction of entry premium, e.g. 0.5'),
  stopLoss: schema.number().optional().describe('Multiple of entry premium, e.g. 2'),
  daysToExpiry: schema.number().optional().describe('Close at or below this DTE'),
});

const OptionsBacktestInputSchema = schema.object({
  chains: schema
    .array(ChainSnapshotSchema)
    .describe('Chain snapshots (any order; the engine sorts)'),
  marking: schema
    .object({
      volatility: schema.enum(['current-quote', 'entry'] as const).optional(),
      missingMark: schema
        .enum(['refuse', 'entry-volatility', 'carry-last-volatility'] as const)
        .optional(),
      maximumQuoteAgeMs: schema.number().nonnegative().optional(),
    })
    .optional()
    .describe('Default: re-mark from the current quote; refuse a missing mark'),
  initialCapital: schema.number().positive().optional().describe('Default 100,000'),
  riskFreeRate: schema
    .number()
    .describe(
      'Continuously-compounded risk-free rate (decimal, e.g. 0.045) pricing every mark — REQUIRED; the engine never assumes a rate',
    ),
  dividendYield: schema.number().optional().describe('Default 0'),
  entry: EntryRuleSchema.optional().describe('One rule; exactly one of entry and rules'),
  rules: schema
    .array(EntryRuleSchema)
    .min(1)
    .optional()
    .describe('Several rules, each a member of the book; exactly one of entry and rules'),
  exit: ExitTriggersSchema.describe('A `when` predicate is SDK-only'),
  roll: schema.object({ when: ExitTriggersSchema.optional() }).optional(),
  hedge: schema
    .object({
      deltaBand: schema.number().positive(),
      commission: CostModelSchema.optional(),
      slippage: SlippageModelSchema.optional(),
    })
    .optional(),
  commission: CostModelSchema.optional(),
  slippage: SlippageModelSchema.optional(),
  assignment: schema.enum(['model', 'none'] as const).optional(),
  periodsPerYear: schema.number().positive().optional().describe('Default 252'),
  book: schema
    .object({
      maximumOpenPositions: schema.number().integer().positive().optional(),
      maximumPerUnderlying: schema.number().integer().positive().optional(),
    })
    .optional()
    .describe('Default: one open trade'),
  limits: schema
    .object({
      maximumMarginFraction: schema.number().positive().optional(),
      maximumNetDelta: schema.number().nonnegative().optional(),
      maximumNetVega: schema.number().nonnegative().optional(),
      maximumConcentration: schema.number().positive().optional(),
      scenarioLoss: schema
        .object({
          spotShocks: schema.array(schema.number()).min(1),
          volatilityShocks: schema.array(schema.number()).min(1),
          maximumLossFraction: schema.number().positive(),
        })
        .optional(),
    })
    .optional()
    .describe('Pre-trade limits on the post-trade book; a breach is a limitRejections row'),
  fillPolicy: schema
    .object({
      mode: schema.enum(['combo', 'legged'] as const).optional(),
      partialFill: schema.enum(['reject', 'allow'] as const).optional(),
      price: schema.enum(['bid', 'ask', 'mid', 'last', 'mark'] as const).optional(),
    })
    .optional(),
  quoteFreshness: schema.object({ maximumQuoteAgeMs: schema.number().nonnegative() }).optional(),
  corporateActions: schema
    .array(
      schema.object({
        symbol: schema.string().nonempty(),
        effectiveDate: schema.string().date(),
        type: schema.enum([
          'split',
          'reverseSplit',
          'dividend',
          'symbolChange',
          'merger',
          'spinoff',
          'other',
        ] as const),
        ratio: schema.number().positive().optional(),
        cash: schema.number().optional(),
        newSymbol: schema.string().optional(),
        details: schema.record(schema.unknown()).optional(),
      }),
    )
    .optional(),
  dividends: schema
    .array(
      schema.object({
        underlying: schema.string().nonempty(),
        exDate: schema.string().date(),
        amount: schema.number().positive(),
      }),
    )
    .optional(),
  baseCurrency: schema.string().nonempty().optional().describe("Default 'USD'"),
});

const backtestOptionsRun = defineOperation({
  id: 'totalfinance.backtest.options_run',
  title: 'Run an options backtest',
  description:
    'Backtest a declarative options strategy over chain snapshots: structure selection by delta and DTE, exit and roll ' +
    'triggers, optional delta hedging, declarative commission and slippage, American assignment modelling, and the ' +
    'marking policy (current-quote or entry volatility; what a missing mark does). Several rules may hold several trades ' +
    'at once (book), pre-trade limits reject entries with rows, combo or legged fills, quote freshness, split lineage, ' +
    'dividend evidence, the surface summary, and the portfolio ledger the equity reconciles to. Equity points, trades ' +
    'with per-leg attribution and mark counts, settlements, and the standard performance summary. The result is ' +
    'optionsBacktest(...) verbatim. Opt-in (backtestPack): payloads and runtime are heavier than the default set.',
  inputSchema: OptionsBacktestInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      points: { type: 'array', items: { type: 'object' } },
      returns: { type: 'array', items: { type: 'number' } },
      trades: { type: 'array', items: { type: 'object' } },
      settlements: { type: 'array', items: { type: 'object' } },
      finalValue: { type: 'number' },
      performance: { type: 'object', description: 'The standard performance summary' },
      limitRejections: { type: 'array', items: { type: 'object' } },
      fillRejections: { type: 'array', items: { type: 'object' } },
      surface: { type: 'array', items: { type: 'object' } },
      ledger: { type: 'object', description: 'The portfolio ledger snapshot (events)' },
      timeline: {
        type: ['object', 'null'],
        description: 'The ledger timeline (null under two marks)',
      },
      runId: { type: 'string' },
      assumptions: ASSUMPTIONS_SCHEMA,
      diagnostics: DIAGNOSTICS_SCHEMA,
    },
    required: [
      'points',
      'returns',
      'trades',
      'settlements',
      'finalValue',
      'performance',
      'limitRejections',
      'fillRejections',
      'surface',
      'ledger',
      'timeline',
      'runId',
      'assumptions',
      'diagnostics',
    ],
  },
  costClass: 'job',
  run: (input) => {
    const id = 'totalfinance.backtest.options_run';
    const { chains, commission, slippage: slip, hedge, ...rest } = input;
    const result = optionsBacktest({
      ...rest,
      chains: capRows(chains, 'chains', id),
      ...(commission !== undefined ? { commission: costModelOf(commission) } : {}),
      ...(slip !== undefined ? { slippage: slippageModelOf(slip) } : {}),
      ...(hedge !== undefined
        ? {
            hedge: {
              deltaBand: hedge.deltaBand,
              ...(hedge.commission !== undefined
                ? { commission: costModelOf(hedge.commission) }
                : {}),
              ...(hedge.slippage !== undefined
                ? { slippage: slippageModelOf(hedge.slippage) }
                : {}),
            },
          }
        : {}),
    } as never);
    return {
      summary: `${result.trades.length} trades, final value ${result.finalValue.toFixed(2)} (${result.assumptions.marking.volatility} marking)`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

// ── packs ─────────────────────────────────────────────────────────────────────────────────────

export function portfolioPack(): OperationPack {
  return {
    name: 'portfolio',
    operations: [
      portfolioSnapshotOperation,
      portfolioExplainPnl,
      portfolioAnalyze,
      portfolioRebalanceProposal,
    ],
  };
}
export function scenarioPack(): OperationPack {
  return { name: 'scenario', operations: [scenarioRun] };
}
export function researchPack(): OperationPack {
  return {
    name: 'research',
    operations: [researchScreen, researchRank, researchScore, researchEventStudy],
  };
}
export function artifactPack(): OperationPack {
  return { name: 'artifact', operations: [artifactRead, artifactCompare] };
}
// ── Stage 4.6 slice 3 (FC8 Decision 11): the cross-sectional backtest over the wire ─────────────

const ReturnObservationSchema = schema.object({
  instrumentId: schema.string().nonempty(),
  tradingSessionDate: schema.string().date(),
  simpleReturn: schema.number(),
});

const UniverseMemberSchema = schema.object({
  instrumentId: schema.string().nonempty(),
  fromTimestampMs: schema.number(),
  toTimestampMs: schema.number().optional(),
  exitReason: schema.enum(['removed', 'delisted', 'merged', 'other'] as const).optional(),
  delistingReturn: schema.number().optional(),
});

const ScoreComponentSchema = schema.object({
  field: schema.string(),
  weight: schema.number().positive(),
  direction: schema.enum(['higher-is-better', 'lower-is-better'] as const),
  standardization: schema.enum(['z-score', 'percentile-rank'] as const),
});

const FactorRecipeSchema = schema
  .object({
    recipeName: schema.string().nonempty(),
    recipeVersion: schema.number().integer().positive(),
    disclosure: schema.string(),
    direction: schema.enum(['higher-is-better', 'lower-is-better'] as const),
    features: schema
      .array(
        schema.object({
          field: schema.string().nonempty(),
          transform: schema.enum(['raw', 'winsorize-then-z-score', 'percentile-rank'] as const),
          weight: schema.number(),
        }),
      )
      .min(1),
    lagTradingSessions: schema.number().integer().nonnegative(),
    neutralization: schema.enum(['none', 'sector', 'sector-and-size'] as const),
    missingValuePolicy: schema.enum(['exclude', 'renormalize-weights'] as const),
  })
  .describe(
    'A versioned research FactorRecipe (canonical or caller-authored), validated by the engine',
  );

const CrossSectionalSignalSchema = schema
  .union([
    schema.object({ factorRecipe: FactorRecipeSchema }),
    schema.object({
      score: schema.object({
        components: schema.array(ScoreComponentSchema).min(1),
        missingValuePolicy: schema.enum(['exclude', 'renormalize-weights'] as const),
      }),
    }),
    schema.object({
      screen: schema.object({
        filter: schema.record(schema.unknown()).optional(),
        orderBy: schema
          .array(
            schema.object({
              field: schema.string(),
              direction: schema.enum(['ascending', 'descending'] as const),
            }),
          )
          .min(1),
        missingValuePolicy: MissingValuePolicySchema,
      }),
    }),
  ])
  .describe('The three declarative signal forms; a signal callback is SDK-only');

const SideSelectionSchema = schema.union([
  schema.object({ topQuantile: schema.number().positive() }),
  schema.object({ count: schema.number().integer().positive() }),
  schema.object({ fraction: schema.number().positive() }),
]);
const ShortSideSelectionSchema = schema.union([
  schema.object({ bottomQuantile: schema.number().positive() }),
  schema.object({ count: schema.number().integer().positive() }),
  schema.object({ fraction: schema.number().positive() }),
]);

const PortfolioConstructionSchema = schema.object({
  method: schema
    .enum(['equal-weight', 'score-weight', 'inverse-volatility', 'risk-budget'] as const)
    .describe("'supplied-weights' takes a caller function and is SDK-only"),
  long: SideSelectionSchema,
  short: ShortSideSelectionSchema.optional(),
  neutrality: schema.enum(['none', 'dollar', 'sector', 'beta', 'factor'] as const).optional(),
  neutralizeAgainst: schema.object({ field: schema.string().nonempty() }).optional(),
  maximumPositions: schema.number().integer().positive().optional(),
  maximumPositionWeight: schema.number().positive().optional(),
  minimumPositionWeight: schema.number().nonnegative().optional(),
  maximumTurnover: schema.number().nonnegative().optional(),
  maximumParticipation: schema.number().positive().optional(),
  volatilityLookbackSessions: schema.number().integer().positive().optional(),
});

const DeclaredExecutionSchema = schema
  .object({
    label: schema.string().nonempty(),
    ambiguity: schema
      .enum(['optimistic', 'pessimistic', 'deterministic-path', 'reject'] as const)
      .optional(),
    costs: schema
      .object({
        commission: CostModelSchema.optional(),
        slippage: SlippageModelSchema.optional(),
        spread: schema
          .union([
            schema.object({ model: schema.literal('none') }),
            schema.object({
              model: schema.literal('halfSpreadBps'),
              bps: schema.number().nonnegative(),
            }),
          ])
          .optional(),
        marketImpact: schema
          .union([
            schema.object({ model: schema.literal('none') }),
            schema.object({
              model: schema.literal('squareRoot'),
              coefficient: schema.number().nonnegative(),
            }),
          ])
          .optional(),
        latencySessions: schema.number().integer().nonnegative().optional(),
        participation: schema.number().positive().optional(),
      })
      .optional(),
    partialFills: schema.enum(['allow', 'reject'] as const).optional(),
    timeInForce: schema
      .object({
        default: schema.enum(['day', 'gtc'] as const),
        expireAtSessionClose: schema.boolean(),
      })
      .optional(),
    margin: schema
      .object({
        buyingPowerMultiplier: schema.number().positive(),
        initialMarginRate: schema.number().nonnegative(),
        maintenanceMarginRate: schema.number().nonnegative(),
        forcedLiquidation: schema.enum(['none', 'close-largest-loss', 'pro-rata'] as const),
      })
      .optional(),
  })
  .describe(
    "A declared execution policy over session bars (execution.declared): the label is the caller's claim; " +
      'a caller fill model, session rules, and quote/order-book observations are SDK-only',
  );

type DeclaredExecutionWire = ReturnType<typeof DeclaredExecutionSchema.parse>;

function executionPolicyOf(wire: DeclaredExecutionWire) {
  const costs = wire.costs;
  return execution.declared({
    label: wire.label,
    ...(wire.ambiguity !== undefined ? { ambiguity: wire.ambiguity } : {}),
    ...(costs !== undefined
      ? {
          costs: {
            ...(costs.commission !== undefined
              ? { commission: costModelOf(costs.commission) }
              : {}),
            ...(costs.slippage !== undefined ? { slippage: slippageModelOf(costs.slippage) } : {}),
            ...(costs.spread !== undefined
              ? {
                  spread:
                    costs.spread.model === 'none'
                      ? spreadModels.none()
                      : spreadModels.halfSpreadBps(costs.spread.bps),
                }
              : {}),
            ...(costs.marketImpact !== undefined
              ? {
                  marketImpact:
                    costs.marketImpact.model === 'none'
                      ? impactModels.none()
                      : impactModels.squareRoot({ coefficient: costs.marketImpact.coefficient }),
                }
              : {}),
            ...(costs.latencySessions !== undefined
              ? { latency: latencyModels.sessions(costs.latencySessions) }
              : {}),
            ...(costs.participation !== undefined ? { participation: costs.participation } : {}),
          },
        }
      : {}),
    ...(wire.partialFills !== undefined ? { partialFills: wire.partialFills } : {}),
    ...(wire.timeInForce !== undefined ? { timeInForce: wire.timeInForce } : {}),
    ...(wire.margin !== undefined ? { margin: wire.margin } : {}),
  });
}

const CrossSectionalRunInputSchema = schema.object({
  dataset: schema.object({
    observations: schema.array(UniverseObservationSchema),
    fieldDefinitions: schema.array(FieldDefinitionSchema).min(1),
    returns: schema
      .array(ReturnObservationSchema)
      .describe('Per instrument per session; prices are return-index levels (base 100)'),
    benchmarkReturns: schema.array(ReturnObservationSchema).optional(),
    groups: schema.record(schema.string()).optional(),
    sizeField: schema.string().optional(),
    classification: schema.record(schema.record(schema.unknown())).optional(),
    averageDailyVolumes: schema.record(schema.number()).optional(),
    betas: schema.record(schema.number()).optional(),
  }),
  universeHistory: schema.object({
    universeId: schema.string().nonempty(),
    members: schema.array(UniverseMemberSchema).min(1),
  }),
  signal: CrossSectionalSignalSchema,
  rebalanceSchedule: schema.object({
    frequency: schema.enum(['daily', 'weekly', 'monthly', 'quarterly'] as const),
    session: schema.enum(['open', 'close'] as const),
    bufferBand: schema.number().nonnegative().optional(),
  }),
  portfolioConstruction: PortfolioConstructionSchema,
  execution: DeclaredExecutionSchema.optional().describe('Default: execution.simplified()'),
  transactionCostModel: schema
    .object({ commission: CostModelSchema.optional(), slippage: SlippageModelSchema.optional() })
    .optional(),
  initialCapital: schema.number().positive().optional().describe('Default 1,000,000'),
  baseCurrency: schema.string().nonempty().optional().describe("Default 'USD'"),
  window: schema
    .object({
      fromTimestampMs: schema.number().optional(),
      toTimestampMs: schema.number().optional(),
    })
    .optional(),
  periodsPerYear: schema.number().positive().optional().describe('Default 252'),
  riskFreeRate: schema.number().optional().describe('Per-period; default 0'),
  seed: schema
    .number()
    .integer()
    .nonnegative()
    .optional()
    .describe('Seeds only the bootstrap confidence intervals; absent = none'),
});

const backtestCrossSectionalRun = defineOperation({
  id: 'totalfinance.backtest.cross_sectional_run',
  title: 'Run a cross-sectional backtest',
  description:
    'Backtest a point-in-time cross-sectional strategy: a returns dataset with declared features, a universe history ' +
    'with entries and exits, one declarative signal (a versioned factor recipe, a composite score, or a screen), a ' +
    'rebalance schedule, and a portfolio construction (quantile/count/fraction selection on each side; equal, score, ' +
    'inverse-volatility, or risk-budget weights; dollar/sector/beta/factor neutrality; position, weight, turnover, and ' +
    'participation caps — every trim a reported goal). Fills go through the execution policy into the portfolio ' +
    'ledger; the final value reconciles to the ledger NAV. Rebalances, holdings, fills, the ledger, the timeline, ' +
    'attribution, the benchmark block, and the performance summary — crossSectionalBacktest(...) verbatim. Opt-in ' +
    '(backtestPack): payloads and runtime are heavier than the default set; bulk row sets above the row cap travel by handle.',
  inputSchema: CrossSectionalRunInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      rebalances: { type: 'array', items: { type: 'object' } },
      holdings: { type: 'array', items: { type: 'object' } },
      points: { type: 'array', items: { type: 'object' } },
      returns: { type: 'array', items: { type: 'number' } },
      trades: { type: 'array', items: { type: 'object' } },
      fills: { type: 'array', items: { type: 'object' } },
      ledger: { type: 'object', description: 'The portfolio ledger snapshot (events)' },
      timeline: { type: 'object', description: 'The ledger timeline' },
      attribution: { type: 'object' },
      benchmark: { type: ['object', 'null'] },
      performance: { type: 'object', description: 'The standard performance summary' },
      performanceConfidence: { type: ['object', 'null'] },
      finalValue: { type: 'number' },
      runId: { type: 'string' },
      assumptions: ASSUMPTIONS_SCHEMA,
      diagnostics: DIAGNOSTICS_SCHEMA,
    },
    required: [
      'rebalances',
      'holdings',
      'points',
      'returns',
      'trades',
      'fills',
      'ledger',
      'timeline',
      'attribution',
      'benchmark',
      'performance',
      'performanceConfidence',
      'finalValue',
      'runId',
      'assumptions',
      'diagnostics',
    ],
  },
  costClass: 'job',
  handleFields: ['dataset'],
  run: (input) => {
    const id = 'totalfinance.backtest.cross_sectional_run';
    const {
      dataset,
      universeHistory,
      execution: executionWire,
      transactionCostModel,
      ...rest
    } = input;
    const result = crossSectionalBacktest({
      ...rest,
      dataset: {
        ...dataset,
        observations: capRows(dataset.observations, 'dataset.observations', id),
        returns: capRows(dataset.returns, 'dataset.returns', id),
        ...(dataset.benchmarkReturns !== undefined
          ? {
              benchmarkReturns: capRows(dataset.benchmarkReturns, 'dataset.benchmarkReturns', id),
            }
          : {}),
      },
      universeHistory: {
        ...universeHistory,
        members: capRows(universeHistory.members, 'universeHistory.members', id),
      },
      ...(executionWire !== undefined ? { execution: executionPolicyOf(executionWire) } : {}),
      ...(transactionCostModel !== undefined
        ? {
            transactionCostModel: {
              ...(transactionCostModel.commission !== undefined
                ? { commission: costModelOf(transactionCostModel.commission) }
                : {}),
              ...(transactionCostModel.slippage !== undefined
                ? { slippage: slippageModelOf(transactionCostModel.slippage) }
                : {}),
            },
          }
        : {}),
    } as never);
    return {
      summary: `${result.diagnostics.rebalanceCount} rebalances over ${result.diagnostics.sessionCount} sessions, final value ${result.finalValue.toFixed(2)} (${result.assumptions.execution.realism} execution)`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

// ── Stage 4.6 slice 6 (FC8 Decision 11): the portfolio backtest over the wire ──────────────────

const BarSchema = schema.object({
  symbol: schema.string().nonempty(),
  timestampMs: schema.number(),
  open: schema.number(),
  high: schema.number(),
  low: schema.number(),
  close: schema.number(),
  volume: schema.number().optional(),
  vwap: schema.number().optional(),
  adjusted: schema.boolean().optional(),
});

const QuoteSchema = schema.object({
  symbol: schema.string().nonempty(),
  timestampMs: schema.number(),
  bid: schema.number(),
  ask: schema.number(),
  bidSize: schema.number().optional(),
  askSize: schema.number().optional(),
  exchange: schema.string().optional(),
  conditions: schema.array(schema.string()).optional(),
});

const TradeRowSchema = schema.object({
  symbol: schema.string().nonempty(),
  timestampMs: schema.number(),
  price: schema.number(),
  size: schema.number(),
  exchange: schema.string().optional(),
  conditions: schema.array(schema.string()).optional(),
  sequence: schema.number().optional(),
});

const OrderBookSchema = schema.object({
  symbol: schema.string().nonempty(),
  timestampMs: schema.number(),
  bids: schema.array(
    schema.object({
      price: schema.number(),
      size: schema.number(),
      exchange: schema.string().optional(),
    }),
  ),
  asks: schema.array(
    schema.object({
      price: schema.number(),
      size: schema.number(),
      exchange: schema.string().optional(),
    }),
  ),
});

const ContractTermsSchema = schema.union([
  schema.object({
    kind: schema.literal('option'),
    underlyingInstrumentId: schema.string().nonempty(),
    right: schema.enum(['call', 'put'] as const),
    strikePricePerUnit: schema.number().positive(),
    expiryTimestampMs: schema.number(),
  }),
  schema.object({
    kind: schema.literal('future'),
    underlyingInstrumentId: schema.string().nonempty(),
    expiryTimestampMs: schema.number(),
  }),
  schema.object({
    kind: schema.literal('perpetual'),
    underlyingInstrumentId: schema.string().nonempty(),
  }),
]);

const InstrumentSpecificationSchema = schema
  .object({
    kind: schema
      .enum([
        'equity',
        'etf',
        'option',
        'future',
        'fx-forward',
        'crypto-spot',
        'crypto-perpetual',
        'bond',
      ] as const)
      .describe("A built-in kind; 'custom' brings its own adapter and is SDK-only"),
    currency: schema.string().nonempty(),
    contractMultiplier: schema.number().positive().optional(),
    contract: ContractTermsSchema.optional(),
    assetClass: schema
      .enum([
        'equity',
        'etf',
        'option',
        'future',
        'fx-forward',
        'crypto-spot',
        'crypto-perpetual',
        'bond',
        'cash',
      ] as const)
      .optional(),
    classification: schema
      .object({
        underlying: schema.string().optional(),
        assetClass: schema.string().optional(),
        strategy: schema.string().optional(),
        tags: schema.array(schema.string()).optional(),
      })
      .optional(),
    roll: schema
      .object({
        toInstrumentId: schema.string().nonempty(),
        sessionsBeforeExpiry: schema.number().integer().nonnegative(),
      })
      .optional(),
    coupon: schema
      .object({
        annualRate: schema.number(),
        paymentsPerYear: schema.number().integer().positive(),
        faceValuePerUnit: schema.number().positive().optional(),
        dayCount: schema.enum(['ACT/365F', '30/360'] as const).optional(),
        issueDate: schema.string().date(),
        maturityDate: schema.string().date(),
      })
      .optional(),
    forward: schema
      .object({
        maturityTimestampMs: schema.number(),
        baseCurrency: schema.string().nonempty(),
        quoteCurrency: schema.string().nonempty(),
        contractRate: schema.number().positive(),
      })
      .optional(),
  })
  .describe('An instrument specification; the terms each kind needs are validated by the engine');

const PortfolioAccountingSchema = schema.object({
  baseCurrency: schema.string().nonempty(),
  initialCash: schema
    .array(
      schema.object({ currency: schema.string().nonempty(), amount: schema.number().positive() }),
    )
    .min(1),
  lotRelief: schema.enum(['fifo', 'lifo', 'highest-cost', 'specific-lot'] as const).optional(),
  settlement: schema.record(schema.enum(['T+0', 'T+1', 'T+2'] as const)).optional(),
});
const PortfolioMarketDataSchema = schema.object({
  bars: schema.array(BarSchema).optional(),
  quotes: schema.array(QuoteSchema).optional(),
  trades: schema.array(TradeRowSchema).optional(),
  orderBooks: schema.array(OrderBookSchema).optional(),
  optionChains: schema.array(ChainSnapshotSchema).optional(),
  fxRates: schema
    .array(
      schema.object({
        timestampMs: schema.number(),
        baseCurrency: schema.string().nonempty(),
        quoteCurrency: schema.string().nonempty(),
        quotePerBase: schema.number().positive(),
      }),
    )
    .optional(),
  forwardRates: schema
    .array(
      schema.object({
        instrumentId: schema.string().nonempty(),
        timestampMs: schema.number(),
        forwardRate: schema.number().positive(),
      }),
    )
    .optional(),
  fundingRates: schema
    .array(
      schema.object({
        instrumentId: schema.string().nonempty(),
        timestampMs: schema.number(),
        fundingRate: schema.number(),
      }),
    )
    .optional(),
  corporateActions: schema
    .array(
      schema.object({
        symbol: schema.string().nonempty(),
        effectiveDate: schema.string().date(),
        type: schema.enum([
          'split',
          'reverseSplit',
          'dividend',
          'symbolChange',
          'merger',
          'spinoff',
          'other',
        ] as const),
        ratio: schema.number().positive().optional(),
        cash: schema.number().optional(),
        newSymbol: schema.string().optional(),
        details: schema.record(schema.unknown()).optional(),
      }),
    )
    .optional(),
  dividends: schema
    .array(
      schema.object({
        instrumentId: schema.string().nonempty(),
        exDate: schema.string().date(),
        amount: schema.number().positive(),
        payDate: schema.string().date().optional(),
      }),
    )
    .optional(),
  coupons: schema
    .array(
      schema.object({
        instrumentId: schema.string().nonempty(),
        paymentDate: schema.string().date(),
        amountPerUnit: schema.number().positive(),
      }),
    )
    .optional(),
});
const ExternalFlowsSchema = schema
  .array(
    schema.object({
      timestampMs: schema.number(),
      amount: schema.number(),
      currency: schema.string().nonempty(),
    }),
  )
  .optional();
const PortfolioCalendarSchema = schema.enum(['NYSE', 'CBOE', 'ALWAYS_OPEN'] as const).optional();
const BacktestWindowSchema = schema
  .object({
    fromTimestampMs: schema.number().optional(),
    toTimestampMs: schema.number().optional(),
  })
  .optional();

const PortfolioRunInputSchema = schema.object({
  accounting: PortfolioAccountingSchema,
  instruments: schema.record(InstrumentSpecificationSchema),
  marketData: PortfolioMarketDataSchema,
  strategy: schema
    .object({
      model: schema.union([
        schema.record(schema.unknown()).describe('A ModelPortfolio artifact'),
        schema.array(AllocationTargetSchema).min(1),
      ]),
      schedule: schema.object({
        frequency: schema.enum(['daily', 'weekly', 'monthly', 'quarterly'] as const),
      }),
      policy: schema
        .record(schema.unknown())
        .optional()
        .describe('An InvestmentPolicy (limits, handling); targets come from the model'),
      scope: schema.enum(['to-target', 'drift-only'] as const).optional(),
    })
    .describe('The declarative strategy; an onSession callback is SDK-only'),
  execution: DeclaredExecutionSchema.optional().describe('Default: execution.simplified()'),
  externalFlows: ExternalFlowsSchema,
  calendar: PortfolioCalendarSchema,
  window: BacktestWindowSchema,
  periodsPerYear: schema.number().positive().optional().describe('Default 252'),
  seed: schema.number().integer().nonnegative().optional(),
});

const backtestPortfolioRun = defineOperation({
  id: 'totalfinance.backtest.portfolio_run',
  title: 'Run a portfolio backtest',
  description:
    'Backtest a multi-asset portfolio through the ledger: instruments with built-in adapters (equity, etf, option, ' +
    'future, fx-forward, crypto-spot, crypto-perpetual, bond), market data by row set, a model or inline targets on a ' +
    'rebalance schedule, an execution policy with settlement lags, external flows, a calendar, and the margin check with ' +
    'forced liquidation. Every fill, flow, lifecycle fact, and liquidation is a portfolio event; the equity is the ' +
    "ledger's net asset value. The result is portfolioBacktest(...) verbatim. Opt-in (backtestPack): payloads and " +
    'runtime are heavier than the default set; bulk row sets above the row cap travel by handle.',
  inputSchema: PortfolioRunInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      ledger: { type: 'object' },
      timeline: { type: ['object', 'null'] },
      pnl: { type: ['object', 'null'] },
      orders: { type: 'array', items: { type: 'object' } },
      fills: { type: 'array', items: { type: 'object' } },
      rejections: { type: 'array', items: { type: 'object' } },
      liquidations: { type: 'array', items: { type: 'object' } },
      events: { type: 'array', items: { type: 'object' } },
      valuationMarks: { type: 'array', items: { type: 'object' } },
      points: { type: 'array', items: { type: 'object' } },
      returns: { type: 'array', items: { type: 'number' } },
      performance: { type: 'object', description: 'The standard performance summary' },
      finalValue: { type: 'number' },
      runId: { type: 'string' },
      assumptions: ASSUMPTIONS_SCHEMA,
      diagnostics: DIAGNOSTICS_SCHEMA,
    },
    required: [
      'ledger',
      'timeline',
      'pnl',
      'orders',
      'fills',
      'rejections',
      'liquidations',
      'events',
      'valuationMarks',
      'points',
      'returns',
      'performance',
      'finalValue',
      'runId',
      'assumptions',
      'diagnostics',
    ],
  },
  costClass: 'job',
  handleFields: ['marketData'],
  run: (input) => {
    const id = 'totalfinance.backtest.portfolio_run';
    const { marketData, execution: executionWire, ...rest } = input;
    const capped = Object.fromEntries(
      Object.entries(marketData)
        .filter(([, rows]) => rows !== undefined)
        .map(([key, rows]) => [key, capRows(rows as unknown[], `marketData.${key}`, id)]),
    );
    const result = portfolioBacktest({
      ...rest,
      marketData: capped,
      ...(executionWire !== undefined ? { execution: executionPolicyOf(executionWire) } : {}),
    } as never);
    return {
      summary: `${result.diagnostics.sessionCount} sessions, ${result.fills.length} fills, final value ${result.finalValue.toFixed(2)} (${result.assumptions.execution.realism} execution)`,
      structured: result as unknown as Record<string, unknown>,
    };
  },
});

// ── Stage 7B.1 slice 5 (AT4 Decision 10): the trading-agent environment over the wire ────────────

const EnvironmentLimitsSchema = schema.object({
  maximumPositionWeight: schema.number().positive().max(1).optional(),
  maximumGrossLeverage: schema.number().positive().optional(),
  maximumDrawdown: schema.number().positive().max(1).optional(),
  maximumDailyLoss: schema.number().positive().max(1).optional(),
  maximumDaysToLiquidate: schema.number().positive().optional(),
  minimumSettledCash: schema.number().optional(),
  allowUndefinedRiskOptions: schema.boolean().optional(),
  maximumPositionNotional: schema.number().positive().optional(),
  onBreach: schema.enum(['terminate', 'reject-and-continue'] as const).optional(),
});

const RewardCompositionSchema = schema
  .object({
    pnl: schema.number().optional(),
    drawdown: schema.number().optional(),
    turnover: schema.number().optional(),
    cost: schema.number().optional(),
    concentration: schema.number().optional(),
    leverage: schema.number().optional(),
    riskViolation: schema.number().optional(),
    benchmark: schema
      .object({ weight: schema.number(), instrumentId: schema.string().nonempty() })
      .optional(),
  })
  .describe('The declared reward composition; a goal callback is SDK-only');

const FeatureRecipesSchema = schema.object({
  lookbackReturns: schema.array(schema.number().integer().positive()).min(1).optional(),
  realizedVolatility: schema
    .object({
      lookbacks: schema.array(schema.number().integer().positive()).min(1),
      annualization: schema
        .number()
        .positive()
        .describe(
          'Bars per year scaling the per-bar σ (252 daily, 52 weekly, 12 monthly; 1 = per-bar). Required: the environment never assumes the bar frequency.',
        ),
    })
    .optional(),
  drawdown: schema.boolean().optional(),
});

/** The environment definition over the wire: the portfolio request without a strategy, plus the episode blocks. */
const EnvironmentDefinitionSchema = schema.object({
  accounting: PortfolioAccountingSchema,
  instruments: schema.record(InstrumentSpecificationSchema),
  marketData: PortfolioMarketDataSchema,
  execution: DeclaredExecutionSchema.optional().describe('Default: execution.simplified()'),
  externalFlows: ExternalFlowsSchema,
  calendar: PortfolioCalendarSchema,
  window: BacktestWindowSchema,
  periodsPerYear: schema.number().positive().optional().describe('Default 252'),
  seed: schema.number().integer().nonnegative().optional(),
  maximumSteps: schema.number().integer().positive().optional(),
  limits: EnvironmentLimitsSchema.optional(),
  reward: RewardCompositionSchema.optional(),
  features: FeatureRecipesSchema.optional(),
});

const BaselineSchema = schema.union([
  schema.object({ baseline: schema.literal('holdCash') }),
  schema.object({
    baseline: schema.literal('buyAndHold'),
    weights: schema.record(schema.number().nonnegative()).optional(),
  }),
  schema.object({
    baseline: schema.literal('periodicRebalance'),
    everySessions: schema.number().integer().positive(),
    weights: schema.record(schema.number().nonnegative()).optional(),
  }),
  schema.object({
    baseline: schema.literal('randomValidAction'),
    seed: schema.number().integer().nonnegative(),
  }),
  schema.object({
    baseline: schema.literal('riskParity'),
    lookback: schema.number().integer().positive(),
    everySessions: schema.number().integer().positive().optional(),
  }),
  schema.object({
    baseline: schema.literal('momentumCrossover'),
    fast: schema.number().integer().positive(),
    slow: schema.number().integer().positive(),
  }),
]);

const EnvironmentEpisodeInputSchema = schema.object({
  episode: schema
    .union([
      schema.enum(ENVIRONMENT_EPISODE_IDS),
      schema.object({ id: schema.string().nonempty(), definition: EnvironmentDefinitionSchema }),
    ])
    .describe('A catalogue id, or a named declarative definition'),
  policy: BaselineSchema.describe('A maintained baseline; a TypeScript policy is SDK-only'),
  seed: schema.number().integer().nonnegative().optional().describe('Default 42'),
  artifact: schema
    .enum(['none', 'embed'] as const)
    .optional()
    .describe(
      "Default 'none'; 'embed' returns the recorded episode as an `environment` run artifact",
    ),
});

type BaselineWire = ReturnType<typeof BaselineSchema.parse>;

function baselineOf(wire: BaselineWire) {
  switch (wire.baseline) {
    case 'holdCash':
      return agentBaselines.holdCash();
    case 'buyAndHold':
      return agentBaselines.buyAndHold(
        wire.weights !== undefined ? { weights: wire.weights } : undefined,
      );
    case 'periodicRebalance':
      return agentBaselines.periodicRebalance({
        everySessions: wire.everySessions,
        ...(wire.weights !== undefined ? { weights: wire.weights } : {}),
      });
    case 'randomValidAction':
      return agentBaselines.randomValidAction(wire.seed);
    case 'riskParity':
      return agentBaselines.riskParity({
        lookback: wire.lookback,
        ...(wire.everySessions !== undefined ? { everySessions: wire.everySessions } : {}),
      });
    case 'momentumCrossover':
      return agentBaselines.momentumCrossover({ fast: wire.fast, slow: wire.slow });
  }
}

const backtestEnvironmentEpisode = defineOperation({
  id: 'totalfinance.backtest.environment_episode',
  title: 'Bench a baseline policy over one trading-environment episode',
  description:
    'Run one of the six maintained baseline policies through the deterministic trading environment over a ' +
    "catalogue episode (or a named declarative definition) at a seed, and return Agent Bench's report for that " +
    'episode: operational conformance (look-ahead, replay equality, duplicate orders under the retry drive, ' +
    'external-order attempts, reconciliation; the mask and limit counts) apart from strategy quality (return, ' +
    'volatility, Sharpe, Sortino, drawdown, turnover, cost, exposure, violations) — no single score by design. ' +
    "With artifact: 'embed', the recorded episode travels as an `environment` run artifact that replays to its run " +
    'hash. Declarative inputs only: a TypeScript policy or a reward goal callback is SDK-only. Opt-in (backtestPack).',
  inputSchema: EnvironmentEpisodeInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      policy: { type: 'string' },
      episode: {
        type: 'object',
        description: 'The bench report for the one episode: operational and strategy blocks',
      },
      trace: {
        type: 'object',
        description:
          'The recorded episode: runId, engineRunId, traceHash, steps, rewardTotal, terminated, truncated, reason',
      },
      artifact: {
        type: ['object', 'null'],
        description: "The `environment` run artifact when artifact is 'embed'",
      },
      assumptions: ASSUMPTIONS_SCHEMA,
      diagnostics: DIAGNOSTICS_SCHEMA,
    },
    required: ['policy', 'episode', 'trace', 'artifact', 'assumptions', 'diagnostics'],
  },
  costClass: 'job',
  handleFields: ['episode.definition.marketData'],
  run: (input) => {
    const id = 'totalfinance.backtest.environment_episode';
    const policy = baselineOf(input.policy);
    const seed = input.seed ?? 42;
    const episode =
      typeof input.episode === 'string'
        ? input.episode
        : (() => {
            const { execution: executionWire, marketData, ...rest } = input.episode.definition;
            const capped = Object.fromEntries(
              Object.entries(marketData)
                .filter(([, rows]) => rows !== undefined)
                .map(([key, rows]) => [
                  key,
                  capRows(rows as unknown[], `episode.definition.marketData.${key}`, id),
                ]),
            );
            return {
              id: input.episode.id,
              definition: {
                ...rest,
                marketData: capped,
                ...(executionWire !== undefined
                  ? { execution: executionPolicyOf(executionWire) }
                  : {}),
              } as never,
            };
          })();
    const report = runAgentBench({ policy, episodes: [episode], seeds: [seed] });
    const row = report.episodes[0]!;
    const trace = report.traces[0]!;
    const artifact =
      input.artifact === 'embed'
        ? backtestRunArtifact({ kind: 'environment', run: trace.episode, input: trace.input })
        : null;
    return {
      summary: `${row.id}@${seed} under ${report.policy}: operational ${row.operational.passes ? 'passes' : 'FAILS'} (look-ahead ${row.operational.lookAhead}, duplicates ${row.operational.duplicateOrders}), final value ${row.strategy.finalValue.toFixed(2)} over ${row.strategy.steps} steps`,
      structured: {
        policy: report.policy,
        episode: row,
        trace: {
          runId: trace.episode.runId,
          engineRunId: trace.episode.engineRunId,
          traceHash: trace.episode.traceHash,
          steps: trace.episode.steps,
          rewardTotal: trace.episode.rewardTotal,
          terminated: trace.episode.terminated,
          truncated: trace.episode.truncated,
          reason: trace.episode.reason,
        },
        artifact,
        assumptions: report.assumptions,
        diagnostics: report.diagnostics,
      } as unknown as Record<string, unknown>,
    };
  },
});

/** The journey operations that join the opt-in backtest pack (`backtestPack()`). */
export function backtestJourneyOperations(): TotalFinanceOperation[] {
  return [
    backtestOptionsRun,
    backtestCrossSectionalRun,
    backtestPortfolioRun,
    backtestEnvironmentEpisode,
  ];
}

// ── Stage 4.7 slice 2 (FC9 Decision 5): company valuation over the wire ───────────────────────

const FundamentalPeriodSchema = schema.object({
  periodStartDate: schema.string().date().optional(),
  periodEndDate: schema.string().date(),
  fiscalYear: schema.number().integer(),
  fiscalQuarter: schema
    .union([schema.literal(1), schema.literal(2), schema.literal(3), schema.literal(4)])
    .optional(),
  periodType: schema.enum(['quarter', 'year', 'trailing-twelve-months'] as const),
  filedTimestampMs: schema.number().optional(),
  availableTimestampMs: schema.number(),
  currency: schema.string().nonempty(),
  monetaryScale: schema.union([
    schema.literal(1),
    schema.literal(1_000),
    schema.literal(1_000_000),
  ]),
  form: schema.string().optional(),
});

const IncomeStatementSchema = schema.object({
  period: FundamentalPeriodSchema,
  revenue: schema.number(),
  costOfRevenue: schema.number().optional(),
  grossProfit: schema.number().optional(),
  operatingExpenses: schema.number().optional(),
  operatingIncome: schema.number(),
  interestExpense: schema.number().optional(),
  incomeTaxExpense: schema.number().optional(),
  netIncome: schema.number(),
  incomeFromContinuingOperations: schema.number().optional(),
  sellingGeneralAdministrativeExpense: schema.number().optional(),
  dilutedSharesOutstanding: schema.number().optional(),
  metadata: schema.record(schema.unknown()).optional(),
});

const BalanceSheetSchema = schema.object({
  period: FundamentalPeriodSchema,
  cashAndCashEquivalents: schema.number(),
  shortTermInvestments: schema.number().optional(),
  accountsReceivable: schema.number().optional(),
  inventory: schema.number().optional(),
  currentAssets: schema.number().optional(),
  propertyPlantEquipmentNet: schema.number().optional(),
  otherAssets: schema.number().optional(),
  totalAssets: schema.number(),
  currentLiabilities: schema.number().optional(),
  accountsPayable: schema.number().optional(),
  shortTermDebt: schema.number().optional(),
  longTermDebt: schema.number().optional(),
  otherLiabilities: schema.number().optional(),
  totalDebt: schema.number().optional(),
  totalLiabilities: schema.number(),
  preferredEquity: schema.number().optional(),
  minorityInterest: schema.number().optional(),
  totalEquity: schema.number(),
  metadata: schema.record(schema.unknown()).optional(),
});

const CashFlowStatementSchema = schema.object({
  period: FundamentalPeriodSchema,
  operatingCashFlow: schema.number(),
  investingCashFlow: schema.number(),
  financingCashFlow: schema.number(),
  capitalExpenditure: schema.number().optional(),
  depreciationAndAmortization: schema.number().optional(),
  stockBasedCompensation: schema.number().optional(),
  acquisitions: schema.number().optional(),
  dividendsPaid: schema.number().optional(),
  shareRepurchases: schema.number().optional(),
  increaseInNetWorkingCapital: schema.number().optional(),
  netChangeInCash: schema.number().optional(),
  metadata: schema.record(schema.unknown()).optional(),
});

const FinancialStatementsSchema = schema
  .object({
    income: IncomeStatementSchema,
    balance: BalanceSheetSchema,
    cashFlow: CashFlowStatementSchema,
  })
  .describe(
    'The typed historical base (one period of the three statements) the projection rolls forward',
  );

const AmountDriverSchema = schema.union([
  schema.object({ amount: schema.number() }),
  schema.object({ fractionOfRevenue: schema.number() }),
]);

const StatementProjectionPeriodSchema = schema.object({
  periodLabel: schema.string().nonempty(),
  revenue: schema.union([
    schema.object({ amount: schema.number() }),
    schema.object({ growthRate: schema.number() }),
  ]),
  operatingMargin: schema.number(),
  taxRate: schema.number(),
  interestExpense: schema.number(),
  depreciationAndAmortization: AmountDriverSchema,
  capitalExpenditure: AmountDriverSchema,
  accountsReceivable: AmountDriverSchema,
  inventory: AmountDriverSchema,
  accountsPayable: AmountDriverSchema,
  netBorrowing: schema.number(),
  dividendsPaid: schema.number(),
});

const InterestCompoundingSchema = schema.union([
  schema.enum(['simple', 'continuous', 'annual', 'semiannual', 'quarterly', 'monthly'] as const),
  schema.object({
    type: schema.literal('periodic'),
    periodsPerYear: schema.number().integer().positive(),
  }),
]);

const TerminalValueMethodSchema = schema.union([
  schema.object({
    method: schema.literal('perpetual-growth'),
    terminalCashFlow: schema.number(),
    perpetualGrowthRate: schema.number(),
  }),
  schema.object({
    method: schema.literal('exit-multiple'),
    terminalMetricAmount: schema.number(),
    exitMultiple: schema.number(),
  }),
]);

const ValuationConventionsSchema = schema
  .object({
    valuationBasis: schema.enum(['firm', 'equity'] as const),
    valuationDate: schema.string().date(),
    currency: schema.string().nonempty(),
    annualDiscountRate: schema
      .number()
      .describe('REQUIRED and explicit — a discount rate is a goal, never a default (FC0)'),
    compounding: InterestCompoundingSchema,
    dayCount: schema.enum(['ACT/365F', 'ACT/360', '30/360'] as const).optional(),
    terminalValueMethod: TerminalValueMethodSchema,
    enterpriseToEquityBridge: schema
      .object({
        cashAndCashEquivalents: schema.number(),
        totalDebt: schema.number(),
        preferredEquity: schema.number(),
        minorityInterest: schema.number(),
        nonOperatingAssets: schema.number(),
      })
      .optional(),
    dilutedSharesOutstanding: schema.number().positive().optional(),
    provenance: schema
      .object({
        forecastIdentity: schema.string().optional(),
        statementIdentity: schema.string().optional(),
        restatementIdentity: schema.string().optional(),
        source: schema.string().optional(),
      })
      .optional(),
  })
  .describe("discountedCashFlow's conventions, minus the projected flows the projection supplies");

const SensitivityAxisSchema = schema.object({
  variable: schema.enum([
    'annual-discount-rate',
    'perpetual-growth-rate',
    'exit-multiple',
  ] as const),
  values: schema.array(schema.number()).min(1),
});

const ValuationCompanyInputSchema = schema.object({
  projection: schema.object({
    baseStatements: FinancialStatementsSchema,
    periods: schema.array(StatementProjectionPeriodSchema).min(1),
  }),
  valuation: ValuationConventionsSchema,
  sensitivity: schema
    .object({ rowAxis: SensitivityAxisSchema, columnAxis: SensitivityAxisSchema })
    .optional()
    .describe('Adds discountedCashFlowSensitivityTable over the same flows when supplied'),
});

const valuationCompany = defineOperation({
  id: 'totalfinance.valuation.company',
  title: 'Value a company from its statements',
  description:
    'Project the three statements from explicit drivers, take the free cash flows the valuation basis ' +
    'needs, and discount them under the stated conventions (basis, date, currency, the REQUIRED discount rate, ' +
    'compounding, day count, the terminal value method, the enterprise-to-equity bridge). The result is ' +
    'discountedCashFlowFromStatements(...) verbatim — the projection with its balance-sheet reconciliation, the ' +
    'cash flows used, and the valuation — plus discountedCashFlowSensitivityTable(...) over the same flows when a ' +
    'sensitivity request is supplied. Opt-in (valuationPack).',
  inputSchema: ValuationCompanyInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      projection: { type: 'object', description: 'projectFinancialStatements(...) verbatim' },
      cashFlowsUsed: { type: 'string', enum: ['freeCashFlowToFirm', 'freeCashFlowToEquity'] },
      valuation: { type: 'object', description: 'discountedCashFlow(...) verbatim' },
      sensitivity: {
        type: ['object', 'null'],
        description: 'discountedCashFlowSensitivityTable(...) verbatim, or null when not requested',
      },
      assumptions: ASSUMPTIONS_SCHEMA,
      diagnostics: DIAGNOSTICS_SCHEMA,
    },
    required: [
      'projection',
      'cashFlowsUsed',
      'valuation',
      'sensitivity',
      'assumptions',
      'diagnostics',
    ],
  },
  costClass: 'medium',
  run: (input) => {
    const { sensitivity, ...request } = input;
    const result = discountedCashFlowFromStatements(request as never);
    // The sensitivity table discounts the SAME flows the composition used — rebuilt exactly as the
    // acceptance law rebuilds them (period index + 1 years, the basis's free cash flow).
    const table =
      sensitivity !== undefined
        ? discountedCashFlowSensitivityTable({
            discountedCashFlowInput: {
              ...(request.valuation as never as Record<string, unknown>),
              projectedCashFlows: result.projection.statements.map((period, index) => ({
                timeYears: index + 1,
                amount:
                  result.cashFlowsUsed === 'freeCashFlowToFirm'
                    ? period.freeCashFlowToFirm
                    : period.freeCashFlowToEquity,
              })),
            } as never,
            rowAxis: sensitivity.rowAxis,
            columnAxis: sensitivity.columnAxis,
          })
        : null;
    const value = result.valuation;
    const headline =
      'enterpriseValue' in value
        ? `enterprise value ${value.enterpriseValue.toFixed(2)}`
        : `equity value ${value.equityValue.toFixed(2)}`;
    return {
      summary: `${result.cashFlowsUsed} over ${result.assumptions.projectedPeriodCount} periods: ${headline} ${request.valuation.currency}${table ? `; ${table.rowValues.length}×${table.columnValues.length} sensitivity table` : ''}`,
      structured: {
        projection: result.projection,
        cashFlowsUsed: result.cashFlowsUsed,
        valuation: result.valuation,
        sensitivity: table,
        assumptions: {
          ...result.assumptions,
          sensitivity: table ? table.assumptions : 'omitted: no sensitivity request supplied',
        },
        diagnostics: {
          warnings: [...result.diagnostics.warnings, ...(table?.diagnostics.warnings ?? [])],
        },
      },
    };
  },
});

/** The company-valuation journey pack — opt-in beside the ten domain packs and the other journey packs. */
export function valuationPack(): OperationPack {
  return { name: 'valuation', operations: [valuationCompany] };
}

/**
 * The five journey packs — opt-in beside the ten domain packs (Decision 9 counts them apart from
 * the twenty-three defaults; Stage 4.7 slice 2 added the valuation pack): `createOperationRegistry({ packs: [...defaultPacks(), ...journeyPacks()] })`.
 */
export function journeyPacks(): OperationPack[] {
  return [portfolioPack(), scenarioPack(), researchPack(), artifactPack(), valuationPack()];
}

/** Every journey operation across the four journey packs, flattened. */
export function journeyOperations(): TotalFinanceOperation[] {
  return journeyPacks().flatMap((pack) => pack.operations);
}
