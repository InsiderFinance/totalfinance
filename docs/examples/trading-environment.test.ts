/**
 * Stage 7B.1 — the trading-environment journey as a cold user runs it: an environment over a small
 * definition, the next-observation law, a retry, the mask, the reward, the episode library, the
 * artifact round trip, and Agent Bench over the baselines. Every number here is the guide's.
 */
import { describe, expect, it } from 'vitest';
import {
  backtestRunArtifact,
  readBacktestRun,
  replayBacktestRun,
} from '@insiderfinance/totalfinance/backtest/artifacts';
import {
  ENVIRONMENT_EPISODE_IDS,
  agentBaselines,
  environmentEpisode,
  runAgentBench,
  runEnvironmentEpisode,
  scoreAgentTranscript,
} from '@insiderfinance/totalfinance/backtest/environment';

describe('the trading-environment journey', () => {
  it('benches every baseline over two episodes: operational conformance passes, strategy is reported apart', () => {
    const baselines = [
      agentBaselines.holdCash(),
      agentBaselines.buyAndHold(),
      agentBaselines.periodicRebalance({ everySessions: 10 }),
      agentBaselines.randomValidAction(7),
      agentBaselines.riskParity({ lookback: 20 }),
      agentBaselines.momentumCrossover({ fast: 5, slow: 20 }),
    ];
    for (const policy of baselines) {
      const report = runAgentBench({ policy, episodes: ['trending', 'range-bound'], seeds: [7] });
      expect({
        policy: policy.label,
        passes: report.operational.passes,
        failing: report.operational.failing,
      }).toEqual({
        policy: policy.label,
        passes: true,
        failing: [],
      });
      expect(report.operational.duplicateOrders).toBe(0);
      expect(report.operational.lookAhead).toBe(0);
      expect(report.episodes).toHaveLength(2);
      expect('score' in report).toBe(false);
      for (const episode of report.episodes) {
        expect(episode.operational.replayEquality).toBe(true);
        expect(episode.operational.reconciled).toBe(true);
        expect(Number.isFinite(episode.strategy.finalValue)).toBe(true);
      }
    }
    // the random baseline draws only from the mask: zero violations by construction
    const random = runAgentBench({
      policy: agentBaselines.randomValidAction(3),
      episodes: ['range-bound'],
      seeds: [3, 4],
    });
    expect(random.operational.maskViolations).toBe(0);
    expect(random.strategy.violations).toBe(0);
    // buy-and-hold beats hold-cash on the trend
    const held = runAgentBench({
      policy: agentBaselines.buyAndHold(),
      episodes: ['trending'],
      seeds: [42],
    });
    const cash = runAgentBench({
      policy: agentBaselines.holdCash(),
      episodes: ['trending'],
      seeds: [42],
    });
    expect(held.episodes[0]!.strategy.finalValue).toBeGreaterThan(
      cash.episodes[0]!.strategy.finalValue,
    );
    expect(cash.episodes[0]!.strategy.turnover).toBe(0);
  });

  it('saves a recorded episode and replays it to the same run hash', () => {
    const trending = environmentEpisode({ id: 'trending', seed: 7 });
    const episode = runEnvironmentEpisode({
      definition: trending.definition,
      seed: 7,
      actions: [
        {
          kind: 'orders',
          orders: [
            { orderId: 'a', instrumentId: 'UP', side: 'buy', quantity: 500, type: 'market' },
          ],
        },
        { kind: 'hold' },
        { kind: 'hold' },
      ],
    });
    const artifact = backtestRunArtifact({
      kind: 'environment',
      run: episode,
      input: {
        definition: trending.definition,
        seed: 7,
        actions: episode.steps.map((s) => s.action),
      },
    });
    expect(readBacktestRun({ artifact }).report.identity.strategy).toMatchObject({
      kind: 'environment',
      actions: 3,
    });
    expect(replayBacktestRun({ artifact }).matches).toBe(true);
    expect(ENVIRONMENT_EPISODE_IDS).toContain('trending');
  });

  it('scores a recorded transcript deterministically', () => {
    const transcript = {
      calls: [
        {
          operation: 'totalfinance.portfolio.snapshot',
          arguments: { asOf: 1 },
          ok: false,
          error: { code: 'input.missing_field' },
          bytes: 200,
        },
        {
          operation: 'totalfinance.portfolio.snapshot',
          arguments: { asOf: 1, portfolio: {} },
          ok: true,
          result: { netAssetValue: 100 },
          bytes: 900,
        },
        {
          operation: 'totalfinance.backtest.environment_episode',
          arguments: {},
          ok: true,
          result: { ok: true },
          bytes: 1200,
        },
      ],
      answer: { text: 'The book is worth 100.', citedArtifactIds: ['sha256:abc'] },
    };
    const expected = {
      operations: ['totalfinance.portfolio.snapshot', 'totalfinance.backtest.environment_episode'],
      parity: { operation: 'totalfinance.portfolio.snapshot', direct: { netAssetValue: 100 } },
      artifactIds: ['sha256:abc'],
      budget: { maximumCalls: 5, maximumBytes: 5_000 },
      mustRefuse: false,
    };
    const score = scoreAgentTranscript({ transcript, expected });
    expect(score).toMatchObject({
      operationSelection: 1,
      firstAttemptValidity: 0.5,
      recovery: 1,
      parity: true,
      refusal: true,
      traceability: 1,
      calls: 3,
      bytes: 2300,
      withinBudget: true,
      passes: true,
    });
    expect(scoreAgentTranscript({ transcript, expected })).toEqual(score);
    expect(
      scoreAgentTranscript({ transcript, expected: { ...expected, mustRefuse: true } }).passes,
    ).toBe(false);
  });
});
