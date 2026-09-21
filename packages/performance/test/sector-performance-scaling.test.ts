import {
  sectorPerformanceSnapshot,
  type SectorPerformanceSnapshotInput,
} from '@totalfinance/performance/sector-performance';
import { describe, expect, it } from 'vitest';
import { snapshotInput } from './sector-performance-fixtures.js';

/**
 * Permanent replacement for review-probes.test.ts's full-universe measurement. The independent
 * sparse-array probes are expanded in sector-performance-boundaries.test.ts.
 * Run: vitest run packages/performance/test/sector-performance-scaling.test.ts
 *
 * 11 sectors; 22 completed weekday sessions; 3 classification states and 2 exact-leg close
 * revisions per security. At 10k securities: 30k classifications + 240k closes, rather than the
 * original two-close toy. Includes validation, indexes, selections, lineage, and postconditions.
 * Timings are evidence, not an isolated inner-loop claim or a hardware-specific latency promise.
 */
function fullUniverse(securities: number): SectorPerformanceSnapshotInput {
  const input = snapshotInput(securities);
  const dates = [
    '2026-07-27',
    '2026-07-28',
    '2026-07-29',
    '2026-07-30',
    '2026-07-31',
    '2026-08-03',
    '2026-08-04',
    '2026-08-05',
    '2026-08-06',
    '2026-08-07',
    '2026-08-10',
    '2026-08-11',
    '2026-08-12',
    '2026-08-13',
    '2026-08-14',
    '2026-08-17',
    '2026-08-18',
    '2026-08-19',
    '2026-08-20',
    '2026-08-21',
    '2026-08-24',
    '2026-08-25',
  ];
  input.completedSessions = dates.map((sessionDate, index) => ({
    sessionId: `session-${index}`,
    sessionDate,
    completedAtTimestampMs: Date.parse(`${sessionDate}T20:00:00Z`),
  }));
  const priorSource = Date.parse('2026-08-25T20:01:00Z');
  const revisionSource = priorSource + 60_000;
  input.cutoffs = {
    sourceCutoffTimestampMs: revisionSource,
    knowledgeCutoffTimestampMs: revisionSource,
    sessionCompletedCutoffTimestampMs: revisionSource,
  };
  input.classifications = input.classifications.flatMap((row, index) =>
    [0, 1, 2].map((revision) => ({
      ...row,
      classificationObservationId: `${row.classificationObservationId}-revision-${revision}`,
      sectorId: `sector-${index % 11}`,
      sectorName: `Sector ${index % 11}`,
      effectiveFromSessionDate:
        revision === 0 ? '2020-01-01' : revision === 1 ? '2025-01-01' : '2026-08-26',
      sourceTimestampMs: priorSource,
      knownAtTimestampMs: priorSource,
    })),
  );
  input.splitAdjustedCloses = input.eligibleUniverse.flatMap((member, index) => {
    const base = 100 + (index % 200);
    const observation = (sessionIndex: number, revision: boolean) => ({
      closeObservationId: `${member.securityId}-session-${sessionIndex}${revision ? '-revision' : ''}`,
      securityId: member.securityId,
      listingId: member.listingId,
      sessionId: `session-${sessionIndex}`,
      splitAdjustedClose: sessionIndex === 21 ? base * (revision ? 1.01 : 1.02) : base,
      currency: 'USD',
      adjustmentVersion: 'split-series-v2',
      quality: 'final' as const,
      sourceId: 'prices',
      sourceTimestampMs: revision ? revisionSource : priorSource,
      knownAtTimestampMs: revision ? revisionSource : priorSource,
    });
    return [
      ...dates.map((_, i) => observation(i, false)),
      observation(20, true),
      observation(21, true),
    ];
  });
  return input;
}

describe('sector snapshot full-universe scaling benchmark', () => {
  it('measures end-to-end 500–10,000-security universes with a month of history', () => {
    sectorPerformanceSnapshot(fullUniverse(100)); // warm module and JIT before measuring
    for (const count of [500, 1_000, 2_000, 5_000, 10_000]) {
      const input = fullUniverse(count);
      const start = performance.now();
      const report = sectorPerformanceSnapshot(input);
      const milliseconds = performance.now() - start;
      console.info(
        JSON.stringify({
          benchmark: 'sectorPerformanceSnapshot',
          securities: count,
          classifications: input.classifications.length,
          closes: input.splitAdjustedCloses.length,
          sessions: input.completedSessions.length,
          milliseconds,
        }),
      );
      expect(report.diagnostics.includedSecurityCount).toBe(count);
      expect(report.diagnostics.status).toBe('complete');
      expect(report.diagnostics.warnings).toEqual([]);
      expect(report.sectors).toHaveLength(11);
      for (const sector of report.sectors) {
        expect(sector.dailyReturn).toBe(0.01);
        expect(sector.rank).toBe(1);
        expect(sector.members[0]!.targetClose.closeObservationId).toContain('-revision');
      }
      // Broad regression guard (many times the measured budget), not a sub-ms/flaky ratio assertion.
      // The old N × full-table scans grow into billions of row visits on this same fixture.
      expect(milliseconds).toBeLessThan(15_000);
    }
  }, 60_000);
});
