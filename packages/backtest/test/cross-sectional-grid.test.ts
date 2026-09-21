/**
 * Stage 4.6 slice 3 — `crossSectionalBacktestGrid`: the cartesian product is the same function
 * called once per point (each child equals its direct run), the hygiene verdicts equal the direct
 * `@totalfinance/risk` calls, the best trial is the metric's maximum with ties to the lower index, the
 * sweep is bounded, every malformed axis teaches, a child's refusal names its variation, the base
 * request is never mutated, and two sweeps are byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode, WarningCode } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import {
  type CrossSectionalBacktestRequest,
  crossSectionalBacktest,
  crossSectionalBacktestGrid,
} from '@totalfinance/backtest';
import {
  CROSS_SECTIONAL_GRID_CEILING,
  CROSS_SECTIONAL_GRID_DEFAULT_MAXIMUM,
} from '@totalfinance/backtest/cross-sectional';
import {
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  researchProtocol,
  sharpeStatistics,
} from '@totalfinance/risk';
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
      universeId: 'grid-4',
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
    rebalanceSchedule: { frequency: 'monthly', session: 'close' },
    portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
    initialCapital: 100_000,
  };
}

const AXES = [
  { path: 'portfolioConstruction.long.count', values: [1, 2, 3] },
  { path: 'rebalanceSchedule.frequency', values: ['monthly', 'weekly'] },
];

const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('crossSectionalBacktestGrid — the product is the same function, called', () => {
  it('runs the cartesian product with the last axis fastest; every child equals its direct run', () => {
    const grid = crossSectionalBacktestGrid({ request: request(), variations: AXES });
    expect(grid.variations).toHaveLength(6);
    expect(grid.runs).toHaveLength(6);
    expect(grid.variations.map((v) => v.parameters)).toEqual([
      { 'portfolioConstruction.long.count': 1, 'rebalanceSchedule.frequency': 'monthly' },
      { 'portfolioConstruction.long.count': 1, 'rebalanceSchedule.frequency': 'weekly' },
      { 'portfolioConstruction.long.count': 2, 'rebalanceSchedule.frequency': 'monthly' },
      { 'portfolioConstruction.long.count': 2, 'rebalanceSchedule.frequency': 'weekly' },
      { 'portfolioConstruction.long.count': 3, 'rebalanceSchedule.frequency': 'monthly' },
      { 'portfolioConstruction.long.count': 3, 'rebalanceSchedule.frequency': 'weekly' },
    ]);
    grid.variations.forEach((row, index) => {
      const base = request();
      const direct = crossSectionalBacktest({
        ...base,
        rebalanceSchedule: {
          ...base.rebalanceSchedule,
          frequency: row.parameters['rebalanceSchedule.frequency'] as 'monthly' | 'weekly',
        },
        portfolioConstruction: {
          ...base.portfolioConstruction,
          long: { count: row.parameters['portfolioConstruction.long.count'] as number },
        },
      });
      expect(row.runId).toBe(direct.runId);
      expect(canonicalJsonOf(grid.runs[index])).toBe(canonicalJsonOf(direct));
      expect(row.metrics.sharpe).toBe(direct.performance.sharpe);
      expect(row.metrics.finalValue).toBe(direct.finalValue);
      expect(row.metrics.rebalanceCount).toBe(direct.diagnostics.rebalanceCount);
      expect(row.metrics.totalCosts).toBeCloseTo(
        direct.rebalances.reduce((sum, r) => sum + r.costs, 0),
        9,
      );
      expect(row.trialSharpeDegenerate).toBe(false);
    });
    expect(
      grid.variations
        .filter((v) => v.parameters['rebalanceSchedule.frequency'] === 'weekly')
        .every((v) => v.metrics.rebalanceCount === 24),
    ).toBe(true);
    expect(grid.assumptions.variationCount).toBe(6);
    expect(grid.assumptions.maximumVariations).toBe(CROSS_SECTIONAL_GRID_DEFAULT_MAXIMUM);
    expect(grid.assumptions.paths).toEqual(AXES.map((a) => a.path));
    expect(grid.sweepId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(grid.variations[0]!.runId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('composes the hygiene verdicts verbatim from @totalfinance/risk and picks the best by the metric', () => {
    const grid = crossSectionalBacktestGrid({ request: request(), variations: AXES });
    // C (hygiene): a zero-variance run has a null Sharpe; the grid records it as 0 (flagged degenerate).
    const trialSharpes = grid.runs.map((run) => sharpeStatistics(run.returns).sharpe ?? 0);
    expect(grid.hygiene.trialSharpes).toEqual(trialSharpes);
    // the best trial is the maximum Sharpe of the performance block
    const sharpes = grid.variations.map((v) => v.metrics.sharpe as number);
    const expectedBest = sharpes.indexOf(Math.max(...sharpes));
    expect(grid.best).toEqual({
      index: expectedBest,
      runId: grid.variations[expectedBest]!.runId,
      metric: 'sharpe',
      value: sharpes[expectedBest],
    });
    const bestReturns = grid.runs[expectedBest]!.returns;
    expect(grid.hygiene.researchProtocol).toEqual(
      researchProtocol({
        returns: bestReturns,
        trials: { trialSharpes },
        confidence: 0.95,
        periodsPerYear: 252,
        riskFreeRate: 0,
      }),
    );
    expect(grid.hygiene.deflatedSharpe).toEqual(
      deflatedSharpeRatio(sharpeStatistics(bestReturns), { trialSharpes }),
    );
    const periods = bestReturns.length; // 23
    const matrix = Array.from({ length: periods }, (_, t) =>
      grid.runs.map((run) => run.returns[t]!),
    );
    expect(grid.hygiene.backtestOverfitting).toEqual(
      probabilityOfBacktestOverfitting(matrix, { splits: 16 }),
    );
    expect(grid.assumptions.hygiene).toEqual({
      splits: 16,
      confidence: 0.95,
      degenerateTrialSharpe: 0,
    });
    expect(grid.diagnostics.skippedHygiene).toEqual([]);
    expect(grid.diagnostics.warnings).toEqual([]);
  });

  it('honors an explicit selection metric and hygiene knobs', () => {
    const grid = crossSectionalBacktestGrid({
      request: request(),
      variations: [AXES[0]!],
      selectionMetric: 'totalReturn',
      hygiene: { splits: 4, confidence: 0.9 },
    });
    const totals = grid.variations.map((v) => v.metrics.totalReturn as number);
    expect(grid.best?.index).toBe(totals.indexOf(Math.max(...totals)));
    expect(grid.best?.metric).toBe('totalReturn');
    expect(grid.hygiene.backtestOverfitting?.splits).toBe(4);
    expect(grid.hygiene.researchProtocol?.assumptions.confidence).toBe(0.9);
  });

  it('skips the hygiene it cannot compute, says why, and records a 0 trial Sharpe for a degenerate series', () => {
    // three sessions → two returns: no Sharpe, no protocol, too few periods for CSCV
    const grid = crossSectionalBacktestGrid({ request: request(3), variations: [AXES[0]!] });
    expect(grid.variations.every((v) => v.trialSharpeDegenerate && v.trialSharpe === 0)).toBe(true);
    expect(grid.diagnostics.degenerateTrialCount).toBe(3);
    expect(grid.hygiene.researchProtocol).toBeNull();
    expect(grid.hygiene.deflatedSharpe).toBeNull();
    expect(grid.hygiene.backtestOverfitting).toBeNull();
    expect(grid.diagnostics.skippedHygiene.map((s) => s.block)).toEqual([
      'researchProtocol',
      'deflatedSharpe',
      'backtestOverfitting',
    ]);
    expect(grid.assumptions.hygiene.splits).toBeNull();
    expect(grid.diagnostics.warnings.every((w) => w.code === WarningCode.DegenerateInput)).toBe(
      true,
    );
    expect(grid.diagnostics.warnings).toHaveLength(6);
  });

  it('a single variation still runs; the overfitting block says there was no selection', () => {
    const grid = crossSectionalBacktestGrid({
      request: request(),
      variations: [{ path: 'initialCapital', values: [250_000] }],
    });
    expect(grid.variations).toHaveLength(1);
    expect(grid.runs[0]!.assumptions.initialCapital).toBe(250_000);
    expect(grid.hygiene.researchProtocol?.trialCount).toBe(1);
    expect(grid.hygiene.researchProtocol).toEqual(
      researchProtocol({
        returns: grid.runs[0]!.returns,
        confidence: 0.95,
        periodsPerYear: 252,
        riskFreeRate: 0,
      }),
    );
    expect(grid.hygiene.deflatedSharpe).toBeNull();
    expect(grid.hygiene.backtestOverfitting).toBeNull();
    expect(grid.diagnostics.skippedHygiene).toEqual([
      {
        block: 'deflatedSharpe',
        reason: 'fewer than two variations — there was no selection to deflate.',
      },
      {
        block: 'backtestOverfitting',
        reason: 'fewer than two variations — there was no selection to test.',
      },
    ]);
  });

  it('is bounded: the product above maximumVariations refuses with backtest.grid_too_large', () => {
    const refused = failure(() =>
      crossSectionalBacktestGrid({
        request: request(),
        variations: [
          { path: 'portfolioConstruction.long.count', values: [1, 2, 3] },
          { path: 'initialCapital', values: [1e5, 2e5, 3e5] },
        ],
        maximumVariations: 8,
      }),
    );
    expect(refused.code).toBe(ErrorCode.BacktestGridTooLarge);
    expect(refused.message).toContain('9 variations');
    expect(refused.message).toContain('maximumVariations=8');
    expect(
      failure(() =>
        crossSectionalBacktestGrid({
          request: request(),
          variations: [AXES[0]!],
          maximumVariations: CROSS_SECTIONAL_GRID_CEILING + 1,
        }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
  });

  it('every malformed axis teaches', () => {
    const base = request();
    const grid =
      (variations: unknown, rest: Record<string, unknown> = {}): (() => unknown) =>
      () =>
        crossSectionalBacktestGrid({
          request: base,
          variations: variations as never,
          ...rest,
        } as never);
    expect(failure(grid([{ path: 'dataset.returns', values: [[]] }])).code).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(failure(grid([{ path: 'dataset.returns', values: [[]] }])).message).toContain(
      'may not vary',
    );
    expect(failure(grid([{ path: 'portfolioConstruction.__proto__.x', values: [1] }])).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(failure(grid([{ path: 'portfolioConstruction..long', values: [1] }])).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      failure(grid([{ path: 'portfolioConstruction.long.count', values: [() => 1] }])).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(failure(grid([{ path: 'portfolioConstruction.long.count', values: [] }])).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      failure(
        grid([
          { path: 'initialCapital', values: [1] },
          { path: 'initialCapital', values: [2] },
        ]),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(failure(grid([{ path: 'initialCapital', values: [1], extra: true }])).code).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(failure(grid([])).code).toBe(ErrorCode.InputWrongType);
    expect(failure(grid([AXES[0]], { maximumVariations: null })).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(failure(grid([AXES[0]], { selectionMetric: 'alpha' })).code).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(failure(grid([AXES[0]], { hygiene: { splits: 5 } })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(failure(grid([AXES[0]], { hygiene: { confidence: 1 } })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(failure(grid([AXES[0]], { hygiene: { splits: 4, extra: 1 } })).code).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(failure(grid([AXES[0]], { variation: [] })).code).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() =>
        crossSectionalBacktestGrid({
          request: { ...base, initialCapital: -1 },
          variations: [AXES[0]!],
        }),
      ).message,
    ).toContain('request.request');
  });

  it("a child's refusal names its variation and keeps the child's code", () => {
    const refused = failure(() =>
      crossSectionalBacktestGrid({
        request: request(),
        variations: [{ path: 'portfolioConstruction.long.count', values: [2, 0] }],
      }),
    );
    expect(refused.message).toContain('variation #1 (portfolioConstruction.long.count=0) refused');
    expect(refused.code).toBe(ErrorCode.InputOutOfRange);
  });

  it('never mutates the base request and is deterministic across sweeps', () => {
    const base = request();
    const before = canonicalJsonOf(base);
    const first = crossSectionalBacktestGrid({ request: base, variations: AXES });
    expect(canonicalJsonOf(base)).toBe(before);
    expect(base.portfolioConstruction.long).toEqual({ count: 2 });
    const second = crossSectionalBacktestGrid({ request: request(), variations: AXES });
    expect(canonicalJsonOf(first)).toBe(canonicalJsonOf(second));
  });
});
