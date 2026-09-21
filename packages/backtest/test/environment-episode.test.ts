/**
 * Stage 7B.1 slice 3 — `runEnvironmentEpisode` and the `environment` run kind: a recorded trace
 * drives an episode to the end; the trace hash chains every action; the artifact spine saves,
 * restores, replays to the same run hash, and compares two episodes; a goal callback or a custom
 * adapter is saved as not replayable; the guards teach.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import {
  backtestRunArtifact,
  compareBacktestRuns,
  readBacktestRun,
  replayBacktestRun,
} from '@totalfinance/backtest/artifacts';
import {
  createTradingEnvironment,
  requireEnvironmentEpisodeInput,
  runEnvironmentEpisode,
  type EnvironmentAction,
  type EnvironmentEpisodeInput,
  type TradingEnvironmentDefinition,
} from '@totalfinance/backtest/environment';
import { bars, drift, equityRequest, portfolioJourneys } from './portfolio-journeys.js';

const DEFINITION = (): TradingEnvironmentDefinition => {
  const rest: Record<string, unknown> = { ...equityRequest() };
  delete rest['strategy'];
  return {
    ...(rest as unknown as TradingEnvironmentDefinition),
    reward: { pnl: 1, turnover: -0.1 },
  };
};
const buy = (quantity: number, orderId: string): EnvironmentAction => ({
  kind: 'orders',
  orders: [{ orderId, instrumentId: 'AAA', side: 'buy', quantity, type: 'market' }],
});
const TRACE: EnvironmentAction[] = [
  buy(100, 'a'),
  { kind: 'hold' },
  buy(50, 'b'),
  { kind: 'hold', rationale: 'sit' },
];
const INPUT = (): EnvironmentEpisodeInput => ({
  definition: DEFINITION(),
  seed: 3,
  actions: TRACE,
});
const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('runEnvironmentEpisode', () => {
  it('drives the trace to the end and reports every step, the rewards, the trace hash, and the engine result', () => {
    const episode = runEnvironmentEpisode(INPUT());
    expect(episode.steps).toHaveLength(4);
    expect(episode.steps.map((s) => s.step)).toEqual([1, 2, 3, 4]);
    expect(episode.steps[0]!.fills).toBe(1);
    expect(episode.steps[2]!.fills).toBe(1);
    expect(episode.steps[3]!.action).toEqual({ kind: 'hold', rationale: 'sit' });
    expect(episode.rewards).toHaveLength(4);
    expect(episode.rewardTotal).toBeCloseTo(
      episode.rewards.reduce((s, r) => s + r, 0),
      12,
    );
    expect(episode.terminated).toBe(false);
    expect(episode.truncated).toBe(false);
    expect(episode.result.fills).toHaveLength(2);
    expect(episode.result.diagnostics.sessionCount).toBe(5);
    expect(episode.seed).toBe(3);
    expect(episode.assumptions.replayable).toBe(true);
    expect(episode.diagnostics).toMatchObject({
      stepCount: 4,
      fillCount: 2,
      rejectionCount: 0,
      violationCount: 0,
    });
    // the same trace by hand leaves the same identity
    const environment = createTradingEnvironment(DEFINITION());
    const start = environment.reset({ seed: 3 });
    expect(start.identity.runId).toBe(episode.runId);
    expect(start.episode.engineRunId).toBe(episode.engineRunId);
    let last = start.identity.traceHash;
    for (const action of TRACE) last = environment.step(action).identity.traceHash;
    expect(last).toBe(episode.traceHash);
    expect(canonicalJsonOf(runEnvironmentEpisode(INPUT()))).toBe(canonicalJsonOf(episode));
  });

  it('runs to the data boundary and refuses a trace that outlives the episode', () => {
    const full = runEnvironmentEpisode({
      definition: DEFINITION(),
      actions: Array.from({ length: 9 }, () => ({ kind: 'hold' as const })),
    });
    expect(full.truncated).toBe(true);
    expect(full.reason).toBe('data-boundary');
    expect(full.steps).toHaveLength(9);
    const over = failure(() =>
      runEnvironmentEpisode({
        definition: DEFINITION(),
        actions: Array.from({ length: 10 }, () => ({ kind: 'hold' as const })),
      }),
    );
    expect(over.code).toBe(ErrorCode.InputOutOfRange);
    expect(over.message).toContain('actions[9]');
    const empty = runEnvironmentEpisode({ definition: DEFINITION(), actions: [] });
    expect(empty.steps).toEqual([]);
    expect(empty.result.diagnostics.sessionCount).toBe(1);
  });

  it('teaches on every malformed input', () => {
    expect(failure(() => runEnvironmentEpisode(null as never)).code).toBe(ErrorCode.InputWrongType);
    expect(failure(() => runEnvironmentEpisode({ ...INPUT(), extra: 1 } as never)).code).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(
      failure(() => runEnvironmentEpisode({ definition: DEFINITION(), actions: 'hold' } as never))
        .code,
    ).toBe(ErrorCode.InputWrongType);
    expect(
      failure(() =>
        runEnvironmentEpisode({ definition: DEFINITION(), actions: [{ kind: 'sell' }] } as never),
      ).code,
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      failure(() => runEnvironmentEpisode({ definition: DEFINITION(), seed: -1, actions: [] }))
        .code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() => runEnvironmentEpisode({ definition: null, actions: [] } as never)).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(requireEnvironmentEpisodeInput('fixture', 'input', INPUT())).toMatchObject({ seed: 3 });
  });
});

describe('the environment run kind', () => {
  it('saves, restores, replays to the same run hash, and compares two episodes', () => {
    const input = INPUT();
    const episode = runEnvironmentEpisode(input);
    const artifact = backtestRunArtifact({ kind: 'environment', run: episode, input });
    const report = readBacktestRun({ artifact }).report;
    expect(report.kind).toBe('environment');
    expect(report.assumptions.replayable).toBe(true);
    expect(report.identity.strategy).toEqual({
      kind: 'environment',
      actions: 4,
      traceHash: episode.traceHash,
    });
    expect(report.identity.childRunIds).toEqual([episode.engineRunId]);
    expect(report.identity.seed).toBe(3);
    const restored = readBacktestRun({ artifact: JSON.parse(JSON.stringify(artifact)) });
    expect(restored.report.runHash).toBe(report.runHash);
    expect((restored.report.run['steps'] as unknown[]).length).toBe(4);
    const replay = replayBacktestRun({ artifact: restored.artifact });
    expect(replay.matches).toBe(true);
    expect(replay.runHash.recomputed).toBe(report.runHash);
    expect(replay.recomputed.run['traceHash'] as string).toBe(episode.traceHash);
    // a second episode with one more buy: the comparison sees the performance move
    const other = runEnvironmentEpisode({
      ...input,
      actions: [...TRACE.slice(0, 3), buy(25, 'c')],
    });
    const comparison = compareBacktestRuns({
      baseline: artifact,
      candidate: backtestRunArtifact({
        kind: 'environment',
        run: other,
        input: { ...input, actions: [...TRACE.slice(0, 3), buy(25, 'c')] },
      }),
    });
    expect(comparison.kind).toBe('environment');
    expect(comparison.identical).toBe(false);
    expect(comparison.sameInputs).toBe(false);
    expect(comparison.sameConventions).toBe(true);
    const finalValue = comparison.metrics.find((m) => m.name === 'finalValue')!;
    expect(finalValue.baselineValue).toBe(episode.result.finalValue);
    expect(finalValue.candidateValue).toBe(other.result.finalValue);
    expect(finalValue.absoluteDelta).toBeCloseTo(
      other.result.finalValue - episode.result.finalValue,
      6,
    );
  });

  it('records a goal callback and a custom adapter as not replayable, and replay refuses', () => {
    const withGoal: EnvironmentEpisodeInput = {
      definition: {
        ...DEFINITION(),
        reward: { pnl: 1, goal: (frame) => ({ fills: frame.fills.length }) },
      },
      actions: [buy(10, 'a')],
    };
    const goalArtifact = backtestRunArtifact({
      kind: 'environment',
      run: runEnvironmentEpisode(withGoal),
      input: withGoal,
    });
    const goalReport = readBacktestRun({ artifact: goalArtifact }).report;
    expect(goalReport.assumptions.replayable).toBe(false);
    expect(goalReport.assumptions.nonReplayableField).toBe('definition.reward.goal');
    expect((goalReport.inputs['definition'] as { reward: { goal: unknown } }).reward.goal).toBe(
      '[caller function — not stored]',
    );
    expect(failure(() => replayBacktestRun({ artifact: goalArtifact })).code).toBe(
      ErrorCode.ArtifactNotReplayable,
    );
    const custom = portfolioJourneys()['custom-adapter']!;
    const definition: Record<string, unknown> = { ...custom };
    delete definition['strategy'];
    const customInput: EnvironmentEpisodeInput = {
      definition: definition as unknown as TradingEnvironmentDefinition,
      actions: [
        {
          kind: 'orders',
          orders: [{ orderId: 'x', instrumentId: 'X', side: 'buy', quantity: 10, type: 'market' }],
        },
      ],
    };
    const customReport = readBacktestRun({
      artifact: backtestRunArtifact({
        kind: 'environment',
        run: runEnvironmentEpisode(customInput),
        input: customInput,
      }),
    }).report;
    expect(customReport.assumptions.replayable).toBe(false);
    expect(customReport.assumptions.nonReplayableField).toBe('definition.instruments.X.adapter');
  });

  it('replays every callback journey to the same run hash', () => {
    for (const [name, request] of Object.entries(portfolioJourneys())) {
      if (!('onSession' in request.strategy) || request.instruments['X'] !== undefined) continue;
      const strategy = request.strategy;
      const definition: Record<string, unknown> = {
        ...request,
        limits: { allowUndefinedRiskOptions: true },
      };
      delete definition['strategy'];
      const environment = createTradingEnvironment(
        definition as unknown as TradingEnvironmentDefinition,
      );
      let state = environment.reset().observation;
      const actions: EnvironmentAction[] = [];
      while (state.index < environment.instantCount - 1) {
        const intents = strategy.onSession({ ...state, observations: state.market } as never);
        const orders = intents.map((o) => {
          const { submittedTimestampMs: _stamp, ...rest } = o;
          return rest;
        });
        const action: EnvironmentAction =
          orders.length > 0 ? { kind: 'orders', orders } : { kind: 'hold' };
        actions.push(action);
        state = environment.step(action).observation;
      }
      const input: EnvironmentEpisodeInput = {
        definition: definition as unknown as TradingEnvironmentDefinition,
        actions,
      };
      const artifact = backtestRunArtifact({
        kind: 'environment',
        run: runEnvironmentEpisode(input),
        input,
      });
      // a declared execution policy is a live model the artifact cannot carry: hand it back
      const replay = replayBacktestRun({
        artifact,
        ...(request.execution !== undefined ? { models: { execution: request.execution } } : {}),
      });
      expect({ name, matches: replay.matches }).toEqual({ name, matches: true });
    }
  });
});

void bars;
void drift;
