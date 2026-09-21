import type {
  SectorPerformanceInput,
  SectorPerformanceSnapshotInput,
} from '@totalfinance/performance/sector-performance';
import type { FixtureThunk } from '../inputs.js';

// Fresh, deterministic observations: the two paths describe the same +10% technology member.
const simple = (): SectorPerformanceInput => ({
  members: [
    {
      securityId: 'security-0',
      sectorId: 'technology',
      sectorName: 'Technology',
      periodReturn: 0.1,
    },
  ],
});

function snapshotInput(count = 1): SectorPerformanceSnapshotInput {
  const ids = Array.from({ length: count }, (_, i) => `security-${i}`);
  return {
    targetSessionDate: '2026-08-25',
    marketCalendarId: 'XNYS',
    classificationTaxonomy: { taxonomyId: 'GICS', taxonomyVersion: '2025' },
    cutoffs: {
      sourceCutoffTimestampMs: 1000,
      knowledgeCutoffTimestampMs: 1000,
      sessionCompletedCutoffTimestampMs: 1000,
    },
    eligibleUniverse: ids.map((id) => ({
      securityId: id,
      listingId: `listing-${id}`,
      universeMembershipId: `membership-${id}`,
    })),
    completedSessions: [
      { sessionId: 'previous', sessionDate: '2026-08-24', completedAtTimestampMs: 100 },
      { sessionId: 'target', sessionDate: '2026-08-25', completedAtTimestampMs: 200 },
    ],
    classifications: ids.map((id) => ({
      classificationObservationId: `classification-${id}`,
      securityId: id,
      taxonomyId: 'GICS',
      taxonomyVersion: '2025',
      effectiveFromSessionDate: '2020-01-01',
      effectiveToSessionDate: null,
      sectorId: 'technology',
      sectorName: 'Technology',
      sourceId: 'classification-source',
      sourceTimestampMs: 10,
      knownAtTimestampMs: 20,
    })),
    splitAdjustedCloses: ids.flatMap((id) =>
      ['previous', 'target'].map((sessionId) => ({
        closeObservationId: `close-${id}-${sessionId}`,
        securityId: id,
        listingId: `listing-${id}`,
        sessionId,
        splitAdjustedClose: sessionId === 'previous' ? 100 : 110,
        currency: 'USD',
        adjustmentVersion: 'v1',
        quality: 'final' as const,
        sourceId: 'close-source',
        sourceTimestampMs: 30,
        knownAtTimestampMs: 40,
      })),
    ),
  };
}

export const SECTOR_PERFORMANCE_FIXTURES: Record<string, FixtureThunk> = {
  'performance.sectorPerformance': () => [simple()],
  'performance.sectorPerformanceSnapshot': () => [snapshotInput()],
};
