/**
 * Stage 4.5 slice 4 — the shared fitted-model kit is public through `@totalfinance/core/artifacts`,
 * so each helper is a closed, typed door like every other export: unknown keys, missing or
 * mistyped strings, malformed laws, foreign registries, and non-handles refuse with their codes,
 * and the happy paths return exactly what the domain adapters rely on.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  ARTIFACT_WORK_LIMITS,
  applyReportMigrations,
  contentHash,
  createArtifactMigrationRegistry,
  flattenSummaryParameters,
  requireComparisonTolerance,
  requireWorkLimit,
  residualStatistics,
  tableHandleForRows,
  verifyReferencedRows,
  type FittedModelSummary,
} from '@totalfinance/core/artifacts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

const summary = (): FittedModelSummary => ({
  family: 'volatility.ssvi',
  modelVersion: 1,
  parameters: { rho: -0.3, 'phi.kind': 'power-law', 'thetaTerm.theta': [0.01, 0.02] },
  objective: { kind: 'root-mean-square-error', value: 0.0012, unit: 'total variance' },
  convergence: { converged: true, iterations: 212 },
  residuals: {
    count: 40,
    rootMeanSquare: 0.0012,
    maximumAbsolute: 0.004,
    unit: 'total variance',
    source: 'direct-evaluator',
  },
  modelRisk: {
    arbitrageFree: true,
    calibratedRange: { logMoneyness: { minimum: -0.4, maximum: 0.3 } },
    notes: [],
  },
  weighting: null,
  inputIdentity: { calibrationHash: contentHash({ a: 1 }), snapshotHash: null },
  warningCount: 0,
});

describe('ARTIFACT_WORK_LIMITS', () => {
  it('is frozen, every default at or below its maximum', () => {
    expect(Object.isFrozen(ARTIFACT_WORK_LIMITS)).toBe(true);
    for (const law of Object.values(ARTIFACT_WORK_LIMITS)) {
      expect(Object.isFrozen(law)).toBe(true);
      if ('default' in law) expect(law.default).toBeLessThanOrEqual(law.maximum);
    }
  });
});

describe('requireWorkLimit', () => {
  const law = { default: 256, maximum: 4_096 };
  it('takes the default for undefined, the value in range, and refuses above the maximum or below the floor', () => {
    expect(requireWorkLimit({ functionName: 'f', field: 'x', value: undefined, law })).toBe(256);
    expect(requireWorkLimit({ functionName: 'f', field: 'x', value: 64, law })).toBe(64);
    expect(requireWorkLimit({ functionName: 'f', field: 'x', value: 0, law, floor: 0 })).toBe(0);
    expect(
      codeOf(() => requireWorkLimit({ functionName: 'f', field: 'x', value: 5_000, law })),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(codeOf(() => requireWorkLimit({ functionName: 'f', field: 'x', value: 0, law }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => requireWorkLimit({ functionName: 'f', field: 'x', value: 1.5, law }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      codeOf(() =>
        requireWorkLimit({ functionName: 'f', field: 'x', value: undefined, law: { maximum: 64 } }),
      ),
    ).toBe(ErrorCode.InputMissingField);
  });
  it('is a closed, typed door', () => {
    expect(codeOf(() => requireWorkLimit(null as never))).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        requireWorkLimit({ functionName: 'f', field: 'x', value: 1, law, extra: 1 } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(codeOf(() => requireWorkLimit({ field: 'x', value: 1, law } as never))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(
      codeOf(() => requireWorkLimit({ functionName: null, field: 'x', value: 1, law } as never)),
    ).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => requireWorkLimit({ functionName: 'f', field: '', value: 1, law }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      codeOf(() =>
        requireWorkLimit({
          functionName: 'f',
          field: 'x',
          value: 1,
          law: { maximum: 'a' },
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        requireWorkLimit({
          functionName: 'f',
          field: 'x',
          value: 1,
          law: { maximum: 4, top: 1 },
        } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() => requireWorkLimit({ functionName: 'f', field: 'x', value: 1, law, floor: NaN })),
    ).toBe(ErrorCode.InputWrongType);
  });
});

describe('requireComparisonTolerance', () => {
  it('returns null for an omitted tolerance, the pair when explicit, and refuses partial or negative ones', () => {
    expect(requireComparisonTolerance({ functionName: 'f', tolerance: undefined })).toBeNull();
    expect(
      requireComparisonTolerance({
        functionName: 'f',
        tolerance: { absolute: 1e-6, relative: 1e-4 },
      }),
    ).toEqual({ absolute: 1e-6, relative: 1e-4 });
    expect(
      codeOf(() =>
        requireComparisonTolerance({ functionName: 'f', tolerance: { absolute: 1e-6 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        requireComparisonTolerance({ functionName: 'f', tolerance: { absolute: -1, relative: 0 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(codeOf(() => requireComparisonTolerance({ functionName: 'f', tolerance: null }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => requireComparisonTolerance({ tolerance: undefined } as never))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(
      codeOf(() =>
        requireComparisonTolerance({ functionName: 'f', tolerance: undefined, x: 1 } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });
});

describe('applyReportMigrations', () => {
  const base = {
    functionName: 'f',
    kind: 'volatility.fitted-model:svi',
    report: { family: 'svi', modelVersion: 1, a: 1 },
    storedVersion: 1,
    currentVersion: 1,
    versionField: 'modelVersion',
    subject: "'svi' report",
  };
  it('passes a current report through, applies a registered family migration, and refuses newer or unmigrated-older ones', () => {
    expect(applyReportMigrations(base)).toEqual({
      report: base.report,
      modelMigrationsApplied: [],
    });
    const migrations = createArtifactMigrationRegistry();
    migrations.register({
      kind: base.kind,
      fromVersion: 1,
      toVersion: 2,
      description: 'rename a → alpha',
      migrate: (envelope) => {
        const report = envelope['report'] as Record<string, unknown>;
        const { a, ...rest } = report;
        return { ...envelope, schemaVersion: 2, report: { ...rest, alpha: a } };
      },
    });
    const migrated = applyReportMigrations({ ...base, currentVersion: 2, migrations });
    expect(migrated.report).toEqual({ family: 'svi', modelVersion: 2, alpha: 1 });
    expect(migrated.modelMigrationsApplied).toHaveLength(1);
    expect(codeOf(() => applyReportMigrations({ ...base, currentVersion: 2 }))).toBe(
      ErrorCode.ArtifactModelVersionUnsupported,
    );
    expect(codeOf(() => applyReportMigrations({ ...base, storedVersion: 3 }))).toBe(
      ErrorCode.ArtifactModelVersionUnsupported,
    );
    expect(codeOf(() => applyReportMigrations({ ...base, storedVersion: '1' }))).toBe(
      ErrorCode.InputOutOfRange,
    );
  });
  it('is a closed, typed door', () => {
    expect(codeOf(() => applyReportMigrations({ ...base, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => applyReportMigrations({ ...base, kind: '' }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => applyReportMigrations({ ...base, report: null } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => applyReportMigrations({ ...base, currentVersion: -1 }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => applyReportMigrations({ ...base, migrations: {} } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    const { subject: _subject, ...withoutSubject } = base;
    expect(codeOf(() => applyReportMigrations(withoutSubject as never))).toBe(
      ErrorCode.InputMissingField,
    );
  });
});

describe('verifyReferencedRows', () => {
  const rows = [
    { instrumentId: 'AAPL', value: 1 },
    { instrumentId: 'MSFT', value: 2 },
  ];
  const handle = tableHandleForRows({ rows });
  it('returns the rows when they hash to the handle and refuses different rows, non-arrays, and non-handles', () => {
    expect(verifyReferencedRows({ functionName: 'f', label: 'observations', handle, rows })).toBe(
      rows,
    );
    expect(
      codeOf(() =>
        verifyReferencedRows({ functionName: 'f', label: 'observations', handle, rows: [rows[0]] }),
      ),
    ).toBe(ErrorCode.ArtifactReferencedDataMismatch);
    expect(
      codeOf(() =>
        verifyReferencedRows({ functionName: 'f', label: 'observations', handle, rows: null }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    // A handle whose row count disagrees with the rows does not describe them, whatever it hashes to.
    expect(
      codeOf(() =>
        verifyReferencedRows({
          functionName: 'f',
          label: 'observations',
          handle: { ...handle, rowCount: 4_294_967_296 },
          rows,
        }),
      ),
    ).toBe(ErrorCode.ArtifactReferencedDataMismatch);
    expect(
      codeOf(() =>
        verifyReferencedRows({
          functionName: 'f',
          label: 'observations',
          handle: { ...handle, contentHash: 'sha256:00' } as never,
          rows,
        }),
      ),
    ).not.toBeUndefined();
    expect(
      codeOf(() =>
        verifyReferencedRows({
          functionName: 'f',
          label: 'observations',
          handle: {},
          rows,
        } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => verifyReferencedRows({ functionName: 'f', handle, rows } as never))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(
      codeOf(() =>
        verifyReferencedRows({ functionName: 'f', label: 'o', handle, rows, more: 1 } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });
});

describe('flattenSummaryParameters and residualStatistics', () => {
  it('flattens a validated summary (arrays become indexed keys) and refuses a non-summary', () => {
    expect(flattenSummaryParameters(summary())).toEqual({
      rho: -0.3,
      'phi.kind': 'power-law',
      'thetaTerm.theta[0]': 0.01,
      'thetaTerm.theta[1]': 0.02,
    });
    expect(codeOf(() => flattenSummaryParameters({ parameters: { a: 1 } } as never))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(codeOf(() => flattenSummaryParameters(null as never))).toBe(ErrorCode.InputWrongType);
  });
  it('reports count, root-mean-square, and maximum absolute — null statistics when empty', () => {
    expect(residualStatistics([])).toEqual({
      count: 0,
      rootMeanSquare: null,
      maximumAbsolute: null,
    });
    const stats = residualStatistics([3, -4]);
    expect(stats.count).toBe(2);
    expect(stats.rootMeanSquare).toBeCloseTo(Math.sqrt(12.5), 12);
    expect(stats.maximumAbsolute).toBe(4);
  });
});
