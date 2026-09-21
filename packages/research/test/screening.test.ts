/**
 * FC3 — screening: the closed grammar's teaching errors, point-in-time eligibility, version
 * resolution, missing-value policies, permutation determinism, and the honest exclusion ledger.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { rankUniverse, screenUniverse, scoreUniverse } from '../src/screening.js';
import { requireReturnObservations } from '../src/observations.js';
import type { FieldDefinition, UniverseObservation } from '../src/observations.js';

const FIELDS: FieldDefinition[] = [
  { fieldName: 'returnOnInvestedCapital', kind: 'numeric', unit: 'decimal ratio' },
  { fieldName: 'netDebtToEbitda', kind: 'numeric', unit: 'ratio' },
  { fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' },
  { fieldName: 'sector', kind: 'category' },
  { fieldName: 'isProfitable', kind: 'boolean' },
];

const AS_OF = Date.UTC(2026, 7, 12, 20);
const AVAILABLE = Date.UTC(2026, 7, 1);

function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function row(
  instrumentId: string,
  fields: UniverseObservation['fields'],
  availableTimestampMs = AVAILABLE,
): UniverseObservation {
  return { instrumentId, availableTimestampMs, fields };
}

const OBSERVATIONS: UniverseObservation[] = [
  row('AAA', {
    returnOnInvestedCapital: 0.22,
    netDebtToEbitda: 1.1,
    freeCashFlowYield: 0.06,
    sector: 'tech',
    isProfitable: true,
  }),
  row('BBB', {
    returnOnInvestedCapital: 0.18,
    netDebtToEbitda: 0.8,
    freeCashFlowYield: 0.08,
    sector: 'tech',
    isProfitable: true,
  }),
  row('CCC', {
    returnOnInvestedCapital: 0.09,
    netDebtToEbitda: 3.0,
    freeCashFlowYield: 0.02,
    sector: 'energy',
    isProfitable: false,
  }),
  row('DDD', {
    returnOnInvestedCapital: 0.3,
    netDebtToEbitda: null,
    freeCashFlowYield: 0.05,
    sector: 'health',
    isProfitable: true,
  }),
  row('EEE', {
    returnOnInvestedCapital: 0.16,
    netDebtToEbitda: 1.9,
    freeCashFlowYield: 0.08,
    sector: 'tech',
    isProfitable: true,
  }),
];

const BASE = {
  universeId: 'test-universe@2026-08-12',
  asOf: AS_OF,
  observations: OBSERVATIONS,
  fieldDefinitions: FIELDS,
  missingValuePolicy: 'exclude' as const,
  orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' as const }],
};

describe('screenUniverse', () => {
  it('filters, orders with the stable tie-breaker, and ledgers every exclusion', () => {
    const result = screenUniverse({
      ...BASE,
      filter: {
        all: [
          { field: 'returnOnInvestedCapital', operator: 'greaterThanOrEqual', value: 0.15 },
          { field: 'netDebtToEbitda', operator: 'lessThanOrEqual', value: 2 },
        ],
      },
    });
    // AAA/BBB/EEE pass; CCC fails both; DDD is missing netDebtToEbitda → excluded with reason.
    // BBB and EEE tie at 0.08 free-cash-flow yield → instrumentId ascending breaks it.
    expect(result.rows.map((r) => r.instrumentId)).toEqual(['BBB', 'EEE', 'AAA']);
    expect(result.diagnostics.exclusionReasons['filtered-out']).toBe(1);
    expect(result.diagnostics.exclusionReasons['missing-value-at-filtered-field']).toBe(1);
    expect(result.diagnostics.includedCount).toBe(3);
    expect(result.assumptions.finalTieBreaker).toBe('instrumentId ascending');
  });

  it('is deterministic under input permutation (the acceptance law)', () => {
    const reversed = screenUniverse({
      ...BASE,
      observations: [...OBSERVATIONS].reverse(),
      filter: { field: 'isProfitable', operator: 'equals', value: true },
    });
    const forward = screenUniverse({
      ...BASE,
      filter: { field: 'isProfitable', operator: 'equals', value: true },
    });
    expect(reversed.rows).toEqual(forward.rows);
  });

  it('availability, not presence, controls what a screen sees; later versions win', () => {
    const withLate = screenUniverse({
      ...BASE,
      observations: [
        ...OBSERVATIONS,
        row(
          'FFF',
          {
            returnOnInvestedCapital: 0.5,
            netDebtToEbitda: 0,
            freeCashFlowYield: 0.2,
            sector: 'tech',
            isProfitable: true,
          },
          AS_OF + 1,
        ),
        row(
          'AAA',
          {
            returnOnInvestedCapital: 0.25,
            netDebtToEbitda: 1.0,
            freeCashFlowYield: 0.07,
            sector: 'tech',
            isProfitable: true,
          },
          AVAILABLE + 1000,
        ),
      ],
    });
    expect(withLate.diagnostics.exclusionReasons['not-yet-available-at-asOf']).toBe(1);
    expect(withLate.diagnostics.exclusionReasons['superseded-by-later-version']).toBe(1);
    const revised = withLate.rows.find((r) => r.instrumentId === 'AAA')!;
    expect(revised.fields['returnOnInvestedCapital']).toBe(0.25);
  });

  it('unknown fields, unknown operators, and unit-incompatible comparisons TEACH', () => {
    expect(() =>
      screenUniverse({ ...BASE, filter: { field: 'unknownField', operator: 'equals', value: 1 } }),
    ).toThrow(/is not declared/);
    expect(() =>
      screenUniverse({
        ...BASE,
        filter: { field: 'sector', operator: 'greaterThan', value: 1 } as never,
      }),
    ).toThrow(/order is only defined for numeric fields/);
    expect(() =>
      screenUniverse({
        ...BASE,
        filter: { field: 'sector', operator: 'like', value: 'te%' } as never,
      }),
    ).toThrow(/not in the grammar/);
  });

  it('the custom predicate is the explicit non-serializable escape hatch', () => {
    const result = screenUniverse({
      ...BASE,
      customPredicate: (observation) => observation.instrumentId !== 'AAA',
    });
    expect(result.assumptions.customPredicate).toBe('non-serializable caller predicate');
    expect(result.diagnostics.warnings[0]).toMatch(/not reproducible from its serialized form/);
    expect(result.rows.some((r) => r.instrumentId === 'AAA')).toBe(false);
    expect(result.diagnostics.exclusionReasons['custom-predicate']).toBe(1);
  });

  it('limit keeps the top rows and ledgers the remainder', () => {
    // With no filter, all five rows carry the ordering field, so five pass and three fall
    // beyond the limit of two.
    const result = screenUniverse({ ...BASE, limit: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.diagnostics.exclusionReasons['beyond-limit']).toBe(3);
  });

  it('accepts data-bounded safe paging, including zero and large limits, and rejects inexact values', () => {
    expect(screenUniverse({ ...BASE, limit: 0 }).rows).toEqual([]);
    expect(screenUniverse({ ...BASE, limit: 2 ** 32 }).rows).toHaveLength(OBSERVATIONS.length);
    expect(screenUniverse({ ...BASE, limit: 1_000_001 }).rows).toHaveLength(OBSERVATIONS.length);
    for (const limit of [2 ** 53, 1e308, 2.5, -1]) {
      const error = catching(() => screenUniverse({ ...BASE, limit }));
      expect(isQuantError(error, 'input.out_of_range'), `limit ${limit}`).toBe(true);
    }
  });
});

describe('rankUniverse', () => {
  const RANK_BASE = {
    universeId: 'u',
    asOf: AS_OF,
    observations: OBSERVATIONS,
    fieldDefinitions: FIELDS,
    rankBy: { field: 'freeCashFlowYield', direction: 'descending' as const },
    missingValuePolicy: 'exclude' as const,
  };

  it('ranks under all three tie policies, stably', () => {
    // Descending values: BBB 0.08, EEE 0.08, AAA 0.06, DDD 0.05, CCC 0.02.
    const competition = rankUniverse({ ...RANK_BASE, tiePolicy: 'competition' });
    expect(competition.rows.map((r) => [r.instrumentId, r.rank])).toEqual([
      ['BBB', 1],
      ['EEE', 1],
      ['AAA', 3],
      ['DDD', 4],
      ['CCC', 5],
    ]);
    const dense = rankUniverse({ ...RANK_BASE, tiePolicy: 'dense' });
    expect(dense.rows.map((r) => r.rank)).toEqual([1, 1, 2, 3, 4]);
    const ordinal = rankUniverse({ ...RANK_BASE, tiePolicy: 'ordinal' });
    expect(ordinal.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('scoreUniverse', () => {
  it('standardizes, weights, and handles the two missing policies', () => {
    const base = {
      universeId: 'u',
      asOf: AS_OF,
      observations: OBSERVATIONS,
      fieldDefinitions: FIELDS,
      components: [
        {
          field: 'returnOnInvestedCapital',
          weight: 2,
          direction: 'higher-is-better' as const,
          standardization: 'z-score' as const,
        },
        {
          field: 'netDebtToEbitda',
          weight: 1,
          direction: 'lower-is-better' as const,
          standardization: 'percentile-rank' as const,
        },
      ],
    };
    const excluded = scoreUniverse({ ...base, missingValuePolicy: 'exclude' });
    // DDD is missing netDebtToEbitda → excluded under 'exclude'.
    expect(excluded.rows.some((r) => r.instrumentId === 'DDD')).toBe(false);
    expect(excluded.diagnostics.exclusionReasons['missing-component-value']).toBe(1);
    expect(excluded.assumptions.components[0]!.normalizedWeight).toBeCloseTo(2 / 3, 12);

    const renormalized = scoreUniverse({ ...base, missingValuePolicy: 'renormalize-weights' });
    const ddd = renormalized.rows.find((r) => r.instrumentId === 'DDD')!;
    expect(ddd.componentsUsed).toBe(1);
    // Scores are ordered descending with the stable tie-breaker.
    const scores = renormalized.rows.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe('impossible calendar dates are refused (review finding)', () => {
  it('2025-02-30 as a trading session teaches, never normalizes', () => {
    expect(() =>
      requireReturnObservations('probe', 'returnObservations', [
        { instrumentId: 'AAA', tradingSessionDate: '2025-02-30', simpleReturn: 0.01 },
      ]),
    ).toThrowError(/calendar date/);
  });
});
