/**
 * Stage 4.5 Decision 2 — the fitted-model summary grammar: a complete summary validates, every
 * honesty rule refuses with its field and code, hostile shapes never reach the field walk, and the
 * predicate is exactly the validator behind a boolean door.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  contentHash,
  isFittedModelSummary,
  requireFittedModelSummary,
} from '@totalfinance/core/artifacts';
import type { FittedModelSummary } from '@totalfinance/core/artifacts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

function summary(overrides: Partial<Record<keyof FittedModelSummary, unknown>> = {}): unknown {
  return {
    family: 'volatility.ssvi',
    modelVersion: 1,
    parameters: {
      rho: -0.3,
      'phi.kind': 'power-law',
      'phi.eta': 1.2,
      'thetaTerm.theta': [0.01, 0.02],
    },
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
      calibratedRange: {
        logMoneyness: { minimum: -0.4, maximum: 0.3 },
        timeToExpiryYears: { minimum: 0.1, maximum: 2 },
      },
      notes: [],
    },
    weighting: 'vega',
    inputIdentity: { calibrationHash: contentHash({ slices: [] }), snapshotHash: null },
    warningCount: 0,
    ...overrides,
  };
}

describe('requireFittedModelSummary', () => {
  it('accepts a complete summary and returns it', () => {
    const value = summary();
    expect(requireFittedModelSummary('test', 'summary', value)).toBe(value);
    expect(isFittedModelSummary(value)).toBe(true);
    expect(
      isFittedModelSummary(
        summary({
          residuals: null,
          weighting: null,
          objective: {
            kind: 'not-applicable',
            value: null,
            unit: 'none',
            reason: 'an aggregate has no fitted objective',
          },
        }),
      ),
    ).toBe(true);
  });

  it('refuses a missing or unknown field naming the path', () => {
    const { warningCount: _dropped, ...missing } = summary() as Record<string, unknown>;
    expect(codeOf(() => requireFittedModelSummary('test', 'summary', missing))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(() => requireFittedModelSummary('test', 'summary', missing)).toThrow(
      /summary\.warningCount is required/,
    );
    expect(
      codeOf(() => requireFittedModelSummary('test', 'summary', summary({ bogus: 1 } as never))),
    ).toBe(ErrorCode.InputUnknownField);
  });

  it('enforces the family and model-version spellings', () => {
    expect(codeOf(() => requireFittedModelSummary('test', 's', summary({ family: 'ssvi' })))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(
      codeOf(() => requireFittedModelSummary('test', 's', summary({ family: 'Volatility.SSVI' }))),
    ).toBe(ErrorCode.InputWrongShape);
    expect(codeOf(() => requireFittedModelSummary('test', 's', summary({ modelVersion: 0 })))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      codeOf(() => requireFittedModelSummary('test', 's', summary({ modelVersion: '1' }))),
    ).toBe(ErrorCode.InputOutOfRange);
  });

  it('keeps parameters flat, finite, and named', () => {
    expect(
      codeOf(() =>
        requireFittedModelSummary('test', 's', summary({ parameters: { phi: { eta: 1 } } })),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        requireFittedModelSummary('test', 's', summary({ parameters: { rho: Number.NaN } })),
      ),
    ).toBe(ErrorCode.InputNaN);
    expect(
      codeOf(() =>
        requireFittedModelSummary('test', 's', summary({ parameters: { theta: [0.1, Infinity] } })),
      ),
    ).toBe(ErrorCode.InputNotFinite);
    expect(
      codeOf(() => requireFittedModelSummary('test', 's', summary({ parameters: { label: '' } }))),
    ).toBe(ErrorCode.InputWrongType);
  });

  it('demands a reason exactly when the objective is null', () => {
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({ objective: { kind: 'exact-bootstrap', value: null, unit: 'none' } }),
        ),
      ),
    ).toBe(ErrorCode.InputMissingField);
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({ objective: { kind: 'r-squared', value: 0.9, unit: 'none', reason: 'why' } }),
        ),
      ),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({ objective: { kind: 'least-squares', value: 1, unit: 'x' } }),
        ),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
  });

  it('types convergence, residuals, model risk, weighting, identity, and the warning count', () => {
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({ convergence: { converged: 'yes', iterations: null } }),
        ),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({ convergence: { converged: true, iterations: -1 } }),
        ),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({
            residuals: {
              count: 3,
              rootMeanSquare: -0.1,
              maximumAbsolute: null,
              unit: 'u',
              source: 'direct-evaluator',
            },
          }),
        ),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({
            residuals: {
              count: 3,
              rootMeanSquare: null,
              maximumAbsolute: null,
              unit: 'u',
              source: 'guessed',
            },
          }),
        ),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({
            modelRisk: {
              arbitrageFree: null,
              calibratedRange: { k: { minimum: 1, maximum: 0 } },
              notes: [],
            },
          }),
        ),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({ modelRisk: { arbitrageFree: true, calibratedRange: {}, notes: [''] } }),
        ),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => requireFittedModelSummary('test', 's', summary({ weighting: 3 })))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({ inputIdentity: { calibrationHash: 'abc', snapshotHash: null } }),
        ),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        requireFittedModelSummary(
          'test',
          's',
          summary({ inputIdentity: { calibrationHash: contentHash(1), snapshotHash: 'x' } }),
        ),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() => requireFittedModelSummary('test', 's', summary({ warningCount: 1.5 }))),
    ).toBe(ErrorCode.InputOutOfRange);
  });

  it('refuses hostile shapes before reading a field, and the predicate never throws', () => {
    const hostile = summary() as Record<string, unknown>;
    let read = 0;
    Object.defineProperty(hostile, 'weighting', {
      enumerable: true,
      get: () => {
        read += 1;
        return 'vega';
      },
    });
    expect(codeOf(() => requireFittedModelSummary('test', 's', hostile))).toBe(
      ErrorCode.SerializationUnsupportedValue,
    );
    expect(read).toBe(0);
    expect(isFittedModelSummary(hostile)).toBe(false);
    expect(isFittedModelSummary(null)).toBe(false);
    expect(isFittedModelSummary('summary')).toBe(false);
    expect(isFittedModelSummary(summary({ family: 'x' }))).toBe(false);
  });
});
