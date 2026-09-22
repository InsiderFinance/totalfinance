/**
 * Stage 4.6 slice 6 (FC8 Decision 4, exit gate "walk-forward and purged cross-validation over the
 * new engines") — out-of-sample evaluation of a cross-sectional grid.
 *
 * A cross-sectional strategy has no fitted state, so "training" means CHOOSING a variation: on
 * every training window the grid runs and its selection metric picks one point; that point is
 * then run once on the held-out window, and only the held-out numbers are reported as the
 * strategy's. Both verbs compose `crossSectionalBacktestGrid` and `crossSectionalBacktest`
 * verbatim — a window is the engine's own `window`, cut at the dataset's session instants — and
 * `crossSectionalPurgedFolds` takes its folds from `@insiderfinance/totalfinance/risk`'s `purgedKFold`, purge gap and
 * embargo included, so a train segment never touches the sessions whose returns it would be
 * judged on.
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  WarningCode,
  ensureKnownKeys,
  requireArgumentObject,
  warning,
  type QuantWarning,
} from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import { analyze, type PerformanceSummary } from '@totalfinance/performance';
import { purgedKFold } from '@totalfinance/risk';
import { crossSectionalBacktest, sessionInstant } from './engine.js';
import {
  crossSectionalBacktestGrid,
  requireCrossSectionalBacktestGridRequest,
  summarizeCrossSectionalRun,
  withPath,
  type CrossSectionalBacktestGridRequest,
  type CrossSectionalBacktestGridResult,
  type GridSelectionMetric,
  type GridSummaryMetrics,
} from './grid.js';
import type { CrossSectionalBacktestRequest, CrossSectionalBacktestResult } from './types.js';

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

/** A contiguous run of dataset sessions, inclusive on both ends, in session-index space. */
export interface SessionSpan {
  /** Index of the first session in the span (0 = the dataset's first session inside the base window). */
  fromSessionIndex: number;
  toSessionIndex: number;
  fromSessionDate: string;
  toSessionDate: string;
  sessionCount: number;
}

/** One out-of-sample window: the choice made on the training span and how it fared on the test span. */
export interface OutOfSampleWindowRow {
  index: number;
  train: SessionSpan[];
  test: SessionSpan;
  /** The grid's best trial on the training span(s), or `null` when no variation carried the metric there. */
  chosen: {
    variationIndex: number;
    parameters: Record<string, unknown>;
    trainMetric: number;
  } | null;
  /** The held-out run of the chosen variation; `null` when nothing could be chosen. */
  testMetric: number | null;
  testMetrics: GridSummaryMetrics | null;
  /** The chosen variation's held-out run id — replayable through `@insiderfinance/totalfinance/backtest/artifacts`. */
  testRunId: string | null;
  /** The training sweep ids, one per contiguous training segment. */
  trainSweepIds: string[];
}

export interface OutOfSampleHygiene {
  windowCount: number;
  /** Windows where a variation could be chosen and evaluated. */
  evaluatedWindowCount: number;
  /** Mean selection metric on the training spans, over evaluated windows. */
  meanTrainMetric: number | null;
  /** Mean selection metric on the held-out spans, over evaluated windows. */
  meanTestMetric: number | null;
  /** `meanTrainMetric − meanTestMetric` — how much the in-sample choice flattered the strategy. */
  degradation: number | null;
  /** Fraction of evaluated windows whose held-out metric was below zero. */
  negativeTestFraction: number | null;
}

export interface OutOfSampleAssumptions {
  conventionsVersion: string;
  selectionMetric: GridSelectionMetric;
  periodsPerYear: number;
  /** Total sessions of the base request inside its window. */
  sessionCount: number;
  /** How held-out returns were stitched: in window order, each test span's per-session returns appended. */
  stitching: string;
  /** The rule for which sessions each window could see. */
  visibility: string;
}

export interface OutOfSampleDiagnostics {
  warnings: QuantWarning[];
  /** Windows skipped because a span had fewer than two sessions after purging. */
  skippedWindowCount: number;
}

/**
 * The grid's members inline (`request`, `variations`, `maximumVariations`, `selectionMetric`,
 * `hygiene`) plus the walk-forward plan — one object, the same shape a grid call takes, so the
 * cross-sectional request sits where every declaration walker and fixture already reads it.
 */
export interface CrossSectionalWalkForwardRequest extends CrossSectionalBacktestGridRequest {
  /** Sessions in each training span (≥ 2). */
  trainSessions: number;
  /** Sessions in each held-out span (≥ 2). */
  testSessions: number;
  /** Sessions the window advances by; default `testSessions` (adjacent, non-overlapping held-out spans). */
  step?: number;
  /** `'rolling'` (default): training spans slide; `'anchored'`: every training span starts at the first session. */
  mode?: 'rolling' | 'anchored';
}

/** The grid's members inline plus the fold plan (see {@link CrossSectionalWalkForwardRequest}). */
export interface CrossSectionalPurgedFoldsRequest extends CrossSectionalBacktestGridRequest {
  /** Folds (≥ 2, ≤ sessions ÷ 2 so every held-out span carries two sessions). */
  folds: number;
  /** `purgedKFold`'s embargo fraction (default 0). */
  embargo?: number;
  /** `purgedKFold`'s purge gap in sessions on each side of a held-out span (default 0). */
  purgeGap?: number;
}

export interface CrossSectionalOutOfSampleResult {
  /** The content hash of the procedure: the grid axes, the fold plan, and every held-out run id. */
  evaluationId: string;
  windows: OutOfSampleWindowRow[];
  /** Every held-out run, index-aligned with the evaluated windows (`windows[i].testRunId !== null`). */
  runs: CrossSectionalBacktestResult[];
  /** Held-out per-session returns stitched in window order. */
  returns: number[];
  /** The performance block of the stitched held-out returns; `null` under two returns. */
  performance: PerformanceSummary | null;
  hygiene: OutOfSampleHygiene;
  assumptions: OutOfSampleAssumptions;
  diagnostics: OutOfSampleDiagnostics;
}

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

const GRID_KEYS = [
  'request',
  'variations',
  'maximumVariations',
  'selectionMetric',
  'hygiene',
] as const;
const WALK_FORWARD_KEYS = [...GRID_KEYS, 'trainSessions', 'testSessions', 'step', 'mode'] as const;
const PURGED_KEYS = [...GRID_KEYS, 'folds', 'embargo', 'purgeGap'] as const;
const WALK_FORWARD_EXAMPLE =
  "crossSectionalWalkForward({ request, variations: [{ path: 'portfolioConstruction.long.count', values: [10, 20] }], trainSessions: 60, testSessions: 20 })";
const PURGED_EXAMPLE =
  "crossSectionalPurgedFolds({ request, variations: [{ path: 'portfolioConstruction.long.count', values: [10, 20] }], folds: 4, purgeGap: 1 })";

/** Ceiling on windows one call may run — each window is a grid run plus a held-out run. */
export const CROSS_SECTIONAL_WINDOW_CEILING = 1_000;

function refuse(
  functionName: string,
  field: string,
  message: string,
  code: ErrorCode,
  context: Record<string, unknown>,
  example: string,
): never {
  throw new InputError(`${functionName}: ${field} ${message} Example: ${example}`, {
    code,
    context: { function: functionName, field, ...context },
  });
}

function requireSessionCount(
  functionName: string,
  field: string,
  value: unknown,
  minimum: number,
  example: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    refuse(
      functionName,
      field,
      `must be a finite integer ≥ ${minimum} (a count of sessions). Received ${JSON.stringify(value)}.`,
      typeof value === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
      { received: value },
      example,
    );
  }
  if (!Number.isSafeInteger(value) || value < minimum) {
    refuse(
      functionName,
      field,
      `must be an integer ≥ ${minimum}. Received ${value}.`,
      ErrorCode.InputOutOfRange,
      { received: value, minimum },
      example,
    );
  }
  return value;
}

/** The grid members of an out-of-sample request, validated by the grid's own guard. */
function gridOf(
  functionName: string,
  label: string,
  request: Record<string, unknown>,
): CrossSectionalBacktestGridRequest {
  const example =
    functionName === 'crossSectionalWalkForward' ? WALK_FORWARD_EXAMPLE : PURGED_EXAMPLE;
  if (request['request'] === undefined) {
    refuse(
      functionName,
      `${label}.request`,
      'is required: the base cross-sectional request the variations are applied to.',
      ErrorCode.InputMissingField,
      {},
      example,
    );
  }
  if (request['variations'] === undefined) {
    refuse(
      functionName,
      `${label}.variations`,
      'is required: the axes each training span chooses from (one axis with one value runs a fixed strategy).',
      ErrorCode.InputMissingField,
      {},
      example,
    );
  }
  const grid: Record<string, unknown> = {};
  for (const key of GRID_KEYS) if (request[key] !== undefined) grid[key] = request[key];
  return requireCrossSectionalBacktestGridRequest(functionName, label, grid);
}

/** The boundary guard for {@link crossSectionalWalkForward}; the grid is validated by the grid's own guard. */
export function requireCrossSectionalWalkForwardRequest(
  functionName: string,
  label: string,
  value: unknown,
): CrossSectionalWalkForwardRequest {
  requireArgumentObject(functionName, label, value);
  const request = value as Record<string, unknown>;
  ensureKnownKeys(functionName, label, request, WALK_FORWARD_KEYS);
  const grid = gridOf(functionName, label, request);
  const trainSessions = requireSessionCount(
    functionName,
    `${label}.trainSessions`,
    request['trainSessions'],
    2,
    WALK_FORWARD_EXAMPLE,
  );
  const testSessions = requireSessionCount(
    functionName,
    `${label}.testSessions`,
    request['testSessions'],
    2,
    WALK_FORWARD_EXAMPLE,
  );
  const step =
    request['step'] === undefined
      ? testSessions
      : requireSessionCount(
          functionName,
          `${label}.step`,
          request['step'],
          1,
          WALK_FORWARD_EXAMPLE,
        );
  // `undefined` means the default; `null` is a wrong value and is refused with the enum.
  const mode = request['mode'] === undefined ? 'rolling' : request['mode'];
  if (mode !== 'rolling' && mode !== 'anchored') {
    refuse(
      functionName,
      `${label}.mode`,
      `must be 'rolling' | 'anchored'. Received ${JSON.stringify(mode)}.`,
      ErrorCode.InputInvalidEnum,
      { received: mode },
      WALK_FORWARD_EXAMPLE,
    );
  }
  return { ...grid, trainSessions, testSessions, step, mode };
}

/** The boundary guard for {@link crossSectionalPurgedFolds}. */
export function requireCrossSectionalPurgedFoldsRequest(
  functionName: string,
  label: string,
  value: unknown,
): CrossSectionalPurgedFoldsRequest {
  requireArgumentObject(functionName, label, value);
  const request = value as Record<string, unknown>;
  ensureKnownKeys(functionName, label, request, PURGED_KEYS);
  const grid = gridOf(functionName, label, request);
  const folds = requireSessionCount(
    functionName,
    `${label}.folds`,
    request['folds'],
    2,
    PURGED_EXAMPLE,
  );
  const out: CrossSectionalPurgedFoldsRequest = { ...grid, folds };
  for (const field of ['embargo', 'purgeGap'] as const) {
    const raw = request[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      refuse(
        functionName,
        `${label}.${field}`,
        `must be a finite number ≥ 0. Received ${JSON.stringify(raw)}.`,
        typeof raw === 'number' && !Number.isFinite(raw)
          ? ErrorCode.InputNotFinite
          : ErrorCode.InputOutOfRange,
        { received: raw },
        PURGED_EXAMPLE,
      );
    }
    if (field === 'purgeGap' && !Number.isSafeInteger(raw)) {
      refuse(
        functionName,
        `${label}.purgeGap`,
        `must be an integer count of sessions. Received ${raw}.`,
        ErrorCode.InputOutOfRange,
        { received: raw },
        PURGED_EXAMPLE,
      );
    }
    out[field] = raw;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Sessions and windows
// ---------------------------------------------------------------------------------------------------

/** The base request's sessions: the sorted unique return dates inside its window — the engine's own calendar. */
function baseSessions(request: CrossSectionalBacktestRequest): string[] {
  const from = request.window?.fromTimestampMs;
  const to = request.window?.toTimestampMs;
  const session = request.rebalanceSchedule.session;
  return [...new Set(request.dataset.returns.map((r) => r.tradingSessionDate))]
    .sort()
    .filter((date) => {
      const instant = sessionInstant(date, session);
      return (from === undefined || instant >= from) && (to === undefined || instant <= to);
    });
}

function span(dates: readonly string[], from: number, to: number): SessionSpan {
  return {
    fromSessionIndex: from,
    toSessionIndex: to,
    fromSessionDate: dates[from]!,
    toSessionDate: dates[to]!,
    sessionCount: to - from + 1,
  };
}

/** Contiguous runs of a sorted index list, each with at least `minimum` sessions. */
function contiguousSpans(
  dates: readonly string[],
  indices: readonly number[],
  minimum: number,
): { spans: SessionSpan[]; dropped: number } {
  const spans: SessionSpan[] = [];
  let dropped = 0;
  let start = -1;
  let previous = -1;
  const flush = (): void => {
    if (start < 0) return;
    if (previous - start + 1 >= minimum) spans.push(span(dates, start, previous));
    else dropped += 1;
  };
  for (const index of indices) {
    if (start >= 0 && index === previous + 1) {
      previous = index;
      continue;
    }
    flush();
    start = index;
    previous = index;
  }
  flush();
  return { spans, dropped };
}

/**
 * The engine's `window` for a span: from the first session's OPEN to the last session's CLOSE, so
 * the same dates stay inside the window whichever session instant a variation decides on (a grid
 * may vary `rebalanceSchedule.session`; the previous date's close and the next date's open lie
 * outside either bound).
 */
function windowOf(
  request: CrossSectionalBacktestRequest,
  dates: readonly string[],
  s: SessionSpan,
): CrossSectionalBacktestRequest {
  return {
    ...request,
    window: {
      fromTimestampMs: sessionInstant(dates[s.fromSessionIndex]!, 'open'),
      toTimestampMs: sessionInstant(dates[s.toSessionIndex]!, 'close'),
    },
  };
}

function applyParameters(
  request: CrossSectionalBacktestRequest,
  parameters: Record<string, unknown>,
): CrossSectionalBacktestRequest {
  let applied: unknown = request;
  for (const [path, value] of Object.entries(parameters)) {
    applied = withPath(applied, path.split('.'), value);
  }
  return applied as CrossSectionalBacktestRequest;
}

// ---------------------------------------------------------------------------------------------------
// The shared procedure
// ---------------------------------------------------------------------------------------------------

interface WindowPlan {
  train: SessionSpan[];
  test: SessionSpan;
}

interface Procedure {
  functionName: string;
  grid: CrossSectionalBacktestGridRequest;
  plan: WindowPlan[];
  planIdentity: Record<string, unknown>;
  visibility: string;
  skippedWindowCount: number;
  warnings: QuantWarning[];
}

/** Sum the metric over pooled training segments: an equity curve stitched from each segment's returns. */
function pooledMetric(input: {
  segments: readonly CrossSectionalBacktestGridResult[];
  variationIndex: number;
  metric: GridSelectionMetric;
  periodsPerYear: number;
  riskFreeRate: number;
}): number | null {
  const { segments, variationIndex, metric, periodsPerYear, riskFreeRate } = input;
  if (segments.length === 1) return segments[0]!.variations[variationIndex]!.metrics[metric];
  const returns: number[] = [];
  for (const segment of segments) returns.push(...segment.runs[variationIndex]!.returns);
  if (returns.length < 2) return null;
  return analyze({ returns }, { periodsPerYear, riskFreeRate })[metric];
}

function evaluate(procedure: Procedure): CrossSectionalOutOfSampleResult {
  const { functionName, grid, plan, warnings } = procedure;
  const base = grid.request;
  const dates = baseSessions(base);
  const selectionMetric = grid.selectionMetric ?? 'sharpe';
  const periodsPerYear = base.periodsPerYear ?? 252;
  const riskFreeRate = base.riskFreeRate ?? 0;
  const windows: OutOfSampleWindowRow[] = [];
  const runs: CrossSectionalBacktestResult[] = [];
  const stitched: number[] = [];
  const trainMetrics: number[] = [];
  const testMetrics: number[] = [];

  plan.forEach((window, index) => {
    // ---- choose on the training span(s) ------------------------------------------------------------
    const segments = window.train.map((s) =>
      crossSectionalBacktestGrid({ ...grid, request: windowOf(base, dates, s) }),
    );
    const variationCount = segments[0]?.variations.length ?? 0;
    let chosen: OutOfSampleWindowRow['chosen'] = null;
    for (let v = 0; v < variationCount; v += 1) {
      const value = pooledMetric({
        segments,
        variationIndex: v,
        metric: selectionMetric,
        periodsPerYear,
        riskFreeRate,
      });
      if (value === null || !Number.isFinite(value)) continue;
      if (chosen === null || value > chosen.trainMetric) {
        chosen = {
          variationIndex: v,
          parameters: segments[0]!.variations[v]!.parameters,
          trainMetric: value,
        };
      }
    }
    const row: OutOfSampleWindowRow = {
      index,
      train: window.train,
      test: window.test,
      chosen,
      testMetric: null,
      testMetrics: null,
      testRunId: null,
      trainSweepIds: segments.map((s) => s.sweepId),
    };
    if (chosen === null) {
      warnings.push(
        warning(
          WarningCode.DegenerateInput,
          `${functionName}: window ${index} chose nothing — no variation carried '${selectionMetric}' on its training span${window.train.length === 1 ? '' : 's'}; the window is reported without a held-out run.`,
          'warn',
          { field: 'request.grid', window: index },
        ),
      );
      windows.push(row);
      return;
    }
    // ---- evaluate on the held-out span ---------------------------------------------------------------
    const run = crossSectionalBacktest(
      applyParameters(windowOf(base, dates, window.test), chosen.parameters),
    );
    const metrics = summarizeCrossSectionalRun(run);
    row.testMetric = metrics[selectionMetric];
    row.testMetrics = metrics;
    row.testRunId = run.runId;
    runs.push(run);
    stitched.push(...run.returns);
    trainMetrics.push(chosen.trainMetric);
    if (row.testMetric !== null) testMetrics.push(row.testMetric);
    windows.push(row);
  });

  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  const meanTrainMetric = mean(trainMetrics);
  const meanTestMetric = mean(testMetrics);
  const performance =
    stitched.length >= 2 ? analyze({ returns: stitched }, { periodsPerYear, riskFreeRate }) : null;
  const evaluated = windows.filter((w) => w.testRunId !== null);

  return {
    evaluationId: contentHash({
      function: functionName,
      axes: grid.variations,
      plan: procedure.planIdentity,
      runIds: evaluated.map((w) => w.testRunId),
    }),
    windows,
    runs,
    returns: stitched,
    performance,
    hygiene: {
      windowCount: windows.length,
      evaluatedWindowCount: evaluated.length,
      meanTrainMetric,
      meanTestMetric,
      degradation:
        meanTrainMetric !== null && meanTestMetric !== null
          ? meanTrainMetric - meanTestMetric
          : null,
      negativeTestFraction:
        testMetrics.length === 0
          ? null
          : testMetrics.filter((m) => m < 0).length / testMetrics.length,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      selectionMetric,
      periodsPerYear,
      sessionCount: dates.length,
      stitching:
        'held-out per-session simple returns appended in window order; the stitched curve is the strategy as it would have been held, choice by choice',
      visibility: procedure.visibility,
    },
    diagnostics: { warnings, skippedWindowCount: procedure.skippedWindowCount },
  };
}

// ---------------------------------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------------------------------

/**
 * Walk a cross-sectional grid forward: on every training span the grid picks a variation by its
 * selection metric; that variation runs once on the following held-out span; the held-out returns
 * are stitched in order. Rolling (default) or anchored training spans; `step` defaults to
 * `testSessions` so held-out spans tile the data without overlap.
 */
export function crossSectionalWalkForward(
  request: CrossSectionalWalkForwardRequest,
): CrossSectionalOutOfSampleResult {
  const functionName = 'crossSectionalWalkForward';
  const { trainSessions, testSessions, step, mode, ...grid } =
    requireCrossSectionalWalkForwardRequest(functionName, 'request', request);
  const dates = baseSessions(grid.request);
  if (dates.length < trainSessions + testSessions) {
    refuse(
      functionName,
      'request',
      `needs at least trainSessions + testSessions = ${trainSessions + testSessions} sessions inside the base window; the dataset carries ${dates.length}.`,
      ErrorCode.InputOutOfRange,
      { sessionCount: dates.length, trainSessions, testSessions },
      WALK_FORWARD_EXAMPLE,
    );
  }
  const plan: WindowPlan[] = [];
  for (let trainEnd = trainSessions; trainEnd + testSessions <= dates.length; trainEnd += step!) {
    const trainStart = mode === 'anchored' ? 0 : trainEnd - trainSessions;
    plan.push({
      train: [span(dates, trainStart, trainEnd - 1)],
      test: span(dates, trainEnd, trainEnd + testSessions - 1),
    });
    if (plan.length > CROSS_SECTIONAL_WINDOW_CEILING) {
      refuse(
        functionName,
        'request',
        `would run more than ${CROSS_SECTIONAL_WINDOW_CEILING} windows — raise step or testSessions.`,
        ErrorCode.BacktestGridTooLarge,
        { windowCount: plan.length, ceiling: CROSS_SECTIONAL_WINDOW_CEILING },
        WALK_FORWARD_EXAMPLE,
      );
    }
  }
  return evaluate({
    functionName,
    grid,
    plan,
    planIdentity: { trainSessions, testSessions, step, mode },
    visibility: `${mode} training spans of ${trainSessions} sessions choose; the next ${testSessions} sessions are held out; a window sees no session after its training span`,
    skippedWindowCount: 0,
    warnings: [],
  });
}

/**
 * Purged k-fold evaluation of a cross-sectional grid: `purgedKFold` over the session index gives
 * every fold a held-out block, a purge gap on each side, and an embargo after it; the grid chooses
 * a variation on the remaining (possibly two-segment) training sessions, pooled into one curve;
 * the choice runs once on the held-out block. Training segments left with fewer than two sessions
 * after purging are dropped with a warning.
 */
export function crossSectionalPurgedFolds(
  request: CrossSectionalPurgedFoldsRequest,
): CrossSectionalOutOfSampleResult {
  const functionName = 'crossSectionalPurgedFolds';
  const {
    folds,
    embargo = 0,
    purgeGap = 0,
    ...grid
  } = requireCrossSectionalPurgedFoldsRequest(functionName, 'request', request);
  const dates = baseSessions(grid.request);
  if (folds * 2 > dates.length) {
    refuse(
      functionName,
      'request.folds',
      `must leave every held-out block at least two sessions: folds ≤ ${Math.floor(dates.length / 2)} for ${dates.length} sessions. Received ${folds}.`,
      ErrorCode.InputOutOfRange,
      { folds, sessionCount: dates.length },
      PURGED_EXAMPLE,
    );
  }
  const splits = purgedKFold(dates.length, { folds, embargo, purgeGap });
  const warnings: QuantWarning[] = [];
  const plan: WindowPlan[] = [];
  let skippedWindowCount = 0;
  splits.forEach((split, index) => {
    const test = contiguousSpans(dates, split.test, 2);
    const train = contiguousSpans(dates, split.train, 2);
    if (test.spans.length !== 1 || train.spans.length === 0) {
      skippedWindowCount += 1;
      warnings.push(
        warning(
          WarningCode.DegenerateInput,
          `${functionName}: fold ${index} was skipped — ${test.spans.length !== 1 ? 'its held-out block is not one span of two or more sessions' : 'no training segment kept two sessions after purging'}.`,
          'warn',
          { field: 'request.folds', fold: index, purgeGap, embargo },
        ),
      );
      return;
    }
    if (train.dropped > 0) {
      warnings.push(
        warning(
          WarningCode.DegenerateInput,
          `${functionName}: fold ${index} dropped ${train.dropped} training segment${train.dropped === 1 ? '' : 's'} with fewer than two sessions after purging.`,
          'warn',
          { field: 'request.folds', fold: index, dropped: train.dropped },
        ),
      );
    }
    plan.push({ train: train.spans, test: test.spans[0]! });
  });
  if (plan.length === 0) {
    refuse(
      functionName,
      'request',
      `left no fold with a two-session held-out block and a two-session training segment — lower purgeGap/embargo or folds.`,
      ErrorCode.InputOutOfRange,
      { folds, purgeGap, embargo, sessionCount: dates.length },
      PURGED_EXAMPLE,
    );
  }
  return evaluate({
    functionName,
    grid,
    plan,
    planIdentity: { folds, embargo, purgeGap },
    visibility: `purged ${folds}-fold over the session index (purgeGap ${purgeGap} sessions, embargo ${embargo}); a fold's training sessions never include its held-out block, its purge gap, or its embargo`,
    skippedWindowCount,
    warnings,
  });
}
