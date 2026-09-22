/**
 * `crossSectionalBacktestGrid` (Stage 4.6, FC8 Decision 4 — "the grid"): the cartesian product of
 * declarative variations over one `crossSectionalBacktest` request, run as independent single runs
 * of the same function with unchanged semantics, with the research-hygiene verdicts composed
 * verbatim from `@insiderfinance/totalfinance/risk` — `researchProtocol` over the trial Sharpes,
 * `probabilityOfBacktestOverfitting` over the per-variation return matrix, `deflatedSharpeRatio` for
 * the best trial. The grid records the parent sweep hash and each child's run hash so one artifact
 * can hold the whole protocol without a second copy of any math.
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureKnownKeys,
  requireArgumentObject,
  warning,
} from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import {
  type BacktestOverfittingProbabilityResult,
  type DeflatedSharpeResult,
  type ResearchVerdict,
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  researchProtocol,
  sharpeStatistics,
} from '@totalfinance/risk';
import { crossSectionalBacktest } from './engine.js';
import type { CrossSectionalBacktestRequest, CrossSectionalBacktestResult } from './types.js';
import { requireCrossSectionalBacktestRequest } from './validate.js';

/** Decision 9: variations one synchronous sweep runs unless the caller raises the ceiling. */
export const CROSS_SECTIONAL_GRID_DEFAULT_MAXIMUM = 256;
/** Decision 9: the hard ceiling on variations one synchronous sweep may run. */
export const CROSS_SECTIONAL_GRID_CEILING = 4_096;

/** One axis of the grid: a dotted path into the request and the values it takes. */
export interface GridVariation {
  /** A dotted path under `signal`, `rebalanceSchedule`, `portfolioConstruction`, `execution`, `transactionCostModel`, `initialCapital`, or `riskFreeRate`. */
  path: string;
  /** The declarative values the path takes, in order; functions are refused (a grid is replayable). */
  values: readonly unknown[];
}

/** The performance-block metric that ranks the variations. */
export type GridSelectionMetric =
  | 'sharpe'
  | 'sortino'
  | 'calmar'
  | 'annualizedReturn'
  | 'totalReturn';

export interface CrossSectionalBacktestGridRequest {
  /** The base request every variation is applied to; validated once, never mutated. */
  request: CrossSectionalBacktestRequest;
  /** The axes; the cartesian product is run with the last axis varying fastest. */
  variations: readonly GridVariation[];
  /** Variations the sweep may run (default 256, at most 4,096). */
  maximumVariations?: number;
  /** The metric that picks the best trial (default `'sharpe'`); ties resolve to the lower index. */
  selectionMetric?: GridSelectionMetric;
  hygiene?: {
    /** CSCV blocks for `probabilityOfBacktestOverfitting` (even, 4–16). Default: 16, or the largest even count the run's periods allow. */
    splits?: number;
    /** `researchProtocol`'s confidence in (0, 1); default 0.95. */
    confidence?: number;
  };
}

/** The summary metrics of one variation, read from the run's performance block and diagnostics. */
export interface GridSummaryMetrics {
  periods: number;
  totalReturn: number | null;
  annualizedReturn: number | null;
  annualizedVolatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  maxDrawdown: number;
  hitRate: number | null;
  finalValue: number;
  rebalanceCount: number;
  tradeCount: number;
  fillCount: number;
  /** Mean allocator turnover per rebalance (fraction of NAV). */
  meanTurnover: number | null;
  /** Costs charged over the run, in base currency. */
  totalCosts: number;
  cappedGoalCount: number;
  violatedGoalCount: number;
  warningCount: number;
}

export interface GridVariationRow {
  index: number;
  /** Path → the value applied at this point of the product. */
  parameters: Record<string, unknown>;
  /** The child run's content-addressed identity (`CrossSectionalBacktestResult.runId`). */
  runId: string;
  metrics: GridSummaryMetrics;
  /** Per-observation Sharpe of the run's returns — the trial Sharpe the deflation reads. */
  trialSharpe: number;
  /** True when the run's returns could not carry a Sharpe (fewer than three periods or zero variance); the trial Sharpe is then 0 by convention. */
  trialSharpeDegenerate: boolean;
}

export interface GridHygiene {
  /** The trial Sharpes in variation order — the pool `researchProtocol` deflates against. */
  trialSharpes: number[];
  /** `researchProtocol` over the best trial's returns with the pool; `null` when the best trial is degenerate. */
  researchProtocol: ResearchVerdict | null;
  /** `probabilityOfBacktestOverfitting` over the periods × variations return matrix; `null` when fewer than two variations or too few periods. */
  backtestOverfitting: BacktestOverfittingProbabilityResult | null;
  /** `deflatedSharpeRatio` for the best trial against the pool; `null` when the best trial is degenerate. */
  deflatedSharpe: DeflatedSharpeResult | null;
}

export interface GridAssumptions {
  conventionsVersion: string;
  variationCount: number;
  maximumVariations: number;
  selectionMetric: GridSelectionMetric;
  periodsPerYear: number;
  riskFreeRate: number;
  paths: string[];
  hygiene: {
    /** The CSCV blocks actually used, or `null` when the overfitting probability was not computed. */
    splits: number | null;
    confidence: number;
    /** The trial Sharpe recorded for a degenerate return series. */
    degenerateTrialSharpe: 0;
  };
}

export interface GridDiagnostics extends Diagnostics {
  variationCount: number;
  degenerateTrialCount: number;
  /** The hygiene blocks that were not computed, each with its reason. */
  skippedHygiene: Array<{
    block: 'researchProtocol' | 'backtestOverfitting' | 'deflatedSharpe';
    reason: string;
  }>;
}

export interface CrossSectionalBacktestGridResult {
  /** The parent sweep hash: the content hash of the axes and every child run hash. */
  sweepId: string;
  variations: GridVariationRow[];
  /** Every child run, index-aligned with `variations` — the same function, called once per point. */
  runs: CrossSectionalBacktestResult[];
  /** The best trial by the selection metric, or `null` when no variation carries the metric. */
  best: { index: number; runId: string; metric: GridSelectionMetric; value: number } | null;
  hygiene: GridHygiene;
  assumptions: GridAssumptions;
  diagnostics: GridDiagnostics;
}

const GRID_REQUEST_KEYS = [
  'request',
  'variations',
  'maximumVariations',
  'selectionMetric',
  'hygiene',
] as const;
const VARIATION_KEYS = ['path', 'values'] as const;
const HYGIENE_KEYS = ['splits', 'confidence'] as const;
const SELECTION_METRICS: readonly GridSelectionMetric[] = [
  'sharpe',
  'sortino',
  'calmar',
  'annualizedReturn',
  'totalReturn',
];
const VARIABLE_ROOTS = [
  'signal',
  'rebalanceSchedule',
  'portfolioConstruction',
  'execution',
  'transactionCostModel',
  'initialCapital',
  'riskFreeRate',
] as const;
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const EXAMPLE =
  "crossSectionalBacktestGrid({ request, variations: [{ path: 'portfolioConstruction.long.count', values: [20, 50, 100] }] })";

function refuse(
  functionName: string,
  field: string,
  message: string,
  code: string = ErrorCode.InputOutOfRange,
  extra: Record<string, unknown> = {},
): never {
  throw new InputError(`${functionName}: ${field} ${message} Example: ${EXAMPLE}`, {
    code,
    context: { function: functionName, field, ...extra },
  });
}

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

function presentNotNull(functionName: string, record: object, key: string, field: string): boolean {
  if (!hasOwn(record, key)) return false;
  if ((record as Record<string, unknown>)[key] === null) {
    refuse(
      functionName,
      field,
      'is null — omit the field to leave it unset.',
      ErrorCode.InputWrongType,
    );
  }
  return (record as Record<string, unknown>)[key] !== undefined;
}

/** The closed guard for the grid request; the base request is validated by the engine's own guard. */
export function requireCrossSectionalBacktestGridRequest(
  functionName: string,
  label: string,
  value: unknown,
): CrossSectionalBacktestGridRequest {
  requireArgumentObject(functionName, label, value);
  const request = value as Record<string, unknown>;
  ensureKnownKeys(functionName, label, request, GRID_REQUEST_KEYS);
  requireCrossSectionalBacktestRequest(functionName, `${label}.request`, request['request']);
  if (!Array.isArray(request['variations']) || request['variations'].length === 0) {
    refuse(
      functionName,
      `${label}.variations`,
      `must be a non-empty array of { path, values }. Received ${request['variations'] === null ? 'null' : typeof request['variations']}.`,
      ErrorCode.InputWrongType,
    );
  }
  const seen = new Set<string>();
  request['variations'].forEach((variation, index) => {
    const field = `${label}.variations[${index}]`;
    requireArgumentObject(functionName, field, variation);
    ensureKnownKeys(functionName, field, variation, VARIATION_KEYS);
    const { path, values } = variation as { path: unknown; values: unknown };
    if (typeof path !== 'string' || path.length === 0) {
      refuse(
        functionName,
        `${field}.path`,
        'must be a dotted path string.',
        ErrorCode.InputWrongType,
      );
    }
    const segments = path.split('.');
    for (const segment of segments) {
      if (!SEGMENT.test(segment) || FORBIDDEN_SEGMENTS.has(segment)) {
        refuse(
          functionName,
          `${field}.path`,
          `has an invalid segment '${segment}' — segments are identifiers separated by dots.`,
          ErrorCode.InputWrongType,
          { path },
        );
      }
    }
    if (!(VARIABLE_ROOTS as readonly string[]).includes(segments[0]!)) {
      refuse(
        functionName,
        `${field}.path`,
        `starts at '${segments[0]}', which a grid may not vary — vary ${VARIABLE_ROOTS.map((r) => `'${r}'`).join(', ')}; the dataset, the universe, the window, the annualization, and the seed are the same for every variation.`,
        ErrorCode.InputInvalidEnum,
        { path },
      );
    }
    if (seen.has(path)) {
      refuse(
        functionName,
        `${field}.path`,
        `repeats '${path}'; each path is one axis.`,
        ErrorCode.InputOutOfRange,
        { path },
      );
    }
    seen.add(path);
    if (!Array.isArray(values) || values.length === 0) {
      refuse(
        functionName,
        `${field}.values`,
        `must be a non-empty array of declarative values. Received ${values === null ? 'null' : typeof values}.`,
        ErrorCode.InputWrongType,
      );
    }
    values.forEach((candidate, valueIndex) => {
      if (candidate === undefined || typeof candidate === 'function') {
        refuse(
          functionName,
          `${field}.values[${valueIndex}]`,
          `must be a declarative value (a grid is replayable); received ${candidate === undefined ? 'undefined' : 'a function'}.`,
          ErrorCode.InputWrongType,
          { path },
        );
      }
    });
  });
  if (presentNotNull(functionName, request, 'maximumVariations', `${label}.maximumVariations`)) {
    const maximum = request['maximumVariations'];
    if (
      !Number.isSafeInteger(maximum) ||
      (maximum as number) < 1 ||
      (maximum as number) > CROSS_SECTIONAL_GRID_CEILING
    ) {
      refuse(
        functionName,
        `${label}.maximumVariations`,
        `must be an integer in [1, ${CROSS_SECTIONAL_GRID_CEILING}]. Received ${String(maximum)}.`,
      );
    }
  }
  if (presentNotNull(functionName, request, 'selectionMetric', `${label}.selectionMetric`)) {
    if (!SELECTION_METRICS.includes(request['selectionMetric'] as GridSelectionMetric)) {
      refuse(
        functionName,
        `${label}.selectionMetric`,
        `must be one of ${SELECTION_METRICS.map((m) => `'${m}'`).join(' | ')}. Received ${JSON.stringify(request['selectionMetric'])}.`,
        ErrorCode.InputInvalidEnum,
      );
    }
  }
  if (presentNotNull(functionName, request, 'hygiene', `${label}.hygiene`)) {
    requireArgumentObject(functionName, `${label}.hygiene`, request['hygiene']);
    const hygiene = request['hygiene'] as Record<string, unknown>;
    ensureKnownKeys(functionName, `${label}.hygiene`, hygiene, HYGIENE_KEYS);
    if (presentNotNull(functionName, hygiene, 'splits', `${label}.hygiene['splits']`)) {
      const splits = hygiene['splits'];
      if (
        !Number.isSafeInteger(splits) ||
        (splits as number) < 4 ||
        (splits as number) > 16 ||
        (splits as number) % 2 !== 0
      ) {
        refuse(
          functionName,
          `${label}.hygiene['splits']`,
          `must be an even integer in [4, 16]. Received ${String(splits)}.`,
        );
      }
    }
    if (presentNotNull(functionName, hygiene, 'confidence', `${label}.hygiene['confidence']`)) {
      const confidence = hygiene['confidence'];
      if (typeof confidence !== 'number' || !(confidence > 0 && confidence < 1)) {
        refuse(
          functionName,
          `${label}.hygiene['confidence']`,
          `must be a number in (0, 1). Received ${String(confidence)}.`,
        );
      }
    }
  }
  return value as CrossSectionalBacktestGridRequest;
}

/** Copy-on-write along one path: every other reference is shared, which is safe because no engine mutates its inputs (Decision 12). */
/** Set a dotted path on a plain object copy (shared with the out-of-sample verbs). */
export function withPath(target: unknown, segments: readonly string[], value: unknown): unknown {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments;
  const base =
    target !== null && typeof target === 'object' && !Array.isArray(target)
      ? (target as Record<string, unknown>)
      : {};
  return { ...base, [head!]: withPath(base[head!], rest, value) };
}

function describeParameters(parameters: Record<string, unknown>): string {
  return Object.entries(parameters)
    .map(([path, value]) => `${path}=${JSON.stringify(value)}`)
    .join(', ');
}

/** The grid's summary row for one run (shared with the out-of-sample verbs). */
export function summarizeCrossSectionalRun(run: CrossSectionalBacktestResult): GridSummaryMetrics {
  const performance = run.performance;
  const rebalances = run.rebalances;
  let turnover = 0;
  let costs = 0;
  for (const row of rebalances) {
    turnover += row.turnover;
    costs += row.costs;
  }
  return {
    periods: performance.periods,
    totalReturn: performance.totalReturn,
    annualizedReturn: performance.annualizedReturn,
    annualizedVolatility: performance.annualizedVolatility,
    sharpe: performance.sharpe,
    sortino: performance.sortino,
    calmar: performance.calmar,
    maxDrawdown: performance.maxDrawdown,
    hitRate: performance.hitRate,
    finalValue: run.finalValue,
    rebalanceCount: run.diagnostics.rebalanceCount,
    tradeCount: run.trades.length,
    fillCount: run.diagnostics.fillCount,
    meanTurnover: rebalances.length > 0 ? turnover / rebalances.length : null,
    totalCosts: costs,
    cappedGoalCount: run.diagnostics.cappedGoalCount,
    violatedGoalCount: run.diagnostics.violatedGoalCount,
    warningCount: run.diagnostics.warnings.length,
  };
}

function degenerate(
  field: string,
  message: string,
  context: Record<string, unknown>,
): QuantWarning {
  return warning(WarningCode.DegenerateInput, message, 'warn', { field, ...context });
}

/**
 * Run the cartesian product of `variations` over `request` — each point one `crossSectionalBacktest`
 * call — and compose the research-hygiene verdicts. Every child run is returned whole and
 * index-aligned with `variations`; `sweepId` is the parent hash over the axes and the child hashes.
 */
export function crossSectionalBacktestGrid(
  gridRequest: CrossSectionalBacktestGridRequest,
): CrossSectionalBacktestGridResult {
  const functionName = 'crossSectionalBacktestGrid';
  const {
    request,
    variations,
    maximumVariations = CROSS_SECTIONAL_GRID_DEFAULT_MAXIMUM,
    selectionMetric = 'sharpe',
    hygiene = {},
  } = requireCrossSectionalBacktestGridRequest(functionName, 'request', gridRequest);
  const confidence = hygiene.confidence ?? 0.95;
  const periodsPerYear = request.periodsPerYear ?? 252;
  const riskFreeRate = request.riskFreeRate ?? 0;

  // ---- the product ---------------------------------------------------------------------------------
  let variationCount = 1;
  for (const axis of variations) variationCount *= axis.values.length;
  if (variationCount > maximumVariations) {
    refuse(
      functionName,
      'request.variations',
      `would run ${variationCount} variations, above maximumVariations=${maximumVariations} — trim an axis or raise maximumVariations (at most ${CROSS_SECTIONAL_GRID_CEILING}).`,
      ErrorCode.BacktestGridTooLarge,
      { variationCount, maximumVariations },
    );
  }
  const axes = variations.map((axis) => ({
    path: axis.path,
    segments: axis.path.split('.'),
    values: axis.values,
  }));
  const warnings: QuantWarning[] = [];
  const rows: GridVariationRow[] = [];
  const runs: CrossSectionalBacktestResult[] = [];
  const trialSharpes: number[] = [];
  let degenerateTrialCount = 0;
  for (let index = 0; index < variationCount; index += 1) {
    // the last axis varies fastest
    let remainder = index;
    const parameters: Record<string, unknown> = {};
    let applied: unknown = request;
    for (let a = axes.length - 1; a >= 0; a -= 1) {
      const axis = axes[a]!;
      const valueIndex = remainder % axis.values.length;
      remainder = Math.floor(remainder / axis.values.length);
      parameters[axis.path] = axis.values[valueIndex];
    }
    for (const axis of axes) applied = withPath(applied, axis.segments, parameters[axis.path]);
    let run: CrossSectionalBacktestResult;
    try {
      run = crossSectionalBacktest(applied as CrossSectionalBacktestRequest);
    } catch (error) {
      const original = error as { message?: string; code?: string };
      throw new InputError(
        `${functionName}: variation #${index} (${describeParameters(parameters)}) refused — ${original.message ?? String(error)}`,
        {
          code: original.code ?? ErrorCode.InputOutOfRange,
          context: { function: functionName, variation: index, parameters },
        },
      );
    }
    let trialSharpe = 0;
    let trialSharpeDegenerate = false;
    // A variation with no Sharpe — too few returns (a typed refusal) or zero variance (C hygiene:
    // `sharpe: null` beside its diagnostic) — records a 0 trial Sharpe and is flagged degenerate.
    let noSharpe: string | null = null;
    try {
      const statistics = sharpeStatistics(run.returns, { riskFreeRate });
      if (statistics.sharpe === null)
        noSharpe = statistics.diagnostics.warnings[0]?.message ?? 'its returns have zero variance';
      else trialSharpe = statistics.sharpe;
    } catch (error) {
      noSharpe = (error as Error).message;
    }
    if (noSharpe !== null) {
      trialSharpeDegenerate = true;
      degenerateTrialCount += 1;
      warnings.push(
        degenerate(
          `variations[${index}]`,
          `variation #${index} (${describeParameters(parameters)}) has no Sharpe — ${noSharpe}; its trial Sharpe is recorded as 0.`,
          { variation: index, parameters },
        ),
      );
    }
    trialSharpes.push(trialSharpe);
    runs.push(run);
    rows.push({
      index,
      parameters,
      runId: run.runId,
      metrics: summarizeCrossSectionalRun(run),
      trialSharpe,
      trialSharpeDegenerate,
    });
  }

  // ---- the best trial ------------------------------------------------------------------------------
  let best: CrossSectionalBacktestGridResult['best'] = null;
  for (const row of rows) {
    const value = row.metrics[selectionMetric];
    if (value === null || !Number.isFinite(value)) continue;
    if (best === null || value > best.value)
      best = { index: row.index, runId: row.runId, metric: selectionMetric, value };
  }

  // ---- hygiene, verbatim from @insiderfinance/totalfinance/risk --------------------------------------------------------
  const skippedHygiene: GridDiagnostics['skippedHygiene'] = [];
  let protocol: ResearchVerdict | null = null;
  let deflated: DeflatedSharpeResult | null = null;
  let overfitting: BacktestOverfittingProbabilityResult | null = null;
  let splitsUsed: number | null = null;
  const bestRow = best === null ? null : rows[best.index]!;
  if (bestRow === null) {
    skippedHygiene.push({
      block: 'researchProtocol',
      reason: `no variation carries '${selectionMetric}'.`,
    });
    skippedHygiene.push({
      block: 'deflatedSharpe',
      reason: `no variation carries '${selectionMetric}'.`,
    });
  } else if (bestRow.trialSharpeDegenerate) {
    const reason = `the best trial (#${bestRow.index}) has a degenerate return series.`;
    skippedHygiene.push({ block: 'researchProtocol', reason });
    skippedHygiene.push({ block: 'deflatedSharpe', reason });
  } else if (variationCount < 2) {
    // one trial is a pre-registered hypothesis: the protocol's PSR is the verdict, nothing deflates
    protocol = researchProtocol({
      returns: runs[bestRow.index]!.returns,
      confidence,
      periodsPerYear,
      riskFreeRate,
    });
    skippedHygiene.push({
      block: 'deflatedSharpe',
      reason: 'fewer than two variations — there was no selection to deflate.',
    });
  } else {
    const bestReturns = runs[bestRow.index]!.returns;
    protocol = researchProtocol({
      returns: bestReturns,
      trials: { trialSharpes },
      confidence,
      periodsPerYear,
      riskFreeRate,
    });
    deflated = deflatedSharpeRatio(sharpeStatistics(bestReturns, { riskFreeRate }), {
      trialSharpes,
    });
  }
  const periods = runs[0]!.returns.length;
  const aligned = runs.every((run) => run.returns.length === periods);
  if (variationCount < 2) {
    skippedHygiene.push({
      block: 'backtestOverfitting',
      reason: 'fewer than two variations — there was no selection to test.',
    });
  } else if (!aligned) {
    skippedHygiene.push({
      block: 'backtestOverfitting',
      reason: 'the variations produced return series of different lengths.',
    });
  } else {
    const requested = hygiene.splits;
    const chosen = requested ?? (periods >= 16 ? 16 : periods - (periods % 2));
    if (chosen < 4 || periods < chosen) {
      skippedHygiene.push({
        block: 'backtestOverfitting',
        reason: `${periods} periods are fewer than the ${chosen} CSCV blocks${requested === undefined ? '' : ' requested'}.`,
      });
    } else {
      const matrix: number[][] = [];
      for (let t = 0; t < periods; t += 1) matrix.push(runs.map((run) => run.returns[t]!));
      overfitting = probabilityOfBacktestOverfitting(matrix, { splits: chosen });
      splitsUsed = chosen;
    }
  }
  for (const skipped of skippedHygiene) {
    warnings.push(
      degenerate(
        `hygiene.${skipped.block}`,
        `${skipped.block} was not computed: ${skipped.reason}`,
        { block: skipped.block },
      ),
    );
  }

  const sweepId = contentHash({
    axes: axes.map((axis) => ({ path: axis.path, values: axis.values })),
    runIds: rows.map((row) => row.runId),
  });

  return {
    sweepId,
    variations: rows,
    runs,
    best,
    hygiene: {
      trialSharpes,
      researchProtocol: protocol,
      backtestOverfitting: overfitting,
      deflatedSharpe: deflated,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      variationCount,
      maximumVariations,
      selectionMetric,
      periodsPerYear,
      riskFreeRate,
      paths: axes.map((axis) => axis.path),
      hygiene: { splits: splitsUsed, confidence, degenerateTrialSharpe: 0 },
    },
    diagnostics: {
      warnings,
      variationCount,
      degenerateTrialCount,
      skippedHygiene,
    },
  };
}
