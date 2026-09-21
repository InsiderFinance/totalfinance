import {
  sectorPerformanceSnapshot,
  type SectorPerformanceExclusionReason,
} from '@totalfinance/performance/sector-performance';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { snapshotInput } from './sector-performance-fixtures.js';

describe('sector snapshot indexed point-in-time selection', () => {
  it('prefers effective state before revision freshness and never revives an ended state', () => {
    const input = snapshotInput();
    const base = input.classifications[0]!;
    input.classifications = [
      {
        ...base,
        classificationObservationId: 'old-effective-new-source',
        sourceTimestampMs: 900,
        knownAtTimestampMs: 900,
      },
      {
        ...base,
        classificationObservationId: 'current-state',
        effectiveFromSessionDate: '2025-01-01',
        sectorId: 'new',
        sectorName: 'New',
      },
      {
        ...base,
        classificationObservationId: 'wrong-taxonomy',
        taxonomyId: 'OTHER',
        effectiveFromSessionDate: '2026-01-01',
      },
      {
        ...base,
        classificationObservationId: 'future-state',
        effectiveFromSessionDate: '2026-08-26',
      },
    ];
    expect(
      sectorPerformanceSnapshot(input).sectors[0]!.members[0]!.classification
        .classificationObservationId,
    ).toBe('current-state');
    input.classifications[1]!.effectiveToSessionDate = '2026-08-25';
    const ended = sectorPerformanceSnapshot(input);
    expect(ended.exclusions[0]!.reasons).toEqual(['classification-unassigned']);
    expect(ended.exclusions[0]!.classification!.classificationObservationId).toBe('current-state');
    input.classifications[1]!.sectorId = null;
    input.classifications[1]!.sectorName = null;
    input.classifications[1]!.effectiveToSessionDate = null;
    expect(sectorPerformanceSnapshot(input).exclusions[0]!.reasons).toEqual([
      'classification-unassigned',
    ]);
  });

  it('selects latest source then knowledge, not latest knowledge alone, including stale revisions', () => {
    const input = snapshotInput();
    const target = input.splitAdjustedCloses[1]!;
    input.splitAdjustedCloses = [
      input.splitAdjustedCloses[0]!,
      {
        ...target,
        closeObservationId: 'old-source-late-knowledge',
        sourceTimestampMs: 40,
        knownAtTimestampMs: 900,
        splitAdjustedClose: 150,
      },
      {
        ...target,
        closeObservationId: 'new-source-early-knowledge',
        sourceTimestampMs: 50,
        knownAtTimestampMs: 60,
        splitAdjustedClose: 105,
      },
      {
        ...target,
        closeObservationId: 'new-source-later-knowledge',
        sourceTimestampMs: 50,
        knownAtTimestampMs: 70,
        splitAdjustedClose: 120,
      },
    ];
    expect(
      sectorPerformanceSnapshot(input).sectors[0]!.members[0]!.targetClose.closeObservationId,
    ).toBe('new-source-later-knowledge');
    input.cutoffs.knowledgeCutoffTimestampMs = 60;
    expect(sectorPerformanceSnapshot(input).sectors[0]!.dailyReturn).toBe(0.05);
    input.cutoffs.knowledgeCutoffTimestampMs = 1000;
    input.splitAdjustedCloses[3]!.quality = 'stale';
    const stale = sectorPerformanceSnapshot(input);
    expect(stale.exclusions[0]!.reasons).toEqual(['target-close-stale']);
    expect(stale.exclusions[0]!.targetClose!.closeObservationId).toBe('new-source-later-knowledge');
  });

  it('discloses every exclusion in the declared order without inventing selected lineage', () => {
    const scenarios: [
      SectorPerformanceExclusionReason,
      (input: ReturnType<typeof snapshotInput>) => void,
    ][] = [
      [
        'classification-missing',
        (input) => {
          input.classifications = [];
        },
      ],
      [
        'classification-after-cutoff',
        (input) => {
          input.classifications[0]!.knownAtTimestampMs = 1001;
        },
      ],
      [
        'classification-unassigned',
        (input) => {
          input.classifications[0]!.sectorId = null;
          input.classifications[0]!.sectorName = null;
        },
      ],
      [
        'previous-close-missing',
        (input) => {
          input.splitAdjustedCloses = input.splitAdjustedCloses.slice(1);
        },
      ],
      [
        'previous-close-after-cutoff',
        (input) => {
          input.splitAdjustedCloses[0]!.sourceTimestampMs = 1001;
          input.splitAdjustedCloses[0]!.knownAtTimestampMs = 1001;
        },
      ],
      [
        'previous-close-stale',
        (input) => {
          input.splitAdjustedCloses[0]!.quality = 'stale';
        },
      ],
      [
        'target-close-missing',
        (input) => {
          input.splitAdjustedCloses = input.splitAdjustedCloses.slice(0, 1);
        },
      ],
      [
        'target-close-after-cutoff',
        (input) => {
          input.splitAdjustedCloses[1]!.knownAtTimestampMs = 1001;
        },
      ],
      [
        'target-close-stale',
        (input) => {
          input.splitAdjustedCloses[1]!.quality = 'stale';
        },
      ],
      [
        'currency-mismatch',
        (input) => {
          input.splitAdjustedCloses[1]!.currency = 'EUR';
        },
      ],
      [
        'adjustment-version-mismatch',
        (input) => {
          input.splitAdjustedCloses[1]!.adjustmentVersion = 'other';
        },
      ],
    ];
    for (const [reason, mutate] of scenarios) {
      const input = snapshotInput();
      mutate(input);
      const report = sectorPerformanceSnapshot(input);
      expect(report.exclusions[0]!.reasons).toEqual([reason]);
      expect(report.diagnostics.reasonCounts).toEqual([{ reason, count: 1 }]);
      expect(report.diagnostics.warnings.map((w) => w.code)).toContain(`performance.${reason}`);
      if (reason.endsWith('after-cutoff') || reason.endsWith('missing')) {
        const field = reason.startsWith('classification')
          ? 'classification'
          : reason.startsWith('previous')
            ? 'previousClose'
            : 'targetClose';
        expect(report.exclusions[0]).not.toHaveProperty(field);
      }
    }
    const input = snapshotInput();
    input.classifications = [];
    input.splitAdjustedCloses[0]!.quality = 'stale';
    Object.assign(input.splitAdjustedCloses[1]!, {
      quality: 'stale',
      currency: 'EUR',
      adjustmentVersion: 'other',
    });
    expect(sectorPerformanceSnapshot(input).exclusions[0]!.reasons).toEqual([
      'classification-missing',
      'previous-close-stale',
      'target-close-stale',
      'currency-mismatch',
      'adjustment-version-mismatch',
    ]);
  });

  it('never cross-joins composite identities containing separators or prototype-like names', () => {
    const input = snapshotInput(2);
    input.eligibleUniverse = [
      { securityId: 'a|b', listingId: 'c', universeMembershipId: '__proto__' },
      { securityId: 'a', listingId: 'b|c', universeMembershipId: 'constructor' },
    ];
    input.classifications = input.classifications.map((row, i) => ({
      ...row,
      securityId: input.eligibleUniverse[i]!.securityId,
      sectorId: '__proto__',
      sectorName: 'Technology',
    }));
    input.splitAdjustedCloses = input.splitAdjustedCloses.map((row, i) => ({
      ...row,
      securityId: input.eligibleUniverse[Math.floor(i / 2)]!.securityId,
      listingId: input.eligibleUniverse[Math.floor(i / 2)]!.listingId,
      splitAdjustedClose: i === 3 ? 120 : row.splitAdjustedClose,
    }));
    expect(sectorPerformanceSnapshot(input).sectors[0]!.dailyReturn).toBe(0.15);
    const missing = {
      ...input,
      splitAdjustedCloses: input.splitAdjustedCloses.filter((_, i) => i !== 0),
    };
    expect(sectorPerformanceSnapshot(missing).exclusions[0]!.securityId).toBe('a|b');
    expect(sectorPerformanceSnapshot(missing).exclusions[0]!.reasons).toEqual([
      'previous-close-missing',
    ]);
  });

  it('still rejects invalid unused history before producing empty or otherwise valid reports', () => {
    const input = snapshotInput();
    input.targetSessionDate = '2026-08-23';
    input.splitAdjustedCloses[0]!.splitAdjustedClose = NaN;
    expect(() => sectorPerformanceSnapshot(input)).toThrowError(
      /splitAdjustedCloses\[0\].splitAdjustedClose/,
    );
    input.targetSessionDate = '2026-08-25';
    input.eligibleUniverse = [];
    expect(() => sectorPerformanceSnapshot(input)).toThrowError(
      /splitAdjustedCloses\[0\].splitAdjustedClose/,
    );
  });

  it('property: indexed selection matches an independent scan oracle over revisions and cutoffs', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            effective: fc.integer({ min: 0, max: 3 }),
            delay: fc.integer({ min: 0, max: 100 }),
            ended: fc.boolean(),
            stale: fc.boolean(),
            price: fc.integer({ min: 1, max: 1000 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        fc.integer({ min: 20, max: 500 }),
        fc.integer({ min: 40, max: 500 }),
        fc.integer(),
        (rows, sourceCutoff, knowledgeCutoff, seed) => {
          const input = snapshotInput();
          input.cutoffs.sourceCutoffTimestampMs = sourceCutoff;
          input.cutoffs.knowledgeCutoffTimestampMs = knowledgeCutoff;
          const classification = input.classifications[0]!;
          const target = input.splitAdjustedCloses[1]!;
          const dates = ['2020-01-01', '2025-01-01', '2026-08-25', '2026-08-26'];
          input.classifications = rows.map((row, i) => ({
            ...classification,
            classificationObservationId: `classification-${i}`,
            effectiveFromSessionDate: dates[row.effective]!,
            effectiveToSessionDate: row.ended && row.effective < 2 ? '2026-08-25' : null,
            sourceTimestampMs: i * 10,
            knownAtTimestampMs: i * 10 + row.delay,
          }));
          input.splitAdjustedCloses = [
            input.splitAdjustedCloses[0]!,
            ...rows.map((row, i) => ({
              ...target,
              closeObservationId: `target-${i}`,
              sourceTimestampMs: i * 10,
              knownAtTimestampMs: i * 10 + row.delay,
              quality: row.stale ? ('stale' as const) : ('final' as const),
              splitAdjustedClose: row.price,
            })),
          ];
          const visible = (row: { sourceTimestampMs: number; knownAtTimestampMs: number }) =>
            row.sourceTimestampMs <= sourceCutoff && row.knownAtTimestampMs <= knowledgeCutoff;
          const expectedClassification = input.classifications
            .filter(
              (row) => row.effectiveFromSessionDate <= input.targetSessionDate && visible(row),
            )
            .sort(
              (a, b) =>
                a.effectiveFromSessionDate.localeCompare(b.effectiveFromSessionDate) ||
                a.sourceTimestampMs - b.sourceTimestampMs ||
                a.knownAtTimestampMs - b.knownAtTimestampMs,
            )
            .at(-1);
          const expectedClose = input.splitAdjustedCloses
            .filter((row) => row.sessionId === 'target' && visible(row))
            .sort(
              (a, b) =>
                a.sourceTimestampMs - b.sourceTimestampMs ||
                a.knownAtTimestampMs - b.knownAtTimestampMs,
            )
            .at(-1);
          const report = sectorPerformanceSnapshot(input);
          const selected = report.sectors[0]?.members[0] ?? report.exclusions[0]!;
          expect(selected.classification?.classificationObservationId).toBe(
            expectedClassification?.classificationObservationId,
          );
          expect(selected.targetClose?.closeObservationId).toBe(expectedClose?.closeObservationId);
          const shuffled = fc.sample(
            fc.shuffledSubarray([...input.classifications], {
              minLength: rows.length,
              maxLength: rows.length,
            }),
            { seed, numRuns: 1 },
          )[0]!;
          expect(
            sectorPerformanceSnapshot({
              ...input,
              classifications: shuffled,
              splitAdjustedCloses: [...input.splitAdjustedCloses].reverse(),
            }),
          ).toEqual(report);
        },
      ),
      { seed: 3369, numRuns: 150 },
    );
  });
});
