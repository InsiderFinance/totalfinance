/**
 * Stage 4.5 Decisions 6, 7, and 9 — structural comparison and replay parity:
 *
 * - every differing leaf is named with both values and (for numbers) absolute/relative deltas;
 *   added/removed keys and trailing array elements are paths, never silently dropped;
 * - disclosed non-finite leaves compare by their wrapper and never produce a NaN delta;
 * - a tolerance is explicit and two-sided; `withinTolerance` is null without one;
 * - the retained-difference cap is honest (`truncated`, `differenceCount`);
 * - different `artifactType`s refuse; different markets and library versions WARN;
 * - parity is byte-exact, with the first differing paths when it fails;
 * - limits are count-safe and the walk is preflighted by the shared scanner.
 */

import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, ErrorCode, isQuantError } from '@totalfinance/core';
import {
  COMPARISON_LIMITS,
  artifactReplayParity,
  compareAnalysisArtifacts,
  contentHash,
  createAnalysisArtifact,
  fromCanonicalJson,
  canonicalJsonOf,
} from '@totalfinance/core/artifacts';
import type { AnalysisArtifact } from '@totalfinance/core/artifacts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

const SNAPSHOT_A = contentHash({ market: 'A' });
const SNAPSHOT_B = contentHash({ market: 'B' });

function fitArtifact(
  overrides: {
    rho?: number;
    rmse?: number;
    perSlice?: number[];
    extra?: Record<string, unknown>;
    snapshotHash?: string;
    libraryVersion?: string;
    artifactType?: string;
    parameters?: unknown;
    warnings?: unknown[];
  } = {},
): AnalysisArtifact {
  return createAnalysisArtifact({
    artifactType: overrides.artifactType ?? 'volatility.fitted-model',
    producedBy: {
      operation: 'calibrateSsvi',
      ...(overrides.libraryVersion !== undefined
        ? { libraryVersion: overrides.libraryVersion }
        : {}),
    },
    inputs: {
      ...(overrides.snapshotHash !== undefined ? { snapshotHash: overrides.snapshotHash } : {}),
      parameters: overrides.parameters ?? { family: 'ssvi', modelVersion: 1 },
    },
    result: {
      parameters: { rho: overrides.rho ?? -0.3, phi: { kind: 'power-law', eta: 1.2, gamma: 0.4 } },
      rmse: overrides.rmse ?? 0.001,
      perSliceRmse: overrides.perSlice ?? [0.001, 0.0012],
      ...(overrides.extra ?? {}),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION, weight: 'vega' },
      diagnostics: { warnings: overrides.warnings ?? [] },
    },
  });
}

describe('compareAnalysisArtifacts — leaf-by-leaf honesty', () => {
  it('reports an identical artifact as identical with no differences', () => {
    const artifact = fitArtifact();
    const comparison = compareAnalysisArtifacts({
      baseline: artifact,
      candidate: fromCanonicalJson(canonicalJsonOf(artifact)) as AnalysisArtifact,
    });
    expect(comparison.identical).toBe(true);
    expect(comparison.artifactIds.baseline).toBe(artifact.id);
    expect(comparison.result.differences).toEqual([]);
    expect(comparison.result.differenceCount).toBe(0);
    expect(comparison.result.comparedLeafCount).toBeGreaterThan(5);
    expect(comparison.inputs.sameInputsHash).toBe(true);
    expect(comparison.inputs.sameSnapshotHash).toBeNull();
    expect(comparison.withinTolerance).toBeNull();
    expect(comparison.assumptions.tolerance).toBeNull();
    expect(comparison.diagnostics.warnings).toEqual([]);
    expect(Object.isFrozen(comparison.result.differences)).toBe(true);
  });

  it('names every changed leaf with both values and the deltas, in key order', () => {
    const comparison = compareAnalysisArtifacts({
      baseline: fitArtifact({ rho: -0.3, rmse: 0.001 }),
      candidate: fitArtifact({ rho: -0.25, rmse: 0.002 }),
    });
    expect(comparison.identical).toBe(false);
    expect(comparison.result.differences.map((d) => d.path)).toEqual(['parameters.rho', 'rmse']);
    const rho = comparison.result.differences[0]!;
    expect(rho.baselineValue).toBe(-0.3);
    expect(rho.candidateValue).toBe(-0.25);
    expect(rho.absoluteDelta).toBeCloseTo(0.05, 12);
    expect(rho.relativeDelta).toBeCloseTo(0.05 / 0.3, 12);
    expect(rho.withinTolerance).toBeNull();
    expect(comparison.result.differenceCount).toBe(2);
    expect(comparison.result.truncated).toBe(false);
  });

  it('reports added and removed keys and trailing array elements as paths', () => {
    const comparison = compareAnalysisArtifacts({
      baseline: fitArtifact({ perSlice: [0.001, 0.0012, 0.0015], extra: { legacy: 1 } }),
      candidate: fitArtifact({ perSlice: [0.001, 0.0012], extra: { fresh: 'yes' } }),
    });
    expect(comparison.result.addedPaths).toEqual(['fresh']);
    expect(comparison.result.removedPaths).toEqual(['legacy', 'perSliceRmse[2]']);
    expect(comparison.result.differences).toEqual([]);
    expect(comparison.result.differenceCount).toBe(3);
  });

  it('reports a relative delta of null at a zero baseline and non-numeric changes without deltas', () => {
    const comparison = compareAnalysisArtifacts({
      baseline: fitArtifact({ rmse: 0, extra: { label: 'a', flag: true } }),
      candidate: fitArtifact({ rmse: 0.5, extra: { label: 'b', flag: false } }),
    });
    const byPath = new Map(comparison.result.differences.map((d) => [d.path, d]));
    expect(byPath.get('rmse')!.relativeDelta).toBeNull();
    expect(byPath.get('rmse')!.absoluteDelta).toBe(0.5);
    expect(byPath.get('label')).toMatchObject({
      baselineValue: 'a',
      candidateValue: 'b',
      absoluteDelta: null,
      relativeDelta: null,
    });
    expect(byPath.get('flag')!.absoluteDelta).toBeNull();
  });

  it('compares disclosed non-finite leaves by their wrapper and never emits a NaN delta', () => {
    const same = compareAnalysisArtifacts({
      baseline: fitArtifact({ extra: { degenerate: Number.NaN } }),
      candidate: fitArtifact({ extra: { degenerate: Number.NaN } }),
    });
    expect(same.result.differences).toEqual([]);
    const changed = compareAnalysisArtifacts({
      baseline: fitArtifact({ extra: { degenerate: Number.NaN } }),
      candidate: fitArtifact({ extra: { degenerate: 0.2 } }),
      tolerance: { absolute: 1, relative: 1 },
    });
    const difference = changed.result.differences.find((d) => d.path === 'degenerate')!;
    expect(difference.baselineValue).toEqual({ nonFinite: 'NaN' });
    expect(difference.candidateValue).toBe(0.2);
    expect(difference.absoluteDelta).toBeNull();
    expect(difference.withinTolerance).toBe(false);
    expect(changed.withinTolerance).toBe(false);
    expect(JSON.stringify(changed)).not.toContain('null,"relativeDelta":NaN');
  });

  it('answers withinTolerance only under an explicit two-sided tolerance', () => {
    const baseline = fitArtifact({ rho: -0.3, rmse: 0.001 });
    const candidate = fitArtifact({ rho: -0.3000001, rmse: 0.00100001 });
    const loose = compareAnalysisArtifacts({
      baseline,
      candidate,
      tolerance: { absolute: 1e-6, relative: 1e-5 },
    });
    expect(loose.withinTolerance).toBe(true);
    expect(loose.result.differences.every((d) => d.withinTolerance === true)).toBe(true);
    const tight = compareAnalysisArtifacts({
      baseline,
      candidate,
      tolerance: { absolute: 0, relative: 1e-9 },
    });
    expect(tight.withinTolerance).toBe(false);
    const added = compareAnalysisArtifacts({
      baseline,
      candidate: fitArtifact({ extra: { fresh: 1 } }),
      tolerance: { absolute: 1, relative: 1 },
    });
    expect(added.withinTolerance).toBe(false); // an added path is never "within tolerance"
    expect(
      codeOf(() =>
        compareAnalysisArtifacts({ baseline, candidate, tolerance: { absolute: 1 } as never }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        compareAnalysisArtifacts({ baseline, candidate, tolerance: { absolute: -1, relative: 0 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
  });

  it('compares the input parameters and reports snapshot, operation, and version facts', () => {
    const comparison = compareAnalysisArtifacts({
      baseline: fitArtifact({
        snapshotHash: SNAPSHOT_A,
        libraryVersion: '0.4.0',
        parameters: { weight: 'vega' },
      }),
      candidate: fitArtifact({
        snapshotHash: SNAPSHOT_B,
        libraryVersion: '0.5.0',
        parameters: { weight: 'uniform' },
      }),
    });
    expect(comparison.inputs.sameInputsHash).toBe(false);
    expect(comparison.inputs.sameSnapshotHash).toBe(false);
    expect(comparison.inputs.parameterDifferences).toEqual([
      {
        path: 'weight',
        baselineValue: 'vega',
        candidateValue: 'uniform',
        absoluteDelta: null,
        relativeDelta: null,
        withinTolerance: null,
      },
    ]);
    expect(comparison.producedBy).toEqual({
      sameOperation: true,
      libraryVersions: { baseline: '0.4.0', candidate: '0.5.0' },
      conventionsVersions: { baseline: CONVENTIONS_VERSION, candidate: CONVENTIONS_VERSION },
    });
    expect(comparison.diagnostics.warnings.map((w) => w.code).sort()).toEqual([
      'artifact.comparison_different_market',
      'artifact.library_version_differs',
    ]);
    expect(comparison.warningCounts).toEqual({ baseline: 0, candidate: 0 });
  });

  it('counts each side’s warnings and leaves sameSnapshotHash null when one side has none', () => {
    const comparison = compareAnalysisArtifacts({
      baseline: fitArtifact({
        snapshotHash: SNAPSHOT_A,
        warnings: [{ code: 'x', message: 'm', severity: 'warn' }],
      }),
      candidate: fitArtifact(),
    });
    expect(comparison.inputs.sameSnapshotHash).toBeNull();
    expect(comparison.warningCounts).toEqual({ baseline: 1, candidate: 0 });
    expect(comparison.diagnostics.warnings).toEqual([]);
  });

  it('refuses two artifact types with the teaching that names both', () => {
    const baseline = fitArtifact();
    const candidate = fitArtifact({ artifactType: 'research.run' });
    expect(codeOf(() => compareAnalysisArtifacts({ baseline, candidate }))).toBe(
      ErrorCode.ArtifactTypeMismatch,
    );
    expect(() => compareAnalysisArtifacts({ baseline, candidate })).toThrow(
      /'volatility\.fitted-model'.*'research\.run'/,
    );
  });

  it('verifies both envelopes through the read door — a tampered artifact is refused', () => {
    const baseline = fitArtifact();
    const tampered = { ...fitArtifact({ rho: -0.2 }), id: baseline.id };
    expect(codeOf(() => compareAnalysisArtifacts({ baseline, candidate: tampered }))).toBe(
      ErrorCode.ArtifactIdMismatch,
    );
    expect(
      codeOf(() => compareAnalysisArtifacts({ baseline, candidate: { bogus: 1 } as never })),
    ).toBe(ErrorCode.InputUnknownField);
    expect(codeOf(() => compareAnalysisArtifacts({ baseline } as never))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(
      codeOf(() => compareAnalysisArtifacts({ baseline, candidate: baseline, extra: 1 } as never)),
    ).toBe(ErrorCode.InputUnknownField);
  });
});

describe('compareAnalysisArtifacts — bounded work', () => {
  it.each([1, 2, 3, 4, 5, 10])(
    'shares retention across changed, added and removed paths (cap %i)',
    (maximumDifferences) => {
      const baseline = fitArtifact({ perSlice: [1, 2, 3], extra: { removed: 'old', changed: 1 } });
      const candidate = fitArtifact({ perSlice: [9, 2], extra: { added: 'new', changed: 2 } });
      const request = {
        baseline,
        candidate,
        limits: { maximumDifferences },
        tolerance: { absolute: 0, relative: 0 },
      };
      const comparison = compareAnalysisArtifacts(request);
      const parity = artifactReplayParity({
        saved: baseline.result,
        recomputed: candidate.result,
        limits: request.limits,
      });
      for (const report of [comparison.result, parity]) {
        expect(
          report.differences.length + report.addedPaths.length + report.removedPaths.length,
        ).toBe(Math.min(maximumDifferences, 5));
        expect(report.differenceCount).toBe(5);
        expect(report.truncated).toBe(maximumDifferences < 5);
      }
      expect(comparison.withinTolerance).toBe(false);
      expect(compareAnalysisArtifacts(request)).toEqual(comparison);
    },
  );

  it.each(['added', 'removed'] as const)(
    'counts every %s array index after retention fills',
    (direction) => {
      const small = { rows: [] };
      const large = { rows: Array.from({ length: 1000 }, (_, index) => index) };
      const parity = artifactReplayParity({
        saved: direction === 'added' ? small : large,
        recomputed: direction === 'added' ? large : small,
        limits: { maximumDifferences: 1 },
      });
      expect(parity.differences).toEqual([]);
      expect(parity.addedPaths).toEqual(direction === 'added' ? ['rows[0]'] : []);
      expect(parity.removedPaths).toEqual(direction === 'removed' ? ['rows[0]'] : []);
      expect(parity.differenceCount).toBe(1000);
      expect(parity.truncated).toBe(true);
    },
  );

  it('never promotes an unretained nonnumeric change to withinTolerance', () => {
    const comparison = compareAnalysisArtifacts({
      baseline: fitArtifact({ extra: { changed: 1 } }),
      candidate: fitArtifact({ extra: { changed: 1.001, zAdded: true } }),
      limits: { maximumDifferences: 1 },
      tolerance: { absolute: 100, relative: 100 },
    });
    expect(comparison.result.differenceCount).toBe(2);
    expect(comparison.result.truncated).toBe(true);
    expect(comparison.withinTolerance).toBe(false);
  });

  it('does not mark an exactly full mixed report as truncated', () => {
    const parity = artifactReplayParity({
      saved: { old: true, value: 1 },
      recomputed: { fresh: true, value: 2 },
      limits: { maximumDifferences: 3 },
    });
    expect(parity.addedPaths).toEqual(['fresh']);
    expect(parity.removedPaths).toEqual(['old']);
    expect(parity.differences.map((item) => item.path)).toEqual(['value']);
    expect(parity.differenceCount).toBe(3);
    expect(parity.truncated).toBe(false);
  });

  it('retains at most maximumDifferences and says so', () => {
    const baseline = fitArtifact({ perSlice: Array.from({ length: 50 }, (_, i) => i / 100) });
    const candidate = fitArtifact({ perSlice: Array.from({ length: 50 }, (_, i) => i / 100 + 1) });
    const comparison = compareAnalysisArtifacts({
      baseline,
      candidate,
      limits: { maximumDifferences: 10 },
      tolerance: { absolute: 0, relative: 0 },
    });
    expect(comparison.result.differences).toHaveLength(10);
    expect(comparison.result.differenceCount).toBe(50);
    expect(comparison.result.truncated).toBe(true);
    expect(comparison.withinTolerance).toBe(false);
    expect(comparison.assumptions.limits).toEqual({
      maximumDifferences: 10,
      maximumLeaves: COMPARISON_LIMITS.maximumLeaves.default,
    });
  });

  it('refuses an oversized side before walking it', () => {
    const baseline = fitArtifact();
    const candidate = fitArtifact({ extra: { rows: Array.from({ length: 2_000 }, (_, i) => i) } });
    expect(
      codeOf(() =>
        compareAnalysisArtifacts({ baseline, candidate, limits: { maximumLeaves: 500 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(() =>
      compareAnalysisArtifacts({ baseline, candidate, limits: { maximumLeaves: 500 } }),
    ).toThrow(/input\.candidate exceeds the configured data-work limit/);
  });

  it('is count-safe: absurd, fractional, negative, and above-maximum limits refuse before work', () => {
    const baseline = fitArtifact();
    for (const bad of [0, -1, 1.5, 2 ** 32 + 0.5, 2 ** 53 + 2, 1e308, Number.NaN, '10']) {
      expect(
        codeOf(() =>
          compareAnalysisArtifacts({
            baseline,
            candidate: baseline,
            limits: { maximumDifferences: bad as never },
          }),
        ),
      ).toBe(ErrorCode.InputOutOfRange);
    }
    expect(
      codeOf(() =>
        compareAnalysisArtifacts({
          baseline,
          candidate: baseline,
          limits: { maximumDifferences: COMPARISON_LIMITS.maximumDifferences.maximum + 1 },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        compareAnalysisArtifacts({
          baseline,
          candidate: baseline,
          limits: { maximumLeaves: COMPARISON_LIMITS.maximumLeaves.maximum + 1 },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        compareAnalysisArtifacts({ baseline, candidate: baseline, limits: { bogus: 1 } as never }),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });
});

describe('artifactReplayParity', () => {
  const saved = { parameters: { rho: -0.3 }, rmse: 0.001, notes: ['a'] };

  it('is byte-exact: identical canonical bytes across key order, with matching hashes', () => {
    const parity = artifactReplayParity({
      saved,
      recomputed: { notes: ['a'], rmse: 0.001, parameters: { rho: -0.3 } },
    });
    expect(parity.identical).toBe(true);
    expect(parity.savedHash).toBe(contentHash(saved));
    expect(parity.recomputedHash).toBe(parity.savedHash);
    expect(parity.differences).toEqual([]);
    expect(parity.assumptions.comparison).toBe('canonical JSON bytes');
    expect(Object.isFrozen(parity)).toBe(true);
  });

  it('lists the first differing paths with values when parity fails', () => {
    const parity = artifactReplayParity({
      saved,
      recomputed: { parameters: { rho: -0.31 }, rmse: 0.001, notes: ['a', 'b'] },
    });
    expect(parity.identical).toBe(false);
    expect(parity.savedHash).not.toBe(parity.recomputedHash);
    expect(parity.differences.map((d) => d.path)).toEqual(['parameters.rho']);
    expect(parity.differences[0]!.absoluteDelta).toBeCloseTo(-0.01, 12);
    expect(parity.addedPaths).toEqual(['notes[1]']);
    expect(parity.differenceCount).toBe(2);
    expect(parity.truncated).toBe(false);
  });

  it('treats a NaN-for-NaN recomputation as identical (the wrapper is the byte)', () => {
    const parity = artifactReplayParity({
      saved: { v: Number.NaN },
      recomputed: { v: Number.NaN },
    });
    expect(parity.identical).toBe(true);
  });

  it('refuses hostile or missing sides and honors the limits', () => {
    expect(codeOf(() => artifactReplayParity({ saved } as never))).toBe(
      ErrorCode.InputMissingField,
    );
    // A saved result is always an object: null and scalars are refused, never hashed as "a result".
    expect(codeOf(() => artifactReplayParity({ saved: null, recomputed: saved } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => artifactReplayParity({ saved, recomputed: 42 } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => artifactReplayParity({ saved, recomputed: { f: () => 1 } }))).toBe(
      ErrorCode.SerializationUnsupportedValue,
    );
    expect(
      codeOf(() => artifactReplayParity({ saved, recomputed: saved, bogus: 1 } as never)),
    ).toBe(ErrorCode.InputUnknownField);
    const big = { rows: Array.from({ length: 5_000 }, (_, i) => i) };
    expect(
      codeOf(() =>
        artifactReplayParity({ saved: big, recomputed: big, limits: { maximumLeaves: 100 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    const many = artifactReplayParity({
      saved: { rows: Array.from({ length: 30 }, (_, i) => i) },
      recomputed: { rows: Array.from({ length: 30 }, (_, i) => i + 1) },
      limits: { maximumDifferences: 5 },
    });
    expect(many.differences).toHaveLength(5);
    expect(many.differenceCount).toBe(30);
    expect(many.truncated).toBe(true);
  });
});
