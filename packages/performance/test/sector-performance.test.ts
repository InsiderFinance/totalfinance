import { InputError } from '@totalfinance/core';
import {
  sectorPerformanceSnapshot,
  type SectorClassificationObservation,
  type SectorPerformanceCloseObservation,
  type SectorPerformanceSnapshotInput,
  type SectorPerformanceUniverseMember,
} from '@totalfinance/performance/sector-performance';
import { describe, expect, it } from 'vitest';

function universeMember(
  securityId: string,
  listingId = `listing-${securityId}`,
): SectorPerformanceUniverseMember {
  return {
    universeMembershipId: `membership-${securityId}`,
    securityId,
    listingId,
  };
}

function classification(
  securityId: string,
  sectorId: string | null,
  sectorName: string | null,
  overrides: Partial<SectorClassificationObservation> = {},
): SectorClassificationObservation {
  return {
    classificationObservationId: `classification-${securityId}`,
    securityId,
    taxonomyId: 'GICS',
    taxonomyVersion: '2025',
    effectiveFromSessionDate: '2020-01-01',
    effectiveToSessionDate: null,
    sectorId,
    sectorName,
    sourceId: 'classification-source',
    sourceTimestampMs: 10,
    knownAtTimestampMs: 20,
    ...overrides,
  };
}

function close(
  securityId: string,
  sessionId: string,
  splitAdjustedClose: number,
  overrides: Partial<SectorPerformanceCloseObservation> = {},
): SectorPerformanceCloseObservation {
  return {
    closeObservationId: `close-${securityId}-${sessionId}`,
    securityId,
    listingId: `listing-${securityId}`,
    sessionId,
    splitAdjustedClose,
    currency: 'USD',
    adjustmentVersion: 'split-series-v1',
    quality: 'final',
    sourceId: 'close-source',
    sourceTimestampMs: 30,
    knownAtTimestampMs: 40,
    ...overrides,
  };
}

function baseInput(): SectorPerformanceSnapshotInput {
  return {
    targetSessionDate: '2026-08-25',
    marketCalendarId: 'XNYS',
    classificationTaxonomy: { taxonomyId: 'GICS', taxonomyVersion: '2025' },
    cutoffs: {
      sourceCutoffTimestampMs: 1_000,
      knowledgeCutoffTimestampMs: 1_000,
      sessionCompletedCutoffTimestampMs: 1_000,
    },
    eligibleUniverse: [
      universeMember('security-a'),
      universeMember('security-b'),
      universeMember('security-c'),
    ],
    completedSessions: [
      { sessionId: 'session-fri', sessionDate: '2026-08-21', completedAtTimestampMs: 100 },
      { sessionId: 'session-mon', sessionDate: '2026-08-24', completedAtTimestampMs: 200 },
      { sessionId: 'session-tue', sessionDate: '2026-08-25', completedAtTimestampMs: 300 },
    ],
    classifications: [
      classification('security-a', 'sector-tech', 'Technology'),
      classification('security-b', 'sector-tech', 'Technology'),
      classification('security-c', 'sector-energy', 'Energy'),
    ],
    splitAdjustedCloses: [
      close('security-a', 'session-mon', 100),
      close('security-a', 'session-tue', 110),
      close('security-b', 'session-mon', 1_000),
      close('security-b', 'session-tue', 1_200),
      close('security-c', 'session-mon', 50),
      close('security-c', 'session-tue', 45),
    ],
  };
}

function cloneInput(input: SectorPerformanceSnapshotInput): SectorPerformanceSnapshotInput {
  return structuredClone(input);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function everyObjectKey(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(everyObjectKey);
  return Object.entries(value).flatMap(([key, child]) => [key, ...everyObjectKey(child)]);
}

describe('sectorPerformanceSnapshot', () => {
  it('calculates the golden daily result with equal-security weights, lineage, and ranking', () => {
    const report = sectorPerformanceSnapshot(baseInput());

    expect(report.policyVersion).toBe('sector-performance-v1');
    expect(report.selectedSessions).toEqual({
      target: {
        sessionId: 'session-tue',
        sessionDate: '2026-08-25',
        completedAtTimestampMs: 300,
      },
      previous: {
        sessionId: 'session-mon',
        sessionDate: '2026-08-24',
        completedAtTimestampMs: 200,
      },
    });
    expect(
      report.sectors.map(({ sectorId, dailyReturn, rank, eligibleSecurityCount }) => ({
        sectorId,
        dailyReturn,
        rank,
        eligibleSecurityCount,
      })),
    ).toEqual([
      {
        sectorId: 'sector-tech',
        dailyReturn: 0.15,
        rank: 1,
        eligibleSecurityCount: 2,
      },
      {
        sectorId: 'sector-energy',
        dailyReturn: -0.1,
        rank: 2,
        eligibleSecurityCount: 1,
      },
    ]);
    expect(report.sectors[0]!.members.map((member) => member.securityId)).toEqual([
      'security-a',
      'security-b',
    ]);
    expect(report.sectors[0]!.members[0]).toMatchObject({
      universeMembershipId: 'membership-security-a',
      classification: { classificationObservationId: 'classification-security-a' },
      previousClose: {
        closeObservationId: 'close-security-a-session-mon',
        splitAdjustedClose: 100,
      },
      targetClose: {
        closeObservationId: 'close-security-a-session-tue',
        splitAdjustedClose: 110,
      },
    });
    expect(report.sectors[0]!.members[0]!.dailyReturn).toBeCloseTo(0.1, 14);
    expect(report.diagnostics).toMatchObject({
      status: 'complete',
      eligibleSecurityCount: 3,
      includedSecurityCount: 3,
      excludedSecurityCount: 0,
      sectorCount: 2,
    });
  });

  it('returns an empty report for weekends, holidays, and sessions incomplete at the cutoff', () => {
    const weekend = cloneInput(baseInput());
    weekend.targetSessionDate = '2026-08-23';
    const weekendReport = sectorPerformanceSnapshot(weekend);
    expect(weekendReport.sectors).toEqual([]);
    expect(weekendReport.selectedSessions).toEqual({ target: null, previous: null });
    expect(weekendReport.diagnostics.blockers).toEqual(['target-session-not-completed']);

    const absentWeekdayHoliday = cloneInput(baseInput());
    absentWeekdayHoliday.targetSessionDate = '2026-08-26';
    expect(sectorPerformanceSnapshot(absentWeekdayHoliday).diagnostics.blockers).toEqual([
      'target-session-not-completed',
    ]);

    const incomplete = cloneInput(baseInput());
    incomplete.cutoffs.sessionCompletedCutoffTimestampMs = 299;
    expect(sectorPerformanceSnapshot(incomplete).diagnostics.blockers).toEqual([
      'target-session-not-completed',
    ]);

    const exactCutoff = cloneInput(baseInput());
    exactCutoff.cutoffs.sessionCompletedCutoffTimestampMs = 300;
    expect(sectorPerformanceSnapshot(exactCutoff).selectedSessions.target?.sessionId).toBe(
      'session-tue',
    );
  });

  it('uses the immediately preceding supplied completed session across weekends and holidays', () => {
    const input = cloneInput(baseInput());
    input.targetSessionDate = '2026-08-24';
    input.eligibleUniverse = [universeMember('security-a')];
    input.splitAdjustedCloses = [
      close('security-a', 'session-fri', 100),
      close('security-a', 'session-mon', 105),
    ];

    const report = sectorPerformanceSnapshot(input);
    expect(report.selectedSessions.previous?.sessionId).toBe('session-fri');
    expect(report.sectors[0]!.dailyReturn).toBe(0.05);
  });

  it('obeys caller-supplied additions and removals without consulting leftover observations', () => {
    const removed = cloneInput(baseInput());
    removed.eligibleUniverse = [universeMember('security-a')];
    const removedReport = sectorPerformanceSnapshot(removed);
    expect(removedReport.diagnostics.eligibleSecurityCount).toBe(1);
    expect(removedReport.sectors[0]!.members.map((member) => member.securityId)).toEqual([
      'security-a',
    ]);

    const added = cloneInput(baseInput());
    added.eligibleUniverse = [...added.eligibleUniverse, universeMember('security-d')];
    added.classifications = [
      ...added.classifications,
      classification('security-d', 'sector-tech', 'Technology'),
    ];
    added.splitAdjustedCloses = [
      ...added.splitAdjustedCloses,
      close('security-d', 'session-mon', 20),
      close('security-d', 'session-tue', 22),
    ];
    expect(
      sectorPerformanceSnapshot(added).sectors.find((sector) => sector.sectorId === 'sector-tech')
        ?.includedSecurityCount,
    ).toBe(3);
  });

  it('replays effective-dated classification revisions at both explicit cutoffs', () => {
    const input = cloneInput(baseInput());
    input.eligibleUniverse = [universeMember('security-a')];
    input.classifications = [
      classification('security-a', 'sector-tech', 'Technology'),
      classification('security-a', 'sector-energy', 'Energy', {
        classificationObservationId: 'classification-security-a-revision',
        sourceTimestampMs: 50,
        knownAtTimestampMs: 60,
      }),
      classification('security-a', 'sector-health', 'Health Care', {
        classificationObservationId: 'classification-security-a-future',
        effectiveFromSessionDate: '2026-08-26',
        sourceTimestampMs: 30,
        knownAtTimestampMs: 30,
      }),
    ];
    input.splitAdjustedCloses = [
      close('security-a', 'session-mon', 100),
      close('security-a', 'session-tue', 110),
    ];
    input.cutoffs.sourceCutoffTimestampMs = 50;
    input.cutoffs.knowledgeCutoffTimestampMs = 59;
    expect(sectorPerformanceSnapshot(input).sectors[0]!.sectorId).toBe('sector-tech');

    input.cutoffs.knowledgeCutoffTimestampMs = 60;
    expect(sectorPerformanceSnapshot(input).sectors[0]!.sectorId).toBe('sector-energy');

    input.classifications = [
      classification('security-a', 'sector-tech', 'Technology', {
        effectiveToSessionDate: '2026-08-25',
      }),
    ];
    const ended = sectorPerformanceSnapshot(input);
    expect(ended.sectors).toEqual([]);
    expect(ended.exclusions[0]!.reasons).toEqual(['classification-unassigned']);
    expect(ended.exclusions[0]!.classification).toMatchObject({
      classificationObservationId: 'classification-security-a',
      sectorId: 'sector-tech',
      effectiveToSessionDate: '2026-08-25',
    });

    const coverage = cloneInput(baseInput());
    coverage.eligibleUniverse = [universeMember('security-a'), universeMember('security-b')];
    coverage.classifications = [
      classification('security-a', 'sector-tech', 'Technology', {
        effectiveToSessionDate: '2026-08-25',
      }),
      classification('security-b', 'sector-tech', 'Technology'),
    ];
    coverage.splitAdjustedCloses = coverage.splitAdjustedCloses.filter(
      (row) => row.securityId !== 'security-c',
    );
    expect(sectorPerformanceSnapshot(coverage).sectors[0]).toMatchObject({
      sectorId: 'sector-tech',
      eligibleSecurityCount: 1,
      includedSecurityCount: 1,
      excludedSecurityCount: 0,
    });
  });

  it('selects close revisions at inclusive source and knowledge cutoffs', () => {
    const input = cloneInput(baseInput());
    input.eligibleUniverse = [universeMember('security-a')];
    input.classifications = [classification('security-a', 'sector-tech', 'Technology')];
    input.splitAdjustedCloses = [
      close('security-a', 'session-mon', 100),
      close('security-a', 'session-tue', 110),
      close('security-a', 'session-tue', 105, {
        closeObservationId: 'close-security-a-session-tue-revision',
        sourceTimestampMs: 50,
        knownAtTimestampMs: 60,
      }),
    ];
    input.cutoffs.sourceCutoffTimestampMs = 50;
    input.cutoffs.knowledgeCutoffTimestampMs = 59;
    expect(sectorPerformanceSnapshot(input).sectors[0]!.dailyReturn).toBe(0.1);

    input.cutoffs.knowledgeCutoffTimestampMs = 60;
    expect(sectorPerformanceSnapshot(input).sectors[0]!.dailyReturn).toBe(0.05);

    input.cutoffs.sourceCutoffTimestampMs = 49;
    expect(sectorPerformanceSnapshot(input).sectors[0]!.dailyReturn).toBe(0.1);
  });

  it('never substitutes stale, missing, or after-cutoff closes and still emits partial sectors', () => {
    const input = cloneInput(baseInput());
    input.splitAdjustedCloses = input.splitAdjustedCloses
      .filter((row) => !(row.securityId === 'security-b' && row.sessionId === 'session-mon'))
      .map((row) =>
        row.securityId === 'security-a' && row.sessionId === 'session-tue'
          ? { ...row, quality: 'stale' as const }
          : row,
      );
    const cTarget = input.splitAdjustedCloses.find(
      (row) => row.securityId === 'security-c' && row.sessionId === 'session-tue',
    )!;
    cTarget.sourceTimestampMs = 900;
    cTarget.knownAtTimestampMs = 900;
    input.cutoffs.sourceCutoffTimestampMs = 899;
    input.cutoffs.knowledgeCutoffTimestampMs = 899;

    const report = sectorPerformanceSnapshot(input);
    expect(report.sectors).toEqual([]);
    expect(report.exclusions.map((exclusion) => [exclusion.securityId, exclusion.reasons])).toEqual(
      [
        ['security-a', ['target-close-stale']],
        ['security-b', ['previous-close-missing']],
        ['security-c', ['target-close-after-cutoff']],
      ],
    );
    expect(report.diagnostics).toMatchObject({ status: 'empty', excludedSecurityCount: 3 });

    cTarget.sourceTimestampMs = 899;
    cTarget.knownAtTimestampMs = 899;
    const partial = sectorPerformanceSnapshot(input);
    expect(partial.sectors.map((sector) => sector.sectorId)).toEqual(['sector-energy']);
    expect(partial.diagnostics.status).toBe('partial');
  });

  it('preserves split continuity by using only the supplied split-adjusted series', () => {
    const input = cloneInput(baseInput());
    input.eligibleUniverse = [universeMember('security-a')];
    input.splitAdjustedCloses = [
      close('security-a', 'session-mon', 50, { adjustmentVersion: 'post-split-v2' }),
      close('security-a', 'session-tue', 55, { adjustmentVersion: 'post-split-v2' }),
    ];

    expect(sectorPerformanceSnapshot(input).sectors[0]!.dailyReturn).toBe(0.1);
  });

  it('joins only stable security/listing identities, so ticker reuse cannot cross-fill history', () => {
    const input = cloneInput(baseInput());
    input.eligibleUniverse = [universeMember('security-new', 'listing-new')];
    input.classifications = [classification('security-new', 'sector-tech', 'Technology')];
    input.splitAdjustedCloses = [
      close('security-old', 'session-mon', 100, { listingId: 'listing-old' }),
      close('security-new', 'session-tue', 110, { listingId: 'listing-new' }),
    ];

    expect(sectorPerformanceSnapshot(input).exclusions[0]!.reasons).toEqual([
      'previous-close-missing',
    ]);
    expect(() =>
      sectorPerformanceSnapshot({
        ...input,
        eligibleUniverse: [{ ...universeMember('security-new', 'listing-new'), ticker: 'REUSED' }],
      } as unknown as SectorPerformanceSnapshotInput),
    ).not.toThrow();
  });

  it('uses competition ranks and deterministic identity ordering for exact and rounded ties', () => {
    const input = cloneInput(baseInput());
    input.eligibleUniverse = [
      universeMember('security-a'),
      universeMember('security-b'),
      universeMember('security-c'),
    ];
    input.classifications = [
      classification('security-a', 'sector-z', 'Zulu'),
      classification('security-b', 'sector-a', 'Alpha'),
      classification('security-c', 'sector-m', 'Middle'),
    ];
    input.splitAdjustedCloses = [
      close('security-a', 'session-mon', 100),
      close('security-a', 'session-tue', 110.0000004),
      close('security-b', 'session-mon', 100),
      close('security-b', 'session-tue', 110.0000003),
      close('security-c', 'session-mon', 100),
      close('security-c', 'session-tue', 105),
    ];

    expect(
      sectorPerformanceSnapshot(input).sectors.map(({ sectorId, dailyReturn, rank }) => ({
        sectorId,
        dailyReturn,
        rank,
      })),
    ).toEqual([
      { sectorId: 'sector-a', dailyReturn: 0.1, rank: 1 },
      { sectorId: 'sector-z', dailyReturn: 0.1, rank: 1 },
      { sectorId: 'sector-m', dailyReturn: 0.05, rank: 3 },
    ]);
  });

  it('handles empty, all-excluded, and partially covered universes explicitly', () => {
    const empty = cloneInput(baseInput());
    empty.eligibleUniverse = [];
    expect(sectorPerformanceSnapshot(empty).diagnostics).toMatchObject({
      status: 'empty',
      blockers: ['eligible-universe-empty'],
    });

    const allExcluded = cloneInput(baseInput());
    allExcluded.classifications = [];
    expect(sectorPerformanceSnapshot(allExcluded).diagnostics).toMatchObject({
      status: 'empty',
      blockers: ['no-includable-members'],
      excludedSecurityCount: 3,
    });

    const partial = cloneInput(baseInput());
    partial.splitAdjustedCloses = partial.splitAdjustedCloses.filter(
      (row) => !(row.securityId === 'security-b' && row.sessionId === 'session-tue'),
    );
    const technology = sectorPerformanceSnapshot(partial).sectors.find(
      (sector) => sector.sectorId === 'sector-tech',
    )!;
    expect(technology).toMatchObject({
      eligibleSecurityCount: 2,
      includedSecurityCount: 1,
      excludedSecurityCount: 1,
      dailyReturn: 0.1,
    });
  });

  it('is input-order invariant, pure on deeply frozen inputs, and emits no compatibility aliases', () => {
    const input = baseInput();
    const reversed: SectorPerformanceSnapshotInput = {
      ...cloneInput(input),
      eligibleUniverse: [...input.eligibleUniverse].reverse(),
      completedSessions: [...input.completedSessions].reverse(),
      classifications: [...input.classifications].reverse(),
      splitAdjustedCloses: [...input.splitAdjustedCloses].reverse(),
    };
    const expected = sectorPerformanceSnapshot(input);
    expect(sectorPerformanceSnapshot(reversed)).toEqual(expected);

    const frozen = cloneInput(input);
    deepFreeze(frozen);
    expect(() => sectorPerformanceSnapshot(frozen)).not.toThrow();

    const keys = everyObjectKey(expected);
    expect(keys).not.toContain('sector');
    expect(keys).not.toContain('Sector');
    expect(keys).not.toContain('averageChange');
    expect(keys).not.toContain('changesPercentage');
  });

  it('fails closed on malformed, non-finite, duplicate, and ambiguous inputs', () => {
    expect(() =>
      sectorPerformanceSnapshot(null as unknown as SectorPerformanceSnapshotInput),
    ).toThrowError(InputError);

    const unknownKey = cloneInput(baseInput());
    unknownKey.eligibleUniverse = [
      { ...universeMember('security-a'), symbol: 'A' },
    ] as unknown as SectorPerformanceUniverseMember[];
    expect(sectorPerformanceSnapshot(unknownKey).sectors[0]!.members[0]!.securityId).toBe(
      'security-a',
    );

    const badDate = cloneInput(baseInput());
    badDate.targetSessionDate = '2026-02-30';
    expect(() => sectorPerformanceSnapshot(badDate)).toThrowError(InputError);

    const nonFinite = cloneInput(baseInput());
    (nonFinite.splitAdjustedCloses[0] as SectorPerformanceCloseObservation).splitAdjustedClose =
      Number.NaN;
    expect(() => sectorPerformanceSnapshot(nonFinite)).toThrowError(InputError);

    const duplicateId = cloneInput(baseInput());
    duplicateId.classifications = [
      ...duplicateId.classifications,
      { ...duplicateId.classifications[0]! },
    ];
    expect(() => sectorPerformanceSnapshot(duplicateId)).toThrowError(InputError);

    const duplicatePrecedence = cloneInput(baseInput());
    duplicatePrecedence.splitAdjustedCloses = [
      ...duplicatePrecedence.splitAdjustedCloses,
      {
        ...duplicatePrecedence.splitAdjustedCloses[0]!,
        closeObservationId: 'different-id-same-precedence',
      },
    ];
    expect(() => sectorPerformanceSnapshot(duplicatePrecedence)).toThrowError(InputError);

    const duplicateSecurity = cloneInput(baseInput());
    duplicateSecurity.eligibleUniverse = [
      universeMember('security-a'),
      { ...universeMember('security-a'), universeMembershipId: 'other-membership' },
    ];
    expect(() => sectorPerformanceSnapshot(duplicateSecurity)).toThrowError(InputError);

    const unknownSession = cloneInput(baseInput());
    unknownSession.splitAdjustedCloses = [close('security-a', 'not-a-supplied-session', 100)];
    expect(() => sectorPerformanceSnapshot(unknownSession)).toThrowError(InputError);
  });

  it('fails closed on incomparable series, conflicting sector identity, and overflow', () => {
    const adjustmentMismatch = cloneInput(baseInput());
    (
      adjustmentMismatch.splitAdjustedCloses.find(
        (row) => row.securityId === 'security-a' && row.sessionId === 'session-tue',
      ) as SectorPerformanceCloseObservation
    ).adjustmentVersion = 'different-adjustment';
    expect(sectorPerformanceSnapshot(adjustmentMismatch).exclusions[0]!.reasons).toContain(
      'adjustment-version-mismatch',
    );

    const conflictingSector = cloneInput(baseInput());
    conflictingSector.classifications = conflictingSector.classifications.map((row) =>
      row.securityId === 'security-b' ? { ...row, sectorName: 'Not Technology' } : row,
    );
    expect(() => sectorPerformanceSnapshot(conflictingSector)).toThrowError(InputError);

    const overflow = cloneInput(baseInput());
    overflow.eligibleUniverse = [universeMember('security-a')];
    overflow.classifications = [classification('security-a', 'sector-tech', 'Technology')];
    overflow.splitAdjustedCloses = [
      close('security-a', 'session-mon', Number.MIN_VALUE),
      close('security-a', 'session-tue', Number.MAX_VALUE),
    ];
    expect(() => sectorPerformanceSnapshot(overflow)).toThrowError(InputError);
  });

  it('computes a representable mean when the unscaled finite-member sum would overflow', () => {
    const input = cloneInput(baseInput());
    input.eligibleUniverse = [
      universeMember('security-a'),
      universeMember('security-b'),
      universeMember('security-c'),
    ];
    input.classifications = [
      classification('security-a', 'sector-tech', 'Technology'),
      classification('security-b', 'sector-tech', 'Technology'),
      classification('security-c', 'sector-tech', 'Technology'),
    ];
    input.splitAdjustedCloses = [
      close('security-a', 'session-mon', 1),
      close('security-a', 'session-tue', Number.MAX_VALUE),
      close('security-b', 'session-mon', 1),
      close('security-b', 'session-tue', Number.MAX_VALUE),
      close('security-c', 'session-mon', 1),
      close('security-c', 'session-tue', Number.MAX_VALUE),
    ];

    const report = sectorPerformanceSnapshot(input);
    expect(report.sectors[0]!.dailyReturn).toBe(Number.MAX_VALUE);
    expect(Number.isFinite(report.sectors[0]!.dailyReturn)).toBe(true);
  });
});
