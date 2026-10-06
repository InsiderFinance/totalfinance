import { describe, expect, it } from 'vitest';
import { InputError, ErrorCode } from '@totalfinance/core';
import {
  createAnalysisArtifact,
  readAnalysisArtifact,
  canonicalJsonOf,
} from '@totalfinance/core/artifacts';
import {
  compareDisclosedHoldingPartitions,
  type DisclosedHoldingPartition,
  type CompareDisclosedHoldingPartitionsInput,
} from '@totalfinance/portfolio/disclosed-holding-partitions';
import { compareDisclosedHoldings } from '@totalfinance/portfolio/disclosed-holdings';
import {
  partitionHolding,
  partitionInput,
  partitionSnapshot,
} from '../../../tools/first-touch/fixtures/disclosed-holding-partitions.js';
import { disclosedInput } from '../../../tools/first-touch/fixtures/disclosed-holdings.js';

const row = (
  discretion: string,
  value = '100',
  extra: Partial<DisclosedHoldingPartition> = {},
): DisclosedHoldingPartition => ({
  ...partitionHolding(),
  holdingId: discretion,
  investmentDiscretion: discretion,
  reportedValue: value,
  ...extra,
});
const withRows = (
  baseline: DisclosedHoldingPartition[],
  current = baseline,
): CompareDisclosedHoldingPartitionsInput => ({
  ...partitionInput(),
  baseline: partitionSnapshot('2026-03-31', baseline),
  current: partitionSnapshot('2026-06-30', current),
});

function accounting(input: CompareDisclosedHoldingPartitionsInput): void {
  const report = compareDisclosedHoldingPartitions(input);
  for (const side of ['baseline', 'current'] as const) {
    const expected = report[side].partitions.map((p) => canonicalJsonOf(p.partitionKey)).sort();
    const actual = [
      ...report.changes
        .filter(
          (c) => (side === 'baseline' ? c.baselineHoldingIds : c.currentHoldingIds).length > 0,
        )
        .map((c) => canonicalJsonOf(c.partitionKey)),
      ...report.uncomparedPartitions
        .filter((p) => p.side === side)
        .map((p) => canonicalJsonOf(p.partitionKey)),
    ].sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
    expect(report[side].holdings.map((h) => h.holdingId).sort()).toEqual(
      input[side].holdings.map((h) => h.holdingId).sort(),
    );
  }
}

describe('reported holding partitions', () => {
  it('preserves the largest accepted source amount after scaling and summation', () => {
    const maximum = '9'.repeat(100);
    const input = withRows([], [row('SOLE', maximum, { valueScale: '1000' })]);
    const result = compareDisclosedHoldingPartitions(input);
    expect(result.current.concentration.denominatorReportedValue).toBe(maximum + '000');
    expect(result.changes[0]!.valueDifference).toBe(maximum + '000');
    expect(result.current.partitions[0]!.partitionWeight).toBe('1');
  });

  it('calculates exact complete mixed discretion partitions without aggregation', () => {
    const result = compareDisclosedHoldingPartitions(
      withRows(
        [row('SOLE', '100'), row('OTR', '50'), row('DFND', '50')],
        [row('SOLE', '120'), row('OTR', '60'), row('DFND', '20')],
      ),
    );
    expect(result.baseline.partitions).toHaveLength(3);
    expect(result.baseline.concentration).toMatchObject({
      denominatorReportedValue: '200',
      largestPartitionWeight: '0.5',
      partitionHerfindahlIndex: '0.375',
      status: 'available',
    });
    expect(result.current.concentration.partitionHerfindahlIndex).toBe('0.46');
    expect(
      result.changes.map((c) => [c.partitionKey.investmentDiscretion, c.valueDifference]),
    ).toEqual([
      ['DFND', '-30'],
      ['OTR', '10'],
      ['SOLE', '20'],
    ]);
    expect(result.changes.every((c) => c.classification === 'still_disclosed')).toBe(true);
    accounting(withRows([row('SOLE'), row('OTR'), row('DFND')]));
  });
  it('keeps high precision quantities and mixed scale values exact', () => {
    const result = compareDisclosedHoldingPartitions(
      withRows(
        [row('SOLE', '25', { quantity: '9007199254740993.100', valueScale: '1000' })],
        [row('SOLE', '28000', { quantity: '9007199254740995.300' })],
      ),
    );
    expect(result.changes[0]).toMatchObject({
      baselineQuantity: '9007199254740993.1',
      quantityDifference: '2.2',
      baselineReportedValue: '25000',
      valueDifference: '3000',
    });
  });
  it('retains explicit zero and establishes complete new/removed source presence', () => {
    const result = compareDisclosedHoldingPartitions(
      withRows([row('SOLE', '0')], [partitionHolding('B', '0', '0')]),
    );
    expect(result.changes.map((c) => c.classification)).toEqual([
      'no_longer_disclosed',
      'newly_disclosed',
    ]);
    expect(result.changes.every((c) => c.valueDifference === '0')).toBe(true);
    expect(result.baseline.concentration.denominatorReportedValue).toBe('0');
    expect(result.baseline.concentration.reasons).toEqual(['zero_denominator']);
  });
  it('represents an empty complete snapshot without ratios', () => {
    const result = compareDisclosedHoldingPartitions(withRows([]));
    expect(result.baseline.concentration.denominatorReportedValue).toBe('0');
    expect(result.baseline.concentration.partitionHerfindahlIndex).toBeNull();
    expect(result.changes).toEqual([]);
  });
  it('uses unrounded weights for Herfindahl and half-away ties', () => {
    const input = withRows([row('SOLE', '1'), row('OTR', '1'), row('DFND', '1')]);
    input.policy.ratioDecimalPlaces = 0;
    const result = compareDisclosedHoldingPartitions(input);
    expect(result.baseline.partitions.map((p) => p.partitionWeight)).toEqual(['0', '0', '0']);
    expect(result.baseline.concentration.partitionHerfindahlIndex).toBe('0');
    input.baseline.holdings = [row('SOLE', '1'), row('OTR', '1')];
    expect(
      compareDisclosedHoldingPartitions(input).baseline.concentration.largestPartitionWeight,
    ).toBe('1');
  });
  it('separates authenticated classes and delimiter-sensitive structured keys', () => {
    const input = withRows([
      { ...partitionHolding('first'), securityId: 'a|b', classId: 'c' },
      { ...partitionHolding('second'), securityId: 'a', classId: 'b|c' },
    ]);
    const result = compareDisclosedHoldingPartitions(input);
    expect(result.baseline.partitions).toHaveLength(2);
    expect(result.baseline.partitions.every((p) => p.status === 'supported')).toBe(true);
    accounting(input);
  });
  it('keeps v1 behavior and literals independent', () => {
    const before = compareDisclosedHoldings(disclosedInput());
    compareDisclosedHoldingPartitions(withRows([row('SOLE'), row('OTR')]));
    expect(compareDisclosedHoldings(disclosedInput())).toEqual(before);
    expect(before.policyVersion).toBe('disclosed-holdings-v1');
    expect(before.assumptions.policy.supportedProfile).toBe('common-stock-shares-v1');
  });
  it('serializes the typed report as an analysis artifact', () => {
    const input = withRows([row('SOLE'), row('OTR')]);
    const result = compareDisclosedHoldingPartitions(input);
    const artifact = createAnalysisArtifact({
      artifactType: 'portfolio.disclosed-holding-partitions',
      producedBy: { operation: 'compareDisclosedHoldingPartitions' },
      inputs: { parameters: input },
      result,
    });
    expect(readAnalysisArtifact({ artifact }).artifact.id).toBe(artifact.id);
  });
  it('does not mutate input and normalizes independent input permutations', () => {
    const input = withRows([
      row('SOLE'),
      row('OTR', '3', { otherManagerReferences: [' z ', 'a'], sourceReportId: 'report' }),
    ]);
    const saved = structuredClone(input);
    const expected = compareDisclosedHoldingPartitions(input);
    expect(input).toEqual(saved);
    const shuffled = structuredClone(input);
    shuffled.baseline.holdings = [...shuffled.baseline.holdings].reverse();
    shuffled.current.holdings = [...shuffled.current.holdings].reverse();
    shuffled.baseline.holdings[0]!.otherManagerReferences = ['a', ' z '];
    shuffled.current.holdings[0]!.otherManagerReferences = ['a', ' z '];
    expect(compareDisclosedHoldingPartitions(shuffled)).toEqual(expected);
    input.policy.ratioDecimalPlaces = 4;
    expect(expected.assumptions.policy.ratioDecimalPlaces).toBe(12);
  });
});

describe('partition basis and complete evidence', () => {
  it.each(['SOLE', 'DFND', 'OTR'])('accepts recognized %s discretion', (discretion) => {
    expect(
      compareDisclosedHoldingPartitions(withRows([row(discretion)])).baseline.partitions[0]!.status,
    ).toBe('supported');
  });
  it.each(['baseline', 'current'] as const)(
    'withholds the entire group with references on %s',
    (side) => {
      const input = withRows([row('SOLE'), row('OTR')]);
      input[side].holdings = [
        ...input[side].holdings,
        row('OTR', '20', { holdingId: 'referenced', otherManagerReferences: ['1'] }),
      ];
      const result = compareDisclosedHoldingPartitions(input);
      expect(result.changes).toEqual([]);
      expect(result.uncomparedPartitions).toHaveLength(5);
      expect(
        result.uncomparedPartitions.every(
          (p) =>
            p.classification === 'unknown' && p.reasons.includes('report_scoped_reference_basis'),
        ),
      ).toBe(true);
      expect(result[side].concentration.status).toBe('available');
      accounting(input);
    },
  );
  it('never equates identical reference tokens from distinct source reports', () => {
    const input = withRows([row('OTR', '50', { otherManagerReferences: ['1'] })]);
    input.current.reportIds = ['later'];
    input.current.holdings = [
      row('OTR', '60', { sourceReportId: 'later', otherManagerReferences: ['1'] }),
    ];
    const result = compareDisclosedHoldingPartitions(input);
    expect(result.uncomparedPartitions.map((p) => p.partitionKey.sourceReportId)).toEqual([
      'report',
      'later',
    ]);
    expect(result.changes).toEqual([]);
    accounting(input);
  });
  it('withholds an otherwise matched SOLE row when discretion basis redistributes', () => {
    const input = withRows([row('SOLE'), row('OTR')], [row('SOLE', '150'), row('DFND', '50')]);
    const result = compareDisclosedHoldingPartitions(input);
    expect(result.changes).toEqual([]);
    expect(result.uncomparedPartitions).toHaveLength(4);
    expect(
      result.uncomparedPartitions.every((p) => p.reasons.includes('partition_basis_changed')),
    ).toBe(true);
    accounting(input);
  });
  it('reviews no-reference duplicates across selected amendments instead of summing them', () => {
    const input = withRows([
      row('SOLE'),
      row('SOLE', '5', { holdingId: 'amendment', sourceReportId: 'amendment' }),
    ]);
    input.baseline.reportIds = ['report', 'amendment'];
    input.current.reportIds = ['report', 'amendment'];
    const result = compareDisclosedHoldingPartitions(input);
    expect(result.baseline.partitions).toHaveLength(1);
    expect(result.baseline.partitions[0]).toMatchObject({
      quantity: null,
      reasons: ['duplicate_partition'],
    });
    expect(result.baseline.partitions[0]!.partitionKey).not.toHaveProperty('sourceReportId');
    accounting(input);
  });
  it('preserves reviewed repeated refs as unkeyed facts and blocks its group', () => {
    const input = withRows(
      [
        row('SOLE'),
        row('OTR', '10', {
          otherManagerReferences: ['1', '1'],
          reviewReasons: ['source_repeated_reference'],
        }),
      ],
      [row('SOLE', '120')],
    );
    const result = compareDisclosedHoldingPartitions(input);
    const repeated = result.baseline.holdings.find((h) => h.holdingId === 'OTR')!;
    expect(repeated).toMatchObject({
      otherManagerReferences: ['1', '1'],
      partitionKey: null,
      status: 'review',
    });
    expect(repeated.reasons).toContain('invalid_other_manager_references');
    expect(result.baseline.concentration.denominatorReportedValue).toBeNull();
    expect(result.changes).toEqual([]);
    expect(result.uncomparedPartitions).toHaveLength(2);
    accounting(input);
  });
  it.each(['reportComplete', 'mappingComplete', 'comparisonEligible'] as const)(
    'withholds all deltas and presence if either independent %s gate fails',
    (flag) => {
      const input = withRows([row('SOLE')], [row('SOLE', '120'), partitionHolding('B')]);
      input.baseline[flag] = false;
      const result = compareDisclosedHoldingPartitions(input);
      expect(result.baseline.concentration.denominatorReportedValue).toBeNull();
      expect(
        result.changes.every(
          (c) =>
            c.classification === 'unknown' &&
            c.quantityDifference === null &&
            c.valueDifference === null,
        ),
      ).toBe(true);
      accounting(input);
    },
  );
  it.each([
    { instrumentType: 'fund' },
    { quantityUnit: 'PRN' },
    { putCall: 'call' as const },
    { investmentDiscretion: 'OTHER' },
    { mappingStatus: 'unresolved' as const },
    { reviewReasons: ['source-review'] },
  ])('retains unsupported row %j with no subset denominator', (extra) => {
    const input = withRows([row('SOLE'), { ...partitionHolding('B'), ...extra }]);
    const result = compareDisclosedHoldingPartitions(input);
    expect(result.baseline.holdings).toHaveLength(2);
    expect(result.baseline.concentration.denominatorReportedValue).toBeNull();
    expect(result.baseline.partitions.every((p) => p.partitionWeight === null)).toBe(true);
    expect(result.changes.every((c) => c.quantityDifference === null)).toBe(true);
    accounting(input);
  });
  it('retains unresolved unkeyed rows and refuses contradictory complete mapping', () => {
    const input = withRows([
      row('SOLE'),
      {
        ...partitionHolding('B'),
        securityId: null,
        issuerId: null,
        classId: null,
        mappingStatus: 'unresolved',
      },
    ]);
    const result = compareDisclosedHoldingPartitions(input);
    expect(result.baseline.holdings[1]!.partitionKey).toBeNull();
    expect(result.baseline.concentration.reasons).toContain('holdings_require_review');
    accounting(input);
  });
  it('withholds identity changes without combining classes', () => {
    const input = withRows([row('SOLE')], [row('SOLE', '50', { issuerId: 'different' })]);
    expect(compareDisclosedHoldingPartitions(input).changes[0]!.reasons).toContain(
      'conflicting_security_identity',
    );
    expect(compareDisclosedHoldingPartitions(input).changes[0]!.classification).toBe('unknown');
  });
  it('withholds a mixed currency denominator and mismatched-currency value deltas', () => {
    const input = withRows([row('SOLE')], [row('SOLE', '120', { valueCurrency: 'EUR' })]);
    const result = compareDisclosedHoldingPartitions(input);
    expect(result.changes[0]!.quantityDifference).toBe('0');
    expect(result.changes[0]!.valueDifference).toBeNull();
    expect(result.changes[0]!.reasons).toContain('currency_mismatch');
    input.current.holdings = [...input.current.holdings, partitionHolding('B')];
    expect(compareDisclosedHoldingPartitions(input).current.concentration.reasons).toContain(
      'mixed_currencies',
    );
  });
  it('accepts same-period revision only with distinct report sets', () => {
    const input = partitionInput();
    input.comparisonMode = 'same-period-revision';
    input.current.periodEnd = input.baseline.periodEnd;
    input.current.reportIds = ['revision'];
    input.current.holdings = input.current.holdings.map((h) => ({
      ...h,
      sourceReportId: 'revision',
    }));
    expect(compareDisclosedHoldingPartitions(input).changes[0]!.quantityDifference).toBe('2');
    input.current.reportIds = ['report'];
    input.current.holdings = input.current.holdings.map((h) => ({
      ...h,
      sourceReportId: 'report',
    }));
    expect(() => compareDisclosedHoldingPartitions(input)).toThrow(InputError);
  });
});

describe('strict partition boundary', () => {
  it.each(['01', '-1', '1e3', '1.', '.1', ' 1', '1.0000000000000000001', '9'.repeat(101)])(
    'rejects invalid exact amount %s',
    (quantity) => {
      expect(() =>
        compareDisclosedHoldingPartitions(withRows([row('SOLE', '1', { quantity })])),
      ).toThrow(InputError);
    },
  );
  it('rejects unreviewed repeated reference tokens', () => {
    expect(() =>
      compareDisclosedHoldingPartitions(
        withRows([row('SOLE', '1', { otherManagerReferences: ['1', '1'] })]),
      ),
    ).toThrow(InputError);
  });
  it('rejects unselected sourceReportId', () => {
    expect(() =>
      compareDisclosedHoldingPartitions(
        withRows([row('SOLE', '1', { sourceReportId: 'unselected' })]),
      ),
    ).toThrow(InputError);
  });
  it.each([-1, 19, 0.5, NaN, Infinity])(
    'rejects invalid ratio precision %s',
    (ratioDecimalPlaces) => {
      const input = partitionInput();
      input.policy.ratioDecimalPlaces = ratioDecimalPlaces;
      expect(() => compareDisclosedHoldingPartitions(input)).toThrow(InputError);
    },
  );
  it('rejects unknown control/policy keys with the registered code', () => {
    expect(() =>
      compareDisclosedHoldingPartitions({
        ...partitionInput(),
        surprise: true,
      } as CompareDisclosedHoldingPartitionsInput),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InputUnknownField }));
  });
  it('rejects consumed accessors before reading them', () => {
    const input = partitionInput();
    let calls = 0;
    Object.defineProperty(input.baseline.holdings[0], 'quantity', {
      get: () => {
        calls++;
        return '1';
      },
    });
    expect(() => compareDisclosedHoldingPartitions(input)).toThrow(InputError);
    expect(calls).toBe(0);
  });
  it('refuses oversized arrays before element traversal', () => {
    const input = partitionInput();
    let calls = 0;
    const holdings = Array(25_001);
    Object.defineProperty(holdings, 0, {
      get: () => {
        calls++;
        return partitionHolding();
      },
    });
    input.baseline.holdings = holdings;
    expect(() => compareDisclosedHoldingPartitions(input)).toThrow(InputError);
    expect(calls).toBe(0);
  });
  it('refuses sparse reference arrays and duplicate holding IDs', () => {
    expect(() =>
      compareDisclosedHoldingPartitions(
        withRows([row('SOLE', '1', { otherManagerReferences: Array(2) })]),
      ),
    ).toThrow(InputError);
    expect(() => compareDisclosedHoldingPartitions(withRows([row('SOLE'), row('SOLE')]))).toThrow(
      InputError,
    );
  });
});
