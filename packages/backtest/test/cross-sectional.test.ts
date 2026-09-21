/**
 * Stage 4.6 slice 2 — `crossSectionalBacktest`: a hand-computed three-name universe over eight
 * sessions with monthly rebalances. The laws: the reported final value equals the ledger's NAV;
 * every fill is a portfolio event (the ledger's state IS the book); a name whose feature becomes
 * available after the decision instant is invisible to it (no look-ahead); a delisting exits at the
 * delisting return or refuses when none is given; a removed name is sold; the benchmark block and
 * the research attribution are present; every construction goal is reported; two runs are
 * byte-identical; every malformed request teaches.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { createPortfolioLedger, readPortfolioLedgerSnapshot } from '@totalfinance/portfolio';
import {
  type CrossSectionalBacktestRequest,
  crossSectionalBacktest,
  fees,
  slippage,
} from '@totalfinance/backtest';
import { execution, spreadModels } from '@totalfinance/backtest/execution';
import type {
  FieldDefinition,
  ReturnObservation,
  UniverseHistory,
  UniverseObservation,
} from '@totalfinance/research';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 2, 21); // the first session's close
const CLOSE = (date: string): number =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), 21);
// eight sessions across two months: 2026-01-02 … 2026-02-06 (one session a week, so monthly rebalances fall on 01-02 and 02-06)
const SESSIONS = [
  '2026-01-02',
  '2026-01-09',
  '2026-01-16',
  '2026-01-23',
  '2026-01-30',
  '2026-02-06',
  '2026-02-13',
  '2026-02-20',
];
const NAMES = ['AAA', 'BBB', 'CCC'] as const;
const fieldDefinitions: FieldDefinition[] = [{ fieldName: 'quality', kind: 'numeric' }];

/** Deterministic returns: AAA drifts up, BBB flat-ish, CCC drifts down. */
function returnsFor(
  names: readonly string[] = NAMES,
  sessions: readonly string[] = SESSIONS,
): ReturnObservation[] {
  const drift: Record<string, number> = { AAA: 0.02, BBB: 0.0, CCC: -0.02, DDD: 0.01, SPY: 0.005 };
  const rows: ReturnObservation[] = [];
  for (const instrumentId of names) {
    sessions.forEach((tradingSessionDate, i) => {
      rows.push({
        instrumentId,
        tradingSessionDate,
        simpleReturn: (drift[instrumentId] ?? 0) + (i % 2 === 0 ? 0.001 : -0.001),
      });
    });
  }
  return rows;
}

function observationsAt(available: string, scores: Record<string, number>): UniverseObservation[] {
  return Object.entries(scores).map(([instrumentId, quality]) => ({
    instrumentId,
    availableTimestampMs: CLOSE(available) - DAY,
    fields: { quality },
  }));
}

function request(
  overrides: Partial<CrossSectionalBacktestRequest> = {},
): CrossSectionalBacktestRequest {
  return {
    dataset: {
      observations: observationsAt('2026-01-02', { AAA: 3, BBB: 2, CCC: 1 }),
      fieldDefinitions,
      returns: returnsFor(),
    },
    universeHistory: {
      universeId: 'test-3',
      members: NAMES.map((instrumentId) => ({ instrumentId, fromTimestampMs: T0 - DAY })),
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
    ...overrides,
  };
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('crossSectionalBacktest — the loop over research, the allocator, execution, and the ledger', () => {
  it('identifies the full declarative signal, costs, execution rules, and report settings', () => {
    const baseline = request();
    const original = crossSectionalBacktest(baseline).runId;
    if (!('score' in baseline.signal)) throw new Error('score fixture required');
    const score = baseline.signal.score;
    const alternatives: Partial<CrossSectionalBacktestRequest>[] = [
      {
        signal: {
          score: {
            ...score,
            components: score.components.map((c) => ({ ...c, direction: 'lower-is-better' })),
          },
        },
      },
      {
        signal: {
          score: { ...score, components: score.components.map((c) => ({ ...c, weight: 2 })) },
        },
      },
      { transactionCostModel: { commission: fees.fixed(1) } },
      { transactionCostModel: { slippage: slippage.bps(1) } },
      { periodsPerYear: 365 },
      { riskFreeRate: 0.02 },
      { seed: 42 },
    ];
    for (const alternative of alternatives) {
      expect(crossSectionalBacktest({ ...baseline, ...alternative }).runId).not.toBe(original);
    }
    const policyA = execution.declared({
      label: 'same label',
      costs: { spread: spreadModels.halfSpreadBps(1) },
    });
    const policyB = execution.declared({
      label: 'same label',
      costs: { spread: spreadModels.halfSpreadBps(2) },
    });
    expect(crossSectionalBacktest({ ...baseline, execution: policyA }).runId).not.toBe(
      crossSectionalBacktest({ ...baseline, execution: policyB }).runId,
    );
    expect(
      crossSectionalBacktest({
        ...baseline,
        dataset: {
          ...baseline.dataset,
          observations: [...baseline.dataset.observations].reverse(),
        },
      }).runId,
    ).toBe(original);
  });

  it('runs the hand-computed universe: two monthly rebalances, the top two by quality held, NAV reconciled to the ledger', () => {
    const run = crossSectionalBacktest(request());
    expect(run.rebalances.map((r) => r.sessionDate)).toEqual(['2026-01-02', '2026-02-06']);
    expect(run.diagnostics.sessionCount).toBe(8);
    expect(run.diagnostics.rebalanceCount).toBe(2);
    // the first rebalance holds AAA and BBB (top two by quality), equal weight
    const first = run.holdings.filter((h) => h.rebalanceIndex === 0 && h.quantity !== 0);
    expect(first.map((h) => h.instrumentId)).toEqual(['AAA', 'BBB']);
    for (const h of first) expect(h.weight).toBeCloseTo(0.5, 2);
    // the ledger is the book: fills exist as trade.fill events with deterministic ids
    expect(run.fills.length).toBeGreaterThanOrEqual(2);
    expect(run.ledger.events.filter((e) => e.eventType === 'trade.fill').length).toBe(
      run.fills.length,
    );
    expect(run.ledger.events[0]!.eventType).toBe('cash.deposit');
    // the final value is the ledger's NAV and the last timeline row
    expect(run.diagnostics.reconciliationResidual).toBe(0);
    expect(run.finalValue).toBe(run.timeline.rows[run.timeline.rows.length - 1]!.netAssetValue);
    expect(run.points).toHaveLength(8);
    expect(run.returns).toHaveLength(7);
    // hand check: AAA +2%±0.1%, BBB 0±0.1% each session; with 50/50 at the first close the next-session
    // portfolio return is ≈ (0.02 − 0.001 + 0 − 0.001) / 2 = 0.009 (weights in index units of ~100 → 500 units each)
    expect(run.returns[0]).toBeCloseTo(0.009, 3);
    expect(run.performance.periods).toBe(7);
    expect(run.assumptions.execution.realism).toBe('simplified');
    expect(run.assumptions.pricing).toContain('return-index');
    expect(run.assumptions.replayable).toBe(true);
    expect(run.runId).toMatch(/^sha256:[0-9a-f]{64}$/);
    // the ledger snapshot restores to the same state
    const restored = readPortfolioLedgerSnapshot({ snapshot: run.ledger });
    expect(restored.ledger.state.eventCount).toBe(run.ledger.events.length);
  });

  it('is deterministic: two runs are byte-identical', () => {
    const a = crossSectionalBacktest(request());
    const b = crossSectionalBacktest(request());
    expect(canonicalJsonOf(a)).toBe(canonicalJsonOf(b));
  });

  it('no look-ahead: a feature that becomes available after the decision instant is invisible to it', () => {
    // BBB's quality is published a day AFTER the first rebalance close → the first decision sees AAA and CCC only
    const late = observationsAt('2026-01-02', { AAA: 3, CCC: 1 });
    late.push({
      instrumentId: 'BBB',
      availableTimestampMs: CLOSE('2026-01-02') + DAY,
      fields: { quality: 2 },
    });
    const run = crossSectionalBacktest(
      request({ dataset: { observations: late, fieldDefinitions, returns: returnsFor() } }),
    );
    const first = run.holdings
      .filter((h) => h.rebalanceIndex === 0 && h.quantity !== 0)
      .map((h) => h.instrumentId);
    expect(first).toEqual(['AAA', 'CCC']);
    expect(run.rebalances[0]!.eligibleCount).toBe(2);
    // by the second rebalance BBB is visible and ranks second
    const second = run.holdings
      .filter((h) => h.rebalanceIndex === 1 && h.quantity !== 0)
      .map((h) => h.instrumentId);
    expect(second).toEqual(['AAA', 'BBB']);
  });

  it('a delisting exits at the delisting return, a removal sells at the last price, and a delisting without a return refuses', () => {
    const history: UniverseHistory = {
      universeId: 'test-exits',
      members: [
        {
          instrumentId: 'AAA',
          fromTimestampMs: T0 - DAY,
          toTimestampMs: CLOSE('2026-02-06') - DAY,
          exitReason: 'delisted' as const,
          delistingReturn: -0.5,
        },
        {
          instrumentId: 'BBB',
          fromTimestampMs: T0 - DAY,
          toTimestampMs: CLOSE('2026-02-06') - DAY,
          exitReason: 'removed' as const,
        },
        { instrumentId: 'CCC', fromTimestampMs: T0 - DAY },
      ],
    };
    const run = crossSectionalBacktest(request({ universeHistory: history }));
    const second = run.rebalances[1]!;
    expect(second.exits.map((e) => [e.instrumentId, e.reason])).toEqual([
      ['AAA', 'delisted'],
      ['BBB', 'removed'],
    ]);
    expect(run.diagnostics.delistingCount).toBe(1);
    expect(run.diagnostics.exitCount).toBe(2);
    // AAA's exit price is half its last level; BBB's is its last level
    const aaaExit = second.exits.find((e) => e.instrumentId === 'AAA')!;
    const bbbExit = second.exits.find((e) => e.instrumentId === 'BBB')!;
    expect(aaaExit.exitPrice).toBeLessThan(bbbExit.exitPrice);
    // only CCC remains holdable
    expect(
      run.holdings
        .filter((h) => h.rebalanceIndex === 1 && h.quantity !== 0)
        .map((h) => h.instrumentId),
    ).toEqual(['CCC']);
    const noReturn: UniverseHistory = {
      ...history,
      members: history.members.map((m) =>
        m.instrumentId === 'AAA'
          ? {
              instrumentId: 'AAA',
              fromTimestampMs: m.fromTimestampMs,
              toTimestampMs: m.toTimestampMs as number,
              exitReason: 'delisted' as const,
            }
          : m,
      ),
    };
    expect(codeOf(() => crossSectionalBacktest(request({ universeHistory: noReturn })))).toBe(
      ErrorCode.BacktestDelistingReturnMissing,
    );
  });

  it('long/short with dollar neutrality, caps, and a declared execution policy; every goal is reported', () => {
    const run = crossSectionalBacktest(
      request({
        portfolioConstruction: {
          method: 'score-weight',
          long: { count: 1 },
          short: { count: 1 },
          neutrality: 'dollar',
          maximumPositionWeight: 0.4,
          maximumTurnover: 0.5,
        },
        execution: execution.declared({
          label: 'test: 5 bps commission, 2 bps half-spread',
          costs: { commission: fees.bps(5), spread: spreadModels.halfSpreadBps(2) },
        }),
        transactionCostModel: { slippage: slippage.bps(1) },
      }),
    );
    const first = run.holdings.filter((h) => h.rebalanceIndex === 0 && h.quantity !== 0);
    expect(first.map((h) => [h.instrumentId, h.side])).toEqual([
      ['AAA', 'long'],
      ['CCC', 'short'],
    ]);
    const goals = run.rebalances[0]!.goals.map((g) => g.goal);
    expect(goals).toContain('dollar neutrality');
    expect(goals).toContain('maximumPositionWeight');
    expect(goals).toContain('maximumTurnover');
    expect(run.rebalances[0]!.goals.find((g) => g.goal === 'maximumTurnover')!.status).toBe(
      'capped',
    );
    expect(run.assumptions.execution.realism).toBe('declared');
    expect(run.assumptions.costs).toEqual({
      commission: fees.bps(5).label,
      slippage: slippage.bps(1).label,
    });
    expect(run.rebalances[0]!.costs).toBeGreaterThan(0);
    expect(run.trades.every((t) => t.commission > 0)).toBe(true);
  });

  it('a factor recipe, a screen, and a callback all produce rankings; the callback is not replayable', () => {
    const recipe = crossSectionalBacktest(
      request({
        signal: {
          factorRecipe: {
            recipeName: 'quality-only',
            recipeVersion: 1,
            disclosure: 'test',
            direction: 'higher-is-better',
            features: [{ field: 'quality', transform: 'raw', weight: 1 }],
            lagTradingSessions: 0,
            neutralization: 'none',
            missingValuePolicy: 'exclude',
          },
        },
      }),
    );
    expect(
      recipe.holdings
        .filter((h) => h.rebalanceIndex === 0 && h.quantity !== 0)
        .map((h) => h.instrumentId),
    ).toEqual(['AAA', 'BBB']);
    expect(recipe.assumptions.signal).toMatchObject({
      kind: 'factor-recipe',
      recipeName: 'quality-only',
    });
    const screen = crossSectionalBacktest(
      request({
        signal: {
          screen: {
            filter: { field: 'quality', operator: 'greaterThan', value: 1 },
            orderBy: [{ field: 'quality', direction: 'descending' }],
            missingValuePolicy: 'exclude',
          },
        },
      }),
    );
    expect(
      screen.holdings
        .filter((h) => h.rebalanceIndex === 0 && h.quantity !== 0)
        .map((h) => h.instrumentId),
    ).toEqual(['AAA', 'BBB']);
    const callback = crossSectionalBacktest(
      request({
        signal: {
          callback: (context) =>
            context.members.map((instrumentId, i) => ({ instrumentId, score: -i })),
        },
      }),
    );
    expect(callback.assumptions.replayable).toBe(false);
    expect(
      callback.holdings
        .filter((h) => h.rebalanceIndex === 0 && h.quantity !== 0)
        .map((h) => h.instrumentId),
    ).toEqual(['AAA', 'BBB']);
  });

  it('a benchmark yields the comparison block through the performance package; a seed yields bootstrap confidence', () => {
    const run = crossSectionalBacktest(
      request({
        dataset: {
          observations: observationsAt('2026-01-02', { AAA: 3, BBB: 2, CCC: 1 }),
          fieldDefinitions,
          returns: returnsFor(),
          benchmarkReturns: returnsFor(['SPY']),
        },
        seed: 7,
      }),
    );
    expect(run.benchmark?.instrumentId).toBe('SPY');
    expect(run.benchmark?.returns).toHaveLength(7);
    expect(run.performance.beta).not.toBeUndefined();
    expect(run.performanceConfidence?.seed).toBe(7);
    expect(run.performanceConfidence?.iterations).toBe(1_000);
    expect(run.attribution.perRebalance).toHaveLength(2);
    expect(run.attribution.perRebalance[0]!.breadth).toBe(3);
    expect(run.attribution.perRebalance[0]!.informationCoefficient).not.toBeNull();
  });

  it('teaches: unknown keys, null members, two signal forms, a method without its callback, an unknown instrument, a small window', () => {
    expect(codeOf(() => crossSectionalBacktest({ ...request(), extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => crossSectionalBacktest(request({ execution: null as never })))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      codeOf(() =>
        crossSectionalBacktest(
          request({ signal: { score: request().signal, callback: () => [] } as never }),
        ),
      ),
    ).toBe(ErrorCode.InputMissingField);
    expect(
      codeOf(() =>
        crossSectionalBacktest(
          request({ portfolioConstruction: { method: 'supplied-weights', long: { count: 1 } } }),
        ),
      ),
    ).toBe(ErrorCode.InputMissingField);
    expect(
      codeOf(() =>
        crossSectionalBacktest(
          request({
            portfolioConstruction: {
              method: 'equal-weight',
              long: { count: 1 },
              neutrality: 'dollar',
            },
          }),
        ),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        crossSectionalBacktest(
          request({
            dataset: { ...request().dataset, returns: returnsFor(['AAA', 'BBB', 'CCC', 'DDD']) },
          }),
        ),
      ),
    ).toBe(ErrorCode.BacktestUniverseMembershipUnknown);
    expect(
      codeOf(() =>
        crossSectionalBacktest(request({ window: { fromTimestampMs: CLOSE('2026-02-20') } })),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        crossSectionalBacktest(
          request({ rebalanceSchedule: { frequency: 'fortnightly' as never, session: 'close' } }),
        ),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        crossSectionalBacktest(
          request({
            portfolioConstruction: {
              method: 'equal-weight',
              long: { count: 1, fraction: 0.5 } as never,
            },
          }),
        ),
      ),
    ).toBe(ErrorCode.InputMissingField);
  });

  it('a weekly schedule rebalances every session here, and the ledger from the snapshot folds to the same state', () => {
    const run = crossSectionalBacktest(
      request({ rebalanceSchedule: { frequency: 'weekly', session: 'open' } }),
    );
    expect(run.diagnostics.rebalanceCount).toBe(8);
    const ledger = createPortfolioLedger({
      portfolioId: run.runId,
      baseCurrency: 'USD',
      events: run.ledger.events,
    });
    expect(ledger.state).toEqual(
      readPortfolioLedgerSnapshot({ snapshot: run.ledger }).ledger.state,
    );
  });
});
