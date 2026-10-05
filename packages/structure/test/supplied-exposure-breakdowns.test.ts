import { describe, expect, it, vi } from 'vitest';
import type * as CoreModule from '@totalfinance/core';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { exposureFromGreeks, type SuppliedExposureInput } from '@totalfinance/structure';
import golden from './golden/supplied-exposure-0.1.0.json';

/**
 * `breakdowns: false` (selective Greeks and exposure spec, decision 19): a caller that aggregates the
 * contributions itself can leave `byStrike` and `byExpiry` out. Everything else in the report is
 * unchanged, and the per-group exact totals — two thirds of the summation — are not computed.
 */

const sums = vi.hoisted(() => ({ count: 0 }));
vi.mock('@totalfinance/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    stableSum: (addends: readonly number[]) => {
      sums.count++;
      return actual.stableSum(addends);
    },
  };
});

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const inputs = golden.entries.map((entry) => entry.input as unknown as SuppliedExposureInput);

function caught(fn: () => unknown): { code: string; message: string; context: unknown } {
  try {
    fn();
  } catch (error) {
    if (!isQuantError(error)) throw error;
    return { code: error.code, message: error.message, context: error.context };
  }
  throw new Error('expected a typed error');
}

describe('exposureFromGreeks({ breakdowns })', () => {
  it('false leaves out byStrike and byExpiry and changes nothing else', () => {
    for (const input of inputs) {
      const full = clone(exposureFromGreeks(input)) as unknown as Json;
      const lean = clone(exposureFromGreeks({ ...input, breakdowns: false })) as unknown as Json;
      const expected = clone(full);
      delete expected['byStrike'];
      delete expected['byExpiry'];
      (expected['assumptions'] as Json)['breakdowns'] = false;
      expect(lean).toStrictEqual(expected);
      expect(Object.keys(lean)).toEqual([
        'contributions',
        'aggregate',
        'coverage',
        'assumptions',
        'diagnostics',
      ]);
    }
  });

  it('true is the released report, with the flag echoed', () => {
    for (const input of inputs) {
      const full = clone(exposureFromGreeks(input)) as unknown as Json;
      const explicit = clone(exposureFromGreeks({ ...input, breakdowns: true })) as unknown as Json;
      expect('breakdowns' in (full['assumptions'] as Json)).toBe(false);
      (full['assumptions'] as Json)['breakdowns'] = true;
      expect(explicit).toStrictEqual(full);
      expect(Object.keys(explicit)).toEqual(Object.keys(full));
    }
  });

  it('composes with a metrics selection', () => {
    const input = inputs[0]!;
    const gexOnly = exposureFromGreeks({ ...input, metrics: ['gex'] });
    const lean = exposureFromGreeks({ ...input, metrics: ['gex'], breakdowns: false });
    expect(lean.aggregate).toStrictEqual(gexOnly.aggregate);
    expect(lean.contributions).toStrictEqual(gexOnly.contributions);
    expect('byStrike' in lean).toBe(false);
    expect(lean.assumptions.metrics).toEqual(['gex']);
  });

  it('skips the per-group exact totals: the aggregate is the only one summed', () => {
    const input = inputs[0]!;
    const full = exposureFromGreeks(input);
    sums.count = 0;
    exposureFromGreeks(input);
    const fullSums = sums.count;
    sums.count = 0;
    exposureFromGreeks({ ...input, breakdowns: false });
    const leanSums = sums.count;
    // Every totals block runs the same number of exact sums: the aggregate, each strike, each expiry.
    const blocks = 1 + full.byStrike.length + full.byExpiry.length;
    expect(fullSums % blocks).toBe(0);
    expect(leanSums).toBe(fullSums / blocks);
  });

  it('refuses anything but a boolean, and teaches a misspelled key', () => {
    const input = inputs[0]!;
    for (const [value, received] of [
      ['false', 'string'],
      [0, 'number'],
      [null, 'null'],
      [{}, 'object'],
    ] as const) {
      const error = caught(() =>
        exposureFromGreeks({ ...input, breakdowns: value } as unknown as SuppliedExposureInput),
      );
      expect(error.code).toBe(ErrorCode.InputWrongType);
      expect(error.message).toContain(
        `breakdowns must be true or false when provided; got ${received}`,
      );
      expect(error.context).toEqual({ field: 'breakdowns', received });
    }
    const typo = caught(() =>
      exposureFromGreeks({ ...input, breakdown: false } as unknown as SuppliedExposureInput),
    );
    expect(typo.code).toBe(ErrorCode.InputUnknownField);
    expect(typo.message).toContain('did you mean "breakdowns"');
  });
});
