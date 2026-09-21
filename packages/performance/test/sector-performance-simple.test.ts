import {
  canonicalJsonOf,
  createAnalysisArtifact,
  fromCanonicalJson,
  readAnalysisArtifact,
} from '@totalfinance/core/artifacts';
import { round } from '@totalfinance/core';
import {
  sectorPerformance,
  sectorPerformanceSnapshot,
  type SectorPerformanceMember,
} from '@totalfinance/performance/sector-performance';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deepFreeze, snapshotInput } from './sector-performance-fixtures.js';
import { SECTOR_PERFORMANCE_FIXTURES } from '../../../tools/first-touch/fixtures/sector-performance.js';

const member = (
  securityId: string,
  sectorId: string,
  periodReturn: number,
): SectorPerformanceMember => ({
  securityId,
  sectorId,
  sectorName: sectorId,
  periodReturn,
});

describe('sectorPerformance same-period on-ramp', () => {
  it('calculates an independent hand golden without audit requirements or a daily horizon', () => {
    const report = sectorPerformance({
      members: [
        member('A', 'technology', 0.1),
        member('B', 'technology', 0.2),
        member('C', 'energy', -0.1),
      ],
    });
    expect(
      report.sectors.map(({ sectorId, periodReturn, rank }) => ({ sectorId, periodReturn, rank })),
    ).toEqual([
      { sectorId: 'technology', periodReturn: 0.15, rank: 1 },
      { sectorId: 'energy', periodReturn: -0.1, rank: 2 },
    ]);
    expect(report.policyVersion).toBe('sector-performance-v1');
    expect(report.diagnostics).toEqual({
      status: 'complete',
      warnings: [],
      inputMemberCount: 3,
      includedSecurityCount: 3,
      sectorCount: 2,
    });
    expect(Object.keys(report).sort()).toEqual([
      'assumptions',
      'diagnostics',
      'policyVersion',
      'sectors',
    ]);
    expect(Object.keys(report.sectors[0]!).sort()).toEqual([
      'includedSecurityCount',
      'members',
      'periodReturn',
      'rank',
      'sectorId',
      'sectorName',
    ]);
    expect(Object.keys(report.sectors[0]!.members[0]!).sort()).toEqual([
      'periodReturn',
      'sectorId',
      'sectorName',
      'securityId',
    ]);
    expect(report.assumptions.returnBasis).toContain('one common period');
    for (const invented of [
      'dailyReturn',
      'targetSessionDate',
      'selectedSessions',
      'currency',
      'sourceId',
      'knownAtTimestampMs',
      'universeMembershipId',
      'classificationTaxonomy',
    ]) {
      expect(JSON.stringify(report)).not.toContain(`"${invented}":`);
    }
  });

  it('shares exact same-data math, rounding and ranks with the audited path', () => {
    const input = snapshotInput(5);
    input.classifications = input.classifications.map((row, index) => ({
      ...row,
      sectorId: `sector-${index % 3}`,
      sectorName: `Sector ${index % 3}`,
    }));
    input.splitAdjustedCloses = input.splitAdjustedCloses.map((row, index) => ({
      ...row,
      splitAdjustedClose:
        row.sessionId === 'previous' ? 73.5 : [75.34, 74, 71, 76.78, 72.4][Math.floor(index / 2)]!,
    }));
    const audit = sectorPerformanceSnapshot(input);
    const simple = sectorPerformance({
      members: audit.sectors.flatMap((sector) =>
        sector.members.map((row) => ({
          securityId: row.securityId,
          sectorId: sector.sectorId,
          sectorName: sector.sectorName,
          periodReturn: row.dailyReturn,
        })),
      ),
    });
    expect(
      simple.sectors.map(({ sectorId, periodReturn, rank, includedSecurityCount }) => ({
        sectorId,
        periodReturn,
        rank,
        includedSecurityCount,
      })),
    ).toEqual(
      audit.sectors.map(({ sectorId, dailyReturn, rank, includedSecurityCount }) => ({
        sectorId,
        periodReturn: dailyReturn,
        rank,
        includedSecurityCount,
      })),
    );
    for (const key of ['weighting', 'rounding', 'rankingAndTies'] as const)
      expect(simple.assumptions[key]).toBe(audit.assumptions[key]);
  });

  it('does not round members before averaging, and pins half ties, competition ranking and negative zero', () => {
    expect(
      sectorPerformance({
        members: [member('A', 'one', 0.000000004), member('B', 'one', 0.000000005)],
      }).sectors[0]!.periodReturn,
    ).toBe(0);
    const report = sectorPerformance({
      members: [
        member('A', 'z', 0.100000004),
        member('B', 'a', 0.100000003),
        member('C', 'm', 0.05),
        member('D', 'half-positive', 0.000000005),
        member('E', 'half-negative', -0.000000005),
        member('F', 'zero', -0.000000001),
        member('G', 'negative-zero', -0),
      ],
    });
    expect(report.sectors.slice(0, 3).map(({ sectorId, rank }) => [sectorId, rank])).toEqual([
      ['a', 1],
      ['z', 1],
      ['m', 3],
    ]);
    expect(report.sectors.find((s) => s.sectorId === 'half-positive')!.periodReturn).toBe(
      0.00000001,
    );
    expect(report.sectors.find((s) => s.sectorId === 'half-negative')!.periodReturn).toBe(
      -0.00000001,
    );
    for (const sector of report.sectors) {
      expect(Object.is(sector.periodReturn, -0)).toBe(false);
      for (const m of sector.members) expect(Object.is(m.periodReturn, -0)).toBe(false);
    }
  });

  it('keeps distinct sector identities even when their display names match', () => {
    const members = [member('A', 'a', 0.1), member('B', 'b', 0.1)].map((row) => ({
      ...row,
      sectorName: 'Shared display name',
    }));
    expect(
      sectorPerformance({ members }).sectors.map((sector) => [sector.sectorId, sector.rank]),
    ).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
  });

  it('accepts total loss, preserves cancellation, tiny returns and representable overflow means', () => {
    for (const values of [
      [-1],
      [Number.MIN_VALUE],
      [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
      [-1, 1, 0.00000003],
    ]) {
      const report = sectorPerformance({
        members: values.map((value, i) => member(String(i), 'one', value)),
      });
      const expected =
        values[0] === Number.MAX_VALUE
          ? Number.MAX_VALUE
          : values.length === 3
            ? 0.00000001
            : round(values[0]!, 8);
      expect(report.sectors[0]!.periodReturn).toBe(expected);
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    }
  });

  it('accepts observation decoration without traversing it, leaking it, or mutating inputs', () => {
    const input = snapshotInput();
    const before = structuredClone(input);
    const original = sectorPerformanceSnapshot(input);
    const decoration: Record<string, unknown> = {};
    decoration['circular'] = decoration;
    for (const key of [
      'eligibleUniverse',
      'completedSessions',
      'classifications',
      'splitAdjustedCloses',
    ] as const) {
      for (const row of input[key]) {
        Object.assign(row, { ticker: 'REUSED', metadata: decoration, unrelatedNonFinite: NaN });
        Object.defineProperty(row, 'unusedGetter', {
          enumerable: true,
          get: () => {
            throw new Error('Decoration was read');
          },
        });
      }
    }
    // Freeze only consumed input rows: intentionally do not read arbitrary decorations ourselves.
    for (const key of [
      'eligibleUniverse',
      'completedSessions',
      'classifications',
      'splitAdjustedCloses',
    ] as const) {
      input[key].forEach(Object.freeze);
      Object.freeze(input[key]);
    }
    Object.freeze(input);
    expect(sectorPerformanceSnapshot(input)).toEqual(original);
    expect(sectorPerformanceSnapshot(before)).toEqual(original);

    const simpleMember = { ...member('A', 'technology', 0.1), metadata: decoration };
    Object.defineProperty(simpleMember, 'unusedGetter', {
      enumerable: true,
      get: () => {
        throw new Error('Decoration was read');
      },
    });
    const simple = { members: Object.freeze([Object.freeze(simpleMember)]) };
    const report = sectorPerformance(Object.freeze(simple));
    expect(report.sectors[0]!.members).toEqual([member('A', 'technology', 0.1)]);
    report.sectors[0]!.members[0]!.periodReturn = 99;
    expect(simpleMember.periodReturn).toBe(0.1);
    const audit = sectorPerformanceSnapshot(before);
    audit.sectors[0]!.members[0]!.targetClose.splitAdjustedClose = 999;
    audit.cutoffs.sourceCutoffTimestampMs = 0;
    expect(before.splitAdjustedCloses[1]!.splitAdjustedClose).toBe(110);
    expect(before.cutoffs.sourceCutoffTimestampMs).toBe(1000);
  });

  it('supports direct artifact save and exact canonical round-trip for every report status', () => {
    const partial = snapshotInput(2);
    partial.splitAdjustedCloses = partial.splitAdjustedCloses.slice(0, 2);
    const missingPrevious = snapshotInput();
    missingPrevious.completedSessions = missingPrevious.completedSessions.slice(1);
    missingPrevious.splitAdjustedCloses = [];
    const reports = [
      sectorPerformance({ members: [member('A', 'one', 0.1)] }),
      sectorPerformance({ members: [] }),
      sectorPerformanceSnapshot(snapshotInput()),
      sectorPerformanceSnapshot(partial),
      sectorPerformanceSnapshot({ ...snapshotInput(), targetSessionDate: '2026-08-23' }),
      sectorPerformanceSnapshot(missingPrevious),
      sectorPerformanceSnapshot({ ...snapshotInput(), eligibleUniverse: [] }),
      sectorPerformanceSnapshot({ ...snapshotInput(), classifications: [] }),
    ];
    for (const report of reports) {
      const artifact = createAnalysisArtifact({
        artifactType: 'performance.sector',
        producedBy: { operation: 'sector-performance-test' },
        result: report,
      });
      const restored = readAnalysisArtifact({
        artifact: fromCanonicalJson(canonicalJsonOf(artifact)),
      });
      expect(canonicalJsonOf(restored.artifact.result)).toBe(canonicalJsonOf(report));
      expect(restored.artifact.id).toBe(artifact.id);
      expect(report.diagnostics.warnings.length > 0).toBe(report.diagnostics.status !== 'complete');
    }
  });

  it('ships fresh executable first-touch fixtures for both canonical names', () => {
    const [simple] = SECTOR_PERFORMANCE_FIXTURES['performance.sectorPerformance']!();
    const [snapshot] = SECTOR_PERFORMANCE_FIXTURES['performance.sectorPerformanceSnapshot']!();
    expect(sectorPerformance(simple as never).sectors[0]!.periodReturn).toBe(0.1);
    expect(sectorPerformanceSnapshot(snapshot as never).sectors[0]!.dailyReturn).toBe(0.1);
    expect(SECTOR_PERFORMANCE_FIXTURES['performance.sectorPerformanceSnapshot']!()[0]).not.toBe(
      snapshot,
    );
  });

  it('property: permutation invariance, independent means, and aggregation conservation', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sector: fc.integer({ min: 0, max: 10 }),
            basisPoints: fc.integer({ min: -10_000, max: 20_000 }),
            order: fc.integer(),
          }),
          { minLength: 1, maxLength: 100 },
        ),
        (rows) => {
          const members = rows.map((row, i) =>
            member(`security-${i}`, `sector-${row.sector}`, row.basisPoints / 10_000),
          );
          const expected = sectorPerformance({ members });
          const permuted = members
            .map((m, i) => ({ m, order: rows[i]!.order }))
            .sort((a, b) => a.order - b.order)
            .map(({ m }) => m);
          deepFreeze(permuted);
          expect(sectorPerformance({ members: permuted })).toEqual(expected);
          expect(
            expected.sectors.reduce((sum, sector) => sum + sector.includedSecurityCount, 0),
          ).toBe(rows.length);
          for (const sector of expected.sectors) {
            const matching = rows.filter((row) => `sector-${row.sector}` === sector.sectorId);
            // Integer arithmetic oracle, independent of stableSum/aggregation's implementation.
            const exactMean =
              matching.reduce((sum, row) => sum + row.basisPoints, 0) / (10_000 * matching.length);
            expect(sector.periodReturn).toBeCloseTo(round(exactMean, 8), 8);
            expect(sector.rank).toBe(
              expected.sectors.findIndex((other) => other.periodReturn === sector.periodReturn) + 1,
            );
          }
        },
      ),
      { seed: 336, numRuns: 150 },
    );
  });

  it('property: positive price rescaling, arbitrary observation permutations, and simple/audit parity', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20_000 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: -10, max: 10 }),
        fc.integer(),
        (prices, exponent, seed) => {
          const input = snapshotInput(prices.length);
          input.classifications = input.classifications.map((row, i) => ({
            ...row,
            sectorId: `sector-${i % 3}`,
            sectorName: `Sector ${i % 3}`,
          }));
          input.splitAdjustedCloses = input.splitAdjustedCloses.map((row, i) => ({
            ...row,
            splitAdjustedClose:
              row.sessionId === 'previous' ? 100 : prices[Math.floor(i / 2)]! / 100,
          }));
          const expected = sectorPerformanceSnapshot(input);
          const order = fc.sample(
            fc.shuffledSubarray([...input.splitAdjustedCloses], {
              minLength: input.splitAdjustedCloses.length,
              maxLength: input.splitAdjustedCloses.length,
            }),
            { seed, numRuns: 1 },
          )[0]!;
          expect(
            sectorPerformanceSnapshot({
              ...input,
              eligibleUniverse: [...input.eligibleUniverse].reverse(),
              classifications: [...input.classifications].reverse(),
              completedSessions: [...input.completedSessions].reverse(),
              splitAdjustedCloses: order,
            }),
          ).toEqual(expected);
          const scaled = sectorPerformanceSnapshot({
            ...input,
            splitAdjustedCloses: input.splitAdjustedCloses.map((row) => ({
              ...row,
              splitAdjustedClose: row.splitAdjustedClose * 2 ** exponent,
            })),
          });
          expect(scaled.sectors.map((s) => [s.sectorId, s.dailyReturn, s.rank])).toEqual(
            expected.sectors.map((s) => [s.sectorId, s.dailyReturn, s.rank]),
          );
          const simple = sectorPerformance({
            members: expected.sectors.flatMap((s) =>
              s.members.map((row) => ({
                securityId: row.securityId,
                sectorId: s.sectorId,
                sectorName: s.sectorName,
                periodReturn: row.dailyReturn,
              })),
            ),
          });
          expect(simple.sectors.map((s) => [s.sectorId, s.periodReturn, s.rank])).toEqual(
            expected.sectors.map((s) => [s.sectorId, s.dailyReturn, s.rank]),
          );
        },
      ),
      { seed: 9336, numRuns: 100 },
    );
  });
});
