import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import {
  compareCalculationArtifacts,
  createAnalysisArtifact,
  artifactReplayParity,
  compareAnalysisArtifacts,
  canonicalJsonOf,
  fromCanonicalJson,
  contentHash,
  scanCanonicalData,
  type AnalysisArtifact,
  type CalculationMetric,
  type CalculationOperationPolicy,
} from '@totalfinance/core/artifacts';

function artifact(
  input: {
    value?: unknown;
    assumptions?: Record<string, unknown>;
    parameters?: unknown;
    noInputs?: boolean;
    snapshotHash?: string;
    libraryVersion?: string;
    operation?: string;
    artifactType?: string;
    result?: Record<string, unknown>;
  } = {},
): AnalysisArtifact {
  return createAnalysisArtifact({
    artifactType: input.artifactType ?? 'options.migration',
    producedBy: {
      operation: input.operation ?? 'options.price',
      libraryVersion: input.libraryVersion ?? '0.0.1',
    },
    inputs: input.noInputs
      ? {}
      : {
          parameters: input.parameters ?? { spot: 100, strike: 100, volatility: 0.2 },
          ...(input.snapshotHash ? { snapshotHash: input.snapshotHash } : {}),
        },
    result: {
      value: input.value === undefined ? 5 : input.value,
      assumptions: input.assumptions ?? { model: 'BSM', dayCount: 'ACT/365F', multiplier: 100 },
      diagnostics: { warnings: [] },
      ...input.result,
    },
  });
}

const metric = (): CalculationMetric => ({
  name: 'premium',
  baseline: { path: ['value'], unit: 'USD/share' },
  candidate: { path: ['value'], unit: 'USD/share' },
  tolerance: { absolute: 0.0001, relative: 0 },
});
function compare(
  input: {
    baseline?: AnalysisArtifact;
    candidate?: AnalysisArtifact;
    metrics?: CalculationMetric[];
    operationPolicy?: CalculationOperationPolicy;
  } = {},
) {
  return compareCalculationArtifacts({
    baseline: input.baseline ?? artifact(),
    candidate: input.candidate ?? artifact(),
    metrics: input.metrics ?? [metric()],
    ...(input.operationPolicy === undefined ? {} : { operationPolicy: input.operationPolicy }),
  });
}
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(InputError);
    return (error as InputError).code;
  }
  return undefined;
}

describe('financial artifact comparison', () => {
  it('uses separate monetary and Greek tolerances and keeps exact replay separate', () => {
    const baseline = artifact({ result: { delta: 0.5 } });
    const candidate = artifact({ value: 5.00001, result: { delta: 0.50001 } });
    const delta: CalculationMetric = {
      name: 'delta',
      baseline: { path: ['delta'], unit: 'delta/share' },
      candidate: { path: ['delta'], unit: 'delta/share' },
      tolerance: { absolute: 0.000001, relative: 0 },
    };
    const report = compare({ baseline, candidate, metrics: [metric(), delta] });
    expect(report.status).toBe('mismatch');
    expect(report.metrics.map((row) => row.withinTolerance)).toEqual([true, false]);
    expect(
      artifactReplayParity({ saved: baseline.result, recomputed: candidate.result }).identical,
    ).toBe(false);
    expect(compare({ baseline, candidate, metrics: [metric()] }).status).toBe('match');
  });

  it.each(['model', 'dayCount', 'multiplier', 'dividendYield', 'priceSource', 'greekSource'])(
    'never promotes equal numbers with a different %s into a match',
    (field) => {
      const report = compare({
        baseline: artifact({ assumptions: { [field]: 'baseline' } }),
        candidate: artifact({ assumptions: { [field]: 'candidate' } }),
      });
      expect(report.status).toBe('not-comparable');
      expect(report.numericAgreement).toBe(true);
      expect(report.context.assumptionComparison.differences[0]!.path).toBe(field);
      expect(report.reasons).toContain('different-assumptions');
    },
  );

  it('refuses to infer conversion between per-share and per-contract prices', () => {
    const selected = metric();
    selected.candidate.unit = 'USD/contract';
    const report = compare({ candidate: artifact({ value: 500 }), metrics: [selected] });
    expect(report.status).toBe('not-comparable');
    expect(report.metrics[0]).toMatchObject({
      absoluteDelta: null,
      withinTolerance: null,
      sameUnit: false,
    });
  });

  it('reports changed and unrecorded input identity rather than certifying an empty hash', () => {
    expect(compare({ candidate: artifact({ parameters: { spot: 101 } }) }).reasons).toContain(
      'different-inputs',
    );
    expect(
      compare({ baseline: artifact({ noInputs: true }), candidate: artifact({ noInputs: true }) })
        .status,
    ).toBe('insufficient-evidence');
    expect(
      compare({ baseline: artifact({ assumptions: {} }), candidate: artifact({ assumptions: {} }) })
        .reasons,
    ).toContain('unrecorded-assumptions');
    expect(
      compare({
        baseline: artifact({ snapshotHash: contentHash('one') }),
        candidate: artifact({ snapshotHash: contentHash('two') }),
      }).context.sameSnapshotHash,
    ).toBe(false);
  });

  it('supports explicit mapping across result schemas and dotted literal keys without guessing', () => {
    const selected = metric();
    selected.candidate.path = ['rows', 0, 'price.usd'];
    const report = compare({
      candidate: artifact({ artifactType: 'other.result', result: { rows: [{ 'price.usd': 5 }] } }),
      metrics: [selected],
    });
    expect(report.status).toBe('match');
  });

  it.each([
    [null, 'null'],
    ['5', 'non-numeric'],
    [Number.NaN, 'non-finite'],
    [Infinity, 'non-finite'],
  ])('does not equate unavailable values (%s)', (value, unavailableReason) => {
    const report = compare({ baseline: artifact({ value }), candidate: artifact({ value }) });
    expect(report.status).toBe('insufficient-evidence');
    expect(report.metrics[0]!.baseline.unavailableReason).toBe(unavailableReason);
    expect(report.numericAgreement).toBeNull();
  });

  it('reports missing paths and zero-baseline relative changes honestly', () => {
    const selected = metric();
    selected.candidate.path = ['does-not-exist'];
    expect(compare({ metrics: [selected] }).metrics[0]!.candidate.unavailableReason).toBe(
      'missing',
    );
    const report = compare({
      baseline: artifact({ value: 0 }),
      candidate: artifact({ value: 0.00001 }),
    });
    expect(report.status).toBe('match');
    expect(report.metrics[0]!.relativeDelta).toBeNull();
  });

  it('keeps extreme comparison results finite and never compares Infinity <= Infinity', () => {
    const baseline = artifact({ value: -Number.MAX_VALUE });
    const candidate = artifact({ value: Number.MAX_VALUE });
    const selected = metric();
    selected.tolerance = { absolute: Number.MAX_VALUE, relative: 0.5 };
    const report = compare({ baseline, candidate, metrics: [selected] });
    expect(report.status).toBe('mismatch');
    expect(report.metrics[0]).toMatchObject({
      absoluteDelta: null,
      relativeDelta: 2,
      withinTolerance: false,
    });
    const structural = compareAnalysisArtifacts({
      baseline,
      candidate,
      tolerance: selected.tolerance,
    });
    expect(structural.withinTolerance).toBe(false);
    expect(structural.result.differences[0]).toMatchObject({
      absoluteDelta: null,
      relativeDelta: 2,
    });
    selected.tolerance.relative = 1;
    expect(compare({ baseline, candidate, metrics: [selected] }).status).toBe('match');
    expect(JSON.stringify(report)).not.toContain('Infinity');
  });

  it('verifies hashes, preserves original data and returns a frozen savable report', () => {
    const baseline = artifact();
    const roundTripped = fromCanonicalJson(canonicalJsonOf(baseline)) as AnalysisArtifact;
    const report = compare({ baseline, candidate: roundTripped });
    expect(Object.isFrozen(report.metrics)).toBe(true);
    expect(() =>
      createAnalysisArtifact({
        artifactType: 'comparison.report',
        producedBy: { operation: 'compareCalculationArtifacts' },
        inputs: { parameters: { baselineId: baseline.id } },
        result: report,
      }),
    ).not.toThrow();
    const tampered = JSON.parse(JSON.stringify(baseline)) as AnalysisArtifact;
    tampered.result['value'] = 7;
    expect(codeOf(() => compare({ candidate: tampered }))).toBeDefined();
    expect(roundTripped.result['value']).toBe(5);
  });

  it('is directly assignable to the saved-analysis result contract without a cast', () => {
    const comparison = compare();
    const result = comparison satisfies Parameters<typeof createAnalysisArtifact>[0]['result'];
    const saved = createAnalysisArtifact({
      artifactType: 'comparison.report',
      producedBy: { operation: 'compareCalculationArtifacts' },
      result,
    });
    expect(saved.result).toEqual(comparison);
  });

  it('discloses bounded/truncated context and different producer versions', () => {
    const baseline = artifact({ assumptions: { x: 1, y: 2, z: 3 } });
    const candidate = artifact({ assumptions: { x: 4, y: 5, z: 6 }, libraryVersion: '0.0.2' });
    const report = compareCalculationArtifacts({
      baseline,
      candidate,
      metrics: [metric()],
      limits: { maximumDifferences: 1 },
    });
    expect(report.reasons).toContain('truncated-context');
    expect(report.context.assumptionComparison.differenceCount).toBe(3);
    expect(
      report.diagnostics.warnings.some((item) => item.code === 'artifact.library_version_differs'),
    ).toBe(true);
  });

  it('rejects malformed controls with typed indexed errors and bounds arrays before traversal', () => {
    const input = { baseline: artifact(), candidate: artifact(), metrics: [metric()] };
    expect(codeOf(() => compareCalculationArtifacts(undefined as never))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(codeOf(() => compareCalculationArtifacts({ ...input, metric: [] } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => compareCalculationArtifacts({ ...input, metrics: new Array(1) }))).toBe(
      ErrorCode.InputWrongShape,
    );
    const huge = new Array(1001);
    Object.defineProperty(huge, '0', {
      get() {
        throw new Error('must not touch');
      },
    });
    expect(codeOf(() => compareCalculationArtifacts({ ...input, metrics: huge }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => compareCalculationArtifacts({ ...input, metrics: [] }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      codeOf(() => compareCalculationArtifacts({ ...input, metrics: [metric(), metric()] })),
    ).toBe(ErrorCode.InputOutOfRange);
    for (const [value, code] of [
      // Explicit undefined is not canonical control data; an omitted required field still
      // receives InputMissingField from the semantic validator after the bounded scan.
      [undefined, ErrorCode.SerializationUnsupportedValue],
      [null, ErrorCode.InputWrongType],
      ['0', ErrorCode.InputWrongType],
      [NaN, ErrorCode.InputNaN],
      [Infinity, ErrorCode.InputNotFinite],
      [-1, ErrorCode.InputOutOfRange],
    ] as const) {
      const selected = metric();
      selected.tolerance.absolute = value as number;
      expect(codeOf(() => compare({ metrics: [selected] }))).toBe(code);
    }
    const selected = metric();
    selected.baseline.path = new Array(1);
    expect(codeOf(() => compare({ metrics: [selected] }))).toBe(
      ErrorCode.SerializationUnsupportedValue,
    );
    expect(
      codeOf(() => compareCalculationArtifacts({ ...input, limits: { maximumLeaves: 1 } })),
    ).toBe(ErrorCode.InputOutOfRange);
  });

  it.each([
    { baseline: Number.MIN_VALUE, candidate: 0, absolute: 0, relative: 0.75, expected: false },
    {
      baseline: Number.MIN_VALUE,
      candidate: 2 * Number.MIN_VALUE,
      absolute: 0,
      relative: 0.75,
      expected: false,
    },
    {
      baseline: Number.MIN_VALUE,
      candidate: -Number.MIN_VALUE,
      absolute: 0,
      relative: 1.5,
      expected: false,
    },
    { baseline: 3, candidate: 4, absolute: 0, relative: 1 / 3, expected: false },
    { baseline: 3, candidate: 4, absolute: 0.5, relative: 1 / 6, expected: false },
    { baseline: 1, candidate: -Number.MIN_VALUE, absolute: 1, relative: 0, expected: false },
    {
      baseline: Number.MAX_VALUE,
      candidate: -Number.MIN_VALUE,
      absolute: 0,
      relative: 1,
      expected: false,
    },
    {
      baseline: -Number.MAX_VALUE,
      candidate: Number.MAX_VALUE,
      absolute: Number.MAX_VALUE,
      relative: 0.5,
      expected: false,
    },
    {
      baseline: -Number.MAX_VALUE,
      candidate: Number.MAX_VALUE,
      absolute: Number.MAX_VALUE,
      relative: 1,
      expected: true,
    },
    { baseline: Number.MIN_VALUE, candidate: 0, absolute: 0, relative: 1, expected: true },
    { baseline: 3, candidate: 4, absolute: 0.5, relative: 0.25, expected: true },
    {
      baseline: 0,
      candidate: Number.MIN_VALUE,
      absolute: 0,
      relative: Number.MAX_VALUE,
      expected: false,
    },
    { baseline: 0, candidate: -0, absolute: 0, relative: 0, expected: true },
  ])(
    'decides the exact IEEE inequality: $baseline to $candidate ($absolute, $relative)',
    ({ baseline: before, candidate: after, absolute, relative, expected }) => {
      const baseline = artifact({ value: before });
      const candidate = artifact({ value: after });
      const selected = metric();
      selected.tolerance = { absolute, relative };
      const report = compare({ baseline, candidate, metrics: [selected] });
      expect(report.metrics[0]!.withinTolerance).toBe(expected);
      expect(report.numericAgreement).toBe(expected);
      expect(report.status).toBe(expected ? 'match' : 'mismatch');
      expect(
        compareAnalysisArtifacts({ baseline, candidate, tolerance: selected.tolerance })
          .withinTolerance,
      ).toBe(expected);
    },
  );

  it('matches an independent exact dyadic oracle over 36,450 extreme and boundary cases', () => {
    // Independent representation: parse JavaScript's exact base-2 digits into a rational.
    // Production instead decodes IEEE bits into fixed 2^-1074 integer units.
    interface Dyadic {
      coefficient: bigint;
      exponent: number;
    }
    const cache = new Map<number, Dyadic>();
    const dyadic = (value: number): Dyadic => {
      const saved = cache.get(value);
      if (saved !== undefined) return saved;
      const [whole, fraction = ''] = Math.abs(value).toString(2).split('.');
      const result = {
        coefficient: BigInt(`0b${whole}${fraction}`) * (value < 0 ? -1n : 1n),
        exponent: -fraction.length,
      };
      cache.set(value, result);
      return result;
    };
    const add = (left: Dyadic, right: Dyadic): Dyadic => {
      const exponent = Math.min(left.exponent, right.exponent);
      return {
        coefficient:
          (left.coefficient << BigInt(left.exponent - exponent)) +
          (right.coefficient << BigInt(right.exponent - exponent)),
        exponent,
      };
    };
    const exact = (
      baseline: number,
      candidate: number,
      absolute: number,
      relative: number,
    ): boolean => {
      const delta = add(dyadic(candidate), dyadic(-baseline));
      const change = {
        ...delta,
        coefficient: delta.coefficient < 0n ? -delta.coefficient : delta.coefficient,
      };
      const scale = dyadic(Math.abs(baseline)),
        fraction = dyadic(relative);
      const threshold = add(dyadic(absolute), {
        coefficient: scale.coefficient * fraction.coefficient,
        exponent: scale.exponent + fraction.exponent,
      });
      return add(threshold, { ...change, coefficient: -change.coefficient }).coefficient >= 0n;
    };
    const positive = [
      Number.MIN_VALUE,
      2 * Number.MIN_VALUE,
      3 * Number.MIN_VALUE,
      1e-320,
      2 ** -1022,
      1e-200,
      1e-20,
      1,
      2,
      1e20,
      1e200,
      1e308,
      Number.MAX_VALUE,
    ];
    const values = [0, ...positive, ...positive.map((value) => -value)];
    const artifacts = values.map((value) => artifact({ value }));
    const tolerances = [0, Number.MIN_VALUE, 1e-20, 1, Number.MAX_VALUE].flatMap((absolute) =>
      [0, Number.MIN_VALUE, 1e-20, 0.25, 0.5, 0.75, 1, 1.5, 2, Number.MAX_VALUE].map(
        (relative) => ({ absolute, relative }),
      ),
    );
    const metrics = tolerances.map((tolerance, index) => ({
      ...metric(),
      name: `case-${index}`,
      tolerance,
    }));
    let checked = 0;
    for (let i = 0; i < values.length; i++)
      for (let j = 0; j < values.length; j++) {
        const report = compare({ baseline: artifacts[i]!, candidate: artifacts[j]!, metrics });
        for (let k = 0; k < tolerances.length; k++) {
          const { absolute, relative } = tolerances[k]!;
          const expected = exact(values[i]!, values[j]!, absolute, relative);
          expect(
            report.metrics[k]!.withinTolerance,
            JSON.stringify({ baseline: values[i], candidate: values[j], absolute, relative }),
          ).toBe(expected);
          checked++;
        }
      }
    expect(checked).toBe(36_450);
  });

  it('requires the same operation by default and discloses explicit cross-operation comparison', () => {
    const baseline = artifact({
      operation: 'options.blackScholes',
      assumptions: { dayCount: 'ACT/365F' },
    });
    const candidate = artifact({
      operation: 'options.bachelier',
      assumptions: { dayCount: 'ACT/365F' },
    });
    const strict = compare({ baseline, candidate });
    expect(strict.status).toBe('not-comparable');
    expect(strict.numericAgreement).toBe(true);
    expect(strict.assumptions.operationPolicy).toBe('require-same');
    expect(strict.context.operations).toEqual({
      baseline: 'options.blackScholes',
      candidate: 'options.bachelier',
    });
    expect(strict.context.sameOperation).toBe(false);
    expect(strict.reasons).toContain('different-operations');
    const allowed = compare({ baseline, candidate, operationPolicy: 'compare-declared-metrics' });
    expect(allowed.status).toBe('match');
    expect(allowed.assumptions.operationPolicy).toBe('compare-declared-metrics');
    expect(allowed.reasons).toContain('different-operations');
    expect(
      allowed.diagnostics.warnings.some(
        (item) =>
          item.message.includes('options.blackScholes') &&
          item.message.includes('options.bachelier') &&
          item.message.includes('does not establish'),
      ),
    ).toBe(true);
    expect(
      compare({
        baseline,
        candidate: artifact({ operation: 'options.bachelier', assumptions: { model: 'normal' } }),
        operationPolicy: 'compare-declared-metrics',
      }).status,
    ).toBe('not-comparable');
    for (const bad of [null, true, 1, 'compare', {}]) {
      expect(
        codeOf(() =>
          compareCalculationArtifacts({
            baseline,
            candidate,
            metrics: [metric()],
            operationPolicy: bad as never,
          }),
        ),
      ).toBe(ErrorCode.InputInvalidEnum);
    }
  });

  it.each([{}, []])('does not treat empty parameters %j as input evidence', (parameters) => {
    const baseline = artifact({ parameters });
    const report = compare({ baseline, candidate: baseline });
    expect(report.status).toBe('insufficient-evidence');
    expect(report.context.inputs).toBe('unrecorded');
    expect(report.reasons).toContain('unrecorded-inputs');
    expect(compare({ baseline, candidate: artifact() }).reasons).toContain('unrecorded-inputs');
    const withSnapshot = artifact({ parameters, snapshotHash: contentHash('recorded snapshot') });
    expect(compare({ baseline: withSnapshot, candidate: withSnapshot }).status).toBe('match');
  });

  it.each([0, false, { spot: 0 }, [0]])(
    'keeps explicit nonempty or scalar parameters %j meaningful',
    (parameters) => {
      const baseline = artifact({ parameters });
      expect(compare({ baseline, candidate: baseline }).status).toBe('match');
    },
  );

  it.each(['baseline', 'candidate'] as const)(
    'preserves %s source diagnostics, including non-error warnings and decoration',
    (side) => {
      const diagnostics = {
        converged: true,
        engine: 'independent-solver',
        requestId: 'audit-123',
        metadata: { iterations: 7 },
        warnings: [
          {
            code: 'source.notice',
            message: 'Informational source qualification.',
            severity: 'info',
            context: { feed: 'observed' },
            decoration: 'preserved',
          },
          { code: 'source.warning', message: 'Quote is old.', severity: 'warn' },
        ],
      };
      const baseline = artifact({ result: { diagnostics } });
      const report = compare({ [side]: baseline });
      expect(report.status).toBe('match');
      expect(report.context.sourceDiagnostics[side]).toEqual(diagnostics);
      expect(
        report.context.sourceDiagnostics[side === 'baseline' ? 'candidate' : 'baseline'],
      ).toEqual({ warnings: [] });
      expect(report.diagnostics.warnings.map((item) => item.code)).toEqual([
        'source.notice',
        'source.warning',
      ]);
      expect(report.diagnostics.warnings[0]!.context).toEqual({
        sourceSide: side,
        artifactId: baseline.id,
        sourceContext: { feed: 'observed' },
      });
      expect(Object.isFrozen(report.context.sourceDiagnostics[side].warnings)).toBe(true);
      const saved = createAnalysisArtifact({
        artifactType: 'comparison.report',
        producedBy: { operation: 'compareCalculationArtifacts' },
        result: report,
      });
      expect(
        artifactReplayParity({
          saved: saved.result,
          recomputed: report,
        }).identical,
      ).toBe(true);
      diagnostics.metadata.iterations = 99;
      expect(report.context.sourceDiagnostics[side]['metadata']).toEqual({ iterations: 7 });
    },
  );

  it.each(['baseline', 'candidate'] as const)(
    'makes %s non-convergence or error warnings insufficient evidence even with other mismatches',
    (side) => {
      for (const result of [
        { diagnostics: { converged: false, warnings: [] } },
        { converged: false },
        {
          diagnostics: {
            warnings: [
              {
                code: 'solver.not_converged',
                severity: 'error',
                message: 'Iteration limit reached; value is the last iterate.',
              },
            ],
          },
        },
      ]) {
        const source = artifact({ result });
        const report = compare({ [side]: source });
        expect(report.status).toBe('insufficient-evidence');
        expect(report.numericAgreement).toBe(true);
        expect(report.reasons).toContain('source-failure');
        expect(
          report.diagnostics.warnings.some(
            (item) => item.severity === 'error' && item.context?.['sourceSide'] === side,
          ),
        ).toBe(true);
        const selected = metric();
        selected.candidate.unit = 'USD/contract';
        const mismatch = compare({ [side]: source, metrics: [selected] });
        expect(mismatch.status).toBe('insufficient-evidence');
        expect(mismatch.reasons).toContain('different-units');
      }
    },
  );

  it('validates every consumed source diagnostic field with side/index teaching', () => {
    const badDiagnostics = [
      { converged: null, warnings: [] },
      { converged: 'false', warnings: [] },
      { warnings: [null] },
      { warnings: [42] },
      { warnings: [{ code: 42, message: 'x', severity: 'error' }] },
      { warnings: [{ code: 'x', message: null, severity: 'error' }] },
      { warnings: [{ code: 'x', message: 'x', severity: 'fatal' }] },
      { warnings: [{ code: 'x', message: 'x', severity: 'warn', context: [] }] },
      { warnings: [], timingMs: Infinity },
    ];
    for (const diagnostics of badDiagnostics) {
      expect(() => compare({ candidate: artifact({ result: { diagnostics } }) })).toThrow(
        InputError,
      );
      expect(() => compare({ candidate: artifact({ result: { diagnostics } }) })).toThrow(
        /input\.candidate\.result\.diagnostics/,
      );
    }
    expect(() => compare({ candidate: artifact({ result: { converged: 'false' } }) })).toThrow(
      /input\.candidate\.result\.converged/,
    );
  });

  it('keeps both source warning streams distinct and does not let operation opt-in erase failures', () => {
    const baseline = artifact({
      operation: 'legacy.price',
      result: {
        diagnostics: {
          engine: 'baseline-engine',
          warnings: [
            {
              code: 'same-code',
              message: 'Baseline qualification.',
              severity: 'warn',
              context: { provider: 'baseline-feed' },
            },
          ],
        },
      },
    });
    const candidate = artifact({
      operation: 'candidate.price',
      result: {
        diagnostics: {
          engine: 'candidate-engine',
          warnings: [
            {
              code: 'same-code',
              message: 'Candidate failure.',
              severity: 'error',
              context: { provider: 'candidate-feed' },
            },
          ],
        },
      },
    });
    const report = compare({ baseline, candidate, operationPolicy: 'compare-declared-metrics' });
    expect(report.status).toBe('insufficient-evidence');
    expect(report.reasons).toEqual(['different-operations', 'source-failure']);
    expect(report.context.sourceDiagnostics.baseline).toEqual(baseline.result['diagnostics']);
    expect(report.context.sourceDiagnostics.candidate).toEqual(candidate.result['diagnostics']);
    expect(
      report.diagnostics.warnings
        .filter((item) => item.code === 'same-code')
        .map((item) => item.context),
    ).toEqual([
      {
        sourceSide: 'baseline',
        artifactId: baseline.id,
        sourceContext: { provider: 'baseline-feed' },
      },
      {
        sourceSide: 'candidate',
        artifactId: candidate.id,
        sourceContext: { provider: 'candidate-feed' },
      },
    ]);
  });

  it('keeps optional defaults, but missing required metric fields still teach', () => {
    expect(
      compareCalculationArtifacts({
        baseline: artifact(),
        candidate: artifact(),
        metrics: [metric()],
        operationPolicy: undefined,
        limits: { maximumLeaves: undefined, maximumDifferences: undefined },
      } as never).status,
    ).toBe('match');
    const selected = metric();
    delete (selected.tolerance as Partial<typeof selected.tolerance>).absolute;
    expect(codeOf(() => compare({ metrics: [selected] }))).toBe(ErrorCode.InputMissingField);
  });

  it('refuses artifact accessors/cycles without invocation, before the reader hashes or copies', () => {
    let touched = false;
    const baseline = artifact();
    const accessor = { ...baseline };
    Object.defineProperty(accessor, 'result', {
      enumerable: true,
      get() {
        touched = true;
        throw new Error('must not run');
      },
    });
    expect(() => compare({ baseline, candidate: accessor })).toThrow(InputError);
    expect(touched).toBe(false);
    const cyclic = { ...baseline, result: { ...baseline.result } };
    cyclic.result['self'] = cyclic;
    expect(() => compare({ baseline, candidate: cyclic })).toThrow(InputError);
  });

  it('rejects overridden map methods and array subclasses before running caller behavior', () => {
    let calls = 0;
    const override = () => {
      calls++;
      return [];
    };
    for (const target of ['metrics', 'path'] as const) {
      const selected = metric(),
        metrics = [selected];
      Object.defineProperty(target === 'metrics' ? metrics : selected.baseline.path, 'map', {
        value: override,
      });
      expect(() => compare({ metrics })).toThrow(InputError);
    }
    class DecoratedArray<T> extends Array<T> {}
    expect(() => compare({ metrics: new DecoratedArray(metric()) })).toThrow(InputError);
    const decorated = [metric()];
    Object.defineProperty(decorated, 'map', { value: null });
    expect(() => compare({ metrics: decorated })).toThrow(InputError);
    expect(calls).toBe(0);
  });

  it('rejects accessors at every control layer without invoking them', () => {
    let calls = 0;
    for (const target of [
      'input',
      'limits',
      'metric',
      'selector',
      'tolerance',
      'array',
      'path',
    ] as const) {
      const selected = metric();
      const input = {
        baseline: artifact(),
        candidate: artifact(),
        metrics: [selected],
        limits: { maximumLeaves: 1000 },
      };
      const [object, key]: [object, string] =
        target === 'input'
          ? [input, 'metrics']
          : target === 'limits'
            ? [input.limits, 'maximumLeaves']
            : target === 'metric'
              ? [selected, 'name']
              : target === 'selector'
                ? [selected.baseline, 'path']
                : target === 'tolerance'
                  ? [selected.tolerance, 'absolute']
                  : target === 'array'
                    ? [input.metrics, '0']
                    : [selected.baseline.path, '0'];
      Object.defineProperty(object, key, {
        enumerable: true,
        get() {
          calls++;
          throw new Error('raw accessor escaped');
        },
      });
      expect(() => compareCalculationArtifacts(input)).toThrow(InputError);
    }
    expect(calls).toBe(0);
  });

  it('bounds metric names, per-side units and path text together before copying them', () => {
    for (const target of [
      'name',
      'baseline-unit',
      'candidate-unit',
      'baseline-path',
      'candidate-path',
    ] as const) {
      const selected = metric(),
        text = 'x'.repeat(640_001);
      if (target === 'name') selected.name = text;
      else if (target === 'baseline-unit') selected.baseline.unit = text;
      else if (target === 'candidate-unit') selected.candidate.unit = text;
      else if (target === 'baseline-path') selected.baseline.path = [text];
      else selected.candidate.path = [text];
      expect(
        codeOf(() =>
          compareCalculationArtifacts({
            baseline: artifact(),
            candidate: artifact(),
            metrics: [selected],
            limits: { maximumLeaves: 1000 },
          }),
        ),
      ).toBe(ErrorCode.InputOutOfRange);
    }
    const selected = metric();
    selected.name = 'x'.repeat(20_000);
    const cost = scanCanonicalData(
      { metrics: [selected], limits: { maximumLeaves: 1 } },
      { functionName: 'test', label: 'controls' },
    );
    const request = { baseline: artifact(), candidate: artifact(), metrics: [selected] };
    expect(
      compareCalculationArtifacts({ ...request, limits: { maximumLeaves: cost } }).status,
    ).toBe('match');
    expect(
      codeOf(() =>
        compareCalculationArtifacts({ ...request, limits: { maximumLeaves: cost - 1 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
  });

  it('discloses truncation for added or removed assumptions under the global retention cap', () => {
    const extra = Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [`new${index}`, index]),
    );
    const small = artifact({ assumptions: { model: 'BSM' } });
    const large = artifact({ assumptions: { model: 'BSM', ...extra } });
    for (const [baseline, candidate] of [
      [small, large],
      [large, small],
    ] as const) {
      const report = compareCalculationArtifacts({
        baseline,
        candidate,
        metrics: [metric()],
        limits: { maximumDifferences: 1 },
      });
      const context = report.context.assumptionComparison;
      expect(
        context.differences.length + context.addedPaths.length + context.removedPaths.length,
      ).toBe(1);
      expect(context.differenceCount).toBe(1000);
      expect(context.truncated).toBe(true);
      expect(report.reasons).toContain('truncated-context');
    }
  });
});
