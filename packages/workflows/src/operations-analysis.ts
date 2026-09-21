/**
 * Analysis tool expansion (dx-completion §WS-5): performance, portfolio optimization, vol
 * surface/metrics/event, options flow, strategy discovery, and calendar sessions — plus the
 * opt-in backtest pack. Same non-negotiables as `tools.ts`: every tool wraps the library's own
 * explain/pro API so `structured` IS (or carries) the `Computed` envelope, numeric fields state
 * their unit conventions, inputs are row-capped, and nothing does I/O.
 */

import {
  ErrorCode,
  InputError,
  type OptionTrade,
  type QuantWarning,
  WarningCode,
  isoDateToEpochMs,
  resolveValuationAsOf,
  resolvedExpiry,
  warning,
} from '@totalfinance/core';
import { type JSONSchema, schema } from '@totalfinance/core/schema';
import { futuresBasis, perpetualFunding } from '@totalfinance/crypto';
import { bonds, yieldMetrics, yieldToMaturity } from '@totalfinance/fixed-income';
import { fees } from '@totalfinance/backtest';
import * as backtest from '@totalfinance/backtest';
import { CBOE, NYSE, crypto24x7, expirations, nextExpiry } from '@totalfinance/calendars';
import { analyze } from '@totalfinance/performance';
import {
  type OptimizeConstraints,
  type OptimizeResult,
  hrp,
  kelly,
  maxSharpe,
  meanVariance,
  minVariance,
  riskParity,
} from '@totalfinance/risk';
import { listStrategies } from '@totalfinance/strategy';
import { flow } from '@totalfinance/structure';
import {
  eventVolatilityDecomposition,
  impliedVolatilityStatistics,
  varianceRiskPremium,
  volatilitySurface,
} from '@totalfinance/volatility';
import { capRows } from './operation-kit.js';
import { ValuationInstantSchema } from './wire-schemas.js';
import { backtestJourneyOperations } from './operations-journey.js';
import { defineOperation, type OperationPack, type TotalFinanceOperation } from './operation.js';

const ENVELOPE_OUTPUT: JSONSchema = {
  type: 'object',
  properties: {
    value: { description: 'The computed result' },
    assumptions: { type: 'object', description: 'Every applied convention, echoed' },
    diagnostics: {
      type: 'object',
      description: 'Engine/method/warnings (+ convergence where iterative)',
    },
  },
  required: ['value', 'assumptions', 'diagnostics'],
};

// ── performance ────────────────────────────────────────────────────────────────────────────────

const PerformanceAnalyzeInputSchema = schema.object({
  returns: schema
    .array(schema.number())
    .optional()
    .describe('Per-period returns as decimals (0.01 = +1%) — supply returns OR equity'),
  equity: schema
    .array(schema.number().positive())
    .optional()
    .describe('Equity curve (growth of capital, price levels) — supply returns OR equity'),
  periodsPerYear: schema
    .number()
    .positive()
    .optional()
    .describe('Annualization factor (default 252 daily; 12 monthly, 52 weekly)'),
  riskFreeRate: schema
    .number()
    .optional()
    .describe('Annualized risk-free rate (decimal, default 0)'),
  benchmark: schema
    .array(schema.number())
    .optional()
    .describe(
      'Aligned per-period benchmark returns (decimals); adds beta/alpha/informationRatio/Treynor',
    ),
});

export const performanceAnalyze = defineOperation({
  id: 'totalfinance.performance.analyze',
  title: 'Full performance summary',
  description:
    'Summarize a return series or equity curve: total/annualized return, volatility, Sharpe, ' +
    'Sortino, Calmar, max drawdown, omega, hit rate, profit factor, expectancy — plus ' +
    'beta/alpha/tracking error/information ratio/Treynor when a `benchmark` is supplied. ' +
    'Suspicious inputs (prices passed as returns, returns passed as equity) are flagged in ' +
    'diagnostics.warnings, never silently reported.',
  inputSchema: PerformanceAnalyzeInputSchema,
  outputSchema: ENVELOPE_OUTPUT,
  run: (input) => {
    if ((input.returns === undefined) === (input.equity === undefined)) {
      throw new InputError(
        'performance.analyze: supply exactly one of `returns` (decimals) or `equity` (price levels).',
        { code: ErrorCode.InputMissingField, context: {} },
      );
    }
    const TOOL = 'totalfinance.performance.analyze';
    const series =
      input.returns !== undefined
        ? { returns: capRows(input.returns, 'returns', TOOL) }
        : { equity: capRows(input.equity!, 'equity', TOOL) };
    const options = {
      ...(input.periodsPerYear !== undefined ? { periodsPerYear: input.periodsPerYear } : {}),
      ...(input.riskFreeRate !== undefined ? { riskFreeRate: input.riskFreeRate } : {}),
      ...(input.benchmark !== undefined
        ? { benchmark: capRows(input.benchmark, 'benchmark', TOOL) }
        : {}),
    };
    const r = analyze.explain(series, options);
    const v = r.value;
    return {
      summary:
        `${v.periods} periods: annualizedReturn=${
          v.annualizedReturn === null ? 'overflowed' : `${(v.annualizedReturn * 100).toFixed(2)}%`
        }, ` +
        `sharpe=${v.sharpe === null ? 'undefined' : v.sharpe.toFixed(2)}, maxDD=${(
          v.maxDrawdown * 100
        ).toFixed(2)}%` +
        (r.diagnostics.warnings.length > 0 ? ` (${r.diagnostics.warnings.length} warning(s))` : ''),
      structured: { value: v, assumptions: r.assumptions, diagnostics: r.diagnostics },
    };
  },
});

// ── risk: portfolio optimization ───────────────────────────────────────────────────────────────

const RiskOptimizeInputSchema = schema.object({
  objective: schema
    .enum(['minVariance', 'maxSharpe', 'meanVariance', 'riskParity', 'hrp', 'kelly'] as const)
    .describe('Which portfolio to solve for'),
  covariance: schema
    .array(schema.array(schema.number()))
    .describe('Asset covariance matrix (per-period, decimal² units), square'),
  mean: schema
    .array(schema.number())
    .optional()
    .describe('Per-asset expected returns (decimals) — required for maxSharpe/meanVariance/kelly'),
  riskFreeRatePerPeriod: schema
    .number()
    .optional()
    .describe(
      'PER-PERIOD risk-free rate (decimal; maxSharpe only) — the same period as the covariance ' +
        'matrix, NOT annualized. Renamed from `riskFreeRate` because every other risk-free rate ' +
        'in the library is annual, and the two were silently interchangeable here',
    ),
  riskAversion: schema.number().positive().optional().describe('λ for meanVariance (default 1)'),
  fraction: schema
    .number()
    .positive()
    .optional()
    .describe('Kelly fraction (default 1 = full Kelly)'),
  longOnly: schema.boolean().optional().describe('Forbid short positions'),
  budget: schema.number().optional().describe('Σw target (default 1 = fully invested)'),
});

const NEEDS_MEAN = new Set(['maxSharpe', 'meanVariance', 'kelly']);

export const riskOptimize = defineOperation({
  id: 'totalfinance.risk.optimize',
  title: 'Portfolio optimization',
  description:
    'Solve a portfolio: minVariance, maxSharpe (tangency), meanVariance utility, riskParity ' +
    '(equal risk contribution), hrp (hierarchical risk parity), or kelly. Returns the Computed ' +
    'envelope: value.weights + value.objective, assumptions echo the objective and budget, and ' +
    'diagnostics carry converged/iterations — a non-converged solve adds an ' +
    'optimize.not_converged warning instead of pretending.',
  inputSchema: RiskOptimizeInputSchema,
  outputSchema: ENVELOPE_OUTPUT,
  run: (input) => {
    const covariance = capRows(
      input.covariance,
      'covariance',
      'totalfinance.risk.optimize',
      // Operation-aware (P3.7): this is the covariance DIMENSION — optimizers scale ~O(p³),
      // so 200 assets is the compute budget, not the generic 5000-row payload cap.
      200,
    );
    if (NEEDS_MEAN.has(input.objective) && input.mean === undefined) {
      throw new InputError(
        `risk.optimize: \`mean\` (per-asset expected returns) is required for ${input.objective}.`,
        { code: ErrorCode.InputMissingField, context: { objective: input.objective } },
      );
    }
    const constraints: OptimizeConstraints = {
      ...(input.longOnly !== undefined ? { longOnly: input.longOnly } : {}),
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
    };
    let r: OptimizeResult;
    switch (input.objective) {
      case 'minVariance':
        r = minVariance(covariance, constraints);
        break;
      case 'maxSharpe':
        r = maxSharpe({
          mean: input.mean!,
          covariance,
          options: {
            ...constraints,
            ...(input.riskFreeRatePerPeriod !== undefined
              ? { riskFreeRatePerPeriod: input.riskFreeRatePerPeriod }
              : {}),
          },
        });
        break;
      case 'meanVariance':
        r = meanVariance({
          mean: input.mean!,
          covariance,
          options: {
            ...constraints,
            ...(input.riskAversion !== undefined ? { riskAversion: input.riskAversion } : {}),
          },
        });
        break;
      case 'riskParity':
        // riskParity is long-only by construction and accepts only budget/maximumIterations/tolerance — its Law 12
        // guard rejects a forwarded `longOnly`, so pass just the budget.
        r = riskParity(covariance, input.budget !== undefined ? { budget: input.budget } : {});
        break;
      case 'hrp':
        r = hrp(covariance, input.budget !== undefined ? { budget: input.budget } : {});
        break;
      case 'kelly':
        r = kelly({
          mean: input.mean!,
          covariance,
          options: {
            ...constraints,
            ...(input.fraction !== undefined ? { fraction: input.fraction } : {}),
          },
        });
        break;
    }
    const w = r.value.weights.map((x) => Number(x.toFixed(4)));
    return {
      summary:
        `${input.objective}: weights=[${w.join(', ')}], objective=${r.value.objective.toFixed(6)}` +
        (r.diagnostics.converged === false ? ' (NOT converged)' : ''),
      structured: { value: r.value, assumptions: r.assumptions, diagnostics: r.diagnostics },
    };
  },
});

// ── vol: surface / metrics / event ─────────────────────────────────────────────────────────────

const SurfaceQuoteSchema = schema.object({
  strike: schema.number().positive(),
  expiry: schema.string().describe('ISO date YYYY-MM-DD'),
  type: schema.enum(['call', 'put'] as const),
  impliedVolatility: schema
    .number()
    .positive()
    .optional()
    .describe('Implied volatility (decimal, e.g. 0.22)'),
  price: schema
    .number()
    .positive()
    .optional()
    .describe('Option mid price (used to imply IV when `impliedVolatility` omitted)'),
});

const VolatilitySurfaceInputSchema = schema.object({
  chain: schema.array(SurfaceQuoteSchema).describe('Chain quotes: one row per contract'),
  spot: schema.number().positive(),
  riskFreeRate: schema.number().describe('Continuously-compounded risk-free rate (decimal)'),
  asOf: ValuationInstantSchema,
  dividendYield: schema.number().optional().describe('Continuous dividend yield (decimal)'),
  model: schema
    .enum(['interpolated', 'raw', 'smoothed', 'svi', 'sabr'] as const)
    .optional()
    .describe('Surface model (default interpolated PCHIP; svi/sabr fit parametric smiles)'),
  underlying: schema.string().describe('Ticker of the chain — REQUIRED, it names every contract'),
  style: schema
    .enum(['american', 'european'] as const)
    .describe(
      "Exercise style of every contract in the chain — REQUIRED (listed US equity options are 'american'); the library never defaults it",
    ),
});

export const volatilitySurfaceTool = defineOperation({
  id: 'totalfinance.volatility.surface',
  title: 'Fit an implied-vol surface',
  description:
    'Fit an implied-volatility surface from chain quotes (IV given directly, or implied from ' +
    'price) and return the surface rows, per-expiry ATM term structure, and the static-arbitrage ' +
    'report (calendar/butterfly violations). The surface never fabricates: non-convergence and ' +
    'extrapolation are reported in diagnostics/warnings.',
  inputSchema: VolatilitySurfaceInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        description: 'Surface grid rows (expiry × strike × impliedVolatility)',
      },
      expiries: { type: 'array', items: { type: 'string' } },
      arbitrage: { type: 'object', description: 'Static-arbitrage report (violations list)' },
      assumptions: { type: 'object' },
      diagnostics: { type: 'object' },
    },
    required: ['rows', 'expiries', 'arbitrage', 'assumptions', 'diagnostics'],
  },
  run: (input) => {
    const chain = capRows(
      input.chain,
      'chain',
      'totalfinance.volatility.surface',
      // Operation-aware (P3.7): each expiry slice is an iterative SVI calibration — 2000 quotes
      // is the fitting budget (a full listed chain), below the generic series cap.
      2000,
    );
    const asOfMs = resolveValuationAsOf(input.asOf, 'totalfinance.volatility.surface');
    const { underlying, style } = input;
    const quotes = chain.map((row) => ({
      contract: {
        underlying,
        type: row.type,
        style,
        strike: row.strike,
        expiry: row.expiry,
        ...resolvedExpiry(row.expiry),
      },
      timestampMs: asOfMs,
      underlyingPrice: input.spot,
      ...(row.impliedVolatility !== undefined ? { impliedVolatility: row.impliedVolatility } : {}),
      ...(row.price !== undefined ? { mid: row.price } : {}),
    }));
    const surface = volatilitySurface({
      quotes,
      market: {
        spot: input.spot,
        riskFreeRate: input.riskFreeRate,
        asOf: asOfMs,
        ...(input.dividendYield !== undefined ? { dividendYield: input.dividendYield } : {}),
      },
      config: input.model !== undefined ? { model: input.model } : {},
    });
    const rows = surface.toRows();
    const arbitrage = surface.arbitrage();
    return {
      summary:
        `surface: ${surface.expiries().length} expiries, ${rows.length} rows, ` +
        `${arbitrage.violations.length} arbitrage violation(s)`,
      structured: {
        rows,
        expiries: surface.expiries(),
        arbitrage,
        assumptions: surface.assumptions,
        diagnostics: surface.diagnostics,
      },
    };
  },
});

const VolatilityMetricsInputSchema = schema.object({
  current: schema.number().positive().describe('Current implied volatility (decimal, e.g. 0.22)'),
  history: schema
    .array(schema.number().positive())
    .describe('Historical IV series (decimals), e.g. 252 daily ATM IVs'),
});

export const volatilityMetrics = defineOperation({
  id: 'totalfinance.volatility.metrics',
  title: 'IV rank / percentile / stats',
  description:
    'Where does the current implied volatility sit against its history? Returns IV rank ' +
    '(min–max position, 0–100), IV percentile (share of history below current, 0–100), and summary statistics — ' +
    'the standard "is IV high?" read before selling or buying premium.',
  inputSchema: VolatilityMetricsInputSchema,
  outputSchema: ENVELOPE_OUTPUT,
  run: (input) => {
    const r = impliedVolatilityStatistics.explain({
      current: input.current,
      history: capRows(input.history, 'history', 'totalfinance.volatility.metrics'),
    });
    return {
      summary:
        `IV ${input.current}: rank=${
          r.value.rank === null ? 'undefined (flat history)' : r.value.rank.toFixed(1)
        }, ` + `percentile=${r.value.percentile.toFixed(1)} over ${r.value.observations} obs`,
      structured: { value: r.value, assumptions: r.assumptions, diagnostics: r.diagnostics },
    };
  },
});

const VolatilityEventInputSchema = schema.object({
  atmVolatility: schema
    .number()
    .positive()
    .describe('Total ATM implied volatility into the event (decimal)'),
  baseVolatility: schema
    .number()
    .describe('Baseline (non-event) vol, e.g. post-event or far-month IV (decimal, ≥ 0)'),
  timeToExpiryYears: schema.number().positive().describe('Time to expiry in years, e.g. 5/365'),
  realizedVolatility: schema
    .number()
    .positive()
    .optional()
    .describe(
      'ANNUALIZED realized volatility (decimal, e.g. 0.18 — a per-bar σ × √252 on daily bars) — adds the variance risk premium',
    ),
});

export const volatilityEvent = defineOperation({
  id: 'totalfinance.volatility.event',
  title: 'Event-volatility decomposition (earnings)',
  description:
    'Decompose pre-event implied volatility into base + event variance and the implied one-day ' +
    'event move (the earnings-move read): eventMove = √max(0, atmVolatility²·timeToExpiryYears − baseVolatility²·timeToExpiryYears). ' +
    'Optionally reports the variance risk premium when `realizedVolatility` is supplied.',
  inputSchema: VolatilityEventInputSchema,
  outputSchema: ENVELOPE_OUTPUT,
  run: (input) => {
    const d = eventVolatilityDecomposition({
      atmVolatility: input.atmVolatility,
      timeToExpiryYears: input.timeToExpiryYears,
      baseVolatility: input.baseVolatility,
    });
    const vrp =
      input.realizedVolatility !== undefined
        ? varianceRiskPremium({
            impliedVolatility: input.atmVolatility,
            realizedVolatility: input.realizedVolatility,
          })
        : undefined;
    // The decomposition is report-shaped (assumptions/diagnostics inline) — lift its numeric
    // fields into the tool envelope's `value` and pass its diagnostics through.
    return {
      summary:
        `implied event move = ${(d.eventMove * 100).toFixed(2)}% ` +
        `(event variance ${d.eventVariance.toExponential(2)} of total ${d.totalVariance.toExponential(
          2,
        )})`,
      structured: {
        value: {
          totalVariance: d.totalVariance,
          baseVariance: d.baseVariance,
          eventVariance: d.eventVariance,
          eventMove: d.eventMove,
          ...(vrp !== undefined ? { varianceRiskPremium: vrp } : {}),
        },
        assumptions: {
          atmVolatility: input.atmVolatility,
          baseVolatility: input.baseVolatility,
          timeToExpiryYears: input.timeToExpiryYears,
          model: 'additive-variance',
        },
        diagnostics: d.diagnostics,
      },
    };
  },
});

// ── structure: options flow ────────────────────────────────────────────────────────────────────

const FlowTradeSchema = schema.object({
  timestampMs: schema.number().describe('Print timestamp (epoch ms)'),
  type: schema.enum(['call', 'put'] as const),
  strike: schema.number().positive(),
  expiry: schema.string().describe('ISO date YYYY-MM-DD'),
  price: schema.number().positive().describe('Print price per share'),
  size: schema.number().positive().describe('Print size (contracts)'),
  bid: schema
    .number()
    .optional()
    .describe('NBBO bid at print time (enables aggressor-side classification)'),
  ask: schema.number().optional().describe('NBBO ask at print time'),
  exchange: schema
    .string()
    .optional()
    .describe('Venue code (enables venue-verified sweep detection)'),
  openInterest: schema
    .number()
    .optional()
    .describe('Prior open interest (enables opening detection)'),
});

const StructureFlowInputSchema = schema.object({
  trades: schema.array(FlowTradeSchema).describe('Option prints, any order (sorted internally)'),
  underlying: schema.string().describe('Ticker of the prints — REQUIRED, it names every contract'),
  style: schema
    .enum(['american', 'european'] as const)
    .describe(
      "Exercise style of the printed contracts — REQUIRED (listed US equity options are 'american'); the library never defaults it",
    ),
  multiplier: schema.number().positive().optional().describe('Contract multiplier (default 100)'),
  blockMinSize: schema.number().optional().describe('Min contracts for a block (default 100)'),
  blockMinPremium: schema
    .number()
    .optional()
    .describe('Min premium $ for a block (default 100,000)'),
  maxDetails: schema
    .number()
    .integer()
    .positive()
    .optional()
    .describe('Max sweeps/spreads returned in detail (default 25 each)'),
});

export const structureFlow = defineOperation({
  id: 'totalfinance.structure.flow',
  title: 'Classify options flow (sweeps / blocks / spreads)',
  description:
    'Classify option prints into aggressor-side flow: sweeps (multi-print bursts, venue-verified ' +
    'when exchange codes are supplied), blocks, and multi-leg spreads. Aggressor side is ' +
    'NBBO-estimated (Lee–Ready style) — the honest caveats ride diagnostics.warnings as ' +
    '`model.limitation` entries (mirrored as `limitations` strings for quick reading); nothing is ' +
    'presented as exchange-confirmed unless it is.',
  inputSchema: StructureFlowInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      counts: { type: 'object', description: 'trades/sweeps/spreads/buy/sell/unknown totals' },
      sweeps: { type: 'array', description: 'Detected sweeps (capped by maxDetails)' },
      spreads: { type: 'array', description: 'Detected multi-leg spreads (capped)' },
      assumptions: { type: 'object', description: 'The rules/windows the analysis ran under' },
      diagnostics: {
        type: 'object',
        description: 'Warnings, including the heuristic caveats as `model.limitation` entries',
      },
      limitations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Convenience view: the `model.limitation` messages from diagnostics.warnings ' +
          '(diagnostics is the source of truth)',
      },
    },
    required: ['counts', 'sweeps', 'spreads', 'assumptions', 'diagnostics', 'limitations'],
  },
  run: (input) => {
    const rows = capRows(input.trades, 'trades', 'totalfinance.structure.flow');
    const { underlying, style } = input;
    const trades: OptionTrade[] = rows.map((row) => ({
      contract: {
        underlying,
        type: row.type,
        style,
        strike: row.strike,
        expiry: row.expiry,
        ...resolvedExpiry(row.expiry),
        ...(input.multiplier !== undefined ? { multiplier: input.multiplier } : {}),
      },
      timestampMs: row.timestampMs,
      price: row.price,
      size: row.size,
      ...(row.bid !== undefined ? { bid: row.bid } : {}),
      ...(row.ask !== undefined ? { ask: row.ask } : {}),
      ...(row.exchange !== undefined ? { exchange: row.exchange } : {}),
      ...(row.openInterest !== undefined ? { openInterest: row.openInterest } : {}),
    }));
    const analysis = flow(trades, {
      ...(input.blockMinSize !== undefined ? { blockMinSize: input.blockMinSize } : {}),
      ...(input.blockMinPremium !== undefined ? { blockMinPremium: input.blockMinPremium } : {}),
    });
    const max = input.maxDetails ?? 25;
    const bySide = { buy: 0, sell: 0, unknown: 0 };
    for (const t of analysis.trades) bySide[t.side] += 1;
    return {
      summary:
        `${analysis.trades.length} prints → ${analysis.sweeps.length} sweep(s), ` +
        `${analysis.spreads.length} spread(s); aggressor buy/sell/unknown = ` +
        `${bySide.buy}/${bySide.sell}/${bySide.unknown}`,
      structured: {
        counts: {
          trades: analysis.trades.length,
          sweeps: analysis.sweeps.length,
          spreads: analysis.spreads.length,
          ...bySide,
        },
        sweeps: analysis.sweeps.slice(0, max),
        spreads: analysis.spreads.slice(0, max),
        assumptions: analysis.assumptions,
        diagnostics: analysis.diagnostics,
        // The caveats live in diagnostics.warnings as `model.limitation` entries (R2 — nothing
        // hoisted by the library); this is a derived convenience view of those messages.
        limitations: analysis.diagnostics.warnings
          .filter((w) => w.code === WarningCode.ModelLimitation)
          .map((w) => w.message),
      },
    };
  },
});

// ── strategy: discovery ────────────────────────────────────────────────────────────────────────

export const strategyList = defineOperation({
  id: 'totalfinance.strategy.list',
  title: 'List the named-strategy catalog',
  description:
    'Discover every named strategy builder: name, one-line description, whether it spans ' +
    'multiple expiries, and a canonical example input (the exact shape `totalfinance.strategy.analyze` ' +
    'accepts via its `strategy` + `input` form). Agents self-serve the input shapes from here.',
  inputSchema: schema.object({
    multiExpiry: schema
      .boolean()
      .optional()
      .describe('Filter: only multi-expiry (true) or single (false)'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer' },
      strategies: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            multiExpiry: { type: 'boolean' },
            example: {
              type: 'object',
              description: 'A canonical, buildable input for this builder',
            },
          },
          required: ['name', 'description', 'multiExpiry', 'example'],
        },
      },
    },
    required: ['count', 'strategies'],
  },
  run: (input) => {
    let list = listStrategies();
    if (input.multiExpiry !== undefined) {
      list = list.filter((d) => d.multiExpiry === input.multiExpiry);
    }
    return {
      summary: `${list.length} named strategies (use strategy + input on totalfinance.strategy.analyze)`,
      structured: { count: list.length, strategies: list },
    };
  },
});

// ── calendars ──────────────────────────────────────────────────────────────────────────────────

const CALENDARS = { NYSE, CBOE, crypto24x7 } as const;

const CalendarSessionsInputSchema = schema.object({
  calendar: schema.enum(['NYSE', 'CBOE', 'crypto24x7'] as const).describe('Exchange calendar'),
  from: schema.string().describe('Range start (ISO YYYY-MM-DD, inclusive)'),
  to: schema.string().describe('Range end (ISO YYYY-MM-DD, inclusive)'),
  expirationKind: schema
    .enum(['weekly', 'monthly', 'quarterly'] as const)
    .optional()
    .describe('Also return option expirations of this kind (holiday-shifted)'),
});

const MAX_SESSION_DAYS = 400;

export const calendarSessions = defineOperation({
  id: 'totalfinance.calendar.sessions',
  title: 'Trading sessions & option expirations',
  description:
    'Trading days, holidays, and half days for an exchange calendar over a date range (≤ ~13 ' +
    'months), plus option expirations (weekly Fridays / monthly OPEX / quarterly, shifted off ' +
    'holidays from the calendar data) when `expirationKind` is set, and the next expiry after ' +
    'the range start.',
  inputSchema: CalendarSessionsInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      tradingDays: { type: 'array', items: { type: 'string' } },
      holidays: { type: 'array', items: { type: 'string' } },
      halfDays: { type: 'array', items: { type: 'string' } },
      expirations: { type: 'array', items: { type: 'string' } },
      nextExpiry: { type: 'string' },
      calendar: { type: 'object', description: 'name/version/timezone' },
    },
    required: ['tradingDays', 'holidays', 'halfDays', 'calendar'],
  },
  run: (input) => {
    const cal = CALENDARS[input.calendar];
    const fromMs = isoDateToEpochMs(input.from);
    const toMs = isoDateToEpochMs(input.to);
    const DAY = 86_400_000;
    const days = Math.round((toMs - fromMs) / DAY);
    if (days < 0 || days > MAX_SESSION_DAYS) {
      throw new InputError(
        `calendar.sessions: range must be 0–${MAX_SESSION_DAYS} days, got ${days}.`,
        { code: ErrorCode.InputOutOfRange, context: { days } },
      );
    }
    const tradingDays: string[] = [];
    const holidays: string[] = [];
    const halfDays: string[] = [];
    for (let ms = fromMs; ms <= toMs; ms += DAY) {
      const iso = new Date(ms).toISOString().slice(0, 10);
      if (cal.isTradingDay(iso)) {
        tradingDays.push(iso);
        if (cal.isHalfDay(iso)) halfDays.push(iso);
      } else if (cal.isHoliday(iso)) {
        holidays.push(iso);
      }
    }
    const expiries =
      input.expirationKind !== undefined
        ? expirations(cal, { from: input.from, to: input.to, kind: input.expirationKind })
        : undefined;
    return {
      summary:
        `${input.calendar}: ${tradingDays.length} trading days, ${holidays.length} holidays, ` +
        `${halfDays.length} half days` +
        (expiries !== undefined ? `, ${expiries.length} ${input.expirationKind} expirations` : ''),
      structured: {
        tradingDays,
        holidays,
        halfDays,
        ...(expiries !== undefined
          ? {
              expirations: expiries,
              nextExpiry: nextExpiry(cal, input.from, input.expirationKind),
            }
          : {}),
        calendar: { name: cal.name, version: cal.version, timezone: cal.timezone },
      },
    };
  },
});

// ── crypto pack: perp funding & futures carry (P3.7) ──────────────────────────────────────────

const CryptoPerpFundingInputSchema = schema.object({
  markPrice: schema.number().positive().describe('Perpetual mark price (quote currency)'),
  indexPrice: schema.number().positive().describe('Index / spot price (quote currency)'),
  fundingRate: schema
    .number()
    .describe(
      'Realized funding for ONE interval (decimal; 0.0001 = 0.01%). Longs pay when positive',
    ),
  intervalHours: schema
    .number()
    .positive()
    .optional()
    .describe('Funding interval in hours (default 8)'),
});

const cryptoPerpFunding = defineOperation({
  id: 'totalfinance.crypto.perpetual_funding',
  title: 'Perpetual funding → implied carry',
  description:
    'Annualize a perpetual funding rate into the implied cost-of-carry: the mark/index premium, ' +
    'simple and compounded annualized funding, and an extreme-funding flag. All rates are ' +
    'decimals; the interval defaults to the standard 8 hours.',
  inputSchema: CryptoPerpFundingInputSchema,
  outputSchema: ENVELOPE_OUTPUT,
  run: (input) => {
    const r = perpetualFunding({
      markPrice: input.markPrice,
      indexPrice: input.indexPrice,
      fundingRate: input.fundingRate,
      ...(input.intervalHours !== undefined ? { intervalHours: input.intervalHours } : {}),
    });
    const v = r.value;
    return {
      summary:
        `premium ${(v.premium * 100).toFixed(3)}%, funding ${(v.fundingRate * 100).toFixed(4)}%/` +
        `${v.intervalHours}h → ${(v.annualizedSimple * 100).toFixed(1)}%/yr simple`,
      structured: { value: v, assumptions: r.assumptions, diagnostics: r.diagnostics },
    };
  },
});

const CryptoFuturesBasisInputSchema = schema.object({
  spot: schema.number().positive().describe('Spot price (quote currency)'),
  future: schema.number().positive().describe('Dated-futures price (quote currency)'),
  timeToExpiryYears: schema.number().positive().describe('Time to futures expiry in YEARS'),
  financingRate: schema
    .number()
    .optional()
    .describe(
      'Quote financing rate (annualized decimal) — supply to get fairFuture/richness/carryArbitrage ' +
        'and the cash-and-carry arbitrage flag',
    ),
  coinYield: schema
    .number()
    .optional()
    .describe('Base-coin yield (annualized decimal, e.g. staking; default 0)'),
  arbitrageThreshold: schema
    .number()
    .optional()
    .describe('|carryArbitrage| above which cash-and-carry is flagged (decimal, default 0.05)'),
});

const cryptoFuturesBasis = defineOperation({
  id: 'totalfinance.crypto.futures_basis',
  title: 'Futures basis / cash-and-carry',
  description:
    'Annualized basis of a dated future over spot — the cash-and-carry yield. Reports raw and ' +
    'percentage basis, simple and continuously-compounded annualization, contango/backwardation, ' +
    'and flags an arbitrage-sized basis.',
  inputSchema: CryptoFuturesBasisInputSchema,
  outputSchema: ENVELOPE_OUTPUT,
  run: (input) => {
    const r = futuresBasis({
      spot: input.spot,
      future: input.future,
      timeToExpiryYears: input.timeToExpiryYears,
      ...(input.financingRate !== undefined ? { financingRate: input.financingRate } : {}),
      ...(input.coinYield !== undefined ? { coinYield: input.coinYield } : {}),
      ...(input.arbitrageThreshold !== undefined
        ? { arbitrageThreshold: input.arbitrageThreshold }
        : {}),
    });
    const v = r.value;
    return {
      summary:
        `basis ${(v.basisFraction * 100).toFixed(2)}% (${v.structure}), ` +
        `annualized ${(v.annualizedSimple * 100).toFixed(2)}%/yr` +
        (v.carryArbitrage !== undefined
          ? `, carry arb ${(v.carryArbitrage * 100).toFixed(2)}%/yr vs financing`
          : ''),
      structured: { value: v, assumptions: r.assumptions, diagnostics: r.diagnostics },
    };
  },
});

/** The crypto derivatives pack (P3.7): funding + carry analytics. */
export function cryptoPack(): OperationPack {
  return { name: 'crypto', operations: [cryptoPerpFunding, cryptoFuturesBasis] };
}

// ── fixed-income pack: bond analytics (P3.7) ──────────────────────────────────────────────────

const FixedIncomeBondInputSchema = schema.object({
  issueDate: schema.string().describe('Dated date / first accrual date, YYYY-MM-DD'),
  maturityDate: schema.string().describe('Maturity date, YYYY-MM-DD'),
  couponRate: schema.number().describe('Annualized coupon rate (decimal; 0.05 = 5%)'),
  frequency: schema
    .enum(['annual', 'semiannual', 'quarterly', 'monthly'] as const)
    .describe('Coupon frequency'),
  faceValue: schema.number().positive().optional().describe('Redemption / par value (default 100)'),
  dayCount: schema
    .enum(['30/360', 'ACT/360', 'ACT/365F', 'ACT/ACT', '30E/360'] as const)
    .optional()
    .describe('Accrual day count (default 30/360)'),
  settlementDate: schema.string().describe('Settlement date, YYYY-MM-DD'),
  yield: schema
    .number()
    .optional()
    .describe('Annualized yield (decimal) — provide this OR `price`'),
  price: schema.number().positive().optional().describe('Bond price — provide this OR `yield`'),
  priceType: schema
    .enum(['clean', 'dirty'] as const)
    .optional()
    .describe('How to read `price` (default clean)'),
});

const fixedIncomeBond = defineOperation({
  id: 'totalfinance.fixed_income.bond_analytics',
  title: 'Bond price/yield analytics',
  description:
    'Full fixed-rate bond analytics from a specification: given a `yield`, price it; given a `price`, ' +
    'solve the yield to maturity — then report clean/dirty price, accrued interest, Macaulay/' +
    'modified duration, convexity, and DV01. Dates are YYYY-MM-DD; rates are decimals.',
  inputSchema: FixedIncomeBondInputSchema,
  outputSchema: ENVELOPE_OUTPUT,
  run: (input) => {
    // Strict XOR (Law 12 posture): both `yield` and `price` is ambiguous — silently preferring
    // one would hide a modelling choice; neither is uncomputable.
    if (input.yield !== undefined && input.price !== undefined) {
      throw new InputError(
        'totalfinance.fixed_income.bond_analytics: provide `yield` OR `price`, not both — pricing ' +
          'from yield and solving yield from price are different questions.',
        { code: ErrorCode.InputWrongShape, context: { got: 'yield AND price' } },
      );
    }
    if (input.priceType !== undefined && input.price === undefined) {
      throw new InputError(
        'totalfinance.fixed_income.bond_analytics: `priceType` only applies when `price` is given.',
        { code: ErrorCode.InputWrongShape, context: { got: 'priceType without price' } },
      );
    }
    const bond = bonds.fixedRate({
      issueDate: input.issueDate,
      maturityDate: input.maturityDate,
      couponRate: input.couponRate,
      frequency: input.frequency,
      ...(input.faceValue !== undefined ? { faceValue: input.faceValue } : {}),
      ...(input.dayCount !== undefined ? { dayCount: input.dayCount } : {}),
    });
    let y: number;
    if (input.yield !== undefined) {
      y = input.yield;
    } else if (input.price !== undefined) {
      y = yieldToMaturity(bond, {
        settlementDate: input.settlementDate,
        price: input.price,
        ...(input.priceType !== undefined ? { priceType: input.priceType } : {}),
      });
    } else {
      throw new InputError(
        'totalfinance.fixed_income.bond_analytics: provide either `yield` or `price`.',
        { code: ErrorCode.InputMissingField, context: { need: 'yield OR price' } },
      );
    }
    const r = yieldMetrics.explain(bond, { settlementDate: input.settlementDate, yield: y });
    const m = r.value;
    // `yield: 5` is a 500% yield. It prices, and the whole report downstream is fiction. Over the
    // wire this is the single easiest mistake an agent makes — the field is a decimal, and JSON
    // gives no unit hint — so it is disclosed alongside the library's own warnings rather than
    // thrown (a genuinely distressed bond can yield above 100%).
    const warnings: QuantWarning[] = [...r.diagnostics.warnings];
    if (input.yield !== undefined && Number.isFinite(input.yield) && Math.abs(input.yield) > 1) {
      warnings.push(
        warning(
          ErrorCode.InputSuspiciousYield,
          `yield=${input.yield} implies a ${(input.yield * 100).toFixed(0)}% yield to maturity — ` +
            `\`yield\` is a decimal; did you mean ${(input.yield / 100).toFixed(4)}?`,
          'info',
          { yield: input.yield },
        ),
      );
    }
    return {
      summary:
        `ytm ${(m.yield * 100).toFixed(3)}%, clean ${m.cleanPrice.toFixed(3)}, ` +
        `modDur ${m.modifiedDuration.toFixed(2)}, convexity ${m.convexity.toFixed(2)}, ` +
        `DV01 ${m.dv01.toFixed(4)}`,
      structured: {
        value: m,
        assumptions: r.assumptions,
        diagnostics: { ...r.diagnostics, warnings },
      },
    };
  },
});

/**
 * The fixed-income pack (P3.7): bond analytics.
 *
 * The pack id is `fixed_income`, matching the `totalfinance.fixed_income.*` tool prefix. It was
 * `fixed-income` while its tools were `fixed_income` — one identity spelled two ways on the wire,
 * so a client selecting packs by name could not derive the name from the tools it saw. Renamed as
 * a pre-1.0 clean break rather than aliased: two spellings is the defect.
 */
export function fixedIncomePack(): OperationPack {
  return { name: 'fixed_income', operations: [fixedIncomeBond] };
}

/** The analysis additions (dx §WS-5) to the default read-only tool set. */
export function analysisOperations(): TotalFinanceOperation[] {
  return [
    performanceAnalyze,
    riskOptimize,
    volatilitySurfaceTool,
    volatilityMetrics,
    volatilityEvent,
    structureFlow,
    strategyList,
    calendarSessions,
  ];
}

// ── opt-in backtest pack (payload/runtime heavy — deliberately NOT in the default set) ─────────

const BacktestBarSchema = schema.object({
  symbol: schema.string().optional().describe('Ticker (default SYMBOL)'),
  timestampMs: schema.number().describe('Bar timestamp (epoch ms)'),
  open: schema.number().positive(),
  high: schema.number().positive(),
  low: schema.number().positive(),
  close: schema.number().positive(),
  volume: schema.number().optional(),
});

const BacktestVectorizedInputSchema = schema.object({
  data: schema.array(BacktestBarSchema).describe('OHLC bars, chronological'),
  signal: schema
    .array(schema.number())
    .describe(
      'Target position per bar (1 long, 0 flat, -1 short; fractional = sized), aligned to data',
    ),
  initialCapital: schema.number().positive().optional().describe('Opening capital (default 1)'),
  feeBps: schema.number().optional().describe('Per-trade fee in basis points of traded notional'),
});

const backtestVectorized = defineOperation({
  id: 'totalfinance.backtest.vectorized_run',
  title: 'Run a vectorized backtest',
  description:
    'Run a single-asset vectorized backtest: signal-following fills at close, optional bps fees. ' +
    'Returns final value, turnover, and the performance summary; every hidden policy the run ' +
    'assumed (fill timing, costs, slippage, settlement, calendar, margin) is echoed in ' +
    '`assumptions`, and the implementation-risk warnings (look-ahead, data alignment) ride ' +
    '`diagnostics`. Deliberately opt-in (backtestPack) — payloads and runtime are heavier than ' +
    'the default tools.',
  inputSchema: BacktestVectorizedInputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      finalValue: { type: 'number' },
      turnover: { type: 'number', description: 'Traded notional ÷ average equity over the run' },
      performance: { type: 'object', description: 'The standard performance summary' },
      assumptions: {
        type: 'object',
        description:
          'The modelling policies the run assumed: initialCapital, fill, cost, slippage, ' +
          'cashSettlement, corporateAction, calendar, margin, conventionsVersion',
      },
      diagnostics: {
        type: 'object',
        description:
          'Implementation-risk warnings (look-ahead / data alignment) + benchmarkFixtureVersion',
      },
    },
    required: ['finalValue', 'turnover', 'performance', 'assumptions', 'diagnostics'],
  },
  run: (input) => {
    const rows = capRows(input.data, 'data', 'totalfinance.backtest.vectorized_run');
    const symbol = rows[0]?.symbol ?? 'SYMBOL';
    const data = rows.map((row) => ({
      ...row,
      symbol: row.symbol ?? symbol,
    }));
    const r = backtest.vectorized({
      data,
      signal: input.signal,
      ...(input.initialCapital !== undefined ? { initialCapital: input.initialCapital } : {}),
      ...(input.feeBps !== undefined ? { fees: fees.bps(input.feeBps) } : {}),
    });
    return {
      summary:
        `backtest: finalValue=${r.finalValue.toFixed(2)} over ${rows.length} bars ` +
        `(sharpe ${
          r.performance.sharpe === null ? 'undefined' : r.performance.sharpe.toFixed(2)
        }, maxDrawdown ${(r.performance.maxDrawdown * 100).toFixed(1)}%)`,
      structured: {
        finalValue: r.finalValue,
        turnover: r.turnover,
        performance: r.performance,
        // dx §2.5: assumptions say what the run assumed; diagnostics say how trustworthy it is.
        assumptions: r.assumptions,
        diagnostics: r.diagnostics,
      },
    };
  },
});

/**
 * The opt-in backtest pack (dx §4.2: backtests do not belong in the default server). Enable with
 * `createTotalFinanceMcpServer({ packs: [backtestPack()] })`.
 */
export function backtestPack(): OperationPack {
  return { name: 'backtest', operations: [backtestVectorized, ...backtestJourneyOperations()] };
}
