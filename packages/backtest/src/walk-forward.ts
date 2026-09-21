/**
 * Walk-forward evaluation (spec §16.2).
 *
 * Slides a (train, test) window across the bars and runs the supplied backtest on each *test* window,
 * then stitches the out-of-sample segments into one continuous equity curve. The strategy can use the
 * train window to fit parameters; only the test segments contribute to the reported performance, so
 * the result is genuinely out-of-sample.
 */

import {
  type Diagnostics,
  ErrorCode,
  type EpochMs,
  InputError,
  type QuantWarning,
  ensureKnownKeys,
  missingFieldError,
} from '@totalfinance/core';
import { analyze } from '@totalfinance/performance';
import type { PerformanceSummary } from '@totalfinance/performance';
import type { Bar, BacktestAssumptions, BacktestResult } from './types.js';
import { requireBarData } from './validate.js';

export interface WalkForwardWindow {
  train: Bar[];
  test: Bar[];
}

export interface WalkForwardOptions {
  /** Bars in ascending time order (one symbol, or a pre-sorted multi-symbol stream). */
  data: Bar[];
  /** Training window length in bars. */
  trainSize: number;
  /** Test (out-of-sample) window length in bars. */
  testSize: number;
  /** Step between successive windows (default `testSize`, i.e. non-overlapping test windows). */
  step?: number;
  /** `rolling` (sliding train window) or `anchored` (train grows from the start). Default `rolling`. */
  mode?: 'rolling' | 'anchored';
  /** Run a backtest over a window; return its out-of-sample result. */
  run: (window: WalkForwardWindow) => BacktestResult;
  /** Bars per year for the stitched performance (default 252). */
  periodsPerYear?: number;
}

/** A per-window out-of-sample result, tagged with the train/test time ranges it covered (WS2.8). */
export interface WalkForwardWindowResult extends BacktestResult {
  /** `[firstTrainBarTs, lastTrainBarTs]`. */
  trainRange: [EpochMs, EpochMs];
  /** `[firstTestBarTs, lastTestBarTs]`. */
  testRange: [EpochMs, EpochMs];
}

export interface WalkForwardResult {
  /** The per-window out-of-sample results, in order, each tagged with its train/test ranges. */
  windows: WalkForwardWindowResult[];
  /** Out-of-sample equity stitched across all test windows (starts at 1). */
  equityCurve: number[];
  /** Performance of the stitched out-of-sample curve. */
  performance: PerformanceSummary;
  /**
   * The echoed modelling assumptions, identical across windows (same engine/config) — taken from the
   * first window, so the walk-forward artifact carries the same honesty story as a single backtest
   * (WS2.8 / dx §2.5).
   */
  assumptions: BacktestAssumptions;
  /** Core diagnostics: the union of every window's warnings, deduped by code + message (WS2.8). */
  diagnostics: Diagnostics;
}

/** EXACT {@link WalkForwardOptions} fields (Law 12) — unknown keys are rejected, never ignored. */
const WALK_FORWARD_KEYS = [
  'data',
  'trainSize',
  'testSize',
  'step',
  'mode',
  'run',
  'periodsPerYear',
] as const;

/** Run a walk-forward evaluation. */
export function walkForward(options: WalkForwardOptions): WalkForwardResult {
  const functionName = 'walkForward';
  requireBarData(options, functionName, '{ data: Bar[], trainSize, testSize, run, … }');
  ensureKnownKeys(functionName, 'options', options, WALK_FORWARD_KEYS);
  // Guard the function option at the boundary: a missing `run` used to surface as a raw
  // "options.run is not a function" TypeError mid-loop. Teach the field and a working call (dx §1.1).
  if (typeof options.run !== 'function') {
    throw missingFieldError(
      functionName,
      'run',
      'walkForward({ data, trainSize: 30, testSize: 10, run: ({ test }) => backtest.vectorized({ data: test, signal: test.map(() => true) }) })',
    );
  }
  const n = options.data.length;
  const { trainSize, testSize } = options;
  // Safe integers (2026-08-23 review, P0): the window loop's condition (`trainEnd + testSize ≤ n`)
  // keeps every slice data-bounded, but above 2^53 these counts are no longer exact and
  // `trainEnd += step` can stop advancing — the safe gate keeps the arithmetic real.
  if (!Number.isSafeInteger(trainSize) || trainSize < 1) {
    throw new InputError(
      `${functionName}: trainSize must be a positive integer, got ${trainSize}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { trainSize },
      },
    );
  }
  if (!Number.isSafeInteger(testSize) || testSize < 2) {
    throw new InputError(`${functionName}: testSize must be an integer ≥ 2, got ${testSize}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { testSize },
    });
  }
  if (
    (options as unknown as Record<string, unknown>)['step'] !== undefined &&
    (typeof (options as unknown as Record<string, unknown>)['step'] !== 'number' ||
      !Number.isFinite((options as unknown as Record<string, unknown>)['step'] as number))
  ) {
    throw new InputError(
      `walkForward: step must be a finite number when provided. Received ${(options as unknown as Record<string, unknown>)['step'] === null ? 'null' : typeof (options as unknown as Record<string, unknown>)['step']}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'step' } },
    );
  }
  const step = options.step ?? testSize;
  // Safe integer (2026-08-23 review, P0): see trainSize/testSize above — `trainEnd += step` must
  // actually advance.
  if (!Number.isSafeInteger(step) || step < 1) {
    throw new InputError(`${functionName}: step must be a positive integer, got ${step}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { step },
    });
  }
  if (options.mode !== undefined && options.mode !== 'rolling' && options.mode !== 'anchored') {
    throw new InputError(
      `walkForward: mode must be 'rolling' | 'anchored' when provided. Received ${options.mode === null ? 'null' : JSON.stringify(options.mode)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'mode' } },
    );
  }
  const mode = options.mode ?? 'rolling';
  if (mode !== 'rolling' && mode !== 'anchored') {
    throw new InputError(`${functionName}: mode must be 'rolling' or 'anchored', got "${mode}".`, {
      code: ErrorCode.InputInvalidEnum,
      context: { mode },
    });
  }

  const windows: WalkForwardWindowResult[] = [];
  const stitched: number[] = [1];
  for (let trainEnd = trainSize; trainEnd + testSize <= n; trainEnd += step) {
    const trainStart = mode === 'anchored' ? 0 : trainEnd - trainSize;
    const train = options.data.slice(trainStart, trainEnd);
    const test = options.data.slice(trainEnd, trainEnd + testSize);
    const res = options.run({ train, test });
    // A run() that returns garbage would fail deep inside the stitcher with a raw TypeError —
    // teach the contract at the boundary instead (it must return a BacktestResult, i.e. the
    // output of vectorized()/eventDriven() on the window).
    if (
      res === null ||
      typeof res !== 'object' ||
      !Array.isArray((res as { returns?: unknown }).returns)
    ) {
      throw new InputError(
        `walkForward: options.run must return a BacktestResult (the output of vectorized()/eventDriven() on the window) — got ${res === null ? 'null' : typeof res}.`,
        { code: ErrorCode.InputWrongType, context: { window: windows.length } },
      );
    }
    windows.push({
      ...res,
      trainRange: [train[0]!.timestampMs, train[train.length - 1]!.timestampMs],
      testRange: [test[0]!.timestampMs, test[test.length - 1]!.timestampMs],
    });
    // compound this window's out-of-sample returns onto the stitched curve
    for (const r of res.returns) stitched.push(stitched[stitched.length - 1]! * (1 + r));
  }

  if (windows.length === 0) {
    throw new InputError(
      `${functionName}: no walk-forward windows fit (${n} bars, trainSize ${trainSize}, testSize ${testSize}).`,
      { code: ErrorCode.InputOutOfRange, context: { observations: n, trainSize, testSize } },
    );
  }

  // Aggregate: assumptions are identical across windows (same engine/config) — take the first;
  // union the warnings, deduped by code+message so a leakage/alignment flag surfaces once.
  const seen = new Set<string>();
  const warnings: QuantWarning[] = [];
  for (const w of windows) {
    for (const warn of w.diagnostics.warnings) {
      const key = `${warn.code}|${warn.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        warnings.push(warn);
      }
    }
  }

  if (
    options.periodsPerYear !== undefined &&
    (typeof options.periodsPerYear !== 'number' || !Number.isFinite(options.periodsPerYear))
  ) {
    throw new InputError(
      `walkForward: periodsPerYear must be a finite number when provided. Received ${options.periodsPerYear === null ? 'null' : typeof options.periodsPerYear}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'periodsPerYear' } },
    );
  }
  return {
    windows,
    equityCurve: stitched,
    performance: analyze({ equity: stitched }, { periodsPerYear: options.periodsPerYear ?? 252 }),
    assumptions: windows[0]!.assumptions,
    diagnostics: { warnings },
  };
}
