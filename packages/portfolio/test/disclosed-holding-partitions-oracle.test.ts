import { describe, expect, it } from 'vitest';
import {
  compareDisclosedHoldingPartitions,
  type DisclosedHoldingPartition,
  type DisclosedHoldingPartitionsReport,
} from '@totalfinance/portfolio/disclosed-holding-partitions';
import {
  partitionHolding,
  partitionInput,
  partitionSnapshot,
} from '../../../tools/first-touch/fixtures/disclosed-holding-partitions.js';

const discretions = ['SOLE', 'DFND', 'OTR'] as const;
const flags = ['reportComplete', 'mappingComplete', 'comparisonEligible'] as const;
const flagReasons = ['report_incomplete', 'mapping_incomplete', 'comparison_ineligible'] as const;

// Independent integer-rational oracle: no production decimal helpers, floating point,
// parsed result weights or intermediate rounding. The one quotient rounds at the final scale.
function roundedRatio(numerator: bigint, denominator: bigint, places: number): string {
  const scale = 10n ** BigInt(places);
  const rounded = (2n * numerator * scale + denominator) / (2n * denominator);
  if (places === 0) return String(rounded);
  const fraction = String(rounded % scale)
    .padStart(places, '0')
    .replace(/0+$/, '');
  return String(rounded / scale) + (fraction.length === 0 ? '' : `.${fraction}`);
}

function assertConcentration(
  result: DisclosedHoldingPartitionsReport,
  amounts: readonly bigint[],
  places: number,
): void {
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  const squares = amounts.reduce((sum, amount) => sum + amount * amount, 0n);
  const maximum = amounts.reduce((largest, amount) => (amount > largest ? amount : largest), 0n);
  expect(result.current.concentration.partitionHerfindahlIndex).toBe(
    roundedRatio(squares, total * total, places),
  );
  expect(result.current.concentration.largestPartitionWeight).toBe(
    roundedRatio(maximum, total, places),
  );
  expect(result.current.partitions).toHaveLength(amounts.length);
  for (const partition of result.current.partitions) {
    const index = discretions.findIndex(
      (discretion) => discretion === partition.partitionKey.investmentDiscretion,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(partition.partitionWeight).toBe(roundedRatio(amounts[index]!, total, places));
  }
}

function assertAccounting(result: DisclosedHoldingPartitionsReport): void {
  for (const side of ['baseline', 'current'] as const) {
    const expected = result[side].partitions.map((p) => JSON.stringify(p.partitionKey)).sort();
    const actual = [
      ...result.changes
        .filter(
          (p) => (side === 'baseline' ? p.baselineHoldingIds : p.currentHoldingIds).length > 0,
        )
        .map((p) => JSON.stringify(p.partitionKey)),
      ...result.uncomparedPartitions
        .filter((p) => p.side === side)
        .map((p) => JSON.stringify(p.partitionKey)),
    ].sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  }
}

function rowsForBasis(mask: number, quantity: string): DisclosedHoldingPartition[] {
  return discretions.flatMap((investmentDiscretion, index) =>
    mask & (1 << index)
      ? [
          {
            ...partitionHolding('A', quantity),
            holdingId: investmentDiscretion,
            investmentDiscretion,
          },
        ]
      : [],
  );
}

const numericCases: { places: number; a: number; b: number; fractional: boolean }[] = [];
for (const places of [0, 1, 2, 12, 18])
  for (let a = 1; a <= 5; a++)
    for (let b = 1; b <= 4; b++)
      for (const fractional of [false, true]) numericCases.push({ places, a, b, fractional });

describe('partition independent exact-rational oracle', () => {
  it.each(numericCases)('matches exact concentration for %j', ({ places, a, b, fractional }) => {
    const amounts = [BigInt(a), BigInt(b), 3n];
    const rows = amounts.map((amount, index) => ({
      ...partitionHolding(),
      holdingId: discretions[index]!,
      investmentDiscretion: discretions[index]!,
      reportedValue: fractional ? `0.${amount}` : String(amount),
    }));
    const input = partitionInput();
    input.policy.ratioDecimalPlaces = places;
    input.baseline = partitionSnapshot('2026-03-31', rows);
    input.current = partitionSnapshot('2026-06-30', rows);
    const result = compareDisclosedHoldingPartitions(input);
    assertConcentration(result, amounts, places);
    for (const change of result.changes) {
      expect(change.quantityDifference).toBe('0');
      expect(change.valueDifference).toBe('0');
    }
    assertAccounting(result);
  });

  it.each([...Array(19).keys()])(
    'keeps mixed scales, huge integers and sub-unit decimals exact at precision %i',
    (places) => {
      const input = partitionInput();
      input.policy.ratioDecimalPlaces = places;
      const makeRows = (current: boolean): DisclosedHoldingPartition[] => [
        {
          ...partitionHolding('A', current ? '9007199254740995.3' : '9007199254740993.1'),
          holdingId: 'SOLE',
          reportedValue: current ? '1.25' : '2.5',
          valueScale: '1000',
        },
        {
          ...partitionHolding('A'),
          holdingId: 'DFND',
          investmentDiscretion: 'DFND',
          reportedValue: current ? '9007199254740993' : '9007199254740992',
        },
        {
          ...partitionHolding('A'),
          holdingId: 'OTR',
          investmentDiscretion: 'OTR',
          reportedValue: current ? '0.000000000000000001' : '0',
        },
      ];
      input.baseline = partitionSnapshot('2026-03-31', makeRows(false));
      input.current = partitionSnapshot('2026-06-30', makeRows(true));
      const result = compareDisclosedHoldingPartitions(input);
      // Oracle amounts in 10^-18 currency units, authored independently of source-value parsing.
      assertConcentration(result, [1250n * 10n ** 18n, 9007199254740993n * 10n ** 18n, 1n], places);
      expect(result.current.concentration.denominatorReportedValue).toBe(
        '9007199254742243.000000000000000001',
      );
      expect(
        result.changes.map((p) => [p.partitionKey.investmentDiscretion, p.valueDifference]),
      ).toEqual([
        ['DFND', '1'],
        ['OTR', '0.000000000000000001'],
        ['SOLE', '-1250'],
      ]);
      expect(
        result.changes.find((p) => p.partitionKey.investmentDiscretion === 'SOLE')!
          .quantityDifference,
      ).toBe('2.2');
      assertAccounting(result);
    },
  );
});

describe('all independent completeness gates', () => {
  it.each([...Array(64).keys()])(
    'withholds unsupported absence and deltas for flag mask %i',
    (mask) => {
      const input = partitionInput();
      input.baseline.holdings = [partitionHolding('A', '10', '100'), partitionHolding('removed')];
      input.current.holdings = [partitionHolding('A', '12', '150'), partitionHolding('added')];
      for (const [sideIndex, side] of (['baseline', 'current'] as const).entries())
        for (const [index, flag] of flags.entries())
          input[side][flag] = Boolean(mask & (1 << (sideIndex * 3 + index)));
      const result = compareDisclosedHoldingPartitions(input);
      const complete = mask === 63;
      expect(result.changes).toHaveLength(3);
      for (const change of result.changes) {
        const id = change.partitionKey.securityId;
        const classification =
          id === 'security-added'
            ? 'newly_disclosed'
            : id === 'security-removed'
              ? 'no_longer_disclosed'
              : 'still_disclosed';
        expect(change.classification).toBe(complete ? classification : 'unknown');
        const difference = id === 'security-added' ? '10' : id === 'security-removed' ? '-10' : '2';
        const valueDifference =
          id === 'security-added' ? '100' : id === 'security-removed' ? '-100' : '50';
        expect(change.quantityDifference).toBe(complete ? difference : null);
        expect(change.valueDifference).toBe(complete ? valueDifference : null);
        if (id === 'security-added') {
          expect(change.baselineQuantity).toBe(complete ? '0' : null);
          expect(change.baselineReportedValue).toBe(complete ? '0' : null);
        }
        if (id === 'security-removed') {
          expect(change.currentQuantity).toBe(complete ? '0' : null);
          expect(change.currentReportedValue).toBe(complete ? '0' : null);
        }
        for (const side of ['baseline', 'current'] as const)
          for (const [index, flag] of flags.entries())
            expect(change.reasons.includes(`${side}_${flagReasons[index]!}`)).toBe(
              !input[side][flag],
            );
      }
      for (const side of ['baseline', 'current'] as const) {
        const available = flags.every((flag) => input[side][flag]);
        expect(result[side].concentration.denominatorReportedValue).toBe(
          available ? (side === 'baseline' ? '200' : '250') : null,
        );
        expect(result[side].partitions.every((p) => p.partitionWeight !== null)).toBe(available);
        expect(result[side].holdings).toHaveLength(2);
      }
      assertAccounting(result);
    },
  );
});

const basisCases: { before: number; after: number }[] = [];
for (let before = 0; before < 8; before++)
  for (let after = 0; after < 8; after++) basisCases.push({ before, after });

describe('all no-reference discretion bases', () => {
  it.each(basisCases)('accounts for each partition across %j', ({ before, after }) => {
    const input = partitionInput();
    input.baseline.holdings = rowsForBasis(before, '10');
    input.current.holdings = rowsForBasis(after, '12');
    const result = compareDisclosedHoldingPartitions(input);
    for (const side of ['baseline', 'current'] as const) {
      expect(result[side].partitions).toHaveLength(input[side].holdings.length);
      expect(result[side].holdings.map((row) => row.holdingId).sort()).toEqual(
        input[side].holdings.map((row) => row.holdingId).sort(),
      );
    }
    const changedBasis = before !== 0 && after !== 0 && before !== after;
    if (changedBasis) {
      expect(result.changes).toEqual([]);
      expect(result.uncomparedPartitions).toHaveLength(
        input.baseline.holdings.length + input.current.holdings.length,
      );
      for (const partition of result.uncomparedPartitions) {
        expect(partition.classification).toBe('unknown');
        expect(partition.reasons).toEqual(['partition_basis_changed']);
        expect(partition.quantity).toBe(partition.side === 'baseline' ? '10' : '12');
      }
    } else {
      expect(result.uncomparedPartitions).toEqual([]);
      expect(result.changes).toHaveLength(
        Math.max(input.baseline.holdings.length, input.current.holdings.length),
      );
      for (const change of result.changes) {
        expect(change.classification).toBe(
          before === 0
            ? 'newly_disclosed'
            : after === 0
              ? 'no_longer_disclosed'
              : 'still_disclosed',
        );
        expect(change.quantityDifference).toBe(before === 0 ? '12' : after === 0 ? '-10' : '2');
        expect(change.reasons).toEqual([]);
      }
    }
    assertAccounting(result);
  });

  it.each(['baseline', 'current'] as const)(
    'limits reference-basis withholding to the affected group on %s',
    (side) => {
      for (const investmentDiscretion of discretions)
        for (const reviewedDuplicate of [false, true]) {
          const input = partitionInput();
          input.baseline.holdings = [...rowsForBasis(7, '10'), partitionHolding('unaffected')];
          input.current.holdings = [...rowsForBasis(7, '12'), partitionHolding('unaffected')];
          input[side].holdings = [
            ...input[side].holdings,
            {
              ...partitionHolding(),
              holdingId: 'referenced',
              investmentDiscretion,
              otherManagerReferences: reviewedDuplicate ? ['1', '1'] : ['1'],
              reviewReasons: reviewedDuplicate ? ['source_repeated_reference'] : [],
            },
          ];
          const result = compareDisclosedHoldingPartitions(input);
          expect(result.changes).toHaveLength(1);
          expect(result.changes[0]!.partitionKey.securityId).toBe('security-unaffected');
          // A reviewed row also makes the overall universe incomplete; no unaffected delta is invented.
          expect(result.changes[0]!.quantityDifference).toBe(reviewedDuplicate ? null : '0');
          expect(result.uncomparedPartitions).toHaveLength(reviewedDuplicate ? 6 : 7);
          for (const partition of result.uncomparedPartitions) {
            expect(partition.classification).toBe('unknown');
            expect(partition.reasons).toContain('report_scoped_reference_basis');
          }
          expect(
            result[side].holdings.find((p) => p.holdingId === 'referenced')!.partitionKey === null,
          ).toBe(reviewedDuplicate);
          assertAccounting(result);
        }
    },
  );
});
