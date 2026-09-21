/**
 * Stage 7B.1 slice 5 — `totalfinance.backtest.environment_episode`: the operation composes runAgentBench
 * verbatim (the bench row equals a direct call), embeds the recorded episode as an `environment` run
 * artifact on request, takes a named declarative definition, and refuses a TypeScript policy or an
 * unknown baseline with the shared codes.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { agentBaselines, runAgentBench } from '@totalfinance/backtest/environment';
import { readBacktestRun, replayBacktestRun } from '@totalfinance/backtest/artifacts';
import { backtestPack, createOperationRegistry, defaultPacks, jsonSafe } from '../src/index.js';

const registry = createOperationRegistry({ packs: [...defaultPacks(), backtestPack()] });
const ID = 'totalfinance.backtest.environment_episode';

describe('totalfinance.backtest.environment_episode', () => {
  it('equals runAgentBench over the one episode, and travels in the backtest pack', () => {
    expect(registry.list().map((d) => d.id)).toContain(ID);
    const result = registry.run({
      id: ID,
      input: { episode: 'trending', policy: { baseline: 'buyAndHold' }, seed: 7 },
    });
    const direct = runAgentBench({
      policy: agentBaselines.buyAndHold(),
      episodes: ['trending'],
      seeds: [7],
    });
    const structured = result.structured as {
      policy: string;
      episode: unknown;
      trace: { runId: string; traceHash: string; steps: unknown[] };
      artifact: unknown;
    };
    expect(structured.policy).toBe('buy-and-hold');
    expect(canonicalJsonOf(jsonSafe(structured.episode))).toBe(
      canonicalJsonOf(jsonSafe(direct.episodes[0])),
    );
    expect(structured.trace.runId).toBe(direct.traces[0]!.episode.runId);
    expect(structured.trace.traceHash).toBe(direct.traces[0]!.episode.traceHash);
    expect(structured.trace.steps.length).toBe(direct.traces[0]!.episode.steps.length);
    expect(structured.artifact).toBeNull();
    expect(result.summary).toContain('trending@7');
    expect(result.summary).toContain('operational passes');
  });

  it('embeds the recorded episode as an `environment` run artifact that replays to its run hash', () => {
    const result = registry.run({
      id: ID,
      input: {
        episode: 'range-bound',
        policy: { baseline: 'periodicRebalance', everySessions: 10 },
        seed: 3,
        artifact: 'embed',
      },
      maxInputBytes: 16_777_216,
    });
    const artifact = (result.structured as { artifact: unknown }).artifact;
    expect(artifact).not.toBeNull();
    const report = readBacktestRun({ artifact }).report;
    expect(report.kind).toBe('environment');
    expect(report.identity.seed).toBe(3);
    expect(replayBacktestRun({ artifact }).matches).toBe(true);
  });

  it('runs a named declarative definition through the same door', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    const bars = closes.map((close, i) => ({
      symbol: 'AAA',
      timestampMs: Date.UTC(2026, 0, 5, 21) + i * 86_400_000,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
    }));
    const result = registry.run({
      id: ID,
      input: {
        episode: {
          id: 'my-ramp',
          definition: {
            accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 50_000 }] },
            instruments: { AAA: { kind: 'equity', currency: 'USD' } },
            marketData: { bars },
            limits: { maximumPositionWeight: 0.9, onBreach: 'reject-and-continue' },
            reward: { pnl: 1, turnover: -0.1 },
          },
        },
        policy: { baseline: 'momentumCrossover', fast: 3, slow: 10 },
        seed: 1,
      },
    });
    const episode = (
      result.structured as {
        episode: { id: string; sessions: number; operational: { passes: boolean } };
      }
    ).episode;
    expect(episode.id).toBe('my-ramp');
    expect(episode.sessions).toBe(30);
    expect(episode.operational.passes).toBe(true);
  });

  it('refuses a TypeScript policy, an unknown baseline, an unknown episode, and an unknown field with the shared codes', () => {
    const failure = (input: unknown): string => {
      try {
        registry.run({ id: ID, input });
      } catch (error) {
        return (error as { code?: string }).code ?? 'no-code';
      }
      throw new Error('expected a refusal');
    };
    expect(failure({ episode: 'trending', policy: { baseline: 'myPolicy' } })).toMatch(/^input\./);
    expect(failure({ episode: 'trending', policy: { decide: () => ({ kind: 'hold' }) } })).toMatch(
      /^input\./,
    );
    expect(failure({ episode: 'bull-run', policy: { baseline: 'holdCash' } })).toMatch(/^input\./);
    expect(failure({ episode: 'trending', policy: { baseline: 'holdCash' }, extra: 1 })).toBe(
      'input.unknown_field',
    );
    expect(
      failure({
        episode: 'trending',
        policy: { baseline: 'momentumCrossover', fast: 20, slow: 5 },
      }),
    ).toMatch(/^input\./);
  });
});
