import type { SectorPerformanceSnapshotInput } from '@totalfinance/performance/sector-performance';
export function snapshotInput(count = 1): SectorPerformanceSnapshotInput {
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

export function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}
