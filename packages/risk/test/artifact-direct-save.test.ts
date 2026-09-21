/**
 * Stage 4.5 slice 5 — the direct-save fixtures Decision 4 names: a hygiene result is a Law-2 report
 * in its own right, saveable through `createAnalysisArtifact` and linked by `createdFrom`; a tail
 * fit is too; and the one disclosed non-finite (`minTrackRecordLength: Infinity` when the Sharpe
 * is at or below its benchmark) round-trips through the canonical serializer. One fixture proves
 * each — no code in the artifacts layer computes any of them.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalJsonOf,
  createAnalysisArtifact,
  fromCanonicalJson,
  readAnalysisArtifact,
} from '@totalfinance/core/artifacts';
import {
  deflatedSharpeRatio,
  fitGeneralizedParetoTail,
  researchProtocol,
} from '@totalfinance/risk';

/** A deterministic return series: a seeded linear-congruential jitter around `mean` with spread `sd`. */
function series(mean: number, sd: number, length: number, seed = 7): number[] {
  let state = seed >>> 0;
  return Array.from({ length }, () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    const u = state / 2 ** 32;
    return mean + sd * (u - 0.5) * Math.sqrt(12);
  });
}
const persisted = <T>(value: T): T => fromCanonicalJson(canonicalJsonOf(value)) as T;

describe('direct-save fixtures (Decision 4)', () => {
  it('a researchProtocol verdict is saved directly, read back byte-identically, and linked by createdFrom', () => {
    const verdict = researchProtocol({
      returns: series(0.001, 0.005, 252),
      trials: { trialSharpes: Array.from({ length: 40 }, (_, i) => -0.1 + (0.2 * i) / 39) },
    });
    const artifact = createAnalysisArtifact({
      artifactType: 'risk.research-protocol',
      producedBy: { operation: 'researchProtocol' },
      inputs: { parameters: { trials: 40, observations: 252 } },
      result: verdict as unknown as Record<string, unknown>,
    });
    const read = readAnalysisArtifact({ artifact: persisted(artifact) });
    expect(read.artifact.id).toBe(artifact.id);
    expect(canonicalJsonOf(read.artifact.result)).toBe(canonicalJsonOf(verdict));
    const child = createAnalysisArtifact({
      artifactType: 'risk.research-protocol',
      producedBy: { operation: 'researchProtocol' },
      inputs: { parameters: { trials: 40, observations: 252, confirmatory: true } },
      result: verdict as unknown as Record<string, unknown>,
      createdFrom: [artifact.id],
    });
    expect(child.createdFrom).toEqual([artifact.id]);
    expect(child.id).not.toBe(artifact.id);
  });

  it('minTrackRecordLength is Infinity when the Sharpe is at or below its benchmark, and the serializer round-trips it', () => {
    const losing = researchProtocol({ returns: series(-0.002, 0.005, 252) });
    expect(losing.minTrackRecordLength).toBe(Number.POSITIVE_INFINITY);
    const artifact = createAnalysisArtifact({
      artifactType: 'risk.research-protocol',
      producedBy: { operation: 'researchProtocol' },
      inputs: { parameters: { observations: 252 } },
      result: losing as unknown as Record<string, unknown>,
    });
    const restored = readAnalysisArtifact({ artifact: persisted(artifact) }).artifact.result as {
      minTrackRecordLength: number;
    };
    expect(restored.minTrackRecordLength).toBe(Number.POSITIVE_INFINITY);
  });

  it('a deflated Sharpe result and a generalized Pareto tail fit are Law-2 reports the spine saves directly', () => {
    const deflated = deflatedSharpeRatio(
      { sharpe: 0.12, observations: 252, skewness: -0.3, kurtosis: 4.5 },
      { trialCount: 25, varianceSharpe: 0.01 },
    );
    const deflatedArtifact = createAnalysisArtifact({
      artifactType: 'risk.research-protocol',
      producedBy: { operation: 'deflatedSharpeRatio' },
      inputs: { parameters: { trialCount: 25 } },
      result: deflated as unknown as Record<string, unknown>,
    });
    expect(readAnalysisArtifact({ artifact: persisted(deflatedArtifact) }).artifact.id).toBe(
      deflatedArtifact.id,
    );
    const returns = series(0.0003, 0.012, 1_000, 11);
    const tail = fitGeneralizedParetoTail(returns, { method: 'pwm' });
    expect(tail.assumptions.estimator).toBe('pwm');
    const tailArtifact = createAnalysisArtifact({
      artifactType: 'risk.tail-fit',
      producedBy: { operation: 'fitGeneralizedParetoTail' },
      inputs: { parameters: { observations: returns.length, method: 'pwm' } },
      result: tail as unknown as Record<string, unknown>,
    });
    const restored = readAnalysisArtifact({ artifact: persisted(tailArtifact) });
    expect(canonicalJsonOf(restored.artifact.result)).toBe(canonicalJsonOf(tail));
    expect((restored.artifact.result as { shape: number }).shape).toBe(tail.shape);
  });
});
