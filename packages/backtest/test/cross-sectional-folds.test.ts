/**
 * Stage 4.6 slice 6 — `crossSectionalWalkForward` and `crossSectionalPurgedFolds`: each window's
 * choice equals a direct grid run on the training span, each held-out run equals a direct
 * `crossSectionalBacktest` with the chosen parameters on the test span, the stitched returns are
 * the held-out returns in order, no window sees a session past its training span, the purged
 * folds honour the gap and the embargo, and every malformed request teaches.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode, WarningCode } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import {
  type CrossSectionalBacktestRequest,
  crossSectionalBacktest,
  crossSectionalBacktestGrid,
  crossSectionalPurgedFolds,
  crossSectionalWalkForward,
} from '@totalfinance/backtest';
import {
  CROSS_SECTIONAL_WINDOW_CEILING,
  requireCrossSectionalPurgedFoldsRequest,
  requireCrossSectionalWalkForwardRequest,
} from '@totalfinance/backtest/cross-sectional';
import { purgedKFold } from '@totalfinance/risk';
import type {
  FieldDefinition,
  ReturnObservation,
  UniverseObservation,
} from '@totalfinance/research';

const DAY = 86_400_000;
const NAMES = ['AAA', 'BBB', 'CCC', 'DDD'] as const;
const fieldDefinitions: FieldDefinition[] = [{ fieldName: 'quality', kind: 'numeric' }];

/** `count` weekly Friday sessions from 2026-01-02. */
function sessions(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(new Date(Date.UTC(2026, 0, 2) + i * 7 * DAY).toISOString().slice(0, 10));
  }
  return out;
}

function returnsFor(dates: readonly string[]): ReturnObservation[] {
  const drift: Record<string, number> = { AAA: 0.02, BBB: 0.005, CCC: -0.01, DDD: -0.02 };
  const rows: ReturnObservation[] = [];
  for (const instrumentId of NAMES) {
    dates.forEach((tradingSessionDate, i) => {
      rows.push({
        instrumentId,
        tradingSessionDate,
        simpleReturn:
          drift[instrumentId]! + ((i * 7 + instrumentId.charCodeAt(0)) % 5) * 0.002 - 0.004,
      });
    });
  }
  return rows;
}

function observations(): UniverseObservation[] {
  const quality: Record<string, number> = { AAA: 4, BBB: 3, CCC: 2, DDD: 1 };
  return NAMES.map((instrumentId) => ({
    instrumentId,
    availableTimestampMs: Date.UTC(2026, 0, 1),
    fields: { quality: quality[instrumentId]! },
  }));
}

function request(sessionCount = 24): CrossSectionalBacktestRequest {
  const dates = sessions(sessionCount);
  return {
    dataset: { observations: observations(), fieldDefinitions, returns: returnsFor(dates) },
    universeHistory: {
      universeId: 'folds-4',
      members: NAMES.map((instrumentId) => ({
        instrumentId,
        fromTimestampMs: Date.UTC(2026, 0, 1),
      })),
    },
    signal: {
      score: {
        components: [
          {
            field: 'quality',
            weight: 1,
            direction: 'higher-is-better',
            standardization: 'z-score',
          },
        ],
        missingValuePolicy: 'exclude',
      },
    },
    rebalanceSchedule: { frequency: 'weekly', session: 'close' },
    portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
    initialCapital: 100_000,
  };
}

const AXES = [{ path: 'portfolioConstruction.long.count', values: [1, 2, 3] }];
// The engine's close-session instant (21:00 UTC, the US equity close) — a window cuts where the engine does.
const CLOSE_MS = 21 * 3_600_000;
const closeOf = (date: string): number => Date.parse(`${date}T00:00:00Z`) + CLOSE_MS;
// A span's window runs from its first session's OPEN (14:30 UTC) to its last session's CLOSE.
const openOf = (date: string): number => Date.parse(`${date}T00:00:00Z`) + 14.5 * 3_600_000;

const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('crossSectionalWalkForward — choose on the training span, report the held-out span', () => {
  it('tiles the sessions: rolling windows, each choice a direct grid run and each held-out run a direct call', () => {
    const dates = sessions(24);
    const result = crossSectionalWalkForward({
      request: request(24),
      variations: AXES,
      trainSessions: 8,
      testSessions: 4,
    });
    // 24 sessions, train 8, test 4, step 4 → windows at trainEnd = 8, 12, 16, 20 (20 + 4 = 24 fits)
    expect(result.windows).toHaveLength(4);
    expect(result.hygiene.windowCount).toBe(4);
    expect(result.hygiene.evaluatedWindowCount).toBe(4);
    expect(result.runs).toHaveLength(4);
    result.windows.forEach((window, i) => {
      const trainStart = i * 4;
      expect(window.train).toEqual([
        {
          fromSessionIndex: trainStart,
          toSessionIndex: trainStart + 7,
          fromSessionDate: dates[trainStart],
          toSessionDate: dates[trainStart + 7],
          sessionCount: 8,
        },
      ]);
      expect(window.test.fromSessionIndex).toBe(trainStart + 8);
      expect(window.test.toSessionIndex).toBe(trainStart + 11);
      // the choice equals the direct grid run on the training window
      const direct = crossSectionalBacktestGrid({
        request: {
          ...request(24),
          window: {
            fromTimestampMs: openOf(dates[trainStart]!),
            toTimestampMs: closeOf(dates[trainStart + 7]!),
          },
        },
        variations: AXES,
      });
      expect(window.trainSweepIds).toEqual([direct.sweepId]);
      expect(window.chosen?.variationIndex).toBe(direct.best?.index);
      expect(window.chosen?.trainMetric).toBe(direct.best?.value);
      // the held-out run equals the direct call with the chosen parameters on the test window
      const held = crossSectionalBacktest({
        ...request(24),
        portfolioConstruction: {
          method: 'equal-weight',
          long: { count: window.chosen!.parameters['portfolioConstruction.long.count'] as number },
        },
        window: {
          fromTimestampMs: openOf(dates[trainStart + 8]!),
          toTimestampMs: closeOf(dates[trainStart + 11]!),
        },
      });
      expect(window.testRunId).toBe(held.runId);
      expect(result.runs[i]!.runId).toBe(held.runId);
      expect(window.testMetric).toBe(held.performance.sharpe);
    });
    // stitched returns are the held-out returns in window order
    expect(result.returns).toEqual(result.runs.flatMap((run) => run.returns));
    expect(result.performance?.periods).toBe(result.returns.length);
    expect(result.assumptions.selectionMetric).toBe('sharpe');
    expect(result.assumptions.sessionCount).toBe(24);
    expect(result.assumptions.visibility).toContain('rolling');
    expect(result.evaluationId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('anchors when asked and honours a custom step', () => {
    const anchored = crossSectionalWalkForward({
      request: request(24),
      variations: AXES,
      trainSessions: 8,
      testSessions: 4,
      step: 8,
      mode: 'anchored',
    });
    // trainEnd = 8, 16 (16 + 4 ≤ 24); 24 + 4 > 24 stops
    expect(anchored.windows.map((w) => w.train[0]!.fromSessionIndex)).toEqual([0, 0]);
    expect(anchored.windows.map((w) => w.train[0]!.toSessionIndex)).toEqual([7, 15]);
    expect(anchored.windows.map((w) => w.test.fromSessionIndex)).toEqual([8, 16]);
    expect(anchored.assumptions.visibility).toContain('anchored');
  });

  it('never lets a window see a session past its training span', () => {
    const dates = sessions(24);
    // A restated return series AFTER session 12 must not change the first window's choice.
    const base = request(24);
    const shocked: CrossSectionalBacktestRequest = {
      ...base,
      dataset: {
        ...base.dataset,
        returns: base.dataset.returns.map((row) =>
          row.tradingSessionDate > dates[11]! ? { ...row, simpleReturn: -0.5 } : row,
        ),
      },
    };
    const before = crossSectionalWalkForward({
      request: base,
      variations: AXES,
      trainSessions: 8,
      testSessions: 4,
    });
    const after = crossSectionalWalkForward({
      request: shocked,
      variations: AXES,
      trainSessions: 8,
      testSessions: 4,
    });
    expect(canonicalJsonOf(after.windows[0])).toBe(canonicalJsonOf(before.windows[0]));
    expect(after.windows[1]!.chosen).toEqual(before.windows[1]!.chosen);
    // The run id is the REQUEST's identity (configuration and session span, not the rows), so the
    // restatement shows in the later window's OUTCOME, never in the earlier window's anything.
    expect(after.runs[1]!.finalValue).not.toBe(before.runs[1]!.finalValue);
    expect(after.runs[0]!.finalValue).toBe(before.runs[0]!.finalValue);
  });

  it('is deterministic and leaves the base request untouched', () => {
    const base = request(24);
    const snapshot = canonicalJsonOf(base);
    const a = crossSectionalWalkForward({
      request: base,
      variations: AXES,
      trainSessions: 8,
      testSessions: 4,
    });
    const b = crossSectionalWalkForward({
      request: base,
      variations: AXES,
      trainSessions: 8,
      testSessions: 4,
    });
    expect(canonicalJsonOf(a)).toBe(canonicalJsonOf(b));
    expect(canonicalJsonOf(base)).toBe(snapshot);
  });

  it('teaches every malformed request', () => {
    const grid = { request: request(24), variations: AXES };
    expect(
      failure(() => crossSectionalWalkForward({ ...grid, trainSessions: 8 } as never)).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(
      failure(() =>
        crossSectionalWalkForward({ variations: AXES, trainSessions: 8, testSessions: 4 } as never),
      ).code,
    ).toBe(ErrorCode.InputMissingField);
    expect(
      failure(() => crossSectionalWalkForward({ ...grid, trainSessions: 1, testSessions: 4 })).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        crossSectionalWalkForward({ ...grid, trainSessions: 8, testSessions: 4, step: 0 }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        crossSectionalWalkForward({
          ...grid,
          trainSessions: 8,
          testSessions: 4,
          mode: 'sliding' as never,
        }),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      failure(() =>
        crossSectionalWalkForward({
          ...grid,
          trainSessions: 8,
          testSessions: 4,
          mode: null as never,
        }),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      failure(() =>
        crossSectionalWalkForward({
          ...grid,
          trainSessions: 8,
          testSessions: 4,
          extra: 1,
        } as never),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
    const tooFew = failure(() =>
      crossSectionalWalkForward({ ...grid, trainSessions: 20, testSessions: 8 }),
    );
    expect(tooFew.code).toBe(ErrorCode.InputOutOfRange);
    expect(tooFew.message).toContain('28 sessions');
    expect(
      failure(() => requireCrossSectionalWalkForwardRequest('fixture', 'label', null)).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(CROSS_SECTIONAL_WINDOW_CEILING).toBe(1_000);
  });
});

describe('crossSectionalPurgedFolds — the folds are purgedKFold over the session index', () => {
  it('runs one held-out block per fold, pools the two training segments, and honours the purge gap', () => {
    const dates = sessions(24);
    const result = crossSectionalPurgedFolds({
      request: request(24),
      variations: AXES,
      folds: 4,
      purgeGap: 1,
    });
    const splits = purgedKFold(24, { folds: 4, purgeGap: 1 });
    expect(result.windows).toHaveLength(4);
    result.windows.forEach((window, i) => {
      const split = splits[i]!;
      expect(window.test.fromSessionIndex).toBe(split.test[0]);
      expect(window.test.toSessionIndex).toBe(split.test[split.test.length - 1]);
      const trainSessions = window.train.flatMap((s) =>
        Array.from({ length: s.sessionCount }, (_, k) => s.fromSessionIndex + k),
      );
      expect(trainSessions).toEqual(split.train);
      // a purge gap of one session on each side of the held-out block
      for (const s of window.train) {
        expect(s.toSessionIndex).not.toBe(window.test.fromSessionIndex - 1);
        expect(s.fromSessionIndex).not.toBe(window.test.toSessionIndex + 1);
      }
      // the held-out run is the direct call with the chosen parameters
      const held = crossSectionalBacktest({
        ...request(24),
        portfolioConstruction: {
          method: 'equal-weight',
          long: { count: window.chosen!.parameters['portfolioConstruction.long.count'] as number },
        },
        window: {
          fromTimestampMs: openOf(dates[window.test.fromSessionIndex]!),
          toTimestampMs: closeOf(dates[window.test.toSessionIndex]!),
        },
      });
      expect(window.testRunId).toBe(held.runId);
      expect(window.trainSweepIds).toHaveLength(window.train.length);
    });
    // the middle folds train on two segments (before and after the block)
    expect(result.windows[1]!.train).toHaveLength(2);
    expect(result.windows[2]!.train).toHaveLength(2);
    expect(result.windows[0]!.train).toHaveLength(1);
    expect(result.windows[3]!.train).toHaveLength(1);
    expect(result.assumptions.visibility).toContain('purged 4-fold');
    expect(result.diagnostics.skippedWindowCount).toBe(0);
    expect(result.returns).toEqual(result.runs.flatMap((run) => run.returns));
  });

  it('drops a training segment left with one session after purging, with a warning', () => {
    // 12 sessions, 6 folds → held-out blocks of 2; purgeGap 1 leaves the first fold's training
    // segment starting at 3 (fine) but the last fold's trailing segment empty — and fold 1's
    // leading segment [0] has a single session, dropped with a warning.
    const result = crossSectionalPurgedFolds({
      request: request(12),
      variations: AXES,
      folds: 6,
      purgeGap: 1,
    });
    const dropped = result.diagnostics.warnings.filter(
      (w) => w.code === WarningCode.DegenerateInput && w.message.includes('dropped'),
    );
    expect(dropped.length).toBeGreaterThan(0);
    expect(result.windows.every((w) => w.train.every((s) => s.sessionCount >= 2))).toBe(true);
  });

  it('teaches every malformed request', () => {
    const grid = { request: request(24), variations: AXES };
    expect(failure(() => crossSectionalPurgedFolds({ ...grid, folds: 1 })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(failure(() => crossSectionalPurgedFolds({ ...grid, folds: 13 })).message).toContain(
      'folds ≤ 12',
    );
    expect(
      failure(() => crossSectionalPurgedFolds({ ...grid, folds: 4, purgeGap: 1.5 })).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() => crossSectionalPurgedFolds({ ...grid, folds: 4, embargo: -0.1 })).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() => crossSectionalPurgedFolds({ ...grid, folds: 4, embargo: Number.NaN })).code,
    ).toBe(ErrorCode.InputNotFinite);
    expect(
      failure(() => crossSectionalPurgedFolds({ variations: AXES, folds: 4 } as never)).code,
    ).toBe(ErrorCode.InputMissingField);
    expect(
      failure(() => crossSectionalPurgedFolds({ ...grid, folds: 4, gap: 1 } as never)).code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() => requireCrossSectionalPurgedFoldsRequest('fixture', 'label', [])).code,
    ).toBe(ErrorCode.InputWrongType);
    // a purge that leaves no fold usable
    const starved = failure(() =>
      crossSectionalPurgedFolds({
        request: request(8),
        variations: AXES,
        folds: 4,
        purgeGap: 5,
      }),
    );
    // purgedKFold itself refuses a gap that empties a training set — the same code, its own words.
    expect(starved.code).toBe(ErrorCode.InputOutOfRange);
    expect(starved.message).toContain('purgeGap');
  });
});
